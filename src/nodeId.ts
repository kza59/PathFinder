import * as path from 'path';

/**
 * Node identity shared by graphBuilder (static analysis) and debugTracker (runtime).
 * Both sides MUST build ids through makeNodeId, or highlights won't match graph nodes.
 *
 * Format: `<absolute posix path>::<qualified function name>`, e.g. `/home/me/proj/function1.py::function1`,
 * `/home/me/proj/animals.py::Dog.speak`, `c:/proj/animals.cpp::Dog::speak` (Windows: lowercased, forward slashes).
 * The path is always the definition's file, never a header.
 * Module-level code uses MODULE_NAME (what debugpy reports as the frame name).
 * The runtime side should map stack frames to nodes with graphBuilder's findNodeForFrame (file + line),
 * since debuggers spell function names differently from language servers.
 */
export const MODULE_NAME = '<module>';

export function normalizePath(fsPath: string): string {
  const p = path.resolve(fsPath).split(path.sep).join('/');
  // Windows paths are case-insensitive and debuggers disagree on drive-letter case.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function makeNodeId(fsPath: string, functionName: string): string {
  return `${normalizePath(fsPath)}::${functionName}`;
}
