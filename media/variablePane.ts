import type { CallArg, CallValue, StepValues, VariableChildren } from '../src/types';
// --- watch variable ---
import { watchMissText, watchModel, type WatchFrame, type WatchModel } from './watchVariable';
// --- end watch variable ---
// --- variable history ---
import { valueHistoryModel, type LabelOf, type ValueHistoryModel } from './variableHistory';
import type { HistoryStep } from '../src/types';
// --- end variable history ---
// --- variable timeline ---
import { cellGlyph, cellLabel, timelineModel, type TimelineCell, type TimelineModel } from './variableTimeline';
// --- end variable timeline ---
// --- search by value ---
import { searchByValue, type SearchModel, type ValueMatch } from './searchByValue';
import { indexRun, type RunIndex } from './watchVariable';
// --- end search by value ---

// --- variable inspector panel ---

/**
 * The variable inspector's view model and rendering.
 *
 * Consumes what the other features already capture - renderer.callValue() for arguments and
 * locals, the `returns` record for the return value, and the expandVariable/variableChildren
 * round-trip for children - and turns it into flat, indentable rows. The model half is pure so it
 * can be tested headlessly; only VariablePane touches the DOM.
 */

/** A row the pane draws: one variable, or a "+N more" marker. */
export interface PaneRow {
  key: string;      // stable identity across re-renders: "args/items", "args/items/0"
  name: string;
  value: string;
  type?: string;
  ref?: number;     // set when the row can be expanded; absent on scalars and on stale values
  depth: number;
  expanded: boolean;
  loading: boolean; // expanded, but its children have not arrived yet
  note?: boolean;   // a "+N more" row rather than a variable
}

export interface PaneSection {
  id: 'args' | 'locals' | 'return';
  title: string;
  note?: string;    // the "value at pause" style caveat
  rows: PaneRow[];
  empty?: string;   // shown instead of rows when there are none
}

export interface PaneModel {
  sections: PaneSection[];
  stale: boolean;
  message?: string; // replaces the sections entirely (no selection, history step, ...)
}

export interface PaneInput {
  label?: string;                                    // the selected node's name
  value?: CallValue;                                 // arguments + locals, from the last pause
  returnValue?: string;                              // from the hot-path hook
  expanded: ReadonlySet<string>;                     // row keys the user has opened
  children: ReadonlyMap<number, VariableChildren>;   // what the round-trip has answered so far
  /** Scrubbing a recorded step: the live values belong to another moment, so they are not shown. */
  historyStep?: boolean;
  // --- per-step variable capture ---
  /** What that step recorded for the selected node, if anything. Only read while `historyStep`. */
  historyValues?: StepValues;
  // --- end per-step variable capture ---
}

/** Children of an expanded row, flattened depth-first. Rows are only expandable while live. */
function childRows(
  parentKey: string,
  ref: number,
  depth: number,
  input: PaneInput,
  stale: boolean,
): PaneRow[] {
  const answer = input.children.get(ref);
  if (!answer || answer.stale) {
    return []; // not here yet, or the reference could not be answered
  }
  if (!answer.children.length && !answer.more) {
    return [{ key: `${parentKey}/+empty`, name: '(empty)', value: '', depth, expanded: false, loading: false, note: true }];
  }
  const rows: PaneRow[] = [];
  for (const child of answer.children) {
    rows.push(...variableRows(`${parentKey}/${child.name}`, child, depth, input, stale));
  }
  if (answer.more) {
    rows.push({
      key: `${parentKey}/+more`, name: `+${answer.more} more`, value: '',
      depth, expanded: false, loading: false, note: true,
    });
  }
  return rows;
}

/** One variable as a row, followed by its children when it is expanded. */
function variableRows(key: string, arg: CallArg, depth: number, input: PaneInput, stale: boolean): PaneRow[] {
  // A dead reference must not offer a disclosure that cannot be answered.
  const ref = stale ? undefined : arg.ref;
  const expanded = ref !== undefined && input.expanded.has(key);
  const children = expanded ? childRows(key, ref, depth + 1, input, stale) : [];
  const row: PaneRow = {
    key,
    name: arg.name,
    value: arg.value ?? '(not in locals)',
    ...(arg.type === undefined ? {} : { type: arg.type }),
    ...(ref === undefined ? {} : { ref }),
    depth,
    expanded,
    loading: expanded && !input.children.has(ref), // no answer yet; an answer with no rows is not loading
  };
  return [row, ...children];
}

// --- per-step variable capture ---
/**
 * A recorded step: the strings session history captured at that pause.
 *
 * Read-only by construction - every `ref` was stripped at capture, so variableRows draws leaves and
 * offers no disclosure that could not be answered. `stale` is false: these values are not a stale
 * reading of the present, they are an accurate reading of the past, and the resume banner would
 * misdescribe them. There is no Return value section either: return values are a latest-per-node
 * record from the hot-path hook, not per-step, so showing one beside a past pause would be a lie.
 */
function historyModel(input: PaneInput): PaneModel {
  const values = input.historyValues;
  if (!values) {
    return { sections: [], stale: false, message: 'No variables recorded for this step.' };
  }
  const hidden = (values.localsCount ?? values.locals.length) - values.locals.length;
  return {
    stale: false,
    sections: [
      {
        id: 'args',
        title: 'Arguments',
        note: values.atEntry
          ? 'Recorded at this step, paused on the first line: values as passed.'
          : 'Recorded at this step: values as they were at that pause.',
        rows: values.args.flatMap(arg => variableRows(`args/${arg.name}`, arg, 0, input, false)),
        empty: 'No parameters.',
      },
      {
        id: 'locals',
        title: 'Local variables',
        ...(hidden > 0 ? { note: `${hidden} more not recorded.` } : {}),
        rows: values.locals.flatMap(local => variableRows(`locals/${local.name}`, local, 0, input, false)),
        empty: 'None bound yet at this pause.',
      },
    ],
  };
}
// --- end per-step variable capture ---

/** The whole pane: three sections for the selected node, or a single message when there is nothing. */
export function paneModel(input: PaneInput): PaneModel {
  if (!input.label) {
    return { sections: [], stale: false, message: 'Click a function to inspect its variables.' };
  }
  if (input.historyStep) {
    return historyModel(input);
  }
  const value = input.value;
  const stale = value?.stale === true;
  if (!value && input.returnValue === undefined) {
    return {
      sections: [], stale: false,
      message: 'No variables captured yet. Pause the debugger inside this function to inspect it.',
    };
  }

  const sections: PaneSection[] = [];
  if (value) {
    sections.push({
      id: 'args',
      title: 'Arguments',
      note: value.atEntry
        ? 'Paused on the first line: values as passed.'
        : 'Values at the pause: may have been reassigned since the call.',
      rows: value.args.flatMap(arg => variableRows(`args/${arg.name}`, arg, 0, input, stale)),
      empty: 'No parameters.',
    });
    const locals = value.locals ?? [];
    const hidden = (value.localsCount ?? locals.length) - locals.length;
    sections.push({
      id: 'locals',
      title: 'Local variables',
      ...(hidden > 0 ? { note: `${hidden} more not shown.` } : {}),
      rows: locals.flatMap(local => variableRows(`locals/${local.name}`, local, 0, input, stale)),
      empty: 'None bound yet at this pause.',
    });
  }
  sections.push({
    id: 'return',
    title: 'Return value',
    // The hook formats this in the user's process and keeps no object, so there is nothing to expand.
    rows: input.returnValue === undefined ? [] : [{
      key: 'return', name: 'returns', value: input.returnValue, depth: 0, expanded: false, loading: false,
    }],
    empty: 'Not recorded yet (Python 3.12+, and the call must have returned).',
  });
  return { sections, stale };
}

export interface VariablePaneDeps {
  /** Ask the extension for a page of children; the answer arrives as a variableChildren message. */
  requestChildren(ref: number): void;
  // --- watch variable ---
  /** The names this path offers, so the input's suggestion list can be refreshed. */
  watchNamesChanged?(names: string[]): void;
  // --- end watch variable ---
  // --- variable history ---
  /** A timeline entry was clicked: select that recorded step across the whole UI. */
  historyStepPicked?(index: number): void;
  /** Names a graph node for a timeline row; undefined when this graph has no such node. */
  labelOf?: LabelOf;
  // --- end variable history ---
}

/** Draws the model into the pane and owns which rows the user has opened. */
export class VariablePane {
  // --- search by value ---
  /** Runs longer than this are searched without a cached index; see `cachedIndex`. */
  public static readonly MAX_INDEXED_STEPS = 1500;
  // --- end search by value ---
  private readonly expanded = new Set<string>();
  private input: PaneInput = { expanded: this.expanded, children: new Map() };
  // --- watch variable ---
  // Kept beside the inspector's state rather than inside it: the watch follows the PATH, the
  // inspector follows the SELECTED NODE, and they change at different moments.
  private watchName = '';
  private watchFrames: WatchFrame[] = [];
  // --- end watch variable ---
  // --- variable history ---
  // The recorded run, shared with the watch's name: one box, two axes.
  private historySteps: readonly HistoryStep[] = [];
  // --- end variable history ---
  // --- variable timeline ---
  // render() runs on every path change, and both the history and the timeline walk the WHOLE run,
  // so their models are cached against the steps (and, for the history, the name) they were built
  // from. Without this, dragging through a 5000-step run's paths rescans it on every frame.
  private cachedHistory?: { steps: readonly HistoryStep[]; name: string; model: ValueHistoryModel };
  private cachedTimeline?: { steps: readonly HistoryStep[]; pinned: string; model: TimelineModel };
  /** The timeline is collapsed until opened; kept in memory, so it survives re-renders only. */
  private timelineOpen = false;
  // --- end variable timeline ---
  // --- search by value ---
  private searchQuery = '';
  private searchContains = false;
  private cachedSearch?: { steps: readonly HistoryStep[]; query: string; contains: boolean; model: SearchModel };
  /**
   * The run indexed once, shared by the timeline and the value search, so between them the steps
   * are walked a single time instead of once per feature and once per keystroke.
   *
   * Only cached for runs up to MAX_INDEXED_STEPS. A full index costs roughly six maps of up to
   * twenty entries PER STEP, so a worst-case 5000-step run would cost far more memory than the
   * recording itself; past the limit both features index on demand, which is slower but correct
   * and bounded. The search input is debounced for that case.
   */
  private cachedIndex?: { steps: readonly HistoryStep[]; index: RunIndex };
  // --- end search by value ---

  constructor(
    private readonly host: HTMLElement,
    private readonly title: HTMLElement,
    private readonly deps: VariablePaneDeps,
  ) {}

  /** Everything except the expansion state, which the pane owns itself. */
  public update(input: Omit<PaneInput, 'expanded'>): void {
    const sameNode = input.label === this.input.label;
    this.input = { ...input, expanded: this.expanded };
    if (!sameNode) {
      this.expanded.clear(); // a different function: start collapsed
    }
    this.render();
  }

  // --- watch variable ---
  /**
   * The watched name and the path to resolve it against.
   *
   * Deliberately NOT a field on update(): that clears the expansion set whenever the selected
   * function changes, and the path changes on its own schedule, so routing watch refreshes through
   * it would collapse open trees for no reason.
   */
  public setWatch(name: string, frames: readonly WatchFrame[]): void {
    this.watchName = name;
    this.watchFrames = [...frames];
    this.render();
  }

  public get watched(): string {
    return this.watchName;
  }
  // --- end watch variable ---

  // --- variable history ---
  /**
   * The finished session's recorded steps. Separate from setWatch for the same reason setWatch is
   * separate from update(): the recording arrives once per session, the path changes constantly,
   * and the selection changes on its own - none of them should re-render the others' state away.
   */
  public setHistory(steps: readonly HistoryStep[]): void {
    this.historySteps = [...steps];
    this.render();
  }
  // --- end variable history ---

  // --- variable timeline ---
  /** The history model for the current name and run, computed once per (steps, name). */
  private historyModelCached(): ValueHistoryModel {
    const cached = this.cachedHistory;
    if (cached && cached.steps === this.historySteps && cached.name === this.watchName) {
      return cached.model;
    }
    const model = valueHistoryModel(this.watchName, this.historySteps, this.deps.labelOf);
    this.cachedHistory = { steps: this.historySteps, name: this.watchName, model };
    return model;
  }

  /** The timeline model for the current run, computed once per (steps, pinned name). */
  private timelineModelCached(): TimelineModel {
    const pinned = this.watchName.trim();
    const cached = this.cachedTimeline;
    if (cached && cached.steps === this.historySteps && cached.pinned === pinned) {
      return cached.model;
    }
    const model = timelineModel(this.historySteps, { pinned, index: this.runIndex() });
    this.cachedTimeline = { steps: this.historySteps, pinned, model };
    return model;
  }
  // --- end variable timeline ---

  // --- search by value ---
  /** The shared run index, or undefined for a run too long to hold one (see cachedIndex). */
  private runIndex(): RunIndex | undefined {
    if (!this.historySteps.length || this.historySteps.length > VariablePane.MAX_INDEXED_STEPS) {
      return undefined;
    }
    const cached = this.cachedIndex;
    if (cached && cached.steps === this.historySteps) {
      return cached.index;
    }
    const index = indexRun(this.historySteps);
    this.cachedIndex = { steps: this.historySteps, index };
    return index;
  }

  private searchModelCached(): SearchModel {
    const cached = this.cachedSearch;
    if (cached && cached.steps === this.historySteps
      && cached.query === this.searchQuery && cached.contains === this.searchContains) {
      return cached.model;
    }
    const model = searchByValue(this.searchQuery, this.historySteps, {
      contains: this.searchContains,
      index: this.runIndex(),
      labelOf: this.deps.labelOf,
    });
    this.cachedSearch = {
      steps: this.historySteps, query: this.searchQuery, contains: this.searchContains, model,
    };
    return model;
  }

  /** The value being searched for, and whether loose substring hits are wanted. */
  public setSearch(query: string, contains: boolean): void {
    this.searchQuery = query;
    this.searchContains = contains;
    this.render();
  }
  // --- end search by value ---

  private render(): void {
    const model = paneModel(this.input);
    // Every row waiting on an answer asks for it: a row left open across a pause has a new ref and
    // an emptied cache. The host sends each ref once per pause, so re-rendering costs nothing.
    for (const row of model.sections.flatMap(section => section.rows)) {
      if (row.loading && row.ref !== undefined) {
        this.deps.requestChildren(row.ref);
      }
    }
    this.title.textContent = this.input.label ?? 'Variables';
    this.host.classList.toggle('stale', model.stale);
    this.host.replaceChildren();
    const doc = this.host.ownerDocument;

    // --- watch variable ---
    // First, and before the early return below: the watch follows the path, so it has something to
    // say even when no function is selected and the inspector only has a message.
    this.renderWatch(doc);
    // --- end watch variable ---
    // --- variable history ---
    // The time axis, right under the space axis: one name, two sections, same order every render.
    this.renderValueHistory(doc);
    // --- end variable history ---
    // --- variable timeline ---
    // Always present once a run is recorded, but collapsed, so the multi-variable grid costs no
    // vertical space in a pane that already stacks four sections.
    this.renderTimeline(doc);
    // --- end variable timeline ---
    // --- search by value ---
    // Only when something is being searched for: a search is an active act, so it needs no
    // disclosure to click open, and it costs nothing when the box is empty.
    this.renderSearch(doc);
    // --- end search by value ---

    if (model.stale) {
      const note = this.host.appendChild(doc.createElement('p'));
      note.className = 'pane-stale';
      note.textContent = 'Program has resumed: these are the values from the last pause, and they can no longer be expanded.';
    }
    if (model.message) {
      const note = this.host.appendChild(doc.createElement('p'));
      note.className = 'pane-message';
      note.textContent = model.message;
      return;
    }

    for (const section of model.sections) {
      const block = this.host.appendChild(doc.createElement('section'));
      block.className = 'pane-section';
      const heading = block.appendChild(doc.createElement('h3'));
      heading.textContent = section.title;
      if (section.note) {
        const note = block.appendChild(doc.createElement('p'));
        note.className = 'pane-note';
        note.textContent = section.note;
      }
      if (!section.rows.length) {
        const note = block.appendChild(doc.createElement('p'));
        note.className = 'pane-note';
        note.textContent = section.empty ?? '';
        continue;
      }
      for (const row of section.rows) {
        block.appendChild(this.rowElement(row, doc));
      }
    }
  }

  // --- watch variable ---
  /** The watch section: one row per node of the path, or a single message. */
  private renderWatch(doc: Document): WatchModel {
    const model = watchModel(this.watchName, this.watchFrames);
    this.deps.watchNamesChanged?.(model.names);
    if (!this.watchName.trim()) {
      return model; // nothing watched: the pane looks exactly as it did before this feature
    }
    const block = this.host.appendChild(doc.createElement('section'));
    block.className = 'pane-section watch-section';
    const heading = block.appendChild(doc.createElement('h3'));
    heading.textContent = `Watch: ${model.name}`;
    if (model.message) {
      const note = block.appendChild(doc.createElement('p'));
      note.className = 'pane-note';
      note.textContent = model.message;
      return model;
    }
    if (model.note) {
      const note = block.appendChild(doc.createElement('p'));
      note.className = 'pane-note';
      note.textContent = model.note;
    }
    model.rows.forEach((row, index) => {
      const element = block.appendChild(doc.createElement('div'));
      // Reuses the inspector's row classes, so one stylesheet change moves both.
      element.className = row.value === undefined ? 'pane-row watch-row watch-miss' : 'pane-row watch-row';
      element.dataset.key = `watch/${index}/${row.id}`;

      const name = element.appendChild(doc.createElement('span'));
      name.className = 'pane-name watch-label';
      name.textContent = row.repeats > 1 ? `${row.label} x${row.repeats}` : row.label;
      name.title = row.repeats > 1
        ? `${row.repeats} positions on this path; the value is the innermost call's`
        : row.label;

      const value = element.appendChild(doc.createElement('span'));
      value.className = 'pane-value';
      value.textContent = row.value ?? watchMissText(row.miss!);

      if (row.origin) {
        const origin = element.appendChild(doc.createElement('span'));
        origin.className = 'pane-type';
        origin.textContent = row.origin;
      }
    });
    return model;
  }
  // --- end watch variable ---

  // --- variable history ---
  /** The value-history section: one row per recorded change, gaps marked, each row clickable. */
  private renderValueHistory(doc: Document): ValueHistoryModel {
    const model = this.historyModelCached(); // variable timeline: shared memoization
    if (!this.watchName.trim()) {
      return model; // nothing watched: the pane looks exactly as it did before this feature
    }
    const block = this.host.appendChild(doc.createElement('section'));
    block.className = 'pane-section vhistory-section';
    const heading = block.appendChild(doc.createElement('h3'));
    heading.textContent = `History: ${model.name}`;
    const note = block.appendChild(doc.createElement('p'));
    note.className = 'pane-note';
    note.textContent = model.message ?? model.note ?? '';
    if (model.message) {
      return model;
    }

    for (const row of model.rows) {
      if (row.kind === 'gap') {
        const marker = block.appendChild(doc.createElement('p'));
        marker.className = 'pane-note vhistory-gap';
        const absent = row.steps - row.unrecorded;
        // The two halves of a gap mean different things, so they are counted separately.
        marker.textContent = row.unrecorded && absent
          ? `… ${absent} steps without it, ${row.unrecorded} with nothing recorded`
          : row.unrecorded
            ? `… ${row.unrecorded} steps recorded no variables`
            : `… ${absent} ${absent === 1 ? 'step' : 'steps'} without a value`;
        continue;
      }
      block.appendChild(this.historyRow(row, doc));
    }
    if (model.more) {
      const trailing = block.appendChild(doc.createElement('p'));
      trailing.className = 'pane-note';
      trailing.textContent = `+${model.more} more changes not shown`;
    }
    return model;
  }

  /** One timeline entry. A button, because clicking it moves the whole UI to that step. */
  private historyRow(row: Extract<ValueHistoryModel['rows'][number], { kind: 'value' }>, doc: Document): HTMLElement {
    const element = doc.createElement('button');
    element.type = 'button';
    element.className = 'pane-row vhistory-row';
    element.dataset.step = String(row.index);
    const span = row.steps > 1 ? `steps ${row.index + 1}-${row.lastIndex + 1}` : `step ${row.index + 1}`;
    element.title = `Go to ${span} · ${row.label} · ${row.origin} · ${row.time} ms`;

    const step = element.appendChild(doc.createElement('span'));
    step.className = 'pane-type vhistory-step';
    // 1-based, to match the step labels the scrubber already shows.
    step.textContent = row.steps > 1 ? `${row.index + 1}-${row.lastIndex + 1}` : `${row.index + 1}`;

    const label = element.appendChild(doc.createElement('span'));
    label.className = 'pane-name vhistory-label';
    label.textContent = row.label;

    const value = element.appendChild(doc.createElement('span'));
    value.className = 'pane-value';
    value.textContent = row.value;

    element.addEventListener('click', () => this.deps.historyStepPicked?.(row.index));
    return element;
  }
  // --- end variable history ---

  // --- variable timeline ---
  /** The multi-variable grid, inside a details/summary so it opens only when wanted. */
  private renderTimeline(doc: Document): TimelineModel {
    const model = this.timelineModelCached();
    const block = this.host.appendChild(doc.createElement('details'));
    block.className = 'pane-section vtimeline-section';
    if (this.timelineOpen) {
      block.setAttribute('open', 'open');
    }
    // The summary stays useful closed: it says how much there is to see.
    const summary = block.appendChild(doc.createElement('summary'));
    summary.textContent = model.lanes.length
      ? `Variable timeline (${model.names} across ${model.steps} steps)`
      : 'Variable timeline';
    summary.addEventListener('click', () => { this.timelineOpen = !this.timelineOpen; });

    const note = block.appendChild(doc.createElement('p'));
    note.className = 'pane-note';
    note.textContent = model.message ?? model.note ?? '';
    if (model.message || !model.lanes.length) {
      return model;
    }

    const grid = block.appendChild(doc.createElement('div'));
    grid.className = 'vtimeline-grid';
    for (const lane of model.lanes) {
      const row = grid.appendChild(doc.createElement('div'));
      row.className = lane.pinned ? 'vtimeline-lane vtimeline-pinned' : 'vtimeline-lane';

      const label = row.appendChild(doc.createElement('span'));
      label.className = 'pane-name vtimeline-name';
      label.textContent = lane.name;
      // The lane's own summary in words and numbers: the grid is never the only readout.
      label.title = `${lane.name} · ${lane.changes} ${lane.changes === 1 ? 'change' : 'changes'}`
        + ` · present at ${lane.present} of ${model.steps} steps · ${lane.origin}`;

      const strip = row.appendChild(doc.createElement('span'));
      strip.className = 'vtimeline-strip';
      for (const cell of lane.cells) {
        strip.appendChild(this.timelineCell(lane.name, cell, doc));
      }
    }
    if (model.more) {
      const trailing = block.appendChild(doc.createElement('p'));
      trailing.className = 'pane-note';
      trailing.textContent = `+${model.more} more variables (ranked by changes)`;
    }
    return model;
  }

  /**
   * One cell. A button when there is a step worth going to, a span otherwise, so only meaningful
   * cells are focusable. State rides on the glyph, the class AND the label - never colour alone.
   */
  private timelineCell(name: string, cell: TimelineCell, doc: Document): HTMLElement {
    const clickable = cell.state === 'changed' || cell.state === 'same';
    const element = doc.createElement(clickable ? 'button' : 'span');
    element.className = `vtimeline-cell vtimeline-${cell.state}`;
    element.textContent = cellGlyph(cell.state);
    const label = cellLabel(name, cell);
    element.title = label;
    element.setAttribute('aria-label', label);
    element.dataset.state = cell.state;
    element.dataset.step = String(cell.target);
    if (clickable) {
      (element as HTMLButtonElement).type = 'button';
      element.addEventListener('click', () => this.deps.historyStepPicked?.(cell.target));
    }
    return element;
  }
  // --- end variable timeline ---

  // --- search by value ---
  /** Where a value was held: one row per collapsed (node, variable, value) run. */
  private renderSearch(doc: Document): SearchModel {
    if (!this.searchQuery.trim()) {
      return this.searchModelCached(); // nothing searched: no section at all
    }
    const model = this.searchModelCached();
    const block = this.host.appendChild(doc.createElement('section'));
    block.className = 'pane-section vsearch-section';
    const heading = block.appendChild(doc.createElement('h3'));
    heading.textContent = `Value: ${model.query}`;

    const note = block.appendChild(doc.createElement('p'));
    note.className = 'pane-note';
    note.textContent = model.message ?? model.note ?? '';
    if (model.message || !model.rows.length) {
      return model;
    }

    for (const row of model.rows) {
      block.appendChild(this.searchRow(row, doc));
    }
    if (model.more) {
      const trailing = block.appendChild(doc.createElement('p'));
      trailing.className = 'pane-note';
      trailing.textContent = `+${model.more} more matches not shown`;
    }
    return model;
  }

  /** One match. A button, because clicking it moves the whole UI to that step. */
  private searchRow(row: ValueMatch, doc: Document): HTMLElement {
    const element = doc.createElement('button');
    element.type = 'button';
    element.className = `pane-row vsearch-row vsearch-${row.tier}`;
    element.dataset.step = String(row.index);
    element.dataset.tier = row.tier;
    const span = row.steps > 1 ? `steps ${row.index + 1}-${row.lastIndex + 1}` : `step ${row.index + 1}`;
    const label = `Go to ${span} · ${row.label} · ${row.name} = ${row.value} · ${row.origin} · ${row.tier} match`;
    element.title = label;
    element.setAttribute('aria-label', label);

    const step = element.appendChild(doc.createElement('span'));
    step.className = 'pane-type vsearch-step';
    step.textContent = row.steps > 1 ? `${row.index + 1}-${row.lastIndex + 1}` : `${row.index + 1}`;

    const where = element.appendChild(doc.createElement('span'));
    where.className = 'pane-name vsearch-where';
    where.textContent = `${row.label}.${row.name}`;

    const value = element.appendChild(doc.createElement('span'));
    value.className = 'pane-value';
    // The stored repr, verbatim: this is what makes a numeric or contains hit explain itself.
    value.textContent = row.value;

    // The tier is on the row in words as well as in its class, so a loose hit is never silent.
    const tier = element.appendChild(doc.createElement('span'));
    tier.className = 'pane-type vsearch-tier';
    tier.textContent = row.tier;

    element.addEventListener('click', () => this.deps.historyStepPicked?.(row.index));
    return element;
  }
  // --- end search by value ---

  private rowElement(row: PaneRow, doc: Document): HTMLElement {
    const element = doc.createElement('div');
    element.className = row.note ? 'pane-row pane-row-note' : 'pane-row';
    element.style.paddingLeft = `${row.depth * 14}px`;
    element.dataset.key = row.key;

    if (row.ref !== undefined) {
      const toggle = element.appendChild(doc.createElement('button'));
      toggle.type = 'button';
      toggle.className = 'pane-twisty';
      toggle.textContent = row.expanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(row.expanded));
      toggle.setAttribute('aria-label', `${row.expanded ? 'Collapse' : 'Expand'} ${row.name}`);
      toggle.addEventListener('click', () => this.toggle(row));
    } else if (!row.note) {
      const spacer = element.appendChild(doc.createElement('span'));
      spacer.className = 'pane-twisty pane-twisty-leaf';
      spacer.textContent = '';
    }

    const name = element.appendChild(doc.createElement('span'));
    name.className = 'pane-name';
    name.textContent = row.name;
    if (!row.note) {
      const value = element.appendChild(doc.createElement('span'));
      value.className = 'pane-value';
      value.textContent = row.loading ? 'loading…' : row.value;
      if (row.type) {
        const type = element.appendChild(doc.createElement('span'));
        type.className = 'pane-type';
        type.textContent = row.type;
      }
    }
    return element;
  }

  private toggle(row: PaneRow): void {
    if (row.ref === undefined) {
      return;
    }
    if (this.expanded.has(row.key)) {
      this.expanded.delete(row.key);
    } else {
      this.expanded.add(row.key); // render() requests the children if they are not here yet
    }
    this.render();
  }
}
// --- end variable inspector panel ---
