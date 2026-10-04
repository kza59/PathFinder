import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveDebugPath } from './debugTracker';
import { buildCallGraph, enclosingFunctionPosition, findNodeForFrame } from './graphBuilder';
import type { GraphData } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

/**
 * Opens the graph on a crash: when the debugger stops because of an exception (Python exceptions, C/C++ signals such
 * as a segfault or an abort all arrive as the reason "exception"), PathFinder shows how the program got there without
 * the user running PathFind first.
 *
 * The crash is located at the innermost frame in the project's own code (not libc or the C++ standard library). If the
 * open graph already contains that function it is kept; otherwise the crashing function's graph is built and opened.
 * Then the crash path is highlighted and marked as a crash (PathFindPanel.setCrashed), which clears again when the
 * program continues, stops for another reason, or ends.
 */

interface DapFrame {
  name: string;
  line: number;
  source?: { path?: string };
}

const RETRY_MS = 2000; // the language server can still be indexing when a program crashes right after launch

const isProjectFrame = (frame: DapFrame) => Boolean(frame.source?.path && fs.existsSync(frame.source.path)
  && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(frame.source.path)) !== undefined);

export function registerCrashGraph(context: vscode.ExtensionContext, openGraph: (graph: GraphData) => PathFindPanel): void {
  const output = vscode.window.createOutputChannel('PathFinder Crash');
  let latestCrash = 0; // a newer stop makes an earlier crash's (slower) graph build irrelevant

  const showCrash = async (session: vscode.DebugSession, threadId: number | undefined, crash: number) => {
    const reply = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 500 });
    const frames: DapFrame[] = reply?.stackFrames ?? [];
    const crashed = frames.find(isProjectFrame);
    if (!crashed) {
      return; // the crash is entirely outside the project's code
    }
    const file = crashed.source!.path!;

    let panel = PathFindPanel.currentPanel;
    let graph = panel?.currentGraph;
    if (!graph || !findNodeForFrame(graph, file, crashed.line)) {
      const uri = vscode.Uri.file(file);
      const position = await enclosingFunctionPosition(uri, crashed.line - 1);
      if (!position) {
        output.appendLine(`Crash at ${file}:${crashed.line} is outside any function; not opening a graph.`);
        return;
      }
      graph = await buildCallGraph(uri, position)
        ?? await new Promise(resolve => setTimeout(resolve, RETRY_MS)).then(() => buildCallGraph(uri, position));
      if (!graph) {
        output.appendLine(`Couldn't build a graph for the crash at ${file}:${crashed.line} (is the language server still loading?).`);
        return;
      }
      if (crash !== latestCrash) {
        return;
      }
      panel = openGraph(graph);
    }
    panel!.highlightPath(resolveDebugPath(frames, graph));
    panel!.setCrashed(true);
    vscode.window.setStatusBarMessage(`$(error) PathFinder: showing how the program reached the crash in ${crashed.name}`, 8000);
  };

  context.subscriptions.push(
    output,
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: session => ({
        onDidSendMessage: (message: { type?: string; event?: string; body?: { reason?: string; threadId?: number } }) => {
          if (message.type !== 'event') {
            return;
          }
          if (message.event === 'stopped') {
            const crash = ++latestCrash;
            if (message.body?.reason !== 'exception') {
              PathFindPanel.currentPanel?.setCrashed(false);
              return;
            }
            if (!vscode.workspace.getConfiguration('pathfinder').get<boolean>('openGraphOnCrash', true)) {
              return;
            }
            showCrash(session, message.body.threadId, crash).catch(error =>
              output.appendLine(`Couldn't show the crash path: ${error instanceof Error ? error.message : error}`));
          } else if (message.event === 'continued') {
            PathFindPanel.currentPanel?.setCrashed(false);
          }
        },
      }),
    }),
  );
}
