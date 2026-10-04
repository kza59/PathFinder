import * as assert from 'node:assert/strict';
import type { Core } from 'cytoscape';
import type { GraphRenderer } from './graph';
import type { GraphData, HistoryStep } from '../src/types';
import { PathNavigation } from './pathNavigation';

const graph: GraphData = {
  targetIds: ['t'], nodes: ['root', 'a', 'b', 't'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
  edges: [['root', 'a'], ['root', 'b'], ['a', 't'], ['b', 't']].map(([from, to]) => ({ from, to, lines: [1] })),
};
const steps: HistoryStep[] = [['root', 'a'], ['root', 'a', 't'], ['root', 'b', 't']]
  .map((path, index) => ({ path, reason: 'step', time: index, session: 'Run' }));

function withNavigation(renderer: GraphRenderer, run: (navigation: PathNavigation, tick: () => void, pending: () => number) => void): void {
  const oldSet = globalThis.setTimeout;
  const oldClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let id = 0;
  globalThis.setTimeout = ((callback: () => void) => { timers.set(++id, callback); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: number) => timers.delete(timer)) as unknown as typeof clearTimeout;
  const navigation = new PathNavigation(state => {
    renderer.highlightPath(state.debugPath);
    if (state.mode === 'source' || state.frame) renderer.previewPath(state.frame ?? state.path);
  });
  renderer.renderGraph(graph);
  navigation.setGraph(graph, new Set(['t']), false);
  const tick = () => { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } };
  try { run(navigation, tick, () => timers.size); }
  finally { navigation.dispose(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; }
}

export const pathNavigationCases: [string, (cy: Core, renderer: GraphRenderer) => void][] = [
  ['Clear Highlights stops playback and retains live paths and recorded history for later navigation', (cy, renderer) => {
    withNavigation(renderer, (navigation, tick, pending) => {
      navigation.receive({ type: 'debugPath', path: ['root', 'a'] });
      navigation.move(1); navigation.toggleReplay();
      navigation.clearHighlights();
      assert.equal(pending(), 0);
      assert.equal(navigation.state.mode, 'overview');
      assert.equal(navigation.state.canReturn, true);
      assert.deepEqual(navigation.state.path, []);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      assert.equal(cy.$id('t').hasClass('target'), true);
      tick();
      navigation.receive({ type: 'sessionHistory', state: 'recording', count: 2, dropped: 0 });
      navigation.setGraph(graph, new Set(['t']), false);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      navigation.returnToDebug();
      assert.deepEqual(navigation.state.path, ['root', 'a']);
      assert.deepEqual(cy.nodes('.current').map(node => node.id()), ['a']);
      navigation.receive({ type: 'debugClear' });
      navigation.receive({ type: 'sessionHistory', state: 'ended', steps, dropped: 0 });
      navigation.toggleReplay(); tick();
      navigation.clearHighlights();
      assert.equal(navigation.state.label, '3 recorded steps');
      assert.equal(navigation.state.canReplay, true);
      assert.equal(pending(), 0);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      navigation.returnToDebug();
      assert.equal(navigation.state.label, 'Step 3 of 3');
      navigation.clearHighlights();
      navigation.move(1);
      assert.equal(navigation.state.label, 'Step 1 of 3');
    });
  }],
  ['fresh panels show an unselected graph; source arrows select a path explicitly', (cy, renderer) => {
    withNavigation(renderer, navigation => {
      assert.equal(navigation.state.label, '2 paths');
      assert.equal(navigation.state.canReplay, false);
      assert.equal(navigation.state.canReturn, false);
      assert.deepEqual(navigation.state.path, []);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      assert.deepEqual(cy.nodes('.target').map(node => node.id()), ['t']);
      navigation.move(1);
      assert.equal(navigation.state.label, 'Path 1 of 2');
      assert.equal(navigation.state.canReplay, true);
      navigation.move(-1);
      assert.equal(navigation.state.label, 'Path 2 of 2');
      navigation.setGraph(graph, new Set(['t']), false);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
    });
  }],
  ['history arrows and Replay use the same recorded step and manual arrows stop playback', (cy, renderer) => {
    withNavigation(renderer, (navigation, tick, pending) => {
      navigation.receive({ type: 'sessionHistory', state: 'ended', steps, dropped: 0 });
      assert.equal(navigation.state.label, '3 recorded steps');
      assert.equal(navigation.state.canReplay, true);
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      navigation.move(1);
      assert.equal(navigation.state.label, 'Step 1 of 3');
      assert.deepEqual(cy.nodes('.current').map(node => node.id()), ['a']);
      navigation.toggleReplay(); tick();
      assert.equal(navigation.state.label, 'Step 2 of 3');
      assert.deepEqual(cy.nodes('.current').map(node => node.id()), ['t']);
      navigation.toggleReplay();
      assert.equal(navigation.state.label, 'Step 2 of 3');
      assert.equal(navigation.state.playing, false);
      assert.equal(pending(), 0);
      navigation.toggleReplay();
      navigation.move(-1);
      assert.equal(navigation.state.label, 'Step 1 of 3');
      assert.equal(navigation.state.playing, false);
      assert.equal(pending(), 0);
      navigation.toggleReplay(); tick(); tick(); tick();
      assert.equal(navigation.state.label, 'Step 3 of 3');
      assert.equal(navigation.state.playing, false);
      assert.deepEqual(navigation.state.path, steps[2].path);
      navigation.move(1);
      assert.equal(navigation.state.label, 'Step 1 of 3');
      navigation.returnToDebug();
      assert.equal(navigation.state.label, 'Step 3 of 3');
      navigation.toggleReplay();
      assert.equal(navigation.state.label, 'Step 1 of 3');
    });
  }],
  ['source replay follows the selected path, preserves the live marker, and cancels on path changes', (cy, renderer) => {
    withNavigation(renderer, (navigation, tick, pending) => {
      navigation.receive({ type: 'debugPath', path: ['root', 'a'] });
      navigation.move(-1);
      assert.equal(navigation.state.label, 'Path 2 of 2');
      navigation.toggleReplay();
      assert.deepEqual(navigation.state.frame, ['root']);
      assert.deepEqual(cy.nodes('.current').map(node => node.id()), ['a']);
      tick();
      assert.deepEqual(navigation.state.frame, ['root', 'b']);
      navigation.move(-1);
      assert.equal(pending(), 0);
      assert.equal(navigation.state.frame, undefined);
      assert.equal(navigation.state.label, 'Path 1 of 2');
      navigation.toggleReplay(); tick(); tick(); tick();
      assert.equal(navigation.state.playing, false);
      assert.equal(navigation.state.frame, undefined);
      assert.deepEqual(cy.nodes('.path').map(node => node.id()).sort(), ['a', 'root', 't']);
      navigation.returnToDebug();
      assert.equal(navigation.state.label, 'Debug path');
      assert.deepEqual(navigation.state.path, ['root', 'a']);
    });
  }],
  ['debug updates, clearing, a new recording and disposal cancel replay without stale timers', (cy, renderer) => {
    withNavigation(renderer, (navigation, tick, pending) => {
      navigation.move(1); navigation.toggleReplay();
      navigation.receive({ type: 'debugPath', path: ['root', 'b'] });
      assert.equal(pending(), 0);
      assert.equal(navigation.state.playing, false);
      assert.deepEqual(cy.nodes('.current').map(node => node.id()), ['b']);
      navigation.receive({ type: 'sessionHistory', state: 'ended', steps, dropped: 2 });
      navigation.toggleReplay();
      navigation.receive({ type: 'sessionHistory', state: 'recording', count: 1, dropped: 0 });
      assert.equal(navigation.state.hasHistory, false);
      assert.equal(navigation.state.label, 'Debug path');
      assert.equal(pending(), 0);
      navigation.receive({ type: 'debugClear' });
      assert.equal(navigation.state.label, '2 paths');
      assert.equal(cy.$('.path, .current, .dimmed').length, 0);
      navigation.move(1); navigation.toggleReplay(); navigation.dispose(); tick();
      assert.equal(pending(), 0);
      navigation.setGraph({ nodes: [], edges: [] }, new Set(), false);
      assert.equal(navigation.state.canMove, false);
      assert.equal(navigation.state.canReplay, false);
    });
  }],
];
