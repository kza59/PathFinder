import type { CollectionReturnValue, Core } from 'cytoscape';
import type { RecursionDepth } from '../src/recursion';

const COLORS = ['#c586c0', '#d7ba7d', '#4ec9b0', '#ce9178', '#9cdcfe', '#b5cea8'];

export function recursionColor(group: number): string {
  return COLORS[((group - 1) % COLORS.length + COLORS.length) % COLORS.length];
}

export interface RecursionOutline {
  group: number;
  color: string;
  members: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One enclosure per recursive group, in graph coordinates; hidden noise contributes no bounds. */
export function recursionOutlines(cy: Core): RecursionOutline[] {
  const groups = new Map<number, CollectionReturnValue>();
  cy.nodes(':visible').forEach(node => {
    const group: unknown = node.data('recursionGroup');
    if (typeof group !== 'number' || !Number.isInteger(group)) return;
    const members = groups.get(group) ?? cy.collection();
    members.merge(node);
    groups.set(group, members);
  });
  return [...groups].map(([group, nodes]) => {
    const bounds = nodes.boundingBox({ includeLabels: false, includeOverlays: false });
    const padding = 18;
    return {
      group, color: recursionColor(group), members: nodes.map(node => node.id()),
      x: bounds.x1 - padding, y: bounds.y1 - padding,
      width: bounds.w + 2 * padding, height: bounds.h + 2 * padding,
    };
  });
}

export function recursionAnnouncement(levels: RecursionDepth[]): string {
  const depth = Math.max(0, ...levels.map(level => level.depth));
  if (!depth) return '';
  if (depth >= 10) return 'MONSTER RECURSION!';
  if (depth >= 4) return 'ULTRA RECURSION!';
  return ['', 'RECURSION!', 'DOUBLE RECURSION!', 'TRIPLE RECURSION!'][depth];
}
