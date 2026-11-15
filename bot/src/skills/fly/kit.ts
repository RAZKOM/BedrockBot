// The flight kit (wave 11, Track AU; docs/flight.md "The kit"): the elytra, the firework rockets and
// the shulker box that holds fireworks. Pure helpers over the inventory model: what the kit is, how
// many rockets are at hand, whether the elytra may still fly, and the owner's supply lines.
//
// A "fireworks box" is any shulker box whose NBT `Items` are firework rockets only (an empty box is
// not one; the owner can name one with `!fly box <slot>`, see `FlightKitMemory`). The kit is never
// dropped by the keeper, never stashed, never unloaded, never used as the stash box, and kept by
// `!drop all` / `!drop items`; `!drop flightkit` drops it.
import { DEFAULT_MEND_AT, durabilityLeft, hasMending, maxDurability, mendReserve } from '../survival/tools.ts';
import { isShulkerBox, shulkerContents, shulkerSlotsUsed } from '../container/chest.ts';
import type { ItemStack } from '../../world/types.ts';

export const ROCKET = 'firework_rocket';
export const ELYTRA = 'elytra';
/** An elytra breaks in the air: land with this many uses above `toolWearLimit`. */
export const ELYTRA_RESERVE = 20;
/** Default `fireworksMin`: fewer rockets in the hotbar than this -> refill from the box, whisper when it is empty. */
export const DEFAULT_FIREWORKS_MIN = 16;

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

export function isRocket(name: string): boolean {
  return bare(name) === ROCKET;
}

export function isElytra(name: string): boolean {
  return bare(name) === ELYTRA;
}

/** A shulker box item whose contents (NBT `Items`) are firework rockets only. `raw`: the wire item. */
export function isFireworksBox(name: string, raw: unknown): boolean {
  if (!isShulkerBox(name)) return false;
  if (shulkerSlotsUsed(raw) === 0) return false;
  const c = shulkerContents(raw);
  const kinds = Object.keys(c);
  return kinds.length > 0 && kinds.every((k) => isRocket(k));
}

/** Rockets inside a fireworks box (0 for any other item). */
export function boxRockets(name: string, raw: unknown): number {
  if (!isShulkerBox(name)) return 0;
  return shulkerContents(raw)[ROCKET] ?? 0;
}

/**
 * An item that belongs to the flight kit by its name alone: the elytra and the rockets. (A fireworks
 * box needs the raw item: `isFireworksBox`.) Used by the keeper, the stash and the unloader.
 */
export function isFlightKitItem(name: string): boolean {
  return isElytra(name) || isRocket(name);
}

/** The slots a box memory remembers: the owner's named box (`!fly box <slot>`), by inventory slot. */
export interface FlightKitMemory {
  /** The inventory slot the owner named as the fireworks box (any shulker box there counts). */
  namedBoxSlot?: number | undefined;
}

/** The kit memory of a task (the fly commands set it; the keeper, the stash and the unloader read it). */
const memories = new WeakMap<object, FlightKitMemory>();
export function flightKitMemoryOf(task: object | undefined): FlightKitMemory {
  if (!task) return {};
  let m = memories.get(task);
  if (!m) {
    m = {};
    memories.set(task, m);
  }
  return m;
}

/** The inventory slots (0..35) the flight kit occupies now: the elytra, every rocket stack and the fireworks box. */
export function flightKitSlots(inv: KitInventory, task: object | undefined): Set<number> {
  const out = new Set<number>();
  const k = readKit(inv, flightKitMemoryOf(task));
  inv.slots.slice(0, 36).forEach((s, i) => {
    if (!s || s.count <= 0) return;
    if (isElytra(s.name) || isRocket(s.name) || i === k.boxSlot) out.add(i);
  });
  return out;
}

export interface KitInventory {
  readonly slots: readonly (ItemStack | null)[];
  rawItem?(window: number, slot: number): unknown;
  window?(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
}

export interface FlightKit {
  /** Inventory slot of an elytra (the first), or -1. */
  elytraSlot: number;
  /** The elytra is worn (armour slot 1). */
  elytraWorn: boolean;
  /** Uses left on the elytra at hand (worn first), undefined without one. */
  elytraLeft: number | undefined;
  /** The elytra at hand has Mending: it is set aside at its mending reserve (elytraWornLimit), not flown until it breaks. */
  elytraMending?: boolean;
  /** Rockets in the hotbar (slots 0..8) and in the whole inventory. */
  rocketsHotbar: number;
  rockets: number;
  /** Inventory slot of the fireworks box (the named slot first, else the box holding most), or -1. */
  boxSlot: number;
  /** Rockets inside the box. */
  boxRockets: number;
}

/** The kit as the inventory shows it now. */
export function readKit(inv: KitInventory, memory: FlightKitMemory = {}): FlightKit {
  const slots = inv.slots.slice(0, 36);
  const worn = inv.window?.(120)?.slots[1] ?? null;
  const elytraWorn = !!worn && isElytra(worn.name);
  let elytraSlot = -1;
  let rockets = 0;
  let rocketsHotbar = 0;
  let boxSlot = -1;
  let box = 0;
  const named = memory.namedBoxSlot;
  slots.forEach((s, i) => {
    if (!s || s.count <= 0) return;
    if (isElytra(s.name) && elytraSlot < 0) elytraSlot = i;
    if (isRocket(s.name)) {
      rockets += s.count;
      if (i < 9) rocketsHotbar += s.count;
    }
    if (isShulkerBox(s.name)) {
      const raw = inv.rawItem?.(0, i);
      const n = boxRockets(s.name, raw);
      const isNamed = named === i;
      if (isNamed || isFireworksBox(s.name, raw)) {
        if (boxSlot < 0 || isNamed || (named !== boxSlot && n > box)) {
          boxSlot = i;
          box = n;
        }
      }
    }
  });
  const piece = elytraWorn ? worn : elytraSlot >= 0 ? slots[elytraSlot] : null;
  const elytraLeft = piece ? durabilityLeft(piece) : undefined;
  const elytraMending = !!piece && hasMending(piece);
  return { elytraSlot, elytraWorn, elytraLeft, ...(elytraMending ? { elytraMending } : {}), rocketsHotbar, rockets, boxSlot, boxRockets: box };
}

/**
 * `toolWearLimit` + the reserve: at or under this many uses the elytra is "worn" (no takeoff; land now). A Mending elytra
 * (`kit.elytraMending`) is set aside earlier, at its mending reserve (DEFAULT_MEND_AT percent: 44 of 432 uses), so it
 * is mended (`!mend`) instead of flown until it breaks.
 */
export function elytraWornLimit(toolWearLimit: number, kit?: Pick<FlightKit, 'elytraMending'>): number {
  const base = toolWearLimit + ELYTRA_RESERVE;
  return kit?.elytraMending ? Math.max(base, mendReserve(ELYTRA, DEFAULT_MEND_AT)) : base;
}

export function elytraMax(): number {
  return maxDurability(ELYTRA) ?? 432;
}

/** `elytra worn: 25 uses left; I will not fly until it is mended or replaced` */
export function elytraWornLine(left: number, mending = false): string {
  return mending ? `elytra set aside to be mended: ${left} uses left (it has Mending: !mend); I will not fly it until then` : `elytra worn: ${left} uses left; I will not fly until it is mended or replaced`;
}

/** `fireworks low: 9 rockets left and the box is empty; give me more (drop them or !bring fireworks_rocket 64)` */
export function fireworksLowLine(rockets: number): string {
  return `fireworks low: ${rockets} rocket${rockets === 1 ? '' : 's'} left and the box is empty; give me more (drop them or !bring fireworks_rocket 64)`;
}

/** `kept the flight kit (elytra, 23 rockets, the fireworks box); !drop flightkit drops it` */
export function keptKitLine(kit: FlightKit): string {
  const parts: string[] = [];
  if (kit.elytraSlot >= 0 || kit.elytraWorn) parts.push('elytra');
  if (kit.rockets > 0) parts.push(`${kit.rockets} rocket${kit.rockets === 1 ? '' : 's'}`);
  if (kit.boxSlot >= 0) parts.push('the fireworks box');
  return `kept the flight kit (${parts.join(', ')}); !drop flightkit drops it`;
}

export type KitRefusal = 'no_elytra' | 'elytra_worn' | 'no_rockets';

/**
 * Whether a flight may start: an elytra (worn or carried) above the worn limit, and rockets at hand
 * (in the inventory or in the box). The reply text for a refusal.
 */
/** `otherRockets`: rockets in the other carried shulker boxes (Supply.carried), taken out before the takeoff. */
export function kitReady(kit: FlightKit, toolWearLimit: number, otherRockets = 0): { ok: true } | { ok: false; reason: KitRefusal; line: string } {
  if (!kit.elytraWorn && kit.elytraSlot < 0) return { ok: false, reason: 'no_elytra', line: 'fly: no elytra (I need one in the inventory or on my back)' };
  if (kit.elytraLeft !== undefined && kit.elytraLeft <= elytraWornLimit(toolWearLimit, kit)) return { ok: false, reason: 'elytra_worn', line: elytraWornLine(kit.elytraLeft, kit.elytraMending) };
  if (kit.rockets === 0 && kit.boxRockets === 0 && otherRockets <= 0) return { ok: false, reason: 'no_rockets', line: 'fly: no firework rockets (give me some, or a shulker box of them)' };
  return { ok: true };
}

/**
 * Track F13 (docs/flight.md "A flight from the box alone (Track F13)"): the rockets a takeoff, a hop or a route is
 * simulated with before the flight starts. The loose rockets (the hotbar's, else the inventory's) when there are any:
 * a flight with loose rockets is decided as before, on fewer rockets than it may have after a refill, which only ever
 * makes the check stricter. With none loose, the rockets the flight will have once FlyProcess.prepare has refilled the
 * hotbar: up to a stack from the fireworks box, else from the other carried boxes (`otherRockets`, Supply.carried).
 * Before, a kit of the box alone was simulated with 0 rockets: every takeoff fell short ("it needs a rocket"), the
 * command said there was no clear climb and walked the whole way, and the refill that would have given it rockets was
 * never reached.
 */
export function rocketsForFlight(kit: Pick<FlightKit, 'rockets' | 'rocketsHotbar' | 'boxRockets'>, otherRockets = 0): number {
  const loose = kit.rocketsHotbar || kit.rockets;
  if (loose > 0) return loose;
  if (kit.boxRockets > 0) return Math.min(64, kit.boxRockets);
  return Math.min(64, Math.max(0, otherRockets));
}

/**
 * Track F16 (docs/flight.md "A window under a roof refills from the box (Track F16)"): a corridor window under a roof
 * with this many loose rockets or more is proven and flown on them, as before the track (no refill is looked at): twice
 * the most seen. The Realm's cave logs: proofs planned 1 to 4 rockets (n 11), windows fired 2 to 4 (n 8); the corridor
 * e2e's bore 0 to 2 and 1 to 2. A window that needs more than the hand holds is bailed out by its own tracker (a partial
 * plan, the sink to the floor), never flown dry.
 */
export const WINDOW_ROCKETS_SURE = 8;
/**
 * Track F16: the rockets a window keeps over what its proof's plan fires before it flies without a refill: the trackers
 * plan again in the air (a shorter burn than planned, a correction) and may fire one more than the proof each time; two
 * covers the re-plans of the windows measured (1 to 4 a window) without a refill for every low hand.
 */
export const WINDOW_ROCKET_RESERVE = 2;

/**
 * Track F16: the rockets a corridor window under a roof is proven with. The loose ones (as before) when there are
 * WINDOW_ROCKETS_SURE or more or no refill can be made where the body stands; else what the hotbar holds after the
 * refill (up to a stack from the fireworks box), the F13 rule (`rocketsForFlight`) carried over to a hand that is low
 * rather than empty: a window is decided on the rockets it will have.
 */
export function rocketsForWindow(kit: Pick<FlightKit, 'rockets' | 'rocketsHotbar' | 'boxRockets'>, refill: boolean): number {
  const loose = kit.rocketsHotbar || kit.rockets;
  if (loose >= WINDOW_ROCKETS_SURE || !refill || kit.boxRockets <= 0) return loose;
  return Math.max(loose, Math.min(64, kit.rocketsHotbar + kit.boxRockets));
}

/**
 * Track F16: a window refills before it flies when its loose rockets are fewer than its proof's plan fires plus
 * WINDOW_ROCKET_RESERVE (and fewer than WINDOW_ROCKETS_SURE: with that many nothing changes). `planRockets` undefined
 * (no proof): the loose ones under WINDOW_ROCKETS_SURE.
 */
export function windowRefillWanted(loose: number, planRockets?: number): boolean {
  if (loose >= WINDOW_ROCKETS_SURE) return false;
  if (planRockets === undefined) return true;
  return loose < planRockets + WINDOW_ROCKET_RESERVE;
}

/** `elytra 410/432, 23 rockets (16 in the hotbar), box 64` for status lines. */
export function kitLine(kit: FlightKit): string {
  const el = kit.elytraWorn || kit.elytraSlot >= 0 ? `elytra ${kit.elytraLeft ?? '?'}/${elytraMax()}${kit.elytraWorn ? ' (on)' : ''}` : 'no elytra';
  const box = kit.boxSlot >= 0 ? `, box ${kit.boxRockets}` : ', no box';
  return `${el}, ${kit.rockets} rocket${kit.rockets === 1 ? '' : 's'} (${kit.rocketsHotbar} in the hotbar)${box}`;
}

/**
 * The owner's supply lines: each one once, and not again until what it
 * reports changed (the rocket count, the uses left). Checked after a landing and before a refused flight.
 */
export class SupplyWatch {
  private saidRockets: number | undefined;
  private saidUses: number | undefined;

  /** The lines to say now (none when nothing is low or it was said for this count already). */
  check(kit: FlightKit, fireworksMin: number, toolWearLimit: number): string[] {
    const out: string[] = [];
    if (kit.boxRockets === 0 && kit.rockets < fireworksMin && (kit.elytraWorn || kit.elytraSlot >= 0)) {
      if (this.saidRockets !== kit.rockets) {
        this.saidRockets = kit.rockets;
        out.push(fireworksLowLine(kit.rockets));
      }
    } else this.saidRockets = undefined;
    if (kit.elytraLeft !== undefined && kit.elytraLeft <= elytraWornLimit(toolWearLimit, kit)) {
      if (this.saidUses !== kit.elytraLeft) {
        this.saidUses = kit.elytraLeft;
        out.push(elytraWornLine(kit.elytraLeft, kit.elytraMending));
      }
    } else this.saidUses = undefined;
    return out;
  }
}
