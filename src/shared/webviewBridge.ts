import * as vscode from 'vscode';

/**
 * PLACEHOLDER bridge between the extension host and the graph webview.
 * Whoever owns the webview calls setWebviewPanel(panel) after creating it;
 * anyone else calls postToWebview(msg) without needing a reference to the panel.
 */
let panel: vscode.WebviewPanel | undefined;

export function setWebviewPanel(p: vscode.WebviewPanel | undefined): void {
  panel = p;
}

export function postToWebview(message: unknown): void {
  // No panel open yet: silently drop the message.
  void panel?.webview.postMessage(message);
}
