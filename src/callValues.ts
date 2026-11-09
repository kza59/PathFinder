import type { CallArg, CallValue, CallValues, VariableChildren } from './types';

/**
 * Call values (Python only): labels graph nodes with the argument values of the calls that are on
 * the stack when the debugger pauses: "(a=3, b=4)" under the node's name.
 *
 * Read over DAP at each pause: scopes -> "Locals" -> variables, filtered to the parameter names
 * parsed from the function's `def` signature (debugpy has no separate "Arguments" scope, and DAP
 * doesn't mark which locals are parameters). Locals hold the values AT THE PAUSE, so a parameter
 * reassigned before the pause shows its new value; `atEntry` says when the pause is on the first
 * body line, before the body has run.
 *
 * The same Locals read also feeds the local variables feature (formatCallLocals below), which takes
 * the other side of that filter: the names in Locals that the signature does NOT account for.
 *
 * Limitation: only functions on the stack at a pause are seen. A call that starts and returns
 * between two pauses is never captured. No return values.
 *
 * Everything here is free of `vscode` imports so it runs under plain Node unit tests.
 */

export const CALL_VALUES_DEBUG_TYPES = ['debugpy', 'python'];

/** DAP requests that resume the program; frame ids are invalid after any of them. */
export const RESUME_COMMANDS = new Set([
  'continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto', 'restartFrame',
]);

const MAX_VALUE = 24;      // one value on the node
const MAX_LINE = 44;       // the whole args line on the node (wraps to two lines at most)
const MAX_FULL = 300;      // one value in the tooltip
const MAX_NODES = 20;      // deepest stacks: only the innermost distinct functions are fetched
const DEBOUNCE_MS = 100;   // VS Code fetches the stack in pages; capture once they've arrived

// --- local variables feature ---
const MAX_LOCAL_VALUE = 16;  // one local's value in a band row (tighter than args: three rows share the width)
const MAX_LOCAL_ROW = 34;    // one band row, so a long value can't reach the next column
const MAX_LOCAL_ROWS = 5;    // rows on the node before "+N more" (ROW_GAP leaves room for five)
const MAX_LOCALS_LIST = 20;  // locals in the tooltip, which also bounds the callValues message
// --- end local variables feature ---

// --- expand complex variables feature ---
export const MAX_CHILDREN = 50; // children fetched per page, which also bounds one response
// --- end expand complex variables feature ---

export interface Param {
  name: string;                            // bare name, as debugpy lists it in Locals
  kind: 'normal' | 'varargs' | 'kwargs';  // *args / **kwargs
}

export interface Signature {
  params: Param[];
  firstBodyLine: number; // 1-based: first line of the body (the def line itself for one-liners)
}

/**
 * Parses the parameter names of the Python `def` whose name is on `defLine` (1-based, as graph
 * nodes store it). Handles multi-line signatures, annotations, defaults (including ones with
 * commas, brackets and strings), `self`, `/`, bare `*`, `*args`, `**kwargs`.
 * Returns undefined when that line has no `def` (e.g. a <module> node).
 */
export function parseSignature(lines: string[], defLine: number): Signature | undefined {
  const first = lines[defLine - 1];
  const match = first === undefined ? null : /\bdef\s+[\p{L}_][\p{L}\p{N}_]*\s*\(/u.exec(first);
  if (!match) {
    return undefined;
  }
  const pieces: string[] = [];
  let current = '';
  let depth = 1;
  let quote = '';      // the open string's delimiter: ' " ''' """
  let row = defLine - 1;
  let col = match.index + match[0].length;
  scan:
  for (; row < lines.length && row < defLine + 60; row++, col = 0) {
    const text = lines[row];
    for (; col < text.length; col++) {
      const ch = text[col];
      if (quote) {
        if (ch === '\\') {
          col++;
        } else if (text.startsWith(quote, col)) {
          col += quote.length - 1;
          quote = '';
        }
        continue;
      }
      if (ch === '#') {
        break; // comment: rest of the line
      }
      if (ch === '"' || ch === "'") {
        quote = text.startsWith(ch.repeat(3), col) ? ch.repeat(3) : ch;
        col += quote.length - 1;
        current += 'S'; // placeholder: string contents don't matter
        continue;
      }
      if ('([{'.includes(ch)) {
        depth++;
      } else if (')]}'.includes(ch)) {
        depth--;
        if (depth === 0) {
          pieces.push(current);
          col++;
          break scan;
        }
      } else if (ch === ',' && depth === 1) {
        pieces.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    current += ' ';
  }
  if (depth !== 0) {
    return undefined; // unterminated signature
  }

  const params: Param[] = [];
  for (const piece of pieces) {
    const p = /^\s*(\*{0,2})\s*([\p{L}_][\p{L}\p{N}_]*)/u.exec(piece);
    if (p) { // skips '', '/' and bare '*'
      params.push({ name: p[2], kind: p[1] === '**' ? 'kwargs' : p[1] === '*' ? 'varargs' : 'normal' });
    }
  }

  // After ')': optional "-> T", then ':' and maybe a one-line body.
  const rest = (lines[row] ?? '').slice(col).replace(/#.*$/, '');
  const colon = rest.indexOf(':');
  if (colon >= 0 && rest.slice(colon + 1).trim()) {
    return { params, firstBodyLine: row + 1 };
  }
  let body = row + 1;
  while (body < lines.length && /^\s*(#.*)?$/.test(lines[body])) {
    body++;
  }
  return { params, firstBodyLine: body + 1 };
}

/** Shortens a debugpy value for the node: drops object addresses, collapses whitespace, caps length. */
export function shortenValue(value: string, max = MAX_VALUE): string {
  let short = value.replace(/\s+/g, ' ').trim()
    .replace(/ at 0x[0-9a-fA-F]+(?=>)/g, '')                       // <function f at 0x..> -> <function f>
    .replace(/<(?:[\p{L}\p{N}_]+\.)*([\p{L}\p{N}_]+) object>/gu, '<$1>'); // <__main__.Dog object> -> <Dog>
  if (short.length > max) {
    short = `${short.slice(0, max - 1)}…`;
  }
  return short;
}

function displayName(param: Param): string {
  return param.kind === 'kwargs' ? `**${param.name}` : param.kind === 'varargs' ? `*${param.name}` : param.name;
}

/**
 * Builds the node's args line and the tooltip's rows from a frame's Locals.
 * `self`/`cls` of a method is left off the node line (it's in the tooltip). A parameter missing
 * from Locals (e.g. `del`eted) is left off the line and shown as unavailable in the tooltip.
 */
export function formatCallValue(
  label: string,
  signature: Signature,
  locals: ReadonlyMap<string, string>,
  pausedLine: number,
  meta?: ReadonlyMap<string, VarMeta>, // expand complex variables feature
): CallValue {
  const args: CallArg[] = signature.params.map(param => {
    const value = locals.get(param.name);
    // The tooltip gets debugpy's value as is (addresses kept), only capped.
    const full = value !== undefined && value.length > MAX_FULL ? `${value.slice(0, MAX_FULL - 1)}…` : value;
    return {
      name: displayName(param),
      ...(full === undefined ? {} : { value: full }),
      ...(meta?.get(param.name) ?? {}), // expand complex variables feature: omitted when scalar
    };
  });
  const isMethod = label.includes('.');
  const parts = signature.params.flatMap((param, index) => {
    const value = locals.get(param.name);
    if (value === undefined || (index === 0 && isMethod && (param.name === 'self' || param.name === 'cls'))) {
      return [];
    }
    return [`${displayName(param)}=${shortenValue(value)}`];
  });
  // Just the parenthesised args: the node's name is already the line above.
  let line = `(${parts.join(', ')})`;
  if (line.length > MAX_LINE) {
    line = `${line.slice(0, MAX_LINE - 2)}…)`;
  }
  return { line, args, atEntry: pausedLine <= signature.firstBodyLine };
}

// --- local variables feature ---

/**
 * Rows debugpy adds to a frame's Locals that are not variables of the program.
 *
 * Verified against debugpy 1.8.20 (the build VS Code's Python extension ships) both in its source
 * and over DAP at a real pause:
 *  - The four DAPGrouper rows. "special"/"function"/"class" are grouped by default and so normally
 *    appear as these rows; set `variablePresentation` to "inline" in launch.json and their contents
 *    arrive as ordinary rows instead, which is why the dunder test below is still needed.
 *    "protected variables" is listed for completeness: it defaults to "inline", so a single-leading-
 *    underscore name like `_cache` arrives as a real row and IS a real local - never filter those.
 *  - "(return) f", added under `showReturnValue`. It is the value f returned, not a local of this
 *    frame, and DAP marks it only with a "readOnly" attribute that plain strings carry too, so the
 *    name prefix is the one reliable test.
 *  - "len()" and "Unable to handle:" are synthesised when expanding a container rather than for a
 *    frame, and `_pydev_stop_at_break` debugpy already strips itself; all three are cheap insurance.
 */
const PSEUDO_LOCALS = new Set([
  'special variables', 'protected variables', 'function variables', 'class variables',
  'len()', 'Unable to handle:', '_pydev_stop_at_break',
]);

export function isPseudoLocal(name: string): boolean {
  return PSEUDO_LOCALS.has(name) || name.startsWith('(return) ') || /^__.*__$/.test(name);
}

/**
 * A scalar as debugpy reprs it: None, a bool, a float special, a number, or a quoted string or
 * bytes. Everything else - a list, dict, set, tuple, or any object, function or class - reprs with
 * a leading `[ { ( <` or a constructor name, so what this really separates is "the value is right
 * here" from "you need to expand this to learn anything".
 */
function isScalarValue(value: string): boolean {
  const text = value.trimStart();
  return /^(?:None|True|False|inf|nan)$/.test(text.trimEnd())
    || /^[-+]?(?:\d|\.\d)/.test(text)             // 7, -3, 3.14, .5, 1e-5, 1_000, 2j
    || /^[rbufRBUF]{0,2}['"]/.test(text);         // 'text', b'bytes', f'...'
}

/**
 * The frame's locals that are NOT parameters: the complement of the signature within the Locals
 * scope that formatCallValue already reads, so no extra DAP traffic.
 *
 * Returns undefined - not an empty result - when the frame has none, which keeps a parameters-only
 * call's CallValue byte-for-byte what it was before this feature. That is the common case: at an
 * `atEntry` pause nothing in the body has been bound yet, so there are no locals to show.
 *
 * Order is debugpy's: alphabetical, with single-underscore names last. It is not binding order.
 * The tooltip keeps exactly that order; only the node's few rows are reordered, to put the values
 * you can actually read from a row ahead of the containers that would otherwise crowd them out.
 */
export function formatCallLocals(
  signature: Signature,
  locals: ReadonlyMap<string, string>,
  meta?: ReadonlyMap<string, VarMeta>, // expand complex variables feature
): Required<Pick<CallValue, 'localsRows' | 'locals' | 'localsCount'>> | undefined {
  const params = new Set(signature.params.map(param => param.name));
  const extras = [...locals].filter(([name]) => !params.has(name) && !isPseudoLocal(name));
  if (!extras.length) {
    return undefined;
  }
  // Scalars first. Array.sort is stable and `extras` arrives alphabetical, so each group keeps
  // that order; the tooltip below reads `extras`, not this, and so is left untouched.
  const ordered = [...extras].sort(
    ([, left], [, right]) => Number(isScalarValue(right)) - Number(isScalarValue(left)),
  );
  const localsRows = ordered.slice(0, MAX_LOCAL_ROWS).map(([name, value]) => {
    const row = `${name}=${shortenValue(value, MAX_LOCAL_VALUE)}`;
    return row.length > MAX_LOCAL_ROW ? `${row.slice(0, MAX_LOCAL_ROW - 1)}…` : row;
  });
  return {
    localsRows,
    // The tooltip gets debugpy's value as is, only capped - the same deal formatCallValue's args get.
    locals: extras.slice(0, MAX_LOCALS_LIST).map(([name, value]) => ({
      name,
      value: value.length > MAX_FULL ? `${value.slice(0, MAX_FULL - 1)}…` : value,
      ...(meta?.get(name) ?? {}), // expand complex variables feature
    })),
    localsCount: extras.length,
  };
}
// --- end local variables feature ---

// --- capture at each pause ---

export interface DapScope {
  name: string;
  variablesReference: number;
  presentationHint?: string;
}

export interface DapVariable {
  name: string;
  value: string;
  // --- expand complex variables feature --- the adapter always sends these; we used to drop them
  variablesReference?: number; // > 0 when the value has children
  type?: string;
  // --- end expand complex variables feature ---
}

/** One frame's Locals scope, as read at a pause. */
export interface FrameLocals {
  values: Map<string, string>;
  /** local variables feature: the scope was identified as Locals, not guessed by the fallback. */
  trusted: boolean;
  /** expand complex variables feature: ref/type per name, kept beside `values` so the formatters
   *  that only ever wanted the string stay exactly as they were. */
  meta: Map<string, VarMeta>;
}

// --- expand complex variables feature ---
/** What a variable carries beyond its printed value. */
export interface VarMeta {
  ref?: number;
  type?: string;
}

/** The ref/type of a DAP variable, with the zero reference normalised away (0 means "no children"). */
export function varMeta(variable: DapVariable): VarMeta {
  return {
    ...(variable.variablesReference && variable.variablesReference > 0 ? { ref: variable.variablesReference } : {}),
    ...(variable.type ? { type: variable.type } : {}),
  };
}
// --- end expand complex variables feature ---

export interface FrameLike {
  id?: number;
  line: number;
  source?: { path?: string };
}

export interface NodeLike {
  id: string;
  label: string;
  file: string;
  line: number;
}

export interface CallValuesDeps {
  /** session.customRequest */
  request(command: string, args: object): PromiseLike<unknown>;
  /** findNodeForFrame against the current graph */
  resolveNode(file: string, line: number): NodeLike | undefined;
  readLines(file: string): string[] | undefined;
  publish(values: CallValues): void;
  // --- per-step variable capture ---
  /**
   * The same values `publish` just got, for session history to snapshot onto the pause it has open.
   * Called from inside the generation guard below, so it inherits the debounce and can never fire
   * for a pause the program has already left, and it adds NO DAP traffic of its own.
   * Entries are in stack order, INNERMOST node first (see `capture`), which is the order the
   * snapshot's frame cap keeps.
   */
  onCapture?(values: CallValues): void;
  // --- end per-step variable capture ---
  debounceMs?: number;
}

// --- local variables feature ---
/**
 * A scope positively identified as the frame's locals, as opposed to pickLocalsScope's last-resort
 * guess. Looking three parameter names up in a guessed scope is harmless, but listing everything
 * *else* in it would spill whatever that scope really is, so only a trusted scope yields locals.
 */
export function isLocalsScope(scope: DapScope): boolean {
  return scope.presentationHint === 'locals' || /^locals$/i.test(scope.name);
}
// --- end local variables feature ---

/** debugpy names it "Locals"; other adapters hint it. Never "Globals". */
export function pickLocalsScope(scopes: DapScope[]): DapScope | undefined {
  return scopes.find(isLocalsScope)
    ?? scopes.find(scope => !/globals/i.test(scope.name) && scope.variablesReference > 0);
}

/**
 * One per debug session. The tracker calls paused/framesChanged/resumed/ended; this fetches the
 * values of the matched frames once the stack pages have arrived and publishes them, keyed by node
 * id. Each pause REPLACES the previous values (a function no longer on the stack loses its line).
 * Responses that arrive after the program resumed are dropped (their frame ids are invalid).
 */
export class CallValuesCapture {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private values: CallValues = {};
  private readonly localsByFrame = new Map<number, Promise<FrameLocals | undefined>>();
  private readonly linesByFile = new Map<string, string[] | undefined>();
  // --- expand complex variables feature ---
  // Its own cache, keyed by generation so it can never outlive the pause its refs belong to, and
  // separate from localsByFrame so on-demand expansion cannot disturb the debounced capture.
  private readonly childrenByRef = new Map<string, Promise<VariableChildren | undefined>>();
  // --- end expand complex variables feature ---

  constructor(private readonly deps: CallValuesDeps) {}

  /** A 'stopped' event: new frame ids are coming. */
  paused(): void {
    this.reset();
  }

  /** Resumed (a continue/step request or a 'continued' event): keep the values, marked stale. */
  resumed(): void {
    this.reset();
    if (Object.keys(this.values).length && !Object.values(this.values).every(value => value.stale)) {
      this.values = Object.fromEntries(Object.entries(this.values).map(([id, value]) => [id, { ...value, stale: true }]));
      this.deps.publish(this.values);
    }
  }

  /** The session ended: clear the values. */
  ended(): void {
    this.reset();
    if (Object.keys(this.values).length) {
      this.values = {};
      this.deps.publish(this.values);
    }
  }

  /** The tracker's accumulated frames (top of stack first) changed. */
  framesChanged(frames: readonly FrameLike[]): void {
    clearTimeout(this.timer);
    const snapshot = [...frames];
    const generation = this.generation;
    this.timer = setTimeout(() => void this.capture(snapshot, generation), this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  private reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
    this.localsByFrame.clear();
    this.linesByFile.clear();
    // --- expand complex variables feature --- every variablesReference just died with the pause
    this.childrenByRef.clear();
    // --- end expand complex variables feature ---
  }

  // --- expand complex variables feature ---
  /**
   * One page of an expandable variable's children, at the pause its `ref` came from.
   *
   * `stale` means the program paused again or resumed while this was in flight, so the reference no
   * longer refers to anything and the caller must show nothing rather than a wrong value. The same
   * (ref, page) is fetched once per pause; collapsing and re-expanding costs nothing.
   */
  async expand(ref: number, start = 0, count = MAX_CHILDREN): Promise<VariableChildren> {
    const page = Math.max(1, Math.min(count, MAX_CHILDREN));
    const from = Math.max(0, start);
    const generation = this.generation;
    if (!Number.isSafeInteger(ref) || ref <= 0) {
      return { ref, children: [], stale: true };
    }
    const key = `${generation}:${ref}:${from}:${page}`;
    let pending = this.childrenByRef.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          // One more than the page, so "are there further children" needs no second request.
          const { variables } = await this.deps.request('variables', {
            variablesReference: ref, start: from, count: page + 1,
          }) as { variables: DapVariable[] };
          const all = (variables ?? []).filter(variable => !isPseudoLocal(variable.name));
          const children = all.slice(0, page).map(variable => ({
            name: variable.name,
            value: variable.value.length > MAX_FULL ? `${variable.value.slice(0, MAX_FULL - 1)}…` : variable.value,
            ...varMeta(variable),
          }));
          // debugpy ignores start/count and caps large lists at 100 rows, so for a container its
          // "len()" row is the real size. Objects have none, and fall back to the rows that came.
          const total = Number((variables ?? []).find(variable => variable.name === 'len()')?.value);
          const more = Number.isInteger(total) ? total - children.length : all.length - page;
          return { ref, children, ...(more > 0 ? { more } : {}) };
        } catch {
          return undefined; // the frame is gone, or the adapter refused the reference
        }
      })();
      this.childrenByRef.set(key, pending);
    }
    const result = await pending;
    // Checked after the await as well: the program may have moved on while this was in flight.
    if (!result || generation !== this.generation) {
      return { ref, children: [], stale: true };
    }
    return result;
  }
  // --- end expand complex variables feature ---

  private async capture(frames: FrameLike[], generation: number): Promise<void> {
    // Innermost frame of each node wins; deeper recursive frames are only counted.
    const byNode = new Map<string, { frame: FrameLike & { id: number }; node: NodeLike; more: number }>();
    for (const frame of frames) {
      const node = frame.source?.path && frame.id !== undefined
        ? this.deps.resolveNode(frame.source.path, frame.line)
        : undefined;
      if (!node) {
        continue;
      }
      const seen = byNode.get(node.id);
      if (seen) {
        seen.more++;
      } else if (byNode.size < MAX_NODES) {
        byNode.set(node.id, { frame: frame as FrameLike & { id: number }, node, more: 0 });
      }
    }

    const entries = await Promise.all([...byNode.values()].map(async ({ frame, node, more }) => {
      const signature = parseSignature(this.lines(node.file) ?? [], node.line);
      if (!signature) {
        return undefined;
      }
      const scope = await this.locals(frame.id);
      if (!scope) {
        return undefined;
      }
      const value = formatCallValue(node.label, signature, scope.values, frame.line, scope.meta);
      // Recursion: "(n=1) +3" = three more fact frames further out on the stack.
      const withMore = more ? { ...value, line: `${value.line} +${more}`, more } : value;
      // --- local variables feature --- undefined unless the frame has non-parameter locals, so a
      // parameters-only call is published exactly as it was before this feature.
      const extras = scope.trusted ? formatCallLocals(signature, scope.values, scope.meta) : undefined;
      // --- end local variables feature ---
      return [node.id, extras ? { ...withMore, ...extras } : withMore] as const;
    }));
    if (generation !== this.generation) {
      return; // resumed (or paused again) meanwhile
    }
    // `entries` follows `byNode`, which followed `frames`: innermost node first. Object keys are
    // node ids (never integer-like), so Object.entries below preserves exactly that order.
    this.values = Object.fromEntries(entries.filter(entry => entry !== undefined));
    this.deps.publish(this.values);
    this.deps.onCapture?.(this.values); // per-step variable capture: same data, no second round-trip
  }

  private lines(file: string): string[] | undefined {
    if (!this.linesByFile.has(file)) {
      this.linesByFile.set(file, this.deps.readLines(file));
    }
    return this.linesByFile.get(file);
  }

  private locals(frameId: number): Promise<FrameLocals | undefined> {
    let pending = this.localsByFrame.get(frameId);
    if (!pending) {
      pending = (async () => {
        try {
          const { scopes } = await this.deps.request('scopes', { frameId }) as { scopes: DapScope[] };
          const scope = pickLocalsScope(scopes ?? []);
          if (!scope) {
            return undefined;
          }
          const { variables } = await this.deps.request('variables', { variablesReference: scope.variablesReference }) as { variables: DapVariable[] };
          const values = new Map<string, string>();
          const meta = new Map<string, VarMeta>(); // expand complex variables feature
          for (const variable of variables ?? []) {
            if (!values.has(variable.name)) {
              values.set(variable.name, variable.value);
              meta.set(variable.name, varMeta(variable));
            }
          }
          return { values, trusted: isLocalsScope(scope), meta }; // trusted: local variables feature
        } catch {
          return undefined; // e.g. the program resumed and the frame id is gone
        }
      })();
      this.localsByFrame.set(frameId, pending);
    }
    return pending;
  }
}
// --- end capture at each pause ---
