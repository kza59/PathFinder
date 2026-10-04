import * as vscode from 'vscode';
import { findNodeForFrame } from './graphBuilder';
import type { DebugPath, GraphData } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

// Minimal slices of the Debug Adapter Protocol types we touch (avoids a dependency).
interface DapFrame {
  name: string;
  line: number;
  source?: { path?: string };
}
interface DapMessage {
  type: 'request' | 'response' | 'event';
  seq: number;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  arguments?: { threadId?: number; startFrame?: number };
  body?: { threadId?: number; stackFrames?: DapFrame[] };
}

/** Send the live path to the webview. Path is OUTER CALLER FIRST, current function LAST. */
export function sendHighlight(path: string[]): void {
  PathFindPanel.currentPanel?.highlightPath(path);
}

/**
 * Registers a tracker on every debug session (any language) that emits the
 * live call path whenever VS Code fetches the stack after the debugger pauses.
 */
export function registerDebugTracker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: () => createTracker(() => PathFindPanel.currentPanel?.currentGraph),
    }),
  );
}

export function resolveDebugPath(frames: DapFrame[], graph: GraphData | undefined): DebugPath {
  const nodeIds = new Set(graph?.nodes.map(node => node.id));
  return [...frames].reverse().map((frame, index) => {
    const node = graph && frame.source?.path
      ? findNodeForFrame(graph, frame.source.path, frame.line)
      : undefined;
    if (node) {
      return node.id;
    }
    // Keep unknown frames in place: do not join disconnected callers or mark
    // a caller as current when the actual current function is outside the graph.
    let unknownId = `pathfinder-unmatched-frame-${index}`;
    while (nodeIds.has(unknownId)) {
      unknownId = `_${unknownId}`;
    }
    return unknownId;
  });
}

export function createTracker(
  getGraph: () => GraphData | undefined,
  onFramesChanged: (frames: DapFrame[]) => void = frames =>
    sendHighlight(resolveDebugPath(frames, getGraph())),
): vscode.DebugAdapterTracker {
  // VS Code fetches the stack in PAGES: first just the top frame (startFrame 0, levels 1),
  // then the rest (startFrame 1, ...). So we remember each stackTrace request's arguments
  // and accumulate the frames, instead of trusting a single response.
  const pendingRequests = new Map<number, { threadId?: number; startFrame: number }>();
  let stoppedThreadId: number | undefined;
  let frames: DapFrame[] = []; // top of stack first, as DAP sends them

  return {
    // VS Code -> debug adapter
    onWillReceiveMessage: (msg: DapMessage) => {
      if (msg.type === 'request' && msg.command === 'stackTrace') {
        pendingRequests.set(msg.seq, {
          threadId: msg.arguments?.threadId,
          startFrame: msg.arguments?.startFrame ?? 0,
        });
      }
    },

    // debug adapter -> VS Code
    onDidSendMessage: (msg: DapMessage) => {
      // Remember which thread paused so other threads' stacks are ignored.
      if (msg.type === 'event' && msg.event === 'stopped') {
        stoppedThreadId = msg.body?.threadId;
        return;
      }

      if (msg.type !== 'response' || msg.command !== 'stackTrace') {
        return;
      }
      const req = pendingRequests.get(msg.request_seq!);
      pendingRequests.delete(msg.request_seq!);
      if (!msg.success || !req) {
        return;
      }
      if (stoppedThreadId !== undefined && req.threadId !== stoppedThreadId) {
        return;
      }

      // startFrame 0 = a fresh stack; otherwise append this page at its offset.
      const page = msg.body?.stackFrames ?? [];
      frames = frames.slice(0, req.startFrame).concat(page);
      onFramesChanged(frames);
    },
  };
}
