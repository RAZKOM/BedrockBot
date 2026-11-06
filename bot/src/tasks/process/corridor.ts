// Track F4b (docs/flight.md "Corridor flight", skills/fly/corridor/): an underground window of a corridor as a process of its own
// (docs/processes.md). A user process (`fly`, like the cruise's FlyProcess) for the ground work: the elytra on
// and rockets into the hotbar, then the window flown from standing on the chain of trackers (drive.ts
// flyStretch). While the body is in the air its priority is FLIGHT_PRIORITY (above flee, as the FlightProcess
// holds the cruise's flight), so nothing pre-empts a body gliding through a bore; on the ground it is a user
// command again. The elytra stays on after the window (the next window takes off again; the corridor trip
// puts the chestplate back on at its end, chat/commands-corridor.ts).
import { silentLogger, type Logger } from '../../log.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';
import { FLIGHT_PRIORITY } from './fly.ts';
import { readKit, type FlightKitMemory, type KitInventory } from '../../skills/fly/kit.ts';
import type { FlightKitOps } from '../../skills/fly/kitops.ts';
import type { StretchReport } from '../../skills/fly/corridor/drive.ts';
import type { StepOutcome } from '../../skills/fly/corridor/executor.ts';
import type { Window } from '../../skills/fly/corridor/stretches.ts';

export interface UnderFlyDeps {
  kitOps: Pick<FlightKitOps, 'wearElytra' | 'rocketsToHotbar'>;
  inventory: KitInventory;
  memory(): FlightKitMemory;
  /** Fly the window from standing (flyStretch bound to the loop, the worker's planner). */
  fly(w: Window): { done: Promise<StretchReport>; stop(): void };
  /** The body is in the air (gliding or not on the ground). */
  airborne(): boolean;
  waitTicks(n: number): Promise<void>;
  log?: Logger;
}

export class UnderFlyProcess extends BaseProcess {
  readonly name = 'fly';
  readonly kind = 'user' as const;
  readonly result: Promise<StepOutcome>;
  phase: 'prepare' | 'flying' | 'done' = 'prepare';
  private resolve!: (r: StepOutcome) => void;
  private readonly d: UnderFlyDeps;
  private readonly w: Window;
  private readonly label: string;
  private readonly log: Logger;
  private flight: { done: Promise<StretchReport>; stop(): void } | undefined;
  report: StretchReport | undefined;

  constructor(w: Window, label: string, deps: UnderFlyDeps) {
    super();
    this.w = w;
    this.label = label;
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
  }

  get priority(): number {
    return this.phase === 'flying' && this.d.airborne() ? FLIGHT_PRIORITY : PRIORITY.user;
  }

  /** In the air: the flight holds on (the window lands by itself); a stop then ends it at the touchdown. */
  stopNow(): void {
    this.flight?.stop();
  }

  status(): ProcessStatus {
    return { line: this.phase === 'flying' ? `flying ${this.label} (corridor, ${Math.round(this.w.blocks)} blocks)` : `readying the flight kit (corridor, ${this.label})` };
  }

  protected run(t: number): void {
    if (this.phase === 'prepare') void this.prepare(t);
  }

  protected halt(why: 'pause' | 'stop'): void {
    // a body on the ground that loses control before its takeoff simply waits; once flying the window flies on (it is above flee)
    if (why === 'stop' && this.phase === 'flying') this.flight?.stop();
  }

  protected override onStopped(reason: StopReason): void {
    this.flight?.stop();
    if (this.phase !== 'flying') this.resolve({ ok: false, reason: reason === 'replaced' ? 'replaced' : 'interrupted' });
  }

  private kit() {
    return readKit(this.d.inventory, this.d.memory());
  }

  private end(r: StepOutcome): void {
    this.phase = 'done';
    this.finish();
    this.resolve(r);
  }

  private async prepare(t: number): Promise<void> {
    try {
      if (this.kit().rocketsHotbar === 0) {
        const r = await this.d.kitOps.rocketsToHotbar();
        if (t !== this.token) return;
        if (!r.ok && this.kit().rocketsHotbar === 0) return this.end({ ok: false, reason: `no rockets in the hotbar (${r.reason ?? '?'})` });
      }
      if (!this.kit().elytraWorn) {
        const w = await this.d.kitOps.wearElytra();
        if (t !== this.token) return;
        for (let i = 0; i < 20 && !this.kit().elytraWorn; i++) await this.d.waitTicks(1);
        if (t !== this.token) return;
        if (!w.ok || !this.kit().elytraWorn) return this.end({ ok: false, reason: `the elytra is not on (${w.reason ?? 'the server did not confirm it'})` });
      }
      await this.d.waitTicks(2);
      if (t !== this.token) return;
      this.phase = 'flying';
      this.flight = this.d.fly(this.w);
      const r = await this.flight.done;
      this.report = r;
      this.log.info(
        `corridor: window ${this.label}: ${r.end}, ${r.reached}/${r.goals} goals, ${r.ticks} ticks, ${r.rockets} rockets, ${r.hits} local hits, ${r.corrections} corrections (max ${r.maxCorrection.toFixed(2)}), ${r.held} held, ${r.windows} trackers, ${r.stats.plans} plans (${r.stats.replans} re, ${r.stats.partial} partial, ${Math.round(r.stats.planMs)} ms), landed at ${r.landedAt.x.toFixed(1)} ${r.landedAt.y.toFixed(1)} ${r.landedAt.z.toFixed(1)}`,
      );
      // the body may still glide (a failed window): wait for the ground before handing back
      for (let i = 0; i < 200 && this.d.airborne(); i++) await this.d.waitTicks(1);
      this.end({ ok: r.end === 'done', ...(r.end === 'done' ? {} : { reason: r.end }), at: r.landedAt, rockets: r.rockets, corrections: r.corrections, replans: r.stats.replans, held: r.held, ticks: r.ticks });
    } catch (e) {
      this.end({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
