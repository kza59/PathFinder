import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { DebugPath, GraphData, GraphMessage, NodeClickedMessage } from '../types';

export class PathFindPanel implements vscode.Disposable {
  public static currentPanel: PathFindPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly nodeClicked = new vscode.EventEmitter<NodeClickedMessage>();
  public readonly onDidClickNode = this.nodeClicked.event;
  private graph: GraphData | undefined;
  private debugPath: DebugPath = [];
  private ready = false;
  private disposed = false;

  public static createOrShow(extensionUri: vscode.Uri): PathFindPanel {
    if (PathFindPanel.currentPanel) {
      PathFindPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return PathFindPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'pathfind.graph',
      'PathFind',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
        ],
      },
    );
    PathFindPanel.currentPanel = new PathFindPanel(panel, extensionUri);
    return PathFindPanel.currentPanel;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      this.nodeClicked,
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) {
          return;
        }
        if (message.type === 'ready') {
          this.ready = true;
          if (this.graph) {
            this.send({ type: 'graph', graph: this.graph });
          }
          this.sendDebugState();
        } else if (
          message.type === 'nodeClicked' &&
          'id' in message && typeof message.id === 'string' &&
          'file' in message && typeof message.file === 'string' &&
          'line' in message && typeof message.line === 'number' &&
          Number.isInteger(message.line) && message.line >= 1
        ) {
          this.nodeClicked.fire({
            type: 'nodeClicked', id: message.id, file: message.file, line: message.line,
          });
        }
      }),
    );
    panel.webview.html = this.html(extensionUri);
  }

  public renderGraph(graph: GraphData): void {
    this.graph = graph;
    this.send({ type: 'graph', graph });
  }

  public get currentGraph(): GraphData | undefined {
    return this.graph;
  }

  public highlightPath(path: DebugPath): void {
    this.debugPath = [...path];
    this.sendDebugState();
  }

  public clearDebugPath(): void {
    this.debugPath = [];
    this.sendDebugState();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (PathFindPanel.currentPanel === this) {
      PathFindPanel.currentPanel = undefined;
    }
    this.panel.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
  }

  private sendDebugState(): void {
    this.send(this.debugPath.length
      ? { type: 'debugPath', path: this.debugPath }
      : { type: 'debugClear' });
  }

  private send(message: GraphMessage): void {
    if (this.ready && !this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'graph.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.css'));
    const nonce = randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${css}">
  <title>PathFind</title>
</head>
<body>
  <header>
    <div><strong>PathFind</strong><span class="hint">Caller → callee</span></div>
    <button id="fit" type="button">Fit graph</button>
  </header>
  <main>
    <div id="graph" role="img" aria-label="Directed function call graph"></div>
    <p id="empty">Waiting for graph data…</p>
  </main>
  <footer>
    <span id="runtime" role="status" aria-live="polite">No runtime path</span>
    <span id="selection">Click a function to see its source location</span>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
