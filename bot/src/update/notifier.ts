// In-bot update timer (PLAN.md task 5.3): runs the update check at start and then every N hours,
// logs the result, publishes it in the metrics (`updateCheck`), and whispers the owners once per new
// finding (`/tell <owner> ...`). Never changes a pin.
import type { Metrics } from '../connection/metrics.ts';
import { silentLogger, type Logger } from '../log.ts';
import { chatSummary, formatReport, runUpdateCheck, type UpdateReport } from './check.ts';

export interface UpdateNotifierOptions {
  intervalHours: number;
  /** First check this long after start (default 60 s, so it does not compete with the login). */
  firstDelayMs?: number;
  metrics?: Metrics;
  log?: Logger;
  /** Called with a one-line message when a newer version appears (e.g. whisper the owners). */
  notify?: (message: string) => void;
  /** The check itself (tests pass a fake). */
  check?: () => Promise<UpdateReport>;
}

export class UpdateNotifier {
  last: UpdateReport | undefined;
  lastError: string | undefined;
  runs = 0;
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private notified = '';
  private readonly o: UpdateNotifierOptions;
  private readonly log: Logger;

  constructor(opts: UpdateNotifierOptions) {
    this.o = opts;
    this.log = opts.log ?? silentLogger;
    opts.metrics?.provide(() => ({ updateCheck: this.summary() }));
  }

  start(): void {
    if (this.o.intervalHours <= 0) return;
    this.first = setTimeout(() => void this.runOnce(), this.o.firstDelayMs ?? 60_000);
    this.timer = setInterval(() => void this.runOnce(), this.o.intervalHours * 3_600_000);
    this.first.unref();
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  summary(): Record<string, unknown> | null {
    if (!this.last && !this.lastError) return null;
    return {
      checkedAt: this.last?.checkedAt ?? null,
      newer: (this.last?.newer ?? []).map((f) => `${f.what} ${f.pinned} -> ${f.latest ?? '?'}`),
      errors: this.last?.errors ?? [],
      lastError: this.lastError ?? null,
      runs: this.runs,
    };
  }

  async runOnce(): Promise<UpdateReport | undefined> {
    this.runs++;
    try {
      const r = await (this.o.check ?? (() => runUpdateCheck()))();
      this.last = r;
      this.lastError = undefined;
      this.o.metrics?.inc('update.checks');
      for (const line of formatReport(r)) {
        if (r.newer.length) this.log.warn(`update check: ${line}`);
        else this.log.info(`update check: ${line}`);
      }
      const msg = chatSummary(r);
      const key = r.newer.map((f) => `${f.what}=${f.latest}`).join(',');
      if (msg && key !== this.notified) {
        this.notified = key;
        this.o.metrics?.inc('update.notified');
        this.o.notify?.(msg);
      }
      return r;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.warn(`update check failed: ${this.lastError}`);
      return undefined;
    }
  }
}
