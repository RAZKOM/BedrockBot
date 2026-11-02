// The stash step (wave 8, Track AD; docs/get.md "Stash"): the work processes (mine, food, gather)
// call `await stash.ifFull(job)` where their inventory fills. When fewer than 2 slots are free:
//
//   (a) chest    the `stashChest` setting (x y z), else the job's own deposit chest: walk there, open
//                it, deposit every stack `keepOnDropItems` does not keep (the job's produce and junk),
//                close it
//   (b) shulker  else (or when the chest step freed too little), with `stashShulker` on and a shulker
//                box carried (Track AV: a box named `keepBoxName`, bot_loot, first; then the unnamed one
//                with the most room; selected in the hotbar so that box is the one placed): place it on a free solid-topped cell next to the bot (open space above
//                for the lid), open it, deposit the same way, close it, break it (the Digger's best
//                tool; a shulker box drops itself with its contents with any tool) and pick it up
//                Track AV, packing (the owner asked that other items come back out so the sand goes first):
//                junk that is no building block (DROP_FIRST: rotten flesh, string, spider eyes, ...) is
//                dropped before a box is filled and never boxed; the box takes the job's produce first,
//                then other items of value, filler blocks (cobblestone, sand, ...) last and only when no
//                produce is waiting; a box that already holds junk (stash junk the job does not want)
//                while produce is waiting is re-packed once: the junk is taken out stack by stack (always
//                with a second inventory slot free, so the keeper's full-inventory drops stay out), the
//                produce fills the freed slots, the junk is dropped after the box is picked up again
//                (`re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand`)
//   (c) drop     else drop the junk (`!drop items` minus what the job is getting)
//   (d) full     if fewer than 2 slots are free after that, ifFull() answers false and the job ends
//                with `inventory full` instead of looping
//
// Every attempt is logged with what it moved and the item_stack_request round trips it cost, counted
// on the task's shared Containers (one instance per bot). A pre-emption (guard, flee, night, !stop)
// cancels the step (`cancel()`); ifFull() then answers true and the job, once resumed, checks again.
//
// Verified on BDS 1.26.60.6 (docs/get.md "Packet facts"): a placed shulker box opens with
// container_open window_type `container` and 27 slots, but item_stack_request must address its slots
// as container_id `shulker` (ContainerSlotType 30); `container` and `shulker_box` are refused with
// status 50. The picked-up item carries its contents as NBT `Items` in the inventory packets.
import { keepOnDropItems } from '../../chat/commands-survival.ts';
import { DEFAULT_JUNK, DEFAULT_THROWAWAY_MIN, THROWAWAY_BLOCKS } from '../../skills/survival/keeper.ts';
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import { isInteractive, REPLACEABLE, type PlaceOptions, type PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { isShulkerBox, maxStackOf, shulkerContents, shulkerSlotsUsed, type DepositResult, type OpenResult } from './chest.ts'; // Track AG: shulker names, NBT reader and slot type live in chest.ts now
import { isFireworksBox } from '../fly/kit.ts'; // Track AU: the fireworks box is never the stash box
import { isKeptBox, keepNameOf, placesExactly } from '../home/boxing.ts'; // Track AV: the named (bot_loot) boxes first
export { isShulkerBox, SHULKER_BOXES, SHULKER_SLOT_TYPE, shulkerSlotsUsed } from './chest.ts'; // Track AG: re-exported for Track AD's callers

/** Fewer free inventory slots than this: stash. */
export const MIN_FREE_SLOTS = 2;

/**
 * The drop stage throws away junk only (never ore, ingots, gems or anything else of value): the survival
 * keeper's junk (rotten flesh, poisonous potatoes, string, spider eyes) plus filler blocks. Throwaway
 * blocks (cobblestone, dirt, ...) keep DEFAULT_THROWAWAY_MIN for pillaring; the job's produce is never junk.
 */
export const STASH_JUNK: ReadonlySet<string> = new Set([
  ...DEFAULT_JUNK,
  ...THROWAWAY_BLOCKS,
  'gravel', 'sand', 'red_sand', 'tuff', 'andesite', 'diorite', 'granite', 'stone', 'deepslate', 'calcite', 'dripstone_block', 'basalt', 'blackstone',
  'grass_block', 'coarse_dirt', 'podzol', 'mud', 'clay', 'moss_block', 'wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'bone', 'arrow', 'feather',
  'flint', 'snowball', 'ice', 'kelp', 'seagrass', 'vine', 'cactus', 'sugar_cane', 'bamboo', 'leaves', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
]);
export function isStashJunk(name: string): boolean {
  return STASH_JUNK.has(name.startsWith('minecraft:') ? name.slice(10) : name);
}
/** How many of a junk stack kind to drop: throwaway blocks keep DEFAULT_THROWAWAY_MIN, the rest go. */
export function junkDropCount(name: string, have: number): number {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return THROWAWAY_BLOCKS.includes(n) ? Math.max(0, have - DEFAULT_THROWAWAY_MIN) : have;
}

/**
 * Track AV: junk dropped before a box is filled, never boxed: the keeper's junk and the small drops that are
 * no building block. Filler blocks of STASH_JUNK (cobblestone, sand, gravel, ...) are boxed last instead.
 */
export const DROP_FIRST: ReadonlySet<string> = new Set([...DEFAULT_JUNK, 'snowball', 'seagrass', 'vine', 'kelp']); // not bones (bone meal), seeds (replanting), flint, feathers, arrows: those are boxed

/** Track AV: dropped before boxing (DROP_FIRST, unless the job is getting it). */
export function dropFirst(name: string, wanted?: (name: string) => boolean): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return DROP_FIRST.has(n) && !wanted?.(n);
}

/** Track AV: the packing class of an item for a box: 0 the job's produce, 1 other items of value, 2 filler blocks; undefined: never boxed (kept, or dropped first). */
export function packClass(name: string, wanted?: (name: string) => boolean): 0 | 1 | 2 | undefined {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  if (!depositable(n)) return undefined;
  if (wanted?.(n)) return 0;
  if (DROP_FIRST.has(n)) return undefined;
  return isStashJunk(n) ? 2 : 1;
}

/** Track AV: inventory slots (0..35) in packing order (produce, value, filler; slot order within a class). */
export function packOrder(slots: readonly ({ name: string; count: number } | null)[], wanted?: (name: string) => boolean): number[] {
  return slots
    .slice(0, 36)
    .map((s, i) => ({ i, c: s && s.count > 0 ? packClass(s.name, wanted) : undefined }))
    .filter((x): x is { i: number; c: 0 | 1 | 2 } => x.c !== undefined)
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((x) => x.i);
}

/** Track AV: stash junk a re-pack leaves in the box (bone meal, replanting, crafting). */
export const REPACK_KEEPS: ReadonlySet<string> = new Set(['bone', 'arrow', 'feather', 'flint', 'wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds']);

/** Track AV: what a re-pack takes out of a box (and drops): stash junk the job does not want, not REPACK_KEEPS. */
export function repackJunk(name: string, wanted?: (name: string) => boolean): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return isStashJunk(n) && !REPACK_KEEPS.has(n) && !wanted?.(n);
}

/** What the step deposits into a chest or shulker box: everything `!drop items` would drop. */
export function depositable(name: string): boolean {
  return !keepOnDropItems(name);
}

/** `x y z` / `none` (the stashChest setting) -> block position. */
export function parseChest(s: string | undefined): Vec3 | undefined {
  if (!s || s.trim().toLowerCase() === 'none') return undefined;
  const n = s.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 3 || !n.every((v) => Number.isFinite(v))) return undefined;
  return { x: Math.floor(n[0]!), y: Math.floor(n[1]!), z: Math.floor(n[2]!) };
}

export interface StashSkills {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  open(p: Vec3): Promise<OpenResult>;
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<DepositResult>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  cancel(): void;
  /** Track AV: turn the view (BotSkills.lookAt): the re-pack's junk is thrown away from the work area. */
  lookAt?(p: Vec3): Promise<void>;
}

export interface StashDeps {
  skills: StashSkills;
  inventory: { readonly slots: readonly (ItemStack | null)[]; freeSlots(): number[]; rawItem?(window: number, slot: number): unknown; window?(id: number): ContainerView | undefined }; // Track AV: window (the box's live slots in a re-pack)
  blockAt(p: Vec3): BlockInfo | undefined;
  /** Feet. */
  position(): Vec3 | undefined;
  /** Live settings: `stashChest` (x y z | none), `stashShulker`. */
  settings: Pick<RuntimeSettings, 'get'>;
  /** The task's shared Containers (round trips counted on its stats; the shulker slot type is set on it). Track AV: `move` takes junk out of a box in a re-pack. */
  containers?: { readonly stats: { requests: number }; move?(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean; reason?: string }> };
  /** Drop every item of a kind (SurvivalKit.drop); without it step (c) is skipped. */
  drop?(name: string, n?: number): Promise<{ ok: boolean; dropped: number; reason?: string }>;
  log?: Logger;
  /** Tell the owner (an attempt that left the inventory full). */
  say?(msg: string): void;
  /** Track AU: the inventory slot the owner named as the fireworks box (), never used as the stash box. */
  flightBoxSlot?(): number | undefined;
  /** Track AV: select a hotbar slot (Hotbar.select), so the placed box is the one chosen. */
  selectHotbar?(slot: number): void;
  /** Why the block in a cell may not be dug (the miner's break rules: nav/actions.ts `breakBlocker`); without it no cell is dug for the box. */
  breakBlocker?(p: Vec3): string | undefined;
  /** Move a main-inventory box into the hotbar (SurvivalKit.hotbar); its hotbar slot, undefined when it could not. */
  toHotbar?(slot: number): Promise<number | undefined>;
  now?: () => number;
}

export interface StashJob {
  /** The job's name for the log (`mine`, `food`, `gather`). */
  label?: string;
  /** The job's own deposit chest (gather `!gather N x y z`, farm). `stashChest` wins. */
  chest?: Vec3 | undefined;
  /** What the job is getting: never dropped in step (c). */
  wanted?: (name: string) => boolean;
}

export interface StashStep {
  kind: 'chest' | 'shulker' | 'drop';
  where?: Vec3;
  ok: boolean;
  reason?: string;
  moved: Record<string, number>;
  total: number;
  /** The step's own item_stack_request round trips (one per deposited stack), or drop calls. */
  requests: number;
  /** item_stack_requests on the shared Containers while the step ran (its own plus others', e.g. the keeper restocking the hotbar). */
  shared: number;
  ms: number;
  /** shulker: the box came back into the inventory. */
  pickedUp?: boolean;
  /** Track AV: a re-pack: junk taken out of the box and dropped, produce boxed in its place. */
  repacked?: { dropped: number; boxed: Record<string, number> };
}

export interface StashAttempt {
  job: string;
  freeBefore: number;
  freeAfter: number;
  ok: boolean;
  interrupted: boolean;
  steps: StashStep[];
  ms: number;
}

const fmt = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

/** Run `fn` with the Containers' container slot type switched (its private option; Track AD, see the file comment). */
export async function withSlotType<T>(containers: object | undefined, slotType: string, fn: () => Promise<T>): Promise<T> {
  const o = (containers as { opts?: { chestSlotType?: string } } | undefined)?.opts;
  const before = o?.chestSlotType;
  if (o && before !== undefined) o.chestSlotType = slotType;
  try {
    return await fn();
  } finally {
    if (o && before !== undefined) o.chestSlotType = before;
  }
}

/** Full-cube solid block with a top a box can stand on. */
function fullTop(b: BlockInfo | undefined): boolean {
  if (!b || !b.solid || isInteractive(b.name) || isShulkerBox(b.name)) return false;
  return b.boxes.some((x) => x[0] <= 0 && x[2] <= 0 && x[3] >= 1 && x[5] >= 1 && x[4] >= 1);
}

function empty(b: BlockInfo | undefined): boolean {
  return !!b && b.name !== 'unknown' && b.boxes.length === 0 && (b.name === 'air' || REPLACEABLE.has(b.name)) && !b.name.includes('water') && !b.name.includes('lava');
}

/** Ring of cells around the feet tried for the box, nearest first (2 ticks of look, then click). */
const RING: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
];

/** Free cells next to the feet for a shulker box: empty with empty space above (the lid), a full solid top below, not in the body. */
export function boxSpots(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3): Vec3[] {
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  const out: { p: Vec3; d: number }[] = [];
  for (const [dx, dz] of RING) {
    const p = { x: f.x + dx, y: f.y, z: f.z + dz };
    if (!empty(blockAt(p)) || !empty(blockAt({ ...p, y: p.y + 1 })) || !fullTop(blockAt({ ...p, y: p.y - 1 }))) continue;
    // the body (0.6 wide) must not reach into the cell
    if (feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 && feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1) continue;
    out.push({ p, d: Math.hypot(p.x + 0.5 - feet.x, p.z + 0.5 - feet.z) });
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.p);
}

/**
 * Cells beside the feet a box fits in once dug (no free cell: a 1-wide mine shaft): the cell and the one above
 * (the lid) each empty or breakable (`blocker` answers why not, the miner's break rules), at least one solid,
 * a full solid top below, not in the body; nearest first, the 4 sides only (in reach of the dig).
 */
export function carveSpots(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3, blocker: (p: Vec3) => string | undefined): { p: Vec3; dig: Vec3[] }[] {
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  const out: { p: Vec3; dig: Vec3[]; d: number }[] = [];
  for (const [dx, dz] of RING.slice(0, 4)) {
    const p = { x: f.x + dx, y: f.y, z: f.z + dz };
    if (!fullTop(blockAt({ ...p, y: p.y - 1 }))) continue;
    if (feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 && feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1) continue;
    const dig: Vec3[] = [];
    let ok = true;
    for (const q of [{ ...p, y: p.y + 1 }, p]) {
      if (empty(blockAt(q))) continue;
      if (blocker(q) !== undefined) {
        ok = false;
        break;
      }
      dig.push(q); // the lid cell first: the cell under it is never dug with a block left hanging over the box
    }
    if (ok && dig.length > 0) out.push({ p, dig, d: Math.hypot(p.x + 0.5 - feet.x, p.z + 0.5 - feet.z) });
  }
  return out.sort((a, b) => a.d - b.d || a.dig.length - b.dig.length).map(({ p, dig }) => ({ p, dig }));
}

export class Stash {
  private readonly d: StashDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private gen = 0;
  private running: Promise<boolean> | undefined;
  /** Every attempt, newest last (at most 50). */
  readonly attempts: StashAttempt[] = [];
  readonly stats = { attempts: 0, ok: 0, full: 0, interrupted: 0, chest: 0, shulker: 0, drop: 0, requests: 0 };

  constructor(d: StashDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => Date.now());
  }

  /** Fewer than MIN_FREE_SLOTS inventory slots are free. */
  needed(): boolean {
    return this.d.inventory.freeSlots().length < MIN_FREE_SLOTS;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Stop the running step (a pre-emption); its ifFull() answers true, the job checks again later. */
  cancel(): void {
    if (!this.running) return;
    this.gen++;
    this.d.skills.cancel();
  }

  /**
   * The stash step when the inventory is (nearly) full. True: the job may go on (room now, nothing to
   * do, or interrupted by a pre-emption); false: still full after every step (end the job).
   */
  ifFull(job: StashJob = {}): Promise<boolean> {
    if (!this.needed()) return Promise.resolve(true);
    if (this.running) return this.running;
    const p = this.attempt(job).finally(() => {
      this.running = undefined;
    });
    this.running = p;
    return p;
  }

  private async attempt(job: StashJob): Promise<boolean> {
    const gen = ++this.gen;
    const t0 = this.now();
    const label = job.label ?? 'job';
    const a: StashAttempt = { job: label, freeBefore: this.free(), freeAfter: 0, ok: false, interrupted: false, steps: [], ms: 0 };
    this.stats.attempts++;
    this.log.info(`stash (${label}): ${a.freeBefore} slots free; stashChest ${this.d.settings.get('stashChest')}, stashShulker ${this.d.settings.get('stashShulker') ? 'on' : 'off'}`);
    const alive = () => gen === this.gen;
    const start = this.d.position();
    try {
      const chest = parseChest(this.d.settings.get('stashChest')) ?? job.chest;
      if (chest && this.hasDepositable()) {
        a.steps.push(await this.toChest(chest, alive));
        if (!alive()) return this.done(a, t0, true);
      }
      // Track AV: junk that is no building block is dropped before a box takes it
      if (this.needed() && this.d.drop && this.d.settings.get('stashShulker') && this.boxChoice(job).best && this.has((n) => dropFirst(n, job.wanted))) {
        a.steps.push(await this.dropJunk(job, alive, (n) => dropFirst(n, job.wanted)));
        if (!alive()) return this.done(a, t0, true);
      }
      if (this.needed() && this.d.settings.get('stashShulker') && this.boxChoice(job).best && this.hasDepositable()) {
        a.steps.push(await this.viaShulker(alive, job));
        if (!alive()) return this.done(a, t0, true);
        // Track AV: the junk a re-pack took out of the box: thrown from where the job had the bot, away from it
        if (this.pendingJunk && start) {
          await this.back(start);
          if (!alive()) return this.done(a, t0, true);
        }
        await this.dropPendingJunk(alive);
        if (!alive()) return this.done(a, t0, true);
      }
      if (this.needed() && this.d.drop) {
        a.steps.push(await this.dropJunk(job, alive));
        if (!alive()) return this.done(a, t0, true);
      }
      // back to where the job had the bot (the chest trip or the box pickup moved it; a miner standing
      // on the line of sight to its ore would refuse to dig under its own feet)
      if (start && a.steps.some((s) => s.kind !== 'drop')) {
        await this.back(start);
        if (!alive()) return this.done(a, t0, true);
      }
    } catch (e) {
      this.log.warn(`stash (${label}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.done(a, t0, false);
  }

  /** Track AV: the cell of the box the running step places, fills and breaks (undefined when none). */
  boxAt: Vec3 | undefined;

  private done(a: StashAttempt, t0: number, interrupted: boolean): boolean {
    this.boxAt = undefined;
    a.freeAfter = this.free();
    a.interrupted = interrupted;
    a.ok = !this.needed();
    a.ms = this.now() - t0;
    this.attempts.push(a);
    if (this.attempts.length > 50) this.attempts.shift();
    for (const s of a.steps) {
      this.stats[s.kind]++;
      if (s.kind !== 'drop') this.stats.requests += s.requests;
    }
    const steps = a.steps.map((s) => stepLine(s)).join('; ') || 'nothing to move';
    if (interrupted) {
      this.stats.interrupted++;
      this.log.info(`stash (${a.job}): interrupted after ${steps}`);
      return true;
    }
    if (a.ok) {
      this.stats.ok++;
      this.log.info(`stash (${a.job}): ${a.freeBefore} -> ${a.freeAfter} slots free in ${(a.ms / 1000).toFixed(1)} s: ${steps}`);
      return true;
    }
    this.stats.full++;
    this.log.warn(`stash (${a.job}): inventory still full (${a.freeAfter} slots free): ${steps}`);
    this.d.say?.(`stash: inventory full (${steps})`);
    return false;
  }

  /** A skill answered 'interrupted': something cancelled the skills (a pre-emption): end this attempt. */
  private seen<R extends { ok: boolean; reason?: string | undefined }>(r: R): R {
    if (!r.ok && r.reason === 'interrupted') this.gen++;
    return r;
  }

  /** Walk back to the feet block the attempt started on (when the bot is more than half a block away). */
  private async back(start: Vec3): Promise<void> {
    const p = this.d.position();
    if (!p || Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z) < 0.5) return;
    const cell = { x: Math.floor(start.x), y: Math.floor(start.y + 1e-6), z: Math.floor(start.z) };
    const g = this.seen(await this.d.skills.goto({ type: 'block', p: cell }, { timeoutTicks: 1200 }));
    if (!g.ok && g.reason !== 'interrupted') this.log.info(`stash: back to ${fmt(cell)}: ${g.reason ?? 'failed'}`);
  }

  private free(): number {
    return this.d.inventory.freeSlots().length;
  }

  private has(pred: (name: string) => boolean): boolean {
    return this.d.inventory.slots.slice(0, 36).some((s) => !!s && s.count > 0 && pred(s.name));
  }

  private hasDepositable(): boolean {
    return this.d.inventory.slots.slice(0, 36).some((s) => !!s && s.count > 0 && depositable(s.name));
  }

  /**
   * The carried shulker box to fill: Track AV: a box named `keepBoxName` (bot_loot) with a free slot first,
   * then the one with the most free slots (its NBT `Items`); only a box the place skill will really pick
   * (in the hotbar, or the first of its colour), unless `toHotbar` can move the best one there first;
   * -1 when none has a free slot.
   */
  private async shulkerSlot(job: StashJob = {}): Promise<number> {
    const { best, exact } = this.boxChoice(job);
    // same-coloured boxes: the place skill takes the first one in the hotbar, often a full one; move the best one there
    if (best && exact !== best && this.d.toHotbar) {
      const to = await this.d.toHotbar(best.i);
      if (to !== undefined && placesExactly(this.d.inventory.slots, to)) {
        this.log.info(`stash: moved the ${best.named ? `${keepNameOf(this.d.settings.get('keepBoxName'))} box` : 'emptiest box'} from slot ${best.i} into hotbar slot ${to}`);
        return to;
      }
    }
    if (best && exact && exact !== best) this.log.info(`stash: the ${best.named ? `${keepNameOf(this.d.settings.get('keepBoxName'))} box` : 'emptiest box'} (slot ${best.i}) is not in the hotbar: filling the box in slot ${exact.i}`);
    return (exact ?? best)?.i ?? -1;
  }

  /** The best box to fill and the best one the place skill would pick by itself (see shulkerSlot). */
  private boxChoice(job: StashJob): { best?: { i: number; named: boolean } | undefined; exact?: { i: number; named: boolean } | undefined } {
    const keep = keepNameOf(this.d.settings.get('keepBoxName'));
    const cands: { i: number; used: number; named: boolean }[] = [];
    // Track AV: a full box holding junk counts too while the job's produce waits (it is re-packed)
    const produce = this.has((n) => packClass(n, job.wanted) === 0);
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (!s || s.count <= 0 || !isShulkerBox(s.name)) return;
      const raw = this.d.inventory.rawItem?.(0, i);
      if (isFireworksBox(s.name, raw) || this.d.flightBoxSlot?.() === i) return; // Track AU: the flight kit's box
      const used = shulkerSlotsUsed(raw);
      const junk = produce && !!this.d.containers?.move && Object.keys(shulkerContents(raw)).some((n) => repackJunk(n, job.wanted));
      if (used < 27 || junk) cands.push({ i, used: junk ? Math.min(used, 26) : used, named: isKeptBox(s.name, raw, keep) });
    });
    cands.sort((a, b) => Number(b.named) - Number(a.named) || a.used - b.used || a.i - b.i);
    return { best: cands[0], exact: cands.find((c) => placesExactly(this.d.inventory.slots, c.i)) };
  }

  private requests(): number {
    return this.d.containers?.stats.requests ?? 0;
  }

  /** Open the container at p (walked to already), deposit, close. */
  private async fill(p: Vec3, slotType: string | undefined, step: StashStep, alive: () => boolean): Promise<void> {
    const sk = this.d.skills;
    const o = await sk.open(p);
    if (!alive()) return;
    if (!o.ok) {
      step.reason = `open: ${o.reason}`;
      return;
    }
    const r0 = this.requests();
    const r = slotType ? await withSlotType(this.d.containers, slotType, () => sk.deposit(o.view, (i) => depositable(i.name))) : await sk.deposit(o.view, (i) => depositable(i.name));
    step.shared += this.requests() - r0;
    step.requests += r.requests;
    for (const [k, v] of Object.entries(r.moved)) step.moved[k] = (step.moved[k] ?? 0) + v;
    step.total += r.total;
    await sk.closeContainer(o.view);
    step.ok = r.total > 0;
    if (!r.ok) step.reason = r.reason ?? 'deposit failed';
  }

  private async toChest(chest: Vec3, alive: () => boolean): Promise<StashStep> {
    const t0 = this.now();
    const step: StashStep = { kind: 'chest', where: chest, ok: false, moved: {}, total: 0, requests: 0, shared: 0, ms: 0 };
    const g = this.seen(await this.d.skills.goto({ type: 'getToBlock', p: chest, reach: 4, face: false }, { timeoutTicks: 4000 })); // within reach from any height
    if (alive()) {
      if (!g.ok) step.reason = `goto: ${g.reason ?? 'failed'}`;
      else await this.fill(chest, undefined, step, alive);
    }
    step.ms = this.now() - t0;
    return step;
  }

  private async viaShulker(alive: () => boolean, job: StashJob = {}): Promise<StashStep> {
    const t0 = this.now();
    const sk = this.d.skills;
    const step: StashStep = { kind: 'shulker', ok: false, moved: {}, total: 0, requests: 0, shared: 0, ms: 0 };
    const slot = await this.shulkerSlot(job);
    const item = this.d.inventory.slots[slot]?.name ?? 'undyed_shulker_box';
    if (slot >= 0 && slot < 9) this.d.selectHotbar?.(slot); // Track AV: the held box is the one placed
    const feet = this.d.position();
    let spots = feet ? boxSpots((q) => this.d.blockAt(q), feet) : [];
    if (spots.length === 0 && feet && this.d.breakBlocker) {
      // a 1-wide shaft or tunnel (mining): dig a cell for the box beside the feet
      const blocker = this.d.breakBlocker.bind(this.d);
      for (const c of carveSpots((q) => this.d.blockAt(q), feet, blocker)) {
        let dug = true;
        for (const q of c.dig) {
          const r = this.seen(await sk.dig(q));
          if (!alive()) return { ...step, ms: this.now() - t0 };
          if (!r.ok) {
            dug = false;
            break;
          }
        }
        if (dug && boxSpots((q) => this.d.blockAt(q), feet).some((q) => q.x === c.p.x && q.y === c.p.y && q.z === c.p.z)) {
          this.log.info(`stash: no free cell next to the bot: dug ${c.dig.length} block${c.dig.length === 1 ? '' : 's'} for the box at ${fmt(c.p)}`);
          spots = [c.p];
          break;
        }
      }
    }
    if (spots.length === 0) {
      step.reason = this.d.breakBlocker ? 'no free cell next to the bot (and none it may dig)' : 'no free cell next to the bot';
      step.ms = this.now() - t0;
      return step;
    }
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
      this.boxAt = p; // Track AV: the home chore ignores this cell's block updates while the step runs
      const r = this.seen(await sk.place(p, { face: 'up', item }));
      if (!alive()) return { ...step, ms: this.now() - t0 };
      if (r.ok) {
        at = p;
        break;
      }
      step.reason = `place: ${r.reason ?? 'failed'}`;
    }
    if (!at) {
      step.ms = this.now() - t0;
      return step;
    }
    step.where = at;
    step.reason = undefined;
    const takenOut = await this.pack(at, step, alive, job); // Track AV: packing priority and the re-pack (the chest skill sets the `shulker` slot type per window)
    // break it and pick it up again, also after a failed open or deposit (never leave it behind);
    // a pre-emption in between leaves it standing: the next attempt finds the cell taken and the bot
    // picks it up on the way if it walks over it
    if (!alive()) return { ...step, ms: this.now() - t0 };
    const before = this.boxesCarried();
    const d = this.seen(await sk.dig(at));
    if (!alive()) return { ...step, ms: this.now() - t0 };
    if (!d.ok) {
      step.ok = false;
      step.reason = `break: ${d.reason ?? 'failed'}`;
      step.ms = this.now() - t0;
      return step;
    }
    for (const radius of [4, 6]) {
      this.seen(await sk.collect(radius, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) }));
      if (!alive()) return { ...step, ms: this.now() - t0 };
      if (this.boxesCarried() > before) break;
    }
    step.pickedUp = this.boxesCarried() > before;
    if (!step.pickedUp) {
      step.ok = false;
      step.reason = `the box was not picked up again (left at ${fmt(at)})`;
    }
    // Track AV: the junk a re-pack took out of the box goes on the floor (dropPendingJunk)
    if (step.repacked) this.pendingJunk = { step, takenOut };
    step.ms = this.now() - t0;
    return step;
  }

  /** Track AV: junk a re-pack took out of a box, dropped right after the box step (before the junk drop stage). */
  private pendingJunk: { step: StashStep; takenOut: Record<string, number> } | undefined;

  private async dropPendingJunk(alive: () => boolean): Promise<void> {
    const p = this.pendingJunk;
    this.pendingJunk = undefined;
    if (!p?.step.repacked) return;
    if (this.d.drop) {
      // look away from the box's cell and up: the stacks fly off the spot the job works from (it walked back
      // over junk dropped at the box and picked a third of it up again, bds-home)
      const pos = this.d.position();
      const from = p.step.where;
      if (pos && from && this.d.skills.lookAt) {
        let dx = pos.x - (from.x + 0.5);
        let dz = pos.z - (from.z + 0.5);
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        await this.d.skills.lookAt({ x: pos.x + dx * 5, y: pos.y + 1.62 + 3, z: pos.z + dz * 5 });
        if (!alive()) return;
      }
      for (const [n, c] of Object.entries(p.takenOut)) {
        const have = this.d.inventory.slots.slice(0, 36).reduce((x, it) => x + (it?.name === n ? it.count : 0), 0);
        const r = await this.d.drop(n, Math.min(c, junkDropCount(n, have)));
        if (!alive()) return;
        p.step.repacked.dropped += r.dropped;
      }
    }
    this.log.info(`stash: ${repackLine(p.step.repacked)}`);
    this.d.say?.(repackLine(p.step.repacked));
  }

  private boxesCarried(): number {
    let n = 0;
    for (const s of this.d.inventory.slots.slice(0, 36)) if (s && isShulkerBox(s.name)) n += s.count;
    return n;
  }

  /**
   * Track AV: open the placed box and fill it in packing order (produce, value, filler; filler only when no
   * produce waits); then, while produce waits and the box holds junk the job does not want, take one junk
   * stack out into the inventory and let the produce take the freed slot (one re-pack per box: after it the
   * box holds no junk, and the packing order never boxes junk while produce waits). Returns the junk taken out.
   */
  private async pack(at: Vec3, step: StashStep, alive: () => boolean, job: StashJob): Promise<Record<string, number>> {
    const sk = this.d.skills;
    const takenOut: Record<string, number> = {};
    const o = await sk.open(at);
    if (!alive()) return takenOut;
    if (!o.ok) {
      step.reason = `open: ${o.reason}`;
      return takenOut;
    }
    const r0 = this.requests();
    const produce = (i: ItemStack) => packClass(i.name, job.wanted) === 0;
    const waiting = () => this.has((n) => packClass(n, job.wanted) === 0);
    const put = async (filter: (i: ItemStack) => boolean): Promise<DepositResult> => {
      const r = await sk.deposit(o.view, filter);
      step.requests += r.requests;
      for (const [k, v] of Object.entries(r.moved)) step.moved[k] = (step.moved[k] ?? 0) + v;
      step.total += r.total;
      if (!r.ok) step.reason = r.reason ?? 'deposit failed';
      return r;
    };
    try {
      for (const cls of [0, 1, 2] as const) {
        if (cls === 2 && waiting()) break;
        if (!this.has((n) => packClass(n, job.wanted) === cls)) continue;
        const r = await put((i) => packClass(i.name, job.wanted) === cls);
        if (!alive() || (!r.ok && r.reason === 'container_full')) break;
      }
      // the re-pack
      const containers = this.d.containers;
      // the window's live slots: an inventory_content for the window replaces the array the view was opened with
      const live = (): readonly (ItemStack | null)[] => this.d.inventory.window?.(o.view.id)?.slots ?? o.view.slots;
      const junkSlot = () => live().findIndex((x) => !!x && x.count > 0 && repackJunk(x.name, job.wanted));
      if (containers?.move && waiting() && junkSlot() >= 0) {
        const boxed: Record<string, number> = {};
        for (let guard = 0; guard < 80 && alive() && waiting(); guard++) {
          const j = junkSlot();
          if (j < 0) break;
          // keep a slot free: a full inventory starts the survival keeper's own junk drops, whose requests
          // race these (seen on bds-home: the model and the box disagreed afterwards)
          const frees = this.d.inventory.freeSlots();
          if (frees.length < 2) {
            const r = await put(produce);
            if (r.total === 0) {
              this.log.info('stash: re-pack: no free inventory slot to take the junk out into');
              break;
            }
            for (const [k, v] of Object.entries(r.moved)) boxed[k] = (boxed[k] ?? 0) + v;
            continue;
          }
          const free = frees[0]!;
          const it = live()[j]!;
          const name = it.name;
          const count = it.count;
          const m = await containers.move({ window: o.view.id, slot: j }, { window: 0, slot: free }, count);
          step.requests++;
          if (!m.ok) {
            this.log.info(`stash: re-pack: taking ${count} ${name} out of the box: ${m.reason ?? 'refused'}`);
            break;
          }
          takenOut[name] = (takenOut[name] ?? 0) + count;
          const r = await put(produce);
          for (const [k, v] of Object.entries(r.moved)) boxed[k] = (boxed[k] ?? 0) + v;
        }
        if (Object.keys(takenOut).length) step.repacked = { dropped: 0, boxed };
      }
    } finally {
      step.shared += this.requests() - r0;
      await sk.closeContainer(o.view);
    }
    step.ok = step.total > 0;
    return takenOut;
  }

  private async dropJunk(job: StashJob, alive: () => boolean, only?: (name: string) => boolean): Promise<StashStep> {
    const t0 = this.now();
    const step: StashStep = { kind: 'drop', ok: false, moved: {}, total: 0, requests: 0, shared: 0, ms: 0 };
    // junk only (STASH_JUNK): the job's produce and anything of value stay; throwaway blocks keep a reserve
    const have = new Map<string, number>();
    for (const s of this.d.inventory.slots.slice(0, 36)) {
      if (!s || s.count <= 0 || !isStashJunk(s.name) || job.wanted?.(s.name) || (only && !only(s.name))) continue; // Track AV: `only` (the drop-first junk)
      have.set(s.name, (have.get(s.name) ?? 0) + s.count);
    }
    const names = new Map<string, number>();
    for (const [n, c] of have) if (junkDropCount(n, c) > 0) names.set(n, junkDropCount(n, c));
    if (names.size === 0) step.reason = 'no junk';
    for (const [n, count] of names) {
      const r = await this.d.drop!(n, count);
      if (!alive()) break;
      step.requests++;
      if (r.dropped > 0) {
        step.moved[n] = (step.moved[n] ?? 0) + r.dropped;
        step.total += r.dropped;
      }
      if (!r.ok && r.reason !== 'none') {
        step.reason = `${n}: ${r.reason ?? 'failed'}`;
        break;
      }
    }
    step.ok = step.total > 0;
    step.ms = this.now() - t0;
    return step;
  }
}

function movedLine(m: Record<string, number>): string {
  const parts = Object.entries(m).map(([k, v]) => `${v} ${k}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/** Track AV: `re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand` */
export function repackLine(r: { dropped: number; boxed: Record<string, number> }): string {
  const boxed = Object.entries(r.boxed).map(([k, v]) => `${Math.ceil(v / maxStackOf(k))} stacks of ${k}`).join(', ') || 'nothing';
  return `re-packed 1 box: dropped ${r.dropped} junk, boxed ${boxed}`;
}

/** `shulker box at 1 -60 2: moved 1728 cobblestone in 27 requests, picked up again` */
export function stepLine(s: StashStep): string {
  const where = s.where ? ` at ${fmt(s.where)}` : '';
  const head = s.kind === 'chest' ? `chest${where}` : s.kind === 'shulker' ? `shulker box${where}` : 'dropped junk';
  const verb = s.kind === 'drop' ? '' : 'moved ';
  const tail = s.kind === 'drop' ? '' : ` in ${s.requests} requests (${s.shared} on the shared Containers)`;
  const pick = s.kind === 'shulker' && s.pickedUp ? ', picked up again' : '';
  const why = s.reason === 'container_full' ? `, ${s.kind === 'chest' ? 'chest' : 'box'} full` : s.reason ? ` (${s.reason})` : '';
  return `${head}: ${verb}${movedLine(s.moved)}${tail}${pick}${why}${s.repacked ? `; ${repackLine(s.repacked)}` : ''}`;
}

// ---- one Stash per bot, found by the processes through their ProcessManager (Track AD) --------------

const stashes = new WeakMap<object, Stash>();

/** Register the bot's Stash under a key every work process can reach (the afk task's ProcessManager). */
export function setStash(key: object, s: Stash): void {
  stashes.set(key, s);
}

export function stashFor(key: object | undefined): Stash | undefined {
  return key ? stashes.get(key) : undefined;
}
