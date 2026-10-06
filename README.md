# PathFinder

PathFinder is a VS Code extension that visualizes how a function is reached through a codebase.

Right-click any function, select **PathFind**, and PathFinder generates an interactive call graph showing the functions and paths that can lead to it.

## Why PathFinder?

Navigating a large or unfamiliar codebase can be difficult.

Suppose you find a function producing unexpected output and want to understand how execution reached it. A global search may show dozens or even hundreds of call sites, leaving you to manually trace through the code.

PathFinder turns that search into a visual graph, helping you quickly understand:

- where a function is called from
- which paths lead to it
- which paths were actually taken during debugging
- which functions are important chokepoints
- how frequently different execution paths are used

## Features

- **Static Call Graph**  
  Visualize direct and indirect callers of a selected function.

- **Live Debug Path**  
  Highlight the active call path while debugging.

- **Hot Path Heatmap**  
  See frequently executed functions and paths at a glance.

- **Debug Replay**  
  Replay recorded execution paths after a debugging session.

- **Chokepoint Detection**  
  Identify useful locations to place breakpoints with **Where to Break**.

- **Recursive Call Visualization**  
  Detect and visually group direct and mutual recursion.

- **Expandable Graphs**  
  Load omitted callers using interactive `+N` nodes.

- **Trace & Explore Layouts**  
  Switch between structured call-flow visualization and interactive force-based exploration.

- **Search & Navigation**  
  Find functions in the graph and jump directly to their source code.

## How to Use

1. Open a project in VS Code.
2. Right-click a function.
3. Select **PathFind**.
4. Explore the generated call graph.
5. Start debugging to see live execution paths and runtime heatmaps.

## Example

Consider the following call structure:

```text
main
├── function1
├── function2
│   ├── function1
│   └── sum
└── function3
    ├── function2
    ├── function1
    ├── sum
    └── function1
```
Running PathFind on `sum()` shows every relevant route that can reach it.
During debugging, PathFinder highlights the actual path taken each time `sum()` is reached.

## Tech Stack
- TypeScript
- Python
- VS Code Extension API
- Cytoscape.js

## Built at StormHacks 2026
PathFinder was created during StormHacks 2026 to make navigating and debugging unfamiliar codebases faster and more intuitive.
