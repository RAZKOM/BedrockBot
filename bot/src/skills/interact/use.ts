// useBlock(p) (PLAN.md task 7.3): open / close doors, fence gates and trapdoors, press buttons, flip
// levers. Same packet as placing (docs/interaction.md): inventory_transaction item_use / click_block
// on the block itself, with whatever the hand holds (a held block is not placed: the door, gate ...
// takes the click), face = the face seen from the eye, click_pos = its centre. The result is the
// block-state change the server sends back (update_block), verified on BDS 1.26.60:
//
//   door        open_bit of the LOWER half (the upper half keeps open_bit 0); a click on either half toggles
//   fence_gate  open_bit; opening also turns minecraft:cardinal_direction away from the player
//   trapdoor    open_bit
//   button      button_pressed_bit 1, back to 0 by itself (wooden: 30 ticks, stone: 20)
//   lever       open_bit (on / off)
//
// Iron doors and iron trapdoors do not open by hand ('not_usable').
//
// Track BG2 (decision 0048 "Realm findings"): a click while SNEAKING with anything in the hand is not a use on
// BDS / Realms: the server tries the item (a block is placed, a tool does nothing) and answers with the old
// state (update_block restores: 'rejected'). Measured on bds-move from a ladder: empty hand opens sneaking or
// not; a pickaxe, a sword, cobblestone, a shulker box open only standing. So a click with a non-empty hand while
// the input loop holds sneak (the navigator on a ladder, edge sneaking) releases sneak from the look ticks to the
// tick after the click and presses it again afterwards.
import { silentLogger, type Logger } from '../../log.ts';
import type { Inventory } from '../../world/inventory.ts';
import type { ItemV4 } from '../../world/packets.ts';
import type { BlockInfo, PacketSource, Vec3 } from '../../world/types.ts';
import { clickBlockTransaction } from '../container/chest.ts';
import { blockCenter, EYE_HEIGHT, faceToward, lookAngles } from '../dig/look.ts';
import { closestDistance, cornerDistance, DEFAULT_CLICK_REACH, SERVER_CLICK_REACH, wireItemOf } from '../place/place.ts';
import { faceOf, type BlockFace } from '../place/face.ts';
import type { SkillResult } from '../types.ts';

export type UsableKind = 'door' | 'trapdoor' | 'fence_gate' | 'button' | 'lever';

/** What kind of usable block a block name is (undefined: not one of the five). */
export function usableKind(name: string): UsableKind | undefined {
  if (name === 'lever') return 'lever';
  if (name.endsWith('_button')) return 'button';
  if (name.endsWith('trapdoor')) return 'trapdoor';
  if (name.endsWith('fence_gate')) return 'fence_gate';
  if (name.endsWith('_door') || name === 'wooden_door') return 'door';
  return undefined;
}

/** Iron doors and trapdoors: redstone only. */
export function handUsable(name: string): boolean {
  return name !== 'iron_door' && name !== 'iron_trapdoor';
}

const bit = (v: unknown): boolean | undefined => (v === undefined ? undefined : v === true || v === 1 || v === '1' || v === 'true');

/** The block that carries the state: the lower half for a door's upper half, else the block itself. */
export function stateHolder(p: Vec3, b: BlockInfo): Vec3 {
  if (usableKind(b.name) === 'door' && bit(b.states.upper_block_bit)) return { x: p.x, y: p.y - 1, z: p.z };
  return p;
}

/**
 * Open (doors, trapdoors, gates), on (levers) or pressed (buttons) from a block state, given the
 * block at the state holder. Undefined for other blocks.
 */
export function openState(b: BlockInfo | undefined): boolean | undefined {
  if (!b) return undefined;
  const kind = usableKind(b.name);
  if (!kind) return undefined;
  if (kind === 'button') return bit(b.states.button_pressed_bit);
  return bit(b.states.open_bit);
}

export type UseReason =
  | 'not_ready'
  | 'unloaded'
  | 'not_usable'
  | 'toggle_only'
  | 'already_pressed'
  | 'out_of_reach'
  | 'timeout'
  | 'rejected'
  | 'interrupted'
  | 'busy';

export interface UseOptions {
  /** 'toggle' (default) clicks once; 'open' / 'closed' click only when the state differs. Buttons and levers: toggle only. */
  want?: 'open' | 'closed' | 'toggle';
  /** Ticks to wait for the state change after the click. Default 20. */
  timeoutTicks?: number;
  /** Own reach, eye to the closest point of the block. Default 5. */
  reach?: number;
  /** Turn the view to the block first (2 ticks). Default true. */
  look?: boolean;
  /** Track BG2: measurements only: click while sneaking as the input loop holds it (no release; BDS then uses the held item). */
  keepSneak?: boolean;
}

export type UseResult = (SkillResult & { reason?: UseReason | (string & {}) }) & {
  kind?: UsableKind;
  block?: string;
  /** The state after the call (open / on / pressed). */
  open?: boolean;
  /** A click was sent and changed the state. */
  changed?: boolean;
  face?: BlockFace;
  /** Bot ticks from the call / from the click to the update_block with the new state. */
  ticks?: number;
  clickTicks?: number;
  ms?: number;
  /** update_block answers at the holder that did not change the state. */
  restores?: number;
  serverDistance?: number;
  distance?: number;
};

export interface UseLoop {
  readonly state: { pos: Vec3; tick: bigint; ready: boolean };
  /** Track BG2: the held input command (sneak is released for a click with an item in the hand). */
  readonly command?: { readonly sneak?: boolean };
  setCommand(c: { yaw?: number; pitch?: number; sneak?: boolean }): void;
  waitTicks(n: number): Promise<void>;
}

export interface UseWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void;
  readonly chunks: { runtimeIdAt(x: number, y: number, z: number): number | undefined };
  readonly inventory: Inventory;
}

export interface UseDeps {
  source: Pick<PacketSource, 'queue'>;
  loop: UseLoop;
  world: UseWorld;
  /** Wire item of a hotbar slot (Hotbar.rawItem); the click echoes the held item. */
  rawHotbarItem?: (slot: number) => ItemV4 | undefined;
  logger?: Logger;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

export class UseSkill {
  private readonly d: UseDeps;
  private readonly log: Logger;
  private running = false;
  private cancelled = false;
  private current: Promise<UseResult> | undefined;

  constructor(deps: UseDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
  }

  get busy(): boolean {
    return this.running;
  }

  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  /** Open (door, trapdoor, gate), on (lever), pressed (button) per the world model; undefined otherwise. */
  isOpen(pos: Vec3): boolean | undefined {
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const b = this.d.world.blockAt(p);
    if (!b || !usableKind(b.name)) return undefined;
    const h = stateHolder(p, b);
    return openState(samePos(h, p) ? b : this.d.world.blockAt(h));
  }

  /** Use the block at `pos`. While another use runs: 'busy', unless it was cancelled (then this one waits for it). */
  async useBlock(pos: Vec3, opts: UseOptions = {}): Promise<UseResult> {
    if (this.running) {
      if (!this.cancelled || !this.current) return { ok: false, reason: 'busy' };
      await this.current.catch(() => undefined);
      if (this.running) return { ok: false, reason: 'busy' };
    }
    this.running = true;
    this.cancelled = false;
    const job = this.run({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, opts);
    this.current = job;
    try {
      return await job;
    } finally {
      if (this.current === job) {
        this.running = false;
        this.current = undefined;
      }
    }
  }

  private eye(): Vec3 {
    const f = this.d.loop.state.pos;
    return { x: f.x, y: f.y + EYE_HEIGHT, z: f.z };
  }

  private async run(p: Vec3, opts: UseOptions): Promise<UseResult> {
    const { loop, world } = this.d;
    const t0 = loop.state.tick;
    const ms0 = performance.now();
    if (!loop.state.ready) return { ok: false, reason: 'not_ready' };
    const b = world.blockAt(p);
    if (!b) return { ok: false, reason: 'unloaded' };
    const kind = usableKind(b.name);
    if (!kind || !handUsable(b.name)) return { ok: false, reason: 'not_usable', block: b.name };
    const holder = stateHolder(p, b);
    const holderBlock = samePos(holder, p) ? b : world.blockAt(holder);
    const before = openState(holderBlock);
    if (before === undefined) return { ok: false, reason: 'not_usable', block: b.name, kind };
    const want = opts.want ?? 'toggle';
    if ((kind === 'button' || kind === 'lever') && want !== 'toggle') return { ok: false, reason: 'toggle_only', block: b.name, kind, open: before };
    if (kind === 'button' && before) return { ok: false, reason: 'already_pressed', block: b.name, kind, open: before };
    if ((want === 'open' && before) || (want === 'closed' && !before)) return { ok: true, block: b.name, kind, open: before, changed: false, ticks: 0 };

    const reach = opts.reach ?? DEFAULT_CLICK_REACH;
    const eye = this.eye();
    const out = (e: Vec3) => closestDistance(e, p) > reach || cornerDistance(e, p) > SERVER_CLICK_REACH;
    if (out(eye)) return { ok: false, reason: 'out_of_reach', block: b.name, kind, open: before, distance: closestDistance(eye, p), serverDistance: cornerDistance(eye, p) };

    // Track BG2: sneaking with an item in the hand uses the item, not the block: sneak is released for the click
    const slot = world.inventory.selected;
    const unsneak = !opts.keepSneak && loop.command?.sneak === true && !!world.inventory.slots[slot];
    if (unsneak) loop.setCommand({ sneak: false });
    try {
      return await this.click(p, opts, b, kind, holder, before, unsneak, t0, ms0);
    } finally {
      if (unsneak && loop.command?.sneak !== true) loop.setCommand({ sneak: true }); // a click that never went out
    }
  }

  private async click(p: Vec3, opts: UseOptions, b: BlockInfo, kind: UsableKind, holder: Vec3, before: boolean, unsneak: boolean, t0: bigint, ms0: number): Promise<UseResult> {
    const { loop, world, source } = this.d;
    const reach = opts.reach ?? DEFAULT_CLICK_REACH;
    const out = (e: Vec3) => closestDistance(e, p) > reach || cornerDistance(e, p) > SERVER_CLICK_REACH;
    if (opts.look ?? true) {
      loop.setCommand(lookAngles(this.eye(), blockCenter(p)));
      await loop.waitTicks(2);
    } else if (unsneak) {
      await loop.waitTicks(1); // the server sees the stop before the click
    }
    if (this.cancelled) return { ok: false, reason: 'interrupted', block: b.name, kind, open: before };
    const eye = this.eye();
    if (out(eye)) return { ok: false, reason: 'out_of_reach', block: b.name, kind, open: before, distance: closestDistance(eye, p), serverDistance: cornerDistance(eye, p) };
    const faceNum = faceToward(eye, p);
    const face = faceOf(faceNum) ?? 'up';

    let restores = 0;
    let done: { open: boolean; at: bigint; ms: number } | undefined;
    const off = world.onBlockUpdate((q, _before, after) => {
      if (done || !samePos(q, holder)) return;
      const s = openState(after);
      if (s === undefined) return;
      if (s !== before) done = { open: s, at: loop.state.tick, ms: performance.now() };
      else restores++;
    });
    const slot = world.inventory.selected;
    const held = wireItemOf(world.inventory.slots[slot], world.inventory.rawItem(0, slot) ?? this.d.rawHotbarItem?.(slot));
    const tick0 = loop.state.tick;
    source.queue('inventory_transaction', clickBlockTransaction({ pos: p, face: faceNum, hotbarSlot: slot, held, eye, blockRuntimeId: world.chunks.runtimeIdAt(p.x, p.y, p.z) ?? 0 }));
    try {
      const timeout = opts.timeoutTicks ?? 20;
      for (let i = 0; i < timeout && !done && !this.cancelled; i++) {
        await loop.waitTicks(1);
        if (unsneak && i === 0) loop.setCommand({ sneak: true }); // Track BG2: the click has gone out: hold again
      }
    } finally {
      off();
    }
    const base = { block: b.name, kind, face, restores, distance: closestDistance(eye, p), serverDistance: cornerDistance(eye, p) };
    if (!done) {
      const reason: UseReason = this.cancelled ? 'interrupted' : restores > 0 ? 'rejected' : 'timeout';
      this.log.info(`use ${fmt(p)} ${b.name}: ${reason}`);
      return { ok: false, reason, ...base, open: this.isOpen(p) ?? before };
    }
    const ticks = Number(done.at - t0);
    this.log.info(`use ${fmt(p)} ${b.name}: ${before} -> ${done.open} after ${ticks} ticks (click +${Number(done.at - tick0)})`);
    return { ok: true, ...base, open: done.open, changed: true, ticks, clickTicks: Number(done.at - tick0), ms: done.ms - ms0 };
  }
}

function fmt(p: Vec3): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}
