import type { HistoryStep } from '../src/types';
import { bareName, resolveName, type Resolved } from './watchVariable';

// --- variable history ---

/**
 * Variable value history: how one variable's value changed across a whole recorded run.
 *
 * The sibling of the watch (media/watchVariable.ts). Same name, same matching - the two differ only
 * in which axis they walk:
 *   watch   = one name, one moment, every node of the path  (space)
 *   history = one name, one node,   every recorded step     (time)
 *
 * Name matching is NOT reimplemented here: every lookup goes through watchVariable's resolveName,
 * so the star rule (`*args` matches `args`) and the case-sensitive exact match are shared with the
 * watch by construction. The data is session history's per-step capture (HistoryStep.values); this
 * module reads it and never touches DAP, the counting hook, or the debuggee.
 *
 * History-only: a finished session's steps are the input, so it says so rather than guessing while
 * a session is still recording.
 *
 * Pure and DOM-free, like watchModel / paneModel / historyModel.
 */

/** Rendered entries are capped; the rest are reported as "+N more" rather than drawn. */
export const MAX_HISTORY_ROWS = 200;

/** One recorded change: the variable held this value, at this function, over these steps. */
export interface HistoryEntry {
  kind: 'value';
  /** First recorded step index (0-based) of the run this entry stands for: where a click lands. */
  index: number;
  /** Last step index of the run. Equal to `index` unless consecutive steps were identical. */
  lastIndex: number;
  steps: number;            // how many consecutive steps the run covers
  nodeId: string;           // the node the value was read at
  label: string;            // that node's name, or its id when the graph cannot name it
  value: string;
  origin: 'arg' | 'local';  // a parameter here and a local there is a real difference
  time: number;             // ms since the session started, from the first step of the run
}

/**
 * A run of steps the variable had no value at, between two entries.
 *
 * Rendered rather than silently skipped: a gap is how you see a variable go out of scope and come
 * back, which a gapless list would hide. `unrecorded` counts the steps in the gap that captured no
 * variables at all - those say nothing about the variable, unlike the rest, which say it was absent.
 */
export interface HistoryGap {
  kind: 'gap';
  index: number;      // first skipped step
  steps: number;      // how many were skipped
  unrecorded: number; // of those, how many recorded no variables at all
}

export type HistoryRow = HistoryEntry | HistoryGap;

export interface ValueHistoryModel {
  name: string;
  rows: HistoryRow[];
  hits: number;        // recorded steps where the name resolved to a value, before collapsing
  total: number;       // recorded steps in all
  unrecorded: number;  // of those, how many carried no captured values at all
  changes: number;     // entries after collapsing unchanged runs
  more: number;        // entries past MAX_HISTORY_ROWS, which are NOT in `rows`
  note?: string;
  message?: string;    // replaces the rows entirely (nothing recorded, nothing typed)
}

/** Names a graph node, or returns undefined when this graph has no such node. */
export type LabelOf = (nodeId: string) => string | undefined;

/** The innermost node of a step where the name resolves, with what it resolved to. */
function atStep(step: HistoryStep, name: string): { nodeId: string; found: Resolved } | undefined {
  const values = step.values;
  if (!values) {
    return undefined;
  }
  // `path` is outer caller first, so the innermost frame is the last one. Scanning from there
  // answers "where was execution when it held this", which is the one node a timeline row wants.
  for (let i = step.path.length - 1; i >= 0; i--) {
    const nodeId = step.path[i];
    const captured = Object.prototype.hasOwnProperty.call(values, nodeId) ? values[nodeId] : undefined;
    if (!captured) {
      continue;
    }
    const found = resolveName(captured, name);
    if (found.value !== undefined) {
      return { nodeId, found };
    }
  }
  return undefined;
}

/** Keeps the first MAX_HISTORY_ROWS entries, with the gaps between them; drops a trailing gap. */
function trim(rows: readonly HistoryRow[]): { rows: HistoryRow[]; more: number } {
  const total = rows.filter(row => row.kind === 'value').length;
  if (total <= MAX_HISTORY_ROWS) {
    return { rows: [...rows], more: 0 };
  }
  const kept: HistoryRow[] = [];
  let seen = 0;
  for (const row of rows) {
    if (row.kind === 'value') {
      if (seen === MAX_HISTORY_ROWS) {
        break;
      }
      seen++;
    }
    kept.push(row);
  }
  while (kept.length && kept[kept.length - 1].kind === 'gap') {
    kept.pop();
  }
  return { rows: kept, more: total - seen };
}

/**
 * The value history of `name` across `steps` (oldest first, as session history sends them).
 *
 * Only steps where the variable HAD a value become entries. Consecutive entries collapse when the
 * value AND the node are both unchanged - a value history is about changes, and a loop would
 * otherwise bury the handful of real ones under hundreds of identical rows. Collapsing on the value
 * alone would be wrong: `n=3` in `fact` and `n=3` in `main` are different facts.
 *
 * `labelOf` names the node a value was read at. A step's `where` is its INNERMOST frame, which is
 * not necessarily where the name resolved, so it cannot be used for this.
 */
export function valueHistoryModel(
  name: string,
  steps: readonly HistoryStep[],
  labelOf: LabelOf = () => undefined,
): ValueHistoryModel {
  const wanted = bareName(name.trim());
  const empty = {
    name: wanted, rows: [], hits: 0, total: steps.length, unrecorded: 0, changes: 0, more: 0,
  };
  if (!wanted) {
    return { ...empty, message: 'Type a variable name to see how its value changed.' };
  }
  if (!steps.length) {
    return { ...empty, message: 'No recorded session yet. Run the debugger to the end, then pick a variable.' };
  }

  const rows: HistoryRow[] = [];
  let hits = 0;
  let unrecorded = 0;
  let gap: HistoryGap | undefined;
  let last: HistoryEntry | undefined;

  steps.forEach((step, index) => {
    const hit = atStep(step, wanted);
    if (!hit) {
      // Not a row of its own: gaps accumulate and are flushed when the next entry arrives.
      gap ??= { kind: 'gap', index, steps: 0, unrecorded: 0 };
      gap.steps++;
      if (!step.values) {
        gap.unrecorded++;
        unrecorded++;
      }
      return;
    }
    hits++;
    // An unchanged run extends the previous entry instead of repeating it. A gap in between breaks
    // the run even when the value matches: the variable was gone and came back, which is a change.
    if (!gap && last && last.nodeId === hit.nodeId && last.value === hit.found.value) {
      last.lastIndex = index;
      last.steps++;
      return;
    }
    if (gap) {
      rows.push(gap);
      gap = undefined;
    }
    last = {
      kind: 'value',
      index,
      lastIndex: index,
      steps: 1,
      nodeId: hit.nodeId,
      label: labelOf(hit.nodeId) ?? hit.nodeId,
      value: hit.found.value!,
      origin: hit.found.origin!,
      time: step.time,
    };
    rows.push(last);
  });
  // A trailing gap is never pushed: it is not a change, just the run ending without the variable.

  const changes = rows.filter(row => row.kind === 'value').length;
  const capped = trim(rows);
  return {
    name: wanted,
    rows: capped.rows,
    hits,
    total: steps.length,
    unrecorded,
    changes,
    more: capped.more,
    note: historyNote(wanted, hits, steps.length, unrecorded, changes),
  };
}

/** The one-line summary: what answered, out of what, and how much of the run said nothing. */
function historyNote(name: string, hits: number, total: number, unrecorded: number, changes: number): string {
  const steps = `${total} recorded ${total === 1 ? 'step' : 'steps'}`;
  if (!hits) {
    return unrecorded === total
      ? `No variables were recorded for this session, so ${name} cannot be traced.`
      : `${name} had no value at any of ${steps}.`;
  }
  // "12 of 400 steps · 5 changes" - the second number is the one worth reading when a loop ran.
  const collapsed = changes === hits ? '' : ` · ${changes} ${changes === 1 ? 'change' : 'changes'}`;
  const blind = unrecorded ? ` · ${unrecorded} recorded no variables` : '';
  return `${name} had a value at ${hits} of ${steps}${collapsed}${blind}.`;
}
// --- end variable history ---
