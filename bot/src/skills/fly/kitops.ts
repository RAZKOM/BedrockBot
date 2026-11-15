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
  /** Two player slots exchanged in one request, under the inventory screen (a full inventory: no slot to park in). */
  swap?(a: number, b: number): Promise<{ ok: boolean; reason?: string }>;
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
  /** Track F13: the box placed and not carried again: still standing (the break failed) or dropped (not picked up). */
  left?: 'standing' | 'dropped';
}

/**
 * Track F13: the rockets a refill may take with the box at `boxSlot` placed: the room on the rocket stacks plus a stack
 * for each free slot other than the box's own, so that the box always has a slot to come back into (`take` merges
 * first, then fills free slots; with this many it leaves one of them free).
 */
export function refillRoom(slots: readonly (ItemStack | null)[], boxSlot: number): number {
  let room = 0;
  for (let i = 0; i < Math.min(36, slots.length); i++) {
    if (i === boxSlot) continue;
    const s = slots[i];
    if (!s || s.count <= 0) room += 64;
    else if (isRocket(s.name)) room += Math.max(0, 64 - s.count);
  }
  return room;
}

/**
 * Track F13 (docs/flight.md "A flight from the box alone (Track F13)"): the line for a fireworks box the refill did not
 * carry again, with where it is, so that the owner knows the kit is on the ground (a flight never leaves it behind).
 */
export function boxLeftLine(r: Pick<RefillResult, 'where' | 'left' | 'reason'>): string {
  const at = r.where ? `${r.where.x} ${r.where.y} ${r.where.z}` : '?';
  const why = r.reason ? ` (${r.reason.replace(/ \(left at [^)]*\)$/, '')})` : '';
  return r.left === 'standing'
    ? `fly: the fireworks box is still standing at ${at}${why}; break it and give it back to me, or !fly again next to it`
    : `fly: the fireworks box lies on the ground near ${at}${why}; walk me over it (!goto ${at}) or give it back to me`;
}

/**
 * Track F13: after the refill before a takeoff, the line that ends the flight, or undefined to fly on. A box not carried
 * again ends it (boxLeftLine: no flight away from the kit); so does a hotbar still without a rocket, with the refill's
 * own reason and what the owner can do.
 */
export function refillEndLine(r: RefillResult, rocketsNow: number): string | undefined {
  if (r.where && !r.pickedUp) return boxLeftLine(r);
  if (rocketsNow > 0) return undefined;
  const why = r.reason ?? 'no rockets taken out';
  const fix = /^no free cell|^place:/.test(why)
    ? 'stand where the box can be set down beside me (a free cell with a solid floor), or give me loose rockets'
    : why.includes('inventory is full')
      ? 'make room (one free slot besides the box), or give me loose rockets'
      : why.includes('empty')
        ? 'give me rockets (drop them or !bring firework_rocket 64)'
        : 'give me loose rockets, or !fly again';
  return `fly: no rockets at hand and the refill from the fireworks box failed (${why}); ${fix}`;
}

/** Blocks that fall when nothing holds them up (terrain/classify.ts GRAVITY_NAMES and the concrete powders). */
const FALLS = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg', 'scaffolding', 'pointed_dripstone']);
const fallsDown = (name: string): boolean => FALLS.has(name) || name.endsWith('concrete_powder');
const liquidBlock = (b: BlockInfo | undefined): boolean => !!b && (b.name.includes('water') || b.name.includes('lava'));
/** A cell a body walks through: loaded, no collision box, no liquid. */
const passable = (b: BlockInfo | undefined): boolean => !!b && b.name !== 'unknown' && b.boxes.length === 0 && !liquidBlock(b);
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Track F16 (docs/flight.md "A window under a roof refills from the box (Track F16)"): why the free cell `p` beside the
 * feet cell `f` (a `boxSpots` cell: empty, the lid free, a full top under it) is no place for the box under a roof, else
 * undefined. The box is broken there and its item drops into the cell with a little speed: every side of the cell must
 * hold the item (a solid, or a floor at the cell's height; an open side over a drop is a ledge the item can slide off),
 * no water or lava beside it or over the lid (flowing water carries the item off, lava burns it), and no block over the
 * lid that falls into the cell once the box is gone (sand, gravel: a cave's ceiling holds them unsupported). And the body
 * must get to the item: a side cell is reached from where it stands, a corner cell through a free side cell, a cell two
 * out through the free cell between them with a floor.
 */
export function unsafeBoxCell(blockAt: (p: Vec3) => BlockInfo | undefined, f: Vec3, p: Vec3): string | undefined {
  for (const [dx, dz] of SIDES) {
    const n = { x: p.x + dx, y: p.y, z: p.z + dz };
    const b = blockAt(n);
    const under = blockAt({ ...n, y: n.y - 1 });
    if (!b || !under || b.name === 'unknown' || under.name === 'unknown') return 'a cell beside it is not loaded';
    if (liquidBlock(b) || liquidBlock(under)) return 'water or lava beside it';
    if (!b.solid && !under.solid) return 'a ledge beside it';
  }
  const over = blockAt({ ...p, y: p.y + 2 });
  if (!over || over.name === 'unknown') return 'the cell over it is not loaded';
  if (liquidBlock(over)) return 'water or lava over it';
  if (fallsDown(over.name)) return `${over.name} over it`;
  const dx = p.x - f.x;
  const dz = p.z - f.z;
  const open = (x: number, z: number): boolean => passable(blockAt({ x, y: f.y, z })) && passable(blockAt({ x, y: f.y + 1, z }));
  if (Math.abs(dx) + Math.abs(dz) === 1) return undefined;
  if (Math.abs(dx) === 1 && Math.abs(dz) === 1) return open(f.x + dx, f.z) || open(f.x, f.z + dz) ? undefined : 'no way to it from where I stand';
  const mx = f.x + Math.sign(dx);
  const mz = f.z + Math.sign(dz);
  return open(mx, mz) && blockAt({ x: mx, y: f.y - 1, z: mz })?.solid === true ? undefined : 'no way to it from where I stand';
}

/**
 * Track F16: the cells beside the feet the box may be set down on under a roof (the corridor's windows): the free cells
 * of `boxSpots` that `unsafeBoxCell` passes, nearest first; with none, why (the free cells' first reason).
 */
export function caveBoxSpots(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3): { spots: Vec3[]; why?: string } {
  const free = boxSpots(blockAt, feet);
  if (free.length === 0) return { spots: [], why: 'no free cell next to me for the box' };
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  const spots: Vec3[] = [];
  let first: string | undefined;
  for (const p of free) {
    const why = unsafeBoxCell(blockAt, f, p);
    if (why === undefined) spots.push(p);
    else first ??= `${why} (${p.x - f.x} ${p.z - f.z})`;
  }
  return spots.length ? { spots } : { spots, why: `no cell next to me where the box and its drop are safe (${first ?? '?'})` };
}

/** Track F16: where the refill may set the box down: beside the body in the open (F13), under a roof the stricter cells. */
export interface RefillWhere {
  /** The corridor's windows under a roof: `caveBoxSpots` instead of `boxSpots`. */
  under?: boolean;
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
    let ok = await this.d.armour.wear(move);
    if (!ok) {
      // once more after a moment, from the slots as they are now (the Realm, 2026-11-09: the keeper dropped junk in the same
      // tick and the server refused the swap with 49)
      await this.d.waitTicks(10);
      const k2 = this.kit();
      if (k2.elytraWorn) ok = true;
      else if (k2.elytraSlot >= 0) {
        const worn2 = this.d.armour.worn()[1] ?? null;
        ok = await this.d.armour.wear({ slot: 1, from: k2.elytraSlot, item: 'elytra', replaces: worn2?.name ?? null });
      }
      if (ok) this.log.info('flight kit: the elytra went on at the second try');
    }
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
  async rocketsToHotbar(below = 1): Promise<KitOpResult> {
    const k = this.kit();
    // (`below`: top the hotbar up while it holds fewer than this and more are carried: the Realm, 2026-11-09, a flight with 7
    // in the hotbar and 448 more in the inventory landed out of rockets 16 blocks short)
    if (k.rocketsHotbar >= below || k.rockets <= k.rocketsHotbar) return { ok: true };
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
      if (to < 0 && this.d.swap && !slots.slice(9, 36).some((x) => !x)) {
        // a full inventory (the Realm, 2026-11-09: no slot to park a hotbar item in, every flight refused): the rockets
        // swap places with the least useful hotbar item instead
        const t = hotbarTarget({ slots, selected: this.d.inventory.selected ?? -1 }, (it) => (isRocket(it.name) ? 1 : 0), (it) => it.name === 'elytra');
        if (t && !t.empty) {
          const other = slots[t.slot]!.name;
          const w = await this.d.swap(from, t.slot);
          if (w.ok) this.log.info(`flight kit: swapped the rockets in slot ${from} with the ${other} in hotbar slot ${t.slot} (the inventory is full)`);
          return w;
        }
      }
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
   * Track F13: why a refill from where the body stands cannot be made, before anything is placed (the command asks it
   * before a flight that needs the box, so that it refuses with the reason instead of starting): no box, an empty box,
   * no free cell with a solid floor beside the body, or no slot for the rockets that leaves one for the box (with every
   * other slot full the rockets went into the slot the box had left and the box stayed on the ground: bds-fly2,
   * 2026-11-13). Undefined: it can be tried.
   */
  refillCheck(o: RefillWhere = {}): string | undefined {
    const k = this.kit();
    if (k.boxSlot < 0) return 'no fireworks box';
    if (k.boxRockets <= 0) return 'the fireworks box is empty';
    const feet = this.d.position();
    if (!feet) return 'no free cell next to me for the box';
    if (o.under) {
      // Track F16: under a roof the cell must also keep the box's drop and be reached by the body
      const c = caveBoxSpots((q) => this.d.blockAt(q), feet);
      if (c.spots.length === 0) return c.why ?? 'no free cell next to me for the box';
    } else if (boxSpots((q) => this.d.blockAt(q), feet).length === 0) return 'no free cell next to me for the box';
    if (refillRoom(this.d.inventory.slots, k.boxSlot) <= 0) return 'the inventory is full: no slot for the rockets that leaves one for the box';
    return undefined;
  }

  /** The cells the refill tries for the box, nearest first. */
  private spots(o: RefillWhere): Vec3[] {
    const feet = this.d.position()!;
    return o.under ? caveBoxSpots((q) => this.d.blockAt(q), feet).spots : boxSpots((q) => this.d.blockAt(q), feet);
  }

  /**
   * Refill the hotbar from the fireworks box: place it, take rockets until the hotbar holds a stack
   * (or the box is empty), pick it up again. `alive()` false (a pre-emption) stops between steps; the
   * box is always broken and picked up when it was placed.
   */
  async refillFromBox(alive: () => boolean = () => true, where: RefillWhere = {}): Promise<RefillResult> {
    const k = this.kit();
    const none: RefillResult = { ok: false, taken: 0, pickedUp: false };
    const blocked = this.refillCheck(where);
    if (blocked) return { ...none, reason: blocked };
    const spots = this.spots(where);
    const room = refillRoom(this.d.inventory.slots, k.boxSlot);
    const item = this.d.inventory.slots[k.boxSlot]?.name ?? 'undyed_shulker_box';
    const sk = this.d.skills;
    let at: Vec3 | undefined;
    let reason: string | undefined;
    for (const p of spots.slice(0, 3)) {
      const r = await sk.place(p, { face: 'up', item });
      if (r.ok) {
        at = p;
        break;
      }
      reason = `place: ${r.reason ?? 'failed'}`;
      if (!alive()) return { ...none, reason: 'interrupted' };
    }
    if (!at) return { ...none, ...(reason ? { reason } : {}) };
    // (Track F13: a pre-emption after the box went down still breaks it and picks it up below; before, it returned here
    // and left the box on the ground)
    const out: RefillResult = { ok: false, taken: 0, pickedUp: false, where: at };
    await this.d.waitTicks(2);
    const o = alive() ? await sk.open(at) : ({ ok: false, reason: 'interrupted' } as const);
    if (alive() && o.ok) {
      const hotbarFree = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !this.d.inventory.slots[i]);
      let want = Math.min(64 - this.kit().rocketsHotbar, room);
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
      out.reason = `break: ${dug.reason ?? 'failed'}`;
      out.left = 'standing';
      this.log.info(`flight kit: refill failed: took ${out.taken} ${ROCKET} (${out.reason}; the box is still at ${at.x} ${at.y} ${at.z})`);
      return out;
    }
    for (const radius of [4, 6]) {
      await sk.collect(radius, 100, { origin: { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, filter: (i) => isShulkerBox(i.name) });
      if (this.boxesCarried() > before) break;
    }
    out.pickedUp = this.boxesCarried() > before;
    if (!out.pickedUp) {
      out.reason = `${out.reason ? `${out.reason}; ` : ''}the box was broken but not picked up again (left at ${at.x} ${at.y} ${at.z})`;
      out.left = 'dropped';
    }
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
