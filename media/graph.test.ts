import * as assert from 'node:assert/strict';
import cytoscape, { type Core } from 'cytoscape';
import { advanceAnimationFrames, pendingAnimationFrames } from './animationFrames.test';
import { GraphRenderer, graphStyles } from './graph';
import type { GraphData } from '../src/types';
import { largeSearchGraph } from '../src/test/mockdata';

const fixture: GraphData = {
  targetIds: ['t'],
  nodes: ['root', 'a', 'b', 't', 'other'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
  edges: [['root', 'a'], ['a', 't'], ['b', 't'], ['a', 'b'], ['t', 't']]
    .map(([from, to]) => ({ from, to, lines: [1] })),
};
const edge = (cy: Core, from: string, to: string) => cy.edges().filter(e => e.source().id() === from && e.target().id() === to);

const cases: [string, (cy: Core, renderer: GraphRenderer) => void | Promise<void>][] = [
  ['search ranks exact names before partial names, ignores case, and cycles distinct duplicate IDs both ways', (cy, renderer) => {
    const ids = ['C:/one.py::summary', 'C:/two.py::sum', 'C:/three.py::sum', 'C:/four.py::Consumer.sum'];
    renderer.renderGraph({
      nodes: ids.map((id, index) => ({ id, label: ['summary', 'Sum', 'sum', 'Consumer.sum'][index], file: id.split('::')[0], line: index + 1, endLine: 10 })),
      edges: [],
    });
    const first = renderer.search.find('  SUM  ');
    assert.equal(first.count, 4);
    assert.equal(first.index, 0);
    assert.equal(first.node?.id, ids[1]);
    assert.equal(renderer.search.move(1).node?.id, ids[2]);
    assert.equal(renderer.search.move(1).node?.id, ids[0]);
    assert.equal(renderer.search.move(1).node?.id, ids[3]);
    assert.equal(renderer.search.move(1).node?.id, ids[1]);
    assert.equal(renderer.search.move(-1).node?.id, ids[3]);
    assert.equal(cy.nodes('.search-hit').length, 1);
    assert.equal(renderer.search.find('CONSUMER.SUM').node?.id, ids[3]);
    assert.equal(renderer.search.find('onsumer').node?.id, ids[3]);
  }],
  ['empty, whitespace, and unmatched searches leave viewport and runtime styling unchanged', (cy, renderer) => {
    renderer.highlightPath(['root', 'a', 't']);
    cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
    const pan = { ...cy.pan() };
    const before = cy.elements().map(e => ({ id: e.id(), classes: e.classes() }));
    for (const query of ['', '  ', 'missing']) {
      const state = renderer.search.find(query);
      assert.equal(state.count, 0);
      assert.equal(state.index, -1);
      assert.equal(state.node, undefined);
      renderer.search.move(1); renderer.search.move(-1);
      assert.deepEqual(cy.pan(), pan);
      assert.equal(cy.zoom(), 1.2);
      assert.deepEqual(cy.elements().map(e => ({ id: e.id(), classes: e.classes() })), before);
    }
  }],
  ['search and result cycling highlight fully visible nodes without changing the viewport', (cy, renderer) => {
    // Give the headless graph a realistic viewport for visibility checks.
    cy.width = () => 1000;
    cy.height = () => 600;
    renderer.renderGraph({
      ...fixture,
      nodes: fixture.nodes.map(node => ['a', 'b'].includes(node.id) ? { ...node, label: 'match' } : node),
    });
    cy.$id('a').position({ x: 200, y: 200 });
    cy.$id('b').position({ x: 400, y: 200 });
    renderer.highlightPath(['root', 'a', 't']);
    cy.zoom(1.2); cy.pan({ x: 20, y: 30 });
    const pan = { ...cy.pan() };
    const events: string[] = [];
    cy.on('viewport', event => events.push(event.type));
    assert.equal(renderer.search.find('MATCH').node?.id, 'a');
    assert.equal(renderer.search.move(1).node?.id, 'b');
    assert.equal(renderer.search.move(-1).node?.id, 'a');
    renderer.search.find('mat');
    assert.deepEqual(cy.pan(), pan);
    assert.equal(cy.zoom(), 1.2);
    assert.deepEqual(events, []);
    assert.equal(cy.$id('a').hasClass('search-hit'), true);
    assert.equal(cy.$id('a').hasClass('path'), true);
    assert.equal(cy.$id('t').hasClass('current'), true);
  }],
  ['search centers clipped nodes at every viewport edge even when their centers are visible', (cy, renderer) => {
    cy.width = () => 1000;
    cy.height = () => 600;
    cy.zoom(1.2);
    const node = cy.$id('a');
    for (const rendered of [{ x: 5, y: 300 }, { x: 995, y: 300 }, { x: 500, y: 5 }, { x: 500, y: 595 }]) {
      renderer.search.clear();
      cy.pan({ x: rendered.x - node.position('x') * cy.zoom(), y: rendered.y - node.position('y') * cy.zoom() });
      assert.ok(node.renderedPosition().x > 0 && node.renderedPosition().x < cy.width());
      assert.ok(node.renderedPosition().y > 0 && node.renderedPosition().y < cy.height());
      renderer.search.find('a');
      assert.ok(Math.abs(node.renderedPosition().x - 500) < 0.001);
      assert.ok(Math.abs(node.renderedPosition().y - 300) < 0.001);
      assert.equal(cy.zoom(), 1.2);
    }
  }],
  ['search centers an off-screen node in a large graph without layout, rebuilding, or moving nodes', (cy, renderer) => {
    renderer.renderGraph(largeSearchGraph);
    cy.zoom(1); cy.pan({ x: 10000, y: 10000 });
    const nodes = cy.nodes().toArray();
    const positions = nodes.map(node => ({ id: node.id(), ...node.position() }));
    const distant = nodes.find(node => node.data('label') === 'distantFunction')!;
    const initial = distant.renderedPosition();
    assert.ok(initial.x < 0 || initial.x > cy.width() || initial.y < 0 || initial.y > cy.height());
    const events: string[] = [];
    cy.on('layoutstart add remove position', event => events.push(event.type));
    const state = renderer.search.find('DISTANTFUNCTION');
    assert.equal(state.node?.id, distant.id());
    const rendered = distant.renderedPosition();
    assert.ok(Math.abs(rendered.x - cy.width() / 2) < 0.001);
    assert.ok(Math.abs(rendered.y - cy.height() / 2) < 0.001);
    assert.equal(cy.zoom(), 1);
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    cy.nodes().forEach((node, index) => assert.equal(node, nodes[index]));
    assert.deepEqual(events, []);
  }],
  ['search in Explore uses current positions and keeps its running simulation', (cy, renderer) => {
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(10);
    const node = cy.$id('a');
    node.position({ x: 2000, y: 3000 });
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const frames = pendingAnimationFrames();
    let layouts = 0;
    cy.on('layoutstart layoutstop', () => layouts++);
    renderer.search.find('a');
    assert.equal(renderer.layoutMode, 'explore');
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.equal(layouts, 0);
    assert.equal(pendingAnimationFrames(), frames);
    assert.ok(frames > 0);
  }],
  ['temporary search highlight survives debug updates and restores the latest debug and hover appearance', async (cy, renderer) => {
    renderer.highlightPath(['root', 'a', 't']);
    renderer.hoverNode('a');
    const currentBorder = cy.$id('t').style('border-color');
    renderer.search.find('t');
    assert.equal(cy.$id('t').style('border-color'), currentBorder);
    renderer.search.find('other');
    const other = cy.$id('other');
    assert.equal(cy.$id('t').hasClass('search-hit'), false);
    assert.equal(other.hasClass('dimmed'), true);
    assert.equal(other.hasClass('hover-faded'), true);
    assert.equal(other.style('opacity'), '1');
    renderer.highlightPath(['b', 't']);
    assert.equal(other.hasClass('search-hit'), true);
    assert.equal(cy.$id('t').hasClass('current'), true);
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(other.hasClass('search-hit'), false);
    assert.equal(other.style('opacity'), '0.4');
    renderer.hoverNode();
    assert.equal(other.style('opacity'), '0.2');
    assert.equal(edge(cy, 'b', 't').hasClass('path'), true);
    assert.equal(edge(cy, 'root', 'a').hasClass('path'), false);
    renderer.search.find('t');
    renderer.clearDebugPath();
    assert.equal(cy.$id('t').hasClass('search-hit'), true);
    assert.equal(cy.$('.path, .current, .dimmed').length, 0);
    renderer.search.clear();
    assert.equal(cy.$('.search-hit').length, 0);
  }],
  ['replacement, failed searches, clearing, and disposal remove transient search state safely', (cy, renderer) => {
    renderer.search.find('a');
    renderer.search.find('missing');
    assert.equal(cy.$('.search-hit').length, 0);
    renderer.search.find('a');
    renderer.search.clear();
    assert.equal(cy.$('.search-hit').length, 0);
    renderer.search.find('a');
    renderer.renderGraph(fixture);
    assert.equal(renderer.search.move(1).count, 0);
    assert.equal(cy.$('.search-hit').length, 0);
    renderer.search.find('a');
    renderer.dispose();
    assert.equal(cy.$('.search-hit').length, 0);
    renderer.renderGraph({ nodes: [], edges: [] });
    assert.equal(renderer.search.find('a').count, 0);
  }],
  ['Trace disables dragging; Explore moves nodes and Trace restores exact positions and styling', (cy, renderer) => {
    assert.equal(renderer.layoutMode, 'trace');
    assert.equal(cy.autoungrabify(), true);
    assert.ok(cy.nodes().toArray().every(node => !node.grabbable()));
    renderer.highlightPath(['root', 'a', 't']);
    cy.$id('a').select();
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const appearance = () => cy.elements().map(element => ({
      id: element.id(), classes: element.classes(), selected: element.selected(),
      opacity: element.style('opacity'),
    }));
    const before = appearance();
    for (let round = 0; round < 2; round++) {
      cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
      const pan = { ...cy.pan() }; const zoom = cy.zoom();
      renderer.setLayoutMode('explore');
      assert.equal(renderer.layoutMode, 'explore');
      assert.equal(cy.autoungrabify(), false);
      assert.ok(cy.nodes().toArray().every(node => node.grabbable() && !node.locked()));
      advanceAnimationFrames(10);
      assert.ok(cy.nodes().toArray().every(node => Number.isFinite(node.position('x')) && Number.isFinite(node.position('y'))));
      assert.notDeepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
      assert.deepEqual(cy.pan(), pan); assert.equal(cy.zoom(), zoom);
      cy.$id('root').position({ x: 999, y: -123 });
      renderer.setLayoutMode('trace');
      advanceAnimationFrames(10);
      assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
      assert.ok(cy.nodes().toArray().every(node => !node.grabbable()));
      assert.deepEqual(appearance(), before);
      assert.equal(pendingAnimationFrames(), 0);
    }
  }],
  ['continuous Explore responds to dragging and disposal stops physics', (cy, renderer) => {
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(100);
    assert.ok(pendingAnimationFrames() > 0);
    const neighbor = cy.$id('a');
    const before = { ...neighbor.position() };
    const root = cy.$id('root');
    root.emit('grab');
    root.position({ x: 999, y: -123 });
    // Simulate Cytoscape holding the grabbed node while Cola moves its neighbors.
    root.lock();
    advanceAnimationFrames(20);
    assert.notDeepEqual(neighbor.position(), before);
    assert.deepEqual(root.position(), { x: 999, y: -123 });
    root.unlock(); root.emit('free');
    advanceAnimationFrames(10);
    renderer.dispose();
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    advanceAnimationFrames(10);
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.equal(pendingAnimationFrames(), 0);
  }],
  ['Explore unlocks entry points and Trace restores their original positions and locks', (cy, renderer) => {
    renderer.renderGraph({
      ...fixture,
      nodes: [...fixture.nodes, ...['main', '<module>'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 }))],
      edges: [...fixture.edges, { from: 'main', to: 't', lines: [] }, { from: '<module>', to: 'main', lines: [] }],
    });
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    renderer.setLayoutMode('explore');
    for (const id of ['main', '<module>']) {
      assert.equal(cy.$id(id).locked(), false);
      assert.equal(cy.$id(id).grabbable(), true);
      cy.$id(id).position({ x: 999, y: 999 });
    }
    renderer.setLayoutMode('trace');
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.equal(cy.$id('main').locked(), true);
    assert.equal(cy.$id('<module>').locked(), true);
    assert.equal(cy.$id('root').locked(), false);
  }],
  ['replacement graphs retain Explore and refresh the saved static positions, including empty and single-node graphs', (cy, renderer) => {
    renderer.setLayoutMode('explore');
    renderer.highlightPath(['root', 'a', 't']);
    renderer.renderGraph({ ...fixture, targetIds: ['root'] });
    advanceAnimationFrames(10);
    assert.equal(renderer.layoutMode, 'explore');
    assert.ok(cy.nodes().toArray().every(node => node.grabbable() && !node.locked()));
    assert.equal(cy.$id('t').hasClass('current'), true);
    renderer.setLayoutMode('trace');
    for (const node of cy.nodes()) {
      assert.deepEqual(node.position(), renderer.layout!.positions.get(node.id()));
    }
    renderer.setLayoutMode('explore');
    renderer.renderGraph({ nodes: [], edges: [], targetIds: [] });
    renderer.setLayoutMode('trace');
    renderer.setLayoutMode('explore');
    renderer.renderGraph({ nodes: [fixture.nodes[0]], edges: [], targetIds: ['root'] });
    assert.equal(cy.nodes().length, 1);
    renderer.setLayoutMode('trace');
    assert.deepEqual(cy.$id('root').position(), renderer.layout!.positions.get('root'));
  }],
  ['target marker and longest-path rows are rendered without distance labels', (cy, renderer) => {
    assert.equal(cy.$id('t').hasClass('target'), true);
    assert.equal(cy.$id('t').style('label'), 't\nTarget');
    assert.ok(cy.$id('a').position('y') < cy.$id('b').position('y'));
    assert.equal(edge(cy, 'a', 't').hasClass('detour'), true);
    assert.equal(edge(cy, 'a', 't').style('curve-style'), 'bezier');
    assert.equal(renderer.layout!.distances.get('a'), 2);
    assert.deepEqual(renderer.layout!.annotations.map(annotation => annotation.label), ['No path to target']);
  }],
  ['entry points occupy top rows and remain locked during hover and runtime updates', (cy, renderer) => {
    renderer.renderGraph({
      ...fixture,
      nodes: [...fixture.nodes, ...['main', '<module>'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 }))],
      edges: [...fixture.edges, { from: 'main', to: 't', lines: [] }, { from: '<module>', to: 'main', lines: [] }],
    });
    const module = cy.$id('<module>');
    const main = cy.$id('main');
    assert.equal(module.position('y'), 0);
    assert.ok(module.position('y') < main.position('y'));
    assert.ok(main.position('y') < cy.$id('root').position('y'));
    assert.equal(main.locked(), true);
    assert.equal(module.locked(), true);
    assert.equal(cy.$id('root').locked(), false);
    const before = { ...main.position() };
    main.position({ x: 999, y: 999 });
    renderer.hoverNode('main'); renderer.highlightPath(['main', 't']);
    assert.deepEqual(main.position(), before);
  }],
  ['hover exposes only immediate connections and distinguishes direction', (cy, renderer) => {
    renderer.hoverNode('a');
    assert.equal(cy.$id('a').hasClass('hovered'), true);
    assert.equal(edge(cy, 'root', 'a').hasClass('hover-in'), true);
    assert.equal(edge(cy, 'a', 'b').hasClass('hover-out'), true);
    assert.equal(edge(cy, 'b', 't').hasClass('hover-faded'), true);
    assert.equal(cy.$id('other').hasClass('hover-faded'), true);
    assert.equal(cy.$id('b').style('opacity'), '1');
    assert.ok(Number(edge(cy, 'a', 't').style('z-index')) > Number(edge(cy, 'b', 't').style('z-index')));
    assert.notEqual(edge(cy, 'root', 'a').style('line-color'), edge(cy, 'a', 'b').style('line-color'));
  }],
  ['hover never changes positions or viewport', (cy, renderer) => {
    cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const pan = { ...cy.pan() }; const zoom = cy.zoom();
    renderer.hoverNode('a'); renderer.hoverNode('b'); renderer.hoverNode();
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.deepEqual(cy.pan(), pan); assert.equal(cy.zoom(), zoom);
  }],
  ['dimmed connections become visible during hover and restore afterward', (cy, renderer) => {
    renderer.highlightPath(['root', 'a', 't']);
    const incoming = edge(cy, 'b', 't');
    assert.equal(incoming.style('opacity'), '0.2');
    renderer.hoverNode('t');
    assert.equal(incoming.hasClass('dimmed'), true);
    assert.equal(incoming.style('opacity'), '1');
    assert.equal(edge(cy, 'a', 't').style('line-color'), 'rgb(79,193,255)');
    assert.equal(cy.$id('t').style('label'), 't\nTarget\nYou are here');
    renderer.hoverNode();
    assert.equal(incoming.style('opacity'), '0.2');
    assert.equal(edge(cy, 'a', 't').style('width'), '4px');
    assert.equal(cy.$id('t').hasClass('current'), true);
  }],
  ['runtime updates during hover retain focus and restore the latest path', (cy, renderer) => {
    renderer.hoverNode('a');
    renderer.highlightPath(['b', 't']);
    assert.equal(cy.$id('a').hasClass('hovered'), true);
    assert.equal(edge(cy, 'a', 't').style('opacity'), '1');
    renderer.hoverNode();
    assert.equal(edge(cy, 'a', 't').style('opacity'), '0.2');
    assert.equal(edge(cy, 'b', 't').hasClass('path'), true);
    renderer.hoverNode('b'); renderer.clearDebugPath();
    assert.equal(cy.$id('b').hasClass('hovered'), true);
    assert.equal(cy.$('.path, .current').length, 0);
    renderer.hoverNode();
    assert.equal(cy.$('.dimmed, .hover-faded, .hovered').length, 0);
  }],
  ['self calls are highlighted without hiding the hovered function', (cy, renderer) => {
    renderer.hoverNode('t');
    const loop = edge(cy, 't', 't');
    assert.equal(loop.hasClass('hover-in'), true);
    assert.equal(loop.hasClass('hover-out'), true);
    assert.ok(Number(loop.style('control-point-step-size').replace('px', '')) >= 100);
    assert.equal(cy.$id('t').style('opacity'), '1');
  }],
  ['graph replacement clears hover and replays runtime state', (cy, renderer) => {
    renderer.highlightPath(['b', 't']); renderer.hoverNode('a'); renderer.renderGraph(fixture);
    assert.equal(cy.$('.hovered, .hover-faded, .hover-in, .hover-out').length, 0);
    assert.equal(cy.$id('t').hasClass('current'), true);
    renderer.renderGraph({ nodes: [], edges: [], targetIds: [] });
    assert.equal(cy.elements().length, 0);
    assert.deepEqual(renderer.layout!.annotations, []);
  }],
  ['unknown hover IDs clear focus; unknown runtime frames never create shortcuts', (cy, renderer) => {
    renderer.hoverNode('a'); renderer.hoverNode('unknown');
    assert.equal(cy.$('.hovered, .hover-faded').length, 0);
    renderer.highlightPath(['root', 'missing', 'a', 'outside']);
    assert.equal(edge(cy, 'root', 'a').hasClass('path'), false);
    assert.equal(cy.$('.current').length, 0);
    assert.equal(cy.edges().length, fixture.edges.length);
  }],
];

async function main(): Promise<void> {
  let failed = 0;
  for (const [name, run] of cases) {
    const cy = cytoscape({ headless: true, styleEnabled: true, style: graphStyles(), layout: { name: 'preset' } });
    const renderer = new GraphRenderer(cy);
    try {
      renderer.renderGraph(fixture);
      await run(cy, renderer);
      console.log(`  PASS  ${name}`);
    } catch (error) { failed++; console.error(`  FAIL  ${name}`, error); }
    finally { renderer.dispose(); cy.destroy(); advanceAnimationFrames(2); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} renderer tests passed`);
  process.exitCode = failed ? 1 : 0;
}
void main();
