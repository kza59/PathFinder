import * as assert from 'node:assert/strict';
import cytoscape, { type Core } from 'cytoscape';
import { GraphRenderer, graphStyles } from './graph';
import type { GraphData } from '../src/types';

const fixture: GraphData = {
  targetIds: ['t'],
  nodes: ['root', 'a', 'b', 't', 'other'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
  edges: [['root', 'a'], ['a', 't'], ['b', 't'], ['a', 'b'], ['t', 't']]
    .map(([from, to]) => ({ from, to, lines: [1] })),
};
const edge = (cy: Core, from: string, to: string) => cy.edges().filter(e => e.source().id() === from && e.target().id() === to);

const cases: [string, (cy: Core, renderer: GraphRenderer) => void][] = [
  ['target marker and longest-path rows are rendered without distance labels', (cy, renderer) => {
    assert.equal(cy.$id('t').hasClass('target'), true);
    assert.equal(cy.$id('t').style('label'), 't\nTarget');
    assert.ok(cy.$id('a').position('y') < cy.$id('b').position('y'));
    assert.equal(edge(cy, 'a', 't').hasClass('detour'), true);
    assert.equal(edge(cy, 'a', 't').style('curve-style'), 'unbundled-bezier');
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

let failed = 0;
for (const [name, run] of cases) {
  const cy = cytoscape({ headless: true, styleEnabled: true, style: graphStyles(), layout: { name: 'preset' } });
  try {
    const renderer = new GraphRenderer(cy);
    renderer.renderGraph(fixture);
    run(cy, renderer);
    console.log(`  PASS  ${name}`);
  } catch (error) { failed++; console.error(`  FAIL  ${name}`, error); }
  finally { cy.destroy(); }
}
console.log(`\n${cases.length - failed}/${cases.length} renderer tests passed`);
process.exitCode = failed ? 1 : 0;
