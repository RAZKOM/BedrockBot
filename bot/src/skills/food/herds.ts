// Remembered herds (Track AF, wave 8; docs/food.md "Herd memory"). Every passive food mob the entity
// tracker shows is recorded as a herd mark of the world cache (world/cache/herds.ts), merged per
// 16-block cell (chunk column): mean position, adults and babies of each kind, wild or penned, time.
// `observe()` runs once a second (commands-food.ts); it rewrites the marks of every cell that holds
// tracked mobs, and drops the mark of a cell the bot stands within `CLEAR_RADIUS` (32) blocks of
// when the tracker has shown no food mob there for 2.5 s ("got there and found nothing").
//
// The food job (tasks/process/food.ts) asks `next()` for the nearest mark within `HERD_RANGE` (200)
// blocks that is worth the walk: a kind with more than `foodLeave` wild adults, or a penned kind the
// hunt may take (the `chorePen` pen, or `!food n pen`) with more than PEN_KEEP adults.
import type { HerdCounts, HerdMark, HerdMarkStore } from '../../world/cache/herds.ts';
import { HerdMarks } from '../../world/cache/herds.ts';
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import { entityFeet, isPlayerEntity } from '../combat/hostiles.ts';
import { foodKindOf } from './finder.ts';
import { PEN_KEEP, type Pen } from './pen.ts';

/** Herd marks are followed up to this far (horizontal blocks from the bot). */
export const HERD_RANGE = 200;
/** Standing this close to a mark with no food mob in the cell drops it (the tracker keeps cows up to 81 blocks: measured). */
export const CLEAR_RADIUS = 32;
/** ... for this long (ms) in a row. */
export const EMPTY_MS = 2500;
/** The entity tracker shows every mob this close (measured on BDS: cows stay tracked up to 81 blocks); marks of empty cells this close are not followed. */
export const TRACKED = 32;

export interface HerdMemoryDeps {
  entities: () => ReadonlyMap<bigint, EntityInfo>;
  isBaby(rid: bigint): boolean;
  isDead?(rid: bigint): boolean;
  /** The bot's feet. */
  position(): Vec3 | undefined;
  /** The persistent store (World.cache.herds), read at call time; an in-memory one without it. */
  store?: () => HerdMarkStore | undefined;
  penOf?(e: EntityInfo): Pen | undefined;
  /** Wall clock (ms) for the marks' `at`. Default Date.now. */
  clock?: () => number;
  /** Monotonic ms (the empty-cell timer). Default performance.now. */
  now?: () => number;
}

export interface HerdWanted {
  /** Wild adults to leave per kind (`foodLeave`). */
  leave: number;
  /** May penned animals of this mark's cell be taken? */
  penAllowed?(m: HerdMark, kind: string): boolean;
  /** Cells to skip (`cx,cz`): already visited by this job. */
  skip?: ReadonlySet<string>;
  kinds?: readonly string[];
}

export const cellKey = (cx: number, cz: number): string => `${cx},${cz}`;

const add = (rec: Record<string, HerdCounts>, kind: string, baby: boolean): void => {
  const c = (rec[kind] ??= { adults: 0, babies: 0 });
  if (baby) c.babies++;
  else c.adults++;
};

/** `cow 4+1 baby` style list of a counts record. */
export function countsLine(rec: Record<string, HerdCounts>): string {
  return Object.entries(rec)
    .map(([k, c]) => `${k} ${c.adults}${c.babies ? `+${c.babies} ${c.babies === 1 ? 'baby' : 'babies'}` : ''}`)
    .join(', ');
}

/** What a mark offers the hunt: kinds with more than `leave` wild adults or an allowed pen above PEN_KEEP. */
export function markOffers(m: HerdMark, w: HerdWanted): string[] {
  const out: string[] = [];
  for (const [k, c] of Object.entries(m.wild)) if ((!w.kinds || w.kinds.includes(k)) && c.adults > w.leave) out.push(k);
  for (const [k, c] of Object.entries(m.penned)) if ((!w.kinds || w.kinds.includes(k)) && c.adults > PEN_KEEP && w.penAllowed?.(m, k) && !out.includes(k)) out.push(k);
  return out;
}

export class HerdMemory {
  private readonly d: HerdMemoryDeps;
  private readonly local = new HerdMarks();
  private readonly clock: () => number;
  /** Cells near the bot seen empty: since when (performance.now()). */
  private readonly emptySince = new Map<string, number>();
  /** Observation passes, marks written, marks cleared, ms spent (status, measurements). */
  readonly stats = { passes: 0, written: 0, cleared: 0, ms: 0, maxMs: 0 };

  constructor(d: HerdMemoryDeps) {
    this.d = d;
    this.clock = d.clock ?? (() => Date.now());
  }

  get store(): HerdMarkStore {
    return this.d.store?.() ?? this.local;
  }

  /** One pass over the entity tracker (call about once a second). Returns the cells written. */
  observe(): number {
    const t0 = performance.now();
    const me = this.d.position();
    const groups = new Map<string, { cx: number; cz: number; sx: number; sy: number; sz: number; n: number; wild: Record<string, HerdCounts>; penned: Record<string, HerdCounts> }>();
    for (const e of this.d.entities().values()) {
      if (isPlayerEntity(e)) continue;
      const kind = foodKindOf(e.type);
      if (!kind || this.d.isDead?.(e.runtimeId)) continue;
      const f = entityFeet(e);
      const cx = Math.floor(f.x) >> 4;
      const cz = Math.floor(f.z) >> 4;
      const k = cellKey(cx, cz);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { cx, cz, sx: 0, sy: 0, sz: 0, n: 0, wild: {}, penned: {} }));
      g.sx += f.x;
      g.sy += f.y;
      g.sz += f.z;
      g.n++;
      add(this.d.penOf?.(e) ? g.penned : g.wild, kind, this.d.isBaby(e.runtimeId));
    }
    const store = this.store;
    const at = this.clock();
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    for (const g of groups.values()) {
      store.set({ cx: g.cx, cz: g.cz, x: r1(g.sx / g.n), y: r1(g.sy / g.n), z: r1(g.sz / g.n), wild: g.wild, penned: g.penned, at });
      this.stats.written++;
    }
    if (me) {
      // a cell near the bot without food mobs for EMPTY_MS (the tracker may lag a moment after an arrival)
      const now = this.d.now?.() ?? performance.now();
      const near = new Set<string>();
      for (const m of store.near(me, CLEAR_RADIUS)) {
        const k = cellKey(m.cx, m.cz);
        if (groups.has(k)) continue;
        near.add(k);
        const since = this.emptySince.get(k) ?? now;
        this.emptySince.set(k, since);
        if (now - since < EMPTY_MS) continue;
        store.clear(m.cx, m.cz);
        this.emptySince.delete(k);
        this.stats.cleared++;
      }
      for (const k of [...this.emptySince.keys()]) if (!near.has(k)) this.emptySince.delete(k);
    }
    const ms = performance.now() - t0;
    this.stats.passes++;
    this.stats.ms += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    return groups.size;
  }

  /** The nearest mark within `range` of `from` that offers something (see `markOffers`). */
  next(from: Vec3, w: HerdWanted, range = HERD_RANGE): HerdMark | undefined {
    let live: Set<string> | undefined;
    for (const m of this.store.near(from, range)) {
      if (w.skip?.has(cellKey(m.cx, m.cz))) continue;
      if (markOffers(m, w).length === 0) continue;
      // within TRACKED blocks the tracker sees every mob: a mark of an empty cell there is stale (not worth a walk)
      if (Math.hypot(m.x - from.x, m.z - from.z) <= TRACKED) {
        live ??= this.liveCells();
        if (!live.has(cellKey(m.cx, m.cz))) continue;
      }
      return m;
    }
    return undefined;
  }

  /** Cells holding a live food mob in the tracker now. */
  liveCells(): Set<string> {
    const out = new Set<string>();
    for (const e of this.d.entities().values()) {
      if (isPlayerEntity(e) || !foodKindOf(e.type) || this.d.isDead?.(e.runtimeId)) continue;
      const f = entityFeet(e);
      out.add(cellKey(Math.floor(f.x) >> 4, Math.floor(f.z) >> 4));
    }
    return out;
  }

  /** Marks within `range` (status). */
  near(from: Vec3, range = HERD_RANGE): HerdMark[] {
    return this.store.near(from, range);
  }

  /** Drop the mark of a cell (nothing was there). */
  clear(cx: number, cz: number): boolean {
    const had = this.store.clear(cx, cz);
    if (had) this.stats.cleared++;
    return had;
  }
}
