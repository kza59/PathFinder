import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';
import type { GraphData } from '../types';

// Load the compiled tracker with only its VS Code event and panel boundaries replaced.
// This exercises the registered lifecycle callbacks without launching a debugger.
function fixture() {
  let createTracker!: (session: { id: string }) => vscode.DebugAdapterTracker;
  let terminate!: (session: { id: string }) => void;
  let displayedPath: string[] = [];
  let clears = 0;
  const graph: GraphData = {
    nodes: ['a', 'b'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 10 })),
    edges: [],
  };
  const panel = {
    currentGraph: graph,
    highlightPath: (ids: string[]) => { displayedPath = [...ids]; },
    clearDebugPath: () => { displayedPath = []; clears++; },
  };
  const panelClass: { currentPanel: typeof panel | undefined } = { currentPanel: panel };
  const subscriptions: { dispose(): void }[] = [];
  const moduleExports: { registerDebugTracker?: (context: { subscriptions: typeof subscriptions }) => void } = {};
  const disposable = { dispose() {} };
  const modules: Record<string, unknown> = {
    vscode: { debug: {
      registerDebugAdapterTrackerFactory: (_type: string, factory: { createDebugAdapterTracker: typeof createTracker }) => {
        createTracker = factory.createDebugAdapterTracker;
        return disposable;
      },
      onDidTerminateDebugSession: (listener: typeof terminate) => { terminate = listener; return disposable; },
    } },
    './webview/PathFindPanel': { PathFindPanel: panelClass },
    './graphBuilder': {
      findNodeForFrame: (data: GraphData, file: string, line: number) =>
        data.nodes.find(node => node.file === file && node.line <= line && line <= node.endLine),
    },
  };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../debugTracker.js'), 'utf8'), {
    exports: moduleExports,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  moduleExports.registerDebugTracker!({ subscriptions });
  assert.equal(subscriptions.length, 2);
  return { createTracker, terminate, panelClass, getPath: () => displayedPath, getClears: () => clears };
}

function request(tracker: vscode.DebugAdapterTracker, seq: number): void {
  tracker.onWillReceiveMessage!({ type: 'request', seq, command: 'stackTrace', arguments: { threadId: 1, startFrame: 0 } });
}

function respond(tracker: vscode.DebugAdapterTracker, seq: number, name: string): void {
  tracker.onDidSendMessage!({
    type: 'response', seq: seq + 100, request_seq: seq, command: 'stackTrace', success: true,
    body: { stackFrames: [{ name, line: 2, source: { path: `${name}.py` } }] },
  });
}

const cases: [string, () => void][] = [
  ['ending the displayed session clears its path and ignores late stack responses', () => {
    const f = fixture();
    const session = { id: 'debug-a' };
    const tracker = f.createTracker(session);
    request(tracker, 1); respond(tracker, 1, 'a');
    assert.deepEqual(f.getPath(), ['a']);
    request(tracker, 2);
    f.terminate(session);
    assert.deepEqual(f.getPath(), []);
    assert.equal(f.getClears(), 1);
    respond(tracker, 2, 'b');
    request(tracker, 3); respond(tracker, 3, 'a');
    assert.deepEqual(f.getPath(), []);
  }],
  ['ending another session keeps the currently displayed session highlighted', () => {
    const f = fixture();
    const a = { id: 'debug-a' }; const b = { id: 'debug-b' };
    const first = f.createTracker(a); const second = f.createTracker(b);
    request(first, 1); respond(first, 1, 'a');
    request(second, 1); respond(second, 1, 'b');
    f.terminate(a);
    assert.deepEqual(f.getPath(), ['b']);
    assert.equal(f.getClears(), 0);
    f.terminate(b);
    assert.deepEqual(f.getPath(), []);
    assert.equal(f.getClears(), 1);
  }],
  ['termination is safe with a closed panel and repeated session-end notifications', () => {
    const f = fixture();
    const session = { id: 'debug-a' };
    const tracker = f.createTracker(session);
    request(tracker, 1); respond(tracker, 1, 'a');
    f.panelClass.currentPanel = undefined;
    f.terminate(session);
    f.terminate(session);
    f.terminate({ id: 'never-tracked' });
    assert.equal(f.getClears(), 0);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`  PASS  ${name}`); }
  catch (error) { failed++; console.error(`  FAIL  ${name}`, error); }
}
console.log(`\n${cases.length - failed}/${cases.length} debug lifecycle tests passed`);
process.exitCode = failed ? 1 : 0;
