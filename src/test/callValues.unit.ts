// Unit tests for the call values feature (src/callValues.ts). Plain Node, no VS Code: part of `npm run test:unit`.
import * as assert from 'assert';
import { CallValuesCapture, formatCallLocals, formatCallValue, isLocalsScope, isPseudoLocal, parseSignature, pickLocalsScope, shortenValue, varMeta, type CallValuesDeps } from '../callValues';
import type { CallValues } from '../types';

const names = (source: string, line = 1) => parseSignature(source.split('\n'), line)?.params.map(p => p.name);
const locals = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** A capture over a fake debug adapter: frame id -> Locals. */
function fakeCapture(source: Record<string, string>, frameLocals: Record<number, Record<string, string>>) {
  const published: CallValues[] = [];
  const nodes = [
    { id: 'main', label: 'main', file: 'main.py', line: 1, endLine: 3 },
    { id: 'fact', label: 'fact', file: 'main.py', line: 5, endLine: 8 },
    { id: 'speak', label: 'Dog.speak', file: 'main.py', line: 11, endLine: 12 },
  ];
  let requests = 0;
  const deps: CallValuesDeps = {
    debounceMs: 0,
    request: async (command, args: any) => {
      requests++;
      if (command === 'scopes') {
        return { scopes: [{ name: 'Globals', variablesReference: 1 }, { name: 'Locals', variablesReference: 100 + args.frameId }] };
      }
      const values = frameLocals[args.variablesReference - 100];
      if (!values) {
        throw new Error('invalid reference');
      }
      return { variables: Object.entries(values).map(([name, value]) => ({ name, value })) };
    },
    resolveNode: (file, line) => nodes.find(n => n.file === file && n.line <= line && line <= n.endLine),
    readLines: file => source[file]?.split('\n'),
    publish: values => published.push(values),
  };
  return { capture: new CallValuesCapture(deps), published, requests: () => requests };
}
const MAIN = [
  'def main():',          // 1
  '    fact(3)',          // 2
  '',                     // 3
  '',                     // 4
  'def fact(n):',         // 5
  '    if n <= 1:',       // 6
  '        return 1',     // 7
  '    return n * fact(n - 1)', // 8
  '',                     // 9
  'class Dog:',           // 10
  '    def speak(self, *words, loud=False, **opts):', // 11
  '        return words', // 12
].join('\n');
const frame = (id: number, line: number) => ({ id, line, source: { path: 'main.py' } });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

const cases: [string, () => void | Promise<void>][] = [
  ['simple signature', () => {
    assert.deepStrictEqual(names('def sum(a, b):\n    return a + b'), ['a', 'b']);
  }],
  ['self, *args, **kwargs, annotations, defaults with commas/brackets/strings, / and bare *', () => {
    const src = 'async def f(self, a: dict[str, int] = {"x,": (1, 2)}, /, b=\'),\', *args, c, d: "T" = 0, **kw) -> int:';
    assert.deepStrictEqual(names(src), ['self', 'a', 'b', 'args', 'c', 'd', 'kw']);
    assert.deepStrictEqual(parseSignature([src], 1)!.params.map(p => p.kind),
      ['normal', 'normal', 'normal', 'varargs', 'normal', 'normal', 'kwargs']);
    assert.deepStrictEqual(names('def g(a, *, b):'), ['a', 'b']);
  }],
  ['multi-line signature with comments, trailing comma and docstring; first body line', () => {
    const src = '@decorator\ndef f(\n    a,  # first (\n    b=[1,\n       2],\n):\n    """doc"""\n    return a';
    const sig = parseSignature(src.split('\n'), 2)!;
    assert.deepStrictEqual(sig.params.map(p => p.name), ['a', 'b']);
    assert.strictEqual(sig.firstBodyLine, 7);
  }],
  ['one-line body, no params, and non-def lines', () => {
    assert.deepStrictEqual(parseSignature(['def f(): return 1'], 1), { params: [], firstBodyLine: 1 });
    assert.strictEqual(parseSignature(['x = 1'], 1), undefined);
    assert.strictEqual(parseSignature(['def f(a,'], 1), undefined); // unterminated
  }],
  ['shortens values: object addresses, whitespace, long values', () => {
    assert.strictEqual(shortenValue('<__main__.Dog object at 0x000001F2A3B4C5D0>'), '<Dog>');
    assert.strictEqual(shortenValue('<function helper at 0x7f00>'), '<function helper>');
    assert.strictEqual(shortenValue("'a\n   b'"), "'a b'");
    const long = shortenValue(`[${Array.from({ length: 50 }, (_, i) => i).join(', ')}]`);
    assert.strictEqual(long.length, 24);
    assert.ok(long.endsWith('…'));
  }],
  ['node line: name=value, self hidden for methods, *args/**kwargs prefixed; tooltip keeps everything', () => {
    const sig = parseSignature(MAIN.split('\n'), 11)!;
    const value = formatCallValue('Dog.speak', sig, locals({
      self: '<__main__.Dog object at 0x1>', words: "('hi',)", loud: 'True', opts: '{}',
    }), 12);
    assert.strictEqual(value.line, "(*words=('hi',), loud=True, **opts={})");
    assert.deepStrictEqual(value.args.map(a => `${a.name} = ${a.value}`),
      ['self = <__main__.Dog object at 0x1>', "*words = ('hi',)", 'loud = True', '**opts = {}']);
    assert.strictEqual(value.atEntry, true);
  }],
  ['long args line is capped; missing params skipped on the node and marked in the tooltip', () => {
    const sig = parseSignature(['def f(a, b, c, d):', '    pass'], 1)!;
    const value = formatCallValue('f', sig, locals({ a: `'${'x'.repeat(40)}'`, b: '[1, 2, 3, 4, 5, 6]', c: '3' }), 5);
    assert.ok(value.line.length <= 44 && value.line.endsWith('…)'), value.line);
    assert.deepStrictEqual(value.args[3], { name: 'd' });
    assert.strictEqual(value.atEntry, false); // paused past the first body line: "value at pause"
  }],
  ['picks Locals, never Globals', () => {
    assert.strictEqual(pickLocalsScope([{ name: 'Globals', variablesReference: 1 }, { name: 'Locals', variablesReference: 2 }])?.variablesReference, 2);
    assert.strictEqual(pickLocalsScope([{ name: 'Globals', variablesReference: 1 }]), undefined);
  }],
  ['capture: recursion shows the innermost call with +N; each frame fetched once per pause', async () => {
    const { capture, published, requests } = fakeCapture({ 'main.py': MAIN }, {
      1: { n: '1' }, 2: { n: '2' }, 3: { n: '3' }, 4: {},
    });
    capture.paused();
    capture.framesChanged([frame(1, 7)]);                                     // first page: top frame
    capture.framesChanged([frame(1, 7), frame(2, 8), frame(3, 8), frame(4, 2)]); // rest of the stack
    await settle();
    assert.deepStrictEqual(published.at(-1), {
      fact: { line: '(n=1) +2', args: [{ name: 'n', value: '1' }], atEntry: false, more: 2 },
      main: { line: '()', args: [], atEntry: true }, // paused at a call on main's first line
    });
    assert.strictEqual(requests(), 4); // scopes + variables for frames 1 and 4 only
  }],
  ['capture: resume marks values stale; late responses dropped; session end clears', async () => {
    const { capture, published } = fakeCapture({ 'main.py': MAIN }, { 1: { n: '3' } });
    capture.paused();
    capture.framesChanged([frame(1, 6)]);
    await settle();
    assert.strictEqual(published.at(-1)!.fact.atEntry, true);
    capture.resumed();
    assert.strictEqual(published.at(-1)!.fact.stale, true);
    const count = published.length;
    capture.paused();
    capture.framesChanged([frame(1, 6)]);
    capture.resumed(); // resumed before the debounce fired: nothing new published
    await settle();
    assert.strictEqual(published.length, count);
    capture.ended();
    assert.deepStrictEqual(published.at(-1), {});
  }],
  ['capture: frames outside the graph or without a def are skipped; adapter errors are ignored', async () => {
    const { capture, published } = fakeCapture({ 'main.py': MAIN }, {});
    capture.paused();
    capture.framesChanged([frame(9, 6), { id: 10, line: 1, source: { path: 'other.py' } }]);
    await settle();
    assert.deepStrictEqual(published.at(-1), {});
  }],
  // --- local variables feature ---
  ['the rows debugpy adds to Locals are not locals, but a single-underscore name is', () => {
    // Every name here was observed over DAP against debugpy 1.8.20, or comes from its source.
    for (const name of ['special variables', 'protected variables', 'function variables',
      'class variables', '(return) add', 'len()', 'Unable to handle:', '_pydev_stop_at_break',
      '__name__', '__dunderish__']) {
      assert.strictEqual(isPseudoLocal(name), true, name);
    }
    // `protected` presents inline by default, so these arrive as ordinary rows and ARE real locals.
    for (const name of ['_private', '_', 'total', 'items', 'x__', 'special']) {
      assert.strictEqual(isPseudoLocal(name), false, name);
    }
  }],
  ['locals are the complement of the signature: pseudo rows dropped, rows and list capped', () => {
    const sig = parseSignature(['def f(a, b):', '    pass'], 1)!;
    const extras = formatCallLocals(sig, locals({
      a: '1', b: '2',                                                    // parameters are not locals
      'special variables': '', '(return) f': '7', __name__: "'__main__'", // nor are these
      total: '3', items: '[1, 2, 3]', text: `'${'x'.repeat(40)}'`, flag: 'True', _p: '0',
    }))!;
    // The node's rows lead with the scalars, alphabetical within each group; the list container
    // drops to the back so it cannot crowd a readable value out behind "+N more".
    assert.deepStrictEqual(extras.localsRows,
      ['total=3', "text='xxxxxxxxxxxxxx…", 'flag=True', '_p=0', 'items=[1, 2, 3]']);
    assert.strictEqual(extras.localsCount, 5); // total, items, text, flag, _p
    // The tooltip keeps debugpy's own order, untouched by the node's reordering.
    assert.deepStrictEqual(extras.locals.map(local => local.name), ['total', 'items', 'text', 'flag', '_p']);
    assert.strictEqual(extras.locals[2].value, `'${'x'.repeat(40)}'`); // the tooltip keeps the value
  }],
  ['a long row is capped, a long list is capped, and a parameters-only frame has no locals at all', () => {
    const sig = parseSignature(['def f(a):', '    pass'], 1)!;
    const long = formatCallLocals(sig, locals({ [`v${'e'.repeat(40)}`]: '[1, 2, 3, 4, 5, 6, 7, 8]' }))!;
    assert.ok(long.localsRows[0].length === 34 && long.localsRows[0].endsWith('…'), long.localsRows[0]);
    const many = formatCallLocals(sig, locals(Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`v${i}`, String(i)]))))!;
    assert.strictEqual(many.localsRows.length, 5);
    assert.strictEqual(many.locals.length, 20); // bounds the callValues message
    assert.strictEqual(many.localsCount, 25);
    // undefined, not an empty result: a parameters-only CallValue stays exactly what it always was.
    assert.strictEqual(formatCallLocals(sig, locals({ a: '1', 'special variables': '' })), undefined);
  }],
  ['node rows lead with scalars, containers and objects fall to the back', () => {
    const sig = parseSignature(['def f(a):', '    pass'], 1)!;
    const rows = (entries: Record<string, string>) =>
      formatCallLocals(sig, locals(entries))!.localsRows.map(row => row.split('=')[0]);
    // Alphabetical in; scalars come out first, each group still alphabetical among itself.
    assert.deepStrictEqual(rows({
      bag: '{1, 2}', count: '7', dog: '<__main__.Dog object at 0x1>', empty: 'None',
      items: '[1, 2, 3]', name: "'ada'", ok: 'True', pair: '(9,)', ratio: '3.14',
    }), ['count', 'empty', 'name', 'ok', 'ratio']);
    // Float specials, bytes and negatives are scalars; a function object is not.
    assert.deepStrictEqual(rows({
      a_fn: '<function helper at 0x1>', b_inf: 'inf', c_bytes: "b'hi'", d_neg: '-3', e_nan: 'nan',
    }), ['b_inf', 'c_bytes', 'd_neg', 'e_nan', 'a_fn']);
    // Containers still fill the rows that the scalars leave free.
    assert.deepStrictEqual(rows({ a_list: '[1]', b_num: '2', c_dict: '{}' }), ['b_num', 'a_list', 'c_dict']);
  }],
  ['scope trust: the hint or the exact name, never the fallback', () => {
    assert.strictEqual(isLocalsScope({ name: 'Locals', variablesReference: 2 }), true);
    assert.strictEqual(isLocalsScope({ name: 'locals', variablesReference: 2 }), true);
    assert.strictEqual(isLocalsScope({ name: 'Frame', variablesReference: 2, presentationHint: 'locals' }), true);
    assert.strictEqual(isLocalsScope({ name: 'Frame', variablesReference: 2 }), false);
    assert.strictEqual(isLocalsScope({ name: 'Local variables', variablesReference: 2 }), false);
    // The fallback still selects it, so arguments keep working on adapters that name it otherwise.
    assert.strictEqual(pickLocalsScope([{ name: 'Frame', variablesReference: 2 }])?.variablesReference, 2);
  }],
  ['capture: locals ride along with the arguments of the same pause', async () => {
    const { capture, published, requests } = fakeCapture({ 'main.py': MAIN },
      { 1: { n: '2', acc: '6', 'special variables': '' } });
    capture.paused();
    capture.framesChanged([frame(1, 8)]);
    await settle();
    const value = published.at(-1)!.fact;
    assert.strictEqual(value.line, '(n=2)'); // the arguments line is untouched by the locals
    assert.deepStrictEqual(value.args, [{ name: 'n', value: '2' }]);
    assert.deepStrictEqual(value.localsRows, ['acc=6']);
    assert.deepStrictEqual(value.locals, [{ name: 'acc', value: '6' }]);
    assert.strictEqual(value.localsCount, 1);
    assert.strictEqual(requests(), 2); // still one scopes + one variables: no extra DAP traffic
    capture.resumed();
    assert.strictEqual(published.at(-1)!.fact.stale, true);
    assert.deepStrictEqual(published.at(-1)!.fact.localsRows, ['acc=6']); // survive the stale marking
  }],
  ['capture: a guessed scope still yields arguments but never locals', async () => {
    const published: CallValues[] = [];
    const capture = new CallValuesCapture({
      debounceMs: 0,
      // No "Locals" name and no presentationHint: pickLocalsScope reaches its fallback.
      request: async (command: string) => command === 'scopes'
        ? { scopes: [{ name: 'Frame 0', variablesReference: 7 }] }
        : { variables: [{ name: 'n', value: '5' }, { name: 'acc', value: '9' }] },
      resolveNode: () => ({ id: 'fact', label: 'fact', file: 'main.py', line: 5 }),
      readLines: () => MAIN.split('\n'),
      publish: values => published.push(values),
    } as CallValuesDeps);
    capture.paused();
    capture.framesChanged([frame(1, 8)]);
    await settle();
    assert.deepStrictEqual(published.at(-1), {
      fact: { line: '(n=5)', args: [{ name: 'n', value: '5' }], atEntry: false },
    });
  }],
  // --- end local variables feature ---
  // --- expand complex variables feature ---
  ['refs and types ride along on args and locals, and scalars carry neither', () => {
    const sig = parseSignature(['def f(a, b):', '    pass'], 1)!;
    const meta = new Map([
      ['a', { ref: 11, type: 'list' }],
      ['b', { type: 'int' }],      // a scalar: debugpy sends variablesReference 0, so no ref
      ['items', { ref: 12, type: 'dict' }],
    ]);
    const value = formatCallValue('f', sig, locals({ a: '[1, 2]', b: '3' }), 2, meta);
    assert.deepStrictEqual(value.args, [
      { name: 'a', value: '[1, 2]', ref: 11, type: 'list' },
      { name: 'b', value: '3', type: 'int' },
    ]);
    const extras = formatCallLocals(sig, locals({ a: '[1, 2]', b: '3', items: '{}' }), meta)!;
    assert.deepStrictEqual(extras.locals, [{ name: 'items', value: '{}', ref: 12, type: 'dict' }]);
    // Without a meta map nothing is attached, so an older capture serialises exactly as before.
    assert.deepStrictEqual(formatCallValue('f', sig, locals({ a: '[1, 2]', b: '3' }), 2).args,
      [{ name: 'a', value: '[1, 2]' }, { name: 'b', value: '3' }]);
  }],
  ['varMeta drops the zero reference that means "no children"', () => {
    assert.deepStrictEqual(varMeta({ name: 'x', value: '1', variablesReference: 0, type: 'int' }), { type: 'int' });
    assert.deepStrictEqual(varMeta({ name: 'x', value: '[]', variablesReference: 7 }), { ref: 7 });
    assert.deepStrictEqual(varMeta({ name: 'x', value: '1' }), {});
  }],
  ['expand: children are fetched once per pause, paged, and pseudo rows dropped', async () => {
    let calls = 0;
    let lastArgs: Record<string, number> = {};
    const capture = new CallValuesCapture({
      debounceMs: 0,
      request: async (command: string, args: Record<string, number>) => {
        calls++;
        lastArgs = args;
        return { variables: [
          { name: 'special variables', value: '' },               // debugpy noise: never a child
          ...Array.from({ length: 8 }, (_, i) => ({
            name: String(i), value: `v${i}`, variablesReference: i === 0 ? 99 : 0, type: 'int',
          })),
        ] };
      },
      resolveNode: () => undefined,
      readLines: () => undefined,
      publish: () => undefined,
    } as unknown as CallValuesDeps);
    capture.paused();
    const page = await capture.expand(11, 0, 3);
    assert.strictEqual(page.ref, 11);
    assert.deepStrictEqual(page.children.map(c => c.name), ['0', '1', '2']);
    assert.deepStrictEqual(page.children[0], { name: '0', value: 'v0', ref: 99, type: 'int' });
    assert.strictEqual(page.more, 5); // 8 real children, 3 shown
    assert.strictEqual(page.stale, undefined);
    // One over the page is requested, so "is there more" needs no second round-trip.
    assert.deepStrictEqual(lastArgs, { variablesReference: 11, start: 0, count: 4 });
    await capture.expand(11, 0, 3);
    assert.strictEqual(calls, 1); // cached: re-expanding the same page is free
    await capture.expand(11, 3, 3);
    assert.strictEqual(calls, 2); // a different page is a different request
  }],
  ['expand: a dead reference, a resume, and a late answer all come back stale', async () => {
    let release: (value: unknown) => void = () => undefined;
    const capture = new CallValuesCapture({
      debounceMs: 0,
      request: () => new Promise(resolve => { release = resolve; }),
      resolveNode: () => undefined,
      readLines: () => undefined,
      publish: () => undefined,
    } as unknown as CallValuesDeps);
    capture.paused();
    // A reference that cannot exist is rejected without troubling the adapter.
    assert.deepStrictEqual(await capture.expand(0), { ref: 0, children: [], stale: true });
    assert.deepStrictEqual(await capture.expand(-1), { ref: -1, children: [], stale: true });
    // In flight when the program resumes: the reference is dead, so the answer must not be shown.
    const pending = capture.expand(11, 0, 3);
    capture.resumed();
    release({ variables: [{ name: '0', value: 'v0' }] });
    assert.deepStrictEqual(await pending, { ref: 11, children: [], stale: true });
    // The cache went with the generation, so the next pause refetches rather than reusing it.
    capture.paused();
    const next = capture.expand(11, 0, 3);
    release({ variables: [{ name: '0', value: 'fresh' }] });
    assert.deepStrictEqual((await next).children, [{ name: '0', value: 'fresh' }]);
  }],
  ['expand: an adapter error is stale, not a crash', async () => {
    const capture = new CallValuesCapture({
      debounceMs: 0,
      request: async () => { throw new Error('invalid reference'); },
      resolveNode: () => undefined,
      readLines: () => undefined,
      publish: () => undefined,
    } as unknown as CallValuesDeps);
    capture.paused();
    assert.deepStrictEqual(await capture.expand(11), { ref: 11, children: [], stale: true });
  }],
  // --- end expand complex variables feature ---
];

void (async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}\n${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} call values tests passed`);
  process.exit(failed ? 1 : 0);
})();
