import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExplainError, PROVIDERS, ProviderId, streamExplanation } from './explainProviders';
import { findNodeForFrame } from './graphBuilder';
import type { GraphData } from './types';
import { PathFindPanel } from './webview/PathFindPanel';

/**
 * Optional AI explanation of the live call path: while the debugger is paused, sends the call stack (each function's
 * source, the line it is on, a few local variables) to Claude, ChatGPT or Gemini (see explainProviders.ts) and streams
 * back a plain-English explanation.
 *
 * Entirely opt-in. Nothing here runs, and no API client is created, until someone runs "PathFinder: Explain Current
 * Path"; without an API key that command only offers to set one. Keys live in VS Code's secret storage (or the
 * provider's usual environment variable), never in settings or the workspace.
 */

const secretKey = (provider: ProviderId) => `pathfinder.apiKey.${provider}`;
const LEGACY_CLAUDE_SECRET = 'pathfinder.anthropicApiKey'; // where the Claude-only version stored its key
const MAX_FRAMES = 12;          // deepest frames kept; deep recursion keeps the outermost two plus the innermost ten
const MAX_FUNCTION_LINES = 80;  // longer functions are cut to a window around the current line
const WINDOW_LINES = 15;        // lines either side of the current line when the function's bounds are unknown
const MAX_VARIABLES = 12;       // per frame
const MAX_VALUE_CHARS = 120;

const SYSTEM_PROMPT = `You explain what a paused program is doing, for a developer stepping through it in a debugger.
You receive the current call stack, from the outermost caller to the function where execution is paused. For each
frame you get the function's source with line numbers (the line it is currently on is marked with "->"), and some of
its local variables with their current values.

Explain in plain English how execution got here and what is happening right now: one short sentence per step of the
path, then one or two sentences on the paused function, using the variable values that explain its behaviour. Refer
to functions by name. Keep it under about 150 words. Do not restate the code line by line, and do not speculate
beyond what the code and values show; if something important is missing (frames or values were left out), say so
briefly.`;

/** What the panel (or anything else) can listen to, to show the explanation as it streams in. */
export type ExplanationEvent =
  | { kind: 'start' }
  | { kind: 'text'; text: string }        // the explanation so far
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

const events = new vscode.EventEmitter<ExplanationEvent>();
export const onExplanation = events.event;

// --- collecting the paused stack through the Debug Adapter Protocol ---

interface DapFrame {
  id: number;
  name: string;
  line: number;
  source?: { path?: string };
}
interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}
interface DapVariable {
  name: string;
  value: string;
  type?: string;
}

interface CollectedFrame {
  name: string;
  file: string;
  line: number;
  source: string;
  variables: string[];
}

/** The paused thread: the one selected in the Call Stack view, else the first one the debugger reports. */
async function pausedThreadId(session: vscode.DebugSession): Promise<number | undefined> {
  const item = (vscode.debug as { activeStackItem?: { session: vscode.DebugSession; threadId: number } }).activeStackItem;
  if (item && item.session.id === session.id) {
    return item.threadId;
  }
  const reply = await session.customRequest('threads');
  return reply?.threads?.[0]?.id;
}

/** Source of the function a frame is in, numbered, with the current line marked. */
function frameSource(file: string, line: number, graph: GraphData | undefined): string {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const node = graph && findNodeForFrame(graph, file, line);
  let start = node ? node.line : line - WINDOW_LINES;
  let end = node ? node.endLine : line + WINDOW_LINES;
  if (end - start + 1 > MAX_FUNCTION_LINES) {
    start = Math.max(start, line - MAX_FUNCTION_LINES / 2);
    end = Math.min(end, start + MAX_FUNCTION_LINES - 1);
  }
  start = Math.max(1, start);
  end = Math.min(lines.length, end);
  const width = String(end).length;
  return lines.slice(start - 1, end)
    .map((text, i) => `${start + i === line ? '->' : '  '} ${String(start + i).padStart(width)}  ${text}`)
    .join('\n');
}

/** A frame's local variables (arguments and locals, not globals), shortened. */
async function frameVariables(session: vscode.DebugSession, frameId: number): Promise<string[]> {
  const scopes: DapScope[] = (await session.customRequest('scopes', { frameId }))?.scopes ?? [];
  const local = scopes.filter(s => !s.expensive && /local|argument|param|register/i.test(s.name) && !/register/i.test(s.name));
  const chosen = local.length ? local : scopes.filter(s => !s.expensive && !/global/i.test(s.name)).slice(0, 1);
  const out: string[] = [];
  for (const scope of chosen) {
    const variables: DapVariable[] = (await session.customRequest('variables', { variablesReference: scope.variablesReference }))?.variables ?? [];
    for (const v of variables) {
      if (out.length >= MAX_VARIABLES || v.name.startsWith('__') || /^(special|function|class) variables$/i.test(v.name)) {
        continue;
      }
      const value = v.value.length > MAX_VALUE_CHARS ? `${v.value.slice(0, MAX_VALUE_CHARS)}…` : v.value;
      out.push(`${v.name}${v.type ? ` (${v.type})` : ''} = ${value}`);
    }
  }
  return out;
}

/** The paused call stack, outermost caller first, limited to frames with readable source files. */
async function collectStack(session: vscode.DebugSession, graph: GraphData | undefined): Promise<{ frames: CollectedFrame[]; omitted: number }> {
  const threadId = await pausedThreadId(session);
  if (threadId === undefined) {
    throw new Error('the debugger reports no threads');
  }
  const reply = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 500 });
  // Frames without a readable source file (system libraries, the language runtime) aren't explained.
  const all: DapFrame[] = (reply?.stackFrames ?? []).filter((f: DapFrame) => f.source?.path && fs.existsSync(f.source.path));
  const innermostFirst = all.length > MAX_FRAMES ? [...all.slice(0, MAX_FRAMES - 2), ...all.slice(-2)] : all;
  const frames: CollectedFrame[] = [];
  for (const frame of innermostFirst.reverse()) {
    const file = frame.source!.path!;
    frames.push({
      name: frame.name,
      file,
      line: frame.line,
      source: frameSource(file, frame.line, graph),
      variables: await frameVariables(session, frame.id).catch(() => []),
    });
  }
  return { frames, omitted: all.length - innermostFirst.length };
}

function describeStack(frames: CollectedFrame[], omitted: number): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const parts = frames.map((frame, i) => {
    const where = root && frame.file.startsWith(root) ? path.relative(root, frame.file) : frame.file;
    const role = i === frames.length - 1 ? 'paused here' : 'calls the next frame';
    return [
      `Frame ${i + 1} of ${frames.length} (${role}): ${frame.name} — ${where}:${frame.line}`,
      '```',
      frame.source,
      '```',
      frame.variables.length ? `Local variables:\n${frame.variables.map(v => `  ${v}`).join('\n')}` : 'Local variables: (none reported)',
    ].join('\n');
  });
  if (omitted > 0) {
    parts.splice(2, 0, `(${omitted} frames in the middle of the stack were left out to keep this short.)`);
  }
  return `Call stack, outermost caller first:\n\n${parts.join('\n\n')}`;
}

/** The exact text that would be sent for the current pause. Exported for tests: no API call is made. */
export async function explanationPrompt(session: vscode.DebugSession, graph: GraphData | undefined): Promise<string> {
  const { frames, omitted } = await collectStack(session, graph);
  return describeStack(frames, omitted);
}

// --- choosing a provider and its key ---

function settings() {
  const config = vscode.workspace.getConfiguration('pathfinder.explain');
  const provider = config.get<ProviderId>('provider', 'claude');
  const id: ProviderId = provider in PROVIDERS ? provider : 'claude';
  return { provider: id, model: config.get<string>('model', '').trim() || PROVIDERS[id].defaultModel };
}

async function apiKey(context: vscode.ExtensionContext, provider: ProviderId): Promise<string | undefined> {
  const saved = await context.secrets.get(secretKey(provider))
    ?? (provider === 'claude' ? await context.secrets.get(LEGACY_CLAUDE_SECRET) : undefined);
  return saved || PROVIDERS[provider].envVars.map(name => process.env[name]).find(Boolean) || undefined;
}

/** Asks which provider, then its key; saves the key and makes that provider the one explanations use. */
async function setApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const current = settings().provider;
  const picked = await vscode.window.showQuickPick(
    Object.values(PROVIDERS).map(p => ({ label: p.label, description: p.id === current ? 'current' : undefined, id: p.id })),
    { title: 'PathFinder: which AI should explain paths?', ignoreFocusOut: true },
  );
  if (!picked) {
    return false;
  }
  const info = PROVIDERS[picked.id];
  const key = await vscode.window.showInputBox({
    title: `PathFinder: ${info.label} API key`,
    prompt: `Get one at ${info.keyHint}. Used only for "Explain Current Path"; stored in VS Code's secret storage.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter a key, or press Escape to cancel',
  });
  if (!key) {
    return false;
  }
  await context.secrets.store(secretKey(info.id), key.trim());
  await vscode.workspace.getConfiguration('pathfinder.explain').update('provider', info.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`PathFinder: ${info.label} key saved; explanations will use ${info.label}.`);
  return true;
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const saved: ProviderId[] = [];
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    if (await context.secrets.get(secretKey(id)) || (id === 'claude' && await context.secrets.get(LEGACY_CLAUDE_SECRET))) {
      saved.push(id);
    }
  }
  if (!saved.length) {
    vscode.window.showInformationMessage('PathFinder: no API keys are saved.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    saved.map(id => ({ label: PROVIDERS[id].label, id })),
    { title: 'PathFinder: remove which API key?' },
  );
  if (picked) {
    await context.secrets.delete(secretKey(picked.id));
    if (picked.id === 'claude') {
      await context.secrets.delete(LEGACY_CLAUDE_SECRET);
    }
    vscode.window.showInformationMessage(`PathFinder: ${picked.label} key removed.`);
  }
}

// --- the command ---

export function registerExplainPath(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PathFinder Explain');
  let running: AbortController | undefined;

  const offerKey = async (message: string) => {
    const choice = await vscode.window.showInformationMessage(message, 'Set API key');
    if (choice === 'Set API key' && await setApiKey(context)) {
      void vscode.commands.executeCommand('pathfinder.explainPath');
    }
  };

  const explain = async () => {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      vscode.window.showInformationMessage('PathFinder: start debugging and pause somewhere, then explain the path.');
      return;
    }
    const { provider, model } = settings();
    const info = PROVIDERS[provider];
    const key = await apiKey(context, provider);
    if (!key) {
      await offerKey('PathFinder can explain the current call path with Claude, ChatGPT or Gemini. This is optional and '
        + 'needs an API key for one of them; everything else works without one.');
      return;
    }

    running?.abort();
    let stack: { frames: CollectedFrame[]; omitted: number };
    try {
      stack = await collectStack(session, PathFindPanel.currentPanel?.currentGraph);
    } catch (error) {
      vscode.window.showWarningMessage(`PathFinder: couldn't read the call stack. Is the program paused? (${error instanceof Error ? error.message : error})`);
      return;
    }
    if (!stack.frames.length) {
      vscode.window.showWarningMessage('PathFinder: no frames with source code to explain at this point.');
      return;
    }

    const controller = new AbortController();
    running = controller;
    output.clear();
    output.show(true);
    output.appendLine(`Explaining with ${info.label} (${model}): ${stack.frames.map(f => f.name).join(' → ')}\n`);
    events.fire({ kind: 'start' });

    let text = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `PathFinder: explaining path with ${info.label}…` },
      async () => {
        try {
          const result = await streamExplanation({
            provider, apiKey: key, model, system: SYSTEM_PROMPT, user: describeStack(stack.frames, stack.omitted),
            signal: controller.signal,
            onText: delta => {
              text += delta;
              output.append(delta);
              events.fire({ kind: 'text', text });
            },
          });
          if (controller.signal.aborted) {
            return; // replaced by a newer explanation, or the program moved on
          }
          if (result.refused) {
            const note = `\n\n(${info.label} declined to explain this path.)`;
            output.append(note);
            text += note;
          } else if (result.truncated) {
            output.append('\n\n(The explanation was cut off.)');
          }
          output.appendLine('');
          events.fire({ kind: 'done', text });
        } catch (error) {
          const message = error instanceof ExplainError ? error.message : String(error);
          output.appendLine(`\n\n${message}`);
          events.fire({ kind: 'error', message });
          if (error instanceof ExplainError && error.kind === 'auth') {
            await offerKey(`PathFinder: ${message} Set a new one?`);
          } else {
            vscode.window.showWarningMessage(`PathFinder: ${message}`);
          }
        } finally {
          if (running === controller) {
            running = undefined;
          }
        }
      },
    );
  };

  context.subscriptions.push(
    output,
    events,
    { dispose: () => running?.abort() },
    vscode.commands.registerCommand('pathfinder.explainPath', explain),
    vscode.commands.registerCommand('pathfinder.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('pathfinder.clearApiKey', () => clearApiKey(context)),
    // A new pause makes an explanation in progress out of date.
    vscode.debug.onDidChangeActiveStackItem?.(() => running?.abort()) ?? { dispose() {} },
  );
}
