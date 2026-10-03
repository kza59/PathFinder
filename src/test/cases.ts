// Expected call graphs for each fixture folder. Ids are relative to the fixture folder (the test workspace).

export interface Case {
  name: string;
  file: string;        // file to "right-click" in
  lineContains: string; // first line containing this text...
  symbol: string;       // ...at the first occurrence of this name on it
  nodes: string[];
  edges: [string, string][];
}

const readmeGraph = (ext: string, extraNodes: string[] = [], extraEdges: [string, string][] = []) => ({
  nodes: [`sum.${ext}::sum`, `function1.${ext}::function1`, `function2.${ext}::function2`,
    `function3.${ext}::function3`, `main.${ext}::main`, ...extraNodes],
  edges: [
    [`function1.${ext}::function1`, `sum.${ext}::sum`],
    [`function2.${ext}::function2`, `sum.${ext}::sum`],
    [`function3.${ext}::function3`, `sum.${ext}::sum`],
    [`function2.${ext}::function2`, `function1.${ext}::function1`],
    [`function3.${ext}::function3`, `function1.${ext}::function1`],
    [`function3.${ext}::function3`, `function2.${ext}::function2`],
    [`main.${ext}::main`, `function2.${ext}::function2`],
    ...extraEdges,
  ] as [string, string][],
});

const pyGraph = readmeGraph('py', ['main.py::<module>'], [['main.py::<module>', 'main.py::main']]);
const cGraph = readmeGraph('c');
const cppGraph = readmeGraph('cpp');

export const CASES: Record<string, Case[]> = {
  test1: [
    { name: 'python: definition', file: 'sum.py', lineContains: 'def sum', symbol: 'sum', ...pyGraph },
    { name: 'python: call site', file: 'function1.py', lineContains: 'sum(1, 2)', symbol: 'sum', ...pyGraph },
  ],
  test2: [
    { name: 'C: definition', file: 'sum.c', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: prototype in header', file: 'sum.h', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: forward declaration', file: 'function3.c', lineContains: 'int sum', symbol: 'sum', ...cGraph },
    { name: 'C: call site', file: 'function1.c', lineContains: 'sum(1, 2)', symbol: 'sum', ...cGraph },
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
        ['animals.py::Dog.speak', 'animals.py::make_sound'],
        ['animals.py::Cat.speak', 'animals.py::make_sound'],
        ['main.py::dog_owner', 'animals.py::Dog.speak'],
        ['main.py::cat_owner', 'animals.py::Cat.speak'],
        ['main.py::main', 'main.py::dog_owner'],
        ['main.py::main', 'main.py::cat_owner'],
        ['main.py::<module>', 'main.py::main'],
      ],
    },
    {
      name: 'python classes: only Dog.speak callers', file: 'animals.py', lineContains: 'def speak', symbol: 'speak',
      nodes: ['animals.py::Dog.speak', 'main.py::dog_owner', 'main.py::main', 'main.py::<module>'],
      edges: [
        ['main.py::dog_owner', 'animals.py::Dog.speak'],
        ['main.py::main', 'main.py::dog_owner'],
        ['main.py::<module>', 'main.py::main'],
      ],
    },
  ],
  'test4/cpp': [
    {
      name: 'C++ classes: shared callee', file: 'animals.cpp', lineContains: 'void make_sound', symbol: 'make_sound',
      nodes: ['animals.cpp::make_sound', 'animals.cpp::Dog::speak', 'animals.cpp::Cat::speak',
        'main.cpp::dog_owner', 'main.cpp::cat_owner', 'main.cpp::main'],
      edges: [
        ['animals.cpp::Dog::speak', 'animals.cpp::make_sound'],
        ['animals.cpp::Cat::speak', 'animals.cpp::make_sound'],
        ['main.cpp::dog_owner', 'animals.cpp::Dog::speak'],
        ['main.cpp::cat_owner', 'animals.cpp::Cat::speak'],
        ['main.cpp::main', 'main.cpp::dog_owner'],
        ['main.cpp::main', 'main.cpp::cat_owner'],
      ],
    },
    {
      name: 'C++ classes: Dog::speak from its in-class declaration', file: 'animals.hpp', lineContains: 'void speak', symbol: 'speak',
      nodes: ['animals.cpp::Dog::speak', 'main.cpp::dog_owner', 'main.cpp::main'],
      edges: [
        ['main.cpp::dog_owner', 'animals.cpp::Dog::speak'],
        ['main.cpp::main', 'main.cpp::dog_owner'],
      ],
    },
  ],
};
