// Trip readiness (wave 7, Track W; docs/pve.md "Trip readiness"). The Realm bot died on trips it
// started hungry and hurt. Before a user process walks more than 16 blocks (`!come`, the start of
// `!follow`, a goto through the PvE layer, `!kill` with the nearest target beyond 16) it prepares:
//
//   when food < 14 or health < 14: put on the best armour, then eat until the food bar is full (the
//   server refuses at 20); status line `preparing: eating`, the chat reply says `eating first`
//   at night (time of day 12542 to 23459, the sleep window) without a chestplate (worn, or in the
//   inventory to put on): `!come` / `!follow` / `!kill` are refused with a reply unless the command
//   ends with `now` (`!come now`); walks (`!goto`, `!home go`, `!top`) are never refused (going home
//   is the safe thing at night)
//
// Pure helpers plus `prepareTrip`, which the processes in tasks/pve.ts call from their start.
import type { Vec3 } from '../../connection/types.ts';
import type { ItemStack } from '../../world/types.ts';
import { armourSlotOf } from '../../skills/survival/armour.ts';
import { inSleepWindow } from '../../skills/survival/sleep.ts';

/** Trips longer than this (blocks) are prepared for. */
export const TRIP_DISTANCE = 16;
/** Prepare when food or health is below this. */
export const PREP_BELOW = 14;
/** At most this many bites in one preparation. */
export const MAX_BITES = 6;

export interface TripSelf {
  readonly food: number;
  readonly health: number;
}

/** What the trip needs from the survival kit (SurvivalKit satisfies it). */
export interface TripKit {
  eat(): Promise<{ ok: boolean; reason?: string; item?: string; foodAfter?: number }>;
  equip(): Promise<{ ok: boolean; equipped: string[]; reason?: string }>;
  readonly armour: { worn(): (ItemStack | null)[]; plan(): unknown[] };
  readonly overrides: { autoEat?: boolean };
}

/** Food or health below 14. */
export function needsPrep(s: TripSelf): boolean {
  return s.food < PREP_BELOW || s.health < PREP_BELOW;
}

/** The trip is long enough to prepare for (unknown distance counts as long). */
export function longTrip(from: Vec3 | undefined, to: Vec3 | undefined): boolean {
  if (!from || !to) return true;
  return Math.hypot(to.x - from.x, to.z - from.z) > TRIP_DISTANCE;
}

/** A chestplate is worn (armour window slot 1) or can be put on from the inventory. */
export function hasChestplate(worn: readonly (ItemStack | null | undefined)[], slots: readonly (ItemStack | null | undefined)[]): boolean {
  if (worn[1]) return true;
  return slots.slice(0, 36).some((s) => s !== null && s !== undefined && armourSlotOf(s.name) === 1);
}

/** `!come now`, `!follow Steve now`: the trailing `now` and the remaining arguments. */
export function splitNow(args: readonly string[]): { args: string[]; now: boolean } {
  const a = [...args];
  if (a.length > 0 && a[a.length - 1]!.toLowerCase() === 'now') {
    a.pop();
    return { args: a, now: true };
  }
  return { args: a, now: false };
}

export interface TripCheck {
  /** The process will eat / equip first. */
  prep: boolean;
  /** Refused: the reply text. */
  refuse?: string;
}

/**
 * The checks at a command (before the process is added): the night rule (refuse without a chestplate
 * unless `now`) and whether it will prepare.
 */
export function checkTrip(a: { cmd: string; self: TripSelf; timeOfDay: number | undefined; worn: readonly (ItemStack | null | undefined)[]; slots: readonly (ItemStack | null | undefined)[]; long: boolean; now: boolean }): TripCheck {
  if (!a.long) return { prep: false };
  if (!a.now && inSleepWindow(a.timeOfDay) && !hasChestplate(a.worn, a.slots)) {
    return { prep: false, refuse: `${a.cmd}: it is night and I have no chestplate; add "now" to go anyway (!${a.cmd} now)` };
  }
  return { prep: needsPrep(a.self) };
}

export type PrepPhase = 'armour' | 'eating';

export interface PrepResult {
  bites: number;
  equipped: string[];
  foodBefore: number;
  foodAfter: number;
  /** Why eating stopped: full, no_food, a failure reason, or cancelled. */
  stop: string;
}

/**
 * Put on the best armour, then eat until the food bar is full (at most MAX_BITES bites). `alive()`
 * false (the process was paused or stopped) ends it early. `wait(ticks)` paces retries while the kit
 * is busy with something else.
 */
export async function prepareTrip(kit: TripKit, self: TripSelf, o: { alive: () => boolean; phase: (p: PrepPhase) => void; wait: (ticks: number) => Promise<void> }): Promise<PrepResult> {
  const foodBefore = self.food;
  let equipped: string[] = [];
  if (kit.armour.plan().length > 0) {
    o.phase('armour');
    for (let i = 0; i < 5 && o.alive(); i++) {
      const r = await kit.equip();
      if (r.reason !== 'busy') {
        equipped = r.equipped;
        break;
      }
      await o.wait(10);
    }
  }
  let bites = 0;
  let stop = 'full';
  o.phase('eating');
  let busy = 0;
  while (o.alive() && self.food < 20 && bites < MAX_BITES) {
    const r = await kit.eat();
    if (r.ok) {
      bites++;
      continue;
    }
    if (r.reason === 'busy' && busy++ < 20) {
      await o.wait(5);
      continue;
    }
    stop = r.reason ?? 'failed';
    break;
  }
  if (!o.alive()) stop = 'cancelled';
  else if (bites >= MAX_BITES && self.food < 20) stop = 'max_bites';
  return { bites, equipped, foodBefore, foodAfter: self.food, stop };
}
