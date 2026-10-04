import type { DebugPath, GraphData } from '../src/types';
import { stronglyConnectedComponents } from '../src/recursion';

export interface PathCatalog { paths: DebugPath[]; limited: boolean }

/** Enumerate simple entry-to-target paths; recursion and branching have finite work limits. */
export function graphPaths(graph: GraphData, targets: ReadonlySet<string>, showNoise = false,
  maxPaths = 500, maxVisits = 20000): PathCatalog {
  const nodes = graph.nodes.filter(node => showNoise || !node.noise);
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to) && !targets.has(edge.from));
  const outgoing = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const incoming = new Map(nodes.map(node => [node.id, new Set<string>()]));
  edges.forEach(({ from, to }) => { outgoing.get(from)!.add(to); incoming.get(to)!.add(from); });
  const reachable = new Set([...targets].filter(id => ids.has(id)));
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) {
    for (const caller of incoming.get(queue[i])!) {
      if (!reachable.has(caller)) { reachable.add(caller); queue.push(caller); }
    }
  }
  const components = stronglyConnectedComponents({ nodes, edges });
  const componentOf = new Map<string, number>();
  components.forEach((members, index) => members.forEach(id => componentOf.set(id, index)));
  const hasParent = new Set<number>();
  edges.forEach(({ from, to }) => {
    if (componentOf.get(from) !== componentOf.get(to)) hasParent.add(componentOf.get(to)!);
  });
  const starts = nodes.map(node => node.id).filter(id => reachable.has(id) && !hasParent.has(componentOf.get(id)!));
  const paths: DebugPath[] = [];
  let visits = 0;
  for (const start of starts) {
    const path = [start];
    const seen = new Set(path);
    const work = [{ id: start, children: [...outgoing.get(start)!], next: 0 }];
    while (work.length) {
      if (++visits > maxVisits) return { paths, limited: true };
      const frame = work[work.length - 1];
      if (targets.has(frame.id)) {
        if (paths.length === maxPaths) return { paths, limited: true };
        paths.push([...path]);
      } else if (frame.next < frame.children.length) {
        const child = frame.children[frame.next++];
        if (!reachable.has(child) || seen.has(child)) continue;
        path.push(child); seen.add(child);
        work.push({ id: child, children: [...outgoing.get(child)!], next: 0 });
        continue;
      }
      work.pop(); seen.delete(path.pop()!);
    }
  }
  return { paths, limited: false };
}
