"""Run the search-and-jump fixture: python -B test6/main.py."""

from calculations import calculateTotal
from helpers import _helper
from order import save as save_order
from storage import saveCache, saveSnapshot
from sum import sum
from user import save as save_user
from workflow import runReports, runWorkflow


def main():
    results = {
        "sum": sum(1, 2),
        "calculateTotal": calculateTotal([1, 2, 3]),
        "_helper": _helper(10),
        "user.py::save": save_user(1),
        "order.py::save": save_order(1),
        "saveCache": saveCache(1),
        "saveSnapshot": saveSnapshot(1),
        "workflow": runWorkflow([1, 2, 3]),
        "reports": runReports([2, 4, 6]),
    }
    print(results)
    return results


if __name__ == "__main__":
    main()
