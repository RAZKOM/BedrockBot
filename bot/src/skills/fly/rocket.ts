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
/**
 * Track F9a: a use written off (no entity within ROCKET_ADD_WITHIN) is remembered this many ticks: a rocket entity that
 * appears by then where the rocket was used is that rocket after all, and is said so in the log (the Realm's log has
 * rockets that "fired nothing" in the middle of a climb, at 1.5 a tick: the entity appears where the SERVER's body used
 * the rocket, and by the time its `add_entity` is read the local body is the round trip farther on).
 */
export const ROCKET_LATE = 20;
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
  /** Track F9a: rocket entities that came for a use already written off (the rocket did fire: the write-off was wrong). */
  late = 0;
  /** The uses still waiting for their rocket entity (oldest first): the tick and where the body was. */
  private pending: { tick: number; at: Vec3 }[] = [];
  /** Track F9a: the uses written off, for ROCKET_LATE ticks. */
  private gone: { tick: number; at: Vec3 }[] = [];
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
    this.late = 0;
    this.pending = [];
    this.gone = [];
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
    while (this.gone.length && now - this.gone[0]!.tick > ROCKET_LATE) this.gone.shift();
    while (this.pending.length && now - this.pending[0]!.tick > ROCKET_ADD_WITHIN) {
      const use = this.pending.shift()!;
      const at = use.tick;
      this.gone.push(use);
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
    this.pending.push({ tick, at: { ...feet } });
    this.fired++;
    this.log.debug(`${this.scope}: rocket from slot ${slot} (${inventory.slots[slot]?.count ?? '?'} there)`);
  }

  /** Watch the rocket entities (the add after a use, the remove that ends the boost) until the returned function is called. `tick` gives the flight's tick now. */
  attach(tick: () => number): () => void {
    const offAdd = this.d.entities.onAdd((e) => {
      if (e.type !== 'minecraft:fireworks_rocket') return;
      const p = this.d.loop.state.pos;
      const from = (q: Vec3): number => Math.hypot(e.pos.x - q.x, e.pos.y - q.y, e.pos.z - q.z);
      const use = this.pending[0];
      if (!use || tick() - use.tick > ROCKET_ADD_WITHIN) {
        // Track F9a: no use waits for it; one written off a moment ago, used near where it appears: that rocket did fire
        const late = this.gone.findIndex((g) => from(g.at) <= ROCKET_NEAR);
        if (late >= 0) {
          const g = this.gone.splice(late, 1)[0]!;
          this.late++;
          this.log.info(`${this.scope}: a rocket entity ${tick() - g.tick} ticks after the use at tick ${g.tick} that was written off, ${from(g.at).toFixed(1)} from where it was used (${from(p).toFixed(1)} from the body now): that rocket did fire, the write-off was wrong`);
        }
        return;
      }
      // (Track F9a: ours when it appears near the body now, or near where the body used the rocket: the server spawns it at its
      // own body, and at 1.5 a tick the local body is a round trip of ticks past that when the packet is read)
      if (from(p) > ROCKET_NEAR && from(use.at) > ROCKET_NEAR) {
        this.log.info(`${this.scope}: a rocket entity ${from(p).toFixed(1)} from the body and ${from(use.at).toFixed(1)} from where the rocket was used at tick ${use.tick} (${tick() - use.tick} ticks ago): not taken as ours`);
        return;
      }
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
