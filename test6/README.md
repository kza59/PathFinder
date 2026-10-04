# Python search and jump fixture

Like test1-test4, this folder is a sample program for testing PathFinder with
real function definitions and calls. All 15 functions reach `sum` directly or
indirectly, so its incoming-call graph includes every target in one graph.
The longest call chain has six function levels, plus a module entry node.
No additional Python packages are needed.

## Open the graph

1. Launch **Run PathFinder** from the extension project and select **test6**
   from the fixture folder picker.
2. Wait for the Python language server (for example, Pylance) to finish loading.
3. Open `sum.py`, place the cursor on the name in `def sum(a, b)`, and run
   **PathFind** from the editor context menu.
4. Confirm the graph contains the sixteen nodes below before testing search.
   Use this real graph rather than the **PathFind: Test Graph** mock graph.
5. Pan the graph so the intended target is off-center, then submit each query
   using the search-and-jump control. Run the checks with debugging stopped so
   runtime highlighting does not obscure temporary search highlighting.

The extension source at fixture creation has no search-and-jump control.
These cases are ready for manual testing once that feature is available.
Running the Python program exercises the call paths; it does not verify the
webview's centering, highlighting, messages, or search state.

## Expected graph nodes

IDs below use relative paths for readability. Actual PathFinder IDs include
the normalized absolute definition path followed by `::` and the label.

| Definition / ID suffix | Display label |
| --- | --- |
| `sum.py::sum` | `sum` |
| `calculations.py::calculateTotal` | `calculateTotal` |
| `calculations.py::validateTotal` | `validateTotal` |
| `helpers.py::_helper` | `_helper` |
| `user.py::save` | `save` |
| `order.py::save` | `save` |
| `storage.py::saveCache` | `saveCache` |
| `storage.py::saveSnapshot` | `saveSnapshot` |
| `workflow.py::runWorkflow` | `runWorkflow` |
| `workflow.py::runReports` | `runReports` |
| `processing.py::processBatch` | `processBatch` |
| `processing.py::buildReport` | `buildReport` |
| `records.py::processRecord` | `processRecord` |
| `records.py::summarizeRecords` | `summarizeRecords` |
| `main.py::main` | `main` |
| `main.py::<module>` | `<module>` |

The graph contains fifteen function nodes, the `<module>` entry node, and
thirty-three directed edges. The functions form these six levels along their
longest call paths; `main` also calls the original search targets directly.

| Function level | Functions |
| --- | --- |
| 1 | `main` |
| 2 | `runWorkflow`, `runReports` |
| 3 | `processBatch`, `buildReport` |
| 4 | `processRecord`, `summarizeRecords` |
| 5 | `calculateTotal`, `validateTotal`, `_helper`, both `save` functions, `saveCache`, `saveSnapshot` |
| 6 | `sum` |

For example: `main -> runWorkflow -> processBatch -> processRecord -> calculateTotal -> sum`.
The module entry point sits above `main`, adding a seventh level when counting
all graph nodes. Both workflows call both processing functions; `buildReport`
shares `processRecord` with `processBatch`, and both record functions share
calculation and validation nodes. `processBatch` calls `processRecord` at two
different source lines, represented by one edge with two call sites.

The import aliases `save_user` and `save_order` distinguish Python calls.
Both function definitions still have the display label `save` and different
node IDs. `<module>` is generated from the module-level `main()` call;
it is not a Python function declaration.

## Search and jump checks

For every successful search, verify the viewport centers on a matching node,
the node receives temporary highlighting, and that highlighting clears after
the feature's configured duration. Search should preserve the graph's node
IDs, node count, edges, and node positions.

| Case | Query / action | Expected result |
| --- | --- | --- |
| Exact function name | Submit `sum`. | Centers on `sum.py::sum` and temporarily highlights it. |
| Case-insensitive search | Submit `SUM`. | Finds the same `sum` node. |
| Partial search | Submit `calc`. | Finds `calculations.py::calculateTotal`. |
| No match | Submit `doesNotExist`. | No crash; pan and zoom remain unchanged; a visible no-match message appears. There is deliberately no function with this name. |
| Empty input | Clear the search field and submit; then enter three spaces and submit. | Neither input crashes or unexpectedly moves or zooms the graph. `""` means an empty field, not two literal quote characters. |
| Same function searched twice | Submit `sum`, then immediately submit `sum` again; repeat after the highlight has cleared. | Both searches center and highlight the same node consistently. No duplicate state, stale highlight, errors, or extra nodes appear. |
| Multiple matches | Submit `save`. | Handles four matches (`save` in two files, `saveCache`, `saveSnapshot`) without crashing. The MVP may select the first matching node; no particular traversal order is required. |
| Duplicate labels | Submit `save`, inspect the chosen node's file/location, and click each of the two `save` nodes. | Both nodes remain distinct by ID. Selecting or highlighting one does not accidentally select/highlight the other. Clicking each opens its own definition in `user.py` or `order.py`. |
| Special characters: module | Submit `<module>`. | Finds `main.py::<module>` safely, centers it, and temporarily highlights it. No selector/parsing error or unintended HTML interpretation occurs. |
| Special characters: underscore | Submit `_helper`. | Finds `helpers.py::_helper` safely, centers it, and temporarily highlights it. |
| Targets at different depths | Submit `runWorkflow`, `buildReport`, `processRecord`, and `validateTotal` in turn. | Each search centers and temporarily highlights its own node while preserving all sixteen nodes and their connections. |

For the no-match and empty-input checks, first move to a recognizable viewport
and wait for any earlier temporary highlight to clear. After a no-match or
empty query, search `sum` again to confirm the search remains usable.

## Run the Python fixture

From the extension project root:

```powershell
python -B test6/main.py
```

Or, with test6 open as the working folder:

```powershell
python -B main.py
```

Expected output:

```text
{'sum': 3, 'calculateTotal': 6, '_helper': 11, 'user.py::save': 101, 'order.py::save': 201, 'saveCache': 301, 'saveSnapshot': 401, 'workflow': 1666, 'reports': 1702}
```

The two `save` functions return different values to make their identities easy
to check while stepping through Python. They do not write files or contact
external services. `-B` avoids creating Python bytecode cache files.
