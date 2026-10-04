import type { GraphData } from '../types';
import { stronglyConnectedComponents } from '../recursion';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 82;
const COLUMN_GAP = NODE_WIDTH + 70;
const ROW_GAP = 210;

export interface Point { x: number; y: number }
export interface LayoutAnnotation extends Point { label: string }
export interface TargetLayout {
  targetIds: Set<string>;
  pinnedIds: Set<string>;
  distances: Map<string, number>;
  positions: Map<string, Point>;
  annotations: LayoutAnnotation[];
}

/** Longest path depth to terminal targets; recursive components count as one group. */
export function targetLayout(graph: GraphData): TargetLayout {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const edges = graph.edges.filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
  const incoming = new Map([...nodes.keys()].map(id => [id, [] as string[]]));
  const outgoing = new Map([...nodes.keys()].map(id => [id, [] as string[]]));
  for (const { from, to } of edges) {
    incoming.get(to)!.push(from);
    outgoing.get(from)!.push(to);
  }
  // Legacy payloads infer sinks, ignoring self calls. Do not guess targets for
  // cycles between different functions or when explicit metadata is empty/invalid.
  const targetIds = new Set((graph.targetIds ?? [...nodes.keys()].filter(id =>
    !(outgoing.get(id) ?? []).some(to => to !== id),
  )).filter(id => nodes.has(id)));
  // Paths end when they reach a selected target. Collapse remaining cycles into
  // components so longest-path ranking stays finite even for recursive graphs.
  const components = stronglyConnectedComponents({
    nodes: graph.nodes, edges: edges.filter(edge => !targetIds.has(edge.from)),
  });
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => members.forEach(id => componentOf.set(id, index)));
  const children = components.map(() => new Set<number>());
  const parents = components.map(() => new Set<number>());
  for (const { from, to } of edges) {
    if (targetIds.has(from)) continue;
    const source = componentOf.get(from)!;
    const target = componentOf.get(to)!;
    if (source !== target) {
      children[source].add(target);
      parents[target].add(source);
    }
  }
  const remainingChildren = children.map(row => row.size);
  const componentDepth = new Map([...targetIds].map(id => [componentOf.get(id)!, 0]));
  const queue = components.map((_, index) => index).filter(index => remainingChildren[index] === 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const component = queue[cursor];
    const depth = componentDepth.get(component);
    for (const parent of parents[component]) {
      if (depth !== undefined) {
        componentDepth.set(parent, Math.max(componentDepth.get(parent) ?? 0, depth + 1));
      }
      if (--remainingChildren[parent] === 0) queue.push(parent);
    }
  }
  const distances = new Map<string, number>();
  for (const id of nodes.keys()) {
    const depth = componentDepth.get(componentOf.get(id)!);
    if (depth !== undefined) distances.set(id, depth);
  }

  const compare = (a: string, b: string) =>
    nodes.get(a)!.label.localeCompare(nodes.get(b)!.label) || a.localeCompare(b);
  const modules = [...nodes.keys()].filter(id => nodes.get(id)!.label === '<module>');
  const mains = [...nodes.keys()].filter(id => nodes.get(id)!.label === 'main');
  const pinnedIds = new Set([...modules, ...mains]);
  // Entry-point placement overrides depth without changing the computed depth.
  // Modules occupy the first row, main the next, then ordinary functions below.
  const ranks = new Map([...distances].filter(([id]) => !pinnedIds.has(id)));
  const ordinaryMax = Math.max(-1, ...ranks.values());
  mains.forEach(id => ranks.set(id, ordinaryMax + 1));
  modules.forEach(id => ranks.set(id, ordinaryMax + (mains.length ? 2 : 1)));
  const rows = new Map<number, string[]>();
  for (const [id, distance] of ranks) {
    if (!rows.has(distance)) rows.set(distance, []);
    rows.get(distance)!.push(id);
  }
  for (const row of rows.values()) row.sort(compare);
  const maxDistance = Math.max(0, ...rows.keys());
  const positions = new Map<string, Point>();
  const placeRow = (distance: number) => {
    const row = rows.get(distance) ?? [];
    row.forEach((id, index) => positions.set(id, {
      x: (index - (row.length - 1) / 2) * COLUMN_GAP,
      y: (maxDistance - distance) * ROW_GAP,
    }));
  };
  for (const distance of rows.keys()) placeRow(distance);

  // Barycenter sweeps align callers with nearer callees and then refine the reverse
  // ordering. Only order within rows changes; depths and entry-point ranks stay fixed.
  const reorder = (distance: number, neighbors: Map<string, string[]>, nearer: boolean) => {
    const row = rows.get(distance);
    if (!row) return;
    const scores = new Map(row.map(id => {
      const xs = (neighbors.get(id) ?? []).filter(other => {
        const otherDistance = ranks.get(other);
        return otherDistance !== undefined && (nearer ? otherDistance < distance : otherDistance > distance);
      }).map(other => positions.get(other)!.x);
      return [id, xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : positions.get(id)!.x];
    }));
    row.sort((a, b) => scores.get(a)! - scores.get(b)! || compare(a, b));
    placeRow(distance);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let distance = 1; distance <= maxDistance; distance++) reorder(distance, outgoing, true);
    for (let distance = maxDistance - 1; distance >= 0; distance--) reorder(distance, incoming, false);
  }

  const annotations: LayoutAnnotation[] = [];
  const right = Math.max(0, ...[...positions.values()].map(point => point.x)) + NODE_WIDTH / 2;

  const unreachable = [...nodes.keys()].filter(id => !distances.has(id) && !pinnedIds.has(id)).sort(compare);
  if (unreachable.length) {
    const startX = positions.size ? right + 220 : 0;
    annotations.push({
      x: startX - NODE_WIDTH / 2, y: -NODE_HEIGHT / 2 - 24,
      label: targetIds.size ? 'No path to target' : 'No target identified',
    });
    unreachable.forEach((id, index) => positions.set(id, {
      x: startX + (index % 4) * COLUMN_GAP,
      y: Math.floor(index / 4) * ROW_GAP,
    }));
  }
  return { targetIds, pinnedIds, distances, positions, annotations };
}

export interface EdgeRoute {
  kind: 'normal' | 'same-row' | 'detour';
  controlDistances?: number[];
  controlWeights?: number[];
}

/** Keep cross-row shortcuts and return calls outside intermediate node rows. */
export function edgeRoute(from: string, to: string, layout: TargetLayout, index: number): EdgeRoute {
  const source = layout.positions.get(from);
  const target = layout.positions.get(to);
  if (!source || !target || from === to) return { kind: 'normal' };
  if (source.y === target.y) {
    // Equal positive offsets put reciprocal calls on opposite sides of the row.
    return { kind: 'same-row', controlDistances: [Math.min(125, 55 + Math.abs(source.x - target.x) / 5)] };
  }
  if (target.y > source.y && target.y - source.y <= ROW_GAP) return { kind: 'normal' };
  const bothReachTarget = layout.distances.has(from) && layout.distances.has(to);
  const points = bothReachTarget
    ? [...layout.distances.keys()].map(id => layout.positions.get(id)!)
    : [...layout.positions.values()];
  // Disconnected functions occupy the right-hand area. Keep the target graph's
  // outer lanes to its left so return calls cannot run through that area.
  const useLeft = (bothReachTarget && layout.distances.size < layout.positions.size)
    || (source.x + target.x) / 2 < 0;
  const lane = useLeft
    ? Math.min(...points.map(point => point.x)) - NODE_WIDTH / 2 - 70 - (index % 6) * 18
    : Math.max(...points.map(point => point.x)) + NODE_WIDTH / 2 + 70 + (index % 6) * 18;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const clearance = (NODE_HEIGHT / 2 + 28) * Math.sign(dy);
  const controlPoints = [
    { x: source.x, y: source.y + clearance },
    { x: lane, y: source.y + clearance },
    { x: lane, y: target.y - clearance },
    { x: target.x, y: target.y - clearance },
  ];
  return {
    kind: 'detour',
    // Leave the source row vertically before taking an outer lane, then enter the
    // destination row vertically. Project these points onto Cytoscape's vector
    // and normal; fixed weights would shift their y values on diagonal returns.
    controlWeights: controlPoints.map(point => ((point.x - source.x) * dx + (point.y - source.y) * dy) / (length * length)),
    controlDistances: controlPoints.map(point => ((point.x - source.x) * -dy + (point.y - source.y) * dx) / length),
  };
}
