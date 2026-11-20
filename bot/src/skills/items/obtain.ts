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
// Track E2 (docs/early-game.md "The iron age", ADR 0099) adds the furnace:
//   - a smelted material (iron, gold and copper ingots, glass) is its raw input mined (`!mine iron_ore n`), then
//     smelted (`!smelt raw_iron n`) once everything is mined; the smelt needs a furnace where the cooker looks (crafted
//     from 8 cobblestone as a target of its own, then set down: `!furnace`) and fuel for every item;
//   - fuel, the cheapest that is near: what the crafts leave of the coal, charcoal, planks and logs carried; then coal
//     when a coal ore is known within 24 blocks (`!mine coal_ore n`); then planks from the logs left (`!craft
//     oak_planks n`: a log as planks smelts 6 items, as a log 1.5); then logs (with the trip for the crafts' own logs
//     when there is one);
//   - raw food carried with a furnace standing near and fuel to spare is cooked (`!cook`) before the food is counted;
//   - a target may be soft (the iron kit's armour): once a mine step for its material came back short, a soft target
//     the carried material no longer covers is dropped (the job says which and why);
//   - worn armour and the offhand's shield count as carried.
// Track E3 (docs/early-game.md "A bed", ADR 0100) adds the bed:
//   - a bed target is met by a bed standing where the night rule sleeps (by home, the shelter or the bed waypoint);
//     one carried is set down (`!bed`); the iron kit ends with one, soft: wool from sheep (`!kill sheep n`), and a hunt
//     that came back short of the wool drops it.
// What has no rule here (string by day) stops the job with the reason, never a guess.
import { toolOf, blockMining, TIER_LEVEL, type ToolTier } from '../../data/mining.ts';
import { canHarvest } from '../dig/breakTime.ts';
import { carried, planChain, type ChainOptions, type ChainLeaf } from '../craft/chain.ts';
import type { Recipe, RecipeIndex } from '../craft/recipes.ts';
import { FOODS } from '../survival/eat.ts';
import { fuelValue, rawFoodCounts } from '../food/finder.ts';
import { countOf, smeltInputsOf } from '../food/smelt.ts';
import type { ItemStack } from '../../world/types.ts';
import { entryFor, minedItem } from './catalog.ts';
import { usableSlots, type ToolOk } from './wear.ts';
import { isLog as gatherCounts } from '../tree/tree.ts'; // Track E5: the logs `!gather` counts

export interface ObtainTarget {
  /** An item name, or `food` (n food items, any kind the bot eats). */
  item: string;
  n: number;
  /** Track E2: dropped when its material ran short (`capped`) instead of stopping the job. */
  soft?: boolean;
  /**
   * Track E3: planned only once every other target is met or dropped (the iron kit's bed: with its wool and planks in
   * the first trips the e2e kit took 575 s against 274).
   */
  last?: boolean;
}

export type ObtainAction =
  | { kind: 'craft'; item: string; n: number; command: string }
  | { kind: 'gather'; n: number; command: string }
  | { kind: 'mine'; block: string; item: string; n: number; command: string }
  | { kind: 'hunt'; mob: string; item: string; n: number; command: string }
  | { kind: 'food'; n: number; command: string }
  | { kind: 'smelt'; item: string; input: string; n: number; command: string }
  | { kind: 'furnace'; command: string }
  | { kind: 'cook'; n: number; command: string }
  | { kind: 'bed'; command: string }
  | { kind: 'done' }
  | { kind: 'stuck'; reason: string };

/** Track E2: what the planner knows beyond the inventory (the chat side fills it in). */
export interface ObtainOptions extends ChainOptions {
  /** A furnace stands where the cooker looks (16 blocks of home, or of the bot without one). */
  furnaceNear?: boolean;
  /** A coal ore is known within 24 blocks (the cheapest fuel to fetch). */
  coalNear?: boolean;
  /** Worn armour and the offhand item (they count as carried). */
  worn?: readonly (ItemStack | null | undefined)[];
  /** Raw materials whose mine step came back short: soft targets they no longer cover are dropped. */
  capped?: ReadonlySet<string>;
  /** Track E3: a bed stands where the night rule sleeps (it meets a bed target; one carried is set down). */
  bedNear?: boolean;
  /** Track E4: the worn-tool rule (SurvivalKit.toolOk): a worn tool counts as not carried (wear.ts). */
  toolOk?: ToolOk;
}

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

/**
 * Track E2: the iron kit (`!get kit iron`): an iron pickaxe and sword, a shield and a bucket (9 ingots), then the iron
 * armour the ore allows (soft: 24 more ingots, the best points per ingot first), the shell's cobblestone, cooked food.
 */
export const IRON_KIT: readonly ObtainTarget[] = [
  { item: 'iron_pickaxe', n: 1 },
  { item: 'iron_sword', n: 1 },
  { item: 'shield', n: 1 },
  { item: 'bucket', n: 1 },
  { item: 'iron_chestplate', n: 1, soft: true },
  { item: 'iron_leggings', n: 1, soft: true },
  { item: 'iron_boots', n: 1, soft: true },
  { item: 'iron_helmet', n: 1, soft: true },
  { item: 'bed', n: 1, soft: true, last: true }, // Track E3: after the iron, set down where the bot sleeps
  { item: 'cobblestone', n: 16 },
  { item: 'food', n: 6 },
];

/** The pickaxe made for a harvest tier (iron: from smelted ingots, Track E2). */
const PICKAXE_FOR: Readonly<Partial<Record<ToolTier, string>>> = { wooden: 'wooden_pickaxe', stone: 'stone_pickaxe', iron: 'iron_pickaxe' };

/** Recursion depth for the pickaxes a target needs first (wooden, stone, iron: an iron pickaxe from nothing). */
const MAX_PICK_DEPTH = 3;
/** Items one log smelts as planks (4 planks x 1.5). */
export const PLANK_ITEMS_PER_LOG = 6;
/** The coal ore distance that counts as near (the fuel rule). */
export const COAL_NEAR = 24;

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
  return { reason: `${block} needs a ${tier} pickaxe (${TIER_LEVEL[tier] >= TIER_LEVEL.diamond ? 'diamonds' : 'materials'} I cannot get yet)` };
}

/** Count of `item` carried or worn (armour, the offhand). */
export function haveCount(slots: Slots, item: string, worn?: Slots): number {
  let n = carried(slots, item);
  for (const s of worn ?? []) if (s?.name === item) n += s.count;
  return n;
}

type RawAction = Extract<ObtainAction, { kind: 'gather' | 'mine' | 'hunt' }>;

/** The leaf's action, or a reason (no rule). Track E2: a smelted material is its raw input's (mined) action. */
function leafAction(leaf: ChainLeaf): RawAction | { kind: 'none'; reason: string } {
  if (isLog(leaf.item) || leaf.item === 'minecraft:logs') return { kind: 'gather', n: leaf.n, command: `gather ${leaf.n}` };
  if (isWool(leaf.item)) return { kind: 'hunt', mob: 'sheep', item: leaf.item, n: leaf.n, command: `kill sheep ${leaf.n}` };
  const block = minedBlockFor(leaf.item);
  if (block) return { kind: 'mine', block, item: leaf.item, n: leaf.n, command: `mine ${block} ${leaf.n}` };
  return { kind: 'none', reason: `no way to get ${leaf.item} yet (it is not gathered, mined or hunted)` };
}

/** Track E2: a smelted leaf (`iron_ingot`) whose input is mined: the input and its block, or undefined. */
function smeltLeaf(item: string): { inputs: readonly string[]; input: string; block: string } | undefined {
  const inputs = smeltInputsOf(item);
  const input = inputs?.[0];
  const block = input ? minedBlockFor(input) : undefined;
  return inputs && input && block ? { inputs, input, block } : undefined;
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

/** The planner's raw rule: gathered, mined, hunted, or (Track E2) smelted from something mined. */
const rawRule = (n: string): boolean => leafAction({ item: n, n: 1 }).kind !== 'none' || smeltLeaf(n) !== undefined;

/**
 * Track E3: the job never dyes. A recipe with a dye in it is left out of its plans: the server's wool and bed recipes
 * re-dye each colour from the others, and the chain tried them all for every plan (measured: 15 to 53 s of planning a
 * step, the event loop blocked, once the iron kit's bed was planned on the server's full recipe set).
 */
export function noDyeRecipe(r: Recipe): boolean {
  return !r.input.some((i) => !!i && ((i.name !== undefined && /_dye$|^ink_sac$|^bone_meal$|^cocoa_beans$|^lapis_lazuli$/.test(i.name)) || (i.tag?.includes('dye') ?? false)));
}
const chainOpts = (o: ObtainOptions): ChainOptions => ({ ...o, raw: rawRule, recipe: o.recipe ? (r) => o.recipe!(r) && noDyeRecipe(r) : noDyeRecipe });

/** The inventory as it would be with every smelt leaf's input smelted (the wood and fuel the crafts leave). */
function smelted(slots: Slots, leaves: readonly ChainLeaf[]): (ItemStack | null)[] {
  const out: (ItemStack | null)[] = slots.slice(0, 36).map((s) => (s ? { ...s } : null));
  for (const l of leaves) {
    const s = smeltLeaf(l.item);
    if (!s) continue;
    let left = l.n;
    for (let i = 0; i < out.length && left > 0; i++) {
      const it = out[i];
      if (!it || !s.inputs.includes(it.name)) continue;
      const k = Math.min(it.count, left);
      left -= k;
      out[i] = it.count === k ? null : { ...it, count: it.count - k };
    }
    out.push({ name: l.item, networkId: 0, count: l.n, metadata: 0 });
  }
  return out;
}

/**
 * Items the fuel the crafts leave smelts: of each carried kind, what `planChain` leaves in the pool (no more than is
 * carried now: planks the crafts would make from a log are not fuel yet, and the furnace may burn that log first).
 */
function fuelLeft(index: Index, targets: readonly ObtainTarget[], slots: Slots, o: ChainOptions): { items: number; logs: number } {
  const p = planChain(index, targets, slots, o);
  let items = 0;
  let logs = 0;
  for (const [name, left] of p.left ?? new Map<string, number>()) {
    const c = Math.min(left, carried(slots, name));
    if (c <= 0) continue;
    items += c * fuelValue(name);
    if (isLog(name)) logs += c;
  }
  return { items: Math.floor(items), logs };
}

/**
 * Track E2: the soft targets the material still covers. With nothing capped every target stays; a capped raw material
 * (`raw_iron` after a short mine step) keeps a soft target only while the hard ones and the soft ones before it need no
 * more of what it smelts into than is carried (inputs and outputs both).
 */
export function affordable(index: Index, targets: readonly ObtainTarget[], slots: Slots, o: ObtainOptions): { kept: ObtainTarget[]; dropped: ObtainTarget[] } {
  const capped = o.capped;
  if (!capped || capped.size === 0 || !targets.some((t) => t.soft)) return { kept: [...targets], dropped: [] };
  const kept: ObtainTarget[] = targets.filter((t) => !t.soft);
  const dropped: ObtainTarget[] = [];
  const oo: ChainOptions = chainOpts(o);
  const missing = (list: readonly ObtainTarget[]) => {
    const need = list.filter((t) => t.item !== 'food' && haveCount(slots, t.item, o.worn) < t.n).map((t) => ({ item: t.item, n: t.n - haveCount(slots, t.item, o.worn) + carried(slots, t.item) }));
    return planChain(index, need, slots, oo).missing.filter((m) => capped.has(smeltLeaf(m.item)?.input ?? m.item));
  };
  const short = (list: readonly ObtainTarget[]): boolean => {
    for (const m of missing(list)) {
      const s = smeltLeaf(m.item);
      if (m.n > (s ? countOf(slots, s.inputs) : 0)) return true;
    }
    return false;
  };
  // Track E3: what a target adds of the capped materials (a bed needs no iron: the iron kit's short ore keeps it)
  const cappedNeed = (list: readonly ObtainTarget[]): number => missing(list).reduce((x, m) => x + m.n, 0);
  for (const t of targets) {
    if (!t.soft) continue;
    if (haveCount(slots, t.item, o.worn) >= t.n || !short([...kept, t]) || cappedNeed([...kept, t]) <= cappedNeed(kept)) kept.push(t);
    else dropped.push(t);
  }
  // keep the original order
  return { kept: targets.filter((t) => kept.includes(t)), dropped };
}

/**
 * The next command towards `targets` (each `n` in all: what is carried or worn counts). `craft` makes one target (the
 * `!craft` command chains its ingredients); the others get a raw material, smelt, set a furnace down or cook.
 */
export function nextAction(index: Index, targets: readonly ObtainTarget[], carriedSlots: Slots, o: ObtainOptions = {}, depth = 0): ObtainAction {
  // Track E4: a worn tool is not carried for the plan (a step that needs a tool makes a fresh one first)
  const slots = o.toolOk ? usableSlots(carriedSlots, o.toolOk) : carriedSlots;
  // Track E3: a `last` target waits for the others
  if (targets.some((t) => t.last) && targets.some((t) => !t.last)) {
    const first = nextAction(index, targets.filter((t) => !t.last), slots, o, depth);
    if (first.kind !== 'done') return first;
  }
  const all = affordable(index, targets, slots, o).kept;
  const worn = (item: string): number => haveCount(slots, item, o.worn) - carried(slots, item);
  // the furnace target is met by one standing where the cooker looks; one carried is set down
  const furnaceT = all.find((t) => t.item === 'furnace');
  if (furnaceT && !o.furnaceNear && carried(slots, 'furnace') >= 1) return { kind: 'furnace', command: 'furnace' };
  // Track E3: the bed target is met by one standing where the night rule sleeps; one carried is set down
  const bedT = all.find((t) => t.item === 'bed');
  if (bedT && !o.bedNear && carried(slots, 'bed') >= 1) return { kind: 'bed', command: 'bed' };
  const items = all.filter((t) => t.item !== 'food' && !(t.item === 'furnace' && o.furnaceNear) && !(t.item === 'bed' && o.bedNear));
  // worn armour and the offhand's shield count as carried: the chain plans what is short of the rest
  const short = items.filter((t) => haveCount(slots, t.item, o.worn) < t.n).map((t) => ({ ...t, n: t.n - worn(t.item) }));
  const oo: ChainOptions = chainOpts(o);
  const plan = planChain(index, short, slots, oo);
  if (short.length > 0 && plan.missing.length === 0) {
    // everything can be crafted now: the first short target (its chain is crafted with it)
    const t = short.find((x) => index.byOutput(x.item).length > 0);
    if (!t) return { kind: 'stuck', reason: `no recipe for ${short[0]!.item}` };
    const n = t.n - carried(slots, t.item);
    return { kind: 'craft', item: t.item, n, command: `craft ${t.item} ${n}` };
  }
  if (short.length > 0) {
    const acts: RawAction[] = [];
    const smelts: { item: string; input: string; n: number }[] = [];
    let logs = 0;
    for (const leaf of plan.missing) {
      const s = smeltLeaf(leaf.item);
      if (s) {
        // Track E2: mined first, then smelted
        const have = countOf(slots, s.inputs);
        if (have < leaf.n) acts.push({ kind: 'mine', block: s.block, item: s.input, n: leaf.n - have, command: `mine ${s.block} ${leaf.n - have}` });
        else smelts.push({ item: leaf.item, input: s.input, n: leaf.n });
        continue;
      }
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
    for (const un of acts) {
      if (un.kind !== 'mine' || canHarvestWith(slots, un.block)) continue;
      const pick = pickaxeFor(un.block);
      if ('reason' in pick) return { kind: 'stuck', reason: pick.reason };
      if (!all.some((t) => t.item === pick.item)) {
        if (depth >= MAX_PICK_DEPTH) return { kind: 'stuck', reason: `no tool harvests ${un.block}` };
        return nextAction(index, [{ item: pick.item, n: 1 }, ...all], slots, o, depth + 1);
      }
    }
    // Track E2: the fuel the smelts will want, when the trip for the crafts' logs goes anyway (planks from the extra logs)
    if (logs > 0 && !o.coalNear) {
      const need = plan.missing.reduce((a, l) => a + (smeltLeaf(l.item) ? l.n : 0), 0);
      if (need > 0) {
        const f = fuelLeft(index, short, smelted(slots, plan.missing), oo);
        if (f.items < need) logs += Math.ceil((need - f.items) / PLANK_ITEMS_PER_LOG);
      }
    }
    // the logs for every target in one trip
    if (logs > 0) return { kind: 'gather', n: logs, command: gatherCommand(slots, logs) };
    // a target the inventory makes on its own now (the pickaxe the mining needs, the table)
    for (const t of short) {
      if (index.byOutput(t.item).length === 0) continue;
      if (planChain(index, [t], slots, oo).missing.length > 0) continue;
      const n = t.n - carried(slots, t.item);
      return { kind: 'craft', item: t.item, n, command: `craft ${t.item} ${n}` };
    }
    if (acts.length > 0) {
      acts.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
      // one mine step for every block of the same kind (the iron of the tools and of the armour in one trip)
      const a = acts[0]!;
      if (a.kind === 'mine' && !canHarvestWith(slots, a.block)) return { kind: 'stuck', reason: `no tool harvests ${a.block}` };
      if (a.kind === 'mine') {
        const n = acts.reduce((x, b) => x + (b.kind === 'mine' && b.block === a.block ? b.n : 0), 0);
        return { ...a, n, command: `mine ${a.block} ${n}` };
      }
      return a;
    }
    // Track E2: everything mined: the smelts, after a furnace and the fuel
    const s = smelts[0];
    if (s) {
      if (!o.furnaceNear) {
        if (carried(slots, 'furnace') >= 1) return { kind: 'furnace', command: 'furnace' };
        if (all.some((t) => t.item === 'furnace')) return { kind: 'stuck', reason: 'no furnace (it was crafted and not set down)' };
        return nextAction(index, [{ item: 'furnace', n: 1 }, ...all], slots, o, depth);
      }
      const n = smelts.filter((x) => x.input === s.input).reduce((a, x) => a + x.n, 0);
      // the fuel for the raw food the job cooks afterwards comes in the same step
      const cook = all.some((t) => t.item === 'food') ? rawCount(slots) : 0;
      const fuel = fuelFor(index, short, slots, plan.missing, n + cook, oo, o.coalNear === true);
      if (fuel) return fuel;
      return { kind: 'smelt', item: s.item, input: s.input, n, command: `smelt ${s.input} ${n}` };
    }
    return { kind: 'stuck', reason: `no step for ${plan.missing.map((m) => m.item).join(', ')}` };
  }
  // Track E2: raw food carried, a furnace near and fuel to spare: cooked before the food is counted
  const food = all.find((t) => t.item === 'food');
  const raw = rawCount(slots);
  if (food && raw > 0 && o.furnaceNear) {
    const fuel = fuelFor(index, [], slots, [], raw, chainOpts(o), o.coalNear === true);
    if (!fuel) return { kind: 'cook', n: raw, command: 'cook' };
    // fuel within reach (coal near, logs carried to make planks of): fetched; else the raw food counts as it is
    if (fuel.kind !== 'gather') return fuel;
  }
  if (food) {
    const have = foodCarried(slots);
    if (have < food.n) return { kind: 'food', n: food.n - have, command: `food ${food.n - have}` };
  }
  return { kind: 'done' };
}

/** Raw food items carried (what the cook step cooks). */
function rawCount(slots: Slots): number {
  return [...rawFoodCounts(slots).values()].reduce((a, b) => a + b, 0);
}

/**
 * Track E2: the step that gets fuel for `n` items, or undefined when what the crafts leave covers it. Coal ore near
 * first (8 items a coal), then planks from the logs left (6 a log), then logs.
 */
function fuelFor(index: Index, short: readonly ObtainTarget[], slots: Slots, missing: readonly ChainLeaf[], n: number, o: ChainOptions, coalNear: boolean): ObtainAction | undefined {
  const f = fuelLeft(index, short, smelted(slots, missing), o);
  if (f.items >= n) return undefined;
  const lack = n - f.items;
  // coal only with a carried tool that harvests it (measured on a fresh world: the pickaxes wore out on the iron, and
  // `!mine coal_ore 2` got nothing, `no tool in the inventory harvests coal_ore`); else the logs
  if (coalNear && canHarvestWith(slots, 'coal_ore')) {
    const k = Math.ceil(lack / 8);
    return { kind: 'mine', block: 'coal_ore', item: 'coal', n: k, command: `mine coal_ore ${k}` };
  }
  if (f.logs > 0) {
    // planks from the logs the crafts leave: each turns 1.5 items of fuel into 6
    const logs = Math.min(f.logs, Math.ceil(lack / (PLANK_ITEMS_PER_LOG - 1.5)));
    const log = [...(planChain(index, short, smelted(slots, missing), o).left ?? new Map<string, number>())].find(([k, c]) => isLog(k) && c > 0)?.[0] ?? 'oak_log';
    const planks = log.replace(/_(log|wood)$/, '_planks');
    const k = 4 * logs;
    if (index.byOutput(planks).length > 0) return { kind: 'craft', item: planks, n: k, command: `craft ${planks} ${k}` };
  }
  const k = Math.ceil(lack / PLANK_ITEMS_PER_LOG);
  return { kind: 'gather', n: k, command: gatherCommand(slots, k) };
}

/**
 * Track E5: the `!gather` command that gets `n` logs more than are carried. `!gather N` with no chest ends once N logs
 * are carried (a total), so the logs carried are added. Measured on a fresh mountain world: 2 oak logs carried, the
 * iron kit's fuel step `!gather 1` ended at once (`gather done: 2/1 logs`), got nothing, and the job stopped.
 */
export function gatherCommand(slots: Slots, n: number): string {
  let have = 0;
  for (const s of slots.slice(0, 36)) if (s && s.count > 0 && gatherCounts(s.name)) have += s.count;
  return `gather ${n + have}`;
}

/** `white_bed` and the other colours name the bed item on Bedrock (its colour follows the wool). */
export function itemAlias(name: string): string {
  return /^[a-z_]+_bed$/.test(name) ? 'bed' : name;
}
