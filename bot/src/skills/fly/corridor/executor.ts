// Track F4b (docs/flight.md "Corridor flight", ADR 0067): the corridor executor. It asks the coarse layer
// (CorridorProvider: the real CoarseLayer, or the stub) for a corridor to the goal and follows its legs:
//  - walk / mine legs: the walk navigator (`walk`, its public API through the port);
//  - fly legs, cut into stretches (stretches.ts): a sky stretch is a cruise (FlyProcess, ADR 0055) to the cell
//    where the next stretch starts (just inside a mouth, a shaft's floor) or to the leg's end; an underground
//    stretch is flown from standing a window at a time (drive.ts, the chain of trackers), each window ending
//    on a floor, waiting for chunks between windows; a short one or a short tail after a bend is walked;
//  - an underground fly leg whose unknown share is over UNKNOWN_FLY_MAX is never flown: it is walked (the
//    walk explores, the layer re-plans as the chunks arrive);
//  - a failure marks the portal it happened at (`markPortal(id, mode, 'failed')`) and plans again from where
//    the body stands (at most MAX_REPLANS), a portal flown through is marked 'ok'.
// Everything the executor does to the world goes through CorridorPorts, so the unit tests run it over stub
// corridors and stub flights (test/unit/skills/fly-corridor.test.ts) and chat/commands-corridor.ts wires the
// real ones.
import { silentLogger, type Logger } from '../../../log.ts';
import type { Vec3 } from '../../../world/types.ts';
import type { RoutePlan } from '../route/types.ts';
import type { CoarseMode, Corridor, CorridorLeg, CorridorProvider, PortalId } from './coarse-port.ts';
import { flightSpace } from './cost.ts';
import { changeCell, nextWindow, splitLeg, standableNear, UNDER_TAIL_MIN, WINDOW_BLOCKS, type CellSolid, type Stretch, type Window } from './stretches.ts';

/** An underground fly leg is walked instead when more than this share of its underground part is unknown space (the layer's unknownFraction for the leg, or the executor's sampling). */
export const UNKNOWN_FLY_MAX = 0.25;
/** Corridors planned again after a failure, at most. */
export const MAX_REPLANS = 4;
/** An underground window flown again after a touchdown short of its landing, at most (per stretch). */
export const UNDER_RETRIES = 2;
/**
 * A cruise that ends within this of its cell walks the rest (blocks, horizontal; the navigator finds the way: along a
 * roof and down its hole, round through a mouth). The 1 x 1 shaft took 1 to 4 go-arounds on the e2e and two runs ran
 * out of them 31 and 35 blocks off; a cruise from standing that close does not fly (the takeoff, a flare and down
 * on the spot in 14 ticks, no rocket: the cruise is for `flyMin` 200 and up), so the walk is the way there.
 */
export const SKY_WALK_MAX = 64;
/**
 * A sky stretch flown again, at most, when the cruise came down whole farther off than SKY_WALK_MAX (its go-arounds
 * ran out, SKY_RETRY_REASONS), before the change is marked failed. A crash, no rockets or a failed walk from a
 * nearer landing fails the change at once.
 */
export const SKY_RETRIES = 1;
/** The cruise's end reasons that leave the body standing, whole, somewhere else (the brain's `landed_off`). */
export const SKY_RETRY_REASONS: readonly string[] = ['landed_off'];
/** A flight that stands within this of its cell is on it (the walk takes the rest). */
export const NEAR_END = 4;
/** An underground window shorter than this is walked (a takeoff and a landing for less is no gain). */
export const UNDER_FLY_MIN = 24;
/** How long the executor waits for the chunks ahead before it walks on (ms). */
export const CHUNK_WAIT_MS = 15_000;
/** The modes a corridor may use (mine is not asked for: the corridor flight never digs). */
export const CORRIDOR_MODES: readonly CoarseMode[] = ['walk', 'fly'];
/**
 * The search time a corridor plan may take (ms, the layer's slices summed; the tick never waits for it). Open sky
 * is cheap for flight everywhere, so a goal under a roof makes the search exhaust the sky round the goal before
 * it takes the way in: 3 600 volumes on the corridor world offline, 7 700 and 2.2 s over the e2e's cold real chunks,
 * where the layer's default 500 ms gave a partial corridor ending in the sky over the goal. A trip plans once (and once per re-plan).
 */
export const CORRIDOR_PLAN_MS = 4000;
/**
 * Hotfix 2026-11-06: underground stretches are walked, not flown. On the Realm a window in a real cave flew on
 * partial plans at the live planner budget ("corridor ahead is blocked", clearance 0, a window handed over with
 * no plan), hit the walls (6.5, 2.8) and died. The e2e bores are clean 3 x 3 tubes; real caves are not. The
 * sky stretches (the cruise to a mouth or a shaft) are still flown. Turn back on only with a cave benchmark.
 */
export const UNDER_FLY = false;
/** Sampling step of the unknown share underground (blocks). */
const SAMPLE_STEP = 4;

/** What a step of the trip reports: how it went and what it cost. */
export interface StepOutcome {
  ok: boolean;
  reason?: string;
  /** Where the body stands after it (undefined: position unknown). */
  at?: Vec3;
  rockets?: number;
  corrections?: number;
  /** The route trackers' re-plans (underground windows). */
  replans?: number;
  /** Corrections that held the body back (ADR 0055's chunk edge). */
  held?: number;
  ticks?: number;
  /** Track F5b: the window bailed out (stopped and sank to the floor) short of its landing. */
  bailed?: boolean;
}

/** What the executor needs of the bot. */
export interface CorridorPorts {
  provider: CorridorProvider;
  position(): Vec3 | undefined;
  dim(): number;
  /** A cell of the live model: true solid, false air, undefined not loaded. */
  solid: CellSolid;
  loaded(x: number, z: number): boolean;
  /** Resolves true once the chunks round every point are loaded, false after `timeoutMs`. */
  waitLoaded(points: readonly Vec3[], timeoutMs: number): Promise<boolean>;
  /** The cruise to an exact feet cell: the takeoff chain, the cruise, the landing families (FlyProcess). */
  flySky(cell: Vec3, label: string): Promise<StepOutcome>;
  /** One underground window from standing (the elytra on, the chain of trackers; lands on `w.end`), with its proven plan when there is one. */
  flyUnder(w: Window, label: string, plan?: RoutePlan): Promise<StepOutcome>;
  /** Track F5b: the plan from standing for a window at the live budget (ExecutorOptions.prove). */
  proveWindow?(w: Window): Promise<WindowProof>;
  /** Walk to a feet cell (the navigator). */
  walk(cell: Vec3, label: string): Promise<StepOutcome>;
  /** The trip was stopped (`!stop`, `!fly stop`). */
  stopped(): boolean;
  log?: Logger;
  say?(msg: string): void;
}

export interface LegReport {
  mode: CoarseMode;
  /** How it was travelled: `fly` (sky / under stretches flown), `walk`, `walk (unknown)` (a refused fly leg). */
  how: string;
  ok: boolean;
  blocks: number;
}

export interface CorridorReport {
  ok: boolean;
  reason?: string;
  /** Corridors planned (the first and the re-plans) and the re-plans alone. */
  plans: number;
  replans: number;
  legs: LegReport[];
  /** Sky flights (cruises), underground windows flown, walks. */
  cruises: number;
  windows: number;
  walks: number;
  rockets: number;
  corrections: number;
  trackerReplans: number;
  held: number;
  /** Track F5b: underground windows that bailed out; proofs asked, windows cut back by a partial proof, walks to a first goal no plan reached. */
  bailouts: number;
  proofs: number;
  cuts: number;
  unproven: number;
  marks: { id: PortalId; mode: CoarseMode; outcome: 'ok' | 'failed' }[];
  seconds: number;
}

export interface ExecutorOptions {
  modes?: readonly CoarseMode[];
  unknownMax?: number;
  maxReplans?: number;
  chunkWaitMs?: number;
  planMs?: number;
  /** Fly the underground stretches in windows (default UNDER_FLY); false walks them. */
  underFly?: boolean;
  /** Track F5b: the windows' size (blocks, default WINDOW_BLOCKS) and the tail after a bend that is walked (default UNDER_TAIL_MIN): the cave style flies shorter pieces. */
  windowBlocks?: number;
  tailMin?: number;
  /**
   * Track F5b: prove every window before its takeoff (`CorridorPorts.proveWindow`: a plan from standing at the live
   * budget). A plan that reaches the landing flies the window; one that reaches some goals cuts the window back to
   * them (at most PROVE_CUTS times); one that reaches nothing walks to the first goal. Never fly on a partial plan.
   */
  prove?: boolean;
  /** Track F5b: a proof must also be robust to the burn (default true with `prove`); a complete plan that is not counts as unproven. */
  proveRobust?: boolean;
}

/** Track F5b: a window is cut back to what its plan reached at most this many times before the rest is walked to the first goal. */
export const PROVE_CUTS = 3;
/** Track F5b: an underground stretch whose steps (windows, walks) bring the body no STALL_PROGRESS blocks nearer its end STALL_STEPS times in a row is walked out (one run flew 297 windows between two floors). */
export const STALL_STEPS = 4;
export const STALL_PROGRESS = 2;

/** Track F5b: what a proof of a window answers (the plan from standing at the live budget). */
export interface WindowProof {
  complete: boolean;
  /** The plan is robust to the burn by construction (route/search.ts burn branches). */
  robust: boolean;
  /** Goals the plan reached. */
  reached: number;
  ms: number;
  /** The plan itself when complete (the window's first tracker flies it; drive.ts `firstPlan`). */
  plan?: RoutePlan;
}

type LegResult = { ok: true } | { ok: false; reason: string; mark?: { id: PortalId; mode: CoarseMode }; fatal?: boolean };

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const hd = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
const cellOf = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) });
const fmt = (p: Vec3): string => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
/** The body stands on (or within NEAR_END of) a cell. */
const near = (at: Vec3 | undefined, cell: Vec3, r = NEAR_END): boolean => !!at && hd(at, { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }) <= r && Math.abs(at.y - cell.y) <= 2;

export class CorridorExecutor {
  private readonly p: CorridorPorts;
  private readonly o: Required<ExecutorOptions>;
  private readonly log: Logger;
  private r!: CorridorReport;

  constructor(ports: CorridorPorts, o: ExecutorOptions = {}) {
    this.p = ports;
    this.o = { modes: o.modes ?? CORRIDOR_MODES, unknownMax: o.unknownMax ?? UNKNOWN_FLY_MAX, maxReplans: o.maxReplans ?? MAX_REPLANS, chunkWaitMs: o.chunkWaitMs ?? CHUNK_WAIT_MS, planMs: o.planMs ?? CORRIDOR_PLAN_MS, underFly: o.underFly ?? UNDER_FLY, windowBlocks: o.windowBlocks ?? WINDOW_BLOCKS, tailMin: o.tailMin ?? UNDER_TAIL_MIN, prove: o.prove ?? false, proveRobust: o.proveRobust ?? true };
    this.log = ports.log ?? silentLogger;
  }

  /** The flight space of a body point (the layer's volume there), undefined for solid or unknown cells. */
  private classify = (p: Vec3) => {
    const v = this.p.provider.volumeAt(p, this.p.dim());
    return v ? flightSpace(v) : undefined;
  };

  /** Follow corridors to `goal` (a feet cell) until it stands there, the re-plans run out or the trip is stopped. */
  async run(goal: Vec3, label = fmt(goal)): Promise<CorridorReport> {
    const t0 = Date.now();
    this.r = { ok: false, plans: 0, replans: 0, legs: [], cruises: 0, windows: 0, walks: 0, rockets: 0, corrections: 0, trackerReplans: 0, held: 0, bailouts: 0, proofs: 0, cuts: 0, unproven: 0, marks: [], seconds: 0 };
    const end = (ok: boolean, reason?: string): CorridorReport => {
      this.r.ok = ok;
      if (reason) this.r.reason = reason;
      this.r.seconds = Math.round((Date.now() - t0) / 100) / 10;
      this.log.info(`corridor: ${ok ? 'arrived at' : 'gave up on'} ${label}${reason ? ` (${reason})` : ''}: ${this.r.plans} corridor plans (${this.r.replans} re-plans), ${this.r.cruises} cruises, ${this.r.windows} windows underground, ${this.r.walks} walks, ${this.r.rockets} rockets, ${this.r.corrections} corrections, ${this.r.trackerReplans} route re-plans, ${this.r.held} held, ${this.r.seconds} s`);
      return this.r;
    };
    for (;;) {
      if (this.p.stopped()) return end(false, 'interrupted');
      const start = this.p.position();
      if (!start) return end(false, 'position unknown');
      if (near(start, goal, 0.8)) return end(true);
      if (this.r.plans > this.o.maxReplans) return end(false, `no corridor worked after ${this.r.replans} re-plans`);
      const c = await this.p.provider.plan({ start, goal, dim: this.p.dim(), modes: this.o.modes, startMode: 'walk', goalStanding: true, maxMs: this.o.planMs });
      this.r.plans++;
      this.log.info(`corridor: plan ${this.r.plans} to ${label}: ${c.status}, ${c.legs.length} legs (${c.legs.map((l) => `${l.mode} ${Math.round(l.blocks)}`).join(', ')}), ${Math.round(c.blocks)} blocks, ${Math.round(c.unknownFraction * 100)}% unknown${c.reason ? `: ${c.reason}` : ''}`);
      if (c.status === 'none' || c.legs.length === 0) return end(false, c.reason ?? 'no corridor');
      const r = await this.follow(c);
      if (r.ok) {
        if (c.status === 'found') {
          const at = this.p.position();
          if (near(at, goal)) {
            if (!near(at, goal, 0.8)) await this.walk(goal, label);
            return end(true);
          }
        }
        continue; // partial, or short of the goal: plan again from here
      }
      if (r.fatal) return end(false, r.reason);
      if (r.mark) this.mark(r.mark.id, r.mark.mode, 'failed');
      this.r.replans++;
      this.log.info(`corridor: ${r.reason}; planning again from ${this.p.position() ? fmt(this.p.position()!) : '?'}`);
    }
  }

  private mark(id: PortalId, mode: CoarseMode, outcome: 'ok' | 'failed'): void {
    this.p.provider.markPortal(id, mode, outcome);
    this.r.marks.push({ id, mode, outcome });
  }

  private add(s: StepOutcome): void {
    this.r.rockets += s.rockets ?? 0;
    this.r.corrections += s.corrections ?? 0;
    this.r.trackerReplans += s.replans ?? 0;
    this.r.held += s.held ?? 0;
    if (s.bailed) this.r.bailouts++;
  }

  private async walk(cell: Vec3, label: string): Promise<StepOutcome> {
    this.r.walks++;
    const w = await this.p.walk(cell, label);
    this.add(w);
    return w;
  }

  private async follow(c: Corridor): Promise<LegResult> {
    for (const [i, leg] of c.legs.entries()) {
      if (this.p.stopped()) return { ok: false, reason: 'interrupted', fatal: true };
      const r = leg.mode === 'fly' ? await this.flyLeg(leg, i) : await this.walkLeg(leg, i);
      this.r.legs.push({ mode: leg.mode, how: r.how, ok: r.res.ok, blocks: Math.round(leg.blocks) });
      if (!r.res.ok) return r.res;
    }
    return { ok: true };
  }

  private async walkLeg(leg: CorridorLeg, i: number): Promise<{ how: string; res: LegResult }> {
    const to = cellOf(leg.to);
    const w = await this.walk(to, `leg ${i + 1} (${leg.mode}) to ${fmt(to)}`);
    if (w.ok || near(w.at ?? this.p.position(), to)) return { how: leg.mode, res: { ok: true } };
    const first = leg.portals[0];
    return { how: leg.mode, res: { ok: false, reason: `the ${leg.mode} leg to ${fmt(to)} failed (${w.reason ?? '?'})`, ...(first ? { mark: { id: first.id, mode: leg.mode } } : {}), ...(w.reason === 'interrupted' ? { fatal: true } : {}) } };
  }

  /** The unknown share of the leg's underground part: sampled along its under stretches (the layer's volumes), else the leg's own unknownFraction. */
  undergroundUnknown(leg: CorridorLeg, stretches: readonly Stretch[]): number {
    let n = 0;
    let unknown = 0;
    for (const s of stretches) {
      if (s.space !== 'under') continue;
      for (let k = 1; k < s.points.length; k++) {
        const a = s.points[k - 1]!;
        const b = s.points[k]!;
        const steps = Math.max(1, Math.ceil(dist(a, b) / SAMPLE_STEP));
        for (let j = 0; j <= steps; j++) {
          const t = j / steps;
          const v = this.p.provider.volumeAt({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + 1, z: a.z + (b.z - a.z) * t }, this.p.dim());
          if (!v) continue;
          n++;
          if (v.kind === 'unknown' || v.known === 'unknown') unknown++;
        }
      }
    }
    return n > 0 ? unknown / n : leg.unknownFraction;
  }

  private async flyLeg(leg: CorridorLeg, i: number): Promise<{ how: string; res: LegResult }> {
    const stretches = splitLeg(leg, this.classify);
    const unknown = this.undergroundUnknown(leg, stretches);
    if (stretches.some((s) => s.space === 'under') && unknown > this.o.unknownMax) {
      // never commit a flight into unknown space underground: the walk explores, the layer re-plans as the chunks arrive
      this.log.info(`corridor: leg ${i + 1} (fly, ${Math.round(leg.blocks)} blocks) runs ${Math.round(unknown * 100)}% through unknown space underground (over ${Math.round(this.o.unknownMax * 100)}%): walking it`);
      const w = await this.walkLeg(leg, i);
      return { how: 'walk (unknown)', res: w.res };
    }
    const legEnd = cellOf(leg.to);
    for (const [k, s] of stretches.entries()) {
      if (this.p.stopped()) return { how: 'fly', res: { ok: false, reason: 'interrupted', fatal: true } };
      const last = k === stretches.length - 1;
      const next = stretches[k + 1];
      // where this stretch ends standing: the leg's end, or the cell where the next stretch starts (inside a mouth, a shaft's floor)
      let cell: Vec3 | undefined = last ? legEnd : undefined;
      if (!cell && s.leave && next) {
        const after = next.points[1] ?? next.end;
        const before = s.points[s.points.length - 2] ?? s.points[0]!;
        cell = changeCell(s.leave, before, after, next.space, this.p.solid);
        if (!cell) {
          await this.p.waitLoaded([s.leave.center, after], this.o.chunkWaitMs);
          cell = changeCell(s.leave, before, after, next.space, this.p.solid);
        }
      }
      if (!cell) return { how: 'fly', res: { ok: false, reason: `no floor known where leg ${i + 1} changes at ${s.leave ? fmt(s.leave.center) : '?'}`, ...(s.leave ? { mark: { id: s.leave.id, mode: 'fly' as const } } : {}) } };
      const r = s.space === 'sky' ? await this.skyStretch(s, cell, i) : await this.underStretch(s, cell, i);
      if (!r.ok) return { how: 'fly', res: r };
      // the change flown through worked
      if (s.leave && !last) this.mark(s.leave.id, 'fly', 'ok');
    }
    return { how: 'fly', res: { ok: true } };
  }

  private async skyStretch(s: Stretch, cell: Vec3, i: number): Promise<LegResult> {
    // a y opening of 1 or 2 across is a shaft; a wider one is the open top of a covered volume (the ground by a mouth)
    const what = !s.leave ? '' : s.leave.axis !== 'y' ? 'mouth' : s.leave.clearance.width <= 2 ? 'shaft' : 'opening';
    const label = s.leave ? `the ${what} at ${fmt(s.leave.center)}` : fmt(cell);
    for (let tries = 0; ; tries++) {
      this.log.info(`corridor: leg ${i + 1}: the cruise to ${fmt(cell)} (${label})${tries ? `, again (${tries + 1})` : ''}`);
      this.r.cruises++;
      const f = await this.p.flySky(cell, label);
      this.add(f);
      if (f.reason === 'interrupted' || this.p.stopped()) return { ok: false, reason: 'interrupted', fatal: true };
      const at = f.at ?? this.p.position();
      if (near(at, cell, 0.8)) return { ok: true };
      // landed near (a miss, the slide, the go-arounds run out over a small opening): walk the rest
      const off = at ? hd(at, cell) : Infinity;
      if (at && off <= SKY_WALK_MAX) {
        if (off > 4) this.log.info(`corridor: the cruise to ${label} ended at ${fmt(at)}, ${Math.round(off)} blocks from it (${f.reason ?? 'missed'}): walking there`);
        const w = await this.walk(cell, `walking into ${label}`);
        if (w.ok || near(w.at ?? this.p.position(), cell, 1.5)) return { ok: true };
      }
      // came down whole far off (the go-arounds ran out): one more approach from there; else the change failed
      if (at && off > SKY_WALK_MAX && f.reason !== undefined && SKY_RETRY_REASONS.includes(f.reason) && tries < SKY_RETRIES) {
        this.log.info(`corridor: the cruise to ${label} ended at ${fmt(at)}, ${Math.round(hd(at, cell))} blocks from it (${f.reason}): flying it again`);
        continue;
      }
      return { ok: false, reason: `the cruise to ${label} ended ${at ? `at ${fmt(at)}, ${Math.round(hd(at, cell))} blocks from it` : 'somewhere'} (${f.reason ?? 'missed'})`, ...(s.leave ? { mark: { id: s.leave.id, mode: 'fly' as const } } : {}) };
    }
  }

  private async underStretch(s: Stretch, end: Vec3, i: number): Promise<LegResult> {
    let tries = 0;
    /** Track F5b: walks for want of a proof that made no progress in a row (the next one goes farther). */
    let stuckWalks = 0;
    /** Track F5b: the nearest the body has been to the stretch's end, and the steps in a row that came no closer (a stretch that makes no headway is walked out). */
    let best = Infinity;
    let stalls = 0;
    for (;;) {
      if (this.p.stopped()) return { ok: false, reason: 'interrupted', fatal: true };
      const pos = this.p.position();
      if (!pos) return { ok: false, reason: 'position unknown', fatal: true };
      if (near(pos, end, 1.5)) return { ok: true };
      const d = dist(pos, { x: end.x + 0.5, y: end.y, z: end.z + 0.5 });
      if (d < best - STALL_PROGRESS) {
        best = d;
        stalls = 0;
      } else if (++stalls >= STALL_STEPS) {
        // windows and walks that bring the body no closer (a window that bails out where it took off, a walk to a goal it stands at): walk the rest
        this.log.info(`corridor: no headway towards ${fmt(end)} in ${stalls} steps: walking the rest`);
        const w = await this.walk(end, `walking the rest underground to ${fmt(end)} (no headway)`);
        if (w.ok || near(w.at ?? this.p.position(), end, 1.5)) return { ok: true };
        return { ok: false, reason: `the walk underground to ${fmt(end)} failed (${w.reason ?? '?'})`, ...(s.portals[0] ? { mark: { id: s.portals[0].id, mode: 'walk' as const } } : {}), ...(w.reason === 'interrupted' ? { fatal: true } : {}) };
      }
      const windowOf = (): Window | undefined => nextWindow(s, pos, { loaded: (x, z) => this.p.loaded(x, z), solid: this.p.solid, endCell: end, maxBlocks: this.o.windowBlocks, tailMin: this.o.tailMin });
      let win = windowOf();
      if (win?.cut && win.blocks < UNDER_FLY_MIN) {
        // the chunks ahead may be on their way: wait, then look again
        const ahead = s.portals.filter((p) => !this.p.loaded(Math.floor(p.center.x), Math.floor(p.center.z))).slice(0, 2).map((p) => p.center);
        if (ahead.length && (await this.p.waitLoaded(ahead, this.o.chunkWaitMs))) win = windowOf();
      }
      if (!this.o.underFly || !win || win.blocks < UNDER_FLY_MIN) {
        // nothing worth flying (a short stretch, the tail after a bend, nothing loaded): walk to the stretch's end
        const w = await this.walk(end, `walking ${win ? 'the rest' : 'on'} underground to ${fmt(end)}`);
        if (w.ok || near(w.at ?? this.p.position(), end, 1.5)) return { ok: true };
        return { ok: false, reason: `the walk underground to ${fmt(end)} failed (${w.reason ?? '?'})`, ...(s.portals[0] ? { mark: { id: s.portals[0].id, mode: 'walk' as const } } : {}), ...(w.reason === 'interrupted' ? { fatal: true } : {}) };
      }
      // Track F5b: the window is proven before the takeoff: a complete plan from standing flies it; a partial one cuts the
      // window back to the goals it reached; one that reaches nothing walks to the window's first goal and looks again
      let plan: RoutePlan | undefined;
      if (this.o.prove && this.p.proveWindow) {
        let proven = false;
        for (let cut = 0; cut <= PROVE_CUTS && win; cut++) {
          this.r.proofs++;
          const pf = await this.p.proveWindow(win);
          if (pf.complete && (pf.robust || !this.o.proveRobust)) {
            proven = true;
            plan = pf.plan;
            break;
          }
          if (pf.complete) {
            // complete but not robust to the burn: a shorter window may be (the long burn's overshoot has less to hit)
            this.log.info(`corridor: the plan for the window to ${fmt(win.end)} is complete but not robust to the burn: cut back`);
            if (win.goals.length <= 2 || cut === PROVE_CUTS) break;
            const shorter = nextWindow(s, pos, { loaded: (x, z) => this.p.loaded(x, z), solid: this.p.solid, endCell: end, maxBlocks: Math.max(1, (win.goalS[Math.max(0, win.goals.length - 3)] ?? 0) + 0.5), tailMin: this.o.tailMin });
            if (!shorter || shorter.goals.length >= win.goals.length) break;
            this.r.cuts++;
            win = shorter;
            continue;
          }
          if (pf.reached <= 0 || cut === PROVE_CUTS) break;
          // cut back to the goals the plan reached: the window ends at the last portal or via point among them
          const shorter = nextWindow(s, pos, { loaded: (x, z) => this.p.loaded(x, z), solid: this.p.solid, endCell: end, maxBlocks: Math.max(1, (win.goalS[pf.reached - 1] ?? 0) + 0.5), tailMin: this.o.tailMin });
          if (!shorter || shorter.goals.length >= win.goals.length) break;
          this.log.info(`corridor: the plan for the window to ${fmt(win.end)} reached ${pf.reached} of ${win.goals.length} goals (${pf.ms.toFixed(0)} ms): cut back to ${fmt(shorter.end)} (${Math.round(shorter.blocks)} blocks, ${shorter.goals.length} goals)`);
          this.r.cuts++;
          win = shorter;
        }
        if (!proven) {
          // no window from here has a complete plan: walk to the first goal of the window (or the stretch's end) and look again
          const first = win?.goals[0];
          const cell = first?.kind === 'waypoint' ? standableNear(this.p.solid, { x: (first.box.min.x + first.box.max.x) / 2, y: first.box.min.y, z: (first.box.min.z + first.box.max.z) / 2 }) : undefined;
          // a first goal the body already stands at (the window starts on its floor), or no progress twice: the next goal, then the end
          let to = cell ?? end;
          if (near(pos, to, 1.5) || stuckWalks >= 1) {
            const second = win?.goals[1];
            const next = second?.kind === 'waypoint' ? standableNear(this.p.solid, { x: (second.box.min.x + second.box.max.x) / 2, y: second.box.min.y, z: (second.box.min.z + second.box.max.z) / 2 }) : undefined;
            to = stuckWalks >= 2 || !next || near(pos, next, 1.5) ? end : next;
          }
          stuckWalks = near(pos, to, 1.5) ? stuckWalks + 1 : 0;
          this.r.unproven++;
          this.log.info(`corridor: no complete plan from ${fmt(pos)} for a window underground: walking to ${fmt(to)}`);
          const w = await this.walk(to, `walking underground to ${fmt(to)} (no plan proven)`);
          if (!(w.ok || near(w.at ?? this.p.position(), to, 1.5))) return { ok: false, reason: `the walk underground to ${fmt(to)} failed (${w.reason ?? '?'})`, ...(s.portals[0] ? { mark: { id: s.portals[0].id, mode: 'walk' as const } } : {}), ...(w.reason === 'interrupted' ? { fatal: true } : {}) };
          if (to === end) return { ok: true };
          tries = 0;
          continue;
        }
        if (win.blocks < UNDER_FLY_MIN) {
          const w = await this.walk(win.end, `walking the short piece underground to ${fmt(win.end)}`);
          if (!(w.ok || near(w.at ?? this.p.position(), win.end, 1.5))) return { ok: false, reason: `the walk underground to ${fmt(win.end)} failed (${w.reason ?? '?'})`, ...(w.reason === 'interrupted' ? { fatal: true } : {}) };
          continue;
        }
      }
      this.log.info(`corridor: leg ${i + 1}: underground window ${this.r.windows + 1} from ${fmt(pos)} to ${fmt(win.end)} (${Math.round(win.blocks)} blocks, ${win.goals.length} goals, margin ${win.margin}${win.cut ? ', cut' : ''})`);
      this.r.windows++;
      const f = await this.p.flyUnder(win, `underground to ${fmt(win.end)}`, plan);
      this.add(f);
      if (f.reason === 'interrupted') return { ok: false, reason: 'interrupted', fatal: true };
      const at = f.at ?? this.p.position();
      if (f.ok || near(at, win.end)) {
        tries = 0;
        continue; // the next window (or the end) from where it stands
      }
      tries++;
      if (tries > UNDER_RETRIES) {
        const p = win.portals[0] ?? s.enter;
        return { ok: false, reason: `the flight underground to ${fmt(win.end)} failed ${tries} times (${f.reason ?? '?'})`, ...(p ? { mark: { id: p.id, mode: 'fly' as const } } : {}) };
      }
      this.log.info(`corridor: the window ended ${at ? `at ${fmt(at)}` : '?'} (${f.reason ?? '?'}): flying again from there`);
    }
  }
}
