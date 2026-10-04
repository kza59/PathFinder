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

// --- call values feature ---
/** One parameter of a paused call, for the tooltip. */
export interface CallArg {
  name: string;   // as written in the signature: "a", "*args", "**kwargs"
  value?: string; // debugpy's repr at the pause (capped); absent when the name isn't in Locals
}
/** Argument values of the innermost paused call of one graph node (Python only). */
export interface CallValue {
  line: string;      // shortened, for the node, under its name: "(a=3, b=4)"
  args: CallArg[];   // every parameter, full values, for the tooltip
  atEntry: boolean;  // paused on the first body line: values are as passed (otherwise "value at pause")
  more?: number;     // further (outer, recursive) calls of the same function on the stack
  stale?: boolean;   // the program has resumed since these were read
}
/** Keyed by graph node id; only nodes on the stack at the last pause are present. */
export type CallValues = Record<string, CallValue>;
// --- end call values feature ---

export type CallerExpansionPreview =
  | { state: 'loading' }
  | { state: 'ready'; addedNodes: number; addedNoiseNodes: number }
  | { state: 'error' };

// --- breakpoint markers ---
/** Enabled breakpoints per graph node id (only nodes in the current graph that have at least one). */
export type BreakpointCounts = Record<string, number>;
// --- end breakpoint markers ---

// --- session history ---
/** One debugger pause of the recorded session. */
export interface HistoryStep {
  path: DebugPath;   // outer caller first, like debugPath (resolved against the graph at send time)
  reason: string;    // DAP stopped reason: "breakpoint", "step", "exception", "pause", "entry", ...
  time: number;      // ms since the session started
  session: string;   // debug session name (child sessions are recorded into their parent's history)
  where?: { name: string; file: string; line: number }; // the top frame
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
  | { type: 'hotCounts'; counts: HotCounts } // hot-path counting
  | { type: 'callValues'; values: CallValues } // call values feature
  | { type: 'breakpoints'; counts: BreakpointCounts } // breakpoint markers
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

export type WebviewMessage = { type: 'ready' } | NodeClickedMessage | CopyPathMessage | ExpandCallersMessage | PreviewCallersMessage;
