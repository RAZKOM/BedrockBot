// Track F3 (docs/flight.md "Route landings and takeoffs", the integration hygiene): the rocket plumbing the
// FlightController (controller.ts) and the route driver (route/live.ts) share, lifted out of the two copies
// Track F2 left. A rocket is used as a vanilla client uses it (the item-use transaction of the firework in the
// selected hotbar slot, eat.ts useItemTransaction), the loop predicts the boost (`loop.boost()`: until the
// removal, up to GLIDE.boostMaxTicks since Track F0), the rocket entity's `add_entity` within ROCKET_NEAR of
// the body in the ticks after the use is ours, and its `remove_entity` ends the boost (`loop.endBoost()`, then
// the caller's `onEnd`: the tracker's `rocketEnded`). Three rules from Track F0 (docs/flight-envelope.md):
// the own rockets are a SET (a second rocket extends the boost to the later end: endBoost on the last
// removal, never while a newer use still waits for its entity); a use with no add_entity within
// ROCKET_ADD_WITHIN ticks did nothing (the server ignores a rocket before the glide's first input) and its
// boost is taken back (`loop.endBoost(ticks since the use)`); and the loop's own refusal of a glide request
// is no glide end. Packet facts measured on BDS 1.26.60.6 (docs/flight.md "Packets").
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { EntityInfo, ItemStack } from '../../world/types.ts';
import { PHYSICS } from '../input/physics.ts';
import { wireItemOf } from '../place/place.ts';
import { useItemTransaction } from '../survival/eat.ts';
import { isRocket } from './kit.ts';

/** Ticks between two rockets (the item-use transaction must settle; the boost of one rocket lasts 12 to 18). */
export const ROCKET_COOLDOWN = 4;
/** A rocket entity appearing within this many blocks of the body right after a use is ours. */
export const ROCKET_NEAR = 6;
/** The rocket's `add_entity` comes within this many ticks of the use (Track F0: 1 input in 163 of 242 uses, 2 in 76, 0 in 3); none by then: the use did nothing. */
export const ROCKET_ADD_WITHIN = 5;

export interface RocketInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  rawItem(window: number, slot: number): unknown;
}

export interface RocketDeps {
  loop: { readonly state: { pos: Vec3 }; boost(ticks?: number): void; endBoost(agoTicks?: number): void };
  /** The connection (`inventory_transaction` for the rocket). */
  queue(name: string, packet: Record<string, unknown>): void;
  inventory: RocketInventory;
  hotbar: { select(slot: number): boolean; rawItem(slot: number): unknown };
  /** The world's entity tracker: the rocket entity's add and remove. */
  entities: { onAdd(fn: (e: EntityInfo) => void): () => void; onRemove(fn: (e: EntityInfo) => void): () => void };
  log?: Logger;
}

/** The rockets in the hotbar and the slot to use (the selected one when it holds rockets, else the first). */
export function rocketsInHotbar(inventory: RocketInventory): { count: number; slot: number } {
  let count = 0;
  let slot = -1;
  for (let i = 0; i < 9; i++) {
    const s = inventory.slots[i];
    if (s && s.count > 0 && isRocket(s.name)) {
      count += s.count;
      if (slot < 0 || i === inventory.selected) slot = i;
    }
  }
  return { count, slot };
}

/** One flight's rocket hand: the uses, their cooldown, the rocket entity's life (see the file comment). */
export class RocketHand {
  private readonly d: RocketDeps;
  private readonly log: Logger;
  private readonly onEnd: (() => void) | undefined;
  /** The tick of the last use (the cooldown counts from it). */
  lastFire = -1000;
  /** Rockets used. */
  fired = 0;
  /** Uses that fired nothing (no rocket entity within ROCKET_ADD_WITHIN: a rocket before the glide's first input). */
  wasted = 0;
  /** The ticks of the uses still waiting for their rocket entity (oldest first). */
  private pending: number[] = [];
  /** The own rockets alive (their unique ids). */
  private readonly live = new Set<bigint | number>();

  constructor(d: RocketDeps, o: { onEnd?: () => void; scope?: string } = {}) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.onEnd = o.onEnd;
    this.scope = o.scope ?? 'flight';
  }

  private readonly scope: string;

  rocketsInHotbar(): { count: number; slot: number } {
    return rocketsInHotbar(this.d.inventory);
  }

  /** The last use has settled (ROCKET_COOLDOWN ticks ago or more). */
  canFire(tick: number): boolean {
    return tick - this.lastFire >= ROCKET_COOLDOWN;
  }

  /** A new flight: the counters and the entity match start over. */
  reset(): void {
    this.lastFire = -1000;
    this.fired = 0;
    this.wasted = 0;
    this.pending = [];
    this.live.clear();
  }

  /** A rocket of ours burns, or a use still waits for its entity. */
  get burning(): boolean {
    return this.live.size > 0 || this.pending.length > 0;
  }

  /**
   * Once a tick (before the controls): a use whose rocket entity never came within ROCKET_ADD_WITHIN ticks
   * fired nothing (the server ignores a rocket used before the glide's first gliding input): its boost is
   * taken back from the loop (the inputs since the use re-simulated without it) and the caller told.
   */
  tick(now: number): void {
    while (this.pending.length && now - this.pending[0]! > ROCKET_ADD_WITHIN) {
      const at = this.pending.shift()!;
      this.wasted++;
      this.log.info(`${this.scope}: the rocket used at tick ${at} fired nothing (no rocket entity in ${ROCKET_ADD_WITHIN} ticks): its boost taken back`);
      if (this.live.size === 0 && this.pending.length === 0) {
        this.d.loop.endBoost(now - at);
        this.onEnd?.();
      }
    }
  }

  /** Use the rocket in `slot` now (at `tick`, the body's feet at `feet`): the transaction, the loop's boost. */
  fire(slot: number, feet: Vec3, tick: number): void {
    const { inventory, hotbar } = this.d;
    if (inventory.selected !== slot) hotbar.select(slot);
    const held = wireItemOf(inventory.slots[slot], (inventory.rawItem(0, slot) ?? hotbar.rawItem(slot)) as Parameters<typeof wireItemOf>[1]);
    this.d.queue('inventory_transaction', useItemTransaction({ hotbarSlot: slot, held, eye: { x: feet.x, y: feet.y + PHYSICS.eyeHeight, z: feet.z } }));
    this.d.loop.boost();
    this.lastFire = tick;
    this.pending.push(tick);
    this.fired++;
    this.log.debug(`${this.scope}: rocket from slot ${slot} (${inventory.slots[slot]?.count ?? '?'} there)`);
  }

  /** Watch the rocket entities (the add after a use, the remove that ends the boost) until the returned function is called. `tick` gives the flight's tick now. */
  attach(tick: () => number): () => void {
    const offAdd = this.d.entities.onAdd((e) => {
      if (e.type !== 'minecraft:fireworks_rocket' || !this.pending.length || tick() - this.pending[0]! > ROCKET_ADD_WITHIN) return;
      const p = this.d.loop.state.pos;
      if (Math.hypot(e.pos.x - p.x, e.pos.y - p.y, e.pos.z - p.z) > ROCKET_NEAR) return;
      this.pending.shift();
      this.live.add(e.uniqueId);
    });
    const offRemove = this.d.entities.onRemove((e) => {
      if (!this.live.delete(e.uniqueId)) return;
      // the boost ends with the LAST rocket (the union of the lifetimes), and not while a newer use still waits for its entity
      if (this.live.size > 0 || this.pending.length > 0) return;
      this.d.loop.endBoost();
      this.onEnd?.();
    });
    return () => {
      offAdd();
      offRemove();
    };
  }
}
