// Track F17 (docs/flight.md "Windows beside the walk (Track F17)"; decisions/0091): the walk under a roof flies the
// stretches of its way where a window is faster. A walk handed a whole way (Track W2: the landing probe's path from the
// cell a flight landed on at a cave's mouth) knows the cells it will stand on. Beside the walk, a scout takes a node
// of the way a few seconds ahead of the body, lays a window from it along the way (the way pulled tight into via
// points, the cave style's corridor window: corridor/stretches.ts nextWindow), prices the walk of the same stretch (the
// probe's ticks at the walk's pace) and has the window proven in the route worker while the body walks on. A proof
// that reaches the window's landing, robust to the burn, with a flight whose time and overhead beat the walk's price
// by WAY_SAVE_MIN_S and WAY_SAVE_SHARE, arms the window: when the body stands on its start the walk stops, the window
// is flown and the walk goes on along the way from where it lands. Nothing else stops the walk: a proof that fails or
// does not pay costs the worker's time, never the body's. This file holds the rules (the window from the way, the
// prices, the gate, which start comes next); chat/commands-fly.ts runs them beside the walk.
import type { Vec3 } from '../../../world/types.ts';
import type { StretchOptions } from '../corridor/drive.ts';
import { UNDER_FLY_MIN } from '../corridor/executor.ts';
import { cellPrice, type LandMob } from '../landmobs.ts';
import { PATH_PACE, probeTicks } from '../landprice.ts';
import { MAX_JUMP_RISE } from '../../nav/astar.ts';
import type { KitBurn, RoutePlan } from '../route/types.ts';
import { boreMargin, lineClear, nextWindow, standable, WINDOW_STEP, type CellSolid, type Stretch, type Window } from '../corridor/stretches.ts';
import { CAVE_STYLE, caveStretchOptions } from './style.ts';

/** A node of the way as the walk has it (nav/astar.ts PathNode: the cell, the feet height, the move's ticks into it). */
export interface WayNode {
  x: number;
  y: number;
  z: number;
  feet: number;
  cost: number;
}

/**
 * The budget of a window's proof (ms, nodes): the cave style's (CAVE_STYLE proveMs 2 s, 80 000 nodes). The proof runs in
 * the route worker while the body walks on, so its time is the worker's, not the walk's; over a 3 x 3 bore an 80-block
 * window's proof often runs out of it 3 to 5 goals in (2 400 to 3 500 nodes a second on the test server), but 5 s did not
 * take more windows offline (the hook cave, n 10 a kit: the plain kit's the same 8 of 10 landed, the crafted kit's 1
 * window against 5): the lead grows with it, and the starts it passes by are the windows that paid.
 */
export const WAY_PROVE_MS = CAVE_STYLE.proveMs;
export const WAY_PROVE_NODES = CAVE_STYLE.proveNodes;
/**
 * Seconds of walk ahead of the body a window's start is chosen: the proof's budget and the stop. A start the body reaches
 * before its proof comes back is passed by, and the next one ahead is proven instead.
 */
export const WAY_LEAD_S = WAY_PROVE_MS / 1000 + 0.5;
/** A start is proven again only this many blocks of way past the last one tried (a proof from the next node is nearly the same search). */
export const WAY_RETRY_BLOCKS = 6;
/**
 * The time a window costs beside its plan's ticks (seconds): the walk's stop, the elytra on and the rockets into the
 * hotbar before the takeoff, the touchdown's settle past the plan's end, the chestplate on again and the walk's new
 * start. Measured on the test server (docs/flight.md, Track F17): 1.1 to 1.9 s.
 */
export const WAY_OVER_S = 2;
/**
 * A window is taken only when it saves at least this many seconds and this share of the walk's price for the same
 * stretch. A window that bails out stands where it stopped and the walk goes on from there: it loses at most its own time
 * and the overhead (offline on the owner's cave and the corridor world, a bailed window stood 1 to 5 s of walk short of
 * its landing); the margins keep the expected saving over zero for bail-outs up to about 3 in 10 windows.
 */
export const WAY_SAVE_MIN_S = 4;
export const WAY_SAVE_SHARE = 0.35;
/** The rockets left after the plan's (the open-air flight's reserve): a window that would leave fewer is walked; nothing is refilled under a roof here. */
export const WAY_ROCKET_RESERVE = 2;
/** A walk's proofs at most (the worker's time over a long cave walk), and windows that bail out before the scout stops for the walk. */
export const WAY_PROOFS_MAX = 24;
export const WAY_BAILS_MAX = 2;
/** The body is on a node of the way within this (blocks, feet to feet). */
export const WAY_NEAR = 2;
/** The fastest a window flies under a roof (blocks a second; the bore's 88 blocks in 86 ticks): a stretch whose walk could not pay even then is not proven. */
export const WAY_FLY_FAST = 22;
/** A window's start is armed when the body comes within this of its cell (horizontal, blocks) standing on its floor. */
export const WAY_ARM_NEAR = 0.8;
/** The body may stand this far (blocks) from the proven start and the proven plan is flown; farther, the window is proven again from where it stands. */
export const WAY_START_OFF = 0.3;
/** The scout looks at the body this often (ms; 5 ticks: a sprinting body moves about 1.4 blocks, WAY_ARM_NEAR either side of a start is 1.6). */
export const WAY_TICK_MS = 250;

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** The feet position over a node (the cell's centre). */
export const nodeFeet = (n: WayNode): Vec3 => ({ x: n.x + 0.5, y: n.feet, z: n.z + 0.5 });
/** The feet cell of a node. */
export const nodeCell = (n: WayNode): Vec3 => ({ x: n.x, y: Math.floor(n.feet + 1e-6), z: n.z });

/**
 * The walk's price from node `i` to node `j` of the way (seconds): the landing probe's ticks (landprice.ts probeTicks: the
 * path's move costs less the extra a drop that cannot be climbed back pays; the probe plans with no surface preference
 * under a roof) at `pace` (PATH_PACE, the landing search's own: the closed-loop walk measured 1.18 to 1.25 times the
 * probe's seconds on the owner's cave, so the gate prices a walk a little faster than it is and takes fewer windows).
 */
export function wayPrice(way: readonly (WayNode & { move?: string })[], irreversibleDrop: number, pace = PATH_PACE): (i: number, j: number) => number {
  const at: number[] = [0];
  const prefs = { underground: 0, irreversibleDrop, jumpRise: MAX_JUMP_RISE };
  for (let k = 1; k < way.length; k++) {
    const a = way[k - 1]!;
    const b = way[k]!;
    at.push(at[k - 1]! + probeTicks([{ ...a, move: a.move ?? 'walk' }, { ...b, move: b.move ?? 'walk' }], prefs));
  }
  return (i, j) => (Math.abs(at[Math.max(i, j)]! - at[Math.min(i, j)]!) / 20) * pace;
}

/** The way's length from its first node to each node (blocks, feet to feet). */
export function wayAlong(way: readonly WayNode[]): number[] {
  const s: number[] = [0];
  for (let i = 1; i < way.length; i++) s.push(s[i - 1]! + dist(nodeFeet(way[i - 1]!), nodeFeet(way[i]!)));
  return s;
}

/** The node of the way at or after `after` nearest the body's feet, within WAY_NEAR; undefined when the body is off the way. */
export function wayAt(way: readonly WayNode[], pos: Vec3, after = 0, near = WAY_NEAR): number | undefined {
  let best: number | undefined;
  let bd = near;
  for (let i = Math.max(0, after); i < way.length; i++) {
    const d = dist(nodeFeet(way[i]!), pos);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/**
 * The way from node `from` to node `to` pulled tight into via points: from each point the farthest node in clear line at
 * the body's height (stretches.ts lineClear) within `step` blocks, the last node last. The corridor window takes them as
 * its via points (3 x 3 boxes 3 high from their feet, each moved to the passage's middle by its node: wayMiddle) and lays
 * its step boxes and bends between them. The points as the way's node indices.
 */
export function wayPointNodes(way: readonly WayNode[], from: number, to: number, solid: CellSolid, step = WINDOW_STEP): number[] {
  const out: number[] = [from];
  let at = from;
  while (at < to) {
    let far = at + 1;
    for (let j = to; j > at + 1; j--) {
      const a = nodeFeet(way[at]!);
      const b = nodeFeet(way[j]!);
      if (dist(a, b) <= step && lineClear(solid, a, b)) {
        far = j;
        break;
      }
    }
    out.push(far);
    at = far;
  }
  return out;
}

/**
 * Where a way winds back within reach of its start: the via node before the first one (after the first two) that lies
 * no farther from the start by the plane than the first via after it; undefined when the way does not. The corridor
 * window takes the via point nearest the body by the plane as the first still ahead (stretches.ts firstAhead), so on a
 * way that comes back past the start a wall away (a hook: offline, a window laid from the bore in took its first goal in
 * the bore back, 14 blocks across 8 of stone, and every proof of it hit) the stretch ends before it comes back.
 */
export function wayWindsBack(way: readonly WayNode[], ids: readonly number[]): number | undefined {
  if (ids.length < 3) return undefined;
  const s = nodeFeet(way[ids[0]!]!);
  const plane = (i: number): number => {
    const p = nodeFeet(way[i]!);
    return Math.hypot(p.x - s.x, p.z - s.z);
  };
  const d1 = plane(ids[1]!);
  for (let k = 2; k < ids.length - 1; k++) if (plane(ids[k]!) <= d1 + 1e-9) return ids[k - 1]!;
  return undefined;
}

/** The most a window's way may turn from its first heading by the plane (degrees): wayTurns. */
export const WAY_TURN_MAX = 60;

/**
 * Where a way turns away from its first heading: the via node before the first leg (after the first) whose heading by
 * the plane is more than `max` degrees off the first leg's; undefined when none is. A window round a bend of a 3 x 3
 * bore is the corridor flight's weak case (the bore's bend window bailed out offline before and after this track), and on
 * the test server a proven window round the hook cave's bend ended on the floor at its corner, 3 of its 7 goals in: so a
 * window lands before a bend and the next one starts beyond it. Offline, n 10 a kit (the PC, the trip's seconds p50,
 * 60 / 120 / 180 degrees): the hook cave's crafted kit 32.7 / 42.9 / 42.9 (walked: 42.9), its plain kit 30.4 / 42.9 /
 * 33.1; the corridor world's crafted kit 36.6 / 36.2 / 36.2 (walked: 51.3), its plain kit 36.6 / 26.1 / 26.1 (its one
 * bend of 90 degrees flown in 13 of 19 windows). 60 for the crafted kit the Realm flies on.
 */
export function wayTurns(way: readonly WayNode[], ids: readonly number[], max = WAY_TURN_MAX): number | undefined {
  if (ids.length < 3) return undefined;
  const heading = (a: number, b: number): number => Math.atan2(way[b]!.z - way[a]!.z, way[b]!.x - way[a]!.x);
  const h0 = heading(ids[0]!, ids[1]!);
  for (let k = 2; k < ids.length; k++) {
    let d = (Math.abs(heading(ids[k - 1]!, ids[k]!) - h0) * 180) / Math.PI;
    if (d > 180) d = 360 - d;
    if (d > max) return ids[k - 1]!;
  }
  return undefined;
}

/**
 * The least head room over a node's feet for the window: a standing start in a passage lower than this has no takeoff
 * (offline on the owner's cave, every proof from a node 2 high came back "every primitive from every reached state hits"
 * in under 20 ms; the corridor world's 3 x 3 bore takes off), and a window through a lower stretch was never proven.
 */
export const WAY_HEAD_MIN = 3;

/** The air cells over a feet cell, the feet's own first (at most 5). */
export function headRoom(solid: CellSolid, c: Vec3): number {
  let h = 0;
  while (h < 5 && solid(c.x, c.y + h, c.z) === false) h++;
  return h;
}

/** The passage round the way's nodes from `from` to `to`: the least head room over the feet and the least width at the body's height across the way (the axis the way does not run along at that node), capped at 5. */
export function wayClearance(way: readonly WayNode[], from: number, to: number, solid: CellSolid): { width: number; height: number } {
  let width = 5;
  let height = 5;
  for (let i = from; i <= to; i++) {
    const c = nodeCell(way[i]!);
    const h = headRoom(solid, c);
    const run = (dx: number, dz: number): number => {
      let n = 0;
      while (n < 4 && solid(c.x + dx * (n + 1), c.y + 1, c.z + dz * (n + 1)) === false) n++;
      return n;
    };
    const a = way[Math.max(from, i - 1)]!;
    const b = way[Math.min(to, i + 1)]!;
    const alongX = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    const w = Math.min(5, alongX ? 1 + run(0, 1) + run(0, -1) : 1 + run(1, 0) + run(-1, 0));
    height = Math.min(height, Math.max(1, h));
    width = Math.min(width, w);
  }
  return { width, height };
}

export interface WayWindowOptions {
  solid: CellSolid;
  /** The cells a body may stand on (the real solids; `solid` has water as an obstacle too). */
  floor?: CellSolid;
  loaded: (x: number, z: number) => boolean;
  /** The walk's seconds from node `i` to node `j` of the way. */
  price: (i: number, j: number) => number;
  maxBlocks?: number;
  landReach?: number;
  tailMin?: number;
  /** The scout's lead (seconds of walk; WAY_LEAD_S). */
  leadS?: number;
  /** The most the window's way may turn (degrees; WAY_TURN_MAX). */
  turnMax?: number;
  /** Track F19: the shortest window laid (blocks; default UNDER_FLY_MIN). */
  minBlocks?: number;
  /** Track F19: the least head room over the feet a window's stretch runs on through (default WAY_HEAD_MIN; its start keeps WAY_HEAD_MIN). */
  passMin?: number;
}

export interface WayWindow {
  win: Window;
  /** The way's node the window starts on and the node nearest its landing. */
  start: number;
  /** The takeoff (feet, the middle of its cell): by the start node, the middle of the passage (wayMiddle). */
  from: Vec3;
  land: number;
  /** The walk's price from the start to the landing node (seconds). */
  walkS: number;
}

/**
 * The window from node `start` along the way: the cave style's corridor window over the way's via points, at most
 * `maxBlocks` (CAVE_STYLE windowBlocks) along them, landing on a standable cell of the way (the stretch's end, or the last
 * via point reached: nextWindow's cut). Undefined when the start is no dry floor, the window is shorter than UNDER_FLY_MIN,
 * or its landing is not on the way.
 */
export function wayWindow(way: readonly WayNode[], start: number, o: WayWindowOptions, along: readonly number[] = wayAlong(way)): WayWindow | undefined {
  const s = way[start];
  if (!s || start >= way.length - 1) return undefined;
  const c = nodeCell(s);
  // (no takeoff under a roof lower than WAY_HEAD_MIN over the feet: every primitive of a standing start hits)
  if (!standable(o.solid, c.x, c.y, c.z, o.floor) || headRoom(o.solid, c) < WAY_HEAD_MIN) return undefined;
  // the takeoff: the cell by the node farthest from the passage's walls (wayMiddle)
  const t = wayMiddle(o.solid, c, o.floor);
  const from = { x: t.x + 0.5, y: s.feet, z: t.z + 0.5 };
  const max = o.maxBlocks ?? CAVE_STYLE.windowBlocks;
  // (the stretch runs up to twice the window's blocks of way, and ends before the first node with less head room than
  // WAY_HEAD_MIN: a low stretch is the walk's, the window lands before it and a window after it starts beyond it)
  let to = start;
  while (to + 1 < way.length && along[to + 1]! - along[start]! <= 2 * max && headRoom(o.solid, nodeCell(way[to + 1]!)) >= (o.passMin ?? WAY_HEAD_MIN)) to++;
  // (a way that winds back past its start, or turns more than WAY_TURN_MAX off its first heading, ends before it does:
  // wayWindsBack, wayTurns)
  for (let guard = 0; guard < 8; guard++) {
    const ids = wayPointNodes(way, start, to, o.solid);
    const back = wayWindsBack(way, ids) ?? wayTurns(way, ids, o.turnMax);
    if (back === undefined) break;
    to = back;
  }
  // the stretch's end on a standable node (a node in water or on a ladder is the walk's: back to one the window may land on)
  while (to > start && !standable(o.solid, way[to]!.x, nodeCell(way[to]!).y, way[to]!.z, o.floor)) to--;
  if (to === start) return undefined;
  // (the takeoff, the via points and the stretch's end in the passage's middle by their nodes, wayMiddle: on a way along a
  // bore's side row the via boxes held one row of air beside the wall row, and the crafted kit's proofs came back not robust)
  const e = wayMiddle(o.solid, nodeCell(way[to]!), o.floor);
  const points = wayPointNodes(way, start, to, o.solid).map((i, k): Vec3 => {
    if (k === 0) return from;
    const m = i === to ? e : wayMiddle(o.solid, nodeCell(way[i]!), o.floor);
    return { x: m.x + 0.5, y: way[i]!.feet, z: m.z + 0.5 };
  });
  const stretch: Stretch = { space: 'under', points, portals: [], end: points[points.length - 1]! };
  const w = nextWindow(stretch, from, { loaded: o.loaded, solid: o.solid, endCell: e, maxBlocks: max, tailMin: o.tailMin ?? CAVE_STYLE.tailMin, landReach: o.landReach ?? CAVE_STYLE.landReach, ...(o.floor ? { floor: o.floor } : {}) });
  if (!w || w.blocks < (o.minBlocks ?? UNDER_FLY_MIN)) return undefined;
  // the landing's node: the way's node nearest the window's end, after the start
  let land: number | undefined;
  let bd = 2.5;
  for (let i = start + 1; i <= to; i++) {
    const d = dist(nodeFeet(way[i]!), { x: w.end.x + 0.5, y: w.end.y, z: w.end.z + 0.5 });
    if (d <= bd) {
      bd = d;
      land = i;
    }
  }
  if (land === undefined) return undefined;
  // the passage's own clearance (a corridor window without portals is laid as a 3 x 3 bore)
  const cl = wayClearance(way, start, land, o.solid);
  const win: Window = { ...w, width: cl.width, height: cl.height, margin: boreMargin(cl.width, cl.height) };
  return { win, start, from, land, walkS: o.price(start, land) };
}

/**
 * The middle of the passage by a node of the way (a window's takeoff and its stretch's end): of the node's cell and its 8
 * neighbours at its height that are dry floor with WAY_HEAD_MIN of head room (a corner one only past an open side), the
 * one whose nearest wall at the body's height is farthest (each side's run counted up to 4), the node's own on a tie. The
 * walk's own path keeps to no middle: on the e2e's 3 x 3 bore the probe's way ran along its side row, where the body
 * standing in its cell is 0.2 from the wall, inside a margin of 0.3, and every proof from it came back `every primitive
 * from every reached state hits` at its 13th node.
 */
export function wayMiddle(solid: CellSolid, c: Vec3, floor?: CellSolid): Vec3 {
  const run = (x: number, z: number, dx: number, dz: number): number => {
    let n = 0;
    while (n < 4 && solid(x + dx * (n + 1), c.y + 1, z + dz * (n + 1)) === false) n++;
    return n;
  };
  const score = (x: number, z: number): number => Math.min(Math.min(run(x, z, 1, 0), run(x, z, -1, 0)), Math.min(run(x, z, 0, 1), run(x, z, 0, -1)));
  let best = { x: c.x, y: c.y, z: c.z };
  const own = score(c.x, c.z);
  let bs = own;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const x = c.x + dx;
      const z = c.z + dz;
      if (!standable(solid, x, c.y, z, floor) || headRoom(solid, { x, y: c.y, z }) < WAY_HEAD_MIN) continue;
      // (a corner cell only past an open side: never through a wall's edge)
      const open = (qx: number, qz: number): boolean => solid(qx, c.y, qz) === false && solid(qx, c.y + 1, qz) === false;
      if (dx && dz && !open(x, c.z) && !open(c.x, z)) continue;
      const sc = score(x, z);
      // (of equally good cells the nearest the node: a side neighbour before a corner)
      if (sc > bs || (sc === bs && bs > own && Math.abs(dx) + Math.abs(dz) < Math.abs(best.x - c.x) + Math.abs(best.z - c.z))) {
        bs = sc;
        best = { x, y: c.y, z };
      }
    }
  }
  return best;
}

export interface WayGateInput {
  walkS: number;
  /** The plan's flight (its ticks: the takeoff, the flight, the settle). */
  flyS: number;
  /** A proof from where the body stands, when the proven start is too far (its seconds). */
  proofS?: number;
  rockets: number;
  loose: number;
  overS?: number;
}

/** The window is worth taking: its time and overhead beat the walk's price by WAY_SAVE_MIN_S and WAY_SAVE_SHARE, with the rocket reserve left. The line says the prices either way. */
export function wayGate(g: WayGateInput): { take: boolean; line: string; saveS: number } {
  const cost = g.flyS + (g.overS ?? WAY_OVER_S) + (g.proofS ?? 0);
  const save = g.walkS - cost;
  const need = Math.max(WAY_SAVE_MIN_S, WAY_SAVE_SHARE * g.walkS);
  const prices = `the walk ${g.walkS.toFixed(1)} s, the window ${cost.toFixed(1)} s (${g.flyS.toFixed(1)} s of flight${g.proofS ? `, ${g.proofS.toFixed(1)} s of proof` : ''}, ${(g.overS ?? WAY_OVER_S).toFixed(1)} s more)`;
  if (g.loose < g.rockets + WAY_ROCKET_RESERVE) return { take: false, saveS: save, line: `${prices}: ${g.loose} rockets at hand, the plan fires ${g.rockets} and ${WAY_ROCKET_RESERVE} stay: walked` };
  if (save < need) return { take: false, saveS: save, line: `${prices}: saves ${save.toFixed(1)} s, under the ${need.toFixed(1)} s a window must: walked` };
  return { take: true, saveS: save, line: `${prices}: saves ${save.toFixed(1)} s` };
}

/**
 * A proof a window beside the walk flies on: complete (every goal of the window, its landing too), robust to the burn's
 * extremes, and at least the window's margin (stretches.ts boreMargin) from every solid all the way, where the corridor's
 * proofs ask only CAVE_STYLE proveClearMin (0.15). The margin is the room the window was sized for: the burn's spread
 * between its extremes (the plan is searched robust to the two ends only) and the tracker's error. Offline (docs/flight.md,
 * Track F17), every window flown on a proof that kept its margin (0.30 to 0.34 of 0.3, the corridor world) ended on the
 * floor unhurt, 28 of 40 on its landing; every one flown on a proof that came within it (0.20 and 0.28, the owner's cave's
 * tall passage) bailed out, 39 of 40, six with a wall hit of 1.9 to 3.8.
 *
 * And its landing begins unpowered (wayLandsUnpowered): no rocket of the plan may still burn when it enters its landing's
 * stage. A bail-out there cannot stop a burning rocket, which pushes the body on for up to its burn: offline on the hook
 * cave, windows whose plans entered the landing at 1.5 a tick with a burn left (plain rockets, 5 to 7 fired) bailed out in
 * the chamber 6 of 10 times, 3 of them into its wall (1.1 to 2.9); every window that landed on the corridor world entered
 * its landing with the burn out (0.9 to 1.4 a tick).
 *
 * Track F18: the landing's rule is judged before the clearance, and the reason gives the clearance after the takeoff where
 * it differs (RoutePlan.flightClearance); which proofs fly is unchanged. A standing start's takeoff edge is swept on the bare
 * box (search.ts startMarginFor): the body standing in its cell is 0.2 from a wall beside it at its feet or head height and
 * 0.28 from one at a corner, so on an uneven cave floor `clearance 0.20` is the takeoff's, not the flight's. On the owner's
 * cave's tall passage every complete proof (both kits, offline 2026-11-16, the same searches as on the Realm) kept 0.41 to
 * 0.65 after its takeoff and entered its landing with the rocket still burning: the landing's rule is what refuses them,
 * and flown anyway they bail out (docs/flight.md, Track F18). Judging the margin after the takeoff alone was measured and
 * not taken: on the hook cave it took more windows with the crafted kit and lost on its inner way; the owner's cave was
 * unchanged.
 */
export function wayProven(p: Pick<RoutePlan, 'complete' | 'robust' | 'clearance' | 'reached' | 'states'> & Partial<Pick<RoutePlan, 'flightClearance'>>, win: Pick<Window, 'margin' | 'goals'>): { ok: boolean; why: string } {
  const need = Math.max(CAVE_STYLE.proveClearMin, win.margin);
  if (!p.complete) return { ok: false, why: `partial, ${p.reached} of ${win.goals.length} goals` };
  if (!p.robust) return { ok: false, why: 'not robust to the burn' };
  const clr = p.flightClearance !== undefined && p.flightClearance > p.clearance + 0.005 ? `clearance ${p.clearance.toFixed(2)} at the takeoff, ${p.flightClearance.toFixed(2)} after it` : `clearance ${p.clearance.toFixed(2)}`;
  if (!wayLandsUnpowered(p, win.goals.length)) return { ok: false, why: `${clr}, but a rocket still burns where its landing begins` };
  if (p.clearance < need - 1e-9) return { ok: false, why: `${clr}, under the window's margin ${need.toFixed(2)}` };
  return { ok: true, why: `clearance ${p.clearance.toFixed(2)}` };
}

/** The plan enters its last goal's stage (the landing) with no burn left that may still run (its state's boost range). */
export function wayLandsUnpowered(p: Pick<RoutePlan, 'states'>, goals: number): boolean {
  const s = p.states.find((q) => q.wp >= goals - 1);
  return s !== undefined && s.boost.max <= 0;
}

/**
 * The tracker's rules of a window beside the walk: the cave style's, with a reference inside a solid's reach taken for
 * none (tracker.ts TrackerRules.refClear). Offline on the corridor world with the crafted kit, 20 windows a side: 11
 * landed with it, 5 without, none hurt either way; with the plain kit the same 16 of 20. It is not in the cave style
 * itself: over the generator's caves (`!fly`'s corridor windows) it landed as many and one wide cave took more damage
 * in two runs of two (docs/flight.md, Track F17).
 */
export function wayStretchOptions(w: Pick<Window, 'margin'> & Partial<Pick<Window, 'height'>>, kit?: Readonly<KitBurn>): Pick<StretchOptions, 'margin' | 'window' | 'rules' | 'riskCost' | 'geodesic' | 'pieces' | 'midBurns' | 'kit'> {
  const so = caveStretchOptions(w);
  return { ...so, rules: { ...(so.rules ?? {}), refClear: true }, ...(kit ? { kit } : {}) };
}

/** No window with a hostile this near the body (blocks, feet to feet): the stop, the elytra on and the takeoff stand still about 1.5 s (the F16 refill keeps the same 8). */
export const WAY_MOB_REACH = 8;

/**
 * The hostiles against a window: refused with a hostile within WAY_MOB_REACH of the body or, with the landing's look on
 * (`flyLandMobs`), with a creeper within LAND_MOBS.refuse of the landing; else what the landing's hostiles cost in seconds
 * (landmobs.ts cellPrice), added to the window's cost. The guard has whatever comes nearer meanwhile: it pre-empts the
 * walk (no window is armed then) and a window in the air flies on to its landing (the flight is above the guard).
 */
export function wayMobs(body: Vec3, land: { x: number; z: number; feet: number }, mobs: readonly LandMob[], landLook: boolean): { refuse?: string; priceS: number; note?: string } {
  let near: { m: LandMob; d: number } | undefined;
  for (const m of mobs) {
    const d = dist(m, body);
    if (d <= WAY_MOB_REACH && (!near || d < near.d)) near = { m, d };
  }
  if (near) return { refuse: `a ${near.m.type} ${near.d.toFixed(1)} blocks away`, priceS: Infinity };
  if (!landLook) return { priceS: 0 };
  const p = cellPrice(land, mobs);
  return p.refuse ? { refuse: `the landing: ${p.refuse}`, priceS: Infinity } : { priceS: p.priceS, ...(p.note ? { note: p.note } : {}) };
}

/** The flight could pay at all: the walk's price over what the fastest window under a roof and its overhead would cost, by the margins. */
export function wayWorthProving(walkS: number, blocks: number): boolean {
  const best = blocks / WAY_FLY_FAST + WAY_OVER_S;
  return walkS - best >= Math.max(WAY_SAVE_MIN_S, WAY_SAVE_SHARE * walkS);
}

/**
 * Which start the scout proves next, as the body walks the way: the first node at least WAY_LEAD_S of walk ahead of the
 * body's node, WAY_RETRY_BLOCKS past the last start tried, whose window could pay at all (wayWorthProving); none once
 * WAY_PROOFS_MAX proofs or WAY_BAILS_MAX bail-outs were spent, or when nothing ahead could pay.
 */
export class WayScout {
  readonly along: number[];
  readonly way: readonly WayNode[];
  private readonly o: WayWindowOptions;
  private tried = -Infinity;
  proofs = 0;
  bails = 0;
  constructor(way: readonly WayNode[], o: WayWindowOptions) {
    this.way = way;
    this.o = o;
    this.along = wayAlong(way);
  }

  /** The next window to prove with the body on node `at`; undefined: nothing to prove now (nothing ahead pays, or the budget is spent). */
  next(at: number): WayWindow | undefined {
    if (this.proofs >= WAY_PROOFS_MAX || this.bails >= WAY_BAILS_MAX) return undefined;
    for (let i = at + 1; i < this.way.length - 1; i++) {
      if (this.o.price(at, i) < (this.o.leadS ?? WAY_LEAD_S)) continue;
      if (this.along[i]! - this.tried < WAY_RETRY_BLOCKS) continue;
      // (the rest of the way from here could not pay even flown at the fastest: nothing further on can either)
      if (!wayWorthProving(this.o.price(i, this.way.length - 1), this.along[this.way.length - 1]! - this.along[i]!)) return undefined;
      const w = wayWindow(this.way, i, this.o, this.along);
      if (!w || !wayWorthProving(w.walkS, w.win.blocks)) continue;
      this.tried = this.along[i]!;
      this.proofs++;
      return w;
    }
    return undefined;
  }

  /** A window flew and bailed out (the scout stops after WAY_BAILS_MAX). */
  bailed(): void {
    this.bails++;
  }
}
