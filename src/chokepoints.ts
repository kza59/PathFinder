// Chokepoint detection over a finished call graph. Pure graph code (no vscode import) so it can be unit-tested directly.
import type { CallGraph } from './graphBuilder';
import { stronglyConnectedComponents } from './recursion';

/**
 * Marks `chokepoint: true` on functions that every path to the target passes through, so one breakpoint there
 * catches every way the target is reached. Recomputed from scratch on each call.
 *
 * - Paths start at entry points: non-noise functions with no callers other than noise (or cycles nothing
 *   outside calls into). Noise nodes (<module>, constructors, tests) never start a path, so a test calling the
 *   target directly doesn't hide the program's chokepoints, but paths still run through noise in the middle.
 * - The target(s), entry points and noise nodes are never marked.
 * - Only certain chokepoints are marked. A node with `hiddenCallers` may be reached from callers the graph doesn't
 *   show, so it counts as a possible extra entry point; a chokepoint those unseen callers could bypass isn't marked.
 */
export function markChokepoints(graph: CallGraph): CallGraph {
  graph.nodes.forEach(node => delete node.chokepoint);
  const targets = new Set((graph.targetIds ?? []).filter(id => graph.nodes.some(node => node.id === id)));
  if (targets.size === 0) {
    return graph;
  }
  const noise = new Set(graph.nodes.filter(node => node.noise).map(node => node.id));
  const edges = graph.edges.filter(e => e.from !== e.to);
  const callees = new Map<string, string[]>(graph.nodes.map(node => [node.id, []]));
  const callers = new Map<string, string[]>(graph.nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    callees.get(edge.from)?.push(edge.to);
    callers.get(edge.to)?.push(edge.from);
  }

  // Noise only "doesn't count" at the top of a path (<module>, a test): noise reached from real code, like a
  // constructor main calls, is part of the route and still counts as a caller.
  const reachedFromCode = new Set<string>();
  const walk = graph.nodes.filter(node => !node.noise).map(node => node.id);
  while (walk.length) {
    for (const next of callees.get(walk.shift()!) ?? []) {
      if (noise.has(next) && !reachedFromCode.has(next)) {
        reachedFromCode.add(next);
        walk.push(next);
      }
    }
  }
  const topNoise = new Set([...noise].filter(id => !reachedFromCode.has(id)));

  // Entry points: non-noise members of components that nothing outside the component calls, top noise aside.
  const componentOf = new Map<string, number>();
  stronglyConnectedComponents(graph).forEach((members, i) => members.forEach(id => componentOf.set(id, i)));
  const calledFromOutside = new Set(edges
    .filter(e => !topNoise.has(e.from) && componentOf.get(e.from) !== componentOf.get(e.to))
    .map(e => componentOf.get(e.to)));
  const entries = graph.nodes
    .filter(node => !node.noise && !calledFromOutside.has(componentOf.get(node.id)))
    .map(node => node.id);
  const possibleEntries = [...new Set([...entries, ...graph.nodes.filter(node => node.hiddenCallers).map(node => node.id)])];

  /** Whether any target is reachable from `sources` along calls, without passing through `avoid`. */
  const reachesTarget = (sources: string[], avoid?: string): boolean => {
    const queue = sources.filter(id => id !== avoid);
    const seen = new Set<string>(avoid ? [avoid, ...queue] : queue);
    while (queue.length) {
      const id = queue.shift()!;
      if (targets.has(id)) {
        return true;
      }
      for (const next of callees.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  if (!reachesTarget(possibleEntries)) {
    return graph; // nothing known reaches the target, so no path to block
  }

  // Candidates must be able to reach a target themselves (walk up from the targets).
  const ancestors = new Set<string>();
  const queue = [...targets];
  while (queue.length) {
    for (const caller of callers.get(queue.shift()!) ?? []) {
      if (!ancestors.has(caller)) {
        ancestors.add(caller);
        queue.push(caller);
      }
    }
  }

  const entrySet = new Set(entries);
  for (const node of graph.nodes) {
    if (!ancestors.has(node.id) || targets.has(node.id) || entrySet.has(node.id) || node.noise) {
      continue;
    }
    if (!reachesTarget(possibleEntries, node.id)) {
      node.chokepoint = true;
    }
  }
  return graph;
}
