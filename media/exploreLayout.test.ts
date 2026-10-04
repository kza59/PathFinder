import * as assert from 'node:assert/strict';
import type { Core } from 'cytoscape';
import type { GraphRenderer } from './graph';
import type { GraphData } from '../src/types';
import { advanceAnimationFrames, pendingAnimationFrames } from './animationFrames.test';

type RendererCase = [string, (cy: Core, renderer: GraphRenderer) => void];
const nodes = (ids: string[]) => ids.map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 }));
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// Nine hidden branches supply real degree without adding forces to the two visible nodes.
const weightedPair = (): GraphData => ({
  nodes: [...nodes(['hub', 'leaf', 'isolated']), ...nodes(Array.from({ length: 9 }, (_, i) => `arm${i}`))
    .map(node => ({ ...node, noise: true }))],
  edges: [
    { from: 'leaf', to: 'hub', lines: [1, 2, 3] },
    ...Array.from({ length: 9 }, (_, i) => ({ from: 'hub', to: `arm${i}`, lines: [1] })),
    { from: 'hub', to: 'hub', lines: [1] },
    { from: 'isolated', to: 'isolated', lines: [1] },
    { from: 'hub', to: 'missing', lines: [1] },
  ],
});

function positionPair(cy: Core, renderer: GraphRenderer, separation: number): void {
  renderer.renderGraph(weightedPair());
  renderer.setLayoutMode('explore');
  cy.nodes().positions(node => node.id() === 'hub' ? { x: 0, y: 0 }
    : node.id() === 'leaf' ? { x: separation, y: 0 } : { x: 2000, y: 2000 });
}

export const exploreLayoutCases: RendererCase[] = [
  ['Explore weights count incoming and outgoing edges, excluding loops, missing nodes and extra call sites', (cy, renderer) => {
    positionPair(cy, renderer, 300);
    assert.equal(cy.$id('hub').data('exploreWeight'), 10);
    assert.equal(cy.$id('leaf').data('exploreWeight'), 1);
    assert.equal(cy.$id('isolated').data('exploreWeight'), 1);
    cy.nodes('[noise]').forEach(node => assert.equal(node.data('exploreWeight'), 1));
    renderer.setShowNoise(true);
    renderer.setShowNoise(false);
    assert.equal(cy.$id('hub').data('exploreWeight'), 10);
    renderer.renderGraph({ nodes: nodes(['hub', 'leaf', 'third']), edges: [
      { from: 'leaf', to: 'hub', lines: [] }, { from: 'hub', to: 'third', lines: [] },
    ] });
    assert.equal(cy.$id('hub').data('exploreWeight'), 2);
  }],
  ['Explore link adjustments move the leaf ten times farther than its hub in either edge direction', (cy, renderer) => {
    for (const reverse of [false, true]) {
      renderer.setLayoutMode('trace');
      const graph = weightedPair();
      if (reverse) graph.edges[0] = { ...graph.edges[0], from: 'hub', to: 'leaf' };
      renderer.renderGraph(graph);
      renderer.setLayoutMode('explore');
      cy.nodes().positions(node => node.id() === 'hub' ? { x: 0, y: 0 }
        : node.id() === 'leaf' ? { x: 300, y: 0 } : { x: 2000, y: 2000 });
      advanceAnimationFrames();
      const hubMovement = cy.$id('hub').position('x');
      const leafMovement = 300 - cy.$id('leaf').position('x');
      assert.ok(hubMovement > 0);
      assert.ok(Math.abs(leafMovement / hubMovement - 10) < 0.000001);
      assert.equal(cy.$id('isolated').position('x'), 2000);
    }
  }],
  ['Explore rectangle collisions also give the lighter node more movement and respect labels', (cy, renderer) => {
    positionPair(cy, renderer, 0);
    // Force a wide label box, even in the headless renderer.
    cy.$id('hub').layoutDimensions = () => ({ w: 600, h: 100 });
    cy.$id('leaf').layoutDimensions = () => ({ w: 300, h: 100 });
    advanceAnimationFrames();
    const hub = cy.$id('hub').position();
    const leaf = cy.$id('leaf').position();
    assert.ok(Math.abs(leaf.y - hub.y) >= 160);
    assert.ok(Math.abs(distance(leaf, { x: 0, y: 0 }) / distance(hub, { x: 0, y: 0 }) - 10) < 0.001);
    cy.nodes().positions(node => node.id() === 'hub' ? { x: 0, y: 0 }
      : node.id() === 'leaf' ? { x: 470, y: 0 } : { x: 2000, y: 2000 });
    advanceAnimationFrames(20);
    assert.ok(cy.$id('leaf').position('x') - cy.$id('hub').position('x') >= 510);
  }],
  ['Explore holds dragged hubs and leaves without removing their degree bias', (cy, renderer) => {
    positionPair(cy, renderer, 300);
    const leaf = cy.$id('leaf');
    leaf.emit('grab');
    leaf.position({ x: 320, y: 0 });
    advanceAnimationFrames();
    const pulledHub = cy.$id('hub').position('x');
    assert.deepEqual(leaf.position(), { x: 320, y: 0 });
    assert.ok(pulledHub > 0 && pulledHub < 2);
    leaf.emit('free');

    cy.nodes().positions(node => node.id() === 'hub' ? { x: 0, y: 0 }
      : node.id() === 'leaf' ? { x: 300, y: 0 } : { x: 2000, y: 2000 });
    const hub = cy.$id('hub');
    hub.emit('grab');
    hub.position({ x: -20, y: 0 });
    advanceAnimationFrames();
    const pulledLeaf = 300 - leaf.position('x');
    assert.deepEqual(hub.position(), { x: -20, y: 0 });
    assert.ok(Math.abs(pulledLeaf / pulledHub - 10) < 0.000001);
    hub.emit('free');
    advanceAnimationFrames();
    assert.notEqual(hub.position('x'), -20);
  }],
  ['dragging an Explore hub moves its branches more than dragging a single leaf', (cy, renderer) => {
    const graph: GraphData = { nodes: nodes(['hub', 'east', 'west', 'north', 'south']), edges: [
      ...['east', 'west', 'north', 'south'].map(to => ({ from: 'hub', to, lines: [] })),
    ] };
    const original: Record<string, { x: number; y: number }> = {
      hub: { x: 0, y: 0 }, east: { x: 100, y: 0 }, west: { x: -100, y: 0 },
      north: { x: 0, y: -100 }, south: { x: 0, y: 100 },
    };
    const drag = (id: string) => {
      renderer.setLayoutMode('trace');
      renderer.renderGraph(graph);
      cy.nodes().style({ width: 20, height: 20, label: '' });
      renderer.setLayoutMode('explore');
      cy.nodes().positions(node => original[node.id()]);
      cy.$id(id).emit('grab').position({ x: original[id].x + 20, y: original[id].y });
      advanceAnimationFrames(10);
      const movement = cy.nodes().toArray().filter(node => node.id() !== id)
        .map(node => distance(node.position(), original[node.id()])).reduce((a, b) => a + b, 0);
      assert.deepEqual(cy.$id(id).position(), { x: original[id].x + 20, y: original[id].y });
      cy.$id(id).emit('free');
      return movement;
    };
    const hubMovement = drag('hub');
    const leafMovement = drag('east');
    assert.ok(hubMovement > leafMovement * 3, `${hubMovement} vs ${leafMovement}`);
  }],
  ['Explore hidden nodes exert no forces, retain their weights, and resume safely when shown', (cy, renderer) => {
    positionPair(cy, renderer, 300);
    const hidden = cy.$id('arm0');
    hidden.emit('grab').position({ x: 0, y: 0 });
    advanceAnimationFrames();
    assert.ok(Math.abs(cy.$id('hub').position('y')) < 0.000001);
    assert.deepEqual(hidden.position(), { x: 0, y: 0 });
    hidden.emit('free');
    renderer.setShowNoise(true);
    advanceAnimationFrames(20);
    assert.ok(cy.nodes().toArray().every(node => Number.isFinite(node.position('x')) && Number.isFinite(node.position('y'))));
    assert.notDeepEqual(hidden.position(), { x: 0, y: 0 });
    assert.equal(cy.$id('hub').data('exploreWeight'), 10);
  }],
  ['Explore handles chains, connected hubs and disconnected components without moving the viewport', (cy, renderer) => {
    const graph: GraphData = { nodes: nodes(['left', 'right', 'a', 'b', 'c', 'd', 'e', 'isolated']), edges: [
      ...[['left', 'right'], ['left', 'a'], ['left', 'b'], ['right', 'c'], ['right', 'd'], ['d', 'e']]
        .map(([from, to]) => ({ from, to, lines: [] })),
    ] };
    renderer.renderGraph(graph);
    const trace = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    cy.zoom(1.3); cy.pan({ x: 71, y: -43 });
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(200);
    cy.$id('left').emit('grab').position({ x: 2000, y: -300 });
    advanceAnimationFrames(50);
    assert.deepEqual(cy.$id('left').position(), { x: 2000, y: -300 });
    cy.$id('left').emit('free');
    advanceAnimationFrames(100);
    assert.ok(cy.nodes().toArray().every(node => Number.isFinite(node.position('x')) && Number.isFinite(node.position('y'))));
    assert.deepEqual(cy.pan(), { x: 71, y: -43 });
    assert.equal(cy.zoom(), 1.3);
    renderer.setLayoutMode('trace');
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), trace);
    advanceAnimationFrames(2);
    assert.equal(pendingAnimationFrames(), 0);
  }],
  ['destroying Cytoscape stops Explore and leaves no animation work', (cy, renderer) => {
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(10);
    assert.ok(pendingAnimationFrames() > 0);
    cy.destroy();
    advanceAnimationFrames(2);
    assert.equal(pendingAnimationFrames(), 0);
  }],
];
