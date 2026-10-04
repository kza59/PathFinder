"""Partial search for 'calc' should find calculateTotal."""

from sum import sum

def calculateTotal(values):
    total = 0
    for value in values:
        total = sum(total, value)
    return total


def validateTotal(total):
    return sum(total, 0) >= 0
