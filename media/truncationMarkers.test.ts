import * as assert from 'node:assert/strict';
import type { Core } from 'cytoscape';
import type { ExpandCallersMessage, PreviewCallersMessage, GraphData } from '../src/types';
import type { GraphRenderer } from './graph';
import { TruncationMarkers } from './truncationMarkers';
import { CASES } from '../src/test/cases';

// Only the DOM boundary is replaced; the overlay runs against real Cytoscape nodes and events.
class Button {
  type = '';
  className = '';
  textContent = '';
  title = '';
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private click!: (event: { stopPropagation(): void }) => void;
  constructor(private readonly children: Button[]) {}
  addEventListener(type: string, listener: typeof this.click): void {
    assert.equal(type, 'click');
    this.click = listener;
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  remove(): void {
    const index = this.children.indexOf(this);
    if (index >= 0) this.children.splice(index, 1);
  }
  activate(): void {
    let stopped = false;
    this.click({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
  }
}

function withMarkers(cy: Core, run: (f: {
  buttons: Button[]; messages: (ExpandCallersMessage | PreviewCallersMessage)[]; flush(): void; pending(): number;
  markers: TruncationMarkers; hidden(): boolean;
}) => void): void {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = frame => { frames.delete(frame); };
  const buttons: Button[] = [];
  const messages: (ExpandCallersMessage | PreviewCallersMessage)[] = [];
  const host = {
    hidden: true,
    ownerDocument: { createElement: (tag: string) => { assert.equal(tag, 'button'); return new Button(buttons); } },
    appendChild: (button: Button) => { buttons.push(button); },
  };
  const markers = new TruncationMarkers(cy, host as unknown as HTMLElement, message => messages.push(message));
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  try { run({ buttons, messages, flush, pending: () => frames.size, markers, hidden: () => host.hidden }); }
  finally {
    markers.dispose();
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
}

export const truncationMarkerCases: [string, (cy: Core, renderer: GraphRenderer) => void][] = [
  ['truncation: eligibility uses hiddenCallers while +N uses the previewed expansion size', (cy, renderer) => {
    const counts = [undefined, 0, -1, 1.5, NaN, Infinity, 3, 1];
    renderer.renderGraph({
      nodes: counts.map((hiddenCallers, i) => ({
        id: `n${i}`, label: `function${i}`, file: 'a.py', line: 1, endLine: 2, hiddenCallers,
      })), edges: [],
    });
    withMarkers(cy, f => {
      f.markers.setPreviews({ n6: { state: 'ready', addedNodes: 8, addedNoiseNodes: 0 },
        n7: { state: 'ready', addedNodes: 1, addedNoiseNodes: 0 } });
      f.flush();
      assert.deepEqual(f.buttons.map(button => button.textContent), ['+8', '+1']);
      assert.equal(f.buttons[0].attributes['aria-label'], 'Show 8 more functions above function6');
      assert.equal(f.buttons[1].title, 'Show 1 more function above function7');
      assert.equal(f.buttons[0].type, 'button');
      assert.equal(f.hidden(), false);
      assert.equal(cy.nodes().length, counts.length);
      assert.equal(cy.edges().length, 0);
    });
  }],
  ['truncation: activation sends only expandCallers with the original ID and ignores stale controls', (cy, renderer) => {
    const id = 'C:\\project with spaces\\chain.py::Class.target[0]';
    const graph: GraphData = {
      nodes: [{ id, label: 'target', file: 'chain.py', line: 1, endLine: 2, hiddenCallers: 3 }], edges: [],
    };
    renderer.renderGraph(graph);
    withMarkers(cy, f => {
      f.markers.setPreviews({ [id]: { state: 'ready', addedNodes: 8, addedNoiseNodes: 0 } });
      f.flush();
      const button = f.buttons[0];
      button.activate();
      assert.deepEqual(f.messages, [{ type: 'expandCallers', id }]);
      renderer.renderGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, hiddenCallers: undefined })) });
      button.activate(); // Before the scheduled DOM reconciliation.
      assert.equal(f.messages.length, 1);
      f.flush();
      assert.equal(f.buttons.length, 0);
      assert.equal(f.hidden(), true);
      renderer.renderGraph({ nodes: [], edges: [] });
      button.activate();
      assert.equal(f.messages.length, 1);
    });
  }],
  ['truncation: markers follow pan, zoom, node movement and resize without replacing buttons', (cy, renderer) => {
    renderer.renderGraph({
      nodes: [{ id: 'a', label: 'a', file: 'a.py', line: 1, endLine: 2, hiddenCallers: 1 }], edges: [],
    });
    withMarkers(cy, f => {
      f.markers.setPreviews({ a: { state: 'ready', addedNodes: 8, addedNoiseNodes: 0 } });
      f.flush();
      const button = f.buttons[0];
      const before = { ...button.style };
      cy.zoom(1.5); cy.pan({ x: 50, y: 30 }); cy.$id('a').position({ x: 80, y: 100 }); cy.emit('resize');
      assert.equal(f.pending(), 1);
      f.flush();
      const node = cy.$id('a');
      assert.equal(button.style.left, `${node.renderedPosition().x + node.renderedOuterWidth() / 2}px`);
      assert.equal(button.style.top, `${node.renderedPosition().y - node.renderedOuterHeight() / 2}px`);
      assert.notDeepEqual(button.style, before);
      assert.equal(f.buttons[0], button);
      node.data('hiddenCallers', 5);
      f.flush();
      assert.equal(button.textContent, '+8'); // Direct caller count is not the next expansion size.
      f.markers.setPreviews({ a: { state: 'ready', addedNodes: 6, addedNoiseNodes: 1 } });
      f.flush(); assert.equal(button.textContent, '+5');
      assert.equal(f.buttons[0], button);
    });
  }],
  ['truncation: noise visibility hides markers and blocks clicks until shown again', (cy, renderer) => {
    renderer.renderGraph({
      nodes: [{ id: 'noise', label: 'noise', file: 'a.py', line: 1, endLine: 2, hiddenCallers: 2, noise: true }], edges: [],
    });
    withMarkers(cy, f => {
      f.markers.setPreviews({ noise: { state: 'ready', addedNodes: 2, addedNoiseNodes: 0 } });
      f.flush(); assert.equal(f.buttons.length, 0);
      renderer.setShowNoise(true);
      f.flush(); assert.equal(f.buttons.length, 1);
      const button = f.buttons[0];
      renderer.setShowNoise(false);
      button.activate(); assert.equal(f.messages.length, 0);
      f.flush(); assert.equal(f.buttons.length, 0);
      renderer.setShowNoise(true);
      f.flush(); f.buttons[0].activate();
      assert.deepEqual(f.messages, [{ type: 'expandCallers', id: 'noise' }]);
    });
  }],
  ['truncation: test8 previews +8 then +5 (+6 with noise) and removes completed markers', (cy, renderer) => {
    withMarkers(cy, f => {
      for (const [index, expected] of CASES.test8.entries()) {
        renderer.renderGraph({
          targetIds: ['chain.py::target'],
          nodes: expected.nodes.map(id => ({
            id, label: id.split('::')[1], file: id.split('::')[0], line: 1, endLine: 2,
            hiddenCallers: expected.hiddenCallers?.[id], chokepoint: expected.chokepoints?.includes(id),
            noise: id.endsWith('::<module>'),
          })),
          edges: expected.edges.map(([from, to, lines]) => ({ from, to, lines })),
        });
        f.markers.setPreviews(index === 2 ? {} : {
          [`chain.py::level${index === 0 ? 8 : 16}`]: {
            state: 'ready', addedNodes: index === 0 ? 8 : 6, addedNoiseNodes: index === 0 ? 0 : 1,
          },
        });
        f.flush();
        assert.deepEqual(f.buttons.map(button => [button.dataset.nodeId, button.textContent]),
          index === 2 ? [] : [[`chain.py::level${index === 0 ? 8 : 16}`, index === 0 ? '+8' : '+5']]);
        if (index === 1) {
          f.markers.setShowNoise(true); f.flush(); assert.equal(f.buttons[0].textContent, '+6');
          f.markers.setShowNoise(false); f.flush(); assert.equal(f.buttons[0].textContent, '+5');
        }
        assert.equal(cy.nodes().length, expected.nodes.length);
        assert.equal(cy.nodes('.target').first().id(), 'chain.py::target');
      }
    });
  }],
  ['truncation: loading has no guessed count, errors retry previews, and replacement clears old counts', (cy, renderer) => {
    renderer.renderGraph({
      nodes: [{ id: 'a', label: 'a', file: 'a.py', line: 1, endLine: 2, hiddenCallers: 1 }], edges: [],
    });
    withMarkers(cy, f => {
      f.flush(); const button = f.buttons[0];
      assert.equal(button.textContent, '…'); assert.equal(button.disabled, true);
      button.activate(); assert.equal(f.messages.length, 0);
      f.markers.setPreviews({ a: { state: 'error' } }); f.flush();
      assert.equal(button.textContent, 'Retry'); assert.equal(button.disabled, false);
      button.activate(); assert.deepEqual(f.messages, [{ type: 'previewCallers', id: 'a' }]);
      f.markers.setPreviews({ a: { state: 'ready', addedNodes: 0, addedNoiseNodes: 0 } }); f.flush();
      assert.equal(button.textContent, '+0'); assert.equal(button.disabled, false);
      button.activate(); assert.equal(f.messages[1].type, 'expandCallers');
      f.markers.setPreviews({}); // The graph-message handler clears previews before rendering a new graph.
      button.activate(); assert.equal(f.messages.length, 2);
      f.flush(); assert.equal(button.textContent, '…'); assert.equal(button.disabled, true);
      assert.equal(f.buttons[0], button);
    });
  }],
  ['truncation: disposal cancels scheduled work and removes controls and listeners', (cy, renderer) => {
    renderer.renderGraph({
      nodes: [{ id: 'a', label: 'a', file: 'a.py', line: 1, endLine: 2, hiddenCallers: 1 }], edges: [],
    });
    withMarkers(cy, f => {
      f.flush();
      const button = f.buttons[0];
      cy.pan({ x: 1, y: 2 }); assert.equal(f.pending(), 1);
      f.markers.dispose();
      assert.equal(f.pending(), 0); assert.equal(f.buttons.length, 0); assert.equal(f.hidden(), true);
      button.activate(); assert.equal(f.messages.length, 0);
      cy.pan({ x: 5, y: 6 }); assert.equal(f.pending(), 0);
      f.markers.dispose();
    });
  }],
];
