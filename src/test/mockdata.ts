import type { DebugPath, GraphData } from '../types';

export const mockGraph: GraphData = {
  targetIds: ['sum.py::sum'],
  nodes: [
    {
      id: "sum.py::sum",
      label: "sum",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/sum.py",
      line: 1,
      endLine: 2
    },
    {
      id: "function1.py::function1",
      label: "function1",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function1.py",
      line: 4,
      endLine: 5
    },
    {
      id: "function2.py::function2",
      label: "function2",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function2.py",
      line: 5,
      endLine: 7
    },
    {
      id: "function3.py::function3",
      label: "function3",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/function3.py",
      line: 6,
      endLine: 10
    },
    {
      id: "main.py::main",
      label: "main",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/main.py",
      line: 4,
      endLine: 5
    },
    {
      id: "main.py::<module>",
      label: "<module>",
      file: "/home/kanez/Useful/Stormhacks2026/PathFinder/test1/main.py",
      line: 1,
      endLine: 9
    }
  ],

  edges: [
    {
      from: "function1.py::function1",
      to: "sum.py::sum",
      lines: []
    },
    {
      from: "function2.py::function2",
      to: "sum.py::sum",
      lines: []
    },
    {
      from: "function3.py::function3",
      to: "sum.py::sum",
      lines: []
    },
    {
      from: "function2.py::function2",
      to: "function1.py::function1",
      lines: []
    },
    {
      from: "function3.py::function3",
      to: "function1.py::function1",
      lines: []
    },
    {
      from: "function3.py::function3",
      to: "function2.py::function2",
      lines: []
    },
    {
      from: "main.py::main",
      to: "function2.py::function2",
      lines: []
    },
    {
      from: "main.py::<module>",
      to: "main.py::main",
      lines: []
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

// A tall graph with duplicate names and the original mock runtime path intact.
const searchNodes = Array.from({ length: 120 }, (_, index) => ({
  id: `search/worker${index}.py::${index === 119 ? 'distantFunction' : 'worker' + index}`,
  label: index === 119 ? 'distantFunction' : `worker${index}`,
  file: `/pathfind-search/worker${index}.py`,
  line: 1,
  endLine: 10,
}));

export const largeSearchGraph: GraphData = {
  targetIds: mockGraph.targetIds,
  nodes: [
    ...mockGraph.nodes,
    ...searchNodes,
    ...['one', 'two'].map(name => ({
      id: `search/${name}/sum.py::sum`, label: 'sum',
      file: `/pathfind-search/${name}/sum.py`, line: 20, endLine: 25,
    })),
  ],
  edges: [
    ...mockGraph.edges,
    { from: 'main.py::main', to: searchNodes[0].id, lines: [] },
    ...searchNodes.slice(1).map((node, index) => ({ from: searchNodes[index].id, to: node.id, lines: [] })),
    { from: searchNodes[119].id, to: 'sum.py::sum', lines: [] },
    ...['one', 'two'].map(name => ({ from: `search/${name}/sum.py::sum`, to: 'sum.py::sum', lines: [] })),
  ],
};
