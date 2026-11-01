import * as assert from 'node:assert/strict';
import cytoscape, { type Core } from 'cytoscape';
import { advanceAnimationFrames, pendingAnimationFrames } from './animationFrames.test';
import { flowLines, GraphRenderer, graphStyles, historyStepLabel } from './graph'; // historyStepLabel: session history; flowLines: argument vs return feature
import { NodeLocals } from './nodeLocals'; // local variables feature
import { heatColor, heatPalette, type HeatRange } from './heatmap';
import type { CallValue, GraphData, HistoryStep, HotCounts, StepValues, VariableChildren } from '../src/types';
import { paneModel, VariablePane } from './variablePane'; // variable inspector panel
import { resolveName, watchMissText, watchModel } from './watchVariable'; // watch variable
import { MAX_HISTORY_ROWS, valueHistoryModel } from './variableHistory'; // variable history
import { largeSearchGraph } from '../src/test/mockdata';
import { CASES } from '../src/test/cases';
import { DEBUG_CASES } from '../src/test/debugCases';
import { markRecursion } from '../src/recursion';
import { recursionAnnouncement, recursionColor, recursionOutlines } from './recursion';
import { truncationMarkerCases } from './truncationMarkers.test';
import { exploreLayoutCases } from './exploreLayout.test';
import { sessionReplayCases } from './sessionReplay.test';
import { uiNavigationCases } from './uiNavigation.test';
import { pathNavigationCases } from './pathNavigation.test';

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

// --- local variables feature ---
// Only the DOM boundary is replaced; the band runs against real Cytoscape nodes and events.
class LocalsDiv {
  public className = '';
  public textContent = '';
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public readonly attributes: Record<string, string> = {};
  public readonly classes = new Set<string>();
  public children: LocalsDiv[] = [];
  public readonly classList = {
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  constructor(private readonly siblings: LocalsDiv[]) {}
  public appendChild(child: LocalsDiv): LocalsDiv { this.children.push(child); return child; }
  public replaceChildren(): void { this.children = []; }
  public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  public remove(): void {
    const index = this.siblings.indexOf(this);
    if (index >= 0) this.siblings.splice(index, 1);
  }
  public rows(): string[] { return this.children.map(child => child.textContent); }
}

// --- watch variable ---
/** A fake element covering just the DOM surface VariablePane touches. */
class PaneEl {
  public className = '';
  public textContent = '';
  public title = '';
  public type = '';
  public children: PaneEl[] = [];
  public dataset: Record<string, string> = {};
  public style: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public clicks: (() => void)[] = [];
  public readonly classes = new Set<string>();
  public readonly classList = {
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); },
  };
  public readonly ownerDocument = { createElement: (tag: string) => new PaneEl(tag) };
  constructor(public readonly tag = 'div') {}
  public appendChild(child: PaneEl): PaneEl { this.children.push(child); return child; }
  public replaceChildren(...next: PaneEl[]): void { this.children = next; }
  public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  public addEventListener(_name: string, handler: () => void): void { this.clicks.push(handler); }
  /** Section headings, in render order. */
  public headings(): string[] {
    return this.children.flatMap(section =>
      section.children.filter(child => child.tag === 'h3').map(child => child.textContent));
  }
  public section(heading: string): PaneEl | undefined {
    return this.children.find(child => child.children.some(c => c.tag === 'h3' && c.textContent.startsWith(heading)));
  }
}

function paneRows(section: PaneEl | undefined): string[][] {
  return (section?.children ?? [])
    .filter(child => child.className.includes('pane-row'))
    .map(row => row.children.map(cell => cell.textContent));
}
// --- end watch variable ---

function withLocals(cy: Core, run: (f: {
  bands: LocalsDiv[]; flush(): void; locals: NodeLocals; hidden(): boolean;
}) => void): void {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = frame => { frames.delete(frame); };
  const bands: LocalsDiv[] = [];
  const host = {
    hidden: true,
    ownerDocument: { createElement: (tag: string) => { assert.equal(tag, 'div'); return new LocalsDiv(bands); } },
    appendChild: (band: LocalsDiv) => { bands.push(band); },
  };
  const locals = new NodeLocals(cy, host as unknown as HTMLElement);
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  try { run({ bands, flush, locals, hidden: () => host.hidden }); }
  finally {
    locals.dispose();
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
}
// --- end local variables feature ---

const cases: [string, (cy: Core, renderer: GraphRenderer) => void | Promise<void>][] = [
  ...truncationMarkerCases,
  ...exploreLayoutCases,
  ...sessionReplayCases,
  ...uiNavigationCases,
  ...pathNavigationCases,
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
    assert.equal(cy.$id('t').style('label'), '◇ t');
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
    assert.equal(cy.$id('t').style('label'), '◇ t\n(x=3)');
    renderer.renderGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, chokepoint: false })) });
    assert.deepEqual(appearance(), before);
    assert.equal(cy.$id('t').style('label'), 't\n(x=3)');
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
  ['heat uses actual count distances on a continuous yellow-to-red scale, including equal counts', (cy, renderer) => {
    renderer.setHotCounts({ root: 1, a: 2, b: 500, t: 1000, other: 2, unknown: 1000000 });
    assert.deepEqual(renderer.heatRange, { min: 1, max: 1000 });
    assert.equal(cy.$id('root').data('heatPosition'), 0);
    assert.equal(cy.$id('a').data('heatPosition'), 1 / 999);
    assert.equal(cy.$id('b').data('heatPosition'), 499 / 999);
    assert.equal(cy.$id('t').data('heatPosition'), 1);
    assert.equal(cy.$id('a').style('background-color'), cy.$id('other').style('background-color'));
    assert.equal(cy.$id('root').style('background-color'), 'rgb(104,88,20)');
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
    // The grab event alone holds the node while Explore moves its neighbors.
    advanceAnimationFrames(20);
    assert.notDeepEqual(neighbor.position(), before);
    assert.deepEqual(root.position(), { x: 999, y: -123 });
    root.emit('free');
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
    assert.equal(cy.$id('t').style('label'), 't');
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
    assert.equal(cy.$id('t').style('label'), 't');
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
    assert.equal(label('a'), 'a\n(x=3, y=4)');
    renderer.renderGraph(fixture);
    assert.equal(label('a'), 'a\n(x=3, y=4)');
    assert.equal(renderer.callValue('a')?.atEntry, true);
    assert.equal(renderer.callValue('toString'), undefined);
    renderer.setCallValues({});
    assert.equal(label('a'), 'a');
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
  // --- session history ---
  ['session history step labels show position, location and reason', () => {
    const step = { path: ['a'], reason: 'step', time: 0, session: 'Run', where: { name: 'sum', file: '/proj/sum.py', line: 2 } };
    assert.equal(historyStepLabel(step, 6, 41), 'Step 7 of 41 · sum.py:2 sum (step)');
    assert.equal(historyStepLabel({ ...step, where: undefined, reason: 'pause' }, 0, 1, 12), 'Step 1 of 1 · (no source) (pause) · 12 older dropped');
  }],
  // --- end session history ---
  // --- local variables feature ---
  ['locals never touch the node label, and ride on node data instead', (cy, renderer) => {
    const label = (id: string) => cy.$id(id).style('label') as string;
    renderer.setCallValues({
      a: {
        line: '(x=3)', args: [{ name: 'x', value: '3' }], atEntry: false,
        localsRows: ['total=7', 'items=[1, 2]', 'flag=True'], localsCount: 6,
        locals: [{ name: 'total', value: '7' }],
      },
      b: { line: '(y=1)', args: [{ name: 'y', value: '1' }], atEntry: true }, // arguments only
    });
    // The whole point of the overlay: the args line is still the only thing added to the label.
    assert.equal(label('a'), 'a\n(x=3)');
    assert.equal(label('b'), 'b\n(y=1)');
    assert.equal(cy.$id('a').hasClass('has-locals'), true);
    assert.equal(cy.$id('b').hasClass('has-locals'), false);
    assert.deepEqual(cy.$id('a').data('callLocals'),
      { rows: ['total=7', 'items=[1, 2]', 'flag=True', '+3 more'], stale: false });
    assert.equal(cy.$id('b').data('callLocals'), undefined);
    // Survives a re-render, and clears with the values.
    renderer.renderGraph(fixture);
    assert.equal(cy.$id('a').hasClass('has-locals'), true);
    assert.equal(label('a'), 'a\n(x=3)');
    renderer.setCallValues({});
    assert.equal(cy.$('.has-locals').length, 0);
    assert.equal(cy.$id('a').data('callLocals'), undefined);
    assert.equal(label('a'), 'a');
  }],
  ['the locals band draws one row per local, greys when stale, and clears', (cy, renderer) => {
    cy.zoom(1); // a headless Cytoscape has no viewport, so its zoom starts at ~0
    withLocals(cy, f => {
      renderer.setCallValues({
        a: {
          line: '(x=3)', args: [], atEntry: false,
          localsRows: ['total=7', 'items=[1, 2]'], localsCount: 2, locals: [{ name: 'total', value: '7' }],
        },
      });
      f.flush();
      assert.deepEqual(f.bands.map(band => band.rows()), [['total=7', 'items=[1, 2]']]);
      assert.equal(f.bands[0].className, 'node-locals');
      assert.equal(f.bands[0].dataset.nodeId, 'a');
      assert.equal(f.bands[0].classes.has('stale'), false);
      assert.equal(f.bands[0].attributes['aria-label'], 'a locals: total=7, items=[1, 2]');
      assert.equal(f.hidden(), false);
      // Anchored below the node, not over the top edge where the pills are.
      assert.ok(Number.parseFloat(f.bands[0].style.top) > cy.$id('a').renderedPosition().y);

      renderer.setCallValues({
        a: {
          line: '(x=3)', args: [], atEntry: false, stale: true,
          localsRows: ['total=7'], localsCount: 4, locals: [{ name: 'total', value: '7' }],
        },
      });
      f.flush();
      assert.deepEqual(f.bands.map(band => band.rows()), [['total=7', '+3 more']]);
      assert.equal(f.bands[0].classes.has('stale'), true);

      renderer.setCallValues({});
      f.flush();
      assert.deepEqual(f.bands, []);
      assert.equal(f.hidden(), true);
    });
  }],
  ['the locals band stays off the graph when zoomed too far out to read', (cy, renderer) => {
    cy.zoom(1);
    withLocals(cy, f => {
      renderer.setCallValues({
        a: { line: '()', args: [], atEntry: false, localsRows: ['total=7'], localsCount: 1, locals: [] },
      });
      f.flush();
      assert.equal(f.bands.length, 1);
      cy.zoom(NodeLocals.MIN_ZOOM / 2);
      f.flush();
      assert.deepEqual(f.bands, []);
      assert.equal(f.hidden(), true);
      cy.zoom(1);
      f.flush();
      assert.equal(f.bands.length, 1);
    });
  }],
  // --- end local variables feature ---
  // --- return values feature ---
  ['return values add their own label line, with or without an args line, and clear', (cy, renderer) => {
    const label = (id: string) => cy.$id(id).style('label') as string;
    renderer.setReturnValues({ a: '7', b: "'done'", unknown: '1' });
    assert.equal(label('a'), 'a\n→ 7');
    assert.equal(label('b'), "b\n→ 'done'");
    assert.equal(cy.$id('a').hasClass('has-return'), true);
    assert.equal(cy.$id('t').hasClass('has-return'), false);
    assert.equal(renderer.returnValue('a'), '7');
    assert.equal(renderer.returnValue('t'), undefined);
    // Paired with the args line when both are present, and both survive a re-render.
    renderer.setCallValues({ a: { line: '(x=3)', args: [{ name: 'x', value: '3' }], atEntry: false } });
    assert.equal(label('a'), 'a\n(x=3) → 7');
    renderer.renderGraph(fixture);
    assert.equal(label('a'), 'a\n(x=3) → 7');
    // A long value is shortened for the node; the full one stays available.
    renderer.setReturnValues({ a: `[${Array.from({ length: 40 }, (_, i) => i).join(', ')}]` });
    const shortened = label('a').split('\n')[2];
    assert.ok(shortened.length <= 24 && shortened.endsWith('…'), shortened);
    assert.ok(renderer.returnValue('a')!.length > 40);
    // A full snapshot: a node absent from it loses the line, and the args line is untouched.
    renderer.setReturnValues({});
    assert.equal(label('a'), 'a\n(x=3)');
    assert.equal(cy.$('.has-return').length, 0);
  }],
  // --- end return values feature ---
  // --- argument vs return feature ---
  ['arguments and the return value share a line until the pair gets too long', () => {
    // One statement when it fits: this is the whole point of the pairing.
    assert.deepEqual(flowLines('(a=3, b=4)', '→ 7'), ['(a=3, b=4) → 7']);
    // Exactly at the cap, then one character over: the pair falls back to the two lines it was.
    const at = '(abcdefghijklmnopqrst)'; // 22 + ' ' + '→ 7' (3) = 26
    assert.equal(`${at} → 7`.length, 26);
    assert.deepEqual(flowLines(at, '→ 7'), [`${at} → 7`]);
    const over = `${at}x`;
    assert.deepEqual(flowLines(over, '→ 7'), [over, '→ 7']);
    // Either one alone is unchanged, and a node with neither contributes no lines.
    assert.deepEqual(flowLines('(a=3, b=4)', undefined), ['(a=3, b=4)']);
    assert.deepEqual(flowLines(undefined, '→ 7'), ['→ 7']);
    assert.deepEqual(flowLines(undefined, undefined), []);
    // The recursion suffix the args line can carry stays attached to the arguments.
    assert.deepEqual(flowLines('(n=1) +3', '→ 1'), ['(n=1) +3 → 1']);
  }],
  // --- end argument vs return feature ---
  // --- variable inspector panel ---
  ['pane: three sections, with the caveats and empty states the capture implies', () => {
    const model = paneModel({
      label: 'add',
      value: {
        line: '(a=3)', atEntry: false, args: [{ name: 'a', value: '3', type: 'int' }],
        locals: [{ name: 'total', value: '7', type: 'int' }], localsCount: 4,
      },
      returnValue: '7',
      expanded: new Set(), children: new Map(),
    });
    assert.deepEqual(model.sections.map(s => s.id), ['args', 'locals', 'return']);
    assert.equal(model.stale, false);
    assert.match(model.sections[0].note!, /values at the pause/i);
    assert.equal(model.sections[1].note, '3 more not shown.'); // localsCount 4, one listed
    assert.deepEqual(model.sections[2].rows.map(r => r.value), ['7']);
    assert.equal(model.sections[2].rows[0].ref, undefined); // the hook keeps no object to expand
    // atEntry switches the caveat, and the empty states explain themselves.
    const entry = paneModel({
      label: 'add', value: { line: '()', atEntry: true, args: [] },
      expanded: new Set(), children: new Map(),
    });
    assert.match(entry.sections[0].note!, /as passed/i);
    assert.equal(entry.sections[0].empty, 'No parameters.');
    assert.ok(entry.sections[2].empty!.includes('3.12'));
  }],
  ['pane: expanding a ref nests its children, pages with "+N more", and shows loading', () => {
    const value: CallValue = {
      line: '()', atEntry: false, args: [{ name: 'items', value: '[1, 2]', type: 'list', ref: 11 }],
    };
    const base = { label: 'f', value, children: new Map(), expanded: new Set<string>() };
    // Collapsed: just the one row, offering a disclosure.
    assert.deepEqual(paneModel(base).sections[0].rows.map(r => [r.name, r.depth, r.expanded]),
      [['items', 0, false]]);
    // Expanded with nothing fetched yet: the row reports itself as loading.
    const waiting = paneModel({ ...base, expanded: new Set(['args/items']) }).sections[0].rows;
    assert.equal(waiting.length, 1);
    assert.deepEqual([waiting[0].expanded, waiting[0].loading], [true, true]);
    // Children arrive, including a nested one that is itself expanded.
    const children = new Map<number, VariableChildren>([
      [11, { ref: 11, children: [{ name: '0', value: '1' }, { name: '1', value: '[9]', ref: 12 }], more: 7 }],
      [12, { ref: 12, children: [{ name: '0', value: '9' }] }],
    ]);
    const rows = paneModel({
      ...base, children, expanded: new Set(['args/items', 'args/items/1']),
    }).sections[0].rows;
    assert.deepEqual(rows.map(r => [r.key, r.depth, r.note ?? false]), [
      ['args/items', 0, false],
      ['args/items/0', 1, false],
      ['args/items/1', 1, false],
      ['args/items/1/0', 2, false],
      ['args/items/+more', 1, true],
    ]);
    assert.equal(rows.find(r => r.note)!.name, '+7 more');
  }],
  ['pane: stale keeps the values but takes away every disclosure', () => {
    const rows = paneModel({
      label: 'f',
      value: { line: '()', atEntry: false, stale: true, args: [{ name: 'items', value: '[1, 2]', ref: 11 }] },
      expanded: new Set(['args/items']),
      children: new Map([[11, { ref: 11, children: [{ name: '0', value: '1' }] }]]),
    }).sections[0].rows;
    // The reference died with the pause, so it is not offered - and not followed either.
    assert.deepEqual(rows.map(r => r.name), ['items']);
    assert.equal(rows[0].value, '[1, 2]'); // the last known value is still worth showing
    assert.equal(rows[0].ref, undefined);
    assert.equal(rows[0].expanded, false);
    assert.equal(paneModel({
      label: 'f', value: { line: '()', atEntry: false, stale: true, args: [] },
      expanded: new Set(), children: new Map(),
    }).stale, true);
  }],
  ['pane: a stale answer is dropped, not rendered as children', () => {
    const rows = paneModel({
      label: 'f',
      value: { line: '()', atEntry: false, args: [{ name: 'items', value: '[1, 2]', ref: 11 }] },
      expanded: new Set(['args/items']),
      children: new Map([[11, { ref: 11, children: [], stale: true }]]),
    }).sections[0].rows;
    assert.deepEqual(rows.map(r => r.name), ['items']);
    assert.equal(rows[0].loading, true); // reported as pending rather than as "no children"
  }],
  ['pane: messages replace the sections when there is nothing honest to show', () => {
    assert.match(paneModel({ expanded: new Set(), children: new Map() }).message!, /Click a function/);
    // A scrubbed step that recorded no variables (not Python, no graph open, or evicted): say so.
    const scrubbed = paneModel({
      label: 'add', historyStep: true,
      value: { line: '(a=3)', atEntry: false, args: [{ name: 'a', value: '3' }] },
      expanded: new Set(), children: new Map(),
    });
    assert.equal(scrubbed.message, 'No variables recorded for this step.');
    assert.deepEqual(scrubbed.sections, []);
    // Selected, but never paused inside it and nothing returned.
    assert.match(paneModel({ label: 'add', expanded: new Set(), children: new Map() }).message!,
      /Pause the debugger inside this function/);
    // A return value alone is enough to be worth a pane.
    const returnOnly = paneModel({ label: 'add', returnValue: '7', expanded: new Set(), children: new Map() });
    assert.equal(returnOnly.message, undefined);
    assert.deepEqual(returnOnly.sections.map(s => s.id), ['return']);
  }],
  // --- per-step variable capture ---
  ['pane: a scrubbed step renders its recorded strings read-only, with no return section', () => {
    const model = paneModel({
      label: 'add', historyStep: true,
      // The live pause's values belong to another moment: they must not leak into a past step.
      value: { line: '(a=99)', atEntry: true, args: [{ name: 'a', value: '99', ref: 5 }] },
      returnValue: '7',
      historyValues: {
        args: [{ name: 'a', value: '3' }, { name: 'b' }],
        locals: [{ name: 'total', value: '[1, 2]' }],
        localsCount: 4,
      },
      expanded: new Set(['locals/total']), // already open from a live pause: cannot reopen here
      children: new Map(),
    });
    assert.equal(model.message, undefined);
    assert.equal(model.stale, false); // an accurate reading of the past, not a stale one of the present
    assert.deepEqual(model.sections.map(s => s.id), ['args', 'locals']); // no 'return'
    assert.deepEqual(model.sections[0].rows.map(r => [r.name, r.value, r.ref, r.expanded]), [
      ['a', '3', undefined, false],
      ['b', '(not in locals)', undefined, false],
    ]);
    assert.match(model.sections[0].note!, /Recorded at this step: values as they were/);
    assert.deepEqual(model.sections[1].rows.map(r => [r.name, r.value, r.ref]), [['total', '[1, 2]', undefined]]);
    assert.equal(model.sections[1].note, '3 more not recorded.');
    // atEntry changes only the caveat.
    const entry = paneModel({
      label: 'add', historyStep: true, historyValues: { args: [], locals: [], atEntry: true },
      expanded: new Set(), children: new Map(),
    });
    assert.match(entry.sections[0].note!, /paused on the first line/);
    assert.equal(entry.sections[0].rows.length, 0);
    assert.equal(entry.sections[0].empty, 'No parameters.');
  }],
  // --- end per-step variable capture ---
  // --- end variable inspector panel ---
  // --- watch variable ---
  ['watch: one name across the path, arguments before locals, with the origin kept', () => {
    const model = watchModel('total', [
      { id: 'main', label: 'main', values: { args: [], locals: [{ name: 'total', value: '0' }] } },
      { id: 'add', label: 'add', values: { args: [{ name: 'total', value: '3' }], locals: [] } },
      // Present in both: the parameter wins, and the row says so.
      { id: 'inner', label: 'inner', values: { args: [{ name: 'total', value: '9' }], locals: [{ name: 'total', value: '99' }] } },
    ]);
    assert.deepEqual(model.rows.map(r => [r.label, r.value, r.origin]), [
      ['main', '0', 'local'],
      ['add', '3', 'arg'],
      ['inner', '9', 'arg'],
    ]);
    assert.equal(model.found, 3);
    assert.equal(model.note, 'Found at 3 of 3 functions on this path.');
    // The suggestion list is every name the path offers, deduplicated and sorted.
    assert.deepEqual(model.names, ['total']);
  }],
  ['watch: stars are stripped on both sides, and the match is case-sensitive', () => {
    const frames = [{
      id: 'f', label: 'f',
      values: { args: [{ name: '*args', value: '(1, 2)' }, { name: '**kwargs', value: '{}' }], locals: [] },
    }];
    // formatCallValue stores parameters under their display name, so typing the bare name must hit.
    assert.equal(watchModel('args', frames).rows[0].value, '(1, 2)');
    assert.equal(watchModel('kwargs', frames).rows[0].value, '{}');
    assert.equal(watchModel('*args', frames).rows[0].value, '(1, 2)'); // typing the stars works too
    assert.deepEqual(watchModel('', frames).names, ['args', 'kwargs']); // suggested without stars
    // Python identifiers are case-sensitive: Total is not total.
    const cased = [{ id: 'f', label: 'f', values: { args: [{ name: 'total', value: '1' }], locals: [] } }];
    assert.equal(watchModel('Total', cased).rows[0].miss, 'not-present');
  }],
  ['watch: the five no-value cases stay apart', () => {
    const model = watchModel('total', [
      { id: 'pathfinder-unmatched-frame-0' },                       // no label: not in this graph
      { id: 'cold', label: 'cold' },                                // no values captured at all
      { id: 'other', label: 'other', values: { args: [{ name: 'n', value: '1' }], locals: [] } },
      { id: 'capped', label: 'capped', values: { args: [], locals: [{ name: 'x', value: '1' }], localsCount: 30 } },
      { id: 'gone', label: 'gone', values: { args: [{ name: 'total' }], locals: [] } }, // deleted
    ]);
    assert.deepEqual(model.rows.map(r => [r.label, r.miss]), [
      ['(outside graph)', 'outside'],
      ['cold', 'no-capture'],       // we know nothing: says nothing about the variable
      ['other', 'not-present'],     // captured, genuinely absent: the informative answer
      ['capped', 'maybe-capped'],   // the caps dropped locals, so absence is not ours to claim
      ['gone', 'no-value'],         // found, but not in Locals
    ]);
    assert.equal(model.rows.every(r => r.value === undefined), true);
    assert.equal(model.found, 0);
    assert.equal(model.note, 'Not found on this path. Check the name, or pause deeper in the call chain.');
    // Each one reads differently, because each one means something different.
    assert.equal(new Set(model.rows.map(r => watchMissText(r.miss!))).size, 5);
    // The outside row is not counted as a function of the path.
    assert.equal(watchModel('n', [{ id: 'x' }, { id: 'other', label: 'other', values: { args: [{ name: 'n', value: '1' }], locals: [] } }]).note,
      'Found at 1 of 1 function on this path.');
  }],
  ['watch: a recursive node collapses to one row rather than repeating its innermost value', () => {
    const fact = { id: 'fact', label: 'fact', values: { args: [{ name: 'n', value: '1' }], locals: [] } };
    const model = watchModel('n', [
      { id: 'main', label: 'main', values: { args: [], locals: [] } },
      fact, fact, fact, // the same node three times: only the innermost frame was captured
    ]);
    // Printing 1 three times would read as "n never changed", which is false.
    assert.deepEqual(model.rows.map(r => [r.label, r.repeats, r.value]), [
      ['main', 1, undefined],
      ['fact', 3, '1'],
    ]);
    assert.equal(model.found, 1);
    // Consecutive unmatched frames collapse the way the breadcrumb collapses them.
    const outside = watchModel('n', [{ id: 'a' }, { id: 'b' }, { id: 'main', label: 'main' }]);
    assert.deepEqual(outside.rows.map(r => [r.label, r.repeats]), [['(outside graph)', 2], ['main', 1]]);
  }],
  ['watch: messages replace the rows when there is nothing to resolve', () => {
    const frames = [{ id: 'f', label: 'f', values: { args: [{ name: 'n', value: '1' }], locals: [] } }];
    const empty = watchModel('   ', frames);
    assert.match(empty.message!, /Type a variable name/);
    assert.deepEqual(empty.rows, []);
    assert.deepEqual(empty.names, ['n']); // still suggested, so the list is ready before you type
    const noPath = watchModel('n', []);
    assert.match(noPath.message!, /No path highlighted/);
    assert.deepEqual(noPath.rows, []);
  }],
  ['watch: a live CallValue and a recorded StepValues both satisfy WatchSource unchanged', () => {
    // Neither shape is converted anywhere: this is the reuse the feature is built on.
    const live: CallValue = {
      line: '(n=2)', atEntry: false, args: [{ name: 'n', value: '2', ref: 7, type: 'int' }],
      locals: [{ name: 'acc', value: '6', ref: 8 }], localsRows: ['acc=6'], localsCount: 1,
    };
    const recorded: StepValues = {
      args: [{ name: 'n', value: '5' }], locals: [{ name: 'acc', value: '7' }], localsCount: 1,
    };
    const model = watchModel('acc', [
      { id: 'live', label: 'live', values: live },
      { id: 'recorded', label: 'recorded', values: recorded },
    ]);
    assert.deepEqual(model.rows.map(r => [r.label, r.value, r.origin]), [
      ['live', '6', 'local'],
      ['recorded', '7', 'local'],
    ]);
    assert.deepEqual(model.names, ['acc', 'n']);
  }],
  ['watch: the section renders above the inspector, with no selection, and keeps twisties open', () => {
    const host = new PaneEl();
    const title = new PaneEl();
    const requested: number[] = [];
    const suggested: string[][] = [];
    const pane = new VariablePane(host as unknown as HTMLElement, title as unknown as HTMLElement, {
      requestChildren: ref => requested.push(ref),
      watchNamesChanged: names => suggested.push(names),
    });
    const frames = [
      { id: 'main', label: 'main', values: { args: [], locals: [{ name: 'total', value: '0' }] } },
      { id: 'add', label: 'add', values: { args: [{ name: 'total', value: '3' }], locals: [] } },
    ];

    // Nothing selected: the inspector has only a message, but the watch still has something to say.
    pane.setWatch('total', frames);
    assert.equal(pane.watched, 'total');
    assert.deepEqual(host.headings(), ['Watch: total', 'History: total']); // variable history: siblings
    assert.deepEqual(paneRows(host.section('Watch')), [['main', '0', 'local'], ['add', '3', 'arg']]);
    assert.deepEqual(suggested.at(-1), ['total']); // the input's suggestion list follows the path

    // With a selection, the watch comes FIRST and the inspector's own sections follow intact.
    pane.update({
      label: 'add',
      value: { line: '(items=[1])', atEntry: false, args: [{ name: 'items', value: '[1]', ref: 4 }] },
      children: new Map(),
    });
    assert.deepEqual(host.headings(),
      ['Watch: total', 'History: total', 'Arguments', 'Local variables', 'Return value']);

    // Open the argument's twisty, then re-render the watch: the disclosure must stay open.
    const twisty = host.section('Arguments')!.children.find(child => child.className === 'pane-row')!
      .children.find(child => child.className === 'pane-twisty')!;
    twisty.clicks[0]();
    assert.deepEqual(requested, [4]);
    const opened = () => host.section('Arguments')!.children
      .some(row => row.children.some(cell => cell.attributes['aria-expanded'] === 'true'));
    assert.equal(opened(), true);
    pane.setWatch('total', [...frames, { id: 'deep', label: 'deep' }]);
    assert.equal(opened(), true, 'a watch refresh must not collapse the inspector');
    assert.deepEqual(paneRows(host.section('Watch')).at(-1), ['deep', 'not recorded']);

    // An empty name takes the section away entirely: the pane is exactly what it was before.
    pane.setWatch('', frames);
    assert.deepEqual(host.headings(), ['Arguments', 'Local variables', 'Return value']);
  }],
  // --- end watch variable ---
  // --- variable history ---
  ['history: one entry per change, collapsing consecutive steps with the same value AND node', () => {
    const at = (node: string, value: string, time: number): HistoryStep => ({
      path: ['main', node], reason: 'step', time, session: 'Run',
      values: { [node]: { args: [{ name: 'n', value }], locals: [] } },
    });
    const model = valueHistoryModel('n', [
      at('fact', '3', 10), at('fact', '3', 20), at('fact', '3', 30), // one run: n did not change
      at('fact', '2', 40),
      at('other', '2', 50), // same value, different node: a different fact, so a new entry
      at('fact', '2', 60),
    ], id => id);
    assert.deepEqual(model.rows.map(r => r.kind === 'value' ? [r.label, r.value, r.index, r.lastIndex, r.steps] : r.kind), [
      ['fact', '3', 0, 2, 3],
      ['fact', '2', 3, 3, 1],
      ['other', '2', 4, 4, 1],
      ['fact', '2', 5, 5, 1],
    ]);
    assert.equal(model.hits, 6);   // every step had a value
    assert.equal(model.changes, 4); // but only four of them were changes
    assert.equal(model.total, 6);
    assert.equal(model.note, 'n had a value at 6 of 6 recorded steps · 4 changes.');
  }],
  ['history: steps without a value are omitted as rows but reported as gaps', () => {
    const withValue = (value: string): HistoryStep => ({
      path: ['f'], reason: 'step', time: 0, session: 'Run',
      values: { f: { args: [{ name: 'n', value }], locals: [] } },
    });
    const absent: HistoryStep = { // captured, but the name is not there
      path: ['f'], reason: 'step', time: 0, session: 'Run',
      values: { f: { args: [{ name: 'other', value: '1' }], locals: [] } },
    };
    const unrecorded: HistoryStep = { path: ['f'], reason: 'step', time: 0, session: 'Run' }; // no values at all
    const model = valueHistoryModel('n', [
      withValue('1'), absent, unrecorded, absent, withValue('1'), unrecorded,
    ], id => id);
    // The two sides of a gap mean different things and are counted apart.
    assert.deepEqual(model.rows.map(r => r.kind === 'value' ? ['value', r.value] : ['gap', r.steps, r.unrecorded]), [
      ['value', '1'],
      ['gap', 3, 1],
      ['value', '1'], // the gap broke the run, so the same value is a new entry, not a collapse
    ]);
    assert.equal(model.hits, 2);
    assert.equal(model.unrecorded, 2); // including the trailing one
    assert.equal(model.note, 'n had a value at 2 of 6 recorded steps · 2 recorded no variables.');
  }],
  ['history: a trailing gap is not a row, and the innermost matching node wins', () => {
    const deep: HistoryStep = {
      // Outer caller first: main -> mid -> inner. The name is in two frames; the inner one answers.
      path: ['main', 'mid', 'inner'], reason: 'step', time: 5, session: 'Run',
      values: {
        main: { args: [{ name: 'n', value: 'outer' }], locals: [] },
        inner: { args: [], locals: [{ name: 'n', value: 'innermost' }] },
      },
    };
    const model = valueHistoryModel('n', [deep, { path: ['main'], reason: 'step', time: 9, session: 'Run' }],
      id => id.toUpperCase());
    assert.equal(model.rows.length, 1); // the trailing valueless step adds no gap row
    const entry = model.rows[0];
    assert.equal(entry.kind === 'value' && entry.value, 'innermost');
    assert.equal(entry.kind === 'value' && entry.nodeId, 'inner');
    assert.equal(entry.kind === 'value' && entry.origin, 'local');
    assert.equal(entry.kind === 'value' && entry.label, 'INNER'); // named by labelOf, not by step.where
    assert.equal(entry.kind === 'value' && entry.time, 5);
  }],
  ['history: shares the watch name matching, stars and case included', () => {
    const step = (name: string, value: string): HistoryStep => ({
      path: ['f'], reason: 'step', time: 0, session: 'Run',
      values: { f: { args: [{ name, value }], locals: [] } },
    });
    // resolveName is the single implementation, so *args behaves exactly as it does in the watch.
    assert.equal(valueHistoryModel('args', [step('*args', '(1,)')], id => id).hits, 1);
    assert.equal(valueHistoryModel('*args', [step('*args', '(1,)')], id => id).hits, 1);
    assert.equal(valueHistoryModel('kwargs', [step('**kwargs', '{}')], id => id).hits, 1);
    assert.equal(valueHistoryModel('Total', [step('total', '1')], id => id).hits, 0);
    // The same lookup through the watch agrees, which is the point of sharing resolveName.
    assert.equal(resolveName({ args: [{ name: '*args', value: '(1,)' }] }, 'args').value, '(1,)');
    assert.equal(resolveName({ args: [{ name: 'total', value: '1' }] }, 'Total').miss, 'not-present');
  }],
  ['history: messages when nothing is typed, nothing recorded, or nothing captured', () => {
    const step: HistoryStep = {
      path: ['f'], reason: 'step', time: 0, session: 'Run',
      values: { f: { args: [{ name: 'n', value: '1' }], locals: [] } },
    };
    assert.match(valueHistoryModel('  ', [step]).message!, /Type a variable name/);
    // History-only: while recording, the message carries no steps, so this is the empty case.
    assert.match(valueHistoryModel('n', []).message!, /No recorded session yet/);
    assert.equal(valueHistoryModel('n', []).rows.length, 0);
    // A whole session that recorded no variables says so, rather than blaming the name.
    const blind: HistoryStep = { path: ['f'], reason: 'step', time: 0, session: 'Run' };
    assert.match(valueHistoryModel('n', [blind, blind]).note!, /No variables were recorded for this session/);
    // Recorded, but the name is nowhere.
    assert.equal(valueHistoryModel('zzz', [step], id => id).note, 'zzz had no value at any of 1 recorded step.');
  }],
  ['history: entries past the cap are counted, not drawn', () => {
    const steps: HistoryStep[] = Array.from({ length: MAX_HISTORY_ROWS + 25 }, (_, i) => ({
      path: ['f'], reason: 'step', time: i, session: 'Run',
      values: { f: { args: [{ name: 'n', value: String(i) }], locals: [] } }, // a change every step
    }));
    const model = valueHistoryModel('n', steps, id => id);
    assert.equal(model.rows.length, MAX_HISTORY_ROWS);
    assert.equal(model.changes, MAX_HISTORY_ROWS + 25);
    assert.equal(model.more, 25);
    // The kept rows are the earliest, so the run reads from its start.
    assert.equal(model.rows[0].kind === 'value' && model.rows[0].value, '0');
  }],
  ['history: the section renders rows and gaps, and clicking a row picks that step', () => {
    const host = new PaneEl();
    const picked: number[] = [];
    const pane = new VariablePane(host as unknown as HTMLElement, new PaneEl() as unknown as HTMLElement, {
      requestChildren: () => {},
      historyStepPicked: index => picked.push(index),
      labelOf: id => id.toUpperCase(),
    });
    const hit = (value: string): HistoryStep => ({
      path: ['f'], reason: 'step', time: 0, session: 'Run',
      values: { f: { args: [{ name: 'n', value }], locals: [] } },
    });
    const blank: HistoryStep = { path: ['f'], reason: 'step', time: 0, session: 'Run' };

    // Nothing recorded yet: the section still appears, with the scrubber's kind of message.
    pane.setWatch('n', []);
    pane.setHistory([]);
    assert.deepEqual(host.headings(), ['Watch: n', 'History: n']);
    assert.match(host.section('History')!.children[1].textContent, /No recorded session yet/);

    pane.setHistory([hit('1'), hit('1'), blank, hit('2')]);
    const section = host.section('History')!;
    // Two collapsed steps, a gap marker, then the change. The step numbers are 1-based.
    assert.deepEqual(paneRows(section), [['1-2', 'F', '1'], ['4', 'F', '2']]);
    const gaps = section.children.filter(child => child.className.includes('vhistory-gap'));
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].textContent, /1 step.* recorded no variables/);

    // Clicking a row reports the FIRST step of its run, which is where a jump should land.
    const rows = section.children.filter(child => child.className.includes('vhistory-row'));
    assert.equal(rows[0].tag, 'button'); // a real control, so it is keyboard reachable
    assert.equal(rows[0].dataset.step, '0');
    rows[0].clicks[0]();
    rows[1].clicks[0]();
    assert.deepEqual(picked, [0, 3]);

    // Clearing the name takes both sections away together.
    pane.setWatch('', []);
    assert.deepEqual(host.headings(), []);
  }],
  // --- end variable history ---


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
