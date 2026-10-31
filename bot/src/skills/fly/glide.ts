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
import { hdist, onTarget, yawDiff, yawTo, type CellQuery, type LandingTarget } from './plan.ts';
import { assumedTop, type TerrainQuery } from './terrain.ts'; // Track BL

/** The ledge's fall corridor: no solid at the body's height (feet .. head + 1) this many blocks out along the heading, a block either side. */
export const LEDGE_CORRIDOR = 10;
/** The least drop under the edge (and under the corridor's first blocks): the glide flies (LEDGE_SPEED) after about 9 blocks of fall at LEDGE_DIVE (the formula: the same 12.5 to 0.9 at any pitch up to 20, pitch 20 the shortest way out). */
export const LEDGE_MIN_DROP = 12;
/** Edges are looked for within this many blocks of walk on the start's platform (the same floor height). */
export const LEDGE_RADIUS = 10;
/** A start platform with at most this many cells within SMALL_PLATFORM_R blocks is a small platform (a pillar, a ledge): the ledge takeoff. */
export const SMALL_PLATFORM = 12;
export const SMALL_PLATFORM_R = 3;
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
  if (kit.elytraLeft !== undefined && kit.elytraLeft <= elytraWornLimit(toolWearLimit)) return { ok: false, line: elytraWornLine(kit.elytraLeft) };
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
  s: { rockets?: number; maxTicks?: number; yaw?: number; until?: (brain: FlightBrain, body: BodyState) => boolean } = {},
): Promise<SimResult> {
  const world = deps.world;
  const brain = new FlightBrain(target, { ...opts, ...(deps.groundAt ? { groundAt: deps.groundAt } : {}), ...(deps.skyTop ? { skyTop: deps.skyTop } : {}), ...(deps.terrain ? { terrain: deps.terrain } : {}), obstacle: (x, y, z) => world.solidAt(x, y, z) === true });
  // Track BL: the corridor check against the terrain the live model does not know
  let knownMax = Math.floor(start.y) - 1;
  let unknownHits = 0;
  let body = initialBody(start, true);
  let cmd: MoveCommand = { ...IDLE_COMMAND, yaw: s.yaw ?? opts.ledge?.yaw ?? 0 };
  let rockets = s.rockets ?? 0;
  let lastFire = -100;
  let hits = 0;
  let wet = false;
  const max = s.maxTicks ?? SIM_MAX_TICKS;
  let t = 1;
  for (; t <= max; t++) {
    if (t % SIM_YIELD === 0 && deps.yieldNow) await deps.yieldNow();
    const fb = { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 };
    const out = brain.step({ tick: t, body: fb, yaw: cmd.yaw, pitch: cmd.pitch, rockets, canFire: t - lastFire >= 4, health: 20, elytraLeft: 400 });
    if (out.end) return { end: out.end, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits };
    const c = out.control;
    cmd = { ...cmd, yaw: c.yaw, pitch: c.pitch, jump: c.jump, glide: c.glide, forward: c.forward ?? 0, sneak: c.sneak === true, sprint: false };
    const step: MoveCommand = { ...cmd, ...(c.fire && rockets > 0 ? { boostStart: GLIDE.boostTicks } : {}) };
    if (c.fire && rockets > 0) {
      rockets--;
      lastFire = t;
    }
    const before = body;
    const r = stepBody(body, step, world);
    if (!r.simulated) break; // the world is unknown here (the caller's world answers undefined)
    body = r.state;
    // a collision in the air: the glide met a wall (its speed cut) or a ceiling (the rise stopped by a solid)
    if (before.gliding && body.pos.y > Math.floor(body.pos.y) + 0.05 && (body.collidedHorizontally || (body.collidedVertically && !body.onGround))) hits++;
    if (deps.terrain && before.gliding) {
      const c = deps.terrain(Math.floor(body.pos.x), Math.floor(body.pos.z));
      if (c.src === 'live') {
        if (c.top !== undefined) knownMax = Math.max(knownMax, c.top);
      } else if (c.src === 'cache' ? c.top !== undefined && body.pos.y < c.top + 1 : body.pos.y < assumedTop(knownMax, 0) + 1) {
        hits++;
        unknownHits++;
      }
    }
    if (body.inWater || body.inLava || liquidContact(world, body.pos).water || liquidContact(world, body.pos).lava) wet = true;
    if (s.until?.(brain, body)) return { end: undefined, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits };
  }
  return { end: undefined, ticks: t, hits, wet, body, stats: brain.stats, phase: brain.phase, unknownHits };
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
