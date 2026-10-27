// Nether processes (wave 10, Track AT; docs/nether.md): portal travel as a user process (`!nether`,
// `!overworld`) and the fire / lava escape as an auto process above flee.
//
// PortalProcess, one trip through a nether portal:
//   find    the remembered `portal` waypoint of this dimension (world/dimension.ts dimWaypointName:
//           `portal` in the overworld, `nether_portal` in the Nether), else the nearest `portal` block
//           within `portalRadius` (loaded columns, then the world cache's marks); none: fails with what
//           is missing (this track does not build portals)
//   walk    to the cell in front of or behind the portal's lowest block (the portal is 1 thick; its
//           `portal_axis` says which way it faces); a far waypoint first gets a `near` walk to it
//   enter   one step in by hand (the planner never walks into a portal: `portal` is a hazard in
//           terrain/classify.ts, so no walk ever travels by accident), then stand still
//   wait    for the change (BDS moves the player after 4 s in the portal: measured 4.0 to 4.4 s),
//           at most 15 s, then once more after stepping out and in
//   arrive  the server's dimension_change_ack (world/dimension.ts answers it), chunks around, the
//           portal block at the arrival recorded as this dimension's `portal` waypoint and the
//           departure portal as the other's; then one step out of the portal
//
// FireProcess: when the bot burns and loses health (skills/survival/fire.ts BurnWatch), it walks to
// the nearest cell that does not burn and is not next to fire or lava (fireEscape) and eats.
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { yawTowards } from '../../skills/nav/follower.ts';
import type { NavGoal } from '../../skills/nav/goals.ts';
import { fireEscape, type BurnWatch, type FireGrid } from '../../skills/survival/fire.ts';
import type { SkillResult } from '../../skills/types.ts';
import { dimensionName, dimWaypointName, type DimensionChange } from '../../world/dimension.ts';
import type { BlockInfo } from '../../world/types.ts';
import type { ProcessMover } from './goto.ts';
import { BaseProcess, PRIORITY, type ProcessStatus, type StopReason } from './manager.ts';

/** Default search radius for portal blocks (setting `portalRadius`). */
export const DEFAULT_PORTAL_RADIUS = 64;
/** How long to stand in the portal before giving up on one attempt, ms. */
export const PORTAL_WAIT_MS = 15_000;

export interface PortalWorld {
  readonly self: { readonly dimension: number; readonly pos: Vec3 };
  blockAt(p: Vec3): BlockInfo | undefined;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): Vec3[];
  readonly dimensions: { onChange(fn: (e: DimensionChange) => void): () => void; readonly changing: boolean };
  waitForChunks(radius: number, opts?: { center?: Vec3; timeoutMs?: number }): Promise<void>;
}

export interface PortalLoop {
  readonly state: { readonly pos: Vec3; readonly ready: boolean };
  setCommand(c: Partial<{ forward: number; strafe: number; yaw: number; pitch: number; jump: boolean; sneak: boolean; sprint: boolean }>): void;
  release(): void;
  waitTicks(n: number): Promise<void>;
}

/** The waypoint store's part the trips use (waypoints/store.ts satisfies it). */
export interface PortalWaypoints {
  get(name: string): { x: number; y: number | null; z: number } | undefined;
  set(name: string, p: { x: number; y: number | null; z: number }, opts?: { auto?: boolean }): unknown;
}

export interface PortalDeps {
  world: PortalWorld;
  loop: PortalLoop;
  mover: ProcessMover;
  /** The navigator's grid (stand checks for the cells beside the portal). */
  grid: { stand(x: number, y: number, z: number): number | undefined };
  waypoints?: PortalWaypoints | undefined;
  position(): Vec3 | undefined;
  radius?: () => number;
  log?: Logger;
  now?: () => number;
}

export type PortalOutcome = SkillResult & { from?: number; to?: number; departure?: Vec3; arrival?: Vec3; ms?: number };

export type PortalPhase = 'find' | 'walk' | 'enter' | 'wait' | 'arrive' | 'out';

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** The lowest portal block of the column at `p` (portals are 2+ high). */
export function portalBase(world: Pick<PortalWorld, 'blockAt'>, p: Vec3): Vec3 {
  let y = p.y;
  while (world.blockAt({ x: p.x, y: y - 1, z: p.z })?.name === 'portal' && p.y - y < 24) y--;
  return { x: p.x, y, z: p.z };
}

/** The two cells a body enters a portal block from: in front of and behind it (`portal_axis` x: the portal spans x, faces z). */
export function portalSides(world: Pick<PortalWorld, 'blockAt'>, base: Vec3): Vec3[] {
  const axis = world.blockAt(base)?.states.portal_axis;
  const faceZ = axis !== 'z'; // 'x' (or unknown): step in along z
  return faceZ
    ? [
        { x: base.x, y: base.y, z: base.z - 1 },
        { x: base.x, y: base.y, z: base.z + 1 },
      ]
    : [
        { x: base.x - 1, y: base.y, z: base.z },
        { x: base.x + 1, y: base.y, z: base.z },
      ];
}

/** Nearest portal block within `radius` of `from` (lowest block of its column), or undefined. */
export function findPortal(world: Pick<PortalWorld, 'find' | 'blockAt'>, from: Vec3, radius: number): Vec3 | undefined {
  const found = world.find((b) => b.name === 'portal', { origin: from, radius, max: 64 });
  let best: Vec3 | undefined;
  let bd = Infinity;
  for (const p of found) {
    const d = Math.hypot(p.x + 0.5 - from.x, p.y - from.y, p.z + 0.5 - from.z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best && world.blockAt(best) ? portalBase(world, best) : best;
}

export class PortalProcess extends BaseProcess {
  readonly name = 'portal';
  readonly kind = 'user' as const;
  readonly target: number;
  phase: PortalPhase = 'find';
  /** The portal block used to leave (lowest of its column). */
  departure: Vec3 | undefined;
  private readonly d: PortalDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private resolve!: (r: PortalOutcome) => void;
  readonly result: Promise<PortalOutcome>;
  private attempts = 0;
  private startAt = 0;
  private from: number;
  private offChange: (() => void) | undefined;
  /** The server's ack of the change into the target (world/dimension.ts 'arrived'). */
  arrived: DimensionChange | undefined;
  /** ms from standing in the portal to the change_dimension. */
  private inPortalMs: number | undefined;
  private line = 'looking for a portal';

  constructor(target: number, deps: PortalDeps) {
    super();
    this.target = target;
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => performance.now());
    this.from = deps.world.self.dimension;
    this.result = new Promise((r) => {
      this.resolve = r;
    });
    this.offChange = deps.world.dimensions.onChange((e) => {
      if (e.phase === 'arrived' && e.to === this.target) this.arrived = e;
    });
  }

  get priority(): number {
    return PRIORITY.user;
  }

  status(): ProcessStatus {
    return { line: `portal to the ${dimensionName(this.target)}: ${this.line}` };
  }

  protected run(t: number): void {
    void this.trip(t).then(
      (r) => {
        if (t !== this.token || !r) return;
        this.end(r);
      },
      (e: unknown) => {
        if (t === this.token) this.end({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  protected halt(): void {
    this.d.loop.release();
    this.d.mover.cancel();
  }

  protected override onStopped(reason: StopReason): void {
    this.offChange?.();
    this.resolve({ ok: false, reason: reason === 'replaced' ? 'replaced' : 'interrupted' });
  }

  private end(r: PortalOutcome): void {
    this.offChange?.();
    this.d.loop.release();
    this.resolve(r);
    this.finish();
  }

  /** One attempt from the current state (a resume starts here again); undefined = superseded. */
  private async trip(t: number): Promise<PortalOutcome | undefined> {
    const { world } = this.d;
    if (world.self.dimension === this.target && !world.dimensions.changing) return this.onArrival(t);
    this.from = world.self.dimension;
    this.phase = 'find';
    const portal = await this.locate(t);
    if (t !== this.token) return undefined;
    if (!('base' in portal)) return portal;
    const base = portal.base;
    this.departure = base;
    // walk to a side cell
    this.phase = 'walk';
    const sides = portalSides(world, base).filter((s) => {
      const f = this.d.grid.stand(s.x, s.y, s.z);
      return f === undefined || !Number.isNaN(f);
    });
    if (sides.length === 0) return { ok: false, reason: `no free cell in front of the portal at ${key(base)}` };
    this.line = `walking to the portal at ${base.x} ${base.y} ${base.z}`;
    const goal: NavGoal = sides.length === 1 ? { type: 'block', p: sides[0]! } : { type: 'any', goals: sides.map((p) => ({ type: 'block' as const, p })) };
    const w = await this.d.mover.goto(goal, { timeoutTicks: 6000 });
    if (t !== this.token) return undefined;
    if (!w.ok) return { ok: false, reason: `could not reach the portal at ${key(base)}: ${w.reason ?? 'failed'}` };
    // step in and wait
    for (; this.attempts < 2; this.attempts++) {
      this.phase = 'enter';
      this.line = `stepping into the portal at ${base.x} ${base.y} ${base.z}`;
      await this.stepTo(t, { x: base.x + 0.5, y: base.y, z: base.z + 0.5 }, 0.3);
      if (t !== this.token) return undefined;
      this.phase = 'wait';
      this.line = `waiting in the portal at ${base.x} ${base.y} ${base.z}`;
      this.startAt = this.now();
      while (this.now() - this.startAt < PORTAL_WAIT_MS) {
        await this.d.loop.waitTicks(1);
        if (t !== this.token) return undefined;
        if (world.self.dimension === this.target) {
          this.inPortalMs = Math.round(this.now() - this.startAt);
          return this.onArrival(t);
        }
      }
      // the server did not move us (cooldown, a step too short): out and in again
      this.log.warn(`portal: no dimension change after ${PORTAL_WAIT_MS / 1000} s in the portal at ${key(base)} (attempt ${this.attempts + 1})`);
      const side = sides[0]!;
      await this.stepTo(t, { x: side.x + 0.5, y: side.y, z: side.z + 0.5 }, 0.3);
      if (t !== this.token) return undefined;
      await this.d.loop.waitTicks(20);
    }
    return { ok: false, reason: `stood in the portal at ${key(base)} twice for ${PORTAL_WAIT_MS / 1000} s without travelling` };
  }

  /** The portal to use: this dimension's `portal` waypoint, else the nearest portal block. */
  private async locate(t: number): Promise<{ base: Vec3 } | PortalOutcome> {
    const { world } = this.d;
    const me = this.d.position() ?? world.self.pos;
    const radius = this.d.radius?.() ?? DEFAULT_PORTAL_RADIUS;
    const wpName = dimWaypointName(this.from, 'portal');
    const wp = this.d.waypoints?.get(wpName);
    if (wp && wp.y !== null) {
      const p = { x: wp.x, y: wp.y, z: wp.z };
      if (world.blockAt(p) === undefined && Math.hypot(p.x - me.x, p.z - me.z) > 8) {
        // remembered but not loaded: walk there first
        this.line = `walking to the remembered portal at ${p.x} ${p.y} ${p.z}`;
        const r = await this.d.mover.goto({ type: 'near', p, r: 4 }, { timeoutTicks: 12_000 });
        if (t !== this.token) return { ok: false, reason: 'interrupted' };
        if (!r.ok) return { ok: false, reason: `could not reach the remembered portal (${wpName} ${p.x} ${p.y} ${p.z}): ${r.reason ?? 'failed'}` };
      }
      if (world.blockAt(p)?.name === 'portal') return { base: portalBase(world, p) };
      this.log.info(`portal: waypoint ${wpName} ${key(p)} holds no portal block now; searching`);
    }
    const found = findPortal(world, this.d.position() ?? world.self.pos, radius);
    if (found) return { base: found };
    return {
      ok: false,
      reason:
        `no nether portal known in the ${dimensionName(this.from)}: no ${wpName} waypoint and no portal block within ${radius} blocks ` +
        '(build and light one, or stand in front of one and say !wp set portal; this bot does not build portals)',
    };
  }

  /** Walk straight at `to` until the body is within `r` of it horizontally (at most 2 s). */
  private async stepTo(t: number, to: Vec3, r: number): Promise<void> {
    const loop = this.d.loop;
    for (let i = 0; i < 40; i++) {
      const p = loop.state.pos;
      const dx = to.x - p.x;
      const dz = to.z - p.z;
      if (Math.hypot(dx, dz) <= r) break;
      loop.setCommand({ forward: Math.hypot(dx, dz) > 0.8 ? 1 : 0.6, strafe: 0, sprint: false, jump: false, sneak: false, yaw: yawTowards(dx, dz) });
      await loop.waitTicks(1);
      if (t !== this.token) break;
    }
    loop.release();
    await loop.waitTicks(4);
  }

  /** In the target dimension: wait for the ground, record both portals, step out. */
  private async onArrival(t: number): Promise<PortalOutcome | undefined> {
    const { world } = this.d;
    this.phase = 'arrive';
    this.line = `arrived in the ${dimensionName(this.target)}`;
    const ms = this.inPortalMs;
    // BDS ignores movement until the client answered its dimension_change_ack (world/dimension.ts does):
    // wait for it, then for the move_player with the exact position, then for the chunks around
    const ackBy = this.now() + 30_000;
    while (world.dimensions.changing && this.now() < ackBy) {
      await this.d.loop.waitTicks(2);
      if (t !== this.token) return undefined;
    }
    await this.d.loop.waitTicks(10);
    await world.waitForChunks(1, { timeoutMs: 20_000 }).catch(() => undefined);
    if (t !== this.token) return undefined;
    const here = this.d.position() ?? world.self.pos;
    const near = findPortal(world, here, 4);
    if (near && this.d.waypoints) {
      this.d.waypoints.set(dimWaypointName(this.target, 'portal'), near, { auto: true });
      if (this.departure && this.from !== this.target) this.d.waypoints.set(dimWaypointName(this.from, 'portal'), this.departure, { auto: true });
    }
    // out of the portal (else the next trip needs a step out first, and the planner treats it as a hazard)
    this.phase = 'out';
    if (near) {
      const out = portalSides(world, near).filter((s) => {
        const f = this.d.grid.stand(s.x, s.y, s.z);
        return f !== undefined && !Number.isNaN(f);
      });
      if (out.length) {
        const goal: NavGoal = out.length === 1 ? { type: 'block', p: out[0]! } : { type: 'any', goals: out.map((p) => ({ type: 'block' as const, p })) };
        const inPortal = world.blockAt({ x: Math.floor(here.x), y: Math.floor(here.y + 1e-6), z: Math.floor(here.z) })?.name === 'portal';
        if (inPortal) {
          // the start cell is a hazard to the planner: one step by hand towards the nearer side first
          const s = out[0]!;
          await this.stepTo(t, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, 0.3);
        } else {
          await this.d.mover.goto(goal, { timeoutTicks: 200 });
        }
      }
    }
    if (t !== this.token) return undefined;
    return { ok: true, from: this.from, to: this.target, ...(this.departure ? { departure: this.departure } : {}), ...(near ? { arrival: near } : {}), ...(ms !== undefined ? { ms } : {}) };
  }
}

export interface FireDeps {
  watch: BurnWatch;
  grid: FireGrid;
  mover: ProcessMover;
  position(): Vec3 | undefined;
  /** Eat now (the survival kit's forced eat), optional. */
  eat?: () => Promise<unknown>;
  log?: Logger;
}

/** Escape from fire / lava damage (priority above flee: lava kills in seconds). */
export class FireProcess extends BaseProcess {
  readonly name = 'fire';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  private readonly d: FireDeps;
  private readonly log: Logger;
  private episode: { to: Vec3 | undefined; startAt: number } | undefined;
  private ateAt = -Infinity;
  readonly stats = { escapes: 0, noEscape: 0, eats: 0 };

  constructor(deps: FireDeps) {
    super();
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  get priority(): number {
    return PRIORITY.flee + 1;
  }

  override wants(): boolean {
    this.d.watch.sample();
    if (this.episode !== undefined) return true;
    if (!this.d.watch.hurtByFire()) return false;
    // already on a cell clear of fire and lava: the flames on the body go out by themselves (about 8 s)
    const me = this.d.position();
    if (!me) return false;
    return fireEscape(this.d.grid, me, 0) === undefined; // radius 0: the own cell, when it is clear
  }

  status(): ProcessStatus {
    const to = this.episode?.to;
    return { line: to ? `escaping the fire to ${to.x} ${to.y} ${to.z}` : 'burning: eating' };
  }

  protected run(t: number): void {
    const me = this.d.position();
    if (!me) return;
    const to = fireEscape(this.d.grid, me);
    this.episode = { to, startAt: performance.now() };
    if (to) this.stats.escapes++;
    else this.stats.noEscape++;
    this.log.warn(`fire: burning and hurt at ${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(1)}; ${to ? `escaping to ${to.x} ${to.y} ${to.z}` : 'no safe cell within 6 blocks'}`);
    void (async () => {
      if (to) await this.d.mover.goto({ type: 'block', p: to }, { timeoutTicks: 120, sprint: true });
      if (t !== this.token) return;
      if (this.d.eat && performance.now() - this.ateAt > 10_000) {
        this.ateAt = performance.now();
        this.stats.eats++;
        await this.d.eat().catch(() => undefined);
      }
      if (t !== this.token) return;
      this.episode = undefined;
      this.yieldControl();
    })();
  }

  protected halt(): void {
    this.d.mover.cancel();
  }

  protected override reset(): void {
    this.episode = undefined;
  }
}
