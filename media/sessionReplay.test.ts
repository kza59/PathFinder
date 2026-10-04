import * as assert from 'node:assert/strict';
import type { Core } from 'cytoscape';
import type { GraphRenderer } from './graph';
import { initializeReplayControls } from './sessionReplay';
import type { DebugPath, GraphMessage, HistoryStep } from '../src/types';

class Control extends EventTarget {
  disabled = false;
  hidden = true;
  title = '';
  value = '0';
  max = '0';
  textContent = '';
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

// Drive the actual footer listeners and renderer, with a deterministic timer and lightweight DOM controls.
function harness(cy: Core, renderer: GraphRenderer) {
  const controls = {
    replay: new Control(), box: new Control(), slider: new Control(),
    previous: new Control(), next: new Control(), label: new Control(),
  };
  const events = new EventTarget();
  const shownPaths: DebugPath[] = [];
  const highlightPath = (path: DebugPath) => {
    shownPaths.push([...path]);
    renderer.highlightPath(path);
  };
  const send = (data: GraphMessage) => events.dispatchEvent(new MessageEvent('message', { data }));
  events.addEventListener('message', event => {
    const message = (event as MessageEvent<GraphMessage>).data;
    if (message.type === 'debugPath') highlightPath(message.path);
    if (message.type === 'debugClear') renderer.clearDebugPath();
    if (message.type === 'graph') renderer.renderGraph(message.graph);
  });
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const dispose = initializeReplayControls(controls, events,
    path => send({ type: 'debugPath', path }), highlightPath, id => cy.$id(id).isNode());
  return {
    controls, send, shownPaths,
    current: () => cy.nodes('.current').map(node => node.id()),
    pending: () => timers.size,
    advance: (ms: number) => {
      const until = now + ms;
      for (;;) {
        const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > until) break;
        now = first[1].at;
        timers.delete(first[0]);
        first[1].callback();
      }
      now = until;
    },
    dispose: () => { dispose(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; },
  };
}

const pauses: HistoryStep[] = [
  { path: ['root', 'a'], reason: 'breakpoint', time: 0, session: 'Run' },
  { path: ['root', 'a'], reason: 'step', time: 1, session: 'Run' },
  { path: ['b', 't'], reason: 'step', time: 2, session: 'Run' },
];
type Harness = ReturnType<typeof harness>;
type ReplayCase = [string, (h: Harness, cy: Core, renderer: GraphRenderer) => void];
const tests: ReplayCase[] = [
  ['Replay is enabled after termination without selecting a pause, even if debugClear arrives last', h => {
    h.send({ type: 'sessionHistory', state: 'recording', count: 3, dropped: 0 });
    assert.equal(h.controls.replay.disabled, true);
    assert.equal(h.controls.slider.disabled, true);
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.send({ type: 'debugClear' });
    assert.equal(h.controls.replay.disabled, false);
    assert.equal(h.controls.replay.title, 'Replay all recorded debugging steps');
    assert.deepEqual(h.current(), []);
  }],
  ['Replay visits every pause without clearing between paths, updates controls and restores the static view', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 4 });
    h.controls.replay.click();
    assert.deepEqual(h.current(), ['a']);
    assert.equal(h.controls.slider.value, '0');
    assert.match(h.controls.label.textContent, /Step 1 of 3.*breakpoint.*4 older dropped/);
    h.advance(499);
    assert.deepEqual(h.current(), ['a']);
    assert.equal(h.controls.slider.value, '0');
    assert.equal(h.controls.replay.disabled, false);
    h.advance(1);
    assert.deepEqual(h.current(), ['a']);
    assert.equal(h.controls.slider.value, '1');
    h.advance(499);
    assert.deepEqual(h.current(), ['a']);
    h.advance(1);
    assert.deepEqual(h.current(), ['t']);
    assert.match(h.controls.label.textContent, /Step 3 of 3/);
    h.advance(499);
    assert.deepEqual(h.current(), ['t']);
    assert.deepEqual(h.shownPaths, pauses.map(pause => pause.path));
    h.advance(1);
    assert.deepEqual(h.current(), []);
    assert.match(h.controls.label.textContent, /Session ended/);
    assert.equal(h.pending(), 0);
    assert.equal(h.controls.replay.disabled, false);
  }],
  ['Replay starts from the beginning and restores a manually selected pause on completion', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.previous.click(); // Select the last pause first.
    assert.deepEqual(h.current(), ['t']);
    h.controls.replay.click();
    assert.deepEqual(h.current(), ['a']);
    h.advance(1500);
    assert.deepEqual(h.current(), ['t']);
    assert.equal(h.controls.slider.value, '2');
    assert.equal(h.pending(), 0);
  }],
  ['clicking Replay during playback restarts once; manual scrubbing cancels playback', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.replay.click();
    h.advance(1000);
    assert.deepEqual(h.current(), ['t']);
    h.controls.replay.click();
    assert.equal(h.controls.slider.value, '0');
    assert.deepEqual(h.current(), ['a']);
    assert.equal(h.pending(), 1);
    h.controls.slider.value = '2';
    h.controls.slider.dispatchEvent(new Event('input'));
    h.advance(5000);
    assert.deepEqual(h.current(), ['t']);
    assert.equal(h.pending(), 0);
  }],
  ['a new session cancels history playback and cannot be overwritten by an old timer', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.replay.click();
    h.send({ type: 'sessionHistory', state: 'recording', count: 0, dropped: 0 });
    h.advance(5000);
    assert.deepEqual(h.current(), []);
    assert.equal(h.controls.replay.disabled, true);
    assert.equal(h.controls.slider.disabled, true);
    assert.match(h.controls.label.textContent, /Recording/);
    h.send({ type: 'debugPath', path: ['b', 't'] });
    assert.deepEqual(h.current(), ['t']);
  }],
  ['a recording update after a new live pause preserves that pause', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.replay.click();
    h.send({ type: 'debugPath', path: ['b', 't'] });
    h.send({ type: 'sessionHistory', state: 'recording', count: 1, dropped: 0 });
    h.advance(5000);
    assert.deepEqual(h.current(), ['t']);
    assert.equal(h.pending(), 0);
  }],
  ['empty history disables Replay; one pause and outside-graph frames finish cleanly', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: [], dropped: 0 });
    assert.equal(h.controls.replay.disabled, true);
    h.send({ type: 'sessionHistory', state: 'ended', steps: [{ ...pauses[0], path: ['missing'] }], dropped: 0 });
    assert.equal(h.controls.replay.disabled, false);
    h.controls.replay.click();
    h.advance(500);
    assert.deepEqual(h.current(), []);
    assert.equal(h.pending(), 0);
  }],
  ['graph replacement cancels playback and the remapped history remains replayable', (h, cy) => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.replay.click();
    const graph = { nodes: cy.nodes().map(node => node.data()), edges: [] };
    h.send({ type: 'graph', graph });
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.advance(5000);
    assert.deepEqual(h.current(), []);
    assert.equal(h.pending(), 0);
    assert.equal(h.controls.replay.disabled, false);
    h.controls.replay.click();
    assert.deepEqual(h.current(), ['a']);
  }],
  ['live call-path Replay still works and a new live pause cancels its timer', h => {
    h.send({ type: 'sessionHistory', state: 'recording', count: 1, dropped: 0 });
    h.send({ type: 'debugPath', path: ['root', 'a'] });
    h.controls.replay.click();
    assert.deepEqual(h.current(), []);
    h.advance(500);
    assert.deepEqual(h.current(), ['root']);
    h.send({ type: 'debugPath', path: ['b', 't'] });
    h.advance(5000);
    assert.deepEqual(h.current(), ['t']);
    assert.equal(h.pending(), 0);
  }],
  ['disposing the webview cancels pending replay timers', h => {
    h.send({ type: 'sessionHistory', state: 'ended', steps: pauses, dropped: 0 });
    h.controls.replay.click();
    h.advance(500);
    h.dispose();
    assert.equal(h.pending(), 0);
  }],
];

export const sessionReplayCases: [string, (cy: Core, renderer: GraphRenderer) => void][] = tests.map(([name, test]) => [
  name, (cy, renderer) => {
    const h = harness(cy, renderer);
    try { test(h, cy, renderer); }
    finally { h.dispose(); }
  },
]);
