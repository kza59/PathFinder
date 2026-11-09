import type { Core } from 'cytoscape';

// --- local variables feature ---

/** Rows the renderer stores on a node for this overlay to draw. */
export interface NodeLocalsData {
  rows: string[];  // already shortened and capped by formatCallLocals, plus a trailing "+N more"
  stale: boolean;  // the program has resumed: greyed, like the tooltip's arguments
}

/**
 * The non-parameter locals of a paused call, as a panel attached below each node's bottom-left
 * corner. It carries its own opaque surface (see .node-locals in media/graph.css) and sits clear of
 * the node's border, so the rows read as an attached panel rather than text loose over the graph.
 *
 * A DOM overlay rather than extra lines on the Cytoscape label, for two reasons: nodes are a fixed
 * 180x82 box that the name plus the arguments line already fills, and the label is what the graph's
 * other features read. Anchoring bottom-left keeps clear of everything that already claims node
 * space - NodePills owns the top edge, TruncationMarkers the top-right corner, the breakpoint dot
 * the inside of the top-left, recursion the outline and the heatmap the fill - and leaves the
 * bottom-centre, where edges leave the node, uncovered.
 *
 * Deliberately inert: the host is pointer-events: none, so hover tooltips, click-to-source, drag
 * and search all keep hitting the node underneath.
 */
export class NodeLocals {
  private readonly bands = new Map<string, HTMLElement>();
  private frame?: number;
  private readonly events = 'viewport resize position add remove style data';
  /** Below this the rows are too small to read, and a dense graph would turn into noise. */
  public static readonly MIN_ZOOM = 0.5;
  /** Unscaled px between the node's bottom border and the panel, so the two never touch. */
  private static readonly GAP = 6;
  /** Unscaled px the panel is inset from the node's left edge, matching where NodePills start. */
  private static readonly INSET = 10;

  constructor(private readonly cy: Core, private readonly host: HTMLElement) {
    cy.on(this.events, this.schedule);
    this.schedule();
  }

  private readonly schedule = (): void => {
    this.frame ??= requestAnimationFrame(this.render);
  };

  private readonly render = (): void => {
    this.frame = undefined;
    const zoom = this.cy.zoom();
    const marked = new Set<string>();
    if (zoom >= NodeLocals.MIN_ZOOM) {
      for (const node of this.cy.nodes(':visible')) {
        const data = node.data('callLocals') as NodeLocalsData | undefined;
        if (!data?.rows.length) continue;
        marked.add(node.id());
        let band = this.bands.get(node.id());
        if (!band) {
          band = this.host.ownerDocument.createElement('div');
          band.className = 'node-locals';
          band.dataset.nodeId = node.id();
          this.bands.set(node.id(), band);
          this.host.appendChild(band);
        }
        band.replaceChildren();
        band.classList.toggle('stale', data.stale);
        for (const text of data.rows) {
          const row = band.appendChild(this.host.ownerDocument.createElement('div'));
          row.className = 'node-local';
          row.textContent = text;
        }
        // Anchored to the node's bottom-left, clear of its border by GAP. The offsets are scaled by
        // zoom so the panel keeps its distance from the node at any zoom, the way the pills do.
        const position = node.renderedPosition();
        band.style.left = `${position.x - node.renderedWidth() / 2 + NodeLocals.INSET * zoom}px`;
        band.style.top = `${position.y + node.renderedHeight() / 2 + NodeLocals.GAP * zoom}px`;
        band.style.transform = `scale(${zoom})`;
        band.style.opacity = String(node.effectiveOpacity());
        band.setAttribute('aria-label', `${node.data('label')} locals: ${data.rows.join(', ')}`);
      }
    }
    for (const [id, band] of this.bands) {
      if (!marked.has(id)) { band.remove(); this.bands.delete(id); }
    }
    this.host.hidden = this.bands.size === 0;
  };

  public dispose(): void {
    this.cy.off(this.events, this.schedule);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.bands.forEach(band => band.remove());
    this.bands.clear();
    this.host.hidden = true;
  }
}

/**
 * The band's rows for one node: the capped rows from formatCallLocals, then "+N more" when the
 * frame had more locals than fit. Returns undefined when there is nothing to draw.
 */
export function nodeLocalsData(
  value: { localsRows?: string[]; localsCount?: number; stale?: boolean } | undefined,
): NodeLocalsData | undefined {
  const rows = value?.localsRows;
  if (!rows?.length) {
    return undefined;
  }
  const hidden = (value?.localsCount ?? rows.length) - rows.length;
  return {
    rows: hidden > 0 ? [...rows, `+${hidden} more`] : [...rows],
    stale: value?.stale === true,
  };
}
// --- end local variables feature ---
