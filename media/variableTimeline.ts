import type { HistoryStep } from '../src/types';
import { bareName, indexStep, mergedStep, type RunIndex } from './watchVariable';

// --- variable timeline ---

/**
 * Variable timeline: every variable's activity across a whole recorded run, at a glance.
 *
 * The third view of the same per-step capture, and the only one that is multi-variable:
 *   watch    = one name,  one moment, every node of the path  (space)
 *   history  = one name,  every step, as a list               (time)
 *   timeline = EVERY name, every step, as a grid              (time x variable)
 *
 * Name matching is not reimplemented: every value comes from watchVariable's indexFrame, which
 * shares frameEntries with resolveName, so a cell here and a row in the history can never disagree
 * about what a name resolved to. The data is session history's HistoryStep.values; nothing here
 * touches DAP, the counting hook, or the debuggee.
 *
 * Why the loop is inverted: resolving one name at a time would re-walk every frame once per lane
 * (24 lanes x 5000 steps x 6 frames of string compares). Instead each step is indexed ONCE and all
 * lanes read that index, which is the difference between seconds and milliseconds.
 *
 * History-only, and pure/DOM-free like watchModel and valueHistoryModel.
 */

/** Lanes shown before the rest are reported as "+N more". 24 lanes is already the pane's tallest. */
export const MAX_LANES = 24;
/** Columns shown. Past this, each column covers a BUCKET of steps - the run is never truncated. */
export const MAX_COLUMNS = 80;

/**
 * What one cell says. Shape and label carry this, never colour alone, and the two "no value" cases
 * stay apart for the same reason they do in the watch and the history: one is information about the
 * variable, the other is the absence of any information at all.
 */
export type CellState =
  /** The value differs from the previous step this variable had one at. */
  | 'changed'
  /** Present, and the same as last time. */
  | 'same'
  /** The step captured values, and this name was not among them. */
  | 'absent'
  /** The step captured nothing: says nothing about this variable. */
  | 'unrecorded';

export interface TimelineCell {
  state: CellState;
  /** First step this column covers (0-based). Equal to `lastStep` when a column is one step. */
  step: number;
  lastStep: number;
  /** Where a click should land: the first CHANGED step in the column, else its first step. */
  target: number;
  /** The value at `target`, when the column has one. Absent for absent/unrecorded. */
  value?: string;
  /** Steps in this column where the variable changed. Greater than 1 only for a bucket. */
  changes: number;
}

export interface TimelineLane {
  name: string;
  cells: TimelineCell[];
  changes: number;  // changed steps across the whole run
  present: number;  // steps the variable had a value at
  origin: 'arg' | 'local' | 'both'; // how it appeared over the run
  pinned: boolean;  // the name in the watch box: always the first lane
}

export interface TimelineModel {
  lanes: TimelineLane[];
  columns: number;
  /** Steps per column: 1 when the run fits, more when it is bucketed. */
  bucket: number;
  steps: number;
  /** Distinct names seen in the run, before MAX_LANES. */
  names: number;
  more: number;     // names past MAX_LANES, not in `lanes`
  note?: string;
  message?: string; // replaces the lanes entirely (nothing recorded)
}

/** Per-step state for one name, before any bucketing. */
interface Track {
  states: CellState[];
  values: (string | undefined)[];
  changes: number;
  present: number;
  args: number;
  locals: number;
}

function emptyTrack(length: number): Track {
  return {
    states: new Array<CellState>(length).fill('absent'),
    values: new Array<string | undefined>(length).fill(undefined),
    changes: 0, present: 0, args: 0, locals: 0,
  };
}

/** The strongest state in a bucket wins, so a change is never averaged away. */
const RANK: Record<CellState, number> = { changed: 3, same: 2, absent: 1, unrecorded: 0 };

/**
 * Collapses a name's per-step track into at most MAX_COLUMNS columns.
 * One column per step when the run fits; otherwise each column covers `bucket` consecutive steps.
 */
function toCells(track: Track, steps: number, bucket: number, columns: number): TimelineCell[] {
  const cells: TimelineCell[] = [];
  for (let column = 0; column < columns; column++) {
    const from = column * bucket;
    const to = Math.min(steps, from + bucket);
    let state: CellState = 'unrecorded';
    let changes = 0;
    let firstChange = -1;
    let firstHeld = -1;
    for (let step = from; step < to; step++) {
      const at = track.states[step];
      if (at === 'changed') {
        changes++;
        if (firstChange < 0) {
          firstChange = step;
        }
      } else if (at === 'same' && firstHeld < 0) {
        firstHeld = step;
      }
      if (RANK[at] > RANK[state]) {
        state = at;
      }
    }
    // A click lands on the first CHANGE in the column, so clicking a diamond goes to the change
    // you clicked; failing that, the first step that held the value; failing that, the column start.
    const target = firstChange >= 0 ? firstChange : firstHeld >= 0 ? firstHeld : from;
    const value = state === 'changed' || state === 'same' ? track.values[target] : undefined;
    cells.push({
      state, step: from, lastStep: to - 1, target, changes,
      ...(value === undefined ? {} : { value }),
    });
  }
  return cells;
}

/**
 * Every variable's activity across `steps` (oldest first, as session history sends them).
 *
 * Lanes are ranked so the informative ones survive the cap: the watched name first (so this agrees
 * with the watch and history sections about what you are looking at), then by number of changes - a
 * variable that changes forty times is the story, a constant is not - then by how long it was
 * present, then by name so the order does not jitter between renders.
 */
export function timelineModel(
  steps: readonly HistoryStep[],
  options: { pinned?: string; index?: RunIndex } = {},
): TimelineModel {
  const pinned = bareName((options.pinned ?? '').trim());
  if (!steps.length) {
    return {
      lanes: [], columns: 0, bucket: 1, steps: 0, names: 0, more: 0,
      message: 'No recorded session yet. Run the debugger to the end, then pick a variable.',
    };
  }

  // One pass: index each step once, and grow a track per name as it is first seen.
  const tracks = new Map<string, Track>();
  const previous = new Map<string, string>(); // last value seen, for change detection
  let unrecorded = 0;
  steps.forEach((step, index) => {
    // search by value: the run's index is built once and shared when the caller has it.
    const frames = options.index ? options.index[index] : indexStep(step);
    const indexed = frames && mergedStep(frames);
    if (!indexed) {
      unrecorded++;
      for (const track of tracks.values()) {
        track.states[index] = 'unrecorded';
      }
      return;
    }
    for (const [name, resolved] of indexed) {
      let track = tracks.get(name);
      if (!track) {
        track = emptyTrack(steps.length);
        // Steps before this name was ever seen are not "absent by measurement" for unrecorded
        // steps, so mark those back as unrecorded to keep the two meanings honest.
        for (let before = 0; before < index; before++) {
          if (!steps[before].values) {
            track.states[before] = 'unrecorded';
          }
        }
        tracks.set(name, track);
      }
      if (resolved.value === undefined) {
        continue; // found but valueless: nothing to chart, and not a change
      }
      track.present++;
      if (resolved.origin === 'arg') {
        track.args++;
      } else {
        track.locals++;
      }
      track.values[index] = resolved.value;
      // `previous` survives unrecorded steps on purpose: a gap we could not observe is no
      // evidence of a change, so the same value either side of one reads as held, not changed.
      // Kept per function: `n` in two functions is two variables that happen to share a lane. A
      // first sighting has nothing to differ from, so it is not a change either.
      const key = `${frames!.find(frame => frame.index.has(name))!.nodeId}\u0000${name}`;
      const was = previous.get(key);
      const changed = was !== undefined && was !== resolved.value;
      track.states[index] = changed ? 'changed' : 'same';
      if (changed) {
        track.changes++;
      }
      previous.set(key, resolved.value);
    }
  });

  const bucket = Math.ceil(steps.length / MAX_COLUMNS) || 1;
  const columns = Math.ceil(steps.length / bucket);
  const ranked = [...tracks.entries()]
    .map(([name, track]) => ({ name, track }))
    .sort((left, right) =>
      Number(right.name === pinned) - Number(left.name === pinned)
      || right.track.changes - left.track.changes
      || right.track.present - left.track.present
      || left.name.localeCompare(right.name));

  const lanes = ranked.slice(0, MAX_LANES).map(({ name, track }) => ({
    name,
    cells: toCells(track, steps.length, bucket, columns),
    changes: track.changes,
    present: track.present,
    origin: (track.args && track.locals ? 'both' : track.args ? 'arg' : 'local') as TimelineLane['origin'],
    pinned: name === pinned && name !== '',
  }));

  return {
    lanes,
    columns,
    bucket,
    steps: steps.length,
    names: tracks.size,
    more: Math.max(0, tracks.size - MAX_LANES),
    note: timelineNote(tracks.size, steps.length, bucket, unrecorded),
  };
}

function timelineNote(names: number, steps: number, bucket: number, unrecorded: number): string {
  if (!names) {
    return unrecorded === steps
      ? 'No variables were recorded for this session.'
      : `No variables were captured across ${steps} recorded steps.`;
  }
  const scale = bucket === 1
    ? 'one column per step'
    : `each column = ${bucket} steps`;
  const blind = unrecorded ? ` · ${unrecorded} recorded no variables` : '';
  return `${names} ${names === 1 ? 'variable' : 'variables'} · ${steps} steps · ${scale}${blind}.`;
}

/** What a cell means, in words. Every cell carries this, so shape is never the only channel. */
export function cellLabel(name: string, cell: TimelineCell): string {
  const when = cell.step === cell.lastStep
    ? `step ${cell.step + 1}`
    : `steps ${cell.step + 1}-${cell.lastStep + 1}`;
  switch (cell.state) {
    case 'changed':
      return cell.changes > 1
        ? `${when} · ${name} = ${cell.value} (${cell.changes} changes)`
        : `${when} · ${name} = ${cell.value} (changed)`;
    case 'same':
      return `${when} · ${name} = ${cell.value}`;
    case 'absent':
      return `${when} · ${name} not in scope`;
    case 'unrecorded':
      return `${when} · no variables recorded`;
  }
}

/** The glyph for a state. Distinct shapes, so the grid reads without colour. */
export function cellGlyph(state: CellState): string {
  switch (state) {
    case 'changed':
      return '◆'; // filled diamond: the signal
    case 'same':
      return '·'; // middle dot: holding
    case 'absent':
      return '';       // nothing drawn; a dotted underline marks the slot
    case 'unrecorded':
      return '?';      // we do not know, which is not the same as "not there"
  }
}
// --- end variable timeline ---
