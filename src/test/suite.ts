// Runs inside VS Code (see runTest.ts), with the fixture folder as the workspace.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCallGraph, CallGraph, expandCallers, findNodeForFrame } from '../graphBuilder';
import { makeNodeId } from '../nodeId';
import { Case, CASES } from './cases';

// Language servers index lazily, so retry until the graph is complete. PATHFINDER_TIMEOUT (ms) overrides.
const TIMEOUT_MS = Number(process.env.PATHFINDER_TIMEOUT) || 120_000;
const RETRY_MS = 3_000;

// The extension host's stdout isn't reliably forwarded, so progress goes to a file runTest.ts streams live.
function log(message: string) {
  if (process.env.PATHFINDER_LOG) {
    fs.appendFileSync(process.env.PATHFINDER_LOG, message + '\n');
  } else {
    console.log(message);
  }
}

/** Groups as sorted member lists, so the comparison doesn't depend on how groups are numbered. */
function recursionGroups(members: (readonly [string, number | undefined])[]): string[][] {
  const groups = new Map<number, string[]>();
  for (const [id, group] of members) {
    if (group !== undefined) {
      groups.set(group, [...(groups.get(group) ?? []), id]);
    }
  }
  return [...groups.values()].map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

function describe(graph: CallGraph | undefined) {
  return {
    nodes: (graph?.nodes.map(n => `${n.id}${n.noise ? ' (noise)' : ''}${n.hiddenCallers ? ` (+${n.hiddenCallers} hidden)` : ''}`
      + `${n.chokepoint ? ' (chokepoint)' : ''}`) ?? []).sort(),
    edges: (graph?.edges.map(e => `${e.from} -> ${e.to} @ ${e.lines.join(',')}${e.recursive ? ' (recursive)' : ''}`) ?? []).sort(),
    recursionGroups: recursionGroups(graph?.nodes.map(n => [n.id, n.recursionGroup] as const) ?? []),
  };
}

async function runCase(root: string, c: Case): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(path.join(root, c.file));
  await vscode.window.showTextDocument(doc);
  const lineIndex = doc.getText().split('\n').findIndex(l => l.includes(c.lineContains));
  const position = new vscode.Position(lineIndex, doc.lineAt(lineIndex).text.indexOf(c.symbol));

  // cases.ts writes ids relative to the fixture folder for readability; real ids use absolute paths.
  const abs = (id: string) => {
    const split = id.indexOf('::');
    return makeNodeId(path.join(root, id.slice(0, split)), id.slice(split + 2));
  };
  const expected = JSON.stringify({
    // <module> (top-level code) is always noise, so cases only list the other noise nodes.
    nodes: c.nodes.map(id => `${abs(id)}${c.noise?.includes(id) || id.endsWith('::<module>') ? ' (noise)' : ''}`
      + `${c.hiddenCallers?.[id] ? ` (+${c.hiddenCallers[id]} hidden)` : ''}${c.chokepoints?.includes(id) ? ' (chokepoint)' : ''}`).sort(),
    edges: c.edges.map(([f, t, lines]) => {
      // An edge is recursive exactly when both ends are in the same expected group.
      const recursive = (c.recursionGroups ?? []).some(g => g.includes(f) && g.includes(t));
      return `${abs(f)} -> ${abs(t)} @ ${lines.join(',')}${recursive ? ' (recursive)' : ''}`;
    }).sort(),
    recursionGroups: recursionGroups((c.recursionGroups ?? []).flatMap((g, i) => g.map(id => [abs(id), i] as const))),
  });
  let actual = '';
  const started = Date.now();
  for (let attempt = 1; Date.now() - started < TIMEOUT_MS; attempt++) {
    let found = 0;
    let graph: CallGraph | undefined;
    try {
      graph = await buildCallGraph(doc.uri, position, c.options);
      for (const id of c.expand ?? []) {
        graph = graph && await expandCallers(graph, abs(id), c.options);
      }
      found = graph?.nodes.length ?? 0;
      actual = JSON.stringify(describe(graph));
    } catch (err) {
      actual = `threw ${err instanceof Error ? err.message : err}`; // language server not ready yet
    }
    if (actual === expected) {
      if (path.basename(root) === 'test1' && graph && !c.options) { // truncated graphs leave main out on purpose
        // Runtime frames stop on executable body lines, not just declarations.
        for (const [file, line, label] of [
          ['main.py', 5, 'main'], ['function2.py', 6, 'function2'],
          ['function2.py', 7, 'function2'], ['sum.py', 2, 'sum'],
          ['main.py', 9, '<module>'],
        ] as const) {
          const node = findNodeForFrame(graph, path.join(root, file), line);
          if (node?.label !== label) {
            log(`  FAIL  ${c.name}: runtime ${file}:${line} expected ${label}, got ${node?.label ?? 'unmatched'}`);
            log(`    ranges: ${JSON.stringify(graph.nodes.map(n => ({ label: n.label, file: n.file, line: n.line, endLine: n.endLine })))}`);
            return false;
          }
        }
      }
      log(`  PASS  ${c.name}`);
      return true;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    log(`        waiting for language server: ${found}/${c.nodes.length} nodes (attempt ${attempt}, ${seconds}s of ${TIMEOUT_MS / 1000}s)`);
    await new Promise(r => setTimeout(r, RETRY_MS));
  }
  log(`  FAIL  ${c.name}\n    expected: ${expected}\n    actual:   ${actual}\n    trace:`);
  await buildCallGraph(doc.uri, position, { ...c.options, trace: message => log(`      ${message}`) }).catch(err => log(`      threw ${err}`));
  return false;
}

export async function run(): Promise<void> {
  const fixture = process.env.PATHFINDER_FIXTURE!;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  let failed = 0;
  const cases = CASES[fixture];
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
    throw new Error(`${failed} case(s) failed in ${fixture}`);
  }
}
