import type { Core } from 'cytoscape';

/** Status labels follow real nodes without becoming searchable graph elements. */
export class NodePills {
  private readonly labels = new Map<string, HTMLElement>();
  private frame?: number;
  private readonly events = 'viewport resize position add remove style data';

  constructor(private readonly cy: Core, private readonly host: HTMLElement) {
    cy.on(this.events, this.schedule);
    this.schedule();
  }

  private readonly schedule = (): void => {
    this.frame ??= requestAnimationFrame(this.render);
  };

  private readonly render = (): void => {
    this.frame = undefined;
    const marked = new Set<string>();
    for (const node of this.cy.nodes(':visible')) {
      const target = node.hasClass('target');
      const current = node.hasClass('current');
      if (!target && !current) continue;
      marked.add(node.id());
      let group = this.labels.get(node.id());
      if (!group) {
        group = this.host.ownerDocument.createElement('div');
        group.className = 'node-pills';
        group.dataset.nodeId = node.id();
        this.labels.set(node.id(), group);
        this.host.appendChild(group);
      }
      group.replaceChildren();
      for (const [visible, kind, text] of [[target, 'target', 'Target'], [current, 'current', 'You are Here']] as const) {
        if (!visible) continue;
        const pill = group.appendChild(this.host.ownerDocument.createElement('span'));
        pill.className = `node-pill ${kind}`;
        pill.textContent = text;
      }
      const position = node.renderedPosition();
      const zoom = this.cy.zoom();
      group.style.left = `${position.x - node.renderedWidth() / 2 + 10 * zoom}px`;
      group.style.top = `${position.y - node.renderedHeight() / 2}px`;
      group.style.transform = `scale(${zoom}) translateY(-50%)`;
      group.style.opacity = String(node.effectiveOpacity());
      group.setAttribute('aria-label', `${node.data('label')}: ${[target ? 'Target' : '', current ? 'You are Here' : ''].filter(Boolean).join(', ')}`);
    }
    for (const [id, group] of this.labels) {
      if (!marked.has(id)) { group.remove(); this.labels.delete(id); }
    }
    this.host.hidden = this.labels.size === 0;
  };

  public dispose(): void {
    this.cy.off(this.events, this.schedule);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.labels.forEach(label => label.remove());
    this.labels.clear();
    this.host.hidden = true;
  }
}
