// Eating (PLAN.md task 7.11, Track S, docs/survival.md). Verified on BDS 1.26.60.6 with the truth
// pack's food reading and item use log:
//
//   select   mob_equipment (Hotbar.select) when the food is not held; a stack in the main inventory is
//            moved to the hotbar first (item_stack_request with the inventory screen open)
//   start    inventory_transaction { item_use, action_type 'click_air', trigger 'player_input',
//            block_position 0 0 0, face 255, hotbar_slot, hand main_hand, held_item = the wire item,
//            player_pos = eye, click_pos 0, block_runtime_id 0, prediction success }
//            -> truth itemStartUse (useDuration 32), own actor flag `action` (using an item) set
//   finish   NOTHING more from the client: the server completes the use itself 31 to 32 ticks later and
//            sends a clientbound inventory_transaction { item_release, consume } with the new stack,
//            inventory_content, update_attributes (player.hunger, player.saturation), the `burp` sound
//   cancel   inventory_transaction { item_release, action_type 'release', hotbar_slot, held_item,
//            head_pos = eye } (truth itemReleaseUse + itemStopUse), or selecting another slot
//   refused  with food 20 the click starts nothing (no event, nothing changes)
//
// When: food < 18 (natural regeneration needs 18), or health < 10 and food < 20. Never starts during a
// fight unless health < 6; stops when hit hard (one drop of `hardHit` or more). Best food: see
// `chooseFood` (the bad foods only when nothing else is there and food < 6).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { ItemStack, Vec3 } from '../../world/types.ts';
import { wireItemOf } from '../place/place.ts';

export interface FoodInfo {
  /** Hunger points restored. */
  nutrition: number;
  /** Saturation points restored. */
  saturation: number;
  /** Ticks of use (default 32). */
  ticks?: number;
  /** Eaten only when nothing else is there and food < 6 (rotten flesh, spider eye, pufferfish, poisonous potato). */
  bad?: boolean;
  /** A small chance of a bad effect (raw chicken): ranked down. */
  risky?: boolean;
  /** Only in an emergency (health < 6): golden apples. */
  precious?: boolean;
}

/** Bedrock food values (nutrition, saturation = nutrition x modifier x 2), the common foods. */
export const FOODS: Readonly<Record<string, FoodInfo>> = {
  cooked_beef: { nutrition: 8, saturation: 12.8 },
  cooked_porkchop: { nutrition: 8, saturation: 12.8 },
  golden_carrot: { nutrition: 6, saturation: 14.4 },
  cooked_mutton: { nutrition: 6, saturation: 9.6 },
  cooked_salmon: { nutrition: 6, saturation: 9.6 },
  cooked_chicken: { nutrition: 6, saturation: 7.2 },
  rabbit_stew: { nutrition: 10, saturation: 12 },
  mushroom_stew: { nutrition: 6, saturation: 7.2 },
  beetroot_soup: { nutrition: 6, saturation: 7.2 },
  baked_potato: { nutrition: 5, saturation: 6 },
  bread: { nutrition: 5, saturation: 6 },
  cooked_cod: { nutrition: 5, saturation: 6 },
  cooked_rabbit: { nutrition: 5, saturation: 6 },
  pumpkin_pie: { nutrition: 8, saturation: 4.8 },
  honey_bottle: { nutrition: 6, saturation: 1.2, ticks: 40 },
  apple: { nutrition: 4, saturation: 2.4 },
  carrot: { nutrition: 3, saturation: 3.6 },
  beef: { nutrition: 3, saturation: 1.8 },
  porkchop: { nutrition: 3, saturation: 1.8 },
  rabbit: { nutrition: 3, saturation: 1.8 },
  mutton: { nutrition: 2, saturation: 1.2 },
  chicken: { nutrition: 2, saturation: 1.2, risky: true },
  cod: { nutrition: 2, saturation: 0.4 },
  salmon: { nutrition: 2, saturation: 0.4 },
  tropical_fish: { nutrition: 1, saturation: 0.2 },
  melon_slice: { nutrition: 2, saturation: 1.2 },
  sweet_berries: { nutrition: 2, saturation: 0.4 },
  glow_berries: { nutrition: 2, saturation: 0.4 },
  cookie: { nutrition: 2, saturation: 0.4 },
  beetroot: { nutrition: 1, saturation: 1.2 },
  potato: { nutrition: 1, saturation: 0.6 },
  dried_kelp: { nutrition: 1, saturation: 0.2, ticks: 16 },
  golden_apple: { nutrition: 4, saturation: 9.6, precious: true },
  rotten_flesh: { nutrition: 4, saturation: 0.8, bad: true },
  spider_eye: { nutrition: 2, saturation: 3.2, bad: true },
  pufferfish: { nutrition: 1, saturation: 0.2, bad: true },
  poisonous_potato: { nutrition: 2, saturation: 1.2, bad: true },
};
// never eaten automatically: chorus_fruit (teleports), suspicious_stew (random effect), enchanted_golden_apple

export function foodInfo(name: string): FoodInfo | undefined {
  return FOODS[name.startsWith('minecraft:') ? name.slice(10) : name];
}

export interface EatState {
  food: number;
  health: number;
}

/** The rule: eat when food < 18, or health < 10 and food < 20. */
export function wantsToEat(s: EatState): boolean {
  return s.food < 18 || (s.health < 10 && s.food < 20);
}

/**
 * The best food among inventory slots 0..35: highest saturation plus the nutrition that is not wasted
 * (20 - food), raw chicken ranked down; golden apples only below health 6; the bad foods only when
 * nothing else is there and food < 6. Ties: hotbar first, then the lower slot. undefined = nothing edible.
 */
export function chooseFood(slots: readonly (ItemStack | null | undefined)[], s: EatState): { slot: number; name: string; info: FoodInfo } | undefined {
  const missing = Math.max(0, 20 - s.food);
  let best: { slot: number; name: string; info: FoodInfo; score: number } | undefined;
  let worst: { slot: number; name: string; info: FoodInfo; score: number } | undefined;
  for (let slot = 0; slot < Math.min(slots.length, 36); slot++) {
    const it = slots[slot];
    if (!it || it.count <= 0) continue;
    const info = foodInfo(it.name);
    if (!info) continue;
    if (info.precious && s.health >= 6) continue;
    let score = info.saturation + Math.min(info.nutrition, missing) * 1.5 - (info.risky ? 4 : 0) - (slot >= 9 ? 0.01 : 0);
    if (missing < 1) score = info.saturation;
    const cand = { slot, name: it.name, info, score };
    if (info.bad) {
      if (!worst || score > worst.score) worst = cand;
    } else if (!best || score > best.score || (score === best.score && slot < best.slot)) {
      best = cand;
    }
  }
  const pick = best ?? (s.food < 6 ? worst : undefined);
  return pick && { slot: pick.slot, name: pick.name, info: pick.info };
}

/** The click that starts using the held item (click_air), BDS 1.26.60 shape. */
export function useItemTransaction(a: { hotbarSlot: number; held: ItemV4; eye: Vec3 }): Record<string, unknown> {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_use',
      actions: [],
      transaction_data: {
        action_type: 'click_air',
        trigger_type: 'player_input',
        block_position: { x: 0, y: 0, z: 0 },
        face: 255,
        hotbar_slot: a.hotbarSlot,
        hand: 'main_hand',
        held_item: a.held,
        player_pos: { ...a.eye },
        click_pos: { x: 0, y: 0, z: 0 },
        block_runtime_id: 0,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    },
  };
}

/** Stop using the held item (item_release / release), BDS 1.26.60 shape. */
export function releaseItemTransaction(a: { hotbarSlot: number; held: ItemV4; eye: Vec3 }): Record<string, unknown> {
  return {
    transaction: {
      legacy: { legacy_request_id: 0 },
      transaction_type: 'item_release',
      actions: [],
      transaction_data: { action_type: 'release', hotbar_slot: a.hotbarSlot, held_item: a.held, head_pos: { ...a.eye }, hand: 'main_hand' },
    },
  };
}

export type EatReason = 'not_hungry' | 'no_food' | 'busy' | 'fighting' | 'move_failed' | 'no_hotbar' | 'interrupted' | 'hit' | 'timeout' | 'refused' | 'not_ready';

export interface EatResult {
  ok: boolean;
  reason?: EatReason;
  item?: string;
  slot?: number;
  foodBefore?: number;
  foodAfter?: number;
  ticks?: number;
  /** The stack came from the main inventory. */
  fetched?: boolean;
}

export interface EatLoop {
  readonly state: { pos: Vec3; ready: boolean };
  waitTicks(n: number): Promise<void>;
}

export interface EatInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  rawItem(window: number, slot: number): ItemV4 | undefined;
}

export interface EatDeps {
  loop: EatLoop;
  inventory: EatInventory;
  self: { readonly food: number; readonly health: number };
  hotbar: { select(slot: number): boolean; rawItem(slot: number): ItemV4 | undefined; noteRaw?(slot: number, item: ItemV4 | undefined): void };
  source: { queue(name: string, params: Record<string, unknown>): void };
  /** Move a stack from a main-inventory slot into the hotbar (returns the hotbar slot). */
  toHotbar?: (slot: number) => Promise<number | undefined>;
  logger?: Logger;
}

export interface EatOptions {
  /** Eat even when full enough by the rule (still refused by the server at food 20). */
  force?: boolean;
  /** One health drop of this much stops eating. Default 4. */
  hardHit?: number;
  /** Re-select the slot held before eating afterwards. Default true. */
  restoreSlot?: boolean;
}

const EYE = 1.62;

export class EatController {
  private readonly d: EatDeps;
  private readonly log: Logger;
  private running = false;
  private cancelled: EatReason | undefined;
  readonly stats = { eaten: 0, failed: 0, interrupted: 0 };

  constructor(deps: EatDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  /** Stop eating now (item_release). */
  cancel(reason: EatReason = 'interrupted'): void {
    if (this.running) this.cancelled = reason;
  }

  private eye(): Vec3 {
    const p = this.d.loop.state.pos;
    return { x: p.x, y: p.y + EYE, z: p.z };
  }

  private held(slot: number): ItemV4 {
    const inv = this.d.inventory;
    return wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? this.d.hotbar.rawItem(slot));
  }

  /** Eat the best food once (see the file comment). */
  async eat(opts: EatOptions = {}): Promise<EatResult> {
    if (this.running) return { ok: false, reason: 'busy' };
    if (!this.d.loop.state.ready) return { ok: false, reason: 'not_ready' };
    const s = { food: this.d.self.food, health: this.d.self.health };
    if (s.food >= 20 || (!opts.force && !wantsToEat(s))) return { ok: false, reason: 'not_hungry', foodBefore: s.food };
    const pick = chooseFood(this.d.inventory.slots, s);
    if (!pick) return { ok: false, reason: 'no_food', foodBefore: s.food };
    this.running = true;
    this.cancelled = undefined;
    try {
      return await this.run(pick, s, opts);
    } finally {
      this.running = false;
    }
  }

  private async run(pick: { slot: number; name: string; info: FoodInfo }, s: EatState, opts: EatOptions): Promise<EatResult> {
    const { loop, inventory: inv, hotbar, source } = this.d;
    const base: EatResult = { ok: false, item: pick.name, foodBefore: s.food };
    let slot = pick.slot;
    if (slot >= 9) {
      const to = await this.d.toHotbar?.(slot);
      if (to === undefined) return { ...base, reason: 'move_failed' };
      slot = to;
      base.fetched = true;
    }
    base.slot = slot;
    const prev = inv.selected;
    if (slot !== inv.selected) {
      if (!hotbar.select(slot)) return { ...base, reason: 'no_hotbar' };
      await loop.waitTicks(1); // mob_equipment goes out before the click
    }
    const stack0 = inv.slots[slot];
    if (stack0?.name !== pick.name) return { ...base, reason: 'interrupted' };
    const count0 = stack0.count;
    const food0 = this.d.self.food;
    const health0 = this.d.self.health;
    let lastHealth = health0;
    const hardHit = opts.hardHit ?? 4;
    source.queue('inventory_transaction', useItemTransaction({ hotbarSlot: slot, held: this.held(slot), eye: this.eye() }));
    this.log.info(`eat: ${pick.name} from slot ${slot}${base.fetched ? ' (fetched)' : ''}, food ${food0}, health ${health0}`);
    const limit = (pick.info.ticks ?? 32) + 15;
    let ticks = 0;
    let outcome: EatReason | 'ok' | undefined;
    for (; ticks < limit; ticks++) {
      await loop.waitTicks(1);
      const now = inv.slots[slot];
      if (this.d.self.food > food0 || now?.name !== pick.name || now.count < count0) {
        outcome = 'ok';
        break;
      }
      const h = this.d.self.health;
      // a hard hit stops eating (fight or flee first), except below 6 health where eating is the way out
      if (lastHealth - h >= hardHit && h >= 6) this.cancelled ??= 'hit';
      lastHealth = h;
      if (inv.selected !== slot) {
        outcome = 'interrupted'; // somebody switched the slot: the server stopped the use
        break;
      }
      if (this.cancelled) {
        source.queue('inventory_transaction', releaseItemTransaction({ hotbarSlot: slot, held: this.held(slot), eye: this.eye() }));
        outcome = this.cancelled;
        break;
      }
    }
    if (outcome === 'ok') {
      // the attribute update can trail the inventory change by a tick
      for (let i = 0; i < 5 && this.d.self.food <= food0; i++) await loop.waitTicks(1);
    }
    const result: EatResult = { ...base, ok: outcome === 'ok', foodAfter: this.d.self.food, ticks: ticks + 1 };
    if (outcome !== 'ok') result.reason = outcome ?? (food0 >= 20 ? 'refused' : 'timeout');
    if (result.ok) this.stats.eaten++;
    else if (result.reason === 'hit' || result.reason === 'interrupted') this.stats.interrupted++;
    else this.stats.failed++;
    this.log.info(`eat: ${pick.name} ${result.ok ? `done after ${result.ticks} ticks` : result.reason}, food ${food0} -> ${result.foodAfter}`);
    if ((opts.restoreSlot ?? true) && prev !== slot && inv.selected === slot && prev >= 0 && prev < 9) hotbar.select(prev);
    return result;
  }
}
