import * as path from 'path';
import * as vscode from 'vscode';
import { makeNodeId, MODULE_NAME, normalizePath } from './nodeId';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES } from './limits';
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
  noise?: true;            // usually uninteresting: top-level <module> code, constructors/destructors, tests
}

export interface GraphEdge {
  from: string;     // caller id
  to: string;       // callee id
  lines: number[];  // 1-based lines in the caller's file where it calls the callee, ascending (one per call site)
  recursive?: true; // set when both ends share a recursionGroup, i.e. this call is part of a cycle
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

function locationKey(item: vscode.CallHierarchyItem): string {
  return `${item.uri.toString()}#${item.selectionRange.start.line}`;
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
    if (cLike && containers.length === 0 && !leaf.includes('::') && self?.detail) {
      containers.push(self.detail);
    }
    return [...containers, leaf].join(separator);
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
    for (const { recursionGroup: _group, ...node } of graph.nodes) {
      this.nodes.set(node.id, { ...node });
      this.idByLocation.set(`${vscode.Uri.file(node.file).toString()}#${node.line - 1}`, node.id);
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
    return markRecursion({ nodes: [...this.nodes.values()], edges: [...this.edges.values()], targetIds });
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
    levels.push({
      id,
      calls: await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls', item) ?? [],
    });
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
  const uri = vscode.Uri.file(node.file);
  const text = (await vscode.workspace.openTextDocument(uri)).lineAt(node.line - 1).text;
  const name = lastSegment(node.label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const column = Math.max(text.search(new RegExp(`\\b${name}\\b`)), 0);
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, new vscode.Position(node.line - 1, column)) ?? [];
  return items.find(i => i.selectionRange.start.line === node.line - 1) ?? items[0];
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
  const prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, position);
  if (!prepared?.length) {
    return undefined;
  }

  const builder = new GraphBuilder(trace);
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
