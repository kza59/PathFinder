// Recursion detection over a finished call graph. Pure graph code (no vscode import) so it can be unit-tested directly.
import type { CallGraph } from './graphBuilder';

/**
 * Marks recursive structures in place:
 * - nodes that belong to the same cycle get the same `recursionGroup` number (1, 2, ...);
 * - edges whose two ends share a group get `recursive: true` (the calls that keep the recursion going).
 *
 * A recursive structure is a strongly connected component (every member can reach every other by
 * following calls) with more than one node, or a single node that calls itself.
 * Groups are numbered in node order, so the numbering is stable for the same graph.
 */
export function markRecursion(graph: CallGraph): CallGraph {
  const groupOf = new Map<string, number>();
  let nextGroup = 1;
  for (const component of stronglyConnectedComponents(graph)) {
    const callsItself = component.length === 1
      && graph.edges.some(e => e.from === component[0] && e.to === component[0]);
    if (component.length > 1 || callsItself) {
      const group = nextGroup++;
      component.forEach(id => groupOf.set(id, group));
    }
  }

  for (const node of graph.nodes) {
    const group = groupOf.get(node.id);
    if (group !== undefined) {
      node.recursionGroup = group;
    }
  }
  for (const edge of graph.edges) {
    const group = groupOf.get(edge.from);
    if (group !== undefined && group === groupOf.get(edge.to)) {
      edge.recursive = true;
    }
  }
  return graph;
}

export interface RecursionDepth {
  group: number;      // the recursionGroup being re-entered
  depth: number;      // calls that re-entered a function already on the stack: 1 = recursing once, 2 = double...
  members: string[];  // distinct ids from that group on the stack, outermost first
}

/**
 * How deep each recursive structure currently goes on a call stack, for live "DOUBLE RECURSION!" style feedback.
 * `path` is a runtime call stack as node ids, outermost first (the same order as DebugPath), and `graph` must have
 * gone through markRecursion. Depth counts the frames that re-enter a function already on the stack, so every
 * shape is measured the same way: countdown x3 is depth 2, is_even -> is_odd -> is_even -> is_odd is depth 2,
 * and one lap of step_a -> step_b -> step_c -> step_a is depth 1. Ids not in the graph are ignored.
 * Only groups that are actually recursing (depth >= 1) are returned, in order of first appearance on the stack.
 */
export function recursionDepth(path: string[], graph: CallGraph): RecursionDepth[] {
  const groupOf = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.recursionGroup !== undefined) {
      groupOf.set(node.id, node.recursionGroup);
    }
  }

  const byGroup = new Map<number, { reentries: number; members: string[] }>();
  for (const id of path) {
    const group = groupOf.get(id);
    if (group === undefined) {
      continue;
    }
    const entry = byGroup.get(group) ?? { reentries: 0, members: [] };
    if (entry.members.includes(id)) {
      entry.reentries++; // this function was already running further up the stack
    } else {
      entry.members.push(id);
    }
    byGroup.set(group, entry);
  }

  return [...byGroup.entries()]
    .filter(([, { reentries }]) => reentries > 0)
    .map(([group, { reentries, members }]) => ({ group, depth: reentries, members }));
}

/**
 * Tarjan's algorithm, iterative so a long call chain can't overflow the stack.
 * Components come out ordered by each component's first node in `graph.nodes`.
 */
function stronglyConnectedComponents(graph: CallGraph): string[][] {
  const callees = new Map<string, string[]>(graph.nodes.map(n => [n.id, []]));
  for (const edge of graph.edges) {
    callees.get(edge.from)?.push(edge.to);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of graph.nodes.map(n => n.id)) {
    if (index.has(start)) {
      continue;
    }
    // Each frame: a node and how many of its callees have been visited so far.
    const work: { id: string; next: number }[] = [{ id: start, next: 0 }];
    index.set(start, counter);
    lowLink.set(start, counter++);
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = callees.get(frame.id) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++];
        if (!index.has(target)) {
          index.set(target, counter);
          lowLink.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          work.push({ id: target, next: 0 });
        } else if (onStack.has(target)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id)!, index.get(target)!));
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.id, Math.min(lowLink.get(parent.id)!, lowLink.get(frame.id)!));
      }
      if (lowLink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        components.push(component);
      }
    }
  }

  // Tarjan emits components in reverse topological order; reorder by first appearance for stable numbering.
  const position = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const first = (component: string[]) => Math.min(...component.map(id => position.get(id)!));
  return components
    .map(component => component.sort((a, b) => position.get(a)! - position.get(b)!))
    .sort((a, b) => first(a) - first(b));
}
