#include "recursion.h"

int leaf(int value)
{
    return value;
}

int countdown(int n)
{
    if (n <= 0)
        return leaf(0);
    return countdown(n - 1);
}

int is_even(int n)
{
    if (n == 0)
        return leaf(1);
    return is_odd(n - 1);
}

int is_odd(int n)
{
    if (n == 0)
        return leaf(0);
    return is_even(n - 1);
}

int step_a(int n)
{
    return step_b(n);
}

int step_b(int n)
{
    return step_c(n);
}

int step_c(int n)
{
    if (n == 0)
        return leaf(n);
    return step_a(n - 1);
}
