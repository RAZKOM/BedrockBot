// The stash step (wave 8, Track AD; docs/get.md "Stash"): the work processes (mine, food, gather)
// call `await stash.ifFull(job)` where their inventory fills. When fewer than 2 slots are free:
//
//   (a) chest    the `stashChest` setting (x y z), else the job's own deposit chest: walk there, open
//                it, deposit every stack `keepOnDropItems` does not keep (the job's produce and junk),
//                close it
//   (b) shulker  else (or when the chest step freed too little), with `stashShulker` on and a shulker
//                box carried: place it on a free solid-topped cell next to the bot (open space above
//                for the lid), open it, deposit the same way, close it, break it (the Digger's best
//                tool; a shulker box drops itself with its contents with any tool) and pick it up
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
import type { Goal } from '../nav/goals.ts';
import { isInteractive, REPLACEABLE, type PlaceOptions, type PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { CONTAINER_BLOCKS, type DepositResult, type OpenResult } from './chest.ts';

/** Fewer free inventory slots than this: stash. */
export const MIN_FREE_SLOTS = 2;
/** item_stack_request slot type of a shulker box window (verified; `container` is refused). */
export const SHULKER_SLOT_TYPE = 'shulker';
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
/** Shulker box block / item names (Bedrock: the plain one is `undyed_shulker_box`). */
export const SHULKER_BOXES: ReadonlySet<string> = new Set(['undyed_shulker_box', 'shulker_box', ...COLOURS.map((c) => `${c}_shulker_box`)]);
// The chest skill opens these too (same click, same window): Track AD adds them at load time instead
// of editing chest.ts; the deposit addresses their slots as `shulker` (withSlotType below).
for (const n of SHULKER_BOXES) CONTAINER_BLOCKS.add(n);

export function isShulkerBox(name: string): boolean {
  return SHULKER_BOXES.has(name.startsWith('minecraft:') ? name.slice(10) : name);
}

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
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  open(p: Vec3): Promise<OpenResult>;
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<DepositResult>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  cancel(): void;
}

export interface StashDeps {
  skills: StashSkills;
  inventory: { readonly slots: readonly (ItemStack | null)[]; freeSlots(): number[] };
  blockAt(p: Vec3): BlockInfo | undefined;
  /** Feet. */
  position(): Vec3 | undefined;
  /** Live settings: `stashChest` (x y z | none), `stashShulker`. */
  settings: Pick<RuntimeSettings, 'get'>;
  /** The task's shared Containers (round trips counted on its stats; the shulker slot type is set on it). */
  containers?: { readonly stats: { requests: number } };
  /** Drop every item of a kind (SurvivalKit.drop); without it step (c) is skipped. */
  drop?(name: string, n?: number): Promise<{ ok: boolean; dropped: number; reason?: string }>;
  log?: Logger;
  /** Tell the owner (an attempt that left the inventory full). */
  say?(msg: string): void;
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
      if (this.needed() && this.d.settings.get('stashShulker') && this.shulkerSlot() >= 0 && this.hasDepositable()) {
        a.steps.push(await this.viaShulker(alive));
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

  private done(a: StashAttempt, t0: number, interrupted: boolean): boolean {
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

  private hasDepositable(): boolean {
    return this.d.inventory.slots.slice(0, 36).some((s) => !!s && s.count > 0 && depositable(s.name));
  }

  private shulkerSlot(): number {
    return this.d.inventory.slots.slice(0, 36).findIndex((s) => !!s && s.count > 0 && isShulkerBox(s.name));
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
    const g = this.seen(await this.d.skills.goto({ type: 'near', p: centre(chest), r: 2 }, { timeoutTicks: 4000 }));
    if (alive()) {
      if (!g.ok) step.reason = `goto: ${g.reason ?? 'failed'}`;
      else await this.fill(chest, undefined, step, alive);
    }
    step.ms = this.now() - t0;
    return step;
  }

  private async viaShulker(alive: () => boolean): Promise<StashStep> {
    const t0 = this.now();
    const sk = this.d.skills;
    const step: StashStep = { kind: 'shulker', ok: false, moved: {}, total: 0, requests: 0, shared: 0, ms: 0 };
    const slot = this.shulkerSlot();
    const item = this.d.inventory.slots[slot]?.name ?? 'undyed_shulker_box';
    const feet = this.d.position();
    const spots = feet ? boxSpots((q) => this.d.blockAt(q), feet) : [];
    if (spots.length === 0) {
      step.reason = 'no free cell next to the bot';
      step.ms = this.now() - t0;
      return step;
    }
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
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
    await this.fill(at, SHULKER_SLOT_TYPE, step, alive);
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
    step.ms = this.now() - t0;
    return step;
  }

  private boxesCarried(): number {
    let n = 0;
    for (const s of this.d.inventory.slots.slice(0, 36)) if (s && isShulkerBox(s.name)) n += s.count;
    return n;
  }

  private async dropJunk(job: StashJob, alive: () => boolean): Promise<StashStep> {
    const t0 = this.now();
    const step: StashStep = { kind: 'drop', ok: false, moved: {}, total: 0, requests: 0, shared: 0, ms: 0 };
    // junk only (STASH_JUNK): the job's produce and anything of value stay; throwaway blocks keep a reserve
    const have = new Map<string, number>();
    for (const s of this.d.inventory.slots.slice(0, 36)) {
      if (!s || s.count <= 0 || !isStashJunk(s.name) || job.wanted?.(s.name)) continue;
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

/** `shulker box at 1 -60 2: moved 1728 cobblestone in 27 requests, picked up again` */
export function stepLine(s: StashStep): string {
  const where = s.where ? ` at ${fmt(s.where)}` : '';
  const head = s.kind === 'chest' ? `chest${where}` : s.kind === 'shulker' ? `shulker box${where}` : 'dropped junk';
  const verb = s.kind === 'drop' ? '' : 'moved ';
  const tail = s.kind === 'drop' ? '' : ` in ${s.requests} requests (${s.shared} on the shared Containers)`;
  const pick = s.kind === 'shulker' && s.pickedUp ? ', picked up again' : '';
  const why = s.reason === 'container_full' ? `, ${s.kind === 'chest' ? 'chest' : 'box'} full` : s.reason ? ` (${s.reason})` : '';
  return `${head}: ${verb}${movedLine(s.moved)}${tail}${pick}${why}`;
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
