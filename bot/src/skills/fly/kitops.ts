// Flight kit operations (wave 11, Track AU; docs/flight.md "The kit"): what a flight does on the
// ground before the takeoff and after the landing, never in the air:
//
//   wearElytra        the chestplate comes off into the inventory and the elytra goes into the chest
//                     slot (armour window 120, slot 1: one `swap` or `place` item_stack_request with
//                     the inventory screen open, survival/armour.ts); wearChestplate puts it back
//   rocketsToHotbar   a stack of rockets moves from the main inventory into a free hotbar slot (a full
//                     hotbar parks its least useful item, e.g. a shulker box, in the main inventory first)
//   refillFromBox     the fireworks box is placed next to the bot (the stash primitive of
//                     container/stash.ts: a free cell with a solid top), opened, rockets are taken out
//                     up to a stack in the hotbar, it is closed, broken and picked up again
//
// All of it is plain inventory work a vanilla player does; nothing here touches the flight model.
import type { Vec3 } from '../../connection/types.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ContainerView, ItemStack } from '../../world/types.ts';
import { isShulkerBox } from '../container/chest.ts';
import { hotbarTarget } from '../container/hotbar-moves.ts';
import { boxSpots } from '../container/stash.ts';
import type { ArmourController, ArmourMove } from '../survival/armour.ts';
import { armourSlotOf } from '../survival/armour.ts';
import type { StackRequests } from '../survival/screen.ts';
import { isRocket, readKit, ROCKET, type FlightKitMemory, type KitInventory } from './kit.ts';

export interface KitOpsSkills {
  open(p: Vec3): Promise<{ ok: true; view: ContainerView } | { ok: false; reason: string }>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  place(p: Vec3, opts?: { face?: 'up'; item?: string }): Promise<{ ok: boolean; reason?: string }>;
  dig(p: Vec3): Promise<{ ok: boolean; reason?: string }>;
  collect(radius: number, timeoutTicks: number, opts?: { origin?: Vec3; filter?: (i: ItemStack) => boolean }): Promise<unknown>;
  /** ChestSkill.take: a container slot into the inventory (hotbar slots preferred). */
  take(view: ContainerView, slot: number, count?: number, prefer?: readonly number[]): Promise<{ ok: boolean; reason?: string; moved: number }>;
}

export interface KitOpsDeps {
  inventory: KitInventory & { window(id: number): ContainerView | undefined; freeSlots(): number[]; readonly selected?: number };
  armour: Pick<ArmourController, 'wear' | 'worn'>;
  requests: Pick<StackRequests, 'withScreen'>;
  /** world/containers.ts: a predicted move between player slots (under the inventory screen). */
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
  skills: KitOpsSkills;
  blockAt(p: Vec3): BlockInfo | undefined;
  position(): Vec3 | undefined;
  waitTicks(n: number): Promise<void>;
  memory?: () => FlightKitMemory;
  log?: Logger;
}

export interface KitOpResult {
  ok: boolean;
  reason?: string;
}

export interface RefillResult extends KitOpResult {
  /** Rockets taken out of the box. */
  taken: number;
  /** The box came back into the inventory. */
  pickedUp: boolean;
  where?: Vec3;
}

export class FlightKitOps {
  private readonly d: KitOpsDeps;
  private readonly log: Logger;
  /** The chestplate taken off for the flight (its name), put back after the landing. */
  private chestplate: string | undefined;

  constructor(deps: KitOpsDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
  }

  private kit() {
    return readKit(this.d.inventory, this.d.memory?.() ?? {});
  }

  /** The elytra into the chest slot (the chestplate, if any, comes off into its inventory slot). */
  async wearElytra(): Promise<KitOpResult> {
    const k = this.kit();
    if (k.elytraWorn) return { ok: true };
    if (k.elytraSlot < 0) return { ok: false, reason: 'no elytra in the inventory' };
    const worn = this.d.armour.worn()[1] ?? null;
    const move: ArmourMove = { slot: 1, from: k.elytraSlot, item: 'elytra', replaces: worn?.name ?? null };
    const ok = await this.d.armour.wear(move);
    if (!ok) return { ok: false, reason: 'the elytra could not be put on (item stack request refused)' };
    this.chestplate = worn && armourSlotOf(worn.name) === 1 ? worn.name : undefined;
    this.log.info(`flight kit: wearing the elytra${this.chestplate ? ` (${this.chestplate} off)` : ''}`);
    return { ok: true };
  }

  /** The chestplate back on (the elytra comes off into the inventory). Nothing to do without one. */
  async wearChestplate(): Promise<KitOpResult> {
    const slots = this.d.inventory.slots;
    const name = this.chestplate;
    let from = -1;
    for (let i = 0; i < Math.min(36, slots.length); i++) {
      const s = slots[i];
      if (!s || s.count <= 0 || armourSlotOf(s.name) !== 1) continue;
      if (from < 0 || (name !== undefined && s.name === name)) from = i;
      if (s.name === name) break;
    }
    if (from < 0) return { ok: true };
    const worn = this.d.armour.worn()[1] ?? null;
    const item = slots[from]!.name;
    const ok = await this.d.armour.wear({ slot: 1, from, item, replaces: worn?.name ?? null });
    if (ok) this.chestplate = undefined;
    this.log.info(`flight kit: ${ok ? `wearing the ${item} again` : `could not put the ${item} back on`}`);
    return ok ? { ok: true } : { ok: false, reason: `the ${item} could not be put back on` };
  }

  /** A stack of rockets from the main inventory into a free hotbar slot (when the hotbar has none). */
  async rocketsToHotbar(): Promise<KitOpResult> {
    const k = this.kit();
    if (k.rocketsHotbar > 0 || k.rockets === 0) return { ok: true };
    const slots = this.d.inventory.slots;
    let from = -1;
    for (let i = 9; i < Math.min(36, slots.length); i++) {
      const s = slots[i];
      if (s && s.count > 0 && isRocket(s.name) && (from < 0 || s.count > slots[from]!.count)) from = i;
    }
    if (from < 0) return { ok: false, reason: 'no rockets' };
    let to = -1;
    for (let i = 8; i >= 0 && to < 0; i--) if (!slots[i]) to = i;
    const r = await this.d.requests.withScreen(async () => {
      if (to < 0) {
        const parked = await this.makeHotbarRoom();
        if (typeof parked === 'string') return { ok: false, reason: parked };
        to = parked;
      }
      return this.d.move({ window: 0, slot: from }, { window: 0, slot: to }, slots[from]!.count);
    });
    if (!('ok' in r) || !r.ok) return { ok: false, reason: `moving the rockets to the hotbar failed${'reason' in r && r.reason ? ` (${r.reason})` : ''}` };
    return { ok: true };
  }

  /**
   * A full hotbar (inventory screen open): the least useful hotbar item (hotbar-moves.ts `hotbarTarget`:
   * a block or box before food before a tool, the held slot last; never rockets or the elytra) moves into
   * a free main-inventory slot; the freed hotbar slot, or why not.
   */
  private async makeHotbarRoom(): Promise<number | string> {
    const inv = this.d.inventory;
    const t = hotbarTarget({ slots: inv.slots, selected: inv.selected ?? -1 }, (it) => (isRocket(it.name) ? 1 : 0), (it) => it.name === 'elytra');
    if (!t) return 'no hotbar slot can be freed for the rockets';
    if (t.empty) return t.slot;
    let park = -1;
    for (let i = 9; i < 36 && park < 0; i++) if (!inv.slots[i]) park = i;
    if (park < 0) return 'the inventory is full (no slot to move a hotbar item to for the rockets)';
    const it = inv.slots[t.slot]!;
    const m = await this.d.move({ window: 0, slot: t.slot }, { window: 0, slot: park }, it.count);
    if (!m.ok) return `moving the ${it.name} out of the hotbar failed${m.reason ? ` (${m.reason})` : ''}`;
    this.log.info(`flight kit: moved the ${it.name} from hotbar slot ${t.slot} to slot ${park} for the rockets`);
    return t.slot;
  }

  /**
   * Refill the hotbar from the fireworks box: place it, take rockets until the hotbar holds a stack
   * (or the box is empty), pick it up again. `alive()` false (a pre-emption) stops between steps; the
   * box is always broken and picked up when it was placed.
   */
  async refillFromBox(alive: () => boolean = () => true): Promise<RefillResult> {
    const k = this.kit();
    const none: RefillResult = { ok: false, taken: 0, pickedUp: false };
    if (k.boxSlot < 0) return { ...none, reason: 'no fireworks box' };
    if (k.boxRockets <= 0) return { ...none, reason: 'the fireworks box is empty' };
    const feet = this.d.position();
    const spots = feet ? boxSpots((q) => this.d.blockAt(q), feet) : [];
    if (spots.length === 0) return { ...none, reason: 'no free cell next to me for the box' };
    const item = this.d.inventory.slots[k.boxSlot]?.name ?? 'undyed_shulker_box';
    const sk = this.d.skills;
    let at: Vec3 | undefined;
    let reason: string | undefined;
    for (const p of spots.slice(0, 3)) {
      const r = await sk.place(p, { face: 'up', item });
      if (!alive()) return { ...none, reason: 'interrupted' };
      if (r.ok) {
        at = p;
        break;
      }
      reason = `place: ${r.reason ?? 'failed'}`;
    }
    if (!at) return { ...none, ...(reason ? { reason } : {}) };
    const out: RefillResult = { ok: false, taken: 0, pickedUp: false, where: at };
    await this.d.waitTicks(2);
    const o = await sk.open(at);
    if (alive() && o.ok) {
      const hotbarFree = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !this.d.inventory.slots[i]);
      let want = 64 - this.kit().rocketsHotbar;
      const view = o.view;
      for (let slot = 0; slot < 27 && want > 0 && alive(); slot++) {
        const s = this.d.inventory.window(view.id)?.slots[slot];
        if (!s || s.count <= 0 || !isRocket(s.name)) continue;
        const r = await sk.take(view, slot, Math.min(want, s.count), hotbarFree);
        out.taken += r.moved;
        want -= r.moved;
        if (!r.ok) {
          out.reason = `take: ${r.reason ?? 'failed'}`;
          break;
        }
      }
      await sk.closeContainer(view);
    } else if (!o.ok) out.reason = `open: ${o.reason}`;
    // break the box and pick it up again, whatever happened (never leave the kit behind)
    const before = this.boxesCarried();
    const dug = await sk.dig(at);
    if (!dug.ok) {
      out.reason = `break: ${dug.reason ?? 'failed'} (the box is still at ${at.x} ${at.y} ${at.z})`;
      return out;
    }
    for (const radius of [4, 6]) {
      await sk.collect(radius, 100, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, filter: (i) => isShulkerBox(i.name) });
      if (this.boxesCarried() > before) break;
    }
    out.pickedUp = this.boxesCarried() > before;
    if (!out.pickedUp) out.reason = `the box was not picked up again (left at ${at.x} ${at.y} ${at.z})`;
    out.ok = out.taken > 0 && out.pickedUp;
    this.log.info(`flight kit: refill ${out.ok ? 'ok' : 'failed'}: took ${out.taken} ${ROCKET}${out.reason ? ` (${out.reason})` : ''}`);
    return out;
  }

  private boxesCarried(): number {
    let n = 0;
    for (const s of this.d.inventory.slots.slice(0, 36)) if (s && isShulkerBox(s.name)) n += s.count;
    return n;
  }
}
