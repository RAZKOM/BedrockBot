// Track K7 (ADR 0121, docs/flight.md "Renewing an elytra at an anvil (Track K7)"): one anvil operation over the protocol.
// Measured on BDS 1.26.60.6 (test/e2e/repair.test.ts `REPAIR_PROBE=wire` and `ops`):
//
//   open    the chest click on the anvil block (any of anvil, chipped_anvil, damaged_anvil) -> container_open window_type
//           'anvil' at the block; no screen of the bot's own is needed
//   fill    one item_stack_request of `place` actions: the target (count 1) from its player slot into anvil_input slot 1,
//           the material (exactly the units the repair consumes) or the second item (count 1) into anvil_material slot 2;
//           the response gives their stack ids there
//   craft   one request: { type_id 'optional', legacy_type_id 15 (BDS CraftRecipeOptional), recipe_network_id 0,
//           filtered_string_index -1, or 0 with the item's name as custom_names[0] and cause 'anvil_text' (the name kept:
//           without it the name is cleared, 1 level more) }, `consume` 1 from anvil_input, `consume` the units from
//           anvil_material, `place` 1 from creative_output slot 50 (stack id: this request's own id) into an empty player
//           slot. ok: the response's destination slot has the new stack id and `durability_correction`, the damage after;
//           no inventory_slot follows, so the item's NBT (RepairCost, the name) is read back with a resync. Status 9: too
//           few levels or too expensive (40 levels or more); `error`: a consume that does not match what the server takes
//   back    what the anvil still holds (the material it did not take, the target after a refusal) is placed back
//   worn    the armour slot is not a source while the anvil is open (status 9 with the elytra on the back): a worn elytra
//           is taken off first (the inventory screen: `place` armor 1 -> an empty slot) and put on again afterwards
//
// Request ids from -500001 down (world/containers.ts counts from -1, survival/screen.ts from -100001, food/cook.ts from
// -200001, combat/shield.ts from -300001, craft/crafter.ts from -400001).
import { silentLogger, type Logger } from '../../log.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../dig/look.ts';
import { wireItemOf } from '../place/place.ts';
import { inventorySlot, isOk, slotInfo, type StackRequests } from '../survival/screen.ts';
import { isAnvil } from './anvil.ts';

/** The anvil is used from this far (eye to the block, as a crafting table). */
export const ANVIL_REACH = 4.5;
/** BDS's CraftRecipeOptional (the second header byte; mc-data's `optional` index differs, see crafter.ts). */
export const OPTIONAL_WIRE_TYPE = 15;
const INPUT = 'anvil_input';
const MATERIAL = 'anvil_material';
const INPUT_SLOT = 1;
const MATERIAL_SLOT = 2;
const OUTPUT = 'creative_output';
const OUTPUT_SLOT = 50;
const WINDOW_ARMOR = 120;
/** Ticks the levels are waited for after an operation (update_attributes follows the response). */
const LEVEL_TICKS = 20;
/** Ticks a resync is waited for. */
const RESYNC_TICKS = 60;

export interface AnvilStackResponse {
  status: 'ok' | 'error' | 'timeout' | number;
  request_id: number;
  containers?: { slot_type: { container_id: string | number }; slots: { slot: number; count: number; item_stack_id?: number; durability_correction?: number }[] }[];
}

/** Item stack requests with names (an anvil's custom_names) and ids of their own (see the file comment). */
export class AnvilRequests {
  private next = -500001;
  private readonly pending = new Map<number, (r: AnvilStackResponse) => void>();
  private readonly off: () => void;
  private readonly source: Pick<PacketSource, 'on' | 'queue'>;
  private readonly waitTicks: (n: number) => Promise<void>;

  constructor(source: Pick<PacketSource, 'on' | 'queue'>, waitTicks: (n: number) => Promise<void>) {
    this.source = source;
    this.waitTicks = waitTicks;
    this.off = source.on('item_stack_response', (p) => {
      for (const r of (p as unknown as { responses?: AnvilStackResponse[] }).responses ?? []) {
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

  /** The id the next `send` uses (the craft's output names it as its stack id). */
  peekId(): number {
    return this.next;
  }

  async send(actions: Record<string, unknown>[], names: readonly string[] = [], timeoutTicks = 60): Promise<AnvilStackResponse> {
    const id = this.next;
    this.next -= 2;
    let got: AnvilStackResponse | undefined;
    this.pending.set(id, (r) => {
      got = r;
    });
    this.source.queue('item_stack_request', { requests: [{ request_id: id, actions, custom_names: [...names], cause: names.length ? 'anvil_text' : 'chat_public' }] });
    for (let i = 0; i < timeoutTicks && !got; i++) await this.waitTicks(1);
    this.pending.delete(id);
    return got ?? { status: 'timeout', request_id: id };
  }
}

export interface AnvilInventory {
  readonly slots: readonly (ItemStack | null)[];
  readonly selected: number;
  readonly contentGeneration: number;
  window(id: number): { readonly slots: readonly (ItemStack | null)[] } | undefined;
  setItem(window: number, slot: number, item: ItemStack | null, raw?: ItemV4): void;
  rawItem(window: number, slot: number): ItemV4 | undefined;
  requestResync(reason: string): void;
}

export interface AnvilDeps {
  source: Pick<PacketSource, 'on' | 'queue'>;
  loop: { readonly state: { pos: Vec3; ready: boolean }; setCommand(c: { yaw?: number; pitch?: number }): void; waitTicks(n: number): Promise<void> };
  world: {
    blockAt(p: Vec3): BlockInfo | undefined;
    readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
    readonly inventory: AnvilInventory;
    readonly self: { readonly level?: number | undefined };
  };
  containers: {
    readonly open: { id: number; type: string; pos: Vec3 } | undefined;
    onOpen(fn: (c: { id: number; type: string; pos: Vec3 }) => void): () => void;
    onClose(fn: (id: number, byServer: boolean) => void): () => void;
    close(id: number, type?: string): void;
  };
  hotbar?: { rawItem(slot: number): ItemV4 | undefined; noteRaw?(slot: number, item: ItemV4 | undefined): void };
  /** The survival kit's requests (the inventory screen) for a worn piece taken off. */
  screen?: Pick<StackRequests, 'send' | 'withScreen'>;
  log?: Logger;
}

/** What one operation sends. */
export interface AnvilUse {
  /** Player slot (0..35) of the target. */
  input: number;
  /** Player slot of the material or the second item, and how many go in (exactly what the server consumes). */
  material?: { slot: number; count: number };
  /** The target's name, sent back so it stays. */
  name?: string;
}

export type AnvilFail = 'no_anvil' | 'out_of_reach' | 'open_failed' | 'fill_refused' | 'refused' | 'timeout' | 'moved';

export interface AnvilOutcome {
  ok: boolean;
  /** The server's status of the craft (9: too few levels or too expensive). */
  status?: unknown;
  reason?: AnvilFail;
  /** Levels before and after (the experience attribute). */
  levelsBefore?: number;
  levelsAfter?: number;
  /** The player slot the result is in (the target's own slot). */
  slot: number;
  /** The result as the server holds it after the resync. */
  item?: ItemStack | null;
  /** Items left in the anvil that could not be given back (the close may drop or return them). */
  left?: string;
}

const samePos = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;
const PLAYER_IDS = new Set<string | number>(['hotbar', 'inventory', 'hotbar_and_inventory', 28, 29, 12]);

/** The anvil's eye-to-block distance from the feet. */
export function anvilDistance(feet: Vec3, p: Vec3): number {
  const eye = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
  const gap = (e: number, lo: number): number => Math.max(lo - e, 0, e - (lo + 1));
  return Math.hypot(gap(eye.x, p.x), gap(eye.y, p.y), gap(eye.z, p.z));
}

export class AnvilUser {
  private readonly d: AnvilDeps;
  private readonly log: Logger;
  readonly req: AnvilRequests;
  readonly stats = { opens: 0, ops: 0, ok: 0, refused: 0, takenOff: 0 };

  constructor(d: AnvilDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.req = new AnvilRequests(d.source, (n) => d.loop.waitTicks(n));
  }

  dispose(): void {
    this.req.dispose();
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  /** Open the anvil at `at` (the click; one retry); the window, or undefined. */
  async open(at: Vec3): Promise<{ id: number; type: string } | undefined> {
    const { containers, loop, source, world } = this.d;
    const stale = containers.open;
    if (stale) await this.close(stale.id, stale.type);
    let opened: { id: number; type: string } | undefined;
    const off = containers.onOpen((c) => {
      if (samePos(c.pos, at) || c.type === 'anvil') opened = c;
    });
    const click = (): void => {
      const slot = world.inventory.selected;
      source.queue('inventory_transaction', clickBlockTransaction({ pos: at, face: faceToward(this.eye(), at), hotbarSlot: slot, held: this.d.hotbar?.rawItem(slot), eye: this.eye(), blockRuntimeId: world.chunks.runtimeIdAt(at.x, at.y, at.z) ?? 0 }));
    };
    try {
      for (let attempt = 0; attempt < 2 && !opened; attempt++) {
        loop.setCommand(lookAngles(this.eye(), blockCenter(at)));
        await loop.waitTicks(2);
        click();
        for (let i = 0; i < 40 && !opened; i++) await loop.waitTicks(1);
      }
    } finally {
      off();
    }
    if (opened) this.stats.opens++;
    else this.log.info(`anvil: the anvil at ${fmt(at)} did not open`);
    return opened;
  }

  async close(id: number, type = 'anvil'): Promise<void> {
    const { containers, loop } = this.d;
    if (containers.open?.id !== id) return;
    let closed = false;
    const off = containers.onClose((cid) => {
      if (cid === id) closed = true;
    });
    containers.close(id, type);
    for (let i = 0; i < 20 && !closed; i++) await loop.waitTicks(1);
    off();
  }

  /** Ask the server for the whole inventory and wait for it (the result's NBT: RepairCost, the name). */
  async resync(reason: string): Promise<boolean> {
    const inv = this.d.world.inventory;
    const gen = inv.contentGeneration;
    inv.requestResync(reason);
    for (let i = 0; i < RESYNC_TICKS && inv.contentGeneration <= gen; i++) await this.d.loop.waitTicks(1);
    return inv.contentGeneration > gen;
  }

  /**
   * The worn elytra (the armour's chest slot) into the empty player slot `to`, with the inventory screen (the anvil does
   * not take from the armour slot). True when it is there.
   */
  async takeOff(to: number): Promise<boolean> {
    const inv = this.d.world.inventory;
    const worn = inv.window(WINDOW_ARMOR)?.slots[1] ?? null;
    const screen = this.d.screen;
    if (!worn || !screen || inv.slots[to]) return false;
    const raw = inv.rawItem(WINDOW_ARMOR, 1);
    const r = await screen.withScreen(async () => {
      inv.setItem(0, to, { ...worn }, raw);
      inv.setItem(WINDOW_ARMOR, 1, null);
      const res = await screen.send([{ type_id: 'place', legacy_type_id: 1, count: 1, source: slotInfo('armor', 1, worn.stackId), destination: inventorySlot(to, undefined) }]);
      if (isOk(res)) return true;
      inv.setItem(WINDOW_ARMOR, 1, worn, raw);
      inv.setItem(0, to, null);
      this.log.warn(`anvil: taking the ${worn.name} off refused (${String(res.status)})`);
      return false;
    });
    if (r === true) {
      this.stats.takenOff++;
      if (to < 9) this.d.hotbar?.noteRaw?.(to, wireItemOf(inv.slots[to], inv.rawItem(0, to)));
    }
    return r === true;
  }

  /** One operation at the anvil at `at` (the bot within ANVIL_REACH): fill, craft, give back, close, read the result. */
  async use(at: Vec3, u: AnvilUse, predict: (target: ItemStack) => ItemStack): Promise<AnvilOutcome> {
    const { world } = this.d;
    const inv = world.inventory;
    const out: AnvilOutcome = { ok: false, slot: u.input };
    if (!isAnvil(world.blockAt(at)?.name)) return { ...out, reason: 'no_anvil' };
    if (anvilDistance(this.d.loop.state.pos, at) > ANVIL_REACH) return { ...out, reason: 'out_of_reach' };
    const target = inv.slots[u.input];
    const mat = u.material ? inv.slots[u.material.slot] : undefined;
    if (!target || (u.material && (!mat || mat.count < u.material.count))) return { ...out, reason: 'moved' };
    const w = await this.open(at);
    if (!w) return { ...out, reason: 'open_failed' };
    this.stats.ops++;
    const lv0 = world.self.level;
    if (lv0 !== undefined) out.levelsBefore = lv0;
    let left: string[] = [];
    try {
      // fill (predicted: the anvil's slots hold the items, the player slots lose them)
      const tRaw = inv.rawItem(0, u.input);
      const mRaw = u.material ? inv.rawItem(0, u.material.slot) : undefined;
      const fill: Record<string, unknown>[] = [{ type_id: 'place', legacy_type_id: 1, count: 1, source: inventorySlot(u.input, target.stackId), destination: slotInfo(INPUT, INPUT_SLOT, 0) }];
      if (u.material && mat) fill.push({ type_id: 'place', legacy_type_id: 1, count: u.material.count, source: inventorySlot(u.material.slot, mat.stackId), destination: slotInfo(MATERIAL, MATERIAL_SLOT, 0) });
      const inAnvil = { ...target };
      delete inAnvil.stackId;
      inv.setItem(w.id, INPUT_SLOT, inAnvil, tRaw);
      inv.setItem(0, u.input, null);
      let matAnvil: ItemStack | undefined;
      if (u.material && mat) {
        matAnvil = { ...mat, count: u.material.count };
        delete matAnvil.stackId;
        inv.setItem(w.id, MATERIAL_SLOT, matAnvil, mRaw);
        inv.setItem(0, u.material.slot, mat.count > u.material.count ? { ...mat, count: mat.count - u.material.count } : null, mRaw);
      }
      const f = await this.req.send(fill);
      if (!isOk(f)) {
        // atomic on BDS: nothing moved
        inv.setItem(0, u.input, target, tRaw);
        if (u.material && mat) inv.setItem(0, u.material.slot, mat, mRaw);
        inv.setItem(w.id, INPUT_SLOT, null);
        inv.setItem(w.id, MATERIAL_SLOT, null);
        this.log.warn(`anvil: the fill was refused (${String(f.status)})`);
        return { ...out, reason: f.status === 'timeout' ? 'timeout' : 'fill_refused', status: f.status };
      }
      const sid = (c: string, s: number): number | undefined => f.containers?.find((x) => x.slot_type.container_id === c)?.slots.find((x) => x.slot === s)?.item_stack_id;
      const inId = sid(INPUT, INPUT_SLOT);
      const matId = sid(MATERIAL, MATERIAL_SLOT);
      // craft (predicted: the result in the target's slot)
      const outId = this.req.peekId();
      const craft: Record<string, unknown>[] = [
        { type_id: 'optional', legacy_type_id: OPTIONAL_WIRE_TYPE, recipe_network_id: 0, filtered_string_index: u.name !== undefined ? 0 : -1 },
        { type_id: 'consume', legacy_type_id: 5, count: 1, source: slotInfo(INPUT, INPUT_SLOT, inId) },
      ];
      if (u.material) craft.push({ type_id: 'consume', legacy_type_id: 5, count: u.material.count, source: slotInfo(MATERIAL, MATERIAL_SLOT, matId) });
      craft.push({ type_id: 'place', legacy_type_id: 1, count: 1, source: slotInfo(OUTPUT, OUTPUT_SLOT, outId), destination: inventorySlot(u.input, undefined) });
      const predicted = predict(target);
      delete predicted.stackId;
      inv.setItem(0, u.input, predicted, tRaw);
      inv.setItem(w.id, INPUT_SLOT, null);
      inv.setItem(w.id, MATERIAL_SLOT, null);
      const c = await this.req.send(craft, u.name !== undefined ? [u.name] : []);
      out.status = c.status;
      if (isOk(c)) {
        out.ok = true;
        this.stats.ok++;
        const dst = c.containers?.find((x) => PLAYER_IDS.has(x.slot_type.container_id))?.slots.find((x) => x.slot === u.input);
        const cur = inv.slots[u.input];
        if (cur && dst) inv.setItem(0, u.input, { ...cur, ...(dst.item_stack_id !== undefined ? { stackId: dst.item_stack_id } : {}), ...(typeof dst.durability_correction === 'number' ? { damage: dst.durability_correction } : {}) });
        // the material the server did not take stays in its slot
        const m = c.containers?.find((x) => x.slot_type.container_id === MATERIAL)?.slots.find((x) => x.slot === MATERIAL_SLOT);
        if (u.material && m && m.count > 0 && matAnvil) {
          inv.setItem(w.id, MATERIAL_SLOT, { ...matAnvil, count: m.count, ...(m.item_stack_id !== undefined ? { stackId: m.item_stack_id } : {}) }, mRaw);
          left = await this.giveBack(w.id, [{ slot: MATERIAL_SLOT, container: MATERIAL, to: u.material.slot }]);
        }
      } else {
        this.stats.refused++;
        inv.setItem(0, u.input, null);
        inv.setItem(w.id, INPUT_SLOT, { ...inAnvil, ...(inId !== undefined ? { stackId: inId } : {}) }, tRaw);
        if (u.material && matAnvil) inv.setItem(w.id, MATERIAL_SLOT, { ...matAnvil, ...(matId !== undefined ? { stackId: matId } : {}) }, mRaw);
        this.log.info(`anvil: the operation was refused (status ${String(c.status)}${lv0 !== undefined ? `, level ${lv0}` : ''})`);
        const back = [{ slot: INPUT_SLOT, container: INPUT, to: u.input }];
        if (u.material) back.push({ slot: MATERIAL_SLOT, container: MATERIAL, to: u.material.slot });
        left = await this.giveBack(w.id, back);
        out.reason = c.status === 'timeout' ? 'timeout' : 'refused';
      }
    } finally {
      await this.close(w.id, w.type);
    }
    if (out.ok) for (let i = 0; i < LEVEL_TICKS && world.self.level === lv0; i++) await this.d.loop.waitTicks(1);
    if (world.self.level !== undefined) out.levelsAfter = world.self.level;
    await this.resync('the anvil result');
    out.item = inv.slots[u.input] ?? null;
    if (u.input < 9) this.d.hotbar?.noteRaw?.(u.input, wireItemOf(inv.slots[u.input], inv.rawItem(0, u.input)));
    if (left.length) out.left = left.join(', ');
    return out;
  }

  /** What the anvil still holds, back into the player slots it came from (else any empty one); what stayed, by name. */
  private async giveBack(window: number, cells: readonly { slot: number; container: string; to: number }[]): Promise<string[]> {
    const inv = this.d.world.inventory;
    const stayed: string[] = [];
    for (const c of cells) {
      const it = inv.window(window)?.slots[c.slot];
      if (!it || it.count <= 0) continue;
      const here = inv.slots[c.to];
      let to = c.to;
      if (here && (here.name !== it.name || here.metadata !== it.metadata || it.damage !== undefined)) {
        to = -1;
        for (let i = 0; i < 36 && to < 0; i++) if (!inv.slots[i]) to = i;
      }
      if (to < 0) {
        stayed.push(`${it.count} ${it.name}`);
        continue;
      }
      const dst = inv.slots[to];
      const raw = inv.rawItem(window, c.slot);
      const r = await this.req.send([{ type_id: 'place', legacy_type_id: 1, count: it.count, source: slotInfo(c.container, c.slot, it.stackId), destination: inventorySlot(to, dst?.stackId) }]);
      if (isOk(r)) {
        inv.setItem(window, c.slot, null);
        inv.setItem(0, to, dst ? { ...dst, count: dst.count + it.count } : { ...it }, dst ? inv.rawItem(0, to) : raw);
      } else stayed.push(`${it.count} ${it.name}`);
    }
    return stayed;
  }
}
