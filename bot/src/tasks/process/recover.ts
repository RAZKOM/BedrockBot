// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the walk back to a death spot and the pick-up of the
// drops, as a user process (`recover`, priority 40): the flee, a guard fight and the night rule pre-empt it like any
// command; a resume plans the walk again from where the bot stands. It ends once the items within `radius` of the spot
// are picked up (or the collect's ticks run out), or when the walk fails. Started by the obtain job after a death with
// `deathReturn` on (chat/commands-kit.ts); the rules for going at all are skills/items/death-return.ts.
import type { Vec3 } from '../../connection/types.ts';
import type { Logger } from '../../log.ts';
import type { CollectOptions, CollectResult } from '../../skills/collect/collect.ts';
import type { NavGoal } from '../../skills/nav/goals.ts';
import type { GotoOptions, SkillResult } from '../../skills/types.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

/**
 * A job's own short work as a user process (the obtain job's table sweep: walk back to a table it left, pick it up):
 * `work` runs with a `cancelled` check; a pre-emption cancels the skill and a resume runs `work` again (it must be safe
 * to repeat: it does what is left). The result resolves once (undefined when stopped).
 */
export class WorkProcess<T> extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name: string;
  readonly result: Promise<T | undefined>;
  private resolve!: (r: T | undefined) => void;
  private readonly work: (cancelled: () => boolean) => Promise<T>;
  private readonly cancel: () => void;
  private readonly line: string;

  constructor(name: string, line: string, work: (cancelled: () => boolean) => Promise<T>, cancel: () => void) {
    super();
    this.name = name;
    this.line = line;
    this.work = work;
    this.cancel = cancel;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(t: number): void {
    void this.work(() => t !== this.token).then(
      (r) => {
        if (t !== this.token) return;
        this.finish();
        this.resolve(r);
      },
      () => {
        if (t !== this.token) return;
        this.finish();
        this.resolve(undefined);
      },
    );
  }

  protected halt(): void {
    this.cancel();
  }

  protected override onStopped(): void {
    this.resolve(undefined);
  }

  status(): ProcessStatus {
    return { line: this.line };
  }
}

export interface RecoverDeps {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  /** Cancel the running skill (a pause or a stop). */
  cancel(): void;
  log?: Logger;
}

export interface RecoverRequest {
  spot: Vec3;
  walkTicks: number;
  collectTicks: number;
  radius: number;
}

export interface RecoverResult {
  /** The bot reached the spot (within 2 blocks). */
  arrived: boolean;
  /** done | walk_failed (+ the nav's reason) | interrupted | error */
  reason: string;
  /** Items picked up, by name. */
  gained: Record<string, number>;
}

export class RecoverProcess extends BaseProcess {
  readonly kind = 'user' as const;
  readonly name = 'recover';
  readonly result: Promise<RecoverResult>;
  private resolve!: (r: RecoverResult) => void;
  private readonly d: RecoverDeps;
  readonly req: RecoverRequest;
  private arrived = false;
  private phase: 'walk' | 'collect' = 'walk';
  private readonly gained: Record<string, number> = {};

  constructor(d: RecoverDeps, req: RecoverRequest) {
    super();
    this.d = d;
    this.req = req;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  private end(reason: string): void {
    this.finish();
    this.resolve({ arrived: this.arrived, reason, gained: { ...this.gained } });
  }

  protected run(t: number): void {
    const s = this.req.spot;
    void (async () => {
      if (!this.arrived) {
        this.phase = 'walk';
        const w = await this.d.goto({ type: 'near', p: s, r: 2 }, { timeoutTicks: this.req.walkTicks });
        if (t !== this.token) return;
        if (!w.ok) return this.end(`walk_failed (${w.reason ?? 'failed'})`);
        this.arrived = true;
      }
      this.phase = 'collect';
      const c = await this.d.collect(this.req.radius, this.req.collectTicks, { origin: s });
      for (const [k, v] of Object.entries(c.gained)) this.gained[k] = (this.gained[k] ?? 0) + v;
      if (t !== this.token) return;
      this.end('done');
    })().catch((e: unknown) => {
      this.d.log?.warn(`recover: ${e instanceof Error ? e.message : String(e)}`);
      if (t === this.token) this.end('error');
    });
  }

  protected halt(): void {
    this.d.cancel();
  }

  protected override onStopped(_reason: StopReason): void {
    this.resolve({ arrived: this.arrived, reason: 'interrupted', gained: { ...this.gained } });
  }

  status(): ProcessStatus {
    const s = this.req.spot;
    return { line: this.phase === 'walk' ? `walking back to ${Math.floor(s.x)} ${Math.floor(s.y)} ${Math.floor(s.z)} for the drops` : 'picking up the drops' };
  }
}
