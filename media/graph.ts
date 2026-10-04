import cytoscape, { type Core, type ElementDefinition, type Layouts, type NodeSingular, type StylesheetJson } from 'cytoscape';
import cola from 'cytoscape-cola';
import { GraphSearch, type SearchState } from './graphSearch';
import { heatColor, heatPalette, heatPosition, type HeatRange } from './heatmap';
import { fileName } from '../src/webview/filePath';
import { edgeRoute, targetLayout, NODE_HEIGHT, NODE_WIDTH, type TargetLayout } from '../src/webview/targetLayout';
import type { CallValue, CallValues, DebugPath, GraphData, GraphMessage, GraphNode, HotCounts, WebviewMessage } from '../src/types';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

cytoscape.use(cola);

type LayoutMode = 'trace' | 'explore';

export const layoutOptions = {
  name: 'preset' as const,
  padding: 80,
  animate: false,
};

const nodeLabel = (node: NodeSingular): string => [
  node.data('label'),
  ...(node.data('callArgs') ? [node.data('callArgs') as string] : []), // call values feature
  ...(node.hasClass('target') ? ['Target'] : []),
  ...(node.hasClass('current') ? ['You are here'] : []),
].join('\n');

export function graphStyles(foreground = '#d4d4d4', background = '#252526'): StylesheetJson {
  const palette = heatPalette(foreground);
  return [
    {
      selector: 'node',
      style: {
        label: nodeLabel,
        shape: 'round-rectangle',
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        'background-color': background,
        'border-color': '#5d8db5',
        'border-width': 2,
        color: foreground,
        'font-size': '14px',
        'font-weight': 'bold',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': `${NODE_WIDTH - 20}px`,
        'overlay-opacity': 0,
      },
    },
    // --- call values feature --- smaller text so the args line fits the fixed node box
    {
      selector: 'node.has-args',
      style: { 'font-size': '12px', 'text-overflow-wrap': 'anywhere' },
    },
    // --- end call values feature ---
    {
      // Heat changes only the fill; borders, halos, opacity and search overlays still compose.
      selector: 'node.heat-counted',
      style: { 'background-color': (node: NodeSingular) => heatColor(node.data('heatPosition'), palette) },
    },
    {
      selector: 'node.target',
      style: {
        'border-color': '#c586c0', 'border-width': 3,
        'underlay-color': '#c586c0', 'underlay-opacity': 0.15, 'underlay-padding': 8,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'curve-style': 'bezier',
        'line-color': '#8196aa',
        'target-arrow-color': '#8196aa',
        'target-arrow-shape': 'triangle',
        'source-arrow-shape': 'none',
        'arrow-scale': 1.3,
        'overlay-opacity': 0,
      },
    },
    {
      selector: 'edge:loop',
      style: { 'control-point-step-size': 110, 'loop-direction': '90deg', 'loop-sweep': '-75deg' },
    },
    {
      selector: 'edge.same-row',
      style: {
        'curve-style': 'unbundled-bezier',
        'control-point-distances': 'data(controlDistances)',
        'control-point-weights': 'data(controlWeights)',
        'edge-distances': 'node-position',
      },
    },
    {
      selector: 'edge.detour',
      style: {
        'curve-style': 'bezier',
        'line-style': 'dashed',
        width: 1.5,
        opacity: 0.35,
        'line-color': '#8196aa',
        'target-arrow-color': '#8196aa',
      },
    },
    {
      selector: '.dimmed',
      style: { opacity: 0.2 },
    },
    {
      selector: 'node.path',
      style: { 'border-color': '#4fc1ff', 'border-width': 3 },
    },
    {
      selector: 'edge.path',
      style: { width: 4, 'line-color': '#4fc1ff', 'target-arrow-color': '#4fc1ff' },
    },
    {
      selector: 'node.current',
      style: {
        'border-color': '#e5c07b',
        'border-width': 5,
        'border-style': 'double',
      },
    },
    {
      selector: 'node:selected',
      style: { 'underlay-color': '#4fc1ff', 'underlay-opacity': 0.2, 'underlay-padding': 8 },
    },
    {
      selector: 'node.hover-faded',
      style: { opacity: 0.4 },
    },
    {
      selector: 'edge.hover-faded',
      style: { opacity: 0.08 },
    },
    {
      selector: 'node.hover-neighbor, node.hovered',
      style: { opacity: 1 },
    },
    {
      selector: 'node.hovered',
      style: { 'underlay-color': '#b5cea8', 'underlay-opacity': 0.3, 'underlay-padding': 10 },
    },
    {
      selector: 'edge.hover-in',
      style: { 'line-color': '#b5cea8', 'target-arrow-color': '#b5cea8' },
    },
    {
      selector: 'edge.hover-out',
      style: { 'line-color': '#ce9178', 'target-arrow-color': '#ce9178' },
    },
    {
      selector: 'edge.path.hover-in, edge.path.hover-out',
      style: { 'line-color': '#4fc1ff', 'target-arrow-color': '#4fc1ff' },
    },
    {
      selector: 'edge.hover-in, edge.hover-out',
      style: { opacity: 1, width: 5, 'arrow-scale': 1.6, 'z-index': 10 },
    },
    {
      selector: 'node.search-hit',
      style: {
        opacity: 1,
        'overlay-color': '#4fc1ff', 'overlay-opacity': 0.25, 'overlay-padding': 12,
      },
    },
    {
      selector: '.noise-hidden',
      style: { display: 'none' },
    },
  ];
}

export class GraphRenderer {
  private path: DebugPath = [];
  private hotCounts = new Map<string, number>();
  public heatRange: HeatRange | undefined;
  private hoveredId: string | undefined;
  private showNoise = false;
  private mode: LayoutMode = 'trace';
  private exploreLayout?: Layouts;
  private staticPositions = new Map<string, { x: number; y: number }>();
  public layout: TargetLayout | undefined;
  public readonly search: GraphSearch;
  // --- call values feature ---
  private callValues: CallValues = {};

  public callValue(id: string): CallValue | undefined {
    return Object.prototype.hasOwnProperty.call(this.callValues, id) ? this.callValues[id] : undefined;
  }

  /** Puts each node's args line ("sum(a=3, b=4)") under its name; nodes without values get none. */
  public setCallValues(values: CallValues): void {
    this.callValues = { ...values };
    this.applyCallValues();
  }

  private applyCallValues(): void {
    this.cy.batch(() => this.cy.nodes().forEach(node => {
      const line = this.callValue(node.id())?.line;
      if (line) {
        node.data('callArgs', line).addClass('has-args');
      } else {
        node.removeData('callArgs').removeClass('has-args');
      }
    }));
  }
  // --- end call values feature ---

  constructor(
    private readonly cy: Core,
    private readonly graphRendered: (nodeCount: number) => void = () => {},
    private readonly pathChanged: (current: GraphNode | undefined, active: boolean) => void = () => {},
    searchChanged: (state: SearchState) => void = () => {},
    private readonly heatChanged: (range: HeatRange | undefined) => void = () => {},
    private readonly visibilityChanged: (nodeCount: number) => void = () => {},
  ) {
    this.cy.autoungrabify(true);
    this.search = new GraphSearch(cy, searchChanged);
  }

  public get layoutMode(): LayoutMode {
    return this.mode;
  }

  public get visibleNodeCount(): number {
    return this.cy.nodes(':visible').length;
  }

  public setShowNoise(show: boolean): void {
    if (this.showNoise === show) return;
    this.showNoise = show;
    this.cy.batch(() => this.applyNoiseVisibility());
    // Class styles are lazy; resolve them before querying cached visibility for search and counts.
    this.cy.elements().forEach(element => element.style('display'));
    if (this.hoveredId !== undefined && this.cy.getElementById(this.hoveredId).hidden()) {
      this.hoverNode();
    }
    this.search.refresh();
    this.visibilityChanged(this.visibleNodeCount);
  }

  private applyNoiseVisibility(): void {
    this.cy.elements().removeClass('noise-hidden');
    if (this.showNoise) return;
    const noise = this.cy.nodes().filter(node => node.data('noise') === true);
    noise.addClass('noise-hidden');
    noise.connectedEdges().addClass('noise-hidden');
  }

  public setLayoutMode(mode: LayoutMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.applyLayoutMode();
  }

  private applyLayoutMode(): void {
    this.stopExploreLayout();
    this.cy.autoungrabify(this.mode === 'trace');

    const nodes = this.cy.nodes();
    nodes.unlock();

    if (!nodes.length) return;

    if (this.mode === 'explore') {
      this.startExploreLayout();
    } else {
      this.cy.layout({
        ...layoutOptions,
        positions: Object.fromEntries(this.staticPositions),
      }).run();

      nodes
        .filter(node => this.layout?.pinnedIds.has(node.id()) ?? false)
        .lock();
    }
  }

  private startExploreLayout(): void {
    const options = {
      name: 'cola',
      animate: true,
      refresh: 1,
      randomize: false,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      nodeSpacing: () => 30,
      edgeLength: () => 100,
      ungrabifyWhileSimulating: false,
      fit: false,
      centerGraph: false,
      infinite: true,
    };
    this.exploreLayout = this.cy.layout(options);
    this.exploreLayout.run();
  }

  private stopExploreLayout(): void {
    this.exploreLayout?.stop();
    this.exploreLayout = undefined;
  }

  public dispose(): void {
    this.search.dispose();
    this.stopExploreLayout();
  }

  public renderGraph(graph: GraphData): void {
    this.search.clear();
    this.stopExploreLayout();
    this.hoveredId = undefined;
    this.layout = targetLayout(graph);
    const layout = this.layout;
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const elements: ElementDefinition[] = graph.nodes.map(node => ({
      group: 'nodes',
      data: { ...node, distance: layout.distances.get(node.id) },
      classes: layout.targetIds.has(node.id) ? 'target' : '',
      position: layout.positions.get(node.id),
      locked: layout.pinnedIds.has(node.id),
    }));
    graph.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        return;
      }
      let edgeId = `pathfind-edge-${index}`;
      while (nodeIds.has(edgeId)) {
        edgeId = `_${edgeId}`;
      }
      const route = edgeRoute(edge.from, edge.to, layout, index);
      elements.push({
        group: 'edges',
        data: {
          ...edge, id: edgeId, source: edge.from, target: edge.to,
          controlDistances: route.controlDistances,
          controlWeights: route.controlWeights ?? [0.5],
        },
        classes: route.kind === 'normal' ? '' : route.kind,
      });
    });

    this.cy.batch(() => {
      this.cy.elements().remove();
      this.cy.add(elements);
      this.applyNoiseVisibility();
    });
    if (this.cy.nodes().length) {
      this.cy.layout({
        ...layoutOptions, positions: Object.fromEntries(layout.positions),
      }).run();
    }
    // Copy coordinates before Explore can move them or the user can drag nodes.
    this.staticPositions = new Map(this.cy.nodes().map(node => [node.id(), { ...node.position() }]));
    if (this.mode === 'explore') this.applyLayoutMode();
    this.applyCallValues(); // call values feature
    this.highlightPath(this.path);
    this.applyHotCounts();
    this.graphRendered(this.visibleNodeCount);
  }

  public setHotCounts(counts: HotCounts): void {
    // Messages contain full cumulative snapshots, not deltas. Retain IDs received before a graph.
    this.hotCounts = new Map(Object.entries(counts).filter(([, count]) => Number.isSafeInteger(count) && count > 0));
    this.applyHotCounts();
  }

  public getHotCount(id: string): number | undefined {
    return this.hotCounts.get(id);
  }

  private applyHotCounts(): void {
    const counted: { node: NodeSingular; count: number }[] = [];
    let min = Infinity;
    let max = 0;
    for (const [id, count] of this.hotCounts) {
      const node = this.cy.getElementById(id);
      if (!node.isNode()) continue;
      counted.push({ node, count });
      min = Math.min(min, count);
      max = Math.max(max, count);
    }
    const range = counted.length ? { min, max } : undefined;
    this.heatRange = range;
    this.cy.batch(() => {
      this.cy.nodes().removeClass('heat-counted').removeData('heatPosition');
      if (range) {
        for (const { node, count } of counted) {
          node.data('heatPosition', heatPosition(count, range)).addClass('heat-counted');
        }
      }
    });
    this.heatChanged(range);
  }

  public highlightPath(path: DebugPath): void {
    this.path = [...path];
    const pathIds = new Set(path);
    const pathNodes = this.cy.nodes().filter(node => pathIds.has(node.id()));
    const pathEdges = new Set(path.slice(1).map((id, index) => JSON.stringify([path[index], id])));

    this.cy.batch(() => {
      this.cy.elements().removeClass('dimmed path current');
      if (pathNodes.length) {
        this.cy.elements().addClass('dimmed');
        pathNodes.removeClass('dimmed').addClass('path');
        this.cy.edges().filter(edge => pathEdges.has(JSON.stringify([
          edge.data('source'), edge.data('target'),
        ]))).removeClass('dimmed').addClass('path');
      }
      if (path.length) {
        const current = this.cy.getElementById(path[path.length - 1]);
        if (current.isNode()) {
          current.addClass('current');
        }
      }
      this.applyHover();
    });

    const current = path.length ? this.cy.getElementById(path[path.length - 1]) : undefined;
    this.pathChanged(current?.isNode() ? current.data() as GraphNode : undefined, path.length > 0);
  }

  public clearDebugPath(): void {
    this.highlightPath([]);
  }

  public hoverNode(id?: string): void {
    const node = id === undefined ? undefined : this.cy.getElementById(id);
    const nextId = node?.isNode() && node.visible() ? id : undefined;
    if (this.hoveredId === nextId) return;
    this.hoveredId = nextId;
    this.cy.batch(() => this.applyHover());
  }

  private applyHover(): void {
    this.cy.elements().removeClass('hover-faded hover-neighbor hovered hover-in hover-out');
    if (this.hoveredId === undefined) return;
    const node = this.cy.getElementById(this.hoveredId);
    if (!node.isNode() || node.hidden()) return;
    const connections = node.connectedEdges();
    this.cy.elements().addClass('hover-faded');
    connections.connectedNodes().removeClass('hover-faded').addClass('hover-neighbor');
    node.removeClass('hover-faded').addClass('hovered');
    connections.removeClass('hover-faded');
    connections.filter(edge => edge.target().id() === node.id()).addClass('hover-in');
    connections.filter(edge => edge.source().id() === node.id()).addClass('hover-out');
  }
}

export function initializeGraphWebview(): void {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('graph')!;
  const empty = document.getElementById('empty')!;
  const runtime = document.getElementById('runtime')!;
  const selection = document.getElementById('selection')!;
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchCount = document.getElementById('search-count')!;
  const searchStatus = document.getElementById('search-status')!;
  const searchPrevious = document.getElementById('search-previous') as HTMLButtonElement;
  const searchNext = document.getElementById('search-next') as HTMLButtonElement;
  const showNoise = document.getElementById('show-noise') as HTMLInputElement;
  const theme = getComputedStyle(document.body);
  const foreground = theme.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4';
  const palette = heatPalette(foreground);
  const heatLegend = document.getElementById('heat-legend')!;
  const heatScale = document.getElementById('heat-scale')!;
  const heatLow = document.getElementById('heat-low')!;
  const heatHigh = document.getElementById('heat-high')!;
  const heatNote = document.getElementById('heat-note')!;
  let tooltipNodeId: string | undefined;
  let tooltipPosition: { x: number; y: number } | undefined;
  const cy = cytoscape({
    container,
    elements: [],
    style: graphStyles(
      foreground,
      theme.getPropertyValue('--vscode-sideBar-background').trim() || '#252526',
    ),
    layout: { name: 'preset' },
    minZoom: 0.05,
    maxZoom: 3,
  });
  const updateEmpty = (count: number) => {
    empty.hidden = count > 0;
    empty.textContent = cy.nodes().length && !count
      ? 'Noise functions are hidden. Enable Show Noise to display them.'
      : 'No functions in this graph';
  };
  const renderer = new GraphRenderer(cy, count => {
    updateEmpty(count);
    selection.textContent = 'Click a function to see its source location';
    searchInput.value = '';
    renderLayoutLabels();
  }, (current, active) => {
    runtime.textContent = current
      ? `You are here: ${current.label} · ${fileName(current.file)}:${current.line}`
      : active ? 'Current function is outside this graph' : 'No runtime path';
  }, state => {
    searchCount.textContent = state.count ? `${state.index + 1} of ${state.count}` : 'No results';
    searchCount.hidden = !state.query;
    searchPrevious.disabled = searchNext.disabled = state.count === 0;
    searchInput.setAttribute('aria-invalid', String(!!state.query && state.count === 0));
    searchStatus.textContent = state.node
      ? `${state.node.label} — ${fileName(state.node.file)}:${state.node.line}`
      : state.query ? 'No matching functions' : 'Enter a function name';
    searchStatus.title = state.node ? `${state.node.file}:${state.node.line}` : '';
  }, range => {
    heatLegend.hidden = !range;
    if (range) {
      const equal = range.min === range.max;
      heatLow.textContent = `${range.min.toLocaleString()}${equal ? ' calls' : ' (blue)'}`;
      heatHigh.textContent = equal ? 'Midpoint color' : `${range.max.toLocaleString()} (red)`;
      heatScale.style.background = equal
        ? heatColor(0.5, palette)
        : `linear-gradient(to right, ${heatColor(0, palette)}, ${heatColor(1, palette)})`;
      heatScale.setAttribute('aria-label', equal
        ? `All recorded functions have ${range.min} calls; midpoint color`
        : `${range.min} calls in blue to ${range.max} calls in red`);
      heatNote.textContent = equal
        ? 'Equal counts use the midpoint color.'
        : 'Linear scale for this graph; colors rescale as counts change.';
    }
    if (tooltipNodeId !== undefined) refreshTooltipCount();
  }, updateEmpty);

  searchInput.addEventListener('input', () => renderer.search.find(searchInput.value));
  document.getElementById('search-form')!.addEventListener('submit', event => {
    event.preventDefault();
    renderer.search.move(1);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      renderer.search.move(-1);
    } else if (event.key === 'Escape') {
      searchInput.value = '';
      renderer.search.clear();
    }
  });
  searchPrevious.addEventListener('click', () => renderer.search.move(-1));
  searchNext.addEventListener('click', () => renderer.search.move(1));

  const layoutLabels = document.getElementById('layout-labels')!;
  const renderLayoutLabels = () => {
    layoutLabels.replaceChildren();
    if (renderer.layoutMode === 'explore') return;
    const zoom = cy.zoom();
    const pan = cy.pan();
    for (const annotation of renderer.layout?.annotations ?? []) {
      const label = layoutLabels.appendChild(document.createElement('span'));
      label.textContent = annotation.label;
      label.style.left = `${annotation.x * zoom + pan.x}px`;
      label.style.top = `${annotation.y * zoom + pan.y}px`;
      label.style.fontSize = `${Math.max(9, Math.min(13, 12 * zoom))}px`;
      label.hidden = zoom < 0.25;
    }
  };
  cy.on('viewport resize', renderLayoutLabels);
  const layoutMode = document.getElementById('layout-mode') as HTMLSelectElement;
  layoutMode.addEventListener('change', () => {
    renderer.setLayoutMode(layoutMode.value === 'explore' ? 'explore' : 'trace');
    renderLayoutLabels();
  });

  cy.on('tap', 'node', event => {
    const node = event.target.data() as GraphNode;
    selection.textContent = `${node.label} · ${fileName(node.file)}:${node.line}`;
    selection.title = node.file;
    vscode.postMessage({ type: 'nodeClicked', id: node.id, file: node.file, line: node.line });
  });

  // --- hover tooltip feature ---
  // Positioned in the coordinate space of <main> (which #graph fills exactly), so
  // Cytoscape's rendered coordinates can be used directly as CSS offsets.
  const tooltipHost = container.parentElement!;
  const tooltip = document.createElement('div');
  tooltip.id = 'node-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const tooltipName = tooltip.appendChild(document.createElement('div'));
  tooltipName.className = 'tooltip-name';
  const tooltipFile = tooltip.appendChild(document.createElement('div'));
  const tooltipLines = tooltip.appendChild(document.createElement('div'));
  tooltipLines.className = 'tooltip-lines';
  const tooltipConnections = tooltip.appendChild(document.createElement('div'));
  const tooltipDistance = tooltip.appendChild(document.createElement('div'));
  const tooltipCalls = tooltip.appendChild(document.createElement('div'));
  // --- call values feature ---
  const tooltipArgs = tooltip.appendChild(document.createElement('div'));
  tooltipArgs.className = 'tooltip-args';
  const renderTooltipArgs = (value: CallValue | undefined) => {
    tooltipArgs.replaceChildren();
    tooltipArgs.hidden = !value;
    if (!value) {
      return;
    }
    const heading = tooltipArgs.appendChild(document.createElement('div'));
    heading.className = 'tooltip-args-heading';
    heading.textContent = value.atEntry
      ? 'Arguments (paused on first line: as passed)'
      : 'Arguments (value at pause: may have been reassigned since the call)';
    if (!value.args.length) {
      tooltipArgs.appendChild(document.createElement('div')).textContent = '(no parameters)';
    }
    for (const arg of value.args) {
      const row = tooltipArgs.appendChild(document.createElement('div'));
      row.className = 'tooltip-arg';
      row.textContent = arg.value === undefined ? `${arg.name} = (not in locals)` : `${arg.name} = ${arg.value}`;
    }
    const notes = [
      ...(value.more ? [`+${value.more} more ${value.more === 1 ? 'call' : 'calls'} of this function on the stack (showing the innermost)`] : []),
      ...(value.stale ? ['Program has resumed: last values seen at the previous pause'] : []),
    ];
    for (const note of notes) {
      const row = tooltipArgs.appendChild(document.createElement('div'));
      row.className = 'tooltip-lines';
      row.textContent = note;
    }
  };
  // --- end call values feature ---
  tooltipHost.appendChild(tooltip);
  const refreshTooltipCount = () => {
    const count = tooltipNodeId === undefined ? undefined : renderer.getHotCount(tooltipNodeId);
    tooltipCalls.textContent = count === undefined ? 'No recorded calls' : `Recorded calls this session: ${count.toLocaleString()}`;
    if (!tooltip.hidden && tooltipPosition) moveTooltip(tooltipPosition.x, tooltipPosition.y);
  };

  const TOOLTIP_OFFSET = 14;
  const TOOLTIP_MARGIN = 6;
  const moveTooltip = (x: number, y: number) => {
    const maxX = tooltipHost.clientWidth - tooltip.offsetWidth - TOOLTIP_MARGIN;
    const maxY = tooltipHost.clientHeight - tooltip.offsetHeight - TOOLTIP_MARGIN;
    // Prefer below-right of the cursor; flip to the other side when it would overflow.
    let left = x + TOOLTIP_OFFSET;
    let top = y + TOOLTIP_OFFSET;
    if (left > maxX) {
      left = x - TOOLTIP_OFFSET - tooltip.offsetWidth;
    }
    if (top > maxY) {
      top = y - TOOLTIP_OFFSET - tooltip.offsetHeight;
    }
    // Final clamp covers panels too small for either side.
    tooltip.style.left = `${Math.max(TOOLTIP_MARGIN, Math.min(left, maxX))}px`;
    tooltip.style.top = `${Math.max(TOOLTIP_MARGIN, Math.min(top, maxY))}px`;
  };
  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltipNodeId = undefined;
    tooltipPosition = undefined;
    renderer.hoverNode();
  };

  showNoise.addEventListener('change', () => {
    hideTooltip();
    renderer.setShowNoise(showNoise.checked);
  });

  cy.on('mouseover', 'node', event => {
    const node = event.target.data() as GraphNode;
    tooltipNodeId = node.id;
    tooltipPosition = { ...event.renderedPosition };
    refreshTooltipCount();
    renderer.hoverNode(node.id);
    tooltipName.textContent = node.label;
    tooltipFile.textContent = fileName(node.file);
    tooltipLines.textContent = node.endLine > node.line
      ? `lines ${node.line}–${node.endLine}`
      : `line ${node.line}`;
    const distance = renderer.layout?.distances.get(node.id);
    tooltipDistance.textContent = distance === undefined
      ? (renderer.layout?.targetIds.size ? 'No path to target' : 'No target identified')
      : renderer.layout?.targetIds.has(node.id) ? 'Selected target' : `Longest path depth: ${distance}`;
    const element = cy.getElementById(node.id);
    const callers = element.incomers('node').length;
    const callees = element.outgoers('node').length;
    tooltipConnections.textContent = `${callers} ${callers === 1 ? 'caller' : 'callers'} · ${callees} ${callees === 1 ? 'callee' : 'callees'}`;
    renderTooltipArgs(renderer.callValue(node.id)); // call values feature
    tooltip.hidden = false;
    moveTooltip(event.renderedPosition.x, event.renderedPosition.y);
  });
  cy.on('mousemove', 'node', event => {
    if (!tooltip.hidden) {
      tooltipPosition = { ...event.renderedPosition };
      moveTooltip(event.renderedPosition.x, event.renderedPosition.y);
    }
  });
  cy.on('mouseout', 'node', hideTooltip);
  // A node can vanish or move out from under a still cursor (new graph, pan, zoom, drag)
  // without Cytoscape firing mouseout, so hide on those too.
  cy.on('remove', 'node', hideTooltip);
  cy.on('viewport grab', hideTooltip);
  container.addEventListener('mouseleave', hideTooltip);
  // --- end hover tooltip feature ---

  // --- legend feature ---
  // The legend's swatch colors are read out of graphStyles() rather than repeated here,
  // so the legend can't drift from the real node/edge styles.
  const styleValue = (selector: string, property: string): string => {
    for (const block of graphStyles()) {
      if (block.selector === selector) {
        const value = ('style' in block ? block.style : block.css) as unknown as Record<string, unknown>;
        if (property in value) {
          return String(value[property]);
        }
      }
    }
    return '';
  };
  const legendColors: Record<string, string> = {
    '--pf-node-border': styleValue('node', 'border-color'),
    '--pf-path': styleValue('node.path', 'border-color'),
    '--pf-current': styleValue('node.current', 'border-color'),
    '--pf-dimmed': styleValue('.dimmed', 'opacity'),
    '--pf-edge': styleValue('edge', 'line-color'),
    '--pf-target': styleValue('node.target', 'border-color'),
    '--pf-hover-in': styleValue('edge.hover-in', 'line-color'),
    '--pf-hover-out': styleValue('edge.hover-out', 'line-color'),
  };
  for (const [name, value] of Object.entries(legendColors)) {
    document.documentElement.style.setProperty(name, value);
  }
  // --- end legend feature ---
  document.getElementById('fit')!.addEventListener('click', () => {
    if (renderer.visibleNodeCount) {
      cy.fit(cy.elements(':visible'), layoutOptions.padding);
    }
  });
  const observer = new ResizeObserver(() => cy.resize());
  observer.observe(container);
  window.addEventListener('message', (event: MessageEvent<GraphMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'graph':
        renderer.renderGraph(message.graph);
        break;
      case 'debugPath':
        renderer.highlightPath(message.path);
        break;
      case 'debugClear':
        renderer.clearDebugPath();
        break;
      case 'hotCounts':
        renderer.setHotCounts(message.counts);
        break;
      // --- call values feature ---
      case 'callValues':
        renderer.setCallValues(message.values);
        break;
      // --- end call values feature ---
    }
  });

  // --- breadcrumb feature ---
  // A second listener, registered after the renderer's, so the graph is already updated when
  // ids are resolved to labels. A new graph re-resolves the last path, like the renderer does.
  const breadcrumb = document.getElementById('breadcrumb')!;
  let breadcrumbPath: DebugPath = [];
  const renderBreadcrumb = () => {
    breadcrumb.replaceChildren();
    breadcrumb.hidden = breadcrumbPath.length === 0;
    // Any id that isn't a node in the graph (pathfinder-unmatched-frame-N placeholders, or ids
    // from a different graph) reads as "(outside graph)"; consecutive ones collapse into one crumb.
    const crumbs: { node?: GraphNode; count: number }[] = [];
    for (const id of breadcrumbPath) {
      const element = cy.getElementById(id);
      const node = element.length && element.isNode() ? element.data() as GraphNode : undefined;
      const previous = crumbs[crumbs.length - 1];
      if (!node && previous && !previous.node) {
        previous.count++;
      } else {
        crumbs.push({ node, count: 1 });
      }
    }
    crumbs.forEach(({ node, count }, index) => {
      if (index > 0) {
        const separator = breadcrumb.appendChild(document.createElement('span'));
        separator.className = 'crumb-sep';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '→';
      }
      const crumb = breadcrumb.appendChild(document.createElement('span'));
      crumb.className = node ? 'crumb' : 'crumb outside';
      crumb.textContent = node ? node.label : count > 1 ? `(outside graph ×${count})` : '(outside graph)';
      if (node) {
        crumb.title = `${node.file}:${node.line}`;
      }
      if (index === crumbs.length - 1) {
        crumb.classList.add('current');
        crumb.setAttribute('aria-current', 'location');
      }
    });
    // Long chains scroll horizontally; keep the current function in view.
    breadcrumb.scrollLeft = breadcrumb.scrollWidth;
  };
  window.addEventListener('message', (event: MessageEvent<GraphMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'debugPath') {
      breadcrumbPath = [...message.path];
    } else if (message.type === 'debugClear') {
      breadcrumbPath = [];
    } else if (message.type !== 'graph') {
      return;
    }
    renderBreadcrumb();
  });
  // --- end breadcrumb feature ---

  // --- copy path feature ---
  // The text is read from the rendered breadcrumb crumbs, so it is exactly what the breadcrumb shows
  // (same labels, same collapsed "(outside graph ×N)" crumbs). The extension writes the clipboard,
  // since clipboard access inside a webview is unreliable.
  const copyPathButton = document.getElementById('copy-path') as HTMLButtonElement;
  const syncCopyPathButton = () => {
    copyPathButton.disabled = breadcrumb.hidden;
  };
  copyPathButton.addEventListener('click', () => {
    const text = Array.from(breadcrumb.querySelectorAll('.crumb'), crumb => crumb.textContent ?? '').join(' → ');
    if (text) {
      vscode.postMessage({ type: 'copyPath', text });
    }
  });
  // Registered after the breadcrumb's listener, so the breadcrumb is already re-rendered here.
  window.addEventListener('message', syncCopyPathButton);
  syncCopyPathButton();
  // --- end copy path feature ---

  // --- replay feature ---
  // Replays the path by calling the renderer's own highlightPath on a growing prefix of it, so every
  // frame uses the existing path / current / dimmed styling. The last frame is the full path, which
  // leaves exactly the state a debugPath message produces.
  const REPLAY_STEP_MS = 500;
  const replayButton = document.getElementById('replay-path') as HTMLButtonElement;
  let replayPath: DebugPath = [];
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const stopReplay = () => {
    clearTimeout(replayTimer);
    replayTimer = undefined;
  };
  replayButton.addEventListener('click', () => {
    stopReplay(); // clicking while playing restarts from the beginning
    const path = [...replayPath];
    // One frame per path entry that is a node in this graph (an "(outside graph)" placeholder
    // would show no change), plus the full path as the final frame.
    const ends = path
      .map((id, index) => (cy.getElementById(id).isNode() ? index + 1 : 0))
      .filter(end => end > 0 && end < path.length);
    const frames = [0, ...ends, path.length];
    const step = (frame: number) => {
      renderer.highlightPath(path.slice(0, frames[frame]));
      replayTimer = frame + 1 < frames.length ? setTimeout(() => step(frame + 1), REPLAY_STEP_MS) : undefined;
    };
    step(0);
  });
  // Registered after the renderer's listener, which has already applied the new highlight.
  window.addEventListener('message', (event: MessageEvent<GraphMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'debugPath') {
      stopReplay();
      replayPath = [...message.path];
    } else if (message.type === 'debugClear') {
      stopReplay();
      replayPath = [];
    } else if (message.type === 'graph' && replayTimer !== undefined) {
      // renderGraph re-applied the half-replayed prefix; show the full path instead.
      stopReplay();
      renderer.highlightPath(replayPath);
    }
    replayButton.disabled = breadcrumb.hidden;
  });
  replayButton.disabled = breadcrumb.hidden;
  // --- end replay feature ---
  window.addEventListener('unload', () => {
    stopReplay(); // replay feature
    observer.disconnect();
    renderer.dispose();
    cy.destroy();
  });
  vscode.postMessage({ type: 'ready' });
}

if (typeof document !== 'undefined') {
  initializeGraphWebview();
}
