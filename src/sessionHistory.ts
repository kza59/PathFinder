import * as vscode from 'vscode';
import { shortenValue } from './callValues'; // per-step variable capture (no vscode imports there)
import { resolveDebugPath, sessionHistoryHook } from './debugTracker';
import type { CallArg, CallValue, CallValues, HistoryStep, SessionHistoryMessage, StepValues } from './types';
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
 *
 * --- per-step variable capture ---
 * A step can also carry the VARIABLE VALUES of its innermost few frames, so scrubbing shows what
 * the program held at that pause instead of "nothing recorded". Those values are a copy of what the
 * call-values capture already read at that pause (src/callValues.ts), handed over through the tap's
 * `valuesCaptured`: no extra DAP request, and nothing is read from the debuggee here.
 * --- end per-step variable capture ---
 */

export const MAX_STEPS = 5000;  // oldest steps are dropped beyond this
export const MAX_FRAMES = 100;  // deepest frames are dropped beyond this (the path keeps the inner ones)
const RECORDING_UPDATE_MS = 300;

// --- per-step variable capture ---
/**
 * Caps on the recorded values. They are far tighter than the live call-values caps because the
 * trade is different: one live snapshot costs ~180 KB of characters at worst, which is fine once
 * and ruinous five thousand times over (~1.8 GB). What survives per frame is the handful of names
 * and short values a reader actually scans in the inspector panel.
 */
// --- watch variable ---
// Raised from 3 for the watch feature: it reads one name across every node of the highlighted
// path at once, so a three-node window barely shows a chain. See the budget note below for what
// the extra frames cost.
// --- end watch variable ---
export const MAX_SNAPSHOT_FRAMES = 6;   // innermost distinct nodes per step
export const MAX_SNAPSHOT_ARGS = 8;     // parameters per frame; nothing else bounds these at all
export const MAX_SNAPSHOT_LOCALS = 12;  // non-parameter locals per frame (the live tooltip keeps 20)
export const MAX_SNAPSHOT_VALUE = 80;   // one value, through shortenValue (the live tooltip keeps 300)
export const MAX_SNAPSHOT_NAME = 40;    // one name; identifiers are shorter in practice
/**
 * Total characters of recorded values across the whole history. Past it the OLDEST steps' values
 * are dropped while their paths stay: a path is cheap and always meaningful, values are the
 * expensive part, and a step without them falls back to the message the pane already had.
 * Worst case per step is ~18 KB of characters (6 frames x 20 variables x ~145), so a pathological
 * session keeps values for ~230 steps; a typical one (~800 characters a step) keeps every step,
 * since MAX_STEPS binds first. Ceiling: 4 MB of characters, about 8 MB in memory - the ceiling is
 * what MAX_SNAPSHOT_FRAMES trades against, so raising it costs steps-with-values, never memory.
 */
export const MAX_SNAPSHOT_CHARS = 4 * 1024 * 1024;
// --- end per-step variable capture ---

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
  // --- per-step variable capture ---
  values?: Record<string, StepValues>; // keyed by graph node id, as resolved when it was captured
  valueChars?: number;                 // what `values` costs the budget, so eviction can refund it
  // --- end per-step variable capture ---
}

/** What createTracker calls for one session. */
export interface SessionHistoryTap {
  paused(reason: string | undefined): void;
  framesChanged(frames: readonly FrameLike[]): void;
  /** per-step variable capture: the call-values capture's result for the pause now open. */
  valuesCaptured(values: CallValues): void;
}

// --- per-step variable capture ---
/**
 * One variable, reduced to what a recorded step keeps: a name and a shortened value.
 *
 * `ref` is dropped because it dies with its pause, and `type` because it is not worth the budget.
 * shortenValue does the work before the length cap - it collapses whitespace, drops object
 * addresses and rewrites `<__main__.Dog object>` as `<Dog>` - so 80 characters carry more meaning
 * than a raw slice of the same length would. A parameter with no value stays valueless, so the pane
 * still reports it as missing from Locals rather than inventing one.
 */
function snapshotArg(arg: CallArg): CallArg {
  return {
    name: shortenValue(arg.name, MAX_SNAPSHOT_NAME),
    ...(arg.value === undefined ? {} : { value: shortenValue(arg.value, MAX_SNAPSHOT_VALUE) }),
  };
}

function snapshotFrame(value: CallValue): StepValues {
  return {
    args: value.args.slice(0, MAX_SNAPSHOT_ARGS).map(snapshotArg),
    locals: (value.locals ?? []).slice(0, MAX_SNAPSHOT_LOCALS).map(snapshotArg),
    // Already shortened for the node's band by the local variables feature: copied, not re-capped.
    ...(value.localsRows?.length ? { localsRows: [...value.localsRows] } : {}),
    ...(value.localsCount === undefined ? {} : { localsCount: value.localsCount }),
    ...(value.atEntry ? { atEntry: true } : {}), // absent means false: the common case, so cheaper
  };
}

/** `{ values }` for the ids this graph still has on the step's path, or `{}` when none are left. */
function valuesOnPath(
  values: Record<string, StepValues> | undefined,
  path: readonly string[],
): { values?: Record<string, StepValues> } {
  if (!values) {
    return {};
  }
  const onPath = new Set(path);
  const kept = Object.entries(values).filter(([id]) => onPath.has(id));
  return kept.length ? { values: Object.fromEntries(kept) } : {};
}

/**
 * The innermost MAX_SNAPSHOT_FRAMES nodes of a capture, reduced to strings.
 * CallValues arrives innermost-node-first (see CallValuesDeps.onCapture). `stale` entries are
 * skipped as insurance: only a fresh capture calls onCapture today, and a step must never record
 * values belonging to a pause the program has already left.
 */
export function snapshotValues(values: CallValues): Record<string, StepValues> | undefined {
  const kept = Object.entries(values)
    .filter(([, value]) => !value.stale)
    .slice(0, MAX_SNAPSHOT_FRAMES)
    .map(([id, value]) => [id, snapshotFrame(value)] as const);
  return kept.length ? Object.fromEntries(kept) : undefined;
}
// --- end per-step variable capture ---

/** The ordered pauses of the current (or last) top-level session. No vscode dependency. */
export class SessionHistory {
  private pauses: RecordedPause[] = [];
  private rootId: string | undefined;
  private startedAt = 0;
  private generation = 0;
  private valueChars = 0; // per-step variable capture: characters of recorded values, for the budget
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
    this.valueChars = 0; // per-step variable capture
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
            const gone = this.pauses.shift();
            this.valueChars -= gone?.valueChars ?? 0; // per-step variable capture: refund the budget
            this.dropped++;
          }
          this.onChange();
        }
      },
      // --- per-step variable capture ---
      // The capture is debounced and asynchronous, so this lands AFTER framesChanged pushed the
      // step: the open pause is already in `pauses` and is updated in place. The same guard
      // framesChanged uses applies - a pause from an older generation (the program resumed, or a
      // new session started) must not write values onto the current one. A step that loses the race
      // because the program resumed inside the debounce simply keeps no values; that is why the
      // field is optional.
      valuesCaptured: values => {
        if (!open || open.generation !== this.generation || !open.added) {
          return;
        }
        const snapshot = snapshotValues(values);
        if (!snapshot) {
          return;
        }
        const pause = open.pause;
        this.valueChars -= pause.valueChars ?? 0; // a re-capture of the same pause replaces, not adds
        pause.values = snapshot;
        pause.valueChars = JSON.stringify(snapshot).length;
        this.valueChars += pause.valueChars;
        this.evictValues();
        // Deliberately no onChange(): the step count has not moved, and while recording that is
        // all that is published. Values travel with the steps once the session ends.
      },
      // --- end per-step variable capture ---
    };
  }

  // --- per-step variable capture ---
  /** Over the character budget: clear the OLDEST steps' values, keeping their paths. */
  private evictValues(): void {
    for (const pause of this.pauses) {
      if (this.valueChars <= MAX_SNAPSHOT_CHARS) {
        return;
      }
      if (pause.values) {
        this.valueChars -= pause.valueChars ?? 0;
        pause.values = undefined;
        pause.valueChars = undefined;
      }
    }
  }
  // --- end per-step variable capture ---

  /** The steps, oldest first, with paths resolved by `resolve` (outer caller first, like debugPath). */
  steps(resolve: (frames: FrameLike[]) => string[]): HistoryStep[] {
    return this.pauses.map(pause => {
      const top = pause.frames[0];
      const path = resolve(pause.frames);
      return {
        path,
        reason: pause.reason,
        time: pause.time,
        session: pause.session,
        ...(top?.source?.path ? { where: { name: top.name, file: top.source.path, line: top.line } } : {}),
        // --- per-step variable capture ---
        // The snapshot's keys were resolved against the graph that was open AT CAPTURE time, while
        // `path` is re-resolved against the graph open now. Same graph (record, then scrub: the
        // normal case) and every key matches; a different graph and the ones it no longer has on
        // this path are dropped rather than attached to a node they do not describe.
        ...valuesOnPath(pause.values, path),
        // --- end per-step variable capture ---
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
