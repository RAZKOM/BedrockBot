// Track BH (docs/flight.md "Glide down" and "Ledge takeoff"; decisions/0054-glide-down-and-ledge-takeoff.md):
//
//   - the ledge takeoff: an edge of the start's platform whose fall corridor is clear (no wall or overhang
//     along the heading for LEDGE_CORRIDOR blocks, nothing under the edge closer than the glide needs to
//     get going), reached by a walk; the brain sneaks to the edge, steps off and glides as the fall begins
//     (brain.ts `ledge`). Used by the glide down and by any flight whose jump takeoff is blocked or that
//     starts on a small platform.
//   - the glide down: a walk that ended `unreachable` with the goal lower and some way off (a peak, a
//     cliff, a tower, a floating platform) glides down to the landing findLanding confirmed, without a
//     rocket, when the whole flight simulated on stepBody from the ledge (the same brain, rockets 0) lands
//     on the landing's cells: never a guess, never into water.
//
// Pure functions over the world model (a BlockQuery / CellQuery): commands-fly.ts wires them.
import type { Vec3 } from '../../connection/types.ts';
import { liquidContact, stepBody } from '../input/physics.ts';
import { IDLE_COMMAND, initialBody, type BlockQuery, type BodyState, type MoveCommand } from '../input/types.ts';
import { FlightBrain, type BrainOptions, type FlightEnd, type FlightStats } from './brain.ts';
import { elytraWornLimit, elytraWornLine, type FlightKit } from './kit.ts';
import { GLIDE } from '../input/physics.ts';
import { hdist, onTarget, takeoffSky, yawDiff, yawTo, type CellQuery, type LandingTarget } from './plan.ts';
import { assumedTop, type TerrainQuery } from './terrain.ts'; // Track BL
import type { TakeoffRoute } from './route/takeoff.ts'; // Track F9a

/** The ledge's fall corridor: no solid at the body's height (feet .. head + 1) this many blocks out along the heading, a block either side. */
export const LEDGE_CORRIDOR = 10;
/** The least drop under the edge (and under the corridor's first blocks): the glide flies (LEDGE_SPEED) after about 9 blocks of fall at LEDGE_DIVE (the formula: the same 12.5 to 0.9 at any pitch up to 20, pitch 20 the shortest way out). */
export const LEDGE_MIN_DROP = 12;
/** Edges are looked for within this many blocks of walk on the start's platform (the same floor height). */
export const LEDGE_RADIUS = 10;
/** A start platform with at most this many cells within SMALL_PLATFORM_R blocks is a small platform (a pillar, a ledge): the ledge takeoff. */
export const SMALL_PLATFORM = 12;
export const SMALL_PLATFORM_R = 3;
/** Track F9c: the ticks a rocket that fired nothing is still believed (rocket.ts ROCKET_ADD_WITHIN: no rocket entity by then, the use is written off and its boost taken back). */
export const DUD_SEEN_TICKS = 5;
/** The whole-flight simulation's tick cap (100 s of flight) and how often it yields to the event loop. */
export const SIM_MAX_TICKS = 2000;
const SIM_YIELD = 10;

/** One edge of the start's platform to step off. */
export interface Ledge {
  /** The edge cell (the body stands on it: feet height) and the heading off it (Bedrock yaw). */
  x: number;
  z: number;
  feet: number;
  yaw: number;
  /** Blocks of walk from the start (the platform's cells). */
  walk: number;
  /** The drop under the cell off the edge (blocks from the feet to the ground). */
  drop: number;
}

/** Track BH: the kit for a glide without rockets: an elytra (worn or carried) with uses left. */
export function glideKitReady(kit: FlightKit, toolWearLimit: number): { ok: true } | { ok: false; line: string } {
  if (!kit.elytraWorn && kit.elytraSlot < 0) return { ok: false, line: 'no elytra' };
  if (kit.elytraLeft !== undefined && kit.elytraLeft <= elytraWornLimit(toolWearLimit, kit)) return { ok: false, line: elytraWornLine(kit.elytraLeft, kit.elytraMending) };
  return { ok: true };
}

const key = (x: number, z: number): number => (x & 0xffff) * 65536 + (z & 0xffff);

/** A body can stand at (x, feet, z): solid under, two free cells (true / false / undefined = unknown). */
export function standable(q: CellQuery, x: number, feet: number, z: number): boolean | undefined {
  const under = q(x, feet - 1, z);
  const a = q(x, feet, z);
  const b = q(x, feet + 1, z);
  if (under === undefined || a === undefined || b === undefined) return undefined;
  return under && !a && !b;
}

/** The start's platform: the standable cells at the start's feet height connected to it (4-neighbours), with their walk in cells. */
export function platformOf(q: CellQuery, from: Vec3, radius = LEDGE_RADIUS, max = 600): Map<number, { x: number; z: number; steps: number }> {
  const feet = Math.floor(from.y + 1e-3);
  const sx = Math.floor(from.x);
  const sz = Math.floor(from.z);
  const out = new Map<number, { x: number; z: number; steps: number }>();
  if (standable(q, sx, feet, sz) !== true) return out;
  const queue = [{ x: sx, z: sz, steps: 0 }];
  out.set(key(sx, sz), queue[0]!);
  for (let i = 0; i < queue.length && out.size < max; i++) {
    const c = queue[i]!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = c.x + dx;
      const z = c.z + dz;
      if (Math.abs(x - sx) > radius || Math.abs(z - sz) > radius || out.has(key(x, z))) continue;
      if (standable(q, x, feet, z) !== true) continue;
      const n = { x, z, steps: c.steps + 1 };
      out.set(key(x, z), n);
      queue.push(n);
    }
  }
  return out;
}

/** Track BH: the start is a small platform (a pillar top, a ledge): few standable cells around it at its height. */
export function smallPlatform(q: CellQuery, from: Vec3): boolean {
  const p = platformOf(q, from, SMALL_PLATFORM_R, SMALL_PLATFORM + 1);
  return p.size > 0 && p.size <= SMALL_PLATFORM;
}

/** The yaw of a step (dx, dz) (Bedrock: 0 = +z, 90 = -x). */
const yawOf = (dx: number, dz: number): number => (Math.atan2(-dx, dz) * 180) / Math.PI;

/** Free of solids and known (a cell the model has not loaded counts as blocked: an unseen wall is still a wall). */
const air = (q: CellQuery, x: number, y: number, z: number): boolean => q(x, y, z) === false;

/** The drop under (x, z) from the feet height: blocks down to the first solid (undefined: unknown before one, or none within `max`). */
export function dropAt(q: CellQuery, x: number, feet: number, z: number, max = 96): number | undefined {
  for (let y = feet - 1; y >= feet - max; y--) {
    const c = q(x, y, z);
    if (c === undefined) return undefined;
    if (c) return feet - (y + 1);
  }
  return undefined;
}

/**
 * The edges of the start's platform to step off (docs/flight.md "Ledge takeoff"), the best first: for
 * every cell of the platform and each of the 8 headings, the cell beside it must be a drop of at least
 * `minDrop` (a diagonal also needs both side cells open, the body's box passes their corner), and the
 * corridor along the heading must be clear: LEDGE_CORRIDOR blocks out, a block either side, from the
 * feet to the head + 1 (walls, an overhang), and the ground under its first 4 blocks at least
 * `minDrop` down (nothing under the edge closer than the glide needs). Ranked by the angle off
 * `bearing` (15 degrees count as a block of walk) plus the walk.
 */
export function findLedges(q: CellQuery, from: Vec3, bearing: number, o: { minDrop?: number; radius?: number; corridor?: number } = {}): { ledges: Ledge[]; cells: number; why: string | undefined } {
  const minDrop = o.minDrop ?? LEDGE_MIN_DROP;
  const corridor = o.corridor ?? LEDGE_CORRIDOR;
  const feet = Math.floor(from.y + 1e-3);
  const plat = platformOf(q, from, o.radius ?? LEDGE_RADIUS);
  if (!plat.size) return { ledges: [], cells: 0, why: 'not standing on a known floor' };
  const out: (Ledge & { score: number })[] = [];
  let edges = 0;
  let shallow = 0;
  let blocked = 0;
  const open = (x: number, z: number): boolean => air(q, x, feet, z) && air(q, x, feet + 1, z) && air(q, x, feet - 1, z);
  for (const c of plat.values()) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        if (!open(c.x + dx, c.z + dz)) continue;
        if (dx !== 0 && dz !== 0 && (!open(c.x + dx, c.z) || !open(c.x, c.z + dz))) continue;
        edges++;
        const drop = dropAt(q, c.x + dx, feet, c.z + dz);
        if (drop === undefined || drop < minDrop) {
          shallow++;
          continue;
        }
        const len = Math.hypot(dx, dz);
        const ux = dx / len;
        const uz = dz / len;
        // from the edge (the cell's border) outwards
        const ox = c.x + 0.5 + ux * 0.5;
        const oz = c.z + 0.5 + uz * 0.5;
        let clear = true;
        for (let i = 0.5; i <= corridor && clear; i += 0.5) {
          for (const lat of [-1, 0, 1]) {
            const x = Math.floor(ox + ux * i - uz * lat);
            const z = Math.floor(oz + uz * i + ux * lat);
            if (plat.has(key(x, z)) && lat !== 0) continue; // the platform itself beside the line (a wide cliff top)
            for (let y = feet; y <= feet + 2; y++) {
              if (!air(q, x, y, z)) {
                clear = false;
                break;
              }
            }
            if (!clear) break;
            if (i <= 4 && lat === 0) {
              const d = dropAt(q, x, feet, z);
              if (d === undefined || d < minDrop) clear = false;
            }
          }
        }
        if (!clear) {
          blocked++;
          continue;
        }
        const yaw = yawOf(dx, dz);
        out.push({ x: c.x, z: c.z, feet, yaw, walk: c.steps, drop, score: Math.abs(yawDiff(yaw, bearing)) / 15 + c.steps });
      }
    }
  }
  out.sort((a, b) => a.score - b.score);
  const why = out.length ? undefined : !edges ? `no edge on the ${plat.size}-cell platform` : `${edges} edges: ${shallow} with less than ${minDrop} blocks of drop, ${blocked} with a wall or overhang in the fall corridor`;
  return { ledges: out.map(({ score: _s, ...l }) => l), cells: plat.size, why };
}

/** The ground under (x, z) looking down from `fromY` (feet height), for the simulated brain's emergency landing. */
export type GroundAt = (x: number, z: number, fromY?: number) => number | undefined;

export interface SimDeps {
  /** The world for stepBody (unknown cells: the caller decides, the flight's skyQuery makes them air). */
  world: BlockQuery;
  groundAt?: GroundAt;
  skyTop?: (x: number, z: number) => number | undefined;
  yieldNow?: () => Promise<void>;
  /**
   * Track BL (docs/flight.md "Takeoff sites"): the terrain columns for the takeoff's climbing turn. The
   * simulated brain gets the terrain floor (as the real flight does), and the body inside a cache-only
   * column's terrain or under an unknown column's assumed top (terrain.ts assumedTop over the highest live
   * top passed) counts as a hit: unknown is not air for the corridor check.
   */
  terrain?: TerrainQuery;
}

export interface SimResult {
  end: FlightEnd | undefined;
  ticks: number;
  /** Collisions in the air (a wall or a ceiling met while gliding). */
  hits: number;
  /** The body ended in water or lava. */
  wet: boolean;
  /** Track BL: of the hits, those inside terrain the live model does not know (cache-only or the unknown columns' assumed top). */
  unknownHits?: number;
  /** Track F9a: of the hits, the head bumps of the takeoff phase (a ceiling touched while rising, no wall met: it costs the rise, not health). */
  bumps?: number;
  /** Track F9b: where the first of the hits that is no head bump was: the tick, the phase, the height over the start and the blocks from it (for the proof's line). */
  firstHit?: { tick: number; phase: string; up: number; out: number };
  /** Track F9b: and where the body first touched water or lava. */
  firstWet?: { tick: number; phase: string; up: number; out: number };
  body: BodyState;
  stats: FlightStats;
  /** The phase the simulation stopped in (`until`). */
  phase: string;
}

/**
 * A whole flight of the FlightBrain on stepBody (the offline simulator of the unit tests, over the live
 * world model): the body starts standing at `start`, `rockets` at hand, the brain flies `target` with
 * `opts` (the same options the real flight gets, so the same seed flies the same plan). Stops when the
 * flight ends, after `maxTicks`, or when `until` says so.
 */
export async function simulateFlight(
  deps: SimDeps,
  start: Vec3,
  target: LandingTarget,
  opts: Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop'>,
  s: {
    rockets?: number;
    maxTicks?: number;
    yaw?: number;
    until?: (brain: FlightBrain, body: BodyState) => boolean;
    /**
     * Track F9a: the ticks every rocket burns (default the nominal, GLIDE.boostTicks; a takeoff is proven at the burn's extremes too).
     * Track F9b: or the burn of each rocket by its number (0 first): a long first rocket and short ones after it is a flight
     * no single burn flies.
     */
    burn?: number | ((rocket: number) => number);
    /** Track F9a: asked before every tick: a promise while something the brain waits for is still out (a route plan in the worker), awaited so the simulation's tick is the answer's. */
    wait?: () => Promise<unknown> | undefined;
    /**
     * Track F9b: the ticks the brain goes on seeing a burn after it has ended (default 0). The input loop boosts until the
     * rocket's remove_entity, which reaches it GLIDE.boostEndLag inputs after the first tick without the boost, so the
     * real brain asks for its next rocket that much later than one that knows the burn's end at once: a climb on rockets
     * back to back has a gap after every one of them, and gains less than a simulation without the gap says.
     */
    endLag?: number;
    /**
     * Track F9c: the rockets that fire nothing, by their number (0 first): the server ignored the use (Track F0: a rocket
     * before it has taken the glide; the Realm has them at takeoffs after that too). The input loop predicts the boost all
     * the same and takes it back DUD_SEEN_TICKS later (rocket.ts: no rocket entity came), re-simulating the inputs since
     * without it. Here: the body flies on unboosted, while for those ticks the brain is shown the body the loop predicted
     * (the same inputs with the boost) and a burn; then the real one again, behind where the prediction was.
     */
    dud?: (rocket: number) => boolean;
  } = {},
): Promise<SimResult> {
  const world = deps.world;
  const brain = new FlightBrain(target, { ...opts, ...(deps.groundAt ? { groundAt: deps.groundAt } : {}), ...(deps.skyTop ? { skyTop: deps.skyTop } : {}), ...(deps.terrain ? { terrain: deps.terrain } : {}), obstacle: (x, y, z) => world.solidAt(x, y, z) === true });
  // Track BL: the corridor check against the terrain the live model does not know; the highest known top is taken from the live columns passed beyond
  // LEDGE_RADIUS + 2 of the start (a start on a platform in the air, the farm 135 over home, is no terrain: the ground around it is)
  let knownMax = -64;
  let unknownHits = 0;
  // Track F9a: the tick the takeoff phase ended, and the head bumps up to it
  let outAt: number | undefined;
  let bumps = 0;
  let firstHit: SimResult['firstHit'];
  let firstWet: SimResult['firstHit'];
  let body = initialBody(start, true);
  let cmd: MoveCommand = { ...IDLE_COMMAND, yaw: s.yaw ?? opts.ledge?.yaw ?? 0 };
  let rockets = s.rockets ?? 0;
  let lastFire = -100;
  let fired = 0;
  let lag = 0;
  let ghost: BodyState | undefined;
  let ghostLeft = 0;
  let hits = 0;
  let wet = false;
  const max = s.maxTicks ?? SIM_MAX_TICKS;
  let t = 1;
  for (; t <= max; t++) {
    if (t % SIM_YIELD === 0 && deps.yieldNow) await deps.yieldNow();
    for (let w = s.wait?.(); w; w = s.wait?.()) await w;
    // (Track F9b: a burn that has ended is still seen for `endLag` ticks)
    const burning = body.boostTicks ?? 0;
    if (burning > 0) lag = s.endLag ?? 0;
    const seen = burning > 0 ? burning : lag > 0 && body.gliding ? 1 : 0;
    if (burning === 0 && lag > 0) lag--;
    // (Track F9c: while a rocket that fired nothing is still believed, the brain is shown the body the loop predicted)
    const shown = ghost ?? body;
    const fb = { pos: shown.pos, vel: shown.vel, onGround: shown.onGround, gliding: shown.gliding ?? false, boostTicks: ghost ? (ghost.boostTicks ?? 0) : seen };
    const out = brain.step({ tick: t, body: fb, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
    if (out.end) return { end: out.end, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits, bumps, ...(firstHit ? { firstHit } : {}), ...(firstWet ? { firstWet } : {}) };
    if (outAt === undefined && brain.phase !== 'takeoff') outAt = t;
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: c.forward ?? 0, sneak: c.sneak === true, sprint: false };
    const firing = c.fire && rockets > 0;
    const dud = firing && s.dud?.(fired) === true;
    const step: MoveCommand = { ...cmd, ...(firing && !dud ? { boostStart: typeof s.burn === 'function' ? s.burn(fired) : (s.burn ?? GLIDE.boostTicks) } : {}) };
    if (firing) {
      rockets--;
      fired++;
      lastFire = t;
    }
    // Track F9c: a rocket that fires nothing: the loop's prediction flies on with the boost for DUD_SEEN_TICKS, the body without
    if (dud) {
      ghost = body;
      ghostLeft = DUD_SEEN_TICKS;
    }
    if (ghost) {
      const g = stepBody(ghost, dud ? { ...cmd, boostStart: GLIDE.boostMaxTicks } : cmd, world);
      ghost = g.simulated && --ghostLeft >= 0 ? g.state : undefined;
    }
    const before = body;
    const r = stepBody(body, step, world);
    if (!r.simulated) break; // the world is unknown here (the caller's world answers undefined)
    body = r.state;
    // a collision in the air: the glide met a wall (its speed cut) or a ceiling (the rise stopped by a solid)
    if (before.gliding && body.pos.y > Math.floor(body.pos.y) + 0.05 && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) {
      hits++;
      if (!body.collidedHorizontally && (outAt === undefined || t <= outAt + 1)) bumps++;
      else firstHit ??= { tick: t, phase: brain.phase, up: body.pos.y - start.y, out: hdist(body.pos, start) };
    }
    if (deps.terrain && before.gliding) {
      const c = deps.terrain(Math.floor(body.pos.x), Math.floor(body.pos.z));
      if (c.src === 'live') {
        if (c.top !== undefined && hdist(body.pos, start) > LEDGE_RADIUS + 2) knownMax = Math.max(knownMax, c.top);
      } else if (c.src === 'cache' ? c.top !== undefined && body.pos.y < c.top + 1 : body.pos.y < assumedTop(knownMax, 0) + 1) {
        hits++;
        unknownHits++;
      }
    }
    if (body.inWater || body.inLava || liquidContact(world, body.pos).water || liquidContact(world, body.pos).lava) {
      wet = true;
      firstWet ??= { tick: t, phase: brain.phase, up: body.pos.y - start.y, out: hdist(body.pos, start) };
    }
    if (s.until?.(brain, body)) return { end: undefined, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits, bumps, ...(firstHit ? { firstHit } : {}), ...(firstWet ? { firstWet } : {}) };
  }
  return { end: undefined, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits, bumps, ...(firstHit ? { firstHit } : {}), ...(firstWet ? { firstWet } : {}) };
}

/** The simulated landing is on the target: inside a walk landing's cells (else the platform), at its height, dry, no hit, no early end. */
export function landedOn(target: LandingTarget, r: SimResult): boolean {
  const e = r.end;
  if (!e || r.hits > 0 || r.wet) return false;
  if (!e.ok && e.reason !== 'landed_off') return false; // an emergency (no rockets for a go-around, ...) is not the plan
  return onTarget(target, e.landedAt) && Math.abs(e.landedAt.y - target.top) < 1.2;
}

/** Why a simulated flight is not a landing on the target (for the log and the owner). */
export function simWhy(target: LandingTarget, r: SimResult): string {
  const e = r.end;
  if (r.hits > 0) return `hits a wall or ceiling ${r.hits} times`;
  if (r.wet) return 'ends in water';
  if (!e) return r.ticks >= SIM_MAX_TICKS ? `still flying after ${r.ticks} ticks` : `stopped in ${r.phase} (unknown world)`;
  const off = hdist(e.landedAt, target);
  if (!e.ok && e.reason !== 'landed_off') return `${e.reason === 'no_rockets' ? 'short of the landing (it needs a rocket)' : e.reason}: down at ${Math.floor(e.landedAt.x)} ${Math.floor(e.landedAt.y)} ${Math.floor(e.landedAt.z)}, ${off.toFixed(0)} blocks from it`;
  return `down ${off.toFixed(0)} blocks from the landing at y ${e.landedAt.y.toFixed(0)}`;
}

/** Track BH: the fall off a ledge until the glide flies (LEDGE_SPEED): clear (no hit, still in the air, dry) and the height it took. */
export async function ledgeFall(deps: SimDeps, ledge: Ledge): Promise<{ ok: boolean; drop: number | undefined; why: string | undefined }> {
  const d = { x: -Math.sin((ledge.yaw * Math.PI) / 180), z: Math.cos((ledge.yaw * Math.PI) / 180) };
  const start = { x: ledge.x + 0.5, y: ledge.feet, z: ledge.z + 0.5 };
  const far: LandingTarget = { x: start.x + d.x * 500, z: start.z + d.z * 500, top: ledge.feet - 200, half: 1 };
  const r = await simulateFlight(deps, start, far, { cruiseY: ledge.feet - 200, ledge: { yaw: ledge.yaw } }, { maxTicks: 160, until: (b) => b.phase !== 'takeoff' });
  if (r.hits > 0) return { ok: false, drop: undefined, why: 'the fall meets a solid' };
  if (r.wet) return { ok: false, drop: undefined, why: 'the fall ends in water' };
  if (r.end) return { ok: false, drop: undefined, why: 'the fall lands before the glide flies' };
  if (r.phase === 'takeoff') return { ok: false, drop: undefined, why: r.stats.ledgeWalkTicks === undefined ? 'no step off' : 'the glide did not get going' };
  return { ok: true, drop: r.stats.ledgeDrop, why: undefined };
}

/** The takeoff simulation of a flight from a ledge: this many ticks (15 s) from the start, the walk to the edge included. */
export const TAKEOFF_SIM_TICKS = 300;

/**
 * Track BH, the ledge takeoff of a flight (docs/flight.md "Ledge takeoff"): the edges of the start's
 * platform (findLedges, towards the target first), each tried by simulating the flight's first
 * TAKEOFF_SIM_TICKS ticks from it with the real options and rockets (the walk to the edge, the step off,
 * the glide out from under an overhang, the climb): the first whose takeoff meets no solid, stays dry and
 * is still flying (or has landed on the target) wins. `undefined` ledge: none (the line says why).
 */
export async function ledgeTakeoff(
  deps: SimDeps & { cell: CellQuery },
  from: Vec3,
  target: LandingTarget,
  opts: Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'ledge'>,
  rockets: number,
  o: { tries?: number } = {},
): Promise<{ ledge: Ledge | undefined; line: string }> {
  const found = findLedges(deps.cell, from, yawTo(from, target));
  if (!found.ledges.length) return { ledge: undefined, line: `no ledge to step off (${found.why ?? '?'})` };
  const tried: string[] = [];
  for (const ledge of found.ledges.slice(0, o.tries ?? 4)) {
    const start = { x: ledge.x + 0.5, y: ledge.feet, z: ledge.z + 0.5 };
    const sim = await simulateFlight(deps, start, target, { ...opts, ledge: { yaw: ledge.yaw } }, { rockets, maxTicks: TAKEOFF_SIM_TICKS, until: (b) => b.phase === 'approach' });
    const at = `${ledge.x} ${ledge.feet} ${ledge.z} heading ${Math.round(ledge.yaw)}`;
    const ok = sim.hits === 0 && !sim.wet && (sim.end ? landedOn(target, sim) : sim.phase !== 'land' && sim.phase !== 'takeoff');
    if (ok) {
      tried.push(`${at}: clear${sim.stats.ledgeDrop !== undefined ? ` (gliding ${sim.stats.ledgeDrop.toFixed(1)} under the edge)` : ''}`);
      return { ledge, line: `${found.ledges.length} ledges on ${found.cells} cells: ${tried.join('; ')}` };
    }
    tried.push(`${at}: ${sim.end ? simWhy(target, sim) : sim.hits ? `hits a solid ${sim.hits} times` : sim.wet ? 'ends in water' : `${sim.phase} after ${sim.ticks} ticks`}`);
  }
  return { ledge: undefined, line: `${found.ledges.length} ledges on ${found.cells} cells, none clear: ${tried.join('; ')}` };
}

/**
 * Track BH (the Realm, 2026-10-31 04:46Z: a takeoff straight into a tree canopy, `steerClear` saw it 3 ticks
 * before the impact): the jump takeoff's first TAKEOFF_SIM_TICKS ticks simulated with the real options and
 * rockets along `yaws` (the sky check's heading first); the first heading whose climb meets no solid (leaves
 * count) is returned with the line; undefined when none clears.
 */
export async function jumpTakeoff(
  deps: SimDeps,
  from: Vec3,
  target: LandingTarget,
  opts: Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'ledge' | 'takeoffYaw'>,
  rockets: number,
  yaws: readonly number[],
): Promise<{ yaw: number | undefined; line: string }> {
  const tried: string[] = [];
  // a climb the path-ahead check had to steer (it saw the solid only 20 ticks ahead: the Realm's steered 3 ticks, then
  // hit) is kept only as the last resort: a heading whose climb needs no steering at all comes first
  let steered: number | undefined;
  for (const yaw of yaws) {
    const sim = await simulateFlight(deps, from, target, { ...opts, takeoffYaw: yaw }, { rockets, yaw, maxTicks: TAKEOFF_SIM_TICKS, until: (b) => b.phase === 'approach' });
    const ok = sim.hits === 0 && !sim.wet && (sim.end ? landedOn(target, sim) : sim.phase !== 'land' && sim.phase !== 'takeoff');
    if (ok && sim.stats.steered === 0) {
      tried.push(`heading ${Math.round(yaw)}: clear`);
      return { yaw, line: tried.join('; ') };
    }
    if (ok) steered ??= yaw;
    tried.push(`heading ${Math.round(yaw)}: ${ok ? `clear only by steering ${sim.stats.steered} ticks` : sim.unknownHits ? `the climbing turn enters terrain not loaded (${sim.unknownHits} ticks)` : sim.hits ? `hits a solid ${sim.hits} times` : sim.end ? simWhy(target, sim) : `${sim.phase} after ${sim.ticks} ticks`}`);

  }
  return { yaw: steered, line: tried.join('; ') };
}

/** Track F9a: the burns a route takeoff is proven at besides the nominal: the shortest and the longest a rocket burns (Track F0: 9 to 21 ticks) first, then the two between (route/types.ts MID_BURNS). */
export const PROOF_BURNS: readonly number[] = Object.freeze([9, 21, 12, 18]);
/**
 * Track F9b: a takeoff along a learned line is proven at every burn a rocket can have (9 to 21 ticks; PROOF_BURNS first, so a
 * refusal comes as soon as it did). Its simulations need no search and cost about a twentieth of a second each, and the burns
 * between the five do differ: a line drawn from the flood and flown by the same follower cleared the five and met a wall at
 * a burn of 11 (docs/flight.md "Learned exits").
 */
export const LEARNED_PROOF_BURNS: readonly number[] = Object.freeze([...PROOF_BURNS, 10, 11, 13, 14, 16, 17, 19, 20]);
/**
 * Track F9b: and with the burns mixed, which no single burn flies: a first rocket of `first` ticks and `rest` for every later
 * one. The longest first with the shortest after it is the flight with the least energy (the follower fires no second rocket
 * under the roof after a long burn, and the climb's own are then short); the other way round is the one with the most.
 */
export const LEARNED_PROOF_MIXES: readonly (readonly [first: number, rest: number])[] = Object.freeze([Object.freeze([21, 9] as const), Object.freeze([9, 21] as const)]);
/** Track F9c: a learned line is flown as well with a first rocket that fires nothing, the rocket after it burning each of these (the nominal, the shortest, the longest). */
export const LEARNED_PROOF_DUDS: readonly number[] = Object.freeze([GLIDE.boostTicks, 9, 21]);
/** Track F9a: searches one proof remembers (the way out is the same at every burn until its first rocket ends). */
const PROOF_MEMO = 200;
/** Track F9a: a proven climb's time to the goal is its simulated ticks plus the way left at this speed (blocks a tick: the cruise's). */
export const PROOF_CRUISE_SPEED = 1.4;

/**
 * Track F9b: a cell question remembered for one proof, within 2048 blocks of `from` (beyond that, and for anything that is not
 * a whole cell, the question is asked again). A learned line's simulations ask the same cells over and over (the follower's
 * looks, the climb's path checks: three million questions for one proof on the owner's cave) and the live model's answer is
 * not free.
 */
function remembered<T>(from: Vec3, cell: (x: number, y: number, z: number) => T): (x: number, y: number, z: number) => T {
  const ox = Math.floor(from.x) - 2048;
  const oz = Math.floor(from.z) - 2048;
  const seen = new Map<number, T>();
  return (x, y, z) => {
    const dx = x - ox;
    const dy = y + 64;
    const dz = z - oz;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || !Number.isInteger(dz) || dx < 0 || dx > 4095 || dz < 0 || dz > 4095 || dy < 0 || dy > 511) return cell(x, y, z);
    const k = (dx * 4096 + dz) * 512 + dy;
    if (seen.has(k)) return seen.get(k) as T;
    const v = cell(x, y, z);
    seen.set(k, v);
    return v;
  };
}

/** What a route takeoff's proof flies: the brain's own options for it (`BrainOptions.route` / `.routeTakeoff`). */
export interface RouteTakeoffFlight {
  route: NonNullable<BrainOptions['route']>;
  takeoff: NonNullable<BrainOptions['routeTakeoff']>;
}

/**
 * Track F9a: the brain's options for a planned route takeoff, the same for its proof and for the flight (one place, so
 * the flight is what was proven): the goals, the margin and the weight; `curve` (the proof's, and the flight's when the
 * takeoff was proven): after the exit the climb keeps the line the body leaves the exit on and turns to the target only
 * as the path ahead stays clear (brain.ts climbYaw); a way out through several goals is searched in its pieces and lands
 * when it loses its plan under the roof (`underRoof`).
 */
export function routeTakeoffOptions(route: Pick<TakeoffRoute, 'goals' | 'margin' | 'weight' | 'pieces' | 'riskCost' | 'guide'>, curve: boolean): NonNullable<BrainOptions['routeTakeoff']> {
  return {
    goals: route.goals,
    margin: route.margin,
    weight: route.weight,
    ...(curve ? { curve: true } : {}),
    ...(route.pieces !== undefined ? { pieces: route.pieces, underRoof: true } : {}),
    ...(route.riskCost !== undefined ? { riskCost: route.riskCost } : {}),
    // Track F9b: a learned way out is flown along its recorded line by the guide follower (and lands when it loses the line)
    ...(route.guide ? { guide: { line: route.guide.line, open: route.guide.open }, underRoof: true } : {}),
  };
}

/**
 * Track F9a (docs/flight.md "Cave exit"; decisions/0077-cave-exit.md): a route takeoff proven as the jump and the
 * vertical takeoff are: the whole takeoff simulated from standing with the real options and rockets, the route's
 * tracker flying its plan out to the exit, then the climb as the brain will fly it (the exit's line kept until the sky is
 * open over the body, then the heading turned to the target as the path ahead clears), for TAKEOFF_SIM_TICKS after the plan's ticks. It clears when the
 * tracker came out through the exit, the flight met no solid, stayed dry and is still flying (or landed on the
 * target), at the nominal burn and at PROOF_BURNS (every rocket of the way out and of the climb that short, that
 * long). `ok` with the tick the body had open sky over it (`out`: the takeoff's own measure, a quick way OUT) and the
 * time to the goal (the nominal flight's simulated ticks plus the way left at the cruise's speed), or the line saying
 * what it met and at which burn. The route's planner may answer later (the worker): the
 * simulation waits for it. Track F9b: a takeoff along a learned line (`flight.takeoff.guide`: the guide follower in the
 * tracker's place, no planner at all) is proven the same way and with more of it: every burn from 9 to 21
 * (LEARNED_PROOF_BURNS), two mixes of them (LEARNED_PROOF_MIXES), each burn's end seen GLIDE.boostEndLag ticks late; its
 * refusal for a hit or for water says where.
 */
export async function routeTakeoff(
  deps: SimDeps,
  from: Vec3,
  target: LandingTarget,
  opts: Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'ledge' | 'takeoffYaw' | 'vertical' | 'route' | 'routeTakeoff'>,
  rockets: number,
  flight: RouteTakeoffFlight,
  o: { planTicks?: number; burns?: readonly number[]; endLag?: number } = {},
): Promise<{ ok: boolean; ticks?: number; out?: number; line: string; sims: number; dud?: boolean }> {
  let pending: Promise<unknown> | undefined;
  // the same search is asked once (the burns fly the same way out until their first rocket ends)
  const memo = new Map<string, ReturnType<RouteTakeoffFlight['route']['plan']>>();
  const plan: RouteTakeoffFlight['route']['plan'] = (req) => {
    const key = JSON.stringify(req);
    let r = memo.get(key);
    if (r === undefined) {
      r = flight.route.plan(req);
      if (memo.size < PROOF_MEMO) memo.set(key, r);
    }
    if (r instanceof Promise) pending = r.catch(() => undefined);
    return r;
  };
  const wait = (): Promise<unknown> | undefined => {
    const p = pending;
    pending = undefined;
    return p;
  };
  const yaw = yawTo(from, target);
  const maxTicks = TAKEOFF_SIM_TICKS + (o.planTicks ?? 0);
  // Track F9b: a learned line's simulations see every burn's end as late as the input loop does (GLIDE.boostEndLag), so a climb
  // on rockets back to back has its gaps
  const learned = flight.takeoff.guide !== undefined;
  const endLag = o.endLag ?? (learned ? GLIDE.boostEndLag : undefined);
  // (and its fifteen simulations ask the same cells of a world that does not change while they run: remembered for the proof)
  const world = learned ? { ...deps, world: { ...deps.world, solidAt: remembered(from, (x, y, z) => deps.world.solidAt(x, y, z)) } } : deps;
  const grid = learned ? { ...flight.route.grid, solid: remembered(from, (x, y, z) => flight.route.grid.solid(x, y, z)) } : flight.route.grid;
  const fly = (burn?: number | ((rocket: number) => number), dud = false): Promise<SimResult> =>
    simulateFlight(world, from, target, { ...opts, takeoffYaw: yaw, route: { ...flight.route, grid, plan }, routeTakeoff: flight.takeoff }, { rockets, yaw, maxTicks, until: (b) => b.phase === 'approach', wait, ...(burn !== undefined ? { burn } : {}), ...(endLag !== undefined ? { endLag } : {}), ...(dud ? { dud: (rocket: number) => rocket === 0 } : {}) });
  const verdict = (sim: SimResult): string | undefined => {
    if (sim.stats.routeTakeoffEnd !== 'out') return sim.stats.routeTakeoffEnd ? `the way out ended ${sim.stats.routeTakeoffEnd}` : sim.end ? `down before the exit (${sim.end.ok ? 'landed' : sim.end.reason})` : `still on the way out after ${sim.ticks} ticks`;
    if (sim.unknownHits) return `enters terrain not loaded (${sim.unknownHits} ticks)`;
    // (a head bump on the way out, a ceiling touched while rising and no wall met, is the route plan's business as it was before
    // this track: the room, the hole and the stack of Track F3 take off under their roofs so; every other contact refuses)
    const hits = sim.hits - (sim.bumps ?? 0);
    // (Track F9b: a learned line's refusal says where: the Realm's log is all there is to see of it)
    const where = learned && sim.firstHit ? ` (the first at tick ${sim.firstHit.tick} in the ${sim.firstHit.phase}, ${sim.firstHit.up.toFixed(0)} over the start and ${sim.firstHit.out.toFixed(0)} blocks from it)` : '';
    if (hits) return `hits a solid ${hits} time${hits === 1 ? '' : 's'}${where}`;
    if (sim.wet) return `ends in water${learned && sim.firstWet ? ` (at tick ${sim.firstWet.tick} in the ${sim.firstWet.phase}, ${sim.firstWet.up.toFixed(0)} over the start and ${sim.firstWet.out.toFixed(0)} blocks from it)` : ''}`;
    if (sim.end) return landedOn(target, { ...sim, hits }) ? undefined : simWhy(target, { ...sim, hits });
    return sim.phase === 'land' || sim.phase === 'takeoff' ? `${sim.phase} after ${sim.ticks} ticks` : undefined;
  };
  const sim = await fly();
  let sims = 1;
  const why = verdict(sim);
  if (why !== undefined) return { ok: false, line: why, sims };
  const burns = o.burns ?? (learned ? LEARNED_PROOF_BURNS : PROOF_BURNS);
  for (const burn of burns) {
    const x = verdict(await fly(burn));
    sims++;
    if (x !== undefined) return { ok: false, line: `clear at the nominal burn; ${x} at a burn of ${burn} ticks`, sims };
  }
  const mixes = learned && !o.burns ? LEARNED_PROOF_MIXES : [];
  for (const [first, rest] of mixes) {
    const x = verdict(await fly((rocket) => (rocket === 0 ? first : rest)));
    sims++;
    if (x !== undefined) return { ok: false, line: `clear at every single burn; ${x} with a first rocket of ${first} ticks and ${rest} for the later ones`, sims };
  }
  // Track F9c: and with a first rocket that fires nothing (the Realm's one failed learned exit): the rocket after it at the
  // nominal burn and at the extremes. A line that clears everything else and not this is still proven, and says so: the
  // caller flies it only when no other take survives a dud first rocket (route/takeoff.ts planTakeoffRoute)
  let dud: { ok: boolean; line: string } | undefined;
  if (learned && !o.burns) {
    for (const burn of LEARNED_PROOF_DUDS) {
      const x = verdict(await fly(burn, true));
      sims++;
      if (x !== undefined) {
        dud = { ok: false, line: `with a first rocket that fires nothing: ${x} at a burn of ${burn} ticks for the one after it` };
        break;
      }
    }
    dud ??= { ok: true, line: `and with a first rocket that fires nothing (the next at ${LEARNED_PROOF_DUDS.join(', ')})` };
  }
  const s = sim.stats;
  const turned = s.routeHeadingAt !== undefined ? `the heading from ${Math.round(s.routeExitYaw ?? yaw)} at the exit to the target's by tick ${s.routeHeadingAt}` : `the heading ${Math.round(s.routeExitYaw ?? yaw)} from the exit on`;
  return { ok: true, ticks: sim.ticks + hdist(sim.body.pos, target) / PROOF_CRUISE_SPEED, ...(s.routeSkyAt !== undefined ? { out: s.routeSkyAt } : {}), ...(dud ? { dud: dud.ok } : {}), line: `clear at burns of ${[GLIDE.boostTicks, ...burns].join(', ')} ticks${mixes.length ? ` and of ${mixes.map(([a, b]) => `${a} then ${b}`).join(', ')}` : ''}${dud?.ok ? ` ${dud.line}` : ''}${dud && !dud.ok ? `; ${dud.line}` : ''} (through the exit at tick ${s.routeTakeoffTicks ?? '?'}, ${s.routeSkyAt !== undefined ? `open sky at tick ${s.routeSkyAt}` : 'no open sky in the simulation'}, ${turned}${s.steered ? `, steered ${s.steered} ticks` : ''})`, sims };
}

/** The vertical takeoff's straight climb: the lowest and highest hand-over over the start, and the step between the heights tried. */
export const VERTICAL_MIN = 6;
export const VERTICAL_MAX = 48;
const VERTICAL_STEP = 2;
/** Open cells the column must have over the hand-over height (the head, and the pitch-over's first ticks). */
export const VERTICAL_SPARE = 3;
/** Simulations at most for one vertical takeoff (each a whole climb). */
const VERTICAL_SIMS = 3;

/**
 * The vertical takeoff (docs/flight.md "Vertical takeoff"): when the jump takeoff is refused (trees, walls, a
 * courtyard, a shaft; any heading), go straight up the start's column and take off from above it. The column
 * over the head must be open (an unknown cell counts as blocked) up to the hand-over height plus
 * VERTICAL_SPARE; the hand-over height is the lowest from VERTICAL_MIN up whose sky check (plan.ts
 * `takeoffSky` from that height: its 3 x 3 and its run along a heading) passes; the whole climb is then
 * simulated (as `jumpTakeoff`: no hit, dry, it gets to the approach). `top` (blocks over the feet) and the
 * heading, or undefined with the why.
 */
export async function verticalTakeoff(
  deps: SimDeps & { cell: CellQuery },
  from: Vec3,
  target: LandingTarget,
  opts: Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop' | 'ledge' | 'takeoffYaw' | 'vertical'>,
  rockets: number,
  run: number,
): Promise<{ top?: number; yaw?: number; line: string }> {
  if (rockets <= 0) return { line: 'no rockets for a straight climb' };
  const fx = Math.floor(from.x);
  const fz = Math.floor(from.z);
  const feet = Math.floor(from.y);
  const highest = Math.min(VERTICAL_MAX, Math.floor(opts.cruiseY) - feet);
  let open = 0;
  for (let y = feet + 1; y <= feet + highest + VERTICAL_SPARE; y++) {
    if (deps.cell(fx, y, fz) !== false) break;
    open = y - feet;
  }
  if (open < VERTICAL_MIN + VERTICAL_SPARE) return { line: `the column over the start is open only ${open} up` };
  const tried: string[] = [];
  let sims = 0;
  for (let top = VERTICAL_MIN; top + VERTICAL_SPARE <= open && top <= highest; top += VERTICAL_STEP) {
    const sky = takeoffSky({ x: from.x, y: feet + top, z: from.z }, target, opts.cruiseY, run, deps.cell);
    if (!sky.ok) continue;
    const sim = await simulateFlight(deps, from, target, { ...opts, vertical: { top }, takeoffYaw: sky.yaw }, { rockets, yaw: sky.yaw, maxTicks: TAKEOFF_SIM_TICKS, until: (b) => b.phase === 'approach' });
    sims++;
    const ok = sim.hits === 0 && !sim.wet && (sim.end ? landedOn(target, sim) : sim.phase !== 'land' && sim.phase !== 'takeoff');
    if (ok) {
      tried.push(`${top} up, heading ${Math.round(sky.yaw)}: clear`);
      return { top, yaw: sky.yaw, line: tried.join('; ') };
    }
    tried.push(`${top} up: ${sim.hits ? `hits a solid ${sim.hits} times` : sim.end ? simWhy(target, sim) : `${sim.phase} after ${sim.ticks} ticks`}`);
    if (sims >= VERTICAL_SIMS) break;
  }
  return { line: tried.length ? tried.join('; ') : `no height up to ${Math.min(open - VERTICAL_SPARE, highest)} with open sky around it` };
}

export interface GlideDownOptions {
  /** The goal must be at least this far below the feet (glideDownMinDrop). */
  minDrop: number;
  /** ... and this far away horizontally (glideDownMinDistance). */
  minDistance: number;
  /** Ledges simulated at most (the best first). */
  tries?: number;
  /** Wall time for all the simulations, ms. */
  budgetMs?: number;
  /** Rockets at hand (optional: 0 = a pure glide); the real flight gets the same. */
  rockets?: number;
  /** The flight's other options (flyMargin, flyGoArounds), the same as the real flight's. */
  flight?: Pick<BrainOptions, 'margin' | 'goArounds'>;
  now?: () => number;
}

/** Track BH: the brain options of a glide down from `ledge` to `target` (the simulation and the real flight use the same). */
export function glideOptions(target: LandingTarget, ledge: Ledge, extra: Pick<BrainOptions, 'margin' | 'goArounds'> = {}): Omit<BrainOptions, 'groundAt' | 'obstacle' | 'skyTop'> {
  return { cruiseY: target.top, ledge: { yaw: ledge.yaw }, ...extra };
}

export type GlideDownPlan = { ok: true; ledge: Ledge; sim: SimResult; line: string } | { ok: false; why: string; line: string };

/**
 * Track BH, the glide down (docs/flight.md "Glide down"): from `from` to the landing `target` (findLanding's,
 * confirmed walk to the goal), without a rocket: the goal at least `minDrop` below and `minDistance` away,
 * an edge of the platform with a clear fall corridor (findLedges), and the whole flight simulated from it
 * (rockets 0) landing on the target's cells. The first ledge whose flight lands wins; the why of each
 * failure goes into the line.
 */
export async function planGlideDown(deps: SimDeps & { cell: CellQuery }, from: Vec3, target: LandingTarget, o: GlideDownOptions): Promise<GlideDownPlan> {
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const drop = from.y - target.top;
  const dist = hdist(from, target);
  const head = `glide down to ${Math.floor(target.x)} ${target.top} ${Math.floor(target.z)} (${drop.toFixed(0)} below, ${dist.toFixed(0)} away)`;
  if (drop < o.minDrop) return { ok: false, why: `the landing is only ${drop.toFixed(0)} blocks below`, line: `${head}: too little drop` };
  if (dist < o.minDistance) return { ok: false, why: `the landing is only ${dist.toFixed(0)} blocks away`, line: `${head}: too near` };
  const found = findLedges(deps.cell, from, yawTo(from, target));
  if (!found.ledges.length) return { ok: false, why: `no edge to step off (${found.why ?? '?'})`, line: `${head}: no ledge (${found.why ?? '?'})` };
  const tried: string[] = [];
  const tries = o.tries ?? 4;
  for (const ledge of found.ledges.slice(0, tries)) {
    if (tried.length && now() - t0 > (o.budgetMs ?? 8000)) break;
    const start = { x: ledge.x + 0.5, y: ledge.feet, z: ledge.z + 0.5 };
    const sim = await simulateFlight(deps, start, target, glideOptions(target, ledge, o.flight), { rockets: o.rockets ?? 0 });
    const at = `${ledge.x} ${ledge.feet} ${ledge.z} heading ${Math.round(ledge.yaw)}`;
    if (landedOn(target, sim)) {
      const e = sim.end!;
      tried.push(`${at}: lands ${hdist(e.landedAt, target).toFixed(1)} from the centre in ${sim.ticks} ticks`);
      return { ok: true, ledge, sim, line: `${head}: ${found.ledges.length} ledges on ${found.cells} cells, ${Math.round(now() - t0)} ms: ${tried.join('; ')}` };
    }
    tried.push(`${at}: ${simWhy(target, sim)}`);
  }
  const why = `no simulated glide lands there (${tried.join('; ')})`;
  return { ok: false, why, line: `${head}: ${found.ledges.length} ledges on ${found.cells} cells, ${Math.round(now() - t0)} ms: ${tried.join('; ')}` };
}
