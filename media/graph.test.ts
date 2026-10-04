import * as assert from 'node:assert/strict';
import cytoscape, { type Core } from 'cytoscape';
import { advanceAnimationFrames, pendingAnimationFrames } from './animationFrames.test';
import { GraphRenderer, graphStyles } from './graph';
import { heatColor, heatPalette, type HeatRange } from './heatmap';
import type { GraphData, HotCounts } from '../src/types';
import { largeSearchGraph } from '../src/test/mockdata';
import { CASES } from '../src/test/cases';
import { DEBUG_CASES } from '../src/test/debugCases';
import { markRecursion } from '../src/recursion';
import { recursionAnnouncement, recursionColor, recursionOutlines } from './recursion';
import { truncationMarkerCases } from './truncationMarkers.test';

const fixture: GraphData = {
  targetIds: ['t'],
  nodes: ['root', 'a', 'b', 't', 'other'].map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
  edges: [['root', 'a'], ['a', 't'], ['b', 't'], ['a', 'b'], ['t', 't']]
    .map(([from, to]) => ({ from, to, lines: [1] })),
};
const edge = (cy: Core, from: string, to: string) => cy.edges().filter(e => e.source().id() === from && e.target().id() === to);
const noiseFixture: GraphData = {
  ...fixture,
  nodes: fixture.nodes.map(node => ({ ...node, noise: node.id === 'a' })),
  edges: [...fixture.edges, { from: 'b', to: 'a', lines: [1] }, { from: 'a', to: 'a', lines: [1] }],
};

const cases: [string, (cy: Core, renderer: GraphRenderer) => void | Promise<void>][] = [
  ...truncationMarkerCases,
  ...['test5/python', 'test5/c'].map(fixtureName => [
    `${fixtureName}: direct, mutual and three-function recursion display and live depth`,
    (cy: Core, renderer: GraphRenderer) => {
      const expected = CASES[fixtureName].find(c => c.name.includes('all three shapes'))!;
      const graph = markRecursion({
        targetIds: [expected.nodes[0]],
        nodes: expected.nodes.map(id => ({ id, label: id.split('::')[1], file: id.split('::')[0], line: 1, endLine: 2 })),
        edges: expected.edges.map(([from, to, lines]) => ({ from, to, lines })),
      });
      renderer.renderGraph(graph);
      assert.deepEqual(recursionOutlines(cy).map(outline => outline.members.sort()).sort(),
        expected.recursionGroups!.map(group => [...group].sort()).sort());
      assert.equal(cy.nodes().length, graph.nodes.length);
      assert.equal(cy.edges().length, graph.edges.length);
      for (const node of graph.nodes) {
        assert.equal(cy.$id(node.id).hasClass('recursion-member'), node.recursionGroup !== undefined);
        assert.equal(cy.$id(node.id).style('outline-width'), node.recursionGroup === undefined ? '0px' : '2px');
      }
      for (const item of graph.edges) {
        const rendered = edge(cy, item.from, item.to);
        assert.equal(rendered.hasClass('recursive'), item.recursive === true);
        if (item.recursive) assert.equal(rendered.style('line-style'), 'dashed');
      }
      for (const [index, path] of DEBUG_CASES[fixtureName][0].stops.entries()) {
        renderer.highlightPath(path);
        assert.equal(renderer.recursionLevels.length, 1);
        assert.equal(renderer.recursionLevels[0].depth, [3, 3, 6][index]);
        assert.equal(recursionAnnouncement(renderer.recursionLevels), ['TRIPLE RECURSION!', 'TRIPLE RECURSION!', 'ULTRA RECURSION!'][index]);
        const recursiveCalls = cy.edges('.recursive.path');
        assert.ok(recursiveCalls.length > 0);
        recursiveCalls.forEach(call => {
          assert.equal(call.style('line-style'), 'dashed');
          assert.equal(call.style('line-color'), 'rgb(79,193,255)');
        });
        renderer.hoverNode(path[1]);
        recursiveCalls.forEach(call => assert.equal(call.style('line-style'), 'dashed'));
        renderer.hoverNode();
      }
      renderer.clearDebugPath();
      assert.deepEqual(renderer.recursionLevels, []);
      assert.equal(recursionAnnouncement(renderer.recursionLevels), '');
      assert.equal(recursionOutlines(cy).length, 3);
      renderer.renderGraph(fixture);
      assert.equal(recursionOutlines(cy).length, 0);
      assert.equal(cy.$('.recursion-member, .recursive').length, 0);
    },
  ] as [string, (cy: Core, renderer: GraphRenderer) => void]),
  ['recursion enclosures follow node positions and noise visibility without adding graph elements', (cy, renderer) => {
    renderer.renderGraph(markRecursion({
      ...noiseFixture, nodes: noiseFixture.nodes.map(node => ({ ...node })),
      edges: noiseFixture.edges.map(item => ({ ...item })),
    }));
    const first = recursionOutlines(cy);
    assert.equal(first.length, 2);
    const mutual = first.find(outline => outline.members.includes('b'))!;
    assert.deepEqual(mutual.members, ['b']);
    renderer.setShowNoise(true);
    const visible = recursionOutlines(cy).find(outline => outline.group === mutual.group)!;
    assert.deepEqual(visible.members.sort(), ['a', 'b']);
    cy.$id('b').unlock().position({ x: 2000, y: 2000 });
    const moved = recursionOutlines(cy).find(outline => outline.group === mutual.group)!;
    assert.ok(moved.width > visible.width);
    assert.ok(moved.height > visible.height);
    for (const id of ['a', 'b']) {
      const pos = cy.$id(id).position();
      assert.ok(pos.x > moved.x && pos.x < moved.x + moved.width);
      assert.ok(pos.y > moved.y && pos.y < moved.y + moved.height);
      assert.equal(cy.$id(id).style('outline-color'), cy.$id('a').style('outline-color'));
    }
    renderer.setShowNoise(false);
    assert.deepEqual(recursionOutlines(cy).find(outline => outline.group === mutual.group)!.members, ['b']);
    assert.equal(cy.nodes().length, noiseFixture.nodes.length);
    assert.notEqual(recursionColor(1), recursionColor(2));
  }],
  ['banner updates only for repeated recursive frames and recomputes on graph replacement', (cy) => {
    const announcements: string[] = [];
    const renderer = new GraphRenderer(cy, undefined, undefined, undefined, undefined, undefined,
      levels => announcements.push(recursionAnnouncement(levels)));
    try {
      const graph = markRecursion({
        ...fixture, nodes: fixture.nodes.map(node => ({ ...node })),
        edges: fixture.edges.map(item => ({ ...item })),
      });
      renderer.highlightPath(['root', 'a', 't', 't', 't']);
      assert.equal(announcements.at(-1), '');
      renderer.renderGraph(graph);
      assert.equal(announcements.at(-1), 'DOUBLE RECURSION!');
      renderer.highlightPath(['t']); assert.equal(announcements.at(-1), '');
      renderer.highlightPath(['root', 'root']); assert.equal(announcements.at(-1), '');
      renderer.highlightPath(Array(11).fill('t')); assert.equal(announcements.at(-1), 'MONSTER RECURSION!');
      renderer.highlightPath(['t', 'outside', 't']); assert.equal(announcements.at(-1), 'RECURSION!');
      renderer.renderGraph(fixture); assert.equal(announcements.at(-1), '');
      renderer.clearDebugPath(); assert.equal(announcements.at(-1), '');
    } finally { renderer.dispose(); }
  }],
  ['recursive false leaves the edge without recursion styling', (cy, renderer) => {
    renderer.renderGraph({ ...fixture, edges: fixture.edges.map(item => ({ ...item, recursive: false })) });
    assert.equal(cy.edges('.recursive').length, 0);
  }],
  ['chokepoint markers require true and compose with target, debug, heat and argument styles', (cy, renderer) => {
    const graph: GraphData = {
      ...fixture,
      nodes: fixture.nodes.map(node => ({ ...node, ...(['a', 't'].includes(node.id)
        ? { chokepoint: true } : node.id === 'b' ? { chokepoint: false } : {}) })),
    };
    renderer.renderGraph(graph);
    assert.equal(renderer.visibleChokepointCount, 2);
    assert.equal(cy.$id('a').style('label'), '◇ a');
    assert.equal(cy.$id('t').style('label'), '◇ t\nTarget');
    for (const id of ['root', 'b', 'other']) {
      assert.equal(cy.$id(id).hasClass('chokepoint'), false);
      assert.equal(cy.$id(id).style('label'), id);
    }
    renderer.highlightPath(['root', 'a', 't']);
    renderer.setHotCounts({ a: 10, t: 100 });
    renderer.setCallValues({ t: { line: '(x=3)', args: [{ name: 'x', value: '3' }], atEntry: true } });
    const appearance = () => ['a', 't'].map(id => ({
      border: cy.$id(id).style('border-color'), width: cy.$id(id).style('border-width'),
      fill: cy.$id(id).style('background-color'), underlay: cy.$id(id).style('underlay-color'),
    }));
    const before = appearance();
    assert.equal(cy.$id('t').style('label'), '◇ t\n(x=3)\nTarget\nYou are here');
    renderer.renderGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, chokepoint: false })) });
    assert.deepEqual(appearance(), before);
    assert.equal(cy.$id('t').style('label'), 't\n(x=3)\nTarget\nYou are here');
    assert.equal(renderer.visibleChokepointCount, 0);
  }],
  ...CASES.test8.map((expected, index) => [
    `test8: chokepoint markers and search cycling at expansion stage ${index + 1}`,
    (cy: Core, renderer: GraphRenderer) => {
      cy.width = () => 1000;
      cy.height = () => 600;
      const graph: GraphData = {
        targetIds: ['chain.py::target'],
        nodes: [...expected.nodes].reverse().map(id => ({
          id, label: id.split('::')[1], file: id.split('::')[0], line: 1, endLine: 2,
          chokepoint: expected.chokepoints?.includes(id),
          noise: id.endsWith('::<module>'),
          hiddenCallers: expected.hiddenCallers?.[id],
        })),
        edges: expected.edges.map(([from, to, lines]) => ({ from, to, lines })),
      };
      renderer.renderGraph(graph);
      assert.deepEqual(cy.nodes('.chokepoint').map(node => node.id()).sort(), [...expected.chokepoints!].sort());
      cy.zoom(0.1); cy.pan({ x: 9000, y: 9000 });
      const nodes = cy.nodes().toArray();
      const positions = nodes.map(node => ({ id: node.id(), ...node.position() }));
      const events: string[] = [];
      cy.on('layoutstart add remove position', event => events.push(event.type));
      const first = renderer.search.findChokepoints();
      assert.equal(first.kind, 'chokepoints');
      assert.equal(first.query, '');
      assert.equal(first.index, 0);
      assert.equal(first.count, expected.chokepoints!.length);
      assert.equal(first.node?.id, 'chain.py::level1');
      assert.equal(cy.zoom(), 1);
      for (const id of expected.chokepoints!.slice(1)) assert.equal(renderer.search.move(1).node?.id, id);
      assert.equal(renderer.search.move(1).node?.id, 'chain.py::level1');
      assert.equal(renderer.search.move(-1).node?.id, expected.chokepoints!.at(-1));
      assert.equal(renderer.search.findChokepoints().node?.id, 'chain.py::level1');
      const focused = cy.$id('chain.py::level1');
      assert.equal(focused.hasClass('search-hit'), true);
      assert.ok(Math.abs(focused.renderedPosition().x - 500) < 0.001);
      assert.ok(Math.abs(focused.renderedPosition().y - 300) < 0.001);
      assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
      cy.nodes().forEach((node, i) => assert.equal(node, nodes[i]));
      assert.deepEqual(events, []);
    },
  ] as [string, (cy: Core, renderer: GraphRenderer) => void]),
  ['chokepoint results refresh with noise visibility and return to function search or clear safely', (cy, renderer) => {
    cy.width = () => 1000;
    cy.height = () => 600;
    renderer.renderGraph({
      ...noiseFixture,
      nodes: noiseFixture.nodes.map(node => ({ ...node, chokepoint: ['a', 'b'].includes(node.id) })),
    });
    assert.equal(renderer.visibleChokepointCount, 1);
    assert.equal(renderer.search.findChokepoints().node?.id, 'b');
    const pan = { ...cy.pan() }; const zoom = cy.zoom();
    renderer.setShowNoise(true);
    assert.equal(renderer.visibleChokepointCount, 2);
    const refreshed = renderer.search.refresh();
    assert.equal(refreshed.kind, 'chokepoints');
    assert.equal(refreshed.count, 2);
    assert.equal(refreshed.node?.id, 'b');
    assert.deepEqual(cy.pan(), pan); assert.equal(cy.zoom(), zoom);
    assert.equal(renderer.search.move(1).node?.id, 'a');
    renderer.setShowNoise(false);
    assert.equal(cy.$id('a').hasClass('search-hit'), false);
    assert.equal(renderer.search.move(1).node?.id, 'b');
    const normal = renderer.search.find('root');
    assert.equal(normal.kind, 'functions');
    assert.equal(normal.query, 'root');
    assert.equal(normal.node?.id, 'root');
    assert.equal(renderer.search.findChokepoints().node?.id, 'b');
    assert.equal(renderer.search.clear().kind, 'functions');
    assert.equal(renderer.search.move(1).count, 0);
    renderer.search.findChokepoints();
    renderer.renderGraph(fixture);
    assert.equal(renderer.search.move(1).kind, 'functions');
    assert.equal(renderer.search.move(1).count, 0);
    assert.equal(cy.$('.search-hit').length, 0);
  }],
  ['no chokepoints and empty graphs leave the viewport and debug appearance unchanged', (cy, renderer) => {
    renderer.highlightPath(['root', 'a', 't']);
    for (const graph of [fixture, { nodes: [], edges: [] }]) {
      renderer.renderGraph(graph);
      cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
      const before = cy.elements().map(node => ({ id: node.id(), classes: node.classes() }));
      const state = renderer.search.findChokepoints();
      assert.equal(state.kind, 'chokepoints');
      assert.equal(state.count, 0);
      assert.equal(state.index, -1);
      assert.equal(state.node, undefined);
      renderer.search.move(1); renderer.search.move(-1);
      assert.deepEqual(cy.pan(), { x: 51, y: 32 });
      assert.equal(cy.zoom(), 1.2);
      assert.deepEqual(cy.elements().map(node => ({ id: node.id(), classes: node.classes() })), before);
    }
  }],
  ['chokepoint zoom fits small viewports, respects zoom limits and keeps Explore running', (cy, renderer) => {
    cy.width = () => 200;
    cy.height = () => 160;
    renderer.renderGraph({ ...fixture, nodes: fixture.nodes.map(node => ({ ...node, chokepoint: node.id === 'a' })) });
    cy.minZoom(0.05); cy.maxZoom(0.5);
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(10);
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const frames = pendingAnimationFrames();
    const events: string[] = [];
    cy.on('layoutstart layoutstop add remove position', event => events.push(event.type));
    renderer.search.findChokepoints();
    assert.equal(cy.zoom(), 0.5);
    assert.equal(renderer.layoutMode, 'explore');
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.equal(pendingAnimationFrames(), frames);
    assert.ok(frames > 0);
    assert.deepEqual(events, []);
    const box = cy.$id('a').renderedBoundingBox({ includeOverlays: false, includeUnderlays: false });
    assert.ok(box.x1 >= 0 && box.x2 <= cy.width() && box.y1 >= 0 && box.y2 <= cy.height());
    cy.minZoom(0.4); cy.width = () => 100;
    renderer.search.move(1);
    assert.equal(cy.zoom(), 0.4);
  }],
  ...['test7/python', 'test7/cpp'].map(folder => [
    `${folder}: noise starts hidden and the toggle restores all tagged nodes and their edges`,
    (cy: Core, renderer: GraphRenderer) => {
      const expected = CASES[folder][0];
      const graph: GraphData = {
        targetIds: [`${expected.file}::target`],
        nodes: expected.nodes.map(id => ({
          id, label: id.split('::').slice(1).join('::'), file: id.split('::')[0], line: 1, endLine: 2,
          ...(expected.noise?.includes(id) || id.endsWith('::<module>') ? { noise: true } : {}),
        })),
        edges: expected.edges.map(([from, to, lines]) => ({ from, to, lines })),
      };
      renderer.renderGraph(graph);
      assert.equal(renderer.visibleNodeCount, 4);
      assert.equal(cy.edges(':visible').length, 4);
      const visible = graph.nodes.filter(node => !node.noise).map(node => node.id);
      assert.deepEqual(cy.nodes(':visible').map(node => node.id()), visible);
      assert.equal(cy.elements().length, graph.nodes.length + graph.edges.length);
      renderer.setShowNoise(true);
      assert.equal(renderer.visibleNodeCount, graph.nodes.length);
      assert.equal(cy.edges(':visible').length, graph.edges.length);
      renderer.setShowNoise(false);
      assert.deepEqual(cy.nodes(':visible').map(node => node.id()), visible);
      assert.equal(cy.edges(':visible').length, 4);
    },
  ] as [string, (cy: Core, renderer: GraphRenderer) => void]),
  ['noise visibility covers incoming, outgoing and self edges, while false and missing remain visible', (cy, renderer) => {
    renderer.renderGraph({ ...noiseFixture, nodes: noiseFixture.nodes.map(node => node.id === 'other'
      ? { id: node.id, label: node.label, file: node.file, line: node.line, endLine: node.endLine } : node) });
    assert.equal(cy.$id('a').visible(), false);
    assert.equal(cy.$id('root').visible(), true);
    assert.equal(cy.$id('other').visible(), true);
    for (const [from, to] of [['root', 'a'], ['a', 't'], ['a', 'b'], ['b', 'a'], ['a', 'a']]) {
      assert.equal(edge(cy, from, to).style('display'), 'none');
      assert.equal(edge(cy, from, to).visible(), false);
    }
    assert.equal(edge(cy, 't', 't').visible(), true);
    assert.equal(edge(cy, 'b', 't').visible(), true);
    renderer.setShowNoise(true);
    assert.equal(cy.elements(':hidden').length, 0);
  }],
  ['noise toggles preserve elements, data, positions, styling, selection and viewport without layouts', (cy, renderer) => {
    renderer.renderGraph(noiseFixture);
    renderer.setShowNoise(true);
    renderer.highlightPath(['root', 'a', 't']);
    renderer.setHotCounts({ root: 1, a: 10, t: 100 });
    cy.$id('a').select();
    renderer.hoverNode('b');
    renderer.search.find('other');
    cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
    const elements = cy.elements().toArray();
    const positions = () => cy.nodes().map(node => ({ id: node.id(), ...node.position(), locked: node.locked() }));
    const beforePositions = positions();
    const appearance = () => cy.elements().map(element => ({
      id: element.id(), data: { ...element.data() },
      classes: element.classes().filter(name => name !== 'noise-hidden'), selected: element.selected(),
      fill: element.style('background-color'), border: element.style('border-color'),
      line: element.style('line-color'), opacity: element.style('opacity'),
    }));
    const before = appearance();
    const events: string[] = [];
    cy.on('layoutstart layoutstop add remove position viewport', event => events.push(event.type));
    for (const show of [false, false, true, true, false, true]) {
      renderer.setShowNoise(show);
      assert.deepEqual(appearance(), before);
      assert.deepEqual(positions(), beforePositions);
      assert.deepEqual(cy.pan(), { x: 51, y: 32 });
      assert.equal(cy.zoom(), 1.2);
      cy.elements().forEach((element, index) => assert.equal(element, elements[index]));
      assert.deepEqual(renderer.heatRange, { min: 1, max: 100 });
    }
    assert.deepEqual(events, []);
  }],
  ['noise visibility refreshes search results without clearing the query or moving the viewport', (cy, renderer) => {
    renderer.renderGraph({
      ...noiseFixture,
      nodes: noiseFixture.nodes.map(node => ['a', 'b'].includes(node.id) ? { ...node, label: 'match' } : node),
    });
    assert.equal(renderer.search.find('MATCH').count, 1);
    assert.equal(renderer.search.move(1).node?.id, 'b');
    cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
    renderer.setShowNoise(true);
    let state = renderer.search.refresh();
    assert.equal(state.query, 'match');
    assert.equal(state.count, 2);
    assert.equal(state.node?.id, 'b');
    assert.equal(cy.$id('b').hasClass('search-hit'), true);
    assert.equal(renderer.search.move(1).node?.id, 'a');
    cy.pan({ x: 51, y: 32 });
    renderer.setShowNoise(false);
    state = renderer.search.refresh();
    assert.equal(state.query, 'match');
    assert.equal(state.count, 1);
    assert.equal(state.node?.id, 'b');
    assert.equal(cy.$id('a').hasClass('search-hit'), false);
    assert.deepEqual(cy.pan(), { x: 51, y: 32 });
    assert.equal(cy.zoom(), 1.2);
    assert.equal(renderer.search.find('a').count, 1); // Visible "match" includes "a".
    assert.equal(renderer.search.find('root').node?.id, 'root');
    renderer.renderGraph(noiseFixture);
    assert.equal(renderer.search.find('a').count, 0);
    renderer.setShowNoise(true);
    assert.equal(renderer.search.refresh().node?.id, 'a');
  }],
  ['hiding a hovered noise node clears hover; runtime and heat updates never reveal it', (cy, renderer) => {
    renderer.renderGraph(noiseFixture);
    renderer.setShowNoise(true);
    renderer.hoverNode('a');
    assert.equal(cy.$id('a').hasClass('hovered'), true);
    renderer.setShowNoise(false);
    assert.equal(cy.$('.hovered, .hover-faded, .hover-in, .hover-out').length, 0);
    renderer.hoverNode('a');
    assert.equal(cy.$('.hovered').length, 0);
    renderer.highlightPath(['root', 'a']);
    renderer.setHotCounts({ a: 10 });
    assert.equal(cy.$id('a').visible(), false);
    assert.equal(edge(cy, 'root', 'a').visible(), false);
    assert.equal(cy.$id('a').hasClass('current'), true);
    renderer.setShowNoise(true);
    assert.equal(cy.$id('a').visible(), true);
    assert.equal(cy.$id('a').hasClass('current'), true);
    assert.equal(cy.$id('a').hasClass('heat-counted'), true);
    assert.equal(edge(cy, 'root', 'a').hasClass('path'), true);
  }],
  ['replacement graphs retain the toggle and report visible counts, including an all-noise target', (cy) => {
    const rendered: number[] = [];
    const changed: number[] = [];
    const renderer = new GraphRenderer(cy, count => rendered.push(count), undefined, undefined, undefined,
      count => changed.push(count));
    try {
      const graph: GraphData = { nodes: [{ ...fixture.nodes[3], noise: true }], edges: [], targetIds: ['t'] };
      renderer.renderGraph(graph);
      assert.equal(renderer.visibleNodeCount, 0);
      assert.equal(cy.$id('t').hasClass('target'), true);
      renderer.setShowNoise(true);
      renderer.renderGraph(graph);
      assert.equal(renderer.visibleNodeCount, 1);
      renderer.setShowNoise(false);
      renderer.renderGraph(graph);
      assert.equal(renderer.visibleNodeCount, 0);
      renderer.renderGraph({ nodes: [], edges: [] });
      renderer.setShowNoise(true);
      assert.deepEqual(rendered, [0, 1, 0, 0]);
      assert.deepEqual(changed, [1, 0, 0]);
    } finally { renderer.dispose(); }
  }],
  ['noise toggles in Explore preserve the running simulation and Trace coordinates', (cy, renderer) => {
    renderer.renderGraph(noiseFixture);
    const tracePositions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    renderer.setLayoutMode('explore');
    advanceAnimationFrames(10);
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const frames = pendingAnimationFrames();
    let layouts = 0;
    cy.on('layoutstart layoutstop', () => layouts++);
    renderer.setShowNoise(true);
    renderer.setShowNoise(false);
    assert.equal(renderer.layoutMode, 'explore');
    assert.equal(layouts, 0);
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
    assert.equal(pendingAnimationFrames(), frames);
    assert.ok(frames > 0);
    advanceAnimationFrames(5);
    renderer.setLayoutMode('trace');
    assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), tracePositions);
    assert.equal(cy.$id('a').visible(), false);
  }],
  ['heat uses actual count distances on a continuous blue-to-red scale, including equal counts', (cy, renderer) => {
    renderer.setHotCounts({ root: 1, a: 2, b: 500, t: 1000, other: 2, unknown: 1000000 });
    assert.deepEqual(renderer.heatRange, { min: 1, max: 1000 });
    assert.equal(cy.$id('root').data('heatPosition'), 0);
    assert.equal(cy.$id('a').data('heatPosition'), 1 / 999);
    assert.equal(cy.$id('b').data('heatPosition'), 499 / 999);
    assert.equal(cy.$id('t').data('heatPosition'), 1);
    assert.equal(cy.$id('a').style('background-color'), cy.$id('other').style('background-color'));
    assert.equal(cy.$id('root').style('background-color'), 'rgb(36,80,139)');
    assert.equal(cy.$id('t').style('background-color'), 'rgb(139,48,48)');
    assert.notEqual(cy.$id('b').style('background-color'), cy.$id('root').style('background-color'));
    assert.notEqual(cy.$id('b').style('background-color'), cy.$id('t').style('background-color'));
    renderer.setHotCounts({ root: 1, a: 2, t: 3 });
    assert.equal(cy.$id('a').data('heatPosition'), 0.5);
    assert.equal(cy.$id('a').style('background-color'), heatColor(0.5, heatPalette('#d4d4d4')));
  }],
  ['heat snapshots replace totals, rescale all nodes, and reset to their original fills', (cy, renderer) => {
    const normal = cy.$id('b').style('background-color');
    renderer.setHotCounts({ root: 1, a: 2, t: 3 });
    renderer.setHotCounts({ root: 1, a: 2, t: 1000 });
    assert.equal(renderer.getHotCount('a'), 2);
    assert.equal(cy.$id('a').data('heatPosition'), 1 / 999);
    assert.equal(cy.$id('b').style('background-color'), normal);
    renderer.setHotCounts({ root: 7, a: 7 });
    assert.deepEqual(renderer.heatRange, { min: 7, max: 7 });
    assert.equal(cy.$id('root').data('heatPosition'), 0.5);
    assert.equal(cy.$id('t').style('background-color'), normal);
    assert.equal(renderer.getHotCount('t'), undefined);
    renderer.setHotCounts({});
    assert.equal(renderer.heatRange, undefined);
    assert.equal(cy.$('.heat-counted').length, 0);
    for (const node of cy.nodes()) {
      assert.equal(node.style('background-color'), normal);
      assert.equal(node.data('heatPosition'), undefined);
    }
  }],
  ['heat ignores invalid counts and resolves exact IDs with path punctuation and line suffixes', (cy, renderer) => {
    const ids = ['c:/my project/a.py::Dog.speak@12', '/tmp/b.py::outer.inner'];
    renderer.renderGraph({ nodes: ids.map(id => ({ id, label: 'same', file: 'a.py', line: 1, endLine: 2 })), edges: [] });
    renderer.setHotCounts({ [ids[0]]: 1, [ids[1]]: 1000, unknown: 999999 });
    assert.deepEqual(renderer.heatRange, { min: 1, max: 1000 });
    assert.equal(cy.getElementById(ids[0]).data('heatPosition'), 0);
    assert.equal(cy.getElementById(ids[1]).data('heatPosition'), 1);
    for (const invalid of [0, -1, NaN, Infinity, 0.5, '2' as unknown as number]) {
      renderer.setHotCounts({ [ids[0]]: invalid });
      assert.equal(cy.$('.heat-counted').length, 0);
      assert.equal(renderer.heatRange, undefined);
    }
  }],
  ['heat replays counts received before a graph and recalculates the scale for replacement graphs', (cy, renderer) => {
    renderer.renderGraph({ nodes: [], edges: [] });
    renderer.setHotCounts({ root: 1, a: 2, t: 1000 });
    assert.equal(renderer.heatRange, undefined);
    renderer.renderGraph(fixture);
    assert.equal(cy.$id('a').data('heatPosition'), 1 / 999);
    renderer.renderGraph({ nodes: fixture.nodes.filter(node => node.id !== 't'), edges: [] });
    assert.deepEqual(renderer.heatRange, { min: 1, max: 2 });
    assert.equal(cy.$id('a').data('heatPosition'), 1);
    renderer.setHotCounts({});
    renderer.renderGraph(fixture);
    assert.equal(cy.$('.heat-counted').length, 0);
  }],
  ['heat updates and resets preserve every existing visual cue, search state, node, and viewport', (cy, renderer) => {
    renderer.highlightPath(['root', 'a', 't']);
    cy.$id('a').select();
    renderer.hoverNode('a');
    renderer.search.find('other');
    cy.zoom(1.2); cy.pan({ x: 51, y: 32 });
    const elements = cy.elements().toArray();
    const properties = ['border-color', 'border-width', 'border-style', 'underlay-color', 'underlay-opacity',
      'overlay-color', 'overlay-opacity', 'opacity', 'line-color', 'target-arrow-color', 'width', 'line-style', 'label'];
    const appearance = () => cy.elements().map(element => ({
      id: element.id(), classes: element.classes().filter(name => name !== 'heat-counted'), selected: element.selected(),
      style: Object.fromEntries(properties.map(property => [property, element.style(property)])),
    }));
    const before = appearance();
    const positions = cy.nodes().map(node => ({ id: node.id(), ...node.position() }));
    const pan = { ...cy.pan() }; const zoom = cy.zoom();
    const events: string[] = [];
    cy.on('layoutstart add remove position', event => events.push(event.type));
    const snapshots: HotCounts[] = [{ root: 1, a: 2, t: 1000, other: 20 }, {}];
    for (const counts of snapshots) {
      renderer.setHotCounts(counts);
      assert.deepEqual(appearance(), before);
      assert.deepEqual(cy.nodes().map(node => ({ id: node.id(), ...node.position() })), positions);
      assert.deepEqual(cy.pan(), pan); assert.equal(cy.zoom(), zoom);
      cy.elements().forEach((element, index) => assert.equal(element, elements[index]));
    }
    assert.deepEqual(events, []);
  }],
  ['runtime clearing retains final heat and layout switches do not change count colors', (cy, renderer) => {
    renderer.setHotCounts({ root: 1, a: 2, t: 1000 });
    const colors = () => cy.nodes().map(node => node.style('background-color'));
    const before = colors();
    renderer.highlightPath(['root', 'a', 't']); renderer.hoverNode('t');
    assert.deepEqual(colors(), before);
    renderer.clearDebugPath();
    assert.deepEqual(colors(), before);
    assert.equal(cy.$('.path, .current, .dimmed').length, 0);
    assert.equal(renderer.getHotCount('t'), 1000);
    renderer.setLayoutMode('explore');
    const frames = pendingAnimationFrames();
    let layouts = 0;
    cy.on('layoutstart layoutstop', () => layouts++);
    renderer.setHotCounts({ root: 1, a: 2, t: 1000 });
    assert.equal(layouts, 0);
    assert.equal(pendingAnimationFrames(), frames);
    renderer.setLayoutMode('trace');
    assert.deepEqual(colors(), before);
  }],
  ['legend callbacks track visible ranges, including reset, equal counts, and empty graphs', (cy) => {
    const ranges: (HeatRange | undefined)[] = [];
    const renderer = new GraphRenderer(cy, undefined, undefined, undefined, range => ranges.push(range));
    try {
      renderer.renderGraph(fixture);
      renderer.setHotCounts({ a: 10, t: 30 });
      renderer.setHotCounts({ t: 4 });
      renderer.setHotCounts({});
      renderer.renderGraph({ nodes: [], edges: [] });
      assert.deepEqual(ranges, [undefined, { min: 10, max: 30 }, { min: 4, max: 4 }, undefined, undefined]);
    } finally { renderer.dispose(); }
  }],
  ['heat fills match the legend palette and keep theme labels readable in light and dark themes', (cy, renderer) => {
    const luminance = (rgb: number[]) => rgb.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    for (const [foreground, background, textRGB] of [
      ['#d4d4d4', '#252526', [212, 212, 212]], ['#333333', '#ffffff', [51, 51, 51]],
    ] as const) {
      cy.style(graphStyles(foreground, background));
      renderer.setHotCounts({ root: 1, a: 501, t: 1001 });
      const palette = heatPalette(foreground);
      for (let step = 0; step <= 100; step++) {
        const rgb = heatColor(step / 100, palette).match(/\d+/g)!.map(Number);
        const text = luminance([...textRGB]); const fill = luminance(rgb);
        assert.ok((Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05) >= 4.5);
      }
      for (const [id, position] of [['root', 0], ['a', 0.5], ['t', 1]] as const) {
        assert.equal(cy.$id(id).style('background-color'), heatColor(position, palette));
        assert.equal(cy.$id(id).style('color'), `rgb(${textRGB.join(',')})`);
      }
      renderer.setHotCounts({});
      assert.equal(cy.$id('root').style('background-color'), background === '#ffffff' ? 'rgb(255,255,255)' : 'rgb(37,37,38)');
    }
  }],
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
  // --- call values feature ---
  ['call values put an args line under the name, survive a re-render, and clear', (cy, renderer) => {
    const label = (id: string) => cy.$id(id).style('label') as string;
    renderer.setCallValues({ a: { line: '(x=3, y=4)', args: [{ name: 'x', value: '3' }, { name: 'y', value: '4' }], atEntry: true } });
    assert.equal(label('a'), 'a\n(x=3, y=4)');
    assert.equal(cy.$id('a').hasClass('has-args'), true);
    assert.equal(label('b'), 'b');
    renderer.highlightPath(['root', 'a']);
    assert.equal(label('a'), 'a\n(x=3, y=4)\nYou are here');
    renderer.renderGraph(fixture);
    assert.equal(label('a'), 'a\n(x=3, y=4)\nYou are here');
    assert.equal(renderer.callValue('a')?.atEntry, true);
    assert.equal(renderer.callValue('toString'), undefined);
    renderer.setCallValues({});
    assert.equal(label('a'), 'a\nYou are here');
    assert.equal(cy.$('.has-args').length, 0);
  }],
  // --- end call values feature ---
  // --- breakpoint markers ---
  ['breakpoint markers add a corner dot without touching path/current borders, survive a re-render, and clear', (cy, renderer) => {
    renderer.highlightPath(['root', 'a']);
    const border = (id: string) => [cy.$id(id).style('border-color'), cy.$id(id).style('border-width')];
    const before = border('a');
    renderer.setBreakpoints({ a: 2, root: 1, unknown: 1 });
    assert.deepEqual(cy.$('.has-breakpoint').map(node => node.id()).sort(), ['a', 'root']);
    assert.match(String(cy.$id('a').style('background-image')), /^data:image\/svg\+xml/);
    assert.deepEqual(border('a'), before);
    assert.equal(cy.$id('a').hasClass('current'), true);
    assert.equal(renderer.breakpointCount('a'), 2);
    assert.equal(renderer.breakpointCount('b'), 0);
    renderer.renderGraph(fixture);
    assert.deepEqual(cy.$('.has-breakpoint').map(node => node.id()).sort(), ['a', 'root']);
    renderer.setBreakpoints({ root: 1 });
    assert.deepEqual(cy.$('.has-breakpoint').map(node => node.id()), ['root']);
    renderer.setBreakpoints({});
    assert.equal(cy.$('.has-breakpoint').length, 0);
  }],
  // --- end breakpoint markers ---
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
