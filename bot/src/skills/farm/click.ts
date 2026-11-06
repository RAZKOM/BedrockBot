// Use a held item on a block that is not a placement (PLAN.md task 7.13): bone meal on a crop, the
// empty hand on a sweet berry bush. Same packet as placing and using doors (docs/interaction.md):
// inventory_transaction item_use / click_block on the block itself, with the item in the selected
// hotbar slot as `held_item`. Verified on BDS 1.26.60.6 (docs/farming.md): bone meal on wheat is
// answered 2 ticks after the click with an update_block that raises `growth` (0 -> 4 -> 7 in the
// probe, 2 to 5 stages per use) and an inventory update with one bone meal less; the truth pack sees
// playerInteractWithBlock (face Up, item bone_meal).
//
// PlaceSkill cannot do this: it only clicks into replaceable cells; UseSkill only knows doors, gates,
// trapdoors, buttons and levers. Both skills' modules are other tracks', so this is a small sibling.
import { silentLogger, type Logger } from '../../log.ts';
import type { Inventory } from '../../world/inventory.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { blockCenter, EYE_HEIGHT, lookAngles, type Face } from '../dig/look.ts';
import { closestDistance, cornerDistance, DEFAULT_CLICK_REACH, hotbarRoom, SERVER_CLICK_REACH, wireItemOf } from '../place/place.ts';
import type { SkillResult } from '../types.ts';

export type ClickReason = 'not_ready' | 'unloaded' | 'no_item' | 'no_hotbar' | 'move_failed' | 'out_of_reach' | 'rejected' | 'timeout' | 'interrupted' | 'busy';

export type ClickResult = (SkillResult & { reason?: ClickReason | (string & {}) }) & {
  /** Block before and after (the update the server sent). */
  before?: BlockInfo;
  after?: BlockInfo;
  /** Ticks from the call / from the click to the update_block. */
  ticks?: number;
  clickTicks?: number;
  slot?: number;
};

export interface ClickOptions {
  /** Face index of the clicked block (default 1, up). */
  face?: Face;
  /** Ticks to wait for an answer after the click. Default 20. */
  timeoutTicks?: number;
  /** Own reach, eye to the closest point of the block. Default 5. */
  reach?: number;
  /** Turn to the block first (2 ticks). Default true. */
  look?: boolean;
}

export interface ClickLoop {
  readonly state: { pos: Vec3; tick: bigint; ready: boolean };
  setCommand(c: { yaw?: number; pitch?: number }): void;
  waitTicks(n: number): Promise<void>;
}

export interface ClickWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: Inventory;
}

export interface ClickHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
  noteRaw?(slot: number, item: ItemV4 | undefined): void;
}

/** Item moves between inventory slots (world/containers.ts). */
export interface ClickMover {
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
  readonly open?: { id: number; type: string } | undefined;
  onOpen?(fn: (c: { id: number; type: string }) => void): () => void;
  onClose?(fn: (id: number, byServer: boolean) => void): () => void;
  close?(id: number, type?: string): void;
}

export interface ClickDeps {
  source: Pick<PacketSource, 'queue'>;
  loop: ClickLoop;
  world: ClickWorld;
  hotbar?: ClickHotbar;
  containers?: ClickMover;
  runtimeId?: () => bigint;
  logger?: Logger;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const sameState = (a: BlockInfo, b: BlockInfo) => a.name === b.name && JSON.stringify(a.states) === JSON.stringify(b.states);

export class ItemClicker {
  private readonly d: ClickDeps;
  private readonly log: Logger;
  private running = false;
  private cancelled = false;

  constructor(deps: ClickDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  /**
   * Click block `p` holding `item` (a name; null = a slot that holds none of `avoid`, e.g. the empty
   * hand for berries). Resolves on the first update_block at `p`: a changed block is ok, the same
   * block 'rejected'.
   */
  async useOn(pos: Vec3, item: string | null, opts: ClickOptions & { avoid?: readonly string[] } = {}): Promise<ClickResult> {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    this.cancelled = false;
    try {
      return await this.run({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, item, opts);
    } finally {
      this.running = false;
    }
  }

  private async run(p: Vec3, item: string | null, opts: ClickOptions & { avoid?: readonly string[] }): Promise<ClickResult> {
    const { loop, world, source } = this.d;
    const t0 = loop.state.tick;
    if (!loop.state.ready) return { ok: false, reason: 'not_ready' };
    const before = world.blockAt(p);
    if (!before) return { ok: false, reason: 'unloaded' };
    const reach = opts.reach ?? DEFAULT_CLICK_REACH;
    const out = (e: Vec3) => closestDistance(e, p) > reach || cornerDistance(e, p) > SERVER_CLICK_REACH;
    if (out(this.eye())) return { ok: false, reason: 'out_of_reach', before };

    const sel = await this.select(item, opts.avoid ?? []);
    if (!sel.ok) return { ok: false, reason: sel.reason, before };
    if (this.cancelled) return { ok: false, reason: 'interrupted', before };
    if (opts.look ?? true) {
      loop.setCommand(lookAngles(this.eye(), blockCenter(p)));
      await loop.waitTicks(2);
    } else {
      await loop.waitTicks(1);
    }
    if (this.cancelled) return { ok: false, reason: 'interrupted', before };
    const eye = this.eye();
    if (out(eye)) return { ok: false, reason: 'out_of_reach', before };

    let answer: BlockInfo | undefined;
    let at = 0n;
    const off = world.onBlockUpdate((q, _b, after) => {
      if (answer || !samePos(q, p)) return;
      answer = after;
      at = loop.state.tick;
    });
    const slot = sel.slot;
    const inv = world.inventory;
    const held = wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? this.d.hotbar?.rawItem(slot));
    const tick0 = loop.state.tick;
    source.queue(
      'inventory_transaction',
      clickBlockTransaction({ pos: p, face: opts.face ?? 1, hotbarSlot: slot, held, eye, blockRuntimeId: world.chunks.runtimeIdAt(p.x, p.y, p.z) ?? 0 }),
    );
    try {
      const timeout = opts.timeoutTicks ?? 20;
      for (let i = 0; i < timeout && !answer && !this.cancelled; i++) await loop.waitTicks(1);
    } finally {
      off();
    }
    if (!answer) return { ok: false, reason: this.cancelled ? 'interrupted' : 'timeout', before, slot };
    const ticks = Number(at - t0);
    const clickTicks = Number(at - tick0);
    if (sameState(answer, before)) {
      this.log.info(`click ${fmt(p)} ${before.name} with ${item ?? 'hand'}: rejected`);
      return { ok: false, reason: 'rejected', before, after: answer, ticks, clickTicks, slot };
    }
    this.log.info(`click ${fmt(p)} ${before.name} with ${item ?? 'hand'}: ${JSON.stringify(before.states)} -> ${answer.name} ${JSON.stringify(answer.states)} after ${ticks} ticks (click +${clickTicks})`);
    return { ok: true, before, after: answer, ticks, clickTicks, slot };
  }

  /** Select a hotbar slot holding `item` (fetching it from the main inventory if needed). */
  private async select(item: string | null, avoid: readonly string[]): Promise<{ ok: true; slot: number } | { ok: false; reason: ClickReason }> {
    const inv = this.d.world.inventory;
    const fits = (s: number) => {
      const i = inv.slots[s];
      return item === null ? !i || !avoid.includes(i.name) : !!i && i.count > 0 && i.name === item;
    };
    let slot = -1;
    if (fits(inv.selected)) slot = inv.selected;
    for (let s = 0; s < 9 && slot < 0; s++) if (fits(s)) slot = s;
    if (slot < 0 && item !== null) {
      let src = -1;
      for (let s = 9; s < 36 && src < 0; s++) if (fits(s)) src = s;
      if (src < 0) return { ok: false, reason: 'no_item' };
      // a full hotbar: park its least useful item first (place.ts hotbarRoom)
      const room = hotbarRoom(inv.slots, inv.selected, src, (i) => i.name === item);
      const mover = this.d.containers;
      if (!room || !mover) return { ok: false, reason: 'move_failed' };
      const dst = room.dst;
      const n = inv.slots[src]!.count;
      const parked = room.park !== undefined ? inv.slots[dst]! : undefined;
      const r = await this.withInventoryOpen(mover, async () => {
        if (parked && room.park !== undefined) {
          const pr = await mover.move({ window: 0, slot: dst }, { window: 0, slot: room.park }, parked.count);
          if (!pr.ok) return pr;
        }
        return mover.move({ window: 0, slot: src }, { window: 0, slot: dst }, n);
      });
      if (!r.ok) return { ok: false, reason: 'move_failed' };
      this.d.hotbar?.noteRaw?.(dst, wireItemOf(inv.slots[dst], undefined));
      slot = dst;
    }
    if (slot < 0) return { ok: false, reason: 'no_item' };
    if (slot !== inv.selected) {
      if (!this.d.hotbar) return { ok: false, reason: 'no_hotbar' };
      this.d.hotbar.select(slot);
    }
    return { ok: true, slot };
  }

  /** BDS refuses moves between player inventory slots unless the inventory screen is open (docs/interaction.md "Items"). */
  private async withInventoryOpen(c: ClickMover, fn: () => Promise<{ ok: boolean; reason?: string }>): Promise<{ ok: boolean; reason?: string }> {
    if (!c.onOpen || !c.close || c.open) return fn();
    const { loop, source } = this.d;
    let opened: { id: number; type: string } | undefined;
    const offOpen = c.onOpen((o) => {
      if (o.type === 'inventory') opened = o;
    });
    source.queue('interact', { action_id: 'open_inventory', target_entity_id: this.d.runtimeId?.() ?? 0n, has_position: false });
    for (let i = 0; i < 20 && !opened; i++) await loop.waitTicks(1);
    offOpen();
    if (!opened) return { ok: false, reason: 'no_inventory_window' };
    try {
      return await fn();
    } finally {
      const id = opened.id;
      let closed = false;
      const offClose = c.onClose?.((cid) => {
        if (cid === id) closed = true;
      });
      c.close(id, 'inventory');
      for (let i = 0; i < 20 && !closed && offClose; i++) await loop.waitTicks(1);
      offClose?.();
    }
  }
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
