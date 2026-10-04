import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import type { GraphData, GraphMessage, NodeClickedMessage } from '../types';
import type { PathFindPanel } from '../webview/PathFindPanel';
import { callerExpansionPreview } from '../webview/callerPreview';

const graph: GraphData = {
  targetIds: ['target'],
  nodes: [
    { id: 'target', label: 'target', file: 'chain.py', line: 1, endLine: 2 },
    { id: 'cutoff', label: 'cutoff', file: 'chain.py', line: 5, endLine: 6, hiddenCallers: 3 },
  ], edges: [{ from: 'cutoff', to: 'target', lines: [6] }],
};
const expanded: GraphData = {
  ...graph,
  nodes: [...graph.nodes.map(node => ({ ...node, hiddenCallers: undefined })),
    { id: 'caller', label: 'caller', file: 'chain.py', line: 9, endLine: 10 }],
  edges: [...graph.edges, { from: 'caller', to: 'cutoff', lines: [10] }],
};
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: (value: GraphData) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GraphData>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Exercise the real compiled panel's message callback; replace only VS Code and the expansion boundary. */
function fixture() {
  const disposable = { dispose() {} };
  class Emitter<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.clear(); }
  }
  let receive!: (message: unknown) => void;
  let onDispose!: () => void;
  let disposed = false;
  const sent: GraphMessage[] = [];
  const errors: string[] = [];
  const calls: { graph: GraphData; id: string }[] = [];
  let expand = async (_graph: GraphData, _id: string) => expanded;
  const webview = {
    html: '', cspSource: 'test-source', asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return disposable; },
    postMessage: (message: GraphMessage) => { sent.push(message); return Promise.resolve(true); },
  };
  const rawPanel = {
    webview, reveal() {},
    onDidDispose: (listener: () => void) => { onDispose = listener; return disposable; },
    dispose: () => { if (!disposed) { disposed = true; onDispose(); } },
  };
  const modules: Record<string, unknown> = {
    crypto,
    './callerPreview': { callerExpansionPreview },
    vscode: {
      EventEmitter: Emitter, ViewColumn: { Beside: 2 },
      Uri: { joinPath: (_uri: unknown, ...parts: string[]) => parts.join('/') },
      window: {
        createWebviewPanel: () => rawPanel,
        showErrorMessage: (message: string) => { errors.push(message); return Promise.resolve(); },
      },
    },
    '../graphBuilder': { expandCallers: (data: GraphData, id: string) => {
      calls.push({ graph: data, id });
      return expand(data, id);
    } },
  };
  const panelModule = {} as { PathFindPanel: typeof PathFindPanel };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../webview/PathFindPanel.js'), 'utf8'), {
    exports: panelModule,
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
  });
  const panel = panelModule.PathFindPanel.createOrShow({} as never);
  let renders = 0;
  panelModule.PathFindPanel.onDidRenderGraph(() => { renders++; });
  return {
    panel, receive: (message: unknown) => receive(message), sent, errors, calls, webview,
    setExpansion: (handler: typeof expand) => { expand = handler; },
    renders: () => renders,
    preview: (id = 'cutoff') => {
      const message = sent.filter(item => item.type === 'callerPreviews').at(-1);
      return message?.type === 'callerPreviews' ? message.previews[id] : undefined;
    },
    graphs: () => sent.filter(item => item.type === 'graph'),
    close: () => rawPanel.dispose(),
  };
}

const cases: [string, () => Promise<void>][] = [
  ['preview counts new functions without changing the graph; clicking applies the cached result', async () => {
    const f = fixture();
    f.panel.renderGraph(graph);
    f.receive({ type: 'ready' });
    assert.equal(f.preview()?.state, 'loading');
    await settle();
    assert.deepEqual({ ...f.preview() }, { state: 'ready', addedNodes: 1, addedNoiseNodes: 0 });
    assert.equal(f.panel.currentGraph, graph); assert.equal(f.renders(), 1);
    f.sent.length = 0;
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    await settle();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].graph, graph); assert.equal(f.calls[0].id, 'cutoff');
    assert.equal(f.panel.currentGraph, expanded);
    assert.equal(f.graphs().length, 1); assert.equal(f.sent[0].type, 'graph');
    assert.equal((f.sent[0] as { graph: GraphData }).graph, expanded);
    assert.equal(f.renders(), 2);
    assert.equal(graph.nodes[1].hiddenCallers, 3);
    assert.equal(f.errors.length, 0);
    assert.ok(f.webview.html.includes('id="truncation-markers"'));
    f.close();
  }],
  ['malformed, unknown, complete and invalid-count requests never expand', async () => {
    const f = fixture();
    f.receive({ type: 'expandCallers', id: 'cutoff' }); // No graph yet.
    f.setExpansion(() => new Promise(() => {})); // An in-flight preview must not be applied.
    f.panel.renderGraph(graph);
    const previews = f.calls.length;
    for (const message of [null, {}, { type: 'expandCallers' }, { type: 'expandCallers', id: 3 },
      { type: 'expandCallers', id: '' }, { type: 'expandCallers', id: 'missing' }, { type: 'expandCallers', id: 'target' }]) {
      f.receive(message);
    }
    for (const hiddenCallers of [undefined, 0, -1, 1.5, NaN, Infinity]) {
      f.panel.renderGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, hiddenCallers })) });
      f.receive({ type: 'expandCallers', id: 'cutoff' });
    }
    await settle();
    assert.equal(f.calls.length, previews); assert.equal(f.errors.length, 0);
    f.close();
  }],
  ['loading clicks are ignored and repeated ready clicks apply the cached result once', async () => {
    const f = fixture(); const pending = deferred();
    f.setExpansion(() => pending.promise); f.panel.renderGraph(graph);
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    f.receive({ type: 'expandCallers', id: 'target' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.panel.currentGraph, graph);
    pending.resolve(expanded); await settle();
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.panel.currentGraph, expanded); assert.equal(f.renders(), 2);
    f.close();
  }],
  ['replacement graphs invalidate previews and discard late results', async () => {
    const f = fixture(); const pending = deferred();
    f.setExpansion(() => pending.promise);
    f.panel.renderGraph(graph); f.receive({ type: 'ready' });
    const replacement = { ...graph, targetIds: ['cutoff'] };
    const next = deferred(); f.setExpansion(() => next.promise);
    f.panel.renderGraph(replacement);
    const sent = f.sent.length; const renders = f.renders();
    pending.resolve(expanded); await settle();
    assert.equal(f.panel.currentGraph, replacement);
    assert.equal(f.sent.length, sent); assert.equal(f.renders(), renders);
    assert.equal(f.preview()?.state, 'loading');
    next.resolve(expanded); await settle();
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.calls[1].graph, replacement); assert.equal(f.panel.currentGraph, expanded);
    f.close();
  }],
  ['disposal prevents late rendering and further expansion', async () => {
    const f = fixture(); const pending = deferred();
    f.setExpansion(() => pending.promise);
    f.panel.renderGraph(graph); f.receive({ type: 'ready' });
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    f.close(); const sent = f.sent.length;
    pending.resolve(expanded); await settle();
    assert.equal(f.panel.currentGraph, graph); assert.equal(f.sent.length, sent); assert.equal(f.renders(), 1);
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    assert.equal(f.calls.length, 1);
  }],
  ['failed previews preserve the graph; Retry recomputes the count before expansion', async () => {
    const f = fixture();
    f.setExpansion(async () => { throw new Error('language server unavailable'); });
    f.panel.renderGraph(graph); f.receive({ type: 'ready' }); await settle();
    assert.equal(f.preview()?.state, 'error');
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.panel.currentGraph, graph); assert.equal(f.calls.length, 1);
    assert.equal(f.errors.length, 0); // Background failures are shown on the marker.
    f.setExpansion(async () => expanded);
    f.receive({ type: 'previewCallers', id: 'missing' });
    f.receive({ type: 'previewCallers', id: 'cutoff' });
    f.receive({ type: 'previewCallers', id: 'cutoff' }); await settle();
    assert.equal(f.calls.length, 2); assert.equal(f.preview()?.state, 'ready');
    assert.equal(f.panel.currentGraph, graph);
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.panel.currentGraph, expanded);
    f.close();
  }],
  ['late failures after replacement or disposal do not show stale errors', async () => {
    for (const close of [false, true]) {
      const f = fixture(); const pending = deferred();
      f.setExpansion(() => pending.promise); f.panel.renderGraph(graph);
      f.receive({ type: 'expandCallers', id: 'cutoff' });
      if (close) f.close(); else f.panel.renderGraph(expanded);
      pending.reject(new Error('late failure')); await settle();
      assert.equal(f.errors.length, 0);
      f.close();
    }
  }],
  ['readiness still delivers the latest graph and nodeClicked still uses its event', async () => {
    const f = fixture(); const clicks: NodeClickedMessage[] = [];
    f.panel.onDidClickNode(message => clicks.push(message));
    f.panel.renderGraph(graph);
    await settle();
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.sent.length, 0);
    f.receive({ type: 'ready' });
    assert.equal(f.sent[0].type, 'graph');
    assert.equal((f.sent[0] as { graph: GraphData }).graph, expanded);
    f.receive({ type: 'nodeClicked', id: 'target', file: 'chain.py', line: 1 });
    assert.equal(clicks.length, 1); assert.equal(clicks[0].id, 'target');
    assert.equal(f.calls.length, 1);
    f.close();
  }],
  ['preview counts deduplicate IDs, exclude existing nodes and retain the noise subtotal', async () => {
    const noise = { id: 'module', label: '<module>', file: 'main.py', line: 1, endLine: 2, noise: true };
    const result = callerExpansionPreview(graph, {
      ...expanded, nodes: [...expanded.nodes, expanded.nodes[2], noise, noise, graph.nodes[0]],
    });
    assert.deepEqual(result, { state: 'ready', addedNodes: 2, addedNoiseNodes: 1 });
    assert.deepEqual(callerExpansionPreview(graph, graph), { state: 'ready', addedNodes: 0, addedNoiseNodes: 0 });
  }],
  ['multiple markers are previewed sequentially and stale per-marker caches are cleared after expansion', async () => {
    const f = fixture(); const first = deferred(); const second = deferred();
    const multi: GraphData = { ...graph, nodes: [...graph.nodes,
      { id: 'other', label: 'other', file: 'a.py', line: 1, endLine: 2, hiddenCallers: 1 }] };
    f.setExpansion((_data, id) => id === 'cutoff' ? first.promise : second.promise);
    f.panel.renderGraph(multi); f.receive({ type: 'ready' });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'cutoff');
    const firstResult: GraphData = { ...multi, nodes: [...multi.nodes.map(node => ({
      ...node, hiddenCallers: node.id === 'cutoff' ? undefined : node.hiddenCallers,
    })), expanded.nodes[2]] };
    first.resolve(firstResult); await settle();
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].id, 'other');
    assert.equal(f.preview('cutoff')?.state, 'ready'); assert.equal(f.preview('other')?.state, 'loading');
    const refreshed = deferred(); f.setExpansion(() => refreshed.promise);
    f.receive({ type: 'expandCallers', id: 'cutoff' }); await settle();
    assert.equal(f.panel.currentGraph, firstResult);
    assert.equal(f.calls.length, 3); assert.equal(f.calls[2].graph, firstResult);
    const sent = f.sent.length;
    second.resolve(expanded); await settle();
    assert.equal(f.sent.length, sent); assert.equal(f.preview('other')?.state, 'loading');
    refreshed.resolve(expanded); await settle();
    assert.equal(f.preview('other')?.state, 'ready');
    f.close();
  }],
  ['re-rendering the same object invalidates its earlier preview and a late cached click', async () => {
    const f = fixture(); const first = deferred(); const second = deferred();
    f.setExpansion(() => first.promise); f.panel.renderGraph(graph); f.receive({ type: 'ready' });
    f.setExpansion(() => second.promise); f.panel.renderGraph(graph);
    first.resolve(expanded); await settle(); assert.equal(f.preview()?.state, 'loading');
    second.resolve(expanded); await settle(); assert.equal(f.preview()?.state, 'ready');
    f.receive({ type: 'expandCallers', id: 'cutoff' });
    f.panel.renderGraph({ nodes: [], edges: [] }); await settle();
    assert.equal(f.panel.currentGraph?.nodes.length, 0);
    f.close();
  }],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log(`  PASS  ${name}`); }
    catch (error) { failed++; console.error(`  FAIL  ${name}`, error); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} truncation host tests passed`);
  process.exitCode = failed ? 1 : 0;
}
void main();
