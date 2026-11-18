// Obtaining crafted items from scratch (Track E1, docs/early-game.md): `!get stone_pickaxe`, `!get bed`, `!get kit`.
// Pure: the targets, the inventory and the recipe index in, the next command out. The chat side
// (chat/commands-kit.ts) runs that command as the owner, waits for its process to end, and asks again with the new
// inventory, until every target is carried or a step makes no progress.
//
// The rules a player follows on the first day:
//   - craft what the inventory can make (skills/craft/chain.ts: planks, sticks and the table first);
//   - a raw material the chain is missing is gathered: logs by felling trees (`!gather n`), cobblestone and the
//     catalog's mined items by mining (`!mine stone n`), wool from sheep (`!kill sheep n`), food by hunting (`!food n`);
//   - a block that drops nothing without a pickaxe of a tier (stone: wooden, iron ore: stone) gets that pickaxe first:
//     it joins the targets ahead of the others, so the logs for both are felled in one trip;
//   - logs first, then mined, then hunted: the order a fresh world allows (no pickaxe without wood).
// What has no rule here (iron ingots: smelting; string by day) stops the job with the reason, never a guess.
import { toolOf, blockMining, TIER_LEVEL, type ToolTier } from '../../data/mining.ts';
import { canHarvest } from '../dig/breakTime.ts';
import { carried, planChain, type ChainOptions, type ChainLeaf } from '../craft/chain.ts';
import type { RecipeIndex } from '../craft/recipes.ts';
import { FOODS } from '../survival/eat.ts';
import type { ItemStack } from '../../world/types.ts';
import { entryFor, minedItem } from './catalog.ts';

export interface ObtainTarget {
  /** An item name, or `food` (n food items, any kind the bot eats). */
  item: string;
  n: number;
}

export type ObtainAction =
  | { kind: 'craft'; item: string; n: number; command: string }
  | { kind: 'gather'; n: number; command: string }
  | { kind: 'mine'; block: string; item: string; n: number; command: string }
  | { kind: 'hunt'; mob: string; item: string; n: number; command: string }
  | { kind: 'food'; n: number; command: string }
  | { kind: 'done' }
  | { kind: 'stuck'; reason: string };

/**
 * The early-game kit (`!get kit`): a table, stone tools, cobblestone left over (the night shell's 10 cells, pillars, a
 * gap bridged), food. The order is the crafting order.
 */
export const EARLY_KIT: readonly ObtainTarget[] = [
  { item: 'crafting_table', n: 1 },
  { item: 'stone_sword', n: 1 },
  { item: 'stone_pickaxe', n: 1 },
  { item: 'stone_axe', n: 1 },
  { item: 'cobblestone', n: 16 },
  { item: 'food', n: 6 },
];

/** The pickaxe made for a harvest tier (iron and above need smelted ingots: no rule here). */
const PICKAXE_FOR: Readonly<Partial<Record<ToolTier, string>>> = { wooden: 'wooden_pickaxe', stone: 'stone_pickaxe' };

type Slots = readonly (ItemStack | null | undefined)[];
type Index = Parameters<typeof planChain>[0] & Pick<RecipeIndex, 'byOutput'>;

const isLog = (n: string): boolean => /_(log|wood)$/.test(n) && !n.startsWith('stripped_') && !n.startsWith('crimson') && !n.startsWith('warped');
const isWool = (n: string): boolean => n.endsWith('_wool');

/** Food items carried (what the eat skill eats, the bad ones not counted). */
export function foodCarried(slots: Slots): number {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    const f = s ? FOODS[s.name] : undefined;
    if (s && f && !f.bad && !f.precious) n += s.count;
  }
  return n;
}

/** The block mined for a raw material (`cobblestone` -> stone, `coal` -> coal_ore), or undefined. */
export function minedBlockFor(item: string): string | undefined {
  if (item === 'cobblestone') return 'stone';
  if (item === 'cobbled_deepslate') return 'deepslate';
  const e = entryFor(item);
  if (e?.strategy !== 'mine' || !e.target || e.target === 'ores') return undefined;
  return minedItem(e.target) === item ? e.target : undefined;
}

/** Does a carried tool harvest the block (the bare hand for blocks that need none)? */
export function canHarvestWith(slots: Slots, block: string): boolean {
  const m = blockMining(block);
  if (!m) return true;
  if (canHarvest(m, null)) return true;
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s && canHarvest(m, toolOf(s.name))) return true;
  }
  return false;
}

/** The pickaxe to make before mining `block`, or a reason there is none to make. */
export function pickaxeFor(block: string): { item: string } | { reason: string } {
  const tier = blockMining(block)?.harvest?.minTier ?? 'wooden';
  const item = PICKAXE_FOR[tier];
  if (item) return { item };
  return { reason: `${block} needs a ${tier} pickaxe (${TIER_LEVEL[tier] >= TIER_LEVEL.iron ? 'smelted ingots' : 'materials'} I cannot get yet)` };
}

/** The leaf's action, or a reason (no rule). */
function leafAction(leaf: ChainLeaf): Exclude<ObtainAction, { kind: 'craft' | 'done' | 'food' | 'stuck' }> | { kind: 'none'; reason: string } {
  if (isLog(leaf.item) || leaf.item === 'minecraft:logs') return { kind: 'gather', n: leaf.n, command: `gather ${leaf.n}` };
  if (isWool(leaf.item)) return { kind: 'hunt', mob: 'sheep', item: leaf.item, n: leaf.n, command: `kill sheep ${leaf.n}` };
  const block = minedBlockFor(leaf.item);
  if (block) return { kind: 'mine', block, item: leaf.item, n: leaf.n, command: `mine ${block} ${leaf.n}` };
  return { kind: 'none', reason: `no way to get ${leaf.item} yet (it is not gathered, mined or hunted)` };
}

const RANK = { gather: 0, mine: 1, hunt: 2 } as const;

/** The first named ingredient of the item's recipes that cannot be had (an iron pickaxe's iron ingot), or undefined. */
function blockingIngredient(index: Index, item: string, slots: Slots, o: ChainOptions): string | undefined {
  const r = [...index.byOutput(item)].sort((a, b) => a.priority - b.priority)[0];
  for (const ing of r?.input ?? []) {
    if (!ing?.name || ing.name === item) continue;
    const p = planChain(index, [{ item: ing.name, n: carried(slots, ing.name) + 1 }], slots, o);
    if (p.missing.some((m) => m.item === ing.name)) return ing.name;
  }
  return undefined;
}

/**
 * The next command towards `targets` (each `n` in all: what is carried counts). `craft` makes one target (the
 * `!craft` command chains its ingredients); the others get a raw material.
 */
export function nextAction(index: Index, targets: readonly ObtainTarget[], slots: Slots, o: ChainOptions = {}, depth = 0): ObtainAction {
  const items = targets.filter((t) => t.item !== 'food');
  const short = items.filter((t) => carried(slots, t.item) < t.n);
  const oo: ChainOptions = { ...o, raw: (n) => leafAction({ item: n, n: 1 }).kind !== 'none' };
  const plan = planChain(index, short, slots, oo);
  if (short.length > 0 && plan.missing.length === 0) {
    // everything can be crafted now: the first short target (its chain is crafted with it)
    const t = short.find((x) => index.byOutput(x.item).length > 0);
    if (!t) return { kind: 'stuck', reason: `no recipe for ${short[0]!.item}` };
    const n = t.n - carried(slots, t.item);
    return { kind: 'craft', item: t.item, n, command: `craft ${t.item} ${n}` };
  }
  if (short.length > 0) {
    const acts: (Exclude<ObtainAction, { kind: 'craft' | 'done' | 'food' | 'stuck' }>)[] = [];
    let logs = 0;
    for (const leaf of plan.missing) {
      const a = leafAction(leaf);
      if (a.kind === 'none') {
        if (index.byOutput(leaf.item).length === 0) return { kind: 'stuck', reason: short.some((t) => t.item === leaf.item) ? `no recipe for ${leaf.item}` : a.reason };
        const cause = blockingIngredient(index, leaf.item, slots, oo);
        return { kind: 'stuck', reason: `no way to get ${leaf.item} yet${cause ? `: it needs ${cause}, which is not gathered, mined, hunted or crafted from those` : ''}` };
      }
      if (a.kind === 'gather') logs += a.n;
      else acts.push(a);
    }
    // a block no carried tool harvests: its pickaxe joins the targets first (its logs come in the same trip)
    const unharvested = acts.find((a): a is Extract<typeof a, { kind: 'mine' }> => a.kind === 'mine' && !canHarvestWith(slots, a.block));
    if (unharvested) {
      const pick = pickaxeFor(unharvested.block);
      if ('reason' in pick) return { kind: 'stuck', reason: pick.reason };
      if (!targets.some((t) => t.item === pick.item)) {
        if (depth >= 2) return { kind: 'stuck', reason: `no tool harvests ${unharvested.block}` };
        return nextAction(index, [{ item: pick.item, n: 1 }, ...targets], slots, o, depth + 1);
      }
    }
    // the logs for every target in one trip
    if (logs > 0) return { kind: 'gather', n: logs, command: `gather ${logs}` };
    // a target the inventory makes on its own now (the pickaxe the mining needs, the table)
    for (const t of short) {
      if (index.byOutput(t.item).length === 0) continue;
      if (planChain(index, [t], slots, oo).missing.length > 0) continue;
      const n = t.n - carried(slots, t.item);
      return { kind: 'craft', item: t.item, n, command: `craft ${t.item} ${n}` };
    }
    acts.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    const a = acts[0]!;
    if (a.kind === 'mine' && !canHarvestWith(slots, a.block)) return { kind: 'stuck', reason: `no tool harvests ${a.block}` };
    return a;
  }
  const food = targets.find((t) => t.item === 'food');
  if (food) {
    const have = foodCarried(slots);
    if (have < food.n) return { kind: 'food', n: food.n - have, command: `food ${food.n - have}` };
  }
  return { kind: 'done' };
}

/** `white_bed` and the other colours name the bed item on Bedrock (its colour follows the wool). */
export function itemAlias(name: string): string {
  return /^[a-z_]+_bed$/.test(name) ? 'bed' : name;
}
