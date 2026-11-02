import type { CallArg, CallValue, VariableChildren } from '../src/types';

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
  /** Scrubbing a recorded step: history never captured variables, so values would be a lie. */
  historyStep?: boolean;
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
    return []; // not here yet, or the pause it belonged to is gone; the parent shows as loading
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
    loading: expanded && children.length === 0,
  };
  return [row, ...children];
}

/** The whole pane: three sections for the selected node, or a single message when there is nothing. */
export function paneModel(input: PaneInput): PaneModel {
  if (!input.label) {
    return { sections: [], stale: false, message: 'Click a function to inspect its variables.' };
  }
  if (input.historyStep) {
    return { sections: [], stale: false, message: 'No variables recorded for this step.' };
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
}

/** Draws the model into the pane and owns which rows the user has opened. */
export class VariablePane {
  private readonly expanded = new Set<string>();
  private input: PaneInput = { expanded: this.expanded, children: new Map() };

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

  private render(): void {
    const model = paneModel(this.input);
    this.title.textContent = this.input.label ?? 'Variables';
    this.host.classList.toggle('stale', model.stale);
    this.host.replaceChildren();
    const doc = this.host.ownerDocument;

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
      this.expanded.add(row.key);
      if (!this.input.children.has(row.ref)) {
        this.deps.requestChildren(row.ref); // the answer re-renders through update()
      }
    }
    this.render();
  }
}
// --- end variable inspector panel ---
