import * as vscode from 'vscode';
import { fileName } from '../webview/filePath';
import { mockDebugPath, mockGraph } from './mockdata';
import { PathFindPanel } from '../webview/PathFindPanel';

export function registerGraphRendererTestCommands(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PathFind Graph');
  const observedPanels = new WeakSet<PathFindPanel>();
  const getPanel = () => {
    const panel = PathFindPanel.createOrShow(context.extensionUri);
    if (!observedPanels.has(panel)) {
      observedPanels.add(panel);
      context.subscriptions.push(panel, panel.onDidClickNode(message => {
        output.appendLine(JSON.stringify(message));
      }));
    }
    return panel;
  };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('pathfind.testGraph', () => {
      const panel = getPanel();
      panel.clearDebugPath();
      panel.renderGraph(mockGraph);
    }),
    vscode.commands.registerCommand('pathfind.testWorkspaceGraph', () => {
      const panel = getPanel();
      panel.clearDebugPath();
      panel.renderGraph({
        nodes: mockGraph.nodes.map(node => ({
          ...node,
          file: vscode.Uri.joinPath(context.extensionUri, 'test1', fileName(node.file)).fsPath,
        })),
        edges: mockGraph.edges,
      });
    }),
    vscode.commands.registerCommand('pathfind.testDebugPath', () => {
      const existingPanel = PathFindPanel.currentPanel;
      const panel = getPanel();
      if (!existingPanel) {
        panel.renderGraph(mockGraph);
      }
      panel.highlightPath(mockDebugPath);
    }),
    vscode.commands.registerCommand('pathfind.clearDebugPath', () => {
      PathFindPanel.currentPanel?.clearDebugPath();
    }),
  );
}
