// LAN control panel (Track AE): the last log lines for the page. The loggers (log.ts) write one line
// per call with console.error, so the ring wraps console.error instead of changing every logger: each
// complete line is kept (the newest `capacity`), partial writes are joined. Lines are redacted before
// they are stored: the panel never shows a token or a sign-in code.
import { format } from 'node:util';

export interface ConsoleLike {
  error: (...args: unknown[]) => void;
}

/** Hide anything credential-like: bearer / token values and Microsoft device codes. */
export function redact(line: string): string {
  return line
    .replace(/(bearer\s+)\S+/gi, '$1***')
    .replace(/(token["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, '$1***')
    .replace(/(enter the code\s+)[A-Z0-9-]{4,}/gi, '$1***')
    .replace(/(user_code["']?\s*[=:]\s*["']?)[^\s"',]+/gi, '$1***');
}

export class LogRing {
  readonly capacity: number;
  private readonly lines: string[] = [];
  private partial = '';
  private untap: (() => void) | undefined;
  /** Lines seen so far (also counts dropped ones). */
  total = 0;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  push(text: string): void {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop() ?? '';
    if (this.partial.length > 4096) {
      parts.push(this.partial);
      this.partial = '';
    }
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      this.lines.push(redact(line));
      this.total++;
    }
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** The newest `n` lines, oldest first. */
  tail(n = 50): string[] {
    return this.lines.slice(-n);
  }

  /** Copy every `target.error(...)` line (default console.error, what log.ts writes) into the ring; idempotent. */
  tap(target: ConsoleLike = console): () => void {
    if (this.untap) return this.untap;
    const orig = target.error;
    target.error = (...args: unknown[]): void => {
      try {
        this.push(`${format(...args)}\n`);
      } catch {
        // never break the real write
      }
      orig.apply(target, args);
    };
    this.untap = () => {
      target.error = orig;
      this.untap = undefined;
    };
    return this.untap;
  }

  stop(): void {
    this.untap?.();
  }
}
