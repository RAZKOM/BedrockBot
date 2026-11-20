// A starter farm set up from nothing (Track E6, docs/farming.md "A starter farm", ADR 0102): the work on the plot that
// `!farm new` chose (skills/farm/plot.ts), in phases a pause can stop and a resume goes on with (each phase looks at the
// world again, so a cell done before is not done twice):
//
//   seeds   grass broken round the plot (a 1 in 8 chance of wheat seeds each) and the drops picked up, until there is
//           a seed for every soil cell, none is left within SEED_RANGE, or SEED_MS have passed;
//   water   the empty bucket filled at still surface water (water.ts, Track E8: the pools seen round the plot, loaded or
//           remembered by the world cache, within WATER_SEEN; with none reached a bounded search walk), the middle cell
//           dug and the water poured into it; with no bucket or no water got the plot stays dry and the reply says why;
//   clear   the plants on the soil and over it dug (the hoe refuses a cell with anything on it);
//   till    each soil cell clicked with the best hoe carried (grass and dirt turn to farmland);
//   plant   the farmer's own loop (`!farm`, following the field) plants every empty farmland cell with the seeds carried;
//   fence   a fence on every free rim cell and a gate in the side facing home, placed from inside the plot.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import type { NavGoal } from '../nav/goals.ts';
import { closestDistance, type PlaceOptions, type PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import type { ClickResult } from './click.ts';
import { cropOf, FARMLAND } from './crops.ts';
import { HOES, type FarmOptions, type FarmState } from './farmer.ts';
import { clearCell, isWater, seedPlant, TILLABLE, type PlotSite } from './plot.ts';
import { searchLegs, surfaceSource, WATER_POOL_LINK, WATER_POOLS, WATER_SEARCH_MS, WATER_SEARCH_STEP, WATER_SEEN, waterPools, type WaterLookDeps, type WaterPool } from './water.ts';

/** Grass this far from the plot's middle (x, z; 6 up and down) is broken for seeds. */
export const SEED_RANGE = 24;
/** Track E8: with the grass within SEED_RANGE gone and time left, the seed step looks out to this. */
export const SEED_WIDE = 48;
/** The seed phase ends after this long (ms) with what it has. */
export const SEED_MS = 150_000;
/** Track E8: the farm chore's seed top-up breaks grass this far from the plot's middle (the set-up took the near grass). */
export const SEED_TOPUP_RANGE = 40;
/** Reach for a dig or a click, eye to the closest point of the block (the planning margin under the server's). */
const REACH = 4.4;

export type PlotPhase = 'seeds' | 'water' | 'clear' | 'till' | 'plant' | 'fence' | 'done';

export interface PlotJobDeps {
  world: {
    blockAt(p: Vec3): BlockInfo | undefined;
    find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }): Vec3[];
    readonly inventory: { count(name: string): number; readonly slots: readonly (ItemStack | null)[] };
    /** Track E8: the world cache's map layer (water remembered in columns not loaded now); undefined without a cache. */
    surfaceAt?: (x: number, z: number) => { name: string; y: number } | undefined;
  };
  skills: {
    goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
    dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
    place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
    collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  };
  /** Use the item on the block's top (ItemClicker.useOn): the hoe on soil, the empty bucket on water. */
  click(p: Vec3, item: string): Promise<ClickResult>;
  /** The farmer's loop (FarmTask): it plants the empty farmland. */
  farm: { start(o: FarmOptions): Promise<FarmState>; stop(): void; readonly stats: { planted: number } };
  /** Feet; undefined before the spawn. */
  position(): Vec3 | undefined;
  /** May this plant be broken for seeds (not inside the owner's base)? */
  mayDig?(p: Vec3): boolean;
  /** Wait so long (ms) for the server's word (the look again after a pour read as rejected); none: no second look. */
  wait?(ms: number): Promise<void>;
  now?: () => number;
  log?: Logger;
}

export interface PlotStats {
  grassBroken: number;
  seedsGot: number;
  covers: number;
  tilled: number;
  tillFailed: number;
  planted: number;
  fenced: number;
  fenceFailed: number;
  gate: boolean;
  water: 'already' | 'poured' | 'dry' | undefined;
  /** Track E8: where the water came from or why the plot is dry (`filled 34 off`, `no still water seen within 256; walked 412 looking`). */
  waterWhy: string | undefined;
  /** Track E8: blocks walked in the water step (straight lines between the goals), pools tried, and a pour that showed late. */
  waterWalked: number;
  poolsTried: number;
  pourLate: boolean;
  /** ms per phase. */
  ms: Partial<Record<PlotPhase, number>>;
}

const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/** The best hoe carried (the most durable kind first), or undefined. */
export function hoeCarried(count: (name: string) => number): string | undefined {
  return HOES.find((h) => count(h) > 0);
}

/** The fence and gate items for a planks kind (`oak` -> oak_fence, fence_gate on Bedrock; `spruce` -> spruce_fence_gate). */
export function fenceItems(kind: string): { fence: string; gate: string } {
  return { fence: `${kind}_fence`, gate: kind === 'oak' ? 'fence_gate' : `${kind}_fence_gate` };
}

/** Eye to the closest point of block `p`. */
function eyeDistOf(d: PlotJobDeps, p: Vec3): number {
  const f = d.position();
  if (!f) return Infinity;
  return closestDistance({ x: f.x, y: f.y + EYE_HEIGHT, z: f.z }, p);
}

/** Walk until `p` is within reach (a near goal), unless it is already. */
async function reachOf(d: PlotJobDeps, p: Vec3, r = 2.5): Promise<boolean> {
  if (eyeDistOf(d, p) <= REACH) return true;
  const f = d.position();
  const far = f ? Math.hypot(p.x + 0.5 - f.x, p.z + 0.5 - f.z) : 32;
  const w = await d.skills.goto({ type: 'near', p: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, r }, { timeoutTicks: Math.max(200, Math.ceil(far * 20)) });
  return w.ok || eyeDistOf(d, p) <= REACH;
}

/**
 * Break seed plants (seedPlant: grass, ferns) within `range` of `centre` (x, z; 6 up and down) and pick the drops up,
 * until `want` seeds are carried, none is left, or `until()`. From each stand every plant in reach is broken before
 * the walk to the next (Track E8: one walk a plant broke about 1.2 a second). False when cancelled.
 */
export async function breakForSeeds(
  d: PlotJobDeps,
  o: { centre: Vec3; range: number; want: number; until: () => boolean },
  cancelled: () => boolean,
  stats: { grassBroken: number },
): Promise<boolean> {
  const inv = d.world.inventory;
  const w = o.centre;
  const skip = new Set<string>();
  const inRange = (p: Vec3): boolean => Math.abs(p.x - w.x) <= o.range && Math.abs(p.z - w.z) <= o.range && Math.abs(p.y - w.y) <= 6;
  let since = 0;
  while (inv.count('wheat_seeds') < o.want && !o.until()) {
    if (cancelled()) return false;
    const me = d.position() ?? { x: w.x, y: w.y + 1, z: w.z };
    const g = d.world.find((b, p) => seedPlant(b) && inRange(p) && !skip.has(fmt(p)) && (d.mayDig?.(p) ?? true), { origin: me, radius: o.range * 2, max: 8 }).find(inRange);
    if (!g) break;
    skip.add(fmt(g));
    if (!(await reachOf(d, g, 2))) {
      if (cancelled()) return false;
      continue;
    }
    if (cancelled()) return false;
    const here = d.position() ?? me;
    const inReach = [
      g,
      ...d.world
        .find((b, p) => seedPlant(b) && inRange(p) && !skip.has(fmt(p)) && (d.mayDig?.(p) ?? true), { origin: { x: here.x, y: here.y + EYE_HEIGHT, z: here.z }, radius: REACH + 1, max: 24 })
        .filter((p) => eyeDistOf(d, p) <= REACH),
    ];
    for (const p of inReach) {
      if (inv.count('wheat_seeds') >= o.want || o.until()) break;
      skip.add(fmt(p));
      if (!seedPlant(d.world.blockAt(p))) continue;
      const r = await d.skills.dig(p);
      if (cancelled()) return false;
      if (r.ok) {
        stats.grassBroken++;
        since++;
      }
    }
    // the drops: picked up every few plants (they fall next to the body)
    if (since >= 6) {
      since = 0;
      await d.skills.collect(5, 40);
      if (cancelled()) return false;
    }
  }
  await d.skills.collect(6, 60);
  return !cancelled();
}

export class FarmPlotJob {
  readonly site: PlotSite;
  readonly phases: readonly PlotPhase[];
  private at = 0;
  readonly stats: PlotStats = { grassBroken: 0, seedsGot: 0, covers: 0, tilled: 0, tillFailed: 0, planted: 0, fenced: 0, fenceFailed: 0, gate: false, water: undefined, waterWhy: undefined, waterWalked: 0, poolsTried: 0, pourLate: false, ms: {} };
  /** The fence items (the fence phase); `more`: other woods' posts and gates to place once these run out (they join). */
  fence: { fence: string; gate: string; more?: readonly string[] } | undefined;
  /** Why the job ended short (`no hoe`, `no seeds`). */
  stop: string | undefined;
  private seedT0: number | undefined;

  constructor(site: PlotSite, phases: readonly PlotPhase[]) {
    this.site = site;
    this.phases = phases;
  }

  get phase(): PlotPhase {
    return this.phases[this.at] ?? 'done';
  }

  /** Run (or go on) until done or cancelled; true when over. */
  async run(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const now = d.now ?? (() => performance.now());
    while (this.phase !== 'done') {
      const ph = this.phase;
      const t0 = now();
      const over = await this.step(ph, d, cancelled);
      this.stats.ms[ph] = (this.stats.ms[ph] ?? 0) + (now() - t0);
      if (cancelled()) return false;
      if (!over) return false;
      if (this.stop) return true;
      this.at++;
    }
    return true;
  }

  private step(ph: PlotPhase, d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    switch (ph) {
      case 'seeds':
        return this.seeds(d, cancelled);
      case 'water':
        return this.water(d, cancelled);
      case 'clear':
        return this.clear(d, cancelled);
      case 'till':
        return this.till(d, cancelled);
      case 'plant':
        return this.plant(d, cancelled);
      case 'fence':
        return this.fenceRing(d, cancelled);
      default:
        return Promise.resolve(true);
    }
  }

  private eyeDist(d: PlotJobDeps, p: Vec3): number {
    return eyeDistOf(d, p);
  }

  /** Walk until `p` is within reach (a near goal), unless it is already. */
  private reach(d: PlotJobDeps, p: Vec3, r = 2.5): Promise<boolean> {
    return reachOf(d, p, r);
  }

  // ---- seeds ------------------------------------------------------------------------------------------

  private async seeds(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const log = d.log ?? silentLogger;
    const now = d.now ?? (() => performance.now());
    this.seedT0 ??= now();
    // a seed for every soil cell with no crop on it yet (a plot set up before keeps its crops)
    const want = this.site.soil.filter((c) => !cropOf(d.world.blockAt({ x: c.x, y: c.y + 1, z: c.z })?.name)).length;
    const inv = d.world.inventory;
    const s0 = inv.count('wheat_seeds');
    const w = this.site.water;
    // the hoe's obtain job can end far off (a log trip): the grass round the plot is not loaded from there
    if (inv.count('wheat_seeds') < want) {
      const at = d.position();
      if (at && Math.hypot(at.x - (w.x + 0.5), at.z - (w.z + 0.5)) > SEED_RANGE) {
        await this.reach(d, { x: w.x, y: w.y + 1, z: w.z }, 4);
        if (cancelled()) return false;
      }
    }
    const t0 = this.seedT0;
    const until = (): boolean => now() - t0 >= SEED_MS;
    if (!(await breakForSeeds(d, { centre: w, range: SEED_RANGE, want, until }, cancelled, this.stats))) return false;
    // Track E8: the grass within SEED_RANGE gone with time left (a mountain plot had 11 plants within 24): the rest of
    // the time goes to the ring out to SEED_WIDE
    let range = SEED_RANGE;
    if (inv.count('wheat_seeds') < want && !until()) {
      range = SEED_WIDE;
      log.info(`farm new: no grass left within ${SEED_RANGE}: looking out to ${SEED_WIDE}`);
      if (!(await breakForSeeds(d, { centre: w, range: SEED_WIDE, want, until }, cancelled, this.stats))) return false;
    }
    this.stats.seedsGot += Math.max(0, inv.count('wheat_seeds') - s0);
    log.info(`farm new: ${this.stats.grassBroken} grass broken, ${inv.count('wheat_seeds')} wheat seeds carried (${want} cells)`);
    if (want > 0 && inv.count('wheat_seeds') === 0) this.stop = `no seeds (${this.stats.grassBroken} grass broken within ${range}; a 1 in 8 chance each)`;
    return true;
  }

  // ---- water ------------------------------------------------------------------------------------------

  private async water(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const log = d.log ?? silentLogger;
    const w = this.site.water;
    const inv = d.world.inventory;
    if (isWater(d.world.blockAt(w))) {
      this.stats.water = 'already';
      return true;
    }
    if (inv.count('water_bucket') > 0) this.stats.waterWhy ??= 'carried';
    else if (inv.count('bucket') > 0) {
      const filled = await this.fill(d, cancelled);
      if (filled === undefined) return false;
    } else this.stats.waterWhy = 'no bucket';
    if (inv.count('water_bucket') === 0) {
      this.stats.water = 'dry';
      log.info(`farm new: no water for the middle (${this.stats.waterWhy ?? 'none'}): the plot stays dry`);
      return true;
    }
    // stand two cells off the middle (never on it) and dig it, then pour
    const stand = { x: w.x + 2, y: w.y + 1, z: w.z };
    const back = d.position();
    const far = back ? Math.hypot(stand.x + 0.5 - back.x, stand.z + 0.5 - back.z) : 0;
    let back1 = await d.skills.goto({ type: 'near', p: { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, r: 1.2 }, { timeoutTicks: Math.max(600, Math.ceil(far * 20)) });
    if (cancelled()) return false;
    // Track E8: a walk back that ends out of reach (one fill 45 down in a cave left the bot 88 off the middle: three
    // digs `out of reach`, then `not poured (occupied)`) is tried once more with a looser goal and twice the time
    if (!back1.ok && this.eyeDist(d, w) > REACH) {
      log.info(`farm new: back at the plot: ${back1.reason ?? 'failed'}, again`);
      back1 = await d.skills.goto({ type: 'near', p: { x: w.x + 0.5, y: w.y + 1, z: w.z + 0.5 }, r: 3 }, { timeoutTicks: Math.max(1200, Math.ceil(far * 40)) });
      if (cancelled()) return false;
    }
    if (this.eyeDist(d, w) > REACH) {
      this.stats.water = 'dry';
      this.stats.waterWhy = `water carried, not back at the plot (${back1.ok ? 'out of reach' : (back1.reason ?? 'failed')})`;
      log.info(`farm new: water at ${fmt(w)}: ${this.stats.waterWhy}`);
      return true;
    }
    // up to 3 digs: one timed out on a fresh world (`dig ...: timeout after 19 ticks`) and the plot stayed dry
    for (let i = 0; i < 3; i++) {
      const here = d.world.blockAt(w);
      if (!here || !TILLABLE.has(here.name)) break;
      const g = await d.skills.dig(w);
      if (cancelled()) return false;
      if (!g.ok) log.info(`farm new: digging the middle ${fmt(w)}: ${g.reason ?? 'failed'}${i < 2 ? ', again' : ''}`);
    }
    const p = await d.skills.place(w, { item: 'water_bucket', face: 'up', jump: false });
    if (cancelled()) return false;
    // a pour read as `rejected` had gone in on a fresh world: the water showed and the bucket emptied about 1 s later,
    // and the reply said `water dry` over a wet plot. Look again for up to 2 s before calling it dry.
    let waited = 0;
    for (let i = 0; i < 4 && !isWater(d.world.blockAt(w)) && d.wait; i++) {
      await d.wait(500);
      waited += 500;
      if (cancelled()) return false;
    }
    this.stats.water = isWater(d.world.blockAt(w)) ? 'poured' : 'dry';
    if (this.stats.water === 'poured' && !p.ok) {
      this.stats.pourLate = true;
      log.info(`farm new: the pour read ${p.reason ?? 'failed'}; the water showed within ${waited} ms`);
    }
    if (this.stats.water === 'dry') this.stats.waterWhy = `not poured (${p.reason ?? d.world.blockAt(w)?.name ?? 'unknown'})`;
    log.info(`farm new: water at ${fmt(w)}: ${this.stats.water === 'poured' ? 'poured' : `not poured (${p.reason ?? d.world.blockAt(w)?.name ?? 'unknown'})`}`);
    return true;
  }

  /** Where the walk is: blocks walked are counted between goals (straight lines). */
  private lastAt: Vec3 | undefined;
  private walked(d: PlotJobDeps): void {
    const f = d.position();
    if (f && this.lastAt) this.stats.waterWalked += Math.hypot(f.x - this.lastAt.x, f.z - this.lastAt.z);
    this.lastAt = f;
  }

  /**
   * Fill the empty bucket (water.ts): the pools seen round the plot nearest first (loaded, then remembered, within
   * WATER_SEEN), WATER_POOLS of them; with none filled the search walk, a look after each step. True when filled,
   * false when not (waterWhy says why), undefined when cancelled.
   */
  private async fill(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean | undefined> {
    const log = d.log ?? silentLogger;
    const now = d.now ?? (() => performance.now());
    const w = this.site.water;
    const inv = d.world.inventory;
    const tried = new Set<string>();
    const surfaceAt = d.world.surfaceAt;
    const look: WaterLookDeps = { blockAt: (p) => d.world.blockAt(p), find: (p, o) => d.world.find(p, o), ...(surfaceAt ? { surfaceAt } : {}) };
    const key = (p: Vec3): string => `${Math.floor(p.x / WATER_POOL_LINK)},${Math.floor(p.z / WATER_POOL_LINK)}`;
    const skip = (p: Vec3): boolean => tried.has(key(p));
    let nearest: number | undefined;
    let pools = 0;
    /** Pools tried at most: WATER_POOLS before the search walk, as many again during it. */
    let cap = WATER_POOLS;
    let searching = false;
    this.lastAt = d.position();
    /** Try the pools seen from here that were not tried; true when the bucket is full. */
    const tryPools = async (): Promise<boolean | undefined> => {
      const from = d.position() ?? { x: w.x + 0.5, y: w.y + 1, z: w.z + 0.5 };
      const found = waterPools(look, w, from, WATER_SEEN, skip);
      for (const pool of found) {
        if (pools >= cap) break;
        pools++;
        this.stats.poolsTried++;
        nearest = Math.min(nearest ?? Infinity, pool.dist);
        for (const c of pool.cells) tried.add(key(c));
        const r = await this.fillAt(d, pool, cancelled);
        this.walked(d);
        if (r === undefined) return undefined;
        log.info(`farm new: the ${pool.seen} water ${Math.round(pool.dist)} off at ${fmt(pool.at)}: ${r ? 'filled' : 'not filled'}`);
        if (r) {
          this.stats.waterWhy = `filled ${Math.round(pool.dist)} off${pool.seen === 'remembered' ? ', seen before' : ''}${searching ? `, walked ${Math.round(this.stats.waterWalked)} looking` : ''}`;
          return true;
        }
      }
      return inv.count('water_bucket') > 0;
    };
    const first = await tryPools();
    if (first !== false) return first;
    // nothing seen, or none reached: walk out and look
    const t0 = now();
    searching = true;
    cap = pools + WATER_POOLS;
    for (const leg of searchLegs(w)) {
      for (const step of leg) {
        if (now() - t0 > WATER_SEARCH_MS) break;
        const at = d.position();
        const far = at ? Math.hypot(step.x + 0.5 - at.x, step.z + 0.5 - at.z) : WATER_SEARCH_STEP;
        const g = await d.skills.goto({ type: 'near', p: { x: step.x + 0.5, y: step.y, z: step.z + 0.5 }, r: 6 }, { timeoutTicks: Math.max(400, Math.ceil(far * 30)) });
        this.walked(d);
        if (cancelled()) return undefined;
        const got = await tryPools();
        if (got !== false) return got;
        if (!g.ok) break; // the leg is blocked (water, a cliff): the next one
      }
    }
    const walked = Math.round(this.stats.waterWalked);
    this.stats.waterWhy = nearest === undefined ? `none seen within ${WATER_SEEN}, walked ${walked} looking` : `${pools} tried, none reached, nearest ${Math.round(nearest)} off, walked ${walked}`;
    return false;
  }

  /** Walk to a pool and fill the bucket from a source in reach there: true filled, false not, undefined cancelled. */
  private async fillAt(d: PlotJobDeps, pool: WaterPool, cancelled: () => boolean): Promise<boolean | undefined> {
    const inv = d.world.inventory;
    const log = d.log ?? silentLogger;
    const at = d.position();
    const far = at ? Math.hypot(pool.at.x + 0.5 - at.x, pool.at.z + 0.5 - at.z) : pool.dist;
    const g = await d.skills.goto({ type: 'near', p: { x: pool.at.x + 0.5, y: pool.at.y, z: pool.at.z + 0.5 }, r: 3 }, { timeoutTicks: Math.max(300, Math.ceil(far * 30)) });
    if (cancelled()) return undefined;
    const me = d.position();
    if (!me) return false;
    // the sources in reach from where the walk ended (a remembered column is read now that it is loaded)
    const still = surfaceSource((p) => d.world.blockAt(p));
    const near = d.world.find(still, { origin: { x: me.x, y: me.y + EYE_HEIGHT, z: me.z }, radius: REACH + 1, max: 12 }).filter((p) => this.eyeDist(d, p) <= REACH);
    if (near.length === 0) {
      log.info(`farm new: at the water ${fmt(pool.at)}: ${g.ok ? 'no still source in reach' : `not reached (${g.reason ?? 'failed'})`}`);
      return false;
    }
    for (const s of near.slice(0, 3)) {
      const r = await d.click(s, 'bucket');
      if (cancelled()) return undefined;
      if (inv.count('water_bucket') > 0) return true;
      log.info(`farm new: bucket at the water ${fmt(s)}: ${r.ok ? 'no water got' : (r.reason ?? 'failed')}`);
    }
    return false;
  }

  // ---- clear and till ---------------------------------------------------------------------------------

  private async clear(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    for (const c of this.byDistance(d, this.site.covers)) {
      if (cancelled()) return false;
      if (clearCell(d.world.blockAt(c)) !== 'cover') continue;
      if (!(await this.reach(d, c))) continue;
      if (cancelled()) return false;
      const r = await d.skills.dig(c);
      if (r.ok) this.stats.covers++;
    }
    await d.skills.collect(6, 40);
    return !cancelled();
  }

  private async till(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const log = d.log ?? silentLogger;
    const inv = d.world.inventory;
    const failed = new Set<string>();
    // a dry plot: farmland with no crop on it and no water within 4 turns back to dirt, so only as many cells as there
    // are seeds are tilled (measured: 18 seeds on a dry 9 x 9, 92 tills for 80 cells and 62 back to dirt)
    const dry = !isWater(d.world.blockAt(this.site.water));
    const limit = (): number => {
      if (!dry) return Infinity;
      const bare = this.site.soil.filter((c) => d.world.blockAt(c)?.name === FARMLAND && !cropOf(d.world.blockAt({ x: c.x, y: c.y + 1, z: c.z })?.name)).length;
      return Math.max(0, inv.count('wheat_seeds') - bare);
    };
    for (;;) {
      if (cancelled()) return false;
      const todo = this.byDistance(d, this.site.soil.filter((c) => TILLABLE.has(d.world.blockAt(c)?.name ?? '') && !failed.has(fmt(c)))).slice(0, limit());
      if (todo.length === 0) break;
      const hoe = hoeCarried((n) => inv.count(n));
      if (!hoe) {
        this.stop = `no hoe left (${this.stats.tilled} of ${this.site.soil.length} tilled)`;
        return true;
      }
      const next = this.byDistance(d, todo)[0]!;
      if (!(await this.reach(d, next))) {
        if (cancelled()) return false;
        failed.add(fmt(next));
        this.stats.tillFailed++;
        continue;
      }
      // every untilled cell in reach from here, nearest first
      for (const c of this.byDistance(d, todo)) {
        if (cancelled()) return false;
        if (this.eyeDist(d, c) > REACH || !TILLABLE.has(d.world.blockAt(c)?.name ?? '')) continue;
        const over = { x: c.x, y: c.y + 1, z: c.z };
        if (clearCell(d.world.blockAt(over)) === 'cover') {
          await d.skills.dig(over);
          if (cancelled()) return false;
        }
        const h = hoeCarried((n) => inv.count(n));
        if (!h) break;
        const r = await d.click(c, h);
        if (cancelled()) return false;
        if (d.world.blockAt(c)?.name === FARMLAND) this.stats.tilled++;
        else {
          failed.add(fmt(c));
          this.stats.tillFailed++;
          log.info(`farm new: till ${fmt(c)} with ${h}: ${r.ok ? `now ${d.world.blockAt(c)?.name}` : (r.reason ?? 'failed')}`);
        }
      }
    }
    return true;
  }

  // ---- plant ------------------------------------------------------------------------------------------

  private async plant(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const w = this.site.water;
    // the farmer's counters start at 0 with every run (FarmTask.start)
    const r = await d.farm.start({ center: { x: w.x + 0.5, y: w.y + 1, z: w.z + 0.5 }, radius: (this.site.n - 1) / 2 + 1, follow: true, maxRange: 4 });
    this.stats.planted += d.farm.stats.planted;
    if (cancelled()) return false;
    return r !== 'stopped' || !cancelled();
  }

  /** Pause: the farmer's loop stops (a resume starts it again; it scans the field afresh). */
  halt(d: PlotJobDeps): void {
    if (this.phase === 'plant') d.farm.stop();
  }

  // ---- fence ------------------------------------------------------------------------------------------

  private async fenceRing(d: PlotJobDeps, cancelled: () => boolean): Promise<boolean> {
    const log = d.log ?? silentLogger;
    const spec = this.fence;
    if (!spec) return true;
    const inv = d.world.inventory;
    const first = (names: readonly string[]): string => names.find((n) => inv.count(n) > 0) ?? names[0]!;
    const more = spec.more ?? [];
    const items = {
      get fence(): string {
        return first([spec.fence, ...more.filter((n) => !n.endsWith('_gate'))]);
      },
      get gate(): string {
        return first([spec.gate, ...more.filter((n) => n.endsWith('_gate'))]);
      },
    };
    const gate = this.site.gate;
    const tried = new Set<string>();
    const freeRim = (): Vec3[] => this.site.rim.filter((c) => !(c.x === gate.x && c.z === gate.z) && clearCell(d.world.blockAt(c)) !== 'blocked' && !tried.has(fmt(c)));
    // a place refused before any click (`in_body`: the bot stands on that line cell) comes back at once: the bot steps
    // off the line, and a cell refused so three times is left, else the loop spun for ever (an e2e run, 19 minutes)
    const inBody = new Map<string, number>();
    let rounds = 0;
    for (;;) {
      if (cancelled()) return false;
      if (inv.count(items.fence) === 0) break;
      if (++rounds > this.site.rim.length * 3 + 10) {
        log.info(`farm new: the fence step gives up after ${rounds - 1} rounds`);
        break;
      }
      const next = this.byDistance(d, freeRim())[0];
      if (!next) break;
      if (!(await this.reach(d, next, 2.5))) {
        if (cancelled()) return false;
        tried.add(fmt(next));
        this.stats.fenceFailed++;
        continue;
      }
      for (const c of this.byDistance(d, freeRim())) {
        if (cancelled()) return false;
        if (this.eyeDist(d, c) > REACH || inv.count(items.fence) === 0) continue;
        if (clearCell(d.world.blockAt(c)) === 'cover') await d.skills.dig(c);
        const r = await d.skills.place(c, { item: items.fence, face: 'up', jump: false });
        if (cancelled()) return false;
        if (r.ok) this.stats.fenced++;
        else if (r.reason === 'in_body') {
          const k = fmt(c);
          const n = (inBody.get(k) ?? 0) + 1;
          inBody.set(k, n);
          if (n >= 3) {
            tried.add(k);
            this.stats.fenceFailed++;
            log.info(`farm new: fence at ${k}: the bot stands in it (${n} times)`);
            continue;
          }
          // two cells out from the line, off the plot (no crop under the feet)
          const w = this.site.water;
          const out = { x: c.x + 2 * Math.sign(c.x - w.x) + 0.5, y: c.y, z: c.z + 2 * Math.sign(c.z - w.z) + 0.5 };
          await d.skills.goto({ type: 'near', p: out, r: 0.8 }, { timeoutTicks: 200 });
          if (cancelled()) return false;
          break; // plan again from where the bot stands now
        } else {
          tried.add(fmt(c));
          this.stats.fenceFailed++;
          log.info(`farm new: fence at ${fmt(c)}: ${r.reason ?? 'failed'}`);
        }
      }
    }
    // the gate, from two cells inside the plot so it swings across the fence line
    if (inv.count(items.gate) > 0 && clearCell(d.world.blockAt(gate)) !== 'blocked') {
      const w = this.site.water;
      const sx = Math.sign(gate.x - w.x);
      const sz = Math.sign(gate.z - w.z);
      const stand = { x: gate.x - 2 * sx, y: gate.y, z: gate.z - 2 * sz };
      await d.skills.goto({ type: 'near', p: { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, r: 0.8 }, { timeoutTicks: 400 });
      if (cancelled()) return false;
      if (clearCell(d.world.blockAt(gate)) === 'cover') await d.skills.dig(gate);
      const r = await d.skills.place(gate, { item: items.gate, face: 'up', jump: false });
      if (cancelled()) return false;
      this.stats.gate = r.ok;
      if (!r.ok) log.info(`farm new: gate at ${fmt(gate)}: ${r.reason ?? 'failed'}`);
    }
    return true;
  }

  private byDistance(d: PlotJobDeps, cells: readonly Vec3[]): Vec3[] {
    const f = d.position();
    if (!f) return [...cells];
    const dist = (c: Vec3): number => Math.hypot(c.x + 0.5 - f.x, c.y + 0.5 - (f.y + EYE_HEIGHT), c.z + 0.5 - f.z);
    return [...cells].sort((a, b) => dist(a) - dist(b));
  }
}
