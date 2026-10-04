import * as assert from 'assert';
import type { GraphData } from '../types';
import { edgeRoute, NODE_WIDTH, targetLayout } from '../webview/targetLayout';

function graph(ids: string[], pairs: string[], targets?: string[]): GraphData {
  return {
    nodes: ids.map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
    edges: pairs.map(pair => {
      const [from, to] = pair.split('->');
      return { from, to, lines: [] };
    }),
    targetIds: targets,
  };
}

const cases: [string, () => void][] = [
  ['shortcuts retain the longest directed path, regardless of input order', () => {
    const g = graph(['main', 'b', 'a', 'target'], ['main->a', 'a->b', 'b->target', 'a->target'], ['target']);
    const layout = targetLayout(g);
    assert.deepStrictEqual(Object.fromEntries(layout.distances), { main: 3, b: 1, a: 2, target: 0 });
    assert.ok(layout.positions.get('a')!.y < layout.positions.get('b')!.y);
    assert.ok(layout.positions.get('main')!.y < layout.positions.get('a')!.y);
    assert.ok(layout.positions.get('a')!.y < layout.positions.get('target')!.y);
    assert.strictEqual(layout.positions.get('target')!.x, 0);
    const shuffled = targetLayout({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() });
    assert.deepStrictEqual(Object.fromEntries(shuffled.positions), Object.fromEntries(layout.positions));
  }],
  ['cycles share a finite component depth and self calls add no depth', () => {
    const layout = targetLayout(graph(['a', 'b', 't'], ['a->b', 'b->a', 'b->t', 't->t'], ['t']));
    assert.deepStrictEqual(Object.fromEntries(layout.distances), { a: 1, b: 1, t: 0 });
    assert.strictEqual(layout.positions.get('a')!.y, layout.positions.get('b')!.y);
  }],
  ['a selected function inside a cycle is still the target', () => {
    const layout = targetLayout(graph(['a', 'b'], ['a->b', 'b->a'], ['a']));
    assert.strictEqual(layout.distances.get('a'), 0);
    assert.strictEqual(layout.distances.get('b'), 1);
  }],
  ['multiple resolved targets share row zero and use the longest path to any target', () => {
    const layout = targetLayout(graph(['a', 'b', 'x', 'y'], ['x->y', 'y->a', 'x->b'], ['a', 'b', 'a']));
    assert.strictEqual(layout.targetIds.size, 2);
    assert.strictEqual(layout.distances.get('x'), 2);
    assert.strictEqual(layout.positions.get('a')!.y, layout.positions.get('b')!.y);
  }],
  ['modules and main are pinned above longer ordinary branches without changing depth', () => {
    const g = graph(['<module>', 'main', 'upstream', 'a', 'b', 'c', 't'],
      ['<module>->main', 'main->t', 'upstream->a', 'a->b', 'b->c', 'c->t'], ['t']);
    const layout = targetLayout(g);
    assert.strictEqual(layout.distances.get('main'), 1);
    assert.strictEqual(layout.distances.get('upstream'), 4);
    assert.strictEqual(layout.positions.get('<module>')!.y, 0);
    assert.ok(layout.positions.get('<module>')!.y < layout.positions.get('main')!.y);
    assert.ok(layout.positions.get('main')!.y < layout.positions.get('upstream')!.y);
    assert.deepStrictEqual([...layout.pinnedIds].sort(), ['<module>', 'main']);
    assert.deepStrictEqual(layout.annotations, []);
  }],
  ['main alone occupies the top row even when it cannot reach the selected target', () => {
    const layout = targetLayout(graph(['main', 'a', 't'], ['a->t'], ['t']));
    assert.strictEqual(layout.positions.get('main')!.y, 0);
    assert.ok(layout.positions.get('main')!.y < layout.positions.get('a')!.y);
    assert.ok(!layout.distances.has('main'));
  }],
  ['multiple module nodes share the top row and a selected main remains pinned', () => {
    const g = graph(['m1', 'm2', 'main', 'caller'], ['m1->main', 'm2->main', 'caller->main'], ['main']);
    g.nodes.filter(node => node.id === 'm1' || node.id === 'm2').forEach(node => node.label = '<module>');
    const layout = targetLayout(g);
    assert.strictEqual(layout.positions.get('m1')!.y, 0);
    assert.strictEqual(layout.positions.get('m2')!.y, 0);
    assert.ok(layout.positions.get('main')!.y < layout.positions.get('caller')!.y);
    assert.strictEqual(layout.distances.get('main'), 0);
  }],
  ['dead-end branches do not increase longest depth to the target', () => {
    const layout = targetLayout(graph(['a', 'dead1', 'dead2', 't'], ['a->t', 'a->dead1', 'dead1->dead2'], ['t']));
    assert.strictEqual(layout.distances.get('a'), 1);
    assert.ok(!layout.distances.has('dead1'));
    assert.ok(!layout.distances.has('dead2'));
  }],
  ['outgoing direction cannot make an unrelated callee reachable', () => {
    const layout = targetLayout(graph(['t', 'caller', 'callee', 'isolated'], ['caller->t', 't->callee'], ['t']));
    assert.ok(!layout.distances.has('callee'));
    assert.ok(!layout.distances.has('isolated'));
    const reachableRight = Math.max(layout.positions.get('t')!.x, layout.positions.get('caller')!.x) + NODE_WIDTH / 2;
    assert.ok(layout.positions.get('callee')!.x - NODE_WIDTH / 2 > reachableRight);
    assert.ok(layout.annotations.some(annotation => annotation.label === 'No path to target'));
  }],
  ['dangling edges and unknown explicit targets are ignored without guessing', () => {
    const layout = targetLayout(graph(['a'], ['missing->a', 'a->missing'], ['missing']));
    assert.strictEqual(layout.distances.size, 0);
    assert.strictEqual(layout.targetIds.size, 0);
    assert.ok(layout.annotations.some(annotation => annotation.label === 'No target identified'));
  }],
  ['legacy sink inference and explicit empty targets remain distinct', () => {
    const g = graph(['a', 't'], ['a->t']);
    assert.strictEqual(targetLayout(g).distances.get('a'), 1);
    assert.strictEqual(targetLayout({ ...g, targetIds: [] }).distances.size, 0);
    assert.strictEqual(targetLayout(graph(['a', 'b'], ['a->b', 'b->a'])).targetIds.size, 0);
  }],
  ['empty graph has no positions or annotations', () => {
    const layout = targetLayout(graph([], [], []));
    assert.strictEqual(layout.positions.size, 0);
    assert.deepStrictEqual(layout.annotations, []);
  }],
  ['wide rows retain spacing and repeated renders have identical positions', () => {
    const callers = Array.from({ length: 299 }, (_, i) => `caller-${i}`);
    const g = graph(['t', ...callers], callers.map(id => `${id}->t`), ['t']);
    const layout = targetLayout(g);
    const xs = callers.map(id => layout.positions.get(id)!.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > NODE_WIDTH);
    assert.deepStrictEqual([...targetLayout(g).positions], [...layout.positions]);
  }],
  ['edge routes distinguish same-row, return, shortcut and self calls', () => {
    const g = graph(['a', 'b', 'c', 't'], ['a->b', 'b->c', 'c->t', 'b->t', 'c->b', 't->t'], ['t']);
    const layout = targetLayout(g);
    assert.strictEqual(edgeRoute('b', 'c', layout, 0).kind, 'same-row');
    assert.strictEqual(edgeRoute('t', 'b', layout, 0).kind, 'detour');
    assert.strictEqual(edgeRoute('a', 't', layout, 0).kind, 'detour');
    assert.strictEqual(edgeRoute('t', 't', layout, 0).kind, 'normal');
    assert.strictEqual(edgeRoute('c', 't', layout, 0).kind, 'normal');
    assert.ok(edgeRoute('a', 't', layout, 0).controlDistances!.every(Number.isFinite));
  }],
  ['return lanes stay outside the target graph when disconnected nodes occupy the right', () => {
    const layout = targetLayout(graph(['a', 'b', 't', 'outside'], ['a->b', 'b->t', 't->a'], ['t']));
    const route = edgeRoute('t', 'a', layout, 0);
    const source = layout.positions.get('t')!;
    const target = layout.positions.get('a')!;
    const dx = target.x - source.x; const dy = target.y - source.y;
    const length = Math.hypot(dx, dy);
    const left = Math.min(...[...layout.distances.keys()].map(id => layout.positions.get(id)!.x)) - NODE_WIDTH / 2;
    route.controlWeights!.forEach((weight, index) => {
      const offset = route.controlDistances![index];
      const x = source.x + dx * weight + (-dy / length) * offset;
      const y = source.y + dy * weight + (dx / length) * offset;
      if (index === 1 || index === 2) assert.ok(x < left);
      if (index === 0) assert.ok(Math.abs(x - source.x) < 0.000001);
      if (index === 3) assert.ok(Math.abs(x - target.x) < 0.000001);
      assert.ok(Math.abs(y - (index < 2 ? source.y : target.y)) > 60);
    });
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`  PASS  ${name}`); }
  catch (error) { failed++; console.error(`  FAIL  ${name}`, error); }
}
console.log(`\n${cases.length - failed}/${cases.length} target layout tests passed`);
process.exitCode = failed ? 1 : 0;
