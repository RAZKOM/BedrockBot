// Track B3 (decision 0128, docs/build.md "Size"): a build larger than one plan. The cells are cut into sections of at
// most SECTION_CELLS (4096): place kinds in bands of whole layers from the bottom up (a layer larger than a section in
// even strips across its longer side, the farthest from the bot first), the blocks that go last in any build (power sources,
// doors, beds, tall plants: decision 0124) in sections of their own at the end; clear and replace in slabs of whole
// layers from the top down. Each section is planned when the one before it is done (on the world as it is then, so a
// section stands on what the last one built), in the planner worker when there is one (worker.ts), and run by a
// BuildRunner of its own; only the running section's plan is kept. A cell a section skipped gets one more try in a
// sweep at the end, and states that depend on the neighbours (a fence beside the next section) are read again then.
//
// The job runs as the build process's work (tasks/process/build.ts). Out of a block on the ground, or at a section's
// start short of a block it needs, it ends `restock` with the runner kept: the controller (chat/commands-build.ts) runs
// a fetch round for the next stretch (what fits in the inventory) and starts the job again, which walks back and goes
// on at the same step. Progress (progress.ts) is marked as cells are done.
import { silentLogger, type Logger } from '../../log.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { PlanError, type Plan, type PlanOptions } from './plan.ts';
import { cleanerWork, TIME_KINDS, type BuildRunner, type BuildWork, type RunnerEnd, type RunnerHooks, type RunnerStats } from './runner.ts';
import type { Area, BlockReader } from './sim.ts';
import { resolveBlocks, sameBlock, statesMatch, stateDiff, type Placement } from './states.ts';
import type { BuildProgress } from './progress.ts';
import { blockId, isAirName, key, SECTION_CELLS, type BuildBlock, type BuildSpec, type Cell } from './types.ts';


/** A section's area around its cells, sideways (the stands' room). */
export const SECTION_SIDE = 6;
/** A section's area below the build's lowest cell and above its own highest. */
export const SECTION_BELOW = 4;
export const SECTION_ABOVE = 4;
/** After a fetch round the bot walks back near the next stand when it is farther than this. */
export const BACK_FAR = 16;
/** Track B10: [again] sections a job makes for cells dug to get out (one after each section that dug some), at most. */
export const UNDONE_ROUNDS = 4;

export interface JobSection {
  spec: BuildSpec;
  area: Area;
  /** Target cells. */
  cells: number;
  /** Items its blocks are placed with (a double slab two). */
  items: Map<string, number>;
  /** The last sections: power sources, doors, beds, tall plants (decision 0124), or the sweep. */
  late?: boolean;
  sweep?: boolean;
  /** Track B9: the cells the section before skipped as it ran, tried once more before the next section is planned. */
  again?: boolean;
  /** Scaffold blocks a stopped run left (a restart): dug first, not the build's work. */
  cleanup?: boolean;
  /** Once planned: its work steps; run: its runner's end. */
  work?: number;
  ran?: boolean;
}

export interface JobDeps {
  world: BlockReader;
  position(): Cell | undefined;
  /** Plan one section (the worker, or planBuildAsync). */
  plan(spec: BuildSpec, o: PlanOptions): Promise<Plan>;
  /** A runner for a section's plan with the job's hooks. */
  runner(plan: Plan, hooks: RunnerHooks): BuildRunner;
  /** The options every section is planned with (scaffold, maxColumn, shapeOf, safeEdge). */
  options: Omit<PlanOptions, 'start' | 'area' | 'skip'>;
  /** A fetch round may bring these (the controller: `fetch` was given and the bill can get them). */
  canFetch?(items: readonly string[]): boolean;
  /** Of an item, how many the build may use now (loose beyond the reserve, and in the carried boxes). */
  have?(item: string): number;
  /** Throwaway blocks that can go into scaffolds now (beyond the reserve). */
  scaffoldHave?(): number;
  /** Walk near a cell (after a fetch round). */
  approach?(c: Cell): Promise<boolean>;
  /**
   * Track B4 (decision 0129): the shulker boxes a stop, a death or a restart left in the world (the progress file's),
   * walked to and picked up before anything is built; `cancelled` is the job's pause.
   */
  boxesFirst?(cancelled: () => boolean): Promise<void>;
  /** Track B4: cancel the running skill (a pause while no runner runs: the walk to a box). */
  cancel?(): void;
  progress?: BuildProgress;
  log?: Logger;
}

/** What a resume found: the cells done before, and the ones changed since. */
export interface Survey {
  done: number;
  /** Done but air now (placed again; for a clear: dug and something is there now: left). */
  air: number;
  /** Done but another block now (left as it is, reported). */
  other: number;
  examples: { pos: Cell; name: string }[];
  /** Scaffold blocks the run before left out (still there): dug first. */
  leftovers: number;
  /** Track B9: cells not marked done that hold their block already (a placement a stop interrupted): marked, in `done`. */
  found: number;
}

const emptyStats = (): RunnerStats => ({ placed: 0, dug: 0, replaced: 0, scaffoldsPlaced: 0, scaffoldsRemoved: 0, skipped: [], processed: 0, activeMs: 0, retries: 0, walks: 0, time: Object.fromEntries(TIME_KINDS.map((k) => [k, 0])) as RunnerStats['time'] });

function addStats(a: RunnerStats, b: RunnerStats, skipped = true): void {
  a.placed += b.placed;
  a.dug += b.dug;
  a.replaced += b.replaced;
  a.scaffoldsPlaced += b.scaffoldsPlaced;
  a.scaffoldsRemoved += b.scaffoldsRemoved;
  if (skipped) a.skipped.push(...b.skipped);
  a.processed += b.processed;
  a.activeMs += b.activeMs;
  a.retries += b.retries;
  a.walks += b.walks;
  for (const k of TIME_KINDS) a.time[k] += b.time[k];
  for (const k of ['refilled', 'refills', 'stowed', 'verified', 'redone', 'escapes', 'undone'] as const) if (b[k]) a[k] = (a[k] ?? 0) + b[k];
  if (b.wrong?.length) (a.wrong ??= []).push(...b.wrong);
}

const boxOf = (cells: Iterable<Cell>): { min: Cell; max: Cell } | undefined => {
  let min: Cell | undefined;
  let max: Cell | undefined;
  for (const c of cells) {
    if (!min || !max) {
      min = { ...c };
      max = { ...c };
      continue;
    }
    min = { x: Math.min(min.x, c.x), y: Math.min(min.y, c.y), z: Math.min(min.z, c.z) };
    max = { x: Math.max(max.x, c.x), y: Math.max(max.y, c.y), z: Math.max(max.z, c.z) };
  }
  return min && max ? { min, max } : undefined;
};

const hd = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.z - b.z);

/** The area a section's stands are looked for in: its columns and SECTION_SIDE round them, from the build's floor up. */
function sectionArea(box: { min: Cell; max: Cell }, floorY: number): Area {
  return { min: { x: box.min.x - SECTION_SIDE, y: Math.min(floorY, box.min.y) - SECTION_BELOW, z: box.min.z - SECTION_SIDE }, max: { x: box.max.x + SECTION_SIDE, y: box.max.y + SECTION_ABOVE, z: box.max.z + SECTION_SIDE } };
}

function itemsOf(cells: readonly { placement: Placement }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const { placement: pl } of cells) m.set(pl.item, (m.get(pl.item) ?? 0) + 1 + pl.merges);
  return m;
}

/**
 * A layer larger than a section in strips across its longer side, as few as hold `max` cells each and of even width,
 * the farthest strip from `from` first (a strip still over `max`, a layer with gaps, is cut in parts).
 */
function strips<T extends { pos: Cell }>(cells: readonly T[], from: Cell, max: number): T[][] {
  const b = boxOf(cells.map((c) => c.pos));
  if (!b) return [];
  const alongX = b.max.x - b.min.x >= b.max.z - b.min.z;
  const len = alongX ? b.max.x - b.min.x + 1 : b.max.z - b.min.z + 1;
  const n = Math.min(len, Math.ceil(cells.length / max));
  const width = Math.ceil(len / n);
  const by = new Map<number, T[]>();
  for (const c of cells) {
    const k = Math.floor((alongX ? c.pos.x - b.min.x : c.pos.z - b.min.z) / width);
    let l = by.get(k);
    if (!l) by.set(k, (l = []));
    l.push(c);
  }
  const centre = (l: T[]) => ({ x: l.reduce((a, c) => a + c.pos.x, 0) / l.length, y: 0, z: l.reduce((a, c) => a + c.pos.z, 0) / l.length });
  const out: T[][] = [];
  for (const l of [...by.values()].sort((p, q) => hd(centre(q), from) - hd(centre(p), from))) for (let i = 0; i < l.length; i += max) out.push(l.slice(i, i + max));
  return out;
}

/** Track B7 (decision 0132): a sparse build's sections are tiles of this many columns a side, every height. */
export const TILE_SIDE = 32;

/**
 * Track B7: a build is sparse when its footprint is wider than a section and it has at most 2 cells a column on average
 * (a map art: one block a column over 256 x 257, at 145 heights). Bands of whole layers would spread every section over
 * the whole footprint: each planned over all of it (minutes a section) and walked end to end layer after layer. A build
 * of at most SPARSE_LOW layers (a floor) keeps its strips.
 */
export function sparseBuild(cells: number, box: { min: Cell; max: Cell }): boolean {
  const cols = (box.max.x - box.min.x + 1) * (box.max.z - box.min.z + 1);
  return cols > SECTION_CELLS && box.max.y - box.min.y + 1 > SPARSE_LOW && cells <= 2 * cols;
}

/** Track B7: a build this low is not sparse (a floor's strips are planned from the ground as before). */
export const SPARSE_LOW = 3;

/**
 * Track B7: cells in tiles of TILE_SIDE x TILE_SIDE columns, every height, the tiles in rows back and forth from the
 * corner of the box nearest `from` (the next tile is beside the last); a tile over `max` cells in bands of layers.
 */
export function tiles<T extends { pos: Cell }>(cells: readonly T[], box: { min: Cell; max: Cell }, from: Cell, max: number, side = TILE_SIDE): T[][] {
  const nx = Math.ceil((box.max.x - box.min.x + 1) / side);
  const nz = Math.ceil((box.max.z - box.min.z + 1) / side);
  const by = new Map<number, T[]>();
  for (const c of cells) {
    const k = Math.floor((c.pos.z - box.min.z) / side) * nx + Math.floor((c.pos.x - box.min.x) / side);
    let l = by.get(k);
    if (!l) by.set(k, (l = []));
    l.push(c);
  }
  const revX = Math.abs(from.x - box.max.x) < Math.abs(from.x - box.min.x);
  const revZ = Math.abs(from.z - box.max.z) < Math.abs(from.z - box.min.z);
  const out: T[][] = [];
  for (let r = 0; r < nz; r++) {
    const tz = revZ ? nz - 1 - r : r;
    for (let q = 0; q < nx; q++) {
      const tx = (r % 2 === 0) !== revX ? q : nx - 1 - q;
      const l = by.get(tz * nx + tx);
      if (!l?.length) continue;
      l.sort((a, b) => a.pos.y - b.pos.y);
      for (let i = 0; i < l.length; i += max) out.push(l.slice(i, i + max));
    }
  }
  return out;
}

export interface Sectioned {
  sections: JobSection[];
  /** Refused blocks (a file build lists them and builds the rest). */
  refused: { pos: Cell; name: string; reason: string }[];
  /** The targets' box. */
  box: { min: Cell; max: Cell };
  /** Target cells (the refused ones not counted). */
  cells: number;
  /** Items in all. */
  materials: Record<string, number>;
}

/**
 * A place build in sections (the file comment). Throws PlanError as planBuild does: a typed build with a refused block.
 * `max` = cells a section (tests use small ones).
 */
export function placeSections(spec: BuildSpec, start: Cell, max = SECTION_CELLS): Sectioned {
  const seen = new Set<string>();
  const unique: BuildBlock[] = [];
  for (const b of spec.places) {
    const k = key(b.pos);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(b);
  }
  seen.clear();
  const byKey = new Map(unique.map((b) => [key(b.pos), b] as const));
  const resolved = resolveBlocks(unique);
  if (resolved.refused.length && spec.kind !== 'file') {
    const r = resolved.refused[0]!;
    throw new PlanError(`${blockId(r.block.name)}: ${r.reason}`);
  }
  const refused = [...resolved.refused.map((r) => ({ pos: r.block.pos, name: blockId(r.block.name), reason: r.reason })), ...(spec.refused ?? [])]; // Track B6: `skip missing`
  const box = boxOf(unique.map((b) => b.pos)) ?? { min: { ...start }, max: { ...start } };
  const floorY = box.min.y;
  const sections: JobSection[] = [];
  const materials: Record<string, number> = {};
  for (const [k, v] of itemsOf(resolved.cells)) materials[k] = v;
  type R = (typeof resolved.cells)[number];
  const late: R[] = [];
  const normal: R[] = [];
  for (const c of resolved.cells) (c.placement.source || c.placement.extra.length > 0 || c.placement.hinge !== undefined ? late : normal).push(c);
  // a section's blocks: its main cells and their second cells (resolved again in its plan)
  const blocksOf = (cs: readonly R[]): BuildBlock[] => {
    const out: BuildBlock[] = [];
    for (const c of cs) {
      out.push(c.block);
      for (const e of c.placement.extra) {
        const b = byKey.get(key({ x: c.block.pos.x + e.offset.x, y: c.block.pos.y + e.offset.y, z: c.block.pos.z + e.offset.z }));
        if (b) out.push(b);
      }
    }
    return out;
  };
  const push = (cs: R[], isLate: boolean) => {
    if (!cs.length) return;
    const n = sections.length + 1;
    const b = boxOf(cs.map((c) => c.block.pos))!;
    sections.push({ spec: { kind: spec.kind, label: `${spec.label} [${n}]`, places: blocksOf(cs) }, area: sectionArea(b, floorY), cells: cs.length, items: itemsOf(cs), ...(isLate ? { late: true } : {}) });
  };
  // Track B7: a sparse build in tiles of whole columns (sparseBuild)
  if (sparseBuild(resolved.cells.length, box)) {
    for (const t of tiles(
      normal.map((c) => ({ pos: c.block.pos, c })),
      box,
      start,
      max,
    ))
      push(
        t.map((x) => x.c),
        false,
      );
    const lateSorted = [...late].sort((a, b) => a.block.pos.y - b.block.pos.y);
    for (let i = 0; i < lateSorted.length; i += max) push(lateSorted.slice(i, i + max), true);
    return { sections, refused, box, cells: resolved.cells.length, materials };
  }
  // bands of whole layers, bottom up
  const layers = new Map<number, R[]>();
  for (const c of normal) {
    let l = layers.get(c.block.pos.y);
    if (!l) layers.set(c.block.pos.y, (l = []));
    l.push(c);
  }
  let band: R[] = [];
  for (const y of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(y)!;
    if (band.length && band.length + layer.length > max) {
      push(band, false);
      band = [];
    }
    if (layer.length > max) {
      for (const t of strips(
        layer.map((c) => ({ pos: c.block.pos, c })),
        start,
        max,
      ))
        push(
          t.map((x) => x.c),
          false,
        );
      continue;
    }
    band.push(...layer);
  }
  push(band, false);
  // the last blocks, bottom up in sections of their own (a door and its upper half stay together)
  const lateSorted = [...late].sort((a, b) => a.block.pos.y - b.block.pos.y);
  for (let i = 0; i < lateSorted.length; i += max) push(lateSorted.slice(i, i + max), true);
  return { sections, refused, box, cells: resolved.cells.length, materials };
}

/** A clear or replace box in slabs of whole layers from the top (a layer larger than a section in tiles). */
export function boxSections(spec: BuildSpec, max = SECTION_CELLS): Sectioned {
  const b = spec.box;
  if (!b) throw new PlanError(`${spec.kind} needs a box`);
  const sx = b.max.x - b.min.x + 1;
  const sz = b.max.z - b.min.z + 1;
  const sy = b.max.y - b.min.y + 1;
  const sections: JobSection[] = [];
  const add = (min: Cell, max2: Cell) => {
    const n = sections.length + 1;
    const cells = (max2.x - min.x + 1) * (max2.y - min.y + 1) * (max2.z - min.z + 1);
    const items = new Map<string, number>();
    if (spec.replace) items.set(spec.replace.to, cells);
    sections.push({ spec: { ...spec, label: `${spec.label} [${n}]`, places: [], box: { min, max: max2 } }, area: sectionArea({ min, max: max2 }, b.min.y), cells, items });
  };
  const layer = sx * sz;
  if (layer <= max) {
    const h = Math.max(1, Math.floor(max / layer));
    for (let top = b.max.y; top >= b.min.y; top -= h) add({ x: b.min.x, y: Math.max(b.min.y, top - h + 1), z: b.min.z }, { x: b.max.x, y: top, z: b.max.z });
  } else {
    // strips across the longer side, as few as hold `max` cells each (a strip one wide still over it: in parts)
    const alongX = sx >= sz;
    const len = alongX ? sx : sz;
    const across = alongX ? sz : sx;
    let n = Math.ceil(layer / max);
    while (n < len && Math.ceil(len / n) * across > max) n++;
    const w = Math.ceil(len / n);
    const part = Math.max(1, Math.floor(max / w));
    for (let y = b.max.y; y >= b.min.y; y--) {
      for (let a = 0; a < len; a += w) {
        for (let c = 0; c < across; c += part) {
          const a2 = Math.min(len, a + w) - 1;
          const c2 = Math.min(across, c + part) - 1;
          if (alongX) add({ x: b.min.x + a, y, z: b.min.z + c }, { x: b.min.x + a2, y, z: b.min.z + c2 });
          else add({ x: b.min.x + c, y, z: b.min.z + a }, { x: b.min.x + c2, y, z: b.min.z + a2 });
        }
      }
    }
  }
  const materials: Record<string, number> = spec.replace ? { [spec.replace.to]: sx * sy * sz } : {};
  return { sections, refused: [], box: { min: { ...b.min }, max: { ...b.max } }, cells: sx * sy * sz, materials };
}

/** Sections for any build kind. */
export function sectionsOf(spec: BuildSpec, start: Cell, max = SECTION_CELLS): Sectioned {
  return spec.kind === 'clear' || spec.kind === 'replace' ? boxSections(spec, max) : placeSections(spec, start, max);
}

/** How many cells a build has (to choose one plan or a job). */
export function buildCells(spec: BuildSpec): number {
  if (spec.kind === 'clear' || spec.kind === 'replace') {
    const b = spec.box;
    return b ? (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1) : 0;
  }
  return spec.places.length;
}

/** Scaffold blocks out in the world as sections that dig them: a clear of each run of them in a column. */
function cleanupSections(cells: readonly Cell[], label: string, floorY: number): JobSection[] {
  const cols = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.x},${c.z}`;
    let l = cols.get(k);
    if (!l) cols.set(k, (l = []));
    l.push(c);
  }
  const out: JobSection[] = [];
  for (const l of cols.values()) {
    l.sort((a, b) => a.y - b.y);
    for (let i = 0; i < l.length; ) {
      let j = i;
      while (j + 1 < l.length && l[j + 1]!.y === l[j]!.y + 1) j++;
      const box = { min: { ...l[i]! }, max: { ...l[j]! } };
      out.push({ spec: { kind: 'clear', label: `${label} [scaffold left]`, places: [], box }, area: sectionArea(box, Math.min(box.min.y, floorY)), cells: j - i + 1, items: new Map(), cleanup: true });
      i = j + 1;
    }
  }
  return out;
}

export class BuildJob implements BuildWork {
  /** The whole build: its spec, materials, refusals (no steps: each section's plan has them). */
  readonly plan: Plan;
  readonly sections: JobSection[];
  readonly box: { min: Cell; max: Cell };
  private readonly d: JobDeps;
  private readonly log: Logger;
  private index = 0;
  private runner: BuildRunner | undefined;
  /** The sections done: their stats. */
  private readonly agg = emptyStats();
  /** Done before this job started (a resume). */
  readonly base: number;
  private running = false;
  private epoch = 0;
  /** Sections whose start asked for a restock already. */
  private prechecked = -1;
  /** Track B10: cells of the build dug to get out and not placed again yet, and the [again] sections made for them. */
  private readonly undone = new Map<string, Cell>();
  private undoneRounds = 0;
  /** A fetch round ran: walk back first. */
  private back = false;
  /** Cells someone changed since a resumed build did them: left (clear, replace). */
  private readonly left = new Set<string>();
  /** The wrong states with what they should be (read again at the end). */
  private readonly wants = new Map<string, Record<string, unknown>>();
  /** Sections of scaffold blocks a stopped run left (the first sections). */
  private readonly leftovers: JobSection[];
  /** Track B8: the end's scaffold cleanup added (once). */
  private cleaned = false;
  /** The column under the feet at the start came down (run()). */
  private down = false;
  /** The runner of that descend while it runs (paused with the job). */
  private side: BuildRunner | undefined;
  rounds = 0;
  planMs = 0;
  /** Steps of the plans in all (stats). */
  steps = 0;

  constructor(spec: BuildSpec, start: Cell, d: JobDeps, o: { max?: number; survey?: Survey; left?: Iterable<Cell>; leftovers?: readonly Cell[] } = {}) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    const s = sectionsOf(spec, start, o.max);
    this.sections = s.sections;
    // scaffold blocks a stopped run left: their columns dug first (each a clear of its own), the one under the feet by run()
    const cleanup = cleanupSections(o.leftovers ?? [], spec.label, s.box.min.y);
    this.leftovers = cleanup;
    this.sections.unshift(...cleanup);
    this.box = s.box;
    this.base = o.survey?.done ?? 0;
    for (const c of o.left ?? []) this.left.add(key(c));
    const done = (c: Cell) => d.progress?.has(c) === true;
    if (spec.kind === 'clear' || spec.kind === 'replace') {
      // what there is to dig or replace: read from the world (a section's estimate until it is planned)
      let all = 0;
      for (const sec of this.sections) {
        if (sec.cleanup) continue;
        const b = sec.spec.box!;
        let n = 0;
        for (let y = b.min.y; y <= b.max.y; y++) {
          for (let x = b.min.x; x <= b.max.x; x++) {
            for (let z = b.min.z; z <= b.max.z; z++) {
              const c = { x, y, z };
              const w = d.world.blockAt(c);
              if (!w || done(c)) continue;
              if (spec.kind === 'clear' ? !isAirName(w.name) && w.boxes.length > 0 : blockId(w.name) === spec.replace?.from) n++;
            }
          }
        }
        sec.cells = n;
        if (spec.replace) sec.items = new Map(n ? [[spec.replace.to, n]] : []);
        all += n;
      }
      s.cells = all + this.base;
      if (spec.replace) s.materials = all ? { [spec.replace.to]: all } : {};
    } else if (d.progress) {
      const placed: BuildBlock[] = [];
      for (const sec of this.sections) {
        if (sec.cleanup) continue;
        const mine = sec.spec.places.filter((p) => done(p.pos));
        sec.cells -= mine.length;
        placed.push(...mine);
      }
      // Track B7 (decision 0132): what was placed before is not in the bill again (a resume of a map art fed with its
      // exact bill was refused: `cannot get 47 black_wool`, the 56 blocks placed counted as still needed)
      if (placed.length) {
        const m = { ...s.materials };
        for (const [k, v] of itemsOf(resolveBlocks(placed).cells)) {
          m[k] = (m[k] ?? 0) - v;
          if (m[k] <= 0) delete m[k];
        }
        s.materials = m;
      }
    }
    this.plan = { spec, steps: [], work: s.cells, already: 0, occupied: 0, skipped: [], scaffolds: 0, scaffoldPeak: 0, materials: s.materials, ms: 0, ...(s.refused.length ? { refused: s.refused } : {}), ...(d.options.safeEdge !== undefined ? { safeEdge: d.options.safeEdge } : {}) };
  }

  get busy(): boolean {
    return this.running;
  }

  /** The section running (1-based) and how many. */
  get at(): { section: number; of: number } {
    return { section: Math.min(this.index + 1, this.sections.length), of: this.sections.length };
  }

  get stats(): RunnerStats {
    const out = emptyStats();
    addStats(out, this.agg);
    if (this.runner) addStats(out, this.runner.stats);
    const k = this.plan.spec.kind;
    if (k === 'clear') out.dug += this.base;
    else if (k === 'replace') out.replaced += this.base;
    else out.placed += this.base;
    return out;
  }

  /** Work in all: what is done before, the planned sections' work, the cells of the sections not planned yet. */
  get total(): number {
    let n = this.base;
    for (const s of this.sections) if (!s.sweep && !s.cleanup) n += s.work ?? s.cells;
    return n;
  }

  private remainingCells(): number {
    let n = 0;
    for (let i = this.index; i < this.sections.length; i++) {
      const s = this.sections[i]!;
      if (s.sweep || s.cleanup) continue;
      if (i === this.index && this.runner) n += Math.max(0, this.runner.total - this.runner.stats.processed);
      else n += s.work ?? s.cells;
    }
    return n;
  }

  etaS(): number | undefined {
    const s = this.stats;
    if (s.processed === 0 || s.activeMs <= 0) return undefined;
    return (this.remainingCells() * s.activeMs) / s.processed / 1000;
  }

  rate(): number | undefined {
    const s = this.stats;
    return s.activeMs > 0 && s.processed > 0 ? (s.processed * 60_000) / s.activeMs : undefined;
  }

  detail(): string {
    const a = this.at;
    return `section ${a.section} of ${a.of}${this.rounds ? `, ${this.rounds} fetch round${this.rounds === 1 ? '' : 's'}` : ''}`;
  }

  pause(): void {
    this.epoch++;
    this.runner?.pause();
    this.side?.pause();
    if (!this.runner && !this.side) this.d.cancel?.(); // Track B4
  }

  perched(): boolean {
    return this.runner?.perched() ?? false;
  }

  /**
   * What the next fetch round should bring: what the running section has left to place, as long as it fits in `slots`
   * stacks (`stack` = an item's stack size; Track B9: what is had of an item, carried or boxed, costs no slot: it is
   * there already), and the scaffold blocks the section needs at once; first the scaffold tool when none carried digs
   * the scaffold blocks (BuildRunner.remainingNeed). The bill counts what is carried and boxed against it.
   * Track B9 (decision 0134): only the running section: the sections after it come in rounds of their own (a round that
   * gathered them too crafted their planks, slabs and stairs ahead, four slots of planks for each slot of logs, and the
   * inventory and the boxes were full before the first block of the house went down).
   * Track B10 (decision 0135): the section's cells in build order until `slots` runs out (the free slots and the carried
   * boxes' room, with the slots of build items carried counted as taken), one slot more for each kind not had; a round
   * with no room at all still asks one stack of the next kind.
   */
  roundNeed(slots: number, stack: (item: string) => number): Pick<Plan, 'materials' | 'scaffoldPeak'> {
    const out: Record<string, number> = {};
    let used = 0;
    // Track B10 (decision 0135): a kind not had keeps one slot more (the stack a craft or a take passes through)
    const kept = new Set<string>();
    const add = (it: string, n: number, force = false): number => {
      const st = Math.max(1, stack(it));
      const held = Math.max(0, this.d.have?.(it) ?? 0);
      const cost = (m: number) => Math.ceil(Math.max(0, m - held) / st);
      const cur = out[it] ?? 0;
      const keep = !kept.has(it) && cur + n > held ? 1 : 0;
      const room = force ? st + held - cur : (slots - used - keep + cost(cur)) * st + held - cur;
      const a = Math.min(n, Math.max(0, room));
      if (a <= 0) return 0;
      used += cost(cur + a) - cost(cur) + (cur + a > held ? keep : 0);
      if (cur + a > held) kept.add(it);
      out[it] = cur + a;
      return a;
    };
    const now = this.runner?.remainingNeed();
    // the scaffold tool first (it broke; one slot each), when the round can get it
    const tool = now?.tool;
    if (tool && (this.d.canFetch?.([tool.item]) ?? false)) {
      out[tool.item] = tool.n;
      used += tool.n;
    }
    let scaffolds = Math.max(now?.scaffolds ?? 0, 16);
    // Track B10 (decision 0135): the cells in build order until the room runs out (on the Realm a round sized to the
    // whole section asked about 25 kinds, thousands of blocks, of a kit leaving about 15 slots, and stuck on a bring)
    const seq = now?.seq ?? [...(this.sections[this.index]?.items ?? new Map<string, number>())].map(([item, n]) => ({ item, n }));
    let got = false;
    let short: string | undefined;
    for (const e of seq) {
      const a = add(e.item, e.n);
      if (a > 0 && (out[e.item] ?? 0) > Math.max(0, this.d.have?.(e.item) ?? 0)) got = true;
      if (a < e.n) {
        short = e.item;
        break;
      }
    }
    // a short round is fine, a stuck one is not: with no room at all it still asks one stack of the next kind (the
    // fetch makes room for it, or says why it cannot)
    // (no stack is filled up from later cells: what a round brings is the prefix the runner places before it runs out
    // again, so nothing of it is left over to fill the boxes; filled up, a test kit of 17 slots stuck in round 8)
    if (short !== undefined && !got && !tool) add(short, (now?.items ?? this.sections[this.index]?.items)?.get(short) ?? 1, true);
    if (!this.runner && this.sections[this.index]) scaffolds = Math.max(scaffolds, 24);
    return { materials: out, scaffoldPeak: scaffolds };
  }

  /** Items of the running section not had now (a fetch round before it starts). */
  private shortAtStart(plan: Plan): string[] {
    if (!this.d.have) return [];
    const short = Object.entries(plan.materials)
      .filter(([it]) => this.d.have!(it) <= 0)
      .map(([it]) => it);
    if (plan.scaffoldPeak > 0 && (this.d.scaffoldHave?.() ?? Infinity) < plan.scaffoldPeak) short.push('cobblestone');
    return short;
  }

  async run(): Promise<RunnerEnd> {
    if (this.running) return { state: 'stopped', reason: 'already running' };
    const epoch = ++this.epoch;
    this.running = true;
    try {
      if (!this.down && this.leftovers.length) {
        const end = await this.offColumn();
        if (epoch !== this.epoch) return { state: 'paused' };
        if (end.state !== 'done') return end;
        this.down = true;
      }
      // Track B4: the boxes left in the world first (off the column: no box is picked up from up there)
      if (this.d.boxesFirst) {
        await this.d.boxesFirst(() => epoch !== this.epoch);
        if (epoch !== this.epoch) return { state: 'paused' };
      }
      for (;;) {
        if (epoch !== this.epoch) return { state: 'paused' };
        if (!this.runner) {
          if (this.index >= this.sections.length && !this.addSweep() && !this.addCleanup()) break;
          const s = this.sections[this.index]!;
          await this.nearSection(s);
          if (epoch !== this.epoch) return { state: 'paused' };
          const plan = await this.planSection(s);
          if (!plan) {
            this.index++;
            continue;
          }
          if (plan.steps.length === 0) {
            s.ran = true;
            this.index++;
            continue;
          }
          const p = this.d.progress;
          this.runner = this.d.runner(plan, {
            ...(this.d.canFetch ? { fetchMore: (items: readonly string[]) => this.d.canFetch!(items) } : {}),
            // a left scaffold block dug is no longer out; a target cell done is marked
            cellDone: s.cleanup
              ? (c) => p?.scaffold(c, false)
              : (c) => {
                  p?.mark(c);
                  this.undone.delete(key(c));
                },
            // Track B10 (decision 0135): a cell dug to get out is not done any more (placed again after the section)
            cellUndone: (c) => {
              p?.unmark(c);
              this.undone.set(key(c), c);
            },
            scaffoldAt: (c, up) => p?.scaffold(c, up),
            avoid: (c) => this.isBuildCell(c), // Track B4: no box on any cell of the build
          });
          if (epoch !== this.epoch) return { state: 'paused' };
        }
        if (this.prechecked !== this.index) {
          this.prechecked = this.index;
          const short = this.shortAtStart(this.runner.plan);
          if (short.length && this.d.canFetch?.(short)) return { state: 'restock', items: short };
        }
        if (this.back) {
          this.back = false;
          await this.walkBack();
          this.runner.reload(); // Track B4: what the round made or left in the boxes comes out for the stretch ahead
          if (epoch !== this.epoch) return { state: 'paused' };
        }
        const end = await this.runner.run();
        if (end.state === 'paused') return end;
        if (end.state === 'restock') return end;
        const ran = this.sections[this.index];
        const skippedNow = ran && !ran.sweep && !ran.cleanup && !ran.again ? [...this.runner.stats.skipped] : [];
        this.close();
        if (end.state === 'stopped') {
          this.d.progress?.flush();
          return end;
        }
        this.index++;
        // Track B10: with the cells dug to get out that no runner placed again (another section's), at most UNDONE_ROUNDS
        const undone = this.undoneRounds < UNDONE_ROUNDS ? [...this.undone.values()].filter((c) => !this.d.progress?.has(c) && !skippedNow.some((k) => key(k.pos) === key(c))) : [];
        this.undone.clear();
        if (undone.length) this.undoneRounds++;
        const again = [...skippedNow, ...undone.map((pos) => ({ pos, reason: 'dug to get out' }))];
        if (again.length) this.tryAgain(again);
        this.d.progress?.flush();
      }
      this.recheck();
      return { state: 'done' };
    } finally {
      this.running = false;
    }
  }

  /**
   * Track B4 (decision 0129): a cell of the whole build (every section's, done or not; a clear or replace: its box), where
   * no shulker box is set down.
   */
  isBuildCell(c: Cell): boolean {
    const b = this.plan.spec.box;
    if (this.plan.spec.kind === 'clear' || this.plan.spec.kind === 'replace') return !!b && c.x >= b.min.x && c.x <= b.max.x && c.y >= b.min.y && c.y <= b.max.y && c.z >= b.min.z && c.z <= b.max.z;
    this.cellKeys ??= new Set(this.plan.spec.places.map((p) => key(p.pos)));
    return this.cellKeys.has(key(c));
  }

  private cellKeys: Set<string> | undefined;

  /** Track B4: no box here: a cell of the build, or a scaffold or a planned stand of the running section. */
  noBox(c: Cell): boolean {
    return this.isBuildCell(c) || (this.runner?.boxBanned(c) ?? false);
  }

  /** A fetch round ran: walk back before going on. */
  roundDone(): void {
    this.rounds++;
    this.back = true;
  }

  /** The round failed: the running section's scaffold blocks down, as a stop would (paused when pre-empted). */
  async cleanup(reason: string): Promise<RunnerEnd> {
    const r = this.runner;
    if (!r) return { state: 'stopped', reason };
    const end = await r.cleanup(reason);
    if (end.state !== 'paused') this.close();
    return end;
  }

  /** A work that only runs cleanup (a process of its own: the body moves). */
  cleaner(reason: string): BuildWork {
    return cleanerWork(this, () => this.cleanup(reason));
  }

  scaffoldsOut(): number {
    return this.runner?.scaffoldsOut() ?? 0;
  }

  /**
   * A restart left the bot on a scaffold column of the run before: it digs that column down under its feet first (a
   * plan of one descend step), before any section is planned from up there.
   */
  private async offColumn(): Promise<RunnerEnd> {
    const p = this.d.position();
    if (!p) return { state: 'done' };
    const f = { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) };
    const i = this.leftovers.findIndex((s) => s.spec.box!.min.x === f.x && s.spec.box!.min.z === f.z && s.spec.box!.max.y === f.y - 1);
    if (i < 0) return { state: 'done' };
    const sec = this.leftovers[i]!;
    const box = sec.spec.box!;
    const height = box.max.y - box.min.y + 1;
    this.log.info(`build: on a scaffold column left by the run before (${height} high): digging down first`);
    const plan: Plan = { spec: sec.spec, steps: [{ op: 'descend', base: { ...box.min }, height }], work: 0, already: 0, occupied: 0, skipped: [], scaffolds: 0, scaffoldPeak: 0, materials: {}, ms: 0 };
    const r = this.d.runner(plan, {});
    this.side = r;
    let end: RunnerEnd;
    try {
      end = await r.run();
    } finally {
      this.side = undefined;
    }
    if (end.state === 'done') {
      for (let y = box.min.y; y <= box.max.y; y++) {
        const c = { x: box.min.x, y, z: box.min.z };
        const b = this.d.world.blockAt(c);
        if (!b || b.boxes.length === 0) this.d.progress?.scaffold(c, false);
      }
      sec.ran = true;
      sec.work = 0;
      // its section has nothing left to dig
      sec.cells = 0;
      this.sections.splice(this.sections.indexOf(sec), 1);
      this.leftovers.splice(i, 1);
    }
    return end;
  }

  private close(): void {
    const r = this.runner;
    if (!r) return;
    const sec0 = this.sections[this.index];
    // a left scaffold dug is not the build's work: its time counts, its digs do not
    addStats(this.agg, sec0?.cleanup ? { ...r.stats, dug: 0, processed: 0, skipped: [] } : r.stats);
    for (const w of r.stats.wrong ?? []) {
      const s = r.plan.steps.find((x) => x.op === 'place' && key(x.pos) === key(w.pos));
      if (s?.op === 'place' && s.pl) this.wants.set(key(w.pos), { ...s.pl.final, ...s.pl.derived });
    }
    this.steps += r.plan.steps.length;
    this.plan.scaffolds += r.plan.scaffolds;
    this.plan.scaffoldPeak = Math.max(this.plan.scaffoldPeak, r.plan.scaffoldPeak);
    const sec = this.sections[this.index];
    if (sec) sec.ran = true;
    this.runner = undefined;
  }

  private async planSection(s: JobSection): Promise<Plan | undefined> {
    const start = this.d.position() ?? s.area.min;
    const t0 = performance.now();
    const skip = this.left.size && (s.spec.kind === 'clear' || s.spec.kind === 'replace') ? (c: Cell) => this.left.has(key(c)) : undefined;
    try {
      // Track B8 (decision 0133): a valley map art is planned free (a stand places every ready cell it reaches)
      const free = this.plan.spec.free ? { free: true } : {};
      // and its columns as high as the art needs (over buildColumnMax when that is lower)
      const col = this.plan.spec.column;
      const column = col && col > (this.d.options.maxColumn ?? 6) ? { maxColumn: col } : {};
      const plan = await this.d.plan(s.spec, { ...this.d.options, ...free, ...column, start: { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) }, area: s.area, ...(skip ? { skip } : {}) });
      this.planMs += performance.now() - t0;
      s.work = plan.work;
      if (s.cleanup) {
        this.log.info(`build: scaffold left by the run before at ${s.spec.box!.min.x} ${s.spec.box!.min.y} ${s.spec.box!.min.z} (${s.cells} high): ${plan.work} to dig, ${plan.skipped.length} out of reach`);
        return plan;
      }
      this.plan.already += plan.already;
      this.plan.occupied += plan.occupied;
      this.plan.left = (this.plan.left ?? 0) + (plan.left ?? 0);
      if (plan.skipped.length) this.agg.skipped.push(...plan.skipped);
      if (plan.unmade?.length) (this.plan.unmade ??= []).push(...plan.unmade);
      this.plan.stateful = (this.plan.stateful ?? 0) + (plan.stateful ?? 0);
      this.plan.turned = (this.plan.turned ?? 0) + (plan.turned ?? 0);
      this.plan.ms += plan.ms;
      this.log.info(`build: section ${this.index + 1} of ${this.sections.length} (${s.cells} cells${s.sweep ? ', the sweep' : s.late ? ', the last blocks' : ''}): ${plan.work} to do, ${plan.already} already, ${plan.skipped.length} skipped, ${plan.scaffolds} scaffolds (peak ${plan.scaffoldPeak}), ${plan.steps.length} steps in ${(performance.now() - t0).toFixed(0)} ms`);
      return plan;
    } catch (e) {
      // a section that cannot be planned is skipped whole (the rest goes on)
      this.log.warn(`build: section ${this.index + 1} of ${this.sections.length} not planned: ${e instanceof Error ? e.message : String(e)}`);
      s.work = 0;
      this.agg.skipped.push({ pos: s.area.min, reason: `section ${this.index + 1} not planned` });
      return undefined;
    }
  }

  /**
   * Track B9 (decision 0134): the cells a section skipped as it ran (its plan's own skips wait for the sweep), planned
   * once more right after it, before the next section: a later section stands on them. Four ceiling cells a run skipped
   * (`no stand in reach`, the scaffold for them unreachable) left a hole beside the stairs' top, and the section over
   * that ceiling planned 413 of its 3 222 cells skipped instead of 122.
   */
  private tryAgain(skipped: readonly { pos: Cell; reason: string }[]): void {
    const spec = this.plan.spec;
    if (spec.kind === 'clear' || spec.kind === 'replace') return;
    const keys = new Set(skipped.map((s) => key(s.pos)));
    const blocks = spec.places.filter((p) => keys.has(key(p.pos)) && !this.d.progress?.has(p.pos));
    const b = boxOf(blocks.map((p) => p.pos));
    if (!b) return;
    const done = new Set(blocks.map((p) => key(p.pos)));
    this.agg.skipped = this.agg.skipped.filter((s) => !done.has(key(s.pos)));
    this.log.info(`build: one more try for the ${blocks.length} cell${blocks.length === 1 ? '' : 's'} section ${this.index} skipped, before the next`);
    this.sections.splice(this.index, 0, { spec: { kind: spec.kind, label: `${spec.label} [again]`, places: blocks }, area: sectionArea(b, this.box.min.y), cells: blocks.length, items: new Map(), again: true });
  }

  /** One more try for the cells the sections skipped (once): sections of their own. False when there is nothing to try. */
  private addSweep(): boolean {
    if (this.sections.some((s) => s.sweep)) return false;
    const retry = this.agg.skipped.filter((s) => !s.reason.endsWith('not planned'));
    if (retry.length === 0) return false;
    const spec = this.plan.spec;
    const keys = new Set(retry.map((s) => key(s.pos)));
    const added: JobSection[] = [];
    if (spec.kind === 'clear' || spec.kind === 'replace') {
      const b = boxOf(retry.map((s) => s.pos))!;
      for (let y = b.max.y; y >= b.min.y; y--) {
        const layer = { min: { ...b.min, y }, max: { ...b.max, y } };
        const n = retry.filter((s) => s.pos.y === y).length;
        if (n) added.push({ spec: { ...spec, label: `${spec.label} [sweep]`, places: [], box: layer }, area: sectionArea(layer, spec.box?.min.y ?? b.min.y), cells: n, items: new Map(), sweep: true });
      }
    } else {
      const blocks = spec.places.filter((p) => keys.has(key(p.pos)));
      const b = boxOf(blocks.map((p) => p.pos));
      if (!b) return false;
      // Track B7: a sparse build's sweep in tiles too (one section over the whole footprint plans for minutes)
      const parts = sparseBuild(this.plan.work, this.box) ? tiles(blocks, this.box, this.d.position() ?? b.min, SECTION_CELLS) : Array.from({ length: Math.ceil(blocks.length / SECTION_CELLS) }, (_, i) => blocks.slice(i * SECTION_CELLS, (i + 1) * SECTION_CELLS));
      for (const part of parts) {
        added.push({ spec: { kind: spec.kind, label: `${spec.label} [sweep]`, places: part }, area: sectionArea(boxOf(part.map((p) => p.pos))!, this.box.min.y), cells: part.length, items: new Map(), sweep: true });
      }
    }
    if (!added.length) return false;
    // what the sweep does not do again stays skipped (its runner lists it)
    this.agg.skipped = this.agg.skipped.filter((s) => !keys.has(key(s.pos)) || s.reason.endsWith('not planned'));
    this.log.info(`build: one more try for ${retry.length} skipped cell${retry.length === 1 ? '' : 's'}`);
    this.sections.push(...added);
    return true;
  }

  /**
   * Track B8 (decision 0133): at the end of a free (map art) build, the scaffold blocks the progress still has out in the
   * world (a section left them out of reach) are dug by sections of their own, once: none stays to show on the map.
   */
  private addCleanup(): boolean {
    if (!this.plan.spec.free || this.cleaned || !this.d.progress) return false;
    this.cleaned = true;
    const out = this.d.progress.scaffoldCells().filter((c) => {
      const b = this.d.world.blockAt(c);
      return b !== undefined && THROWAWAY_BLOCKS.includes(blockId(b.name));
    });
    if (!out.length) return false;
    this.log.info(`build: ${out.length} scaffold block${out.length === 1 ? '' : 's'} left in the world: dug at the end`);
    this.sections.push(...cleanupSections(out, this.plan.spec.label, this.box.min.y));
    return true;
  }

  /** States that follow the neighbours read again at the end: a fence beside a later section is right by now. */
  private recheck(): void {
    if (!this.agg.wrong?.length) return;
    this.agg.wrong = this.agg.wrong.filter((w) => {
      const want = this.wants.get(key(w.pos));
      const now = this.d.world.blockAt(w.pos);
      if (!want || !now || !sameBlock(w.name, now.name)) return true;
      const diff = stateDiff(want, now.states);
      if (diff.length === 0) return false;
      w.diff = diff;
      return true;
    });
  }

  /** Far from a section before planning it (a resume after a restart elsewhere): walk near it first. */
  private async nearSection(s: JobSection): Promise<void> {
    const me = this.d.position();
    if (!this.d.approach || !me) return;
    const b = s.spec.box ?? boxOf(s.spec.places.map((p) => p.pos));
    if (!b) return;
    const to = { x: Math.max(b.min.x, Math.min(b.max.x, Math.floor(me.x))), y: b.min.y, z: Math.max(b.min.z, Math.min(b.max.z, Math.floor(me.z))) };
    if (Math.hypot(me.x - to.x, me.z - to.z) <= BACK_FAR) return;
    this.log.info(`build: walking to section ${this.index + 1} of ${this.sections.length} (${Math.round(Math.hypot(me.x - to.x, me.z - to.z))} blocks away)`);
    await this.d.approach(to);
  }

  private async walkBack(): Promise<void> {
    if (!this.d.approach || !this.runner) return;
    const me = this.d.position();
    const to = this.runner.nextPlace() ?? this.sections[this.index]?.area.min;
    if (!me || !to || Math.hypot(me.x - to.x, me.z - to.z) <= BACK_FAR) return;
    this.log.info(`build: back to the build (section ${this.index + 1} of ${this.sections.length})`);
    await this.d.approach(to);
  }

  /**
   * A resume: each cell the saved progress marks done is checked against the world. A place cell still holding its
   * block stays done; one that is air now is placed again (unmarked); another block is left and reported. A dug cell
   * (clear) not air now is left and reported, as is a replaced cell that holds something else.
   */
  static survey(spec: BuildSpec, world: BlockReader, progress: BuildProgress): { survey: Survey; left: Cell[]; leftovers: Cell[] } {
    const out: Survey = { done: 0, air: 0, other: 0, examples: [], leftovers: 0, found: 0 };
    const left: Cell[] = [];
    // the scaffold blocks the run before left out: those still a throwaway block are dug first, the rest forgotten
    const leftovers: Cell[] = [];
    for (const c of progress.scaffoldCells()) {
      const b = world.blockAt(c);
      if (b && THROWAWAY_BLOCKS.includes(blockId(b.name))) leftovers.push(c);
      else if (b) progress.scaffold(c, false);
    }
    out.leftovers = leftovers.length;
    const note = (pos: Cell, name: string) => {
      if (out.examples.length < 3) out.examples.push({ pos, name });
    };
    const cells = [...progress.cells()];
    if (spec.kind === 'clear' || spec.kind === 'replace') {
      for (const c of cells) {
        const b = world.blockAt(c);
        if (!b) {
          out.done++;
          continue;
        }
        const ok = spec.kind === 'clear' ? isAirName(b.name) || b.boxes.length === 0 : blockId(b.name) === spec.replace?.to;
        if (ok) out.done++;
        else {
          out.other++;
          left.push(c);
          note(c, blockId(b.name));
        }
      }
      return { survey: out, left, leftovers };
    }
    const done = new Set(cells.map(key));
    const mine = spec.places.filter((p) => done.has(key(p.pos)));
    const resolved = resolveBlocks(mine);
    const want = new Map<string, Placement>();
    for (const r of resolved.cells) {
      want.set(key(r.block.pos), r.placement);
      for (const e of r.placement.extra) want.set(key({ x: r.block.pos.x + e.offset.x, y: r.block.pos.y + e.offset.y, z: r.block.pos.z + e.offset.z }), { ...r.placement, name: e.name, final: e.check });
    }
    for (const c of cells) {
      const b = world.blockAt(c);
      const pl = want.get(key(c));
      if (!b || !pl) {
        out.done++;
        continue;
      }
      if (sameBlock(pl.name, b.name) && statesMatch(pl.final, b.states)) out.done++;
      else if (isAirName(b.name) || b.boxes.length === 0) {
        out.air++;
        progress.unmark(c);
        note(c, 'air');
      } else {
        out.other++;
        left.push(c);
        note(c, blockId(b.name));
      }
    }
    // Track B9 (decision 0134): a cell not marked that already holds its block is done: a stop interrupts a placement
    // the server still makes (the item is gone, the cell never marked), and the bill then counted the block again
    // (`cannot get 1 cactus`: the dye for 1 green_wool, on the resume of a house the boxes held exactly)
    const rest = resolveBlocks(spec.places.filter((p) => !done.has(key(p.pos))));
    for (const r of rest.cells) {
      const b = world.blockAt(r.block.pos);
      if (!b || !sameBlock(r.placement.name, b.name) || !statesMatch(r.placement.final, b.states)) continue;
      if (r.placement.extra.some((e) => {
        const eb = world.blockAt({ x: r.block.pos.x + e.offset.x, y: r.block.pos.y + e.offset.y, z: r.block.pos.z + e.offset.z });
        return !eb || !sameBlock(e.name, eb.name) || !statesMatch(e.check, eb.states);
      })) continue;
      progress.mark(r.block.pos);
      out.done++;
      out.found++;
    }
    return { survey: out, left, leftovers };
  }
}
