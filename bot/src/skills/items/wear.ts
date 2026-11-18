// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): worn tools in the obtain job.
//
// The worn-tool rule (docs/survival.md, skills/survival/tools.ts `makeToolOk`): a tool with `toolWearLimit` uses left or
// fewer is not chosen by the Digger, so for the job a worn pickaxe harvests nothing. The planner (obtain.ts) plans on
// the usable inventory: a worn tool counts as not carried, so a step that needs a tool (stone needs a pickaxe) gets a
// fresh one first through the planner's own pickaxe rule, crafted from what is carried or cheap to get (3 cobblestone
// for a stone pickaxe). A worn tool is never an ingredient (chain.ts `neverConsume`), so dropping it from the plan's
// inventory changes nothing else. Pure: the inventory and the rule in, the answer out.
import type { ItemStack } from '../../world/types.ts';
import { maxDurability } from '../survival/tools.ts';

type Slots = readonly (ItemStack | null | undefined)[];
export type ToolOk = (item: ItemStack) => boolean;

/** The tool kinds a worn one is replaced by (one of the same kind, any tier). */
const KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'] as const;
export type ToolKind = (typeof KINDS)[number];

/** `stone_pickaxe` -> `pickaxe`; undefined for anything that is not a tool or a blade. */
export function toolKind(name: string): ToolKind | undefined {
  const k = name.slice(name.lastIndexOf('_') + 1);
  return (KINDS as readonly string[]).includes(k) && maxDurability(name) !== undefined ? (k as ToolKind) : undefined;
}

/** A carried item with durability that the rule refuses (worn down to the limit, or set aside to be mended). */
export function isWorn(s: ItemStack | null | undefined, toolOk: ToolOk): boolean {
  return !!s && s.count > 0 && maxDurability(s.name) !== undefined && !toolOk(s);
}

/** The main inventory (0 to 35) with every worn item left out: what the planner may count on. */
export function usableSlots(slots: Slots, toolOk: ToolOk): (ItemStack | null)[] {
  return slots.slice(0, 36).map((s) => (s && !isWorn(s, toolOk) ? s : null));
}

/** Worn tools carried, by name (`['stone_pickaxe']`). */
export function wornTools(slots: Slots, toolOk: ToolOk): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s && isWorn(s, toolOk) && toolKind(s.name)) out.push(s.name);
  }
  return out;
}

/**
 * The worn tool a craft of `item` replaced: one of the same kind carried worn before the craft (`stone_pickaxe` for a
 * new stone or iron pickaxe), undefined when the craft replaced nothing.
 */
export function replacedBy(before: Slots, item: string, toolOk: ToolOk): string | undefined {
  const kind = toolKind(item);
  if (!kind) return undefined;
  const worn = wornTools(before, toolOk).filter((n) => toolKind(n) === kind);
  return worn.find((n) => n === item) ?? worn[0];
}
