import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type StylesheetJson } from 'cytoscape';
import { fileName } from '../src/webview/filePath';
import type { DebugPath, GraphData, GraphMessage, GraphNode, WebviewMessage } from '../src/types';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

export const layoutOptions = {
  name: 'breadthfirst' as const,
  directed: true,
  direction: 'downward' as const,
  circle: false,
  padding: 40,
  spacingFactor: 1.1,
  avoidOverlap: true,
  nodeDimensionsIncludeLabels: true,
  animate: false,
  depthSort: (first: NodeSingular | null, second: NodeSingular | null) =>
    String(first?.data('label') ?? '').localeCompare(String(second?.data('label') ?? '')),
};

export function graphStyles(foreground = '#d4d4d4', background = '#252526'): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        shape: 'round-rectangle',
        width: 150,
        height: 64,
        'background-color': background,
        'border-color': '#5d8db5',
        'border-width': 2,
        color: foreground,
        'font-size': '16px',
        'font-weight': 'bold',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '135px',
        'overlay-opacity': 0,
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
        label: (node: NodeSingular) => `${node.data('label')}\nYou are here`,
        'border-color': '#e5c07b',
        'border-width': 5,
        'border-style': 'double',
      },
    },
    {
      selector: 'node:selected',
      style: { 'underlay-color': '#4fc1ff', 'underlay-opacity': 0.2, 'underlay-padding': 8 },
    },
  ];
}

export class GraphRenderer {
  private path: DebugPath = [];

  constructor(
    private readonly cy: Core,
    private readonly graphRendered: (nodeCount: number) => void = () => {},
    private readonly pathChanged: (current: GraphNode | undefined, active: boolean) => void = () => {},
  ) {}

  public renderGraph(graph: GraphData): void {
    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const elements: ElementDefinition[] = graph.nodes.map(node => ({
      group: 'nodes', data: { ...node },
    }));
    graph.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        return;
      }
      let edgeId = `pathfind-edge-${index}`;
      while (nodeIds.has(edgeId)) {
        edgeId = `_${edgeId}`;
      }
      elements.push({
        group: 'edges', data: { id: edgeId, source: edge.from, target: edge.to },
      });
    });

    this.cy.batch(() => {
      this.cy.elements().remove();
      this.cy.add(elements);
    });
    if (this.cy.nodes().length) {
      const acyclic = this.cy.elements().tarjanStronglyConnected().components.every(component =>
        component.nodes().length === 1 && component.edges().length === 0,
      );
      const options = { ...layoutOptions, maximal: acyclic, acyclic };
      this.cy.layout(options).run();
    }
    this.highlightPath(this.path);
    this.graphRendered(this.cy.nodes().length);
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
    });

    const current = path.length ? this.cy.getElementById(path[path.length - 1]) : undefined;
    this.pathChanged(current?.isNode() ? current.data() as GraphNode : undefined, path.length > 0);
  }

  public clearDebugPath(): void {
    this.highlightPath([]);
  }
}

export function initializeGraphWebview(): void {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('graph')!;
  const empty = document.getElementById('empty')!;
  const runtime = document.getElementById('runtime')!;
  const selection = document.getElementById('selection')!;
  const theme = getComputedStyle(document.body);
  const cy = cytoscape({
    container,
    elements: [],
    style: graphStyles(
      theme.getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4',
      theme.getPropertyValue('--vscode-sideBar-background').trim() || '#252526',
    ),
    layout: { name: 'preset' },
    minZoom: 0.05,
    maxZoom: 3,
  });
  const renderer = new GraphRenderer(cy, count => {
    empty.hidden = count > 0;
    empty.textContent = 'No functions in this graph';
    selection.textContent = 'Click a function to see its source location';
  }, (current, active) => {
    runtime.textContent = current
      ? `You are here: ${current.label} · ${fileName(current.file)}:${current.line}`
      : active ? 'Current function is outside this graph' : 'No runtime path';
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
  tooltipHost.appendChild(tooltip);

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
  };

  cy.on('mouseover', 'node', event => {
    const node = event.target.data() as GraphNode;
    tooltipName.textContent = node.label;
    tooltipFile.textContent = fileName(node.file);
    tooltipLines.textContent = node.endLine > node.line
      ? `lines ${node.line}–${node.endLine}`
      : `line ${node.line}`;
    tooltip.hidden = false;
    moveTooltip(event.renderedPosition.x, event.renderedPosition.y);
  });
  cy.on('mousemove', 'node', event => {
    if (!tooltip.hidden) {
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
  document.getElementById('fit')!.addEventListener('click', () => {
    if (cy.nodes().length) {
      cy.fit(undefined, 40);
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
    }
  });
  window.addEventListener('unload', () => {
    observer.disconnect();
    cy.destroy();
  });
  vscode.postMessage({ type: 'ready' });
}

if (typeof document !== 'undefined') {
  initializeGraphWebview();
}
