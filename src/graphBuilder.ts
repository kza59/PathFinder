import * as vscode from 'vscode';
import { makeNodeId, MODULE_NAME } from './nodeId';

export interface GraphNode {
  id: string;     // makeNodeId(file, label)
  label: string;  // function name
  file: string;   // absolute path, for jump-to-source
  line: number;   // 1-based line of the function name (same base as debugger frames)
}

export interface GraphEdge {
  from: string;   // caller id
  to: string;     // callee id
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildOptions {
  maxDepth?: number;
  maxNodes?: number;
  token?: vscode.CancellationToken;
}

function functionName(item: vscode.CallHierarchyItem): string {
  // Calls from top-level code come back as a file/module item; the debugger calls that frame "<module>".
  return item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module
    ? MODULE_NAME
    : item.name;
}

function idOf(item: vscode.CallHierarchyItem): string {
  return makeNodeId(item.uri.fsPath, functionName(item));
}

function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

/**
 * Builds the "how did we get here" graph for the function at `position`:
 * the function itself plus every transitive caller, with edges pointing caller -> callee.
 * Returns undefined if no language server can resolve a function at that position.
 */
export async function buildCallGraph(
  uri: vscode.Uri,
  position: vscode.Position,
  { maxDepth = 15, maxNodes = 300, token }: BuildOptions = {},
): Promise<CallGraph | undefined> {
  const roots = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy', uri, position);
  if (!roots?.length) {
    return undefined;
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (item: vscode.CallHierarchyItem) => {
    const id = idOf(item);
    nodes.set(id, {
      id,
      label: functionName(item),
      file: item.uri.fsPath,
      line: item.selectionRange.start.line + 1,
    });
  };

  roots.forEach(addNode);
  let frontier = roots;

  // Breadth-first walk up the callers; `nodes` doubles as the visited set, so recursion terminates.
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    if (token?.isCancellationRequested) {
      break;
    }
    const levels = await Promise.all(frontier.map(async item => ({
      item,
      calls: await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls', item) ?? [],
    })));

    const next: vscode.CallHierarchyItem[] = [];
    for (const { item, calls } of levels) {
      const to = idOf(item);
      for (const call of calls) {
        if (!inWorkspace(call.from.uri)) {
          continue; // skip library / site-packages callers
        }
        const from = idOf(call.from);
        if (!nodes.has(from)) {
          if (nodes.size >= maxNodes) {
            continue;
          }
          addNode(call.from);
          next.push(call.from);
        }
        edges.set(`${from}->${to}`, { from, to });
      }
    }
    frontier = next;
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
