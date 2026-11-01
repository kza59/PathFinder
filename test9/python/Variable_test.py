def add(a, b):
      total = a + b
      return total

def compute(x):
      doubled = x * 2
      return add(doubled, 1)

def main():
      for i in range(4):
          compute(i)

main()