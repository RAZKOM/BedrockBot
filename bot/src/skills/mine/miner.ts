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
// Lights nothing, places nothing.
import { blockMining } from '../../data/mining.ts';
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import type { Goal } from '../nav/goals.ts';
import { closestDistance } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { lineOfSight, type OreMemory, type SeenOre } from './seen.ts';

export type MineState = 'idle' | 'scan' | 'walk' | 'dig' | 'collect' | 'waiting' | 'done' | 'none_left' | 'low_health' | 'no_pickaxe' | 'stopped' | 'failed';

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
}

export interface MinePlan {
  status: 'found' | 'partial' | 'none';
  path: readonly { act?: { dig?: readonly Vec3[] } }[];
}

export interface MineSkills {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  cancel(): void;
  /** The navigator's report of the last goto (actions.dig counts its tunnel digs). */
  status?(): { lastGoto?: { actions: { dig: number } } | undefined };
}

export interface MineDeps {
  skills: MineSkills;
  memory: OreMemory;
  /** Plan only (Navigator.plan) with the given goto options: the tunnel-length check. */
  plan?: (goal: Goal, opts: GotoOptions) => MinePlan | undefined;
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
  log?: Logger;
  now?: () => number;
}

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
  lastError: string | undefined;
  private readonly d: MineDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private gen = 0;
  private readonly fails = new Map<string, number>();
  private readonly black = new Set<string>();
  private readonly doneFns = new Set<(s: MineState) => void>();

  constructor(deps: MineDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return ['scan', 'walk', 'dig', 'collect', 'waiting'].includes(this.state);
  }

  start(opts: MineOptions): Promise<MineState> {
    const count = opts.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new Error(`count must be a positive integer, got ${count}`);
    this.gen++;
    this.d.skills.cancel();
    this.opts = { ...opts, count };
    this.names = resolveTargets(opts.block);
    this.d.memory.watch(this.names);
    Object.assign(this.stats, newStats());
    this.stats.startedAt = this.now();
    this.fails.clear();
    this.black.clear();
    this.lastError = undefined;
    this.state = 'scan';
    this.log.info(`mine: ${count} x ${[...this.names].join('/')}, tunnel cap ${this.tunnelLen()}`);
    const gen = this.gen;
    return this.run(gen).catch((e: unknown) => {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.error(`mine: ${this.lastError}`);
      return this.end(gen, 'failed');
    });
  }

  stop(): void {
    if (!this.running) return;
    this.gen++;
    this.d.skills.cancel();
    this.end(this.gen, 'stopped');
  }

  onDone(fn: (s: MineState) => void): () => void {
    this.doneFns.add(fn);
    return () => this.doneFns.delete(fn);
  }

  summary(): string {
    return `mine ${[...this.names][0] ?? '?'}: ${this.state}, ${this.stats.mined}/${this.opts?.count ?? 0} mined, ${this.stats.tunnelled} tunnelled, ${this.stats.blacklisted.length} skipped`;
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
    return gen === this.gen;
  }

  private end(gen: number, state: MineState): MineState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.log.info(`${this.summary()}${this.lastError ? ` (${this.lastError})` : ''}`);
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private eye(): Vec3 | undefined {
    const p = this.d.position();
    return p ? { x: p.x, y: p.y + EYE_HEIGHT, z: p.z } : undefined;
  }

  private fail(t: SeenOre, why: string): void {
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
    while (this.alive(gen)) {
      if (!this.d.ready()) {
        this.state = 'waiting';
        await this.d.waitTicks(20);
        continue;
      }
      if (this.stats.mined >= o.count!) return this.end(gen, 'done');
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
      let target: SeenOre | undefined;
      for (const t of this.d.memory.targets(this.names, pos)) {
        if (this.black.has(key(t.p))) continue;
        const why = this.d.breakRule(t.p);
        if (why) {
          this.stats.unsafe.push({ p: { ...t.p }, why });
          this.log.info(`mine: skipping ${t.name} at ${fmt(t.p)}: ${why}`);
          this.blacklist(t.p);
          continue;
        }
        target = t;
        break;
      }
      if (!target) return this.end(gen, 'none_left');
      if (needsPickaxe(target.name) && !hasPickaxe(this.d.inventory.slots)) {
        this.lastError = `no pickaxe for ${target.name}`;
        return this.end(gen, 'no_pickaxe');
      }
      this.stats.targeted.push({ ...target.p });
      await this.mineOne(gen, target);
    }
    return this.state;
  }

  private async mineOne(gen: number, t: SeenOre): Promise<void> {
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
    // approach
    if (!(near() && seen())) {
      for (const r of [APPROACH_EYE_RANGE, 1.6]) {
        const goal = eyeGoal(t.p, r);
        const opts: GotoOptions = { allowBreak: true, timeoutTicks: 2400 };
        if (this.d.plan) {
          const plan = this.d.plan(goal, opts);
          if (!plan || plan.status === 'none') return this.fail(t, 'unreachable (no route)');
          const digs = plan.path.reduce((a, n) => a + (n.act?.dig?.length ?? 0), 0);
          if (digs > this.tunnelLen()) {
            // a longer tunnel will not get shorter: skip it for this run
            this.blacklist(t.p);
            return this.fail(t, `tunnel of ${digs} blocks > mineTunnelLen ${this.tunnelLen()}`);
          }
        }
        this.state = 'walk';
        const g = await sk.goto(goal, opts);
        if (!this.alive(gen)) return;
        this.stats.tunnelled += sk.status?.().lastGoto?.actions.dig ?? 0;
        if (!g.ok) {
          if (g.reason !== 'interrupted') this.fail(t, `goto: ${g.reason}`);
          return;
        }
        if (near() && seen()) break;
        if (near()) break; // the sight step below digs the blockers
      }
    }
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
    this.stats.mined++;
    this.stats.minedAt.push({ ...t.p });
    if (r.ticks !== undefined) this.stats.digTicks.push(r.ticks);
    this.d.memory.noteDug(t.p);
    this.state = 'collect';
    const origin = { x: t.p.x + 0.5, y: t.p.y, z: t.p.z + 0.5 };
    const c = await sk.collect(5, 120, { origin, near: 1.2 });
    this.addCollected(c.gained);
    if (!this.alive(gen) || c.pickedUp > 0 || !this.d.stand) return;
    // The drop usually stays in the hole the ore left (in a wall: no cell to stand in next to it).
    // Stand on the floor right next to the hole, where the server's pickup reach covers it.
    const spot = this.besideHole(t.p);
    if (!spot) return;
    this.stats.pickupWalks++;
    const g = await sk.goto({ type: 'block', p: spot }, { timeoutTicks: 400 });
    if (!this.alive(gen) || !g.ok) return;
    await this.d.waitTicks(15);
    const c2 = await sk.collect(4, 60, { origin, near: 1.2 });
    this.addCollected(c2.gained);
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
  };
}

function fmt(p: Vec3): string {
  return `${p.x} ${p.y} ${p.z}`;
}
