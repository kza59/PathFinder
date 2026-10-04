// Unit tests for the call values feature (src/callValues.ts). Plain Node, no VS Code: part of `npm run test:unit`.
import * as assert from 'assert';
import { CallValuesCapture, formatCallValue, parseSignature, pickLocalsScope, shortenValue, type CallValuesDeps } from '../callValues';
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
