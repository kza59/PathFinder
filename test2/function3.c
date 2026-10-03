#include "function3.h"
#include "function1.h"
#include "function2.h"

/* Redundant forward declaration instead of #include "sum.h": must not become its own node. */
int sum(int a, int b);

void function3(void)
{
    function2();
    function1();
    sum(4, 4);
    function1();
}
