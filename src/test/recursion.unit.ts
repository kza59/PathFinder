// Unit tests for markRecursion. Plain Node, no VS Code: `npm run test:unit`.
import * as assert from 'assert';
import type { CallGraph } from '../graphBuilder';
import { markRecursion, recursionDepth } from '../recursion';

/** Builds a graph from "a->b" strings; node order is first appearance. */
function graph(...edges: string[]): CallGraph {
  const ids: string[] = [];
  const pairs = edges.map(e => e.split('->'));
  pairs.flat().forEach(id => ids.includes(id) || ids.push(id));
  return {
    nodes: ids.map(id => ({ id, label: id, file: `/${id}.py`, line: 1, endLine: 2 })),
    edges: pairs.map(([from, to]) => ({ from, to, lines: [1] })),
  };
}

/** "a,b | c" style summary of groups, plus the recursive edges. */
function summary(g: CallGraph) {
  const groups = new Map<number, string[]>();
  for (const node of g.nodes) {
    if (node.recursionGroup !== undefined) {
      groups.set(node.recursionGroup, [...(groups.get(node.recursionGroup) ?? []), node.id]);
    }
  }
  return {
    groups: [...groups.entries()].sort(([a], [b]) => a - b).map(([, members]) => members.join(',')),
    recursiveEdges: g.edges.filter(e => e.recursive).map(e => `${e.from}->${e.to}`),
  };
}

const cases: [string, () => void][] = [
  ['no recursion: README graph has no groups', () => {
    assert.deepStrictEqual(summary(markRecursion(graph(
      'function1->sum', 'function2->sum', 'function3->sum', 'function2->function1',
      'function3->function1', 'function3->function2', 'main->function2'))), { groups: [], recursiveEdges: [] });
  }],
  ['direct recursion: a function calling itself', () => {
    assert.deepStrictEqual(summary(markRecursion(graph('countdown->leaf', 'countdown->countdown', 'main->countdown'))),
      { groups: ['countdown'], recursiveEdges: ['countdown->countdown'] });
  }],
  ['mutual recursion: two functions calling each other', () => {
    assert.deepStrictEqual(summary(markRecursion(graph('is_even->leaf', 'is_even->is_odd', 'is_odd->is_even', 'main->is_even'))),
      { groups: ['is_even,is_odd'], recursiveEdges: ['is_even->is_odd', 'is_odd->is_even'] });
  }],
  ['three-function loop is one group; the call into it is not recursive', () => {
    assert.deepStrictEqual(summary(markRecursion(graph('a->b', 'b->c', 'c->a', 'c->leaf', 'main->a'))),
      { groups: ['a,b,c'], recursiveEdges: ['a->b', 'b->c', 'c->a'] });
  }],
  ['separate cycles get separate groups, numbered in node order', () => {
    const g = markRecursion(graph('x->x', 'p->q', 'q->p', 'main->x', 'main->p'));
    assert.deepStrictEqual(summary(g), { groups: ['x', 'p,q'], recursiveEdges: ['x->x', 'p->q', 'q->p'] });
    assert.strictEqual(g.nodes.find(n => n.id === 'x')!.recursionGroup, 1);
    assert.strictEqual(g.nodes.find(n => n.id === 'p')!.recursionGroup, 2);
  }],
  ['a self-call inside a larger cycle stays in that cycle\'s group', () => {
    assert.deepStrictEqual(summary(markRecursion(graph('a->b', 'b->a', 'a->a'))),
      { groups: ['a,b'], recursiveEdges: ['a->b', 'b->a', 'a->a'] });
  }],
  ['two cycles joined by a one-way call stay separate', () => {
    assert.deepStrictEqual(summary(markRecursion(graph('a->b', 'b->a', 'b->c', 'c->d', 'd->c'))),
      { groups: ['a,b', 'c,d'], recursiveEdges: ['a->b', 'b->a', 'c->d', 'd->c'] });
  }],
  ['non-recursive nodes and edges get no fields at all', () => {
    const g = markRecursion(graph('main->a', 'a->a'));
    assert.ok(!('recursionGroup' in g.nodes.find(n => n.id === 'main')!));
    assert.ok(!('recursive' in g.edges.find(e => e.from === 'main')!));
  }],
  ['recomputing after breaking a cycle removes stale fields and retains other metadata', () => {
    const g = markRecursion(graph('main->a', 'a->b', 'b->a'));
    g.targetIds = ['a'];
    g.nodes.find(n => n.id === 'a')!.noise = true;
    g.edges = g.edges.filter(e => e.from !== 'b');
    assert.strictEqual(markRecursion(g), g);
    assert.ok(g.nodes.every(n => !('recursionGroup' in n)));
    assert.ok(g.edges.every(e => !('recursive' in e)));
    assert.strictEqual(g.nodes.find(n => n.id === 'a')!.noise, true);
    assert.deepStrictEqual(g.targetIds, ['a']);
  }],
  ['edges to missing nodes cannot create a recursion group', () => {
    const g = graph('a->missing', 'missing->a');
    g.nodes = g.nodes.filter(n => n.id !== 'missing');
    assert.deepStrictEqual(summary(markRecursion(g)), { groups: [], recursiveEdges: [] });
  }],
  ['a 20,000-function loop does not overflow the stack', () => {
    const n = 20_000;
    const edges = Array.from({ length: n }, (_, i) => `f${i}->f${(i + 1) % n}`);
    const g = markRecursion(graph(...edges));
    assert.ok(g.nodes.every(node => node.recursionGroup === 1));
    assert.ok(g.edges.every(edge => edge.recursive));
  }],

  // recursionDepth: the test5 graph shape, with runtime stacks listed outermost first.
  ['depth: no recursion on the stack is an empty result', () => {
    assert.deepStrictEqual(recursionDepth(['main', 'countdown', 'leaf'], test5()), []);
  }],
  ['depth: countdown x2 is depth 1, x3 is double, x4 is triple', () => {
    const g = test5();
    const depthWith = (n: number) => recursionDepth(['main', ...Array(n).fill('countdown'), 'leaf'], g);
    assert.deepStrictEqual(depthWith(2), [{ group: 1, depth: 1, members: ['countdown'] }]);
    assert.strictEqual(depthWith(3)[0].depth, 2);
    assert.strictEqual(depthWith(4)[0].depth, 3);
  }],
  ['depth: mutual recursion is_even -> is_odd -> is_even -> is_odd re-enters twice', () => {
    assert.deepStrictEqual(recursionDepth(['main', 'is_even', 'is_odd', 'is_even', 'is_odd', 'leaf'], test5()),
      [{ group: 2, depth: 2, members: ['is_even', 'is_odd'] }]);
  }],
  ['depth: one trip around a three-function loop is depth 1', () => {
    assert.deepStrictEqual(recursionDepth(['main', 'step_a', 'step_b', 'step_c', 'step_a', 'leaf'], test5()),
      [{ group: 3, depth: 1, members: ['step_a', 'step_b', 'step_c'] }]);
  }],
  ['depth: a single frame of a recursive function is not recursing yet', () => {
    assert.deepStrictEqual(recursionDepth(['main', 'is_even', 'leaf'], test5()), []);
  }],
  ['depth: several groups on one stack are reported in stack order', () => {
    const g = markRecursion(graph('main->x', 'x->x', 'x->p', 'p->q', 'q->p'));
    assert.deepStrictEqual(recursionDepth(['main', 'x', 'x', 'p', 'q', 'p'], g), [
      { group: 1, depth: 1, members: ['x'] },
      { group: 2, depth: 1, members: ['p', 'q'] },
    ]);
  }],
  ['depth: ids missing from the graph are ignored', () => {
    assert.deepStrictEqual(recursionDepth(['main', 'callback', 'countdown', 'countdown', 'unknown'], test5()),
      [{ group: 1, depth: 1, members: ['countdown'] }]);
  }],
  ['depth: 100 nested calls report depth 99', () => {
    assert.strictEqual(recursionDepth(Array(100).fill('countdown'), test5())[0].depth, 99);
  }],
];

/** The call graph of test5: countdown calls itself, is_even <-> is_odd, step_a -> step_b -> step_c -> step_a. */
function test5(): CallGraph {
  return markRecursion(graph(
    'countdown->leaf', 'countdown->countdown', 'is_even->leaf', 'is_odd->leaf', 'is_even->is_odd',
    'is_odd->is_even', 'step_c->leaf', 'step_a->step_b', 'step_b->step_c', 'step_c->step_a',
    'main->countdown', 'main->is_even', 'main->step_a'));
}

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
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
