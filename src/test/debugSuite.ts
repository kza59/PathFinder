// Runs inside VS Code (see runTest.ts --debug), with the fixture folder as the workspace.
// Drives a real debug session through the fixture's own launch.json and checks what the debug tracker reports.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTracker, resolveDebugPath } from '../debugTracker';
import { buildCallGraph, CallGraph } from '../graphBuilder';
import { makeNodeId } from '../nodeId';
import { DebugCase, DEBUG_CASES } from './debugCases';

const GRAPH_TIMEOUT_MS = 90_000;   // language servers index lazily
const SESSION_TIMEOUT_MS = 120_000; // includes the `make` pre-launch build
const SETTLE_MS = 400;              // each stack arrives in pages; wait for the last one

function log(message: string) {
  if (process.env.PATHFINDER_LOG) {
    fs.appendFileSync(process.env.PATHFINDER_LOG, message + '\n');
  } else {
    console.log(message);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function lineOf(root: string, file: string, text: string): Promise<{ doc: vscode.TextDocument; line: number }> {
  const doc = await vscode.workspace.openTextDocument(path.join(root, file));
  return { doc, line: doc.getText().split('\n').findIndex(l => l.includes(text)) };
}

/** Builds the graph, retrying until every function the expected stops mention is in it. */
async function graphFor(root: string, c: DebugCase, expectedIds: Set<string>): Promise<CallGraph | undefined> {
  const { doc, line } = await lineOf(root, c.target.file, c.target.lineContains);
  await vscode.window.showTextDocument(doc);
  const position = new vscode.Position(line, doc.lineAt(line).text.indexOf(c.target.symbol));
  const started = Date.now();
  let graph: CallGraph | undefined;
  while (Date.now() - started < GRAPH_TIMEOUT_MS) {
    graph = await buildCallGraph(doc.uri, position).catch(() => undefined);
    if (graph && [...expectedIds].every(id => graph!.nodes.some(n => n.id === id))) {
      return graph;
    }
    await sleep(3000);
  }
  return graph;
}

async function runCase(root: string, c: DebugCase): Promise<boolean> {
  const abs = (id: string) => {
    const split = id.indexOf('::');
    return makeNodeId(path.join(root, id.slice(0, split)), id.slice(split + 2));
  };
  const expected = c.stops.map(stop => stop.map(abs));
  const graph = await graphFor(root, c, new Set(expected.flat()));
  if (!graph) {
    log(`  FAIL  ${c.name}: no graph`);
    return false;
  }
  const nodeIds = new Set(graph.nodes.map(n => n.id));

  const { doc, line } = await lineOf(root, c.breakpoint.file, c.breakpoint.lineContains);
  const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line, 0)));
  vscode.debug.addBreakpoints([breakpoint]);

  // At each stop: record the resolved path once the whole stack has arrived, then continue.
  const stops: string[][] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: () => createTracker(() => graph, frames => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stops.push(resolveDebugPath(frames, graph));
        void vscode.commands.executeCommand('workbench.action.debug.continue');
      }, SETTLE_MS);
    }),
  });
  const ended = new Promise<void>(resolve => {
    const sub = vscode.debug.onDidTerminateDebugSession(() => { sub.dispose(); resolve(); });
  });

  try {
    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], 'Debug main');
    if (!started) {
      log(`  FAIL  ${c.name}: the "Debug main" launch configuration did not start`);
      return false;
    }
    await Promise.race([ended, sleep(SESSION_TIMEOUT_MS)]);
  } finally {
    clearTimeout(timer);
    tracker.dispose();
    vscode.debug.removeBreakpoints([breakpoint]);
    await vscode.debug.stopDebugging();
  }

  // Frames outside the graph (libc's startup code, the Python runtime) may only sit outside the known path.
  const problems: string[] = [];
  stops.forEach((stop, i) => {
    const known = stop.map(id => nodeIds.has(id));
    const first = known.indexOf(true);
    const last = known.lastIndexOf(true);
    if (first !== -1 && known.slice(first, last + 1).includes(false)) {
      problems.push(`stop ${i + 1} has unmatched frames inside the path`);
    }
  });
  const actual = stops.map(stop => stop.filter(id => nodeIds.has(id)));
  const short = (paths: string[][]) => paths.map(p => p.map(id => id.slice(root.length + 1)).join(' -> '));
  if (problems.length === 0 && JSON.stringify(actual) === JSON.stringify(expected)) {
    log(`  PASS  ${c.name} (${stops.length} stops)`);
    short(actual).forEach(p => log(`          ${p}`));
    return true;
  }
  log(`  FAIL  ${c.name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  log(`    expected:\n${short(expected).map(p => `      ${p}`).join('\n')}`);
  log(`    actual:\n${short(actual).map(p => `      ${p}`).join('\n') || '      (no stops)'}`);
  log(`    raw stops:\n${stops.map(s => `      ${s.join(' -> ')}`).join('\n')}`);
  return false;
}

export async function run(): Promise<void> {
  const fixture = process.env.PATHFINDER_FIXTURE!;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  let failed = 0;
  const cases = DEBUG_CASES[fixture];
  for (const [i, c] of cases.entries()) {
    log(`  case ${i + 1}/${cases.length}: ${c.name}`);
    try {
      if (!(await runCase(root, c))) {
        failed++;
      }
    } catch (err) {
      log(`  FAIL  ${c.name}: ${err instanceof Error ? err.stack : err}`);
      failed++;
    }
  }
  if (failed) {
    throw new Error(`${failed} debug case(s) failed in ${fixture}`);
  }
}
