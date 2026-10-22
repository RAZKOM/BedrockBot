// Item stack requests the survival kit sends itself (armour into the armour container, drops), and the
// inventory screen they need. Verified on BDS 1.26.60.6 (docs/survival.md "Packets"):
//   - a request that touches a main-inventory slot (9..35) or the armour container is refused unless
//     the inventory screen is open (status 49 / 50, as for PlaceSkill's main -> hotbar move,
//     docs/interaction.md): `interact open_inventory` -> container_open (type 'inventory', window 2,3..)
//     ... container_close;
//   - a `drop` from a hotbar slot works without the screen.
// Request ids are negative odd numbers from -100001 down, a range world/containers.ts (which counts
// from -1) never reaches in practice, so its pending map and ours never answer each other.
// Containers.handleResponses still applies every ok response to the model (counts of hotbar /
// inventory slots); the armour window itself is updated by the server's inventory_slot.
import type { PacketSource } from '../../world/types.ts';

export interface StackResponseLike {
  status: 'ok' | 'error' | number;
  request_id: number;
  containers?: { slot_type: { container_id: string | number }; slots: { slot: number; count: number; item_stack_id?: number }[] }[];
}

export interface ScreenContainers {
  readonly open: { id: number; type: string } | undefined;
  onOpen(fn: (c: { id: number; type: string }) => void): () => void;
  onClose(fn: (id: number, byServer: boolean) => void): () => void;
  close(id: number, type?: string): void;
}

export interface ScreenDeps {
  source: Pick<PacketSource, 'on' | 'queue'>;
  containers: ScreenContainers;
  loop: { waitTicks(n: number): Promise<void> };
  runtimeId: () => bigint;
}

export interface SlotInfo {
  slot_type: { container_id: string };
  slot: number;
  stack_id: number;
}

export function slotInfo(containerId: string, slot: number, stackId: number | undefined): SlotInfo {
  return { slot_type: { container_id: containerId }, slot, stack_id: stackId ?? 0 };
}

/** The slot info of player inventory slot 0..35 (hotbar 0..8, main 9..35). */
export function inventorySlot(slot: number, stackId: number | undefined): SlotInfo {
  return slotInfo(slot < 9 ? 'hotbar' : 'inventory', slot, stackId);
}

export class StackRequests {
  private readonly d: ScreenDeps;
  private next = -100001;
  private readonly pending = new Map<number, (r: StackResponseLike) => void>();
  private readonly off: () => void;
  private screenBusy = false;

  constructor(deps: ScreenDeps) {
    this.d = deps;
    this.off = deps.source.on('item_stack_response', (p) => {
      for (const r of (p as unknown as { responses: StackResponseLike[] }).responses ?? []) {
        const fn = this.pending.get(r.request_id);
        if (fn) {
          this.pending.delete(r.request_id);
          fn(r);
        }
      }
    });
  }

  dispose(): void {
    this.off();
    this.pending.clear();
  }

  /** Send one request (its actions) and wait for the response (status 'timeout' after `timeoutTicks`). */
  async send(actions: Record<string, unknown>[], timeoutTicks = 40): Promise<StackResponseLike | { status: 'timeout'; request_id: number }> {
    const id = this.next;
    this.next -= 2;
    let got: StackResponseLike | undefined;
    this.pending.set(id, (r) => {
      got = r;
    });
    this.d.source.queue('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [], cause: 'chat_public' }] });
    for (let i = 0; i < timeoutTicks && !got; i++) await this.d.loop.waitTicks(1);
    this.pending.delete(id);
    return got ?? { status: 'timeout', request_id: id };
  }

  /**
   * Run `fn` with the inventory screen open (open it if no container is open, close it afterwards).
   * One screen at a time: a second caller waits.
   */
  async withScreen<T>(fn: () => Promise<T>): Promise<T | { ok: false; reason: 'no_inventory_window' }> {
    const c = this.d.containers;
    if (c.open) return fn();
    for (let i = 0; i < 100 && this.screenBusy; i++) await this.d.loop.waitTicks(1);
    this.screenBusy = true;
    try {
      let opened: { id: number; type: string } | undefined;
      const offOpen = c.onOpen((o) => {
        if (o.type === 'inventory') opened = o;
      });
      this.d.source.queue('interact', { action_id: 'open_inventory', target_entity_id: this.d.runtimeId(), has_position: false });
      for (let i = 0; i < 20 && !opened; i++) await this.d.loop.waitTicks(1);
      offOpen();
      if (!opened) return { ok: false, reason: 'no_inventory_window' };
      try {
        return await fn();
      } finally {
        const id = opened.id;
        let closed = false;
        const offClose = c.onClose((cid) => {
          if (cid === id) closed = true;
        });
        c.close(id, 'inventory');
        for (let i = 0; i < 20 && !closed; i++) await this.d.loop.waitTicks(1);
        offClose();
      }
    } finally {
      this.screenBusy = false;
    }
  }
}

export const isOk = (r: { status: unknown }): boolean => r.status === 'ok' || r.status === 0;
