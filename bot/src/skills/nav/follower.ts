// Path following (PLAN.md tasks 3.3 / 3.4): turns a node path into per-tick MoveCommands.
//
// - Steering: aim at the farthest node (up to 6 ahead) that can be reached in a straight line on the
//   same feet height (every sample of the body's footprint along the line is standable at that
//   height); turn towards it at most `maxTurnDeg` per tick; hold `forward` while the aim is within
//   50 degrees of the view.
// - Jumps: press jump when on the ground, facing the step and within 1.4 blocks of the next node (or
//   pushing against its face).
// - Drops: approach the edge at reduced speed (forward pulsed above 0.12 blocks/tick) and steer in
//   the air only while the air drift (about 10 x speed) would not carry the body past the landing.
// - Sprint: on straight walkable runs longer than 5 blocks, facing within 15 degrees; never into a
//   jump, a drop or the final stop.
// - Final stop: release forward once the coasting distance (speed x 0.546 / (1 - 0.546)) covers the
//   remaining distance; done when on the ground within `arriveRadius` of the last node's centre and
//   (almost) stopped.
import type { MoveCommand, Vec3 } from '../input/types.ts';
import type { PathNode } from './astar.ts';
import type { NavGrid } from './grid.ts';

export interface FollowerOptions {
  /** Allow sprinting on long straight runs. Default true. */
  sprint?: boolean;
  /** Max yaw change per tick (degrees). Default 30. */
  maxTurnDeg?: number;
  /** Horizontal distance to the last node's centre that counts as arrived. Default 0.3. */
  arriveRadius?: number;
  /** Stop on the last node (a complete path) or just reach it (a partial path, a replan follows). Default true. */
  stopAtEnd?: boolean;
  /** Shared across the followers of one goto (re-plans), so no double tap slips through a re-plan. */
  guard?: PressGuard;
  /** Track S: the plan's extra cost per cell (avoidance): straight-line shortcuts never cross cells costing more. */
  cellCost?: ((x: number, y: number, z: number) => number) | undefined;
}

/**
 * Forward-press book-keeping: a re-press within 6 steps of the previous press would be a double tap
 * (BDS starts sprinting on its own), so it is delayed. Apply to every command, once per tick.
 */
export class PressGuard {
  private n = 0;
  private lastPress = -Infinity;
  private prevForward = false;

  apply<T extends { forward: number; sprint: boolean }>(cmd: T): T {
    this.n++;
    let forward = cmd.forward > 0;
    if (forward && !this.prevForward) {
      if (this.n - this.lastPress <= DOUBLE_TAP_GUARD) forward = false;
      else this.lastPress = this.n;
    }
    this.prevForward = forward;
    return forward ? cmd : { ...cmd, forward: 0, sprint: false };
  }

  /** A tick without the follower (no forward). */
  idle(): void {
    this.n++;
    this.prevForward = false;
  }
}

export interface FollowerInput {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  collidedHorizontally: boolean;
  /** The body sprints (BDS keeps a sprint while forward is held). */
  sprinting?: boolean;
}

export interface FollowStep {
  cmd: Pick<MoveCommand, 'forward' | 'strafe' | 'yaw' | 'jump' | 'sprint' | 'sneak'>;
  done: boolean;
}

/** Ground coasting distance factor: inertia / (1 - inertia) with inertia 0.546. */
const GROUND_COAST = 0.546 / (1 - 0.546);
/** Air coasting distance factor with inertia 0.91. */
const AIR_COAST = 0.91 / (1 - 0.91);
const HALF = 0.31;
/** A forward re-press within this many steps of the previous press is delayed (BDS double tap: 6). */
const DOUBLE_TAP_GUARD = 7;

/** Bedrock yaw (degrees) that faces from (0, 0) along (dx, dz): 0 = +z, 90 = -x. */
export function yawTowards(dx: number, dz: number): number {
  return (Math.atan2(-dx, dz) * 180) / Math.PI;
}

/** Signed smallest difference b - a in degrees, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Turn `from` towards `to` by at most `max` degrees. */
export function turnTowards(from: number, to: number, max: number): number {
  const d = angleDiff(from, to);
  if (Math.abs(d) <= max) return to;
  return from + Math.sign(d) * max;
}

export class PathFollower {
  readonly path: readonly PathNode[];
  private readonly grid: NavGrid;
  private readonly sprint: boolean;
  private readonly maxTurn: number;
  private readonly arrive: number;
  readonly stopAtEnd: boolean;
  /** Index of the node being walked to (the aim; nodes before it may be skipped by straight lines). */
  index: number;
  /** Last node the body was inside. */
  private passed = 0;
  private readonly pressGuard: PressGuard;
  private yaw: number | undefined;
  /** suffix[i]: path length from node i to the end. */
  private readonly suffix: number[];
  private readonly cellCost: FollowerOptions['cellCost']; // Track S

  constructor(path: readonly PathNode[], grid: NavGrid, opts: FollowerOptions = {}) {
    if (path.length === 0) throw new Error('empty path');
    this.path = path;
    this.grid = grid;
    this.sprint = opts.sprint ?? true;
    this.maxTurn = opts.maxTurnDeg ?? 30;
    this.arrive = opts.arriveRadius ?? 0.3;
    this.stopAtEnd = opts.stopAtEnd ?? true;
    this.pressGuard = opts.guard ?? new PressGuard();
    this.cellCost = opts.cellCost; // Track S
    this.index = path.length > 1 ? 1 : 0;
    this.suffix = new Array<number>(path.length).fill(0);
    for (let i = path.length - 2; i >= 0; i--) {
      const a = path[i]!;
      const b = path[i + 1]!;
      this.suffix[i] = this.suffix[i + 1]! + Math.hypot(b.x - a.x, b.z - a.z, b.feet - a.feet);
    }
  }

  /** Progress measure for stuck detection: minus the remaining distance along the path (blocks). */
  progress(pos: Vec3): number {
    const n = this.path[this.index]!;
    return -(Math.hypot(n.x + 0.5 - pos.x, n.z + 0.5 - pos.z, n.feet - pos.y) + this.suffix[this.index]!);
  }

  /** Nodes not passed yet: from the last node the body was inside (it may still be on it) to the end. */
  remaining(): readonly PathNode[] {
    return this.path.slice(this.passed);
  }

  /** Index of the last node the body was inside. */
  get passedIndex(): number {
    return this.passed;
  }

  step(s: FollowerInput, currentYaw: number): FollowStep {
    const out = this.decide(s, currentYaw);
    return { ...out, cmd: this.pressGuard.apply(out.cmd) };
  }

  private decide(s: FollowerInput, currentYaw: number): FollowStep {
    const path = this.path;
    const last = path.length - 1;
    const p = s.pos;
    this.yaw ??= currentYaw;

    // Advance past nodes the body is in (and can leave towards the next one).
    while (this.index < last) {
      const node = path[this.index]!;
      if (!this.inNode(p, node, s.onGround)) break;
      const centred = Math.hypot(node.x + 0.5 - p.x, node.z + 0.5 - p.z) < 0.35;
      if (!centred && !this.lineClear(p, this.index + 1)) break;
      this.index++;
    }

    for (let k = this.passed + 1; k <= Math.min(this.index, last); k++) if (this.inNode(p, path[k]!, true)) this.passed = k;

    const target = path[this.index]!;
    const finalLeg = this.index === last;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const dTarget = Math.hypot(target.x + 0.5 - p.x, target.z + 0.5 - p.z);

    if (finalLeg) {
      const there = dTarget <= this.arrive && Math.abs(p.y - target.feet) < 0.6 && s.onGround;
      if (there && (!this.stopAtEnd || speed < 0.03)) return { cmd: this.idle(), done: true };
      if (!this.stopAtEnd && this.inNode(p, target, s.onGround)) return { cmd: this.idle(), done: true };
    }

    // Aim: the farthest straight-line node on the same level.
    let aim = this.index;
    if (s.onGround && (target.move === 'walk' || target.move === 'diag') && Math.abs(p.y - target.feet) < 1e-3) {
      for (let j = this.index + 1; j <= Math.min(this.index + 6, last); j++) {
        const n = path[j]!;
        if ((n.move !== 'walk' && n.move !== 'diag') || Math.abs(n.feet - target.feet) > 1e-6) break;
        if (!this.lineClear(p, j)) break;
        aim = j;
      }
      // pure pursuit: the nodes before the aim are passed (the straight line to it is clear)
      this.index = aim;
    }
    const a = path[aim]!;
    const dx = a.x + 0.5 - p.x;
    const dz = a.z + 0.5 - p.z;
    const dAim = Math.hypot(dx, dz);
    if (dAim > 0.05) this.yaw = turnTowards(this.yaw, yawTowards(dx, dz), this.maxTurn);
    const err = dAim > 0.05 ? Math.abs(angleDiff(this.yaw, yawTowards(dx, dz))) : 0;

    let forward = err < 50 ? 1 : 0;
    let jump = false;
    let sprint = false;

    if (finalLeg && this.stopAtEnd) {
      // brake: coast the rest
      if (dTarget - speed * GROUND_COAST < 0.12 || dTarget <= this.arrive) forward = 0;
      if (dTarget < 1 && err > 30) forward = 0;
    }

    // (not once the body is up at the target's height: landed off-centre on the step, it walks on)
    if (target.move === 'jump' && s.onGround && err < 25 && p.y < target.feet - 1e-3) {
      if (dTarget <= 1.4 || s.collidedHorizontally) jump = true;
    }

    if (target.move === 'drop') {
      if (s.onGround) {
        // creep off the edge
        if (speed > 0.12 && dTarget < 1.2) forward = 0;
      } else if (dTarget - speed * AIR_COAST < 0.05) {
        forward = 0;
      }
    }

    if (this.sprint && forward === 1 && s.onGround && err < 15 && this.runLength(p) > 5) sprint = true;
    // BDS keeps a sprint while forward is held: releasing forward for one tick is what ends it
    if (s.sprinting && !sprint && forward === 1 && s.onGround) forward = 0;

    return { cmd: { forward, strafe: 0, yaw: this.yaw, jump, sprint, sneak: false }, done: false };
  }



  private idle(): FollowStep['cmd'] {
    return { forward: 0, strafe: 0, yaw: this.yaw ?? 0, jump: false, sprint: false, sneak: false };
  }

  private inNode(p: Vec3, node: PathNode, onGround: boolean): boolean {
    if (Math.floor(p.x) !== node.x || Math.floor(p.z) !== node.z) return false;
    if (Math.abs(p.y - node.feet) >= 0.6) return false;
    if ((node.move === 'jump' || node.move === 'drop' || node.move === 'pillar') && !onGround) return false;
    return true;
  }

  /**
   * The straight line from `p` to node j's centre keeps the body's footprint on cells standable at
   * that node's feet height (sampled every 0.2 blocks, footprint half-width 0.31).
   */
  private lineClear(p: Vec3, j: number): boolean {
    const n = this.path[j]!;
    if (n.move !== 'walk' && n.move !== 'diag') return false;
    const feet = n.feet;
    if (Math.abs(p.y - feet) > 1e-3) return false;
    const tx = n.x + 0.5;
    const tz = n.z + 0.5;
    const len = Math.hypot(tx - p.x, tz - p.z);
    const steps = Math.max(1, Math.ceil(len / 0.2));
    for (let i = 0; i <= steps; i++) {
      const sx = p.x + ((tx - p.x) * i) / steps;
      const sz = p.z + ((tz - p.z) * i) / steps;
      for (const [ox, oz] of [
        [-HALF, -HALF],
        [-HALF, HALF],
        [HALF, -HALF],
        [HALF, HALF],
      ] as const) {
        const f = this.grid.stand(Math.floor(sx + ox), n.y, Math.floor(sz + oz));
        if (f === undefined || Number.isNaN(f) || Math.abs(f - feet) > 1e-6) return false;
      }
      // Track S: no shortcut through cells the planner penalised more than the nodes it skips (avoidance)
      if (this.cellCost && this.cellCost(Math.floor(sx), n.y, Math.floor(sz)) > this.skippedCost(j) + 1e-9) return false;
    }
    return true;
  }

  /** Track S: the highest extra cost among the path nodes from the current one to j. */
  private skippedCost(j: number): number {
    let m = 0;
    for (let k = Math.max(0, this.index - 1); k <= j; k++) m = Math.max(m, this.cellCost!(this.path[k]!.x, this.path[k]!.y, this.path[k]!.z));
    return m;
  }

  /** Straight-ish walkable distance ahead before a jump, a drop or the end of the path. */
  private runLength(p: Vec3): number {
    const path = this.path;
    let prev = { x: p.x, z: p.z };
    let total = 0;
    for (let i = this.index; i < path.length; i++) {
      const n = path[i]!;
      if (n.move !== 'walk' && n.move !== 'diag') return total - 3;
      const c = { x: n.x + 0.5, z: n.z + 0.5 };
      total += Math.hypot(c.x - prev.x, c.z - prev.z);
      prev = c;
      if (total > 8) return total;
    }
    return this.stopAtEnd ? total - 3 : total;
  }
}
