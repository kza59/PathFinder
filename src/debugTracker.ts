import * as vscode from 'vscode';
import { makeId } from './shared/makeId';
import { postToWebview } from './shared/webviewBridge';

// Minimal slices of the Debug Adapter Protocol types we touch (avoids a dependency).
interface DapFrame {
  name: string;
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
  postToWebview({ type: 'highlight', path });
}

/**
 * Registers a tracker on every debug session (any language) that emits the
 * live call path whenever VS Code fetches the stack after the debugger pauses.
 */
export function registerDebugTracker(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: () => createTracker(),
    })
  );
}

function createTracker(): vscode.DebugAdapterTracker {
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

      const path = [...frames]
        .reverse() // outer caller first
        .filter((f) => !!f.source?.path) // skip frames with no file (native/internal)
        .map((f) => makeId(f.source!.path!, f.name));

      console.log('[PathFinder] debug path:', path);
      sendHighlight(path);
    },
  };
}
