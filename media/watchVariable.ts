import type { CallArg } from '../src/types';

// --- watch variable ---

/**
 * Watch one variable across the highlighted path.
 *
 * The inspector pane answers "what does this function hold right now"; this answers the other
 * question - "what is `total` at each step of the call chain" - without scrubbing node by node.
 *
 * It invents no data. Every value here was already captured by the call-values capture (live, at a
 * pause) or by session history's per-step snapshot (while scrubbing), so this module reads, matches
 * and labels - it never touches DAP, the counting hook, or the debuggee.
 *
 * Pure and DOM-free, like paneModel/historyModel, so the matching rules below are unit-testable.
 */

/**
 * The value side of one node, as both sources already provide it: a live `CallValue` and a recorded
 * `StepValues` both satisfy this structurally, so neither has to be converted or copied.
 */
export interface WatchSource {
  args: readonly CallArg[];
  locals?: readonly CallArg[];
  /** Total locals before the recording caps. Greater than `locals.length` means some were dropped. */
  localsCount?: number;
}

/** One position on the highlighted path, outer caller first (the order debugPath uses). */
export interface WatchFrame {
  id: string;
  /** The node's name. Absent when the id is not a node of this graph (an unmatched frame). */
  label?: string;
  /** What was captured for this node, if anything. Absent is NOT the same as "name not found". */
  values?: WatchSource;
}

/** Why a row has no value. Each one means something different; never collapse them. */
export type WatchMiss =
  /** The id is not a node of this graph: an unmatched frame, or an id from another graph. */
  | 'outside'
  /**
   * Nothing was captured for this node: not a Python session, no graph open while recording, the
   * step's values were evicted by the character budget, or the node sits deeper than
   * MAX_SNAPSHOT_FRAMES. Says nothing at all about the variable.
   */
  | 'no-capture'
  /** Captured, and the name is genuinely not in this frame. The informative answer. */
  | 'not-present'
  /**
   * Captured, the name is absent, but the recording caps dropped some of this frame's locals - so
   * "not in this frame" would be an assertion the data cannot support.
   */
  | 'maybe-capped'
  /** Found, but it carries no value: a parameter that is not in Locals (e.g. `del`eted). */
  | 'no-value';

export interface WatchRow {
  id: string;
  label: string;            // the node's name, or the "(outside graph)" stand-in
  value?: string;           // the variable's value at this node
  origin?: 'arg' | 'local'; // where it was found; a parameter and a local are not the same thing
  miss?: WatchMiss;         // set exactly when `value` is absent
  /** Path positions this row stands for: greater than 1 only for recursion (see `collapse`). */
  repeats: number;
}

export interface WatchModel {
  name: string;
  rows: WatchRow[];
  /** Every name available on this path, sorted, for the input's suggestion list. */
  names: string[];
  found: number;      // rows that resolved to a value
  note?: string;      // the one-line summary under the heading
  message?: string;   // replaces the rows entirely (no name typed, nothing highlighted)
}

/**
 * Parameters are stored under their DISPLAY name, so `*args` and `**kwargs` keep their stars
 * (callValues.ts's displayName), while locals are stored bare. Typing `args` has to match `*args`,
 * so both sides are compared with the stars removed.
 *
 * Nothing else is normalised: the match is exact and case-sensitive, because Python identifiers
 * are, and folding case would conflate `total` with `Total`.
 */
export function bareName(name: string): string {
  return name.replace(/^\*{1,2}/, '');
}

// --- variable timeline ---
/**
 * A frame's entries in PRECEDENCE order: parameters first, then locals.
 *
 * The one definition of that order. resolveName (one name, many frames) and indexFrame (one frame,
 * every name) both derive from it, so a single lookup and a bulk scan can never disagree about
 * which entry wins when a name is both a parameter here and a local there.
 */
function frameEntries(values: WatchSource): readonly CallArg[] {
  const locals = values.locals;
  return locals?.length ? [...values.args, ...locals] : values.args;
}

/** Where the entry at that index of frameEntries came from. Derived from the order, not guessed. */
function originAt(values: WatchSource, index: number): 'arg' | 'local' {
  return index < values.args.length ? 'arg' : 'local';
}

/**
 * A whole frame as bare name -> Resolved, first entry winning.
 *
 * For scanning MANY names against one frame, which is what the variable timeline does. Doing that
 * with resolveName per name would re-walk the frame (and re-run bareName on every entry) once per
 * name; this walks it once. Same rules, because both read frameEntries.
 */
export function indexFrame(values: WatchSource): Map<string, Resolved> {
  const index = new Map<string, Resolved>();
  const entries = frameEntries(values);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = bareName(entry.name);
    if (index.has(name)) {
      continue; // precedence: the first entry wins, exactly as resolveName picks it
    }
    const origin = originAt(values, i);
    index.set(name, entry.value === undefined ? { origin, miss: 'no-value' } : { origin, value: entry.value });
  }
  return index;
}
// --- end variable timeline ---

/** Every name this path offers, args and locals together, deduplicated and sorted. */
export function watchNames(frames: readonly WatchFrame[]): string[] {
  const names = new Set<string>();
  for (const frame of frames) {
    for (const arg of frame.values?.args ?? []) {
      names.add(bareName(arg.name));
    }
    for (const local of frame.values?.locals ?? []) {
      names.add(bareName(local.name));
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

interface CollapsedFrame extends WatchFrame {
  repeats: number;
}

/**
 * One row per DISTINCT node, not per path position.
 *
 * A recursive chain repeats a node id on the path, but the captured values are keyed by node and
 * hold only the INNERMOST frame of that node (the capture's `byNode` keeps the innermost and counts
 * the rest). Rendering `fact -> fact -> fact` with the same value three times would read as "it
 * never changed", which is false - so every position of a node collapses into one row that says how
 * many it covers. Consecutive unmatched frames collapse the way the breadcrumb collapses them.
 */
function collapse(frames: readonly WatchFrame[]): CollapsedFrame[] {
  const rows: CollapsedFrame[] = [];
  for (const frame of frames) {
    const previous = rows[rows.length - 1];
    const at = previous && previous.label === undefined && frame.label === undefined
      ? rows.length - 1
      : rows.findIndex(row => row.id === frame.id);
    if (at >= 0) {
      rows[at].repeats++;
    } else {
      rows.push({ ...frame, repeats: 1 });
    }
  }
  return rows;
}

// --- variable history ---
/**
 * The outcome of looking one name up in one frame's values. `value` is set exactly when `miss`
 * is not. Only the three "we had values to look in" cases can come out of here; `outside` and
 * `no-capture` are about the frame itself, so the callers add those.
 */
export interface Resolved {
  value?: string;
  origin?: 'arg' | 'local';
  miss?: Extract<WatchMiss, 'not-present' | 'maybe-capped' | 'no-value'>;
}

/**
 * THE one place a variable name is matched against captured values. Both the watch (space axis)
 * and the value history (time axis) go through here, so the star rule and the case-sensitive exact
 * match cannot drift apart between them.
 *
 * `name` is whatever the user typed; it is normalised here, so a caller cannot forget to.
 */
export function resolveName(values: WatchSource, name: string): Resolved {
  const bare = bareName(name);
  // Arguments first, then locals: the same name can be a parameter here and a local there, and
  // that difference is worth seeing rather than flattening. frameEntries defines that order.
  const entries = frameEntries(values);
  const at = entries.findIndex(entry => bareName(entry.name) === bare);
  if (at < 0) {
    const locals = values.locals ?? [];
    const capped = (values.localsCount ?? locals.length) > locals.length;
    return { miss: capped ? 'maybe-capped' : 'not-present' };
  }
  const hit = entries[at];
  const origin = originAt(values, at);
  return hit.value === undefined ? { origin, miss: 'no-value' } : { origin, value: hit.value };
}
// --- end variable history ---

/** Resolves one frame, keeping the five "no value" cases apart. */
function watchRow(frame: CollapsedFrame, name: string): WatchRow {
  const base = { id: frame.id, label: frame.label ?? '(outside graph)', repeats: frame.repeats };
  if (frame.label === undefined) {
    return { ...base, miss: 'outside' };
  }
  if (!frame.values) {
    return { ...base, miss: 'no-capture' };
  }
  return { ...base, ...resolveName(frame.values, name) }; // variable history: the shared primitive
}

/** Resolves `name` at every node of `frames` (outer caller first, like debugPath). */
export function watchModel(name: string, frames: readonly WatchFrame[]): WatchModel {
  const wanted = name.trim();
  const names = watchNames(frames);
  if (!wanted) {
    return {
      name: '', rows: [], names, found: 0,
      message: 'Type a variable name to follow it along the path.',
    };
  }
  if (!frames.length) {
    return {
      name: wanted, rows: [], names, found: 0,
      message: 'No path highlighted. Pause the debugger, or scrub a recorded step.',
    };
  }

  const rows = collapse(frames).map(frame => watchRow(frame, wanted));
  const found = rows.filter(row => row.value !== undefined).length;
  const nodes = rows.filter(row => row.miss !== 'outside').length;
  return {
    name: wanted,
    rows,
    names,
    found,
    // Says how much of the path actually answered, so a column of "not recorded" is explained
    // rather than looking like the variable vanished.
    note: found
      ? `Found at ${found} of ${nodes} ${nodes === 1 ? 'function' : 'functions'} on this path.`
      : 'Not found on this path. Check the name, or pause deeper in the call chain.',
  };
}

/** What a row shows in place of a value. The five cases read differently because they ARE different. */
export function watchMissText(miss: WatchMiss): string {
  switch (miss) {
    case 'outside':
      return 'outside graph';
    case 'no-capture':
      return 'not recorded';
    case 'not-present':
      return 'not in scope';
    case 'maybe-capped':
      return 'not in the recorded subset';
    case 'no-value':
      return '(not in locals)';
  }
}
// --- end watch variable ---
