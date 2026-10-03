import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Node identity shared by graphBuilder (static analysis) and debugTracker (runtime).
 * Both sides MUST build ids through makeNodeId, or highlights won't match graph nodes.
 *
 * Format: `<workspace-relative posix path>::<functionName>`, e.g. `function1.py::function1`.
 * Module-level code uses MODULE_NAME (what debugpy reports as the frame name).
 */
export const MODULE_NAME = '<module>';

export function normalizePath(fsPath: string): string {
  const abs = path.resolve(fsPath);
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(abs));
  let p = folder ? path.relative(folder.uri.fsPath, abs) : abs;
  p = p.split(path.sep).join('/');
  // Windows paths are case-insensitive and debuggers disagree on drive-letter case.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function makeNodeId(fsPath: string, functionName: string): string {
  return `${normalizePath(fsPath)}::${functionName}`;
}
