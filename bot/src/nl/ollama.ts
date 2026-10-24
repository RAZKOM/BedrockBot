// Ollama provider (PLAN.md 7.18, Track Y; docs/natural-language.md "Ollama request and response").
//
// One non-streaming POST <url>/api/chat with `format` set to the plan's JSON schema (structured
// outputs: the server constrains the sampling to the schema) and temperature 0:
//
//   request  { model, messages: [{ role: 'system', content }, { role: 'user', content }],
//              stream: false, format: <JSON schema>, options: { temperature: 0 }, keep_alive: '30m' }
//   response { model, created_at, message: { role: 'assistant', content: '<JSON text>' },
//              done: true, done_reason: 'stop', total_duration, load_duration, prompt_eval_count,
//              prompt_eval_duration, eval_count, eval_duration }
//   error    HTTP 4xx/5xx with { error: 'model "x" not found, try pulling it first' }
//
// The shapes come from the Ollama API documentation (docs/api.md, "Generate a chat completion" and
// "Structured outputs"); they are unverified against a live server here (no Ollama on the dev machine).
import type { CompletionRequest, NlProvider } from './provider.ts';
import { NlProviderError } from './provider.ts';

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs: number;
  /** Tests: a fetch stand-in. Default: the global fetch. */
  fetch?: typeof fetch;
}

export interface OllamaChatRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream: false;
  format: Record<string, unknown>;
  options: { temperature: number };
  keep_alive: string;
}

/** The request body for one completion. */
export function ollamaChatRequest(model: string, r: CompletionRequest): OllamaChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.user },
    ],
    stream: false,
    format: r.schema,
    options: { temperature: 0 },
    keep_alive: '30m',
  };
}

/**
 * The answer text of an /api/chat response body (parsed JSON), or an NlProviderError. Accepts the
 * non-streaming shape; an `error` field (Ollama's error body) is reported as is.
 */
export function parseOllamaChatResponse(body: unknown, httpStatus = 200): string {
  if (typeof body !== 'object' || body === null) throw new NlProviderError(`ollama: unexpected response (${httpStatus})`);
  const b = body as { error?: unknown; message?: { content?: unknown }; done?: unknown; done_reason?: unknown };
  if (typeof b.error === 'string') throw new NlProviderError(`ollama: ${b.error}`);
  if (httpStatus < 200 || httpStatus >= 300) throw new NlProviderError(`ollama: HTTP ${httpStatus}`);
  const content = b.message?.content;
  if (typeof content !== 'string') throw new NlProviderError('ollama: response has no message.content');
  if (b.done === false) throw new NlProviderError('ollama: response not done (streaming answer?)');
  if (b.done_reason === 'length') throw new NlProviderError('ollama: answer cut off (done_reason length)');
  return content;
}

export class OllamaProvider implements NlProvider {
  readonly label: string;
  private readonly opts: OllamaOptions;

  constructor(opts: OllamaOptions) {
    this.opts = opts;
    this.label = `ollama ${opts.model}`;
  }

  async complete(r: CompletionRequest): Promise<string> {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.url.replace(/\/+$/, '')}/api/chat`;
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ollamaChatRequest(this.opts.model, r)),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new NlProviderError(`ollama: no answer within ${this.opts.timeoutMs} ms`);
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
      throw new NlProviderError(`ollama: cannot reach ${this.opts.url}${cause}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NlProviderError(`ollama: HTTP ${res.status}, body is not JSON`);
    }
    return parseOllamaChatResponse(body, res.status);
  }
}
