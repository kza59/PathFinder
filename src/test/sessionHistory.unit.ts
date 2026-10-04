// Unit tests for session history (src/sessionHistory.ts). Plain Node, no VS Code: part of `npm run test:unit`.
// Loads the real compiled sessionHistory.js / debugTracker.js / graphBuilder.js; only 'vscode' and the
// panel are replaced, so the real tracker paging and path resolution are exercised.
import * as assert from 'assert';
import * as path from 'path';
import type { GraphData, SessionHistoryMessage } from '../types';

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
const { SessionHistory, MAX_STEPS, MAX_FRAMES, registerSessionHistory } = require('../sessionHistory') as typeof import('../sessionHistory');
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
