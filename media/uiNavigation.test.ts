import * as assert from 'node:assert/strict';
import type { Core } from 'cytoscape';
import type { GraphData } from '../src/types';
import type { GraphRenderer } from './graph';
import { graphPaths } from './graphPaths';
import { NodePills } from './nodePills';

function graph(ids: string[], edges: string[][], targets = ['t']): GraphData {
  return { targetIds: targets, nodes: ids.map(id => ({ id, label: id, file: `${id}.py`, line: 1, endLine: 2 })),
    edges: edges.map(([from, to]) => ({ from, to, lines: [1] })) };
}

class Element {
  children: Element[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  hidden = true;
  parent?: Element;
  ownerDocument = { createElement: () => new Element() };
  appendChild(child: Element): Element { child.parent = this; this.children.push(child); return child; }
  replaceChildren(): void { this.children = []; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
}

export const uiNavigationCases: [string, (cy: Core, renderer: GraphRenderer) => void][] = [
  ['path browser enumerates branches once, ignores dangling edges, and stops at targets', () => {
    const data = graph(['root', 'a', 'b', 't', 'after', 'island'],
      [['root', 'a'], ['root', 'a'], ['root', 'b'], ['a', 't'], ['b', 't'], ['t', 'after'], ['missing', 't']]);
    assert.deepEqual(graphPaths(data, new Set(['t'])), { paths: [['root', 'a', 't'], ['root', 'b', 't']], limited: false });
    data.nodes.find(node => node.id === 'a')!.noise = true;
    assert.deepEqual(graphPaths(data, new Set(['t'])).paths, [['root', 'b', 't']]);
    assert.equal(graphPaths(data, new Set(['t']), true).paths.length, 2);
    assert.deepEqual(graphPaths(data, new Set()), { paths: [], limited: false });
  }],
  ['path browser handles root cycles and terminates on bounded branching and long chains', () => {
    const cycle = graph(['a', 'b', 't'], [['a', 'b'], ['b', 'a'], ['b', 't'], ['a', 'a']]);
    assert.deepEqual(graphPaths(cycle, new Set(['t'])).paths, [['a', 'b', 't'], ['b', 't']]);
    const branches = graph(['root', 'a', 'b', 't'], [['root', 'a'], ['root', 'b'], ['a', 't'], ['b', 't']]);
    assert.deepEqual(graphPaths(branches, new Set(['t']), false, 1), { paths: [['root', 'a', 't']], limited: true });
    assert.equal(graphPaths(branches, new Set(['t']), false, 500, 1).limited, true);
    const ids = [...Array.from({ length: 1500 }, (_, i) => `n${i}`), 't'];
    assert.equal(graphPaths(graph(ids, ids.slice(1).map((id, i) => [ids[i], id])), new Set(['t'])).paths[0].length, ids.length);
  }],
  ['source path browsing preserves the debug location and new debug messages restore runtime highlighting', (cy, renderer) => {
    renderer.renderGraph(graph(['root', 'a', 'b', 't'], [['root', 'a'], ['root', 'b'], ['a', 't'], ['b', 't']]));
    renderer.highlightPath(['root', 'a']);
    renderer.previewPath(['root', 'b', 't']);
    assert.equal(cy.$id('a').hasClass('current'), true);
    assert.equal(cy.$id('a').hasClass('dimmed'), false);
    assert.equal(cy.$id('t').hasClass('current'), false);
    assert.deepEqual(cy.nodes('.path').map(node => node.id()).sort(), ['b', 'root', 't']);
    renderer.previewPath();
    assert.deepEqual(cy.nodes('.path').map(node => node.id()).sort(), ['a', 'root']);
    renderer.previewPath(['root', 'b', 't']);
    renderer.highlightPath(['root', 'b']);
    assert.deepEqual(cy.nodes('.path').map(node => node.id()).sort(), ['b', 'root']);
    renderer.clearDebugPath();
    renderer.previewPath(['root', 'b', 't']);
    assert.equal(cy.nodes('.current').length, 0);
  }],
  ['search suggestions pick an exact function ID and preserve match cycling', (cy, renderer) => {
    renderer.renderGraph({ ...graph(['a', 'b', 't'], []),
      nodes: graph(['a', 'b', 't'], []).nodes.map(node => ({ ...node, label: 'sum' })) });
    renderer.search.find('sum');
    assert.deepEqual(renderer.search.results().map(node => node.id), ['a', 'b', 't']);
    assert.equal(renderer.search.choose('b').node?.id, 'b');
    assert.equal(renderer.search.move(1).node?.id, 't');
    assert.equal(renderer.search.choose('unknown').node?.id, 't');
  }],
  ['node pills compose target and current status, track viewport and visibility, and dispose cleanly', (cy, renderer) => {
    const host = new Element();
    const frames = new Map<number, FrameRequestCallback>();
    let frame = 0;
    const previousRequest = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
    globalThis.cancelAnimationFrame = id => { frames.delete(id); };
    const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
    const pills = new NodePills(cy, host as unknown as HTMLElement);
    try {
      renderer.highlightPath(['root', 'a', 't']);
      flush();
      assert.equal(host.children.length, 1);
      const group = host.children[0];
      assert.deepEqual(group.children.map(child => child.textContent), ['Target', 'You are Here']);
      assert.equal(cy.$id('t').style('label'), 't');
      const before = { ...group.style };
      cy.zoom(1.5); cy.pan({ x: 50, y: 30 }); cy.$id('t').position({ x: 700, y: 800 });
      assert.equal(frames.size, 1); flush();
      assert.notDeepEqual(group.style, before);
      assert.equal(group.style.left, `${cy.$id('t').renderedPosition().x - cy.$id('t').renderedWidth() / 2 + 15}px`);
      assert.equal(group.style.transform, 'scale(1.5) translateY(-50%)');
      renderer.clearDebugPath(); flush();
      assert.deepEqual(group.children.map(child => child.textContent), ['Target']);
      cy.$id('t').style('display', 'none'); flush();
      assert.equal(host.children.length, 0);
      cy.$id('t').style('display', 'element'); flush();
      assert.equal(host.children.length, 1);
      pills.dispose();
      assert.equal(host.children.length, 0);
      assert.equal(frames.size, 0);
      assert.equal(host.hidden, true);
    } finally {
      pills.dispose();
      globalThis.requestAnimationFrame = previousRequest;
      globalThis.cancelAnimationFrame = previousCancel;
    }
  }],
];
