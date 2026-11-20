// Track F9e round 2 (docs/flight.md "What the Realm showed (Track F9e, round 2)"; decisions/0082 addendum): the decisions
// of a flight that stays under a roof, in one place: the bot (chat/commands-fly.ts hopFor, exitPieceFor) and the probes
// (scripts/cave-hop-probe.ts, cave-drawn-probe.ts `--bot`) call these with the same numbers, so a probe's table is what
// the bot does. Round 1's probes ran on the whole fixture with a radius of their own and the bot ran on its live model
// with the cache behind it: the Realm found the difference.
//
// The world is two layers (`UnderWorld`): the LIVE model (the chunks the server has sent: what the body will meet) and
// the world CACHE behind it (what the bot saw once). The rule:
//
//   a line is drawn, proven and flown only through cells of the live model.
//
// An unknown cell is a solid for the proof and for the follower alike, so nothing is proven, and no rocket fired, into
// cells never seen live. The cache says where the way goes on: when no way lies wholly in the live model, the way is
// looked for on both layers and the flight is a PIECE of it: a hop to a standable cell on the way, UNDER_STOP cells short
// of the first cell the live model does not have, proven from standing to standing like any hop. The body stands there,
// the chunks ahead are sent, and the trip asks again from where it stands: hops, standing in between, by need. A piece
// needs no new way of flying and no stopping distance: it ends in a touchdown that was proven.
import type { Vec3 } from '../../../connection/types.ts';
import type { BurnRange } from '../burn.ts';
import { routeHop, routeTakeoffOptions, type SimDeps } from '../glide.ts';
import type { LandingTarget } from '../plan.ts';
import type { RouteGrid } from '../route/grid.ts';
import { TAKEOFF_WEIGHT, type TakeoffRoute } from '../route/takeoff.ts';
import type { Planner } from '../route/tracker.ts';
import { DRAW_FLOOD_MAX, floodOut, floodTo, rememberedGrid, type DrawnWay } from './draw.ts';
import { ENTRY_AIR, ENTRY_SOLID, entryTouchdowns, type EntryLine } from './entry.ts';
import { FOLLOW_MARGIN } from './follow.ts';
import { guideLength } from './guide.ts';
import { drawHopsOn, HOP_FLOOD_MAX, HOP_RADIUS, hopLast, type DrawnHop } from './hop.ts';

interface Cell {
  x: number;
  y: number;
  z: number;
}

/** The two layers of the bot's world, a cell's class in each (entry.ts ENTRY_AIR, ENTRY_SOLID, ENTRY_WATER, ENTRY_LAVA). */
export interface UnderWorld {
  /** The live model; undefined where no chunk is loaded. */
  live(x: number, y: number, z: number): number | undefined;
  /** The world cache; undefined where it has never seen the chunk. */
  cached(x: number, y: number, z: number): number | undefined;
}

/** A piece ends this many cells of the way before the first cell the live model does not have (the follower looks 6 ticks ahead: 10 blocks at a rocket's speed). */
export const UNDER_STOP = 12;
/** A piece's touchdown is looked for this many cells farther back each time one has no floor or is not proven. */
export const UNDER_STEP = 6;
/** A cell of the way counts as seen live when the columns this far round it are loaded. */
export const UNDER_ROUND = 3;
/** A way out is looked for this far (blocks, straight) and through this many cells: the deep cave's is 413 blocks of line. */
export const EXIT_RADIUS = 448;
export const EXIT_FLOOD_MAX = 150_000;
/** The lines proven at most for one hop, and no proof begun once this long has gone (ms). */
export const UNDER_PROOFS = 3;
export const UNDER_BUDGET_MS = 6000;

/** The grid of the live model alone: an unknown cell is a solid (the route planner's own rule). */
export const liveGrid = (w: UnderWorld): RouteGrid => ({ solid: (x, y, z) => (w.live(x, y, z) ?? ENTRY_SOLID) !== ENTRY_AIR });
/** The grid of what was ever seen: the live model, the cache where it has nothing, a solid where neither has anything. */
export const seenGrid = (w: UnderWorld): RouteGrid => ({ solid: (x, y, z) => (w.live(x, y, z) ?? w.cached(x, y, z) ?? ENTRY_SOLID) !== ENTRY_AIR });

/** The first cell of a way the live model does not have (its index; the way's length: all of it is live). */
export function liveReach(w: UnderWorld, way: readonly Cell[]): number {
  for (let i = 0; i < way.length; i++) {
    const c = way[i]!;
    for (const [dx, dz] of [[0, 0], [UNDER_ROUND, 0], [-UNDER_ROUND, 0], [0, UNDER_ROUND], [0, -UNDER_ROUND]] as const) if (w.live(c.x + dx, c.y, c.z + dz) === undefined) return i;
  }
  return way.length;
}

/** A piece's touchdown has no water within this many blocks of it (a touchdown beside a pool ends in it). */
export const UNDER_DRY = 2;

/** A piece's touchdown lies at most this far under the way's cell (the way flies high through a hall) and this far beside it. */
export const UNDER_DOWN = 10;
export const UNDER_BESIDE = 2;

/**
 * A cell a body can stand in under a cell of the way or under a cell beside it (UNDER_BESIDE each way, UNDER_DOWN down),
 * in the live model: a floor (three of the four cells beside it standable too), dry (no water or lava within UNDER_DRY of
 * it), with free air from the way's cell down to it. The nearest column first. With the cells from the way's cell to it.
 */
export function standNear(w: UnderWorld, c: Cell): { cell: Cell; down: Cell[] } | undefined {
  const cls = (x: number, y: number, z: number): number | undefined => w.live(x, y, z);
  const stands = (x: number, y: number, z: number): boolean => cls(x, y, z) === ENTRY_AIR && cls(x, y - 1, z) === ENTRY_SOLID && cls(x, y + 1, z) === ENTRY_AIR;
  const cols: [number, number][] = [];
  for (let dx = -UNDER_BESIDE; dx <= UNDER_BESIDE; dx++) for (let dz = -UNDER_BESIDE; dz <= UNDER_BESIDE; dz++) cols.push([dx, dz]);
  cols.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  for (const [dx, dz] of cols) {
    const down: Cell[] = [];
    // (beside the way's cell: the cells between at its height are free)
    let free = true;
    for (let s = 1; s <= Math.max(Math.abs(dx), Math.abs(dz)) && free; s++) {
      const x = c.x + Math.round((dx * s) / Math.max(Math.abs(dx), Math.abs(dz)));
      const z = c.z + Math.round((dz * s) / Math.max(Math.abs(dx), Math.abs(dz)));
      if (cls(x, c.y, z) !== ENTRY_AIR || cls(x, c.y + 1, z) !== ENTRY_AIR) free = false;
      else down.push({ x, y: c.y, z });
    }
    if (!free) continue;
    for (let dy = 0; dy >= -UNDER_DOWN; dy--) {
      const x = c.x + dx;
      const y = c.y + dy;
      const z = c.z + dz;
      if (cls(x, y, z) !== ENTRY_AIR) break;
      if (dy !== 0) down.push({ x, y, z });
      if (!stands(x, y, z)) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([ex, ez]) => stands(x + ex!, y, z + ez!)).length < 3) break;
      let wet = false;
      for (let ex = -UNDER_DRY; ex <= UNDER_DRY && !wet; ex++) for (let ez = -UNDER_DRY; ez <= UNDER_DRY && !wet; ez++) for (let ey = -1; ey <= 0; ey++) if ((cls(x + ex, y + ey, z + ez) ?? ENTRY_SOLID) > ENTRY_SOLID) wet = true;
      if (wet) break;
      return { cell: { x, y, z }, down };
    }
  }
  return undefined;
}

export interface UnderOptions {
  rockets: number;
  /** The burn of the rockets at hand (burn.ts); none: the plain rocket's. */
  burn?: BurnRange;
  /** The flight's margin (the setting flyMargin). */
  margin: number;
  /** The roof's height the floods look up to. */
  top: number;
  /** The route planner the brain's options want (a hop asks none). */
  plan: Planner;
  now?: () => number;
  budgetMs?: number;
  proofs?: number;
  /**
   * Track F22: the ticks a burn's end is seen late on this connection (rocket.ts RocketLag): the proof flies its line with
   * every burn ending in a slow place of the line and seen that late (glide.ts routeHop). Absent, or GLIDE.boostEndLag or
   * less: the proof as it was.
   */
  late?: number;
}

/** What a decision found: the hop to fly (its route and line for the flight's target), or none; and the log's words. */
export interface UnderPick {
  hop?: {
    drawn: DrawnHop;
    route: TakeoffRoute;
    /** The cell the flight ends standing in: the goal's own touchdown, or a piece's. */
    cell: Cell;
    /** The proof's own measure: the cell the flights stood by. */
    goal: Cell;
    length: number;
    /** A piece of a longer way: the cells of the whole way, the cell of it the piece ends by, why it ends there. */
    piece?: { of: number; to: number; why: string };
    /** With a first rocket that fires nothing the flight comes down short with no hit. */
    frail: boolean;
  };
  tried: string[];
  cells: number;
  sims: number;
  drawMs: number;
  /** One line for the log: what was looked at, what was tried, what is flown. */
  said: string;
}

/** The brain's route for a drawn hop (the same for its proof and for its flight). */
export function hopRoute(h: DrawnHop, from: Vec3): TakeoffRoute {
  const ticks = Math.ceil(h.guide.ticks[h.guide.ticks.length - 1] ?? 0);
  return { exit: { x: h.cell.x, y: h.cell.y, z: h.cell.z, steps: h.steps, dist: Math.hypot(h.cell.x + 0.5 - from.x, h.cell.y - from.y, h.cell.z + 0.5 - from.z) }, goals: [], margin: FOLLOW_MARGIN, weight: TAKEOFF_WEIGHT, yaw: h.guide.yaw, ticks, rockets: 1, edges: `the hop ${h.guide.path}`, nodes: 0, ms: 0, guide: { line: h.guide, open: Infinity, off: 0 }, drawn: { steps: h.steps, berth: h.berth, room: 1 }, hop: { hand: h.hand }, proven: true };
}

/** The flight's target for a hop to `cell`: its line as the entry, the hop as the route takeoff. */
export function hopTarget(h: DrawnHop, cell: Cell): LandingTarget & { entry: { line: EntryLine; goal: LandingTarget } } {
  const c = { x: cell.x + 0.5, z: cell.z + 0.5 };
  return { x: c.x, z: c.z, top: cell.y, half: 2, entry: { line: h.line, goal: { x: c.x, z: c.z, top: cell.y, half: 2 } } };
}

/** The hops drawn along `way` to `cell` on the live model, proven one after another (glide.ts routeHop, on the live model alone): the first that clears. */
async function proveAlong(sim: SimDeps, live: RouteGrid, from: Vec3, way: DrawnWay, goal: Cell, cell: Cell, o: UnderOptions, t0: number, tried: string[], proofsLeft: { n: number }): Promise<{ hop?: NonNullable<UnderPick['hop']>; sims: number; short?: boolean }> {
  const now = o.now ?? (() => performance.now());
  const d = drawHopsOn(live, from, way, goal, cell, o.burn);
  if (!d.hops.length) {
    tried.push(d.tried[d.tried.length - 1] ?? 'no line');
    return { sims: 0, short: d.tried.some((t) => /too short|of air over the start/.test(t)) };
  }
  let sims = 0;
  for (const h of d.hops) {
    if (proofsLeft.n <= 0) break;
    if (sims && now() - t0 > (o.budgetMs ?? UNDER_BUDGET_MS)) {
      tried.push(`${h.guide.path}: not tried (${Math.round(now() - t0)} ms gone)`);
      proofsLeft.n = 0;
      break;
    }
    proofsLeft.n--;
    const route = hopRoute(h, from);
    const p = await routeHop(sim, from, hopTarget(h, h.cell), { cruiseY: from.y + 24, margin: o.margin, goArounds: 0 }, o.rockets, { route: { grid: live, plan: o.plan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks, yaw: h.guide.yaw, ...(o.late !== undefined ? { late: o.late } : {}) });
    sims += p.sims;
    const length = Math.round(guideLength(h.guide));
    tried.push(`${h.guide.path} (${length} blocks of line, ${h.at}, ${Math.round(h.climb)} from its lowest to its highest): ${p.line}${p.ok ? '' : ': refused'}`);
    if (p.ok) return { hop: { drawn: h, route, cell: h.cell, goal, length, frail: p.dud === false }, sims };
  }
  return { sims };
}

/**
 * The flight along a way of cells (the body's first; `to`: the cell it ends in, a touchdown by the goal or an open-sky
 * cell): the whole way when it lies in the live model and ends in a touchdown, else a PIECE of it: a hop to a standable
 * cell UNDER_STOP short of the first cell the live model does not have, farther back when that one is not proven.
 */
async function alongWay(w: UnderWorld, sim: SimDeps, live: RouteGrid, from: Vec3, way: DrawnWay, goal: Cell | undefined, o: UnderOptions, t0: number, tried: string[]): Promise<{ hop?: NonNullable<UnderPick['hop']>; sims: number }> {
  const cells = way.way;
  const reach = liveReach(w, cells);
  const left = { n: o.proofs ?? UNDER_PROOFS };
  let sims = 0;
  if (goal && reach >= cells.length) {
    const r = await proveAlong(sim, live, from, way, goal, { x: way.x, y: way.y, z: way.z }, o, t0, tried, left);
    return r.hop ? { hop: r.hop, sims: r.sims } : { sims: r.sims };
  }
  const why = goal ? `the live model ends ${reach} cells along a way of ${cells.length}` : reach >= cells.length ? `the way out's ${cells.length} cells are all in the live model and no line out along it was proven` : `the way out: the live model ends ${reach} cells along its ${cells.length}`;
  const least = Math.ceil(hopLast(o.burn).min * 0.7);
  let looked = 0;
  for (let j = Math.min(cells.length - 1, reach) - UNDER_STOP; j >= least && left.n > 0; j -= UNDER_STEP) {
    const t = standNear(w, cells[j]!);
    if (!t) continue;
    looked++;
    const piece: DrawnWay = { x: t.cell.x, y: t.cell.y, z: t.cell.z, steps: j + t.down.length, cost: 0, way: [...cells.slice(0, j + 1), ...t.down] };
    const r = await proveAlong(sim, live, from, piece, t.cell, t.cell, o, t0, tried, left);
    sims += r.sims;
    if (r.hop) return { hop: { ...r.hop, piece: { of: cells.length, to: j, why } }, sims };
    if (r.short) break;
  }
  if (!looked) tried.push(`${why}; no floor to stand on under its first ${Math.max(0, Math.min(cells.length - 1, reach) - UNDER_STOP)} cells`);
  else tried.push(`${why}; no piece of it proven`);
  return { sims };
}

/**
 * The hop from where the body stands (feet `from`) to a goal's cell under the same roof: the way looked for on what was
 * ever seen (one flood), flown whole when it lies in the live model, else as a piece (see the file comment). Nothing
 * found: `hop` undefined and `said` says why.
 */
export async function pickHop(w: UnderWorld, sim: SimDeps, from: Vec3, goal: Cell, label: string, o: UnderOptions): Promise<UnderPick> {
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const live = rememberedGrid(liveGrid(w), from);
  const seen = rememberedGrid(seenGrid(w), from);
  const tried: string[] = [];
  const seenCls = (x: number, y: number, z: number): number => w.live(x, y, z) ?? w.cached(x, y, z) ?? ENTRY_SOLID;
  const stands = (c: Cell): boolean => seenCls(c.x, c.y - 1, c.z) === ENTRY_SOLID && seenCls(c.x, c.y, c.z) === ENTRY_AIR && seenCls(c.x, c.y + 1, c.z) === ENTRY_AIR;
  const c = entryTouchdowns(seenCls, goal).find(stands);
  const f = c ? floodTo(seen, from, c, { radius: HOP_RADIUS, max: HOP_FLOOD_MAX, top: o.top }) : undefined;
  const cells = f?.cells ?? 0;
  const drawMs = now() - t0;
  let sims = 0;
  let found: UnderPick['hop'];
  if (!c) tried.push('no cell a body can stand in within reach of the goal');
  else if (!f?.way) tried.push(`no way under the roof to the cell ${c.x - goal.x} ${c.y - goal.y} ${c.z - goal.z} from the goal's (${cells} cells looked at)`);
  else {
    const r = await alongWay(w, sim, live, from, f.way, goal, o, t0, tried);
    sims = r.sims;
    found = r.hop;
  }
  const head = `fly: hop: to ${label} under the roof: ${cells} cells looked at in ${Math.round(drawMs)} ms`;
  const flown = found ? `${found.piece ? `a piece: ${found.length} blocks of line to a cell ${found.piece.to} of ${found.piece.of} cells along the way (${found.piece.why}); the trip asks again from there` : `along the drawn line ${found.drawn.guide.path} to the touchdown ${found.cell.x - goal.x} ${found.cell.y - goal.y} ${found.cell.z - goal.z} from the goal's cell`}` : 'no hop';
  return { ...(found ? { hop: found } : {}), tried, cells, sims, drawMs, said: `${head}; ${tried.join('; ')} -> ${flown} (${sims} simulated, ${Math.round(now() - t0)} ms)` };
}

/**
 * Track F22 (docs/flight.md "The hop asked from a walk (Track F22)"): whether a hop MAY be flown from about here, for a
 * walk's re-check: the way looked for as `pickHop` looks for it and a line drawn along it (the whole way when it lies in
 * the live model, else to the first floor a piece could end on), and nothing proven. A line is proven from where the
 * body stands, so a walking body cannot ask for the proof: by the time its answer comes the body is somewhere else. The
 * walk asks this (the flood and one line: no simulation), stops where it says a hop may be there, and the hop is
 * decided once, standing (learn/standing.ts). `may` false: `why` says what stands against it (no way, a line too short
 * to fly, no head room over the start, no floor to end a piece on).
 */
export function scoutHop(w: UnderWorld, from: Vec3, goal: Cell, o: Pick<UnderOptions, 'burn' | 'top'>): { may: boolean; cells: number; why: string } {
  const live = rememberedGrid(liveGrid(w), from);
  const seen = rememberedGrid(seenGrid(w), from);
  const seenCls = (x: number, y: number, z: number): number => w.live(x, y, z) ?? w.cached(x, y, z) ?? ENTRY_SOLID;
  const stands = (c: Cell): boolean => seenCls(c.x, c.y - 1, c.z) === ENTRY_SOLID && seenCls(c.x, c.y, c.z) === ENTRY_AIR && seenCls(c.x, c.y + 1, c.z) === ENTRY_AIR;
  const c = entryTouchdowns(seenCls, goal).find(stands);
  if (!c) return { may: false, cells: 0, why: 'no cell a body can stand in within reach of the goal' };
  const f = floodTo(seen, from, c, { radius: HOP_RADIUS, max: HOP_FLOOD_MAX, top: o.top });
  if (!f.way) return { may: false, cells: f.cells, why: `no way under the roof to the goal's cell (${f.cells} cells looked at)` };
  const cells = f.way.way;
  const reach = liveReach(w, cells);
  const drawn = (way: DrawnWay, to: Cell): { may: boolean; cells: number; why: string } => {
    const d = drawHopsOn(live, from, way, to, to, o.burn);
    return { may: d.hops.length > 0, cells: f.cells, why: d.hops.length ? `${d.hops.length} line${d.hops.length === 1 ? '' : 's'} to prove` : (d.tried[d.tried.length - 1] ?? 'no line') };
  };
  if (reach >= cells.length) return drawn(f.way, { x: f.way.x, y: f.way.y, z: f.way.z });
  const least = Math.ceil(hopLast(o.burn).min * 0.7);
  for (let j = Math.min(cells.length - 1, reach) - UNDER_STOP; j >= least; j -= UNDER_STEP) {
    const t = standNear(w, cells[j]!);
    if (!t) continue;
    return drawn({ x: t.cell.x, y: t.cell.y, z: t.cell.z, steps: j + t.down.length, cost: 0, way: [...cells.slice(0, j + 1), ...t.down] }, t.cell);
  }
  return { may: false, cells: f.cells, why: `the live model ends ${reach} cells along a way of ${cells.length} and there is no floor to stand on under its first ${Math.max(0, Math.min(cells.length - 1, reach) - UNDER_STOP)} cells` };
}

/**
 * A piece of the way OUT: for a body under a roof whose way to the open sky does not lie in the live model (the route
 * takeoff found no drawn way out there: learn/draw.ts on the live grid): the way to the sky on what was ever seen, and a
 * hop along it as far as the live model goes. Undefined `hop`: no way on the cache either, or no piece proven.
 */
export async function pickExitPiece(w: UnderWorld, sim: SimDeps, from: Vec3, o: UnderOptions): Promise<UnderPick> {
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const live = rememberedGrid(liveGrid(w), from);
  const seen = rememberedGrid(seenGrid(w), from);
  const tried: string[] = [];
  const f = floodOut(seen, from, o.top, { radius: EXIT_RADIUS, max: EXIT_FLOOD_MAX, exits: 1 });
  const cells = f.cells;
  let sims = 0;
  let found: UnderPick['hop'];
  const way: DrawnWay | undefined = f.ways[0];
  const drawMs = now() - t0;
  if (!way) tried.push(`no way under the roof to the open sky in the world cache either (a flood of ${f.cells} cells, within ${EXIT_RADIUS})`);
  else {
    const r = await alongWay(w, sim, live, from, way, undefined, o, t0, tried);
    sims = r.sims;
    found = r.hop;
  }
  const head = `fly: way out: ${cells} cells looked at in ${Math.round(drawMs)} ms`;
  const flown = found ? `a piece of it: ${found.length} blocks of line to a cell ${found.piece!.to} of ${found.piece!.of} cells along it (${found.piece!.why}); the trip asks again from there` : 'no piece of it';
  return { ...(found ? { hop: found } : {}), tried, cells, sims, drawMs, said: `${head}; ${tried.join('; ')} -> ${flown} (${sims} simulated, ${Math.round(now() - t0)} ms)` };
}

// (kept in reach of the probes: the live flood's own cap for a way out)
export { DRAW_FLOOD_MAX };
