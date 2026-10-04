"""Shared callers connect calculation, validation, helpers, and all save nodes."""

from calculations import calculateTotal, validateTotal
from helpers import _helper
from order import save as save_order
from storage import saveCache, saveSnapshot
from user import save as save_user


def processRecord(values):
    total = calculateTotal(values)
    if not validateTotal(total):
        raise ValueError("Record total must be non-negative")
    adjusted = _helper(total)
    user_total = save_user(adjusted)
    order_total = save_order(adjusted)
    return user_total + order_total


def summarizeRecords(values):
    total = calculateTotal(values)
    if not validateTotal(total):
        raise ValueError("Summary total must be non-negative")
    cached = saveCache(total)
    snapshot = saveSnapshot(total)
    return cached + snapshot
