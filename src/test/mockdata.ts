import type { DebugPath, GraphData } from '../types';

export const mockGraph: GraphData = {
  nodes: [
    {
      id: "sum.py::sum",
      label: "sum",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/sum.py",
      line: 1,
      endLine: 1
    },
    {
      id: "function1.py::function1",
      label: "function1",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function1.py",
      line: 4,
      endLine: 4
    },
    {
      id: "function2.py::function2",
      label: "function2",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function2.py",
      line: 5,
      endLine: 5
    },
    {
      id: "function3.py::function3",
      label: "function3",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function3.py",
      line: 6,
      endLine: 6
    },
    {
      id: "main.py::main",
      label: "main",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/main.py",
      line: 4,
      endLine: 4
    },
    {
      id: "main.py::<module>",
      label: "<module>",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/main.py",
      line: 1,
      endLine: 1
    }
  ],

  edges: [
    {
      from: "function1.py::function1",
      to: "sum.py::sum"
    },
    {
      from: "function2.py::function2",
      to: "sum.py::sum"
    },
    {
      from: "function3.py::function3",
      to: "sum.py::sum"
    },
    {
      from: "function2.py::function2",
      to: "function1.py::function1"
    },
    {
      from: "function3.py::function3",
      to: "function1.py::function1"
    },
    {
      from: "function3.py::function3",
      to: "function2.py::function2"
    },
    {
      from: "main.py::main",
      to: "function2.py::function2"
    },
    {
      from: "main.py::<module>",
      to: "main.py::main"
    }
  ]
};

export const mockDebugPath: DebugPath = [
  "main.py::<module>",
  "main.py::main",
  "function2.py::function2",
  "function1.py::function1",
  "sum.py::sum"
];
