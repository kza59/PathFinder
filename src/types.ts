import type { GraphEdge, GraphNode } from './graphBuilder';

export type { GraphEdge, GraphNode } from './graphBuilder';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

export type WebviewMessage = { type: 'ready' } | NodeClickedMessage;
