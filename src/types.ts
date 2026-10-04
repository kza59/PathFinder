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

export type GraphMessage =
  | { type: 'graph'; graph: GraphData }
  | { type: 'debugPath'; path: DebugPath; crashed?: boolean } // crashed: the program stopped because of an exception
  | { type: 'debugClear' }
  | { type: 'hotCounts'; counts: HotCounts } // hot-path counting
  | { type: 'callValues'; values: CallValues }; // call values feature

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

export type WebviewMessage = { type: 'ready' } | NodeClickedMessage | CopyPathMessage;
