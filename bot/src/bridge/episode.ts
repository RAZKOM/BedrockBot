// Episode bookkeeping and reward signals (PLAN.md section 9 "Reward" and "Episode").
//
// logs_delta counts natural logs entering the inventory, from inventory deltas only, against a
// high-water mark: a log that leaves the inventory (dropped, despawned) and is picked up again does
// not pay twice. The episode terminates on `targetLogs` collected or a death and is truncated after
// `maxSteps` decision steps or `maxTicks` ticks, whichever comes first.

export interface EpisodeLimits {
  maxSteps: number;
  maxTicks: number;
  targetLogs: number;
}

export const DEFAULT_LIMITS: Readonly<EpisodeLimits> = Object.freeze({ maxSteps: 200, maxTicks: 2400, targetLogs: 16 });

export type EndReason = 'logs' | 'died' | 'steps' | 'ticks';

export interface StepOutcome {
  logsDelta: number;
  ticksUsed: number;
  died: boolean;
  done: boolean;
  terminated: boolean;
  truncated: boolean;
  reason: EndReason | undefined;
}

export class Episode {
  readonly limits: EpisodeLimits;
  steps = 0;
  startTick = 0n;
  lastTick = 0n;
  /** Logs in the inventory at the reset. */
  baseline = 0;
  /** Highest log count seen this episode. */
  best = 0;
  done = false;
  reason: EndReason | undefined;
  active = false;
  corrections = 0;

  constructor(limits: Partial<EpisodeLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  start(tick: bigint, logs: number): void {
    this.steps = 0;
    this.startTick = tick;
    this.lastTick = tick;
    this.baseline = logs;
    this.best = logs;
    this.done = false;
    this.reason = undefined;
    this.active = true;
    this.corrections = 0;
  }

  /** Logs collected so far (high-water mark minus the reset baseline). */
  get logs(): number {
    return this.best - this.baseline;
  }

  get ticks(): number {
    return Number(this.lastTick - this.startTick);
  }

  /** Record one finished decision step. */
  step(tick: bigint, logsNow: number, died: boolean): StepOutcome {
    if (!this.active) throw new Error('no episode: reset first');
    if (this.done) throw new Error('episode is done: reset first');
    const ticksUsed = Math.max(0, Number(tick - this.lastTick));
    this.lastTick = tick;
    this.steps++;
    let logsDelta = 0;
    if (logsNow > this.best) {
      logsDelta = logsNow - this.best;
      this.best = logsNow;
    }
    let reason: EndReason | undefined;
    if (died) reason = 'died';
    else if (this.logs >= this.limits.targetLogs) reason = 'logs';
    else if (this.steps >= this.limits.maxSteps) reason = 'steps';
    else if (this.ticks >= this.limits.maxTicks) reason = 'ticks';
    const terminated = reason === 'died' || reason === 'logs';
    const truncated = reason === 'steps' || reason === 'ticks';
    this.done = terminated || truncated;
    this.reason = reason;
    return { logsDelta, ticksUsed, died, done: this.done, terminated, truncated, reason };
  }
}
