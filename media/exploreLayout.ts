import type { Core, EventObject, NodeSingular } from 'cytoscape';
import { forceLink, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

const NODE_SPACING = 30;
const EDGE_LENGTH = 100;

interface ExploreNode extends SimulationNodeDatum {
  id: string;
  element: NodeSingular;
  weight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  halfWidth: number;
  halfHeight: number;
  visible: boolean;
}

interface ExploreLink extends SimulationLinkDatum<ExploreNode> {
  source: ExploreNode;
  target: ExploreNode;
}

/** Continuous, degree-weighted positioning; Cytoscape still owns rendering and dragging. */
export class ExploreLayout {
  private readonly nodes = new Map<string, ExploreNode>();
  private readonly grabbed = new Set<string>();
  private readonly simulation: Simulation<ExploreNode, ExploreLink>;
  private applyingPositions = false;
  private stopped = false;

  constructor(private readonly cy: Core) {
    cy.nodes().forEach(element => {
      const position = element.position();
      this.nodes.set(element.id(), {
        id: element.id(), element, weight: 1,
        x: position.x, y: position.y, vx: 0, vy: 0,
        halfWidth: 0, halfHeight: 0, visible: element.visible(),
      });
    });

    const degree = new Map<string, number>();
    const links: ExploreLink[] = [];
    cy.edges().forEach(edge => {
      const source = this.nodes.get(edge.source().id());
      const target = this.nodes.get(edge.target().id());
      // Recursion loops exert no spatial force and do not make a node heavier.
      if (!source || !target || source === target) return;
      degree.set(source.id, (degree.get(source.id) ?? 0) + 1);
      degree.set(target.id, (degree.get(target.id) ?? 0) + 1);
      links.push({ source, target });
    });
    for (const node of this.nodes.values()) {
      node.weight = Math.max(1, degree.get(node.id) ?? 0);
      node.element.data('exploreWeight', node.weight);
      this.updateFixedPosition(node);
    }

    // D3's link bias uses these same endpoint degrees. Keep every link in the
    // force so filtering cannot change the weights; hidden links have zero strength.
    const strength = (link: ExploreLink) => link.source.visible && link.target.visible
      ? 0.3 / Math.min(link.source.weight, link.target.weight) : 0;
    const linkForce = forceLink<ExploreNode, ExploreLink>(links).distance(EDGE_LENGTH).strength(strength);
    this.simulation = forceSimulation<ExploreNode, ExploreLink>([...this.nodes.values()])
      .alpha(0.4)
      .alphaDecay(0)
      .velocityDecay(0.5)
      .force('visibility', () => {
        let changed = false;
        for (const node of this.nodes.values()) {
          const visible = node.element.visible();
          if (visible !== node.visible) {
            node.visible = visible;
            node.vx = node.vy = 0;
            this.updateFixedPosition(node);
            changed = true;
          }
        }
        if (changed) linkForce.strength(strength);
      })
      .force('link', linkForce)
      .on('tick', () => this.updatePositions());

    cy.on('grab free position lock unlock', 'node', this.handleNodeEvent);
    cy.on('destroy', this.handleDestroy);
  }

  private updateFixedPosition(node: ExploreNode): void {
    const fixed = this.grabbed.has(node.id) || node.element.grabbed() || node.element.locked() || !node.visible;
    node.fx = fixed ? node.x : null;
    node.fy = fixed ? node.y : null;
    if (fixed) node.vx = node.vy = 0;
  }

  private readonly handleNodeEvent = (event: EventObject): void => {
    if (this.applyingPositions || this.stopped) return;
    const node = this.nodes.get(event.target.id());
    if (!node) return;
    if (event.type === 'grab') this.grabbed.add(node.id);
    if (event.type === 'free') this.grabbed.delete(node.id);
    const position = node.element.position();
    node.x = position.x;
    node.y = position.y;
    node.vx = node.vy = 0;
    this.updateFixedPosition(node);
  };

  private readonly handleDestroy = (): void => this.stop();

  private updatePositions(): void {
    if (this.stopped) return;
    const visible = [...this.nodes.values()].filter(node => node.visible);
    for (const node of visible) {
      const dimensions = node.element.layoutDimensions({ nodeDimensionsIncludeLabels: true });
      node.halfWidth = dimensions.w / 2 + NODE_SPACING;
      node.halfHeight = dimensions.h / 2 + NODE_SPACING;
    }
    this.separateOverlaps(visible);
    this.applyingPositions = true;
    try {
      this.cy.nodes().positions(element => {
        const node = this.nodes.get(element.id())!;
        return { x: node.x, y: node.y };
      });
    } finally {
      this.applyingPositions = false;
    }
  }

  /** Project overlapping label boxes apart, giving lighter nodes more of the correction. */
  private separateOverlaps(nodes: ExploreNode[]): void {
    for (let pass = 0; pass < 4; pass++) {
      // Sweep along x to avoid comparing every pair in sparse/large graphs.
      const boxes = nodes.map(node => ({ node, left: node.x - node.halfWidth, right: node.x + node.halfWidth }))
        .sort((a, b) => a.left - b.left);
      let changed = false;
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i].node;
        for (let j = i + 1; j < boxes.length && boxes[j].left < boxes[i].right; j++) {
          const b = boxes[j].node;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const overlapX = a.halfWidth + b.halfWidth - Math.abs(dx);
          const overlapY = a.halfHeight + b.halfHeight - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const mobilityA = a.fx == null ? 1 / a.weight : 0;
          const mobilityB = b.fx == null ? 1 / b.weight : 0;
          const total = mobilityA + mobilityB;
          if (!total) continue;
          const axis = overlapX < overlapY ? 'x' : 'y';
          const delta = axis === 'x' ? dx : dy;
          const correction = ((axis === 'x' ? overlapX : overlapY) + 0.01) * (delta < 0 ? -1 : 1);
          a[axis] -= correction * mobilityA / total;
          b[axis] += correction * mobilityB / total;
          // Cancel velocity into the constraint, preventing springs from causing bouncing.
          if (axis === 'x') a.vx = b.vx = 0;
          else a.vy = b.vy = 0;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.simulation.stop();
    this.cy.off('grab free position lock unlock', 'node', this.handleNodeEvent);
    this.cy.off('destroy', this.handleDestroy);
    this.grabbed.clear();
  }
}
