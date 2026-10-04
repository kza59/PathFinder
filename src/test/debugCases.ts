// End-to-end debugger cases: build the PathFind graph, set a breakpoint in the target, run the fixture's own
// "Debug main" launch configuration, and check the call path the debug tracker resolves at every stop.
// Ids are relative to the fixture folder, outermost caller first. Run with `npm run test:debug`.

export interface DebugCase {
  name: string;
  target: { file: string; lineContains: string; symbol: string }; // where PathFind is run
  breakpoint?: { file: string; lineContains: string };             // a line inside the target's body; none = run until it stops by itself
  stopReasons?: string[];                                          // why the debugger stopped each time (DAP 'stopped' reason), if checked
  autoOpen?: string;                                               // the crash must open the panel by itself, with this function as its target
  stops: string[][];                                               // expected paths, one per breakpoint hit
  hotCounts: Record<string, number>;                               // calls per function so far, at the last stop
  promptMentions: string[];                                        // text the AI explanation prompt must contain at stop 1
}

// sum(1, 2) is the first call to reach the breakpoint.
const readmePrompt = ['-> ', 'a (int) = 1', 'b (int) = 2'];
// countdown(3) recurses down to countdown(0), which calls leaf(0).
const recursionPrompt = ['-> ', 'value (int) = 0', 'n (int) = 3', 'n (int) = 0'];

// main -> function2 -> function1 -> sum, then main -> function2 -> sum (main only calls function2).
// At the second stop: main, function2 and function1 have run once, and sum twice.
const readmeCounts = (ext: string, outer: Record<string, number> = {}) => ({
  ...outer, [`main.${ext}::main`]: 1, [`function2.${ext}::function2`]: 1, [`function1.${ext}::function1`]: 1, [`sum.${ext}::sum`]: 2,
});

const readmeStops = (ext: string, outer: string[] = []) => [
  [...outer, `main.${ext}::main`, `function2.${ext}::function2`, `function1.${ext}::function1`, `sum.${ext}::sum`],
  [...outer, `main.${ext}::main`, `function2.${ext}::function2`, `sum.${ext}::sum`],
];

// countdown(3), is_even(4) and step_a(2) each recurse down to leaf.
// At the third stop every recursion has bottomed out once: countdown(3..0), is_even(4,2,0), is_odd(3,1), 3 laps of step_*.
const recursionCounts = (rec: string, main: string, outer: Record<string, number> = {}) => ({
  ...outer, [`${main}::main`]: 1, [`${rec}::countdown`]: 4, [`${rec}::is_even`]: 3, [`${rec}::is_odd`]: 2,
  [`${rec}::step_a`]: 3, [`${rec}::step_b`]: 3, [`${rec}::step_c`]: 3, [`${rec}::leaf`]: 3,
});

const recursionStops = (rec: string, main: string, outer: string[] = []) => [
  [...outer, `${main}::main`, ...Array(4).fill(`${rec}::countdown`), `${rec}::leaf`],
  [...outer, `${main}::main`, `${rec}::is_even`, `${rec}::is_odd`, `${rec}::is_even`, `${rec}::is_odd`, `${rec}::is_even`, `${rec}::leaf`],
  [...outer, `${main}::main`, ...Array(3).fill([`${rec}::step_a`, `${rec}::step_b`, `${rec}::step_c`]).flat(), `${rec}::leaf`],
];

// test9: main -> add_user -> load_record -> parse_age works; main -> import_all -> load_record -> parse_age crashes on
// the second imported row. No breakpoint: the debugger must stop by itself, because of the crash, on the import path.
const crashStops = (ext: string, outer: string[] = []) => [[
  ...outer, `main.${ext}::main`, `importer.${ext}::import_all`, `records.${ext}::load_record`, `validate.${ext}::parse_age`,
]];
// parse_age ran for "31", "42" and then the bad row.
const crashCounts = (ext: string, outer: Record<string, number> = {}) => ({
  ...outer, [`main.${ext}::main`]: 1, [`admin.${ext}::add_user`]: 1, [`importer.${ext}::import_all`]: 1,
  [`records.${ext}::load_record`]: 3, [`validate.${ext}::parse_age`]: 3,
});

export const DEBUG_CASES: Record<string, DebugCase[]> = {
  test1: [{
    name: 'python (debugpy): both calls to sum',
    target: { file: 'sum.py', lineContains: 'def sum', symbol: 'sum' },
    breakpoint: { file: 'sum.py', lineContains: 'return a + b' },
    stops: readmeStops('py', ['main.py::<module>']),
    promptMentions: readmePrompt,
    hotCounts: readmeCounts('py', { 'main.py::<module>': 1 }),
  }],
  test2: [{
    name: 'C (gdb): both calls to sum',
    target: { file: 'sum.c', lineContains: 'int sum', symbol: 'sum' },
    breakpoint: { file: 'sum.c', lineContains: 'return a + b' },
    stops: readmeStops('c'),
    promptMentions: readmePrompt,
    hotCounts: readmeCounts('c'),
  }],
  test3: [{
    name: 'C++ (gdb): both calls to sum',
    target: { file: 'sum.cpp', lineContains: 'int sum', symbol: 'sum' },
    breakpoint: { file: 'sum.cpp', lineContains: 'return a + b' },
    stops: readmeStops('cpp'),
    promptMentions: readmePrompt,
    hotCounts: readmeCounts('cpp'),
  }],
  'test5/c': [{
    name: 'C (gdb): recursive stacks repeat nodes',
    target: { file: 'recursion.c', lineContains: 'int leaf', symbol: 'leaf' },
    breakpoint: { file: 'recursion.c', lineContains: 'return value' },
    stops: recursionStops('recursion.c', 'main.c'),
    promptMentions: recursionPrompt,
    hotCounts: recursionCounts('recursion.c', 'main.c'),
  }],
  'test5/python': [{
    name: 'python (debugpy): recursive stacks repeat nodes',
    target: { file: 'recursion.py', lineContains: 'def leaf', symbol: 'leaf' },
    breakpoint: { file: 'recursion.py', lineContains: 'return value' },
    stops: recursionStops('recursion.py', 'main.py', ['main.py::<module>']),
    promptMentions: recursionPrompt,
    hotCounts: recursionCounts('recursion.py', 'main.py', { 'main.py::<module>': 1 }),
  }],
  'test9/python': [{
    name: 'python (debugpy): uncaught ValueError stops on the crashing path',
    target: { file: 'validate.py', lineContains: 'def parse_age', symbol: 'parse_age' },
    stopReasons: ['exception'],
    autoOpen: 'validate.py::parse_age',
    stops: crashStops('py', ['main.py::<module>']),
    promptMentions: ['-> ', 'ValueError: invalid literal', "text (str) = 'abc'"],
    hotCounts: crashCounts('py', { 'main.py::<module>': 1 }),
  }],
  'test9/c': [{
    name: 'C (gdb): segfault stops on the crashing path',
    target: { file: 'validate.c', lineContains: 'int parse_age', symbol: 'parse_age' },
    stopReasons: ['exception'],
    autoOpen: 'validate.c::parse_age',
    stops: crashStops('c'),
    promptMentions: ['-> ', 'Segmentation fault', 'age_text (const char *) = 0x0'],
    hotCounts: crashCounts('c'),
  }],
  'test9/cpp': [{
    name: 'C++ (gdb): uncaught std::invalid_argument stops on the crashing path',
    target: { file: 'validate.cpp', lineContains: 'int parse_age', symbol: 'parse_age' },
    stopReasons: ['exception'],
    autoOpen: 'validate.cpp::parse_age',
    stops: crashStops('cpp'),
    promptMentions: ['-> ', 'Aborted', 'std::__throw_invalid_argument', 'stoi'],
    hotCounts: crashCounts('cpp'),
  }],
};
