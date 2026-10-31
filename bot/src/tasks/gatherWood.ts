// GatherWood task (PLAN.md section 4.4 and task 4.6): a state machine
//
//   find-tree -> fell (goto + dig, bottom up) -> collect drops -> (target reached or inventory
//   full) -> goto chest -> open -> deposit logs -> close -> repeat until N logs are in the chest
//
// Logs of any kind count towards the target; saplings, apples and sticks are picked up (they are
// drops near the tree) but never counted and never deposited. Only logs are dug unless
// `allowDig` says otherwise. Started from the CLI (`--task gather --target-logs 64 --chest x,y,z`)
// or by chat (`!gather 64 [x y z]`, `!gather stop`); `!status` shows the state.
//
// Death (PLAN.md 5.1, minimum here): tasks/respawn.ts presses respawn; on its death event the task
// pauses (skills cancelled), after the respawn it resumes from find-tree. Items lost at the death
// are not fetched back.
//
// Remembered forests (Track Z, docs/world-cache.md "Remembered forests"): when find-tree finds no tree
// within the search radius, the task asks its ForestFinder (`useForests`; loaded logs farther away
// and logs the world cache remembers from earlier visits, also before a restart) for the nearest log
// cluster, walks there with an `any` goal (near the cluster's nearest logs) and searches again from
// there. A cluster that yields no tree after the walk, or that cannot be reached, is put on Track R's
// blacklist (its logs), so the next search skips it.
import type { ParseArgsOptionsConfig } from 'node:util';
import { registerGatherCommands } from '../chat/commands.ts';
import type { Vec3 } from '../connection/types.ts';
import { silentLogger, type Logger } from '../log.ts';
import type { BotSkills, Tree } from '../skills/index.ts';
import { isLog } from '../skills/tree/tree.ts';
import { Containers } from '../world/containers.ts';
import { findLogClusters, type LogCluster } from '../world/find.ts'; // Track Z
import { Hotbar } from '../world/hotbar.ts';
import type { EntityInfo, ItemStack } from '../world/types.ts';
import type { RunningTask, TaskContext, TaskDefinition } from './base.ts';
import { isWoodDrop, sweepItems } from '../skills/collect/sweep.ts'; // Track AQ

export type GatherState =
  | 'idle'
  | 'find'
  | 'fell'
  | 'collect'
  | 'to_chest'
  | 'deposit'
  | 'waiting'
  | 'dead'
  | 'done'
  | 'failed'
  | 'stopped';

export interface GatherOptions {
  /** Logs to put into the chest (or to carry, without a chest). */
  target: number;
  /** Chest position (block). Without one the task stops once it carries `target` logs. */
  chest?: Vec3;
  /** Centre of the tree search. Default: the chest, else the bot's position at start. */
  origin?: Vec3;
  /** Tree search radius around the origin. Default 48. */
  searchRadius?: number;
  /** Drop pickup radius around a felled tree. Default 8. */
  collectRadius?: number;
  /** Ticks for one collect round. Default 300. */
  collectTicks?: number;
  /** Deposit when this few inventory slots are left. Default 2. */
  minFreeSlots?: number;
  /** Extra blocks the feller may dig (default none: logs only). */
  allowDig?: (name: string) => boolean;
  /** Give up on a tree after this many attempts that left logs. Default 2. */
  treeAttempts?: number;
  /** Rounds without any tree before giving up (100 ticks apart). Default 5. */
  noTreeRounds?: number;
  /** Track Z: search radius for remembered / far log clusters when none is near. Default 256. */
  forestRadius?: number;
  /** Track Z: walks to log clusters per run at most. Default 8. */
  maxForestWalks?: number;
}

/** Track Z: where the gather task looks for trees beyond its search radius (`cachedForests`). */
export interface ForestFinder {
  /** Log clusters (loaded and remembered) within `radius` of `origin`, nearest first, blacklisted logs left out. */
  clusters(origin: Vec3, radius: number): LogCluster[];
  /** Put a log on the blacklist at once (Track R's NavBlacklist: skipped by the tree finder and by `clusters`). */
  blacklist?(p: Vec3, why: string): void;
}

export interface GatherStats {
  startedAt: number | undefined;
  finishedAt: number | undefined;
  deposited: number;
  logsBroken: number;
  treesFelled: number;
  treesFailed: number;
  trips: number;
  depositFailures: number;
  collectRounds: number;
  inventoryFull: number;
  corrections: number;
  repaths: number;
  digFailures: number;
  deaths: number;
  saplings: number;
  /** Track Z: walks to a log cluster beyond the search radius, clusters blacklisted (nothing there / unreachable). */
  forestWalks: number;
  forestsBlacklisted: number;
}

export interface GatherDeps {
  skills: Pick<BotSkills, 'findTrees' | 'fellTree' | 'collect' | 'goto' | 'open' | 'deposit' | 'closeContainer' | 'cancel' | 'status'>;
  inventory: { readonly slots: readonly (ItemStack | null)[]; freeSlots(): number[] };
  /** Feet position when known. */
  position: () => Vec3 | undefined;
  /** The bot can act (spawned, input loop ready, alive). */
  ready: () => boolean;
  waitTicks: (n: number) => Promise<void>;
  /** Correction counter (InputLoop.state.corrections). */
  corrections: () => number;
  /** Track AQ: the entities (the floor sweep: logs lying within 8 blocks are picked up before the next tree). */
  entities?: () => ReadonlyMap<bigint, EntityInfo>;
  log?: Logger;
  now?: () => number;
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

/** Logs (any kind) carried in the player inventory. */
export function logsIn(slots: readonly (ItemStack | null)[]): number {
  let n = 0;
  for (const s of slots.slice(0, 36)) if (s && isLog(s.name)) n += s.count;
  return n;
}

export class GatherWoodTask {
  readonly name = 'gather';
  state: GatherState = 'idle';
  readonly stats: GatherStats = newStats();
  opts: GatherOptions | undefined;
  lastError: string | undefined;
  private readonly d: GatherDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** Generation of the run loop; stop() / start() bump it so an old loop ends. */
  private gen = 0;
  private paused = false;
  private resumeFns: (() => void)[] = [];
  private readonly treeFails = new Map<string, number>();
  private readonly doneFns = new Set<(s: GatherState) => void>();
  private c0 = 0;
  private origin: Vec3 | undefined;
  /** Track Z: remembered / far forests, and the cluster the last forest walk went to (until a tree is felled there). */
  private forests: ForestFinder | undefined;
  private forest: LogCluster | undefined;
  /** Track AD: the stash step when the inventory fills (skills/container/stash.ts, docs/get.md); set by commands-get. */
  stash: { ifFull(job: { label?: string; chest?: Vec3 | undefined; wanted?: (name: string) => boolean }): Promise<boolean> } | undefined;

  constructor(deps: GatherDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Track Z: walk to remembered or far forests when no tree is within the search radius (undefined: off). */
  useForests(f: ForestFinder | undefined): void {
    this.forests = f;
  }

  get running(): boolean {
    return !['idle', 'done', 'failed', 'stopped'].includes(this.state);
  }

  /** Start (or restart with new options). Resolves when the run ends (done, failed or stopped). */
  start(opts: GatherOptions): Promise<GatherState> {
    if (!Number.isInteger(opts.target) || opts.target <= 0) throw new Error(`target must be a positive integer, got ${opts.target}`);
    this.gen++;
    this.d.skills.cancel();
    this.opts = opts;
    Object.assign(this.stats, newStats());
    this.stats.startedAt = this.now();
    this.c0 = this.d.corrections();
    this.treeFails.clear();
    this.lastError = undefined;
    this.forest = undefined;
    this.origin = opts.origin ?? opts.chest;
    this.state = 'find';
    this.log.info(`gather: target ${opts.target} logs, chest ${opts.chest ? key(opts.chest) : 'none'}, search radius ${opts.searchRadius ?? 48}`);
    const gen = this.gen;
    return this.run(gen).catch((e: unknown) => {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.error(`gather: ${this.lastError}`);
      return this.end(gen, 'failed');
    });
  }

  stop(): void {
    if (!this.running) return;
    this.gen++;
    this.d.skills.cancel();
    this.end(this.gen, 'stopped');
    this.wake();
  }

  /** Death: cancel the running skill and wait for resume(). */
  pause(why = 'dead'): void {
    if (!this.running) return;
    this.paused = true;
    this.stats.deaths += why === 'dead' ? 1 : 0;
    this.state = 'dead';
    this.d.skills.cancel();
    this.log.warn(`gather: paused (${why})`);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.state === 'dead') this.state = 'find';
    this.log.info('gather: resumed');
    this.wake();
  }

  onDone(fn: (s: GatherState) => void): () => void {
    this.doneFns.add(fn);
    return () => this.doneFns.delete(fn);
  }

  status(): Record<string, unknown> {
    const s = this.stats;
    const end = s.finishedAt ?? this.now();
    const elapsedS = s.startedAt ? (end - s.startedAt) / 1000 : 0;
    return {
      state: this.state,
      target: this.opts?.target ?? null,
      chest: this.opts?.chest ?? null,
      carried: logsIn(this.d.inventory.slots),
      elapsedS: +elapsedS.toFixed(1),
      logsPerHour: elapsedS > 0 ? Math.round((s.deposited / elapsedS) * 3600) : 0,
      lastError: this.lastError ?? null,
      ...s,
    };
  }

  /** `key value` parts for !status. */
  statusLine(): Record<string, string | number> {
    const st = this.status();
    return {
      task: 'gather',
      state: this.state,
      logs: `${this.stats.deposited}/${this.opts?.target ?? 0}`,
      carried: st.carried as number,
      trees: this.stats.treesFelled,
      corrections: this.stats.corrections,
      deaths: this.stats.deaths,
    };
  }

  // ---- the loop ----------------------------------------------------------------------------------

  private end(gen: number, state: GatherState): GatherState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.stats.corrections = this.d.corrections() - this.c0;
    const s = this.status();
    this.log.info(
      `gather: ${state} after ${String(s.elapsedS)} s: ${this.stats.deposited} logs deposited (${String(s.logsPerHour)}/h), ${this.stats.logsBroken} broken, ` +
        `${this.stats.treesFelled} trees, ${this.stats.trips} trips, ${this.stats.corrections} corrections, ${this.stats.deaths} deaths${this.lastError ? ` (${this.lastError})` : ''}`,
    );
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private wake(): void {
    for (const fn of this.resumeFns.splice(0)) fn();
  }

  private waitResume(): Promise<void> {
    return new Promise((resolve) => this.resumeFns.push(resolve));
  }

  private alive(gen: number): boolean {
    return gen === this.gen;
  }

  private async run(gen: number): Promise<GatherState> {
    const o = this.opts!;
    const minFree = o.minFreeSlots ?? 2;
    let noTree = 0;
    let depositFailsInARow = 0;
    while (this.alive(gen)) {
      this.stats.corrections = this.d.corrections() - this.c0;
      if (this.paused) {
        await this.waitResume();
        continue;
      }
      if (!this.d.ready()) {
        this.state = 'waiting';
        await this.d.waitTicks(20);
        continue;
      }
      this.origin ??= this.d.position();
      const carried = logsIn(this.d.inventory.slots);
      const need = o.target - this.stats.deposited;
      if (!o.chest && carried >= o.target) {
        this.stats.deposited = carried;
        return this.end(gen, 'done');
      }
      if (o.chest && need <= 0) return this.end(gen, 'done');
      const full = this.d.inventory.freeSlots().length < minFree;
      if (full) this.stats.inventoryFull++;
      if (full && this.stash && !(o.chest && carried > 0)) {
        // Track AD: the stash step (chest, shulker box, drop junk); still full: the job ends
        if (await this.stash.ifFull({ label: 'gather', chest: o.chest, wanted: isLog })) continue;
        this.lastError = 'inventory full';
        return this.end(gen, 'failed');
      }
      if (o.chest && carried > 0 && (carried >= need || full)) {
        const ok = await this.depositTrip(gen, o.chest);
        if (!this.alive(gen)) break;
        if (!ok) {
          if (this.paused) continue;
          depositFailsInARow++;
          if (depositFailsInARow >= 3) {
            this.lastError = 'deposit failed 3 times in a row';
            return this.end(gen, 'failed');
          }
          await this.d.waitTicks(40);
        } else {
          depositFailsInARow = 0;
        }
        continue;
      }
      if (full && !o.chest) {
        this.lastError = 'inventory full and no chest';
        return this.end(gen, 'failed');
      }

      // Track AQ (collect/sweep.ts): logs lying within 8 blocks first (own drops left, the owner's dropped wood)
      if (this.d.entities && (await sweepItems((r, t, c) => this.d.skills.collect(r, t, c), isWoodDrop, { entities: this.d.entities, position: this.d.position }))?.pickedUp) continue;
      if (!this.alive(gen)) break;

      // find-tree
      this.state = 'find';
      const pos = this.d.position() ?? this.origin!;
      const trees = this.d.skills
        .findTrees(o.searchRadius ?? 48, { origin: this.origin ?? pos })
        .filter((t) => (this.treeFails.get(key(t.base)) ?? 0) < (o.treeAttempts ?? 2));
      if (trees.length === 0) {
        // Track Z: a remembered (or just far) forest
        const walk = await this.walkToForest(gen, pos, o);
        if (!this.alive(gen)) break;
        if (walk === 'walked' || walk === 'interrupted' || walk === 'failed') continue;
        noTree++;
        if (carried > 0 && o.chest) {
          await this.depositTrip(gen, o.chest);
          continue;
        }
        if (noTree >= (o.noTreeRounds ?? 5)) {
          this.lastError = `no trees within ${o.searchRadius ?? 48} blocks`;
          return this.end(gen, 'failed');
        }
        this.state = 'waiting';
        await this.d.waitTicks(100);
        continue;
      }
      noTree = 0;
      const dist = (t: Tree) => Math.hypot(t.base.x + 0.5 - pos.x, t.base.y - pos.y, t.base.z + 0.5 - pos.z);
      const tree = [...trees].sort((a, b) => dist(a) - dist(b))[0]!;

      // fell (the feller walks to the tree itself)
      this.state = 'fell';
      const f = await this.d.skills.fellTree(tree, { allowDig: o.allowDig });
      if (!this.alive(gen)) break;
      this.stats.logsBroken += f.broken.length;
      this.stats.repaths += f.repaths;
      this.stats.digFailures += f.digFailures;
      if (f.broken.length > 0) this.forest = undefined; // Track Z: the forest yielded logs
      if (f.ok) this.stats.treesFelled++;
      else if (f.reason !== 'interrupted') {
        this.stats.treesFailed++;
        this.treeFails.set(key(tree.base), (this.treeFails.get(key(tree.base)) ?? 0) + 1);
        this.log.warn(`gather: tree at ${key(tree.base)}: ${f.reason ?? 'failed'} (${f.left.length} logs left)`);
      }
      if (this.paused) continue;

      // collect
      this.state = 'collect';
      this.stats.collectRounds++;
      const saplingsBefore = this.saplings();
      const c = await this.d.skills.collect(o.collectRadius ?? 8, o.collectTicks ?? 300, {
        origin: { x: tree.base.x + 0.5, y: tree.base.y, z: tree.base.z + 0.5 },
        // a log on a ledge or caught in another canopy: one walk that may dig and place (decision 0051)
        hard: true,
        hardFilter: (i) => isLog(i.name),
      });
      if (!this.alive(gen)) break;
      this.stats.saplings += Math.max(0, this.saplings() - saplingsBefore);
      if (!c.ok && c.reason === 'inventory_full') this.stats.inventoryFull++;
    }
    return this.state;
  }

  private saplings(): number {
    let n = 0;
    for (const s of this.d.inventory.slots) if (s?.name.endsWith('_sapling')) n += s.count;
    return n;
  }

  /**
   * Track Z: no tree within the search radius. The cluster the last walk went to yielded nothing:
   * blacklist it. Then walk to the nearest log cluster (loaded farther away, or remembered by the
   * world cache) with an `any` goal near its nearest logs; the search continues from there.
   */
  private async walkToForest(gen: number, pos: Vec3, o: GatherOptions): Promise<'walked' | 'none' | 'failed' | 'interrupted'> {
    const f = this.forests;
    if (!f) return 'none';
    if (this.forest) {
      this.blacklistForest(this.forest, 'no tree found there');
      this.forest = undefined;
    }
    if (this.stats.forestWalks >= (o.maxForestWalks ?? 8)) return 'none';
    const cluster = f.clusters(pos, o.forestRadius ?? 256)[0];
    if (!cluster) return 'none';
    const members = cluster.logs.slice(0, 8).map((p) => ({ type: 'near' as const, p: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, r: 4 }));
    const c = cluster.center;
    this.log.info(
      `gather: no tree within ${o.searchRadius ?? 48} blocks; walking to a forest of ${cluster.logs.length} logs (${cluster.cached} remembered) ` +
        `at ${Math.round(c.x)} ${Math.round(c.y)} ${Math.round(c.z)}, ${cluster.distance.toFixed(0)} blocks away`,
    );
    this.state = 'find';
    const g = await this.d.skills.goto({ type: 'any', goals: members }, { timeoutTicks: 1200 + Math.round(cluster.distance * 20) });
    if (!this.alive(gen)) return 'interrupted';
    if (!g.ok && (g.reason === 'interrupted' || this.paused)) return 'interrupted';
    this.stats.forestWalks++;
    if (!g.ok) {
      this.blacklistForest(cluster, `walk: ${g.reason}`);
      return 'failed';
    }
    this.forest = cluster;
    this.origin = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) };
    return 'walked';
  }

  private blacklistForest(cluster: LogCluster, why: string): void {
    this.stats.forestsBlacklisted++;
    for (const p of cluster.logs) this.forests?.blacklist?.(p, why);
    const c = cluster.center;
    this.log.warn(`gather: forest at ${Math.round(c.x)} ${Math.round(c.y)} ${Math.round(c.z)} (${cluster.logs.length} logs) blacklisted: ${why}`);
  }

  /** goto chest -> open -> deposit logs -> close. */
  private async depositTrip(gen: number, chest: Vec3): Promise<boolean> {
    this.state = 'to_chest';
    this.stats.trips++;
    const g = await this.d.skills.goto({ type: 'near', p: { x: chest.x + 0.5, y: chest.y, z: chest.z + 0.5 }, r: 2 }, { timeoutTicks: 4000 });
    if (!this.alive(gen)) return false;
    if (!g.ok) {
      this.stats.depositFailures++;
      this.lastError = `goto chest: ${g.reason}`;
      this.log.warn(`gather: ${this.lastError}`);
      return false;
    }
    this.state = 'deposit';
    const o = await this.d.skills.open(chest);
    if (!this.alive(gen)) return false;
    if (!o.ok) {
      this.stats.depositFailures++;
      this.lastError = `open chest: ${o.reason}`;
      this.log.warn(`gather: ${this.lastError}`);
      return false;
    }
    const r = await this.d.skills.deposit(o.view, (i) => isLog(i.name));
    let moved = 0;
    for (const [name, n] of Object.entries(r.moved)) if (isLog(name)) moved += n;
    this.stats.deposited += moved;
    await this.d.skills.closeContainer(o.view);
    this.log.info(`gather: deposited ${moved} logs (${this.stats.deposited}/${this.opts?.target ?? 0})${r.ok ? '' : ` - ${r.reason}`}`);
    if (!r.ok) {
      this.stats.depositFailures++;
      this.lastError = `deposit: ${r.reason}`;
      return moved > 0;
    }
    return true;
  }
}

function newStats(): GatherStats {
  return {
    startedAt: undefined,
    finishedAt: undefined,
    deposited: 0,
    logsBroken: 0,
    treesFelled: 0,
    treesFailed: 0,
    trips: 0,
    depositFailures: 0,
    collectRounds: 0,
    inventoryFull: 0,
    corrections: 0,
    repaths: 0,
    digFailures: 0,
    deaths: 0,
    saplings: 0,
    forestWalks: 0,
    forestsBlacklisted: 0,
  };
}

/** Track Z: forests are searched in this vertical window around the bot (logs deep underground, e.g. an ancient city, are no forest). */
export const FOREST_MAX_BELOW = 24;
export const FOREST_MAX_ABOVE = 48;

/**
 * Track Z: the ForestFinder over a World (loaded logs and, with a world cache attached, remembered
 * ones; the cache is read at call time) and Track R's navigator blacklist (a blacklisted log is
 * skipped by the clusters and by BotSkills.findTrees).
 */
export function cachedForests(
  world: Parameters<typeof findLogClusters>[0],
  blacklist?: { blocked(p: Vec3): boolean; failBlock(p: Vec3, why?: string): boolean; has(key: string): boolean; failures: number },
): ForestFinder {
  return {
    clusters: (origin, radius) =>
      findLogClusters(world, origin, radius, { maxBelow: FOREST_MAX_BELOW, maxAbove: FOREST_MAX_ABOVE, ...(blacklist ? { skip: (p: Vec3) => blacklist.blocked(p) } : {}) }),
    blacklist: blacklist
      ? (p, why) => {
          // NavBlacklist skips a key after `failures` failures: count them all now (nothing to retry there)
          for (let i = 0; i < blacklist.failures && !blacklist.blocked(p); i++) blacklist.failBlock(p, why);
        }
      : undefined,
  };
}

/** Track Z: give the gather task of the afk task (`!gather`) the remembered forests (one call from tasks/registry.ts). */
export function useCachedForests(task: GatherWoodTask | undefined, world: Parameters<typeof findLogClusters>[0] | undefined, blacklist?: Parameters<typeof cachedForests>[1]): void {
  if (task && world) task.useForests(cachedForests(world, blacklist));
}

/** `x,y,z` or `x y z` -> block position. */
export function parseBlockPos(s: string | undefined): Vec3 | undefined {
  if (!s) return undefined;
  const parts = s.split(/[,\s]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, z] = parts as [number, number, number];
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

// ---- CLI task -------------------------------------------------------------------------------------

const GATHER_CLI: ParseArgsOptionsConfig = {
  'target-logs': { type: 'string' },
  chest: { type: 'string' },
  'search-radius': { type: 'string' },
  'exit-when-done': { type: 'boolean' },
  'allow-dig': { type: 'string' },
};

export const gatherTask: TaskDefinition = {
  name: 'gather',
  summary: 'gather wood: fell trees, collect logs, store them in a chest (!gather N, !gather stop)',
  defaultUsername: 'WoodBot',
  cliOptions: GATHER_CLI,
  usage: `  --target-logs <n>        start at once: put n logs into the chest (else wait for !gather N)
  --chest <x,y,z>          the chest (block position); !gather N x y z overrides it
  --search-radius <n>      tree search radius around the chest (default 48)
  --exit-when-done         disconnect and exit 0 when the target is reached (exit 1 on failure)
  --allow-dig <names>      blocks besides logs the feller may dig, comma list (default none)`,
  create(ctx: TaskContext): RunningTask {
    const log = ctx.logger('gather');
    const values = ctx.values;
    const cfg = ctx.taskConfig;
    const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const target = num(values['target-logs'] ?? cfg.targetLogs);
    const chestArg = (values.chest ?? cfg.chest) as string | Vec3 | undefined;
    let chest = typeof chestArg === 'string' ? parseBlockPos(chestArg) : chestArg;
    if (typeof chestArg === 'string' && !chest) throw new Error(`--chest must be x,y,z, got "${chestArg}"`);
    const radius = num(values['search-radius'] ?? cfg.searchRadius) ?? 48;
    if (target !== undefined && (!Number.isInteger(target) || target <= 0)) throw new Error(`--target-logs must be a positive integer`);
    const exitWhenDone = values['exit-when-done'] === true || cfg.exitWhenDone === true;
    const allowRaw = values['allow-dig'] ?? cfg.allowDig;
    const allowList = new Set((Array.isArray(allowRaw) ? allowRaw.map(String) : typeof allowRaw === 'string' ? allowRaw.split(',') : []).map((n) => n.trim().replace(/^minecraft:/, '')).filter(Boolean));
    const allowDig = allowList.size ? (name: string) => allowList.has(name) : undefined;

    const mob = ctx.mobility();
    const hotbar = new Hotbar(ctx.conn, { inventory: mob.world.inventory, runtimeId: () => mob.world.self.runtimeId });
    const containers = new Containers(ctx.conn, mob.world.inventory, { logger: log });
    mob.skills.attach({ hotbar, containers, source: ctx.conn });
    const respawn = ctx.respawn();
    const gather = new GatherWoodTask({
      skills: mob.skills,
      inventory: mob.world.inventory,
      position: () => mob.position(),
      ready: () => ctx.conn.state === 'spawned' && mob.loop.state.ready && !respawn.dead,
      waitTicks: (n) => (ctx.conn.state === 'spawned' ? mob.loop.waitTicks(n) : new Promise((r) => setTimeout(r, n * 50))),
      corrections: () => mob.loop.state.corrections,
      entities: () => mob.world.entities, // Track AQ: the floor sweep
      log,
    });
    gather.useForests(cachedForests(mob.world, mob.skills.nav.blacklist)); // Track Z: remembered forests
    respawn.onEvent((e) => {
      if (e.kind === 'death') gather.pause('dead');
    });
    respawn.afterRespawn(async (_feet, _death, signal) => {
      await mob.world.waitForChunks(2, { timeoutMs: 10_000 }).catch(() => undefined);
      await mob.loop.waitTicks(10);
      if (!signal.aborted) gather.resume();
    });
    const begin = (n: number, at: Vec3 | undefined) => {
      if (at) chest = at;
      void gather.start({ target: n, chest, searchRadius: radius, allowDig });
    };
    if (exitWhenDone) {
      gather.onDone((s) => {
        if (s === 'stopped') return;
        log.info(`gather ${s}; exiting (--exit-when-done)`);
        process.exitCode = s === 'done' ? 0 : 1;
        // index.ts finishes cleanly (disconnect, metrics) on SIGTERM; exit code 1 for a failure.
        setTimeout(() => {
          if (s === 'done') process.emit('SIGTERM', 'SIGTERM');
          else process.exit(1);
        }, 500);
      });
    }
    registerGatherCommands(ctx.chat, {
      start: (n, at) => {
        const c = at ?? chest;
        begin(n, at);
        return `gathering ${n} logs${c ? ` into the chest at ${c.x} ${c.y} ${c.z}` : ' (no chest: keeping them)'}`;
      },
      stop: () => {
        const was = gather.running;
        gather.stop();
        return was ? `stopped (${gather.stats.deposited} logs deposited)` : 'not gathering';
      },
      status: () => {
        const s = gather.status();
        return `gather: ${String(s.state)}, ${gather.stats.deposited}/${gather.opts?.target ?? 0} logs, carried ${String(s.carried)}, ${gather.stats.treesFelled} trees, ${String(s.elapsedS)} s`;
      },
    });
    let started = false;
    return {
      name: 'gather',
      start: () => {
        if (target !== undefined && !started) {
          started = true;
          begin(target, undefined);
        }
      },
      stop: () => {
        gather.stop();
        containers.dispose();
        hotbar.dispose();
        mob.dispose();
      },
      status: () => ({ ...gather.status(), skills: mob.skills.status().running ?? null, respawn: respawn.status() }),
      position: () => mob.position(),
      statusLine: () => gather.statusLine(),
      alive: () => !respawn.dead,
    };
  },
};
