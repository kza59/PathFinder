import * as vscode from 'vscode';
import { buildCallGraph } from './graphBuilder';
import { registerGraphRendererTestCommands } from './test/graphRendererTest';
import { PathFindPanel } from './webview/PathFindPanel';
import { registerDebugTracker } from './debugTracker';
import { registerHotPathCounting } from './hotPath'; // hot-path counting
import { registerRecursionLog } from './recursionLog';

export function activate(context: vscode.ExtensionContext) {
  registerGraphRendererTestCommands(context);
  const output = vscode.window.createOutputChannel('PathFinder');
  registerDebugTracker(context);
  // --- hot-path counting ---
  registerHotPathCounting(context);
  // --- end hot-path counting ---
  // registerRecursionLog(context); // TEMPORARY: see src/recursionLog.ts

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
      vscode.window.showWarningMessage('PathFinder: no function found here (is the language server still loading?)');
      return;
    }
    // TODO: hand `graph` to the webview once rendering lands; JSON dumclp for now.
    const panel = PathFindPanel.createOrShow(context.extensionUri);
    attachClickToCode(panel);
    panel.renderGraph(graph);

    output.clear();
    output.appendLine(JSON.stringify(graph, null, 2));
    output.show(true);
  }));
}

export function deactivate() {}
