// Track AW (wave 11, docs/crafting.md "Compaction"): the 9 -> 1 block table and the plans behind
// `!compact` and the unload hook. The owner: "if a chest has iron blocks and iron ore, and it's full
// and trying to drop off more iron ore, then it should craft them into blocks to make it fit".
// Only storage blocks a vanilla player crafts back 1 -> 9 are listed: raw metal blocks and the
// ingot / gem / dust blocks; never sand, cobblestone, wheat, melons or anything that does not come
// back as the same item.
import type { ItemStack } from '../../world/types.ts';
import { maxStackOf } from '../container/chest.ts';
import type { PlanChest, UnloadPlan, UnloadSlot } from '../home/unloader.ts';
import { setCompactPlanner } from '../home/unloader.ts';
import { usablePool, type PlanOptions } from './recipes.ts';

/** Item -> its storage block (9 items each). */
export const COMPACT: Readonly<Record<string, string>> = {
  raw_iron: 'raw_iron_block',
  raw_copper: 'raw_copper_block',
  raw_gold: 'raw_gold_block',
  iron_ingot: 'iron_block',
  gold_ingot: 'gold_block',
  copper_ingot: 'copper_block',
  diamond: 'diamond_block',
  emerald: 'emerald_block',
  coal: 'coal_block',
  redstone: 'redstone_block',
  lapis_lazuli: 'lapis_block',
  netherite_ingot: 'netherite_block',
};
export const COMPACT_PER_BLOCK = 9;
export const COMPACT_KINDS: readonly string[] = Object.keys(COMPACT);

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** The block `kind` compacts into, or undefined. */
export function compactable(kind: string): string | undefined {
  return COMPACT[bare(kind)];
}

export interface CompactStep {
  kind: string;
  block: string;
  /** Blocks to make. */
  blocks: number;
  /** Items consumed (blocks * 9). */
  uses: number;
}

/** What compacting `kind` from these slots would make (the keep rules and the reserve applied); undefined when fewer than 9. */
export function compactPlan(kind: string, slots: readonly (ItemStack | null | undefined)[], opts: PlanOptions = {}): CompactStep | undefined {
  const k = bare(kind);
  const block = COMPACT[k];
  if (!block) return undefined;
  const have = usablePool(slots, opts).get(k) ?? 0;
  const blocks = Math.floor(have / COMPACT_PER_BLOCK);
  if (blocks <= 0) return undefined;
  return { kind: k, block, blocks, uses: blocks * COMPACT_PER_BLOCK };
}

/** Every compactable kind carried in threes of three (the `!compact` plan), in COMPACT order. */
export function compactAll(slots: readonly (ItemStack | null | undefined)[], opts: PlanOptions = {}, only?: string): CompactStep[] {
  const out: CompactStep[] = [];
  const want = only ? bare(only) : undefined;
  for (const kind of COMPACT_KINDS) {
    if (want && kind !== want && !kind.includes(want) && COMPACT[kind] !== want) continue;
    const s = compactPlan(kind, slots, opts);
    if (s) out.push(s);
  }
  return out;
}

/** The chests that end with no free slot after the plan's moves (a plan's own simulation, replayed). */
export function fullAfter(plan: UnloadPlan, chests: readonly PlanChest[], maxStack: (name: string) => number = maxStackOf): Set<string> {
  const out = new Set<string>();
  for (const c of chests) {
    let free = c.free;
    const room: Record<string, number> = { ...c.room };
    for (const m of plan.moves) {
      if (m.to !== c.key) continue;
      const fromRoom = Math.min(room[m.name] ?? 0, m.count);
      room[m.name] = (room[m.name] ?? 0) - fromRoom;
      const rest = m.count - fromRoom;
      if (rest > 0) {
        const max = maxStack(m.name);
        const slots = Math.ceil(rest / max);
        free -= slots;
        room[m.name] = (room[m.name] ?? 0) + slots * max - rest;
      }
    }
    if (free <= 0) out.add(c.key);
  }
  return out;
}

/**
 * The unload hook (docs/home.md `UnloadPlan.compact`): the compactable kinds the bot carries nine or
 * more of whose chest cannot take the load, i.e. some of the kind overflows or its target chest ends
 * with no free slot. Compacting first makes 9 items into 1 block (8 slots freed per 9 stacks).
 */
export function compactForUnload(slots: readonly UnloadSlot[], plan: UnloadPlan, chests: readonly PlanChest[], opts: PlanOptions = {}): { kind: string; count: number }[] {
  const out: { kind: string; count: number }[] = [];
  const full = fullAfter(plan, chests);
  const items: ItemStack[] = slots.map((s) => ({ name: s.name, count: s.count, networkId: 0, metadata: 0 }));
  for (const kind of COMPACT_KINDS) {
    const step = compactPlan(kind, items, opts);
    if (!step) continue;
    const overflow = plan.overflow.some((o) => o.name === kind);
    const fills = plan.moves.some((m) => m.name === kind && full.has(m.to));
    if (overflow || fills) out.push({ kind, count: step.uses });
  }
  return out;
}

/** Make `planUnload` carry the compaction step (idempotent; `opts` are read at plan time). */
export function installCompactPlanner(opts: () => PlanOptions): void {
  setCompactPlanner((slots, plan, chests) => compactForUnload(slots, plan, chests, opts()));
}

export interface CompactDone {
  kind: string;
  block: string;
  blocks: number;
  uses: number;
}

/** `compacted 54 raw_iron into 6 raw_iron_block` (several kinds joined with `; `). */
export function compactLine(done: readonly CompactDone[]): string {
  if (done.length === 0) return 'compact: nothing compacted';
  return `compacted ${done.map((d) => `${d.uses} ${d.kind} into ${d.blocks} ${d.block}`).join('; ')}`;
}
