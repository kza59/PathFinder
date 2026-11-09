import * as path from 'path';
import * as vscode from 'vscode';
import { definitionKey, makeNodeId, MODULE_NAME, normalizePath } from './nodeId';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES } from './limits';
import { markChokepoints } from './chokepoints';
import { markRecursion } from './recursion';

export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES } from './limits';

export interface GraphNode {
  id: string;       // makeNodeId(file, label)
  label: string;    // qualified function name: "function1", "Dog.speak" (Python), "Dog::speak" (C++)
  file: string;     // absolute path of the definition (never a prototype), for jump-to-source
  line: number;     // 1-based line of the function name (same base as debugger frames)
  endLine: number;  // 1-based last line of the function body
  recursionGroup?: number; // set on nodes in a recursive structure; members of the same cycle share the number
  hiddenCallers?: number;  // callers that exist but were left out (depth or node limit reached); the graph is cut off here
  noise?: boolean;         // usually uninteresting: top-level <module> code, constructors/destructors, tests
  chokepoint?: boolean;    // every path to the target passes through here: one breakpoint here catches them all
}

export interface GraphEdge {
  from: string;     // caller id
  to: string;       // callee id
  lines: number[];  // 1-based lines in the caller's file where it calls the callee, ascending (one per call site)
  recursive?: boolean; // true when both ends share a recursionGroup; omitted for calls outside a cycle
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Resolved functions selected by PathFind, independent of node order and recursion. */
  targetIds?: string[];
}

export interface BuildOptions {
  maxDepth?: number;
  maxNodes?: number;
  token?: vscode.CancellationToken;
  trace?: (message: string) => void; // logs every language-server answer, for debugging missing callers
}

const CONSTRUCTOR_NAMES = new Set(['__init__', '__new__', '__del__']);
const TEST_NAME = /^test(_|[A-Z]|$)/; // test_parse, testParse, test

const C_LIKE_EXTENSIONS = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx']);
const SOURCE_EXCLUDE = '**/{node_modules,.git,.venv,venv,env,__pycache__,site-packages,build,out,dist}/**';
const MAX_SCANNED_FILES = 5000;

const FUNCTION_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

// Symbols whose names become part of a qualified name (classes, namespaces, enclosing functions).
const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Namespace, vscode.SymbolKind.Class, vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface, vscode.SymbolKind.Function, vscode.SymbolKind.Method,
]);

/** "Dog::speak() const" -> "Dog::speak" */
function stripSignature(name: string): string {
  return name.replace(/\(.*$/s, '').trim();
}

function lastSegment(name: string): string {
  return name.split(/::|\./).pop() ?? name;
}

function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/** Top-level code is reported as the file/module symbol rather than as a function. */
function isModuleItem(item: vscode.CallHierarchyItem): boolean {
  return item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module;
}

function locationKey(item: vscode.CallHierarchyItem): string {
  return definitionKey(item.uri.toString(), item.selectionRange.start.line, isModuleItem(item));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The call hierarchy item for the function whose name is on `line` (0-based) of `uri`, found by searching for the name. */
async function prepareAtName(uri: vscode.Uri, line: number, name: string): Promise<vscode.CallHierarchyItem | undefined> {
  const text = (await vscode.workspace.openTextDocument(uri)).lineAt(line).text;
  const column = Math.max(text.search(new RegExp(`\\b${escapeRegExp(name)}\\b`)), 0);
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, new vscode.Position(line, column)) ?? [];
  return items.find(i => i.selectionRange.start.line === line) ?? items[0];
}

function describeItem(item: vscode.CallHierarchyItem): string {
  return `${item.name} @ ${path.basename(item.uri.fsPath)}:${item.selectionRange.start.line + 1} (${vscode.SymbolKind[item.kind]})`;
}

/**
 * For debugTracker: the node whose body contains a stack frame location (file + 1-based line).
 * Matching by location instead of by frame name avoids every debugger's own naming scheme
 * (debugpy says "speak", gdb says "Dog::speak() const").
 */
export function findNodeForFrame(graph: CallGraph, filePath: string, line: number): GraphNode | undefined {
  const file = normalizePath(filePath);
  let best: GraphNode | undefined;
  for (const node of graph.nodes) {
    if (normalizePath(node.file) === file && node.line <= line && line <= node.endLine
        && (!best || node.line > best.line)) {
      best = node; // innermost wins, for nested functions
    }
  }
  return best;
}

class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly idByLocation = new Map<string, string>();
  private readonly symbolCache = new Map<string, Promise<vscode.DocumentSymbol[]>>();

  constructor(readonly trace: (message: string) => void = () => {}) {}

  /**
   * Language servers may hand back a prototype (`int sum(int, int);` in a header or a forward
   * declaration) instead of the body. Resolve to the definition so a function has exactly one node.
   */
  async toDefinition(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyItem> {
    if (item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module) {
      return item; // top-level code is already where it is
    }
    const targets = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider', item.uri, item.selectionRange.start) ?? [];
    const locations = targets.map(t => 'targetUri' in t
      ? new vscode.Location(t.targetUri, t.targetSelectionRange ?? t.targetRange)
      : t);
    if (locations.length === 0 || locations.some(l => l.uri.toString() === item.uri.toString() && item.range.contains(l.range.start))) {
      return item;
    }
    const definition = locations.find(l => inWorkspace(l.uri)) ?? locations[0];
    const [resolved] = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      'vscode.prepareCallHierarchy', definition.uri, definition.range.start) ?? [];
    this.trace(`  definition of ${describeItem(item)} -> ${resolved ? describeItem(resolved) : 'unresolved, keeping original'}`);
    return resolved ?? item;
  }

  private documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    const key = uri.toString();
    let symbols = this.symbolCache.get(key);
    if (!symbols) {
      symbols = Promise.resolve(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        'vscode.executeDocumentSymbolProvider', uri))
        .then(result => (result ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s));
      this.symbolCache.set(key, symbols);
    }
    return symbols;
  }

  private async definitionEndLine(item: vscode.CallHierarchyItem): Promise<number> {
    if (item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module) {
      return (await vscode.workspace.openTextDocument(item.uri)).lineCount;
    }
    // Call hierarchy ranges can cover only the declaration/name (Pylance),
    // while debugger frames point into the body. Use the definition's outline
    // range, matched by its declaration location rather than its name.
    const find = (symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
      for (const symbol of symbols) {
        if (!symbol.range.contains(item.selectionRange.start)) {
          continue;
        }
        const child = find(symbol.children);
        if (child) {
          return child;
        }
        if (symbol.selectionRange.contains(item.selectionRange.start)) {
          return symbol;
        }
      }
      return undefined;
    };
    const symbol = find(await this.documentSymbols(item.uri));
    return (symbol?.range ?? item.range).end.line + 1;
  }

  /** "speak" -> "Dog.speak" / "Dog::speak", using the document outline for the enclosing classes. */
  private async qualifiedName(item: vscode.CallHierarchyItem): Promise<string> {
    // Calls from top-level code come back as a file/module item; the debugger calls that frame "<module>".
    if (item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module) {
      return MODULE_NAME;
    }
    const chain: vscode.DocumentSymbol[] = [];
    for (let level = await this.documentSymbols(item.uri); ;) {
      const hit = level.find(s => s.range.contains(item.selectionRange.start));
      if (!hit) {
        break;
      }
      chain.push(hit);
      level = hit.children;
    }

    const cLike = C_LIKE_EXTENSIONS.has(path.extname(item.uri.fsPath).toLowerCase());
    let leaf = stripSignature(item.name);
    let self: vscode.DocumentSymbol | undefined = chain[chain.length - 1];
    if (self && lastSegment(stripSignature(self.name)) === lastSegment(leaf)) {
      chain.pop();
      // Some servers name out-of-line C++ members "Dog::speak" in the outline; keep the longer spelling.
      const outlineName = stripSignature(self.name);
      if (outlineName.length > leaf.length) {
        leaf = outlineName;
      }
    } else {
      self = undefined;
    }
    const separator = cLike ? '::' : '.';
    const containers = chain.filter(s => CONTAINER_KINDS.has(s.kind)).map(s => stripSignature(s.name));
    // The C/C++ extension lists out-of-line members (`void Dog::speak() const {}`) at the top level as
    // "speak() const" and puts the owning class in `detail` ("Dog").
    // Inside a namespace (`namespace geo { int Square::area() {} }`) the chain holds only the namespace.
    const owner = self?.detail ? stripSignature(self.detail) : '';
    const inClass = chain.some(s => s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Struct);
    if (cLike && owner && !inClass && !leaf.includes('::')) {
      const prefix = containers.join('::');
      if (prefix && (owner === prefix || owner.startsWith(prefix + '::'))) {
        containers.length = 0; // detail is already fully qualified ("geo::Square")
      }
      if (owner !== prefix) {
        containers.push(owner);
      }
    }
    return [...containers, leaf].join(separator);
  }

  private readonly sourceCache = new Map<string, Promise<{ uri: vscode.Uri; text: string }[]>>();

  /** Workspace source files in the same language family as `uri`, read once per build. */
  private sources(uri: vscode.Uri): Promise<{ uri: vscode.Uri; text: string }[]> {
    const ext = path.extname(uri.fsPath).toLowerCase();
    const extensions = C_LIKE_EXTENSIONS.has(ext) ? [...C_LIKE_EXTENSIONS] : [ext];
    const key = extensions.join(',');
    let files = this.sourceCache.get(key);
    if (!files) {
      const glob = `**/*{${extensions.join(',')}}`;
      files = Promise.resolve(vscode.workspace.findFiles(glob, SOURCE_EXCLUDE, MAX_SCANNED_FILES)).then(uris =>
        Promise.all(uris.map(async u => ({ uri: u, text: new TextDecoder().decode(await vscode.workspace.fs.readFile(u)) }))));
      this.sourceCache.set(key, files);
    }
    return files;
  }

  /**
   * Method calls the language server could not tie to `item` because it doesn't know the object's type
   * (`def f(shape): shape.speak()`): `.speak(` / `->speak(` call sites whose name has no definition at all.
   * Calls that resolve to some other function are left out, so a same-named method elsewhere doesn't add callers.
   */
  async unresolvedCallers(item: vscode.CallHierarchyItem, known: vscode.CallHierarchyIncomingCall[]): Promise<vscode.CallHierarchyIncomingCall[]> {
    if (item.kind !== vscode.SymbolKind.Method && !/::|\./.test(await this.qualifiedName(item))) {
      return []; // only methods are called through an object
    }
    const name = lastSegment(stripSignature(item.name));
    const knownSites = new Set(known.flatMap(c => c.fromRanges.map(r => `${c.from.uri.toString()}#${r.start.line}`)));
    const pattern = new RegExp(`(?:\\.|->)\\s*(${escapeRegExp(name)})\\s*\\(`, 'g');
    const byCaller = new Map<string, vscode.CallHierarchyIncomingCall>();
    for (const { uri, text } of await this.sources(item.uri)) {
      if (!text.includes(name)) {
        continue;
      }
      let document: vscode.TextDocument | undefined;
      for (const match of text.matchAll(pattern)) {
        document ??= await vscode.workspace.openTextDocument(uri);
        const start = document.positionAt(match.index! + match[0].indexOf(match[1], 1));
        if (knownSites.has(`${uri.toString()}#${start.line}`)) {
          continue;
        }
        const definitions = await vscode.commands.executeCommand<unknown[]>('vscode.executeDefinitionProvider', uri, start) ?? [];
        if (definitions.length > 0) {
          continue; // resolved: either already a known caller, or a call to a different function
        }
        const caller = await this.callerAt(document, start.line);
        if (!caller) {
          continue;
        }
        const range = new vscode.Range(start, start.translate(0, name.length));
        const key = locationKey(caller);
        const call = byCaller.get(key);
        if (call) {
          call.fromRanges.push(range);
        } else {
          byCaller.set(key, new vscode.CallHierarchyIncomingCall(caller, [range]));
        }
      }
    }
    const found = [...byCaller.values()];
    if (found.length) {
      this.trace(`  unresolved calls to ${name}: ${found.map(c => describeItem(c.from)).join(', ')}`);
    }
    return found;
  }

  /** The function containing `line` as a call hierarchy item, or the file itself for top-level code. */
  private async callerAt(document: vscode.TextDocument, line: number): Promise<vscode.CallHierarchyItem | undefined> {
    const position = await enclosingFunctionPosition(document.uri, line);
    if (position) {
      const [item] = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy', document.uri, position) ?? [];
      return item;
    }
    if (C_LIKE_EXTENSIONS.has(path.extname(document.uri.fsPath).toLowerCase())) {
      return undefined; // C/C++ has no top-level code that runs
    }
    const whole = new vscode.Range(0, 0, document.lineCount, 0);
    return new vscode.CallHierarchyItem(vscode.SymbolKind.File, path.basename(document.uri.fsPath), '', document.uri,
      whole, new vscode.Range(0, 0, 0, 0));
  }

  /** The id of the node already built for this item's location, if any. */
  knownId(item: vscode.CallHierarchyItem): string | undefined {
    return this.idByLocation.get(locationKey(item));
  }

  /** Top-level code, constructors/destructors and test code: real callers, but rarely what "how did we get here" is after. */
  private async isNoise(item: vscode.CallHierarchyItem, label: string): Promise<boolean> {
    const segments = label.split(/::|\./);
    const name = segments[segments.length - 1];
    const owner = segments[segments.length - 2];
    if (label === MODULE_NAME || CONSTRUCTOR_NAMES.has(name) || name.startsWith('~') || name === owner) {
      return true; // <module>, __init__/__new__/__del__, C++ ~Dog, and C++ Dog::Dog
    }
    if (item.kind === vscode.SymbolKind.Constructor || (await this.outlineSymbol(item))?.kind === vscode.SymbolKind.Constructor) {
      return true;
    }
    // Tests, judged by the path inside the workspace so a project that itself lives under ~/tests isn't all noise.
    const relative = vscode.workspace.asRelativePath(item.uri, false).replace(/\\/g, '/').toLowerCase();
    const folders = relative.split('/').slice(0, -1);
    const file = relative.split('/').pop() ?? '';
    return TEST_NAME.test(name) || (owner !== undefined && /^Test/.test(owner))
      || folders.some(f => f === 'test' || f === 'tests')
      || /^test_|_test\.[^.]+$|\.(test|spec)\.[^.]+$/.test(file);
  }

  /** The outline symbol whose name sits at this item's position, if the language server provides one. */
  private async outlineSymbol(item: vscode.CallHierarchyItem): Promise<vscode.DocumentSymbol | undefined> {
    const find = (symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
      for (const symbol of symbols) {
        if (symbol.range.contains(item.selectionRange.start)) {
          return find(symbol.children) ?? (symbol.selectionRange.contains(item.selectionRange.start) ? symbol : undefined);
        }
      }
      return undefined;
    };
    return find(await this.documentSymbols(item.uri));
  }

  /** Returns the node id for `item`, creating the node the first time. `isNew` tells the caller to keep walking. */
  async addNode(item: vscode.CallHierarchyItem): Promise<{ id: string; isNew: boolean }> {
    const location = locationKey(item);
    const known = this.idByLocation.get(location);
    if (known) {
      return { id: known, isNew: false };
    }

    const label = await this.qualifiedName(item);
    let id = makeNodeId(item.uri.fsPath, label);
    if (this.nodes.has(id)) {
      // Two different definitions with the same name (e.g. C++ overloads): keep both, distinguishable.
      id = `${id}@${item.selectionRange.start.line + 1}`;
    }
    this.idByLocation.set(location, id);
    this.nodes.set(id, {
      id,
      label,
      file: item.uri.fsPath,
      line: item.selectionRange.start.line + 1,
      endLine: await this.definitionEndLine(item),
      ...(await this.isNoise(item, label) ? { noise: true as const } : {}),
    });
    return { id, isNew: true };
  }

  get size(): number {
    return this.nodes.size;
  }

  addEdge(from: string, to: string, lines: number[]) {
    const key = `${from}->${to}`;
    const edge = this.edges.get(key) ?? { from, to, lines: [] };
    // Servers may report each call site as its own incoming call, so merge rather than overwrite.
    edge.lines = [...new Set([...edge.lines, ...lines])].sort((a, b) => a - b);
    this.edges.set(key, edge);
  }

  /** Starts from an existing graph (copied, never mutated), so a walk can extend it. Recursion is recomputed later. */
  seed(graph: CallGraph) {
    for (const { recursionGroup: _group, chokepoint: _chokepoint, ...node } of graph.nodes) {
      this.nodes.set(node.id, { ...node });
      // Same key shape as locationKey(), so a seeded graph recognises the same definitions.
      this.idByLocation.set(
        definitionKey(vscode.Uri.file(node.file).toString(), node.line - 1, node.label === MODULE_NAME), node.id);
    }
    for (const { recursive: _recursive, ...edge } of graph.edges) {
      this.edges.set(`${edge.from}->${edge.to}`, { ...edge, lines: [...edge.lines] });
    }
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  clearHiddenCallers(id: string) {
    delete this.nodes.get(id)?.hiddenCallers;
  }

  setHiddenCallers(id: string, count: number) {
    const node = this.nodes.get(id);
    if (node && count > 0) {
      node.hiddenCallers = count;
    }
  }

  /** `targetIds`: the functions PathFind was run on, which the renderer lays the graph out around. */
  result(targetIds?: string[]): CallGraph {
    return markChokepoints(markRecursion({ nodes: [...this.nodes.values()], edges: [...this.edges.values()], targetIds }));
  }
}

type Entry = { item: vscode.CallHierarchyItem; id: string };
// Callers that exist but were left out, per node id, keyed by caller location so repeat call sites count once.
type Hidden = Map<string, Set<string>>;

/**
 * Asks each entry for its callers. Callers already in the graph always get their edge. New callers are added when
 * `mayAdd` and the node limit allows; otherwise they are only recorded in `hidden`. Returns the newly added callers.
 */
async function expandLevel(builder: GraphBuilder, entries: Entry[], mayAdd: boolean, maxNodes: number, hidden: Hidden): Promise<Entry[]> {
  // One request at a time: the C/C++ extension answers overlapping call-hierarchy requests with nothing.
  const levels: { id: string; calls: vscode.CallHierarchyIncomingCall[] }[] = [];
  for (const { item, id } of entries) {
    if (item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module) {
      levels.push({ id, calls: [] }); // top-level code has no callers
      continue;
    }
    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls', item) ?? [];
    levels.push({ id, calls: [...calls, ...await builder.unresolvedCallers(item, calls)] });
  }

  const next: Entry[] = [];
  for (const { id: to, calls } of levels) {
    builder.trace(`incoming calls of ${to}: ${calls.length ? calls.map(c => describeItem(c.from)).join(', ') : 'none'}`);
    for (const call of calls) {
      if (!inWorkspace(call.from.uri)) {
        continue; // skip library / system-header callers
      }
      const lines = call.fromRanges.map(r => r.start.line + 1);
      const known = builder.knownId(call.from);
      if (known) {
        builder.addEdge(known, to, lines);
        continue;
      }
      if (!mayAdd || builder.size >= maxNodes) {
        hidden.set(to, (hidden.get(to) ?? new Set()).add(locationKey(call.from)));
        continue;
      }
      const caller = await builder.toDefinition(call.from);
      const { id: from, isNew } = await builder.addNode(caller);
      if (isNew) {
        next.push({ item: caller, id: from });
      }
      builder.addEdge(from, to, lines);
    }
  }
  return next;
}

/** Breadth-first walk up the callers of `frontier`, marking `hiddenCallers` wherever the limits cut it off. */
async function walkCallers(builder: GraphBuilder, frontier: Entry[], maxDepth: number, maxNodes: number, token?: vscode.CancellationToken) {
  const hidden: Hidden = new Map();
  // Nodes are deduplicated by definition location, so recursion terminates.
  let cancelled = false;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    if (token?.isCancellationRequested) {
      cancelled = true;
      break;
    }
    frontier = await expandLevel(builder, frontier, true, maxNodes, hidden);
  }
  // Depth limit reached with nodes still unexplored: look one level further without adding nodes, so the graph
  // gets the edges between nodes it already has and marks only the nodes that really have more callers.
  if (frontier.length > 0 && !cancelled && !token?.isCancellationRequested) {
    await expandLevel(builder, frontier, false, maxNodes, hidden);
  }
  hidden.forEach((callers, id) => builder.setHiddenCallers(id, callers.size));
}

/** The call hierarchy item for a node already in a graph, by asking the language server at its name. */
async function itemForNode(node: GraphNode): Promise<vscode.CallHierarchyItem | undefined> {
  if (node.label === MODULE_NAME) {
    return undefined; // top-level code has no callers
  }
  return prepareAtName(vscode.Uri.file(node.file), node.line - 1, lastSegment(node.label));
}

/**
 * The functions named like the word at `position`, for when the language server can't resolve it there:
 * typically `shape.speak()` where the type of `shape` is unknown. Every same-named workspace function is a target.
 */
async function prepareByName(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyItem[]> {
  const document = await vscode.workspace.openTextDocument(uri);
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_~][A-Za-z0-9_]*/);
  if (!range) {
    return [];
  }
  const name = document.getText(range);
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', name) ?? [];
  const items = new Map<string, vscode.CallHierarchyItem>();
  for (const symbol of symbols) {
    if (FUNCTION_KINDS.has(symbol.kind) && inWorkspace(symbol.location.uri)
        && lastSegment(stripSignature(symbol.name)) === name) {
      const item = await prepareAtName(symbol.location.uri, symbol.location.range.start.line, name);
      if (item) {
        items.set(locationKey(item), item);
      }
    }
  }
  return [...items.values()];
}

/**
 * Where the name of the innermost function containing `line` (0-based) is, for running PathFind from any line inside
 * a function (e.g. where a debugger stopped). Undefined when the line isn't inside a function (top-level code).
 */
export async function enclosingFunctionPosition(uri: vscode.Uri, line: number): Promise<vscode.Position | undefined> {
  const symbols = (await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    'vscode.executeDocumentSymbolProvider', uri) ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s);
  let found: vscode.DocumentSymbol | undefined;
  const visit = (list: vscode.DocumentSymbol[]) => {
    for (const symbol of list) {
      if (symbol.range.start.line <= line && line <= symbol.range.end.line) {
        if (FUNCTION_KINDS.has(symbol.kind)) {
          found = symbol; // keep descending: a nested function is more specific
        }
        visit(symbol.children);
      }
    }
  };
  visit(symbols);
  return found?.selectionRange.start;
}

/**
 * Builds the "how did we get here" graph for the function at `position`:
 * the function itself plus every transitive caller, with edges pointing caller -> callee.
 * `position` may be on a definition, a prototype, or a call site.
 * Returns undefined if no language server can resolve a function at that position.
 */
export async function buildCallGraph(
  uri: vscode.Uri,
  position: vscode.Position,
  { maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES, token, trace }: BuildOptions = {},
): Promise<CallGraph | undefined> {
  let prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, position) ?? [];
  const builder = new GraphBuilder(trace);
  if (!prepared.length) {
    prepared = await prepareByName(uri, position);
    builder.trace(`not resolved at the cursor; by name: ${prepared.length ? prepared.map(describeItem).join(', ') : 'none'}`);
  }
  if (!prepared.length) {
    return undefined;
  }

  prepared.forEach(item => builder.trace(`prepared: ${describeItem(item)}`));
  const frontier: Entry[] = [];
  const targetIds = new Set<string>();
  for (const preparedItem of prepared) {
    const item = await builder.toDefinition(preparedItem);
    const { id, isNew } = await builder.addNode(item);
    targetIds.add(id);
    if (isNew) {
      frontier.push({ item, id });
    }
  }
  await walkCallers(builder, frontier, maxDepth, maxNodes, token);
  return builder.result([...targetIds]);
}

/**
 * Loads more callers above one node of an existing graph (typically one marked with `hiddenCallers`), using the
 * same limits as buildCallGraph counted from that node, and returns the merged graph. `graph` is not modified.
 * Other marked nodes are re-checked afterwards: a caller they were missing may have just joined the graph, in
 * which case they get its edge and their marker is updated or removed.
 */
export async function expandCallers(
  graph: CallGraph,
  nodeId: string,
  { maxDepth = DEFAULT_MAX_DEPTH, maxNodes = DEFAULT_MAX_NODES, token, trace }: BuildOptions = {},
): Promise<CallGraph> {
  const builder = new GraphBuilder(trace);
  builder.seed(graph);
  const node = builder.node(nodeId);
  const item = node && await itemForNode(node);
  if (!item) {
    builder.trace(`expand: no call hierarchy item for ${nodeId}`);
    return builder.result(graph.targetIds);
  }

  builder.clearHiddenCallers(nodeId);
  await walkCallers(builder, [{ item, id: nodeId }], maxDepth, maxNodes, token);

  const stale: Entry[] = [];
  for (const marked of graph.nodes.filter(n => n.hiddenCallers && n.id !== nodeId)) {
    const markedItem = await itemForNode(marked);
    if (markedItem) {
      builder.clearHiddenCallers(marked.id);
      stale.push({ item: markedItem, id: marked.id });
    }
  }
  const hidden: Hidden = new Map();
  await expandLevel(builder, stale, false, maxNodes, hidden);
  hidden.forEach((callers, id) => builder.setHiddenCallers(id, callers.size));

  return builder.result(graph.targetIds);
}
