// Unit tests for breakpoint markers (src/breakpoints.ts). Plain Node, no VS Code: part of `npm run test:unit`.
// Loads the real compiled breakpoints.js + graphBuilder.js (so findNodeForFrame and normalizePath are the
// real ones); only the 'vscode' module and the panel are replaced.
import * as assert from 'assert';
import * as path from 'path';
import type { BreakpointCounts, GraphData } from '../types';

// --- fake vscode: just what breakpoints.ts and graphBuilder.ts touch ---
class Breakpoint {
  constructor(readonly enabled = true, readonly condition?: string, readonly hitCondition?: string, readonly logMessage?: string) {}
}
class SourceBreakpoint extends Breakpoint {
  constructor(readonly location: { uri: { scheme: string; fsPath: string }; range: { start: { line: number } } },
    enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
    super(enabled, condition, hitCondition, logMessage);
  }
}
class FunctionBreakpoint extends Breakpoint {
  constructor(readonly functionName: string, enabled?: boolean) {
    super(enabled);
  }
}
let changeListener: (() => void) | undefined;
let renderListener: ((panel: FakePanel) => void) | undefined;
const fakeVscode = {
  SourceBreakpoint, FunctionBreakpoint, SymbolKind: {},
  debug: {
    breakpoints: [] as Breakpoint[],
    onDidChangeBreakpoints: (listener: () => void) => { changeListener = listener; return { dispose() {} }; },
  },
};
interface FakePanel { currentGraph: GraphData | undefined; sent: BreakpointCounts[]; setBreakpoints(counts: BreakpointCounts): void }
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { breakpointCounts, registerBreakpointMarkers } = require('../breakpoints') as typeof import('../breakpoints');
Module._load = load;

// --- fixture: absolute paths, as the graph builder stores them ---
const dir = path.resolve('/proj');
const MAIN = path.join(dir, 'main.py');
const SUM = path.join(dir, 'sum.py');
const graph: GraphData = {
  nodes: [
    { id: 'main', label: 'main', file: MAIN, line: 1, endLine: 4 },
    { id: 'outer', label: 'outer', file: MAIN, line: 6, endLine: 12 },
    { id: 'inner', label: 'outer.inner', file: MAIN, line: 8, endLine: 9 },
    { id: 'sum', label: 'sum', file: SUM, line: 1, endLine: 2 },
  ],
  edges: [],
};
const file = (fsPath: string) => ({ scheme: 'file', fsPath });
/** A source breakpoint on a 1-based line (VS Code stores 0-based). */
const at = (fsPath: string, line: number, enabled = true, logMessage?: string) =>
  new SourceBreakpoint({ uri: file(fsPath), range: { start: { line: line - 1 } } }, enabled, undefined, undefined, logMessage);
const counts = (bps: Breakpoint[], g: GraphData | undefined = graph) => breakpointCounts(bps as never, g);

const cases: [string, () => void][] = [
  ['a breakpoint inside a function marks that node; first and last lines count, outside does not', () => {
    assert.deepStrictEqual(counts([at(SUM, 1)]), { sum: 1 });
    assert.deepStrictEqual(counts([at(SUM, 2)]), { sum: 1 });
    assert.deepStrictEqual(counts([at(SUM, 3), at(MAIN, 5)]), {});
  }],
  ['several breakpoints in one function are counted; nested def goes to the innermost node', () => {
    assert.deepStrictEqual(counts([at(MAIN, 2), at(MAIN, 3), at(MAIN, 9), at(MAIN, 11)]), { main: 2, inner: 1, outer: 1 });
  }],
  ['paths are normalized like node ids (Windows: case and slashes)', () => {
    const spelled = process.platform === 'win32' ? SUM.toUpperCase().split(path.sep).join('/') : `${dir}/./sum.py`;
    assert.deepStrictEqual(counts([at(spelled, 2)]), { sum: 1 });
  }],
  ['disabled breakpoints, logpoints, non-file documents and files outside the graph are ignored', () => {
    const untitled = new SourceBreakpoint({ uri: { scheme: 'untitled', fsPath: SUM }, range: { start: { line: 0 } } });
    assert.deepStrictEqual(counts([at(SUM, 2, false), at(SUM, 2, true, 'x={x}'), untitled, at(path.join(dir, 'other.py'), 1)]), {});
  }],
  ['function breakpoints match a node label exactly; data/other breakpoints are ignored', () => {
    assert.deepStrictEqual(counts([new FunctionBreakpoint('sum'), new FunctionBreakpoint('inner'), new FunctionBreakpoint('outer.inner'), new Breakpoint()]),
      { sum: 1, inner: 1 });
    assert.deepStrictEqual(counts([new FunctionBreakpoint('sum', false)]), {});
  }],
  ['no graph: nothing to mark', () => {
    assert.deepStrictEqual(breakpointCounts([at(SUM, 1)] as never, undefined), {});
  }],
  ['live: re-sent when breakpoints change and when a graph renders; no panel is fine', () => {
    registerBreakpointMarkers({ subscriptions: [] } as never);
    fakeVscode.debug.breakpoints = [at(SUM, 2)];
    changeListener!(); // no panel open: nothing to do, no throw
    const panel: FakePanel = { currentGraph: graph, sent: [], setBreakpoints(c) { this.sent.push(c); } };
    fakePanelClass.currentPanel = panel;
    changeListener!();
    assert.deepStrictEqual(panel.sent.at(-1), { sum: 1 });
    fakeVscode.debug.breakpoints = [];
    changeListener!(); // removing the last breakpoint clears the markers
    assert.deepStrictEqual(panel.sent.at(-1), {});
    fakeVscode.debug.breakpoints = [at(MAIN, 2)];
    panel.currentGraph = { nodes: graph.nodes.filter(n => n.id === 'main'), edges: [] };
    renderListener!(panel);
    assert.deepStrictEqual(panel.sent.at(-1), { main: 1 });
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
console.log(`\n${cases.length - failed}/${cases.length} breakpoint marker tests passed`);
process.exit(failed ? 1 : 0);
