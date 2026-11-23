// The build planner (wave 9, Track AL; docs/build.md "Order rules", "Scaffolding"). Turns a BuildSpec
// into ordered steps on a simulated copy of the world (sim.ts):
//
//   place kinds   bottom layer first; inside a layer from the cell farthest from the bot towards the
//                 bot, so the bot never walls itself in. Every cell gets a stand that is reachable,
//                 within reach and not a cell filled later. A cell with no clickable neighbour gets a
//                 chain of up to 3 support scaffold blocks (removed at the end of its layer); a cell
//                 out of reach from every reachable stand gets a scaffold column next to it: the bot
//                 pillars up on it, places from the top what it can reach from there, then digs the
//                 column away under its feet on the way down (`buildScaffold` off: such cells are
//                 skipped).
//   clear         a dig list, top layer first, in lanes back and forth inside a layer (topDown); never the block
//                 under the feet, nothing next to water or lava, nothing unbreakable.
//   replace       like clear over the cells holding `from`; each is dug and `to` placed at once.
//
// Cells already holding the wanted block count as done; cells holding another solid block are left
// (`occupied`) by fill-type builds. The planner is synchronous; `planBuildAsync` yields to the event
// loop between chunks so a big plan does not stall the bot's ticks.
import { centreDistance, BUILD_REACH, canDigFrom, canPlaceFrom, canPlaceWith, canStand, clickable, edgeDrop, inBody, isLiquid, NEIGHBOURS6, passable, reachableStands, replaceable, SimWorld, standTop, supportsOf, areaAround, type Area, type BlockReader } from './sim.ts';
import { doorHinge, hingeCells, hingeSolid, itemFor, resolveBlocks, sameBlock, statesMatch, unsupportedBlock, DIR_VEC, type Cardinal, type Placement } from './states.ts';
import { add, blockId, isAirName, key, MAX_BUILD_CELLS, type BuildBlock, type BuildSpec, type Cell } from './types.ts';

/** Track B3 (decision 0128): a scaffold column is kept for the next cells while it reaches them, grown by at most this much. */
export const COLUMN_GROW = 3;
/** Track B3: a new column may be this much taller than the least that reaches its cell, when its top reaches more. */
export const COLUMN_EXTRA = 4;
/**
 * Track B7 (decision 0132): a layer's cells out of reach are tried again at most this many rounds. Each round that
 * placed one more cell used to start another over all of them: hundreds of unreachable cells beside a placed map art
 * tile planned for more than 25 minutes.
 */
export const LATER_ROUNDS = 8;
/** Track B7: blocks that fall when nothing is under them (placed only on a block that stays). */
export const GRAVITY_RE = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg)$/;
/** Track B3: a column's block costs this many cells of cover (a pillar jump and a dig for nothing reached). */
export const COLUMN_BLOCK_COST = 0.75;
/**
 * Track B3: from a ground stand the cells of the layers above the current one (up to this many) that it reaches and
 * that stand on a block (placed or there) are placed too, before the bot moves on (a wall goes up several layers a
 * stand); never the cells beside or over its body.
 */
export const GROUND_UP = 4;
/**
 * Track B3: a stand's walk is worth this many blocks less for each cell of the layer it reaches (Planner.standFor
 * `cover`). With the next cell the one nearest the bot, 0.3 made many short hops (the e2e castle's plan: 760 stand
 * moves, 2 274 blocks walked), 1 long ones (408, 2 655); 0.6 is between (514, 2 458).
 */
export const COVER_WEIGHT = 0.6;
/** Track B3: stands scored by the cells they reach: the nearest this many. */
const COVER_STANDS = 16;
/** Track B3: a support chain's search looks at this many cells at most. */
const SUPPORT_NODES = 4000;

export type Step =
  /**
   * Place a target block; `top`: from the scaffold column top the bot stands on (no walking). Track B1: `pl` = how
   * (the click its states need, the states to verify, merges, taps, the cells it fills besides its own).
   */
  | { op: 'place'; pos: Cell; name: string; item: string; stand?: Cell; top?: Cell; pl?: Placement }
  /** Place a support scaffold (a throwaway block). */
  | { op: 'scaffold'; pos: Cell; stand?: Cell; top?: Cell }
  /**
   * Walk to `base` (feet) and pillar up `height` blocks (scaffold cells base.y .. base.y + height - 1). Track B3: a
   * second pillar step on the same base grows the column the bot stands on (it pillars on from its top).
   */
  | { op: 'pillar'; base: Cell; height: number }
  /** Standing on the column top: dig the column cells top-down under the feet, landing on each. */
  | { op: 'descend'; base: Cell; height: number }
  /** Dig a support scaffold; Track B7: `top` = from the scaffold column top the bot stands on. */
  | { op: 'unscaffold'; pos: Cell; stand?: Cell; top?: Cell }
  /** Dig a target (clear); Track B3: `top` = from the scaffold column top the bot stands on. */
  | { op: 'dig'; pos: Cell; name: string; stand?: Cell; top?: Cell }
  /** Dig `from`, place `to` (replace); Track B3: `top` as for dig. */
  | { op: 'replace'; pos: Cell; from: string; to: string; item: string; stand?: Cell; top?: Cell };

export interface Skip {
  pos: Cell;
  reason: string;
}

export interface Plan {
  spec: BuildSpec;
  steps: Step[];
  /** Target cells with work to do (place, dig or replace steps). */
  work: number;
  /** Cells that already hold the wanted block (place kinds) / are already air (clear). */
  already: number;
  /** Cells holding another block (place kinds: left as they are). */
  occupied: number;
  /** Cells the planner gave up on, with the reason (they are not in `steps`). */
  skipped: Skip[];
  /** Scaffold blocks placed in all (support blocks + column blocks) and the most at one time. */
  scaffolds: number;
  scaffoldPeak: number;
  /** Items the build places (scaffolds not included): item -> count. */
  materials: Record<string, number>;
  /** Planning time, ms. */
  ms: number;
  /** Track B1: blocks the builder refuses, each with the reason (a file build places the rest). */
  refused?: { pos: Cell; name: string; reason: string }[];
  /** Track B1: places whose states are verified, and of them how many need a turned view (no stand looks that way). */
  stateful?: number;
  turned?: number;
  /** Track B1: states the plan cannot arrange (a door's hinge its neighbours decide): verified at the end, reported. */
  unmade?: Skip[];
  /** Track B3: the plan's stands keep off drops deeper than this (PlanOptions.safeEdge): the runner's stands too. */
  safeEdge?: number;
  /** Track B3: cells left as they are (PlanOptions.skip: changed by someone since a resumed build did them). */
  left?: number;
}

/** A turned view costs this much more than walking a block further (Planner.standFor `penalty`). */
export const TURN_PENALTY = 2.5;

/** Track B1: a placement the old path handles (any face, no state to give, nothing to verify after). */
export function plainPlacement(pl: Placement | undefined): boolean {
  if (!pl) return true;
  const n = pl.need;
  return (
    n.faces.length === 6 &&
    !n.cardinal &&
    !n.axis &&
    n.yaw === undefined &&
    !n.eye &&
    !n.half &&
    !n.soil &&
    !n.realSupport &&
    pl.merges === 0 &&
    pl.taps === 0 &&
    pl.extra.length === 0 &&
    Object.keys(pl.check).length === 0 &&
    Object.keys(pl.final).length === 0 &&
    pl.placed === pl.name
  );
}

export interface PlanOptions {
  /** The bot's feet (the order runs from the far side towards it). */
  start: Cell;
  /** Add scaffold cells (the `buildScaffold` setting). Default true. */
  scaffold?: boolean;
  /** Eye-to-centre reach for stands. Default 4.5. */
  reach?: number;
  /** Highest scaffold column. Default 6 (the `buildColumnMax` setting). */
  maxColumn?: number;
  /** Longest support chain. Default 5 (Track B3; 3 before). */
  maxSupport?: number;
  /** Track B1: a block's collision boxes by name and states (world registry), so stands on slabs and stairs are planned right. */
  shapeOf?: ((name: string, states: Readonly<Record<string, unknown>> | undefined) => readonly (readonly number[])[] | undefined) | undefined;
  /** Track B3: the area whose stands count (a section of a large build: from the build's floor up); default around the cells. */
  area?: Area | undefined;
  /** Track B3: place what the stand reaches before walking on; a new stand chosen by the cells it reaches. Default true. */
  cluster?: boolean;
  /** Track B3: no stand beside a drop deeper than this (a fall that costs health); column tops excepted. Default none. */
  safeEdge?: number | undefined;
  /** Track B3: clear / replace: cells to leave as they are (a resumed build's cells someone changed since). */
  skip?: ((c: Cell) => boolean) | undefined;
}

export class PlanError extends Error {
  override name = 'PlanError';
}

const dist = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const hdist = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.z - b.z);

/** A clear's stand higher than one block over its target costs this much more per block (Planner.standFor `low`). */
export const CLEAR_HIGH_STAND = 3;
/** Cells across one lane of the clear order (`topDown`): about what a stand in the dug lane reaches to either side. */
export const CLEAR_LANE = 4;

/**
 * The cells a clear / replace box holds, top layer first. Inside a layer the cells go in lanes, back and
 * forth (a boustrophedon): the sweep runs along the layer's longer side, the lanes are CLEAR_LANE cells
 * across, the first lane starts at the corner nearest `ref` (the next layer at the corner nearest where
 * the last one ended), and each lane's cells go row by row across, so consecutive digs are neighbours and
 * a stand digs everything around it before the bot moves on. The old order (nearest to `ref` first, rings)
 * took each ring end to end: on a 32 x 32 layer 863 stand moves and about 10 000 blocks walked between
 * stands for 1024 digs.
 */
export function topDown(box: { min: Cell; max: Cell }, ref: Cell, lane = CLEAR_LANE): Cell[] {
  const out: Cell[] = [];
  const sx = box.max.x - box.min.x + 1;
  const sz = box.max.z - box.min.z + 1;
  // sweep along the longer side (fewer lane turns); `u` runs along the sweep, `v` across it
  const alongX = sx >= sz;
  const nu = alongX ? sx : sz;
  const nv = alongX ? sz : sx;
  const cell = (u: number, v: number, y: number): Cell => (alongX ? { x: box.min.x + u, y, z: box.min.z + v } : { x: box.min.x + v, y, z: box.min.z + u });
  let from = ref;
  for (let y = box.max.y; y >= box.min.y; y--) {
    // the corner nearest `from`: which end of the sweep and which side of the lanes the layer starts at
    const corners = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const;
    let best: (typeof corners)[number] = corners[0];
    let bestD = Infinity;
    for (const c of corners) {
      const p = cell(c[0] ? nu - 1 : 0, c[1] ? nv - 1 : 0, y);
      const d = hdist(p, from);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    const [uRev, vRev] = best;
    let forward = !uRev;
    for (let v0 = 0; v0 < nv; v0 += lane) {
      const vs: number[] = [];
      for (let v = v0; v < Math.min(nv, v0 + lane); v++) vs.push(vRev ? nv - 1 - v : v);
      for (let i = 0; i < nu; i++) {
        const u = forward ? i : nu - 1 - i;
        // across the lane from the end nearer the last cell (the first row from the start corner): rows go
        // back and forth, so the row's last cell is next to the next row's first; a lane change steps at most
        // a lane's width across
        const last = out.length > 0 && out[out.length - 1]!.y === y ? out[out.length - 1]! : cell(uRev ? nu - 1 : 0, vRev ? nv - 1 : 0, y);
        const a = cell(u, vs[0]!, y);
        const z = cell(u, vs[vs.length - 1]!, y);
        const row = hdist(a, last) <= hdist(z, last) ? vs : [...vs].reverse();
        for (const v of row) out.push(cell(u, v, y));
      }
      forward = !forward;
    }
    from = out[out.length - 1] ?? from;
  }
  return out;
}

/** Placement order: bottom layer first, farthest from `ref` first inside a layer. */
export function bottomUp(blocks: readonly BuildBlock[], ref: Cell): BuildBlock[] {
  return [...blocks].sort((a, b) => a.pos.y - b.pos.y || hdist(b.pos, ref) - hdist(a.pos, ref) || a.pos.x - b.pos.x || a.pos.z - b.pos.z);
}

/** A block to place with its placement (Track B1). */
interface Item {
  b: BuildBlock;
  pl: Placement;
}

function bottomUpItems(items: readonly Item[], ref: Cell): Item[] {
  const at = new Map(items.map((it) => [it.b, it] as const));
  return bottomUp(
    items.map((it) => it.b),
    ref,
  ).map((b) => at.get(b)!);
}

/** A scaffold column the bot stands on (base = the first scaffold cell, top = the feet on it). */
export interface Column {
  base: Cell;
  height: number;
  top: Cell;
}

class Planner {
  readonly sim: SimWorld;
  readonly o: Required<Omit<PlanOptions, 'shapeOf' | 'area' | 'safeEdge' | 'skip'>> & Pick<PlanOptions, 'shapeOf' | 'safeEdge' | 'skip'>;
  readonly steps: Step[] = [];
  readonly skipped: Skip[] = [];
  /** Where the simulated bot stands. */
  cur: Cell;
  private area: Area;
  private cache: { version: number; set: Set<string> } | undefined;
  scaffolds = 0;
  private live = 0;
  peak = 0;

  constructor(world: BlockReader, area: Area, o: PlanOptions) {
    this.sim = new SimWorld(world);
    const { area: _a, ...rest } = o;
    this.o = { scaffold: true, reach: BUILD_REACH, maxColumn: 6, maxSupport: 5, cluster: true, ...rest };
    this.cur = o.start;
    this.area = o.area ?? area;
  }

  /** Track B3: a stand off every drop deeper than safeEdge (no fall that costs health one step off it). */
  safe(f: Cell): boolean {
    const lim = this.o.safeEdge;
    return lim === undefined || edgeDrop(this.sim, f, lim + 1) <= lim;
  }

  private reachable(fresh: boolean): Set<string> {
    if (!this.cache || (fresh && this.cache.version !== this.sim.version)) {
      this.cache = { version: this.sim.version, set: reachableStands(this.sim, this.area, this.cur, { isBlocked: (p) => this.sim.isBlocked(p) }) };
    }
    return this.cache.set;
  }

  /**
   * A reachable stand from which `ok(f)` holds: the current one if it does, else the nearest to it.
   * `low` (a clear's digs): a stand higher than one over the target costs CLEAR_HIGH_STAND per block
   * more, so the bot follows the dig down into the pit instead of walking the rim (the planner's walks
   * only step one block up or down: from the rim a pit two deep is out of reach).
   */
  standFor(t: Cell, ok: (f: Cell) => boolean, low = false, penalty?: (f: Cell) => number, cover?: (f: Cell) => number): Cell | undefined {
    const rules = { isBlocked: (p: Cell) => this.sim.isBlocked(p) };
    const high = (f: Cell): number => (low ? Math.max(0, f.y - t.y - 1) : 0);
    // Track B1: a stand's extra cost (a turned view); the current stand counts it too
    const extra = (f: Cell): number => CLEAR_HIGH_STAND * high(f) + (penalty?.(f) ?? 0);
    let found: Cell | undefined;
    for (const fresh of [false, true]) {
      const set = this.reachable(fresh);
      const curOk = set.has(key(this.cur)) && canStand(this.sim, this.cur, rules) && this.safe(this.cur) && ok(this.cur);
      if (curOk && extra(this.cur) === 0) return this.cur;
      let best: Cell | undefined = curOk ? this.cur : undefined;
      let bestD = curOk ? extra(this.cur) : Infinity;
      const scored: { f: Cell; d: number }[] = [];
      const r = Math.ceil(this.o.reach);
      for (let dy = -r - 1; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const f = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
            if (!set.has(key(f)) || !canStand(this.sim, f, rules) || !this.safe(f) || !ok(f)) continue;
            const d = dist(f, this.cur) + 0.001 * centreDistance(f, t) + extra(f);
            if (cover) scored.push({ f, d });
            else if (d < bestD) {
              bestD = d;
              best = f;
            }
          }
        }
      }
      if (cover && scored.length) {
        // Track B3: of the nearest stands, the one whose walk the cells it reaches pay for best
        scored.sort((a, b) => a.d - b.d);
        for (const s of scored.slice(0, COVER_STANDS)) {
          const d = s.d - COVER_WEIGHT * cover(s.f);
          if (d < bestD) {
            bestD = d;
            best = s.f;
          }
        }
      }
      // a clear's best stand over the dig level in the cached set: look again in the fresh one (a pit floor dug since)
      if (best && extra(best) === 0) return best;
      found ??= best;
      if (best && fresh) return best;
    }
    return found;
  }

  placeStand(t: Cell, cover?: (f: Cell) => number): Cell | undefined {
    return this.standFor(t, (f) => canPlaceFrom(this.sim, f, t, this.o.reach), false, undefined, cover);
  }

  digStand(t: Cell, low = false): Cell | undefined {
    return this.standFor(t, (f) => canDigFrom(f, t, this.o.reach), low);
  }

  addScaffold(p: Cell): void {
    this.sim.setSolid(p);
    this.scaffolds++;
    this.live++;
    this.peak = Math.max(this.peak, this.live);
  }

  removeScaffold(p: Cell): void {
    this.sim.setAir(p);
    this.live--;
  }

  /**
   * The shortest chain of support scaffolds that gives `t` a clickable neighbour: cells that are
   * free, not filled later and not in the way, from one with a clickable neighbour to one next to `t`.
   * Each must itself have a reachable stand. Returns the cells in placement order, or undefined.
   */
  supportChain(t: Cell, ends?: readonly Cell[]): { cells: Cell[]; stands: Cell[] } | undefined {
    // Track B1: `ends` = the only cells next to t the chain may end in (the supports a placement's states allow)
    const start = (ends ?? NEIGHBOURS6.map((d) => add(t, d.x, d.y, d.z))).filter((c) => this.freeForScaffold(c));
    const prev = new Map<string, Cell | null>();
    let frontier: Cell[] = [];
    for (const c of start) {
      prev.set(key(c), null);
      frontier.push(c);
    }
    for (let depth = 1; depth <= this.o.maxSupport && frontier.length && prev.size <= SUPPORT_NODES; depth++) {
      // anchored cells of this depth, nearest to the bot first
      const anchored = frontier.filter((c) => supportsOf(this.sim, c).length > 0).sort((a, b) => dist(a, this.cur) - dist(b, this.cur));
      for (const a of anchored) {
        const chain: Cell[] = [];
        for (let c: Cell | null | undefined = a; c; c = prev.get(key(c))) chain.push(c);
        // placement order: the anchored end first, the cell next to t last
        const stands: Cell[] = [];
        const placed: Cell[] = [];
        let ok = true;
        for (const c of chain) {
          const s = this.placeStand(c);
          if (!s) {
            ok = false;
            break;
          }
          stands.push(s);
          this.sim.setSolid(c);
          placed.push(c);
        }
        for (const c of placed) this.sim.setAir(c);
        if (ok) return { cells: chain, stands };
      }
      const next: Cell[] = [];
      for (const c of frontier) {
        for (const d of NEIGHBOURS6) {
          const n = add(c, d.x, d.y, d.z);
          if (prev.has(key(n)) || (n.x === t.x && n.y === t.y && n.z === t.z) || !this.freeForScaffold(n)) continue;
          prev.set(key(n), c);
          next.push(n);
        }
      }
      frontier = next;
    }
    return undefined;
  }

  freeForScaffold(c: Cell): boolean {
    return !this.sim.isBlocked(c) && replaceable(this.sim.blockAt(c)) && !isLiquid(this.sim.blockAt(c));
  }

  /**
   * A scaffold column next to `t`: a reachable stand `base`, `height` free cells above it to pillar
   * into (plus the head room for the last jump), from whose top `t` can be placed.
   */
  column(t: Cell, can: (top: Cell) => boolean = (top) => canPlaceFrom(this.sim, top, t, this.o.reach), cover?: (top: Cell) => number): Column | undefined {
    const rules = { isBlocked: (p: Cell) => this.sim.isBlocked(p) };
    const set = this.reachable(true);
    const offsets: [number, number][] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx !== 0 || dz !== 0) offsets.push([dx, dz]);
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    // Track B3 (decision 0128): the bases first (a reachable stand in each offset's column, from 1 over the target down
    // to the tallest column's reach), then only the heights whose top can reach the target: a 32-high column is
    // searched in about the time a 6-high one took. The lowest height wins, then the top closest to the target; with
    // `cover` (the planner's cluster option) the heights up to COLUMN_EXTRA over the least are tried too and the top
    // that reaches the most cells still to place wins, less COLUMN_BLOCK_COST a block of height.
    const maxH = this.o.maxColumn;
    let best: (Column & { d: number; score: number }) | undefined;
    for (const [dx, dz] of offsets) {
      // the top from 6 under the target to 1 over it (as before)
      for (let by = t.y; by >= t.y - maxH - 6; by--) {
        const base = { x: t.x + dx, y: by, z: t.z + dz };
        if (!set.has(key(base)) || !canStand(this.sim, base, rules) || !this.safe(base)) continue;
        const lo = Math.max(1, t.y - 6 - by);
        const hi = Math.min(maxH, t.y + 1 - by);
        if (lo > hi || (!cover && best && lo > best.height)) continue;
        // the free run above the base (the column's cells, the feet and the head on the top, and the jump's room)
        let run = 0;
        while (run < hi + 3) {
          const c = add(base, 0, run, 0);
          if (this.sim.isBlocked(c) || !passable(this.sim.blockAt(c))) break;
          run++;
        }
        let first: number | undefined;
        for (let h = lo; h <= Math.min(hi, run - 3); h++) {
          if (!cover && best && h > best.height) break;
          if (first !== undefined && h > first + COLUMN_EXTRA) break;
          const top = add(base, 0, h, 0);
          for (let k = 0; k < h; k++) this.sim.setSolid(add(base, 0, k, 0));
          const ok = can(top);
          for (let k = 0; k < h; k++) this.sim.setAir(add(base, 0, k, 0));
          if (!ok) continue;
          first ??= h;
          // closest top to the target first (margin on a real server), then the shortest walk
          const d = centreDistance(top, t) + 0.25 * dist(base, this.cur);
          if (cover) {
            // Track B3: the top that reaches the most cells still to place, less what its height costs
            const score = cover(top) - COLUMN_BLOCK_COST * h;
            if (!best || score > best.score || (score === best.score && (h < best.height || (h === best.height && d < best.d)))) best = { base, height: h, top, d, score };
            continue;
          }
          if (!best || h < best.height || (h === best.height && d < best.d)) best = { base, height: h, top, d, score: 0 };
          break;
        }
      }
    }
    return best && { base: best.base, height: best.height, top: best.top };
  }

  /**
   * Track B3: the column `c` grown (at most COLUMN_GROW blocks, never over maxColumn) so that `can` holds from its new
   * top, or undefined. The cells it grows into are free and no cell the build fills later.
   */
  grow(c: Column, can: (top: Cell) => boolean): Column | undefined {
    for (let h = c.height + 1; h <= Math.min(this.o.maxColumn, c.height + COLUMN_GROW); h++) {
      let free = true;
      for (let k = c.height; k < h + 3 && free; k++) {
        const cell = add(c.base, 0, k, 0);
        free = !this.sim.isBlocked(cell) && passable(this.sim.blockAt(cell));
      }
      if (!free) return undefined;
      const top = add(c.base, 0, h, 0);
      for (let k = c.height; k < h; k++) this.sim.setSolid(add(c.base, 0, k, 0));
      const ok = can(top);
      for (let k = c.height; k < h; k++) this.sim.setAir(add(c.base, 0, k, 0));
      if (ok) return { base: c.base, height: h, top };
    }
    return undefined;
  }

  setArea(a: Area): void {
    this.area = a;
    this.cache = undefined;
  }
}

/** Plan a build. Throws PlanError for a bad spec (too big, unsupported block). */
export function planBuild(world: BlockReader, spec: BuildSpec, o: PlanOptions): Plan {
  const gen = planSteps(world, spec, o);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/** planBuild, yielding to the event loop every `chunk` cells. */
export async function planBuildAsync(world: BlockReader, spec: BuildSpec, o: PlanOptions, chunk = 64): Promise<Plan> {
  const gen = planSteps(world, spec, o, chunk);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await new Promise<void>((res) => setImmediate(res));
  }
}

function* planSteps(world: BlockReader, spec: BuildSpec, o: PlanOptions, chunk = 64): Generator<void, Plan, void> {
  const t0 = performance.now();
  const start = { x: Math.floor(o.start.x), y: Math.floor(o.start.y), z: Math.floor(o.start.z) };
  const plan: Plan = { spec, steps: [], work: 0, already: 0, occupied: 0, skipped: [], scaffolds: 0, scaffoldPeak: 0, materials: {}, ms: 0 };
  const count = (item: string) => {
    plan.materials[item] = (plan.materials[item] ?? 0) + 1;
  };

  if (spec.kind === 'clear' || spec.kind === 'replace') {
    const box = spec.box;
    if (!box) throw new PlanError(`${spec.kind} needs a box`);
    const cells = topDown(box, start);
    if (cells.length > MAX_BUILD_CELLS) throw new PlanError(`${cells.length} cells is too big (at most ${MAX_BUILD_CELLS})`);
    const rep = spec.replace;
    if (rep) {
      const why = unsupportedBlock(rep.to);
      if (why) throw new PlanError(`${rep.to}: ${why}`);
    }
    const p = new Planner(world, areaAround([box.min, box.max], 6, 4, start), { ...o, start });
    if (o.safeEdge !== undefined) plan.safeEdge = o.safeEdge;
    // Track B3: a target out of reach from every stand gets a scaffold column (buildScaffold on): the bot digs from
    // its top while it reaches, then comes down it (the column stands in cells that are air)
    let column: Column | undefined;
    const descend = () => {
      if (!column) return;
      p.steps.push({ op: 'descend', base: column.base, height: column.height });
      for (let k = column.height - 1; k >= 0; k--) p.removeScaffold(add(column.base, 0, k, 0));
      p.cur = column.base;
      column = undefined;
    };
    const fromColumn = (can: (top: Cell) => boolean): Cell | undefined => {
      if (!column) return undefined;
      if (can(column.top)) return column.top;
      descend();
      return undefined;
    };
    const newColumn = (t: Cell, can: (top: Cell) => boolean): Cell | undefined => {
      if (!p.o.scaffold) return undefined;
      const col = p.column(t, can);
      if (!col) return undefined;
      p.steps.push({ op: 'pillar', base: col.base, height: col.height });
      for (let k = 0; k < col.height; k++) p.addScaffold(add(col.base, 0, k, 0));
      column = col;
      p.cur = col.top;
      return col.top;
    };
    let n = 0;
    for (const t of cells) {
      if (++n % chunk === 0) yield;
      const b = p.sim.blockAt(t);
      if (!b) {
        plan.skipped.push({ pos: t, reason: 'unloaded' });
        continue;
      }
      if (p.sim.isScaffold(t)) {
        // a column of this plan stands in it (an air cell): nothing to dig
        if (!rep) plan.already++;
        continue;
      }
      const name = blockId(b.name);
      if (rep ? name !== rep.from : isAirName(name)) {
        if (!rep) plan.already++;
        continue;
      }
      if (rep?.to === name) continue;
      if (o.skip?.(t)) {
        plan.left = (plan.left ?? 0) + 1;
        continue;
      }
      if (isLiquid(b)) {
        if (!rep) plan.skipped.push({ pos: t, reason: 'liquid' });
        continue;
      }
      if ((b.hardness ?? 0) < 0) {
        plan.skipped.push({ pos: t, reason: 'unbreakable' });
        continue;
      }
      if (NEIGHBOURS6.some((d) => isLiquid(p.sim.blockAt(add(t, d.x, d.y, d.z))))) {
        plan.skipped.push({ pos: t, reason: 'next to water or lava' });
        continue;
      }
      if (rep) {
        const canRep = (f: Cell): boolean => {
          if (!canDigFrom(f, t, p.o.reach)) return false;
          p.sim.setAir(t);
          const ok = canPlaceFrom(p.sim, f, t, p.o.reach);
          p.sim.setSolid(t, name);
          return ok;
        };
        const top = fromColumn(canRep);
        const stand = top ? undefined : p.standFor(t, canRep);
        const top2 = top ?? (stand ? undefined : newColumn(t, canRep));
        if (!stand && !top2) {
          plan.skipped.push({ pos: t, reason: 'out of reach' });
          continue;
        }
        p.steps.push({ op: 'replace', pos: t, from: rep.from, to: rep.to, item: itemFor(rep.to), ...(top2 ? { top: top2 } : { stand: stand! }) });
        p.sim.setSolid(t, rep.to);
        p.cur = top2 ?? stand!;
        count(itemFor(rep.to));
      } else {
        const canDig = (f: Cell): boolean => canDigFrom(f, t, p.o.reach);
        const top = fromColumn(canDig);
        const stand = top ? undefined : p.digStand(t, true);
        const top2 = top ?? (stand ? undefined : newColumn(t, canDig));
        if (!stand && !top2) {
          plan.skipped.push({ pos: t, reason: 'out of reach' });
          continue;
        }
        p.steps.push({ op: 'dig', pos: t, name, ...(top2 ? { top: top2 } : { stand: stand! }) });
        p.sim.setAir(t);
        p.cur = top2 ?? stand!;
      }
      plan.work++;
    }
    descend();
    plan.steps = p.steps;
    plan.scaffolds = p.scaffolds;
    plan.scaffoldPeak = p.peak;
    plan.ms = performance.now() - t0;
    return plan;
  }

  // ---- place kinds
  if (spec.places.length > MAX_BUILD_CELLS) throw new PlanError(`${spec.places.length} blocks is too big (at most ${MAX_BUILD_CELLS})`);
  // Track B1 (decision 0124): every block's placement (the click its states need, what is verified) or refusal; a
  // file build lists its refusals and builds the rest, a typed one stops at the first
  const seen = new Set<string>();
  const unique: BuildBlock[] = [];
  for (const b of spec.places) {
    if (seen.has(key(b.pos))) continue;
    seen.add(key(b.pos));
    unique.push(b);
  }
  const byKey = new Map(unique.map((b) => [key(b.pos), b] as const));
  const resolved = resolveBlocks(unique);
  if (resolved.refused.length) {
    if (spec.kind !== 'file') {
      const r = resolved.refused[0]!;
      throw new PlanError(`${blockId(r.block.name)}: ${r.reason}`);
    }
    plan.refused = resolved.refused.map((r) => ({ pos: r.block.pos, name: blockId(r.block.name), reason: r.reason }));
  }
  const p = new Planner(
    world,
    areaAround(
      unique.map((b) => b.pos),
      6,
      4,
      start,
    ),
    { ...o, start },
  );
  if (o.safeEdge !== undefined) plan.safeEdge = o.safeEdge;
  const cellsOf = (t: Cell, pl: Placement): Cell[] => pl.extra.map((e) => add(t, e.offset.x, e.offset.y, e.offset.z));
  const todo: Item[] = [];
  for (const { block: b, placement: pl } of resolved.cells) {
    const w = world.blockAt(b.pos);
    if (!w) {
      plan.skipped.push({ pos: b.pos, reason: 'unloaded' });
      continue;
    }
    if (sameBlock(pl.name, w.name) && statesMatch(pl.final, w.states)) {
      plan.already++;
      continue;
    }
    if (!replaceable(w)) {
      plan.occupied++;
      continue;
    }
    if (!cellsOf(b.pos, pl).every((c) => replaceable(world.blockAt(c)))) {
      plan.skipped.push({ pos: b.pos, reason: `${pl.family}: its second cell is taken` });
      continue;
    }
    todo.push({ b, pl });
    p.sim.block(b.pos);
    for (const c of cellsOf(b.pos, pl)) p.sim.block(c);
  }
  // Track B1: the supports a placement's states allow; ready = one of them is there (a bed: and a floor under its head)
  const allowedSupports = (it: Item): Cell[] => it.pl.need.faces.map((f) => add(it.b.pos, -DIR_VEC[f].x, -DIR_VEC[f].y, -DIR_VEC[f].z));
  const headFloor = (it: Item): Cell | undefined => (it.pl.family === 'bed' && it.pl.extra[0] ? add(cellsOf(it.b.pos, it.pl)[0]!, 0, -1, 0) : undefined);
  const hasSupport = (it: Item): boolean =>
    plainPlacement(it.pl) ? supportsOf(p.sim, it.b.pos).length > 0 : allowedSupports(it).some((s) => clickable(p.sim.blockAt(s)) && !(it.pl.need.realSupport && p.sim.isScaffold(s)));
  const ready = (it: Item): boolean => {
    if (!hasSupport(it)) return false;
    const hf = headFloor(it);
    return !hf || standTop(p.sim.blockAt(hf));
  };
  /** Not ready, but a support (or a bed's floor) is a cell the build fills later: wait for it. */
  const mayWait = (it: Item): boolean => {
    if (plainPlacement(it.pl)) return false;
    const hf = headFloor(it);
    return allowedSupports(it).some((s) => p.sim.isBlocked(s)) || (!!hf && p.sim.isBlocked(hf));
  };
  /**
   * Inside a layer: the farthest ready cell. Track B3: with `cluster`, once the layer has begun, the ready cell nearest
   * the bot (the farthest on a tie): the layer's order by distance from the start puts cells of opposite sides of a
   * ring (a curtain wall round the start) next to each other, and the cells a stand left were walked to across it.
   */
  const pickIndex = (layer: Item[]): number => {
    if (!p.o.cluster || clusterFrom === undefined) return layer.findIndex(ready);
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < layer.length; i++) {
      const it = layer[i]!;
      const d = hdist(it.b.pos, p.cur);
      if (d < bd && ready(it)) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  };
  let column: Column | undefined;
  let supports: Cell[] = [];
  const descend = () => {
    if (!column) return;
    p.steps.push({ op: 'descend', base: column.base, height: column.height });
    for (let k = column.height - 1; k >= 0; k--) p.removeScaffold(add(column.base, 0, k, 0));
    p.cur = column.base;
    column = undefined;
  };
  /** Track B3: the bot on the column grows it (it pillars on from the top). */
  const growColumn = (g: Column): void => {
    p.steps.push({ op: 'pillar', base: g.base, height: g.height });
    for (let k = column!.height; k < g.height; k++) p.addScaffold(add(g.base, 0, k, 0));
    column = g;
    p.cur = g.top;
  };
  // Track B3 (decision 0128): the cells still to place by position (what a stand or a column top reaches), the
  // current layer's by column (how many a new stand reaches); the stand the last placement was made from
  const remaining = new Map<string, Item>();
  let layerY: number | undefined;
  const layerCols = new Map<string, Item>();
  let clusterFrom: Cell | undefined;
  const taken = (it: Item): void => {
    remaining.delete(key(it.b.pos));
    if (it.b.pos.y === layerY) layerCols.delete(`${it.b.pos.x},${it.b.pos.z}`);
  };
  const reachR = Math.ceil(p.o.reach);
  const cover = (f: Cell): number => {
    if (layerY === undefined) return 0;
    let c = 0;
    for (let dx = -reachR; dx <= reachR; dx++) {
      for (let dz = -reachR; dz <= reachR; dz++) {
        const it = layerCols.get(`${f.x + dx},${f.z + dz}`);
        if (it && !inBody(f, it.b.pos) && centreDistance(f, it.b.pos) <= p.o.reach) c++;
      }
    }
    return c;
  };
  const isScaffoldCell = (c: Cell) => p.sim.isScaffold(c);
  /** Track B3: the look from stand f at the cell's centre has the cardinal (or axis) its states need (no support checked). */
  const viewFits = (it: Item, f: Cell): boolean => {
    const n = it.pl.need;
    if (n.yaw !== undefined || n.eye !== undefined || (!n.cardinal && !n.axis)) return false;
    const dx = it.b.pos.x - f.x;
    const dz = it.b.pos.z - f.z;
    const look: Cardinal = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north';
    if (dx === dz || dx === -dz) return false; // on the diagonal: either quadrant
    if (n.cardinal) return look === n.cardinal;
    return (look === 'east' || look === 'west') === (n.axis === 'x');
  };
  const fromHere = (it: Item, f: Cell): boolean => (plainPlacement(it.pl) ? canPlaceFrom(p.sim, f, it.b.pos, p.o.reach) : canPlaceWith(p.sim, f, it.b.pos, it.pl, p.o.reach, isScaffoldCell)?.natural === true);
  /**
   * Track B3: cells still to place that a column top reaches (any layer: the column is kept and grown for them); a
   * block whose states the click chooses only when the top gives them with a natural view (now, or for one whose
   * support comes later: a view of its cardinal from the eye to the cell); the column top is left for the next one
   * otherwise, as nearPick does.
   */
  const coverTop = (top: Cell): number => {
    let c = 0;
    for (let y = top.y - reachR - 1; y <= top.y + reachR; y++) {
      for (let dx = -reachR; dx <= reachR; dx++) {
        for (let dz = -reachR; dz <= reachR; dz++) {
          const q = { x: top.x + dx, y, z: top.z + dz };
          const it = remaining.get(key(q));
          if (!it || inBody(top, q) || centreDistance(top, q) > p.o.reach) continue;
          if (plainPlacement(it.pl) || (it.pl.hinge === undefined && it.pl.extra.length === 0 && (ready(it) ? fromHere(it, top) : viewFits(it, top)))) c++;
        }
      }
    }
    return c;
  };
  /**
   * Track B3: the next cell from where the bot is: on a column top any ready cell it reaches (the layers above too,
   * the column is kept and grown for them); on the ground, once it walked to a stand for this layer, the ready cells
   * that stand reaches in this layer and up to GROUND_UP above it (those not beside or over its body), the lowest
   * first, the farthest first in a layer, the cells beside its body last. Doors and two-cell blocks keep the old order.
   */
  const nearPick = (layers: Item[][], li: number): { layer: Item[]; index: number } | undefined => {
    if (!p.o.cluster || layerY === undefined) return undefined;
    const f = column ? column.top : clusterFrom && key(clusterFrom) === key(p.cur) ? p.cur : undefined;
    if (!f) return undefined;
    let best: Item | undefined;
    let bestD = -Infinity;
    let bestNear = true;
    let bestY = Infinity;
    const y0 = column ? f.y - reachR - 1 : layerY;
    const y1 = column ? f.y + reachR : Math.min(layerY + GROUND_UP, f.y + reachR);
    for (let y = y0; y <= y1; y++) {
      for (let dx = -reachR; dx <= reachR; dx++) {
        for (let dz = -reachR; dz <= reachR; dz++) {
          // above the layer from the ground: not beside or over the body
          if (!column && y > layerY && Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
          const it = remaining.get(key({ x: f.x + dx, y, z: f.z + dz }));
          if (!it || waiting.has(it) || it.pl.hinge !== undefined || it.pl.extra.length > 0 || !ready(it) || !fromHere(it, f)) continue;
          // above the layer from the ground: only on a block (a wall goes up; no cell hangs over one left for later)
          if (!column && y > layerY && replaceable(p.sim.blockAt(add(it.b.pos, 0, -1, 0)))) continue;
          const near = !column && Math.abs(it.b.pos.x - f.x) <= 1 && Math.abs(it.b.pos.z - f.z) <= 1 && it.b.pos.y <= f.y + 1;
          const d = hdist(it.b.pos, start);
          // on a column: the farthest first (as before); on the ground: the lowest first, then the farthest
          const lower = !column && y < bestY;
          const same = column !== undefined || y === bestY;
          if ((bestNear && !near) || (near === bestNear && (lower || (same && d > bestD)))) {
            best = it;
            bestD = d;
            bestNear = near;
            bestY = y;
          }
        }
      }
    }
    if (!best) return undefined;
    for (const list of [...layers.slice(li), carry, later ?? []]) {
      const idx = list.indexOf(best);
      if (idx >= 0) return { layer: list, index: idx };
    }
    remaining.delete(key(best.b.pos)); // not in any list any more (never: guard)
    return undefined;
  };
  const endLayer = (last = false) => {
    // Track B3: the column stays for the next layer unless support scaffolds wait to be dug (from the ground)
    if (last || supports.length) descend();
    // support scaffolds: highest first
    for (const s of supports.sort((a, b) => b.y - a.y)) {
      const stand = p.digStand(s);
      if (!stand) {
        plan.skipped.push({ pos: s, reason: 'scaffold left (out of reach)' });
        continue;
      }
      p.steps.push({ op: 'unscaffold', pos: s, stand });
      p.removeScaffold(s);
      p.cur = stand;
    }
    supports = [];
  };
  // Track B1: power sources after everything else (decision 0124 "ordered redstone"); a cell whose support comes in
  // a later layer (a lantern under a ceiling, a torch on a wall built later) waits for it
  let n = 0;
  let carry: Item[] = [];
  /** Track B3: the layer's plain cells out of reach when their turn came (tried again at the layer's end). */
  let later: Item[] | undefined;
  /**
   * Track B7 (decision 0132): the cells in `later`, which nearPick leaves alone until the layer's end: one it picked
   * from there could fail again at once, for ever (the stand it was reached from not safe), and the plan never ended.
   */
  const waiting = new Set<Item>();
  // doors after the rest (their hinge follows the neighbours at the click, which are all there then), power sources last
  const isDoor = (it: Item) => it.pl.hinge !== undefined;
  for (const phase of [todo.filter((it) => !it.pl.source && !isDoor(it)), todo.filter((it) => !it.pl.source && isDoor(it)), todo.filter((it) => it.pl.source)]) {
    const order = bottomUpItems(phase, start);
    const layers: Item[][] = [];
    for (const it of order) {
      const last = layers.at(-1);
      if (last?.[0]?.b.pos.y === it.b.pos.y) last.push(it);
      else layers.push([it]);
    }
    remaining.clear();
    for (const it of phase) remaining.set(key(it.b.pos), it);
    if (carry.length) {
      for (const it of carry) remaining.set(key(it.b.pos), it);
      if (layers.length) layers[0] = [...carry, ...layers[0]!];
      else layers.push(carry);
      carry = [];
    }
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]!;
      // the layer's own height (carried cells come first and may lie lower)
      layerY = layer[layer.length - 1]?.b.pos.y;
      layerCols.clear();
      for (const it of layer) if (it.b.pos.y === layerY) layerCols.set(`${it.b.pos.x},${it.b.pos.z}`, it);
      clusterFrom = undefined;
      // Track B3: a plain cell out of reach now waits for the rest of its layer (the stands it needs may be blocks of
      // the layer still to place), then is tried again while each round places something; skipped after that
      later = p.o.cluster ? [] : undefined;
      let retried = -1;
      let rounds = 0;
      for (;;) {
        while (layer.length) {
          if (++n % chunk === 0) yield;
          const near = nearPick(layers, li);
          if (near) {
            placeOne(near.layer.splice(near.index, 1)[0]!);
            clusterFrom = p.cur;
            continue;
          }
          const i = pickIndex(layer);
          if (i >= 0) {
            placeOne(layer.splice(i, 1)[0]!);
            clusterFrom = p.cur;
            continue;
          }
          for (let j = layer.length - 1; j >= 0; j--) if (mayWait(layer[j]!)) carry.unshift(...layer.splice(j, 1));
          if (!layer.length) break;
          placeOne(layer.splice(0, 1)[0]!);
          clusterFrom = p.cur;
        }
        if (!later?.length) break;
        if (plan.work === retried || ++rounds > LATER_ROUNDS) {
          for (const it of later) {
            taken(it);
            plan.skipped.push({ pos: it.b.pos, reason: 'out of reach' });
          }
          break;
        }
        retried = plan.work;
        waiting.clear();
        layer.push(...later.splice(0));
      }
      later = undefined;
      waiting.clear();
      endLayer(li === layers.length - 1);
      if (carry.length && li + 1 < layers.length) {
        layers[li + 1] = [...carry, ...layers[li + 1]!];
        carry = [];
      }
    }
  }
  // what still waits: once more, in order (a support that never came: a scaffold or a skip)
  layerY = undefined;
  if (carry.length) {
    const rest = carry;
    while (rest.length) {
      if (++n % chunk === 0) yield;
      const i = pickIndex(rest);
      placeOne(rest.splice(i >= 0 ? i : 0, 1)[0]!);
    }
  }
  endLayer(true);
  function placeOne(it: Item): void {
    const { b, pl } = it;
    taken(it);
    if (!plainPlacement(pl)) return placeStateful(it);
    const t = b.pos;
    const item = pl.item;
    const name = pl.name;
    // Track B7 (decision 0132): a block that falls (sand, gravel, concrete powder) needs a block under it that stays
    // there: on air or on a scaffold block dug later it would fall (a staircased map art's sand)
    if (GRAVITY_RE.test(name)) {
      const under = add(t, 0, -1, 0);
      if (replaceable(p.sim.blockAt(under)) || p.sim.isScaffold(under)) {
        plan.skipped.push({ pos: t, reason: 'it falls (nothing under it)' });
        return;
      }
    }
    // a fence, a wall, a pane: placed the old way, its connections verified at the end
    const stepPl = Object.keys(pl.derived).length > 0 ? { pl } : {};
    const done = () => {
      p.sim.unblock(t);
      p.sim.setSolid(t, name, p.o.shapeOf?.(name, b.states), b.states);
      count(item);
      plan.work++;
    };
    // from the column top while it reaches (Track B3: grown by a few blocks when that reaches it)
    if (column) {
      const supported = supportsOf(p.sim, t).length > 0;
      if (supported && canPlaceFrom(p.sim, column.top, t, p.o.reach)) {
        p.steps.push({ op: 'place', pos: t, name, item, top: column.top, ...stepPl });
        done();
        return;
      }
      const g = supported ? p.grow(column, (top) => canPlaceFrom(p.sim, top, t, p.o.reach)) : undefined;
      if (g) {
        growColumn(g);
        p.steps.push({ op: 'place', pos: t, name, item, top: g.top, ...stepPl });
        done();
        return;
      }
      // Track B7: no support yet: one support block from the top, the block on it, the support dug again
      const s = !supported && p.o.scaffold ? topSupport(t, column.top) : undefined;
      if (s) {
        placeOnSupport(t, s, column.top, () => p.steps.push({ op: 'place', pos: t, name, item, top: column!.top, ...stepPl }), done);
        return;
      }
      descend();
    }
    // support
    if (supportsOf(p.sim, t).length === 0) {
      if (!p.o.scaffold) {
        plan.skipped.push({ pos: t, reason: 'no support (buildScaffold off)' });
        return;
      }
      const chain = p.supportChain(t);
      if (!chain) {
        // Track B7 (decision 0132): no chain from a stand (a block high over the ground: a map art's staircase): a
        // scaffold column whose top places one support block beside it, then the block, then digs the support
        const col = p.column(t, (top) => topSupport(t, top) !== undefined, p.o.cluster ? coverTop : undefined);
        const s2 = col && topSupport(t, col.top, col);
        if (col && s2) {
          p.steps.push({ op: 'pillar', base: col.base, height: col.height });
          for (let k = 0; k < col.height; k++) p.addScaffold(add(col.base, 0, k, 0));
          column = col;
          p.cur = col.top;
          placeOnSupport(t, s2, col.top, () => p.steps.push({ op: 'place', pos: t, name, item, top: col.top, ...stepPl }), done);
          return;
        }
        plan.skipped.push({ pos: t, reason: 'no support' });
        return;
      }
      chain.cells.forEach((c, i) => {
        p.steps.push({ op: 'scaffold', pos: c, stand: chain.stands[i]! });
        p.addScaffold(c);
        p.cur = chain.stands[i]!;
        supports.push(c);
      });
    }
    const stand = p.placeStand(t, p.o.cluster ? cover : undefined);
    if (stand) {
      p.steps.push({ op: 'place', pos: t, name, item, stand, ...stepPl });
      p.cur = stand;
      done();
      return;
    }
    if (!p.o.scaffold) {
      plan.skipped.push({ pos: t, reason: 'out of reach (buildScaffold off)' });
      return;
    }
    const col = p.column(t, undefined, p.o.cluster ? coverTop : undefined);
    if (!col) {
      if (later) {
        // Track B3: tried again at the layer's end (its stand may be a block of the layer still to place)
        later.push(it);
        waiting.add(it);
        remaining.set(key(t), it);
        if (t.y === layerY) layerCols.set(`${t.x},${t.z}`, it);
        return;
      }
      plan.skipped.push({ pos: t, reason: 'out of reach' });
      return;
    }
    p.steps.push({ op: 'pillar', base: col.base, height: col.height });
    for (let k = 0; k < col.height; k++) p.addScaffold(add(col.base, 0, k, 0));
    column = col;
    p.cur = col.top;
    p.steps.push({ op: 'place', pos: t, name, item, top: col.top, ...stepPl });
    done();
  }

  /**
   * Track B7 (decision 0132): a support cell beside `t` (free, no cell the build fills later, with a clickable neighbour
   * of its own) that the bot on column top `top` places, and from which it then places `t`; `col`: a column not in the
   * simulation yet (its cells counted as blocks for the look).
   */
  function topSupport(t: Cell, top: Cell, col?: Column): Cell | undefined {
    const colCells = col ? Array.from({ length: col.height }, (_, k) => add(col.base, 0, k, 0)) : [];
    for (const c of colCells) p.sim.setSolid(c);
    try {
      const under = add(top, 0, -1, 0);
      for (const d of NEIGHBOURS6) {
        const s = add(t, d.x, d.y, d.z);
        if (key(s) === key(under) || inBody(top, s) || !p.freeForScaffold(s) || supportsOf(p.sim, s).length === 0) continue;
        if (!canPlaceFrom(p.sim, top, s, p.o.reach)) continue;
        p.sim.setSolid(s);
        const ok = canPlaceFrom(p.sim, top, t, p.o.reach) && canDigFrom(top, s, p.o.reach);
        p.sim.setAir(s);
        if (ok) return s;
      }
      return undefined;
    } finally {
      for (const c of colCells) p.sim.setAir(c);
    }
  }

  /** Track B7: from column top `top`: the support block `s`, the block (`place` pushes its step), the support dug. */
  function placeOnSupport(t: Cell, s: Cell, top: Cell, place: () => void, done: () => void): void {
    p.steps.push({ op: 'scaffold', pos: s, top });
    p.addScaffold(s);
    place();
    done();
    p.steps.push({ op: 'unscaffold', pos: s, top });
    p.removeScaffold(s);
  }

  /**
   * Track B1: a block whose states the click chooses: a stand from which an allowed face is in reach with the eye
   * where it must be, a natural view first (a turned one costs TURN_PENALTY); a door's hinge arranged with scaffold
   * blocks beside it for the click; its second cells filled with it.
   */
  function placeStateful(it: Item): void {
    const { b, pl } = it;
    const t = b.pos;
    const skip = (reason: string) => plan.skipped.push({ pos: t, reason: `${pl.family}: ${reason}` });
    const extras = cellsOf(t, pl);
    const isScaffold = (c: Cell) => p.sim.isScaffold(c);
    const can = (f: Cell, q: Placement) => canPlaceWith(p.sim, f, t, q, p.o.reach, isScaffold);
    let use = pl;
    const done = (how: { stand?: Cell; top?: Cell }) => {
      const c = can(how.stand ?? how.top!, use);
      if (c && !c.natural) plan.turned = (plan.turned ?? 0) + 1;
      plan.stateful = (plan.stateful ?? 0) + 1;
      p.steps.push({ op: 'place', pos: t, name: pl.name, item: pl.item, ...how, pl: use });
      p.sim.unblock(t);
      p.sim.setSolid(t, pl.name, p.o.shapeOf?.(pl.name, b.states), b.states);
      extras.forEach((c2, i) => {
        const e = byKey.get(key(c2));
        p.sim.unblock(c2);
        p.sim.setSolid(c2, pl.extra[i]!.name, p.o.shapeOf?.(pl.extra[i]!.name, e?.states), e?.states);
      });
      for (let k = 0; k <= pl.merges; k++) count(pl.item);
      plan.work++;
    };
    if (!extras.every((c) => replaceable(p.sim.blockAt(c)))) return void skip('its second cell is taken');
    const hf = headFloor(it);
    if (hf && !standTop(p.sim.blockAt(hf))) return void skip('no floor under its head');
    // from the column top while it reaches (Track B3: or grown a little, not for a door)
    if (column) {
      if (can(column.top, use)) return done({ top: column.top });
      const g = pl.hinge === undefined && hasSupport(it) ? p.grow(column, (top) => !!can(top, use)) : undefined;
      if (g) {
        growColumn(g);
        return done({ top: g.top });
      }
      descend();
    }
    // support: one of the allowed faces' blocks (a scaffold chain ending there, never for a block that hangs on it)
    if (!hasSupport(it)) {
      if (pl.need.realSupport) return void skip('nothing to hang it on');
      if (!p.o.scaffold) return void skip('no support (buildScaffold off)');
      const chain = p.supportChain(t, allowedSupports(it));
      if (!chain) return void skip('no support');
      chain.cells.forEach((c, i) => {
        p.steps.push({ op: 'scaffold', pos: c, stand: chain.stands[i]! });
        p.addScaffold(c);
        p.cur = chain.stands[i]!;
        supports.push(c);
      });
    }
    // a door's hinge: the neighbours at the click decide (measured); scaffold blocks beside it when they give the other side
    let temps: { cells: Cell[]; stands: Cell[] } | undefined;
    if (pl.hinge !== undefined && pl.need.cardinal && doorHinge(p.sim, t, pl.need.cardinal) !== pl.hinge) {
      temps = hingeFix(t, pl.need.cardinal, pl.hinge);
      if (!temps) use = withoutHinge(pl);
    }
    let stand = p.standFor(t, (f) => !!can(f, use), false, (f) => (can(f, use)?.natural === false ? TURN_PENALTY : 0), p.o.cluster && pl.hinge === undefined ? cover : undefined);
    if (!stand && temps) {
      for (const c of temps.cells) p.sim.setAir(c);
      temps = undefined;
      use = withoutHinge(pl);
      stand = p.standFor(t, (f) => !!can(f, use), false, (f) => (can(f, use)?.natural === false ? TURN_PENALTY : 0));
    }
    if (use !== pl) (plan.unmade ??= []).push({ pos: t, reason: 'door hinge: its neighbours give the other side' });
    if (temps) {
      // the scaffold blocks are in the sim already (hingeFix); placed first, dug right after the door
      const stands = temps.stands;
      temps.cells.forEach((c, i) => {
        p.sim.setAir(c);
        p.steps.push({ op: 'scaffold', pos: c, stand: stands[i]! });
        p.addScaffold(c);
      });
    }
    if (stand) {
      p.cur = stand;
      done({ stand });
    } else if (!p.o.scaffold) skip('no stand that gives its states (buildScaffold off)');
    else {
      const col = p.column(t, (top) => !!can(top, use), p.o.cluster && pl.hinge === undefined ? coverTop : undefined);
      if (!col) skip('no stand that gives its states');
      else {
        p.steps.push({ op: 'pillar', base: col.base, height: col.height });
        for (let k = 0; k < col.height; k++) p.addScaffold(add(col.base, 0, k, 0));
        column = col;
        p.cur = col.top;
        done({ top: col.top });
      }
    }
    for (const c of [...(temps?.cells ?? [])].reverse()) {
      const s = column ? undefined : p.digStand(c);
      if (!s) {
        supports.push(c); // dug at the end of the layer
        continue;
      }
      p.steps.push({ op: 'unscaffold', pos: c, stand: s });
      p.removeScaffold(c);
      p.cur = s;
    }
  }

  /** Scaffold cells beside a door at `t` that make its neighbours give hinge `want` (left in the sim), or undefined. */
  function hingeFix(t: Cell, view: Parameters<typeof doorHinge>[2], want: boolean): { cells: Cell[]; stands: Cell[] } | undefined {
    const { next, next2 } = hingeCells(t, view);
    const side = want ? next2 : next;
    const out = { cells: [] as Cell[], stands: [] as Cell[] };
    for (const c of [side, add(side, 0, 1, 0)]) {
      const blk = p.sim.blockAt(c);
      if (hingeSolid(blk)) continue;
      if (!replaceable(blk) || isLiquid(blk) || p.sim.isBlocked(c) || supportsOf(p.sim, c).length === 0) break;
      const s = p.placeStand(c);
      if (!s) break;
      p.sim.setSolid(c);
      out.cells.push(c);
      out.stands.push(s);
      if (doorHinge(p.sim, t, view) === want) return out;
    }
    for (const c of out.cells) p.sim.setAir(c);
    return undefined;
  }
  plan.steps = p.steps;
  plan.scaffolds = p.scaffolds;
  plan.scaffoldPeak = p.peak;
  plan.ms = performance.now() - t0;
  return plan;
}

/** Track B1: a door's placement that takes the hinge its neighbours give (verified at the end, reported). */
function withoutHinge(pl: Placement): Placement {
  const { hinge: _h, ...rest } = pl;
  return { ...rest, extra: pl.extra.map((e) => ({ ...e, check: Object.fromEntries(Object.entries(e.check).filter(([k]) => k !== 'door_hinge_bit')) })) };
}

/**
 * Track B1: refusals grouped by reason, `3 refused (standing_banner: a banner's colour ...; water: no liquids)`: at most
 * `max` reasons with `names` blocks each; Track B5: the rest as `+N more` (`!build materials more` lists them all).
 */
export function refusedLine(refused: readonly { name: string; reason: string }[], max = 3, names = 3): string {
  const by = new Map<string, Set<string>>();
  for (const r of refused) {
    const s = by.get(r.reason) ?? new Set<string>();
    s.add(r.name);
    by.set(r.reason, s);
  }
  const parts = [...by].slice(0, max).map(([why, ns]) => `${[...ns].slice(0, names).join(' ')}${ns.size > names ? ` +${ns.size - names} more` : ''}: ${why}`);
  const rest = by.size - max;
  return `${refused.length} refused (${parts.join('; ')}${rest > 0 ? `; +${rest} more reason${rest === 1 ? '' : 's'}` : ''})`;
}

/** One line: `fill 5x3x5 cobblestone: 75 to place, 0 there already, 0 occupied, 0 skipped, 1 scaffold`. */
export function planLine(plan: Plan): string {
  const verb = plan.spec.kind === 'clear' ? 'to dig' : plan.spec.kind === 'replace' ? 'to replace' : 'to place';
  const parts = [`${plan.work} ${verb}`];
  if (plan.already) parts.push(`${plan.already} ${plan.spec.kind === 'clear' ? 'empty' : 'there'} already`);
  if (plan.occupied) parts.push(`${plan.occupied} occupied (left)`);
  if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped (${[...new Set(plan.skipped.map((s) => s.reason))].join(', ')})`);
  if (plan.refused?.length) parts.push(refusedLine(plan.refused));
  if (plan.scaffolds) parts.push(`${plan.scaffolds} scaffold${plan.scaffolds === 1 ? '' : 's'}`);
  return `${plan.spec.label}: ${parts.join(', ')}`;
}
