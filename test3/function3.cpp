#include "function3.hpp"
#include "function1.hpp"
#include "function2.hpp"

// Redundant forward declaration instead of #include "sum.hpp": must not become its own node.
int sum(int a, int b);

void function3()
{
    function2();
    function1();
    sum(4, 4);
    function1();
}
