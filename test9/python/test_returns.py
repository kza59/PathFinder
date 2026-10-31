class Dog:
    def __repr__(self):
        raise RuntimeError("should never run")

def add(a, b):
    return a + b

def gives_obj():
    return Dog()

def boom():
    raise ValueError("x")

def main():
    add(3, 4)
    gives_obj()
    try:
        boom()
    except ValueError:
        pass

main()