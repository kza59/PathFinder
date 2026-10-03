import * as vscode from 'vscode';
import { buildCallGraph } from './graphBuilder';
import { registerGraphRendererTestCommands } from './test/graphRendererTest';
import { PathFindPanel } from './webview/PathFindPanel';

export function activate(context: vscode.ExtensionContext) {
  registerGraphRendererTestCommands(context);
  const output = vscode.window.createOutputChannel('PathFinder');

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
    // TODO: hand `graph` to the webview once rendering lands; JSON dump for now.

    const panel = PathFindPanel.createOrShow(context.extensionUri);
    panel.renderGraph(graph);

    output.clear();
    output.appendLine(JSON.stringify(graph, null, 2));
    output.show(true);
  }));
}

export function deactivate() {}
