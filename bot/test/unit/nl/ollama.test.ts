// PLAN.md 7.18 (Track Y): the Ollama provider against recorded request / response shapes (no network).
// The shapes follow the Ollama API documentation (POST /api/chat, stream false, format = JSON schema);
// unverified against a live server.
import { describe, expect, it } from 'vitest';
import { OllamaProvider, ollamaChatRequest, parseOllamaChatResponse } from '../../../src/nl/ollama.ts';
import { NlProviderError, resolveNlConfig } from '../../../src/nl/provider.ts';
import { NlConfigSchema } from '../../../src/nl/provider.ts';

/** A non-streaming /api/chat response as documented (values made up). */
const RESPONSE = {
  model: 'qwen2.5:7b',
  created_at: '2026-10-29T12:00:00.000000Z',
  message: { role: 'assistant', content: '{"steps":[{"command":"goto","waypoint":"home"},{"command":"guard","mode":"on"}]}' },
  done_reason: 'stop',
  done: true,
  total_duration: 2_812_000_000,
  load_duration: 21_000_000,
  prompt_eval_count: 1450,
  prompt_eval_duration: 1_900_000_000,
  eval_count: 31,
  eval_duration: 880_000_000,
};

const REQ = { system: 'sys', user: 'request from Steve: walk home', schema: { type: 'object' } };

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  const f = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: url instanceof Request ? url.url : url.toString(), ...(init ? { init } : {}) });
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return f;
}

const failing = (e: Error): typeof fetch => (() => Promise.reject(e));

describe('ollama provider', () => {
  it('builds the documented request body', () => {
    expect(ollamaChatRequest('qwen2.5:7b', REQ)).toEqual({
      model: 'qwen2.5:7b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'request from Steve: walk home' },
      ],
      stream: false,
      format: { type: 'object' },
      options: { temperature: 0 },
      keep_alive: '30m',
    });
  });

  it('reads message.content of a response', () => {
    expect(parseOllamaChatResponse(RESPONSE)).toBe(RESPONSE.message.content);
  });

  it('reports error bodies and odd responses', () => {
    expect(() => parseOllamaChatResponse({ error: 'model "qwen2.5:7b" not found, try pulling it first' }, 404)).toThrow('ollama: model "qwen2.5:7b" not found, try pulling it first');
    expect(() => parseOllamaChatResponse({}, 500)).toThrow('ollama: HTTP 500');
    expect(() => parseOllamaChatResponse({ message: {} })).toThrow(NlProviderError);
    expect(() => parseOllamaChatResponse({ ...RESPONSE, done: false })).toThrow(/not done/);
    expect(() => parseOllamaChatResponse({ ...RESPONSE, done_reason: 'length' })).toThrow(/cut off/);
    expect(() => parseOllamaChatResponse('x')).toThrow(/unexpected/);
  });

  it('posts to <url>/api/chat and returns the content', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const p = new OllamaProvider({ url: 'http://127.0.0.1:11434/', model: 'qwen2.5:7b', timeoutMs: 5000, fetch: fakeFetch(200, RESPONSE, seen) });
    expect(await p.complete(REQ)).toBe(RESPONSE.message.content);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(seen[0]!.init?.method).toBe('POST');
    expect(JSON.parse(seen[0]!.init?.body as string)).toMatchObject({ model: 'qwen2.5:7b', stream: false, format: { type: 'object' } });
    expect(p.label).toBe('ollama qwen2.5:7b');
  });

  it('turns transport failures into one-line errors', async () => {
    const refused = failing(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') }));
    await expect(new OllamaProvider({ url: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 5000, fetch: refused }).complete(REQ)).rejects.toThrow(
      'ollama: cannot reach http://127.0.0.1:11434: connect ECONNREFUSED 127.0.0.1:11434',
    );
    const slow = failing(new DOMException('signal timed out', 'TimeoutError'));
    await expect(new OllamaProvider({ url: 'http://x', model: 'm', timeoutMs: 1234, fetch: slow }).complete(REQ)).rejects.toThrow('ollama: no answer within 1234 ms');
    await expect(new OllamaProvider({ url: 'http://x', model: 'm', timeoutMs: 1000, fetch: fakeFetch(502, 'Bad Gateway') }).complete(REQ)).rejects.toThrow('ollama: HTTP 502, body is not JSON');
  });

  it('config block defaults and bounds', () => {
    expect(resolveNlConfig(undefined)).toEqual({ provider: 'none', url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', timeoutMs: 60_000 });
    expect(resolveNlConfig({ provider: 'ollama', model: 'llama3.1:8b' })).toMatchObject({ provider: 'ollama', model: 'llama3.1:8b' });
    expect(NlConfigSchema.safeParse({ provider: 'openai' }).success).toBe(false);
    expect(NlConfigSchema.safeParse({ url: 'ftp://x' }).success).toBe(false);
    expect(NlConfigSchema.safeParse({ timeoutMs: 10 }).success).toBe(false);
    expect(NlConfigSchema.safeParse({ provider: 'ollama', url: 'http://192.168.1.20:11434', timeoutMs: 90000 }).success).toBe(true);
  });
});
