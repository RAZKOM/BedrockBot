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
import { centreDistance, BUILD_REACH, canDigFrom, canPlaceFrom, canStand, isLiquid, NEIGHBOURS6, passable, reachableStands, replaceable, SimWorld, supportsOf, areaAround, type Area, type BlockReader } from './sim.ts';
import { add, blockId, isAirName, itemFor, key, MAX_BUILD_CELLS, unsupportedBlock, type BuildBlock, type BuildSpec, type Cell } from './types.ts';

export type Step =
  /** Place a target block; `top`: from the scaffold column top the bot stands on (no walking). */
  | { op: 'place'; pos: Cell; name: string; item: string; stand?: Cell; top?: Cell }
  /** Place a support scaffold (a throwaway block). */
  | { op: 'scaffold'; pos: Cell; stand?: Cell; top?: Cell }
  /** Walk to `base` (feet) and pillar up `height` blocks (scaffold cells base.y .. base.y + height - 1). */
  | { op: 'pillar'; base: Cell; height: number }
  /** Standing on the column top: dig the column cells top-down under the feet, landing on each. */
  | { op: 'descend'; base: Cell; height: number }
  /** Dig a support scaffold. */
  | { op: 'unscaffold'; pos: Cell; stand?: Cell }
  /** Dig a target (clear). */
  | { op: 'dig'; pos: Cell; name: string; stand?: Cell }
  /** Dig `from`, place `to` (replace). */
  | { op: 'replace'; pos: Cell; from: string; to: string; item: string; stand?: Cell };

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
}

export interface PlanOptions {
  /** The bot's feet (the order runs from the far side towards it). */
  start: Cell;
  /** Add scaffold cells (the `buildScaffold` setting). Default true. */
  scaffold?: boolean;
  /** Eye-to-centre reach for stands. Default 4.5. */
  reach?: number;
  /** Highest scaffold column. Default 6. */
  maxColumn?: number;
  /** Longest support chain. Default 3. */
  maxSupport?: number;
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

class Planner {
  readonly sim: SimWorld;
  readonly o: Required<PlanOptions>;
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
    this.o = { scaffold: true, reach: BUILD_REACH, maxColumn: 6, maxSupport: 3, ...o };
    this.cur = o.start;
    this.area = area;
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
  standFor(t: Cell, ok: (f: Cell) => boolean, low = false): Cell | undefined {
    const rules = { isBlocked: (p: Cell) => this.sim.isBlocked(p) };
    const high = (f: Cell): number => (low ? Math.max(0, f.y - t.y - 1) : 0);
    let found: Cell | undefined;
    for (const fresh of [false, true]) {
      const set = this.reachable(fresh);
      const curOk = set.has(key(this.cur)) && canStand(this.sim, this.cur, rules) && ok(this.cur);
      if (curOk && high(this.cur) === 0) return this.cur;
      let best: Cell | undefined = curOk ? this.cur : undefined;
      let bestD = curOk ? CLEAR_HIGH_STAND * high(this.cur) : Infinity;
      const r = Math.ceil(this.o.reach);
      for (let dy = -r - 1; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const f = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
            if (!set.has(key(f)) || !canStand(this.sim, f, rules) || !ok(f)) continue;
            const d = dist(f, this.cur) + 0.001 * centreDistance(f, t) + CLEAR_HIGH_STAND * high(f);
            if (d < bestD) {
              bestD = d;
              best = f;
            }
          }
        }
      }
      // a clear's best stand over the dig level in the cached set: look again in the fresh one (a pit floor dug since)
      if (best && high(best) === 0) return best;
      found ??= best;
      if (best && fresh) return best;
    }
    return found;
  }

  placeStand(t: Cell): Cell | undefined {
    return this.standFor(t, (f) => canPlaceFrom(this.sim, f, t, this.o.reach));
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
  supportChain(t: Cell): { cells: Cell[]; stands: Cell[] } | undefined {
    const start = NEIGHBOURS6.map((d) => add(t, d.x, d.y, d.z)).filter((c) => this.freeForScaffold(c));
    const prev = new Map<string, Cell | null>();
    let frontier: Cell[] = [];
    for (const c of start) {
      prev.set(key(c), null);
      frontier.push(c);
    }
    for (let depth = 1; depth <= this.o.maxSupport && frontier.length; depth++) {
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

  private freeForScaffold(c: Cell): boolean {
    return !this.sim.isBlocked(c) && replaceable(this.sim.blockAt(c)) && !isLiquid(this.sim.blockAt(c));
  }

  /**
   * A scaffold column next to `t`: a reachable stand `base`, `height` free cells above it to pillar
   * into (plus the head room for the last jump), from whose top `t` can be placed.
   */
  column(t: Cell): { base: Cell; height: number; top: Cell } | undefined {
    const rules = { isBlocked: (p: Cell) => this.sim.isBlocked(p) };
    const set = this.reachable(true);
    const offsets: [number, number][] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx !== 0 || dz !== 0) offsets.push([dx, dz]);
    offsets.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - (Math.abs(b[0]) + Math.abs(b[1])));
    for (let h = 1; h <= this.o.maxColumn; h++) {
      let best: { base: Cell; height: number; top: Cell } | undefined;
      let bestD = Infinity;
      for (const [dx, dz] of offsets) {
        for (let by = t.y - h - 6; by <= t.y - h + 1; by++) {
          const base = { x: t.x + dx, y: by, z: t.z + dz };
          if (!set.has(key(base)) || !canStand(this.sim, base, rules)) continue;
          let free = true;
          for (let k = 0; k < h + 3 && free; k++) {
            const c = add(base, 0, k, 0);
            free = !this.sim.isBlocked(c) && passable(this.sim.blockAt(c));
          }
          if (!free) continue;
          const top = add(base, 0, h, 0);
          for (let k = 0; k < h; k++) this.sim.setSolid(add(base, 0, k, 0));
          const ok = canPlaceFrom(this.sim, top, t, this.o.reach);
          for (let k = 0; k < h; k++) this.sim.setAir(add(base, 0, k, 0));
          if (!ok) continue;
          // closest top to the target first (margin on a real server), then the shortest walk
          const d = centreDistance(top, t) + 0.25 * dist(base, this.cur);
          if (d < bestD) {
            bestD = d;
            best = { base, height: h, top };
          }
        }
      }
      if (best) return best;
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
    let n = 0;
    for (const t of cells) {
      if (++n % chunk === 0) yield;
      const b = p.sim.blockAt(t);
      if (!b) {
        plan.skipped.push({ pos: t, reason: 'unloaded' });
        continue;
      }
      const name = blockId(b.name);
      if (rep ? name !== rep.from : isAirName(name)) {
        if (!rep) plan.already++;
        continue;
      }
      if (rep?.to === name) continue;
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
        const stand = p.standFor(t, (f) => {
          if (!canDigFrom(f, t, p.o.reach)) return false;
          p.sim.setAir(t);
          const ok = canPlaceFrom(p.sim, f, t, p.o.reach);
          p.sim.setSolid(t, name);
          return ok;
        });
        if (!stand) {
          plan.skipped.push({ pos: t, reason: 'out of reach' });
          continue;
        }
        p.steps.push({ op: 'replace', pos: t, from: rep.from, to: rep.to, item: itemFor(rep.to), stand });
        p.sim.setSolid(t, rep.to);
        p.cur = stand;
        count(itemFor(rep.to));
      } else {
        const stand = p.digStand(t, true);
        if (!stand) {
          plan.skipped.push({ pos: t, reason: 'out of reach' });
          continue;
        }
        p.steps.push({ op: 'dig', pos: t, name, stand });
        p.sim.setAir(t);
        p.cur = stand;
      }
      plan.work++;
    }
    plan.steps = p.steps;
    plan.ms = performance.now() - t0;
    return plan;
  }

  // ---- place kinds
  if (spec.places.length > MAX_BUILD_CELLS) throw new PlanError(`${spec.places.length} blocks is too big (at most ${MAX_BUILD_CELLS})`);
  for (const b of spec.places) {
    const why = unsupportedBlock(b.name);
    if (why) throw new PlanError(`${b.name}: ${why}`);
  }
  const p = new Planner(
    world,
    areaAround(
      spec.places.map((b) => b.pos),
      6,
      4,
      start,
    ),
    { ...o, start },
  );
  const todo: BuildBlock[] = [];
  const seen = new Set<string>();
  for (const b of spec.places) {
    if (seen.has(key(b.pos))) continue;
    seen.add(key(b.pos));
    const w = world.blockAt(b.pos);
    if (!w) {
      plan.skipped.push({ pos: b.pos, reason: 'unloaded' });
      continue;
    }
    if (blockId(w.name) === blockId(b.name)) {
      plan.already++;
      continue;
    }
    if (!replaceable(w)) {
      plan.occupied++;
      continue;
    }
    todo.push(b);
    p.sim.block(b.pos);
  }
  const order = bottomUp(todo, start);
  /** Inside a layer: the farthest cell that has a clickable neighbour now, else the farthest. */
  const nextOf = (layer: BuildBlock[]): BuildBlock => {
    const i = layer.findIndex((b) => supportsOf(p.sim, b.pos).length > 0);
    return layer.splice(i >= 0 ? i : 0, 1)[0]!;
  };
  let column: { base: Cell; height: number; top: Cell } | undefined;
  let supports: Cell[] = [];
  const descend = () => {
    if (!column) return;
    p.steps.push({ op: 'descend', base: column.base, height: column.height });
    for (let k = column.height - 1; k >= 0; k--) p.removeScaffold(add(column.base, 0, k, 0));
    p.cur = column.base;
    column = undefined;
  };
  const endLayer = () => {
    descend();
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
  let n = 0;
  for (let li = 0; li < order.length; ) {
    let lj = li;
    while (lj < order.length && order[lj]!.pos.y === order[li]!.pos.y) lj++;
    const layer = order.slice(li, lj);
    li = lj;
    while (layer.length) {
      if (++n % chunk === 0) yield;
      placeOne(nextOf(layer));
    }
    endLayer();
  }
  function placeOne(b: BuildBlock): void {
    const t = b.pos;
    const item = itemFor(b.name);
    const done = () => {
      p.sim.unblock(t);
      p.sim.setSolid(t, blockId(b.name));
      count(item);
      plan.work++;
    };
    // from the column top while it reaches
    if (column) {
      if (supportsOf(p.sim, t).length > 0 && canPlaceFrom(p.sim, column.top, t, p.o.reach)) {
        p.steps.push({ op: 'place', pos: t, name: blockId(b.name), item, top: column.top });
        done();
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
    const stand = p.placeStand(t);
    if (stand) {
      p.steps.push({ op: 'place', pos: t, name: blockId(b.name), item, stand });
      p.cur = stand;
      done();
      return;
    }
    if (!p.o.scaffold) {
      plan.skipped.push({ pos: t, reason: 'out of reach (buildScaffold off)' });
      return;
    }
    const col = p.column(t);
    if (!col) {
      plan.skipped.push({ pos: t, reason: 'out of reach' });
      return;
    }
    p.steps.push({ op: 'pillar', base: col.base, height: col.height });
    for (let k = 0; k < col.height; k++) p.addScaffold(add(col.base, 0, k, 0));
    column = col;
    p.cur = col.top;
    p.steps.push({ op: 'place', pos: t, name: blockId(b.name), item, top: col.top });
    done();
  }
  plan.steps = p.steps;
  plan.scaffolds = p.scaffolds;
  plan.scaffoldPeak = p.peak;
  plan.ms = performance.now() - t0;
  return plan;
}

/** One line: `fill 5x3x5 cobblestone: 75 to place, 0 there already, 0 occupied, 0 skipped, 1 scaffold`. */
export function planLine(plan: Plan): string {
  const verb = plan.spec.kind === 'clear' ? 'to dig' : plan.spec.kind === 'replace' ? 'to replace' : 'to place';
  const parts = [`${plan.work} ${verb}`];
  if (plan.already) parts.push(`${plan.already} ${plan.spec.kind === 'clear' ? 'empty' : 'there'} already`);
  if (plan.occupied) parts.push(`${plan.occupied} occupied (left)`);
  if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped (${[...new Set(plan.skipped.map((s) => s.reason))].join(', ')})`);
  if (plan.scaffolds) parts.push(`${plan.scaffolds} scaffold${plan.scaffolds === 1 ? '' : 's'}`);
  return `${plan.spec.label}: ${parts.join(', ')}`;
}
