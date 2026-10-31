// Branch mining (wave 9, Track AI; docs/mining.md "Branch mining", docs/decisions/0030): what
// `!mine <ore> n` does when it knows no target of a mineable ore. The miner's loop (miner.ts) calls
// `branchMore(task, skills)` at the one place where it would end `none_left`; each call digs one more
// step of the layout below and returns true (scan again: the normal mine loop mines what the new
// cells exposed or brought into the scan), or false (nothing more to dig: the run ends `none_left`).
//
//   staircase  from where the bot stands to the ore's best Y (`mineBranchY auto`, BRANCH_Y below, or a
//              number), one block down (or up) per step, 2 high plus the step's head room (3 cells per
//              step), never straight down; a step blocked by the dig rules turns right, then left
//   main       a 2-high tunnel at that Y in the staircase's direction (blocked: turns right / left)
//   branches   every 3 blocks of main tunnel one branch to each side, 2 high, up to 16 long; a branch
//              blocked by the dig rules ends there
//   dig rules  the navigator's (nav/actions.ts breakBlocker): no cell next to water or lava, nothing
//              under sand / gravel, never the block under the feet, nothing protected; every new feet
//              cell needs a solid dry floor
//   stop       n ore mined (the miner), `mineTunnelLen` blocks of tunnel at the ore's Y without a find,
//              health below 10, no pickaxe, a layout blocked on every side
//   torches    with `allowPlace` on and torches carried: one on the floor every 8 blocks of tunnel
//   drops      an ore's drop the miner's collect left in its hole (a hole in a 1-wide tunnel wall is
//              no cell to stand in): the bot walks into the hole cell (the planner digs the head room)
//   end        the host walks back to the surface (the staircase's top) and home (`returnUp`), through
//              the holes whose drops are still there
//
// The layout lives in absolute coordinates, so the run picks up where it was after the miner walked
// off to an ore, after a pre-emption (guard, flee, night, the stash step) or a `!pause`.
import type { Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import type { Goal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import type { MineState } from './miner.ts';
import { clearStep, flatStep, stairStep, type Dir, type Step } from './tunnel.ts'; // Track AQ: one step primitive for the staircase and the direct tunnels

export { flatStep, stairStep, type Dir, type Step } from './tunnel.ts';

/** A pickaxe anywhere in the inventory (miner.ts hasPickaxe, repeated here so the two modules do not import each other's values). */
export function carriesPickaxe(slots: readonly (ItemStack | null)[]): boolean {
  return slots.slice(0, 36).some((s) => !!s && s.count > 0 && s.name.endsWith('_pickaxe'));
}

/**
 * Best Y per ore (vanilla 1.18+ ore distribution as of 1.21: the peak of each ore's triangular
 * distribution, or the bottom of a uniform / skewed one where most of it lies; docs/explore.md has the table and sources).
 */
export const BRANCH_Y: Readonly<Record<string, number>> = {
  coal: 40,
  iron: 16,
  copper: 48,
  gold: -16,
  redstone: -58,
  lapis: 0,
  diamond: -58,
  emerald: 232,
};

/** Emerald ore exists in mountain biomes only; the bot counts as "in the mountains" when it stands at or above this Y. */
export const EMERALD_MIN_FEET = 232;
/** A side branch is this long at most. */
export const BRANCH_LEN = 16;
/** Blocks of main tunnel between two branch pairs. */
export const BRANCH_EVERY = 3;
/** Stop below this health (then the host walks home). */
export const BRANCH_MIN_HEALTH = 10;
/** A torch every this many blocks of tunnel. */
export const TORCH_EVERY = 8;
/** A torch anywhere in the inventory (Track BK: shared with !tunnel). */
export function carriesTorch(slots: readonly (ItemStack | null)[]): boolean {
  return slots.slice(0, 36).some((x) => !!x && x.count > 0 && x.name === 'torch');
}

/**
 * A torch on the floor of cell `p` (the cell must be open with a solid floor; no jump: never a pillar).
 * Track BK: always the floor's top face; the placer's own choice once hung it on the next block of a
 * `!tunnel` (the west face of the stone ahead), which the next cross-section dug and popped the torch.
 */
export function placeTorch(place: (p: Vec3, o?: PlaceOptions) => Promise<PlaceResult>, p: Vec3): Promise<PlaceResult> {
  return place(p, { item: 'torch', jump: false, face: 'up' });
}

/** Failed digs / walks of one step before the step counts as blocked. */
const STEP_ATTEMPTS = 3;

export const DIRS: readonly Dir[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
export const turnLeft = (d: Dir): Dir => [d[1], 0 - d[0] || 0];
export const turnRight = (d: Dir): Dir => [0 - d[1] || 0, d[0]];

/** `deepslate_iron_ore` -> `iron`, `lit_redstone_ore` -> `redstone`; undefined for anything that is not a branch ore. */
export function oreBase(name: string): string | undefined {
  const n = name
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/^lit_/, '')
    .replace(/^deepslate_/, '')
    .replace(/_ore$/, '');
  return n in BRANCH_Y && name.endsWith('_ore') ? n : undefined;
}

export type BranchTarget = { y: number; ore: string; why: string } | { skip: string };

/**
 * The Y to branch-mine `names` (the miner's resolved target names) at: `setting` is `mineBranchY`
 * (`auto` or a whole number). Not a branch ore, or emerald while the bot stands below 232: skip.
 */
export function branchTarget(names: Iterable<string>, setting: string, feetY: number): BranchTarget {
  let ore: string | undefined;
  for (const n of names) ore ??= oreBase(n);
  if (!ore) return { skip: 'not an ore for branch mining' };
  const s = setting.trim().toLowerCase();
  if (s !== 'auto' && s !== '') {
    const y = Number(s);
    if (Number.isInteger(y)) return { y, ore, why: `mineBranchY ${y}` };
  }
  if (ore === 'emerald' && feetY < EMERALD_MIN_FEET) return { skip: `emerald is mined at y ${BRANCH_Y.emerald} in the mountains (standing at y ${Math.floor(feetY)})` };
  return { y: BRANCH_Y[ore]!, ore, why: `best y for ${ore}` };
}

/** The feet cells of the planned staircase from `start` to `y` going `dir` (no turns; tests and the e2e pick their start with it). */
export function stairCells(start: Vec3, dir: Dir, y: number): Step[] {
  const out: Step[] = [];
  let tip = start;
  const dy = y < start.y ? -1 : 1;
  while (tip.y !== y) {
    const s = stairStep(tip, dir, dy);
    out.push(s);
    tip = s.feet;
  }
  return out;
}

/** The planned main tunnel and branch cells from the staircase's bottom `tip` (no turns): `pairs` branch pairs. */
export function tunnelCells(tip: Vec3, dir: Dir, pairs: number): { main: Step[]; branches: Step[][] } {
  const main: Step[] = [];
  const branches: Step[][] = [];
  let t = tip;
  for (let p = 0; p < pairs; p++) {
    for (let i = 0; i < BRANCH_EVERY; i++) {
      const s = flatStep(t, dir);
      main.push(s);
      t = s.feet;
    }
    for (const side of [turnLeft(dir), turnRight(dir)]) {
      const b: Step[] = [];
      let bt = t;
      for (let i = 0; i < BRANCH_LEN; i++) {
        const s = flatStep(bt, side);
        b.push(s);
        bt = s.feet;
      }
      branches.push(b);
    }
  }
  return { main, branches };
}

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const same = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const fmt = (p: Vec3) => `${p.x} ${p.y} ${p.z}`;

/** What branch mining needs from the bot (wired by chat/commands-explore.ts `attachBranch`). */
export interface BranchHost {
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
  place?(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  /** Why the block at p may not be broken (nav/actions.ts breakBlocker), undefined when it may; `air` for an empty cell. */
  breakRule(p: Vec3): string | undefined;
  /** The body may stand on this cell's top: a floor, not a liquid, not a hazard. undefined = not loaded. */
  floor(p: Vec3): boolean | undefined;
  /** The body may be in this cell (no collision, no liquid, no hazard). undefined = not loaded. */
  free(p: Vec3): boolean | undefined;
  blockAt?(p: Vec3): BlockInfo | undefined;
  position(): Vec3 | undefined;
  health(): number;
  slots(): readonly (ItemStack | null)[];
  /** Setting `mineBranchY` (`auto` or a number). */
  branchY(): string;
  /** Setting `mineTunnelLen`: tunnel blocks at the ore's Y without a find before giving up. */
  tunnelLen(): number;
  /** Setting `allowPlace`: torches. */
  allowPlace(): boolean;
  waitTicks(n: number): Promise<void>;
  /** The bot's yaw (the staircase's first direction is the one it faces). */
  yaw?(): number | undefined;
  /** A chat line (the run's own summary at the end). */
  say?(msg: string): void;
  /** Walk back to the surface (the staircase's top) and home, after the run ended by itself. */
  returnUp?(start: Vec3, why: string, pickups: readonly Vec3[]): void;
  /** Item entities within `r` blocks of the centre of cell p (drops left in an ore's hole). */
  itemsNear?(p: Vec3, r: number): number;
  log?: Logger;
  now?(): number;
}

/** The parts of MineTask branch mining reads (miner.ts). */
export interface BranchTask {
  readonly names: ReadonlySet<string>;
  state: MineState;
  readonly stats: { readonly mined: number; readonly startedAt: number | undefined; readonly minedAt?: readonly Vec3[] };
  readonly opts: { count?: number } | undefined;
  readonly running: boolean;
  readonly isPaused: boolean;
  onDone(fn: (s: MineState) => void): () => void;
}

export type BranchPhase = 'stairs' | 'main' | 'branch' | 'back' | 'done';
export type BranchEnd = 'exhausted' | 'blocked' | 'low_health' | 'no_pickaxe' | 'skip';

export interface BranchStats {
  startedAt: number;
  ore: string;
  targetY: number;
  /** Feet cell where the staircase starts (the surface the run returns to). */
  start: Vec3;
  stairSteps: number;
  mainLen: number;
  branchLen: number;
  branches: number;
  /** Blocks broken by the layout (the miner's own tunnels to ores not counted). */
  dug: number;
  /** Every cell the layout cleared (the e2e checks the dig rules on them). */
  dugAt: Vec3[];
  /** Ore mined during the run, and the tunnel blocks (main + branches) dug when each was found. */
  finds: number;
  findAt: number[];
  /** Tunnel blocks at the ore's Y since the last find. */
  sinceFind: number;
  turns: number;
  blockedSteps: { at: Vec3; why: string }[];
  torches: number;
  /** Walks into ore holes to pick up a drop the miner's collect left. */
  pickupWalks: number;
  digFailures: number;
  /** ms from the start when the staircase reached the ore's Y. */
  reachedYMs: number | undefined;
  end: BranchEnd | undefined;
  endWhy: string | undefined;
}

/** One branch-mining run (one `!mine` run of one MineTask). */
export class BranchRun {
  readonly stats: BranchStats;
  phase: BranchPhase = 'stairs';
  dir: Dir;
  /** End of the staircase / main tunnel (feet cell). */
  tip: Vec3;
  /** Branch in progress: its direction, tip and length. */
  private bDir: Dir | undefined;
  private bTip: Vec3 | undefined;
  private bLen = 0;
  /** 0: the left branch of the pair is next, 1: the right one, 2: the pair is done. */
  private side = 0;
  private sinceJunction = 0;
  private lastMined: number;
  private fails = 0;
  private sinceTorch = 0;
  /** Mined positions (index into the task's minedAt) whose drop was looked for. */
  private pickedUpTo = 0;
  private readonly minedAtStart: number;
  /** Ore cells of the layout left to the miner once. */
  private readonly deferred = new Set<string>();
  private readonly h: BranchHost;
  private readonly task: BranchTask;

  constructor(h: BranchHost, task: BranchTask, start: Vec3, dir: Dir, ore: string, targetY: number) {
    this.h = h;
    this.task = task;
    this.dir = dir;
    this.tip = { ...start };
    this.lastMined = task.stats.mined;
    this.minedAtStart = task.stats.minedAt?.length ?? 0;
    this.stats = {
      startedAt: this.now(),
      ore,
      targetY,
      start: { ...start },
      stairSteps: 0,
      mainLen: 0,
      branchLen: 0,
      branches: 0,
      dug: 0,
      dugAt: [],
      finds: 0,
      findAt: [],
      sinceFind: 0,
      turns: 0,
      blockedSteps: [],
      torches: 0,
      pickupWalks: 0,
      digFailures: 0,
      reachedYMs: undefined,
      end: undefined,
      endWhy: undefined,
    };
    if (start.y === targetY) this.enterMain();
  }

  private now(): number {
    return this.h.now?.() ?? Date.now();
  }

  private alive(): boolean {
    return this.task.running && !this.task.isPaused;
  }

  private finish(end: BranchEnd, why: string): false {
    this.phase = 'done';
    this.stats.end = end;
    this.stats.endWhy = why;
    this.h.log?.info(`branch: ${end} (${why}); ${this.summary()}`);
    return false;
  }

  private enterMain(): void {
    this.phase = 'main';
    this.stats.reachedYMs ??= this.now() - this.stats.startedAt;
    this.sinceJunction = 0;
  }

  /** `iron: staircase 52 steps to y 16, tunnel 3 + 32 in 2 branches, 1 find, 160 blocks dug` */
  summary(): string {
    const s = this.stats;
    return `${s.ore} at y ${s.targetY}: staircase ${s.stairSteps} steps, tunnel ${s.mainLen} + ${s.branchLen} in ${s.branches} branches, ${s.finds} finds, ${s.dug} blocks dug`;
  }

  /** Count the ore the miner mined since the last look (a find resets the tunnel count). */
  noteFinds(): void {
    const s = this.stats;
    const mined = this.task.stats.mined;
    if (mined <= this.lastMined) return;
    s.finds += mined - this.lastMined;
    s.findAt.push(s.mainLen + s.branchLen);
    s.sinceFind = 0;
    this.lastMined = mined;
  }

  /** The holes of ore mined during this run whose drop is still there (item entities within 1.5 blocks). */
  leftDrops(from = this.minedAtStart): Vec3[] {
    const at = this.task.stats.minedAt ?? [];
    if (!this.h.itemsNear) return [];
    return at.slice(from).filter((p) => this.h.itemsNear!(p, 1.5) > 0);
  }

  /** Walk into the holes of newly mined ore whose drop is still there (the planner digs the head room). True: walked (scan again). */
  private async pickUp(): Promise<boolean> {
    const at = this.task.stats.minedAt ?? [];
    const from = Math.max(this.pickedUpTo, this.minedAtStart);
    this.pickedUpTo = at.length;
    const left = this.leftDrops(from);
    for (const p of left) {
      this.task.state = 'collect';
      const r = await this.h.goto({ type: 'block', p }, { allowBreak: true, allowPlace: false, timeoutTicks: 600 });
      if (!this.alive()) return true;
      this.stats.pickupWalks++;
      if (r.ok) await this.h.waitTicks(10);
      this.h.log?.info(`branch: drop left at ${fmt(p)}: ${r.ok ? 'walked into the hole' : r.reason}`);
    }
    return left.length > 0;
  }

  /** One more step of the layout. True: dug something (or was interrupted): scan again. False: the run is over. */
  async step(): Promise<boolean> {
    if (this.phase === 'done') return false;
    const s = this.stats;
    this.noteFinds();
    if (await this.pickUp()) return true;
    if (this.h.health() < BRANCH_MIN_HEALTH) return this.finish('low_health', `health ${this.h.health()}`);
    if (!carriesPickaxe(this.h.slots())) return this.finish('no_pickaxe', 'no pickaxe');
    if (this.phase !== 'stairs' && s.sinceFind >= this.h.tunnelLen()) return this.finish('exhausted', `${s.sinceFind} blocks of tunnel without ${s.ore} (mineTunnelLen ${this.h.tunnelLen()})`);
    switch (this.phase) {
      case 'stairs':
        return this.stairs();
      case 'main':
        return this.main();
      case 'branch':
        return this.branch();
      case 'back':
        return this.back();
      default:
        return false;
    }
  }

  /** Stand on `p` (walk there through the cleared cells first, digging only when that fails). */
  private async standOn(p: Vec3): Promise<'ok' | 'interrupted' | 'failed'> {
    const pos = this.h.position();
    if (pos && Math.floor(pos.x) === p.x && Math.floor(pos.z) === p.z && Math.abs(pos.y - p.y) < 0.6) return 'ok';
    this.task.state = 'walk';
    let r = await this.h.goto({ type: 'block', p }, { allowBreak: false, allowPlace: false, timeoutTicks: 1200 });
    if (!this.alive()) return 'interrupted';
    if (!r.ok && r.reason !== 'interrupted') {
      r = await this.h.goto({ type: 'block', p }, { allowBreak: true, allowPlace: false, timeoutTicks: 1200 });
      if (!this.alive()) return 'interrupted';
    }
    if (r.ok) return 'ok';
    return r.reason === 'interrupted' ? 'interrupted' : 'failed';
  }

  /** The dig rules for a step: undefined when it may be dug, else the reason. */
  private stepRule(st: Step): string | undefined {
    for (const c of st.dig) {
      const why = this.h.breakRule(c);
      if (why === undefined || why === 'air') continue;
      return `${why} at ${fmt(c)}`;
    }
    const f = this.h.floor(st.floor);
    if (f === undefined) return `floor ${fmt(st.floor)} not loaded`;
    if (!f) {
      // the floor cell itself may be dug (the planned step's own cells never are its floor)
      return `no floor at ${fmt(st.floor)}`;
    }
    return undefined;
  }

  /** Clear the step's cells and walk onto it. 'blocked' when the dig rules forbid it. */
  private async doStep(st: Step): Promise<'ok' | 'blocked' | 'interrupted' | 'failed'> {
    const why = this.stepRule(st);
    if (why) {
      this.stats.blockedSteps.push({ at: { ...st.feet }, why });
      this.h.log?.info(`branch: step to ${fmt(st.feet)} blocked: ${why}`);
      return 'blocked';
    }
    // Track AQ: the same step primitive as the direct tunnels (tunnel.ts clearStep)
    this.task.state = 'dig';
    const r = await clearStep(
      { dig: (p, o) => this.h.dig(p, o), breakRule: (p) => this.h.breakRule(p), free: (p) => this.h.free(p), alive: () => this.alive() },
      st,
      {
        // the ore itself in the way: the miner's loop mines it (counted, collected) on the next scan;
        // the layout digs it only when it is still there the second time
        skip: (c) => {
          const name = this.h.blockAt?.(c)?.name;
          if (!name || !this.task.names.has(name) || this.deferred.has(key(c))) return undefined;
          this.deferred.add(key(c));
          this.h.log?.info(`branch: ${name} in the way at ${fmt(c)}: left to the miner`);
          return 'defer';
        },
        onDug: (c) => {
          this.stats.dug++;
          this.stats.dugAt.push({ ...c });
        },
        onFail: (c, why) => {
          this.stats.digFailures++;
          this.h.log?.info(`branch: dig ${fmt(c)} failed: ${why}`);
        },
      },
    );
    if (r !== 'ok') return r;
    const w = await this.standOn(st.feet);
    return w;
  }

  /** Run a step with up to STEP_ATTEMPTS tries: true = done, 'blocked' = turn, 'interrupted' = scan again. */
  private async attempt(st: Step): Promise<'ok' | 'blocked' | 'interrupted'> {
    const r = await this.doStep(st);
    if (r === 'failed') {
      if (++this.fails >= STEP_ATTEMPTS) {
        this.fails = 0;
        this.stats.blockedSteps.push({ at: { ...st.feet }, why: `${STEP_ATTEMPTS} failed attempts` });
        return 'blocked';
      }
      return 'interrupted';
    }
    this.fails = 0;
    return r;
  }

  private async torch(behind: Vec3): Promise<void> {
    if (++this.sinceTorch < TORCH_EVERY || !this.h.allowPlace() || !this.h.place) return;
    if (!carriesTorch(this.h.slots())) return;
    this.sinceTorch = 0;
    const r = await placeTorch((p, o) => this.h.place!(p, o), behind);
    if (r.ok) this.stats.torches++;
    else this.h.log?.info(`branch: torch at ${fmt(behind)}: ${r.reason}`);
  }

  private async stairs(): Promise<boolean> {
    const at = await this.standOn(this.tip);
    if (at === 'interrupted') return true;
    if (at === 'failed') return this.finish('blocked', `cannot get back to the staircase at ${fmt(this.tip)}`);
    const dy = this.stats.targetY < this.tip.y ? -1 : 1;
    for (const d of [this.dir, turnRight(this.dir), turnLeft(this.dir)]) {
      const st = stairStep(this.tip, d, dy);
      const r = await this.attempt(st);
      if (r === 'interrupted') return true;
      if (r === 'blocked') continue;
      if (d !== this.dir) this.stats.turns++;
      this.dir = d;
      this.tip = st.feet;
      this.stats.stairSteps++;
      if (this.tip.y === this.stats.targetY) {
        this.h.log?.info(`branch: reached y ${this.tip.y} at ${fmt(this.tip)} after ${this.stats.stairSteps} steps`);
        this.enterMain();
      }
      return true;
    }
    return this.finish('blocked', `staircase blocked at ${fmt(this.tip)}`);
  }

  private async main(): Promise<boolean> {
    if (this.sinceJunction >= BRANCH_EVERY && this.side < 2) {
      this.phase = 'branch';
      return this.branch();
    }
    const at = await this.standOn(this.tip);
    if (at === 'interrupted') return true;
    if (at === 'failed') return this.finish('blocked', `cannot get back to the tunnel at ${fmt(this.tip)}`);
    for (const d of [this.dir, turnRight(this.dir), turnLeft(this.dir)]) {
      const st = flatStep(this.tip, d);
      const r = await this.attempt(st);
      if (r === 'interrupted') return true;
      if (r === 'blocked') continue;
      if (d !== this.dir) this.stats.turns++;
      const behind = this.tip;
      this.dir = d;
      this.tip = st.feet;
      this.stats.mainLen++;
      this.stats.sinceFind++;
      this.sinceJunction++;
      if (this.sinceJunction >= BRANCH_EVERY) this.side = 0;
      await this.torch(behind);
      return true;
    }
    return this.finish('blocked', `tunnel blocked at ${fmt(this.tip)}`);
  }

  private async branch(): Promise<boolean> {
    if (this.side >= 2) {
      this.sinceJunction = 0;
      this.phase = 'main';
      return true;
    }
    if (!this.bDir || !this.bTip) {
      this.bDir = this.side === 0 ? turnLeft(this.dir) : turnRight(this.dir);
      this.bTip = { ...this.tip };
      this.bLen = 0;
      this.stats.branches++;
    }
    const at = await this.standOn(this.bTip);
    if (at === 'interrupted') return true;
    if (at === 'failed') return this.endBranch(`cannot get back to ${fmt(this.bTip)}`);
    const st = flatStep(this.bTip, this.bDir);
    const r = await this.attempt(st);
    if (r === 'interrupted') return true;
    if (r === 'blocked') return this.endBranch('blocked');
    const behind = this.bTip;
    this.bTip = st.feet;
    this.bLen++;
    this.stats.branchLen++;
    this.stats.sinceFind++;
    await this.torch(behind);
    if (this.bLen >= BRANCH_LEN) return this.endBranch('full length');
    return true;
  }

  private endBranch(why: string): boolean {
    this.h.log?.info(`branch: branch ${this.stats.branches} ends after ${this.bLen} blocks (${why})`);
    this.bDir = undefined;
    this.bTip = undefined;
    this.side++;
    this.phase = 'back';
    return true;
  }

  /** Walk back to the junction on the main tunnel. */
  private async back(): Promise<boolean> {
    const at = await this.standOn(this.tip);
    if (at === 'interrupted') return true;
    if (at === 'failed') return this.finish('blocked', `cannot get back to the tunnel at ${fmt(this.tip)}`);
    this.phase = this.side < 2 ? 'branch' : 'main';
    if (this.phase === 'main') this.sinceJunction = 0;
    return true;
  }
}

/** Per skills object (one bot): the host; per MineTask: the current run. */
const hosts = new WeakMap<object, BranchHost>();
const runs = new WeakMap<object, { startedAt: number | undefined; run: BranchRun | undefined; skip?: string }>();

/** Wire branch mining for the miner that uses `skills` (chat/commands-explore.ts). */
export function attachBranch(skills: object, host: BranchHost): () => void {
  hosts.set(skills, host);
  return () => {
    if (hosts.get(skills) === host) hosts.delete(skills);
  };
}

/** The branch run of a MineTask's current run (status, tests). */
export function branchRunOf(task: object): BranchRun | undefined {
  return runs.get(task)?.run;
}

/** The staircase's first direction: the cardinal direction the bot faces, else east. */
export function dirFromYaw(yaw: number | undefined): Dir {
  if (yaw === undefined || !Number.isFinite(yaw)) return DIRS[0]!;
  // Bedrock yaw: 0 = south (+z), 90 = west (-x), 180 / -180 = north, -90 = east
  const i = (((Math.round(yaw / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return ([[0, 1], [-1, 0], [0, -1], [1, 0]] as const)[i];
}

/**
 * The miner's hook (miner.ts, Track AI): it knows no target. Starts a branch run for this MineTask
 * run on the first call, then digs one step per call. False: no branch mining (not attached, not a
 * branch ore, emerald below the mountains) or the run is over: the miner ends `none_left`.
 */
export async function branchMore(task: BranchTask, skills: object): Promise<boolean> {
  const h = hosts.get(skills);
  if (!h) return false;
  let r = runs.get(task);
  if (!r || r.startedAt !== task.stats.startedAt) {
    r = { startedAt: task.stats.startedAt, run: undefined };
    runs.set(task, r);
    const pos = h.position();
    if (!pos) return false;
    const feet = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-6), z: Math.floor(pos.z) };
    const t = branchTarget(task.names, h.branchY(), feet.y);
    if ('skip' in t) {
      r.skip = t.skip;
      h.log?.info(`branch: not branch mining ${[...task.names][0] ?? '?'}: ${t.skip}`);
      return false;
    }
    const run = new BranchRun(h, task, feet, dirFromYaw(h.yaw?.()), t.ore, t.y);
    r.run = run;
    h.log?.info(`branch: no ${t.ore} known: branch mining at y ${t.y} (${t.why}) from ${fmt(feet)}, staircase ${Math.abs(feet.y - t.y)} steps`);
    h.say?.(`branch mining ${[...task.names][0] ?? t.ore}: none known, digging down to y ${t.y} (staircase from ${fmt(feet)})`);
    const off = task.onDone((state) => {
      off();
      onRunEnd(h, run, task, state);
    });
  }
  const run = r.run;
  if (!run) return false;
  return run.step();
}

function onRunEnd(h: BranchHost, run: BranchRun, task: BranchTask, state: MineState): void {
  const s = run.stats;
  run.noteFinds();
  run.phase = 'done';
  const secs = ((h.now?.() ?? Date.now()) - s.startedAt) / 1000;
  const name = [...task.names][0] ?? s.ore;
  const why = s.end && s.endWhy ? `, ${s.endWhy}` : '';
  const line = `branch ${name}: ${task.stats.mined}/${task.opts?.count ?? '?'} in ${secs.toFixed(0)} s; ${run.summary()}${why}`;
  h.log?.info(line);
  if (state === 'stopped') return; // !stop / !mine stop: the owner decides where the bot goes
  h.say?.(line);
  const pos = h.position();
  if (s.dug > 0 && (!pos || !same({ x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-6), z: Math.floor(pos.z) }, s.start))) h.returnUp?.(s.start, s.end ?? state, run.leftDrops());
}
