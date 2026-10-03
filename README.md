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
