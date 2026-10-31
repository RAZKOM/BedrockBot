// Legit mining (PLAN.md task 7.14, docs/mining.md): `!mine <block> [n]`.
//
//   targets   only blocks in the OreMemory (skills/mine/seen.ts): a face exposed to an open cell in
//             a loaded chunk, or next to a cell the bot dug. Buried blocks are never targets.
//   pick      the nearest seen target that the break safety rules allow (never next to water or
//             lava, never under sand or gravel, never the block under the feet: nav/actions.ts
//             breakBlocker); a target that failed 3 times is blacklisted for this run
//   approach  goto 'near' with the EYE within 3.5 blocks of the target's centre, `allowBreak` on;
//             the planned route may dig at most `tunnelLen()` blocks (default 32), checked on the
//             plan before walking
//   sight     the eye must see a face of the target; a solid block on the line of sight is dug first
//             (same safety rules), up to 3 of them
//   dig       Digger with requireHarvest (the right pickaxe tier from the hotbar), then collect the drop
//   stop      after n blocks, when no seen target is left, health < `minHealth` (8), no pickaxe in
//             the inventory for a block that needs one, or stop() (cancels the running skill at once)
//
// Lights nothing, places nothing (a pillar back up a shaft places throwaway blocks).
//
// Wave 10 Track AQ (mining v3, decision 0038; `mineDirect`, default on): before an approach a cheap walk
// probe (4 000 nodes / 300 ms, no digging); no walk, or one longer than 3 x the straight line + 8: a
// direct tunnel (tunnel.ts: staircase, or a shaft when it saves 8 blocks or more), every cell under the
// break rules, blocked = the ore is skipped with the reason at once. After the first block of a vein the
// whole group (vein.ts) is mined from where the bot stands, then every drop of it collected. Several kinds
// with quotas in one job (`kinds`, `ores`): the candidates are the kinds still below their quota, nearest
// first across kinds. Before each target the job's kind of items within 8 blocks is picked up
// (collect/sweep.ts). A run that tunnelled down walks (or pillars, or digs a staircase) back up at the end.
//
// Wave 11 Track BD (mining v4, docs/mining.md "Mining v4: MineProcess"; setting `mineMode`): in mode `baritone`
// the probe, the detour ratio and the straight tunnel planner are not used. Every candidate the memory knows
// (pruned by Baritone's rules, mine/baritone/mineProcess.ts) goes into ONE composite goal of Baritone's column
// goals and one goto with the dig moves (Track BC) finds the cheapest reachable ore by itself: tunnels,
// staircases and shafts fall out of the search. On arrival the reached ore is mined as before (sight digs,
// requireHarvest, the vein, the collect); a goto without a path blacklists the nearest candidate
// (blacklistClosestOnFailure); the candidates are pruned again every MINE_GOAL_UPDATE_TICKS on the way. With
// nothing known the job explores (branch mining) and resumes when the memory knows ore again, round after
// round, until n ("mine until n", both modes); `none_left` only when the explorer gives up.
import { blockMining, toolOf } from '../../data/mining.ts';
import { canHarvest } from '../dig/breakTime.ts'; // Track BD review: the harvest rule for ores the walk digs
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import type { AnyGoal, Goal, NavGoal } from '../nav/goals.ts';
import { closestDistance } from '../place/place.ts';
import { BLACKLIST_CLOSEST_ON_FAILURE, MINE_GOAL_UPDATE_TICKS, compositeOf, droppedItems, estimate, headingMember, memberAt, nearestCandidate, prune, type MineCandidate, type MineGoalContext, type PruneResult } from './baritone/mineProcess.ts'; // Track BD
import type { GotoOptions, SkillResult } from '../types.ts';
import { LIQUIDS, lineOfSight, type OreMemory, type SeenOre } from './seen.ts';
import { branchMore, branchRunOf } from './branch.ts'; // Track AI: branch mining when no target is known
import { pathBlocks } from '../home/reach.ts'; // Track AQ
import { sweepItems, SWEEP_RADIUS } from '../collect/sweep.ts'; // Track AQ
import type { EntityInfo } from '../../world/types.ts';
import { chooseTunnel, PILLAR_SPARE, planTunnel, runTunnel, type TunnelPlan, type TunnelWorld } from './tunnel.ts'; // Track AQ
import { oreKind, veinCentre, veinFrom, veinRadius } from './vein.ts'; // Track AQ
import { DEFAULT_JUNK } from '../survival/keeper.ts';

export type MineState = 'idle' | 'scan' | 'walk' | 'dig' | 'collect' | 'waiting' | 'paused' | 'done' | 'none_left' | 'low_health' | 'no_pickaxe' | 'stopped' | 'failed';

export interface MineOptions {
  /** Block name as typed (`coal_ore`, `coal`, `minecraft:iron_ore`). */
  block: string;
  /** Blocks to mine. Default 1. */
  count?: number;
  /** Scan radius around the bot. Default 32. */
  radius?: number;
  /** Stop when health drops below this. Default 8. */
  minHealth?: number;
  /** Failures before a target is blacklisted. Default 3. */
  attempts?: number;
  /**
   * Track AQ: several kinds in one trip, each with its quota (`!mine iron_ore 8 coal_ore 16`); `block` and
   * `count` are then the first kind and the sum. A kind named `ores` is every ore kind (one quota for all).
   */
  kinds?: { block: string; count: number }[];
}

/** Track AQ: one kind of a job and its quota. */
export interface MineQuota {
  /** `iron`, `coal`, `ores` */
  label: string;
  names: Set<string>;
  want: number;
  got: number;
}

/** Track AQ: a direct tunnel (or the climb back) of a run. */
export interface TunnelRecord {
  mode: 'stairs' | 'shaft' | 'climb';
  target: Vec3;
  planned: number;
  dug: number;
  placed?: number;
  ms: number;
  ok: boolean;
  why?: string;
}

/** Track AQ: one vein group. */
export interface VeinRecord {
  at: Vec3;
  size: number;
  mined: number;
  /** ms from the run's start of its first and last block. */
  firstMs: number;
  lastMs: number;
  collected: number;
}

export interface MineStats {
  startedAt: number | undefined;
  finishedAt: number | undefined;
  mined: number;
  /** Positions mined, in order. */
  minedAt: Vec3[];
  /** Every position chosen as a target (for the "buried never targeted" check). */
  targeted: Vec3[];
  /** Targets left out by the safety rules, with the rule. */
  unsafe: { p: Vec3; why: string }[];
  blacklisted: Vec3[];
  failures: number;
  /** Blocks dug on the way (navigator tunnels and line-of-sight blockers). */
  tunnelled: number;
  sightDigs: number;
  /** Walks next to a hole to pick up a drop the first collect did not reach. */
  pickupWalks: number;
  /** Bot ticks per target dig. */
  digTicks: number[];
  collected: Record<string, number>;
  scans: number;
  scanMs: number;
  buriedSeen: number;
  /** Track Z: targets skipped as unreachable after one plan (no route / no progress), and the probe plans made. */
  unreachable: Vec3[];
  /** Track Z: ms from the start of the run at which each of them was skipped. */
  unreachableMs: number[];
  /** Track Z: ms from the start of the run at which each block was mined. */
  minedMs: number[];
  probes: number;
  probeMs: number;
  /** Track AQ: direct tunnels, vein groups, ores skipped with the reason. */
  tunnels: TunnelRecord[];
  veins: VeinRecord[];
  skipped: { p: Vec3; why: string }[];
  /** Track BD: explore rounds (nothing known -> branch mining -> ore known again) and the blocks the explorer dug. */
  rounds: number;
  exploreBlocks: number;
  /** Track BD (mode baritone): composite gotos and their members in all, re-scans on the way, walks restarted after one, ores dug by the walk itself, gotos without a path (the nearest candidate blacklisted). */
  composites: number;
  compositeMembers: number;
  rescans: number;
  replans: number;
  walkDug: number;
  calcFailed: number;
}

/** Track BD: a target as the loop handles it (a memory record, or a composite member). */
export type MineTarget = Pick<SeenOre, 'p' | 'name'>;

export interface MinePlan {
  status: 'found' | 'partial' | 'none';
  path: readonly { act?: { dig?: readonly Vec3[] }; x?: number; z?: number; feet?: number }[];
  /** The search stopped at its node / time budget (a partial plan that may still lead there). */
  limited?: boolean;
}

/**
 * Track Z: the plan leads nowhere: no route at all, or a partial plan that does not leave the start
 * node (the navigator's "no progress possible", which it retries for about 3 s before giving up).
 */
export function noProgress(plan: MinePlan | undefined): boolean {
  return !plan || plan.status === 'none' || (plan.status !== 'found' && plan.path.length <= 1);
}

/** Track Z: candidates probed with a cheap bounded plan before one is chosen. */
export const PROBE_CANDIDATES = 3;

export interface MineSkills {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  cancel(): void;
  /** The navigator's report of the last goto (actions.dig counts its tunnel digs; segments 0 = it never moved; Track BD: `reached` = the member of an `any` goal the walk ended in). */
  status?(): { lastGoto?: { actions: { dig: number; place?: number }; segments?: number; reached?: { index: number } | undefined; plans?: readonly { status: string; noProgress?: boolean; unknown?: boolean }[] } | undefined };
}

export interface MineDeps {
  skills: MineSkills;
  memory: OreMemory;
  /** Plan only (Navigator.plan) with the given goto options: the tunnel-length check. */
  plan?: (goal: Goal, opts: GotoOptions) => MinePlan | undefined;
  /** Track Z: a cheap bounded plan (few thousand nodes) to rank candidates; default `plan`. */
  probe?: (goal: Goal, opts: GotoOptions) => MinePlan | undefined;
  /** Track Z: Track R's navigator blacklist; an unreachable ore goes on it at once. */
  blacklist?: { failBlock(p: Vec3, why?: string): boolean; blocked(p: Vec3): boolean; readonly failures?: number };
  /** Why the block at p may not be broken (nav/actions.ts breakBlocker), undefined when it may. */
  breakRule: (p: Vec3) => string | undefined;
  /** Feet height when the body can stand in cell (x, y, z), NaN / undefined when not (NavGrid.stand); for picking up drops. */
  stand?: (x: number, y: number, z: number) => number | undefined;
  blockAt: (p: Vec3) => BlockInfo | undefined;
  inventory: { readonly slots: readonly (ItemStack | null)[] };
  position: () => Vec3 | undefined;
  health: () => number;
  ready: () => boolean;
  waitTicks: (n: number) => Promise<void>;
  /** Setting `mineTunnelLen` (default 32), read for every target. */
  tunnelLen?: () => number;
  /**
   * Track Z: setting `mineSeenOnly` (default false), read at every scan. True: only blocks with a seen
   * open face are targets (the legit rule). False: every known matching block (buried ones of the
   * loaded chunks, the world cache's marks), tunnelling to it under the same safety rules.
   */
  seenOnly?: () => boolean;
  /** Track AQ: setting `mineDirect` (default true): direct tunnels after a cheap walk probe. */
  direct?: () => boolean;
  /** Track AQ: the walk probe (no digging, 4 000 nodes / 300 ms, sliced); without it every approach is a tunnel. */
  walkProbe?: (goal: Goal) => Promise<MinePlan | undefined>;
  /** Track AQ: the world model for the tunnel planner (without it no direct tunnels). */
  tunnelWorld?: TunnelWorld;
  /** Track AQ: throwaway blocks carried (a pillar back up a shaft). */
  throwaways?: () => number;
  /** Track AQ: the entities (the floor sweep's cheap check, drops left in holes). */
  entities?: () => ReadonlyMap<bigint, EntityInfo>;
  /** Track BD: setting `mineMode` (`v3` | `baritone`, default v3), read at every scan. */
  mode?: () => string;
  /** Track BD: ticks between re-scans of the candidates on the way (default MINE_GOAL_UPDATE_TICKS; 0 = none). */
  rescanTicks?: () => number;
  /** Track BD: ours, the shaft hazards under a candidate below the feet (mine/tunnel.ts shaftHazard); undefined = none. */
  belowRule?: (p: Vec3) => string | undefined;
  /** Track BD: the explore fallback with nothing known (one step per call, true = scan again); default branch mining (mine/branch.ts branchMore). */
  explore?: (task: MineTask) => Promise<boolean>;
  /** Track BD: blocks the explore fallback dug so far (the status line); default the branch run's count. */
  exploredBlocks?: () => number;
  log?: Logger;
  now?: () => number;
}

/** Track AQ: a walk longer than this factor x the straight line (+ WALK_SLACK) is a detour: tunnel instead. */
export const WALK_DETOUR = 3;
export const WALK_SLACK = 8;

/** Eye within this distance of the target's centre ends the approach. */
export const APPROACH_EYE_RANGE = 3.5;
/** Own dig reach used to decide whether to walk closer (the Digger's is 5). */
export const MINE_REACH = 4.6;

/** `coal` -> coal_ore + deepslate_coal_ore; `coal_ore` -> both; other names as they are (+ deepslate_ twin of an ore). */
export function resolveTargets(input: string): Set<string> {
  let n = input.trim().toLowerCase().replace(/^minecraft:/, '');
  if (n.startsWith('deepslate_') && n.endsWith('_ore')) n = n.slice('deepslate_'.length);
  const known = (x: string) => blockMining(x) !== undefined;
  if (!n.endsWith('_ore') && known(`${n}_ore`)) n = `${n}_ore`;
  const out = new Set([n]);
  if (n.endsWith('_ore') && known(`deepslate_${n}`)) out.add(`deepslate_${n}`);
  if (n === 'redstone_ore') out.add('lit_redstone_ore').add('lit_deepslate_redstone_ore');
  return out;
}

/** Track AQ: every ore kind (`!mine ores 32`, `!get ores 32`). */
export const ORE_BASES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald', 'nether_gold', 'nether_quartz'] as const;

/** Track AQ: the names of a kind as typed: `ores` = every ore, else resolveTargets. */
export function kindNames(input: string): Set<string> {
  const n = input.trim().toLowerCase().replace(/^minecraft:/, '');
  if (n === 'ores' || n === 'ore') {
    const out = new Set<string>();
    for (const b of ORE_BASES) for (const x of resolveTargets(`${b}_ore`)) if (blockMining(x) !== undefined) out.add(x);
    return out;
  }
  return resolveTargets(n);
}

/** Track AQ: `iron_ore` -> `iron`, `ores` -> `ores`. */
export function kindLabel(input: string): string {
  const n = input.trim().toLowerCase().replace(/^minecraft:/, '').replace(/^deepslate_/, '');
  return n === 'ores' || n === 'ore' ? 'ores' : n.replace(/_ore$/, '');
}

/** The block needs a pickaxe to drop anything. */
export function needsPickaxe(name: string): boolean {
  return blockMining(name)?.harvest?.types.includes('pickaxe') ?? false;
}

export function hasPickaxe(slots: readonly (ItemStack | null)[]): boolean {
  return slots.slice(0, 36).some((s) => !!s && s.count > 0 && s.name.endsWith('_pickaxe'));
}

/** Goal: the eye (feet + 1.62) within `r` of the block's centre. */
export function eyeGoal(p: Vec3, r = APPROACH_EYE_RANGE): Goal {
  return { type: 'near', p: { x: p.x + 0.5, y: p.y + 0.5 - EYE_HEIGHT, z: p.z + 0.5 }, r };
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

export class MineTask {
  readonly name = 'mine';
  state: MineState = 'idle';
  readonly stats: MineStats = newStats();
  opts: MineOptions | undefined;
  names = new Set<string>();
  private drops: ReadonlySet<string> = new Set(); // the job's pickup names (jobDropNames)
  lastError: string | undefined;
  private readonly d: MineDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private gen = 0;
  private readonly fails = new Map<string, number>();
  private readonly black = new Set<string>();
  /** Track BD: the feet cell (and the dig tallies) of the last composite goto that found no path at all, until one walks. */
  private calcFailedAt: string | undefined;
  /** Track Z: ores found unreachable (one plan without progress): skipped for the rest of the session. */
  private readonly unreachable = new Set<string>();
  private readonly doneFns = new Set<(s: MineState) => void>();
  private paused = false;
  /** Track AQ: the job's kinds and quotas; `active` the names of the kinds still below their quota. */
  quotas: MineQuota[] = [];
  private active = new Set<string>();
  /** Track AQ: the vein group being mined (`vein 3/5` in the status line). */
  vein: { done: number; size: number } | undefined;
  /** Track AQ: the feet cell where the run's first tunnel started (the way back up), and the deepest shaft. */
  private surface: Vec3 | undefined;
  private shaftDepth = 0;
  /** Track BD: the explore fallback runs (nothing known): its round; undefined while ore is known. */
  exploring: { round: number } | undefined;

  constructor(deps: MineDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return ['scan', 'walk', 'dig', 'collect', 'waiting', 'paused'].includes(this.state);
  }

  /** Track Z: pre-empted (process manager): cancel the running skill at once and hold the loop until resume(). */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.state = 'paused';
    this.d.skills.cancel();
    this.log.info('mine: paused');
  }

  /** Track Z: go on after pause() (a fresh scan picks the target again). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.log.info('mine: resumed');
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Track Z: ores skipped as unreachable this session. */
  get unreachableCount(): number {
    return this.unreachable.size;
  }

  start(opts: MineOptions): Promise<MineState> {
    const count = opts.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);
    this.gen++;
    this.paused = false; // a new job never inherits a pause (a stale one held the next !mine forever)
    this.d.skills.cancel();
    this.opts = { ...opts, count };
    // Track AQ: kinds and quotas (one for a plain `!mine <block> n`)
    const kinds = opts.kinds?.length ? opts.kinds : [{ block: opts.block, count }];
    this.quotas = kinds.map((k) => ({ label: kindLabel(k.block), names: kindNames(k.block), want: k.count, got: 0 }));
    if (opts.kinds?.length) this.opts.count = this.quotas.reduce((a, q) => a + q.want, 0);
    this.names = new Set(this.quotas.flatMap((q) => [...q.names]));
    this.drops = jobDropNames(this.names); // the sweeps pick up these too (sand, cobblestone, dirt ...), not only ore drops
    this.refreshActive();
    this.vein = undefined;
    this.surface = undefined;
    this.shaftDepth = 0;
    this.exploring = undefined; // Track BD
    this.d.memory.watch(this.names);
    Object.assign(this.stats, newStats());
    this.stats.startedAt = this.now();
    this.fails.clear();
    this.black.clear();
    this.calcFailedAt = undefined;
    this.lastError = undefined;
    this.state = 'scan';
    this.log.info(`mine: ${this.quotas.length > 1 ? this.quotaLine() : `${count} x ${[...this.names].join('/')}`}, tunnel cap ${this.tunnelLen()}, direct ${this.directOn() ? 'on' : 'off'}, mode ${this.modeOf()}`);
    const gen = this.gen;
    return this.run(gen)
      .then((s) => {
        // every end of the job logs its line and is a final state: a loop that left without end() (Realm
        // 2026-10-30: 'paused', no line, the process dropped) ends 'failed' here instead
        if (gen !== this.gen || !this.running) return s;
        this.lastError = `the loop left in state ${s}`;
        this.paused = false;
        return this.end(gen, 'failed');
      })
      .catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log.error(`mine: ${this.lastError}`);
        return this.end(gen, 'failed');
      });
  }

  stop(): void {
    if (!this.running) return;
    this.gen++;
    this.paused = false;
    this.d.skills.cancel();
    this.end(this.gen, 'stopped');
  }

  onDone(fn: (s: MineState) => void): () => void {
    this.doneFns.add(fn);
    return () => this.doneFns.delete(fn);
  }

  /** Track AQ: `iron 5/8, coal 16/16, diamond 0/4` (the quotas). */
  quotaLine(): string {
    return this.quotas.map((q) => `${q.label} ${q.got}/${q.want}`).join(', ');
  }

  private refreshActive(): void {
    this.active = new Set(this.quotas.filter((q) => q.got < q.want).flatMap((q) => [...q.names]));
  }

  /** Track AQ: the quota a mined block of `name` counts for (the first kind below its quota that has it). */
  private quotaOf(name: string): MineQuota | undefined {
    return this.quotas.find((q) => q.got < q.want && q.names.has(name));
  }

  /** Track AQ: direct tunnels on (`mineDirect`) and wired. */
  private directOn(): boolean {
    return (this.d.direct?.() ?? true) && !!this.d.tunnelWorld;
  }

  /** Track BD: the approach (setting `mineMode`): `baritone` = the composite goal, else `v3`. */
  modeOf(): 'baritone' | 'v3' {
    return this.d.mode?.() === 'baritone' ? 'baritone' : 'v3';
  }

  /** Track BD: `exploring (round 3, 420 blocks)` while the explore fallback runs, else undefined. */
  exploreLine(): string | undefined {
    return this.exploring ? `exploring (round ${this.exploring.round}, ${this.exploredBlocks()} blocks)` : undefined;
  }

  private exploredBlocks(): number {
    const n = this.d.exploredBlocks ? this.d.exploredBlocks() : (branchRunOf(this)?.stats.dug ?? 0);
    this.stats.exploreBlocks = Math.max(this.stats.exploreBlocks, n);
    return this.stats.exploreBlocks;
  }

  summary(): string {
    const explore = this.exploreLine();
    return `mine ${[...this.names][0] ?? '?'}: ${this.state}, ${this.stats.mined}/${this.opts?.count ?? 0} mined, ${this.stats.tunnelled} tunnelled, ${this.stats.blacklisted.length} skipped${this.modeOf() === 'baritone' ? ', mode baritone' : ''}${explore ? `, ${explore}` : ''}`;
  }

  status(): Record<string, unknown> {
    const s = this.stats;
    return { state: this.state, block: this.opts?.block ?? null, names: [...this.names], count: this.opts?.count ?? null, lastError: this.lastError ?? null, seen: this.d.memory.size, ...s, digTicks: undefined };
  }

  private tunnelLen(): number {
    const n = this.d.tunnelLen?.() ?? 32;
    return Number.isFinite(n) && n >= 0 ? n : 32;
  }

  private alive(gen: number): boolean {
    return gen === this.gen && !this.paused;
  }

  /** Track Z: unreachable after one plan: blacklisted for this run, skipped for the session, and on Track R's blacklist. */
  private markUnreachable(t: MineTarget, why: string): void {
    const k = key(t.p);
    if (!this.unreachable.has(k)) {
      this.unreachable.add(k);
      this.stats.unreachable.push({ ...t.p });
      this.stats.unreachableMs.push(this.now() - (this.stats.startedAt ?? this.now()));
    }
    this.blacklist(t.p);
    const bl = this.d.blacklist;
    if (bl) for (let i = 0; i < (bl.failures ?? 3) && !bl.blocked(t.p); i++) bl.failBlock(t.p, why);
    this.log.info(`mine: ${t.name} at ${fmt(t.p)}: unreachable (${why}); skipped for this session`);
  }

  private end(gen: number, state: MineState): MineState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.exploredBlocks(); // Track BD: the end line's count
    this.log.info(`${this.summary()}${this.lastError ? ` (${this.lastError})` : ''}`);
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private eye(): Vec3 | undefined {
    const p = this.d.position();
    return p ? { x: p.x, y: p.y + EYE_HEIGHT, z: p.z } : undefined;
  }

  private fail(t: MineTarget, why: string): void {
    const k = key(t.p);
    this.stats.failures++;
    const n = (this.fails.get(k) ?? 0) + 1;
    this.fails.set(k, n);
    this.log.info(`mine: ${t.name} at ${fmt(t.p)}: ${why} (${n})`);
    if (n >= (this.opts?.attempts ?? 3)) this.blacklist(t.p);
  }

  private blacklist(p: Vec3): void {
    if (this.black.has(key(p))) return;
    this.black.add(key(p));
    this.stats.blacklisted.push({ ...p });
  }

  private async run(gen: number): Promise<MineState> {
    const o = this.opts!;
    while (gen === this.gen) {
      if (this.paused) {
        this.state = 'paused';
        await this.d.waitTicks(5);
        continue;
      }
      if (!this.d.ready()) {
        this.state = 'waiting';
        await this.d.waitTicks(20);
        continue;
      }
      // own drops lying around (a diamond left in a hole, a drop that rolled): a short sweep before the next target
      // (Realm 2026-10-30: the bot walked past one of its own diamonds on the way to the next ore)
      await this.sweepDrops(gen, SWEEP_RADIUS, 200); // Track AQ: the job's kind within 8 blocks, one entity scan when none
      if (!this.alive(gen)) continue; // paused: the loop waits for resume() (Realm 2026-10-30: returning here ended the job); stopped: the loop ends
      if (this.stats.mined >= o.count!) {
        await this.sweepDrops(gen, 12, 200); // the job ends with every nearby drop picked up
        await this.pickupLeft(gen); // Track AQ: drops still lying in the holes of this run
        await this.returnUp(gen); // Track AQ
        if (!this.alive(gen)) continue; // paused: the loop waits for resume() (Realm 2026-10-30: returning here ended the job); stopped: the loop ends
        return this.end(gen, 'done');
      }
      if (this.d.health() < (o.minHealth ?? 8)) {
        this.lastError = `health ${this.d.health()}`;
        return this.end(gen, 'low_health');
      }
      this.state = 'scan';
      const pos = this.d.position();
      if (!pos) {
        await this.d.waitTicks(10);
        continue;
      }
      this.d.memory.scan(pos, o.radius ?? 32);
      this.stats.scans++;
      this.stats.scanMs += this.d.memory.lastScanMs;
      this.stats.buriedSeen = Math.max(this.stats.buriedSeen, this.d.memory.lastBuried);
      if (this.modeOf() === 'baritone') {
        // Track BD: every candidate into one composite goal; the planner picks the cheapest reachable one
        const pr = this.pruneNow(pos);
        if (pr.candidates.length === 0 && this.noTool && [...this.active].every((n) => !this.harvestable(n))) {
          // Track BD review: no carried tool harvests any kind the job still wants (v3: the dig's no_tool);
          // with one harvestable kind left the job explores for it instead
          this.lastError = `no tool in the inventory harvests ${this.noTool}`;
          return this.end(gen, 'no_pickaxe');
        }
        if (pr.candidates.length === 0) {
          const r = await this.nothingKnown(gen);
          if (r === 'continue') continue;
          return r;
        }
        this.exploring = undefined;
        const end = await this.mineComposite(gen, pos, pr.candidates);
        if (end) return this.end(gen, end);
        continue;
      }
      // the nearest safe candidates; Track Z: up to PROBE_CANDIDATES of them are probed with a cheap
      // bounded plan and the first that leads somewhere wins (no route / no progress: skipped at once)
      const cands: SeenOre[] = [];
      for (const t of this.d.memory.targets(this.active, pos, { seenOnly: this.d.seenOnly?.() ?? false })) {
        const k = key(t.p);
        if (this.black.has(k)) continue;
        if (this.unreachable.has(k) || this.d.blacklist?.blocked(t.p)) {
          this.blacklist(t.p);
          continue;
        }
        const why = this.d.breakRule(t.p);
        if (why) {
          this.stats.unsafe.push({ p: { ...t.p }, why });
          this.log.info(`mine: skipping ${t.name} at ${fmt(t.p)}: ${why}`);
          this.blacklist(t.p);
          continue;
        }
        cands.push(t);
        if (cands.length >= PROBE_CANDIDATES) break;
      }
      if (cands.length === 0) {
        // Track AI: no known target: branch mining (skills/mine/branch.ts); Track BD: round after round until n
        const r = await this.nothingKnown(gen);
        if (r === 'continue') continue;
        return r;
      }
      this.exploring = undefined; // Track BD: ore known again
      const target = this.directOn() ? cands[0] : this.pickReachable(cands); // Track AQ: the approach itself probes (walk or tunnel)
      if (!target) continue; // all probed candidates unreachable: the next scan takes the next ones
      if (needsPickaxe(target.name) && !hasPickaxe(this.d.inventory.slots)) {
        this.lastError = `no pickaxe for ${target.name}`;
        return this.end(gen, 'no_pickaxe');
      }
      this.stats.targeted.push({ ...target.p });
      const d = Math.hypot(target.p.x + 0.5 - pos.x, target.p.y + 0.5 - pos.y, target.p.z + 0.5 - pos.z);
      this.log.info(`mine: target ${target.name} at ${fmt(target.p)} (${target.how}, ${d.toFixed(1)} blocks; ${this.d.memory.size} seen, ${this.d.memory.recalled} remembered)`);
      await this.mineOne(gen, target);
    }
    return this.state;
  }

  /** Track Z: the first candidate that is in reach already or whose bounded plan leads somewhere; the others probed are marked unreachable. */
  private pickReachable(cands: SeenOre[]): SeenOre | undefined {
    const probe = this.d.probe ?? this.d.plan;
    let doubtful: SeenOre | undefined;
    for (const t of cands) {
      if (!probe) return t;
      const e = this.eye();
      if (e && closestDistance(e, t.p) <= MINE_REACH) return t;
      const t0 = performance.now();
      const plan = probe(eyeGoal(t.p), { allowBreak: true });
      this.stats.probes++;
      this.stats.probeMs += performance.now() - t0;
      if (!noProgress(plan)) return t;
      // no progress within the probe's budget: unreachable for sure when the search was not cut short;
      // otherwise only doubtful (the full plan decides), taken when no other candidate leads anywhere
      if (plan?.limited) doubtful ??= t;
      else this.markUnreachable(t, plan?.status === 'none' ? 'no route' : 'no progress possible');
    }
    return doubtful;
  }

  /** The approach before Track AQ (and with `mineDirect` off; the walk once the probe found one): a goto with dig-through, its plan checked against the tunnel cap. */
  private async approachWalk(gen: number, t: SeenOre): Promise<'ok' | 'skip'> {
    const sk = this.d.skills;
    const near = () => this.near(t.p);
    const seen = () => this.seen(t.p);
    for (const r of [APPROACH_EYE_RANGE, 1.6]) {
      const goal = eyeGoal(t.p, r);
      const opts: GotoOptions = { allowBreak: true, timeoutTicks: 2400 };
      if (this.d.plan) {
        const plan = this.d.plan(goal, opts);
        if (!plan || noProgress(plan)) {
          // Track Z: one plan that leads nowhere is enough (the navigator would retry it for seconds)
          if (r === APPROACH_EYE_RANGE && !near()) {
            this.markUnreachable(t, plan?.status === 'none' ? 'no route' : 'no progress possible');
            return 'skip';
          } // Track AD: in reach already (ore under the floor): dig the sight line instead
          break; // the closer approach is not possible: dig from where the first one ended
        }
        const digs = plan.path.reduce((a, n) => a + (n.act?.dig?.length ?? 0), 0);
        if (digs > this.tunnelLen()) {
          // a longer tunnel will not get shorter: skip it for this run
          this.blacklist(t.p);
          this.fail(t, `tunnel of ${digs} blocks > mineTunnelLen ${this.tunnelLen()}`);
          return 'skip';
        }
      }
      this.state = 'walk';
      const g = await sk.goto(goal, opts);
      if (!this.alive(gen)) return 'skip';
      const rep = sk.status?.().lastGoto;
      this.stats.tunnelled += rep?.actions.dig ?? 0;
      if (!g.ok) {
        if (g.reason === 'interrupted') return 'skip';
        // Track Z: the navigator never got a segment going: unreachable, not worth two more tries
        if (rep?.segments === 0) {
          this.markUnreachable(t, `goto: ${g.reason}, no segment`);
          return 'skip';
        }
        this.fail(t, `goto: ${g.reason}`);
        return 'skip';
      }
      if (near() && seen()) break;
      if (near()) break; // the sight step below digs the blockers
    }
    return 'ok';
  }

  private async mineOne(gen: number, t: SeenOre): Promise<void> {
    const blockAt = this.d.blockAt;
    const near = () => {
      const e = this.eye();
      return !!e && closestDistance(e, t.p) <= MINE_REACH;
    };
    const seen = () => {
      const e = this.eye();
      return !!e && lineOfSight(blockAt, e, t.p).clear;
    };
    // approach
    if (!(near() && seen())) {
      const a = this.directOn() ? await this.approachDirect(gen, t) : await this.approachWalk(gen, t);
      if (a !== 'ok' || !this.alive(gen)) return;
    }
    await this.takeOre(gen, t, false);
  }

  /**
   * The ore within reach: the sight digs, the dig with requireHarvest, the vein, the collect (the tail of
   * `mineOne`; Track BD: mode baritone's arrival too). `dugByWalk`: the planner's path may have dug the ore
   * itself (Baritone's column goals put the feet into its cell): an ore that is gone now counts as mined.
   */
  private async takeOre(gen: number, t: MineTarget, dugByWalk: boolean): Promise<void> {
    const sk = this.d.skills;
    const blockAt = this.d.blockAt;
    const near = () => {
      const e = this.eye();
      return !!e && closestDistance(e, t.p) <= MINE_REACH;
    };
    const seen = () => {
      const e = this.eye();
      return !!e && lineOfSight(blockAt, e, t.p).clear;
    };
    // Track Z: a target remembered by the cache (unloaded when chosen) is checked now that it is loaded
    const now = blockAt(t.p);
    if (!now) return this.fail(t, 'not loaded after the approach');
    if (now.name !== t.name) {
      if (dugByWalk && now.boxes.length === 0 && !LIQUIDS.has(now.name) && this.harvestable(t.name)) {
        // Track BD: the walk's own dig took it (the body stands in or under its cell): counted, its drop collected below
        this.stats.walkDug++;
        this.counted(t.p, t.name, undefined);
        this.log.info(`mine: ${t.name} at ${fmt(t.p)} dug by the walk`);
      } else {
        this.blacklist(t.p);
        return this.fail(t, `is ${now.name} now`);
      }
    } else {
      // line of sight: dig what is in the way (safety rules apply)
      for (let i = 0; i < 3 && !seen(); i++) {
        const e = this.eye();
        if (!e) return;
        const s = lineOfSight(blockAt, e, t.p);
        if (s.clear || !s.blocker) break;
        const why = this.d.breakRule(s.blocker);
        if (why) return this.fail(t, `line of sight blocked at ${fmt(s.blocker)} (${why})`);
        this.state = 'dig';
        const r = await sk.dig(s.blocker);
        if (!this.alive(gen)) return;
        if (!r.ok) return this.fail(t, `sight dig ${fmt(s.blocker)}: ${r.reason}`);
        this.stats.sightDigs++;
        this.stats.tunnelled++;
        this.d.memory.noteDug(s.blocker);
      }
      if (!near()) return this.fail(t, 'out of reach after the approach');
      if (!seen()) return this.fail(t, 'no line of sight');
      this.state = 'dig';
      const r = await sk.dig(t.p, { requireHarvest: true });
      if (!this.alive(gen)) return;
      if (!r.ok) {
        if (r.reason === 'no_tool') {
          this.lastError = `no tool in the hotbar harvests ${t.name}`;
          this.blacklist(t.p);
        }
        return this.fail(t, `dig: ${r.reason}`);
      }
      this.counted(t.p, t.name, r.ticks);
    }
    // Track AQ: the rest of the vein from here, then every drop of the group
    if (await this.mineVein(gen, t)) return;
    this.state = 'collect';
    const origin = { x: t.p.x + 0.5, y: t.p.y, z: t.p.z + 0.5 };
    // everything but the keeper's junk: the stash step throws that away (rotten flesh it dropped was picked up again at every ore)
    const notJunk = (i: ItemStack) => !DEFAULT_JUNK.includes(i.name);
    const c = await sk.collect(5, 120, { origin, near: 1.2, filter: notJunk, hard: true });
    this.addCollected(c.gained);
    this.log.info(`mine: ${t.name} at ${fmt(t.p)} mined, collect ${c.ok ? 'ok' : c.reason}: ${JSON.stringify(c.gained)}`); // Track AQ
    if (!this.alive(gen) || c.pickedUp > 0 || !this.d.stand) return;
    // The drop usually stays in the hole the ore left (in a wall: no cell to stand in next to it).
    // Stand on the floor right next to the hole, where the server's pickup reach covers it.
    if (!this.besideHole(t.p) && !this.itemsNear(t.p, 1.6)) return;
    this.stats.pickupWalks++;
    const g = await this.intoHole(gen, t.p); // Track AQ: digs the rock over the hole when there is no head room
    if (!this.alive(gen) || !g.ok) return;
    await this.d.waitTicks(15);
    const c2 = await sk.collect(4, 60, { origin, near: 1.2, filter: notJunk, hard: true });
    this.addCollected(c2.gained);
  }

  /** Pick up the job's kind of drops within `radius` (quick when none is there: one scan of the entities). */
  private async sweepDrops(gen: number, radius: number, ticks: number): Promise<void> {
    // Track AQ (collect/sweep.ts): one entity scan when nothing of the kind is near, no grace wait
    const ents = this.d.entities;
    const c = await sweepItems((r, t, o) => this.d.skills.collect(r, t, o), (n) => isJobDrop(this.drops, n), { radius, ticks, position: this.d.position, ...(ents ? { entities: ents } : {}) });
    if (c && this.alive(gen)) this.addCollected(c.gained);
  }

  private near(p: Vec3, reach = MINE_REACH): boolean {
    const e = this.eye();
    return !!e && closestDistance(e, p) <= reach;
  }

  private seen(p: Vec3): boolean {
    const e = this.eye();
    return !!e && lineOfSight(this.d.blockAt, e, p).clear;
  }

  /** Count a mined block: stats, the ore memory, its kind's quota. */
  private counted(p: Vec3, name: string, ticks: number | undefined): void {
    this.stats.mined++;
    this.stats.minedAt.push({ ...p });
    this.stats.minedMs.push(this.now() - (this.stats.startedAt ?? this.now()));
    if (ticks !== undefined) this.stats.digTicks.push(ticks);
    this.d.memory.noteDug(p);
    const q = this.quotaOf(name);
    if (q) {
      q.got++;
      if (q.got >= q.want) this.refreshActive();
    }
  }

  private skip(t: MineTarget, why: string): void {
    this.stats.skipped.push({ p: { ...t.p }, why });
    this.lastError = `${t.name} at ${fmt(t.p)}: ${why}`;
    this.markUnreachable(t, why);
  }

  private feetCell(): Vec3 | undefined {
    const p = this.d.position();
    return p ? cellOf(p) : undefined;
  }

  // ---- Track BD: nothing known -> explore, round after round ------------------------------------------------

  /**
   * Track BD (both modes): no candidate known. While the job is below n the explore fallback runs one step
   * (`explore`, default branch mining: mine/branch.ts `branchMore`, which digs one step of its layout and
   * returns true to scan again); the memory learning ore ends the round (the loop mines again) and the next
   * dead end starts round + 1. The explorer giving up (its own budget: `mineTunnelLen` blocks of tunnel
   * without a find, blocked, no pickaxe) ends the job `none_left` after the drop walk and the climb back.
   */
  private async nothingKnown(gen: number): Promise<'continue' | MineState> {
    if (await this.exploreMore()) return 'continue';
    await this.pickupLeft(gen); // Track AQ
    await this.returnUp(gen); // Track AQ
    if (!this.alive(gen)) return 'continue'; // paused: the loop waits for resume() (Realm 2026-10-30: returning here ended the job); stopped: the loop ends
    return this.end(gen, 'none_left');
  }

  private async exploreMore(): Promise<boolean> {
    const more = await (this.d.explore ? this.d.explore(this) : branchMore(this, this.d.skills));
    this.exploredBlocks();
    if (!more) {
      this.exploring = undefined;
      return false;
    }
    if (!this.exploring) {
      // Track BD review: a round counts once the explorer took a step (a refused branch run is no round)
      this.stats.rounds++;
      this.exploring = { round: this.stats.rounds };
      this.log.info(`mine: nothing known, ${this.stats.mined}/${this.opts?.count ?? 0} mined: exploring (round ${this.stats.rounds})`);
    }
    return true;
  }

  // ---- Track BD: mode baritone, the composite goal ----------------------------------------------------------

  private rescanTicks(): number {
    const n = this.d.rescanTicks?.() ?? MINE_GOAL_UPDATE_TICKS;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** The mine process' view of the world and the rules (mine/baritone/mineProcess.ts `MineGoalContext`). */
  private goalCtx(feet: Vec3): MineGoalContext {
    return {
      blockAt: (p) => this.d.blockAt(p),
      // without the under-feet rule (the tunnel planner's view): the dig-down move is the one move that digs the floor (Track BC)
      breakRule: (p) => (this.d.tunnelWorld ? this.d.tunnelWorld.breakRule(p) : this.d.breakRule(p)),
      ...(this.d.belowRule ? { belowRule: this.d.belowRule } : {}),
      names: this.active,
      feet,
      blocked: (p) => this.black.has(key(p)) || this.unreachable.has(key(p)) || !!this.d.blacklist?.blocked(p),
      exposedOnly: this.d.seenOnly?.() ?? false,
    };
  }

  /** Baritone `prune` over the memory's candidates (under `mineSeenOnly`) and the job's dropped items; the skipped ones reported once and blacklisted. */
  /** Track BD review: the last prune left out an ore of this name because no carried tool harvests it. */
  private noTool: string | undefined;

  /** Track BD review: a carried tool (or the hand) harvests the block `name` (dig/breakTime.ts `canHarvest`, the Digger's rule; the Digger's pullTool brings a main-inventory tool into the hotbar). */
  private harvestable(name: string): boolean {
    const b = blockMining(name);
    if (!b?.harvest) return true;
    if (canHarvest(b, null)) return true;
    return this.d.inventory.slots.slice(0, 36).some((it) => !!it && it.count > 0 && canHarvest(b, toolOf(it.name)));
  }

  private pruneNow(pos: Vec3): PruneResult {
    const feet = cellOf(pos);
    const seenOnly = this.d.seenOnly?.() ?? false;
    // Track BD review: an ore no carried tool harvests is no candidate (the planner's path would dig it for
    // nothing: the dig with requireHarvest refuses it in v3, the walk's own dig would not)
    this.noTool = undefined;
    const ores: MineCandidate[] = [];
    for (const t of this.d.memory.targets(this.active, pos, { seenOnly })) {
      if (!this.harvestable(t.name)) {
        this.noTool = t.name;
        continue;
      }
      ores.push({ kind: 'ore', p: t.p, name: t.name, ...(t.cached ? { cached: true } : {}) });
    }
    const drops = droppedItems(this.d.entities?.(), (n) => isJobDrop(this.drops, n), feet, this.opts?.radius ?? 32);
    const r = prune(this.goalCtx(feet), ores, drops);
    for (const s of r.skipped) {
      if (this.black.has(key(s.p))) continue;
      this.stats.unsafe.push({ p: { ...s.p }, why: s.why });
      this.log.info(`mine: skipping ${this.d.blockAt(s.p)?.name ?? '?'} at ${fmt(s.p)}: ${s.why}`);
      this.blacklist(s.p);
    }
    return r;
  }

  /**
   * One goto to the composite of every candidate (Baritone's GoalComposite of GoalThreeBlocks / GoalTwoBlocks /
   * GoalBlock), dig-through and the dig moves allowed (`allowPlace` for the dig-down move's way back; the
   * navigator drops it without throwaway blocks), planned in the worker when one is attached. On arrival the
   * reached member's ore is mined (`takeOre`) or the drop picked up; a goto that never got a segment going
   * blacklists the nearest candidate (Baritone `blacklistClosestOnFailure`, the whole composite being
   * "unreachable" otherwise); any other failure counts against the member the body headed for. Returns an end
   * state (no pickaxe) or undefined to go on.
   */
  private async mineComposite(gen: number, pos: Vec3, cands: MineCandidate[]): Promise<MineState | undefined> {
    const sk = this.d.skills;
    const feet = cellOf(pos);
    const hi = headingMember(cands, feet);
    const head = cands[hi];
    if (head?.kind === 'ore' && needsPickaxe(head.name) && !hasPickaxe(this.d.inventory.slots)) {
      this.lastError = `no pickaxe for ${head.name}`;
      return 'no_pickaxe';
    }
    if (cands.some((c) => c.p.y < feet.y)) this.surface ??= { ...feet }; // the way back up at the end (returnUp)
    const { goal, goals } = compositeOf(this.goalCtx(feet), cands);
    this.stats.composites++;
    this.stats.compositeMembers += cands.length;
    if (head) this.stats.targeted.push({ ...head.p });
    this.log.info(`mine: composite of ${cands.length}${head ? ` (nearest ${head.name} at ${fmt(head.p)}, ${estimate(feet, head.p).toFixed(0)} blocks; ${this.d.memory.size} seen, ${this.d.memory.recalled} remembered)` : ''}`);
    this.state = 'walk';
    // the ores of the composite as they are before the walk: a path into the column of one ore may dig
    // another on the way (e2e mine-baritone, the cave: 3 raw iron, 1 counted); those count as mined
    const before = cands.filter((c) => c.kind === 'ore' && this.d.blockAt(c.p)?.name === c.name);
    const r = await this.gotoComposite(gen, goal, cands);
    const rep = sk.status?.().lastGoto;
    const reached = r.result.ok && !r.restart ? (rep?.reached?.index ?? memberAt(goals, this.feetCell() ?? feet)) : -1;
    if (gen === this.gen && (rep?.actions.dig ?? 0) > 0) this.dugOnTheWay(before, reached >= 0 ? cands[reached] : undefined); // not after a stop (its end line is out)
    if (!this.alive(gen)) return undefined;
    this.stats.tunnelled += rep?.actions.dig ?? 0;
    if (r.restart) {
      this.stats.replans++;
      return undefined; // the candidates changed on the way: the loop prunes again
    }
    const g = r.result;
    if ((rep?.segments ?? 0) > 0) this.calcFailedAt = undefined;
    if (!g.ok) {
      if (g.reason === 'interrupted') return undefined;
      if (g.reason === 'blacklisted') {
        for (const c of cands) this.blacklist(c.p); // every member on Track R's blacklist already
        return undefined;
      }
      if (!rep || rep.segments === 0 || rep.plans?.at(-1)?.status === 'none') {
        // Baritone onTick `calcFailed` (any path calculation that failed, also after walking a while: e2e mine-cave,
        // two ores floating over the bot cost 3 failed gotos otherwise): no path to any of them: blacklist the presumably
        // unreachable closest one
        this.stats.calcFailed++;
        // a real "no path": the navigator gave up on an exhaustive search or a no-progress one over loaded world (not
        // a timeout, chunks still loading); the same cell with nothing dug since (a direct dig, a tunnel) repeats it
        const last = rep?.plans?.at(-1);
        const noPath = g.reason === 'unreachable' && !!last && (last.status === 'none' || (!!last.noProgress && !last.unknown));
        const at = noPath ? `${key(feet)}|${this.stats.mined}|${this.stats.tunnelled}` : undefined;
        if (at && this.calcFailedAt === at) {
          // the second in a row from the same cell: the search covered every member and went nowhere; one member
          // blacklisted per round spins (Realm 2026-10-31: 64 members, a round every 8 s for 15 minutes, the bot
          // never moved): all of them for this run, the next round takes other ores or explores
          this.calcFailedAt = undefined;
          for (const c of cands) this.blacklist(c.p);
          this.log.info(`mine: composite of ${cands.length}: no path again from ${fmt(feet)} (${g.reason}): all ${cands.length} skipped for this run`);
          return undefined;
        }
        this.calcFailedAt = at;
        const n = BLACKLIST_CLOSEST_ON_FAILURE ? nearestCandidate(feet, cands) : undefined;
        if (n) this.markUnreachable(n, `goto: ${g.reason}, no segment (closest of ${cands.length} blacklisted)`);
        else if (head) this.fail(head, `goto: ${g.reason}`);
        return undefined;
      }
      if (head) this.fail(head, `goto: ${g.reason}`);
      return undefined;
    }
    const idx = reached;
    const c = idx >= 0 ? cands[idx] : undefined;
    if (!c) {
      if (head) this.fail(head, 'arrived at no member of the composite');
      return undefined;
    }
    if (idx !== hi) this.stats.targeted.push({ ...c.p });
    if (c.kind === 'drop') {
      this.state = 'collect';
      const col = await sk.collect(2, 60, { origin: { x: c.p.x + 0.5, y: c.p.y, z: c.p.z + 0.5 }, near: 1.2, filter: (i) => isJobDrop(this.drops, i.name), hard: true });
      if (!this.alive(gen)) return undefined;
      this.addCollected(col.gained);
      // Track BD review: a drop goal that gives nothing counts as a failure (3 blacklist it), or the same goal comes back forever
      if (!Object.values(col.gained).some((v) => v > 0)) this.fail(c, 'drop not picked up');
      return undefined;
    }
    await this.takeOre(gen, { p: c.p, name: c.name }, (rep?.actions.dig ?? 0) > 0);
    return undefined;
  }

  /**
   * Ores of the composite the walk's own digs took on the way (open now, not a liquid), other than the member
   * it arrived at (`takeOre` counts that one): counted as mined (Baritone counts the inventory; ours counts
   * the cells), their drops left to the floor sweep.
   */
  private dugOnTheWay(before: readonly MineCandidate[], arrived: MineCandidate | undefined): void {
    for (const c of before) {
      if (arrived && key(arrived.p) === key(c.p)) continue;
      const b = this.d.blockAt(c.p);
      if (!b || b.boxes.length > 0 || LIQUIDS.has(b.name) || !this.active.has(c.name) || !this.harvestable(c.name)) continue;
      this.stats.walkDug++;
      this.counted(c.p, c.name, undefined);
      this.log.info(`mine: ${c.name} at ${fmt(c.p)} dug by the walk on the way`);
    }
  }

  /**
   * The composite goto with Baritone's rescan: every `rescanTicks` on the way the memory is scanned and the
   * candidates pruned again; when the member the body heads for (the lowest estimate from where it stands)
   * is not a candidate any more (mined, blacklisted, something else there) the walk is cancelled and
   * `restart` set (the loop builds a new composite). Nothing else re-plans: a new candidate waits for the
   * next loop (Baritone re-validates the whole goal every 5 ticks).
   */
  private async gotoComposite(gen: number, goal: AnyGoal, cands: readonly MineCandidate[]): Promise<{ result: SkillResult; restart: boolean }> {
    const sk = this.d.skills;
    let settled = false;
    let restart = false;
    const p = sk.goto(goal, { allowBreak: true, allowPlace: true, timeoutTicks: 2400 }).finally(() => {
      settled = true;
    });
    const every = this.rescanTicks();
    if (every > 0) {
      void (async () => {
        while (!settled && this.alive(gen)) {
          await this.d.waitTicks(every);
          if (settled || !this.alive(gen)) break;
          const pos = this.d.position();
          if (!pos) continue;
          this.d.memory.scan(pos, this.opts?.radius ?? 32);
          this.stats.scans++;
          this.stats.scanMs += this.d.memory.lastScanMs;
          this.stats.rescans++;
          const now = new Set(this.pruneNow(pos).candidates.map((c) => key(c.p)));
          const hi = headingMember(cands, cellOf(pos));
          const h = cands[hi];
          if (h && !now.has(key(h.p))) {
            this.log.info(`mine: ${h.name} at ${fmt(h.p)} is no candidate any more: re-planning`);
            restart = true;
            sk.cancel();
            break;
          }
        }
      })();
    }
    const result = await p;
    return { result, restart: restart && !result.ok && result.reason === 'interrupted' };
  }

  /**
   * Track AQ: the cheap walk probe first (no digging); a walk that exists and is no long detour is
   * walked (the approach before Track AQ, dig-through allowed); otherwise the direct tunnel.
   */
  private async approachDirect(gen: number, t: SeenOre): Promise<'ok' | 'skip' | 'ore'> {
    const pos = this.d.position();
    if (!pos) return 'skip';
    if (this.d.walkProbe) {
      const t0 = performance.now();
      const plan = await this.d.walkProbe(eyeGoal(t.p));
      this.stats.probes++;
      this.stats.probeMs += performance.now() - t0;
      if (!this.alive(gen)) return 'skip';
      if (plan?.status === 'found') {
        const straight = Math.hypot(t.p.x + 0.5 - pos.x, t.p.y + 0.5 - (pos.y + EYE_HEIGHT), t.p.z + 0.5 - pos.z);
        const nodes = plan.path.filter((n): n is { x: number; z: number; feet: number } => n.x !== undefined && n.z !== undefined && n.feet !== undefined);
        const len = nodes.length === plan.path.length ? pathBlocks(nodes) : 0;
        if (len <= WALK_DETOUR * straight + WALK_SLACK) return this.approachWalk(gen, t);
        this.log.info(`mine: ${t.name} at ${fmt(t.p)}: the walk is ${len.toFixed(0)} blocks for ${straight.toFixed(0)} straight: tunnelling`);
      }
    }
    return this.tunnelTo(gen, t);
  }

  /** Track AQ: plan the direct tunnel (staircase / shaft, the way back), dig it, or skip the ore with the reason. */
  private async tunnelTo(gen: number, t: SeenOre): Promise<'ok' | 'skip' | 'ore'> {
    const w = this.d.tunnelWorld!;
    const feet = this.feetCell();
    if (!feet) return 'skip';
    const t0 = this.now();
    const goal = { kind: 'ore' as const, p: t.p };
    const stairs = planTunnel(w, feet, goal, { mode: 'stairs', names: this.active });
    let shaft: TunnelPlan | undefined = t.p.y < feet.y ? planTunnel(w, feet, goal, { mode: 'shaft', names: this.active }) : undefined;
    let pillar = false;
    if (shaft?.ok && shaft.depth > 0) {
      // the way back up: a pillar (throwaway blocks for the depth + 4) or a staircase from the bottom
      const need = shaft.depth + PILLAR_SPARE;
      const have = this.d.throwaways?.() ?? 0;
      pillar = have >= need;
      if (!pillar) {
        const bottom = shaft.steps.at(-1)?.feet ?? feet;
        const climb = planTunnel(w, bottom, { kind: 'feet', p: feet }, { mode: 'stairs', opened: shaft.opened });
        if (!climb.ok) shaft = { ...shaft, ok: false, why: `no way back up (${have} of ${need} throwaway blocks; staircase: ${climb.why ?? 'blocked'})` };
      }
    }
    const plan = chooseTunnel(stairs, shaft);
    if (!plan.ok) {
      const why = plan.why ?? 'blocked';
      // a liquid next to the straight line: the walk planner's dig-through (same rules) may find a way around it
      if (why.includes('liquid') && !why.includes('_below') && this.d.plan) {
        this.log.info(`mine: ${t.name} at ${fmt(t.p)}: tunnel blocked (${why}): trying the dig-through walk`);
        const a = await this.approachWalk(gen, t);
        if (a === 'ok') return 'ok';
        if (!this.unreachable.has(key(t.p))) this.skip(t, `tunnel blocked: ${why}`);
        else this.stats.skipped.push({ p: { ...t.p }, why: `tunnel blocked: ${why}` });
        return 'skip';
      }
      this.skip(t, `tunnel blocked: ${why}`);
      return 'skip';
    }
    if (plan.dug > this.tunnelLen()) {
      this.blacklist(t.p);
      this.fail(t, `tunnel of ${plan.dug} blocks > mineTunnelLen ${this.tunnelLen()}`);
      return 'skip';
    }
    this.log.info(`mine: ${t.name} at ${fmt(t.p)}: ${plan.mode === 'shaft' ? `shaft ${plan.depth} deep${pillar ? ' (pillar back)' : ' (staircase back)'}` : 'staircase tunnel'}, ${plan.steps.length} steps, ${plan.dug} blocks`);
    if (plan.steps.length === 0) return plan.end === 'ore' ? 'ore' : 'ok';
    if (plan.steps.some((s) => s.feet.y < feet.y)) this.surface ??= { ...feet };
    if (plan.mode === 'shaft') this.shaftDepth = Math.max(this.shaftDepth, plan.depth);
    this.state = 'dig';
    const run = await runTunnel(
      {
        dig: (p, o) => this.d.skills.dig(p, o),
        goto: (g, o) => this.d.skills.goto(g, o),
        breakRule: (p) => w.breakRule(p),
        free: (p) => w.cell(p)?.open,
        position: () => this.d.position(),
        waitTicks: (n) => this.d.waitTicks(n),
        alive: () => this.alive(gen),
      },
      w,
      plan,
      (c) => {
        this.stats.tunnelled++;
        this.d.memory.noteDug(c);
      },
    );
    this.stats.tunnels.push({ mode: plan.mode, target: { ...t.p }, planned: plan.dug, dug: run.dug, ms: this.now() - t0, ok: run.ok, ...(run.why ? { why: run.why } : {}) });
    if (run.interrupted || !this.alive(gen)) return 'skip';
    if (!run.ok) {
      this.fail(t, `tunnel: ${run.why ?? 'failed'}`);
      return 'skip';
    }
    return plan.end === 'ore' ? 'ore' : 'ok';
  }

  /**
   * Track AQ: the rest of the vein of the block just mined at `t`, from where the bot stands (no re-plan
   * between blocks; a step into the mined cells when the next block is out of reach), while its kind's
   * quota is open; then every drop of the group. False when the block was alone (the caller collects).
   */
  private async mineVein(gen: number, t: MineTarget): Promise<boolean> {
    const kind = oreKind(t.name);
    const q0 = this.quotas.find((q) => q.names.has(t.name));
    const left = () => (q0 ? q0.want - q0.got : 0);
    const group = veinFrom(this.d.blockAt, t.p, kind).filter((p) => this.names.has(this.d.blockAt(p)?.name ?? ''));
    if (group.length === 0) return false;
    const sk = this.d.skills;
    const cells = [{ ...t.p }];
    const rec: VeinRecord = { at: { ...t.p }, size: group.length + 1, mined: 1, firstMs: this.stats.minedMs.at(-1) ?? 0, lastMs: this.stats.minedMs.at(-1) ?? 0, collected: 0 };
    this.stats.veins.push(rec);
    this.vein = { done: 1, size: rec.size };
    this.log.info(`mine: vein of ${rec.size} ${kind} at ${fmt(t.p)}`);
    let remaining = [...group];
    let steps = 0;
    let sights = 0;
    while (remaining.length > 0 && left() > 0 && this.alive(gen)) {
      const e = this.eye();
      if (!e) break;
      remaining.sort((a, b) => closestDistance(e, a) - closestDistance(e, b));
      const next = remaining.find((p) => this.near(p) && this.seen(p));
      if (!next) {
        const p = remaining[0]!;
        if (this.near(p) && sights < 2 * group.length) {
          // something between the eye and the block (a corner of the rock): dig it, same rules
          const s = lineOfSight(this.d.blockAt, e, p);
          const why = s.blocker ? this.d.breakRule(s.blocker) : 'no blocker';
          if (!s.blocker || why) {
            remaining = remaining.filter((x) => x !== p);
            continue;
          }
          this.state = 'dig';
          const r = await sk.dig(s.blocker);
          if (!this.alive(gen)) break;
          sights++;
          if (!r.ok) remaining = remaining.filter((x) => x !== p);
          else {
            this.stats.sightDigs++;
            this.stats.tunnelled++;
            this.d.memory.noteDug(s.blocker);
          }
          continue;
        }
        if (steps >= 4) break;
        // step into the mined cells towards it (no digging: the vein's own holes)
        steps++;
        this.state = 'walk';
        const g = await sk.goto(eyeGoal(p, APPROACH_EYE_RANGE), { allowBreak: false, timeoutTicks: 300 });
        if (!this.alive(gen)) break;
        if (!g.ok) break;
        continue;
      }
      remaining = remaining.filter((x) => x !== next);
      const b = this.d.blockAt(next);
      if (!b || !this.names.has(b.name) || this.d.breakRule(next)) continue;
      this.state = 'dig';
      const r = await sk.dig(next, { requireHarvest: true });
      if (!this.alive(gen)) break;
      if (!r.ok) {
        if (r.reason === 'no_tool') break;
        continue;
      }
      this.counted(next, b.name, r.ticks);
      cells.push(next);
      rec.mined++;
      rec.lastMs = this.stats.minedMs.at(-1) ?? rec.lastMs;
      this.vein = { done: rec.mined, size: rec.size };
    }
    // every drop of the group: one collect over it, then the holes whose drop is still there
    if (this.alive(gen)) {
      this.state = 'collect';
      const before = Object.values(this.stats.collected).reduce((a, n) => a + n, 0);
      const c = await sk.collect(veinRadius(cells) + 5, 300, { origin: veinCentre(cells), near: 1.2, filter: (i) => isJobDrop(this.drops, i.name), hard: true });
      this.addCollected(c.gained);
      for (const p of cells) {
        if (!this.alive(gen) || !this.itemsNear(p, 1.6)) continue;
        this.stats.pickupWalks++;
        const g = await this.intoHole(gen, p);
        if (!this.alive(gen)) break;
        if (g.ok) await this.d.waitTicks(10);
        const c2 = await sk.collect(4, 60, { origin: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, near: 1.2, filter: (i) => isJobDrop(this.drops, i.name), hard: true });
        this.addCollected(c2.gained);
      }
      rec.collected = Object.values(this.stats.collected).reduce((a, n) => a + n, 0) - before;
    }
    this.vein = undefined;
    return true;
  }

  /**
   * Track AQ: before the run ends, the holes of this run whose drop is still there (an item entity of the
   * mine's kind within 1.6 blocks): walk into the hole (the planner may dig the head room, same rules),
   * wait for the pickup. The last block's drop may arrive a moment after its block update: a short collect
   * with the grace wait first.
   */
  private async pickupLeft(gen: number): Promise<void> {
    if (!this.d.entities || this.stats.minedAt.length === 0) return;
    const c = await this.d.skills.collect(6, 60, { filter: (i) => isJobDrop(this.drops, i.name) });
    if (!this.alive(gen)) return;
    this.addCollected(c.gained);
    const pos = this.d.position();
    for (const p of this.stats.minedAt.slice(-16)) {
      if (!this.alive(gen) || !pos || Math.hypot(p.x + 0.5 - pos.x, p.y - pos.y, p.z + 0.5 - pos.z) > 24 || !this.itemsNear(p, 1.6)) continue;
      this.stats.pickupWalks++;
      this.state = 'collect';
      const g = await this.intoHole(gen, p);
      if (!this.alive(gen)) return;
      if (g.ok) await this.d.waitTicks(10);
      const c2 = await this.d.skills.collect(4, 60, { origin: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, near: 1.2, filter: (i) => isJobDrop(this.drops, i.name), hard: true });
      this.addCollected(c2.gained);
      this.log.info(`mine: drop left at ${fmt(p)}: ${g.ok ? 'walked there' : g.reason}, picked up ${JSON.stringify(c2.gained)}`);
    }
  }

  /**
   * Track AQ: stand beside or in the hole at p (a drop lies there). The hole of an ore in a tunnel wall
   * often has rock over it (no head room to step in): that block is dug first when the rules allow it
   * and it is in reach, then the walk is tried again.
   */
  private async intoHole(gen: number, p: Vec3): Promise<SkillResult> {
    const sk = this.d.skills;
    let g = await sk.goto({ type: 'block', p: this.besideHole(p) ?? p }, { allowBreak: true, timeoutTicks: 400 });
    if (g.ok || !this.alive(gen)) return g;
    // Head room for the hole: the body needs the two cells above the hole floor open, and a 1-high pocket under a
    // roof cannot be entered from the side either (get-front on main, 2026-10-30: a 2 x 2 coal vein under a 1-thick
    // stone layer under grass left 4 drops in 1-high pockets; the planner searched 250 000 nodes for a cell 1 block
    // away). Dig what is over the hole, 1 and 2 above, when the rules allow and it is in reach, then walk in.
    let dug = false;
    for (const dy of [1, 2]) {
      const over = { x: p.x, y: p.y + dy, z: p.z };
      const b = this.d.blockAt(over);
      if (!b || b.boxes.length === 0 || this.d.breakRule(over) || !this.near(over)) continue;
      const r = await sk.dig(over);
      if (!this.alive(gen)) return g;
      if (!r.ok) break;
      dug = true;
      this.stats.tunnelled++;
      this.d.memory.noteDug(over);
    }
    if (dug) g = await sk.goto({ type: 'block', p }, { allowBreak: true, timeoutTicks: 400 });
    return g;
  }

  /** Item entities of the mine's kind within `r` of the centre of cell p. */
  private itemsNear(p: Vec3, r: number): number {
    const ents = this.d.entities?.();
    if (!ents) return 0;
    let n = 0;
    for (const e of ents.values()) if (e.type === 'minecraft:item' && e.item && isJobDrop(this.drops, e.item.name) && Math.hypot(e.pos.x - (p.x + 0.5), e.pos.y - (p.y + 0.5), e.pos.z - (p.z + 0.5)) <= r) n++;
    return n;
  }

  /**
   * Track AQ: the run tunnelled down: back to where its first tunnel started. A walk (the staircases are
   * climbable), a pillar up a shaft with throwaway blocks, or a staircase dug up from the bottom.
   */
  private async returnUp(gen: number): Promise<void> {
    const top = this.surface;
    const pos = this.d.position();
    if (!top || !pos || pos.y >= top.y - 1.5 || branchRunOf(this)) return;
    const t0 = this.now();
    const have0 = this.d.throwaways?.() ?? 0;
    const sk = this.d.skills;
    let dug = 0;
    this.state = 'walk';
    this.log.info(`mine: back up to ${fmt(top)}`);
    let g = await sk.goto({ type: 'block', p: top }, { allowBreak: false, allowPlace: false, timeoutTicks: 1200 });
    if (!this.alive(gen)) return;
    if (!g.ok && have0 > 0) {
      g = await sk.goto({ type: 'block', p: top }, { allowBreak: false, allowPlace: true, timeoutTicks: 2400 });
      if (!this.alive(gen)) return;
    }
    if (!g.ok && this.d.tunnelWorld) {
      const w = this.d.tunnelWorld;
      const feet = this.feetCell();
      if (feet) {
        const climb = planTunnel(w, feet, { kind: 'feet', p: top }, { mode: 'stairs' });
        if (climb.ok) {
          this.state = 'dig';
          const r = await runTunnel(
            { dig: (p, o) => sk.dig(p, o), goto: (gl, o) => sk.goto(gl, o), breakRule: (p) => w.breakRule(p), free: (p) => w.cell(p)?.open, position: () => this.d.position(), waitTicks: (n) => this.d.waitTicks(n), alive: () => this.alive(gen) },
            w,
            climb,
            (c) => {
              this.stats.tunnelled++;
              this.d.memory.noteDug(c);
            },
          );
          dug = r.dug;
          if (!this.alive(gen)) return;
          if (r.ok) g = await sk.goto({ type: 'block', p: top }, { allowBreak: true, allowPlace: false, timeoutTicks: 1200 });
        } else this.log.info(`mine: no staircase back up: ${climb.why ?? 'blocked'}`);
      }
    }
    const placed = Math.max(0, have0 - (this.d.throwaways?.() ?? 0));
    this.stats.tunnels.push({ mode: 'climb', target: { ...top }, planned: 0, dug, placed, ms: this.now() - t0, ok: g.ok, ...(g.ok ? {} : { why: g.reason ?? 'failed' }) });
    if (g.ok) this.surface = undefined;
  }

  private addCollected(gained: Record<string, number>): void {
    for (const [k, v] of Object.entries(gained)) if (v > 0) this.stats.collected[k] = (this.stats.collected[k] ?? 0) + v;
  }

  /** A standable cell horizontally next to the (now open) cell `p`, at its height or up to 2 below, nearest to the bot. */
  private besideHole(p: Vec3): Vec3 | undefined {
    const pos = this.d.position();
    let best: Vec3 | undefined;
    let bestD = Infinity;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const dy of [0, -1, -2]) {
        const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
        const f = this.d.stand?.(q.x, q.y, q.z);
        if (f === undefined || !Number.isFinite(f)) continue;
        const d = pos ? Math.hypot(q.x + 0.5 - pos.x, f - pos.y, q.z + 0.5 - pos.z) : 0;
        if (d < bestD) {
          bestD = d;
          best = q;
        }
        break;
      }
    }
    return best;
  }
}

function newStats(): MineStats {
  return {
    startedAt: undefined,
    finishedAt: undefined,
    mined: 0,
    minedAt: [],
    targeted: [],
    unsafe: [],
    blacklisted: [],
    failures: 0,
    tunnelled: 0,
    sightDigs: 0,
    pickupWalks: 0,
    digTicks: [],
    collected: {},
    scans: 0,
    scanMs: 0,
    buriedSeen: 0,
    unreachable: [],
    unreachableMs: [],
    minedMs: [],
    probes: 0,
    probeMs: 0,
    tunnels: [],
    veins: [],
    skipped: [],
    rounds: 0,
    exploreBlocks: 0,
    composites: 0,
    compositeMembers: 0,
    rescans: 0,
    replans: 0,
    walkDug: 0,
    calcFailed: 0,
  };
}

function fmt(p: Vec3): string {
  return `${p.x} ${p.y} ${p.z}`;
}

function cellOf(p: Vec3): Vec3 {
  return { x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) };
}

/** What a mining job picks up on sight: ore drops, raw metals, gems and the ore blocks themselves (silk touch). */
const MINE_DROPS = new Set(['diamond', 'emerald', 'coal', 'charcoal', 'raw_iron', 'raw_copper', 'raw_gold', 'redstone', 'lapis_lazuli', 'quartz', 'ancient_debris', 'gold_nugget', 'amethyst_shard', 'flint']);
export function isMineDrop(name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return MINE_DROPS.has(n) || n.endsWith('_ore');
}

/** What a plain block drops when mined without silk touch (the block itself when not listed). `!get sand 256` left every sand item on the floor: the sweeps only knew ore drops. */
const BLOCK_DROPS: Record<string, readonly string[]> = {
  stone: ['cobblestone'], deepslate: ['cobbled_deepslate'], grass_block: ['dirt'], dirt_with_roots: ['dirt'], podzol: ['dirt'], mycelium: ['dirt'],
  gravel: ['gravel', 'flint'], clay: ['clay_ball'], snow: ['snowball'], glowstone: ['glowstone_dust'], sea_lantern: ['prismarine_crystals'],
  bookshelf: ['book'], melon_block: ['melon_slice'], stone_bricks: ['stone_bricks'], end_stone: ['end_stone'], netherrack: ['netherrack'], blackstone: ['blackstone'],
};
/** The item names a job for these block kinds picks up: the ore drops plus each kind and what it drops. */
export function jobDropNames(blockNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of blockNames) {
    const n = raw.startsWith('minecraft:') ? raw.slice(10) : raw;
    out.add(n);
    for (const d of BLOCK_DROPS[n] ?? []) out.add(d);
  }
  return out;
}
export function isJobDrop(jobDrops: ReadonlySet<string>, name: string): boolean {
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return isMineDrop(n) || jobDrops.has(n);
}
