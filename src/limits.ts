// Graph size limits. No vscode import, so plain-Node code (the test runner, unit tests) can use them too.

/** Default number of caller levels above the target; deeper callers show up as `hiddenCallers` on the last level. */
export const DEFAULT_MAX_DEPTH = 8;
/** Default cap on graph size; callers beyond it show up as `hiddenCallers`. */
export const DEFAULT_MAX_NODES = 300;
