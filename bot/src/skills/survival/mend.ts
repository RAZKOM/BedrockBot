// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): mending what the bot uses from the experience it gathers
// itself. Pure rules here; the hand that holds a piece while experience comes in is tasks/mend-hand.ts, `!mend` and the
// chore tasks/process/mend.ts, the wiring chat/commands-mend.ts.
//
// Measured on BDS 1.26.60.6 (test/e2e/mend.test.ts MEND_PROBE, n3 a case): one experience orb summoned is one point;
// a point picked up mends 2 uses of one damaged Mending piece worn (any armour slot, the elytra on the back) or held
// (the main hand; the offhand for what the offhand takes: a shield); a piece only carried gets nothing; a point that
// mends gives no experience. With several damaged Mending pieces worn or held, each orb goes to one of them, not by
// how damaged they are (an elytra 100/432 damaged, a chestplate 400/528 and leggings 50/495: 7, 3 and 10 of 20 orbs).
// The offhand refuses an elytra (item_stack_request status 55), so a carried piece is mended in the main hand.
//
//   gearPieces   every item with durability the bot wears, holds or carries: where it is, its uses, Mending, set aside
//   turnPiece    the damaged Mending piece that is only carried and gets the hand for the moment experience comes in:
//                a piece set aside to be mended first (it is not used until mended), then the one with the smallest
//                share of its uses left
//   lines        `!mend status`, the `!mend` end line, the `!inv` mark
import { isElytra } from '../fly/kit.ts';
import type { ItemStack } from '../../world/types.ts';
import { durabilityLeft, hasMending, maxDurability, mendReserve, setAsideForMending } from './tools.ts';

/** Uses one experience point mends (measured: 10 orbs of 1 point mended 20 uses, worn or held). */
export const USES_PER_XP = 2;
/** The window ids of the armour and the offhand (world/inventory.ts). */
const WINDOW_ARMOR = 120;
const WINDOW_OFFHAND = 119;

export type PieceWhere = 'worn' | 'offhand' | 'held' | 'carried';

/** One item with durability the bot has. */
export interface MendPiece {
  name: string;
  where: PieceWhere;
  /** Inventory slot (0..35) for `held` and `carried`; the armour slot (0 head .. 3 feet) for `worn`. */
  slot: number;
  left: number;
  max: number;
  mending: boolean;
  /** A Mending piece at its mending reserve: not used until mended (tools.ts setAsideForMending). */
  aside: boolean;
  /** At or under the worn-tool limit: not used; without Mending it cannot be mended. */
  wornOut: boolean;
}

export interface GearInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  window(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

/** Every item with durability the bot wears, holds in the offhand, holds in the hand or carries (slots 0..35). */
export function gearPieces(inv: GearInventory, toolWearLimit: number, mendAt: number): MendPiece[] {
  const out: MendPiece[] = [];
  const add = (it: ItemStack | null | undefined, where: PieceWhere, slot: number): void => {
    if (!it || it.count <= 0) return;
    const max = maxDurability(it.name);
    const left = durabilityLeft(it);
    if (max === undefined || left === undefined) return;
    const mending = hasMending(it);
    const aside = mending && (!!setAsideForMending(it, toolWearLimit, mendAt) || (left <= Math.max(toolWearLimit, mendReserve(it.name, mendAt)) && left < max));
    out.push({ name: it.name, where, slot, left, max, mending, aside, wornOut: left <= toolWearLimit });
  };
  (inv.window(WINDOW_ARMOR)?.slots ?? []).forEach((it, i) => add(it, 'worn', i));
  add(inv.window(WINDOW_OFFHAND)?.slots[0], 'offhand', 0);
  inv.slots.slice(0, 36).forEach((it, i) => add(it, i === inv.selected ? 'held' : 'carried', i));
  return out;
}

/** A Mending piece that takes experience (damaged). */
export const mendable = (p: Pick<MendPiece, 'mending' | 'left' | 'max'>): boolean => p.mending && p.left < p.max;

/** Uses still to mend. */
export const usesToMend = (p: Pick<MendPiece, 'left' | 'max'>): number => Math.max(0, p.max - p.left);

/**
 * The piece that gets the hand while experience comes in (a furnace's output taken, the orbs of a kill, an ore in a
 * `!mend` mine step): of the damaged Mending pieces only carried (a worn or held one mends where it is), a piece set
 * aside first (it is not used until mended: the elytra set aside does not fly), then the one with the smallest share
 * of its uses left (it reaches its limit first); `want` (a name, `!mend <piece>`) only that kind, held pieces too.
 * The pieces worn or held are not moved: the server shares each orb among every damaged Mending piece worn or held.
 */
export function turnPiece(pieces: readonly MendPiece[], want?: string): MendPiece | undefined {
  const can = pieces.filter((p) => mendable(p) && (want ? p.name === want && p.where !== 'worn' && p.where !== 'offhand' : p.where === 'carried'));
  return can.sort((a, b) => Number(b.aside) - Number(a.aside) || a.left / a.max - b.left / b.max || Number(isElytra(b.name)) - Number(isElytra(a.name)) || a.slot - b.slot)[0];
}

/** The damaged Mending pieces, the worst share first (`!mend` works through them in this order). */
export function mendQueue(pieces: readonly MendPiece[], want?: string): MendPiece[] {
  return pieces.filter((p) => mendable(p) && (!want || p.name === want)).sort((a, b) => Number(b.aside) - Number(a.aside) || a.left / a.max - b.left / b.max || a.slot - b.slot);
}

const wearOf = (p: MendPiece): string => (p.left >= p.max ? 'full' : `${p.left}/${p.max}`);

/**
 * `!mend status`: `mend: Mending on elytra 131/432 (set aside), netherite_pickaxe 2030/2031, netherite_sword full; no
 * Mending: netherite_axe, trident (1/250, worn out: cannot be mended)`.
 */
export function mendStatusLine(pieces: readonly MendPiece[]): string {
  if (pieces.length === 0) return 'mend: nothing with durability carried, worn or held';
  const withM = pieces.filter((p) => p.mending).sort((a, b) => a.left / a.max - b.left / b.max);
  const without = pieces.filter((p) => !p.mending);
  const m = withM.map((p) => `${p.name} ${wearOf(p)}${p.aside ? ' (set aside)' : ''}${p.where === 'worn' ? ' (worn)' : ''}`);
  const n = without.map((p) => (p.wornOut ? `${p.name} (${p.left}/${p.max}, worn out: cannot be mended)` : p.name));
  const parts = [withM.length ? `Mending on ${m.join(', ')}` : 'no Mending on anything'];
  if (withM.length && without.length) parts.push(`no Mending: ${n.join(', ')}`);
  else if (!withM.length && without.some((p) => p.wornOut)) parts.push(`worn out: ${n.filter((x) => x.includes('worn out')).join(', ')}`);
  return `mend: ${parts.join('; ')}`;
}

/** Experience points that would mend a piece fully. */
export const pointsToMend = (p: Pick<MendPiece, 'left' | 'max'>): number => Math.ceil(usesToMend(p) / USES_PER_XP);
