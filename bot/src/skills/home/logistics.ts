// Track AG (wave 9, docs/home.md): home logistics. Two jobs, both cancellable between steps (the
// process that runs them cancels the skills on a pre-emption and runs the job again on resume):
//
//   scan     find every container within `homeChestRadius` of home (discovery.ts), walk to each one not
//            read in the last 10 minutes, open it, snapshot it into the chest memory, close it;
//            remembered containers whose block is gone are forgotten. Track AN: with `homeChestWalk` > 0
//            every candidate first gets a bounded probe plan (reach.ts, no walking); those without a
//            path, or with a path longer than homeChestWalk, are remembered as unreachable (skipped for
//            an hour, or until `!chests scan`); the nearest MAX_READS_PER_SCAN by path length are read,
//            nearest-neighbour; the rest is reported as pending (the chore reads them next)
//   unload   plan (unloader.ts) from the inventory and the memory, walk to the nearest chest with moves,
//            open it, refresh its memory, plan again for that chest with what it really holds, deposit,
//            close; repeat. Then, while unloadable items are left and a chest holds an empty shulker box:
//            take the box, place it next to the bot, fill it, break it, pick it up and store the full box
//            in the box chest. With `all`, full shulker boxes carried (not the fireworks box) are emptied
//            (placed, opened, emptied into the inventory but for the slot the box needs back, broken,
//            picked up) and their items unloaded like the rest, one box after the other until none holds items.
//            Track AV (boxing.ts, docs/home.md "Boxing at the chests"): the plan's `box` steps run first
//            (a spare box, carried or taken from a chest; the target chest's loose stacks into the
//            inventory, in rounds when the inventory is short of room; the box placed next to the chest,
//            filled with that item's stacks, broken, picked up, stored in the chest), boxes named
//            `keepBoxName` (bot_loot) are emptied into the inventory between deposit passes and kept.
//            Fill steps (before the box steps): every full box's worth of one item the bot has (loose plus in
//            its bot_loot boxes) goes into a spare, in rounds (the item taken out of a bot_loot box, the
//            spare placed, filled, broken, picked up), and the full box into that item's chest. After the
//            deposits, tidy steps: a home chest holding 27 full stacks of one item loose gets them boxed there.
//   tidy     the idle chore's part of that: tidy steps only (MAX_TIDY_STEPS); what a failed step took out
//            of a chest goes back there.
//   withdraw Track AS (`!bring`, bring.ts): plan from the memory and the inventory, walk to the nearest
//            chest of the plan (the scan's stand cell), open it, take the item's stacks (or, when the
//            loose stacks are not enough, whole shulker boxes holding it), refresh its memory, close;
//            plan again; repeat until carried or no chest is left.
//
// Every chest trip refreshes that chest's record. All container traffic goes through the task's one
// Containers (`shared` counts its item_stack_requests while a job ran; `requests` the job's own).
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { chestKey, type ChestMemoryStore, type ChestRecord } from '../../world/cache/chests.ts';
import type { ContainerView, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import { isShulkerBox, maxStackOf, shulkerContents, shulkerSlotsUsed, type ContainerSnapshot, type DepositResult, type OpenResult } from '../container/chest.ts';
import { BoxOps } from '../supply/boxes.ts'; // Track BJ
import { isFireworksBox } from '../fly/kit.ts'; // Track AU: the fireworks box is never unloaded
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { chestNeighbours, findContainers, isHomeContainer, visitOrder, visitOrderBanded, type DiscoveryWorld } from './discovery.ts';
import { chestName, fmtPos, partnerKeys, planChests, recordFrom, unreadRecord } from './memory.ts';
import { chestGoal, standOf, verdict } from './reach.ts';
import { bringMatches, countOf, extractChoice, halfBox, planBring, takesWhole, type BringItem } from './bring.ts'; // Track AS; Track BJ: halves, extracts
import { compactRunner, heldBack, planUnload, unloadableStacks, type UnloadPlan, type UnloadSlot, type UnloadStep } from './unloader.ts';
import { BOX_SLOTS, carriedBoxes, carriedSpares, isKeptBox, keepNameOf, MAX_BOX_STEPS, MAX_FILL_STEPS, MAX_TIDY_STEPS, namedBoxesWord, placesExactly } from './boxing.ts'; // Track AV
import { DEFAULT_THROWAWAY_MIN, THROWAWAY_BLOCKS } from '../survival/keeper.ts';

/** A container read within this many ms is not read again by a scan. */
export const READ_FRESH_MS = 10 * 60_000;
/** The bot is "at home" within this many blocks (horizontal) of the home point. */
export const AT_HOME = 8;
/** Shulker boxes filled per unload run at most. */
export const MAX_BOXES_PER_RUN = 3;
/** Deposit passes per unload run at most: each one unloads, then empties the next carried box (`all`: every full box of the inventory). */
export const MAX_UNLOAD_PASSES = 24;
/** Rounds of one fill step at most (a take out of a carried box, or a fill of the spare: 27 stacks need 2 to 4 with ~25 free slots). */
export const MAX_FILL_ROUNDS = 12;
/** Track AN: a container found unreachable is not probed again for this long (ms), unless `!chests scan`. */
export const UNREACHABLE_RETRY_MS = 60 * 60_000;
/** Track AN: containers opened per scan at most (the rest stays pending for the next idle moment). */
export const MAX_READS_PER_SCAN = 64;
/** Candidates probed from the bot's position to pick the next container of a scan (the real path, not the straight line). */
export const NEXT_PROBES = 8;

export interface HomeSkills {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  open(p: Vec3): Promise<OpenResult>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  snapshot(view: ContainerView): ContainerSnapshot | undefined;
  depositSlots(view: ContainerView, moves: readonly { slot: number; count: number; name?: string }[]): Promise<DepositResult>;
  take(view: ContainerView, slot: number, count?: number, prefer?: readonly number[]): Promise<{ ok: boolean; reason?: string; to?: number; moved: number }>;
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  cancel(): void;
}

export interface HomeDeps {
  skills: HomeSkills;
  inventory: { readonly slots: readonly ({ name: string; count: number; metadata?: number } | null)[]; rawItem?(window: number, slot: number): unknown; window?(id: number): { readonly slots: readonly ({ name: string } | null | undefined)[] } | undefined }; // window 120: the armour worn
  world: DiscoveryWorld;
  position(): Vec3 | undefined;
  home(): Vec3 | undefined;
  memory(): ChestMemoryStore;
  settings: Pick<RuntimeSettings, 'get'>;
  /** The task's shared Containers: request counts, and inventory-to-inventory moves while a window is open. */
  containers?: {
    readonly stats: { requests: number };
    move?(src: { window: number; slot: number }, dst: { window: number; slot: number }, count: number): Promise<{ ok: boolean }>;
  };
  /** Select a hotbar slot (Hotbar.select), so a placed shulker box is the one wanted. */
  selectHotbar?(slot: number): void;
  /** Track AU: the inventory slot the owner named as the fireworks box (`!fly box <slot>`): kept like a fireworks-only box. */
  flightBoxSlot?(): number | undefined;
  /** Track AN: a bounded probe plan (reach.ts probePath) from `from` to `goal`; undefined: `from` is no standable node. Without it scans use the radius only. */
  probe?(goal: NavGoal, from: Vec3): Promise<PathResult | undefined>;
  log?: Logger;
  now?: () => number;
}

export interface ScanReport {
  ok: boolean;
  reason?: string;
  found: number;
  read: ChestRecord[];
  /** Read less than 10 minutes ago (not opened again). */
  fresh: number;
  forgotten: number;
  failed: { p: Vec3; reason: string }[];
  requests: number;
  ms: number;
  /** Track AN: homeChestRadius of this scan. */
  radius?: number;
  /** Track AN: homeChestWalk of this scan (0 = radius only); undefined when nothing was probed. */
  walk?: number;
  /** Track AN: probe plans made and their time (ms, wall clock: the slices and the waits between them). */
  probes?: number;
  probeMs?: number;
  /** Track AN: candidates whose probe found a path within `walk` (read, pending, or partners). */
  reachable?: number;
  /** Track AN: containers the bot could not get to (this scan's probes and walks, and those remembered from the last hour). */
  unreachable?: { p: Vec3; kind: string; reason: string }[];
  /** Track AN: reachable containers left for the next scan (MAX_READS_PER_SCAN). */
  pending?: Vec3[];
}

export interface ScanOptions {
  /** Read containers read less than 10 minutes ago too. */
  force?: boolean;
  /** Track AN: probe the containers remembered as unreachable again (`!chests scan`). */
  retry?: boolean;
  /** Only these blocks (containers that appeared, pending ones). */
  only?: Vec3[];
}

/** Track AN: a record without its unreachable mark. */
export function reachableAgain(r: ChestRecord): ChestRecord {
  const out = { ...r };
  delete out.unreachable;
  delete out.unreachableAt;
  return out;
}

export interface UnloadedLine {
  name: string;
  count: number;
  to: string;
}

export interface UnloadReport {
  ok: boolean;
  reason?: string;
  /** Moved items by (item, container name), in order. */
  moved: UnloadedLine[];
  kept: UnloadPlan['kept'];
  /** Unloadable items that stayed (no room anywhere, no empty box). */
  left: { name: string; count: number }[];
  /** Shulker boxes filled and stored. */
  boxes: number;
  /** Full shulker boxes emptied (`all`). */
  emptied: number;
  /** Track AV: box steps done: `stacks` stacks of `item` boxed at chest `chest` (its name), the empty box from `from`. */
  boxed?: { item: string; stacks: number; chest: string; from: string; took: number; rounds: number; ms: number }[];
  /** Fill steps done: a spare filled with 27 full stacks of `item` (`took` items out of the carried boxes), stored in `chest` (its name). */
  filled?: { item: string; chest: string; from: string; took: number; rounds: number; ms: number }[];
  /** Track AV: named (bot_loot) boxes emptied into the inventory, and how many named boxes stayed carried. */
  emptiedNamed?: number;
  namedKept?: number;
  /** Track AV: the `keepBoxName` of the run (the reply's `kept 2 bot_loot boxes`). */
  keepName?: string;
  /** Track AV/AW: the compact runner's reply fragment (`compacted 27 raw_iron into 3 raw_iron_block`). */
  compacted?: string;
  /** Track AV: why items were left (a kind whose chest could not be boxed). */
  blocked?: { item: string; chest: string; why: 'no_spare' | 'boxes_full' }[];
  chests: number;
  /** The job's own item_stack_requests (deposits and takes). */
  requests: number;
  /** item_stack_requests on the shared Containers while the job ran. */
  shared: number;
  ms: number;
}

/** Track AS: what one `!bring` withdrawal did. */
export interface WithdrawReport {
  ok: boolean;
  reason?: string;
  /** Items taken by name (loose stacks; boxes count under their own name). */
  taken: Record<string, number>;
  /** Containers that gave something, by name (`chest 3 -60 -2`). */
  from: string[];
  /** Full shulker boxes taken out and the matching items inside each. */
  boxes: { name: string; items: number; from: string }[];
  /** Track BJ: items taken out of a box placed next to the bot (`back`: the box went back into its chest). */
  extracted?: { items: number; from: string; back: boolean }[];
  /** Matching items carried after the job (top-level inventory). */
  carried: number;
  /** Chest trips. */
  chests: number;
  requests: number;
  ms: number;
}

/** What an interrupted or failed box step took: `loose` items of `item` and the box it was filling, owed to `chest`. */
interface Debt {
  chest: string;
  item: string;
  loose: number;
  box: number | undefined;
  /** Track BJ: an extract's box: the box holding exactly this (any slot; also one fetched from the ground later). */
  contents?: Record<string, number>;
}

const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
const hdist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

export class HomeLogistics {
  private readonly d: HomeDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private running = 0;
  /** Jobs run one after the other: a cancelled job finishes its current step before the next starts. */
  private chain: Promise<void> = Promise.resolve();
  lastScan: ScanReport | undefined;
  lastUnload: UnloadReport | undefined;

  /** Track BJ: the placed-box steps (place, take out, put in, pick up), shared with `!bring` and the supply layer. */
  readonly boxes: BoxOps;

  constructor(d: HomeDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => Date.now());
    this.boxes = new BoxOps({
      skills: d.skills,
      inventory: d.inventory,
      blockAt: (p) => d.world.blockAt(p),
      position: () => d.position(),
      keepName: () => this.keepName(),
      ...(d.selectHotbar ? { selectHotbar: (slot: number) => d.selectHotbar!(slot) } : {}),
      toHotbar: (slot, cancelled) => this.boxToHotbar(slot, cancelled),
      log: this.log,
    });
  }

  /** A job runs (block updates it causes itself are ignored by the trigger). */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Track BJ: run `fn` under the serial lock (the task's Supply: its box work never overlaps a home job). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn);
  }

  /** Run `fn` after the previous job ended (serialised), counted in `busy`. */
  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise((r) => {
      release = r;
    });
    this.running++;
    try {
      await prev;
      return await fn();
    } finally {
      this.running--;
      release();
    }
  }

  radius(): number {
    return Number(this.d.settings.get('homeChestRadius'));
  }

  /** Track AN: the walking distance limit (path blocks; 0 = no path check). */
  walkLimit(): number {
    return Number(this.d.settings.get('homeChestWalk'));
  }

  /** Within AT_HOME blocks of home (horizontal, 4 vertical). */
  atHome(): boolean {
    const h = this.d.home();
    const p = this.d.position();
    return !!h && !!p && hdist({ x: h.x + 0.5, y: h.y, z: h.z + 0.5 }, p) <= AT_HOME && Math.abs(p.y - h.y) <= 4;
  }

  /** The remembered containers within the radius of home (or of the bot without a home). */
  records(): ChestRecord[] {
    const at = this.d.home() ?? this.d.position();
    if (!at) return [];
    return this.d.memory().near(centre(at), this.radius() + 1);
  }

  /** The inventory as the unloader sees it (with shulker box contents from the raw items). */
  slots(): UnloadSlot[] {
    const out: UnloadSlot[] = [];
    const keep = this.keepName();
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (!s || s.count <= 0) return;
      const raw = this.d.inventory.rawItem?.(0, i);
      out.push({ slot: i, name: s.name, count: s.count, ...(isShulkerBox(s.name) ? { boxUsed: shulkerSlotsUsed(raw) } : {}), ...(isShulkerBox(s.name) && shulkerSlotsUsed(raw) > 0 ? { boxItems: shulkerContents(raw) } : {}), ...(isFireworksBox(s.name, raw) || this.d.flightBoxSlot?.() === i ? { flightKit: true } : {}), ...(isKeptBox(s.name, raw, keep) ? { named: true } : {}), ...(isShulkerBox(s.name) && raw === undefined ? { unknown: true } : {}) }); // Track AU: the fireworks box is kept; Track AV: named boxes
    });
    return out;
  }

  /** Track BJ: the skills the placed-box steps use (the task's Supply builds its own BoxOps on them). */
  skillsForBoxes(): HomeSkills {
    return this.d.skills;
  }

  /** Track AV: the `keepBoxName` setting (bot_loot). */
  keepName(): string {
    return keepNameOf(this.d.settings.get('keepBoxName'));
  }

  /** Track AV: the throwaway reserve (`throwawayMin`, default 16). */
  private reserve(): number | undefined {
    const r = Number(this.d.settings.get('throwawayMin'));
    return Number.isFinite(r) && r >= 0 ? r : undefined;
  }

  /** Track BJ: the food and seed reserves (`foodReserve`, `seedReserve`). */
  private crops(): { foodReserve?: number; seedReserve?: number } {
    const f = Number(this.d.settings.get('foodReserve'));
    const s = Number(this.d.settings.get('seedReserve'));
    return { ...(Number.isFinite(f) && f >= 0 ? { foodReserve: f } : {}), ...(Number.isFinite(s) && s >= 0 ? { seedReserve: s } : {}) };
  }

  /** What the autoUnload chore looks at: unloadable stacks carried and full boxes. */
  load(): { stacks: number; fullBoxes: number } {
    const r = this.reserve();
    return unloadableStacks(this.slots(), { ...(r !== undefined ? { reserve: r } : {}), ...this.crops() });
  }

  /** The unload plan now; `reserve`: one free slot of that chest is kept (for a full box that goes back there). */
  plan(all = false, reserve?: string, box: { on?: boolean; fill?: boolean; tidy?: boolean; skip?: ReadonlySet<string>; skipFill?: ReadonlySet<string>; hold?: ReadonlySet<string> } = {}): UnloadPlan {
    const p = this.d.position();
    const chests = planChests(this.records()).map((c) => (c.key === reserve ? { ...c, free: Math.max(0, c.free - 1) } : c));
    const r = this.reserve();
    return planUnload(this.slots(), chests, {
      all,
      ...(p ? { origin: p } : {}),
      ...(r !== undefined ? { reserve: r } : {}),
      boxing: box.on ?? true, // Track AV
      filling: box.fill ?? box.on ?? true,
      ...(box.tidy ? { tidy: true } : {}),
      ...(box.skip ? { noBox: box.skip } : {}),
      ...(box.skipFill ? { noFill: box.skipFill } : {}),
      ...(box.hold?.size ? { hold: box.hold } : {}),
      noTidy: this.unchanged(this.tidyFailed),
      noSpareFrom: this.unchanged(this.spareRefused),
      worn: (this.d.inventory.window?.(120)?.slots ?? []).flatMap((x) => (x ? [x.name] : [])),
      ...this.crops(), // Track BJ
    });
  }

  /** Tidy steps that failed, by `chestKey|item`: the chest's readAt then (not planned again until the chest is read anew). */
  private readonly tidyFailed = new Map<string, number>();
  /** Chests that gave no spare though the memory counted one, with their readAt then. */
  private readonly spareRefused = new Map<string, number>();

  /** The keys of `m` whose chest record was not read again since (the others are dropped). */
  private unchanged(m: Map<string, number>): Set<string> {
    const out = new Set<string>();
    for (const [k, at] of m) {
      const [x, y, z] = k.split('|')[0]!.split(',').map(Number);
      if (this.d.memory().get({ x: x!, y: y!, z: z! })?.readAt === at) out.add(k);
      else m.delete(k);
    }
    return out;
  }

  private requests(): number {
    return this.d.containers?.stats.requests ?? 0;
  }


  // ---- reading one container ------------------------------------------------------------------

  /** Walk to a container, open it, remember what it holds, keep it open (the caller closes it). */
  /** The stand cells the probes found, by container key: the walk goes there, not to whatever cell the goal picks (Realm 2026-10-30: a chest 5 blocks from home sent the bot 180 blocks around the house to a cell behind the wall). */
  private readonly stands = new Map<string, Vec3>();

  private async visit(p: Vec3, kind: string, cancelled: () => boolean): Promise<{ ok: true; view: ContainerView; record: ChestRecord } | { ok: false; reason: string }> {
    let stand = this.stands.get(chestKey(p));
    if (!stand && this.d.probe && this.walkLimit() > 0) {
      const here = this.d.position();
      if (here) stand = standOf(await this.d.probe(chestGoal(p), here));
    }
    let g = stand ? await this.d.skills.goto({ type: 'block', p: stand }, { timeoutTicks: 800 }) : { ok: false as const, reason: 'no stand' };
    if (!g.ok && !cancelled() && g.reason !== 'interrupted') g = await this.d.skills.goto(chestGoal(p), { timeoutTicks: 800 }); // 40 s: a stuck walk must not eat the scan // 40 s: the probe already said it is reachable; a stuck walk must not eat the scan // within reach from any height (stacked chests, shelves, Track AN: up to 3 blocks above the feet); `near` failed for chests above floor level on the Realm
    if (cancelled()) return { ok: false, reason: 'interrupted' };
    if (!g.ok) return { ok: false, reason: `goto: ${g.reason ?? 'failed'}` };
    let o = await this.d.skills.open(p);
    // a container opened and closed a moment ago sometimes misses one click (seen with barrels): once more
    if (!o.ok && o.reason === 'timeout' && !cancelled()) o = await this.d.skills.open(p);
    if (cancelled()) {
      if (o.ok) await this.d.skills.closeContainer(o.view);
      return { ok: false, reason: 'interrupted' };
    }
    if (!o.ok) {
      // the block is gone or is no container any more: forget it
      const b = this.d.world.blockAt(p);
      if (b && b.name !== 'unknown' && !isHomeContainer(b.name)) this.d.memory().delete(p);
      return { ok: false, reason: `open: ${o.reason}` };
    }
    const record = this.remember(p, o.block ?? kind, o.view);
    return { ok: true, view: o.view, record };
  }

  /** Snapshot the open window into the memory (double chest: its other half becomes the partner). */
  private remember(p: Vec3, kind: string, view: ContainerView): ChestRecord {
    const mem = this.d.memory();
    const snap = this.d.skills.snapshot(view) ?? { size: view.slots.length, counts: {}, stacks: 0, free: view.slots.length, double: false, room: {}, boxes: { empty: 0, full: 0 } };
    let partner: Vec3 | undefined;
    if (snap.double) {
      const n = chestNeighbours((q) => this.d.world.blockAt(q), p, kind);
      if (n.length === 1) {
        partner = n[0];
        mem.delete(partner!); // the other half is no container of its own
      }
    }
    const r = recordFrom(p, kind, snap, mem.get(p), this.now(), partner);
    // Track AS: what the full shulker boxes hold (the `!bring` plan and the `!get` hint read it)
    const inBoxes: Record<string, number> = {};
    const boxList: Record<string, number>[] = []; // Track BJ: per box
    view.slots.forEach((s, i) => {
      if (!s || !isShulkerBox(s.name)) return;
      const inside = shulkerContents(this.d.inventory.rawItem?.(view.id, i));
      for (const [k, v] of Object.entries(inside)) inBoxes[k] = (inBoxes[k] ?? 0) + v;
      if (Object.keys(inside).length) boxList.push(inside);
    });
    // Track AV: boxes named keepBoxName are the owner's (never spares, never the box chest's load): out of the box counts
    const keep = this.keepName();
    let namedEmpty = 0;
    let namedFull = 0;
    view.slots.forEach((s, i) => {
      if (!s || !isShulkerBox(s.name)) return;
      const raw = this.d.inventory.rawItem?.(view.id, i);
      if (raw !== undefined && !isKeptBox(s.name, raw, keep)) return; // a box without its wire item is no spare either
      if (shulkerSlotsUsed(raw) > 0) namedFull += s.count;
      else namedEmpty += s.count;
    });
    const r2: ChestRecord = namedEmpty + namedFull > 0 ? { ...r, boxes: { empty: Math.max(0, r.boxes.empty - namedEmpty), full: Math.max(0, r.boxes.full - namedFull) } } : r;
    // the full stacks by item (a tidy step boxes 27 of them; partial stacks never count)
    const fullStacks: Record<string, number> = {};
    for (const st of view.slots) if (st && !isShulkerBox(st.name) && maxStackOf(st.name) > 1 && st.count >= maxStackOf(st.name)) fullStacks[st.name] = (fullStacks[st.name] ?? 0) + 1;
    const r3: ChestRecord = { ...r2 };
    delete r3.fullStacks;
    delete r3.boxList;
    if (Object.keys(fullStacks).length) r3.fullStacks = fullStacks;
    if (boxList.length) r3.boxList = boxList;
    const rec: ChestRecord = Object.keys(inBoxes).length ? { ...r3, inBoxes } : r3;
    mem.set(rec);
    return rec;
  }

  // ---- scan --------------------------------------------------------------------------------------

  /**
   * Find and read the containers around home (see the file comment). `force` reads fresh ones too;
   * `retry` (Track AN) probes the ones remembered as unreachable again; `only` limits the scan to these blocks.
   */
  scan(cancelled: () => boolean, opts: ScanOptions = {}): Promise<ScanReport> {
    return this.serial(() => this.doScan(cancelled, opts));
  }

  /** Unload at home (see the file comment). */
  unload(cancelled: () => boolean, opts: { all?: boolean } = {}): Promise<UnloadReport> {
    return this.serial(() => this.doUnload(cancelled, opts));
  }

  /** The idle chore's tidy job: the home chests' own full boxes' worth into spares (tidy steps only). */
  tidy(cancelled: () => boolean): Promise<UnloadReport> {
    return this.serial(() => this.doTidy(cancelled));
  }

  /** Track BJ: of `item`, what the unload holds back (the throwaway reserve, the food and seed reserve; unloader.ts heldBack). */
  private holdOf(item: string): number {
    const r = this.reserve();
    return heldBack(this.slots(), { ...(r !== undefined ? { reserve: r } : {}), ...this.crops() }).all.get(item) ?? 0;
  }

  /** A tidy step is due: a home chest holds 27 full stacks' worth of one item loose and a spare is known. */
  tidyDue(): boolean {
    return this.plan(false, undefined, { tidy: true }).steps.length > 0;
  }

  /** Track AS: take `want` of the item out of the chests at home (see the file comment); what is carried counts first. */
  withdraw(cancelled: () => boolean, req: { item: BringItem; want: number }): Promise<WithdrawReport> {
    return this.serial(() => this.doWithdraw(cancelled, req));
  }

  /** Track AS: matching items in the inventory (slots 0..35). */
  carried(item: BringItem): number {
    let n = 0;
    // Track AV: the bot_loot boxes and the fireworks box do not count as carried boxes
    const kept = new Set(carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.()).filter((b) => b.named || b.flightKit).map((b) => b.slot));
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (s && s.count > 0 && !kept.has(i) && bringMatches(item, s.name)) n += s.count;
    });
    return n;
  }

  private async doWithdraw(cancelled: () => boolean, req: { item: BringItem; want: number }): Promise<WithdrawReport> {
    const t0 = this.now();
    const rep: WithdrawReport = { ok: false, taken: {}, from: [], boxes: [], carried: 0, chests: 0, requests: 0, ms: 0 };
    const finish = (reason?: string): WithdrawReport => {
      rep.ok = reason === undefined;
      if (reason) rep.reason = reason;
      rep.carried = this.carried(req.item);
      rep.ms = this.now() - t0;
      const took = Object.entries(rep.taken).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
      this.log.info(`bring: withdraw ${rep.ok ? 'done' : `ended (${reason})`}: took ${took}${rep.boxes.length ? ` (${rep.boxes.length} full shulker boxes)` : ''} from ${rep.from.length} containers in ${rep.chests} trips; carrying ${rep.carried} (${(rep.ms / 1000).toFixed(1)} s)`);
      return rep;
    };
    if (!this.d.home()) return finish('no_home');
    // Track BJ: an earlier extract's box (or one left standing / on the ground) goes back first
    if (this.debts.length > 0 || this.boxes.pending) {
      if ((await this.settleDebts(rep, cancelled)) === 'interrupted') return finish('interrupted');
    }
    const failed = new Set<string>();
    let boxItems = 0;
    for (let round = 0; round < 24; round++) {
      if (cancelled()) return finish('interrupted');
      const plan = planBring(this.records(), req.item, req.want, this.carried(req.item) + boxItems, this.d.position());
      if (plan.need <= 0) break;
      const mode = (x: { box: boolean; extract?: true }): string => (x.extract ? 'extract' : x.box ? 'box' : 'loose');
      const next = plan.sources.find((x) => !failed.has(`${x.key}:${mode(x)}`));
      if (!next) break;
      const tag = `${next.key}:${mode(next)}`;
      const v = await this.visit(next.pos, next.kind, cancelled);
      if (!v.ok) {
        if (v.reason === 'interrupted') return finish('interrupted');
        this.log.info(`bring: ${next.kind} at ${fmtPos(next.pos)}: ${v.reason}`);
        failed.add(tag);
        continue;
      }
      rep.chests++;
      let got = 0;
      let full = false;
      let extractSlot: number | undefined; // Track BJ: the box taken out for an extract (the chest is closed first)
      let extractBox: { name: string; inside: number } | undefined;
      try {
        let left = plan.need;
        const used = (i: number): number => shulkerSlotsUsed(this.d.inventory.rawItem?.(v.view.id, i));
        if (next.extract) {
          // Track BJ: one box out (into the hotbar: the place takes it), the items come out of it next to the bot
          const inside = v.view.slots.map((st, i) => (st && isShulkerBox(st.name) ? countOf(req.item, shulkerContents(this.d.inventory.rawItem?.(v.view.id, i))) : 0));
          const i = extractChoice(inside, left);
          if (i !== undefined && this.boxes.freeSlots().length >= 3) {
            await this.freeHotbarSlot();
            extractBox = { name: v.view.slots[i]!.name, inside: inside[i]! };
            const t = await this.d.skills.take(v.view, i, 1, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
            if (t.moved > 0) rep.requests++;
            if (t.ok && t.to !== undefined) extractSlot = await this.hotbarWhileOpen(t.to);
          } else if (i !== undefined) full = true;
        } else if (!next.box) {
          // loose stacks: the preferred name first; shulker boxes asked for: the empty ones first
          const rank = (name: string): number => {
            const k = req.item.names.indexOf(name);
            return k < 0 ? req.item.names.length : k;
          };
          const slots = v.view.slots
            .map((st, i) => ({ st, i }))
            .filter((x) => !!x.st && x.st.count > 0 && bringMatches(req.item, x.st.name))
            .sort((a, b) => rank(a.st!.name) - rank(b.st!.name) || (req.item.boxes ? used(a.i) - used(b.i) : 0) || a.i - b.i);
          for (const { st, i } of slots) {
            if (left <= 0 || cancelled()) break;
            const itemName = st!.name;
            const t = await this.d.skills.take(v.view, i, Math.min(left, st!.count));
            if (t.moved > 0) {
              rep.requests++;
              rep.taken[itemName] = (rep.taken[itemName] ?? 0) + t.moved;
              left -= t.moved;
              got += t.moved;
            }
            if (!t.ok || t.reason === 'inventory_full') {
              full = t.reason === 'inventory_full';
              break;
            }
          }
        } else {
          // whole boxes holding the item, the fullest first (Track BJ: while half a box or more is still needed, and only
          // boxes holding half a box of it or more, like the plan: a mixed box with a few of it is taken out of instead)
          const half = halfBox(req.item);
          const order = v.view.slots
            .map((st, i) => ({ i, inside: st && isShulkerBox(st.name) ? countOf(req.item, shulkerContents(this.d.inventory.rawItem?.(v.view.id, i))) : 0 }))
            .filter((x) => x.inside > 0 && x.inside >= half)
            .sort((a, b) => b.inside - a.inside || a.i - b.i);
          for (const { i, inside } of order) {
            if (!takesWhole(left, half) || cancelled()) break;
            const st = v.view.slots[i]!;
            const boxName = st.name;
            const t = await this.d.skills.take(v.view, i, 1);
            if (t.moved > 0) {
              rep.requests++;
              rep.taken[boxName] = (rep.taken[boxName] ?? 0) + 1;
              rep.boxes.push({ name: boxName, items: inside, from: chestName(v.record) });
              boxItems += inside;
              left -= inside;
              got += inside;
            }
            if (!t.ok) {
              full = t.reason === 'inventory_full';
              break;
            }
          }
        }
        // the memory follows at once (counts down; a box taken out leaves the box counts)
        const after = this.remember(next.pos, v.record.kind, v.view);
        if (got > 0 && !rep.from.includes(chestName(after))) rep.from.push(chestName(after));
      } finally {
        await this.d.skills.closeContainer(v.view);
      }
      if (extractSlot !== undefined) {
        const e = await this.extractFrom(extractSlot, next, req.item, plan.need, extractBox!, rep, cancelled);
        got += e.got;
        boxItems += e.whole ?? 0;
        if (e.reason === 'interrupted') return finish('interrupted');
        if (e.reason) this.log.info(`bring: taking ${req.item.word} out of a box from ${chestName(v.record)}: ${e.reason}`);
        if (e.got === 0 && this.boxes.freeSlots().length < 3) full = true;
      }
      if (cancelled()) return finish('interrupted');
      if (full) return finish('inventory_full');
      if (got === 0) failed.add(tag); // it held less than remembered: the refreshed memory sends the next round elsewhere
    }
    return finish();
  }

  /**
   * Track BJ (decision 0052): the box of inventory slot `slot`, just taken out of the chest at `from`: placed next to the
   * bot, `want` of the item taken out of it (two inventory slots kept free, see emptyBox), broken, picked up and put
   * back into that chest. What was taken, and why it stopped short (a box not put back is carried: the reply says so).
   */
  private async extractFrom(slot: number, from: { key: string; pos: Vec3; kind: string }, item: BringItem, want: number, box: { name: string; inside: number }, rep: WithdrawReport, cancelled: () => boolean): Promise<{ got: number; whole?: number; reason?: string }> {
    const byName = (): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const s of this.d.inventory.slots.slice(0, 36)) if (s && s.count > 0 && bringMatches(item, s.name)) m[s.name] = (m[s.name] ?? 0) + s.count;
      return m;
    };
    const before = byName();
    const contents = { ...shulkerContents(this.d.inventory.rawItem?.(0, slot)) };
    const out: { slot?: number } = {};
    const r = await this.boxes.takeOut(slot, rep, cancelled, { item: (n) => bringMatches(item, n), want }, out);
    let got = 0;
    for (const [k, v] of Object.entries(byName())) {
      const n = v - (before[k] ?? 0);
      if (n <= 0) continue;
      rep.taken[k] = (rep.taken[k] ?? 0) + n;
      got += n;
      // what the box holds now (the debt below finds it by that)
      const left = (contents[k] ?? 0) - n;
      if (left > 0) contents[k] = left;
      else delete contents[k];
    }
    const name = chestName(this.d.memory().get(from.pos) ?? unreadRecord(from.pos, from.kind));
    if (got > 0 && !rep.from.includes(name)) rep.from.push(name);
    // nothing came out and the box is carried as it was (no free cell, the place failed, it did not open): it comes whole
    if (got === 0 && r !== 'interrupted' && out.slot !== undefined) {
      rep.taken[box.name] = (rep.taken[box.name] ?? 0) + 1;
      rep.boxes.push({ name: box.name, items: box.inside, from: name });
      if (!rep.from.includes(name)) rep.from.push(name);
      this.log.info(`bring: taking ${item.word} out of a shulker box from ${name}: ${r}; the box comes whole`);
      return { got: box.inside, whole: box.inside };
    }
    const line = { items: got, from: name, back: false };
    (rep.extracted ??= []).push(line);
    // the box goes back into its chest: at once, else (interrupted, not stored, left on the ground) as a debt the next
    // withdrawal or unload settles first (never filed elsewhere by an unload)
    const debt = (at: number | undefined): void => {
      this.debts.push({ chest: from.key, item: '', loose: 0, box: at, contents });
    };
    if (r === 'interrupted' || out.slot === undefined) {
      debt(out.slot);
      this.log.info(`bring: took ${got} ${item.word} out of a shulker box from ${name}; the box goes back later (${r})`);
      return { got, reason: r === 'interrupted' ? r : `the box goes back later: ${r}` };
    }
    const back = await this.storeBox(from.pos, from.kind, out.slot, cancelled, rep);
    line.back = typeof back !== 'string';
    this.log.info(`bring: took ${got} ${item.word} out of a shulker box from ${name}; the box ${typeof back !== 'string' ? 'went back' : `goes back later (${back})`}`);
    if (typeof back === 'string') {
      debt(out.slot);
      return { got, reason: back === 'interrupted' ? back : `the box goes back later: ${back}` };
    }
    return { got, ...(r.startsWith('emptied') ? {} : { reason: r }) };
  }

  /** Track AN: remember that the bot cannot get to the container at p (kept until a read or `!chests clear`). */
  private markUnreachable(p: Vec3, kind: string, reason: string, rep: ScanReport): void {
    const mem = this.d.memory();
    const rec = mem.get(p) ?? unreadRecord(p, kind);
    mem.set({ ...rec, unreachable: reason, unreachableAt: this.now() });
    rep.unreachable!.push({ p: { x: p.x, y: p.y, z: p.z }, kind: rec.kind, reason });
  }

  private async doScan(cancelled: () => boolean, opts: ScanOptions): Promise<ScanReport> {
    const t0 = this.now();
    const r0 = this.requests();
    const rep: ScanReport = { ok: false, found: 0, read: [], fresh: 0, forgotten: 0, failed: [], requests: 0, ms: 0, radius: this.radius(), unreachable: [], pending: [] };
    const finish = (reason?: string): ScanReport => {
      rep.ok = reason === undefined;
      if (reason) rep.reason = reason;
      rep.requests = this.requests() - r0;
      rep.ms = this.now() - t0;
      this.lastScan = rep;
      const probed = rep.walk !== undefined ? `, ${rep.reachable} reachable within ${rep.walk} path blocks (${rep.probes} probes in ${((rep.probeMs ?? 0) / 1000).toFixed(1)} s)` : '';
      this.log.info(
        `chests: scan ${rep.ok ? 'done' : `ended (${reason})`}: ${rep.found} found${probed}, ${rep.read.length} read, ${rep.pending!.length} pending, ${rep.unreachable!.length} unreachable, ${rep.fresh} fresh, ${rep.forgotten} forgotten, ${rep.failed.length} failed in ${(rep.ms / 1000).toFixed(1)} s`,
      );
      return rep;
    };
    const home = this.d.home();
    if (!home) return finish('no_home');
    if (cancelled()) return finish('interrupted');
    const radius = rep.radius!;
    const mem = this.d.memory();
    const found = findContainers(this.d.world, home, radius);
    rep.found = found.length;
    const at = new Set(found.map((f) => chestKey(f.p)));
    // forget remembered containers whose (loaded) block is no container any more
    for (const r of mem.near(centre(home), radius + 1)) {
      if (at.has(chestKey(r))) continue;
      const b = this.d.world.blockAt(r);
      if (b && b.name !== 'unknown' && !isHomeContainer(b.name)) {
        mem.delete(r);
        rep.forgotten++;
      }
    }
    let partners = partnerKeys(mem.all());
    for (const f of found) if (!mem.get(f.p) && !partners.has(chestKey(f.p))) mem.set(unreadRecord(f.p, f.kind));
    const now = this.now();
    const wanted = opts.only ? new Set(opts.only.map(chestKey)) : undefined;
    const todo = found.filter((f) => {
      if (wanted && !wanted.has(chestKey(f.p))) return false;
      if (partners.has(chestKey(f.p))) return false; // the other half of a remembered double chest
      const rec = mem.get(f.p);
      if (!opts.force && rec && rec.readAt > 0 && now - rec.readAt < READ_FRESH_MS && !rec.unreachable) {
        rep.fresh++;
        return false;
      }
      if (!opts.retry && rec?.unreachable && now - (rec.unreachableAt ?? 0) < UNREACHABLE_RETRY_MS) {
        rep.unreachable!.push({ p: f.p, kind: rec.kind, reason: rec.unreachable });
        return false;
      }
      return true;
    });
    // Track AN: walking distance. Probe every candidate first (plans only), then read the nearest ones.
    const walk = this.walkLimit();
    let reach: { f: (typeof todo)[number]; blocks: number }[] = todo.map((f) => ({ f, blocks: 0 }));
    if (walk > 0 && this.d.probe && todo.length > 0) {
      const pos = this.d.position();
      const from = pos && this.atHome() ? pos : { x: Math.floor(home.x) + 0.5, y: home.y, z: Math.floor(home.z) + 0.5 };
      const p0 = this.now();
      const out: typeof reach = [];
      let probes = 0;
      let blind = false;
      for (const f of todo) {
        if (cancelled()) return finish('interrupted');
        const r = await this.d.probe(chestGoal(f.p), from);
        const st0 = standOf(r);
        if (st0) this.stands.set(chestKey(f.p), st0);
        if (!r) {
          blind = true; // no standable start: nothing to say about any container
          break;
        }
        probes++;
        const v = verdict(r, walk);
        if (!v.ok) {
          this.markUnreachable(f.p, f.kind, v.reason, rep);
          continue;
        }
        const rec = mem.get(f.p);
        if (rec?.unreachable) mem.set(reachableAgain(rec));
        out.push({ f, blocks: v.blocks });
      }
      rep.probes = probes;
      rep.probeMs = this.now() - p0;
      if (blind) {
        this.log.info(`chests: no standable start at ${fmtPos({ x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) })} for the probes: radius only`);
      } else {
        rep.walk = walk;
        rep.reachable = out.length;
        reach = out.sort((a, b) => a.blocks - b.blocks);
        this.log.info(`chests: probed ${probes} containers in ${((rep.probeMs ?? 0) / 1000).toFixed(1)} s (${probes ? ((rep.probeMs ?? 0) / probes).toFixed(1) : 0} ms each): ${out.length} within ${walk} path blocks, ${rep.unreachable!.length} unreachable`);
      }
    }
    // the nearest MAX_READS_PER_SCAN by path length (straight line without probes), visited nearest-neighbour
    const take = reach.slice(0, MAX_READS_PER_SCAN).map((x) => x.f);
    const blocksOf = new Map(reach.map((x) => [chestKey(x.f.p), x.blocks]));
    rep.pending = reach.slice(MAX_READS_PER_SCAN).map((x) => ({ ...x.f.p }));
    // Visit order: at every step the walking-aware cost (height, path-length band from home: another room)
    // shortlists the NEXT_PROBES nearest remaining containers, a probe plan from where the bot stands measures
    // each one's real path, and the shortest path wins (a wall or a floor between two "close" chests no longer
    // fools the order). Without a probe, the cheap cost alone decides.
    const remaining = [...take];
    let here = this.d.position() ?? centre(home);
    while (remaining.length > 0) {
      if (cancelled()) return finish('interrupted');
      // the other half of a double chest read in this scan
      partners = partnerKeys(mem.all());
      const ranked = visitOrderBanded(remaining.filter((f) => !partners.has(chestKey(f.p))), here, (f) => blocksOf.get(chestKey(f.p)) ?? 0);
      if (ranked.length === 0) break;
      let f = ranked[0]!;
      if (this.d.probe && walk > 0 && ranked.length > 1) { // homeChestWalk 0: radius only, no probes at all
        let best = Infinity;
        for (const c of ranked.slice(0, NEXT_PROBES)) {
          const r = await this.d.probe(chestGoal(c.p), here);
          const st1 = standOf(r);
          if (st1) this.stands.set(chestKey(c.p), st1);
          const pv = r ? verdict(r, 0) : undefined;
          if (pv?.ok && pv.blocks < best) {
            best = pv.blocks;
            f = c;
          }
        }
      }
      remaining.splice(remaining.indexOf(f), 1);
      const v = await this.visit(f.p, f.kind, cancelled);
      here = this.d.position() ?? centre(f.p);
      if (!v.ok) {
        if (v.reason === 'interrupted') return finish('interrupted');
        this.log.info(`chests: ${f.kind} at ${fmtPos(f.p)}: ${v.reason}`);
        if (v.reason.startsWith('goto:')) this.markUnreachable(f.p, f.kind, v.reason, rep);
        else rep.failed.push({ p: f.p, reason: v.reason });
        continue;
      }
      await this.d.skills.closeContainer(v.view);
      rep.read.push(v.record);
    }
    return finish();
  }

  // ---- unload ------------------------------------------------------------------------------------

  private async doUnload(cancelled: () => boolean, opts: { all?: boolean }): Promise<UnloadReport> {
    const t0 = this.now();
    const r0 = this.requests();
    const rep: UnloadReport = { ok: false, moved: [], kept: [], left: [], boxes: 0, emptied: 0, chests: 0, requests: 0, shared: 0, ms: 0, boxed: [], filled: [], emptiedNamed: 0, namedKept: 0, blocked: [] };
    let finish = (reason?: string): UnloadReport => {
      const plan = this.plan(opts.all, undefined, { on: false });
      rep.kept = plan.kept.filter((k) => k.why !== 'named_box');
      rep.namedKept = plan.kept.filter((k) => k.why === 'named_box').reduce((a, k) => a + k.count, 0); // Track AV
      rep.keepName = this.keepName();
      rep.left = [];
      for (const o of plan.overflow) {
        const l = rep.left.find((x) => x.name === o.name);
        if (l) l.count += o.count;
        else rep.left.push({ name: o.name, count: o.count });
      }
      // Track AV: why a kind was left (its chest could not be boxed), from a plan with boxing on
      const why = this.plan(opts.all, undefined, { on: true }).blocked;
      rep.blocked = why.filter((b) => rep.left.some((l) => l.name === b.item));
      rep.ok = reason === undefined;
      if (reason) rep.reason = reason;
      rep.shared = this.requests() - r0;
      rep.ms = this.now() - t0;
      this.lastUnload = rep;
      this.log.info(`unload: ${unloadLine(rep)} (${rep.requests} requests, ${rep.shared} on the shared Containers, ${(rep.ms / 1000).toFixed(1)} s)`);
      return rep;
    };
    if (!this.d.home()) return finish('no_home');
    if (this.records().filter((r) => r.readAt > 0).length === 0) return finish('no_chests');
    if (cancelled()) return finish('interrupted');
    // Track AV: the named boxes holding items now; those empty at the end were emptied
    const namedFull = () => carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.()).filter((b) => b.named && !b.flightKit && b.used > 0).length;
    const fullBefore = namedFull();
    const finishAll = finish;
    finish = (reason?: string): UnloadReport => {
      rep.emptiedNamed = Math.max(0, fullBefore - namedFull());
      return finishAll(reason);
    };
    {
      if (opts.all) {
        const r = await this.emptyFullBoxes(rep, cancelled);
        if (r) return finish(r);
      }
      // Track AV/AW: the compact list (crafting into blocks) first, through the installed runner, if any
      // (Track AW's runner must not re-enter HomeLogistics: this job holds its serial lock)
      const runner = compactRunner;
      if (runner) {
        const list = this.plan(opts.all).compact;
        if (list?.length) {
          try {
            const frag = await runner(list, cancelled);
            if (frag) rep.compacted = frag;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.log.warn(`unload: compact: ${msg}`);
            rep.compacted = `compact failed: ${msg}`;
          }
          if (cancelled()) return finish('interrupted');
        }
      }
      const failed = new Set<string>();
      // Track AV: fill and box steps first; a failed step's kind is planned without that kind of step afterwards
      const skip = new Set<string>();
      const skipFill = new Set<string>();
      let steps = 0;
      let fills = 0;
      let lastBox = false;
      // a fill the inventory has too little room for is put off once: the other items go first (its kind is held back)
      const deferFill = new Set<string>();
      let deferred = false;
      // what an interrupted box step left in the inventory goes back first
      if ((await this.settleDebts(rep, cancelled)) === 'interrupted') return finish('interrupted');
      for (let pass = 0; pass < MAX_UNLOAD_PASSES; pass++) {
        for (let round = 0; round < 40; round++) {
          if (cancelled()) return finish('interrupted');
          const plan = this.plan(opts.all, undefined, { on: steps < MAX_BOX_STEPS, fill: fills < MAX_FILL_STEPS, skip, skipFill: new Set([...skipFill, ...deferFill]), hold: deferFill });
          const step = plan.steps[0];
          if (step?.kind === 'fill') {
            const r = await this.fillStep(step, rep, cancelled, opts.all ?? false);
            if (r === 'interrupted') return finish('interrupted');
            if (r.startsWith('defer: ')) {
              this.log.info(`unload: fill a box of ${step.item}: ${r.slice(7)}${deferred ? '' : ' (after the other items)'}`);
              (deferred ? skipFill : deferFill).add(step.item);
              continue;
            }
            fills++;
            if (r !== 'ok') {
              this.log.info(`unload: fill a box of ${step.item}: ${r}`);
              skipFill.add(step.item);
            }
            continue;
          }
          if (step?.kind === 'box') {
            steps++;
            const r = await this.boxStep(step, rep, cancelled);
            if (r === 'interrupted') return finish('interrupted');
            if (r !== 'ok') {
              this.log.info(`unload: box ${step.item}: ${r}`);
              skip.add(step.item);
            }
            continue;
          }
          const targets = new Map<string, Vec3>();
          for (const m of plan.moves) if (!failed.has(m.to)) targets.set(m.to, planChests(this.records()).find((c) => c.key === m.to)!.pos);
          if (targets.size === 0) {
            if (deferFill.size === 0) break;
            // the other items are away: the put-off fills get their turn with the emptier inventory
            deferFill.clear();
            deferred = true;
            continue;
          }
          const here = this.d.position() ?? centre(this.d.home()!);
          const [next] = visitOrder([...targets].map(([key, p]) => ({ key, p })), here);
          const r = await this.depositAt(next!.p, rep, cancelled, opts.all ?? false, skip, deferFill);
          if (r === 'interrupted') return finish('interrupted');
          if (r !== 'ok') failed.add(next!.key);
        }
        if (lastBox) break;
        // Track AV: the named boxes' items next (with `all`, every full box's but the fireworks box's); they are unloaded in the next pass
        const e = await this.emptyNextBox(opts.all ?? false, rep, cancelled);
        if (e === 'interrupted') return finish('interrupted');
        if (e !== 'ok') {
          if (e !== 'none') this.log.info(`unload: emptying a box: ${e}`);
          // the box's items are in the inventory already (only its pickup failed): one more pass unloads them, no further box
          if (!e.startsWith('the box was not picked up')) break;
          lastBox = true;
        }
      }
      await this.boxes.fetchLeft(cancelled);
      if (cancelled()) return finish('interrupted');
      // overflow: spare shulker boxes from the box chest (a failed fill's or box step's kind included)
      for (let n = 0; n < MAX_BOXES_PER_RUN; n++) {
        if (cancelled()) return finish('interrupted');
        const plan = this.plan(opts.all, undefined, { skip, skipFill });
        if (!plan.overflow.some((o) => !isShulkerBox(o.name))) break;
        const r = await this.viaSpareBox(rep, cancelled, opts.all ?? false);
        if (r === 'interrupted') return finish('interrupted');
        if (r !== 'ok') {
          this.log.info(`unload: spare shulker box: ${r}`);
          break;
        }
      }
      // tidy: the home chests' own full boxes' worth, after the bot's items
      const t = await this.tidySteps(rep, cancelled, skip);
      if (t === 'interrupted') return finish('interrupted');
      return finish();
    }
  }

  private addMoved(rep: UnloadReport, moved: Record<string, number>, to: string): void {
    for (const [name, count] of Object.entries(moved)) {
      const l = rep.moved.find((x) => x.name === name && x.to === to);
      if (l) l.count += count;
      else rep.moved.push({ name, count, to });
    }
  }

  /** One chest trip: walk, open (refresh), plan for this chest with what it holds, deposit, refresh, close. */
  private async depositAt(p: Vec3, rep: UnloadReport, cancelled: () => boolean, all: boolean, skip?: ReadonlySet<string>, hold?: ReadonlySet<string>): Promise<string> {
    const rec = this.d.memory().get(p);
    const v = await this.visit(p, rec?.kind ?? 'chest', cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const key = chestKey(p);
      const plan = this.plan(all, undefined, { on: false, ...(skip ? { skip } : {}), ...(hold ? { hold } : {}) });
      const moves = plan.moves.filter((m) => m.to === key).map((m) => ({ slot: m.slot, count: m.count, name: m.name }));
      if (moves.length === 0) return 'nothing_fits';
      const r = await this.d.skills.depositSlots(v.view, moves);
      rep.requests += r.requests;
      this.addMoved(rep, r.moved, chestName(this.remember(p, v.record.kind, v.view)));
      if (cancelled()) return 'interrupted';
      return r.total > 0 ? 'ok' : (r.reason ?? 'nothing_moved');
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
  }

  /** The nearest read container holding an empty shulker box (not a box block itself). */
  private boxChest(): ChestRecord | undefined {
    const here = this.d.position();
    const list = this.records().filter((r) => r.readAt > 0 && r.boxes.empty > 0 && !isShulkerBox(r.kind));
    if (here) list.sort((a, b) => Math.hypot(a.x - here.x, a.z - here.z) - Math.hypot(b.x - here.x, b.z - here.z));
    return list[0];
  }


  /** Make a hotbar slot free while a window is open (a placed box must come from the hotbar). */
  private async freeHotbarSlot(): Promise<void> {
    const inv = this.d.inventory.slots;
    if (inv.slice(0, 9).some((s) => !s || s.count <= 0)) return;
    const c = this.d.containers;
    if (!c?.move) return;
    const main = this.boxes.freeSlots().filter((i) => i >= 9);
    if (main.length < 2) return; // one for the stack moved out, one for the box
    const plan = this.plan(false, undefined, { on: false }); // without the steps: a stack a fill or box step takes is movable too
    const movable = new Set(plan.moves.map((m) => m.slot).concat(plan.overflow.map((o) => o.slot)));
    const h = [...Array(9).keys()].find((i) => movable.has(i) && !isShulkerBox(inv[i]?.name ?? ''));
    if (h === undefined) return;
    await c.move({ window: 0, slot: h }, { window: 0, slot: main[0]! }, inv[h]!.count);
  }

  /** Take an empty box from the box chest, fill it next to the bot, break it, pick it up, store it. */
  private async viaSpareBox(rep: UnloadReport, cancelled: () => boolean, all: boolean): Promise<string> {
    const from = this.boxChest();
    if (!from) return 'no empty shulker box in any chest';
    if (this.boxes.freeSlots().length === 0) return 'no free inventory slot for a box';
    // (the caller saw overflow with the box chest as it is; after the take its freed slot is kept for
    // the full box, so the box gets the same overflow)
    // 1. take one empty box
    const v = await this.visit(from, from.kind, cancelled);
    if (!v.ok) return v.reason;
    let boxSlot: number | undefined;
    try {
      const slot = v.view.slots.findIndex((s, i) => !!s && isShulkerBox(s.name) && this.d.inventory.rawItem?.(v.view.id, i) !== undefined && shulkerSlotsUsed(this.d.inventory.rawItem?.(v.view.id, i)) === 0 && !isKeptBox(s.name, this.d.inventory.rawItem?.(v.view.id, i), this.keepName())); // Track AV: never a named box
      if (slot < 0) {
        this.remember(from, v.record.kind, v.view);
        return 'the box chest holds no empty box any more';
      }
      await this.freeHotbarSlot();
      // the last free hotbar slot: the survival keeper restocks throwaway blocks into the first ones
      const t = await this.d.skills.take(v.view, slot, 1, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
      if (t.moved > 0) rep.requests++;
      this.remember(from, v.record.kind, v.view);
      if (!t.ok || t.to === undefined) return `take: ${t.reason ?? 'failed'}`;
      boxSlot = t.to;
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
    if (cancelled()) return 'interrupted';
    // 2.-4. placed next to the bot, filled with what fits nowhere else, broken and picked up again, also after a failed
    // open (supply/boxes.ts putIn). The box chest's slot the box came from is kept for the full box.
    const put = await this.boxes.putIn(
      boxSlot,
      () => this.plan(all, chestKey(from), { on: false }).overflow.filter((x) => !isShulkerBox(x.name)).map((x) => ({ slot: x.slot, count: x.count, name: x.name })),
      rep,
      cancelled,
      { onMoved: (r) => this.addMoved(rep, r.moved, `shulker box (into ${chestName(from)})`) },
    );
    if ('reason' in put) return put.reason;
    if (typeof put.back === 'string') return put.back === 'interrupted' ? put.back : `the box was left on the ground${put.moved > 0 ? '' : ' unfilled'}: ${put.back}`;
    if (cancelled()) return 'interrupted';
    const full = put.back;
    if (shulkerSlotsUsed(this.d.inventory.rawItem?.(0, full)) === 0) return 'the box was not filled';
    // 5. store the full box in the box chest (or the emptiest chest with a free slot)
    const store = this.memoryTargetForBox(from);
    if (!store) return 'no chest with a free slot for the full box';
    const w = await this.visit(store, store.kind, cancelled);
    if (!w.ok) return w.reason;
    rep.chests++;
    try {
      const r = await this.d.skills.depositSlots(w.view, [{ slot: full, count: 1 }]);
      rep.requests += r.requests;
      this.remember(store, w.record.kind, w.view);
      if (r.total <= 0) return `storing the full box: ${r.reason ?? 'failed'}`;
      rep.boxes++;
      return 'ok';
    } finally {
      await this.d.skills.closeContainer(w.view);
    }
  }

  private memoryTargetForBox(from: ChestRecord): ChestRecord | undefined {
    const fresh = this.d.memory().get(from);
    if (fresh && fresh.free > 0) return fresh;
    const list = this.records().filter((r) => r.readAt > 0 && r.free > 0 && !isShulkerBox(r.kind) && !partnerKeys(this.records()).has(chestKey(r)));
    list.sort((a, b) => b.free - a.free);
    return list[0];
  }

  /** `all`: empty the full boxes carried into the inventory (place, open, take, break, pick up). Returns a reason to stop. Track AV: not the named ones (emptied anyway, kept) and not the fireworks box. */
  private async emptyFullBoxes(rep: UnloadReport, cancelled: () => boolean): Promise<string | undefined> {
    for (let n = 0; n < MAX_BOXES_PER_RUN; n++) {
      if (cancelled()) return 'interrupted';
      const full = carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.()).find((b) => b.used > 0 && !b.named && !b.flightKit)?.slot;
      if (full === undefined) return undefined;
      if (this.boxes.freeSlots().length < 2) return undefined; // nothing to take the items into: unload first
      const r = await this.boxes.takeOut(full, rep, cancelled);
      if (r === 'interrupted') return 'interrupted';
      if (r === 'emptied') rep.emptied++;
      else return undefined; // partly: the deposit passes make room, then emptyNextBox comes back for the rest
    }
    return undefined;
  }

  // ---- Track AV: named boxes, box steps ----------------------------------------------------------

  /**
   * Empty one carried box holding items into the inventory: a named (bot_loot) one, with `all` any unnamed one too
   * (never the fireworks box): 'ok', 'none' (no such box), or why not. The items are unloaded in the next pass, which
   * comes back here for the next box.
   */
  private async emptyNextBox(all: boolean, rep: UnloadReport, cancelled: () => boolean): Promise<string> {
    const box = carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.()).find((b) => !b.flightKit && b.used > 0 && (b.named || all));
    if (!box) return 'none';
    if (this.boxes.freeSlots().length < 2) return 'no free inventory slot for its items';
    const r = await this.boxes.takeOut(box.slot, rep, cancelled);
    if (r === 'emptied' && !box.named) rep.emptied++; // the named ones are counted by emptiedNamed
    return r.startsWith('emptied') ? 'ok' : r;
  }

  /** While a window is open: move the box of `slot` (main inventory) into a free hotbar slot; its slot after that. */
  private async hotbarWhileOpen(slot: number): Promise<number> {
    if (slot < 9 || placesExactly(this.d.inventory.slots, slot)) return slot;
    const c = this.d.containers;
    if (!c?.move) return slot;
    const empty = () => [...Array(9).keys()].find((i) => (this.d.inventory.slots[i]?.count ?? 0) <= 0);
    if (empty() === undefined) await this.freeHotbarSlot();
    const to = empty();
    if (to === undefined) return slot;
    const r = await c.move({ window: 0, slot }, { window: 0, slot: to }, 1);
    return r.ok ? to : slot;
  }

  /** A box the place skill would not pick by itself: open the nearest known chest and move it into the hotbar meanwhile. */
  private async boxToHotbar(slot: number, cancelled: () => boolean): Promise<number | string> {
    if (placesExactly(this.d.inventory.slots, slot)) return slot;
    const here = this.d.position();
    const near = planChests(this.records()).sort((a, b) => (here ? Math.hypot(a.pos.x - here.x, a.pos.z - here.z) - Math.hypot(b.pos.x - here.x, b.pos.z - here.z) : 0))[0];
    if (!near) return 'the box is not in the hotbar';
    const v = await this.visit(near.pos, near.kind, cancelled);
    if (!v.ok) return v.reason;
    try {
      const to = await this.hotbarWhileOpen(slot);
      return placesExactly(this.d.inventory.slots, to) ? to : 'the box is not in the hotbar';
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
  }

  /** A carried spare: unnamed, empty, not the flight kit's, not the one kept for the stash step (no named box carried: the lowest slot). */
  private carriedSpare(): number | undefined {
    const boxes = carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.());
    const spares = carriedSpares(boxes).sort((a, b) => a.slot - b.slot);
    const usable = boxes.some((b) => b.named && !b.flightKit) ? spares : spares.slice(1);
    return usable.at(-1)?.slot;
  }

  /** Take one empty unnamed box out of the chest at `from` into a free hotbar slot: its inventory slot, or why not. */
  private async takeSpare(from: { pos: Vec3; kind: string }, rep: UnloadReport, cancelled: () => boolean): Promise<number | string> {
    if (this.boxes.freeSlots().length === 0) return 'no free inventory slot for a box';
    const v = await this.visit(from.pos, from.kind, cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const keep = this.keepName();
      const raw = (i: number) => this.d.inventory.rawItem?.(v.view.id, i);
      const slot = v.view.slots.findIndex((s, i) => !!s && isShulkerBox(s.name) && raw(i) !== undefined && shulkerSlotsUsed(raw(i)) === 0 && !isKeptBox(s.name, raw(i), keep)); // a box without its wire item is no spare
      if (slot < 0) {
        const rec = this.remember(from.pos, v.record.kind, v.view);
        if (rec.boxes.empty > 0) this.spareRefused.set(chestKey(from.pos), rec.readAt); // counted, but none usable
        return 'the chest holds no empty box any more';
      }
      await this.freeHotbarSlot();
      const t = await this.d.skills.take(v.view, slot, 1, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
      if (t.moved > 0) rep.requests++;
      this.remember(from.pos, v.record.kind, v.view);
      if (!t.ok || t.to === undefined) return `take: ${t.reason ?? 'failed'}`;
      if (this.boxes.namedAt(t.to)) return 'took a bot_loot box for a spare'; // never: the take refuses named boxes
      return t.to;
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
  }

  /** The (slot, count) pairs of `item` for a box: at most `stacks` slots, fullest first, the throwaway reserve held back. */
  private boxMoves(item: string, stacks: number, hold: number, fullOnly = false): { slot: number; count: number; name: string }[] {
    const slots = this.slots();
    const have = slots.filter((s) => s.name === item && (!fullOnly || s.count >= maxStackOf(item)));
    let allowed = have.reduce((a, s) => a + s.count, 0) - hold;
    const out: { slot: number; count: number; name: string }[] = [];
    for (const s of [...have].sort((a, b) => b.count - a.count || a.slot - b.slot)) {
      if (out.length >= stacks || allowed <= 0) break;
      const n = Math.min(s.count, allowed);
      out.push({ slot: s.slot, count: n, name: item });
      allowed -= n;
    }
    return out;
  }

  /**
   * One `box` step: a spare box (carried, else out of `step.spare`), then in rounds: at the target chest its
   * loose stacks of the item into the inventory (as many as the box and the inventory take), the box placed
   * next to the bot, filled with the item's stacks, broken and picked up; the full box into the chest.
   * The reserve held back is the bot's own at the start (the chest's stacks never become the reserve). A tidy
   * step takes and boxes full stacks only, and none at all when the chest holds fewer than the box lacks.
   */
  private async boxStep(step: Extract<UnloadStep, { kind: 'box' }>, rep: UnloadReport, cancelled: () => boolean): Promise<string> {
    const before = this.looseCount(step.item);
    this.stepBox = undefined;
    const r = await this.boxStepRun(step, rep, cancelled);
    if (r === 'ok') return r;
    // what it took out of the chest (a tidy step: the loose stacks too) and a partly filled box go back into that chest
    const debt: Debt = { chest: step.chest, item: step.item, loose: step.tidy ? Math.max(0, this.looseCount(step.item) - before) : 0, box: this.stepBox };
    if (r === 'interrupted') {
      this.debts.push(debt);
      return r;
    }
    const back = await this.settle(debt, rep, cancelled);
    if (back !== 'ok') this.log.info(`unload: box ${step.item}: ${r}; putting it back into ${step.chest}: ${back}`);
    return r;
  }

  /** The box a running box step fills (its inventory slot), for the put-back after a failure. */
  private stepBox: number | undefined;
  /** What interrupted box steps left in the inventory: put back at the start of the next run. */
  private readonly debts: Debt[] = [];

  /** The debts of interrupted box steps first: 'ok', or 'interrupted'. */
  private async settleDebts(rep: { chests: number; requests: number }, cancelled: () => boolean): Promise<string> {
    await this.boxes.recover(cancelled); // Track BJ: a box left standing too
    while (this.debts.length > 0) {
      if (cancelled()) return 'interrupted';
      const d = this.debts.shift()!;
      const r = await this.settle(d, rep, cancelled);
      if (r === 'interrupted') {
        this.debts.unshift(d);
        return r;
      }
      if (r !== 'ok') this.log.info(`unload: putting ${d.item} back into ${d.chest}: ${r}`);
    }
    return 'ok';
  }

  /**
   * Put back what a failed box step took: `loose` items of `item` (fullest stacks first) and the partly filled box
   * (an unnamed box holding only `item`, in slot `box` or, the slot moved, any such box) into the chest `chest`.
   */
  private async settle(d: Debt, rep: { chests: number; requests: number }, cancelled: () => boolean): Promise<string> {
    const only = (i: number) => {
      const st = this.d.inventory.slots[i];
      if (!st || !isShulkerBox(st.name) || this.boxes.namedAt(i)) return false;
      const c = shulkerContents(this.d.inventory.rawItem?.(0, i));
      const k = Object.keys(c);
      if (d.contents) return k.length === Object.keys(d.contents).length && k.every((x) => c[x] === d.contents![x]);
      return k.length === 1 && k[0] === d.item;
    };
    const box = d.box !== undefined && only(d.box) ? d.box : d.box !== undefined || d.contents ? [...this.boxes.boxKeys()].find(only) : undefined;
    const moves: { slot: number; count: number; name?: string }[] = [];
    let left = Math.min(d.loose, this.looseCount(d.item));
    for (const s of this.slots().filter((x) => x.name === d.item).sort((a, b) => b.count - a.count || a.slot - b.slot)) {
      if (left <= 0) break;
      const n = Math.min(s.count, left);
      moves.push({ slot: s.slot, count: n, name: d.item });
      left -= n;
    }
    if (box !== undefined) moves.push({ slot: box, count: 1 });
    if (moves.length === 0) return 'ok';
    const c = planChests(this.records()).find((x) => x.key === d.chest);
    if (!c) return 'the chest is not known any more';
    const v = await this.visit(c.pos, c.kind, cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const r = await this.d.skills.depositSlots(v.view, moves);
      rep.requests += r.requests;
      this.remember(c.pos, v.record.kind, v.view);
      return r.reason === undefined || r.ok ? 'ok' : r.reason;
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
  }

  private async boxStepRun(step: Extract<UnloadStep, { kind: 'box' }>, rep: UnloadReport, cancelled: () => boolean): Promise<string> {
    const t0 = this.now();
    const hold = this.holdOf(step.item); // Track BJ: the crop and seed reserve too
    const fullOnly = step.tidy === true;
    const target = planChests(this.records()).find((c) => c.key === step.chest);
    if (!target) return 'the chest is not known any more';
    // 1. the spare box
    let box = step.spare === 'carried' ? this.carriedSpare() : undefined;
    let from = 'my inventory';
    if (box === undefined) {
      const src = planChests(this.records()).find((c) => c.key === step.spare && c.boxes.empty > 0) ?? (() => {
        const b = this.boxChest();
        return b ? { pos: { x: b.x, y: b.y, z: b.z }, kind: b.kind } : undefined;
      })();
      if (!src) return 'no spare shulker box';
      const r = await this.takeSpare(src, rep, cancelled);
      if (typeof r === 'string') return r;
      box = r;
      from = chestName(this.d.memory().get(src.pos) ?? unreadRecord(src.pos, src.kind));
    }
    this.stepBox = box;
    // 2. rounds: the chest's loose stacks out, the box filled next to it
    let took = 0;
    let rounds = 0;
    for (let round = 0; round < 4; round++) {
      if (cancelled()) return 'interrupted';
      const need = BOX_SLOTS - shulkerSlotsUsed(this.d.inventory.rawItem?.(0, box));
      if (need <= 0) break;
      const v = await this.visit(target.pos, target.kind, cancelled);
      if (!v.ok) return v.reason;
      rep.chests++;
      const room = this.boxes.freeSlots().length;
      let got = 0;
      try {
        const loose = v.view.slots
          .map((st, i) => ({ st, i }))
          .filter((x) => !!x.st && x.st.count > 0 && x.st.name === step.item && (!fullOnly || x.st.count >= maxStackOf(step.item)))
          .sort((a, b) => b.st!.count - a.st!.count || a.i - b.i);
        if (fullOnly && loose.length < need) {
          this.remember(target.pos, v.record.kind, v.view);
          return `the chest holds ${loose.length} full stacks of ${step.item}, the box lacks ${need}`;
        }
        for (const { i } of loose.slice(0, Math.min(need, room))) {
          if (cancelled()) break;
          const t = await this.d.skills.take(v.view, i);
          if (t.moved > 0) {
            rep.requests++;
            got++;
          }
          if (!t.ok) break;
        }
        box = await this.hotbarWhileOpen(box);
        this.stepBox = box;
        this.remember(target.pos, v.record.kind, v.view);
      } finally {
        await this.d.skills.closeContainer(v.view);
      }
      took += got;
      if (cancelled()) return 'interrupted';
      if (this.boxMoves(step.item, need, hold, fullOnly).length === 0) break;
      // filled next to the bot, broken and picked up again also after a cancel (never left standing; supply/boxes.ts)
      const put = await this.boxes.putIn(
        box,
        (view) => {
          const left = BOX_SLOTS - (this.d.skills.snapshot(view)?.stacks ?? 0);
          return left > 0 ? this.boxMoves(step.item, left, hold, fullOnly) : [];
        },
        rep,
        cancelled,
      );
      if ('reason' in put) return put.reason;
      rounds++;
      if (typeof put.back === 'string') return put.back;
      box = put.back;
      this.stepBox = box;
      if (cancelled()) return 'interrupted';
      if (put.moved === 0) return put.open === undefined ? 'the box took nothing' : `open: ${put.open}`;
      // another round only when the inventory's room, not the chest, limited the take
      if (got < room || got === 0) break;
    }
    // 3. the full box into the chest
    const used = shulkerSlotsUsed(this.d.inventory.rawItem?.(0, box));
    if (used === 0) return 'the box stayed empty';
    const w = await this.visit(target.pos, target.kind, cancelled);
    if (!w.ok) return w.reason;
    rep.chests++;
    try {
      const r = await this.d.skills.depositSlots(w.view, [{ slot: box, count: 1 }]);
      rep.requests += r.requests;
      const rec = this.remember(target.pos, w.record.kind, w.view);
      if (r.total <= 0) return `storing the box: ${r.reason ?? 'failed'}`;
      (rep.boxed ??= []).push({ item: step.item, stacks: used, chest: chestName(rec), from, took, rounds, ms: this.now() - t0 });
      this.log.info(`unload: boxed ${used} stacks of ${step.item} (${took} out of ${chestName(rec)}, ${rounds} round${rounds === 1 ? '' : 's'}) into a shulker box from ${from}, stored in ${chestName(rec)} (${((this.now() - t0) / 1000).toFixed(1)} s)`);
      return 'ok';
    } finally {
      await this.d.skills.closeContainer(w.view);
    }
  }

  // ---- tidy: the home chests' own full boxes' worth ----------------------------------------------

  /**
   * Tidy steps (MAX_TIDY_STEPS at most; the planner stops when no spare is left): 'ok', or 'interrupted'. A failed
   * step's kind is not tidied again in this run; what it left in the inventory goes back into the chests.
   */
  private async tidySteps(rep: UnloadReport, cancelled: () => boolean, skip: Set<string>): Promise<string> {
    for (let n = 0; n < MAX_TIDY_STEPS; n++) {
      if (cancelled()) return 'interrupted';
      const step = this.plan(false, undefined, { tidy: true, skip }).steps.find((x) => x.kind === 'box');
      if (step?.kind !== 'box') break;
      const r = await this.boxStep(step, rep, cancelled); // a failure puts back what it took (boxStep)
      if (r === 'interrupted') return r;
      if (r !== 'ok') {
        this.log.info(`unload: tidy ${step.item} in ${step.chest}: ${r}`);
        skip.add(step.item);
        // not again until that chest is read anew (the chore would retry it every 10 minutes)
        const [x, y, z] = step.chest.split(',').map(Number);
        const at = this.d.memory().get({ x: x!, y: y!, z: z! })?.readAt;
        if (at !== undefined) this.tidyFailed.set(`${step.chest}|${step.item}`, at);
        await this.boxes.fetchLeft(cancelled);
      }
    }
    await this.boxes.fetchLeft(cancelled);
    return cancelled() ? 'interrupted' : 'ok';
  }

  private async doTidy(cancelled: () => boolean): Promise<UnloadReport> {
    const t0 = this.now();
    const r0 = this.requests();
    const rep: UnloadReport = { ok: false, moved: [], kept: [], left: [], boxes: 0, emptied: 0, chests: 0, requests: 0, shared: 0, ms: 0, boxed: [], filled: [] };
    const settled = this.d.home() ? await this.settleDebts(rep, cancelled) : 'no_home';
    const r = settled === 'ok' ? await this.tidySteps(rep, cancelled, new Set()) : settled;
    rep.ok = r === 'ok';
    if (r !== 'ok') rep.reason = r;
    rep.shared = this.requests() - r0;
    rep.ms = this.now() - t0;
    this.log.info(`tidy: ${rep.boxed?.length ? unloadLine(rep) : 'nothing boxed'}${rep.reason ? ` (${rep.reason})` : ''}`);
    return rep;
  }

  // ---- fill steps: full boxes out of what the bot carries ---------------------------------------

  /** Items of `item` loose in the inventory. */
  private looseCount(item: string): number {
    return this.d.inventory.slots.slice(0, 36).reduce((a, s) => a + (s?.name === item ? s.count : 0), 0);
  }

  /** The (slot, count) pairs of `item` for the spare: `want` items at most, fullest stacks first, the throwaway reserve held back. */
  private fillMoves(item: string, want: number): { slot: number; count: number; name: string }[] {
    const slots = this.slots();
    const have = slots.filter((s) => s.name === item);
    let allowed = Math.min(want, have.reduce((a, s) => a + s.count, 0) - this.holdOf(item)); // Track BJ: the crop and seed reserve too
    const out: { slot: number; count: number; name: string }[] = [];
    for (const s of [...have].sort((a, b) => b.count - a.count || a.slot - b.slot)) {
      if (allowed <= 0) break;
      const n = Math.min(s.count, allowed);
      out.push({ slot: s.slot, count: n, name: item });
      allowed -= n;
    }
    return out;
  }

  /** The carried box to take `item` out of: a bot_loot box (with `all` any full one; never the fireworks box, never `spare`), the most of it first. */
  private fillSource(item: string, spare: number, all: boolean): number | undefined {
    const boxes = carriedBoxes(this.d.inventory, this.keepName(), this.d.flightBoxSlot?.()).filter((b) => b.slot !== spare && !b.flightKit && !b.unknown && b.used > 0 && (b.named || all) && (b.contents[item] ?? 0) > 0);
    return boxes.sort((a, b) => (b.contents[item] ?? 0) - (a.contents[item] ?? 0) || a.slot - b.slot)[0]?.slot;
  }

  /**
   * One `fill` step: a spare (carried, else out of `step.spare`), then rounds until it holds 27 full stacks of the item:
   * while the loose stacks (the reserve held back) do not cover what it lacks and a carried box holds more, that box is
   * placed and only that item taken out of it (two inventory slots stay free, as when emptying); else the spare is placed
   * next to the bot, filled, broken and picked up. Then the full box goes into `step.chest`. A failure before the store
   * takes the items back out of the spare (best effort: what stays in it makes it a full box like any other, stored in
   * the box chest or, with `all`, emptied); a spare that is not picked up again is walked to at once. A target found
   * full after all (an old memory) gets the box stored where the overflow's boxes go.
   */
  private async fillStep(step: Extract<UnloadStep, { kind: 'fill' }>, rep: UnloadReport, cancelled: () => boolean, all: boolean): Promise<string> {
    const t0 = this.now();
    const target = planChests(this.records()).find((c) => c.key === step.chest);
    if (!target) return 'the chest is not known any more';
    const max = maxStackOf(step.item);
    const full = BOX_SLOTS * max;
    // 0. can the rounds complete the box? a take keeps 2 slots free while the box stands (its own slot one of them):
    // (free - 1) stacks a take, then a fill; too little room: put off (the caller unloads the other items first)
    const free = this.boxes.freeSlots().length - (step.spare === 'carried' ? 0 : 1);
    const fromBoxes = full - this.fillMoves(step.item, full).reduce((a, m) => a + m.count, 0);
    if (fromBoxes > 0) {
      const per = (free - 1) * max;
      if (per <= 0 || 2 * Math.ceil(fromBoxes / per) + 1 > MAX_FILL_ROUNDS) return `defer: ${free} free inventory slots are too few to take ${fromBoxes} ${step.item} out of the boxes within ${MAX_FILL_ROUNDS} rounds`;
    }
    // 1. the spare box
    let box = step.spare === 'carried' ? this.carriedSpare() : undefined;
    let from = 'my inventory';
    if (box === undefined) {
      const src = planChests(this.records()).find((c) => c.key === step.spare && c.boxes.empty > 0) ?? (() => {
        const b = this.boxChest();
        return b ? { pos: { x: b.x, y: b.y, z: b.z }, kind: b.kind } : undefined;
      })();
      if (!src) return 'no spare shulker box';
      const r = await this.takeSpare(src, rep, cancelled);
      if (typeof r === 'string') return r;
      box = r;
      from = chestName(this.d.memory().get(src.pos) ?? unreadRecord(src.pos, src.kind));
    }
    let spare = box;
    const inBox = (): number => shulkerContents(this.d.inventory.rawItem?.(0, spare))[step.item] ?? 0;
    // a failure takes the items back out of the spare; what stays (no room) goes into the item's chest with the box,
    // never a partly filled box into the chest of spares
    const fail = async (why: string): Promise<string> => {
      if (why === 'interrupted' || cancelled() || shulkerSlotsUsed(this.d.inventory.rawItem?.(0, spare)) === 0) return why;
      const r = await this.boxes.takeOut(spare, rep, cancelled);
      this.log.info(`unload: fill a box of ${step.item}: ${why}; its items taken back out of the spare: ${r}`);
      if (r === 'interrupted') return r;
      const still = [...this.boxes.boxKeys()].find((i) => !this.boxes.namedAt(i) && Object.keys(shulkerContents(this.d.inventory.rawItem?.(0, i))).join() === step.item);
      if (still !== undefined && r !== 'emptied') {
        const st = await this.storeBox(target.pos, target.kind, still, cancelled, rep);
        if (typeof st === 'string') this.log.info(`unload: fill a box of ${step.item}: the partly filled box into ${step.chest}: ${st}`);
      }
      return why;
    };
    // the reserve of a throwaway kind may grow as items come out of the boxes: take that much more
    const r0 = this.reserve() ?? DEFAULT_THROWAWAY_MIN;
    const reserveGap = (): number => (THROWAWAY_BLOCKS.includes(step.item) ? Math.max(0, r0 - [...heldBack(this.slots(), { reserve: r0 }).throwaway.values()].reduce((a, n) => a + n, 0)) : 0);
    // 2. rounds
    let took = 0;
    let rounds = 0;
    for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
      if (cancelled()) return 'interrupted';
      const need = full - inBox();
      if (need <= 0) break;
      const loose = this.fillMoves(step.item, need).reduce((a, m) => a + m.count, 0);
      const src = loose < need ? this.fillSource(step.item, spare, all) : undefined;
      if (src !== undefined && this.boxes.freeSlots().length >= 2) {
        const before = this.looseCount(step.item);
        const r = await this.boxes.takeOut(src, rep, cancelled, { item: step.item, want: need - loose + reserveGap() });
        if (r === 'interrupted') return r;
        const got = this.looseCount(step.item) - before;
        took += Math.max(0, got);
        if (got > 0) continue;
        if (loose === 0) return fail(`taking ${step.item} out of a box: ${r}`);
      }
      if (loose === 0) return fail(`not enough ${step.item}`);
      const hb = await this.boxToHotbar(spare, cancelled);
      if (typeof hb === 'string') return fail(hb);
      spare = hb;
      const stacksBefore = Math.floor(inBox() / max);
      // filled next to the bot, broken and picked up again also after a cancel: never left standing; not picked up: walk
      // to it at once (the spare's slot is free, the deposits freed more); never a bot_loot box lying there taken for it
      const put = await this.boxes.putIn(spare, (view) => this.fillMoves(step.item, full - (this.d.skills.snapshot(view)?.counts[step.item] ?? 0)), rep, cancelled);
      if ('reason' in put) return fail(put.reason);
      rounds++;
      if (typeof put.back === 'string') return put.back;
      spare = put.back;
      if (cancelled()) return 'interrupted';
      if (put.moved === 0) return fail(put.open === undefined ? 'the box took nothing' : `open: ${put.open}`);
      if (Math.floor(inBox() / max) <= stacksBefore) return fail('a fill round added no full stack');
    }
    if (inBox() < full) return fail(`the box holds ${inBox()} of ${full} ${step.item}`);
    // 3. the full box into the chest; that chest full after all (the memory was older than the chest): the chest the
    // spare came from, else the emptiest one with a free slot (as the overflow's boxes); else it stays carried (a full
    // box like any other)
    const stored = await this.storeBox(target.pos, target.kind, spare, cancelled, rep);
    let at = stored;
    if (typeof stored === 'string' && stored !== 'interrupted') {
      const partners = partnerKeys(this.records());
      const alt = this.records()
        .filter((r) => r.readAt > 0 && !r.unreachable && r.free > 0 && !isShulkerBox(r.kind) && r.boxes.empty === 0 && !partners.has(chestKey(r)) && chestKey(r) !== chestKey(target.pos))
        .sort((a, b) => b.free - a.free)[0];
      if (alt) {
        this.log.info(`unload: fill a box of ${step.item}: ${chestName(this.d.memory().get(target.pos) ?? unreadRecord(target.pos, target.kind))}: ${stored}; storing it in ${chestName(alt)}`);
        at = await this.storeBox({ x: alt.x, y: alt.y, z: alt.z }, alt.kind, spare, cancelled, rep);
      }
    }
    if (typeof at === 'string') return at;
    (rep.filled ??= []).push({ item: step.item, chest: chestName(at), from, took, rounds, ms: this.now() - t0 });
    this.log.info(`unload: filled a box with ${full} ${step.item} (${took} out of the carried boxes, ${rounds} round${rounds === 1 ? '' : 's'}; the box from ${from}), stored in ${chestName(at)} (${((this.now() - t0) / 1000).toFixed(1)} s)`);
    return 'ok';
  }

  /** Walk to a chest, put the box of `slot` in, refresh its record: the record, or why not. */
  private async storeBox(p: Vec3, kind: string, slot: number, cancelled: () => boolean, rep: { chests: number; requests: number }): Promise<ChestRecord | string> {
    const w = await this.visit(p, kind, cancelled);
    if (!w.ok) return w.reason;
    rep.chests++;
    try {
      const r = await this.d.skills.depositSlots(w.view, [{ slot, count: 1 }]);
      rep.requests += r.requests;
      const rec = this.remember(p, w.record.kind, w.view);
      return r.total > 0 ? rec : `storing the box: ${r.reason ?? 'failed'}`;
    } finally {
      await this.d.skills.closeContainer(w.view);
    }
  }
}

/** `unloaded: 64 coal -> chest 100 63 -48, ...; 1 shulker box filled; kept 16 cobblestone, 1 bread; left 5 dirt (no room)` */
export function unloadLine(rep: UnloadReport): string {
  if (rep.reason === 'no_home') return 'unload: no home set (!home set)';
  if (rep.reason === 'no_chests') return 'unload: I know no chest near home yet (!chests scan)';
  const moved = rep.moved.map((m) => `${m.count} ${m.name} -> ${m.to}`).join(', ');
  const parts = [moved ? `unloaded: ${moved}` : rep.boxed?.length || rep.filled?.length ? 'unloaded: nothing loose' : 'unload: nothing moved'];
  if (rep.compacted) parts.push(rep.compacted); // Track AV/AW
  if (rep.emptied) parts.push(`${rep.emptied} full shulker box${rep.emptied === 1 ? '' : 'es'} emptied`);
  if (rep.boxes) parts.push(`${rep.boxes} shulker box${rep.boxes === 1 ? '' : 'es'} filled and stored`);
  // the fill steps: `boxed 2 full boxes of cobbled_deepslate into chest 1 2 3`
  const fills = new Map<string, { item: string; chest: string; n: number }>();
  for (const f of rep.filled ?? []) {
    const g = fills.get(`${f.item}|${f.chest}`) ?? { item: f.item, chest: f.chest, n: 0 };
    g.n++;
    fills.set(`${f.item}|${f.chest}`, g);
  }
  for (const g of fills.values()) parts.push(`boxed ${g.n} full box${g.n === 1 ? '' : 'es'} of ${g.item} into ${g.chest}`);
  // Track AV: the box steps, the named boxes
  const groups = new Map<string, { item: string; chest: string; from: string; stacks: number; n: number }>();
  for (const b of rep.boxed ?? []) {
    const k = `${b.item}|${b.chest}|${b.from}`;
    const g = groups.get(k) ?? { item: b.item, chest: b.chest, from: b.from, stacks: 0, n: 0 };
    g.stacks += b.stacks;
    g.n++;
    groups.set(k, g);
  }
  for (const g of groups.values()) parts.push(g.n === 1 ? `boxed ${g.stacks} stacks of ${g.item} from ${g.chest} into a shulker (box from ${g.from})` : `boxed ${g.stacks} stacks of ${g.item} from ${g.chest} into ${g.n} shulkers (boxes from ${g.from})`);
  if (rep.emptiedNamed) parts.push(`emptied ${namedBoxesWord(rep.emptiedNamed, rep.keepName)}`);
  const kept = rep.kept.map((k) => `${k.count} ${k.name}`);
  if (rep.namedKept) kept.unshift(namedBoxesWord(rep.namedKept, rep.keepName));
  if (kept.length) parts.push(`kept ${kept.join(', ')}`);
  if (rep.left.length) {
    const why = (name: string): string => {
      const b = rep.blocked?.find((x) => x.item === name);
      if (!b) return 'no room';
      const at = b.chest.replace(/,/g, ' ');
      return b.why === 'no_spare' ? `no room; chest ${at} is full and no spare shulker box is known` : `no room; chest ${at} is full of boxes`;
    };
    parts.push(`left ${rep.left.map((l) => `${l.count} ${l.name} (${why(l.name)})`).join(', ')}`);
  }
  if (rep.reason && rep.reason !== 'no_home' && rep.reason !== 'no_chests') parts.push(rep.reason === 'interrupted' ? 'interrupted' : rep.reason);
  // Track AV: a line past 256 characters (chat cuts there) says `unloaded: 14 stacks into 3 containers` instead of the list
  const line = parts.join('; ');
  if (line.length > 256 && moved) {
    const stacks = rep.moved.reduce((n, m) => n + Math.ceil(m.count / maxStackOf(m.name)), 0);
    const chests = new Set(rep.moved.map((m) => m.to)).size;
    parts[0] = `unloaded: ${stacks} stacks into ${chests} container${chests === 1 ? '' : 's'}`;
    return parts.join('; ');
  }
  return line;
}
