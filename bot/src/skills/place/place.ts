// place(p) (PLAN.md task 7.3): put a block into cell `p` by clicking a face of a neighbouring block,
// the way the vanilla client does it, verified on BDS 1.26.60 (docs/interaction.md):
//
//   item     pick the slot (opts.item, else the held block item, else any block item); a stack in the
//            main inventory (9..35) is moved into the hotbar with one item_stack_request first
//   face     opts.face, else the best clickable neighbour: solid, not interactive (a click on a door
//            or chest uses it instead of placing), in reach, its face visible from the eye
//   select   mob_equipment when the slot changes; look at the face centre (yaw/pitch)
//   click    inventory_transaction { item_use / click_block, block_position = the neighbour, face,
//            hotbar_slot, held_item = the slot's wire item, player_pos = eye, click_pos = face centre,
//            block_runtime_id = the neighbour's runtime id, trigger player_input, prediction success }
//   result   update_block at p with a new block -> ok; update_block at p with the old block (the
//            server's resync of a refused click) -> 'rejected'; nothing within timeoutTicks -> 'timeout'
//
// While the answer is pending the block is predicted in the movement model (the InputLoop's
// BlockQuery), so a body falling onto it lands on it as the server will.
//
// Pillar-up: `p` = the cell the feet stand in, on the ground: the skill jumps, waits until the feet
// are above p (the input carrying that height has been sent), clicks the top of the block below,
// then waits for the landing. Called while already rising over p (a navigator's own jump), it waits
// for the clearance the same way. Any other overlap with the body is refused ('in_body').
import { silentLogger, type Logger } from '../../log.ts';
import type { Inventory } from '../../world/inventory.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, ItemStack, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { EYE_HEIGHT, lookAngles, type Face } from '../dig/look.ts';
import type { BlockQuery } from '../input/types.ts';
import { maxDurability } from '../survival/tools.ts';
import type { SkillResult } from '../types.ts';
import { BLOCK_FACES, faceIndex, facePoint, faceVisibleFrom, supportOf, type BlockFace } from './face.ts';

/** Server limit for a click (place or use), measured on BDS 1.26.60.6: eye to the clicked block's min corner. */
export const SERVER_CLICK_REACH = 7.19;
/** Own reach for clicks: eye to the closest point of the clicked block (vanilla survival is about 5). */
export const DEFAULT_CLICK_REACH = 5;
/** Feet must be this far above the target cell before a pillar block is clicked. */
export const PILLAR_CLEARANCE = 0.05;
const BODY_WIDTH = 0.6;
const BODY_HEIGHT = 1.8;

/** Blocks a placement may replace (the server puts the new block in their place). */
export const REPLACEABLE = new Set([
  'air',
  'cave_air',
  'void_air',
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
  'short_grass',
  'tallgrass',
  'tall_grass',
  'fern',
  'large_fern',
  'deadbush',
  'dead_bush',
  'snow_layer',
  'vine',
  'fire',
  'soul_fire',
  'seagrass',
  'structure_void',
]);

/**
 * Blocks whose click does something instead of placing against them (open a door or a container,
 * press a button ...). Never used as the support of a placement.
 */
export function isInteractive(name: string): boolean {
  return (
    INTERACTIVE_EXACT.has(name) ||
    name.endsWith('_door') ||
    name === 'wooden_door' ||
    name.endsWith('trapdoor') ||
    name.endsWith('fence_gate') ||
    name.endsWith('_button') ||
    name.endsWith('shulker_box') ||
    name.endsWith('_bed') ||
    name.endsWith('chest')
  );
}

const INTERACTIVE_EXACT = new Set([
  'lever',
  'barrel',
  'crafting_table',
  'furnace',
  'lit_furnace',
  'smoker',
  'lit_smoker',
  'blast_furnace',
  'lit_blast_furnace',
  'anvil',
  'bed',
  'enchanting_table',
  'hopper',
  'dispenser',
  'dropper',
  'loom',
  'stonecutter_block',
  'grindstone',
  'cartography_table',
  'smithing_table',
  'brewing_stand',
  'beacon',
  'noteblock',
  'unpowered_repeater',
  'powered_repeater',
  'unpowered_comparator',
  'powered_comparator',
  'daylight_detector',
  'daylight_detector_inverted',
  'cake',
  'bell',
  'lectern',
  'composter',
  'cauldron',
  'jukebox',
  'respawn_anchor',
  'crafter',
  'fence_gate',
  'trapdoor',
  'wooden_button',
  'ender_chest',
  'command_block',
  'flower_pot',
  'decorated_pot',
  'chiseled_bookshelf',
]);

export type PlaceReason =
  | 'not_ready'
  | 'unloaded'
  | 'occupied'
  | 'no_item'
  | 'no_face'
  | 'out_of_reach'
  | 'in_body'
  | 'no_headroom'
  | 'timeout'
  | 'rejected'
  | 'interrupted'
  | 'busy'
  | 'no_hotbar'
  | 'move_failed';

export interface PlaceOptions {
  /** Face of the support block to click (the support is `p - offset(face)`); default: chosen. */
  face?: BlockFace;
  /** Item name(s) to place (without namespace); default the held block item, else any block item. */
  item?: string | string[];
  /** Ticks to wait for the server's answer after the click. Default 20. */
  timeoutTicks?: number;
  /** Own reach, eye to the closest point of the support. Default 5. */
  reach?: number;
  /** Turn the view to the click point first (2 ticks). Default true. The server does not check it. */
  look?: boolean;
  /** Pillar-up when `p` is the cell the feet stand in (jump, place below). Default true. */
  jump?: boolean;
}

export type PlaceResult = (SkillResult & { reason?: PlaceReason | (string & {}) }) & {
  /** Block now at p (ok) or the one that was there. */
  block?: string;
  face?: BlockFace;
  /** The clicked neighbour. */
  support?: Vec3;
  slot?: number;
  item?: string;
  /** Bot ticks from the call to the update_block that showed the block. */
  ticks?: number;
  /** Bot ticks from the click (transaction queued) to the update_block. */
  clickTicks?: number;
  /** Wall-clock ms from the call to the update_block. */
  ms?: number;
  /** The skill jumped (pillar-up) / the body stood on the ground afterwards. */
  jumped?: boolean;
  landed?: boolean;
  /** Eye to the support's min corner (the server's measure) and to its closest point, at the click. */
  serverDistance?: number;
  distance?: number;
};

/** The parts of InputLoop the skill uses. */
export interface PlaceLoop {
  readonly state: { pos: Vec3; vel: Vec3; onGround: boolean; tick: bigint; ready: boolean };
  readonly command: { yaw: number; pitch: number };
  world: BlockQuery;
  setCommand(c: { yaw?: number; pitch?: number; jump?: boolean; forward?: number; strafe?: number; sneak?: boolean }): void;
  waitTicks(n: number): Promise<void>;
}

/** The parts of World the skill uses. */
export interface PlaceWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: Inventory;
}

/** Hotbar switching and the wire items of slots 0..8 (world/hotbar.ts). */
export interface PlaceHotbar {
  select(slot: number): boolean;
  rawItem(slot: number): ItemV4 | undefined;
  noteRaw?(slot: number, item: ItemV4 | undefined): void;
}

/** Item stack moves (world/containers.ts). */
export interface PlaceMover {
  move(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }>;
  /** The open container window, if any (an open window makes the inventory screen unnecessary). */
  readonly open?: { id: number; type: string } | undefined;
  onOpen?(fn: (c: { id: number; type: string }) => void): () => void;
  onClose?(fn: (id: number, byServer: boolean) => void): () => void;
  close?(id: number, type?: string): void;
}

export interface PlaceDeps {
  source: Pick<PacketSource, 'queue'>;
  loop: PlaceLoop;
  world: PlaceWorld;
  hotbar?: PlaceHotbar;
  containers?: PlaceMover;
  /** Own runtime entity id (the target of `interact open_inventory`). */
  runtimeId?: () => bigint;
  logger?: Logger;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const floorPos = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Eye to the closest point of block `b`. */
export function closestDistance(eye: Vec3, b: Vec3): number {
  const gap = (e: number, lo: number) => Math.max(lo - e, 0, e - (lo + 1));
  return Math.hypot(gap(eye.x, b.x), gap(eye.y, b.y), gap(eye.z, b.z));
}

/** Eye to the min corner of block `b` (what BDS measures for clicks). */
export function cornerDistance(eye: Vec3, b: Vec3): number {
  return Math.hypot(b.x - eye.x, b.y - eye.y, b.z - eye.z);
}

/** True when cell `p` overlaps the body box at feet `feet` (shrunk by `eps`). */
export function cellInBody(p: Vec3, feet: Vec3, eps = 1e-3): boolean {
  const w = BODY_WIDTH / 2 - eps;
  return feet.x + w > p.x && feet.x - w < p.x + 1 && feet.z + w > p.z && feet.z - w < p.z + 1 && feet.y + eps < p.y + 1 && feet.y + BODY_HEIGHT - eps > p.y;
}

/** The body's footprint overlaps column (x, z) of cell `p`. */
function overColumn(p: Vec3, feet: Vec3): boolean {
  const w = BODY_WIDTH / 2 - 1e-3;
  return feet.x + w > p.x && feet.x - w < p.x + 1 && feet.z + w > p.z && feet.z - w < p.z + 1;
}

/** A block item: the item registry gives it a block runtime id. */
export function isBlockItem(i: ItemStack | null | undefined): i is ItemStack {
  return !!i && i.count > 0 && i.blockRuntimeId !== undefined && i.blockRuntimeId !== 0;
}

/**
 * Where an item from main-inventory slot `src` goes in the hotbar: an empty hotbar slot (`dst`), else
 * the least useful hotbar item (no durability before tools and weapons, the selected slot last, never
 * one that `wanted` accepts) parked first in a free main slot (`park`, never `src`). undefined = no room.
 */
export function hotbarRoom(slots: readonly (ItemStack | null)[], selected: number, src: number, wanted: (i: ItemStack) => boolean): { dst: number; park?: number } | undefined {
  for (let s = 0; s < 9; s++) if (!slots[s]) return { dst: s };
  let park = -1;
  for (let s = 9; s < 36 && park < 0; s++) if (!slots[s] && s !== src) park = s;
  if (park < 0) return undefined;
  let best: { slot: number; rank: number } | undefined;
  for (let s = 8; s >= 0; s--) {
    const it = slots[s]!;
    if (wanted(it)) continue;
    const rank = (maxDurability(it.name) !== undefined ? 20 : 0) + (s === selected ? 5 : 0);
    if (!best || rank < best.rank) best = { slot: s, rank };
  }
  return best ? { dst: best.slot, park } : undefined;
}

/** The wire item to echo for a model slot: the server's own if it still matches, else built from the model. */
export function wireItemOf(stack: ItemStack | null | undefined, raw: ItemV4 | undefined): ItemV4 {
  if (!stack) return { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } } as ItemV4;
  if (raw?.network_id === stack.networkId && raw.count === stack.count && (stack.stackId === undefined || raw.stack_id === stack.stackId)) return raw;
  return {
    network_id: stack.networkId,
    count: stack.count,
    metadata: stack.metadata,
    has_stack_id: stack.stackId !== undefined,
    ...(stack.stackId !== undefined ? { stack_id: stack.stackId } : {}),
    block_runtime_id: stack.blockRuntimeId ?? 0,
    extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
  } as ItemV4;
}

interface Candidate {
  face: BlockFace;
  support: Vec3;
  visible: boolean;
  distance: number;
  serverDistance: number;
}

export class PlaceSkill {
  private readonly d: PlaceDeps;
  private readonly log: Logger;
  private running = false;
  private cancelled = false;
  private epoch = 0;
  private current: Promise<PlaceResult> | undefined;

  constructor(deps: PlaceDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  /** Stop a running placement: it resolves with 'interrupted' at its next tick. */
  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  /** A block the new block can be placed against (a solid, non-interactive block). */
  clickable(b: BlockInfo | undefined): boolean {
    return !!b && b.name !== 'unknown' && b.boxes.length > 0 && !REPLACEABLE.has(b.name) && !isInteractive(b.name);
  }

  /** Faces of `p`'s neighbours that can be clicked to place into `p`, best first. */
  candidates(p: Vec3, eye: Vec3 = this.eye()): Candidate[] {
    const out: Candidate[] = [];
    for (const face of BLOCK_FACES) {
      const support = supportOf(p, face);
      if (!this.clickable(this.d.world.blockAt(support))) continue;
      out.push({
        face,
        support,
        visible: faceVisibleFrom(eye, support, face),
        distance: closestDistance(eye, support),
        serverDistance: cornerDistance(eye, support),
      });
    }
    // Visible faces first (a real client can only click those), then the nearest click point.
    const click = (c: Candidate) => {
      const f = facePoint(c.support, c.face);
      return Math.hypot(f.x - eye.x, f.y - eye.y, f.z - eye.z);
    };
    return out.sort((a, b) => Number(b.visible) - Number(a.visible) || click(a) - click(b));
  }

  /**
   * Place a block into cell `pos`. While another placement runs: 'busy', unless that one was
   * cancelled, then this one waits for it to wind down (at most a tick or two) and starts.
   */
  async place(pos: Vec3, opts: PlaceOptions = {}): Promise<PlaceResult> {
    if (this.running) {
      if (!this.cancelled || !this.current) return { ok: false, reason: 'busy' };
      await this.current.catch(() => undefined);
      if (this.running) return { ok: false, reason: 'busy' };
    }
    this.running = true;
    this.cancelled = false;
    const epoch = ++this.epoch;
    const job = this.run(floorPos(pos), opts);
    this.current = job;
    try {
      return await job;
    } finally {
      if (this.epoch === epoch) {
        this.running = false;
        this.current = undefined;
      }
    }
  }

  private async run(p: Vec3, opts: PlaceOptions): Promise<PlaceResult> {
    const { loop, world } = this.d;
    const t0 = loop.state.tick;
    const ms0 = performance.now();
    if (!loop.state.ready) return { ok: false, reason: 'not_ready' };
    const here = world.blockAt(p);
    if (!here) return { ok: false, reason: 'unloaded' };
    if (!REPLACEABLE.has(here.name)) return { ok: false, reason: 'occupied', block: here.name };
    const reach = opts.reach ?? DEFAULT_CLICK_REACH;

    // ---- the body: pillar-up, a rising jump, or refuse
    let mode: 'normal' | 'jump' | 'rising' = 'normal';
    const st = loop.state;
    if (cellInBody(p, st.pos)) {
      const below = { x: p.x, y: p.y - 1, z: p.z };
      const feetCell = Math.floor(st.pos.y + 1e-6) === p.y && overColumn(p, st.pos) && Math.floor(st.pos.x) === p.x && Math.floor(st.pos.z) === p.z;
      if (opts.jump === false || !feetCell || !this.clickable(world.blockAt(below))) return { ok: false, reason: 'in_body', block: here.name };
      if (opts.face !== undefined && opts.face !== 'up') return { ok: false, reason: 'in_body', block: here.name };
      if (st.onGround) mode = 'jump';
      else if (st.vel.y > 0) mode = 'rising';
      else return { ok: false, reason: 'in_body', block: here.name };
      // head room for the jump: the cells the head rises into
      for (const dy of [2, 3]) {
        const b = world.blockAt({ x: p.x, y: p.y + dy, z: p.z });
        if (!b || b.boxes.length > 0) return { ok: false, reason: 'no_headroom', block: here.name };
      }
    }

    // ---- the face
    let cand: Candidate | undefined;
    if (mode !== 'normal') {
      const support = { x: p.x, y: p.y - 1, z: p.z };
      // judged from the eye at the jump's apex region (feet about p.y + 1.2)
      const eye = { x: st.pos.x, y: p.y + 1.2 + EYE_HEIGHT, z: st.pos.z };
      cand = { face: 'up', support, visible: true, distance: closestDistance(eye, support), serverDistance: cornerDistance(eye, support) };
    } else if (opts.face !== undefined) {
      const support = supportOf(p, opts.face);
      if (!this.clickable(world.blockAt(support))) return { ok: false, reason: 'no_face', block: here.name };
      const eye = this.eye();
      cand = { face: opts.face, support, visible: faceVisibleFrom(eye, support, opts.face), distance: closestDistance(eye, support), serverDistance: cornerDistance(eye, support) };
    } else {
      const all = this.candidates(p);
      if (all.length === 0) return { ok: false, reason: 'no_face', block: here.name };
      cand = all.find((c) => c.distance <= reach && c.serverDistance <= SERVER_CLICK_REACH);
      if (!cand) {
        const c = all[0]!;
        this.log.info(`place ${fmt(p)}: out of reach (${c.distance.toFixed(2)} / server ${c.serverDistance.toFixed(2)})`);
        return { ok: false, reason: 'out_of_reach', block: here.name, distance: c.distance, serverDistance: c.serverDistance };
      }
    }
    if (cand.distance > reach || cand.serverDistance > SERVER_CLICK_REACH) {
      return { ok: false, reason: 'out_of_reach', block: here.name, face: cand.face, support: cand.support, distance: cand.distance, serverDistance: cand.serverDistance };
    }

    // ---- the item
    const sel = await this.selectItem(opts.item);
    if (!sel.ok) return { ok: false, reason: sel.reason, block: here.name };
    const { slot, item } = sel;
    if (this.cancelled) return { ok: false, reason: 'interrupted' };

    const result: Omit<PlaceResult, 'ok' | 'reason'> = { face: cand.face, support: cand.support, slot, item, jumped: mode === 'jump' };
    const click = facePoint(cand.support, cand.face);
    if (opts.look ?? true) {
      loop.setCommand(lookAngles(mode === 'normal' ? this.eye() : { ...this.eye(), y: p.y + 1.2 + EYE_HEIGHT }, click));
    }
    if (mode === 'jump') loop.setCommand({ jump: true, forward: 0, strafe: 0, sneak: false });
    // the slot change and the new look go out with the next input before the click
    await loop.waitTicks(mode === 'normal' && (opts.look ?? true) ? 2 : 1);

    if (mode !== 'normal') {
      // wait until an input with the feet above p has been sent
      let ok = false;
      for (let i = 0; i < 14; i++) {
        if (this.cancelled) break;
        const s = loop.state;
        if (s.pos.y >= p.y + 1 + PILLAR_CLEARANCE) {
          ok = true;
          break;
        }
        if (s.onGround && i > 3) break; // the jump did not happen (ceiling, correction)
        await loop.waitTicks(1);
      }
      if (mode === 'jump') loop.setCommand({ jump: false });
      if (this.cancelled) return { ...result, ok: false, reason: 'interrupted' };
      if (!ok) return { ...result, ok: false, reason: 'in_body' };
    } else if (this.cancelled) return { ...result, ok: false, reason: 'interrupted' };

    const eye = this.eye();
    result.distance = closestDistance(eye, cand.support);
    result.serverDistance = cornerDistance(eye, cand.support);
    if (result.serverDistance > SERVER_CLICK_REACH || (mode === 'normal' && result.distance > reach)) {
      return { ...result, ok: false, reason: 'out_of_reach' };
    }
    if (cellInBody(p, loop.state.pos)) return { ...result, ok: false, reason: 'in_body' };

    // Track Z: the latest inventory state right before the click. The stack may have moved, been
    // used up or the selection changed during the look ticks (another skill, a server resync): select
    // again; the held item itself is built from the slot's current contents in clickAndWait.
    let clickSlot = slot;
    const inv = world.inventory;
    if (inv.slots[slot]?.name !== item || (inv.slots[slot]?.count ?? 0) <= 0 || inv.selected !== slot) {
      const again = await this.selectItem(opts.item);
      if (!again.ok) return { ...result, ok: false, reason: again.reason };
      clickSlot = again.slot;
      result.slot = clickSlot;
      await loop.waitTicks(1);
      if (this.cancelled) return { ...result, ok: false, reason: 'interrupted' };
    }

    const verdict = await this.clickAndWait(p, here.name, cand, clickSlot, opts.timeoutTicks ?? 20);
    const out: PlaceResult = verdict.ok
      ? { ...result, ok: true, block: verdict.block, ticks: Number(verdict.at - t0), clickTicks: verdict.clickTicks, ms: verdict.ms - ms0 }
      : { ...result, ok: false, reason: verdict.reason, block: here.name, ticks: Number(loop.state.tick - t0) };
    if (mode !== 'normal') {
      // land (on the new block if it came)
      for (let i = 0; i < 30 && !loop.state.onGround; i++) await loop.waitTicks(1);
      out.landed = loop.state.onGround;
    }
    this.log.info(
      `place ${fmt(p)} ${item} via ${cand.face} of ${fmt(cand.support)}: ${out.ok ? `ok after ${out.ticks} ticks (click +${out.clickTicks})` : out.reason}${mode !== 'normal' ? `, ${mode}, landed ${out.landed}` : ''}`,
    );
    return out;
  }

  /** Select (and if needed fetch into the hotbar, making room in a full one) the item to place. */
  private async selectItem(want: string | string[] | undefined): Promise<{ ok: true; slot: number; item: string } | { ok: false; reason: PlaceReason }> {
    const inv = this.d.world.inventory;
    const names = want === undefined ? undefined : (Array.isArray(want) ? want : [want]).map((n) => (n.startsWith('minecraft:') ? n.slice(10) : n));
    const fits = (i: ItemStack | null | undefined): i is ItemStack => !!i && i.count > 0 && (names ? names.includes(i.name) : isBlockItem(i));
    let slot = -1;
    if (fits(inv.held)) slot = inv.selected;
    else {
      // in the order of `names` (preference), else the lowest slot
      const order = names ?? [undefined];
      outer: for (const n of order) {
        for (let s = 0; s < 9; s++) {
          const i = inv.slots[s];
          if (fits(i) && (n === undefined || i.name === n)) {
            slot = s;
            break outer;
          }
        }
      }
    }
    if (slot < 0) {
      // main inventory -> a hotbar slot (an empty one, else the selected one if it holds no wanted item)
      let src = -1;
      for (let s = 9; s < 36 && src < 0; s++) if (fits(inv.slots[s])) src = s;
      if (src < 0) return { ok: false, reason: 'no_item' };
      const mover = this.d.containers;
      if (!mover) return { ok: false, reason: 'no_item' };
      // a full hotbar: park its least useful item in a free main slot first (a Realm farm: the carrots
      // picked up landed in the main inventory behind a full hotbar and every planting failed)
      const room = hotbarRoom(inv.slots, inv.selected, src, (i) => fits(i));
      if (!room) return { ok: false, reason: 'move_failed' };
      const dst = room.dst;
      const stack = inv.slots[src]!;
      const parked = room.park !== undefined ? inv.slots[dst]! : undefined;
      const r = await this.withInventoryOpen(async () => {
        if (parked && room.park !== undefined) {
          const pr = await mover.move({ window: 0, slot: dst }, { window: 0, slot: room.park }, parked.count);
          if (!pr.ok) return pr;
        }
        return mover.move({ window: 0, slot: src }, { window: 0, slot: dst }, stack.count);
      });
      if (!r.ok) {
        this.log.warn(`place: moving ${stack.name} ${src} -> ${dst} failed: ${r.reason}`);
        return { ok: false, reason: 'move_failed' };
      }
      this.d.hotbar?.noteRaw?.(dst, wireItemOf(inv.slots[dst], undefined));
      slot = dst;
    }
    if (slot !== inv.selected) {
      if (!this.d.hotbar) return { ok: false, reason: 'no_hotbar' };
      this.d.hotbar.select(slot);
    }
    return { ok: true, slot, item: inv.slots[slot]!.name };
  }

  /**
   * BDS 1.26.60 refuses item stack requests between player inventory slots unless the inventory
   * screen is open (status 49 / 50, measured): `interact open_inventory` -> container_open
   * (window_type 'inventory'), the request, then container_close. With a container already open the
   * request goes out as is.
   */
  private async withInventoryOpen(fn: () => Promise<{ ok: boolean; reason?: string }>): Promise<{ ok: boolean; reason?: string }> {
    const c = this.d.containers;
    if (!c?.onOpen || !c.close || c.open) return fn();
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

  /** Queue the click, predict the block, wait for the verdict. */
  private async clickAndWait(
    p: Vec3,
    original: string,
    c: Candidate,
    slot: number,
    timeoutTicks: number,
  ): Promise<{ ok: true; block: string; at: bigint; ms: number; clickTicks: number } | { ok: false; reason: PlaceReason; block?: string }> {
    const { loop, world, source } = this.d;
    const inv = world.inventory;
    let verdict: { ok: true; block: string; at: bigint; ms: number } | { ok: false; reason: PlaceReason } | undefined;
    const off = world.onBlockUpdate((q, _before, after) => {
      if (verdict || !samePos(q, p)) return;
      if (after.name === original) verdict = { ok: false, reason: 'rejected' };
      else verdict = { ok: true, block: after.name, at: loop.state.tick, ms: performance.now() };
    });
    // Track Z: built at the last moment from the slot's current stack (count and stack id as the server
    // last reported them). A pickup that the server merges into this stack after this point still makes
    // it refuse the click ('rejected'; docs/farming.md "Rejected plantings"): callers that place right
    // after a harvest wait for nearby drops first (skills/farm/farmer.ts settle()).
    const held = wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? this.d.hotbar?.rawItem(slot));
    const tick0 = loop.state.tick;
    source.queue(
      'inventory_transaction',
      clickBlockTransaction({
        pos: c.support,
        face: faceIndex(c.face) as Face,
        hotbarSlot: slot,
        held,
        eye: this.eye(),
        blockRuntimeId: world.chunks.runtimeIdAt(c.support.x, c.support.y, c.support.z) ?? 0,
      }),
    );
    // Client prediction for the movement model: the block is there unless the server says no.
    const real = loop.world;
    const predicted = predictBlock(real, p);
    loop.world = predicted;
    try {
      for (let i = 0; i < timeoutTicks && !verdict && !this.cancelled; i++) await loop.waitTicks(1);
    } finally {
      if (loop.world === predicted) loop.world = real;
      off();
    }
    if (!verdict) return { ok: false, reason: this.cancelled ? 'interrupted' : 'timeout' };
    if (!verdict.ok) return { ok: false, reason: verdict.reason, block: original };
    return { ...verdict, clickTicks: Number(verdict.at - tick0) };
  }
}

const FULL_BOX: readonly (readonly number[])[] = Object.freeze([Object.freeze([0, 0, 0, 1, 1, 1])]);

/** `real` with a full solid block at `p` (client-side prediction of a placement). */
export function predictBlock(real: BlockQuery, p: Vec3): BlockQuery {
  const at = (x: number, y: number, z: number) => x === p.x && y === p.y && z === p.z;
  const q: BlockQuery = { solidAt: (x, y, z) => (at(x, y, z) ? true : real.solidAt(x, y, z)) };
  if (real.boxesAt) q.boxesAt = (x, y, z) => (at(x, y, z) ? FULL_BOX : real.boxesAt!(x, y, z));
  if (real.frictionAt) q.frictionAt = (x, y, z) => real.frictionAt!(x, y, z);
  if (real.liquidAt) q.liquidAt = (x, y, z) => (at(x, y, z) ? null : real.liquidAt!(x, y, z));
  return q;
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
