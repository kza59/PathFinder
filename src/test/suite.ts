// Runs inside VS Code (see runTest.ts), with the fixture folder as the workspace.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCallGraph, CallGraph } from '../graphBuilder';
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

function describe(graph: CallGraph | undefined) {
  return {
    nodes: (graph?.nodes.map(n => n.id) ?? []).sort(),
    edges: (graph?.edges.map(e => `${e.from} -> ${e.to}`) ?? []).sort(),
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
    nodes: c.nodes.map(abs).sort(),
    edges: c.edges.map(([f, t]) => `${abs(f)} -> ${abs(t)}`).sort(),
  });
  let actual = '';
  const started = Date.now();
  for (let attempt = 1; Date.now() - started < TIMEOUT_MS; attempt++) {
    let found = 0;
    try {
      const graph = await buildCallGraph(doc.uri, position);
      found = graph?.nodes.length ?? 0;
      actual = JSON.stringify(describe(graph));
    } catch (err) {
      actual = `threw ${err instanceof Error ? err.message : err}`; // language server not ready yet
    }
    if (actual === expected) {
      log(`  PASS  ${c.name}`);
      return true;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    log(`        waiting for language server: ${found}/${c.nodes.length} nodes (attempt ${attempt}, ${seconds}s of ${TIMEOUT_MS / 1000}s)`);
    await new Promise(r => setTimeout(r, RETRY_MS));
  }
  log(`  FAIL  ${c.name}\n    expected: ${expected}\n    actual:   ${actual}\n    trace:`);
  await buildCallGraph(doc.uri, position, { trace: message => log(`      ${message}`) }).catch(err => log(`      threw ${err}`));
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
