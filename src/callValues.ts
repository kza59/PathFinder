import type { CallArg, CallValue, CallValues } from './types';

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
): CallValue {
  const args: CallArg[] = signature.params.map(param => {
    const value = locals.get(param.name);
    // The tooltip gets debugpy's value as is (addresses kept), only capped.
    const full = value !== undefined && value.length > MAX_FULL ? `${value.slice(0, MAX_FULL - 1)}…` : value;
    return { name: displayName(param), ...(full === undefined ? {} : { value: full }) };
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

// --- capture at each pause ---

export interface DapScope {
  name: string;
  variablesReference: number;
  presentationHint?: string;
}

export interface DapVariable {
  name: string;
  value: string;
}

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
  debounceMs?: number;
}

/** debugpy names it "Locals"; other adapters hint it. Never "Globals". */
export function pickLocalsScope(scopes: DapScope[]): DapScope | undefined {
  return scopes.find(scope => scope.presentationHint === 'locals' || /^locals$/i.test(scope.name))
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
  private readonly localsByFrame = new Map<number, Promise<Map<string, string> | undefined>>();
  private readonly linesByFile = new Map<string, string[] | undefined>();

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
  }

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
      const locals = await this.locals(frame.id);
      if (!locals) {
        return undefined;
      }
      const value = formatCallValue(node.label, signature, locals, frame.line);
      // Recursion: "(n=1) +3" = three more fact frames further out on the stack.
      return [node.id, more ? { ...value, line: `${value.line} +${more}`, more } : value] as const;
    }));
    if (generation !== this.generation) {
      return; // resumed (or paused again) meanwhile
    }
    this.values = Object.fromEntries(entries.filter(entry => entry !== undefined));
    this.deps.publish(this.values);
  }

  private lines(file: string): string[] | undefined {
    if (!this.linesByFile.has(file)) {
      this.linesByFile.set(file, this.deps.readLines(file));
    }
    return this.linesByFile.get(file);
  }

  private locals(frameId: number): Promise<Map<string, string> | undefined> {
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
          const locals = new Map<string, string>();
          for (const variable of variables ?? []) {
            if (!locals.has(variable.name)) {
              locals.set(variable.name, variable.value);
            }
          }
          return locals;
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
