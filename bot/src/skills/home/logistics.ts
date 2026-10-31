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
import { boxSpots } from '../container/stash.ts';
import { isFireworksBox } from '../fly/kit.ts'; // Track AU: the fireworks box is never unloaded
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { chestNeighbours, findContainers, isHomeContainer, visitOrder, visitOrderBanded, type DiscoveryWorld } from './discovery.ts';
import { chestName, fmtPos, partnerKeys, planChests, recordFrom, unreadRecord } from './memory.ts';
import { chestGoal, standOf, verdict } from './reach.ts';
import { bringMatches, countOf, planBring, type BringItem } from './bring.ts'; // Track AS
import { compactRunner, planUnload, reserveByKind, unloadableStacks, type UnloadPlan, type UnloadSlot, type UnloadStep } from './unloader.ts';
import { BOX_SLOTS, carriedBoxes, carriedSpares, isKeptBox, keepNameOf, MAX_BOX_STEPS, namedBoxesWord, placesExactly } from './boxing.ts'; // Track AV

/** A container read within this many ms is not read again by a scan. */
export const READ_FRESH_MS = 10 * 60_000;
/** The bot is "at home" within this many blocks (horizontal) of the home point. */
export const AT_HOME = 8;
/** Shulker boxes filled per unload run at most. */
export const MAX_BOXES_PER_RUN = 3;
/** Deposit passes per unload run at most: each one unloads, then empties the next carried box (`all`: every full box of the inventory). */
export const MAX_UNLOAD_PASSES = 24;
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
  inventory: { readonly slots: readonly ({ name: string; count: number; metadata?: number } | null)[]; rawItem?(window: number, slot: number): unknown };
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
  /** Matching items carried after the job (top-level inventory). */
  carried: number;
  /** Chest trips. */
  chests: number;
  requests: number;
  ms: number;
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

  constructor(d: HomeDeps) {
    this.d = d;
    this.log = d.log ?? silentLogger;
    this.now = d.now ?? (() => Date.now());
  }

  /** A job runs (block updates it causes itself are ignored by the trigger). */
  get busy(): boolean {
    return this.running > 0;
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
      out.push({ slot: i, name: s.name, count: s.count, ...(isShulkerBox(s.name) ? { boxUsed: shulkerSlotsUsed(raw) } : {}), ...(isFireworksBox(s.name, raw) || this.d.flightBoxSlot?.() === i ? { flightKit: true } : {}), ...(isKeptBox(s.name, raw, keep) ? { named: true } : {}), ...(isShulkerBox(s.name) && raw === undefined ? { unknown: true } : {}) }); // Track AU: the fireworks box is kept; Track AV: named boxes
    });
    return out;
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

  /** What the autoUnload chore looks at: unloadable stacks carried and full boxes. */
  load(): { stacks: number; fullBoxes: number } {
    return unloadableStacks(this.slots());
  }

  /** The unload plan now; `reserve`: one free slot of that chest is kept (for a full box that goes back there). */
  plan(all = false, reserve?: string, box: { on?: boolean; skip?: ReadonlySet<string> } = {}): UnloadPlan {
    const p = this.d.position();
    const chests = planChests(this.records()).map((c) => (c.key === reserve ? { ...c, free: Math.max(0, c.free - 1) } : c));
    const r = this.reserve();
    return planUnload(this.slots(), chests, {
      all,
      ...(p ? { origin: p } : {}),
      ...(r !== undefined ? { reserve: r } : {}),
      boxing: box.on ?? true, // Track AV
      ...(box.skip ? { noBox: box.skip } : {}),
    });
  }

  private requests(): number {
    return this.d.containers?.stats.requests ?? 0;
  }

  private freeSlots(): number[] {
    const out: number[] = [];
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (!s || s.count <= 0) out.push(i);
    });
    for (let i = this.d.inventory.slots.length; i < 36; i++) out.push(i);
    return out;
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
    view.slots.forEach((s, i) => {
      if (!s || !isShulkerBox(s.name)) return;
      for (const [k, v] of Object.entries(shulkerContents(this.d.inventory.rawItem?.(view.id, i)))) inBoxes[k] = (inBoxes[k] ?? 0) + v;
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
    const rec: ChestRecord = Object.keys(inBoxes).length ? { ...r2, inBoxes } : r2;
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
    const failed = new Set<string>();
    let boxItems = 0;
    for (let round = 0; round < 24; round++) {
      if (cancelled()) return finish('interrupted');
      const plan = planBring(this.records(), req.item, req.want, this.carried(req.item) + boxItems, this.d.position());
      if (plan.need <= 0) break;
      const next = plan.sources.find((x) => !failed.has(`${x.key}:${x.box ? 'box' : 'loose'}`));
      if (!next) break;
      const tag = `${next.key}:${next.box ? 'box' : 'loose'}`;
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
      try {
        let left = plan.need;
        const used = (i: number): number => shulkerSlotsUsed(this.d.inventory.rawItem?.(v.view.id, i));
        if (!next.box) {
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
          // whole boxes holding the item (the loose stacks were not enough)
          for (let i = 0; i < v.view.slots.length && left > 0 && !cancelled(); i++) {
            const st = v.view.slots[i];
            if (!st || !isShulkerBox(st.name)) continue;
            const inside = countOf(req.item, shulkerContents(this.d.inventory.rawItem?.(v.view.id, i)));
            if (inside <= 0) continue;
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
      if (cancelled()) return finish('interrupted');
      if (full) return finish('inventory_full');
      if (got === 0) failed.add(tag); // it held less than remembered: the refreshed memory sends the next round elsewhere
    }
    return finish();
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
    const rep: UnloadReport = { ok: false, moved: [], kept: [], left: [], boxes: 0, emptied: 0, chests: 0, requests: 0, shared: 0, ms: 0, boxed: [], emptiedNamed: 0, namedKept: 0, blocked: [] };
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
      // Track AV: box steps first; a failed step's kind is planned without boxing afterwards
      const skip = new Set<string>();
      let steps = 0;
      for (let pass = 0; pass < MAX_UNLOAD_PASSES; pass++) {
        for (let round = 0; round < 40; round++) {
          if (cancelled()) return finish('interrupted');
          const plan = this.plan(opts.all, undefined, { on: steps < MAX_BOX_STEPS, skip });
          const step = plan.steps.find((x) => x.kind === 'box');
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
          if (targets.size === 0) break;
          const here = this.d.position() ?? centre(this.d.home()!);
          const [next] = visitOrder([...targets].map(([key, p]) => ({ key, p })), here);
          const r = await this.depositAt(next!.p, rep, cancelled, opts.all ?? false, skip);
          if (r === 'interrupted') return finish('interrupted');
          if (r !== 'ok') failed.add(next!.key);
        }
        // Track AV: the named boxes' items next (with `all`, every full box's but the fireworks box's); they are unloaded in the next pass
        const e = await this.emptyNextBox(opts.all ?? false, rep, cancelled);
        if (e === 'interrupted') return finish('interrupted');
        if (e !== 'ok') {
          if (e !== 'none') this.log.info(`unload: emptying a box: ${e}`);
          break;
        }
      }
      // overflow: spare shulker boxes from the box chest
      for (let n = 0; n < MAX_BOXES_PER_RUN; n++) {
        if (cancelled()) return finish('interrupted');
        const plan = this.plan(opts.all);
        if (!plan.overflow.some((o) => !isShulkerBox(o.name))) break;
        const r = await this.viaSpareBox(rep, cancelled, opts.all ?? false);
        if (r === 'interrupted') return finish('interrupted');
        if (r !== 'ok') {
          this.log.info(`unload: spare shulker box: ${r}`);
          break;
        }
      }
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
  private async depositAt(p: Vec3, rep: UnloadReport, cancelled: () => boolean, all: boolean, skip?: ReadonlySet<string>): Promise<string> {
    const rec = this.d.memory().get(p);
    const v = await this.visit(p, rec?.kind ?? 'chest', cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const key = chestKey(p);
      const plan = this.plan(all, undefined, { on: false, ...(skip ? { skip } : {}) });
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

  /** Box slots carried (inventory slot -> NBT slots used). */
  private boxSlots(): Map<number, number> {
    const out = new Map<number, number>();
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (s && s.count > 0 && isShulkerBox(s.name)) out.set(i, shulkerSlotsUsed(this.d.inventory.rawItem?.(0, i)));
    });
    return out;
  }

  /** Make a hotbar slot free while a window is open (a placed box must come from the hotbar). */
  private async freeHotbarSlot(): Promise<void> {
    const inv = this.d.inventory.slots;
    if (inv.slice(0, 9).some((s) => !s || s.count <= 0)) return;
    const c = this.d.containers;
    if (!c?.move) return;
    const main = this.freeSlots().filter((i) => i >= 9);
    if (main.length < 2) return; // one for the stack moved out, one for the box
    const plan = this.plan();
    const movable = new Set(plan.moves.map((m) => m.slot).concat(plan.overflow.map((o) => o.slot)));
    const h = [...Array(9).keys()].find((i) => movable.has(i) && !isShulkerBox(inv[i]?.name ?? ''));
    if (h === undefined) return;
    await c.move({ window: 0, slot: h }, { window: 0, slot: main[0]! }, inv[h]!.count);
  }

  /** Take an empty box from the box chest, fill it next to the bot, break it, pick it up, store it. */
  private async viaSpareBox(rep: UnloadReport, cancelled: () => boolean, all: boolean): Promise<string> {
    const from = this.boxChest();
    if (!from) return 'no empty shulker box in any chest';
    if (this.freeSlots().length === 0) return 'no free inventory slot for a box';
    // (the caller saw overflow with the box chest as it is; after the take its freed slot is kept for
    // the full box, so the box gets the same overflow)
    // 1. take one empty box
    const v = await this.visit(from, from.kind, cancelled);
    if (!v.ok) return v.reason;
    let boxSlot: number | undefined;
    let boxName: string | undefined;
    try {
      const slot = v.view.slots.findIndex((s, i) => !!s && isShulkerBox(s.name) && this.d.inventory.rawItem?.(v.view.id, i) !== undefined && shulkerSlotsUsed(this.d.inventory.rawItem?.(v.view.id, i)) === 0 && !isKeptBox(s.name, this.d.inventory.rawItem?.(v.view.id, i), this.keepName())); // Track AV: never a named box
      if (slot < 0) {
        this.remember(from, v.record.kind, v.view);
        return 'the box chest holds no empty box any more';
      }
      boxName = v.view.slots[slot]!.name;
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
    if (boxSlot < 9) this.d.selectHotbar?.(boxSlot);
    // 2. place it next to the bot
    const feet = this.d.position();
    const spots = feet ? boxSpots((q) => this.d.world.blockAt(q), feet) : [];
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
      const r = await this.d.skills.place(p, { face: 'up', item: boxName ?? 'undyed_shulker_box' });
      if (cancelled()) return 'interrupted';
      if (r.ok) {
        at = p;
        break;
      }
    }
    if (!at) return 'no free cell for the box next to the bot';
    // 3. fill it with what fits nowhere else
    let filled = 0;
    const o = await this.d.skills.open(at);
    if (o.ok) {
      try {
        // the box chest's slot the box came from is kept for the full box; planned again after each
        // pass (the survival keeper may move a stack to the hotbar meanwhile)
        for (let pass = 0; pass < 3; pass++) {
          const plan = this.plan(all, chestKey(from), { on: false });
          const moves = plan.overflow.filter((x) => !isShulkerBox(x.name)).map((x) => ({ slot: x.slot, count: x.count, name: x.name }));
          if (moves.length === 0) break;
          const r = await this.d.skills.depositSlots(o.view, moves);
          rep.requests += r.requests;
          filled += r.total;
          this.addMoved(rep, r.moved, `shulker box (into ${chestName(from)})`);
          if (r.total === 0 || r.reason === 'container_full' || cancelled()) break;
        }
      } finally {
        await this.d.skills.closeContainer(o.view);
      }
    }
    // 4. break it and pick it up again (also after a failed open: never leave it behind)
    const before = new Map(this.boxSlots());
    const dg = await this.d.skills.dig(at);
    if (!dg.ok) return dg.reason === 'interrupted' ? 'interrupted' : `break: ${dg.reason ?? 'failed'}`;
    for (const radius of [4, 6]) {
      await this.d.skills.collect(radius, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      if (cancelled()) return 'interrupted';
      if ([...this.boxSlots()].some(([i, used]) => used > 0 && before.get(i) !== used)) break;
    }
    const full = [...this.boxSlots()].find(([i, used]) => used > 0 && before.get(i) !== used)?.[0];
    if (full === undefined) return filled > 0 ? `the full box was not picked up again (left at ${fmtPos(at)})` : 'the box was not filled';
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
      if (this.freeSlots().length < 2) return undefined; // nothing to take the items into: unload first
      const r = await this.emptyBox(full, rep, cancelled);
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
    if (this.freeSlots().length < 2) return 'no free inventory slot for its items';
    const r = await this.emptyBox(box.slot, rep, cancelled);
    if (r === 'emptied' && !box.named) rep.emptied++; // the named ones are counted by emptiedNamed
    return r.startsWith('emptied') ? 'ok' : r;
  }

  /** New inventory slots that taking the stack `st` out of a window uses: none for what tops up partial stacks of the same item (a shulker box never stacks). */
  private slotsFor(st: { name: string; count: number; metadata?: number }): number {
    const max = maxStackOf(st.name);
    let room = 0;
    if (!isShulkerBox(st.name)) {
      for (const s of this.d.inventory.slots.slice(0, 36)) {
        if (s?.name === st.name && s.metadata === st.metadata && s.count < max) room += max - s.count;
      }
    }
    return Math.ceil(Math.max(0, st.count - room) / max);
  }

  /**
   * Place the box of `slot`, take what fits into the inventory, break it, pick it up: `emptied` / `emptied partly` or why not.
   * The slot the placed box left stays free for it: the broken box drops as an item and needs a slot to come back to
   * (the contents filled it, the box stayed on the ground and the run stuck, Realm 2026-10-30).
   */
  private async emptyBox(slot: number, rep: UnloadReport, cancelled: () => boolean): Promise<string> {
    const s = await this.boxToHotbar(slot, cancelled);
    if (typeof s === 'string') return s;
    const placed = await this.placeBox(s, cancelled);
    if ('reason' in placed) return placed.reason;
    let left = 0;
    const o = await this.d.skills.open(placed.at);
    if (o.ok) {
      try {
        for (let i = 0; i < o.view.slots.length; i++) {
          const st = o.view.slots[i];
          if (!st) continue;
          if (this.freeSlots().length - this.slotsFor(st) < 1) {
            left++;
            continue;
          }
          const t = await this.d.skills.take(o.view, i);
          if (t.moved > 0) rep.requests++;
          if (o.view.slots[i]) left++;
          if (!t.ok && t.reason !== 'inventory_full') break;
        }
      } finally {
        await this.d.skills.closeContainer(o.view);
      }
    }
    const back = await this.breakAndPickUp(placed.at, cancelled);
    if (typeof back === 'string') return back;
    if (!o.ok) return `open: ${o.reason}`;
    return left > 0 ? 'emptied partly' : 'emptied';
  }

  /** The inventory slots holding a shulker box. */
  private boxKeys(): Set<number> {
    return new Set(this.boxSlots().keys());
  }

  /** Break the box at `at` and pick it up again (also an empty one): its new inventory slot, or why not. */
  private async breakAndPickUp(at: Vec3, cancelled: () => boolean): Promise<number | string> {
    const before = this.boxKeys();
    // a box broken meanwhile (a player, a mob, an explosion): no dig, straight to the pickup
    const b = this.d.world.blockAt(at);
    if (b && b.name !== 'unknown' && isShulkerBox(b.name)) {
      const dg = await this.d.skills.dig(at);
      if (!dg.ok && dg.reason !== 'no_block') return dg.reason === 'interrupted' ? 'interrupted' : `break: ${dg.reason ?? 'failed'}`;
    }
    const fresh = (): number | undefined => [...this.boxKeys()].find((i) => !before.has(i));
    for (const radius of [4, 6]) {
      await this.d.skills.collect(radius, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      if (cancelled()) return 'interrupted';
      if (fresh() !== undefined) break;
    }
    return fresh() ?? `the box was not picked up again (left at ${fmtPos(at)})`;
  }

  /**
   * Place the box of `slot` next to the bot (`slot` selected when in the hotbar; `placesExactly` must hold).
   * A different box placed (the model moved meanwhile) is broken and picked up again.
   */
  private async placeBox(slot: number, cancelled: () => boolean): Promise<{ at: Vec3 } | { reason: string }> {
    const inv = this.d.inventory.slots;
    const name = inv[slot]?.name;
    if (!name || !isShulkerBox(name)) return { reason: `no box in slot ${slot}` };
    if (!placesExactly(inv, slot)) return { reason: 'the box is not in the hotbar (another box of that colour would be placed)' };
    if (slot < 9) this.d.selectHotbar?.(slot);
    const others = new Map<number, string>();
    inv.slice(0, 36).forEach((x, i) => {
      if (i !== slot && x && isShulkerBox(x.name)) others.set(i, x.name);
    });
    const feet = this.d.position();
    const spots = feet ? boxSpots((q) => this.d.world.blockAt(q), feet) : [];
    let at: Vec3 | undefined;
    for (const p of spots.slice(0, 3)) {
      const r = await this.d.skills.place(p, { face: 'up', item: name });
      if (cancelled()) return { reason: 'interrupted' };
      if (r.ok) {
        at = p;
        break;
      }
    }
    if (!at) return { reason: 'no free cell for the box next to the bot' };
    const now = this.d.inventory.slots;
    if ([...others].some(([i, n]) => now[i]?.name !== n)) {
      const back = await this.breakAndPickUp(at, cancelled);
      return { reason: back === 'interrupted' ? 'interrupted' : 'placed another box than the one wanted (picked it up again)' };
    }
    return { at };
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
    if (this.freeSlots().length === 0) return 'no free inventory slot for a box';
    const v = await this.visit(from.pos, from.kind, cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const keep = this.keepName();
      const raw = (i: number) => this.d.inventory.rawItem?.(v.view.id, i);
      const slot = v.view.slots.findIndex((s, i) => !!s && isShulkerBox(s.name) && raw(i) !== undefined && shulkerSlotsUsed(raw(i)) === 0 && !isKeptBox(s.name, raw(i), keep)); // a box without its wire item is no spare
      if (slot < 0) {
        this.remember(from.pos, v.record.kind, v.view);
        return 'the chest holds no empty box any more';
      }
      await this.freeHotbarSlot();
      const t = await this.d.skills.take(v.view, slot, 1, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
      if (t.moved > 0) rep.requests++;
      this.remember(from.pos, v.record.kind, v.view);
      if (!t.ok || t.to === undefined) return `take: ${t.reason ?? 'failed'}`;
      return t.to;
    } finally {
      await this.d.skills.closeContainer(v.view);
    }
  }

  /** The (slot, count) pairs of `item` for a box: at most `stacks` slots, fullest first, the throwaway reserve held back. */
  private boxMoves(item: string, stacks: number): { slot: number; count: number; name: string }[] {
    const slots = this.slots();
    const have = slots.filter((s) => s.name === item);
    let allowed = have.reduce((a, s) => a + s.count, 0) - (reserveByKind(slots, this.reserve()).get(item) ?? 0);
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
   */
  private async boxStep(step: Extract<UnloadStep, { kind: 'box' }>, rep: UnloadReport, cancelled: () => boolean): Promise<string> {
    const t0 = this.now();
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
      const room = this.freeSlots().length;
      let got = 0;
      try {
        const loose = v.view.slots
          .map((st, i) => ({ st, i }))
          .filter((x) => !!x.st && x.st.count > 0 && x.st.name === step.item)
          .sort((a, b) => b.st!.count - a.st!.count || a.i - b.i);
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
        this.remember(target.pos, v.record.kind, v.view);
      } finally {
        await this.d.skills.closeContainer(v.view);
      }
      took += got;
      if (cancelled()) return 'interrupted';
      if (this.boxMoves(step.item, need).length === 0) break;
      const placed = await this.placeBox(box, cancelled);
      if ('reason' in placed) return placed.reason;
      rounds++;
      let moved = 0;
      const o = await this.d.skills.open(placed.at);
      if (o.ok) {
        try {
          // planned again after each pass: the survival keeper may move a stack to the hotbar meanwhile
          for (let pass = 0; pass < 3; pass++) {
            const left = BOX_SLOTS - (this.d.skills.snapshot(o.view)?.stacks ?? 0);
            const moves = left > 0 ? this.boxMoves(step.item, left) : [];
            if (moves.length === 0) break;
            const r = await this.d.skills.depositSlots(o.view, moves);
            rep.requests += r.requests;
            moved += r.total;
            if (r.total === 0 || r.reason === 'container_full' || cancelled()) break;
          }
        } finally {
          await this.d.skills.closeContainer(o.view);
        }
      }
      const back = await this.breakAndPickUp(placed.at, cancelled);
      if (typeof back === 'string') return back;
      box = back;
      if (moved === 0) return o.ok ? 'the box took nothing' : `open: ${o.reason}`;
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
}

/** `unloaded: 64 coal -> chest 100 63 -48, ...; 1 shulker box filled; kept 16 cobblestone, 1 bread; left 5 dirt (no room)` */
export function unloadLine(rep: UnloadReport): string {
  if (rep.reason === 'no_home') return 'unload: no home set (!home set)';
  if (rep.reason === 'no_chests') return 'unload: I know no chest near home yet (!chests scan)';
  const moved = rep.moved.map((m) => `${m.count} ${m.name} -> ${m.to}`).join(', ');
  const parts = [moved ? `unloaded: ${moved}` : rep.boxed?.length ? 'unloaded: nothing loose' : 'unload: nothing moved'];
  if (rep.compacted) parts.push(rep.compacted); // Track AV/AW
  if (rep.emptied) parts.push(`${rep.emptied} full shulker box${rep.emptied === 1 ? '' : 'es'} emptied`);
  if (rep.boxes) parts.push(`${rep.boxes} shulker box${rep.boxes === 1 ? '' : 'es'} filled and stored`);
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
