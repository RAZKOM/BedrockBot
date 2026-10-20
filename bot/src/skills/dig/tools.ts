// Tool selection (PLAN.md task 4.2): the hotbar slot that breaks a block fastest.
import { blockMining, toolOf, type BlockMining } from '../../data/mining.ts';
import { estimateBreak, type BreakConditions, type BreakEstimate } from './breakTime.ts';

/** Hotbar slots are inventory slots 0..8. */
export const HOTBAR_SIZE = 9;

/** The minimum an inventory slot needs to expose (World's ItemStack satisfies it). */
export interface SlotItem {
  name: string;
}

export interface ToolChoice extends BreakEstimate {
  /** Hotbar slot 0..8. */
  slot: number;
  /** Item in that slot (null = empty hand). */
  item: string | null;
}

/**
 * Picks the hotbar slot for breaking `block`:
 * 1. fewest ticks;
 * 2. on a tie, a slot whose item drops the block over one that does not;
 * 3. then a slot that does not hold a tool (no durability spent on a block the tool does not help
 *    with: dirt with an axe in hand is broken from an empty slot when there is one);
 * 4. then the currently selected slot (no switch);
 * 5. then the lowest slot.
 * `slots` are inventory slots; only 0..8 are considered.
 */
export function chooseTool(
  block: BlockMining | string,
  slots: readonly (SlotItem | null | undefined)[],
  selected: number,
  cond?: BreakConditions,
): ToolChoice | undefined {
  const b = typeof block === 'string' ? blockMining(block) : block;
  if (!b) return undefined;
  let best: (ToolChoice & { isTool: boolean }) | undefined;
  for (let slot = 0; slot < HOTBAR_SIZE; slot++) {
    const item = slots[slot]?.name ?? null;
    const tool = toolOf(item);
    const est = estimateBreak(b, tool, cond);
    const cand = { ...est, slot, item, isTool: tool !== null };
    if (!best || better(cand, best, selected)) best = cand;
  }
  if (!best) return undefined;
  const { isTool: _isTool, ...choice } = best;
  return choice;
}

function better(a: ToolChoice & { isTool: boolean }, b: ToolChoice & { isTool: boolean }, selected: number): boolean {
  if (a.ticks !== b.ticks) return a.ticks < b.ticks;
  if (a.canHarvest !== b.canHarvest) return a.canHarvest;
  if (a.isTool !== b.isTool) return !a.isTool;
  if ((a.slot === selected) !== (b.slot === selected)) return a.slot === selected;
  return a.slot < b.slot;
}
