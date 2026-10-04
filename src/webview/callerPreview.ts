import type { CallerExpansionPreview, GraphData } from '../types';

/** Count unique new functions, retaining the noise subtotal for the webview's visibility toggle. */
export function callerExpansionPreview(graph: GraphData, expanded: GraphData): Extract<CallerExpansionPreview, { state: 'ready' }> {
  const seen = new Set(graph.nodes.map(node => node.id));
  let addedNodes = 0;
  let addedNoiseNodes = 0;
  for (const node of expanded.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    addedNodes++;
    if (node.noise === true) addedNoiseNodes++;
  }
  return { state: 'ready', addedNodes, addedNoiseNodes };
}
