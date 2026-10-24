// A provider without a model (PLAN.md 7.18, Track Y): unit and e2e tests, and `nl-try.ts --fake`.
// Either a table of phrasing -> answer (first match wins; a string matches case-insensitively as a
// substring of the request text, a RegExp is tested against it) or a function of the request.
import type { CompletionRequest, NlProvider } from './provider.ts';
import { NlProviderError } from './provider.ts';

export type FakeAnswer = string | Record<string, unknown>;
export type FakeRule = readonly [match: string | RegExp, answer: FakeAnswer];

/** The owner's words in a user message built by nl/prompt.ts (`request from X: <text>`), else the whole message. */
export function requestText(user: string): string {
  const m = /^request from [^:]*: ([\s\S]*)$/.exec(user);
  return (m ? m[1]! : user).trim();
}

export class FakeProvider implements NlProvider {
  readonly label = 'fake';
  /** Every request seen (tests check the prompt). */
  readonly requests: CompletionRequest[] = [];
  private readonly answer: (r: CompletionRequest) => FakeAnswer | undefined;
  private readonly delayMs: number;

  constructor(rules: readonly FakeRule[] | ((r: CompletionRequest) => FakeAnswer | undefined), opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
    if (typeof rules === 'function') {
      this.answer = rules;
    } else {
      this.answer = (r) => {
        const text = requestText(r.user);
        for (const [m, a] of rules) {
          if (typeof m === 'string' ? text.toLowerCase().includes(m.toLowerCase()) : m.test(text)) return a;
        }
        return undefined;
      };
    }
  }

  async complete(r: CompletionRequest): Promise<string> {
    this.requests.push(r);
    if (this.delayMs > 0) await new Promise((res) => setTimeout(res, this.delayMs));
    const a = this.answer(r);
    if (a === undefined) throw new NlProviderError(`fake: no answer for "${requestText(r.user)}"`);
    return typeof a === 'string' ? a : JSON.stringify(a);
  }
}
