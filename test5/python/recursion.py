def leaf(value):
    
    return value


def countdown(n):
    if n <= 0:
        return leaf(0)
    return countdown(n - 1)


def is_even(n):
    if n == 0:
        return leaf(True)
    return is_odd(n - 1)


def is_odd(n):
    if n == 0:
        return leaf(False)
    return is_even(n - 1)


def step_a(n):
    return step_b(n)


def step_b(n):
    return step_c(n)


def step_c(n):
    if n == 0:
        return leaf(n)
    return step_a(n - 1)
