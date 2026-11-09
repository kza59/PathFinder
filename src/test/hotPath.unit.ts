// Unit tests for mapHotCounts. Plain Node, no VS Code: `npm run test:unit`.
// Added with the return values feature, which rides the hot-path channel.
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mapHotCounts, type HotFunction } from '../hotPathMap';
import type { GraphData } from '../types';

const graph: GraphData = {
  nodes: [
    { id: 'app::add', label: 'add', file: '/proj/app.py', line: 1, endLine: 2 },
    { id: 'app::main', label: 'main', file: '/proj/app.py', line: 4, endLine: 5 },
    { id: 'app::<module>', label: '<module>', file: '/proj/app.py', line: 1, endLine: 7 },
  ],
  edges: [],
};
const fn = (over: Partial<HotFunction>): HotFunction => ({
  file: '/proj/app.py', qualname: 'add', line: 1, endLine: 2, count: 1, ...over,
});

const cases: [string, () => void][] = [
  ['counts still map as they did, with or without return values', () => {
    const { counts, returns } = mapHotCounts([fn({ count: 3 })], graph);
    assert.deepStrictEqual(counts, { 'app::add': 3 });
    assert.deepStrictEqual(returns, {}); // no ret field: nothing to show
  }],
  // --- return values feature ---
  ['a return value lands on the same node as its count', () => {
    const { counts, returns } = mapHotCounts(
      [fn({ count: 2, ret: '7', retSeq: 5 }), fn({ qualname: 'main', line: 4, endLine: 5, ret: 'None', retSeq: 6 })],
      graph);
    assert.deepStrictEqual(counts, { 'app::add': 2, 'app::main': 1 });
    assert.deepStrictEqual(returns, { 'app::add': '7', 'app::main': 'None' });
  }],
  ['when several entries map to one node, the highest retSeq wins', () => {
    // Two processes, or the same function re-entered as a new code object: counts add up, but the
    // value shown has to be one of them - the most recently captured.
    const older = fn({ count: 1, ret: 'stale', retSeq: 2 });
    const newer = fn({ count: 1, ret: 'fresh', retSeq: 9 });
    assert.deepStrictEqual(mapHotCounts([older, newer], graph).returns, { 'app::add': 'fresh' });
    assert.deepStrictEqual(mapHotCounts([newer, older], graph).returns, { 'app::add': 'fresh' });
    assert.deepStrictEqual(mapHotCounts([older, newer], graph).counts, { 'app::add': 2 });
  }],
  ['a missing retSeq never outranks a real one, and an empty string is still a value', () => {
    assert.deepStrictEqual(
      mapHotCounts([fn({ ret: 'seqless' }), fn({ ret: 'ranked', retSeq: 1 })], graph).returns,
      { 'app::add': 'ranked' });
    assert.deepStrictEqual(mapHotCounts([fn({ ret: '', retSeq: 1 })], graph).returns, { 'app::add': '' });
  }],
  ['a function that matches no node contributes no return value', () => {
    const stray = fn({ file: '/proj/other.py', qualname: 'ghost', ret: '1', retSeq: 9 });
    const { returns, unmatched } = mapHotCounts([stray], graph);
    assert.deepStrictEqual(returns, {});
    assert.strictEqual(unmatched.length, 1);
    assert.deepStrictEqual(mapHotCounts([fn({ ret: '1', retSeq: 1 })], undefined).returns, {});
  }],
  ['the hook keeps the last return of a recursion and of a tight loop', () => {
    // Runs the real sitecustomize.py, which needs Python 3.12+ for sys.monitoring.
    if (spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 12))']).status !== 0) {
      console.log('  SKIP  python3 3.12+ not found');
      return;
    }
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pathfinder-ret-')));
    try {
      const out = path.join(dir, 'out');
      fs.writeFileSync(path.join(dir, 'prog.py'), [
        'def fact(n):',
        '    return 1 if n <= 1 else n * fact(n - 1)',
        'def add(a, b):',
        '    return a + b',
        'fact(5)',
        'for i in range(1000):',
        '    add(i, 1)',
      ].join('\n'));
      const run = spawnSync('python3', ['prog.py'], {
        cwd: dir,
        env: {
          ...process.env,
          PYTHONPATH: path.join(__dirname, '..', '..', 'python', 'pathfinder_hot'),
          PATHFINDER_HOT_DIR: out,
          PATHFINDER_HOT_ROOTS: dir,
        },
      });
      assert.strictEqual(run.status, 0, String(run.stderr));
      const [file] = fs.readdirSync(out);
      const { functions } = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8')) as { functions: HotFunction[] };
      const ret = (name: string) => functions.find(fn => fn.qualname === name)?.ret;
      assert.strictEqual(ret('fact'), '120');
      assert.strictEqual(ret('add'), '1000');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  // --- end return values feature ---
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
console.log(`\n${cases.length - failed}/${cases.length} hot path tests passed`);
process.exit(failed ? 1 : 0);
