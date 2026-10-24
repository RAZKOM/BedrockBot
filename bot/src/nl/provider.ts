// Natural-language front end (PLAN.md 7.18, Track Y; docs/natural-language.md): the model provider
// interface and the `nl` config block.
//
// A provider turns one request (system prompt, user text, JSON schema of the answer) into the model's
// raw answer text. It never sees the bot and never acts: the answer is parsed and validated against the
// plan schema (nl/plan.ts) and then checked against what the owner actually said (nl/executor.ts).
import { z } from 'zod';

export interface CompletionRequest {
  /** System prompt: rules, command reference, bot state, worked examples (nl/prompt.ts). */
  system: string;
  /** The owner's request as one user message. */
  user: string;
  /** JSON schema the answer must follow (z.toJSONSchema of the plan schema). */
  schema: Record<string, unknown>;
}

export interface NlProvider {
  /** Short label for logs and replies, e.g. `ollama qwen2.5:7b`. */
  readonly label: string;
  /** The model's answer text (JSON as a string). Rejects with NlProviderError on transport or model errors. */
  complete(request: CompletionRequest): Promise<string>;
}

export class NlProviderError extends Error {
  override name = 'NlProviderError';
}

export const DEFAULT_NL_URL = 'http://127.0.0.1:11434';
export const DEFAULT_NL_MODEL = 'qwen2.5:7b';
export const DEFAULT_NL_TIMEOUT_MS = 60_000;

/** The `nl` block of config.json (config/config.ts). Everything optional; defaults in resolveNlConfig. */
export const NlConfigSchema = z
  .object({
    /** `ollama` = ask the local Ollama server; `none` (default) = natural language off (`!do` says so). */
    provider: z.enum(['ollama', 'none']).optional(),
    /** Ollama base URL (default http://127.0.0.1:11434). */
    url: z.url({ protocol: /^https?$/ }).optional(),
    /** Model name as `ollama pull` knows it (default qwen2.5:7b). */
    model: z.string().min(1).max(200).optional(),
    /** One model call may take this long (default 60000 ms; the first call loads the model). */
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  })
  .strict();

export type NlConfigInput = z.infer<typeof NlConfigSchema>;

export interface NlConfig {
  provider: 'ollama' | 'none';
  url: string;
  model: string;
  timeoutMs: number;
}

export function resolveNlConfig(input: NlConfigInput | undefined): NlConfig {
  return {
    provider: input?.provider ?? 'none',
    url: input?.url ?? DEFAULT_NL_URL,
    model: input?.model ?? DEFAULT_NL_MODEL,
    timeoutMs: input?.timeoutMs ?? DEFAULT_NL_TIMEOUT_MS,
  };
}

/** Key in the task's CLI values (TaskContext.values) holding the resolved NlConfig (config/resolve.ts). */
export const NL_VALUE_KEY = '$nl';
/** Key in the task's CLI values holding an NlProvider instance (tests inject a FakeProvider here). */
export const NL_PROVIDER_KEY = '$nlProvider';

export function isNlProvider(v: unknown): v is NlProvider {
  return typeof v === 'object' && v !== null && typeof (v as { complete?: unknown }).complete === 'function';
}
