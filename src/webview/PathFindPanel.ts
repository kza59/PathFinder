import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { expandCallers } from '../graphBuilder';
import type { BreakpointCounts, CallerExpansionPreview, CallValues, DebugPath, GraphData, GraphMessage, HotCounts, NodeClickedMessage, SessionHistoryMessage } from '../types';
import { callerExpansionPreview } from './callerPreview';

export class PathFindPanel implements vscode.Disposable {
  public static currentPanel: PathFindPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly nodeClicked = new vscode.EventEmitter<NodeClickedMessage>();
  public readonly onDidClickNode = this.nodeClicked.event;
  private graph: GraphData | undefined;
  private debugPath: DebugPath = [];
  private crashed = false; // the current path is how the program reached an exception
  // --- hot-path counting ---
  private static readonly graphRendered = new vscode.EventEmitter<PathFindPanel>();
  /** Fires after any panel renders a new graph, so hot counts can be re-mapped onto its nodes. */
  public static readonly onDidRenderGraph = PathFindPanel.graphRendered.event;
  private hotCounts: HotCounts = {};
  // --- end hot-path counting ---
  private callValues: CallValues = {}; // call values feature
  private breakpoints: BreakpointCounts = {}; // breakpoint markers
  private sessionHistory: SessionHistoryMessage | undefined; // session history
  private ready = false;
  private disposed = false;
  private expanding = false;
  private callerExpansions = new Map<string, Promise<GraphData>>();
  private callerPreviews = new Map<string, CallerExpansionPreview>();

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
            this.sendCallerPreviews();
          }
          this.sendDebugState();
          // --- hot-path counting ---
          if (Object.keys(this.hotCounts).length) {
            this.send({ type: 'hotCounts', counts: this.hotCounts });
          }
          // --- end hot-path counting ---
          // --- call values feature ---
          if (Object.keys(this.callValues).length) {
            this.send({ type: 'callValues', values: this.callValues });
          }
          // --- end call values feature ---
          // --- breakpoint markers ---
          if (Object.keys(this.breakpoints).length) {
            this.send({ type: 'breakpoints', counts: this.breakpoints });
          }
          // --- end breakpoint markers ---
          // --- session history ---
          if (this.sessionHistory) {
            this.send(this.sessionHistory);
          }
          // --- end session history ---
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
        } else if (message.type === 'expandCallers' && 'id' in message && typeof message.id === 'string') {
          void this.expandNodeCallers(message.id);
        } else if (message.type === 'previewCallers' && 'id' in message && typeof message.id === 'string') {
          if (this.graph && this.callerPreviews.get(message.id)?.state === 'error') {
            void this.previewNodeCallers(message.id, this.graph, this.callerExpansions);
          }
        // --- copy path feature ---
        } else if (message.type === 'copyPath' && 'text' in message && typeof message.text === 'string' && message.text) {
          const text = message.text;
          void vscode.env.clipboard.writeText(text).then(
            () => vscode.window.showInformationMessage('Path copied to clipboard'),
            error => vscode.window.showErrorMessage(`PathFind: could not copy path (${error instanceof Error ? error.message : String(error)})`),
          );
        // --- end copy path feature ---
        }
      }),
    );
    panel.webview.html = this.html(extensionUri);
  }

  public renderGraph(graph: GraphData): void {
    if (this.disposed) return;
    this.graph = graph;
    // Each preview is tied to this exact render, including re-renders of the same graph object.
    this.callerExpansions = new Map();
    this.callerPreviews = new Map(graph.nodes
      .filter(node => typeof node.hiddenCallers === 'number' && Number.isSafeInteger(node.hiddenCallers) && node.hiddenCallers > 0)
      .map(node => [node.id, { state: 'loading' }]));
    this.send({ type: 'graph', graph });
    this.sendCallerPreviews();
    PathFindPanel.graphRendered.fire(this); // hot-path counting
    void this.prepareCallerPreviews(graph, this.callerExpansions);
  }

  private sendCallerPreviews(): void {
    this.send({ type: 'callerPreviews', previews: Object.fromEntries(this.callerPreviews) });
  }

  private isCurrentPreview(graph: GraphData, cache: Map<string, Promise<GraphData>>): boolean {
    return !this.disposed && this.graph === graph && this.callerExpansions === cache;
  }

  private async prepareCallerPreviews(graph: GraphData, cache: Map<string, Promise<GraphData>>): Promise<void> {
    // Preview one marker at a time to avoid flooding the language server for wide graphs.
    for (const id of this.callerPreviews.keys()) {
      if (!this.isCurrentPreview(graph, cache)) return;
      await this.previewNodeCallers(id, graph, cache);
    }
  }

  private async previewNodeCallers(id: string, graph: GraphData, cache: Map<string, Promise<GraphData>>): Promise<void> {
    if (!this.isCurrentPreview(graph, cache)) return;
    if (this.callerPreviews.get(id)?.state !== 'loading') {
      this.callerPreviews.set(id, { state: 'loading' });
      this.sendCallerPreviews();
    }
    try {
      let expansion = cache.get(id);
      if (!expansion) {
        expansion = expandCallers(graph, id);
        cache.set(id, expansion);
      }
      const expanded = await expansion;
      if (this.isCurrentPreview(graph, cache)) {
        this.callerPreviews.set(id, callerExpansionPreview(graph, expanded));
        this.sendCallerPreviews();
      }
    } catch {
      cache.delete(id);
      if (this.isCurrentPreview(graph, cache)) {
        this.callerPreviews.set(id, { state: 'error' });
        this.sendCallerPreviews();
      }
    }
  }

  private async expandNodeCallers(id: string): Promise<void> {
    const graph = this.graph;
    const count = graph?.nodes.find(node => node.id === id)?.hiddenCallers;
    const cache = this.callerExpansions;
    const expansion = cache.get(id);
    if (this.disposed || this.expanding || !graph || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      return;
    }
    if (!expansion || this.callerPreviews.get(id)?.state !== 'ready') return;
    this.expanding = true;
    try {
      const expanded = await expansion;
      // A different PathFind request or a closed panel must not receive this late result.
      if (this.isCurrentPreview(graph, cache)) {
        this.renderGraph(expanded);
      }
    } catch (error) {
      if (this.isCurrentPreview(graph, cache)) {
        void vscode.window.showErrorMessage(`PathFind: could not expand callers (${error instanceof Error ? error.message : String(error)})`);
      }
    } finally {
      this.expanding = false;
    }
  }

  // --- hot-path counting ---
  public setHotCounts(counts: HotCounts): void {
    this.hotCounts = { ...counts };
    this.send({ type: 'hotCounts', counts: this.hotCounts });
  }
  // --- end hot-path counting ---

  // --- call values feature ---
  public setCallValues(values: CallValues): void {
    this.callValues = { ...values };
    this.send({ type: 'callValues', values: this.callValues });
  }
  // --- end call values feature ---

  // --- breakpoint markers ---
  public setBreakpoints(counts: BreakpointCounts): void {
    this.breakpoints = { ...counts };
    this.send({ type: 'breakpoints', counts: this.breakpoints });
  }
  // --- end breakpoint markers ---

  // --- session history ---
  public setSessionHistory(message: SessionHistoryMessage): void {
    this.sessionHistory = message;
    this.send(message);
  }
  // --- end session history ---

  public get currentGraph(): GraphData | undefined {
    return this.graph;
  }

  public highlightPath(path: DebugPath): void {
    this.debugPath = [...path];
    this.sendDebugState();
  }

  public clearDebugPath(): void {
    this.debugPath = [];
    this.crashed = false;
    this.sendDebugState();
  }

  // --- crash path ---
  /** Marks the highlighted path as the route to an exception (or not), e.g. so it can be drawn in red. */
  public setCrashed(crashed: boolean): void {
    if (this.crashed !== crashed) {
      this.crashed = crashed;
      this.sendDebugState();
    }
  }

  public get currentDebugPath(): DebugPath {
    return [...this.debugPath];
  }

  public get isCrashed(): boolean {
    return this.crashed;
  }
  // --- end crash path ---

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.callerExpansions.clear();
    this.callerPreviews.clear();
    if (PathFindPanel.currentPanel === this) {
      PathFindPanel.currentPanel = undefined;
    }
    this.panel.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
  }

  private sendDebugState(): void {
    this.send(this.debugPath.length
      ? { type: 'debugPath', path: this.debugPath, ...(this.crashed ? { crashed: true } : {}) }
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
  <!-- breakpoint markers: img-src data: lets Cytoscape draw the breakpoint dot (an inline SVG background image) -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src data:;">
  <link rel="stylesheet" href="${css}">
  <title>PathFind</title>
</head>
<body>
  <header>
    <div><strong>PathFind</strong><span class="hint">Caller → callee · Longest paths to target · Hover to trace connections</span></div>
    <div class="graph-controls">
      <form id="search-form" role="search" aria-label="Find a function in the graph">
        <input id="search-input" type="search" placeholder="Find function" aria-label="Find function" aria-describedby="search-status" autocomplete="off" spellcheck="false">
        <span id="search-count" hidden></span>
        <button id="search-submit" type="submit" title="Search / next match (Enter)">Search</button>
        <button id="search-previous" class="search-arrow" type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled>&#8593;</button>
        <button id="search-next" class="search-arrow" type="button" aria-label="Next match" title="Next match (Enter)" disabled>&#8595;</button>
      </form>
      <label class="noise-toggle"><input id="show-noise" type="checkbox"> Show Noise</label>
      <select id="layout-mode" aria-label="Graph layout">
        <option value="trace">Trace</option>
        <option value="explore">Explore</option>
      </select>
      <button id="fit" type="button">Fit graph</button>
      <button id="where-to-break" type="button" title="No visible chokepoints in this graph" disabled>Where to break</button>
    </div>
  </header>
  <main>
    <div id="graph" role="img" aria-label="Directed function call graph"></div>
    <div id="truncation-markers" hidden></div>
    <div id="recursion-outlines" aria-hidden="true" hidden></div>
    <div id="layout-labels" aria-hidden="true"></div>
    <p id="empty">Waiting for graph data…</p>
    <!-- --- legend feature --- swatch colors are filled in from graphStyles() by media/graph.ts -->
    <details id="legend">
      <summary>Legend</summary>
      <ul>
        <li><span class="swatch node" aria-hidden="true"></span>Function</li>
        <li><span class="swatch node target" aria-hidden="true"></span>Selected target</li>
        <li><span class="swatch chokepoint" aria-hidden="true">&#9671;</span>Chokepoint / breakpoint suggestion</li>
        <li><span class="swatch node path" aria-hidden="true"></span>On current call path</li>
        <li><span class="swatch node current" aria-hidden="true"></span>You are here</li>
        <li><span class="swatch node dimmed" aria-hidden="true"></span>Not on current path</li>
        <!-- --- breakpoint markers --- -->
        <li><span class="swatch node breakpoint" aria-hidden="true"></span>Has a breakpoint</li>
        <!-- --- end breakpoint markers --- -->
        <li><span class="swatch edge" aria-hidden="true"></span>Calls (caller → callee)</li>
        <li id="recursion-group-legend" hidden><span class="swatch recursion-group" aria-hidden="true"></span>Shared outline: recursion group</li>
        <li id="recursive-edge-legend" hidden><span class="swatch edge recursive" aria-hidden="true"></span>Recursive call (dashed)</li>
        <li><span class="swatch edge incoming" aria-hidden="true"></span>Calls hovered function</li>
        <li><span class="swatch edge outgoing" aria-hidden="true"></span>Called by hovered function</li>
      </ul>
      <!-- --- heatmap feature --- -->
      <div id="heat-legend" hidden>
        <strong>Calls this session</strong>
        <div id="heat-scale" role="img"></div>
        <div class="heat-range"><span id="heat-low"></span><span id="heat-high"></span></div>
        <p id="heat-note"></p>
        <p>Normal fill: no recorded calls. Existing dimming still applies.</p>
      </div>
      <!-- --- end heatmap feature --- -->
    </details>
    <!-- --- end legend feature --- -->
  </main>
  <footer>
    <span id="search-status" role="status" aria-live="polite">Enter a function name</span>
    <!-- --- breadcrumb feature --- -->
    <nav id="breadcrumb" aria-label="Current call path" hidden></nav>
    <!-- --- end breadcrumb feature --- -->
    <!-- --- copy path feature --- enabled by media/graph.ts while the breadcrumb shows a path -->
    <button id="copy-path" type="button" title="Copy the current call path as text" disabled>Copy path</button>
    <!-- --- end copy path feature --- -->
    <!-- --- replay feature --- enabled by media/graph.ts while the breadcrumb shows a path -->
    <button id="replay-path" type="button" title="Replay the call path, outer caller to current function" disabled>Replay</button>
    <!-- --- end replay feature --- -->
    <!-- --- session history --- shown by media/graph.ts once a debug session has been recorded -->
    <div id="history" role="group" aria-label="Debug session history" hidden>
      <button id="history-prev" type="button" title="Previous pause" aria-label="Previous pause" disabled>◀</button>
      <input id="history-slider" type="range" min="0" max="0" step="1" value="0" aria-label="Pause in the recorded session" disabled>
      <button id="history-next" type="button" title="Next pause" aria-label="Next pause" disabled>▶</button>
      <span id="history-label" role="status" aria-live="polite"></span>
    </div>
    <!-- --- end session history --- -->
    <span id="runtime" role="status" aria-live="polite">No runtime path</span>
    <span id="recursion-banner" role="status" aria-live="polite" hidden></span>
    <span id="selection">Click a function to see its source location</span>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
