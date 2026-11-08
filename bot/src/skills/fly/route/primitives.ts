// Track F2: the motion primitives of the route search and how a manoeuvre becomes an edge.
//
// A primitive is a `Maneuver` (types.ts): a control law held for a few ticks. `edgeOf` flies it from a state
// on the glide formula (glideVelocity: the server matches it within 0.002 a tick) through the grid, sweeping
// the 0.6 box every tick, and returns the edge (the state out, the per-tick controls and path, the rockets
// used, the clearance) or undefined when the body hits. The library here is the minimal set the search needs
// until Track F1's manoeuvres plug in through the same interface: a steady glide at a pitch, a coordinated
// turn (the look held a fixed angle off the velocity), a powered snap (a rocket with the look snapped to a
// new heading), the 180 brake, the hover flip and the jump takeoff.
import type { Vec3 } from '../../../connection/types.ts';
import { GLIDE, PHYSICS, glideVelocity } from '../../input/physics.ts';
import { sweep, type RouteGrid } from './grid.ts';
import { BURN, CLIPPED_GLIDE_DELAY, EDGE_MAX_TICKS, EDGE_TICKS, GLIDE_DELAY, RISK_RANGE, burnTick, cloneState, dist3, freshBurn, headingOf, hspeed, inBox, landingCells, type Maneuver, type PrimitiveFamily, type RouteControl, type RouteEdge, type RouteGoal, type RouteState } from './types.ts';

export interface EdgeContext {
  grid: RouteGrid;
  margin: number;
  goals: readonly RouteGoal[];
  stackRockets: boolean;
  /** The burn the simulation runs with (BURN.nominal; the robust check passes others). */
  burn?: number;
  /** Sweep the burn branches too (RouteRequest.burnBranches; default true). */
  burnBranches?: boolean;
}

/**
 * One tick of the body on `control` (pure). A standing body jumps (vy 0.42, then gravity and drag as
 * stepBody's ground branch) and glides from the next tick on; a gliding body follows glideVelocity with the
 * boost while the nominal burn runs. The rocket is counted only when it may be fired.
 */
export function stepState(s: Readonly<RouteState>, c: RouteControl, stackRockets: boolean, burn = BURN.nominal, grid?: RouteGrid, branches = true): { next: RouteState; fired: boolean } {
  const n = cloneState(s);
  let fired = false;
  n.yaw = c.yaw;
  if (!s.gliding) {
    // the takeoff tick: the jump from the ground (physics.ts stepBody: jump, move, gravity, drag); a ceiling
    // within the jump clips the rise and zeroes the vertical speed (moveBody), as under a 2-high roof
    if (c.jump) {
      let rise: number = PHYSICS.jumpVelocity;
      if (grid) {
        const head = s.pos.y + PHYSICS.height;
        for (let cy = Math.floor(head); cy <= Math.floor(head + rise); cy++) {
          for (let cx = Math.floor(s.pos.x - PHYSICS.width / 2); cx <= Math.floor(s.pos.x + PHYSICS.width / 2); cx++) {
            for (let cz = Math.floor(s.pos.z - PHYSICS.width / 2); cz <= Math.floor(s.pos.z + PHYSICS.width / 2); cz++) {
              if (grid.solid(cx, cy, cz)) rise = Math.max(0, Math.min(rise, cy - head));
            }
          }
        }
      }
      const clipped = rise < PHYSICS.jumpVelocity;
      // Track F0: under a 2-high ceiling the jump has only two airborne inputs and the first is refused: no glide
      // starts from it at all (docs/flight-envelope.md section 8). The body is back on the floor: no takeoff here.
      if (clipped && rise <= LOW_CEILING_RISE) return { next: n, fired };
      n.pos.y = f32(s.pos.y + rise);
      n.vel = { x: 0, y: Math.fround(((clipped ? 0 : PHYSICS.jumpVelocity) - PHYSICS.gravity) * PHYSICS.drag), z: 0 };
      n.gliding = c.glide === true;
      n.glideIn = clipped ? CLIPPED_GLIDE_DELAY : GLIDE_DELAY;
    }
    return { next: n, fired };
  }
  if (s.glideIn) {
    // the airborne ticks before the server's glide takes: plain gravity and drag (physics.ts stepBody's air branch), no boost
    n.pos = { x: f32(s.pos.x + s.vel.x), y: f32(s.pos.y + s.vel.y), z: f32(s.pos.z + s.vel.z) };
    n.vel = { x: f32(s.vel.x * PHYSICS.airInertia), y: f32((s.vel.y - PHYSICS.gravity) * PHYSICS.drag), z: f32(s.vel.z * PHYSICS.airInertia) };
    n.glideIn = s.glideIn - 1;
    if (n.glideIn === 0) {
      delete n.glideIn;
      n.glideFresh = true;
    }
    return { next: n, fired };
  }
  // Track F4a: the glide's first input after a jump (j2) takes no rocket (the server ignores the use; F0, docs/flight-envelope.md
  // section 8): a rocket works from the input after it, so the model's first boosted tick is the server's
  const fresh = s.glideFresh === true;
  if (fresh) delete n.glideFresh;
  if (c.fire && !fresh && s.rockets > 0 && (s.boost.max === 0 || inBurnTail(s.boost) || stackRockets)) {
    n.boost = freshBurn();
    n.boost.nom = burn;
    n.rockets = s.rockets - 1;
    fired = true;
    // the burn branches start at the fire, on the nominal body (a rocket in a burn's tail: the branches of that
    // burn go on, now both boosted: the union)
    if (branches && !(n.early && n.late)) {
      n.early = { pos: { ...s.pos }, vel: { ...s.vel } };
      n.late = { pos: { ...s.pos }, vel: { ...s.vel } };
    }
  }
  const boosting = n.boost.nom > 0;
  const v = glideVelocity(s.vel, c.yaw, c.pitch, boosting);
  n.vel = v;
  // (float32 positions, as the loop and the server keep them)
  n.pos = { x: f32(s.pos.x + v.x), y: f32(s.pos.y + v.y), z: f32(s.pos.z + v.z) };
  if (n.early && n.late) {
    const ev = glideVelocity(n.early.vel, c.yaw, c.pitch, n.boost.min > 0);
    const lv = glideVelocity(n.late.vel, c.yaw, c.pitch, n.boost.max > 0);
    n.early = { pos: { x: f32(n.early.pos.x + ev.x), y: f32(n.early.pos.y + ev.y), z: f32(n.early.pos.z + ev.z) }, vel: ev };
    n.late = { pos: { x: f32(n.late.pos.x + lv.x), y: f32(n.late.pos.y + lv.y), z: f32(n.late.pos.z + lv.z) }, vel: lv };
    // converged back onto the nominal once the burn is over in every branch
    if (n.boost.max <= 1 && dist3(n.early.pos, n.pos) < BRANCH_CONVERGED && dist3(n.late.pos, n.pos) < BRANCH_CONVERGED) {
      delete n.early;
      delete n.late;
    }
  }
  n.boost = burnTick(n.boost);
  return { next: n, fired };
}

/**
 * Track F4a: a burn that may be over (past its earliest end, F0: 9 of 9 to 21 ticks) but may still run. A rocket may
 * be used there: if the burn still runs, the boost is the union of the two lifetimes (F0's measurement), so the plan
 * need not wait for the latest end before it boosts again and never rides on a tail it cannot know (the e2e's 3 x 3
 * tunnel scraped on a snap turn planned on the burn's last nominal ticks, and came to its corner with a long burn still
 * running and its rocket held). Before the earliest end a rocket stays a waste (full stacking, `stackRockets`, cost
 * the rings and the slalom their clean runs: more speed in the gates).
 */
export function inBurnTail(b: Readonly<RouteState['boost']>): boolean {
  return b.min === 0 && b.max > 0;
}

/** The branches are dropped once both are within this of the nominal body (blocks) after the burn. */
export const BRANCH_CONVERGED = 0.3;
/** Track F0: a jump whose rise is clipped to this or less by the ceiling (a 2-high space: 0.2) never glides. */
export const LOW_CEILING_RISE = 0.25;

/**
 * Re-fly `controls` from `start` on the nominal burn (the per-tick states of a plan; no collision check):
 * the search's unwind and the tracker's reference share it.
 */
export function replay(start: Readonly<RouteState>, controls: readonly RouteControl[], goals: readonly RouteGoal[], stackRockets: boolean, branches = false): RouteState[] {
  return replayBurns(start, controls, goals, [], stackRockets, branches);
}

/**
 * Track F6: `replay` with the burn of each rocket given in fire order (`burns[k]` ticks for the k-th rocket the controls
 * fire; the nominal when absent): the tracker re-times a plan's reference states to the burn it has read off the body
 * (tracker.ts `retime`), so the body is tracked against where the plan's controls really take it.
 */
export function replayBurns(start: Readonly<RouteState>, controls: readonly RouteControl[], goals: readonly RouteGoal[], burns: readonly number[], stackRockets: boolean, branches = false): RouteState[] {
  const out: RouteState[] = [];
  let s = cloneState(start);
  let k = 0;
  for (const c of controls) {
    // (Track F7: `branches` carries the burn branches along the states, for a search in pieces to start its next piece from them)
    const { next, fired } = stepState(s, c, stackRockets, c.fire ? (burns[k] ?? BURN.nominal) : BURN.nominal, undefined, branches);
    if (fired) k++;
    const g = goals[next.wp];
    if (g?.kind === 'landing' && landsOn(g, s.pos, next.pos, next.vel)) {
      const f = (s.pos.y - g.top) / Math.max(1e-9, s.pos.y - next.pos.y);
      next.pos = { x: s.pos.x + (next.pos.x - s.pos.x) * f, y: g.top, z: s.pos.z + (next.pos.z - s.pos.z) * f };
      next.gliding = false;
      next.wp++;
    }
    while (next.wp < goals.length && passes(goals[next.wp]!, s.pos, next.pos)) next.wp++;
    out.push(next);
    s = next;
  }
  return out;
}

/** The landing test of a goal on the move `from` -> `to`: the feet cross the cell's top inside it slowly enough. */
export function landsOn(g: RouteGoal, from: Vec3, to: Vec3, vel: Vec3): boolean {
  if (g.kind !== 'landing') return false;
  if (!(from.y >= g.top && to.y <= g.top)) return false;
  const f = (from.y - g.top) / Math.max(1e-9, from.y - to.y);
  const x = Math.floor(from.x + (to.x - from.x) * f);
  const z = Math.floor(from.z + (to.z - from.z) * f);
  if (!landingCells(g).some((c) => c.x === x && c.z === z)) return false;
  const max = g.maxSpeed ?? 0.3;
  return -vel.y <= max && hspeed(vel) <= max;
}

/** The move crosses a landing goal's floor plane (a landing when `landsOn` holds, else the ground). */
export function crossesFloor(g: RouteGoal | undefined, from: Vec3, to: Vec3): boolean {
  return g?.kind === 'landing' && from.y >= g.top && to.y < g.top;
}

/** The waypoint test of a goal on the move: the feet inside the box at the tick's end or midpoint. */
export function passes(g: RouteGoal, from: Vec3, to: Vec3): boolean {
  if (g.kind !== 'waypoint') return false;
  return inBox(g.box, to) || inBox(g.box, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 });
}

const f32 = Math.fround;

/** The grid without the cells at or under `floorY` (the floor a takeoff leaves). */
function floorless(grid: RouteGrid, floorY: number): RouteGrid {
  return { solid: (x, y, z) => y >= floorY && grid.solid(x, y, z) };
}

/** Within this horizontal distance of a landing cell the cell's floor is no obstacle (the body comes down onto it through the margin). */
export const LANDING_NEAR = 3;

/** The grid an edge from `pos` towards `goal` is swept in: a landing goal's floor plane is no obstacle near the cell (plan.ts simulateProfile does the same near the target). */
export function sweepGridFor(grid: RouteGrid, goal: RouteGoal | undefined, pos: Vec3): RouteGrid {
  if (goal?.kind !== 'landing') return grid;
  if (!landingCells(goal).some((c) => Math.hypot(pos.x - (c.x + 0.5), pos.z - (c.z + 0.5)) <= LANDING_NEAR)) return grid;
  return floorless(grid, goal.top);
}

/**
 * Fly `m` from `s` through the grid: the edge, or undefined when the body hits a solid (or the manoeuvre does
 * not apply). The goals are advanced as they are passed; a landing ends the edge on contact.
 */
export function edgeOf(m: Maneuver, s: Readonly<RouteState>, ctx: EdgeContext): RouteEdge | undefined {
  if (!m.applies(s)) return undefined;
  const ticks = Math.min(EDGE_MAX_TICKS, Math.max(1, m.ticks(s)));
  const controls: RouteControl[] = [];
  const path: Vec3[] = [];
  let now = cloneState(s);
  let rockets = 0;
  let clearance = RISK_RANGE;
  let risk = 0;
  let landed = false;
  const branches = ctx.burnBranches !== false;
  for (let i = 0; i < ticks; i++) {
    const c = m.control(s, now, i);
    const { next, fired } = stepState(now, c, ctx.stackRockets, ctx.burn, ctx.grid, branches);
    if (fired) rockets++;
    const g = ctx.goals[next.wp];
    if (g?.kind === 'landing' && now.pos.y >= g.top && next.pos.y < g.top) {
      // the floor plane of the landing cell: a soft contact inside the cell lands, anything else is the ground
      if (!landsOn(g, now.pos, next.pos, next.vel)) return undefined;
      // contact: the glide ends on the cell's top
      const f = (now.pos.y - g.top) / Math.max(1e-9, now.pos.y - next.pos.y);
      next.pos = { x: now.pos.x + (next.pos.x - now.pos.x) * f, y: g.top, z: now.pos.z + (next.pos.z - now.pos.z) * f };
      next.gliding = false;
      next.wp++;
      landed = true;
    }
    // the jump tick leaves the floor the body stands on: that floor is no obstacle (only the cells over the feet count)
    const grid = c.jump && !now.gliding ? floorless(ctx.grid, Math.floor(now.pos.y + 1e-6)) : sweepGridFor(ctx.grid, ctx.goals[now.wp], now.pos);
    const sw = sweep(grid, c.jump && !now.gliding ? next.pos : now.pos, next.pos, ctx.margin);
    if (sw.hit && !landed) return undefined;
    if (!landed) {
      if (sw.clearance < clearance) clearance = sw.clearance;
      risk += 1 - sw.clearance / RISK_RANGE;
      // the burn branches must clear too (the plan is robust to the burn by construction)
      if (next.early && next.late && now.early && now.late) {
        const e = sweep(grid, now.early.pos, next.early.pos, ctx.margin);
        if (e.hit) return undefined;
        const l = sweep(grid, now.late.pos, next.late.pos, ctx.margin);
        if (l.hit) return undefined;
        clearance = Math.min(clearance, e.clearance, l.clearance);
      }
    }
    while (next.wp < ctx.goals.length && passes(ctx.goals[next.wp]!, now.pos, next.pos)) next.wp++;
    controls.push({ ...c, fire: fired });
    path.push({ ...next.pos });
    now = next;
    if (landed || next.wp >= ctx.goals.length) break;
    if (m.done?.(s, now, i)) break;
  }
  return { name: m.name, family: m.family, out: now, controls, path, ticks: controls.length, rockets, clearance, risk, robust: rockets === 0 || branches };
}

// ---- the minimal library ----------------------------------------------------------------------------

const heading = (s: Readonly<RouteState>): number => headingOf(s.vel, s.yaw);

/** A steady glide: the look along the velocity at `pitch`. */
export function glide(pitch: number, ticks = EDGE_TICKS): Maneuver {
  return {
    name: `glide${pitch >= 0 ? '+' : ''}${pitch}`,
    family: 'glide',
    applies: (s) => s.gliding,
    control: (_s, now) => ({ yaw: heading(now), pitch, fire: false }),
    ticks: () => ticks,
  };
}

/** A coordinated turn: the look held `offset` degrees off the velocity's heading every tick (the formula turns the velocity onto the look at 10 % a tick). */
export function turn(offset: number, pitch: number, ticks = EDGE_TICKS): Maneuver {
  const side = offset < 0 ? 'L' : 'R';
  return {
    name: `turn${Math.abs(offset)}${side}${pitch ? (pitch > 0 ? '+' : '') + pitch : ''}`,
    family: 'turn',
    applies: (s) => s.gliding && hspeed(s.vel) >= 0.3,
    control: (_s, now) => ({ yaw: heading(now) + offset, pitch, fire: false }),
    ticks: () => ticks,
  };
}

/** A rocket with the look snapped `offset` degrees off the heading at the start and held (a powered snap turn; offset 0: a straight boost at `pitch`). */
export function rocket(offset: number, pitch: number, ticks = EDGE_TICKS): Maneuver {
  const side = offset === 0 ? '' : offset < 0 ? 'L' : 'R';
  return {
    name: `rocket${offset ? Math.abs(offset) + side : ''}${pitch ? (pitch > 0 ? '+' : '') + pitch : ''}`,
    family: 'rocket',
    applies: (s) => s.gliding && s.rockets > 0,
    control: (s, _now, i) => ({ yaw: heading(s) + offset, pitch, fire: i === 0 }),
    ticks: () => ticks,
  };
}

/** The boost held on: the look along the velocity at `pitch` while a rocket burns (no new rocket). */
export function boosted(offset: number, pitch: number, ticks = EDGE_TICKS): Maneuver {
  const side = offset === 0 ? '' : offset < 0 ? 'L' : 'R';
  return {
    name: `boost${offset ? Math.abs(offset) + side : ''}${pitch ? (pitch > 0 ? '+' : '') + pitch : ''}`,
    family: 'rocket',
    applies: (s) => s.gliding && s.boost.nom > 0,
    control: (_s, now) => ({ yaw: heading(now) + offset, pitch, fire: false }),
    ticks: () => ticks,
  };
}

/** The 180 brake: the look flipped against the velocity at `pitch` until the speed is under `until` (at most `max` ticks). */
export function brake180(pitch: number, until = 0.2, max = 12): Maneuver {
  return {
    name: `brake180${pitch ? (pitch > 0 ? '+' : '') + pitch : ''}`,
    family: 'brake',
    applies: (s) => s.gliding && hspeed(s.vel) >= 0.5 && s.boost.max === 0,
    control: (s) => ({ yaw: heading(s) + 180, pitch, fire: false }),
    ticks: () => max,
    done: (_s, now) => hspeed(now.vel) < until,
  };
}

/** The hover: the look flipped 180 degrees every tick at pitch 0 (sinks 0.149 a tick, drifts under 0.4 blocks in 400 ticks). */
export function hover(ticks = 4): Maneuver {
  return {
    name: 'hover',
    family: 'hover',
    applies: (s) => s.gliding && hspeed(s.vel) < 0.35,
    control: (s, _now, i) => ({ yaw: s.yaw + (i % 2 ? 180 : 0), pitch: 0, fire: false }),
    ticks: () => ticks,
  };
}

/**
 * The settle onto a landing cell: the hover flip held until contact (an elevator descent at 0.149 a tick), from a
 * nearly stopped body within SETTLE_NEAR of the cell. The edge ends on the touchdown; a contact outside the cell
 * or too fast is the ground (edgeOf drops it).
 */
export function settle(g: RouteGoal): Maneuver {
  const cx = g.kind === 'landing' ? g.cell.x + 0.5 : 0;
  const cz = g.kind === 'landing' ? g.cell.z + 0.5 : 0;
  return {
    name: 'settle',
    family: 'brake',
    applies: (s) => g.kind === 'landing' && s.gliding && s.boost.max === 0 && hspeed(s.vel) < 0.35 && Math.hypot(s.pos.x - cx, s.pos.z - cz) <= SETTLE_NEAR && s.pos.y > g.top,
    control: (s, _now, i) => ({ yaw: s.yaw + (i % 2 ? 180 : 0), pitch: 0, fire: false }),
    ticks: () => EDGE_MAX_TICKS,
  };
}
export const SETTLE_NEAR = 4;

/** The jump takeoff from standing: jump and request the glide, then `pitch` along `yaw` (a rocket on the first gliding tick that takes one when `fire`: the second, Track F4a). */
export function takeoff(yaw: number, pitch: number, fire: boolean, ticks = GLIDE_DELAY + 4): Maneuver {
  return {
    name: `takeoff${fire ? 'R' : ''}${pitch ? (pitch > 0 ? '+' : '') + pitch : ''}`,
    family: 'takeoff',
    applies: (s) => !s.gliding,
    // the rocket as soon as the glide takes one (no rocket used yet in this edge; stepState refuses it on the glide's first tick)
    control: (s, now, i) => (i === 0 ? { yaw, pitch: 0, fire: false, jump: true, glide: true } : { yaw, pitch, fire: fire && !now.glideIn && !now.glideFresh && now.rockets === s.rockets }),
    ticks: () => ticks,
  };
}

/** The glide pitches of the library (the polar is flat between -6 and 20; 35 is the dive). */
const GLIDE_PITCHES = [-20, -10, 0, 10, 20, 35];
const TURN_OFFSETS = [25, 50, 90];
const SNAP_OFFSETS = [45, 90];

/**
 * The minimal library for a state: glides, turns, rockets (snaps and climbs), the boost held, the brake and
 * the hover, the takeoffs for a standing body. `families` restricts it (the benchmark's ablations).
 */
export function libraryFor(families: readonly PrimitiveFamily[] | undefined, edgeTicks = EDGE_TICKS, takeoffYaws: readonly number[] = [], goals: readonly RouteGoal[] = []): Maneuver[] {
  const want = (f: PrimitiveFamily): boolean => !families || families.includes(f);
  const out: Maneuver[] = [];
  if (want('brake')) for (const g of goals) if (g.kind === 'landing') out.push(settle(g));
  if (want('glide')) for (const p of GLIDE_PITCHES) out.push(glide(p, edgeTicks));
  if (want('turn')) {
    for (const o of TURN_OFFSETS) for (const side of [-1, 1]) for (const p of [0, 15]) out.push(turn(o * side, p, edgeTicks));
  }
  if (want('rocket')) {
    for (const p of [-60, -45, -35, -15, 0, 20]) out.push(rocket(0, p, edgeTicks));
    for (const o of SNAP_OFFSETS) for (const side of [-1, 1]) for (const p of [-20, 0]) out.push(rocket(o * side, p, edgeTicks));
    for (const p of [-45, -20, 0, 20]) out.push(boosted(0, p, edgeTicks));
    for (const o of [45, 90]) for (const side of [-1, 1]) out.push(boosted(o * side, 0, edgeTicks));
  }
  if (want('brake')) for (const p of [-20, 0]) out.push(brake180(p));
  if (want('hover')) out.push(hover());
  if (want('takeoff')) for (const yaw of takeoffYaws) for (const [p, f] of [[-20, true], [-45, true], [0, false], [20, false]] as const) out.push(takeoff(yaw, p, f));
  return out;
}

/** The boosted speed the heuristic divides by (the boost pulls the speed towards GLIDE.boostTarget + push). */
export const HEURISTIC_SPEED = GLIDE.boostTarget + GLIDE.boostPush * 2;
