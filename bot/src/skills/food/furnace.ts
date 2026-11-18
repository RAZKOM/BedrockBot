// A furnace set down where the cooker and the smelter use it (Track E2, docs/early-game.md "The iron age").
//
// The cooker (cook.ts) looks for furnaces within 16 blocks of home, or of the bot without a home; so a furnace the bot
// places goes there: with a home it walks to the home point first, without one it stays where it stands. The cell is
// the crafting table's rule (skills/craft/table-spot.ts: a ring cell next to the feet, empty or under a cover a hand
// clears, a full solid natural top under it); unlike the table the furnace stays standing (it smelts while the bot
// waits by it, and the next `!cook` or `!smelt` finds it). One furnace is placed only when none stands where the
// cooker looks.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import { canHarvestCarried, tableSpots } from '../craft/table-spot.ts';
import { isBuiltBlock } from '../terrain/classify.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

export const FURNACE = 'furnace';
/** The walk home stops within this many blocks of the home point. */
export const FURNACE_HOME_REACH = 3;

export interface FurnaceDeps {
  world: { blockAt(p: Vec3): BlockInfo | undefined; readonly inventory: { readonly slots: readonly (ItemStack | null)[] } };
  loop: { readonly state: { pos: Vec3; ready: boolean } };
  skills: { place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>; dig(p: Vec3): Promise<DigResult>; goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult> };
  home(): Vec3 | undefined;
  /** The furnaces where the cooker looks (Cooker.furnaces(16)). */
  furnaces(): Vec3[];
  log?: Logger;
}

export type FurnaceReason = 'no_furnace_item' | 'walk_failed' | 'no_spot' | 'place_failed' | 'interrupted' | 'not_ready';

export type FurnaceResult = { ok: true; pos: Vec3; walked: boolean; already: boolean } | { ok: false; reason: FurnaceReason; detail?: string };

const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/** Furnaces carried (main inventory). */
export function furnacesCarried(slots: readonly (ItemStack | null | undefined)[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) if (slots[i]?.name === FURNACE) n += slots[i]!.count;
  return n;
}

/** The reply part for a failed placement. */
export function furnaceReasonText(r: FurnaceReason, detail?: string): string {
  switch (r) {
    case 'no_furnace_item':
      return 'no furnace carried (8 cobblestone make one: !get furnace)';
    case 'walk_failed':
      return `the walk home failed${detail ? ` (${detail})` : ''}`;
    case 'no_spot':
      return 'no free cell next to me for it';
    case 'place_failed':
      return `placing it failed${detail ? ` (${detail})` : ''}`;
    case 'interrupted':
      return 'stopped';
    case 'not_ready':
      return 'not spawned yet';
  }
}

/**
 * Set a carried furnace down where the cooker looks: done at once when one stands there; with a home, walk to it
 * first; then the first ring cell the table rule allows (a cover cleared first).
 */
export async function placeFurnace(d: FurnaceDeps, cancelled: () => boolean): Promise<FurnaceResult> {
  const log = d.log ?? silentLogger;
  if (!d.loop.state.ready) return { ok: false, reason: 'not_ready' };
  const there = d.furnaces()[0];
  if (there) return { ok: true, pos: there, walked: false, already: true };
  if (furnacesCarried(d.world.inventory.slots) === 0) return { ok: false, reason: 'no_furnace_item' };
  let walked = false;
  const h = d.home();
  if (h) {
    const me = d.loop.state.pos;
    const far = Math.hypot(h.x - me.x, h.y - me.y, h.z - me.z);
    if (far > FURNACE_HOME_REACH + 0.5) {
      const w = await d.skills.goto({ type: 'near', p: h, r: FURNACE_HOME_REACH }, { timeoutTicks: Math.max(600, Math.ceil(far * 20)) });
      if (cancelled()) return { ok: false, reason: 'interrupted' };
      if (!w.ok) return { ok: false, reason: 'walk_failed', detail: w.reason ?? 'failed' };
      walked = true;
    }
  }
  const spots = tableSpots((q) => d.world.blockAt(q), d.loop.state.pos, isBuiltBlock, (name) => canHarvestCarried(d.world.inventory.slots, name));
  if (spots.length === 0) return { ok: false, reason: 'no_spot' };
  let last: string | undefined;
  for (const { p, cover, dig } of spots.slice(0, 4)) {
    if (cancelled()) return { ok: false, reason: 'interrupted' };
    if (cover ?? dig) {
      const g = await d.skills.dig(p);
      if (!g.ok || d.world.blockAt(p)?.name !== 'air') {
        log.info(`furnace: clearing ${cover ?? dig} at ${fmt(p)}: ${g.ok ? `still ${d.world.blockAt(p)?.name ?? 'unknown'}` : (g.reason ?? 'failed')}`);
        continue;
      }
    }
    const r = await d.skills.place(p, { face: 'up', item: FURNACE });
    if (r.ok) {
      log.info(`furnace: placed at ${fmt(p)}${walked ? ' (walked home first)' : ''}`);
      return { ok: true, pos: p, walked, already: false };
    }
    last = r.reason ?? 'failed';
    log.info(`furnace: place at ${fmt(p)}: ${last}`);
    if (r.reason === 'interrupted') return { ok: false, reason: 'interrupted' };
  }
  return { ok: false, reason: 'place_failed', ...(last ? { detail: last } : {}) };
}
