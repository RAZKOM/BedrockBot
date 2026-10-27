// Food knowledge for gathering (PLAN.md task 7.16, Track X, docs/food.md): which mobs give food, what a
// raw food cooks into, what burns in a furnace, how much food the inventory carries, baby detection,
// target choice with the "leave some of each kind" rule, and the furnace finder. Pure functions plus
// one small packet listener (BabyTracker); the hunt and cook loops live in hunter.ts and cook.ts.
//
// Facts used (BDS 1.26.60.6, Bedrock loot tables): cow and mooshroom drop 1-3 beef (+ 0-2 leather),
// pig 1-3 porkchop, sheep 1-2 mutton (+ wool), chicken 1 chicken (+ 0-2 feathers), rabbit 0-1 rabbit
// (+ hide). Babies drop nothing, so they are never hunted. Baby mobs carry the actor flag `baby` in
// add_entity / set_entity_data metadata (`flags`).
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { bareType, entityFeet, isPlayerEntity } from '../combat/hostiles.ts';
import { foodInfo } from '../survival/eat.ts';
import { PEN_KEEP, type Pen } from './pen.ts'; // Track AF

export interface FoodAnimal {
  /** Raw food items it drops. */
  drops: readonly string[];
  /** Expected food items per kill (loot table mean). */
  expected: number;
}

/** Passive mobs hunted for food (Bedrock ids without the namespace). */
export const FOOD_ANIMALS: Readonly<Record<string, FoodAnimal>> = {
  cow: { drops: ['beef'], expected: 2 },
  mooshroom: { drops: ['beef'], expected: 2 },
  pig: { drops: ['porkchop'], expected: 2 },
  sheep: { drops: ['mutton'], expected: 1.5 },
  chicken: { drops: ['chicken'], expected: 1 },
  rabbit: { drops: ['rabbit'], expected: 0.5 },
};

/** The food kind of an entity type (`minecraft:cow` -> `cow`), or undefined. */
export function foodKindOf(type: string): string | undefined {
  const t = bareType(type);
  return FOOD_ANIMALS[t] ? t : undefined;
}

/** Raw food -> what a furnace or smoker makes of it. */
export const COOKED: Readonly<Record<string, string>> = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
};

const short = (name: string): string => (name.startsWith('minecraft:') ? name.slice(10) : name);

export function cookedOf(name: string): string | undefined {
  return COOKED[short(name)];
}

const NETHER_WOOD = /crimson|warped/;

/** Items smelted per fuel item (vanilla burn time / 200 ticks); 0 = not a fuel. Nether wood is fireproof. */
export function fuelValue(name: string): number {
  const n = short(name);
  if (n === 'coal' || n === 'charcoal') return 8;
  if (n === 'coal_block') return 80;
  if (n === 'dried_kelp_block') return 20;
  if (n === 'blaze_rod') return 12;
  if (NETHER_WOOD.test(n)) return 0;
  if (n.endsWith('_planks') || /(_log|_wood)$/.test(n)) return 1.5;
  return 0;
}

/** Fuel preference (lower = burnt first): charcoal and coal, kelp blocks, coal blocks, planks, logs. */
export function fuelRank(name: string): number {
  const n = short(name);
  if (n === 'charcoal') return 0;
  if (n === 'coal') return 1;
  if (n === 'dried_kelp_block') return 2;
  if (n === 'coal_block') return 3;
  if (n.endsWith('_planks')) return 4;
  if (n === 'blaze_rod') return 6;
  return 5;
}

export function isFuel(name: string): boolean {
  return fuelValue(name) > 0;
}

/** Hunger points of the food the inventory carries (slots 0..35); the bad foods do not count. */
export function inventoryFoodPoints(slots: readonly (ItemStack | null | undefined)[]): number {
  let total = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const it = slots[i];
    if (!it || it.count <= 0) continue;
    const info = foodInfo(it.name);
    if (!info || info.bad) continue;
    total += info.nutrition * it.count;
  }
  return total;
}

/** Food items carried (what `!food n` counts): every food except the bad ones. */
export function foodItemCount(slots: readonly (ItemStack | null | undefined)[]): number {
  let total = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const it = slots[i];
    if (!it || it.count <= 0) continue;
    const info = foodInfo(it.name);
    if (info && !info.bad) total += it.count;
  }
  return total;
}

/** Raw food in the inventory that a furnace can cook: name -> count. */
export function rawFoodCounts(slots: readonly (ItemStack | null | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const it = slots[i];
    if (!it || it.count <= 0 || !cookedOf(it.name) || !foodInfo(it.name)) continue;
    out.set(it.name, (out.get(it.name) ?? 0) + it.count);
  }
  return out;
}

// ---- babies ----------------------------------------------------------------------------------------

interface MetaLike {
  key: string;
  value: unknown;
}

/** What the tracker subscribes to (`Connection` satisfies it). */
export interface BabySource {
  on(name: string, fn: (p: Record<string, unknown>) => void): () => void;
}

const toBig = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(v as number | string));

/** The `baby` actor flag of a metadata list: true / false, or undefined when the list has no flags. */
export function babyFlag(metadata: readonly MetaLike[] | undefined): boolean | undefined {
  for (const m of metadata ?? []) {
    if (m.key === 'flags' && m.value && typeof m.value === 'object') return (m.value as { baby?: boolean }).baby === true;
  }
  return undefined;
}

/** Track AF: the `inlove` actor flag (love mode after feeding): true / false, or undefined without flags. */
export function loveFlag(metadata: readonly MetaLike[] | undefined): boolean | undefined {
  for (const m of metadata ?? []) {
    if (m.key === 'flags' && m.value && typeof m.value === 'object') return (m.value as { inlove?: boolean }).inlove === true;
  }
  return undefined;
}

/** Runtime ids of baby mobs, from add_entity / set_entity_data metadata (`flags.baby`); Track AF: and of mobs in love mode (`flags.inlove`). */
export class BabyTracker {
  readonly babies = new Set<bigint>();
  /** Track AF: mobs in love mode now (fed, looking for a partner). */
  readonly inLove = new Set<bigint>();
  /** Track AF: runtime id -> performance.now() when it was first seen as a baby (breeding counts new calves). */
  readonly bornSeen = new Map<bigint, number>();
  private readonly unsubs: (() => void)[] = [];

  constructor(source: BabySource) {
    const apply = (rid: bigint, meta: unknown) => {
      const b = babyFlag(meta as MetaLike[] | undefined);
      if (b === true) {
        if (!this.babies.has(rid)) this.bornSeen.set(rid, performance.now());
        this.babies.add(rid);
      } else if (b === false) {
        this.babies.delete(rid);
        this.bornSeen.delete(rid);
      }
      const l = loveFlag(meta as MetaLike[] | undefined);
      if (l === true) this.inLove.add(rid);
      else if (l === false) this.inLove.delete(rid);
    };
    this.unsubs.push(
      source.on('add_entity', (p) => {
        apply(toBig(p.runtime_id), p.metadata);
      }),
      source.on('set_entity_data', (p) => {
        apply(toBig(p.runtime_entity_id), p.metadata);
      }),
      source.on('remove_entity', () => {
        // runtime ids are not reused within a session; the set stays small (babies only)
      }),
      source.on('start_game', () => {
        this.babies.clear();
        this.inLove.clear();
        this.bornSeen.clear();
      }),
    );
  }

  isBaby(rid: bigint): boolean {
    return this.babies.has(rid);
  }

  /** Track AF: in love mode (the `inlove` flag). */
  isInLove(rid: bigint): boolean {
    return this.inLove.has(rid);
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }
}

// ---- targets ---------------------------------------------------------------------------------------

export interface TargetQuery {
  /** Centre of the search (the bot when the job started). */
  center: Vec3;
  /** Horizontal radius. Default 48. */
  radius?: number;
  /** Max height difference from the centre. Default 16. */
  height?: number;
  /** Never reduce a kind below this many adults within the radius. */
  leave: number;
  /** The bot's feet (nearest first). */
  me: Vec3;
  isBaby(rid: bigint): boolean;
  /** Dead or dying (death animation seen). */
  isDead?(rid: bigint): boolean;
  /** Skip for now (unreachable, failed fights). */
  ignored?(rid: bigint): boolean;
  /** Only these kinds (default all). */
  kinds?: readonly string[];
  /** Track AF: the pen a mob stands in (undefined = wild). Without it every mob counts as wild. */
  penOf?(e: EntityInfo): Pen | undefined;
  /** Track AF: may this pen's animals of `kind` be hunted (down to PEN_KEEP adults)? Default never. */
  penAllowed?(pen: Pen, kind: string): boolean;
}

export interface FoodTarget {
  entity: EntityInfo;
  kind: string;
  distance: number;
  /** Track AF: the pen it stands in, if any. */
  pen?: Pen | undefined;
}

export interface HerdCount {
  adults: number;
  babies: number;
}

/**
 * Adults and babies of every food kind within the query's radius (dead ones left out). With `penOf`
 * (Track AF) only the wild ones (outside pens); `pens` then receives the penned ones by pen id.
 */
export function countHerd(
  entities: Iterable<EntityInfo>,
  q: Pick<TargetQuery, 'center' | 'radius' | 'height' | 'isBaby' | 'isDead' | 'penOf'>,
  pens?: Map<string, Map<string, HerdCount>>,
): Map<string, HerdCount> {
  const out = new Map<string, HerdCount>();
  const r = q.radius ?? 48;
  const h = q.height ?? 16;
  for (const e of entities) {
    if (isPlayerEntity(e)) continue;
    const kind = foodKindOf(e.type);
    if (!kind || q.isDead?.(e.runtimeId)) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - q.center.x, f.z - q.center.z) > r || Math.abs(f.y - q.center.y) > h) continue;
    const pen = q.penOf?.(e);
    let into = out;
    if (pen) {
      if (!pens) continue;
      into = pens.get(pen.id) ?? new Map<string, HerdCount>();
      pens.set(pen.id, into);
    }
    const c = into.get(kind) ?? { adults: 0, babies: 0 };
    if (q.isBaby(e.runtimeId)) c.babies++;
    else c.adults++;
    into.set(kind, c);
  }
  return out;
}

/**
 * The next mob to hunt: adults of a food kind within the radius, of a kind with more than `leave`
 * adults within the radius, not ignored; nearest first, worth-weighted (2 blocks per expected item).
 * Track AF, with `penOf`: the leave rule counts wild mobs only, and a mob inside a pen is taken only
 * when `penAllowed(pen, kind)` and its pen holds more than PEN_KEEP (2) adults of the kind.
 */
export function pickTarget(entities: Iterable<EntityInfo>, q: TargetQuery): FoodTarget | undefined {
  const list = [...entities];
  // one fill per mob at most (PenDetector memoizes, this keeps the pass consistent)
  const pens = new Map<bigint, Pen | undefined>();
  const penOf = q.penOf
    ? (e: EntityInfo): Pen | undefined => {
        if (pens.has(e.runtimeId)) return pens.get(e.runtimeId);
        const p = q.penOf!(e);
        pens.set(e.runtimeId, p);
        return p;
      }
    : undefined;
  const penned = new Map<string, Map<string, HerdCount>>();
  const herd = countHerd(list, { ...q, ...(penOf ? { penOf } : {}) }, penned);
  const r = q.radius ?? 48;
  const h = q.height ?? 16;
  let best: (FoodTarget & { score: number }) | undefined;
  for (const e of list) {
    if (isPlayerEntity(e)) continue;
    const kind = foodKindOf(e.type);
    if (!kind || (q.kinds && !q.kinds.includes(kind))) continue;
    if (q.isBaby(e.runtimeId) || q.isDead?.(e.runtimeId) || q.ignored?.(e.runtimeId)) continue;
    const f = entityFeet(e);
    if (Math.hypot(f.x - q.center.x, f.z - q.center.z) > r || Math.abs(f.y - q.center.y) > h) continue;
    const pen = penOf?.(e);
    if (pen) {
      if (!q.penAllowed?.(pen, kind)) continue;
      if ((penned.get(pen.id)?.get(kind)?.adults ?? 0) <= PEN_KEEP) continue;
    } else if ((herd.get(kind)?.adults ?? 0) <= q.leave) continue;
    const distance = Math.hypot(f.x - q.me.x, f.y - q.me.y, f.z - q.me.z);
    const score = distance - 2 * FOOD_ANIMALS[kind]!.expected;
    if (!best || score < best.score) best = { entity: e, kind, distance, score, pen };
  }
  if (!best) return undefined;
  return { entity: best.entity, kind: best.kind, distance: best.distance, ...(best.pen ? { pen: best.pen } : {}) };
}

// ---- furnaces --------------------------------------------------------------------------------------

/** Blocks that cook food (lit or not). Blast furnaces cook ores only. */
export const COOKERS: ReadonlySet<string> = new Set(['furnace', 'lit_furnace', 'smoker', 'lit_smoker']);

export function isCooker(b: Pick<BlockInfo, 'name'>): boolean {
  return COOKERS.has(b.name);
}

/** The finder the cook step uses (`World` satisfies it; cached marks are included when a world cache is open). */
export interface CookerFinder {
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): Vec3[];
}

/** Furnaces and smokers within `radius` of `origin`, nearest first. */
export function findCookers(world: CookerFinder, origin: Vec3, radius = 16): Vec3[] {
  return world.find((b) => isCooker(b), { origin, radius, max: 8 });
}
