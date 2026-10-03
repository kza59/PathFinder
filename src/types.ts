import type { GraphEdge, GraphNode } from './graphBuilder';

export type { GraphEdge, GraphNode } from './graphBuilder';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type DebugPath = string[];

export type GraphMessage =
  | { type: 'graph'; graph: GraphData }
  | { type: 'debugPath'; path: DebugPath }
  | { type: 'debugClear' };

export interface NodeClickedMessage {
  type: 'nodeClicked';
  id: string;
  file: string;
  line: number;
}

export type WebviewMessage = { type: 'ready' } | NodeClickedMessage;
