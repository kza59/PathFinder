import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MODULE_NAME, normalizePath } from './nodeId';
import type { GraphData, HotCounts } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

/**
 * Hot-path counting (Python 3.12+ only): counts every call of every workspace function during a
 * Python debug launch and sends the totals to the webview as a 'hotCounts' message.
 *
 * 1. A DebugConfigurationProvider for debugpy puts python/pathfinder_hot first on the launch's
 *    PYTHONPATH, so its sitecustomize.py loads at interpreter startup (the user's code is untouched).
 * 2. That hook counts calls with sys.monitoring and keeps <dir>/<pid>.json up to date.
 * 3. While the session runs, this module polls <dir>, maps the counts onto graph nodes and
 *    sends them to the panel (and logs them to the "PathFinder Hot Path" output channel).
 * Any other debugger, or an attach request, is left alone.
 */

const PYTHON_DEBUG_TYPES = ['debugpy', 'python'];
const DIR_CONFIG_KEY = 'pathfinderHotDir'; // carries the counts folder from the config to the session
const POLL_MS = 300;

/** One function as reported by sitecustomize.py. Lines are 1-based. */
export interface HotFunction {
  file: string;     // absolute path
  qualname: string; // Python's co_qualname: "Dog.speak", "outer.<locals>.inner", "<module>"
  line: number;     // co_firstlineno: the def line, or the first decorator line when decorated
  endLine: number;  // last line of the function's code
  count: number;
}

interface HotFile {
  pid: number;
  functions?: HotFunction[];
  error?: string;
}

function lastSegment(name: string): string {
  return name.split('.').pop() ?? name;
}

/**
 * Maps counted Python functions onto graph nodes. Matches by location, not by building an id from
 * the name: Python's qualnames ("outer.<locals>.inner") differ from the graph's labels ("outer.inner"),
 * and graph ids can carry an "@line" suffix.
 *
 * A function matches the node in the same file whose name line is the first one at or after the
 * code's first line (skips decorator lines; picks the outer function over a nested def on its first
 * body line), within the code's lines, with the same last name segment. "<module>" matches the
 * file's module node.
 */
export function mapHotCounts(functions: HotFunction[], graph: GraphData | undefined): {
  counts: HotCounts;
  unmatched: { fn: HotFunction; reason: string }[];
} {
  const nodesByFile = new Map<string, GraphData['nodes']>();
  for (const node of graph?.nodes ?? []) {
    const file = normalizePath(node.file);
    nodesByFile.set(file, [...(nodesByFile.get(file) ?? []), node]);
  }

  const counts: HotCounts = {};
  const unmatched: { fn: HotFunction; reason: string }[] = [];
  for (const fn of functions) {
    const file = normalizePath(fn.file);
    const nodes = nodesByFile.get(file) ?? [];
    let match: GraphData['nodes'][number] | undefined;
    if (fn.qualname === MODULE_NAME) {
      match = nodes.find(node => node.label === MODULE_NAME);
    } else {
      for (const node of nodes) {
        if (node.label !== MODULE_NAME && fn.line <= node.line && node.line <= fn.endLine
            && lastSegment(node.label) === lastSegment(fn.qualname)
            && (!match || node.line < match.line)) {
          match = node;
        }
      }
    }
    if (match) {
      counts[match.id] = (counts[match.id] ?? 0) + fn.count;
      continue;
    }
    // --- diagnostics: why it didn't match ---
    const describe = (list: GraphData['nodes']) =>
      list.map(node => `${node.label} @${node.line}-${node.endLine}`).join(', ');
    let reason: string;
    if (!graph) {
      reason = 'no graph';
    } else if (!nodes.length) {
      reason = `file not in graph: ${file}`;
    } else if (fn.qualname === MODULE_NAME) {
      reason = `no <module> node in this file (file has: ${describe(nodes)})`;
    } else {
      const atLines = nodes.filter(node => node.label !== MODULE_NAME && fn.line <= node.line && node.line <= fn.endLine);
      reason = atLines.length
        ? `name differs: "${lastSegment(fn.qualname)}" vs ${describe(atLines)}`
        : `no node at lines ${fn.line}-${fn.endLine} (file has: ${describe(nodes)})`;
    }
    unmatched.push({ fn, reason });
  }
  return { counts, unmatched };
}

/** PYTHONPATH from a dotenv file (KEY=VALUE lines), or undefined. No ${VAR} expansion. */
function envFilePythonPath(envFile: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?PYTHONPATH\s*=\s*(.*?)\s*$/.exec(line);
    if (match) {
      return match[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return undefined;
}

class HotSession {
  private readonly files = new Map<string, { mtimeMs: number; data: HotFile }>();
  private readonly timer: NodeJS.Timeout;
  private polling: Promise<void> = Promise.resolve();

  constructor(
    readonly sessionId: string,
    readonly dir: string,
    private readonly onChange: (functions: HotFunction[], errors: string[]) => void,
  ) {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  /** Reads every <pid>.json that changed since the last poll (one per Python process). */
  poll(): Promise<void> {
    this.polling = this.polling.then(async () => {
      let names: string[];
      try {
        names = (await fs.promises.readdir(this.dir)).filter(name => name.endsWith('.json'));
      } catch {
        return; // the hook hasn't written anything yet
      }
      let changed = false;
      for (const name of names) {
        const file = path.join(this.dir, name);
        try {
          const { mtimeMs } = await fs.promises.stat(file);
          if (this.files.get(name)?.mtimeMs === mtimeMs) {
            continue;
          }
          const data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as HotFile;
          this.files.set(name, { mtimeMs, data });
          changed = true;
        } catch {
          // Replaced mid-read (Windows): picked up on the next poll.
        }
      }
      if (changed) {
        const all = [...this.files.values()].map(entry => entry.data);
        this.onChange(all.flatMap(data => data.functions ?? []), all.flatMap(data => data.error ?? []));
      }
    });
    return this.polling;
  }

  get receivedAnything(): boolean {
    return this.files.size > 0;
  }

  /** Final read after the process exits, then removes the counts folder. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.poll();
    await fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerHotPathCounting(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PathFinder Hot Path');
  const bootstrap = path.join(context.extensionPath, 'python', 'pathfinder_hot');
  let active: HotSession | undefined;
  let functions: HotFunction[] = []; // latest totals, kept after the session ends until the next one
  let lastLog = '';

  // --- diagnostics: number each panel instance, to tell them apart in the log ---
  const panelNumbers = new WeakMap<PathFindPanel, number>();
  let panelCount = 0;
  const panelName = (panel: PathFindPanel | undefined) => {
    if (!panel) {
      return 'no panel';
    }
    if (!panelNumbers.has(panel)) {
      panelNumbers.set(panel, ++panelCount);
    }
    return `panel #${panelNumbers.get(panel)}`;
  };

  const publish = (trigger: string) => {
    const panel = PathFindPanel.currentPanel;
    const graph = panel?.currentGraph;
    const { counts, unmatched } = mapHotCounts(functions, graph);
    panel?.setHotCounts(counts);

    const labels = new Map(graph?.nodes.map(node => [node.id, node.label]));
    const lines = [
      ...Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([id, count]) => `  ${String(count).padStart(8)}  ${labels.get(id)}   (${id})`),
      ...(unmatched.length ? ['  not in graph:'] : []),
      ...unmatched.sort((a, b) => b.fn.count - a.fn.count).flatMap(({ fn, reason }) => [
        `  ${String(fn.count).padStart(8)}  ${fn.qualname}   (${fn.file}:${fn.line}-${fn.endLine})`,
        `            why: ${reason}`,
      ]),
    ];
    const log = lines.join('\n');
    if (log !== lastLog) {
      lastLog = log;
      output.appendLine(`[${new Date().toLocaleTimeString()}] calls per function (on ${trigger}):`);
      // --- diagnostics: which graph the counts were matched against ---
      output.appendLine(`  ${panelName(panel)}, ${graph ? `graph: ${graph.nodes.length} nodes` : 'no graph open'}`);
      for (const node of graph?.nodes ?? []) {
        output.appendLine(`    node ${node.label} @${node.line}-${node.endLine}  file=${normalizePath(node.file)}  id=${node.id}`);
      }
      output.appendLine(log || '  (none yet)');
    }
  };

  const provider: vscode.DebugConfigurationProvider = {
    resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
      try {
        const roots = (vscode.workspace.workspaceFolders ?? [])
          .filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
        if (config.request !== 'launch' || !roots.length || !fs.existsSync(path.join(bootstrap, 'sitecustomize.py'))) {
          return config;
        }
        const env: Record<string, string | null> = { ...(config.env ?? {}) };
        const envFile = typeof config.envFile === 'string'
          ? config.envFile
          : path.join((folder ?? vscode.workspace.workspaceFolders![0]).uri.fsPath, '.env');
        const existing = env.PYTHONPATH ?? envFilePythonPath(envFile) ?? process.env.PYTHONPATH;
        const dir = path.join(os.tmpdir(), `pathfinder-hot-${randomBytes(6).toString('hex')}`);
        env.PYTHONPATH = existing ? `${bootstrap}${path.delimiter}${existing}` : bootstrap;
        env.PATHFINDER_HOT_DIR = dir;
        env.PATHFINDER_HOT_ROOTS = roots.join(path.delimiter);
        config.env = env;
        config[DIR_CONFIG_KEY] = dir;
      } catch (error) {
        output.appendLine(`Hot-path counting disabled for this launch: ${error instanceof Error ? error.message : String(error)}`);
      }
      return config;
    },
  };

  const stopActive = async () => {
    const session = active;
    active = undefined;
    if (!session) {
      return;
    }
    await session.stop();
    output.appendLine(session.receivedAnything
      ? `[${new Date().toLocaleTimeString()}] debug session ended; final counts above.`
      : `[${new Date().toLocaleTimeString()}] debug session ended without any counts (is the interpreter Python 3.12+?).`);
  };

  context.subscriptions.push(
    { dispose: () => void stopActive() },
    output,
    ...PYTHON_DEBUG_TYPES.map(type => vscode.debug.registerDebugConfigurationProvider(type, provider)),
    vscode.debug.onDidStartDebugSession(session => {
      const dir: unknown = session.configuration[DIR_CONFIG_KEY];
      // Child sessions (subprocesses) can carry the same folder; the parent's poller already reads it.
      if (typeof dir !== 'string' || active?.dir === dir) {
        return;
      }
      void stopActive().then(() => {
        functions = [];
        lastLog = '';
        output.appendLine(`[${new Date().toLocaleTimeString()}] counting calls for "${session.name}"`);
        PathFindPanel.currentPanel?.setHotCounts({});
        active = new HotSession(session.id, dir, (latest, errors) => {
          errors.forEach(error => output.appendLine(`  hook: ${error}`));
          functions = latest;
          publish('new counts from the program');
        });
      });
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      if (active?.sessionId === session.id) {
        void stopActive();
      }
    }),
    // A new graph (or a re-opened panel) gets the current counts re-mapped onto its nodes.
    PathFindPanel.onDidRenderGraph(() => {
      if (functions.length) {
        publish('graph rendered');
      }
    }),
  );
}
