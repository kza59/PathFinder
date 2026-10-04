// Runs inside VS Code (see runTest.ts --debug), with the fixture folder as the workspace.
// Drives a real debug session through the fixture's own launch.json and checks what the debug tracker reports.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveDebugPath } from '../debugTracker';
import { buildCallGraph, CallGraph } from '../graphBuilder';
import { explanationPrompt } from '../explainPath';
import { DIR_CONFIG_KEY, HotFunction, mapHotCounts } from '../hotPath';
import { makeNodeId } from '../nodeId';
import { PathFindPanel } from '../webview/PathFindPanel';
import { DebugCase, DEBUG_CASES } from './debugCases';

const GRAPH_TIMEOUT_MS = 90_000;   // language servers index lazily
const SESSION_TIMEOUT_MS = 120_000; // includes the `make` pre-launch build
const SETTLE_MS = 400;              // each stack arrives in pages; wait for the last one
const COUNTS_MS = 400;              // the counting hooks write their file every 250 ms

/** Every function counted so far in this session's counts folder (one file per process). */
function readCounts(dir: string | undefined): HotFunction[] {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).functions ?? [];
    } catch {
      return []; // mid-write; the next stop reads it again
    }
  });
}

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

  const breakpoints: vscode.Breakpoint[] = [];
  if (c.breakpoint) {
    const { doc, line } = await lineOf(root, c.breakpoint.file, c.breakpoint.lineContains);
    breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(doc.uri, new vscode.Position(line, 0))));
    vscode.debug.addBreakpoints(breakpoints);
  }

  // At each stop: record the resolved path once the whole stack has arrived, then continue.
  const stops: string[][] = [];
  const counts: Record<string, number>[] = [];
  const prompts: string[] = [];
  const reasons: string[] = [];
  // What the panel showed at the crash, when the case expects it to open by itself.
  let panelAtCrash: { targetIds: string[]; path: string[]; crashed: boolean } | undefined;
  let countsDir: string | undefined;
  const started = vscode.debug.onDidStartDebugSession(session => {
    const dir: unknown = session.configuration[DIR_CONFIG_KEY];
    countsDir ??= typeof dir === 'string' ? dir : undefined;
  });
  // At each pause ask the debugger for the whole stack ourselves, instead of depending on when the VS Code UI
  // fetches it (it fetches the top frame first and the rest later, sometimes much later for debugpy).
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker: session => ({
      onDidSendMessage: (message: { type?: string; event?: string; body?: { threadId?: number; reason?: string; text?: string; description?: string } }) => {
        if (message.type !== 'event' || message.event !== 'stopped') {
          return;
        }
        reasons.push(message.body?.reason ?? '(none)');
        const threadId = message.body?.threadId;
        const stopBody = { ...message.body };
        setTimeout(async () => {
          try {
            const reply = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 500 });
            stops.push(resolveDebugPath(reply.stackFrames ?? [], graph));
            prompts.push(await explanationPrompt(session, graph, { reason: 'none', ...stopBody })
              .catch(err => `prompt failed: ${err}`));
            await sleep(COUNTS_MS);
            counts.push(mapHotCounts(readCounts(countsDir), graph).counts);
            if (c.autoOpen && stopBody.reason === 'exception') {
              const started = Date.now();
              while (!PathFindPanel.currentPanel?.isCrashed && Date.now() - started < GRAPH_TIMEOUT_MS) {
                await sleep(250);
              }
              const panel = PathFindPanel.currentPanel;
              panelAtCrash = panel && {
                targetIds: panel.currentGraph?.targetIds ?? [],
                path: panel.currentDebugPath.filter(id => panel.currentGraph?.nodes.some(n => n.id === id)),
                crashed: panel.isCrashed,
              };
            }
          } finally {
            void vscode.commands.executeCommand('workbench.action.debug.continue');
          }
        }, SETTLE_MS);
      },
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
    tracker.dispose();
    started.dispose();
    vscode.debug.removeBreakpoints(breakpoints);
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
  const sorted = (record: Record<string, number>) => JSON.stringify(Object.entries(record).sort());
  const countsText = (record: Record<string, number> | undefined) =>
    Object.entries(record ?? {}).map(([id, n]) => `${id.slice(root.length + 1)}=${n}`).sort().join(', ') || '(none)';
  const expectedCounts = Object.fromEntries(Object.entries(c.hotCounts).map(([id, n]) => [abs(id), n]));
  const lastCounts = counts[counts.length - 1];
  if (sorted(lastCounts ?? {}) !== sorted(expectedCounts)) {
    problems.push(`call counts at the last stop: expected ${countsText(expectedCounts)}; got ${countsText(lastCounts)}`);
  }
  if (c.stopReasons && JSON.stringify(reasons) !== JSON.stringify(c.stopReasons)) {
    problems.push(`stop reasons: expected ${c.stopReasons.join(', ')}; got ${reasons.join(', ') || '(no stops)'}`);
  }
  // The exception line must appear exactly when the program stopped because of an exception.
  const crashed = reasons[0] === 'exception';
  if (prompts[0] !== undefined && prompts[0].includes('stopped because of an exception') !== crashed) {
    problems.push(`explanation prompt at stop 1 ${crashed ? 'is missing' : 'should not have'} the exception line`);
  }
  if (c.autoOpen) {
    const want = { targetIds: [abs(c.autoOpen)], path: expected[0], crashed: true };
    if (JSON.stringify(panelAtCrash) !== JSON.stringify(want)) {
      const show = (v: unknown) => JSON.stringify(v)?.split(root + '/').join('') ?? 'no panel opened';
      problems.push(`panel at the crash: expected ${show(want)}; got ${show(panelAtCrash)}`);
    }
  }
  const missing = c.promptMentions.filter(text => !(prompts[0] ?? '').includes(text));
  if (missing.length) {
    problems.push(`explanation prompt at stop 1 is missing: ${missing.join(', ')}`);
  }
  if (process.env.PATHFINDER_SHOW_PROMPT) {
    log(`    explanation prompt at stop 1:\n${(prompts[0] ?? '(none)').split('\n').map(l => `      | ${l}`).join('\n')}`);
  }
  if (problems.length === 0 && JSON.stringify(actual) === JSON.stringify(expected)) {
    log(`  PASS  ${c.name} (${stops.length} stops)`);
    short(actual).forEach(p => log(`          ${p}`));
    log(`          counts: ${countsText(lastCounts)}`);
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
