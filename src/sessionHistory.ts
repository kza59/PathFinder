import * as vscode from 'vscode';
import { resolveDebugPath, sessionHistoryHook } from './debugTracker';
import type { HistoryStep, SessionHistoryMessage } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

/**
 * Session history: records every debugger pause (breakpoints, steps, exceptions, ...) of a debug
 * session in order, so that after the session ends the webview can scrub through them.
 *
 * - One pause = one step. VS Code fetches a pause's stack in pages (top frame, then the rest, and
 *   again on "load more"), so a pause's step is UPDATED in place as frames arrive, never re-added.
 * - Steps keep raw frames (file/line/name), resolved to node ids only when sent, so a graph opened
 *   after the session re-maps the whole history onto its own nodes.
 * - A new top-level session clears the history (so Restart starts over); child sessions
 *   (subprocesses, compound launches) add to their parent's. Ending the top-level session keeps it.
 * - While recording only the count is sent (the scrubber is read-only during a live session, so it
 *   never fights the live highlight); the full steps are sent once the session ends.
 * Any debugger type: it only uses stack frames.
 */

export const MAX_STEPS = 5000;  // oldest steps are dropped beyond this
export const MAX_FRAMES = 100;  // deepest frames are dropped beyond this (the path keeps the inner ones)
const RECORDING_UPDATE_MS = 300;

export interface FrameLike {
  name: string;
  line: number;
  source?: { path?: string };
}

interface RecordedPause {
  reason: string;
  frames: FrameLike[]; // top of stack first
  time: number;        // ms since the session started
  session: string;
}

/** What createTracker calls for one session. */
export interface SessionHistoryTap {
  paused(reason: string | undefined): void;
  framesChanged(frames: readonly FrameLike[]): void;
}

/** The ordered pauses of the current (or last) top-level session. No vscode dependency. */
export class SessionHistory {
  private pauses: RecordedPause[] = [];
  private rootId: string | undefined;
  private startedAt = 0;
  private generation = 0;
  public dropped = 0;
  public recording = false;

  constructor(
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  get count(): number {
    return this.pauses.length;
  }

  get hasSession(): boolean {
    return this.rootId !== undefined;
  }

  /** A top-level session started: clear and record it. */
  start(rootId: string): void {
    this.pauses = [];
    this.rootId = rootId;
    this.startedAt = this.now();
    this.generation++;
    this.dropped = 0;
    this.recording = true;
    this.onChange();
  }

  /** A session ended; only the top-level one stops the recording. The steps are kept. */
  end(sessionId: string): boolean {
    if (sessionId !== this.rootId || !this.recording) {
      return false;
    }
    this.recording = false;
    this.generation++; // late stack responses from the ended session can't add steps
    this.onChange();
    return true;
  }

  /** Per-session hooks for the tracker. Each session tracks its own open pause. */
  tap(sessionName: string): SessionHistoryTap {
    let open: { pause: RecordedPause; added: boolean; generation: number } | undefined;
    return {
      paused: reason => {
        open = this.recording
          ? { pause: { reason: reason || 'pause', frames: [], time: this.now() - this.startedAt, session: sessionName }, added: false, generation: this.generation }
          : undefined;
      },
      framesChanged: frames => {
        if (!open || open.generation !== this.generation || !frames.length) {
          return;
        }
        open.pause.frames = frames.slice(0, MAX_FRAMES).map(frame => ({
          name: frame.name, line: frame.line, source: { path: frame.source?.path },
        }));
        if (!open.added) {
          open.added = true;
          this.pauses.push(open.pause);
          if (this.pauses.length > MAX_STEPS) {
            this.pauses.shift();
            this.dropped++;
          }
          this.onChange();
        }
      },
    };
  }

  /** The steps, oldest first, with paths resolved by `resolve` (outer caller first, like debugPath). */
  steps(resolve: (frames: FrameLike[]) => string[]): HistoryStep[] {
    return this.pauses.map(pause => {
      const top = pause.frames[0];
      return {
        path: resolve(pause.frames),
        reason: pause.reason,
        time: pause.time,
        session: pause.session,
        ...(top?.source?.path ? { where: { name: top.name, file: top.source.path, line: top.line } } : {}),
      };
    });
  }
}

// --- extension wiring ---

let publishSoon: (() => void) | undefined;
const history = new SessionHistory(() => publishSoon?.());

/** The tracker hooks for a session; a top-level session (or the first one seen) starts a new history. */
function tapSession(session: vscode.DebugSession): SessionHistoryTap {
  if (!session.parentSession || !history.hasSession) {
    history.start(session.id);
  }
  return history.tap(session.name);
}

export function sessionHistoryMessage(graph = PathFindPanel.currentPanel?.currentGraph): SessionHistoryMessage {
  return history.recording
    ? { type: 'sessionHistory', state: 'recording', count: history.count, dropped: history.dropped }
    : { type: 'sessionHistory', state: 'ended', steps: history.steps(frames => resolveDebugPath(frames, graph)), dropped: history.dropped };
}

export function registerSessionHistory(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;
  const publish = (panel = PathFindPanel.currentPanel) => {
    clearTimeout(timer);
    timer = undefined;
    if (panel && history.hasSession) {
      panel.setSessionHistory(sessionHistoryMessage(panel.currentGraph));
    }
  };
  // While recording, batch the count updates; the end (and anything after it) goes out at once.
  publishSoon = () => {
    if (!history.recording) {
      publish();
    } else if (!timer) {
      timer = setTimeout(() => publish(), RECORDING_UPDATE_MS);
    }
  };
  sessionHistoryHook.tap = tapSession;
  context.subscriptions.push(
    { dispose: () => { clearTimeout(timer); publishSoon = undefined; sessionHistoryHook.tap = undefined; } },
    vscode.debug.onDidTerminateDebugSession(session => history.end(session.id)),
    // A new graph (or a re-opened panel's first graph) gets the history re-mapped onto its nodes.
    PathFindPanel.onDidRenderGraph(panel => publish(panel)),
  );
}
// --- end extension wiring ---
