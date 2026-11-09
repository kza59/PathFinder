// Unit tests for session history (src/sessionHistory.ts). Plain Node, no VS Code: part of `npm run test:unit`.
// Loads the real compiled sessionHistory.js / debugTracker.js / graphBuilder.js; only 'vscode' and the
// panel are replaced, so the real tracker paging and path resolution are exercised.
import * as assert from 'assert';
import * as path from 'path';
import type { CallValue, CallValues, GraphData, SessionHistoryMessage } from '../types';

let terminateListener: ((session: { id: string }) => void) | undefined;
let renderListener: ((panel: FakePanel) => void) | undefined;
const fakeVscode = {
  SymbolKind: {},
  debug: { onDidTerminateDebugSession: (listener: typeof terminateListener) => { terminateListener = listener; return { dispose() {} }; } },
};
interface FakePanel { currentGraph: GraphData | undefined; sent: SessionHistoryMessage[]; setSessionHistory(m: SessionHistoryMessage): void }
const fakePanelClass = {
  currentPanel: undefined as FakePanel | undefined,
  onDidRenderGraph: (listener: (panel: FakePanel) => void) => { renderListener = listener; return { dispose() {} }; },
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return fakeVscode;
  if (request === './webview/PathFindPanel') return { PathFindPanel: fakePanelClass };
  return load.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  SessionHistory, MAX_STEPS, MAX_FRAMES, registerSessionHistory,
  // per-step variable capture
  snapshotValues, MAX_SNAPSHOT_FRAMES, MAX_SNAPSHOT_ARGS, MAX_SNAPSHOT_LOCALS, MAX_SNAPSHOT_VALUE,
  MAX_SNAPSHOT_NAME, MAX_SNAPSHOT_CHARS,
} = require('../sessionHistory') as typeof import('../sessionHistory');
const { createTracker, sessionHistoryHook } = require('../debugTracker') as typeof import('../debugTracker');
/* eslint-enable @typescript-eslint/no-var-requires */
Module._load = load;

const FILE = path.resolve('/proj/main.py');
const graph: GraphData = {
  nodes: [
    { id: 'main', label: 'main', file: FILE, line: 1, endLine: 4 },
    { id: 'sum', label: 'sum', file: FILE, line: 6, endLine: 7 },
  ],
  edges: [],
};
const frame = (name: string, line: number) => ({ name, line, source: { path: FILE } });
const ids = (frames: { line: number }[]) => [...frames].reverse().map(f => (f.line >= 6 ? 'sum' : 'main'));

// --- per-step variable capture ---
/** A live CallValue as the call-values capture publishes one, with every optional field set. */
const callValue = (over: Partial<CallValue> = {}): CallValue => ({
  line: '(n=2)',
  args: [{ name: 'n', value: '2', ref: 7, type: 'int' }],
  atEntry: false,
  locals: [{ name: 'acc', value: '6', ref: 8, type: 'list' }],
  localsRows: ['acc=6'],
  localsCount: 1,
  ...over,
});

/** A worst-case capture: MAX_SNAPSHOT_FRAMES frames, each filled to every per-frame cap. */
function maximalValues(seed: number): CallValues {
  const big = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({
    name: `${prefix}_${i}_`.padEnd(MAX_SNAPSHOT_NAME + 20, 'n'),
    value: `${seed}:`.padEnd(MAX_SNAPSHOT_VALUE + 40, 'v'),
  }));
  return Object.fromEntries(Array.from({ length: MAX_SNAPSHOT_FRAMES }, (_, f) => [
    `/proj/main.py::f${f}`,
    callValue({ args: big('a', MAX_SNAPSHOT_ARGS + 4), locals: big('l', MAX_SNAPSHOT_LOCALS + 8) }),
  ]));
}
// --- end per-step variable capture ---

/** Drives a real tracker like VS Code does: stopped, then the stack in two pages (top frame, then the rest). */
function pause(tracker: ReturnType<typeof createTracker>, reason: string, stack: ReturnType<typeof frame>[], seq: number) {
  tracker.onDidSendMessage!({ type: 'event', seq, event: 'stopped', body: { threadId: 1, reason } });
  tracker.onWillReceiveMessage!({ type: 'request', seq, command: 'stackTrace', arguments: { threadId: 1, startFrame: 0 } });
  tracker.onDidSendMessage!({ type: 'response', seq: seq + 1, request_seq: seq, command: 'stackTrace', success: true, body: { stackFrames: stack.slice(0, 1) } });
  tracker.onWillReceiveMessage!({ type: 'request', seq: seq + 2, command: 'stackTrace', arguments: { threadId: 1, startFrame: 1 } });
  tracker.onDidSendMessage!({ type: 'response', seq: seq + 3, request_seq: seq + 2, command: 'stackTrace', success: true, body: { stackFrames: stack.slice(1) } });
}

const cases: [string, () => void][] = [
  ['one pause = one step, even though the stack arrives in pages; live highlight still fires per page', () => {
    let changes = 0;
    const history = new SessionHistory(() => changes++, () => 1000);
    history.start('root');
    const live: number[] = [];
    const tracker = createTracker(() => graph, frames => live.push(frames.length), undefined, history.tap('Run'));
    pause(tracker, 'breakpoint', [frame('sum', 7), frame('main', 2)], 1);
    pause(tracker, 'step', [frame('main', 3)], 10);
    assert.deepStrictEqual(live, [1, 2, 1, 1]); // unchanged live behavior: every page still highlights
    const steps = history.steps(ids);
    assert.strictEqual(steps.length, 2);
    assert.deepStrictEqual(steps.map(s => [s.path, s.reason, s.where?.line, s.session]), [
      [['main', 'sum'], 'breakpoint', 7, 'Run'],
      [['main'], 'step', 3, 'Run'],
    ]);
    assert.strictEqual(changes, 3); // start + 2 new steps (page updates don't re-notify)
  }],
  ['a pause whose frames never arrive records nothing; missing reason reads "pause"', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    tap.paused('breakpoint');
    tap.paused(undefined);
    tap.framesChanged([frame('main', 1)]);
    assert.deepStrictEqual(history.steps(ids).map(s => s.reason), ['pause']);
  }],
  ['ending the top-level session keeps the steps and ignores late frames; a child ending does not stop it', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    tap.paused('step');
    tap.framesChanged([frame('main', 1)]);
    assert.strictEqual(history.end('child'), false);
    assert.strictEqual(history.recording, true);
    tap.paused('step');
    assert.strictEqual(history.end('root'), true);
    tap.framesChanged([frame('main', 2)]); // late response for a pause opened before the end
    assert.strictEqual(history.recording, false);
    assert.strictEqual(history.count, 1);
  }],
  ['a new session clears the history; taps from the old session cannot add to it', () => {
    const history = new SessionHistory();
    history.start('first');
    const old = history.tap('Run');
    old.paused('step');
    old.framesChanged([frame('main', 1)]);
    old.paused('step');
    history.start('second');
    old.framesChanged([frame('main', 2)]);
    assert.strictEqual(history.count, 0);
  }],
  ['caps: oldest steps dropped past MAX_STEPS, deepest frames past MAX_FRAMES', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    for (let i = 0; i < MAX_STEPS + 3; i++) {
      tap.paused('step');
      tap.framesChanged([frame('main', i)]);
    }
    assert.strictEqual(history.count, MAX_STEPS);
    assert.strictEqual(history.dropped, 3);
    assert.strictEqual(history.steps(ids)[0].where?.line, 3);
    tap.paused('step');
    tap.framesChanged(Array.from({ length: MAX_FRAMES + 50 }, (_, i) => frame('main', i)));
    assert.strictEqual(history.steps(f => f.map(String)).at(-1)!.path.length, MAX_FRAMES);
  }],
  // --- per-step variable capture ---
  ['snapshot: strings only, every per-frame cap applied, refs and types stripped', () => {
    const snapshot = snapshotValues({
      main: callValue({
        args: [{ name: 'a'.repeat(MAX_SNAPSHOT_NAME + 10), value: 'x'.repeat(MAX_SNAPSHOT_VALUE + 50) },
          { name: 'missing' }], // not in Locals: stays valueless rather than gaining a made-up one
        locals: Array.from({ length: MAX_SNAPSHOT_LOCALS + 5 }, (_, i) => ({ name: `l${i}`, value: `${i}`, ref: i + 1 })),
        localsCount: 99,
        atEntry: true,
      }),
    })!;
    const captured = snapshot.main;
    // No ref and no type anywhere: a recorded step can never answer an expansion.
    assert.strictEqual(JSON.stringify(snapshot).includes('"ref"'), false);
    assert.strictEqual(JSON.stringify(snapshot).includes('"type"'), false);
    assert.strictEqual(captured.args[0].name.length, MAX_SNAPSHOT_NAME);
    assert.strictEqual(captured.args[0].value!.length, MAX_SNAPSHOT_VALUE);
    assert.deepStrictEqual(captured.args[1], { name: 'missing' });
    assert.strictEqual(captured.locals.length, MAX_SNAPSHOT_LOCALS);
    assert.strictEqual(captured.localsCount, 99); // the true total, so "+N more" stays truthful
    assert.deepStrictEqual(captured.localsRows, ['acc=6']); // the node's band, for scrubbing later
    assert.strictEqual(captured.atEntry, true);
    // atEntry false is absent rather than stored: that is the common case, so it is the cheap one.
    assert.strictEqual('atEntry' in snapshotValues({ main: callValue() })!.main, false);
    // shortenValue runs before the length cap, so addresses go and objects collapse.
    const dog = snapshotValues({ main: callValue({ args: [{ name: 'd', value: '<__main__.Dog object at 0x7f1>' }] }) })!;
    assert.strictEqual(dog.main.args[0].value, '<Dog>');
  }],
  ['snapshot: only the innermost MAX_SNAPSHOT_FRAMES frames, and nothing stale', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SNAPSHOT_FRAMES + 4 }, (_, i) => [`f${i}`, callValue()]),
    );
    // CallValues arrives innermost first, so the frames kept are the leading ones.
    assert.deepStrictEqual(Object.keys(snapshotValues(many)!),
      Array.from({ length: MAX_SNAPSHOT_FRAMES }, (_, i) => `f${i}`));
    assert.strictEqual(snapshotValues({ main: callValue({ stale: true }) }), undefined);
    assert.strictEqual(snapshotValues({}), undefined);
  }],
  ['capture: values attach to the open step and ride out with it, filtered to its path', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    tap.paused('breakpoint');
    tap.framesChanged([frame('sum', 7), frame('main', 2)]);
    // 'gone' is not on this path: another graph could resolve it there, this one cannot.
    tap.valuesCaptured({ sum: callValue(), gone: callValue() });
    const step = history.steps(ids)[0];
    assert.deepStrictEqual(Object.keys(step.values!), ['sum']);
    assert.deepStrictEqual(step.values!.sum.args, [{ name: 'n', value: '2' }]);
    assert.deepStrictEqual(step.path, ['main', 'sum']); // the path itself is untouched
    // A step that captured nothing carries no `values` key at all.
    tap.paused('step');
    tap.framesChanged([frame('main', 3)]);
    assert.strictEqual('values' in history.steps(ids)[1], false);
    // Nothing on the path matches: omitted entirely rather than attached to the wrong node.
    tap.valuesCaptured({ nowhere: callValue() });
    assert.strictEqual('values' in history.steps(ids)[1], false);
  }],
  ['capture: the generation guard rejects values from a pause the program has left', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    // Before any frames arrived there is no step to attach to yet.
    tap.paused('step');
    tap.valuesCaptured({ main: callValue() });
    tap.framesChanged([frame('main', 2)]);
    assert.strictEqual('values' in history.steps(ids)[0], false);

    // A late capture for an older pause must not land on a newer one.
    const old = history.tap('Run');
    old.paused('step');
    old.framesChanged([frame('main', 2)]);
    history.start('second'); // a restart bumps the generation
    const fresh = history.tap('Run');
    fresh.paused('step');
    fresh.framesChanged([frame('main', 3)]);
    old.valuesCaptured({ main: callValue() });
    assert.strictEqual(history.count, 1);
    assert.strictEqual('values' in history.steps(ids)[0], false);
    // The current pause still accepts its own.
    fresh.valuesCaptured({ main: callValue() });
    assert.ok(history.steps(ids)[0].values);
  }],
  ['caps: past MAX_SNAPSHOT_CHARS the OLDEST values are evicted and every step keeps its path', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    const perStep = JSON.stringify(snapshotValues(maximalValues(0))!).length;
    // The worst case stays the size the caps were chosen for: ~18 KB a step at 6 frames.
    assert.ok(perStep < 24_000, `worst case per step grew to ${perStep} characters`);
    const needed = Math.floor(MAX_SNAPSHOT_CHARS / perStep) + 2;
    for (let i = 0; i < needed; i++) {
      tap.paused('step');
      tap.framesChanged([frame('main', i)]);
      tap.valuesCaptured(maximalValues(i));
    }
    const resolveAll = (frames: { line: number }[]) => frames.map(() => '/proj/main.py::f0');
    const steps = history.steps(resolveAll);
    assert.strictEqual(steps.length, needed);        // not one step was dropped
    assert.strictEqual(history.dropped, 0);
    assert.strictEqual('values' in steps[0], false); // the oldest lost its values
    assert.strictEqual(steps[0].path.length, 1);     // and kept its path
    assert.ok(steps.at(-1)!.values, 'the newest step keeps its values');
    const kept = steps.filter(step => step.values).length;
    assert.ok(kept > 0 && kept < needed, `expected a partial eviction, kept ${kept}/${needed}`);
    assert.ok(kept * perStep <= MAX_SNAPSHOT_CHARS, 'the surviving values exceed the budget');
    // VS Code can re-fetch a stack, so the same pause can be captured twice: the second snapshot
    // must REPLACE the first one's cost. Double-counting would shrink the budget on every re-fetch.
    for (let i = 0; i < 20; i++) {
      tap.valuesCaptured(maximalValues(i));
    }
    const recaptured = history.steps(resolveAll).filter(step => step.values).length;
    assert.strictEqual(recaptured, kept, 'a re-captured pause was charged twice');
  }],
  ['caps: a step dropped past MAX_STEPS refunds its share of the values budget', () => {
    const history = new SessionHistory();
    history.start('root');
    const tap = history.tap('Run');
    for (let i = 0; i < MAX_STEPS + 5; i++) {
      tap.paused('step');
      tap.framesChanged([frame('main', i)]);
      tap.valuesCaptured({ main: callValue() });
    }
    // Every frame resolves to the node the snapshots are keyed by, so nothing is path-filtered.
    const steps = history.steps(frames => frames.map(() => 'main'));
    assert.strictEqual(steps.length, MAX_STEPS);
    assert.strictEqual(history.dropped, 5);
    // These snapshots are small enough that MAX_STEPS of them stay inside the budget, so every
    // surviving step still has its values - which is only true if the dropped ones refunded theirs.
    assert.strictEqual(steps.filter(step => step.values).length, MAX_STEPS);
  }],
  // --- end per-step variable capture ---
  ['wiring: root session starts recording, child joins it, end sends every step resolved on the current graph', () => {
    registerSessionHistory({ subscriptions: [] } as never);
    const panel: FakePanel = { currentGraph: graph, sent: [], setSessionHistory(m) { this.sent.push(m); } };
    fakePanelClass.currentPanel = panel;
    const root = createTracker(() => graph, () => {}, undefined, sessionHistoryHook.tap!({ id: 'root', name: 'Run' } as never));
    const child = createTracker(() => graph, () => {}, undefined,
      sessionHistoryHook.tap!({ id: 'kid', name: 'Child', parentSession: { id: 'root' } } as never));
    pause(root, 'breakpoint', [frame('sum', 7), frame('main', 2)], 1);
    pause(child, 'step', [frame('main', 3)], 10);
    terminateListener!({ id: 'root' });
    const last = panel.sent.at(-1)!;
    assert.strictEqual(last.state, 'ended');
    assert.deepStrictEqual(last.state === 'ended' && last.steps.map(s => [s.path, s.session]),
      [[['main', 'sum'], 'Run'], [['main'], 'Child']]);
    // A different graph afterwards: the same history is re-mapped onto it (sum is outside it now).
    panel.currentGraph = { nodes: [graph.nodes[0]], edges: [] };
    renderListener!(panel);
    const remapped = panel.sent.at(-1)!;
    assert.deepStrictEqual(remapped.state === 'ended' && remapped.steps[0].path, ['main', 'pathfinder-unmatched-frame-1']);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n${err instanceof Error ? err.stack : err}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} session history tests passed`);
process.exit(failed ? 1 : 0);
