VScode extension that allows you to right click on any function, click the option "PathFind", and then draws a beautiful graph illustrating how we "got here".

Concrete issue example: consider someone who is working on another person's very large and complex codebase. They see a print statement coming from a function, and they go to investigate. Upon seeing the function that invokes the print statement, they try looking for where that function is called by doing ctrl+shift+f on the function name. In the sidebar they see at least a hundred different places where it is invoked. They are now lost and may need to go through an insane amount of code just to find "how we got here". With pathfind, you just right click the function, click pathfind, and a clear, concise call graph is shown to you, which highlights the most relevant paths. 
For instance, consider sum() which is called many times in the example below. When the code executes, it should be made clear to the user at which times, and HOW the sum() function is being called.
The "optimal" design would of course be if somehow you could right click a print statement or something and immediately see the "touch" that way.

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
import { PathFindPanel } from './PathFindPanel';
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
security policy and no CDN. Layout settings are isolated in `layoutOptions`;
the built-in breadthfirst layout flows downward, using its maximal adjustment
on acyclic graphs to place callees below all their callers. Recursive graphs
use the ordinary breadthfirst layout because cycles cannot all point downward.

For development, use `npm run watch` for the extension and `npm run watch:webview`
in a second terminal for the webview. Run `npm run compile` for full type checks.
The existing graph-building command is unchanged. Integration TODOs are to call
the panel with its real graph, forward runtime paths when debugger integration
lands, and optionally handle clicks for source navigation. Temporary commands
are isolated in `src/graphRendererTest.ts`; their registration is one line in
`src/extension.ts`.
