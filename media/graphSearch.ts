import type { Core } from 'cytoscape';
import type { GraphNode } from '../src/types';

export interface SearchState {
  kind: 'functions' | 'chokepoints';
  query: string;
  count: number;
  index: number;
  node?: GraphNode;
}

/** Searches existing nodes; only the viewport and a temporary class are changed. */
export class GraphSearch {
  private kind: SearchState['kind'] = 'functions';
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
    this.kind = 'functions';
    this.query = input.trim().toLowerCase();
    this.index = -1;
    this.ids = this.matches();
    return this.move(1);
  }

  /** Use the same counter and previous/next controls to visit suggested breakpoint locations. */
  public findChokepoints(): SearchState {
    if (this.kind === 'chokepoints') return this.move(1);
    this.clearHighlight();
    this.kind = 'chokepoints';
    this.query = '';
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
    if (this.kind === 'chokepoints') {
      return this.cy.nodes(':visible').toArray()
        .filter(node => node.data('chokepoint') === true)
        .sort((a, b) => ((a.data('distance') ?? Infinity) - (b.data('distance') ?? Infinity))
          || a.id().localeCompare(b.id()))
        .map(node => node.id());
    }
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
      if (this.kind === 'chokepoints') {
        const box = node.boundingBox({ includeOverlays: false, includeUnderlays: false });
        const zoom = Math.min(1,
          Math.max(1, this.cy.width() - 80) / Math.max(1, box.w),
          Math.max(1, this.cy.height() - 80) / Math.max(1, box.h));
        this.cy.zoom(Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), zoom)));
        this.cy.center(node);
      } else if (!visible) this.cy.center(node);
      node.addClass('search-hit');
      this.highlightedId = node.id();
      this.highlightTimer = setTimeout(() => this.clearHighlight(), 1500);
    }
    return this.publish();
  }

  public results(): GraphNode[] {
    return this.ids.map(id => this.cy.getElementById(id).data() as GraphNode);
  }

  public choose(id: string): SearchState {
    const index = this.ids.indexOf(id);
    if (index < 0) return this.publish();
    this.index = index - 1;
    return this.move(1);
  }

  private publish(): SearchState {
    const state: SearchState = {
      kind: this.kind,
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
    this.kind = 'functions';
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
