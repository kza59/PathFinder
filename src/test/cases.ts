// Expected call graphs for each fixture folder. Ids are written relative to the fixture folder for
// readability; suite.ts expands them to the real absolute-path ids before comparing.

import { DEFAULT_MAX_DEPTH } from '../limits';

/** [caller id, callee id, 1-based lines in the caller's file where the call happens] */
export type ExpectedEdge = [string, string, number[]];

export interface Case {
  name: string;
  file: string;        // file to "right-click" in
  lineContains: string; // first line containing this text...
  symbol: string;       // ...at the first occurrence of this name on it
  nodes: string[];
  edges: ExpectedEdge[];
  recursionGroups?: string[][]; // node ids that form each recursive structure; omitted = no recursion expected
  options?: { maxDepth?: number; maxNodes?: number }; // build limits, to exercise truncation
  hiddenCallers?: Record<string, number>; // node id -> callers left out; omitted = graph expected complete
  expand?: string[]; // node ids passed to expandCallers in order after building, before comparing
  noise?: string[]; // node ids expected to be tagged noise, besides <module> nodes (always noise); omitted = none
  chokepoints?: string[]; // node ids expected to be marked chokepoints; omitted = none
}

interface ReadmeLines {
  f1Sum: number; f2Sum: number; f3Sum: number;
  f2F1: number; f3F1: number[]; f3F2: number; mainF2: number;
}

const readmeGraph = (ext: string, l: ReadmeLines, extraNodes: string[] = [], extraEdges: ExpectedEdge[] = []) => ({
  nodes: [`sum.${ext}::sum`, `function1.${ext}::function1`, `function2.${ext}::function2`,
    `function3.${ext}::function3`, `main.${ext}::main`, ...extraNodes],
  edges: [
    [`function1.${ext}::function1`, `sum.${ext}::sum`, [l.f1Sum]],
    [`function2.${ext}::function2`, `sum.${ext}::sum`, [l.f2Sum]],
    [`function3.${ext}::function3`, `sum.${ext}::sum`, [l.f3Sum]],
    [`function2.${ext}::function2`, `function1.${ext}::function1`, [l.f2F1]],
    [`function3.${ext}::function3`, `function1.${ext}::function1`, l.f3F1], // called twice
    [`function3.${ext}::function3`, `function2.${ext}::function2`, [l.f3F2]],
    [`main.${ext}::main`, `function2.${ext}::function2`, [l.mainF2]],
    ...extraEdges,
  ] as ExpectedEdge[],
});

const pyGraph = readmeGraph('py',
  { f1Sum: 5, f2Sum: 7, f3Sum: 9, f2F1: 6, f3F1: [8, 10], f3F2: 7, mainF2: 5 },
  ['main.py::<module>'], [['main.py::<module>', 'main.py::main', [9]]]);
// The C and C++ fixtures are laid out line-for-line the same.
const cLines: ReadmeLines = { f1Sum: 6, f2Sum: 8, f3Sum: 12, f2F1: 7, f3F1: [11, 13], f3F2: 10, mainF2: 5 };
const cGraph = readmeGraph('c', cLines);
const cppGraph = readmeGraph('cpp', cLines);

// All 15 functions reach sum; the longest function path spans six levels.
const searchGraph = {
  nodes: ['sum.py::sum', 'calculations.py::calculateTotal', 'calculations.py::validateTotal', 'helpers.py::_helper',
    'user.py::save', 'order.py::save', 'storage.py::saveCache', 'storage.py::saveSnapshot',
    'workflow.py::runWorkflow', 'workflow.py::runReports', 'processing.py::processBatch', 'processing.py::buildReport',
    'records.py::processRecord', 'records.py::summarizeRecords',
    'main.py::main', 'main.py::<module>'],
  edges: [
    ['calculations.py::calculateTotal', 'sum.py::sum', [8]],
    ['calculations.py::validateTotal', 'sum.py::sum', [13]],
    ['helpers.py::_helper', 'sum.py::sum', [7]],
    ['user.py::save', 'sum.py::sum', [7]],
    ['order.py::save', 'sum.py::sum', [7]],
    ['storage.py::saveCache', 'sum.py::sum', [7]],
    ['storage.py::saveSnapshot', 'sum.py::sum', [11]],
    ['main.py::main', 'sum.py::sum', [14]],
    ['main.py::main', 'calculations.py::calculateTotal', [15]],
    ['main.py::main', 'helpers.py::_helper', [16]],
    ['main.py::main', 'user.py::save', [17]],
    ['main.py::main', 'order.py::save', [18]],
    ['main.py::main', 'storage.py::saveCache', [19]],
    ['main.py::main', 'storage.py::saveSnapshot', [20]],
    ['main.py::main', 'workflow.py::runWorkflow', [21]],
    ['main.py::main', 'workflow.py::runReports', [22]],
    ['main.py::<module>', 'main.py::main', [29]],
    ['workflow.py::runWorkflow', 'processing.py::processBatch', [7]],
    ['workflow.py::runWorkflow', 'processing.py::buildReport', [8]],
    ['workflow.py::runReports', 'processing.py::buildReport', [13]],
    ['workflow.py::runReports', 'processing.py::processBatch', [14]],
    ['processing.py::processBatch', 'records.py::processRecord', [7, 8]],
    ['processing.py::buildReport', 'records.py::summarizeRecords', [13]],
    ['processing.py::buildReport', 'records.py::processRecord', [14]],
    ['records.py::processRecord', 'calculations.py::calculateTotal', [11]],
    ['records.py::processRecord', 'calculations.py::validateTotal', [12]],
    ['records.py::processRecord', 'helpers.py::_helper', [14]],
    ['records.py::processRecord', 'user.py::save', [15]],
    ['records.py::processRecord', 'order.py::save', [16]],
    ['records.py::summarizeRecords', 'calculations.py::calculateTotal', [21]],
    ['records.py::summarizeRecords', 'calculations.py::validateTotal', [22]],
    ['records.py::summarizeRecords', 'storage.py::saveCache', [24]],
    ['records.py::summarizeRecords', 'storage.py::saveSnapshot', [25]],
  ] as ExpectedEdge[],
};

/**
 * The README graph cut off one level above the target (maxDepth 1, or a node limit that fits exactly those nodes):
 * sum and its three direct callers, with the edges between them, and only function2 marked, since its caller
 * main was left out. function1's callers (function2, function3) are all in the graph, so it is not marked.
 */
const oneLevel = (g: ReturnType<typeof readmeGraph>, ext: string) => ({
  nodes: g.nodes.slice(0, 4),
  edges: g.edges.slice(0, 6),
  hiddenCallers: { [`function2.${ext}::function2`]: 1 },
});

// Same three recursive shapes in both languages: a function calling itself (countdown), two calling each
// other (is_even <-> is_odd), and a three-function loop (step_a -> step_b -> step_c -> step_a).
const recursionGraph = (rec: string, main: string, l: Record<string, number>, extraNodes: string[] = [], extraEdges: ExpectedEdge[] = []) => ({
  nodes: [`${rec}::leaf`, `${rec}::countdown`, `${rec}::is_even`, `${rec}::is_odd`,
    `${rec}::step_a`, `${rec}::step_b`, `${rec}::step_c`, `${main}::main`, ...extraNodes],
  edges: [
    [`${rec}::countdown`, `${rec}::leaf`, [l.countdownLeaf]],
    [`${rec}::countdown`, `${rec}::countdown`, [l.countdownSelf]],
    [`${rec}::is_even`, `${rec}::leaf`, [l.evenLeaf]],
    [`${rec}::is_odd`, `${rec}::leaf`, [l.oddLeaf]],
    [`${rec}::is_even`, `${rec}::is_odd`, [l.evenOdd]],
    [`${rec}::is_odd`, `${rec}::is_even`, [l.oddEven]],
    [`${rec}::step_c`, `${rec}::leaf`, [l.cLeaf]],
    [`${rec}::step_a`, `${rec}::step_b`, [l.ab]],
    [`${rec}::step_b`, `${rec}::step_c`, [l.bc]],
    [`${rec}::step_c`, `${rec}::step_a`, [l.ca]],
    [`${main}::main`, `${rec}::countdown`, [5]],
    [`${main}::main`, `${rec}::is_even`, [6]],
    [`${main}::main`, `${rec}::step_a`, [7]],
    ...extraEdges,
  ] as ExpectedEdge[],
  recursionGroups: [
    [`${rec}::countdown`],
    [`${rec}::is_even`, `${rec}::is_odd`],
    [`${rec}::step_a`, `${rec}::step_b`, `${rec}::step_c`],
  ],
});

const pyRecursion = recursionGraph('recursion.py', 'main.py',
  { countdownLeaf: 7, countdownSelf: 8, evenLeaf: 13, oddLeaf: 19, evenOdd: 14, oddEven: 20, cLeaf: 33, ab: 24, bc: 28, ca: 34 },
  ['main.py::<module>'], [['main.py::<module>', 'main.py::main', [11]]]);
const cRecursion = recursionGraph('recursion.c', 'main.c',
  { countdownLeaf: 11, countdownSelf: 12, evenLeaf: 18, oddLeaf: 25, evenOdd: 19, oddEven: 26, cLeaf: 42, ab: 31, bc: 36, ca: 43 });

// test8: level20 -> level19 -> ... -> level1 -> target, deeper than the default depth limit. levelK is defined on
// line 4K+1 and makes its call on line 4K+2. With default settings the graph stops DEFAULT_MAX_DEPTH levels up,
// and that last level is marked +1 for the caller just beyond it.
const chainId = (k: number) => k === 0 ? 'chain.py::target' : `chain.py::level${k}`;
const chain = (levels: number) => ({
  nodes: Array.from({ length: levels + 1 }, (_, k) => chainId(k)),
  edges: Array.from({ length: levels }, (_, i) => [chainId(i + 1), chainId(i), [4 * (i + 1) + 2]]) as ExpectedEdge[],
});
const defaultDepthCutoff = {
  nodes: Array.from({ length: DEFAULT_MAX_DEPTH + 1 }, (_, k) => chainId(k)),
  edges: Array.from({ length: DEFAULT_MAX_DEPTH }, (_, i) => [chainId(i + 1), chainId(i), [4 * (i + 1) + 2]]) as ExpectedEdge[],
  hiddenCallers: { [chainId(DEFAULT_MAX_DEPTH)]: 1 },
  // Every level below the cut-off is certain: the hidden callers attach above them.
  chokepoints: Array.from({ length: DEFAULT_MAX_DEPTH - 1 }, (_, i) => chainId(i + 1)),
};

// test9: parse_age is reached through add_user (works) and import_all (crashes); every path goes through load_record.
// Same line layout in C and C++, except C++'s main calls import_all on line 7 (C: 8).
const crashGraph = (ext: string, mainImportLine: number, importerLine: number, extra: { nodes?: string[]; edges?: ExpectedEdge[] } = {}) => ({
  nodes: [`validate.${ext}::parse_age`, `records.${ext}::load_record`, `admin.${ext}::add_user`,
    `importer.${ext}::import_all`, `main.${ext}::main`, ...(extra.nodes ?? [])],
  edges: [
    [`records.${ext}::load_record`, `validate.${ext}::parse_age`, [6]],
    [`admin.${ext}::add_user`, `records.${ext}::load_record`, [ext === 'py' ? 5 : 6]],
    [`importer.${ext}::import_all`, `records.${ext}::load_record`, [importerLine]],
    [`main.${ext}::main`, `admin.${ext}::add_user`, [6]],
    [`main.${ext}::main`, `importer.${ext}::import_all`, [mainImportLine]],
    ...(extra.edges ?? []),
  ] as ExpectedEdge[],
  chokepoints: [`records.${ext}::load_record`],
});

export const CASES: Record<string, Case[]> = {
  test1: [
    { name: 'python: definition', file: 'sum.py', lineContains: 'def sum', symbol: 'sum', ...pyGraph },
    { name: 'python: call site', file: 'function1.py', lineContains: 'sum(1, 2)', symbol: 'sum', ...pyGraph },
    {
      name: 'python truncation: depth limit 1 marks only function2', file: 'sum.py', lineContains: 'def sum', symbol: 'sum',
      options: { maxDepth: 1 }, ...oneLevel(pyGraph, 'py'),
    },
    {
      name: 'python truncation: node limit 4 marks only function2', file: 'sum.py', lineContains: 'def sum', symbol: 'sum',
      options: { maxNodes: 4 }, ...oneLevel(pyGraph, 'py'),
    },
    {
      name: 'python truncation: node limit 1 keeps the target with 3 hidden callers', file: 'sum.py', lineContains: 'def sum', symbol: 'sum',
      options: { maxNodes: 1 }, nodes: ['sum.py::sum'], edges: [], hiddenCallers: { 'sum.py::sum': 3 },
    },
    {
      name: 'python expand: function2 gains main, and main is marked for <module>', file: 'sum.py', lineContains: 'def sum', symbol: 'sum',
      options: { maxDepth: 1 }, expand: ['function2.py::function2'],
      nodes: [...pyGraph.nodes.slice(0, 5)],
      edges: [...pyGraph.edges.slice(0, 7)],
      hiddenCallers: { 'main.py::main': 1 },
    },
  ],
  test2: [
    { name: 'C: definition', file: 'sum.c', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: prototype in header', file: 'sum.h', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: forward declaration', file: 'function3.c', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: call site', file: 'function1.c', lineContains: 'sum(1, 2)', symbol: 'sum', ...cGraph },
    {
      name: 'C truncation: depth limit 1 marks only function2', file: 'sum.c', lineContains: 'int sum', symbol: 'sum',
      options: { maxDepth: 1 }, ...oneLevel(cGraph, 'c'),
    },
    {
      // function3 calls function1 twice; each call site is reported separately, but it is one hidden caller.
      name: 'C truncation: node limit 1 counts each hidden caller once', file: 'sum.c', lineContains: 'int sum', symbol: 'sum',
      options: { maxNodes: 1 }, nodes: ['sum.c::sum'], edges: [], hiddenCallers: { 'sum.c::sum': 3 },
    },
    {
      // Unlike Python there is no <module> caller above main, so the expanded graph is complete.
      name: 'C expand: function2 gains main and the graph is complete', file: 'sum.c', lineContains: 'int sum', symbol: 'sum',
      options: { maxDepth: 1 }, expand: ['function2.c::function2'], ...cGraph,
    },
  ],
  test3: [
    { name: 'C++: definition', file: 'sum.cpp', lineContains: 'int sum', symbol: 'sum', ...cppGraph },
    { name: 'C++: prototype in header', file: 'sum.hpp', lineContains: 'int sum', symbol: 'sum', ...cppGraph },
    { name: 'C++: forward declaration', file: 'function3.cpp', lineContains: 'int sum', symbol: 'sum', ...cppGraph },
    { name: 'C++: call site', file: 'function1.cpp', lineContains: 'sum(1, 2)', symbol: 'sum', ...cppGraph },
  ],
  'test4/python': [
    {
      name: 'python classes: shared callee', file: 'animals.py', lineContains: 'def make_sound', symbol: 'make_sound',
      nodes: ['animals.py::make_sound', 'animals.py::Dog.speak', 'animals.py::Cat.speak',
        'main.py::dog_owner', 'main.py::cat_owner', 'main.py::main', 'main.py::<module>'],
      edges: [
        ['animals.py::Dog.speak', 'animals.py::make_sound', [7]],
        ['animals.py::Cat.speak', 'animals.py::make_sound', [12]],
        ['main.py::dog_owner', 'animals.py::Dog.speak', [5]],
        ['main.py::cat_owner', 'animals.py::Cat.speak', [9]],
        ['main.py::main', 'main.py::dog_owner', [13]],
        ['main.py::main', 'main.py::cat_owner', [14]],
        ['main.py::<module>', 'main.py::main', [18]],
      ],
    },
    {
      name: 'python classes: only Dog.speak callers', file: 'animals.py', lineContains: 'def speak', symbol: 'speak',
      nodes: ['animals.py::Dog.speak', 'main.py::dog_owner', 'main.py::main', 'main.py::<module>'],
      edges: [
        ['main.py::dog_owner', 'animals.py::Dog.speak', [5]],
        ['main.py::main', 'main.py::dog_owner', [13]],
        ['main.py::<module>', 'main.py::main', [18]],
      ],
      chokepoints: ['main.py::dog_owner'],
    },
  ],
  'test4/cpp': [
    {
      name: 'C++ classes: shared callee', file: 'animals.cpp', lineContains: 'void make_sound', symbol: 'make_sound',
      nodes: ['animals.cpp::make_sound', 'animals.cpp::Dog::speak', 'animals.cpp::Cat::speak',
        'main.cpp::dog_owner', 'main.cpp::cat_owner', 'main.cpp::main'],
      edges: [
        ['animals.cpp::Dog::speak', 'animals.cpp::make_sound', [12]],
        ['animals.cpp::Cat::speak', 'animals.cpp::make_sound', [17]],
        ['main.cpp::dog_owner', 'animals.cpp::Dog::speak', [5]],
        ['main.cpp::cat_owner', 'animals.cpp::Cat::speak', [10]],
        ['main.cpp::main', 'main.cpp::dog_owner', [15]],
        ['main.cpp::main', 'main.cpp::cat_owner', [16]],
      ],
    },
    {
      name: 'C++ classes: Dog::speak from its in-class declaration', file: 'animals.hpp', lineContains: 'void speak', symbol: 'speak',
      nodes: ['animals.cpp::Dog::speak', 'main.cpp::dog_owner', 'main.cpp::main'],
      edges: [
        ['main.cpp::dog_owner', 'animals.cpp::Dog::speak', [5]],
        ['main.cpp::main', 'main.cpp::dog_owner', [15]],
      ],
      chokepoints: ['main.cpp::dog_owner'],
    },
  ],
  'test5/python': [
    {
      // At depth 1, countdown and is_even are both missing main. Expanding countdown brings main in, so is_even's
      // marker must be refreshed: it gets the main -> is_even edge and loses its marker. step_c keeps its own.
      name: 'python expand: a caller two marked nodes were missing joins, and both are updated',
      file: 'recursion.py', lineContains: 'def leaf', symbol: 'leaf',
      options: { maxDepth: 1 }, expand: ['recursion.py::countdown'],
      nodes: ['recursion.py::leaf', 'recursion.py::countdown', 'recursion.py::is_even', 'recursion.py::is_odd',
        'recursion.py::step_c', 'main.py::main'],
      edges: [
        ['recursion.py::countdown', 'recursion.py::leaf', [7]],
        ['recursion.py::countdown', 'recursion.py::countdown', [8]],
        ['recursion.py::is_even', 'recursion.py::leaf', [13]],
        ['recursion.py::is_odd', 'recursion.py::leaf', [19]],
        ['recursion.py::is_even', 'recursion.py::is_odd', [14]],
        ['recursion.py::is_odd', 'recursion.py::is_even', [20]],
        ['recursion.py::step_c', 'recursion.py::leaf', [33]],
        ['main.py::main', 'recursion.py::countdown', [5]],
        ['main.py::main', 'recursion.py::is_even', [6]],
      ],
      recursionGroups: [['recursion.py::countdown'], ['recursion.py::is_even', 'recursion.py::is_odd']],
      hiddenCallers: { 'recursion.py::step_c': 1, 'main.py::main': 1 },
    },
    { name: 'python recursion: all three shapes reach leaf', file: 'recursion.py', lineContains: 'def leaf', symbol: 'leaf', ...pyRecursion },
    {
      name: 'python recursion: the right-clicked function is itself recursive', file: 'recursion.py', lineContains: 'def countdown', symbol: 'countdown',
      nodes: ['recursion.py::countdown', 'main.py::main', 'main.py::<module>'],
      edges: [
        ['recursion.py::countdown', 'recursion.py::countdown', [8]],
        ['main.py::main', 'recursion.py::countdown', [5]],
        ['main.py::<module>', 'main.py::main', [11]],
      ],
      recursionGroups: [['recursion.py::countdown']],
    },
  ],
  test8: [
    {
      name: `deep chain: default depth limit stops at level${DEFAULT_MAX_DEPTH}, marked +1`, file: 'chain.py', lineContains: 'def target', symbol: 'target',
      ...defaultDepthCutoff,
    },
    {
      name: 'deep chain: expanding the marked node loads the next levels and moves the marker up',
      file: 'chain.py', lineContains: 'def target', symbol: 'target',
      expand: [chainId(DEFAULT_MAX_DEPTH)],
      ...chain(2 * DEFAULT_MAX_DEPTH),
      hiddenCallers: { [chainId(2 * DEFAULT_MAX_DEPTH)]: 1 },
      chokepoints: Array.from({ length: 2 * DEFAULT_MAX_DEPTH - 1 }, (_, i) => chainId(i + 1)),
    },
    {
      name: 'deep chain: expanding again reaches main and the graph is complete',
      file: 'chain.py', lineContains: 'def target', symbol: 'target',
      expand: [chainId(DEFAULT_MAX_DEPTH), chainId(2 * DEFAULT_MAX_DEPTH)],
      nodes: [...chain(20).nodes, 'main.py::main', 'main.py::<module>'],
      edges: [...chain(20).edges, ['main.py::main', chainId(20), [5]], ['main.py::<module>', 'main.py::main', [9]]],
      chokepoints: Array.from({ length: 20 }, (_, i) => chainId(i + 1)),
    },
  ],
  // Neither Pylance nor the C/C++ extension reports creating an object (`Service()`, `Service service;`) as a call
  // to its constructor, so constructors appear without callers. latest() contains "test" but is not test code.
  'test7/python': [
    {
      name: 'noise: <module>, __init__ and test code are tagged; ordinary functions are not',
      file: 'target.py', lineContains: 'def target', symbol: 'target',
      nodes: ['target.py::target', 'service.py::Service.__init__', 'service.py::Service.run', 'service.py::latest',
        'tests/test_target.py::test_target', 'tests/helpers.py::call_target', 'main.py::main', 'main.py::<module>'],
      edges: [
        ['service.py::Service.__init__', 'target.py::target', [6]],
        ['service.py::Service.run', 'target.py::target', [9]],
        ['service.py::latest', 'target.py::target', [13]],
        ['tests/test_target.py::test_target', 'target.py::target', [5]],
        ['tests/helpers.py::call_target', 'target.py::target', [5]],
        ['main.py::main', 'service.py::Service.run', [5]],
        ['main.py::main', 'service.py::latest', [6]],
        ['main.py::<module>', 'main.py::main', [10]],
      ],
      noise: ['service.py::Service.__init__', 'tests/test_target.py::test_target', 'tests/helpers.py::call_target', 'main.py::<module>'],
    },
  ],
  'test7/cpp': [
    {
      name: 'noise: constructor, destructor and test code are tagged; ordinary functions are not',
      file: 'target.cpp', lineContains: 'int target', symbol: 'target',
      nodes: ['target.cpp::target', 'service.cpp::Service::Service', 'service.cpp::Service::~Service', 'service.cpp::Service::run',
        'service.cpp::latest', 'tests/test_target.cpp::test_target', 'main.cpp::main'],
      edges: [
        ['service.cpp::Service::Service', 'target.cpp::target', [6]],
        ['service.cpp::Service::~Service', 'target.cpp::target', [11]],
        ['service.cpp::Service::run', 'target.cpp::target', [16]],
        ['service.cpp::latest', 'target.cpp::target', [21]],
        ['tests/test_target.cpp::test_target', 'target.cpp::target', [5]],
        ['main.cpp::main', 'service.cpp::Service::run', [7]],
        ['main.cpp::main', 'service.cpp::latest', [6]],
      ],
      noise: ['service.cpp::Service::Service', 'service.cpp::Service::~Service', 'tests/test_target.cpp::test_target'],
    },
  ],
  'test5/c': [
    { name: 'C recursion: all three shapes reach leaf', file: 'recursion.c', lineContains: 'int leaf', symbol: 'leaf', ...cRecursion },
    { name: 'C recursion: from the prototype in the header', file: 'recursion.h', lineContains: 'int leaf', symbol: 'leaf', ...cRecursion },
    {
      name: 'C recursion: the right-clicked function is itself recursive', file: 'recursion.c', lineContains: 'int countdown', symbol: 'countdown',
      nodes: ['recursion.c::countdown', 'main.c::main'],
      edges: [
        ['recursion.c::countdown', 'recursion.c::countdown', [12]],
        ['main.c::main', 'recursion.c::countdown', [5]],
      ],
      recursionGroups: [['recursion.c::countdown']],
    },
  ],
  'test6': [
    { name: 'python search fixture: definition', file: 'sum.py', lineContains: 'def sum', symbol: 'sum', ...searchGraph },
    { name: 'python search fixture: call site', file: 'helpers.py', lineContains: 'return sum(value, 1)', symbol: 'sum', ...searchGraph },
  ],
  'test9/python': [
    {
      name: 'exception fixture (python): both routes to parse_age, load_record is the chokepoint',
      file: 'validate.py', lineContains: 'def parse_age', symbol: 'parse_age',
      ...crashGraph('py', 7, 7, { nodes: ['main.py::<module>'], edges: [['main.py::<module>', 'main.py::main', [11]]] }),
    },
  ],
  'test9/c': [
    {
      name: 'exception fixture (C): both routes to parse_age, load_record is the chokepoint',
      file: 'validate.c', lineContains: 'int parse_age', symbol: 'parse_age', ...crashGraph('c', 8, 8),
    },
  ],
  'test9/cpp': [
    {
      name: 'exception fixture (C++): both routes to parse_age, load_record is the chokepoint',
      file: 'validate.cpp', lineContains: 'int parse_age', symbol: 'parse_age', ...crashGraph('cpp', 7, 8),
    },
  ],
};
