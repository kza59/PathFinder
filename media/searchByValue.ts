import type { HistoryStep } from '../src/types';
import { indexStep, type RunIndex } from './watchVariable';

// --- search by value ---

/**
 * Search by value: every recorded step and node where some variable held a given value.
 *
 * The one view that runs backwards. The watch, the history and the timeline all start from a NAME
 * and ask where/when it had values; this starts from a VALUE and asks which name, function and
 * moment held it.
 *
 * It reads the same per-step capture through the same shared index (watchVariable's indexStep), so
 * a hit here and a cell in the timeline can never disagree about what a step contained. Nothing
 * here touches DAP, the counting hook, or the debuggee.
 *
 * WHAT IS BEING MATCHED, and why it needs care: the stored strings are debugpy reprs that were
 * then passed through shortenValue. So a Python string `hello` is stored as `'hello'`, a float 7.0
 * as `7.0`, an int 7 as `7` - and every value was CAPPED AT 80 CHARACTERS with a trailing ellipsis.
 * A query that only occurs past that cut cannot be found; the note says so rather than implying the
 * search was exhaustive.
 *
 * History-only, and pure/DOM-free like watchModel, valueHistoryModel and timelineModel.
 */

/** Rows shown before the rest are reported as "+N more", matching the history's cap. */
export const MAX_RESULTS = 200;

/**
 * How a value matched, strongest first. Every row carries its tier, so a loose hit is never
 * mistaken for a precise one.
 */
export type MatchTier =
  /** The whole value is the query, give or take a string repr's quotes: `hello` finds `'hello'`. */
  | 'exact'
  /** Both sides are numbers and they are numerically equal: `7` finds `7.0`. */
  | 'numeric'
  /** The value contains the query: `7` finds `[7, 8]`. Off unless asked for. */
  | 'contains';

const TIER_RANK: Record<MatchTier, number> = { exact: 0, numeric: 1, contains: 2 };

export interface ValueMatch {
  /** First step of the run this row stands for, and where a click lands. */
  index: number;
  lastIndex: number;
  steps: number;            // consecutive steps the run covers
  nodeId: string;
  label: string;            // the node's name, or its id when the graph cannot name it
  name: string;             // the variable that held the value
  value: string;            // the stored repr, verbatim - so `7` matching `7.0` explains itself
  origin: 'arg' | 'local';
  tier: MatchTier;
}

export interface SearchModel {
  query: string;
  rows: ValueMatch[];
  hits: number;        // matching (step, node, variable) triples before collapsing
  variables: number;   // distinct variable names that matched
  steps: number;       // distinct steps that matched
  total: number;       // recorded steps searched
  more: number;        // rows past MAX_RESULTS, not in `rows`
  truncated: boolean;  // some searched value was capped at capture, so `contains` cannot see it all
  note?: string;
  message?: string;    // replaces the rows entirely (nothing typed, nothing recorded)
}

export type LabelOf = (nodeId: string) => string | undefined;

/** Characters that, on either side of a numeric hit, mean it is part of a longer number or name. */
const FLANK = /[0-9A-Za-z_.]/;

/** A decimal number as Python reprs one, with underscores allowed. Complex (`2j`) is not one. */
const NUMERIC = /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?$/;

/**
 * Strips a string repr's prefix and matching outer quotes, so the query can be typed as the text
 * rather than as its repr: `'hello'`, `"hello"`, `b'hi'` and `f'hi'` all give up their contents.
 * Returns undefined when the value is not a quoted string.
 */
export function unquote(value: string): string | undefined {
  const match = /^[rbufRBUF]{0,2}(['"])([\s\S]*)\1$/.exec(value);
  return match ? match[2] : undefined;
}

/** A Python numeric literal as a JS number, or undefined. NaN is excluded: it equals nothing. */
export function asNumber(text: string): number | undefined {
  if (/^[+-]?inf$/.test(text)) {
    return text.startsWith('-') ? -Infinity : Infinity;
  }
  if (!NUMERIC.test(text)) {
    return undefined;
  }
  const parsed = Number(text.replace(/_/g, ''));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A boundary-aware `contains` for numeric queries: the hit must not be flanked by a digit, a dot or
 * an identifier character. So `7` is found in `[7, 8]` and `{'a': 7}` but not in `17`, `0.75` or
 * `x7` - which is the difference between a useful result list and a page of noise.
 */
function containsAtBoundary(value: string, query: string): boolean {
  for (let at = value.indexOf(query); at >= 0; at = value.indexOf(query, at + 1)) {
    const before = at > 0 ? value[at - 1] : '';
    const after = at + query.length < value.length ? value[at + query.length] : '';
    if (!FLANK.test(before) && !FLANK.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * The strongest tier at which `value` matches `query`, or undefined.
 * Case-sensitive throughout, like the name matching in the sibling features: Python identifiers and
 * literals are case-sensitive, and `True` is not `true`.
 */
export function matchTier(value: string, query: string, contains: boolean): MatchTier | undefined {
  if (value === query || unquote(value) === query) {
    return 'exact';
  }
  const wanted = asNumber(query);
  if (wanted !== undefined && asNumber(value) === wanted) {
    return 'numeric';
  }
  if (!contains) {
    return undefined;
  }
  // A numeric query gets the boundary rule; text is a plain substring, since `hello` inside
  // `'hello world'` is a legitimate hit and has no numeric neighbours to confuse it with.
  const hit = wanted !== undefined ? containsAtBoundary(value, query) : value.includes(query);
  return hit ? 'contains' : undefined;
}

/**
 * Every place `query` was held across `steps` (oldest first, as session history sends them).
 *
 * Consecutive steps where the SAME variable at the SAME node holds the SAME value collapse into one
 * row with a step range, exactly as the value history collapses: a loop would otherwise emit
 * hundreds of identical rows and bury the distinct places the value actually appears. A
 * non-consecutive reappearance starts a new row, because it is a different moment.
 */
export function searchByValue(
  query: string,
  steps: readonly HistoryStep[],
  options: { contains?: boolean; index?: RunIndex; labelOf?: LabelOf } = {},
): SearchModel {
  const wanted = query.trim();
  const contains = options.contains === true;
  const labelOf = options.labelOf ?? (() => undefined);
  const empty = {
    query: wanted, rows: [], hits: 0, variables: 0, steps: 0,
    total: steps.length, more: 0, truncated: false,
  };
  if (!wanted) {
    return { ...empty, message: 'Type a value to find where it was held.' };
  }
  if (!steps.length) {
    return { ...empty, message: 'No recorded session yet. Run the debugger to the end, then search for a value.' };
  }

  const rows: ValueMatch[] = [];
  const open = new Map<string, ValueMatch>(); // the run in progress per (node, name, value)
  const names = new Set<string>();
  const hitSteps = new Set<number>();
  let hits = 0;
  let captured = 0;
  let truncated = false;

  steps.forEach((step, at) => {
    const frames = options.index ? options.index[at] : indexStep(step);
    if (!frames) {
      return; // the step captured nothing: it cannot match, and it is not a miss either
    }
    captured++;
    // Innermost frame first, which is the order indexStep produces, so a step's own rows read
    // from the current function outwards.
    for (const frame of frames) {
      for (const [name, resolved] of frame.index) {
        const value = resolved.value;
        if (value === undefined) {
          continue; // found but valueless: there is no value to match
        }
        if (value.endsWith('…')) {
          truncated = true; // capped at capture: `contains` cannot see the whole of this one
        }
        const tier = matchTier(value, wanted, contains);
        if (!tier) {
          continue;
        }
        hits++;
        names.add(name);
        hitSteps.add(at);
        const key = `${frame.nodeId}\u0000${name}\u0000${value}`;
        const run = open.get(key);
        if (run && run.lastIndex === at - 1) {
          run.lastIndex = at;
          run.steps++;
          continue;
        }
        const row: ValueMatch = {
          index: at, lastIndex: at, steps: 1,
          nodeId: frame.nodeId,
          label: labelOf(frame.nodeId) ?? frame.nodeId,
          name, value, origin: resolved.origin!, tier,
        };
        rows.push(row);
        open.set(key, row);
      }
    }
  });

  // Step order is the default and the natural reading. With `contains` on, the precise hits come
  // first instead, so loose ones can never sit above them; sort is stable, so step order survives
  // inside each tier.
  if (contains) {
    rows.sort((left, right) => TIER_RANK[left.tier] - TIER_RANK[right.tier]);
  }

  const more = Math.max(0, rows.length - MAX_RESULTS);
  return {
    query: wanted,
    rows: rows.slice(0, MAX_RESULTS),
    hits,
    variables: names.size,
    steps: hitSteps.size,
    total: steps.length,
    more,
    truncated,
    note: searchNote(wanted, names.size, hitSteps.size, steps.length, captured, contains, truncated),
  };
}

function searchNote(
  query: string,
  variables: number,
  steps: number,
  total: number,
  captured: number,
  contains: boolean,
  truncated: boolean,
): string {
  if (!captured) {
    return 'No variables were recorded for this session.';
  }
  if (!variables) {
    const scope = contains ? '' : ' Try "contains" for values inside lists and objects.';
    // No hits is exactly when a capped value could have been hiding one.
    const cut = truncated ? ' Long values were capped at 80 characters, so it may be in one of those.' : '';
    return `${query} was not held by any recorded variable.${cut}${scope}`;
  }
  const where = `${variables} ${variables === 1 ? 'variable' : 'variables'}`;
  const when = `${steps} of ${total} recorded ${total === 1 ? 'step' : 'steps'}`;
  // Only worth saying when it could actually have hidden a hit.
  const capped = contains && truncated ? ' · long values were capped at capture, so matches past 80 characters are not visible' : '';
  return `${query} found in ${where} across ${when}${capped}.`;
}
// --- end search by value ---
