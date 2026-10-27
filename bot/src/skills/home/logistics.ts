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
//            in the box chest. With `all`, full shulker boxes carried are emptied first (placed, opened,
//            emptied into the inventory, broken, picked up) and their items unloaded like the rest.
//
// Every chest trip refreshes that chest's record. All container traffic goes through the task's one
// Containers (`shared` counts its item_stack_requests while a job ran; `requests` the job's own).
import type { RuntimeSettings } from '../../config/settings.ts';
import { silentLogger, type Logger } from '../../log.ts';
import { chestKey, type ChestMemoryStore, type ChestRecord } from '../../world/cache/chests.ts';
import type { ContainerView, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import { isShulkerBox, shulkerSlotsUsed, type ContainerSnapshot, type DepositResult, type OpenResult } from '../container/chest.ts';
import { boxSpots } from '../container/stash.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { PathResult } from '../nav/astar.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { chestNeighbours, findContainers, isHomeContainer, visitOrder, visitOrderBanded, type DiscoveryWorld } from './discovery.ts';
import { chestName, fmtPos, partnerKeys, planChests, recordFrom, unreadRecord } from './memory.ts';
import { chestGoal, verdict } from './reach.ts';
import { planUnload, unloadableStacks, type UnloadPlan, type UnloadSlot } from './unloader.ts';

/** A container read within this many ms is not read again by a scan. */
export const READ_FRESH_MS = 10 * 60_000;
/** The bot is "at home" within this many blocks (horizontal) of the home point. */
export const AT_HOME = 8;
/** Shulker boxes filled per unload run at most. */
export const MAX_BOXES_PER_RUN = 3;
/** Track AN: a container found unreachable is not probed again for this long (ms), unless `!chests scan`. */
export const UNREACHABLE_RETRY_MS = 60 * 60_000;
/** Track AN: containers opened per scan at most (the rest stays pending for the next idle moment). */
export const MAX_READS_PER_SCAN = 64;

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
  inventory: { readonly slots: readonly ({ name: string; count: number } | null)[]; rawItem?(window: number, slot: number): unknown };
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
  chests: number;
  /** The job's own item_stack_requests (deposits and takes). */
  requests: number;
  /** item_stack_requests on the shared Containers while the job ran. */
  shared: number;
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
    this.d.inventory.slots.slice(0, 36).forEach((s, i) => {
      if (!s || s.count <= 0) return;
      out.push({ slot: i, name: s.name, count: s.count, ...(isShulkerBox(s.name) ? { boxUsed: shulkerSlotsUsed(this.d.inventory.rawItem?.(0, i)) } : {}) });
    });
    return out;
  }

  /** What the autoUnload chore looks at: unloadable stacks carried and full boxes. */
  load(): { stacks: number; fullBoxes: number } {
    return unloadableStacks(this.slots());
  }

  /** The unload plan now; `reserve`: one free slot of that chest is kept (for a full box that goes back there). */
  plan(all = false, reserve?: string): UnloadPlan {
    const p = this.d.position();
    const chests = planChests(this.records()).map((c) => (c.key === reserve ? { ...c, free: Math.max(0, c.free - 1) } : c));
    return planUnload(this.slots(), chests, { all, ...(p ? { origin: p } : {}) });
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
  private async visit(p: Vec3, kind: string, cancelled: () => boolean): Promise<{ ok: true; view: ContainerView; record: ChestRecord } | { ok: false; reason: string }> {
    const g = await this.d.skills.goto(chestGoal(p), { timeoutTicks: 800 }); // 40 s: the probe already said it is reachable; a stuck walk must not eat the scan // within reach from any height (stacked chests, shelves, Track AN: up to 3 blocks above the feet); `near` failed for chests above floor level on the Realm
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
    mem.set(r);
    return r;
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
    const start = this.d.position() ?? centre(home);
    // visit order: nearest neighbour on a walking-aware cost (a floor change or a jump in path length from home
    // means another room: finish the wall of chests here before walking across the room or out of the door)
    for (const f of visitOrderBanded(take, start, (f) => blocksOf.get(chestKey(f.p)) ?? 0)) {
      if (cancelled()) return finish('interrupted');
      // the other half of a double chest read in this scan
      partners = partnerKeys(mem.all());
      if (partners.has(chestKey(f.p))) continue;
      const v = await this.visit(f.p, f.kind, cancelled);
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
    const rep: UnloadReport = { ok: false, moved: [], kept: [], left: [], boxes: 0, emptied: 0, chests: 0, requests: 0, shared: 0, ms: 0 };
    const finish = (reason?: string): UnloadReport => {
      const plan = this.plan(opts.all);
      rep.kept = plan.kept;
      rep.left = [];
      for (const o of plan.overflow) {
        const l = rep.left.find((x) => x.name === o.name);
        if (l) l.count += o.count;
        else rep.left.push({ name: o.name, count: o.count });
      }
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
    {
      if (opts.all) {
        const r = await this.emptyFullBoxes(rep, cancelled);
        if (r) return finish(r);
      }
      const failed = new Set<string>();
      for (let round = 0; round < 40; round++) {
        if (cancelled()) return finish('interrupted');
        const plan = this.plan(opts.all);
        const targets = new Map<string, Vec3>();
        for (const m of plan.moves) if (!failed.has(m.to)) targets.set(m.to, planChests(this.records()).find((c) => c.key === m.to)!.pos);
        if (targets.size === 0) break;
        const here = this.d.position() ?? centre(this.d.home()!);
        const [next] = visitOrder([...targets].map(([key, p]) => ({ key, p })), here);
        const r = await this.depositAt(next!.p, rep, cancelled, opts.all ?? false);
        if (r === 'interrupted') return finish('interrupted');
        if (r !== 'ok') failed.add(next!.key);
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
  private async depositAt(p: Vec3, rep: UnloadReport, cancelled: () => boolean, all: boolean): Promise<string> {
    const rec = this.d.memory().get(p);
    const v = await this.visit(p, rec?.kind ?? 'chest', cancelled);
    if (!v.ok) return v.reason;
    rep.chests++;
    try {
      const key = chestKey(p);
      const plan = this.plan(all);
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
      const slot = v.view.slots.findIndex((s, i) => !!s && isShulkerBox(s.name) && shulkerSlotsUsed(this.d.inventory.rawItem?.(v.view.id, i)) === 0);
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
          const plan = this.plan(all, chestKey(from));
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

  /** `all`: empty the full boxes carried into the inventory (place, open, take, break, pick up). Returns a reason to stop. */
  private async emptyFullBoxes(rep: UnloadReport, cancelled: () => boolean): Promise<string | undefined> {
    for (let n = 0; n < MAX_BOXES_PER_RUN; n++) {
      if (cancelled()) return 'interrupted';
      const full = [...this.boxSlots()].find(([, used]) => used > 0)?.[0];
      if (full === undefined) return undefined;
      if (this.freeSlots().length < 2) return undefined; // nothing to take the items into: unload first
      const name = this.d.inventory.slots[full]!.name;
      if (full < 9) this.d.selectHotbar?.(full);
      const feet = this.d.position();
      const spots = feet ? boxSpots((q) => this.d.world.blockAt(q), feet) : [];
      let at: Vec3 | undefined;
      for (const p of spots.slice(0, 3)) {
        const r = await this.d.skills.place(p, { face: 'up', item: name });
        if (cancelled()) return 'interrupted';
        if (r.ok) {
          at = p;
          break;
        }
      }
      if (!at) return undefined;
      const o = await this.d.skills.open(at);
      if (o.ok) {
        try {
          for (let i = 0; i < o.view.slots.length; i++) {
            if (!this.d.inventory.slots.slice(0, 36).some((s) => !s)) break;
            if (!o.view.slots[i]) continue;
            const t = await this.d.skills.take(o.view, i);
            if (t.moved > 0) rep.requests++;
            if (!t.ok) break;
          }
        } finally {
          await this.d.skills.closeContainer(o.view);
        }
      }
      const dg = await this.d.skills.dig(at);
      if (!dg.ok) return dg.reason === 'interrupted' ? 'interrupted' : undefined;
      await this.d.skills.collect(4, 100, { origin: centre(at), filter: (i) => isShulkerBox(i.name) });
      rep.emptied++;
      if (cancelled()) return 'interrupted';
    }
    return undefined;
  }
}

/** `unloaded: 64 coal -> chest 100 63 -48, ...; 1 shulker box filled; kept 16 cobblestone, 1 bread; left 5 dirt (no room)` */
export function unloadLine(rep: UnloadReport): string {
  if (rep.reason === 'no_home') return 'unload: no home set (!home set)';
  if (rep.reason === 'no_chests') return 'unload: I know no chest near home yet (!chests scan)';
  const moved = rep.moved.map((m) => `${m.count} ${m.name} -> ${m.to}`).join(', ');
  const parts = [moved ? `unloaded: ${moved}` : 'unload: nothing moved'];
  if (rep.emptied) parts.push(`${rep.emptied} full shulker box${rep.emptied === 1 ? '' : 'es'} emptied`);
  if (rep.boxes) parts.push(`${rep.boxes} shulker box${rep.boxes === 1 ? '' : 'es'} filled and stored`);
  const kept = rep.kept.map((k) => `${k.count} ${k.name}`);
  if (kept.length) parts.push(`kept ${kept.join(', ')}`);
  if (rep.left.length) parts.push(`left ${rep.left.map((l) => `${l.count} ${l.name}`).join(', ')} (no room)`);
  if (rep.reason && rep.reason !== 'no_home' && rep.reason !== 'no_chests') parts.push(rep.reason === 'interrupted' ? 'interrupted' : rep.reason);
  return parts.join('; ');
}
