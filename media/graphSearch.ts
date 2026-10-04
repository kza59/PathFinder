import type { Core } from 'cytoscape';
import type { GraphNode } from '../src/types';

export interface SearchState {
  query: string;
  count: number;
  index: number;
  node?: GraphNode;
}

/** Searches existing nodes; only the viewport and a temporary class are changed. */
export class GraphSearch {
  private query = '';
  private ids: string[] = [];
  private index = -1;
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private highlightedId?: string;

  constructor(
    private readonly cy: Core,
    private readonly changed: (state: SearchState) => void = () => {},
  ) {}

  public find(input: string): SearchState {
    this.clearHighlight();
    this.query = input.trim().toLowerCase();
    this.index = -1;
    this.ids = this.matches();
    return this.move(1);
  }

  /** Update visibility-dependent results without moving the viewport or changing the query. */
  public refresh(): SearchState {
    const currentId = this.ids[this.index];
    this.ids = this.matches();
    const currentIndex = this.ids.indexOf(currentId);
    this.index = currentIndex >= 0 ? currentIndex : this.ids.length ? 0 : -1;
    if (this.highlightedId !== undefined && !this.ids.includes(this.highlightedId)) {
      this.clearHighlight();
    }
    return this.publish();
  }

  private matches(): string[] {
    const exact: string[] = [];
    const partial: string[] = [];
    if (this.query) {
      for (const node of this.cy.nodes(':visible')) {
        const label = (node.data() as GraphNode).label.toLowerCase();
        if (label === this.query) exact.push(node.id());
        else if (label.includes(this.query)) partial.push(node.id());
      }
    }
    return [...exact, ...partial];
  }

  public move(direction: 1 | -1): SearchState {
    if (this.ids.length) {
      this.index = this.index < 0
        ? direction === 1 ? 0 : this.ids.length - 1
        : (this.index + direction + this.ids.length) % this.ids.length;
      const node = this.cy.getElementById(this.ids[this.index]);
      if (!node.isNode()) return this.clear();
      this.clearHighlight();
      // Ignore temporary halos when deciding whether the node and label are visible.
      const bounds = node.renderedBoundingBox({ includeOverlays: false, includeUnderlays: false });
      const visible = bounds.x1 >= 0 && bounds.y1 >= 0
        && bounds.x2 <= this.cy.width() && bounds.y2 <= this.cy.height();
      // Keep the viewport still for visible matches, including when cycling results.
      if (!visible) this.cy.center(node);
      node.addClass('search-hit');
      this.highlightedId = node.id();
      this.highlightTimer = setTimeout(() => this.clearHighlight(), 1500);
    }
    return this.publish();
  }

  private publish(): SearchState {
    const state: SearchState = {
      query: this.query,
      count: this.ids.length,
      index: this.index,
      node: this.index < 0 ? undefined : this.cy.getElementById(this.ids[this.index]).data() as GraphNode,
    };
    this.changed(state);
    return state;
  }

  public clear(): SearchState {
    this.clearHighlight();
    this.query = '';
    this.ids = [];
    this.index = -1;
    return this.move(1);
  }

  public dispose(): void {
    this.clearHighlight();
  }

  private clearHighlight(): void {
    if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer);
    if (this.highlightedId !== undefined) {
      this.cy.getElementById(this.highlightedId).removeClass('search-hit');
    }
    this.highlightTimer = undefined;
    this.highlightedId = undefined;
  }
}
