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
// - Track AJ (docs/pathfinding.md "Movement variety"): swim / swimOut / climb / climbOut / parkour
//   targets have their own controllers (`variety`); on walks the body sneaks while its centre is
//   within 0.3 of an edge with a drop of more than 3 blocks (or lava) beyond (`edgeSneak`), and does
//   not sprint for 10 ticks after a sneak.
import type { MoveCommand, Vec3 } from '../input/types.ts';
import type { PathNode } from './astar.ts';
import { isPanel, type NavGrid } from './grid.ts';
import { PHYSICS } from '../input/physics.ts'; // Track BG

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
  /** Track AJ: sneak while the body centre is within 0.3 of an edge with a drop of more than 3 blocks (or lava) beyond. Default true. */
  edgeSneak?: boolean;
}

/**
 * Forward-press book-keeping: a re-press within 6 steps of the previous press would be a double tap
 * (BDS starts sprinting on its own), so it is delayed. Apply to every command, once per tick.
 */
export class PressGuard {
  private n = 0;
  private lastPress = -Infinity;
  private prevForward = false;
  /** Track AJ: commands since the last one with sneak held (across the followers of one goto). */
  sinceSneak = Infinity;

  apply<T extends { forward: number; sprint: boolean; sneak?: boolean }>(cmd: T): T {
    this.n++;
    this.sinceSneak = cmd.sneak ? 0 : this.sinceSneak + 1;
    if (cmd.forward < 0) {
      // Track AJ: the back key (braking on a ladder) is no forward press
      this.prevForward = false;
      return cmd;
    }
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
  /** Track AJ: the body moves with water physics (InputLoopState.inWater). */
  inWater?: boolean;
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
/** Track AJ: a climb node is reached with the feet within this of its height. */
const CLIMB_TOLERANCE = 0.25;
/** Track BG: a climbing body is held this far off an open trapdoor's panel (the centring stops within 0.06 of its target). */
const PANEL_CLEAR = 0.08;
/** Track BG: in the tight gap of a panel opposite a ladder the target lies this far inside the box the body presses against. */
const PRESS = 0.1;
/** Track BG: dropping into the tight gap of a hatch panel opposite a ladder, the body is aligned within this of its middle first. */
const HATCH_ALIGN = 0.006;
/** Track BG: walking into such a hatch, forward is pressed only while the body is slower than this (blocks/tick). */
const HATCH_SPEED = 0.08;
/**
 * Track BG: how far one tick of forward from rest carries the body on default ground before it stops again:
 * 0.098 / (1 - 0.546). BDS takes only whole inputs (a fractional move vector is corrected, measured), so the
 * fine alignment is done with such single-tick pulses whose direction (the yaw) is chosen freely.
 */
const PULSE = (PHYSICS.walkSpeed * PHYSICS.impulseScale) / (1 - PHYSICS.groundFriction * PHYSICS.airInertia);
/** Track AJ: parkour: jump once the body centre is this far from the takeoff edge (walking / sprinting). */
const PARKOUR_JUMP_WALK = 0.15;
const PARKOUR_JUMP_SPRINT = 0.3;
/** Track AJ: a 2-block parkour needs at least this speed towards the gap at the takeoff (walking is 0.216, sprinting 0.281; else it backs up for a run-up). */
const PARKOUR_RUN_SPEED = 0.25;
/** Track AJ: sneak while the body centre is this close to an unsafe edge. */
const EDGE_SNEAK = 0.3;
/** Track AJ: no sprint for this many ticks after a sneak (BDS keeps walking; measured on 1.26.60). */
const SPRINT_AFTER_SNEAK = 10;
const CORNERS: readonly (readonly [number, number])[] = [
  [-HALF, -HALF],
  [-HALF, HALF],
  [HALF, -HALF],
  [HALF, HALF],
];

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
  /** Track AJ: edge sneaking, its per-column verdicts (cellKey-like string -> unsafe), and the ticks sneaked. */
  private readonly edgeSneak: boolean;
  private readonly unsafeCols = new Map<string, boolean>();
  sneakTicks = 0;
  /** Track AJ: a 2-block parkour backing up for its run-up (undefined: not decided yet). */
  private backing: boolean | undefined;
  /** Track BC: the path has sneak moves (the low-ceiling check runs only then). */
  private readonly hasSneak: boolean;

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
    this.edgeSneak = opts.edgeSneak ?? true; // Track AJ
    this.index = path.length > 1 ? 1 : 0;
    this.hasSneak = path.some((n) => n.move === 'sneak'); // Track BC
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

  // Track BE: the off-path checks (nav/baritone/executor.ts) leave these moves alone
  /**
   * Track BE: the move under way is one the navigator's off-path / skip-ahead checks must not judge:
   * the body in the air (a jump, a fall, an irreversible drop, a knock) or in water, or the target a
   * swim, a climb, a parkour gap (its run-up backs away from the path), a pillar.
   */
  checksPaused(s: Pick<FollowerInput, 'onGround' | 'inWater'>): boolean {
    if (!s.onGround || s.inWater === true || this.backing === true) return true;
    const m = this.path[this.index]!.move;
    return m === 'swim' || m === 'swimOut' || m === 'climb' || m === 'climbOut' || m === 'parkour' || m === 'pillar' || m === 'downward'; // Track BC: a dig-down drop (the body idles, then falls)
  }
  // Track BE end

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
      // Track AJ: a run of climb nodes in one column is reached at its end's height
      if (node.move === 'climb') {
        if (!this.climbReached(p, s.onGround, node)) break;
        this.index++;
        continue;
      }
      if (!this.inNode(p, node, s.onGround)) break;
      // Track AJ: swim nodes are passed without centring (the next one is aimed at in a straight line)
      if (node.move === 'swim') {
        this.index++;
        continue;
      }
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
      // Track BG: a leg that ends on a ladder (a hatch to open above or to close behind follows): held there sneaking
      if (target.move === 'climb' && !Number.isFinite(this.grid.stand(target.x, target.y, target.z)) && this.climbReached(p, s.onGround, target) && Math.abs(s.vel.y) < 0.1) {
        return { cmd: { ...this.idle(), sneak: true }, done: true };
      }
    }

    // Track AJ: swimming, climbing and parkour have their own controllers
    const variety = this.variety(s, target, finalLeg);
    if (variety) return { cmd: variety, done: false };

    // Track BC: a dig-down move (baritone/moves.ts `downward`): the block under the feet is gone (the
    // navigator's dig action ran before this leg) and the body drops into the node by itself; no key is
    // pressed until it stands there (a forward press would carry it out of the 1 x 1 shaft)
    if (target.move === 'downward') return { cmd: this.idle(), done: false };

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

    // Track AJ: edge sneaking: the body centre within 0.3 of an edge with a deep drop (or lava) beyond
    // Track BC: a sneak move (into, through or out of a cell the body only fits sneaking): sneak held for the whole move,
    // and until the whole footprint is out from under the low ceiling (released a step early, the server kept the body
    // crouched and slow for a tick while the local body stood up: 1 correction of 0.14 at the passage's exit)
    const sneak = target.move === 'sneak' || this.underLowCeiling(p, target.y) || (this.edgeSneak && s.onGround && !jump && (target.move === 'walk' || target.move === 'diag') && this.nearUnsafeEdge(p, target.y));
    if (sneak) {
      this.sneakTicks++;
    }

    // (BDS does not start a sprint right after a sneak: the server walks on while the client would sprint)
    if (this.sprint && this.pressGuard.sinceSneak > SPRINT_AFTER_SNEAK && forward === 1 && s.onGround && err < 15 && this.runLength(p) > 5) sprint = true;
    // BDS keeps a sprint while forward is held: releasing forward for one tick is what ends it
    if (s.sprinting && !sprint && forward === 1 && s.onGround) forward = 0;

    return { cmd: { forward, strafe: 0, yaw: this.yaw, jump, sprint, sneak }, done: false };
  }

  // ---- Track AJ: movement variety (docs/pathfinding.md "Movement variety") -------------------------

  /** Index of the last node of the climb run starting at i (consecutive 'climb' nodes in one column). */
  private climbRunEnd(i: number): number {
    const path = this.path;
    let j = i;
    while (j + 1 < path.length && path[j + 1]!.move === 'climb' && path[j + 1]!.x === path[i]!.x && path[j + 1]!.z === path[i]!.z) j++;
    return j;
  }

  /** The body is in node n's column at its height (a standing node at the foot: on the ground). */
  private climbReached(p: Vec3, onGround: boolean, n: PathNode): boolean {
    if (Math.floor(p.x) !== n.x || Math.floor(p.z) !== n.z) return false;
    if (Number.isFinite(this.grid.stand(n.x, n.y, n.z))) return onGround && Math.abs(p.y - n.feet) < 0.2;
    return Math.abs(p.y - n.feet) < CLIMB_TOLERANCE;
  }

  /**
   * Commands for swim / swimOut / climb / climbOut / parkour targets, undefined for the others.
   *
   * - swim: forward towards the farthest swim node in a straight line over swim cells, jump held in
   *   the water (the body bobs at the surface), never sprint (a sprint in water starts swimming).
   * - swimOut: forward towards the bank, jump held: pushing against the bank lifts the body out.
   * - climb: centre in the ladder's column (forward / back pulses), jump to climb (0.2 per tick),
   *   nothing to slide down (0.2 per tick), sneak to hold at the run's end.
   * - climbOut: climb (pushing towards the exit climbs as well) until the feet are at the exit's floor,
   *   then forward onto it (sneak holds the height for an exit at the feet level).
   * - parkour: forward (sprinting for a 2-block gap), jump once the body centre is `PARKOUR_JUMP` from
   *   the takeoff edge.
   */
  private variety(s: FollowerInput, target: PathNode, finalLeg: boolean): FollowStep['cmd'] | undefined {
    const p = s.pos;
    const m = target.move;
    if (m !== 'swim' && m !== 'swimOut' && m !== 'climb' && m !== 'climbOut' && m !== 'parkour') return undefined;
    const wet = s.inWater === true || this.grid.cls(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z))?.liquid === 'water';
    const cmd = { forward: 0, strafe: 0, yaw: this.yaw ?? 0, jump: false, sprint: false, sneak: false };
    if (m === 'swim') {
      // Track BG: still above the water (a drop into it, e.g. through a hatch): the entry node itself, not one beyond it
      const aim = p.y > target.feet + 1.2 ? this.index : this.swimAim(p);
      this.index = aim;
      const a = this.path[aim]!;
      this.steer(cmd, a.x + 0.5 - p.x, a.z + 0.5 - p.z);
      cmd.jump = wet || !s.onGround;
      if (s.sprinting && s.onGround) cmd.forward = 0; // end a sticky sprint before the water
      return cmd;
    }
    if (m === 'swimOut') {
      this.steer(cmd, target.x + 0.5 - p.x, target.z + 0.5 - p.z);
      cmd.jump = wet || (!s.onGround && p.y < target.feet);
      if (s.onGround && !wet) this.brake(cmd, s, target, finalLeg);
      return cmd;
    }
    if (m === 'climb') {
      const j = this.climbRunEnd(this.index);
      const end = this.path[j]!;
      const inCol = Math.floor(p.x) === end.x && Math.floor(p.z) === end.z;
      const dy = end.feet - p.y;
      if (s.onGround && dy < -0.5 && this.hatchEntry(cmd, s, end)) return cmd; // Track BG: the 0.63 gap of a hatch
      if (!inCol) {
        // into the column: walk towards its centre, slowly near it
        this.steer(cmd, end.x + 0.5 - p.x, end.z + 0.5 - p.z);
        const d = Math.hypot(end.x + 0.5 - p.x, end.z + 0.5 - p.z);
        if (d < 1 && Math.hypot(s.vel.x, s.vel.z) > 0.1) cmd.forward = 0;
        if (s.sprinting && s.onGround) cmd.forward = 0;
        return cmd;
      }
      // hold the column, clear of a ladder's box (touching it while sliding would climb)
      const [tx, tz, tight] = this.columnTarget(end.x, Math.floor(p.y + 1e-3), end.z, s.onGround && dy < -0.5 ? 'drop' : dy > 0.02 ? 'up' : 'down'); // Track BG: the mode
      // (Track BG: in the 0.63 gap of a hatch panel opposite the ladder the walk goes on in a straight line to its middle)
      if (s.onGround && dy < -0.5 && Math.hypot(tx - p.x, tz - p.z) > (tight ? 0.008 : 0.05)) {
        // still standing on the ladder's top: walk on until the body drops into the column (clear of the box)
        this.steer(cmd, tx - p.x, tz - p.z);
        if (Math.hypot(s.vel.x, s.vel.z) > 0.06) cmd.forward = 0; // slowly: the air carries the body on
        return cmd;
      }
      this.centre(cmd, s, tx, tz, true);
      if (dy > 0.02) cmd.jump = true;
      else if (dy > -CLIMB_TOLERANCE && !Number.isFinite(this.grid.stand(end.x, end.y, end.z))) cmd.sneak = true; // hold at the run's end
      return cmd;
    }
    if (m === 'climbOut') {
      const prev = this.path[Math.max(0, this.index - 1)]!;
      const inCol = Math.floor(p.x) === prev.x && Math.floor(p.z) === prev.z;
      const dy = target.feet - p.y;
      if (inCol && dy > 0.3) {
        // climb, pushing towards the exit (the push climbs as well)
        this.steer(cmd, target.x + 0.5 - p.x, target.z + 0.5 - p.z);
        cmd.jump = true;
        return cmd;
      }
      if (inCol && !s.onGround) {
        // fine: feet in [floor, floor + 0.15], then onto it
        if (dy > 0) cmd.jump = true;
        else if (dy > -0.15) cmd.sneak = true;
        if (dy < 0.02) this.steer(cmd, target.x + 0.5 - p.x, target.z + 0.5 - p.z);
        else this.centre(cmd, s, prev.x + 0.5, prev.z + 0.5);
        return cmd;
      }
      this.steer(cmd, target.x + 0.5 - p.x, target.z + 0.5 - p.z);
      if (s.onGround) this.brake(cmd, s, target, finalLeg);
      return cmd;
    }
    // parkour
    const g = target.gap;
    if (!g) return undefined;
    const dirX = Math.sign(target.x - g.x);
    const dirZ = Math.sign(target.z - g.z);
    // along the jump axis: the body centre's distance past the takeoff cell's centre (the edge is at 0.5)
    const along = (p.x - (g.x + 0.5)) * dirX + (p.z - (g.z + 0.5)) * dirZ;
    const lateral = Math.abs((p.x - (g.x + 0.5)) * dirZ) + Math.abs((p.z - (g.z + 0.5)) * dirX);
    if (g.sprint && s.onGround && Math.floor(p.y + 1e-3) === g.y) {
      // a 2-block gap needs the sprint run-up: without speed towards the gap, back up 2 blocks first
      const speedAlong = s.vel.x * dirX + s.vel.z * dirZ;
      if (this.backing === undefined && along > -1.2) this.backing = speedAlong < PARKOUR_RUN_SPEED; // decided once
      if (this.backing) {
        const rx = g.x + 0.5 - 2 * dirX;
        const rz = g.z + 0.5 - 2 * dirZ;
        if (Math.hypot(rx - p.x, rz - p.z) < 0.25) this.backing = false;
        else {
          this.steer(cmd, rx - p.x, rz - p.z);
          if (Math.hypot(rx - p.x, rz - p.z) < 0.8 && Math.hypot(s.vel.x, s.vel.z) > 0.08) cmd.forward = 0;
          return cmd;
        }
      }
    }
    this.steer(cmd, target.x + 0.5 - p.x, target.z + 0.5 - p.z, true);
    if (s.onGround && along < 0.5 + 0.3 && Math.floor(p.y + 1e-3) === g.y) {
      if (along >= 0.5 - (g.sprint ? PARKOUR_JUMP_SPRINT : PARKOUR_JUMP_WALK) && lateral < 0.25) cmd.jump = true;
      cmd.sprint = g.sprint && this.sprint;
    } else if (!s.onGround) {
      cmd.sprint = g.sprint && this.sprint;
    } else {
      this.brake(cmd, s, target, finalLeg);
    }
    return cmd;
  }

  /** Turn towards (dx, dz) and hold forward while roughly facing it (`straight`: no turning limit relief). */
  private steer(cmd: { forward: number; yaw: number }, dx: number, dz: number, straight = false): void {
    const d = Math.hypot(dx, dz);
    if (d > 0.05) this.yaw = turnTowards(this.yaw ?? cmd.yaw, yawTowards(dx, dz), this.maxTurn);
    cmd.yaw = this.yaw ?? cmd.yaw;
    const err = d > 0.05 ? Math.abs(angleDiff(cmd.yaw, yawTowards(dx, dz))) : 0;
    cmd.forward = err < (straight ? 20 : 50) ? 1 : 0;
  }

  /** Stop on the final node (coast out), as the walking controller does. */
  private brake(cmd: { forward: number }, s: FollowerInput, target: PathNode, finalLeg: boolean): void {
    if (!finalLeg || !this.stopAtEnd) return;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const d = Math.hypot(target.x + 0.5 - s.pos.x, target.z + 0.5 - s.pos.z);
    if (d - speed * GROUND_COAST < 0.12 || d <= this.arrive) cmd.forward = 0;
  }

  /**
   * Hold the body over (cx, cz) in a ladder's column: face the centre, forward when the speed towards
   * it is below a gentle target, back when above it (in the air the body accelerates by 0.02 per tick).
   */
  private centre(cmd: { forward: number; yaw: number }, s: FollowerInput, cx: number, cz: number, gentle = false): void {
    const dx = cx - s.pos.x;
    const dz = cz - s.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < (gentle ? 0.06 : 0.08) && Math.hypot(s.vel.x, s.vel.z) < 0.03) {
      cmd.forward = 0;
      return;
    }
    // Track BG2: a centre behind the body (an overshoot) is reached backing up, not after a turn of up to 180
    // degrees at 30 per tick with no input meanwhile: dropped into a hatch's column with some speed left, the
    // body hit the far side of the shaft during the turn (a ladder cell: the server climbs, a 0.72 correction)
    const back = d > 0.05 && Math.abs(angleDiff(this.yaw ?? cmd.yaw, yawTowards(dx, dz) + 180)) <= 60;
    if (d > 0.05) this.yaw = turnTowards(this.yaw ?? cmd.yaw, yawTowards(dx, dz) + (back ? 180 : 0), this.maxTurn);
    cmd.yaw = this.yaw ?? cmd.yaw;
    if (back) {
      const toward = (s.vel.x * dx + s.vel.z * dz) / d;
      const want = Math.min(0.08, d * 0.25);
      cmd.forward = toward < want - 0.01 ? -1 : toward > want + 0.02 ? 1 : 0;
      return;
    }
    if (Math.abs(angleDiff(cmd.yaw, yawTowards(dx, dz))) > 45) {
      cmd.forward = 0;
      return;
    }
    const toward = d > 1e-6 ? (s.vel.x * dx + s.vel.z * dz) / d : 0;
    const want = Math.min(0.08, d * 0.25);
    cmd.forward = toward < want - 0.01 ? 1 : toward > want + 0.02 ? -1 : 0;
  }

  /**
   * Track BG: dropping into a climber column through the tight gap of a hatch panel opposite the ladder (the
   * body's centre must be within 0.0125 of the gap's middle along that axis, or it stands on the ladder's top or
   * touches the panel, and a touch while falling into the ladder's cell climbs on BDS): at rest on the floor
   * beside the column, a single tick of forward (PULSE far) aimed so that its share along the tight axis is the
   * offset (the rest goes along the free axis, away from the column when near it), until the offset is within
   * HATCH_ALIGN; then walking straight in, the yaw exactly on the free axis, forward pressed only below
   * HATCH_SPEED. False when the column is not tight this way or the body is already over it (the climb
   * controller's drop takes over).
   */
  private hatchEntry(cmd: { forward: number; strafe: number; yaw: number; sneak: boolean }, s: FollowerInput, end: PathNode): boolean {
    const p = s.pos;
    const y = Math.floor(p.y + 1e-3);
    const ax = this.panelAxis(end.x, y, end.z, 0, end.x + 0.5, 'drop');
    const az = this.panelAxis(end.x, y, end.z, 2, end.z + 0.5, 'drop');
    if (ax.tight === az.tight) return false;
    const tightX = ax.tight;
    const e = (tightX ? ax.t : az.t) - (tightX ? p.x : p.z);
    const dFree = (tightX ? end.z : end.x) + 0.5 - (tightX ? p.z : p.x);
    if (Math.abs(dFree) < 0.3) return false;
    const sgn = Math.sign(dFree);
    const world = (t: number, fr: number): [number, number] => (tightX ? [t, fr * sgn] : [fr * sgn, t]);
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const turn = (dx: number, dz: number): boolean => {
      const want = yawTowards(dx, dz);
      this.yaw = turnTowards(this.yaw ?? cmd.yaw, want, this.maxTurn);
      cmd.yaw = this.yaw;
      return Math.abs(angleDiff(cmd.yaw, want)) < 0.05;
    };
    cmd.strafe = 0;
    cmd.sneak = false;
    cmd.forward = 0;
    // moving (walking in, or a pulse settling): only a clearly lost alignment stops the walk (0.0125 is the limit)
    if (Math.abs(e) > (speed > 1e-3 ? 0.011 : HATCH_ALIGN)) {
      if (speed > 1e-3) return true; // let the last pulse settle
      // a pulse of PULSE whose tight share is e; the free share away from the column when it is near
      const t = Math.max(-PULSE, Math.min(PULSE, e));
      const fr = Math.sqrt(Math.max(0, PULSE * PULSE - t * t)) * (Math.abs(dFree) < 0.9 ? -1 : 1);
      if (turn(...world(t, fr))) cmd.forward = 1;
      return true;
    }
    const vF = (tightX ? s.vel.z : s.vel.x) * sgn;
    const vT = tightX ? s.vel.x : s.vel.z;
    if (Math.abs(vT) > 2e-3) return true; // a pulse still settling
    if (turn(...world(0, 1)) && vF < HATCH_SPEED) cmd.forward = 1;
    return true;
  }

  /** Where to hold the body in a climber column: the centre, moved 0.1 away from a ladder's box (the middle of the free 0.21 in a 1 x 1 shaft). */
  private columnTarget(x: number, y: number, z: number, mode: 'up' | 'down' | 'drop' = 'down'): [number, number, boolean] {
    let tx = x + 0.5;
    let tz = z + 0.5;
    for (const cy of [y - 1, y, y + 1]) {
      const c = this.grid.cls(x, cy, z);
      if (!c?.climbable) continue;
      for (const b of c.boxes) {
        if (b[3] - b[0] < 0.5) tx = x + (b[0] > 0.5 ? 0.4 : 0.6);
        if (b[5] - b[2] < 0.5) tz = z + (b[2] > 0.5 ? 0.4 : 0.6);
      }
    }
    // Track BG: an open trapdoor's panel in the cells the body passes (a hatch over the ladder, or under the body)
    let panel = false;
    for (let cy = y - 1; cy <= y + 2 && !panel; cy++) {
      const c = this.grid.cls(x, cy, z);
      panel = !!c && isPanel(c);
    }
    if (!panel) return [tx, tz, false];
    const ax = this.panelAxis(x, y, z, 0, tx, mode);
    const az = this.panelAxis(x, y, z, 2, tz, mode);
    return [ax.t, az.t, ax.tight || az.tight];
  }

  /**
   * Track BG: the body centre's target along `axis` in a column with an open trapdoor's panel: the thin boxes
   * (panels, ladders) in cells y - 1 .. y + 2 at the column's sides bound the centre to [lo, hi]. With room the
   * target `t` is kept PANEL_CLEAR inside. In the tight gap of a panel opposite a ladder (0.63 for the 0.6 body):
   * climbing up, pressed against the ladder beside the body (jump held anyway: the collision holds it 0.03 clear
   * of the panel); else the middle, never pressed against anything: on BDS a horizontal collision while the feet
   * are just inside the ladder's cell climbs (measured: 1 correction of 0.89 dropping in pressed against the panel).
   */
  private panelAxis(x: number, y: number, z: number, axis: 0 | 2, t: number, mode: 'up' | 'down' | 'drop'): { t: number; tight: boolean } {
    const base = axis === 0 ? x : z;
    const half = PHYSICS.width / 2;
    let lo = -Infinity;
    let hi = Infinity;
    let loLadder = false;
    let hiLadder = false;
    for (let cy = y - 1; cy <= y + 2; cy++) {
      const c = this.grid.cls(x, cy, z);
      if (!c) continue;
      const ladder = !!c.climbable && c.boxes.length > 0;
      if (!isPanel(c) && !ladder) continue;
      const beside = ladder && (cy === y || cy === y + 1);
      for (const b of c.boxes) {
        const a0 = axis === 0 ? b[0] : b[2];
        const a1 = axis === 0 ? b[3] : b[5];
        if (a1 - a0 > 0.5) continue; // spans this axis
        if (a0 < 0.5) {
          lo = Math.max(lo, base + a1 + half);
          loLadder ||= beside;
        } else {
          hi = Math.min(hi, base + a0 - half);
          hiLadder ||= beside;
        }
      }
    }
    if (hi - lo >= 2 * PANEL_CLEAR) return { t: Math.min(Math.max(t, lo + PANEL_CLEAR), hi - PANEL_CLEAR), tight: false };
    if (hi < lo) return { t, tight: false }; // (no room at all: the planner does not plan this)
    if (mode === 'up' && loLadder) return { t: lo - PRESS, tight: true };
    if (mode === 'up' && hiLadder) return { t: hi + PRESS, tight: true };
    return { t: (lo + hi) / 2, tight: true };
  }

  /** The farthest swim node (up to 6 ahead) whose straight line from the body keeps its footprint over swim cells. */
  private swimAim(p: Vec3): number {
    const path = this.path;
    let aim = this.index;
    for (let j = this.index + 1; j <= Math.min(this.index + 6, path.length - 1); j++) {
      const n = path[j]!;
      if (n.move !== 'swim' || n.y !== path[this.index]!.y) break;
      if (!this.swimLineClear(p, n)) break;
      aim = j;
    }
    return aim;
  }

  private swimLineClear(p: Vec3, n: PathNode): boolean {
    const tx = n.x + 0.5;
    const tz = n.z + 0.5;
    const len = Math.hypot(tx - p.x, tz - p.z);
    const steps = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 0; i <= steps; i++) {
      const sx = p.x + ((tx - p.x) * i) / steps;
      const sz = p.z + ((tz - p.z) * i) / steps;
      for (const [ox, oz] of CORNERS) {
        const w = this.grid.swim(Math.floor(sx + ox), n.y, Math.floor(sz + oz));
        if (w === undefined || Number.isNaN(w)) return false;
      }
    }
    return true;
  }

  /**
   * The body centre is within EDGE_SNEAK of a side of its cell beyond which the column has no floor
   * within 3 blocks below the feet level (or holds lava / a hazard).
   */
  private nearUnsafeEdge(p: Vec3, y: number): boolean {
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const fx = p.x - bx;
    const fz = p.z - bz;
    if (fx < EDGE_SNEAK && this.unsafeColumn(bx - 1, y, bz)) return true;
    if (fx > 1 - EDGE_SNEAK && this.unsafeColumn(bx + 1, y, bz)) return true;
    if (fz < EDGE_SNEAK && this.unsafeColumn(bx, y, bz - 1)) return true;
    if (fz > 1 - EDGE_SNEAK && this.unsafeColumn(bx, y, bz + 1)) return true;
    return false;
  }

  /**
   * Track BC: a corner of the body's footprint is in a cell the body only fits sneaking (feet cell free, not
   * standable: a low ceiling). Read only while the path has sneak moves.
   */
  private underLowCeiling(p: Vec3, y: number): boolean {
    if (!this.hasSneak) return false;
    for (const [ox, oz] of CORNERS) {
      const x = Math.floor(p.x + ox);
      const z = Math.floor(p.z + oz);
      const f = this.grid.stand(x, y, z);
      if (f !== undefined && Number.isNaN(f) && this.grid.free(x, y, z) === true && this.grid.cls(x, y + 1, z)?.boxes.length) return true;
    }
    return false;
  }

  private unsafeColumn(x: number, y: number, z: number): boolean {
    const key = `${x},${y},${z}`;
    const hit = this.unsafeCols.get(key);
    if (hit !== undefined) return hit;
    let unsafe = false;
    const f = this.grid.stand(x, y, z);
    if (f === undefined || Number.isNaN(f)) {
      unsafe = true;
      for (let d = 0; d <= 3; d++) {
        const c = this.grid.cls(x, y - 1 - d, z);
        if (!c) break;
        if (c.liquid === 'lava' || c.danger) break;
        if (c.boxes.length || c.liquid === 'water') {
          unsafe = false; // a floor (or water) at most 3 blocks below
          break;
        }
      }
      // a wall at the feet is no edge
      const wall = this.grid.cls(x, y, z);
      if (wall?.boxes.length && !wall.danger) unsafe = false;
    }
    this.unsafeCols.set(key, unsafe);
    return unsafe;
  }



  private idle(): FollowStep['cmd'] {
    return { forward: 0, strafe: 0, yaw: this.yaw ?? 0, jump: false, sprint: false, sneak: false };
  }

  private inNode(p: Vec3, node: PathNode, onGround: boolean): boolean {
    if (Math.floor(p.x) !== node.x || Math.floor(p.z) !== node.z) return false;
    // Track AJ: a swimming body bobs between 1 below and 0.6 above the surface cell
    if (node.move === 'swim') return p.y > node.feet - 1 && p.y < node.feet + 1.2;
    if (Math.abs(p.y - node.feet) >= 0.6) return false;
    if ((node.move === 'jump' || node.move === 'drop' || node.move === 'pillar' || node.move === 'swimOut' || node.move === 'climbOut' || node.move === 'parkour' || node.move === 'downward') && !onGround) return false; // Track BC: downward
    return true;
  }

  /**
   * The straight line from `p` to node j's centre keeps the body's footprint on cells standable at
   * that node's feet height (sampled every 0.2 blocks, footprint half-width 0.31).
   */
  private lineClear(p: Vec3, j: number): boolean {
    const n = this.path[j]!;
    if (n.move !== 'walk' && n.move !== 'diag') return false; // (Track BC: a sneak node is not standable: aimed at node by node)
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
