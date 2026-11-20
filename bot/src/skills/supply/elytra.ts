// Track K4 (ADR 0108, docs/flight.md "An elytra on hand"): a flyable elytra on hand. Track F20 made the takeoff ask
// whether the elytra covers the trip (fly/wear.ts tripCover) and walk a trip it does not cover; nothing renewed an elytra,
// so once the one on the back was worn every long trip was walked although a better one lay in the inventory, in a
// carried shulker box or in a chest at home. Pure rules here (the wiring: chat/commands-elytra.ts, the process and the
// chore: tasks/process/elytra.ts):
//
//   elytraPieces   every elytra the bot has to hand and its uses: the one on the back, the one the kit would put on
//                  (fly/kit.ts readKit: the first carried), the other loose ones, the ones inside the carried boxes (the
//                  box item's NBT `Items`, each entry's `tag.Damage`), and a count of those in the chests at home
//   chooseElytra   the stock rule: when the elytra at hand does not cover the need (a trip: tripCover; else a number of
//                  uses over its worn limit), the cheapest source first: loose, then a carried box, then the chests at
//                  home (only while they are in reach: K2's rule; the trip readiness never takes them); within a source the
//                  piece with the most uses left that covers the need (see `chooseElytra`)
//   elytraToStore  what the unloader stores: every carried elytra but the best that is low (under ELYTRA_LOW_USES over
//                  its worn limit) and has no Mending: what a swap left behind
//   lines          the status line, the line a refused trip carries, the panel row
import { elytraMax, elytraWornLimit, isElytra } from '../fly/kit.ts';
import { tripCover, tripReach, unbreakingSaid, useShare, type TripShape } from '../fly/wear.ts';
import { durabilityLeft, ENCH_MENDING, ENCH_UNBREAKING, hasMending, unbreakingLevel } from '../survival/tools.ts';
import type { ItemStack } from '../../world/types.ts';

export const ELYTRA = 'elytra';
/** The chore and `!elytra`: an elytra with fewer uses than this over its worn limit is replaced when a better one is to hand (about a flight of 1 500 blocks: reachBlocks). */
export const ELYTRA_LOW_USES = 100;

export type ElytraSource = 'back' | 'kit' | 'loose' | 'box';

/** One elytra the bot has to hand. */
export interface ElytraPiece {
  source: ElytraSource;
  /** Inventory slot (`kit`, `loose`), or the carried box's inventory slot (`box`); undefined on the back. */
  slot?: number;
  /** `box`: the slot inside the box (NBT `Slot`). */
  inBox?: number;
  left: number;
  mending: boolean;
  /** Track F21: the Unbreaking level (0 or absent: none): a trip costs it a share of the uses (fly/wear.ts useShare). */
  unbreaking?: number;
}

export interface ElytraState {
  /** The elytra at hand: on the back, else the one the kit puts on (the first carried); undefined: none. */
  current?: ElytraPiece;
  /** Every other elytra carried loose or inside a carried box. */
  spares: ElytraPiece[];
  /** Elytra in the chests at home by the chest memory (their uses are only known once a chest is opened). */
  home: number;
  /** The chests at home are in reach (HomeLogistics.inReach). */
  homeInReach: boolean;
}

interface BoxNbtEntry {
  Name?: { value?: unknown };
  Count?: { value?: unknown };
  Slot?: { value?: unknown };
  tag?: { value?: { Damage?: { value?: unknown }; ench?: { value?: { value?: unknown } } } };
}

/** The elytra inside a shulker box item (the raw wire item's NBT `Items`): the slot inside the box, the uses left, Mending, the Unbreaking level. */
export function boxElytra(raw: unknown): { inBox: number; left: number; mending: boolean; unbreaking?: number }[] {
  const list = (raw as { extra?: { nbt?: { nbt?: { value?: { Items?: { value?: { value?: unknown } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.Items?.value?.value;
  if (!Array.isArray(list)) return [];
  const out: { inBox: number; left: number; mending: boolean; unbreaking?: number }[] = [];
  list.forEach((e: BoxNbtEntry, i) => {
    const name = e.Name?.value;
    if (typeof name !== 'string' || !isElytra(name)) return;
    const slot = e.Slot?.value;
    const dmg = e.tag?.value?.Damage?.value;
    const ench = e.tag?.value?.ench?.value?.value;
    const es = Array.isArray(ench) ? (ench as { id?: { value?: unknown }; lvl?: { value?: unknown } }[]) : [];
    const mending = es.some((x) => x.id?.value === ENCH_MENDING);
    const ub = es.find((x) => x.id?.value === ENCH_UNBREAKING)?.lvl?.value;
    out.push({ inBox: typeof slot === 'number' ? slot : i, left: Math.max(0, elytraMax() - (typeof dmg === 'number' ? dmg : 0)), mending, ...(typeof ub === 'number' && ub > 0 ? { unbreaking: ub } : {}) });
  });
  return out;
}

/** What `elytraPieces` reads. */
export interface ElytraInventory {
  readonly slots: readonly (ItemStack | null)[];
  rawItem?(window: number, slot: number): unknown;
  window?(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

const pieceOf = (it: ItemStack): { left: number; mending: boolean; unbreaking?: number } => {
  const u = unbreakingLevel(it);
  return { left: durabilityLeft(it) ?? elytraMax(), mending: hasMending(it), ...(u > 0 ? { unbreaking: u } : {}) };
};

/**
 * Every elytra to hand (see the file comment). `boxSlots`: the carried boxes items may come out of (Supply.boxes: not the
 * fireworks box, not one owed to a chest or unknown); `home`: the count in the chests at home and whether they are in reach.
 */
export function elytraPieces(inv: ElytraInventory, boxSlots: readonly number[], home: { count: number; inReach: boolean } = { count: 0, inReach: false }): ElytraState {
  const worn = inv.window?.(120)?.slots[1] ?? null;
  const spares: ElytraPiece[] = [];
  let current: ElytraPiece | undefined = worn && isElytra(worn.name) ? { source: 'back', ...pieceOf(worn) } : undefined;
  inv.slots.slice(0, 36).forEach((s, i) => {
    if (!s || s.count <= 0 || !isElytra(s.name)) return;
    if (!current) current = { source: 'kit', slot: i, ...pieceOf(s) };
    else spares.push({ source: 'loose', slot: i, ...pieceOf(s) });
  });
  for (const b of boxSlots) for (const e of boxElytra(inv.rawItem?.(0, b))) spares.push({ source: 'box', slot: b, inBox: e.inBox, left: e.left, mending: e.mending, ...(e.unbreaking ? { unbreaking: e.unbreaking } : {}) });
  return { ...(current ? { current } : {}), spares, home: Math.max(0, home.count), homeInReach: home.inReach };
}

/** What the elytra must cover: a trip (its blocks and shape: tripCover), or a number of uses over its worn limit (the chore, `!elytra`). */
export type ElytraNeed = { distance: number; shape?: TripShape } | { uses: number };

/** The worn limit of a piece (kit.ts elytraWornLimit: toolWearLimit and the reserve; a Mending elytra's mending reserve). */
export function limitOf(p: Pick<ElytraPiece, 'mending'>, toolWearLimit: number): number {
  return elytraWornLimit(toolWearLimit, { elytraMending: p.mending });
}

/**
 * Track F21: the uses of a bare elytra the piece is worth over its worn limit: its uses over the limit over the share of
 * the gliding seconds that cost it a use (an Unbreaking III elytra with 60 over the limit flies what a bare one with 230
 * does). The stock rule ranks and compares pieces by this, and `{ uses }` needs are counted in it.
 */
export function spendable(p: Pick<ElytraPiece, 'left' | 'mending' | 'unbreaking'>, toolWearLimit: number): number {
  return (p.left - limitOf(p, toolWearLimit)) / useShare(p.unbreaking ?? 0);
}

/** Does the piece cover the need? */
export function covers(p: Pick<ElytraPiece, 'left' | 'mending' | 'unbreaking'>, toolWearLimit: number, need: ElytraNeed): boolean {
  const limit = limitOf(p, toolWearLimit);
  if ('uses' in need) return p.left > limit && spendable(p, toolWearLimit) >= need.uses;
  return p.left > limit && tripCover(p.left, limit, need.distance, need.shape ?? {}, p.unbreaking ?? 0).ok;
}

/**
 * The trip no elytra covers (more than a new one has over the limit): no spare helps. `unbreaking`: the highest
 * Unbreaking level of the elytra to hand (Track F21: a new one of that level is what the question is asked of).
 */
export function neverCovered(toolWearLimit: number, need: ElytraNeed, unbreaking = 0): boolean {
  if ('uses' in need) return need.uses > (elytraMax() - limitOf({ mending: false }, toolWearLimit)) / useShare(unbreaking);
  return tripCover(elytraMax(), limitOf({ mending: false }, toolWearLimit), need.distance, need.shape ?? {}, unbreaking).never;
}

/** Which sources a pass may take from: the carried boxes (a box placed and broken next to the bot), the chests at home (in reach only). */
export interface ElytraAllow {
  boxes: boolean;
  home: boolean;
}

export type ElytraChoice =
  /** The elytra at hand covers the need. */
  | { kind: 'ok'; current: ElytraPiece }
  /** Put this one on (or first in the inventory): a loose spare, or one out of a carried box. */
  | { kind: 'swap'; piece: ElytraPiece; why: string }
  /** No carried spare covers it: an elytra out of the chests at home (in reach; its uses are read at the chest). */
  | { kind: 'home'; why: string }
  /** Nothing to hand covers it. */
  | { kind: 'none'; why: string; never: boolean };

/**
 * The stock rule (see the file comment). Within a source the piece with the most uses left is taken (of those that cover
 * the need): every swap is a body action (an armour swap; a box placed, opened, broken and picked up; a walk to a home
 * chest), and the most uses give the most trips before the next one; nothing is wasted by it, since a worn spare is taken
 * as soon as it is the best one left. The best fit (the fewest uses that still cover) was not chosen: it keeps a fresh
 * elytra back for a long trip, but the piece it puts on covers this trip only and the next trip swaps again.
 */
export function chooseElytra(s: ElytraState, toolWearLimit: number, need: ElytraNeed, allow: ElytraAllow): ElytraChoice {
  if (s.current && covers(s.current, toolWearLimit, need)) return { kind: 'ok', current: s.current };
  // (Track F21: a far trip is asked of the best Unbreaking level to hand; the pieces are ranked by what they fly, not their uses)
  const level = Math.max(0, s.current?.unbreaking ?? 0, ...s.spares.map((p) => p.unbreaking ?? 0));
  if (neverCovered(toolWearLimit, need, level)) return { kind: 'none', why: 'no elytra covers it (more than a new one has)', never: true };
  const worth = (p: ElytraPiece): number => spendable(p, toolWearLimit);
  const best = (src: ElytraSource): ElytraPiece | undefined =>
    s.spares
      .filter((p) => p.source === src && covers(p, toolWearLimit, need) && (!s.current || worth(p) > worth(s.current)))
      .sort((a, b) => worth(b) - worth(a) || (a.slot ?? 0) - (b.slot ?? 0) || (a.inBox ?? 0) - (b.inBox ?? 0))[0];
  const loose = best('loose');
  if (loose) return { kind: 'swap', piece: loose, why: `a spare carried loose (${loose.left} uses)` };
  const boxed = allow.boxes ? best('box') : undefined;
  if (boxed) return { kind: 'swap', piece: boxed, why: `a spare in a carried box (${boxed.left} uses)` };
  if (allow.home && s.homeInReach && s.home > 0) return { kind: 'home', why: `${s.home} in the chests at home` };
  return { kind: 'none', why: noSpareWhy(s, toolWearLimit, need), never: false };
}

/** Why no spare: `no spare (carried, in the boxes or at home in reach)`, or what the spares there are lack. */
function noSpareWhy(s: ElytraState, toolWearLimit: number, need: ElytraNeed): string {
  // (the sources a pass may use differ: the owner is told every place a spare is looked for)
  const where = 'carried, in the boxes or at home in reach';
  const short = s.spares.filter((p) => !covers(p, toolWearLimit, need));
  const parts = [`no spare that covers it (${where})`];
  if (short.length) parts.push(`the spare${short.length === 1 ? '' : 's'} carried: ${short.map((p) => `${p.left}/${elytraMax()}`).join(', ')}`);
  if (s.home > 0 && !s.homeInReach) parts.push(`${s.home} at home, out of reach`);
  return parts.join('; ');
}

/** `58/432 (covers about 600 blocks)`, `25/432 (worn: no flights)`. */
export function pieceLine(p: Pick<ElytraPiece, 'left' | 'mending' | 'unbreaking'>, toolWearLimit: number): string {
  const limit = limitOf(p, toolWearLimit);
  const reach = p.left > limit ? `covers about ${roundBlocks(reachBlocks(p.left, limit, p.unbreaking ?? 0))} blocks` : p.mending ? 'set aside to be mended' : 'worn: no flights';
  const u = unbreakingSaid(p.unbreaking ?? 0);
  return `${p.left}/${elytraMax()} (${u ? `${u}, ` : ''}${reach})`;
}

const roundBlocks = (n: number): number => (n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n / 10) * 10);

/** The longest flight (blocks, over flat ground, no hold) the uses over the limit cover: tripUses searched (tripReach counts a held goal, so it says 0 for a short reach); `unbreaking`: the level (Track F21). */
export function reachBlocks(left: number, limit: number, unbreaking = 0): number {
  if (left <= limit) return 0;
  let lo = 0;
  let hi = Math.max(1, tripReach(left - limit, unbreaking) * 2 + 2000);
  if (!tripCover(left, limit, lo, {}, unbreaking).ok) return 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (tripCover(left, limit, mid, {}, unbreaking).ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The status line (`!elytra status`, `!status`): `elytra 58/432 (covers about 600 blocks); no spare (carried, in the boxes
 * or at home in reach)`, or the spares: `spares: 432 loose, 432 in a box, 1 at home`.
 */
export function elytraLine(s: ElytraState, toolWearLimit: number): string {
  const head = s.current ? `elytra ${pieceLine(s.current, toolWearLimit)}${s.current.source === 'back' ? ' on' : ''}` : 'no elytra';
  const flyable = (p: ElytraPiece) => p.left > limitOf(p, toolWearLimit);
  const loose = s.spares.filter((p) => p.source === 'loose');
  const boxed = s.spares.filter((p) => p.source === 'box');
  const parts: string[] = [];
  if (loose.length) parts.push(...loose.map((p) => `${p.left} loose`));
  if (boxed.length) parts.push(...boxed.map((p) => `${p.left} in a box`));
  if (s.home > 0) parts.push(`${s.home} at home${s.homeInReach ? '' : ' (out of reach)'}`);
  const any = s.spares.some(flyable) || (s.home > 0 && s.homeInReach);
  if (!any) return `${head}; no spare (carried, in the boxes or at home in reach)${parts.length ? `; worn spares: ${parts.join(', ')}` : ''}`;
  return `${head}; spares: ${parts.join(', ')}`;
}

/**
 * Track K4: what the unloader stores of the carried elytra (inventory slots). The elytra with the most uses (worn or
 * carried) always stays: it is the one the stock rule puts on. Every other carried one that is low (under ELYTRA_LOW_USES
 * over its worn limit: it covers a flight of about 1 500 blocks at most) and has no Mending is stored: it is what a swap left
 * behind, and nothing but a trip shorter than that would ever put it on again. A spare above that line is kept (a fresh
 * spare carried is the cheapest source away from home); a Mending one is kept to be mended. So the inventory never fills
 * with worn elytra, and the only flyable one is never stored.
 */
export function elytraToStore(s: Pick<ElytraState, 'current' | 'spares'>, toolWearLimit: number): Set<number> {
  const all = [...(s.current ? [s.current] : []), ...s.spares.filter((p) => p.source === 'loose')];
  // the best: the most it flies (Track F21: an Unbreaking one's uses count for more), the one on the back on a tie, then the first slot
  const worth = (p: ElytraPiece): number => spendable(p, toolWearLimit);
  const best = [...all].sort((a, b) => worth(b) - worth(a) || (a.source === 'back' ? -1 : b.source === 'back' ? 1 : (a.slot ?? 0) - (b.slot ?? 0)))[0];
  const low = (p: ElytraPiece): boolean => !p.mending && worth(p) < ELYTRA_LOW_USES;
  return new Set(all.filter((p) => p !== best && p.source !== 'back' && p.slot !== undefined && low(p)).map((p) => p.slot!));
}

/** `elytra 410/432 on, spares 432, 432 (box)` for the panel's vitals row. */
export function panelElytraLine(s: ElytraState, toolWearLimit: number): string | undefined {
  if (!s.current && s.spares.length === 0 && s.home === 0) return undefined;
  const head = s.current ? `${s.current.left}/${elytraMax()}${s.current.source === 'back' ? ' on' : ''}${s.current.left <= limitOf(s.current, toolWearLimit) ? ' (worn)' : ''}` : 'none';
  const sp = s.spares.map((p) => `${p.left}${p.source === 'box' ? ' (box)' : ''}`);
  return `${head}${sp.length ? `, spares ${sp.join(', ')}` : ''}${s.home > 0 ? `, ${s.home} at home` : ''}`;
}
