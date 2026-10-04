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

export type GraphMessage =
  | { type: 'graph'; graph: GraphData }
  | { type: 'debugPath'; path: DebugPath }
  | { type: 'debugClear' }
  | { type: 'hotCounts'; counts: HotCounts }; // hot-path counting

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
