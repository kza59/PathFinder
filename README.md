VScode extension that allows you to right click on any function, click the option "PathFind", and then draws a beautiful graph illustrating how we "got here".

Concrete issue example: consider someone who is working on another person's very large and complex codebase. They see a print statement coming from a function, and they go to investigate. Upon seeing the function that invokes the print statement, they try looking for where that function is called by doing ctrl+shift+f on the function name. In the sidebar they see at least a hundred different places where it is invoked. They are now lost and may need to go through an insane amount of code just to find "how we got here". With pathfind, you just right click the function, click pathfind, and a clear, concise call graph is shown to you, which highlights the most relevant paths. 
For instance, consider sum() which is called many times in the example below. When the code executes, it should be made clear to the user at which times, and HOW the sum() function is being called.
The "optimal" design would of course be if somehow you could right click a print statement or something and immediately see the "touch" that way.

## Minimal Test Plan

**Objective:** Verify that PathFinder displays every call path leading to a selected function, and that the graph reflects the program's actual execution in real time.

**Preconditions**
- The extension is built (`npm run compile`) and running in the Extension Development Host.
- A sample program is open in which the target function is reached through several paths (e.g., `sum()` in the example below).
- The language extension for that program is installed and has finished loading (e.g., Pylance for Python, C/C++ for C and C++).

| # | Action | Expected Result |
|---|--------|-----------------|
| 1 | Right-click the target function (e.g., `sum()`) and select **PathFind**. | A graph opens showing the target function and every function that can call it, directly or indirectly. No paths are highlighted yet. |
| 2 | Start debugging (**F5**) and step through the program using the standard debugger controls. | Each time the target function is reached (a "touch"), the graph updates immediately. The path of the most recent touch is drawn in a distinct highlight color (e.g., magenta). |
| 3 | Continue stepping past the final call to the target function, then pause. | The most recent touch remains highlighted, so it is clear how the function was last reached. |
| 4 | Restart and run the program to completion without stepping. | The final graph matches the result of step 3: the same touch counts and the same most recent path. |
| 5 | Inspect the graph after execution. | Frequently taken paths are drawn hotter (brighter); paths taken less often, or not at all, are dimmer. |

**Pass criteria:** All expected results are observed, and the touch counts on each path match the number of times the program actually took that path.

Concrete example:
sum function defined in sum.py
def sum(a,b):
	return a+b

functions defined in function1.py, function2.py, function3.py respectively:
def function1():
	...
	...
	sum(1,2)
	...

def function2():
	...
	function1()
	sum(2,3)


def function3():
	...
	function2()
	function1()
	sum(4,4)
	function1()

def main():
	function1()
	function2()
	function3()

see example.png for how this call graph should look like.

## Graph renderer

Run `npm install` and `npm run compile`, then launch **Run PathFinder** with F5.
In the Extension Development Host, run **PathFind: Test Graph** from the command
palette to display the supplied six-node mock graph. **PathFind: Test Debug Path**
highlights the mock runtime path; **PathFind: Clear Debug Path** restores normal
styling. Click nodes and check the **PathFind Graph** output channel for their
`nodeClicked` messages.

**PathFind: Test Graph with Workspace Paths** uses the same IDs, labels, lines,
and edges, but points files at this extension's `test1` directory using VS Code
URIs. This works on Windows, Linux, and macOS. The original fixture in
`src/mockdata.ts` retains the exact supplied Linux paths. The renderer accepts
both slash styles, displays the filename and line in its footer, and returns
the original file string on clicks. It never derives identity from file paths.

```ts
import { PathFindPanel } from './webview/PathFindPanel';
import type { GraphData, DebugPath } from './types';

const panel = PathFindPanel.createOrShow(context.extensionUri);
panel.renderGraph(graph);
panel.highlightPath(path);
panel.clearDebugPath();
context.subscriptions.push(panel);
context.subscriptions.push(panel.onDidClickNode(message => {
  console.log(message.id, message.file, message.line);
}));
```

`graph` has type `GraphData`; `path` has type `DebugPath`. The panel remembers
the latest graph and runtime state until the webview sends `ready`, and replays
them if its document reloads. Runtime updates only change Cytoscape classes;
they preserve positions and the viewport. Unknown path IDs are ignored, missing
IDs do not create shortcut edges, and an absent final ID does not mark another
function as current. An empty path clears runtime styling.

The renderer source is `media/graph.ts`. `npm run compile` type-checks both the
extension and webview, then bundles Cytoscape and the renderer into
`out/webview/graph.js`. The webview loads this local bundle with a content
security policy and no CDN. Graphs carry `targetIds` identifying the resolved
functions selected with PathFind. `src/webview/targetLayout.ts` computes longest
directed path depths to those targets, treating each selected target as a path
endpoint. Recursive components are grouped into one level so cycles have finite
depth; self calls add no depth. The renderer uses a preset layout with deeper
callers above their callees. `<module>` nodes are pinned in the top row and `main`
nodes in the next row (or the top row when there are no module nodes), overriding
their computed depth. These entry nodes cannot be dragged. Other targets sit at
the bottom. Ordering within each row reduces crossings and stays deterministic.
Calls within a recursive group curve around the row, while shortcuts and return
calls use outer lanes. No call-distance labels are displayed along the left side.
Nodes without
a directed path to any target appear in a separate labeled area. Older payloads
without `targetIds` infer sink functions, ignoring self calls; graphs consisting
only of cycles between different functions need explicit targets.

Hover a function to emphasize its immediate callers and callees. Incoming calls
are green, outgoing calls orange, and unrelated connections fade. Highlighted
edges draw above ordinary edges while staying beneath nodes. The tooltip shows
the longest path depth and counts of distinct callers and callees in this graph.
Runtime path edges keep their blue color during hover, and leaving the function
restores the latest runtime styling. Hover, runtime updates, and resizing preserve
node positions; pan, zoom, drag, and graph replacement clear hover. The selected
function's `Target` marker remains distinct from the debugger's `You are here`.

`npm run test:unit` runs recursion tests, target-distance layout tests, and
headless Cytoscape renderer tests, including hover/runtime overlap. To run only
the renderer checks, use `npm run test:renderer`.

For development, use `npm run watch` for the extension and `npm run watch:webview`
in a second terminal for the webview. Run `npm run compile` for full type checks.
The PathFind command renders real graphs, debugger updates highlight runtime
paths, and clicking a function opens its source. Temporary preview commands
are isolated in `src/test/graphRendererTest.ts`; their registration is one line in
`src/extension.ts`.
