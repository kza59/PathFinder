// Unit tests for markChokepoints. Plain Node, no VS Code: part of `npm run test:unit`.
import * as assert from 'assert';
import { markChokepoints } from '../chokepoints';
import type { CallGraph } from '../graphBuilder';

/**
 * Builds a graph from "caller->callee" strings, with `target` as the PathFind target.
 * `noise` and `hidden` (node id -> hidden caller count) set those node fields.
 */
function graph(edges: string[], { noise = [] as string[], hidden = {} as Record<string, number>, target = 'target' } = {}): CallGraph {
  const ids: string[] = [target];
  const pairs = edges.map(e => e.split('->'));
  pairs.flat().forEach(id => ids.includes(id) || ids.push(id));
  return {
    nodes: ids.map(id => ({
      id, label: id, file: `/${id}.py`, line: 1, endLine: 2,
      ...(noise.includes(id) ? { noise: true as const } : {}),
      ...(hidden[id] ? { hiddenCallers: hidden[id] } : {}),
    })),
    edges: pairs.map(([from, to]) => ({ from, to, lines: [1] })),
    targetIds: [target],
  };
}

const chokepoints = (g: CallGraph) => markChokepoints(g).nodes.filter(n => n.chokepoint).map(n => n.id);

const cases: [string, () => void][] = [
  ['the only function between main and the target is a chokepoint', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->f2', 'f2->f1', 'f2->target', 'f1->target'])), ['f2']);
  }],
  ['every link of a single chain is a chokepoint; main and the target are not', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->a', 'a->b', 'b->c', 'c->target'])), ['a', 'b', 'c']);
  }],
  ['two separate routes have no chokepoint', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->a', 'main->b', 'a->target', 'b->target'])), []);
  }],
  ['a second uncalled function is its own entry point (README graph: function3 bypasses function2)', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->f2', 'f2->f1', 'f2->target', 'f1->target', 'f3->f2', 'f3->f1', 'f3->target'])), []);
  }],
  ['a test calling the target directly does not hide the chokepoint', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->a', 'a->target', 'test_x->target'], { noise: ['test_x'] })), ['a']);
  }],
  ['<module> above main does not stop main being the entry point', () => {
    assert.deepStrictEqual(chokepoints(graph(['module->main', 'main->a', 'a->target'], { noise: ['module'] })), ['a']);
  }],
  ['a noise constructor in the middle carries the path but is never marked itself', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->init', 'init->setup', 'setup->target'], { noise: ['init'] })), ['setup']);
  }],
  ['hidden callers at the top of a cut-off chain leave the chokepoints below it certain', () => {
    assert.deepStrictEqual(chokepoints(graph(['l3->l2', 'l2->l1', 'l1->target'], { hidden: { l3: 1 } })), ['l2', 'l1']);
  }],
  ['hidden callers below a chokepoint could bypass it, so it is not marked', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->l2', 'l2->l1', 'l1->target'], { hidden: { l1: 2 } })), ['l1']);
  }],
  ['a recursive function on the only route is still a chokepoint', () => {
    assert.deepStrictEqual(chokepoints(graph(['main->a', 'a->a', 'a->target'])), ['a']);
  }],
  ['a cycle nothing outside calls into is a set of entry points, not chokepoints', () => {
    assert.deepStrictEqual(chokepoints(graph(['a->b', 'b->a', 'b->target'])), []);
  }],
  ['if only noise reaches the target, nothing is marked', () => {
    assert.deepStrictEqual(chokepoints(graph(['test_x->a', 'a->target'], { noise: ['test_x'] })), []);
  }],
  ['without targetIds nothing is marked', () => {
    const g = graph(['main->a', 'a->target']);
    delete g.targetIds;
    assert.deepStrictEqual(chokepoints(g), []);
  }],
  ['recomputing clears chokepoints that no longer hold', () => {
    const g = markChokepoints(graph(['main->a', 'a->target']));
    g.edges.push({ from: 'main', to: 'target', lines: [2] });
    assert.deepStrictEqual(chokepoints(g), []);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} chokepoint tests passed`);
process.exit(failed ? 1 : 0);
