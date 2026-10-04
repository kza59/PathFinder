import * as path from 'path';
import * as vscode from 'vscode';
import { makeNodeId, MODULE_NAME, normalizePath } from './nodeId';

export interface GraphNode {
  id: string;       // makeNodeId(file, label)
  label: string;    // qualified function name: "function1", "Dog.speak" (Python), "Dog::speak" (C++)
  file: string;     // absolute path of the definition (never a prototype), for jump-to-source
  line: number;     // 1-based line of the function name (same base as debugger frames)
  endLine: number;  // 1-based last line of the function body
}

export interface GraphEdge {
  from: string;     // caller id
  to: string;       // callee id
  lines: number[];  // 1-based lines in the caller's file where it calls the callee, ascending (one per call site)
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildOptions {
  maxDepth?: number;
  maxNodes?: number;
  token?: vscode.CancellationToken;
  trace?: (message: string) => void; // logs every language-server answer, for debugging missing callers
}

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

  /** Returns the node id for `item`, creating the node the first time. `isNew` tells the caller to keep walking. */
  async addNode(item: vscode.CallHierarchyItem): Promise<{ id: string; isNew: boolean }> {
    const location = `${item.uri.toString()}#${item.selectionRange.start.line}`;
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

  result(): CallGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
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
  { maxDepth = 15, maxNodes = 300, token, trace }: BuildOptions = {},
): Promise<CallGraph | undefined> {
  const prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, position);
  if (!prepared?.length) {
    return undefined;
  }

  const builder = new GraphBuilder(trace);
  prepared.forEach(item => builder.trace(`prepared: ${describeItem(item)}`));
  type Entry = { item: vscode.CallHierarchyItem; id: string };
  let frontier: Entry[] = [];
  for (const preparedItem of prepared) {
    const item = await builder.toDefinition(preparedItem);
    const { id, isNew } = await builder.addNode(item);
    if (isNew) {
      frontier.push({ item, id });
    }
  }

  // Breadth-first walk up the callers; nodes are deduplicated by definition location, so recursion terminates.
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    if (token?.isCancellationRequested) {
      break;
    }
    // One request at a time: the C/C++ extension answers overlapping call-hierarchy requests with nothing.
    const levels: { id: string; calls: vscode.CallHierarchyIncomingCall[] }[] = [];
    for (const { item, id } of frontier) {
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
        if (builder.size >= maxNodes) {
          break;
        }
        const caller = await builder.toDefinition(call.from);
        const { id: from, isNew } = await builder.addNode(caller);
        if (isNew) {
          next.push({ item: caller, id: from });
        }
        builder.addEdge(from, to, call.fromRanges.map(r => r.start.line + 1));
      }
    }
    frontier = next;
  }

  return builder.result();
}
