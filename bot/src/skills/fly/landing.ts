// The landing cell of a flight that ends in a walk (wave 11, Track BF; docs/flight.md "Landing v3",
// decision 0047). Two Realm failures shaped it: a flight that "landed" on the sea floor (the highest
// solid of a column under 15 blocks of water was taken for ground) and one that landed on the roof
// of a 30 x 30 creeper spawning box because the cell came from the world cache and no walking path
// from it was ever checked. The rules here:
//
//   - only dry ground: a floor with a liquid (water, lava, kelp, seagrass, a bubble column) in the
//     body's cells or one above is never a landing cell (`Floor.wet`), nor a hazard (lava, cactus,
//     magma, fire, a lily pad, ...)
//   - only the live world model: a column the server has not sent is never landed on (the cache may
//     predate a structure), the search says `unknown` and the flight holds high until it arrives
//   - only a confirmed path: every landing cell has a bounded walking plan (reach.ts probePath, no
//     digging, no pillars) from its feet to the goal; candidates are probed nearest first (by the
//     straight distance plus three per block of height) within a probe and time budget, and a cell
//     next to one whose probe exhausted the space without a path is skipped (the same plateau)
//   - under an overhang: a floor whose ceiling is `headroom` (4) or more above the feet counts when an
//     open corridor leads in from the side (`corridorsOf`: at most `maxUnder` blocks under the roof,
//     the body's cells free, the open approach beyond it) and the approach planner's simulation from
//     the corridor's entry lands on it (`corridorLands`, the same physics and obstacle model the
//     flight flies with)
//   - a walk landing accepts a touchdown anywhere in the landing cell's flat dry neighbourhood (the
//     cells of the same floor connected to it, every one walks to it), so a touchdown a few blocks
//     off the centre is no reason to go around (`LandingTarget.cells`, plan.ts touchdownCost)
//   - nothing confirmed: the nearest safe dry ground (the flight lands there, says so, and the walk
//     still runs: it may find a way the bounded probe missed)
import type { Vec3 } from '../../connection/types.ts';
import { ApproachPlanner, APPROACH_DISTANCE, columnKey, hdist, yawDir, type FlightBody, type LandingTarget, type Obstacle } from './plan.ts';

/** A cell of the live world model as the search sees it. */
export interface CellBlock {
  readonly name: string;
  readonly solid: boolean;
}
/** The live world model: undefined = the cell is not loaded. */
export type BlockLookup = (x: number, y: number, z: number) => CellBlock | undefined;

const LIQUID = /^(flowing_)?(water|lava)$|^bubble_column$|kelp|seagrass/;
const HAZARD = /lava|cactus|magma|fire|portal|sweet_berry|powder_snow|wither_rose|pointed_dripstone|waterlily|lily_pad|scaffolding/;
/** A cell holding a liquid (or a plant that only grows in water). */
export const isLiquidName = (name: string): boolean => LIQUID.test(name);
/** A block nobody lands on or in. */
export const isHazardName = (name: string): boolean => HAZARD.test(name);

/** No solid within this many blocks above the feet: open sky (the Track AU2 rule). */
export const OPEN_SKY = 20;
/** The body's cells and one above must be free of liquid: feet .. feet + WET_ABOVE - 1. */
export const WET_ABOVE = 3;

/** A floor of a column: a solid block with two free cells over it. */
export interface Floor {
  /** Feet height of a body standing on it (the block's y + 1). */
  feet: number;
  /** The first solid above the feet (undefined: none up to the scan's top). */
  ceiling: number | undefined;
  /** A liquid in feet .. feet + WET_ABOVE - 1. */
  wet: boolean;
  /** The floor block or the cell above it is a hazard. */
  hazard: boolean;
}

/** The floors of column (x, z) from `yTop` down to `yBottom` (live cells only); undefined when the column is not loaded. */
export function floorsOf(look: BlockLookup, x: number, z: number, yTop: number, yBottom: number): Floor[] | undefined {
  const out: Floor[] = [];
  // cells above the first loaded one count as air (sub-chunks above the terrain may never be sent); a gap below it ends the scan
  let known = false;
  let ceiling: number | undefined;
  // the three cells above the current one (y + 1, y + 2, y + 3): [solid, liquid, name]
  let a1: CellBlock | undefined;
  let a2: CellBlock | undefined;
  let a3: CellBlock | undefined;
  for (let y = yTop; y >= yBottom; y--) {
    const b = look(x, y, z);
    if (b === undefined) {
      if (known) break;
      a3 = a2;
      a2 = a1;
      a1 = undefined;
      continue;
    }
    known = true;
    if (b.solid) {
      const free = (c: CellBlock | undefined) => !c || !c.solid;
      if (y + 2 <= yTop && free(a1) && free(a2)) {
        const wet = [a1, a2, a3].some((c) => c !== undefined && isLiquidName(c.name));
        out.push({ feet: y + 1, ceiling, wet, hazard: isHazardName(b.name) || (a1 !== undefined && isHazardName(a1.name)) });
      }
      ceiling = y;
    }
    a3 = a2;
    a2 = a1;
    a1 = b;
  }
  return known ? out : undefined;
}

export type CandidateKind = 'open' | 'roof';

export interface Candidate {
  x: number;
  z: number;
  feet: number;
  kind: CandidateKind;
  ceiling: number | undefined;
  /** The ranking estimate: the straight distance plus three per block of height. */
  est: number;
  /** A lower bound of any walk from it: the straight 3D distance. */
  lb: number;
}

export type ProbeOutcome = { status: 'found'; blocks: number } | { status: 'none' } | { status: 'limited' } | { status: 'nostart' };

export interface LandingDeps {
  look: BlockLookup;
  /** Solid cells for the approach simulation (the flight's obstacle model; unknown = free). */
  obstacle: Obstacle;
  /** A bounded walking plan from feet `from` to the goal (no digging, no pillars). Without it nothing is confirmed. */
  probe?: (from: Vec3) => Promise<ProbeOutcome>;
  /** Safe dry ground of a column under open sky (feet), the fallback beyond the candidates. */
  dryGround?: (x: number, z: number) => number | undefined;
  /** Let the event loop run (the search is sliced). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

export interface LandingOptions {
  /** Candidates within this many blocks of the goal (flyLandSearch). */
  radius: number;
  /** A ceiling at least this many blocks above the feet makes a floor an overhang candidate (flyHeadroom). */
  headroom: number;
  /** At most this many blocks of the corridor under the roof (flyOverhangDepth). */
  maxUnder: number;
  /** Probe plans per search (flyLandProbes). */
  probes: number;
  /** Time budget of the search in ms (probes and simulations). */
  budgetMs: number;
  /** Land on the goal itself when it is landable (`!fly <x y z>`): an exact landing of this half width. */
  exact?: number;
  /** Share of the candidate columns that must be live, else the search is `unknown` (partly loaded). */
  liveShare?: number;
}

export interface LandingCell {
  x: number;
  z: number;
  feet: number;
  kind: CandidateKind | 'goal' | 'ground';
}

export type LandingPlan =
  | { kind: 'unknown'; line: string }
  | { kind: 'goal'; cell: LandingCell; walk: 0; target: LandingTarget; line: string }
  | { kind: 'cell'; cell: LandingCell; walk: number; target: LandingTarget; line: string }
  | { kind: 'fallback'; cell: LandingCell; walk: number; target: LandingTarget; line: string; why: string }
  | { kind: 'none'; line: string };

/** The acceptance radius of a walk landing that walks `walk` blocks (more walk, more slack). */
export function walkSlack(walk: number): number {
  return Math.min(5, 1.5 + walk / 10);
}

const fmtCell = (c: { x: number; z: number; feet: number }): string => `${c.x} ${c.feet} ${c.z}`;

/**
 * The column view of one search: floors memoised per column over a fixed height window around the
 * goal (feet from goal - 32 to goal + 48; the open-sky test needs 20 above, so the scan starts 72 up).
 */
export class ColumnView {
  private readonly memo = new Map<number, Floor[] | null>();
  readonly yTop: number;
  readonly yBottom: number;
  lookups = 0;
  private readonly look: BlockLookup;

  constructor(look: BlockLookup, goalY: number) {
    this.look = look;
    this.yTop = Math.min(319, Math.floor(goalY) + 72);
    this.yBottom = Math.max(-64, Math.floor(goalY) - 36);
  }

  floors(x: number, z: number): Floor[] | undefined {
    const k = columnKey(x, z);
    const hit = this.memo.get(k);
    if (hit !== undefined) return hit ?? undefined;
    this.lookups++;
    const f = floorsOf(this.look, x, z, this.yTop, this.yBottom);
    this.memo.set(k, f ?? null);
    return f;
  }

  floorNear(x: number, z: number, feet: number, within = 1): Floor | undefined {
    let best: Floor | undefined;
    for (const f of this.floors(x, z) ?? []) if (Math.abs(f.feet - feet) <= within && (!best || Math.abs(f.feet - feet) < Math.abs(best.feet - feet))) best = f;
    return best;
  }

  /** The floor's class: open sky, an overhang with `headroom` or more, or nothing to land on. */
  kindOf(f: Floor, headroom: number): CandidateKind | undefined {
    if (f.ceiling === undefined) return f.feet + OPEN_SKY <= this.yTop ? 'open' : undefined;
    const room = f.ceiling - f.feet;
    if (room > OPEN_SKY) return 'open';
    return room >= headroom ? 'roof' : undefined;
  }

  /** Dry, no hazard, and level neighbours (each of the four has a floor within a block: neither a 1-wide column nor a hole nor an edge). */
  sound(x: number, z: number, f: Floor): boolean {
    if (f.wet || f.hazard) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = this.floorNear(x + dx, z + dz, f.feet);
      if (!n || n.wet || n.hazard) return false;
    }
    return true;
  }
}

/** An open corridor into an overhang: the bearing (Bedrock yaw, from the cell outwards) and the blocks under the roof. */
export interface Corridor {
  bearing: number;
  under: number;
}

/**
 * The open corridors into an overhang cell (x, z) at `feet`: bearings 15 degrees apart along which the
 * glide's cells (feet .. feet + 3 on the line, feet + 1 .. feet + 2 a block either side) are free and
 * loaded until a column with open sky over the feet (`OPEN_SKY`) within `maxUnder` blocks, and beyond
 * it the approach from above (cells around a line rising 0.2 per block) is free for 40 blocks (cells
 * beyond 24 out may be unloaded). Sorted: the shortest stretch under the roof first, bearings 45
 * degrees apart at least.
 */
export function corridorsOf(look: BlockLookup, x: number, z: number, feet: number, maxUnder: number): Corridor[] {
  const solidOr = (cx: number, y: number, cz: number, unknown: boolean): boolean => {
    const b = look(cx, y, cz);
    return b === undefined ? unknown : b.solid;
  };
  const found: Corridor[] = [];
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const d = yawDir(bearing);
    const side = { x: d.z, z: -d.x };
    const col = (s: number, lat = 0) => ({ x: Math.floor(x + 0.5 + d.x * s + side.x * lat), z: Math.floor(z + 0.5 + d.z * s + side.z * lat) });
    let openAt: number | undefined;
    let ok = true;
    for (let s = 1; s <= maxUnder + 1 && ok; s++) {
      const c = col(s);
      for (let y = feet; y <= feet + 3; y++) if (solidOr(c.x, y, c.z, true)) ok = false;
      for (const lat of [-1, 1]) {
        const l = col(s, lat);
        for (let y = feet + 1; y <= feet + 2; y++) if (solidOr(l.x, y, l.z, true)) ok = false;
      }
      if (!ok) break;
      let open = true;
      for (let y = feet + 4; y <= feet + OPEN_SKY; y++) {
        if (solidOr(c.x, y, c.z, true)) {
          open = false;
          break;
        }
      }
      if (open) openAt = s;
      if (open) break;
    }
    if (!ok || openAt === undefined) continue;
    for (let s = openAt + 1; s <= openAt + 40 && ok; s++) {
      const c = col(s);
      const path = feet + 1 + (s - openAt) * 0.2;
      for (let y = Math.floor(path) - 1; y <= Math.ceil(path) + 2; y++) if (solidOr(c.x, y, c.z, s - openAt <= 24)) ok = false;
    }
    if (ok) found.push({ bearing, under: openAt - 1 });
  }
  found.sort((a, b) => a.under - b.under || a.bearing - b.bearing);
  const out: Corridor[] = [];
  for (const c of found) if (out.every((o) => Math.abs(((c.bearing - o.bearing + 540) % 360) - 180) >= 45)) out.push(c);
  return out;
}

/**
 * The approach simulation into an overhang along `bearing`: from the corridor's entry (56 out, 12
 * above the floor, 1.05 blocks a tick heading in; and from 40 out, 7 above) the approach planner
 * (the flight's own, with the world's solids as walls) must find a profile that lands on the target.
 */
export function corridorLands(target: LandingTarget, bearing: number, obstacle: Obstacle, seed = 7): { ok: boolean; cost: number; kind: string } {
  const d = yawDir(bearing);
  let best = { ok: false, cost: Infinity, kind: 'none' };
  for (const [out, up] of [
    [APPROACH_DISTANCE, 12],
    [40, 7],
  ] as const) {
    const body: FlightBody = { pos: { x: target.x + d.x * out, y: target.top + up, z: target.z + d.z * out }, vel: { x: -d.x * 1.05, y: -0.1, z: -d.z * 1.05 }, onGround: false, gliding: true, boostTicks: 0 };
    const planner = new ApproachPlanner(seed, obstacle);
    const c = planner.step(body, bearing + 180, target);
    if (c.cost < best.cost) best = { ok: c.touchdown.kind === 'landed' && c.cost < CORRIDOR_COST, cost: c.cost, kind: c.touchdown.kind };
    if (best.ok) break;
  }
  return best;
}
/** An overhang approach is flown only when its simulated plan costs under this (a soft landing; the go-around threshold is 35). */
export const CORRIDOR_COST = 30;

/** The ranking's extra walk for an overhang landing: 4, and 2 per block of the corridor under the roof (the open ground beside a big roof wins). */
export function roofPenalty(corridor: Corridor | undefined): number {
  return corridor ? 4 + 2 * corridor.under : 0;
}

/** At most this many overhang cells get their corridors looked for in one search (each is about 24 x 13 short column scans). */
export const MAX_ROOF_CELLS = 240;

/**
 * The cells a walk landing on `c` accepts: the floors at the same height connected to it (4-way)
 * within `radius`, every one sound and of the same class (open sky, or an overhang with the headroom).
 */
export function cellsAround(view: ColumnView, c: { x: number; z: number; feet: number }, kind: CandidateKind, radius: number, headroom: number): Set<number> {
  const out = new Set<number>([columnKey(c.x, c.z)]);
  const queue: [number, number][] = [[c.x, c.z]];
  while (queue.length) {
    const [x, z] = queue.shift()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = columnKey(nx, nz);
      if (out.has(k) || Math.hypot(nx - c.x, nz - c.z) > radius) continue;
      const f = view.floorNear(nx, nz, c.feet, 0);
      if (!f || view.kindOf(f, headroom) !== kind || !view.sound(nx, nz, f)) continue;
      out.add(k);
      queue.push([nx, nz]);
    }
  }
  return out;
}

/**
 * The plateau of `c`: the floors at exactly its height connected to it (4-way, any class, dry), up to
 * `max` cells within `radius`. A probe that exhausted the space from `c` without a path proves the
 * same for every one of them (they walk to each other on the flat).
 */
export function plateauOf(view: ColumnView, c: { x: number; z: number; feet: number }, radius = 64, max = 6000): Set<number> {
  const out = new Set<number>([columnKey(c.x, c.z)]);
  const queue: [number, number][] = [[c.x, c.z]];
  while (queue.length && out.size < max) {
    const [x, z] = queue.shift()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      const k = columnKey(nx, nz);
      if (out.has(k) || Math.abs(nx - c.x) > radius || Math.abs(nz - c.z) > radius) continue;
      const f = view.floorNear(nx, nz, c.feet, 0);
      if (!f || f.wet) continue;
      out.add(k);
      queue.push([nx, nz]);
    }
  }
  return out;
}

/** A walk-landing target on `c` with its accepted cells. */
export function walkTarget(c: LandingCell, cells: ReadonlySet<number>, extra: Partial<LandingTarget> = {}): LandingTarget {
  let half = 0.5;
  for (const k of cells) {
    const x = Math.floor(k / 65536);
    const z = k % 65536;
    const dx = ((x - (c.x & 0xffff) + 98304) % 65536) - 32768;
    const dz = ((z - (c.z & 0xffff) + 98304) % 65536) - 32768;
    half = Math.max(half, Math.hypot(dx, dz) + 0.5);
  }
  return { x: c.x + 0.5, z: c.z + 0.5, top: c.feet, half, cells, walk: true, ...extra };
}

/** The candidate cells within `radius` of the goal (every cell out to 8, every other beyond), and how much of the window is live. */
export function candidatesNear(view: ColumnView, goal: Vec3, o: Pick<LandingOptions, 'radius' | 'headroom'>): { list: Candidate[]; columns: number; live: number } {
  const gx = Math.floor(goal.x);
  const gz = Math.floor(goal.z);
  const list: Candidate[] = [];
  let columns = 0;
  let live = 0;
  for (let r = 1; r <= o.radius; r++) {
    const step = r > 8 ? 2 : 1;
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        columns++;
        const x = gx + dx;
        const z = gz + dz;
        const floors = view.floors(x, z);
        if (!floors) continue;
        live++;
        for (const f of floors) {
          if (f.feet > goal.y + 48 || f.feet < goal.y - 32) continue;
          const kind = view.kindOf(f, o.headroom);
          if (!kind || !view.sound(x, z, f)) continue;
          const dy = f.feet - goal.y;
          list.push({ x, z, feet: f.feet, kind, ceiling: f.ceiling, est: Math.hypot(dx, dz) + 3 * Math.abs(dy), lb: Math.hypot(dx, dz, dy) });
        }
      }
    }
  }
  list.sort((a, b) => a.est - b.est);
  return { list, columns, live };
}

/**
 * The landing for a walk to `goal` (see the file comment). `label` names the goal in the log line.
 */
export async function findLanding(goal: Vec3, label: string, deps: LandingDeps, o: LandingOptions): Promise<LandingPlan> {
  const now = deps.now ?? (() => performance.now());
  const t0 = now();
  const yieldNow = deps.yieldNow ?? (() => Promise.resolve());
  const gx = Math.floor(goal.x);
  const gz = Math.floor(goal.z);
  const gy = Math.floor(goal.y);
  if (deps.look(gx, gy, gz) === undefined) return { kind: 'unknown', line: `landing for ${label}: the goal's ground is not loaded yet` };
  const view = new ColumnView(deps.look, gy);
  // the goal itself: landable under open sky, dry, level
  const own = view.floorNear(gx, gz, gy);
  if (own && view.kindOf(own, o.headroom) === 'open' && view.sound(gx, gz, own)) {
    const cell: LandingCell = { x: gx, z: gz, feet: own.feet, kind: 'goal' };
    const target: LandingTarget =
      o.exact !== undefined ? { x: gx + 0.5, z: gz + 0.5, top: own.feet, half: o.exact } : walkTarget(cell, cellsAround(view, cell, 'open', walkSlack(0) + 1, o.headroom));
    return { kind: 'goal', cell, walk: 0, target, line: `landing for ${label}: the goal itself (${fmtCell(cell)}, ${o.exact !== undefined ? 'exact' : `${target.cells?.size ?? 1} cells`})` };
  }
  const { list, columns, live } = candidatesNear(view, goal, o);
  await yieldNow();
  if (live < columns * (o.liveShare ?? 0.85)) return { kind: 'unknown', line: `landing for ${label}: only ${live} of ${columns} columns loaded around the goal` };
  type Probed = { c: Candidate; result: string; blocks?: number; corridor?: Corridor; status: ProbeOutcome['status'] | 'skip' };
  const probed: Probed[] = [];
  // probes that exhausted the space without a path: their whole plateau is skipped (feet -> columns)
  const dead = new Map<number, Set<number>>();
  const isDead = (c: Candidate): boolean => [...dead.entries()].some(([feet, cols]) => feet === c.feet && cols.has(columnKey(c.x, c.z)));
  let best: { c: Candidate; blocks: number; corridor?: Corridor } | undefined;
  let probes = 0;
  let sims = 0;
  let roofsLooked = 0;
  // a queue by the ranking estimate: an overhang cell is re-queued once its corridors are known, with the
  // extra walk its corridor costs (roofPenalty), so the open ground beside a deep roof comes first
  type Entry = { c: Candidate; key: number; lb: number; corridors?: Corridor[] };
  const queue: Entry[] = list.map((c) => ({ c, key: c.est, lb: c.lb }));
  const push = (e: Entry): void => {
    let i = queue.findIndex((q) => q.key > e.key);
    if (i < 0) i = queue.length;
    queue.splice(i, 0, e);
  };
  while (queue.length) {
    const e = queue.shift()!;
    const c = e.c;
    // (a confirmed walk within a tenth, at least 2 blocks, of what any later candidate could do is good enough)
    if (best && e.lb >= best.blocks - Math.max(2, best.blocks * 0.1)) break;
    if (probes >= o.probes || now() - t0 > o.budgetMs) break;
    if (isDead(c)) continue;
    let corridor: Corridor | undefined;
    if (c.kind === 'roof' && !e.corridors) {
      if (++roofsLooked > MAX_ROOF_CELLS) continue;
      const corridors = corridorsOf(deps.look, c.x, c.z, c.feet, o.maxUnder);
      if (roofsLooked % 16 === 0) await yieldNow();
      if (!corridors.length) continue;
      const extra = roofPenalty(corridors[0]);
      push({ c, key: e.key + extra, lb: e.lb + extra, corridors });
      continue;
    }
    if (c.kind === 'roof') {
      const corridors = e.corridors!;
      const cells = cellsAround(view, c, 'roof', 1.5, o.headroom);
      for (const k of corridors.slice(0, 2)) {
        sims++;
        const target = walkTarget({ ...c, kind: 'roof' }, cells, { bearing: k.bearing });
        if (corridorLands(target, k.bearing, deps.obstacle).ok) {
          corridor = k;
          break;
        }
      }
      if (!corridor) {
        probed.push({ c, result: 'no-sim', status: 'skip' });
        continue;
      }
    }
    if (!deps.probe) break;
    probes++;
    const r = await deps.probe({ x: c.x + 0.5, y: c.feet, z: c.z + 0.5 });
    await yieldNow();
    if (r.status === 'found') {
      // an overhang landing counts as a little more walk than an open one (the approach is harder), more the deeper under the roof
      const cost = r.blocks + roofPenalty(corridor);
      probed.push({ c, result: `path ${Math.round(r.blocks)}`, blocks: r.blocks, ...(corridor ? { corridor } : {}), status: 'found' });
      if (!best || cost < best.blocks) best = { c, blocks: cost, ...(corridor ? { corridor } : {}) };
    } else {
      probed.push({ c, result: r.status, ...(corridor ? { corridor } : {}), status: r.status });
      if (r.status === 'none') {
        const cols = dead.get(c.feet) ?? new Set<number>();
        for (const k of plateauOf(view, c)) cols.add(k);
        dead.set(c.feet, cols);
      }
    }
  }
  const ms = Math.round(now() - t0);
  const roofs = list.filter((c) => c.kind === 'roof').length;
  const tried = probed
    .slice(0, 10)
    .map((p) => `${fmtCell(p.c)}${p.c.kind === 'roof' ? `/roof${p.corridor ? ` b${p.corridor.bearing}` : ''}` : ''}:${p.result}`)
    .join(', ');
  const head = `landing for ${label}: ${list.length} candidates (${roofs} under a roof), ${probes} probes, ${sims} approach sims, ${ms} ms${tried ? `: ${tried}` : ''}`;
  if (best) {
    const c = best.c;
    const walk = best.blocks - roofPenalty(best.corridor);
    const cell: LandingCell = { x: c.x, z: c.z, feet: c.feet, kind: c.kind };
    const cells = cellsAround(view, cell, c.kind, walkSlack(walk), o.headroom);
    const target = walkTarget(cell, cells, best.corridor ? { bearing: best.corridor.bearing, ...(c.ceiling !== undefined ? { ceiling: c.ceiling } : {}) } : {});
    return { kind: 'cell', cell, walk, target, line: `${head} -> ${fmtCell(cell)}${best.corridor ? ` under a roof (ceiling ${c.ceiling}), in from ${best.corridor.bearing}` : ''}, ${Math.round(walk)} blocks of walk, ${cells.size} cells` };
  }
  // nothing confirmed: the nearest safe dry ground; a probe that ran out of budget before one that proved there is no way
  const rank = (s: Probed['status'] | undefined): number => (s === 'limited' || s === 'nostart' ? 0 : s === undefined ? 1 : s === 'none' ? 3 : 2);
  const statusOf = new Map(probed.map((p) => [p.c, p.status]));
  const open = list.filter((c) => c.kind === 'open').sort((a, b) => rank(statusOf.get(a)) - rank(statusOf.get(b)) || a.est - b.est);
  let pick: LandingCell | undefined;
  let est = 0;
  const first = open[0];
  if (first && rank(statusOf.get(first)) < 3) {
    pick = { x: first.x, z: first.z, feet: first.feet, kind: 'open' };
    est = first.est;
  }
  if (!pick && deps.dryGround) {
    // dry open ground farther out or far below (the candidates keep to 32 under and 48 over the goal)
    for (let r = 2; r <= o.radius * 2 && !pick; r += 2) {
      for (let dx = -r; dx <= r && !pick; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const feet = deps.dryGround(gx + dx, gz + dz);
          if (feet === undefined) continue;
          pick = { x: gx + dx, z: gz + dz, feet, kind: 'ground' };
          est = Math.hypot(dx, dz) + 3 * Math.abs(feet - gy);
          break;
        }
      }
    }
  }
  if (!pick && first) {
    pick = { x: first.x, z: first.z, feet: first.feet, kind: 'open' };
    est = first.est;
  }
  if (!pick) return { kind: 'none', line: `${head} -> no dry ground known near it` };
  const cells = pick.kind === 'ground' ? new Set([columnKey(pick.x, pick.z)]) : cellsAround(view, pick, 'open', 2.5, o.headroom);
  const why = deps.probe ? (probed.length ? 'no walking path from any landing cell near it' : 'no landing cell near it') : 'no path check available';
  return { kind: 'fallback', cell: pick, walk: est, target: walkTarget(pick, cells), why, line: `${head} -> none confirmed: dry ground at ${fmtCell(pick)} (${why})` };
}

/** The walk from `p` to the goal is still what the plan said: the landing cell is dry, sound and live (re-checked in the descent). */
export function stillLandable(look: BlockLookup, c: { x: number; z: number; feet: number }, headroom: number): boolean {
  const view = new ColumnView(look, c.feet);
  const f = view.floorNear(c.x, c.z, c.feet, 0);
  return !!f && view.kindOf(f, headroom) !== undefined && view.sound(c.x, c.z, f);
}

/** Distance helper for callers (the goal and a landing cell centre). */
export const cellDistance = (a: { x: number; z: number }, c: LandingCell): number => hdist(a, { x: c.x + 0.5, z: c.z + 0.5 });
