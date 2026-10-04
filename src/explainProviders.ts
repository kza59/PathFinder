// The AI providers "Explain Current Path" can use: Claude (Anthropic), ChatGPT (OpenAI) and Gemini (Google).
// No vscode import, so this can be exercised from plain Node.
import Anthropic from '@anthropic-ai/sdk';
import { ApiError as GeminiApiError, FinishReason, GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

export type ProviderId = 'claude' | 'openai' | 'gemini';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: string;   // overridable with the pathfinder.explain.model setting
  envVars: string[];      // used when no key has been saved in VS Code
  keyHint: string;        // where to get a key
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: 'claude', label: 'Claude (Anthropic)', defaultModel: 'claude-opus-5-5',
    envVars: ['ANTHROPIC_API_KEY'], keyHint: 'console.anthropic.com',
  },
  openai: {
    id: 'openai', label: 'ChatGPT (OpenAI)', defaultModel: 'gpt-6.1-sol',
    envVars: ['OPENAI_API_KEY'], keyHint: 'platform.openai.com',
  },
  gemini: {
    id: 'gemini', label: 'Gemini (Google)', defaultModel: 'gemini-3.8-flash',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyHint: 'aistudio.google.com',
  },
};

export interface StreamResult {
  refused: boolean;    // the provider declined to answer (safety filters)
  truncated: boolean;  // the answer hit the output limit
}

export type ExplainErrorKind = 'auth' | 'permission' | 'rateLimit' | 'unavailable' | 'connection' | 'other';

/** A provider failure, classified so the extension can react the same way whichever provider failed. */
export class ExplainError extends Error {
  constructor(readonly kind: ExplainErrorKind, message: string) {
    super(message);
  }
}

export interface StreamRequest {
  provider: ProviderId;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/**
 * Streams one explanation. Resolves with how it ended; rejects with an ExplainError on failure. A request cancelled
 * through `signal` resolves quietly (nothing more is streamed) instead of rejecting.
 */
export async function streamExplanation(request: StreamRequest): Promise<StreamResult> {
  try {
    switch (request.provider) {
      case 'claude': return await streamClaude(request);
      case 'openai': return await streamOpenAI(request);
      case 'gemini': return await streamGemini(request);
    }
  } catch (error) {
    if (request.signal.aborted) {
      return { refused: false, truncated: false };
    }
    throw classify(request.provider, error);
  }
}

async function streamClaude({ apiKey, model, system, user, signal, onText }: StreamRequest): Promise<StreamResult> {
  const client = new Anthropic({ apiKey });
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    output_config: { effort: 'medium' },
    // On a policy refusal the API re-runs the request on a fallback model instead of failing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: user }],
  }, { signal });
  stream.on('text', onText);
  const message = await stream.finalMessage();
  return { refused: message.stop_reason === 'refusal', truncated: message.stop_reason === 'max_tokens' };
}

async function streamOpenAI({ apiKey, model, system, user, signal, onText }: StreamRequest): Promise<StreamResult> {
  const client = new OpenAI({ apiKey });
  const stream = client.responses.stream({
    model,
    instructions: system,
    input: user,
    max_output_tokens: 16000,
  }, { signal });
  stream.on('response.output_text.delta', event => onText(event.delta));
  const response = await stream.finalResponse();
  const reason = response.incomplete_details?.reason;
  return { refused: reason === 'content_filter', truncated: reason === 'max_output_tokens' };
}

async function streamGemini({ apiKey, model, system, user, signal, onText }: StreamRequest): Promise<StreamResult> {
  // Unlike the Anthropic and OpenAI SDKs, this one doesn't retry by default. Gemini (especially the free tier) often
  // answers 503 "overloaded" at busy times, so retry timeouts, 429 and 5xx twice, 1 s then 2 s apart.
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4 } },
  });
  const stream = await client.models.generateContentStream({
    model,
    contents: user,
    config: { systemInstruction: system, abortSignal: signal },
  });
  let finish: FinishReason | undefined;
  let blocked = false;
  for await (const chunk of stream) {
    if (chunk.text) {
      onText(chunk.text);
    }
    finish = chunk.candidates?.[0]?.finishReason ?? finish;
    blocked ||= Boolean(chunk.promptFeedback?.blockReason);
  }
  const refusals: (FinishReason | undefined)[] = [
    FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST, FinishReason.SPII,
  ];
  return { refused: blocked || refusals.includes(finish), truncated: finish === FinishReason.MAX_TOKENS };
}

/** Maps each SDK's own error types onto the shared ExplainError kinds. */
function classify(provider: ProviderId, error: unknown): ExplainError {
  const name = PROVIDERS[provider].label;
  const text = error instanceof Error ? error.message : String(error);
  const status = provider === 'claude' && error instanceof Anthropic.APIError ? error.status
    : provider === 'openai' && error instanceof OpenAI.APIError ? error.status
      : provider === 'gemini' && error instanceof GeminiApiError ? error.status
        : undefined;

  if ((error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError)
      || (status === undefined && error instanceof TypeError)) { // fetch failures surface as TypeError
    return new ExplainError('connection', `couldn't reach ${name}. Check your internet connection.`);
  }
  // Gemini reports a bad key as 400 INVALID_ARGUMENT ("API key not valid"), not 401.
  if (status === 401 || (provider === 'gemini' && status === 400 && /api key/i.test(text))) {
    return new ExplainError('auth', `the ${name} API key was rejected.`);
  }
  if (status === 403) {
    return new ExplainError('permission', `this ${name} API key isn't allowed to use the model.`);
  }
  if (status === 404) {
    return new ExplainError('other', `${name} doesn't recognise the model. Check the "pathfinder.explain.model" setting.`);
  }
  if (status === 429) {
    return new ExplainError('rateLimit', `${name} is rate-limiting requests (or the account is out of credit); try again in a moment.`);
  }
  if (status !== undefined && status >= 500) {
    const lighter = provider === 'gemini' ? ' If it keeps happening, set "pathfinder.explain.model" to gemini-3.5-flash-lite, which is usually less busy.' : '';
    return new ExplainError('unavailable', `${name} is overloaded or temporarily unavailable (${status}); try again in a moment.${lighter}`);
  }
  return new ExplainError('other', `${name} returned an error${status ? ` (${status})` : ''}: ${text}`);
}
