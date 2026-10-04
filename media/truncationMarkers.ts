import type { Core } from 'cytoscape';
import type { CallerExpansionPreview, ExpandCallersMessage, PreviewCallersMessage } from '../src/types';

/** DOM controls anchored to real nodes; markers never participate in graph layout or search. */
export class TruncationMarkers {
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private frame: number | undefined;
  private disposed = false;
  private previews = new Map<string, CallerExpansionPreview>();
  private showNoise = false;
  private readonly events = 'viewport resize position add remove style data';

  constructor(
    private readonly cy: Core,
    private readonly host: HTMLElement,
    private readonly postMessage: (message: ExpandCallersMessage | PreviewCallersMessage) => void,
  ) {
    cy.on(this.events, this.schedule);
    this.schedule();
  }

  public setPreviews(previews: Record<string, CallerExpansionPreview>): void {
    this.previews = new Map(Object.entries(previews));
    this.schedule();
  }

  public setShowNoise(show: boolean): void {
    this.showNoise = show;
    this.schedule();
  }

  private readonly schedule = (): void => {
    if (!this.disposed && this.frame === undefined) {
      this.frame = requestAnimationFrame(this.render);
    }
  };

  private readonly render = (): void => {
    this.frame = undefined;
    if (this.disposed) return;
    const marked = new Set<string>();
    for (const node of this.cy.nodes(':visible')) {
      const count: unknown = node.data('hiddenCallers');
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) continue;
      const id = node.id();
      marked.add(id);
      let button = this.buttons.get(id);
      if (!button) {
        button = this.host.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'truncation-marker';
        button.dataset.nodeId = id;
        button.addEventListener('click', event => {
          event.stopPropagation();
          const current = this.cy.getElementById(id);
          const hidden: unknown = current.data('hiddenCallers');
          if (!this.disposed && current.isNode() && current.visible() &&
            typeof hidden === 'number' && Number.isSafeInteger(hidden) && hidden > 0) {
            const preview = this.previews.get(id);
            if (preview?.state === 'ready') this.postMessage({ type: 'expandCallers', id });
            else if (preview?.state === 'error') this.postMessage({ type: 'previewCallers', id });
          }
        });
        this.buttons.set(id, button);
        this.host.appendChild(button);
      }
      const preview = this.previews.get(id);
      const added = preview?.state === 'ready' ? preview.addedNodes - (this.showNoise ? 0 : preview.addedNoiseNodes) : 0;
      button.disabled = !preview || preview.state === 'loading';
      button.textContent = preview?.state === 'ready' ? `+${added}` : preview?.state === 'error' ? 'Retry' : '…';
      const label = preview?.state === 'ready'
        ? `Show ${added} more ${added === 1 ? 'function' : 'functions'} above ${node.data('label')}`
        : preview?.state === 'error' ? `Retry counting more functions above ${node.data('label')}`
        : `Counting more functions above ${node.data('label')}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      const position = node.renderedPosition();
      button.style.left = `${position.x + node.renderedOuterWidth() / 2}px`;
      button.style.top = `${position.y - node.renderedOuterHeight() / 2}px`;
    }
    for (const [id, button] of this.buttons) {
      if (!marked.has(id)) {
        button.remove();
        this.buttons.delete(id);
      }
    }
    this.host.hidden = this.buttons.size === 0;
  };

  public dispose(): void {
    this.disposed = true;
    this.cy.off(this.events, this.schedule);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    for (const button of this.buttons.values()) button.remove();
    this.buttons.clear();
    this.host.hidden = true;
  }
}
