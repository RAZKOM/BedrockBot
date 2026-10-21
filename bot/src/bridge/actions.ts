// Action executor for action space v1 (PLAN.md section 9). Each action runs to completion or is
// cancelled after ACTION_TICK_CAP ticks; actions never overlap (the bridge awaits each one fully, and
// goto and dig both set yaw/pitch, so they must not run at the same time).
//
//   noop              wait NOOP_TICKS
//   goto_nearest_log  path to within GOTO_RADIUS of the nearest natural log (world model), then look at it
//   dig_facing_block  ray from the eye along the view (reach 5): dig the first non-air, non-liquid block
//   collect_drops     walk over item drops within COLLECT_RADIUS
//   turn_left/right   yaw -/+ TURN_DEG, pitch 0 (Bedrock yaw grows clockwise seen from above)
//   step_forward      hold forward until the body moved 1 block (or is blocked), then stop
//   jump_forward      forward + one jump (climbs a 1-block step), then stop
import { DEFAULT_REACH, EYE_HEIGHT, blockCenter } from '../skills/dig/look.ts';
import type { MoveCommand } from '../skills/input/types.ts';
import type { Goal, GotoOptions, SkillResult } from '../skills/types.ts';
import type { BlockInfo, Vec3 } from '../world/types.ts';
import { blockClass, nearestLog, type ObsWorld } from './observation.ts';
import type { Action, ActionKind } from './schema.ts';

export const ACTION_TICK_CAP = 100;
export const NOOP_TICKS = 10;
export const TURN_DEG = 45;
export const GOTO_RADIUS = 3;
export const COLLECT_RADIUS = 8;
/** Horizontal distance that counts as one step. */
export const STEP_DISTANCE = 1;

export interface ActionLoop {
  readonly state: { pos: Vec3; vel: Vec3; onGround: boolean; collidedHorizontally: boolean; tick: bigint; ready: boolean };
  readonly command: Readonly<Pick<MoveCommand, 'yaw' | 'pitch'>>;
  setCommand(c: Partial<MoveCommand>): void;
  release(): void;
  waitTicks(n: number): Promise<void>;
}

/** Skills as the executor needs them (BotSkills + a digger / collect fallback, see tasks/rlAgent.ts). */
export interface ActionSkills {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  lookAt(p: Vec3): Promise<void>;
  dig(p: Vec3): Promise<SkillResult>;
  collect(radius: number, timeoutTicks: number): Promise<SkillResult>;
  /** Cancel whatever goto / look / dig / collect is running. */
  cancel(): void;
}

export interface ActionResult { ok: boolean; reason?: string; action: ActionKind; ticks: number; target?: Vec3 }

/** Unit view vector (yaw 0 = +z, 90 = -x; pitch 90 = down). */
export function viewVector(yaw: number, pitch: number): Vec3 {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
}

/**
 * First block along a ray (Amanatides-Woo voxel walk) for which `hit` is true, within `maxDist`.
 * Returns undefined when nothing is hit or a block is not loaded.
 */
export function raycast(blockAt: (p: Vec3) => BlockInfo | undefined, from: Vec3, dir: Vec3, maxDist: number, hit: (b: BlockInfo) => boolean): Vec3 | undefined {
  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  let z = Math.floor(from.z);
  const step = { x: Math.sign(dir.x), y: Math.sign(dir.y), z: Math.sign(dir.z) };
  const tDelta = { x: dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity, y: dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity, z: dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity };
  const frac = (v: number, s: number) => (s > 0 ? Math.floor(v) + 1 - v : v - Math.floor(v));
  const tMax = { x: dir.x !== 0 ? frac(from.x, step.x) * tDelta.x : Infinity, y: dir.y !== 0 ? frac(from.y, step.y) * tDelta.y : Infinity, z: dir.z !== 0 ? frac(from.z, step.z) * tDelta.z : Infinity };
  for (let i = 0; i < 64; i++) {
    let t: number;
    if (tMax.x <= tMax.y && tMax.x <= tMax.z) {
      t = tMax.x;
      x += step.x;
      tMax.x += tDelta.x;
    } else if (tMax.y <= tMax.z) {
      t = tMax.y;
      y += step.y;
      tMax.y += tDelta.y;
    } else {
      t = tMax.z;
      z += step.z;
      tMax.z += tDelta.z;
    }
    if (t > maxDist) return undefined;
    const p = { x, y, z };
    const b = blockAt(p);
    if (!b) return undefined;
    if (hit(b)) return p;
  }
  return undefined;
}

/** Diggable target for dig_facing_block: anything but air and liquids. */
export function isDigTarget(b: BlockInfo): boolean {
  const c = blockClass(b);
  return c !== 'air' && c !== 'water' && c !== 'lava' && c !== 'unknown';
}

const hdist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

export class ActionExecutor {
  private readonly world: ObsWorld;
  private readonly loop: ActionLoop;
  private readonly skills: ActionSkills;
  private running = false;

  constructor(deps: { world: ObsWorld; loop: ActionLoop; skills: ActionSkills }) {
    this.world = deps.world;
    this.loop = deps.loop;
    this.skills = deps.skills;
  }

  get busy(): boolean {
    return this.running;
  }

  async run(action: Action): Promise<ActionResult> {
    if (this.running) return { ok: false, reason: 'busy', action: action.kind, ticks: 0 };
    this.running = true;
    const t0 = this.loop.state.tick;
    try {
      const r = await this.dispatch(action);
      return { ...r, action: action.kind, ticks: Number(this.loop.state.tick - t0) };
    } catch (e) {
      this.skills.cancel();
      this.loop.release();
      return { ok: false, reason: `error: ${e instanceof Error ? e.message : String(e)}`, action: action.kind, ticks: Number(this.loop.state.tick - t0) };
    } finally {
      this.running = false;
    }
  }

  private async dispatch(a: Action): Promise<Omit<ActionResult, 'action' | 'ticks'>> {
    switch (a.kind) {
      case 'noop':
        await this.loop.waitTicks(NOOP_TICKS);
        return { ok: true };
      case 'goto_nearest_log':
        return this.gotoNearest(a.block);
      case 'dig_facing_block':
        return this.digFacing();
      case 'collect_drops':
        return this.capped((left) => this.skills.collect(COLLECT_RADIUS, left));
      case 'turn_left':
        return this.turn(-TURN_DEG);
      case 'turn_right':
        return this.turn(TURN_DEG);
      case 'step_forward':
        return this.move(false);
      case 'jump_forward':
        return this.move(true);
    }
  }

  /** Runs a skill, cancelling it once ACTION_TICK_CAP ticks have passed since `start`. */
  private async capped(fn: (ticksLeft: number) => Promise<SkillResult>, start = this.loop.state.tick): Promise<SkillResult> {
    const used = Number(this.loop.state.tick - start);
    const left = ACTION_TICK_CAP - used;
    if (left <= 0) return { ok: false, reason: 'timeout' };
    let finished = false;
    let capHit = false;
    void this.loop.waitTicks(left).then(() => {
      if (finished) return;
      capHit = true;
      this.skills.cancel();
    });
    try {
      const r = await fn(left);
      return capHit && !r.ok ? { ok: false, reason: 'timeout' } : r;
    } finally {
      finished = true;
    }
  }

  private async gotoNearest(block: string): Promise<SkillResult & { target?: Vec3 }> {
    const start = this.loop.state.tick;
    const n = nearestLog(this.world, this.loop.state.pos, block);
    if (!n) {
      await this.loop.waitTicks(1);
      return { ok: false, reason: 'no_log' };
    }
    const goal: Goal = { type: 'near', p: { x: n.p.x + 0.5, y: n.p.y, z: n.p.z + 0.5 }, r: GOTO_RADIUS };
    const r = await this.capped((left) => this.skills.goto(goal, { timeoutTicks: left, sprint: false }), start);
    if (!r.ok) return { ...r, target: n.p };
    // Face the log so dig_facing_block hits it.
    const look = await this.capped(async () => {
      await this.skills.lookAt(blockCenter(n.p));
      return { ok: true };
    }, start);
    return { ...look, target: n.p };
  }

  private async digFacing(): Promise<SkillResult & { target?: Vec3 }> {
    const start = this.loop.state.tick;
    const s = this.loop.state;
    const c = this.loop.command;
    const eye = { x: s.pos.x, y: s.pos.y + EYE_HEIGHT, z: s.pos.z };
    const p = raycast((q) => this.world.blockAt(q), eye, viewVector(c.yaw, c.pitch), DEFAULT_REACH, isDigTarget);
    if (!p) {
      await this.loop.waitTicks(1);
      return { ok: false, reason: 'no_block' };
    }
    const r = await this.capped(() => this.skills.dig(p), start);
    return { ...r, target: p };
  }

  private async turn(deg: number): Promise<SkillResult> {
    const yaw = this.loop.command.yaw + deg;
    this.loop.setCommand({ yaw: ((yaw % 360) + 360) % 360, pitch: 0 });
    await this.loop.waitTicks(2);
    return { ok: true };
  }

  /** step_forward / jump_forward with raw inputs; stops once moved STEP_DISTANCE, blocked, or landed. */
  private async move(jump: boolean): Promise<SkillResult> {
    const start = this.loop.state.tick;
    const from = { ...this.loop.state.pos };
    const elapsed = () => Number(this.loop.state.tick - start);
    this.loop.setCommand({ forward: 1, strafe: 0, jump, sprint: false, sneak: false });
    let leftGround = false;
    let blockedTicks = 0;
    try {
      while (elapsed() < 40) {
        await this.loop.waitTicks(1);
        const s = this.loop.state;
        if (jump && elapsed() >= 2) this.loop.setCommand({ jump: false });
        if (!s.onGround) leftGround = true;
        const moved = hdist(s.pos, from);
        if (!jump && moved >= STEP_DISTANCE) break;
        if (jump && leftGround && s.onGround && moved >= 0.5) break;
        if (jump && !leftGround && elapsed() >= 6) break; // could not jump (ceiling)
        blockedTicks = s.collidedHorizontally && Math.hypot(s.vel.x, s.vel.z) < 0.01 ? blockedTicks + 1 : 0;
        if (blockedTicks >= 4 && (!jump || s.onGround)) break;
      }
    } finally {
      this.loop.release();
    }
    // Let the body come to rest (ground friction) so the next observation is stable.
    for (let i = 0; i < 10 && elapsed() < ACTION_TICK_CAP; i++) {
      const s = this.loop.state;
      if (s.onGround && Math.hypot(s.vel.x, s.vel.z) < 0.003) break;
      await this.loop.waitTicks(1);
    }
    const moved = hdist(this.loop.state.pos, from);
    const climbed = this.loop.state.pos.y - from.y;
    if (moved >= 0.5 || climbed >= 0.5) return { ok: true };
    return { ok: false, reason: 'blocked' };
  }
}
