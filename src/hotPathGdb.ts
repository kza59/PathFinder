import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DIR_CONFIG_KEY } from './hotPath';

/**
 * Hot-path counting for C/C++: the gdb counterpart of hotPath.ts's Python hook.
 *
 * Adds two setup commands to every C/C++ (cppdbg, gdb) launch: load gdb/pathfinder_hot.py into gdb, then start
 * it with a fresh counts folder and the workspace roots. The script counts calls to workspace functions with
 * breakpoints that never stop, and writes <dir>/<pid>.json in the same format as the Python hook. Setting
 * DIR_CONFIG_KEY on the configuration is all hotPath.ts needs to poll that folder, map the counts onto graph
 * nodes and send them to the panel, exactly as for Python.
 *
 * Each counted call costs roughly 0.1 ms inside gdb, so functions called millions of times slow the program down.
 * lldb (macOS) launches and attach requests are left alone.
 */
export function registerGdbHotPathCounting(context: vscode.ExtensionContext): void {
  const script = path.join(context.extensionPath, 'gdb', 'pathfinder_hot.py');
  // gdb.string_to_argv understands double quotes, so paths with spaces survive.
  const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cppdbg', {
    resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
      const roots = (vscode.workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
      if (config.request !== 'launch' || (config.MIMode ?? 'gdb') !== 'gdb' || !roots.length || !fs.existsSync(script)) {
        return config;
      }
      const dir = path.join(os.tmpdir(), `pathfinder-hot-${randomBytes(6).toString('hex')}`);
      config.setupCommands = [
        ...(Array.isArray(config.setupCommands) ? config.setupCommands : []),
        {
          description: 'PathFinder: load the call counter',
          // runpy instead of `source`, so a path with spaces needs no gdb-specific quoting.
          text: `python import runpy; runpy.run_path(${JSON.stringify(script)})`,
          ignoreFailures: true,
        },
        {
          description: 'PathFinder: count calls to workspace functions',
          text: `pathfinder-hot ${quote(dir)} ${quote(roots.join(path.delimiter))}`,
          ignoreFailures: true,
        },
      ];
      config[DIR_CONFIG_KEY] = dir;
      return config;
    },
  }));
}
