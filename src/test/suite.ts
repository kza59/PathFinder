// Runs inside VS Code (see runTest.ts), with the fixture folder as the workspace.
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCallGraph, CallGraph } from '../graphBuilder';
import { Case, CASES } from './cases';

const TIMEOUT_MS = 120_000; // language servers index lazily, so retry until the graph is complete
const RETRY_MS = 3_000;

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

  const expected = JSON.stringify({ nodes: [...c.nodes].sort(), edges: c.edges.map(([f, t]) => `${f} -> ${t}`).sort() });
  let actual = '';
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      actual = JSON.stringify(describe(await buildCallGraph(doc.uri, position)));
    } catch (err) {
      actual = `threw ${err instanceof Error ? err.message : err}`; // language server not ready yet
    }
    if (actual === expected) {
      console.log(`  PASS  ${c.name}`);
      return true;
    }
    await new Promise(r => setTimeout(r, RETRY_MS));
  }
  console.log(`  FAIL  ${c.name}\n    expected: ${expected}\n    actual:   ${actual}`);
  return false;
}

export async function run(): Promise<void> {
  const fixture = process.env.PATHFINDER_FIXTURE!;
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  console.log(`\n[${fixture}]`);
  let failed = 0;
  for (const c of CASES[fixture]) {
    try {
      if (!(await runCase(root, c))) {
        failed++;
      }
    } catch (err) {
      console.log(`  FAIL  ${c.name}: ${err instanceof Error ? err.stack : err}`);
      failed++;
    }
  }
  if (failed) {
    throw new Error(`${failed} case(s) failed in ${fixture}`);
  }
}
