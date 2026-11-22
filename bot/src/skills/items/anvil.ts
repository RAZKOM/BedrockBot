// Track K7 (ADR 0121, docs/flight.md "Renewing an elytra at an anvil (Track K7)"): the anvil's rules as the bot plans
// with them. Pure: the pieces in, the operation, its cost and its result out. Measured on BDS 1.26.60.6 (bds-farm,
// test/e2e/repair.test.ts `REPAIR_PROBE=ops`, the levels paid read from the experience attribute, the result from the
// server's durability and the item's NBT after a resync):
//
//   material   each unit of the repair material gives back a quarter of the maximum (a phantom membrane 108 of an
//              elytra's 432); exactly the units the damage needs are consumed: ceil(damage / 108) (4 placed with 3
//              needed: consuming 4 is refused, 3 leaves one in the slot); 1 level a unit
//   combine    two of the same item: the uses of both plus 12 % of the maximum (51 for an elytra), at most the maximum;
//              2 levels for the repair when the target is damaged (none when it is full); the enchantments merged
//   enchants   an enchantment the sacrifice brings and the target lacks costs its level times the multiplier: Mending
//              4 from an item, 2 from a book; Unbreaking 2 a level from an item; one the target already has at the same
//              level costs nothing (Mending + Mending, Unbreaking III + Unbreaking III: 2 levels, the repair alone)
//   penalty    the item's prior-work tag (NBT `RepairCost`): 0, then 2 x the larger tag of the two + 1 after each
//              operation (0 -> 1 -> 3 -> 7 -> 15 -> 31); every operation also costs both pieces' tags in levels
//   rename     1 level, no penalty; an operation that does not send the item's own name back clears it (+1 level)
//   too dear   an operation of 40 levels or more is refused ("too expensive", status 9, the status too few levels
//              get); 39 and 38 were paid
//
// Only the elytra was measured. The other items' materials and the enchantment multipliers the elytra cannot carry are
// the game's documented values, used as the best estimate: a wrong estimate costs a refusal (the server computes the
// cost itself and refuses what the levels do not cover), never levels the bot did not count.
import type { ItemStack } from '../../world/types.ts';
import { durabilityLeft, ENCH_MENDING, ENCH_UNBREAKING, maxDurability } from '../survival/tools.ts';

export const ANVIL_BLOCKS: ReadonlySet<string> = new Set(['anvil', 'chipped_anvil', 'damaged_anvil']);
export const isAnvil = (name: string | undefined): boolean => name !== undefined && ANVIL_BLOCKS.has(name.replace(/^minecraft:/, ''));

/** The anvil refuses an operation that costs this many levels or more (measured: 40 refused, 39 paid). */
export const TOO_EXPENSIVE = 40;
/** A unit of the repair material gives back this share of the maximum (measured: 108 of an elytra's 432). */
export const UNIT_SHARE = 0.25;
/** Two pieces combined: both pieces' uses plus this share of the maximum (measured: 51 for an elytra). */
export const COMBINE_BONUS = 0.12;
/** Levels a combine costs for the repair itself when the target is damaged (measured: 2; 0 onto a full target). */
export const COMBINE_LEVELS = 2;
/** Levels a unit of material costs (measured). */
export const UNIT_LEVELS = 1;

export const PHANTOM_MEMBRANE = 'phantom_membrane';
const PLANKS = ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks', 'pale_oak_planks'];

/** The repair material of an item (several names: any of them), undefined: none (combine only). The elytra's is measured. */
export function repairMaterials(name: string): readonly string[] | undefined {
  const n = name.replace(/^minecraft:/, '');
  if (n === 'elytra') return [PHANTOM_MEMBRANE];
  if (n === 'turtle_helmet') return ['turtle_scute'];
  if (n === 'shield') return PLANKS;
  if (n === 'mace') return ['breeze_rod'];
  const tier = n.slice(0, n.lastIndexOf('_'));
  if (maxDurability(n) === undefined) return undefined;
  switch (tier) {
    case 'netherite':
      return ['netherite_ingot'];
    case 'diamond':
      return ['diamond'];
    case 'iron':
    case 'chainmail':
      return ['iron_ingot'];
    case 'golden':
      return ['gold_ingot'];
    case 'leather':
      return ['leather'];
    case 'stone':
      return ['cobblestone', 'cobbled_deepslate', 'blackstone'];
    case 'wooden':
      return PLANKS;
    default:
      return undefined;
  }
}

/**
 * The multiplier of an enchantment brought by an item sacrifice (a book: half, at least 1). Measured: Mending 4 (book
 * 2), Unbreaking 2; the rest are the game's documented rarities (common 1, uncommon 2, rare 4, very rare 8).
 */
const MULTIPLIER: Readonly<Record<number, number>> = {
  0: 1, // protection
  1: 2, // fire protection
  2: 2, // feather falling
  3: 4, // blast protection
  4: 2, // projectile protection
  5: 8, // thorns
  6: 4, // respiration
  7: 4, // depth strider
  8: 4, // aqua affinity
  9: 1, // sharpness
  10: 2, // smite
  11: 2, // bane of arthropods
  12: 2, // knockback
  13: 4, // fire aspect
  14: 4, // looting
  15: 1, // efficiency
  16: 8, // silk touch
  [ENCH_UNBREAKING]: 2,
  18: 4, // fortune
  19: 1, // power
  20: 4, // punch
  21: 4, // flame
  22: 8, // infinity
  23: 4, // luck of the sea
  24: 4, // lure
  25: 4, // frost walker
  [ENCH_MENDING]: 4,
  27: 8, // curse of binding
  28: 8, // curse of vanishing
  29: 4, // impaling
  30: 4, // riptide
  31: 1, // loyalty
  32: 8, // channeling
  33: 4, // multishot
  34: 1, // piercing
  35: 2, // quick charge
  36: 8, // soul speed
  37: 8, // swift sneak
  38: 4, // wind burst
  39: 2, // density
  40: 4, // breach
};
/** The highest level of an enchantment (a merge of two equal levels below it goes one up, the game's rule; unmeasured). */
const MAX_LEVEL: Readonly<Record<number, number>> = { 0: 4, 1: 4, 2: 4, 3: 4, 4: 4, 5: 3, 6: 3, 7: 3, 9: 5, 10: 5, 11: 5, 12: 2, 13: 2, 14: 3, 15: 5, [ENCH_UNBREAKING]: 3, 18: 3, 19: 5, 20: 2, 23: 3, 24: 3, 25: 2, 29: 5, 30: 3, 31: 3, 33: 1, 34: 4, 35: 3, 36: 3, 37: 3, 38: 3, 39: 5, 40: 4 };

export const multiplierOf = (id: number, book = false): number => {
  const m = MULTIPLIER[id] ?? 8;
  return book ? Math.max(1, Math.floor(m / 2)) : m;
};

export interface Ench {
  id: number;
  lvl: number;
}

/** A piece as the anvil sees it. */
export interface AnvilPiece {
  name: string;
  /** Uses left (an enchanted book: 0). */
  left: number;
  max: number;
  /** The prior-work tag (NBT `RepairCost`; 0 without). */
  repairCost: number;
  enchants: readonly Ench[];
  /** The custom name (sent back with the operation, so it is kept and costs nothing). */
  customName?: string;
  /** An enchanted book (the sacrifice of an enchantment only). */
  book?: boolean;
}

/** The prior-work tag of a raw wire item (`extra.nbt.nbt.value.RepairCost`), 0 without one. */
export function repairCostOf(raw: unknown): number {
  const v = (raw as { extra?: { nbt?: { nbt?: { value?: { RepairCost?: { value?: unknown } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.RepairCost?.value;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The anvil's view of an inventory item (the tag and the name from the item, else its raw wire item); undefined without durability. */
export function pieceOf(it: Pick<ItemStack, 'name' | 'damage' | 'enchants' | 'repairCost' | 'customName'>, raw?: unknown): AnvilPiece | undefined {
  const max = maxDurability(it.name);
  if (max === undefined) return undefined;
  const name = it.customName ?? customNameOf(raw);
  return { name: it.name.replace(/^minecraft:/, ''), left: durabilityLeft(it) ?? max, max, repairCost: it.repairCost ?? repairCostOf(raw), enchants: (it.enchants ?? []).map((e) => ({ id: e.id, lvl: e.lvl })), ...(name !== undefined ? { customName: name } : {}) };
}

/** The anvil name of a raw wire item (`extra.nbt.nbt.value.display.Name`), undefined without one. */
export function customNameOf(raw: unknown): string | undefined {
  const v = (raw as { extra?: { nbt?: { nbt?: { value?: { display?: { value?: { Name?: { value?: unknown } } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.display?.value?.Name?.value;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The tag after an operation on pieces tagged `a` and `b` (measured: 2 x the larger + 1). */
export const nextPenalty = (a: number, b = 0): number => 2 * Math.max(a, b) + 1;

/** The cheapest operation an item with tag `rc` can still have: one unit of material (`extra` 1) or a combine (2). */
export const minCost = (rc: number, extra = UNIT_LEVELS): number => rc + extra;

/** How many operations the item can still have before every one costs TOO_EXPENSIVE or more (the cheapest kind each time). */
export function renewalsLeft(rc: number, extra = UNIT_LEVELS): number {
  let n = 0;
  for (let r = rc; minCost(r, extra) < TOO_EXPENSIVE && n < 64; r = nextPenalty(r)) n++;
  return n;
}

/** The enchantments after `target` takes `sacrifice`'s, and the levels they cost (see the file comment). */
export function mergeEnchants(target: readonly Ench[], sacrifice: readonly Ench[], book = false): { enchants: Ench[]; cost: number } {
  const out = target.map((e) => ({ ...e }));
  let cost = 0;
  for (const s of sacrifice) {
    const t = out.find((e) => e.id === s.id);
    const max = MAX_LEVEL[s.id] ?? 1;
    if (!t) {
      out.push({ id: s.id, lvl: s.lvl });
      cost += s.lvl * multiplierOf(s.id, book);
      continue;
    }
    // (measured: an equal level at its maximum costs nothing; the rest is the game's rule as documented, unmeasured)
    const lvl = t.lvl === s.lvl ? Math.min(max, t.lvl + 1) : Math.max(t.lvl, s.lvl);
    if (lvl > t.lvl) cost += lvl * multiplierOf(s.id, book);
    t.lvl = lvl;
  }
  return { enchants: out.sort((a, b) => a.id - b.id), cost };
}

export type AnvilKind = 'material' | 'combine' | 'book';

/** One planned operation. */
export interface AnvilOp {
  kind: AnvilKind;
  target: AnvilPiece;
  /** combine / book: the piece used up. */
  sacrifice?: AnvilPiece;
  /** material: the units consumed and the material. */
  units?: number;
  material?: string;
  /** Levels it costs. */
  cost: number;
  /** The piece afterwards. */
  result: { left: number; repairCost: number; enchants: Ench[] };
  /** Uses gained by the target. */
  gain: number;
}

/** Units of material the damage needs (at most `have`): ceil(damage / unit), as the server takes them. */
export function unitsNeeded(p: Pick<AnvilPiece, 'left' | 'max'>, have = Infinity): number {
  const unit = Math.floor(p.max * UNIT_SHARE);
  const damage = p.max - p.left;
  if (damage <= 0 || unit <= 0) return 0;
  return Math.max(0, Math.min(have, Math.ceil(damage / unit)));
}

/** A repair with `have` units of material (undefined: nothing to repair or no material). */
export function materialOp(target: AnvilPiece, material: string, have: number): AnvilOp | undefined {
  const units = unitsNeeded(target, have);
  if (units <= 0) return undefined;
  const unit = Math.floor(target.max * UNIT_SHARE);
  const left = Math.min(target.max, target.left + units * unit);
  return { kind: 'material', target, units, material, cost: target.repairCost + units * UNIT_LEVELS, result: { left, repairCost: nextPenalty(target.repairCost), enchants: target.enchants.map((e) => ({ ...e })) }, gain: left - target.left };
}

/** `target` takes `sacrifice` (another of the same item, or an enchanted book). */
export function combineOp(target: AnvilPiece, sacrifice: AnvilPiece): AnvilOp {
  const book = sacrifice.book === true;
  const m = mergeEnchants(target.enchants, sacrifice.enchants, book);
  const damaged = target.left < target.max;
  const left = book ? target.left : Math.min(target.max, target.left + sacrifice.left + Math.floor(target.max * COMBINE_BONUS));
  const repair = !book && damaged ? COMBINE_LEVELS : 0;
  return {
    kind: book ? 'book' : 'combine',
    target,
    sacrifice,
    cost: target.repairCost + sacrifice.repairCost + repair + m.cost,
    result: { left, repairCost: nextPenalty(target.repairCost, sacrifice.repairCost), enchants: m.enchants },
    gain: left - target.left,
  };
}

/**
 * Which of two pieces of the same item is the base (the anvil's target) in a combine: the result has both pieces'
 * enchantments and the same uses either way, so the base is the one that costs fewer levels: the piece whose
 * enchantments the other lacks (measured: a Mending elytra as the base 2 levels, as the sacrifice 6). On a tie the
 * piece at hand (`a`). `why` names the reason for the reply.
 */
export function chooseBase(a: AnvilPiece, b: AnvilPiece): { op: AnvilOp; base: 'a' | 'b'; why: string } {
  const ab = combineOp(a, b);
  const ba = combineOp(b, a);
  const lacks = (x: AnvilPiece, y: AnvilPiece): string[] => x.enchants.filter((e) => !y.enchants.some((f) => f.id === e.id && f.lvl >= e.lvl)).map((e) => enchantName(e));
  if (ba.cost < ab.cost) {
    const what = lacks(b, a);
    return { op: ba, base: 'b', why: `the other one is the base: ${what.length ? `its ${what.join(' and ')} stays at no cost` : 'it costs fewer levels'} (${ba.cost} levels, the other way round ${ab.cost})` };
  }
  const what = lacks(a, b);
  if (ab.cost < ba.cost) return { op: ab, base: 'a', why: `it is the base: ${what.length ? `its ${what.join(' and ')} stays at no cost` : 'it costs fewer levels'} (${ab.cost} levels, the other way round ${ba.cost})` };
  return { op: ab, base: 'a', why: `it is the base (the one at hand; either way ${ab.cost} levels)` };
}

const ENCH_NAMES: Readonly<Record<number, string>> = { [ENCH_MENDING]: 'Mending', [ENCH_UNBREAKING]: 'Unbreaking', 27: 'Curse of Binding', 28: 'Curse of Vanishing' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export function enchantName(e: Ench): string {
  const n = ENCH_NAMES[e.id] ?? `enchantment ${e.id}`;
  return (MAX_LEVEL[e.id] ?? 1) > 1 ? `${n} ${ROMAN[e.lvl] ?? e.lvl}` : n;
}

/** Why an operation is not paid now (undefined: it may be). */
export interface OpRefusal {
  kind: 'nothing' | 'levels' | 'expensive' | 'last' | 'unknown_levels';
  why: string;
}

/**
 * The checks before the bot pays (the owner: never too expensive by accident): something to gain, under TOO_EXPENSIVE,
 * the levels it has, and not the item's last renewal unless `last` (after it every operation would cost TOO_EXPENSIVE
 * or more: the reply says the penalty and the next cost first).
 */
export function checkOp(op: AnvilOp, levels: number | undefined, o: { last?: boolean } = {}): OpRefusal | undefined {
  const adds = op.result.enchants.some((e) => !op.target.enchants.some((t) => t.id === e.id && t.lvl >= e.lvl));
  if (op.gain <= 0 && !adds) return { kind: 'nothing', why: `nothing to gain: the ${op.target.name.replace(/_/g, ' ')} would stay at ${op.result.left}/${op.target.max}` };
  if (op.cost >= TOO_EXPENSIVE) return { kind: 'expensive', why: `too expensive: it would cost ${op.cost} levels and the anvil refuses ${TOO_EXPENSIVE} or more (prior-work penalty ${op.target.repairCost}${op.sacrifice ? ` + ${op.sacrifice.repairCost}` : ''})` };
  if (levels === undefined) return { kind: 'unknown_levels', why: 'my experience level is not known yet' };
  if (levels < op.cost) return { kind: 'levels', why: `not enough levels: it costs ${op.cost} and I have ${levels}` };
  if (!o.last && renewalsLeft(op.result.repairCost) === 0) return { kind: 'last', why: `this would be its last renewal: it costs ${op.cost} levels and leaves the prior-work penalty at ${op.result.repairCost}, so the next one would cost ${minCost(op.result.repairCost)} or more (too expensive)` };
  return undefined;
}

/** `prior-work penalty 0 -> 1 (the next renewal 2 levels or more, 5 more before too expensive)`. */
export function penaltyLine(op: AnvilOp): string {
  const after = op.result.repairCost;
  const left = renewalsLeft(after);
  const before = op.sacrifice && op.sacrifice.repairCost > 0 ? `${op.target.repairCost} (+${op.sacrifice.repairCost})` : String(op.target.repairCost);
  return `prior-work penalty ${before} -> ${after} (${left > 0 ? `the next renewal ${minCost(after)} levels or more, ${left} more before too expensive` : 'no renewal after this one: too expensive'})`;
}

/** `elytra 132/432 (Mending, penalty 3)`. */
export function pieceText(p: AnvilPiece): string {
  const tags = [...p.enchants.map((e) => enchantName(e)), ...(p.repairCost > 0 ? [`penalty ${p.repairCost}`] : [])];
  return p.book ? `an enchanted book (${tags.join(', ') || 'nothing'})` : `${p.name} ${p.left}/${p.max}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}
