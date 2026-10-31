// Produce on the floor (wave 10 Track AQ; docs/mining.md "Produce on the floor", docs/decisions/0038):
// before a work job chooses its next target it picks up its own kind of items lying within SWEEP_RADIUS
// (8) blocks: its own drops that were left, and what the owner dropped (`!get wood` with logs on the
// floor picks them up first). One entity scan when nothing of the kind is near; no grace wait.
import type { EntityInfo, ItemStack, Vec3 } from '../../world/types.ts';
import { foodInfo } from '../survival/eat.ts';
import { isLog } from '../tree/tree.ts';
import type { CollectOptions, CollectResult } from './collect.ts';

/** Items of the job's kind within this many blocks are picked up before the next target. */
export const SWEEP_RADIUS = 8;

export type CollectFn = (radius: number, timeoutTicks: number, opts?: CollectOptions) => Promise<unknown>;

export interface SweepOptions {
  radius?: number;
  /** Ticks for the collect at most. Default 200. */
  ticks?: number;
  /** Centre of the search (default the bot). */
  origin?: Vec3;
  /** The entities, for the cheap check: without one matching item near, collect is not called at all. */
  entities?: () => ReadonlyMap<bigint, EntityInfo>;
  /** Feet of the bot (the centre of the cheap check when no origin is given). */
  position?: () => Vec3 | undefined;
}

/** Item entities of the kind within `radius` of `origin`. */
export function itemsOfKind(entities: ReadonlyMap<bigint, EntityInfo>, origin: Vec3, radius: number, kind: (name: string) => boolean): number {
  let n = 0;
  for (const e of entities.values()) {
    if (e.type !== 'minecraft:item' || !e.item || !kind(e.item.name)) continue;
    if (Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y, e.pos.z - origin.z) <= radius) n++;
  }
  return n;
}

/**
 * Pick up the job's kind of items near the bot (the collect skill with a filter and no grace wait).
 * Resolves with the collect result, or undefined when nothing of the kind is near (collect not called).
 */
export async function sweepItems(collect: CollectFn, kind: (name: string) => boolean, o: SweepOptions = {}): Promise<CollectResult | undefined> {
  const radius = o.radius ?? SWEEP_RADIUS;
  const at = o.origin ?? o.position?.();
  if (o.entities && at && itemsOfKind(o.entities(), at, radius, kind) === 0) return undefined;
  const filter = (i: ItemStack) => kind(i.name);
  const r = await collect(radius, o.ticks ?? 200, { filter, graceTicks: 0, hard: true, ...(o.origin ? { origin: o.origin } : {}) });
  return r as CollectResult | undefined;
}

const bare = (n: string) => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** Gather wood's kind: logs, saplings, sticks and apples (what a felled tree leaves). */
export function isWoodDrop(name: string): boolean {
  const n = bare(name);
  return isLog(n) || n.endsWith('_sapling') || n === 'stick' || n === 'apple' || n === 'mangrove_propagule';
}

/** Food's kind: every food item but the bad ones (what `!food n` counts), and leather / feathers / wool from the hunt. */
export function isFoodDrop(name: string): boolean {
  const n = bare(name);
  const f = foodInfo(n);
  return (!!f && !f.bad) || n === 'leather' || n === 'feather' || n.endsWith('_wool') || n === 'rabbit_hide';
}
