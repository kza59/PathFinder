# Debug-tracker test: function3 -> function2 -> sum. Put a breakpoint inside sum.


def sum(a, b):
    return a + b


def function2():
    return sum(2, 3)


def function3():
    return function2()


if __name__ == "__main__":
     for _ in range(1000):
           function3()
