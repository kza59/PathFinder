import * as vscode from 'vscode';
import { buildCallGraph } from './graphBuilder';
import { registerGraphRendererTestCommands } from './test/graphRendererTest';
import { PathFindPanel } from './webview/PathFindPanel';
import type { GraphData } from './types';
import { registerDebugTracker } from './debugTracker';
import { registerHotPathCounting } from './hotPath'; // hot-path counting
import { registerGdbHotPathCounting } from './hotPathGdb'; // hot-path counting for C/C++
import { registerExplainPath } from './explainPath'; // optional AI explanation of the live path
import { registerCrashGraph } from './crashGraph'; // open the graph on a crash

export function activate(context: vscode.ExtensionContext) {
  registerGraphRendererTestCommands(context);
  const output = vscode.window.createOutputChannel('PathFinder');
  registerDebugTracker(context);
  // --- hot-path counting ---
  registerHotPathCounting(context);
  registerGdbHotPathCounting(context);
  registerExplainPath(context);
  // --- end hot-path counting ---

  // --- click-to-code feature ---
  // The panel is created lazily (and re-created after it's closed), so subscribe per panel instance.
  // Graph lines are 1-based (graphBuilder: selectionRange.start.line + 1); VS Code positions are 0-based.
  const clickToCodePanels = new WeakSet<PathFindPanel>();
  const attachClickToCode = (panel: PathFindPanel) => {
    if (clickToCodePanels.has(panel)) {
      return;
    }
    clickToCodePanels.add(panel);
    context.subscriptions.push(panel.onDidClickNode(async ({ file, line }) => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const target = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
        // Open beside the graph rather than replacing it: reuse a visible editor's column if there is one.
        const column = vscode.window.visibleTextEditors[0]?.viewColumn ?? vscode.ViewColumn.One;
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: column });
        const position = new vscode.Position(target, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } catch (error) {
        output.appendLine(`PathFinder: could not open ${file}:${line} (${error instanceof Error ? error.message : String(error)})`);
      }
    }));
  };
  // --- end click-to-code feature ---

  /** Shows a graph in the panel (creating it if needed), with click-to-code attached. */
  const openGraph = (graph: GraphData) => {
    const panel = PathFindPanel.createOrShow(context.extensionUri);
    attachClickToCode(panel);
    panel.renderGraph(graph);
    return panel;
  };
  registerCrashGraph(context, openGraph);

  context.subscriptions.push(output, vscode.commands.registerCommand('pathfinder.pathFind', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const graph = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'PathFinder: building call graph', cancellable: true },
      (_progress, token) => buildCallGraph(editor.document.uri, editor.selection.active, { token }),
    );
    if (!graph) {
      vscode.window.showWarningMessage("PathFinder: no function at the cursor. Right-click a function's name or a call to it. (If you just opened this folder, the language server may still be loading.)");
      return;
    }
    openGraph(graph);

    output.clear();
    output.appendLine(JSON.stringify(graph, null, 2));
    output.show(true);
  }));
}

export function deactivate() {}
