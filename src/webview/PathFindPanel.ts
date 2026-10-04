import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { DebugPath, GraphData, GraphMessage, HotCounts, NodeClickedMessage } from '../types';

export class PathFindPanel implements vscode.Disposable {
  public static currentPanel: PathFindPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly nodeClicked = new vscode.EventEmitter<NodeClickedMessage>();
  public readonly onDidClickNode = this.nodeClicked.event;
  private graph: GraphData | undefined;
  private debugPath: DebugPath = [];
  // --- hot-path counting ---
  private static readonly graphRendered = new vscode.EventEmitter<PathFindPanel>();
  /** Fires after any panel renders a new graph, so hot counts can be re-mapped onto its nodes. */
  public static readonly onDidRenderGraph = PathFindPanel.graphRendered.event;
  private hotCounts: HotCounts = {};
  // --- end hot-path counting ---
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
          // --- hot-path counting ---
          if (Object.keys(this.hotCounts).length) {
            this.send({ type: 'hotCounts', counts: this.hotCounts });
          }
          // --- end hot-path counting ---
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
    PathFindPanel.graphRendered.fire(this); // hot-path counting
  }

  // --- hot-path counting ---
  public setHotCounts(counts: HotCounts): void {
    this.hotCounts = { ...counts };
    this.send({ type: 'hotCounts', counts: this.hotCounts });
  }
  // --- end hot-path counting ---

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
    <div><strong>PathFind</strong><span class="hint">Caller → callee · Longest paths to target · Hover to trace connections</span></div>
    <button id="fit" type="button">Fit graph</button>
  </header>
  <main>
    <div id="graph" role="img" aria-label="Directed function call graph"></div>
    <div id="layout-labels" aria-hidden="true"></div>
    <p id="empty">Waiting for graph data…</p>
    <!-- --- legend feature --- swatch colors are filled in from graphStyles() by media/graph.ts -->
    <details id="legend">
      <summary>Legend</summary>
      <ul>
        <li><span class="swatch node" aria-hidden="true"></span>Function</li>
        <li><span class="swatch node target" aria-hidden="true"></span>Selected target</li>
        <li><span class="swatch node path" aria-hidden="true"></span>On current call path</li>
        <li><span class="swatch node current" aria-hidden="true"></span>You are here</li>
        <li><span class="swatch node dimmed" aria-hidden="true"></span>Not on current path</li>
        <li><span class="swatch edge" aria-hidden="true"></span>Calls (caller → callee)</li>
        <li><span class="swatch edge incoming" aria-hidden="true"></span>Calls hovered function</li>
        <li><span class="swatch edge outgoing" aria-hidden="true"></span>Called by hovered function</li>
      </ul>
    </details>
    <!-- --- end legend feature --- -->
  </main>
  <footer>
    <!-- --- breadcrumb feature --- -->
    <nav id="breadcrumb" aria-label="Current call path" hidden></nav>
    <!-- --- end breadcrumb feature --- -->
    <span id="runtime" role="status" aria-live="polite">No runtime path</span>
    <span id="selection">Click a function to see its source location</span>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
