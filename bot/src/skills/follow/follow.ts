// Follow and come (PLAN.md task 7.5, docs/pve.md).
//
//   const follow = new FollowController({ loop, mover: skills, entities: () => world.entities });
//   void follow.follow({ playerName: 'Steve' });   // runs until stop(); resolves { ok: true, reason: 'stopped' }
//   await follow.come('Steve');                    // one goto to within 2 blocks of where Steve is now
//
// follow(), driven from the InputLoop's before-step hook:
// - target in the tracked entities: farther than `stopDistance` (3) -> navigator `near` goal of that
//   radius around the target's feet, re-planned when the target moved more than `replanDistance` (2)
//   since the last plan; sprint when farther than `sprintDistance` (8); within `stopDistance` -> stop
//   and face the target;
// - target gone from the tracked set (out of view, dimension change, logged off): walk to the last
//   known position and wait there; resume as soon as it is tracked again.
// Players are found by the username from add_player (case-insensitive, formatting codes stripped);
// mobs by runtime id.
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import type { MoveCommand } from '../input/types.ts';
import { turnTowards, yawTowards } from '../nav/follower.ts';
import type { Goal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { entityFeet } from '../combat/hostiles.ts';

export type FollowTarget = { runtimeId: bigint } | { playerName: string };

export interface FollowLoop {
  readonly state: { pos: Vec3; ready: boolean; inWater?: boolean };
  readonly command: Readonly<MoveCommand>;
  setCommand(c: Partial<MoveCommand>): void;
  onBeforeStep(fn: (tick: bigint, state: { pos: Vec3; ready: boolean; inWater?: boolean }) => void): () => void;
}

export interface FollowMover {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  cancel(): void;
  readonly nav: { readonly busy: boolean };
}

export interface FollowDeps {
  loop: FollowLoop;
  mover: FollowMover;
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  logger?: Logger;
}

export interface FollowOptions {
  /** Stop within this distance (blocks, 3D to the target's feet). Default 3. */
  stopDistance?: number;
  /** Re-plan when the target moved more than this since the last plan. Default 2. */
  replanDistance?: number;
  /** Sprint when farther than this. Default 8. */
  sprintDistance?: number;
}

export type FollowState = 'idle' | 'following' | 'close' | 'lost' | 'waiting';

export interface FollowResult {
  ok: boolean;
  reason: 'stopped' | (string & {});
  ticks: number;
  plans: number;
  /** Largest distance to the target seen while it was tracked (after the first arrival). */
  maxDistance: number;
}

/** `Steve§r` / `§aSteve` -> `steve`. */
export function cleanName(name: string): string {
  return name.replace(/§./g, '').trim().toLowerCase();
}

/** The tracked player called `name`, if any. */
export function findPlayer(entities: ReadonlyMap<bigint, EntityInfo>, name: string): EntityInfo | undefined {
  const want = cleanName(name);
  for (const e of entities.values()) if (e.username !== undefined && cleanName(e.username) === want) return e;
  return undefined;
}

interface Active {
  target: FollowTarget;
  o: Required<FollowOptions>;
  t: number;
  state: FollowState;
  planAt: Vec3 | undefined;
  planT: number;
  /** The latest plan's goto reached its goal. */
  planOk: boolean;
  plans: number;
  lastKnown: Vec3 | undefined;
  preJump: Vec3 | undefined;
  jumpT: number;
  goingToLast: boolean;
  arrived: boolean;
  maxDistance: number;
  failUntil: number;
  /** Track W1: in water with nothing driving, the jump key held (treading water at the surface instead of sinking). */
  treading: boolean;
  /** Track W1: the last tick the body was in water (a bob at the surface leaves the water physics for a few ticks). */
  wetAt: number;
  resolve: (r: FollowResult) => void;
}

export class FollowController {
  private readonly d: FollowDeps;
  private readonly log: Logger;
  private active: Active | undefined;
  private readonly unsub: () => void;

  constructor(deps: FollowDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.unsub = deps.loop.onBeforeStep((_t, s) => {
      this.onTick(s);
    });
  }

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** What is followed, for status lines: a player name or `<type> #<runtime id>`. */
  get label(): string | undefined {
    const a = this.active;
    if (!a) return undefined;
    return describe(a.target, this.d.entities());
  }

  status(): { state: FollowState; target: string | null; distance: number | null; lastKnown: Vec3 | null; plans: number } {
    const a = this.active;
    if (!a) return { state: 'idle', target: null, distance: null, lastKnown: null, plans: 0 };
    const e = this.resolve(a.target);
    const p = this.d.loop.state.pos;
    const f = e ? entityFeet(e) : undefined;
    return { state: a.state, target: this.label ?? null, distance: f ? +dist(p, f).toFixed(2) : null, lastKnown: a.lastKnown ?? null, plans: a.plans };
  }

  dispose(): void {
    this.stop();
    this.unsub();
  }

  /** Stop following (resolves the follow() promise with 'stopped'). */
  stop(): void {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    if (this.d.mover.nav.busy) this.d.mover.cancel();
    a.resolve({ ok: true, reason: 'stopped', ticks: a.t, plans: a.plans, maxDistance: +a.maxDistance.toFixed(2) });
  }

  /** Follow until stop(). Replaces a running follow. */
  follow(target: FollowTarget, opts: FollowOptions = {}): Promise<FollowResult> {
    this.stop();
    this.log.info(`follow: following ${describe(target, this.d.entities())}`);
    return new Promise((resolve) => {
      this.active = {
        target,
        o: { stopDistance: opts.stopDistance ?? 3, replanDistance: opts.replanDistance ?? 2, sprintDistance: opts.sprintDistance ?? 8 },
        t: 0,
        state: 'following',
        planAt: undefined,
        planT: -Infinity,
        planOk: false,
        plans: 0,
        lastKnown: undefined,
        preJump: undefined,
        jumpT: -Infinity,
        goingToLast: false,
        arrived: false,
        maxDistance: 0,
        failUntil: 0,
        treading: false,
        wetAt: -Infinity,
        resolve,
      };
    });
  }

  /**
   * One-shot: walk to within `radius` (default 2) of the player's current position. Resolves
   * `{ ok: false, reason: 'not_found' }` when no such player is tracked.
   */
  come(playerName: string, opts: { radius?: number; timeoutTicks?: number } = {}): Promise<SkillResult> {
    this.stop();
    const e = findPlayer(this.d.entities(), playerName);
    if (!e) return Promise.resolve({ ok: false, reason: 'not_found' });
    const f = entityFeet(e);
    const here = this.d.loop.state.pos;
    this.log.info(`come: walking to ${playerName} at ${f.x.toFixed(1)} ${f.y.toFixed(1)} ${f.z.toFixed(1)}`);
    return this.d.mover.goto({ type: 'near', p: { x: f.x, y: Math.round(f.y), z: f.z }, r: opts.radius ?? 2 }, { timeoutTicks: opts.timeoutTicks ?? 1200, sprint: dist(here, f) > 8 });
  }

  private resolve(t: FollowTarget): EntityInfo | undefined {
    const ents = this.d.entities();
    return 'runtimeId' in t ? ents.get(t.runtimeId) : findPlayer(ents, t.playerName);
  }

  private onTick(s: { pos: Vec3; ready: boolean; inWater?: boolean }): void {
    const a = this.active;
    if (!a || !s.ready) return;
    // Track W1: treading water stops once the body is out of it or the navigator drives again
    if (a.treading && (s.inWater !== true || this.d.mover.nav.busy)) {
      a.treading = false;
      if (!this.d.mover.nav.busy) this.d.loop.setCommand({ jump: false });
    }
    a.t++;
    this.track(a, s);
    // Track W1: in water with nothing driving the body (close to the target, a goal reached while the target drifts
    // less than replanDistance, a failed plan's pause, at the last known position): tread water. The jump key keeps
    // the head at the surface; without it the body sank to the bottom while it waited (the Realm 2026-11-06, and
    // bds-fly: 155 air gone on a pool's floor 3.0 blocks from a swimming target)
    if (this.active === a && s.inWater === true && !this.d.mover.nav.busy) {
      a.treading = true;
      this.d.loop.setCommand({ jump: true, forward: 0, sneak: false, sprint: false });
    }
  }

  /** Follow the target one tick: close, re-plan, or go to its last known position. */
  private track(a: Active, s: { pos: Vec3; ready: boolean; inWater?: boolean }): void {
    const e = this.resolve(a.target);
    const mover = this.d.mover;
    if (e) {
      const f = entityFeet(e);
      if (a.lastKnown && dist(a.lastKnown, f) > JUMP) {
        // a teleport: if the target disappears right after it, go where it was before the jump
        a.preJump = a.lastKnown;
        a.jumpT = a.t;
      }
      a.lastKnown = f;
      a.goingToLast = false;
      const d = dist(s.pos, f);
      if (a.arrived) a.maxDistance = Math.max(a.maxDistance, d);
      // Track W1: in water a walk in progress is not cut short at the stop distance (it ends on the bank for a
      // target on land, at the surface for a swimming one: the planner's goal rule), and bobbing at the surface
      // (up to 0.9 a bob) does not toggle `close` (a cancelled walk every few ticks on bds-fly)
      if (s.inWater === true) a.wetAt = a.t;
      const wet = a.t - a.wetAt <= WET_MEMORY;
      const closeAt = a.o.stopDistance + (wet && a.state === 'close' ? WATER_CLOSE_SLACK : 0);
      if (d <= closeAt && !(wet && mover.nav.busy && a.state !== 'close')) {
        a.arrived = true;
        if (a.state !== 'close') {
          a.state = 'close';
          if (mover.nav.busy) mover.cancel();
          a.planAt = undefined;
        }
        // face the target
        const loop = this.d.loop;
        if (Math.hypot(f.x - s.pos.x, f.z - s.pos.z) > 0.3) loop.setCommand({ yaw: turnTowards(loop.command.yaw, yawTowards(f.x - s.pos.x, f.z - s.pos.z), 20) });
        return;
      }
      a.state = 'following';
      const moved = a.planAt ? dist(a.planAt, f) : Infinity;
      if (a.t < a.failUntil) return;
      // re-plan when the target moved more than replanDistance, or the last walk ended without
      // reaching the goal; a goal reached for this target position (3D distance just over the stop
      // distance while the `near` goal counts node centres) needs no new walk
      // (Track W1: and the body is still within a block of the stop distance: a target that drifted less than
      // replanDistance but away, as a swimmer does, is followed again instead of watched from 4.4 blocks for good)
      const settled = a.planOk && moved <= a.o.replanDistance && d <= a.o.stopDistance + SETTLED_SLACK;
      if (((!mover.nav.busy && !settled) || moved > a.o.replanDistance) && a.t - a.planT >= 5) this.plan(a, f, a.o.stopDistance, d > a.o.sprintDistance);
      return;
    }
    // lost: go to the last known position once, then wait there
    if (!a.lastKnown) {
      a.state = 'waiting';
      return;
    }
    if (!a.goingToLast && a.state !== 'waiting') {
      a.goingToLast = true;
      a.state = 'lost';
      // teleported away and then dropped from view within 2 s: its last position is not a place
      // anybody walked to; use where it was before the jump
      const to = a.preJump && a.t - a.jumpT <= 40 ? a.preJump : a.lastKnown;
      a.lastKnown = to;
      this.log.info(`follow: target out of view, going to its last known position ${to.x.toFixed(1)} ${to.y.toFixed(1)} ${to.z.toFixed(1)}`);
      this.plan(a, to, 1.5, dist(s.pos, to) > a.o.sprintDistance);
      return;
    }
    if (a.state === 'lost' && !mover.nav.busy) a.state = 'waiting';
  }

  private plan(a: Active, p: Vec3, r: number, sprint: boolean): void {
    a.planAt = { ...p };
    a.planT = a.t;
    a.planOk = false;
    const n = ++a.plans;
    void this.d.mover.goto({ type: 'near', p: { x: p.x, y: Math.round(p.y), z: p.z }, r }, { timeoutTicks: 600, sprint }).then((res) => {
      if (this.active !== a || a.plans !== n) return;
      a.planOk = res.ok;
      if (!res.ok && res.reason === 'unreachable') {
        // wait a second before trying again
        a.failUntil = a.t + 20;
        a.planAt = undefined;
      }
    });
  }
}

/** A move longer than this between two ticks is a teleport. */
const JUMP = 8;
/** Track W1: in water `close` holds to the stop distance plus this (the body bobs at the surface). */
const WATER_CLOSE_SLACK = 1;
/** Track W1: the body counts as in water this many ticks after it left the water physics (a bob's top). */
const WET_MEMORY = 10;
/** Track W1: a reached goal counts as settled while the body is within the stop distance plus this. */
const SETTLED_SLACK = 1;

function describe(t: FollowTarget, ents: ReadonlyMap<bigint, EntityInfo>): string {
  if ('playerName' in t) return t.playerName;
  const e = ents.get(t.runtimeId);
  return `${e ? e.type.replace(/^minecraft:/, '') : 'entity'} #${t.runtimeId}`;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
