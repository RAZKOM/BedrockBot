// Track P1 (docs/versions.md "Packets the bot cannot read", ADR 0092): the inventory model after a packet the bot could
// not read.
//
// A packet that fails to parse is dropped by bedrock-protocol, so whatever it changed never reaches the model: on the
// Realm (2026-11-16) a lost item_stack_response made the survival kit roll back a box swap the server had done, and the
// room chore's next steps worked on slots that no longer held what the model said. The rule:
//   1. a lost packet that can change the inventory (INVENTORY_PACKETS, or one whose id has no name) marks the model
//      unsure and asks the server for the whole inventory at once: an `inventory_mismatch` inventory transaction, the
//      vanilla client's own request. BDS 1.26.60.6 answers it within one tick with inventory_content for the
//      inventory, armour, offhand and ui windows and a player_hotbar (measured on bds-home, 90 ms);
//   2. the model is sure again with the next full inventory_content of window 0; until then item stack requests wait
//      for it (up to 3 s: StackRequests, Containers) instead of being built on a slot that may be stale;
//   3. a request that ends without its response after a lost packet asks again once the caller has rolled its
//      prediction back (the rollback of a swap the server did is undone by the server's own inventory);
//   4. no answer in 3 s: asked again, at most 3 times; then the model is used as it is (WARN).
import { silentLogger, type Logger } from '../log.ts';
import type { Inventory } from './inventory.ts';
import type { PacketSource } from './types.ts';

/** Packets whose loss can leave the inventory model stale. */
export const INVENTORY_PACKETS: ReadonlySet<string> = new Set([
  'item_stack_response',
  'inventory_content',
  'inventory_slot',
  'inventory_transaction',
  'player_hotbar',
  'mob_equipment',
  'mob_armor_equipment',
  'container_open',
  'container_close',
  'update_equipment',
]);

/** The vanilla client's "send me my inventory again" (ComplexInventoryTransaction type 1). */
export function mismatchTransaction(): Record<string, unknown> {
  return { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'inventory_mismatch', actions: [] } };
}

export const RESYNC_WAIT_MS = 3000;
export const RESYNC_TRIES = 3;

/** A lost packet as the Connection tells it (connection/readErrors.ts ReadFailure). */
export interface LostPacket {
  id?: number | undefined;
  name?: string | undefined;
}

export interface ResyncDeps {
  source: Pick<PacketSource, 'queue'> & { onTick?(fn: (tick: bigint) => void): () => void };
  inventory: Inventory;
  logger?: Logger;
  now?: () => number;
}

/** Does losing this packet leave the inventory unsure? (unnamed ids too: they may be anything) */
export function touchesInventory(p: LostPacket): boolean {
  return p.name === undefined || INVENTORY_PACKETS.has(p.name);
}

export class InventoryResync {
  private readonly d: ResyncDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** Date.now() of the last request sent, and the requests since the model was last sure. */
  private sentAt: number | undefined;
  private tries = 0;
  private reason = '';
  private readonly unsubs: (() => void)[] = [];
  readonly stats = { lost: 0, asked: 0, resynced: 0, gaveUp: 0, lastMs: 0 };
  /** Off: a lost packet changes nothing (the e2e's before case; no setting, the rule is always on). */
  enabled = true;

  constructor(deps: ResyncDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.now = deps.now ?? Date.now;
    deps.inventory.resyncer = (reason) => this.ask(reason);
    this.unsubs.push(
      deps.inventory.onChange((window, slot) => {
        if (window === 0 && slot === undefined) this.check();
      }),
    );
    if (deps.source.onTick) this.unsubs.push(deps.source.onTick(() => this.tick()));
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    if (this.d.inventory.resyncer) this.d.inventory.resyncer = undefined;
  }

  /** A packet was lost (Connection.onReadError). */
  lost(p: LostPacket): void {
    if (!this.enabled || !touchesInventory(p)) return;
    this.stats.lost++;
    const what = `unreadable ${p.name ?? `packet ${p.id ?? '?'}`}`;
    this.d.inventory.markLost(what);
    this.ask(what);
  }

  /** Ask the server for the whole inventory (once per RESYNC_WAIT_MS while one is outstanding). */
  ask(reason: string): void {
    if (!this.enabled) return;
    const inv = this.d.inventory;
    if (inv.unsure === undefined) inv.markUnsure(reason);
    const t = this.now();
    if (this.sentAt !== undefined && t - this.sentAt < RESYNC_WAIT_MS && this.tries > 0) return;
    this.send(reason, t);
  }

  private send(reason: string, t: number): void {
    this.sentAt = t;
    this.tries++;
    this.reason = reason;
    this.stats.asked++;
    this.d.source.queue('inventory_transaction', mismatchTransaction());
    this.log.info(`inventory: ${reason}; asked the server for the whole inventory (try ${this.tries} of ${RESYNC_TRIES})`);
  }

  /** The model is sure again (a window 0 inventory_content arrived). */
  private check(): void {
    if (this.sentAt === undefined || this.d.inventory.unsure !== undefined) return;
    const ms = this.now() - this.sentAt;
    this.stats.resynced++;
    this.stats.lastMs = ms;
    this.log.info(`inventory: resynced ${ms} ms after asking (${this.reason})`);
    this.sentAt = undefined;
    this.tries = 0;
  }

  /** Retries and the give-up (driven by the connection's ticks; tests call it directly). */
  tick(): void {
    const inv = this.d.inventory;
    if (this.sentAt === undefined) return;
    if (inv.unsure === undefined) return this.check();
    const t = this.now();
    if (t - this.sentAt < RESYNC_WAIT_MS) return;
    if (this.tries < RESYNC_TRIES) return this.send(this.reason, t);
    this.stats.gaveUp++;
    this.log.warn(`inventory: the server sent no inventory after ${this.tries} requests (${this.reason}); the model is used as it is`);
    this.sentAt = undefined;
    this.tries = 0;
    inv.clearUnsure();
  }
}
