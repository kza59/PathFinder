// The pure part of hot-path counting: the shape the Python hook writes, and how those functions
// map onto graph nodes. Free of `vscode` imports so it runs under plain Node unit tests, like
// recursion.ts and callValues.ts. src/hotPath.ts re-exports both for existing callers.
import { MODULE_NAME, normalizePath } from './nodeId';
import type { GraphData, HotCounts, ReturnValues } from './types';

export interface HotFunction {
  file: string;     // absolute path
  qualname: string; // Python's co_qualname: "Dog.speak", "outer.<locals>.inner", "<module>"
  line: number;     // co_firstlineno: the def line, or the first decorator line when decorated
  endLine: number;  // last line of the function's code
  count: number;
  // --- return values feature ---
  ret?: string;     // latest return value, formatted by the hook (never a user __repr__)
  retSeq?: number;  // bumped per capture; highest wins when several code objects map to one node
  // --- end return values feature ---
}

function lastSegment(name: string): string {
  return name.split('.').pop() ?? name;
}

/**
 * Maps counted Python functions onto graph nodes. Matches by location, not by building an id from
 * the name: Python's qualnames ("outer.<locals>.inner") differ from the graph's labels ("outer.inner"),
 * and graph ids can carry an "@line" suffix.
 *
 * A function matches the node in the same file whose name line is the first one at or after the
 * code's first line (skips decorator lines; picks the outer function over a nested def on its first
 * body line), within the code's lines, with the same last name segment. "<module>" matches the
 * file's module node.
 */
export function mapHotCounts(functions: HotFunction[], graph: GraphData | undefined): {
  counts: HotCounts;
  returns: ReturnValues; // return values feature
  unmatched: { fn: HotFunction; reason: string }[];
} {
  const nodesByFile = new Map<string, GraphData['nodes']>();
  for (const node of graph?.nodes ?? []) {
    const file = normalizePath(node.file);
    nodesByFile.set(file, [...(nodesByFile.get(file) ?? []), node]);
  }

  const counts: HotCounts = {};
  const unmatched: { fn: HotFunction; reason: string }[] = [];
  // --- return values feature --- counts add up across processes, but a return value is one value:
  // the most recently captured one wins, which is what retSeq orders.
  const returns: ReturnValues = {};
  const bestSeq = new Map<string, number>();
  // --- end return values feature ---
  for (const fn of functions) {
    const file = normalizePath(fn.file);
    const nodes = nodesByFile.get(file) ?? [];
    let match: GraphData['nodes'][number] | undefined;
    if (fn.qualname === MODULE_NAME) {
      match = nodes.find(node => node.label === MODULE_NAME);
    } else {
      for (const node of nodes) {
        if (node.label !== MODULE_NAME && fn.line <= node.line && node.line <= fn.endLine
            && lastSegment(node.label) === lastSegment(fn.qualname)
            && (!match || node.line < match.line)) {
          match = node;
        }
      }
    }
    if (match) {
      counts[match.id] = (counts[match.id] ?? 0) + fn.count;
      // --- return values feature ---
      if (fn.ret !== undefined) {
        const seq = fn.retSeq ?? 0;
        if (seq >= (bestSeq.get(match.id) ?? -Infinity)) {
          bestSeq.set(match.id, seq);
          returns[match.id] = fn.ret;
        }
      }
      // --- end return values feature ---
      continue;
    }
    // --- diagnostics: why it didn't match ---
    const describe = (list: GraphData['nodes']) =>
      list.map(node => `${node.label} @${node.line}-${node.endLine}`).join(', ');
    let reason: string;
    if (!graph) {
      reason = 'no graph';
    } else if (!nodes.length) {
      reason = `file not in graph: ${file}`;
    } else if (fn.qualname === MODULE_NAME) {
      reason = `no <module> node in this file (file has: ${describe(nodes)})`;
    } else {
      const atLines = nodes.filter(node => node.label !== MODULE_NAME && fn.line <= node.line && node.line <= fn.endLine);
      reason = atLines.length
        ? `name differs: "${lastSegment(fn.qualname)}" vs ${describe(atLines)}`
        : `no node at lines ${fn.line}-${fn.endLine} (file has: ${describe(nodes)})`;
    }
    unmatched.push({ fn, reason });
  }
  return { counts, returns, unmatched };
}
