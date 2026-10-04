// End-to-end debugger cases: build the PathFind graph, set a breakpoint in the target, run the fixture's own
// "Debug main" launch configuration, and check the call path the debug tracker resolves at every stop.
// Ids are relative to the fixture folder, outermost caller first. Run with `npm run test:debug`.

export interface DebugCase {
  name: string;
  target: { file: string; lineContains: string; symbol: string }; // where PathFind is run
  breakpoint: { file: string; lineContains: string };              // a line inside the target's body
  stops: string[][];                                               // expected paths, one per breakpoint hit
}

// main -> function2 -> function1 -> sum, then main -> function2 -> sum (main only calls function2).
const readmeStops = (ext: string, outer: string[] = []) => [
  [...outer, `main.${ext}::main`, `function2.${ext}::function2`, `function1.${ext}::function1`, `sum.${ext}::sum`],
  [...outer, `main.${ext}::main`, `function2.${ext}::function2`, `sum.${ext}::sum`],
];

// countdown(3), is_even(4) and step_a(2) each recurse down to leaf.
const recursionStops = (rec: string, main: string, outer: string[] = []) => [
  [...outer, `${main}::main`, ...Array(4).fill(`${rec}::countdown`), `${rec}::leaf`],
  [...outer, `${main}::main`, `${rec}::is_even`, `${rec}::is_odd`, `${rec}::is_even`, `${rec}::is_odd`, `${rec}::is_even`, `${rec}::leaf`],
  [...outer, `${main}::main`, ...Array(3).fill([`${rec}::step_a`, `${rec}::step_b`, `${rec}::step_c`]).flat(), `${rec}::leaf`],
];

export const DEBUG_CASES: Record<string, DebugCase[]> = {
  test1: [{
    name: 'python (debugpy): both calls to sum',
    target: { file: 'sum.py', lineContains: 'def sum', symbol: 'sum' },
    breakpoint: { file: 'sum.py', lineContains: 'return a + b' },
    stops: readmeStops('py', ['main.py::<module>']),
  }],
  test2: [{
    name: 'C (gdb): both calls to sum',
    target: { file: 'sum.c', lineContains: 'int sum', symbol: 'sum' },
    breakpoint: { file: 'sum.c', lineContains: 'return a + b' },
    stops: readmeStops('c'),
  }],
  test3: [{
    name: 'C++ (gdb): both calls to sum',
    target: { file: 'sum.cpp', lineContains: 'int sum', symbol: 'sum' },
    breakpoint: { file: 'sum.cpp', lineContains: 'return a + b' },
    stops: readmeStops('cpp'),
  }],
  'test5/c': [{
    name: 'C (gdb): recursive stacks repeat nodes',
    target: { file: 'recursion.c', lineContains: 'int leaf', symbol: 'leaf' },
    breakpoint: { file: 'recursion.c', lineContains: 'return value' },
    stops: recursionStops('recursion.c', 'main.c'),
  }],
  'test5/python': [{
    name: 'python (debugpy): recursive stacks repeat nodes',
    target: { file: 'recursion.py', lineContains: 'def leaf', symbol: 'leaf' },
    breakpoint: { file: 'recursion.py', lineContains: 'return value' },
    stops: recursionStops('recursion.py', 'main.py', ['main.py::<module>']),
  }],
};
