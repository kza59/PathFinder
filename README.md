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

When the debug session supplying the displayed call path ends, PathFind clears
the live path, current-function marker, and runtime dimming. The graph returns
to its static view while retaining the final heatmap counts and the current
layout and viewport. Ending an unrelated debug session preserves the displayed
session's path.

Chokepoints have a small ◇ beside their function name. **Where to break** focuses
a chokepoint at a readable zoom, starting closest to the target. Use the search
bar's result counter and previous/next arrows (or Enter / Shift+Enter in the
search field) to cycle through all visible chokepoints. Typing a function name
returns to normal search. The button is disabled when no visible chokepoints exist.

To check **Chokepoint Marker** and **Where to Break**, open `test8/chain.py` and
run **PathFind** on `target`. The intermediate chain functions should have ◇
markers; `target` and the top entry should retain their usual styles. Click
**Where to break** from a zoomed-out view, cycle both ways, and repeat after
expanding callers. Also check Trace / Explore, light / dark themes, and a graph
with no chokepoints.
