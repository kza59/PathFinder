// TEMPORARY: logs the live recursion depth to its own "PathFinder Recursion" output channel on each debugger
// pause, so recursionDepth can be watched while stepping until the panel shows it. Remove this file and its
// one registration line in extension.ts once B's banner lands.
import * as vscode from 'vscode';
import { createTracker, resolveDebugPath } from './debugTracker';
import { recursionDepth } from './recursion';
import { PathFindPanel } from './webview/PathFindPanel';

// VS Code fetches each paused stack in pages (top frame first, then the rest) within a few milliseconds.
// Waiting this long after the last page means each pause is logged once, with its full stack.
const SETTLE_MS = 150;

function announcement(depth: number): string {
  if (depth >= 100) return 'STACK OVERFLOW IMMINENT!!!';
  if (depth >= 10) return 'MONSTER RECURSION!!';
  if (depth >= 6) return 'RAMPAGE!';
  if (depth >= 4) return 'ULTRA RECURSION!';
  return ['', 'RECURSION!', 'DOUBLE RECURSION!', 'TRIPLE RECURSION!'][depth];
}

export function registerRecursionLog(context: vscode.ExtensionContext): void {
  // Its own channel: the PathFind command clears the main PathFinder channel each time it runs.
  const channel = vscode.window.createOutputChannel('PathFinder Recursion');
  context.subscriptions.push(channel);
  let pauses = 0;

  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return createTracker(() => PathFindPanel.currentPanel?.currentGraph, frames => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const graph = PathFindPanel.currentPanel?.currentGraph;
          const prefix = `[pause ${++pauses}, ${frames.length} frames]`;
          if (!graph) {
            channel.appendLine(`${prefix} no PathFind graph open: run PathFind first`);
          } else {
            const label = new Map(graph.nodes.map(n => [n.id, n.label]));
            const levels = recursionDepth(resolveDebugPath(frames, graph), graph);
            channel.appendLine(levels.length
              ? `${prefix} ${levels.map(l => `${l.members.map(id => label.get(id)).join(' <-> ')}: depth ${l.depth}  ${announcement(l.depth)}`).join('  |  ')}`
              : `${prefix} no recursion on the stack`);
          }
          channel.show(true);
        }, SETTLE_MS);
      });
    },
  }));
}
