import type { GraphEdge, GraphNode } from './graphBuilder';

export type { GraphEdge, GraphNode } from './graphBuilder';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  targetIds?: string[];
}

export type DebugPath = string[];

// --- hot-path counting ---
/** Cumulative calls per graph node id for the current Python debug run (nodes never called are absent). */
export type HotCounts = Record<string, number>;
// --- end hot-path counting ---

// --- return values feature ---
/**
 * The latest value each function returned, per graph node id, formatted in the user's process by
 * python/pathfinder_hot/sitecustomize.py. Absent until a call of that function has returned; a
 * function that only ever raises never appears. Rides the hot-path channel, so Python only.
 */
export type ReturnValues = Record<string, string>;
// --- end return values feature ---

// --- call values feature ---
/** One parameter of a paused call, for the tooltip. Also used for an expanded variable's children. */
export interface CallArg {
  name: string;   // as written in the signature: "a", "*args", "**kwargs"
  value?: string; // debugpy's repr at the pause (capped); absent when the name isn't in Locals
  // --- expand complex variables feature ---
  // Both omitted for a plain scalar, so a CallValue of scalars serialises as it always did.
  ref?: number;   // DAP variablesReference: > 0 when the value has children that can be fetched.
                  // Valid ONLY at the pause it came from; dead as soon as the program resumes.
  type?: string;  // debugpy's type name ("list", "Dog"), for the tooltip
  // --- end expand complex variables feature ---
}
/** Argument values of the innermost paused call of one graph node (Python only). */
export interface CallValue {
  line: string;      // shortened, for the node, under its name: "(a=3, b=4)"
  args: CallArg[];   // every parameter, full values, for the tooltip
  atEntry: boolean;  // paused on the first body line: values are as passed (otherwise "value at pause")
  more?: number;     // further (outer, recursive) calls of the same function on the stack
  stale?: boolean;   // the program has resumed since these were read
  // --- local variables feature ---
  // The non-parameter locals of the same frame. All three are ABSENT (not empty) when the frame has
  // none, so a call with only parameters serialises exactly as it did before this feature existed.
  localsRows?: string[];  // shortened "name=value" rows for the band under the node, already capped
  locals?: CallArg[];     // the first MAX_LOCALS_LIST locals, full values, for the tooltip
  localsCount?: number;   // how many there are in total, so both views can say "+N more"
  // --- end local variables feature ---
}
/** Keyed by graph node id; only nodes on the stack at the last pause are present. */
export type CallValues = Record<string, CallValue>;
// --- end call values feature ---

// --- expand complex variables feature ---
/** The children of one expandable variable, as read at the pause its `ref` belongs to. */
export interface VariableChildren {
  ref: number;        // the variablesReference that was asked for
  children: CallArg[];
  more?: number;      // further children beyond the page that was fetched
  stale?: boolean;    // the program resumed before the answer arrived: the ref is dead, show nothing
}
// --- end expand complex variables feature ---

export type CallerExpansionPreview =
  | { state: 'loading' }
  | { state: 'ready'; addedNodes: number; addedNoiseNodes: number }
  | { state: 'error' };

// --- breakpoint markers ---
/** Enabled breakpoints per graph node id (only nodes in the current graph that have at least one). */
export type BreakpointCounts = Record<string, number>;
// --- end breakpoint markers ---

// --- session history ---
// --- per-step variable capture ---
/**
 * One frame's variables as session history recorded them at one pause.
 *
 * STRINGS ONLY: `ref` and `type` are stripped at capture. A DAP variablesReference dies with the
 * pause it came from, so a recorded step could never answer an expansion - offering one would be a
 * disclosure that resolves to nothing. The pane renders these read-only for exactly that reason.
 *
 * Capped much tighter than the live CallValue (see the MAX_SNAPSHOT_* caps in sessionHistory.ts):
 * one live snapshot is cheap, thousands of them are not.
 */
export interface StepValues {
  args: CallArg[];        // the frame's parameters: name + value, no ref/type
  locals: CallArg[];      // its non-parameter locals, same shape
  localsRows?: string[];  // the node's value band, already shortened by the local variables feature
  localsCount?: number;   // locals before the cap, so "+N more" stays truthful
  atEntry?: boolean;      // paused on the first body line: the values are as passed. Absent = false
}
// --- end per-step variable capture ---
/** One debugger pause of the recorded session. */
export interface HistoryStep {
  path: DebugPath;   // outer caller first, like debugPath (resolved against the graph at send time)
  reason: string;    // DAP stopped reason: "breakpoint", "step", "exception", "pause", "entry", ...
  time: number;      // ms since the session started
  session: string;   // debug session name (child sessions are recorded into their parent's history)
  where?: { name: string; file: string; line: number }; // the top frame
  // --- per-step variable capture ---
  // The innermost few frames' variables at this pause, keyed by graph node id. ABSENT whenever
  // nothing was recorded: a non-Python session, no graph open while debugging, the program resumed
  // inside the capture debounce, or the character budget evicted this step's values.
  values?: Record<string, StepValues>;
  // --- end per-step variable capture ---
}
/** While recording only the count is sent; once the top-level session ends, every step. */
export type SessionHistoryMessage =
  | { type: 'sessionHistory'; state: 'recording'; count: number; dropped: number }
  | { type: 'sessionHistory'; state: 'ended'; steps: HistoryStep[]; dropped: number }; // dropped: oldest steps over the cap
// --- end session history ---

export type GraphMessage =
  | { type: 'graph'; graph: GraphData }
  | { type: 'callerPreviews'; previews: Record<string, CallerExpansionPreview> }
  | { type: 'debugPath'; path: DebugPath; crashed?: boolean } // crashed: the program stopped because of an exception
  | { type: 'debugClear' }
  | { type: 'hotCounts'; counts: HotCounts; returns?: ReturnValues } // hot-path counting + return values feature
  | { type: 'callValues'; values: CallValues } // call values feature
  | { type: 'breakpoints'; counts: BreakpointCounts } // breakpoint markers
  | { type: 'variableChildren'; result: VariableChildren } // expand complex variables feature
  | SessionHistoryMessage; // session history

export interface NodeClickedMessage {
  type: 'nodeClicked';
  id: string;
  file: string;
  line: number;
}

// --- copy path feature ---
/** The current debug path as the breadcrumb shows it, e.g. "main → function2 → sum". */
export interface CopyPathMessage {
  type: 'copyPath';
  text: string;
}
// --- end copy path feature ---

export interface ExpandCallersMessage {
  type: 'expandCallers';
  id: string;
}

export interface PreviewCallersMessage {
  type: 'previewCallers';
  id: string;
}

// --- expand complex variables feature ---
/** Webview -> extension: fetch one page of an expandable variable's children at the current pause. */
export interface ExpandVariableMessage {
  type: 'expandVariable';
  ref: number;
  start: number;
  count: number;
}
// --- end expand complex variables feature ---

export type WebviewMessage = { type: 'ready' } | NodeClickedMessage | CopyPathMessage | ExpandCallersMessage
  | PreviewCallersMessage | ExpandVariableMessage; // expand complex variables feature
