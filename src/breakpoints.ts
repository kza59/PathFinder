import * as vscode from 'vscode';
import { findNodeForFrame } from './graphBuilder';
import type { BreakpointCounts, GraphData } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

/**
 * Breakpoint markers: marks the graph nodes whose function has a breakpoint set in it.
 *
 * Breakpoints are read from VS Code (vscode.debug.breakpoints), not from a debugger, so this works
 * for every language and with no debug session running. The counts are recomputed and sent to the
 * panel whenever breakpoints change and whenever a graph is rendered.
 *
 * Counted: enabled source breakpoints (including conditional / hit-count ones), and enabled function
 * breakpoints whose name is exactly a node's label ("sum", "Dog.speak", "Dog::speak").
 * Not counted: disabled breakpoints, logpoints (they never pause), data/exception breakpoints.
 */

/**
 * Breakpoints per graph node id; nodes without breakpoints are absent. A source breakpoint belongs
 * to the node findNodeForFrame picks for its file + line (same path normalization as node ids,
 * innermost function for nested defs), so it lands exactly where a debugger pause there would.
 */
export function breakpointCounts(breakpoints: readonly vscode.Breakpoint[], graph: GraphData | undefined): BreakpointCounts {
  const counts: BreakpointCounts = {};
  if (!graph) {
    return counts;
  }
  const add = (id: string) => { counts[id] = (counts[id] ?? 0) + 1; };
  for (const breakpoint of breakpoints) {
    if (!breakpoint.enabled || breakpoint.logMessage) {
      continue;
    }
    if (breakpoint instanceof vscode.SourceBreakpoint) {
      const { uri, range } = breakpoint.location;
      if (uri.scheme !== 'file') {
        continue; // untitled / virtual documents are never graph nodes
      }
      // VS Code positions are 0-based; graph lines are 1-based (like debugger frames).
      const node = findNodeForFrame(graph, uri.fsPath, range.start.line + 1);
      if (node) {
        add(node.id);
      }
    } else if (breakpoint instanceof vscode.FunctionBreakpoint) {
      graph.nodes.filter(node => node.label === breakpoint.functionName).forEach(node => add(node.id));
    }
  }
  return counts;
}

export function registerBreakpointMarkers(context: vscode.ExtensionContext): void {
  const publish = (panel = PathFindPanel.currentPanel) => {
    panel?.setBreakpoints(breakpointCounts(vscode.debug.breakpoints, panel.currentGraph));
  };
  context.subscriptions.push(
    vscode.debug.onDidChangeBreakpoints(() => publish()),
    // A new graph (or a re-opened panel's first graph) gets the current breakpoints mapped onto its nodes.
    PathFindPanel.onDidRenderGraph(panel => publish(panel)),
  );
}
