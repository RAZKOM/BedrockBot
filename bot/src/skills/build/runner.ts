// The build runner (wave 9, Track AL; docs/build.md "Execution"): executes a plan's steps on the bot,
// one at a time, against the live world model.
//
//   place / scaffold   stand where the cell is in reach and the stand is not a cell filled later (the
//                      current spot if it qualifies, else a goto to any of the nearest such stands,
//                      the planner's own first), place with the PlaceSkill, verify the block in the
//                      world model; from a column top no walking at all
//   pillar             walk to the column base and pillar up (the PlaceSkill's jump-and-place)
//   descend            dig the column under the feet, landing on each block, then pick up the drops
//   dig / unscaffold   the same stand rules with the dig reach, the Digger, verify air
//   replace            dig, then place
//
// A failed step is retried twice (walking again), then skipped and reported. The build's own blocks
// come from the inventory; the keeper's throwaway reserve is never used for a build block (out of a
// block: the build stops). Scaffold blocks are throwaway blocks and are picked up again.
// pause() cancels the running skill; run() again continues at the same step (a column the bot is no
// longer standing on is dug away from the ground and pillared again).
//
// Track BJ (decision 0052): with the task's Supply (skills/supply/supply.ts) the carried shulker boxes are part
// of the inventory: out of a block on the ground, the box holding it is placed next to the bot (never on a cell of
// the build: `footprint`), what the rest of the build needs is taken out and the box picked up again; before a
// pillar (still on the ground) the column's places and its scaffold blocks are topped up the same way (no box
// can be placed from a column top); at the start the scaffold peak is. What a refill took out and the build did
// not use goes back into a box at the end (`stow`).
// Track B4 (decision 0129): at the start, after a fetch round and when out of a block on the ground, the stretch of steps
// ahead that fits in the inventory comes out of the boxes in one go (`load`: every kind it places, a box visited once),
// with the loose build items it does not use put into a box first when it needs their room. No box is set down on a
// cell of the build (the whole job's, `avoid`), a scaffold or a planned stand; with no such cell beside the bot it walks
// to a stand nearby that has one.
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import type { DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { ManyOptions, ManyResult, PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { blockMining, toolOf } from '../../data/mining.ts';
import { canHarvest } from '../dig/breakTime.ts';
import { maxDurability } from '../survival/tools.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import { maxStackOf } from '../container/chest.ts';
import { usable, type InventoryCounts, type ReserveOptions } from './materials.ts';
import { plainPlacement, type Plan, type Step } from './plan.ts';
import { canDigFrom, canPlaceFrom, canPlaceWith, canStand, clickFor, edgeDrop, replaceable, BUILD_REACH, type BlockLike, type BlockReader } from './sim.ts';
import { cardinalYaw, OPPOSITE, remaining, sameBlock, stateDiff, statesMatch, stateText, type Cardinal, type Placement } from './states.ts';
import { MISSING_REASON } from './skip.ts'; // Track B6

const stateTextEq = (a: unknown, b: unknown): boolean => stateText(a) === stateText(b);
import { add, blockId, cellOf, fmtCell, isAirName, key, type Cell } from './types.ts';

export interface RunnerDeps {
  blockAt(p: Cell): BlockLike | undefined;
  /** Feet position. */
  position(): Vec3 | undefined;
  onGround(): boolean;
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  place(p: Cell, opts: PlaceOptions): Promise<PlaceResult>;
  dig(p: Cell): Promise<DigResult>;
  collect(radius: number, timeoutTicks: number): Promise<SkillResult>;
  waitTicks(n: number): Promise<void>;
  inventory: InventoryCounts;
  /** The keeper's reserve, read live (`throwawayMin`). */
  reserve(): ReserveOptions;
  /** Cancel the running skill (pause / stop). */
  cancel(): void;
  /** Track BJ: the carried shulker boxes (the task's Supply); without it the build sees loose blocks only. */
  supply?: RunnerSupply | undefined;
  /** Track B1: one click on a placed block (a repeater's delay, open), with an optional view (skills tapBlock). */
  tap?: ((p: Cell, view?: { yaw: number; pitch: number }) => Promise<SkillResult>) | undefined;
  /**
   * Track B3 (decision 0128): plain blocks placed from where the bot stands several a tick, each click without waiting
   * for the one before (PlaceSkill.placeMany); `burst` = the clicks a tick (0: one block at a time, as before).
   */
  placeMany?: ((cells: readonly Cell[], opts: ManyOptions) => Promise<ManyResult>) | undefined;
  burst?: (() => number) | undefined;
  /**
   * Track B3: a large build's restock (job.ts): true when a fetch round may bring `items`; the run then ends `restock`
   * where it stands (on the ground) and runs on at the same step after the round. Without it, out of a block stops.
   */
  fetchMore?: ((items: readonly string[]) => boolean) | undefined;
  /** Track B3: a target cell placed, dug or replaced and verified (the job's progress). */
  cellDone?: ((c: Cell) => void) | undefined;
  /** Track B3: a scaffold block of the build placed (`up`) or dug (the job's progress: a restart digs what was left). */
  scaffoldAt?: ((c: Cell, up: boolean) => void) | undefined;
  /**
   * Track B4 (decision 0129): cells a shulker box is never set down on besides this plan's own (a job: every cell of the
   * whole build, the sections not planned yet too).
   */
  avoid?: ((c: Cell) => boolean) | undefined;
  /**
   * Track B3: the hand or a carried tool the wear rule lets the digger use (the survival kit's toolOk: a tool with
   * few uses left is kept, not used) harvests `block`. Without it: any carried pickaxe or shovel that harvests it.
   */
  harvests?: ((block: string) => boolean) | undefined;
  log?: Logger;
}

/** Track B3: plain placements clicked at once at most (one burst). */
export const BURST_MAX = 16;

/** Track BJ: what the runner uses of the Supply (skills/supply/supply.ts). */
export interface RunnerSupply {
  carried(names: string | readonly string[]): number;
  ensure(names: string | readonly string[], n: number, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }): Promise<{ ok: boolean; loose: number; fromBoxes: number; reason?: string }>;
  stow(names: string | readonly string[], keep: number, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }): Promise<{ stowed: number; reason?: string }>;
  /** How many more of it fit loose (a margin of slots kept free): a refill takes no more. */
  room?(names: string | readonly string[]): number;
  /** A box an interrupted refill left standing or on the ground: picked up again (at the start of a run). */
  recover?(cancelled: () => boolean): Promise<void>;
  /** Track B4: what the carried boxes hold, by item. */
  contents?(): Map<string, number>;
  /** Track B4: free inventory slots (0..35). */
  freeSlots?(): number;
  /** Track B4: several kinds out of the carried boxes in one go (a box at a time, each visited once). */
  takeMany?(want: Record<string, number>, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }): Promise<{ taken: Record<string, number>; boxes: number; reason?: string }>;
  /** Track B4: the loose items of these kinds beyond the count given into the carried boxes. */
  stowMany?(keep: Record<string, number>, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean; notInto?: (name: string) => boolean }): Promise<{ stowed: Record<string, number>; boxes: number; reason?: string }>;
}

export interface RunnerStats {
  placed: number;
  dug: number;
  replaced: number;
  scaffoldsPlaced: number;
  scaffoldsRemoved: number;
  skipped: { pos: Cell; reason: string }[];
  /** Work steps done or skipped. */
  processed: number;
  /** Active (not paused) ms so far. */
  activeMs: number;
  retries: number;
  walks: number;
  /** Track BJ: items taken out of carried boxes, and how often. */
  refilled?: number;
  refills?: number;
  /** Track BJ: items put back into a box at the end. */
  stowed?: number;
  /** Track B1: blocks placed with states the runner verified, blocks dug and placed again for a wrong state. */
  verified?: number;
  redone?: number;
  /** Track B1: blocks left with states other than the build's (after the retries, or at the end): what differs. */
  wrong?: { pos: Cell; name: string; diff: string[] }[];
  /** Track B3: where the time went, ms (TIME_KINDS). */
  time: Record<TimeKind, number>;
}

/**
 * Track B3 (decision 0128): the runner's time by kind: walking to stands and column bases, the clicks of a placement
 * with their answers, digs, the pillar jumps and the descend, the drop pickups, the waits after a step (the
 * verification ticks), the shulker box refills, the fetch rounds of a large build.
 */
export const TIME_KINDS = ['walk', 'place', 'dig', 'pillar', 'collect', 'wait', 'refill', 'fetch'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

/** `walk 40 s, place 20 s, ...` (the kinds that took a second or more, the largest first). */
export function timeLine(t: Readonly<Record<string, number>>): string {
  return Object.entries(t)
    .filter(([, ms]) => ms >= 1000)
    .sort((a, b) => b[1] - a[1])
    .map(([k, ms]) => `${k} ${Math.round(ms / 1000)} s`)
    .join(', ');
}

/** Track B3: what a large build (job.ts) and a build's progress hook into a runner (Track B4: and the cells no box goes on). */
export type RunnerHooks = Pick<RunnerDeps, 'fetchMore' | 'cellDone' | 'scaffoldAt' | 'avoid'>;

/** Track B3: `restock` only with RunnerDeps.fetchMore (the job fetches, then runs the runner again). */
export type RunnerEnd = { state: 'done' } | { state: 'stopped'; reason: string } | { state: 'paused' } | { state: 'restock'; items: string[] };

/**
 * Track B3: what a build process drives: one runner, or a large build's job (job.ts) of one runner a section.
 * `stop()` (optional) ends what the work does besides its runner (a job's fetch round).
 */
export interface BuildWork {
  readonly plan: Plan;
  readonly stats: RunnerStats;
  readonly total: number;
  readonly busy: boolean;
  run(): Promise<RunnerEnd>;
  pause(): void;
  stop?(): void;
  etaS(): number | undefined;
  rate(): number | undefined;
  /** More for the status line (`section 3 of 12`). */
  detail?(): string | undefined;
  /** The bot stands on a scaffold column of the build (combat strikes from there without a step: Skills.perch). */
  perched?(): boolean;
  /** Scaffold blocks of the build out in the world now. */
  scaffoldsOut?(): number;
  /** A work that only takes those down (after `!build stop`: a process of its own). */
  cleaner?(reason: string): BuildWork;
}

/** Track B3: a work whose run() is `clean` (taking a build's scaffold blocks down), reporting `of`'s numbers. */
export function cleanerWork(of: BuildWork, clean: () => Promise<RunnerEnd>): BuildWork {
  let busy = false;
  return {
    plan: of.plan,
    get stats() {
      return of.stats;
    },
    get total() {
      return of.total;
    },
    get busy() {
      return busy || of.busy;
    },
    async run() {
      busy = true;
      try {
        return await clean();
      } finally {
        busy = false;
      }
    },
    pause: () => of.pause(),
    etaS: () => undefined,
    rate: () => of.rate(),
    detail: () => 'taking the scaffold down',
  };
}

/** Attempts per step (the first + 2 retries). */
export const STEP_ATTEMPTS = 3;
/** Stands offered to one goto. */
const MAX_STANDS = 12;
/** Track B3: the tools a scaffold kind is harvested with (scaffoldItems: the kinds these take down first). */
const SCAFFOLD_TOOLS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].flatMap((m) => [`${m}_pickaxe`, `${m}_shovel`]);
/**
 * Track B3: the tool a fetch round brings when no carried tool harvests the scaffold kind any more (the pickaxe broke:
 * a castle's 900 scaffold blocks wear out more than three iron pickaxes; by hand cobblestone takes 10 s and drops
 * nothing). Made of the scaffold blocks themselves and two sticks.
 */
export const SCAFFOLD_PICK = 'stone_pickaxe';
/** Track B3: at most this many of SCAFFOLD_PICK a round (each takes a slot from the build's blocks). */
const SCAFFOLD_PICKS = 2;
/** Track B3: out of throwaway blocks on the ground: the pickup of the drops lying round first (radius, ticks). */
const DROPS_RADIUS = 6;
const DROPS_TICKS = 60;
/** A goto to a stand gives up after (ticks). */
const GOTO_TICKS = 1200;
/** Collect drops after this many digs. */
const COLLECT_EVERY = 16;
/** Track B4: inventory slots a load from the boxes leaves free (Supply's ROOM_MARGIN: the box, its pickup, drops). */
const LOAD_MARGIN = 4;
/** Track B4: no box cell next to the bot: stands this far off are looked at for one. */
const BOX_STAND_RADIUS = 6;

const WORK = new Set<Step['op']>(['place', 'dig', 'replace']);

export class BuildRunner implements BuildWork {
  readonly plan: Plan;
  private readonly d: RunnerDeps;
  private readonly log: Logger;
  /** Next step. */
  index = 0;
  readonly stats: RunnerStats = { placed: 0, dug: 0, replaced: 0, scaffoldsPlaced: 0, scaffoldsRemoved: 0, skipped: [], processed: 0, activeMs: 0, retries: 0, walks: 0, time: Object.fromEntries(TIME_KINDS.map((k) => [k, 0])) as Record<TimeKind, number> };
  /** Work steps in the plan. */
  readonly total: number;
  private epoch = 0;
  private running = false;
  private since: number | undefined;
  /** Target cells not placed yet (never stood in). */
  private readonly pending = new Set<string>();
  private digsSinceCollect = 0;
  /** Step indices already counted. */
  private readonly finished = new Set<number>();
  /** Scaffold blocks out in the world now (lent from the throwaway reserve until they are dug). */
  private lent = 0;
  /** Cells of the scaffold blocks this runner placed and has not dug yet. */
  private readonly outstanding = new Set<string>();
  /** Set when the bot left a column it was building from (resume): dig it away and pillar again. */
  private rebuild: { base: Cell; height: number } | undefined;
  /** Track BJ: every cell the build places, digs or scaffolds (a refill's box never stands there). */
  private readonly footprint = new Set<string>();
  /** Track BJ: items taken out of carried boxes by name (stowed again at the end, what is left of them). */
  private readonly refilled = new Map<string, number>();
  /** Track B1: the attempt of the running step (0 = the first): a wrong state is kept on the last. */
  private attempt = 0;
  /** Track B1: the final check (states that follow the neighbours) is done. */
  private checked = false;
  /** Track B1: wrong blocks dug since the last wide pickup (their drops may lie about). */
  private wrongDug = 0;

  /** Track B3: what the place and dig calls count as now (`pillar` while pillaring up or coming down a column). */
  private clickKind: TimeKind = 'place';
  /** Track B3: steps that asked for a restock once (a second shortage there stops as before). */
  private readonly restocked = new Set<number>();
  /** Track B3: a round was asked for SCAFFOLD_PICK and none harvests the scaffold kind yet (asked once until one does). */
  private toolAsked = false;

  constructor(plan: Plan, deps: RunnerDeps) {
    this.plan = plan;
    this.d = this.timed(deps);
    this.log = deps.log ?? silentLogger;
    this.total = plan.steps.filter((s) => WORK.has(s.op)).length;
    for (const s of plan.steps) if (s.op === 'place') for (const c of cellsOf(s)) this.pending.add(key(c));
    for (const s of plan.steps) {
      if (s.op === 'place') for (const c of cellsOf(s)) this.footprint.add(key(c));
      else if ('pos' in s) this.footprint.add(key(s.pos));
      else for (let k = 0; k <= s.height; k++) this.footprint.add(key(add(s.base, 0, k, 0)));
      // Track B4 (decision 0129): nor on a planned stand (the feet and the head cell)
      if ('stand' in s && s.stand) {
        this.footprint.add(key(s.stand));
        this.footprint.add(key(add(s.stand, 0, 1, 0)));
      }
    }
  }

  /** Track B4: a cell no shulker box is set down on (the plan's cells, scaffolds and stands; the job's whole build). */
  private noBox = (p: Cell): boolean => this.footprint.has(key(p)) || (this.d.avoid?.(p) ?? false);

  /** Track B4: noBox for a fetch round's box steps (the job's). */
  boxBanned(p: Cell): boolean {
    return this.noBox(p);
  }

  /** Track B4: a fetch round ran: the next run() loads the stretch ahead out of the boxes first. */
  private reloadAsked = false;

  reload(): void {
    this.reloadAsked = true;
  }

  /** Track B3: the deps with their time counted by kind (stats.time). */
  private timed(d: RunnerDeps): RunnerDeps {
    const t = this.stats.time;
    const count = async <T>(k: () => TimeKind, p: () => Promise<T>): Promise<T> => {
      const kind = k();
      const t0 = performance.now();
      try {
        return await p();
      } finally {
        t[kind] += performance.now() - t0;
      }
    };
    const supply = (s: RunnerSupply | undefined): RunnerSupply | undefined =>
      s && {
        carried: (n) => s.carried(n),
        ensure: (n, k, o) => count(() => 'refill', () => s.ensure(n, k, o)),
        stow: (n, k, o) => count(() => 'refill', () => s.stow(n, k, o)),
        ...(s.room ? { room: (n: string | readonly string[]) => s.room!(n) } : {}),
        ...(s.recover ? { recover: (c: () => boolean) => count(() => 'refill', () => s.recover!(c)) } : {}),
        // Track B4
        ...(s.contents ? { contents: () => s.contents!() } : {}),
        ...(s.freeSlots ? { freeSlots: () => s.freeSlots!() } : {}),
        ...(s.takeMany ? { takeMany: (w: Record<string, number>, o: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }) => count(() => 'refill', () => s.takeMany!(w, o)) } : {}),
        ...(s.stowMany ? { stowMany: (k: Record<string, number>, o: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean; notInto?: (name: string) => boolean }) => count(() => 'refill', () => s.stowMany!(k, o)) } : {}),
      };
    return {
      ...d,
      goto: (g, o) => count(() => 'walk', () => d.goto(g, o)),
      place: (p, o) => count(() => this.clickKind, () => d.place(p, o)),
      dig: (p) => count(() => (this.clickKind === 'pillar' ? 'pillar' : 'dig'), () => d.dig(p)),
      collect: (r, n) => count(() => 'collect', () => d.collect(r, n)),
      waitTicks: (n) => count(() => (this.clickKind === 'pillar' ? 'pillar' : 'wait'), () => d.waitTicks(n)),
      ...(d.tap ? { tap: (p: Cell, v?: { yaw: number; pitch: number }) => count(() => 'place', () => d.tap!(p, v)) } : {}),
      ...(d.placeMany ? { placeMany: (c: readonly Cell[], o: ManyOptions) => count(() => this.clickKind, () => d.placeMany!(c, o)) } : {}),
      get supply() {
        return supply(d.supply);
      },
    };
  }

  get busy(): boolean {
    return this.running;
  }

  get done(): boolean {
    return this.index >= this.plan.steps.length;
  }

  /** Stop the running step (it ends `paused`); run() continues later at the same step. */
  pause(): void {
    this.epoch++;
    this.d.cancel();
    this.tickClock();
  }

  private tickClock(): void {
    if (this.since !== undefined) this.stats.activeMs += performance.now() - this.since;
    this.since = undefined;
  }

  /** Seconds left at the rate so far (work steps), undefined before the first one. */
  etaS(): number | undefined {
    const ms = this.stats.activeMs + (this.since !== undefined ? performance.now() - this.since : 0);
    if (this.stats.processed === 0 || ms <= 0) return undefined;
    return ((this.total - this.stats.processed) * ms) / this.stats.processed / 1000;
  }

  /** Work steps per minute so far. */
  rate(): number | undefined {
    const ms = this.stats.activeMs + (this.since !== undefined ? performance.now() - this.since : 0);
    return ms > 0 && this.stats.processed > 0 ? (this.stats.processed * 60_000) / ms : undefined;
  }

  async run(): Promise<RunnerEnd> {
    if (this.running) return { state: 'stopped', reason: 'already running' };
    const epoch = ++this.epoch;
    this.running = true;
    this.since = performance.now();
    try {
      // Track BJ: a paused refill's box first, never in a column phase (the walk would leave the column top)
      if (this.d.supply?.recover && !this.inColumnPhase() && this.d.onGround()) await this.d.supply.recover(() => epoch !== this.epoch);
      if (epoch !== this.epoch) return { state: 'paused' };
      this.checkColumn();
      // Track B4: the stretch ahead out of the boxes in one go (at the start, after a fetch round), on the ground only
      if ((this.index === 0 || this.reloadAsked) && !this.inColumnPhase() && this.d.onGround()) {
        this.reloadAsked = false;
        await this.load(epoch);
        if (epoch !== this.epoch) return { state: 'paused' };
      }
      if (this.index === 0 && this.plan.scaffoldPeak > 0) await this.topUpScaffold(this.plan.scaffoldPeak, epoch); // Track BJ
      while (this.index < this.plan.steps.length) {
        if (epoch !== this.epoch) return { state: 'paused' };
        const step = this.plan.steps[this.index]!;
        let last = 'failed';
        let ok = false;
        for (let attempt = 0; attempt < STEP_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            this.stats.retries++;
            await this.d.waitTicks(5);
          }
          if (epoch !== this.epoch) return { state: 'paused' };
          this.attempt = attempt;
          const r = await this.exec(step, epoch);
          if (epoch !== this.epoch) return { state: 'paused' };
          if (r === true) {
            ok = true;
            break;
          }
          if (r.startsWith('fatal:')) return await this.stopCleaning(r.slice(6), epoch);
          // Track B3: out of a block on the ground with a restock: the job fetches, then runs this step again
          if (r.startsWith('restock:')) return { state: 'restock', items: r.slice(8).split(',') };
          last = r;
          if ((step.op === 'place' || step.op === 'dig' || step.op === 'replace') && step.top && !this.atTop(step.top)) break; // no walking back up: skip
        }
        this.finishStep(step, ok, last);
        this.index++;
      }
      if (!this.checked) {
        await this.finalCheck(epoch); // Track B1
        if (epoch !== this.epoch) return { state: 'paused' };
        this.checked = true;
      }
      await this.collectNow(6, 200);
      await this.stowRest(epoch); // Track BJ
      return { state: 'done' };
    } finally {
      this.running = false;
      if (epoch === this.epoch) this.tickClock();
    }
  }

  /** Track B3: the job's restock round failed: the scaffold blocks down as for a stop (stopCleaning). */
  async cleanup(reason: string): Promise<RunnerEnd> {
    if (this.running) return { state: 'stopped', reason };
    const epoch = ++this.epoch;
    this.running = true;
    try {
      return await this.stopCleaning(reason, epoch);
    } finally {
      this.running = false;
    }
  }

  /**
   * The build cannot go on (out of a block): take the scaffold blocks it placed down again first (the
   * descend and unscaffold steps ahead whose blocks are out), so the bot is not left on a column.
   */
  private async stopCleaning(reason: string, epoch: number): Promise<RunnerEnd> {
    for (let j = this.index; j < this.plan.steps.length && this.outstanding.size > 0; j++) {
      if (epoch !== this.epoch) return { state: 'paused' };
      const s = this.plan.steps[j]!;
      const mine = s.op === 'descend' ? Array.from({ length: s.height }, (_, k) => add(s.base, 0, k, 0)).some((c) => this.outstanding.has(key(c))) : s.op === 'unscaffold' && this.outstanding.has(key(s.pos));
      if (!mine) continue;
      const r = await this.exec(s, epoch);
      if (r === true && s.op === 'unscaffold') {
        this.stats.scaffoldsRemoved++;
        this.lent = Math.max(0, this.lent - 1);
        this.out(s.pos, false);
      }
    }
    await this.collectNow(6, 200);
    await this.stowRest(epoch); // Track BJ
    return { state: 'stopped', reason };
  }

  /** Track B3: where the next step works from (its stand, a column's base, its cell): the walk back after a fetch round. */
  nextPlace(): Cell | undefined {
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const s = this.plan.steps[j]!;
      if (this.finished.has(j)) continue;
      if (s.op === 'pillar' || s.op === 'descend') return s.base;
      if (s.stand) return s.stand;
      return s.pos;
    }
    return undefined;
  }

  /**
   * Track B3: the items the steps left place (a large build's next fetch round), the scaffold blocks at most out at
   * once, and the scaffold tool while the runner wants one (it asked: none carried harvests the scaffold kind) and
   * scaffold blocks are left to dig (`tool`: SCAFFOLD_PICK, enough for those digs, at most SCAFFOLD_PICKS).
   */
  remainingNeed(): { items: Map<string, number>; scaffolds: number; tool?: { item: string; n: number } } {
    const items = new Map<string, number>();
    let out = this.outstanding.size;
    let peak = out;
    let digs = out;
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const s = this.plan.steps[j]!;
      if (this.finished.has(j)) continue;
      if (s.op === 'place' || s.op === 'replace') items.set(s.item, (items.get(s.item) ?? 0) + 1 + (s.op === 'place' ? (s.pl?.merges ?? 0) : 0));
      else if (s.op === 'scaffold') {
        out++;
        digs++;
      } else if (s.op === 'pillar') {
        digs += Math.max(0, s.height - out);
        out = Math.max(out, s.height);
      } else if (s.op === 'unscaffold') out = Math.max(0, out - 1);
      else if (s.op === 'descend') out = Math.max(0, out - s.height);
      peak = Math.max(peak, out);
    }
    if (digs === 0 || !this.toolAsked) return { items, scaffolds: peak };
    // the ones carried are worn (none harvests the kind) and the bill would count them as had: that many more
    const n = Math.min(SCAFFOLD_PICKS, Math.ceil(digs / (maxDurability(SCAFFOLD_PICK) ?? 131))) + this.d.inventory.count(SCAFFOLD_PICK);
    return { items, scaffolds: peak, tool: { item: SCAFFOLD_PICK, n } };
  }

  /**
   * Track B3: the scaffold kind a column of `height` will use that nothing carried harvests (the kinds that are
   * harvested, dirt by hand, are fewer than its blocks: the column goes on with the next kind), else its first kind.
   */
  private columnKind(height: number): string | undefined {
    const kinds = this.scaffoldItems();
    let ok = 0;
    for (const k of kinds) {
      if (this.harvested(k)) ok += this.d.inventory.count(k);
      else if (ok < height) return k;
    }
    return kinds[0];
  }

  // ---- Track BJ: the carried shulker boxes

  /** Items of `item` the steps from `from` on place (until `until`, exclusive). */
  private needOf(item: string, from = this.index, until = this.plan.steps.length): number {
    let n = 0;
    for (let j = from; j < until; j++) {
      const s = this.plan.steps[j]!;
      if ((s.op === 'place' || s.op === 'replace') && s.item === item && !this.finished.has(j)) n++;
    }
    return n;
  }

  /** Loose items of `item` the throwaway reserve holds back (what the other throwaway kinds leave of it; 0 for other kinds). */
  private reserveFor(item: string): number {
    const r = this.reserve();
    const kinds = r.throwaway ?? THROWAWAY_BLOCKS;
    if (!kinds.includes(item)) return 0;
    return Math.max(0, r.throwawayMin - kinds.filter((k) => k !== item).reduce((n, k) => n + this.d.inventory.count(k), 0));
  }

  /**
   * Track B4 (decision 0129): what the next stretch of steps places, out of the carried boxes in one go. The stretch is
   * the steps from here on as far as their items (and the throwaway reserve's share of a throwaway kind) fit in the
   * slots the build may fill (the free slots and the stacks its loose items hold, less LOAD_MARGIN); what of it is not
   * loose comes out of the boxes (Supply.takeMany: each box holding any of it set down once, off the build's cells). When
   * the take needs more free slots than there are, the loose build items the stretch does not use go into a box first.
   */
  private async load(epoch: number): Promise<void> {
    const s = this.d.supply;
    if (!s?.takeMany || !s.contents || !s.freeSlots) return;
    const boxed = s.contents();
    if (boxed.size === 0) return;
    const count = (k: string) => this.d.inventory.count(k);
    const stack = (k: string) => Math.max(1, maxStackOf(k));
    const kinds = new Set<string>();
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const st = this.plan.steps[j]!;
      if ((st.op === 'place' || st.op === 'replace') && !this.finished.has(j)) kinds.add(st.item);
    }
    if (![...kinds].some((k) => (boxed.get(k) ?? 0) > 0)) return;
    const held = [...kinds].reduce((a, k) => a + Math.ceil(count(k) / stack(k)), 0);
    const cap = s.freeSlots() - LOAD_MARGIN + held;
    // the stretch: steps in order while their items fit in `cap` stacks
    const need = new Map<string, number>();
    const stacks = (m: ReadonlyMap<string, number>) => [...m].reduce((a, [k, n]) => a + Math.ceil((n + this.reserveFor(k)) / stack(k)), 0);
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const st = this.plan.steps[j]!;
      if ((st.op !== 'place' && st.op !== 'replace') || this.finished.has(j)) continue;
      const n = 1 + (st.op === 'place' ? (st.pl?.merges ?? 0) : 0);
      const next = new Map(need).set(st.item, (need.get(st.item) ?? 0) + n);
      if (stacks(next) > cap && need.size > 0) break;
      need.set(st.item, next.get(st.item)!);
    }
    const want: Record<string, number> = {};
    for (const [k, n] of need) {
      const w = Math.min(boxed.get(k) ?? 0, n + this.reserveFor(k) - count(k));
      if (w > 0) want[k] = w;
    }
    if (Object.keys(want).length === 0) return;
    const cancelled = () => epoch !== this.epoch;
    // room: the stretch's new stacks against the free slots; the build items it does not use go into a box first
    const after = new Map([...need].map(([k, n]) => [k, Math.max(n + this.reserveFor(k), count(k))] as const));
    const newStacks = stacks(after) - [...need.keys()].reduce((a, k) => a + Math.ceil(count(k) / stack(k)), 0);
    if (s.stowMany && newStacks > s.freeSlots() - LOAD_MARGIN) {
      const throwaway = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
      const keep: Record<string, number> = {};
      // (Track B6: a box the build places never goes into another box, nor is an empty one of them stow room)
      for (const k of kinds) if (!throwaway.includes(k) && !k.endsWith('shulker_box') && count(k) > (need.get(k) ?? 0)) keep[k] = need.get(k) ?? 0;
      if (Object.keys(keep).length) {
        const own = new Set(kinds);
        const r = await this.boxWork((avoid) => s.stowMany!(keep, { cancelled, avoid, notInto: (n) => own.has(n) }), epoch);
        if (cancelled()) return;
        const n = Object.values(r.stowed).reduce((a, b) => a + b, 0);
        this.stats.stowed = (this.stats.stowed ?? 0) + n;
        for (const [k, v] of Object.entries(r.stowed)) this.refilled.set(k, Math.max(0, (this.refilled.get(k) ?? 0) - v));
        this.log.info(`build: ${Object.entries(r.stowed).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'} into my shulker boxes to make room${r.reason ? ` (${r.reason})` : ''}`);
      }
    }
    const r = await this.boxWork((avoid) => s.takeMany!(want, { cancelled, avoid }), epoch);
    const got = Object.values(r.taken).reduce((a, b) => a + b, 0);
    if (got > 0) {
      this.stats.refills = (this.stats.refills ?? 0) + 1;
      this.stats.refilled = (this.stats.refilled ?? 0) + got;
      for (const [k, v] of Object.entries(r.taken)) this.refilled.set(k, (this.refilled.get(k) ?? 0) + v);
    }
    this.log.info(`build: ${Object.entries(r.taken).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'} out of ${r.boxes} shulker box${r.boxes === 1 ? '' : 'es'} for the next ${[...need.values()].reduce((a, b) => a + b, 0)} blocks${r.reason ? ` (${r.reason})` : ''}`);
  }

  /**
   * Track B4: a box job on a cell `noBox` allows; with no such cell next to the bot (beside a wall, among planned
   * stands) the bot walks to a stand within BOX_STAND_RADIUS that has one and the job runs once more.
   */
  private async boxWork<T extends { reason?: string }>(job: (avoid: (p: Cell) => boolean) => Promise<T>, epoch: number): Promise<T> {
    const first = await job(this.noBox);
    if (epoch !== this.epoch || !first.reason?.includes('no free cell for the box')) return first;
    const to = this.boxStand();
    if (!to) return first;
    const r = await this.d.goto({ type: 'block', p: to }, { timeoutTicks: GOTO_TICKS, allowBreak: false, allowPlace: false });
    if (epoch !== this.epoch || !r.ok) return first;
    return job(this.noBox);
  }

  /** Track B4: the nearest stand within BOX_STAND_RADIUS with a cell beside it a box may go on (empty, lid free, a full floor). */
  private boxStand(): Cell | undefined {
    const me = this.feet();
    if (!me) return undefined;
    const empty = (p: Cell) => {
      const b = this.d.blockAt(p);
      return !!b && b.boxes.length === 0 && !/water|lava|fire/.test(b.name);
    };
    const full = (p: Cell) => {
      const b = this.d.blockAt(p);
      return !!b && b.boxes.some((x) => x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 1 && x[4] === 1 && x[5] === 1);
    };
    const spot = (p: Cell) => !this.noBox(p) && !this.noBox(add(p, 0, 1, 0)) && empty(p) && empty(add(p, 0, 1, 0)) && full(add(p, 0, -1, 0));
    const rules = this.rules();
    let best: { f: Cell; d: number } | undefined;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -BOX_STAND_RADIUS; dx <= BOX_STAND_RADIUS; dx++) {
        for (let dz = -BOX_STAND_RADIUS; dz <= BOX_STAND_RADIUS; dz++) {
          const f = add(me, dx, dy, dz);
          const d = Math.hypot(dx, dy, dz);
          // (not the cell the bot stands on: the box job just found no cell beside it)
          if (d < 1 || (best && d >= best.d) || !canStand(this.d, f, rules)) continue;
          if (this.plan.safeEdge !== undefined && edgeDrop(this.d, f, this.plan.safeEdge + 1) > this.plan.safeEdge) continue;
          const ring = [add(f, 1, 0, 0), add(f, -1, 0, 0), add(f, 0, 0, 1), add(f, 0, 0, -1), add(f, 1, 0, 1), add(f, -1, 0, 1), add(f, 1, 0, -1), add(f, -1, 0, -1)];
          if (ring.some(spot)) best = { f, d };
        }
      }
    }
    return best?.f;
  }

  /** At least `target` of `items` loose, out of the carried boxes (the box beside the bot, off the footprint): true when some came out. */
  private async refill(items: readonly string[], target: number, epoch: number): Promise<boolean> {
    const s = this.d.supply;
    if (!s || s.carried(items) <= 0) return false;
    // no more than fits loose with a margin (a 2000-block wall must not fill the inventory)
    const loose = items.reduce((a, k) => a + this.d.inventory.count(k), 0);
    if (s.room) target = Math.min(target, loose + s.room(items));
    if (target <= loose) return false;
    const r = await this.boxWork((avoid) => s.ensure(items, target, { cancelled: () => epoch !== this.epoch, avoid }), epoch);
    if (r.fromBoxes > 0) {
      this.stats.refills = (this.stats.refills ?? 0) + 1;
      this.stats.refilled = (this.stats.refilled ?? 0) + r.fromBoxes;
      const k = items.length === 1 ? items[0]! : 'throwaway';
      this.refilled.set(k, (this.refilled.get(k) ?? 0) + r.fromBoxes);
    }
    this.log.info(`build: ${r.fromBoxes} ${items.join('/')} out of my shulker boxes (${r.loose} loose, wanted ${target})${r.reason ? `: ${r.reason}` : ''}`);
    return r.fromBoxes > 0;
  }

  /** Scaffold blocks for `n` scaffolds, the reserve on top, out of the carried boxes when short. */
  private async topUpScaffold(n: number, epoch: number): Promise<void> {
    const kinds = this.scaffoldItems(true); // a kind the build does not need first
    const loose = kinds.reduce((a, k) => a + this.d.inventory.count(k), 0);
    const target = n + this.reserve().throwawayMin;
    if (loose < target) await this.refill(kinds, target, epoch);
  }

  /** Before a pillar, on the ground: the column's places and its scaffold blocks (no box can stand on a column top). */
  private async prepareColumn(height: number, epoch: number): Promise<void> {
    let end = this.index + 1;
    while (end < this.plan.steps.length && this.plan.steps[end]!.op !== 'descend') end++;
    const items = new Set<string>();
    for (let j = this.index + 1; j < end; j++) {
      const s = this.plan.steps[j]!;
      if (s.op === 'place') items.add(s.item);
    }
    // Track B4: the stretch ahead (this column's places first) in one go, then each kind still short as before
    if ([...items].some((it) => usable(this.d.inventory, it, this.reserve()) < this.needOf(it, this.index + 1, end))) await this.load(epoch);
    for (const it of items) {
      const need = this.needOf(it, this.index + 1, end);
      if (usable(this.d.inventory, it, this.reserve()) < need) await this.refill([it], this.reserveFor(it) + need, epoch);
    }
    // the scaffold blocks on top of the column's own places of a throwaway kind (the pillar may take that kind)
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    const scaffolds = this.plan.steps.slice(this.index + 1, end).filter((s) => s.op === 'scaffold').length;
    await this.topUpScaffold(height + scaffolds + [...items].filter((it) => kinds.includes(it)).reduce((n, it) => n + this.needOf(it, this.index + 1, end), 0), epoch);
  }

  /** Track B3: the items a column (from this pillar step to its descend) places or pillars with that are not carried. */
  private columnShort(height: number): string[] {
    let end = this.index + 1;
    while (end < this.plan.steps.length && this.plan.steps[end]!.op !== 'descend') end++;
    const need = new Map<string, number>();
    let scaffolds = height;
    for (let j = this.index + 1; j < end; j++) {
      const s = this.plan.steps[j]!;
      if ((s.op === 'place' || s.op === 'replace') && !this.finished.has(j)) need.set(s.item, (need.get(s.item) ?? 0) + 1);
      else if (s.op === 'scaffold') scaffolds++;
      else if (s.op === 'pillar') scaffolds = Math.max(scaffolds, s.height);
    }
    const out = [...need].filter(([it, n]) => usable(this.d.inventory, it, this.reserve()) < n).map(([it]) => it);
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    if (kinds.reduce((a, k) => a + this.d.inventory.count(k), 0) < scaffolds) out.push(kinds[0]!);
    return out;
  }

  /** What the refills took out and the build did not use: back into a box (the reserve and what is left to place stay). */
  private async stowRest(epoch: number): Promise<void> {
    const s = this.d.supply;
    if (!s || this.refilled.size === 0) return;
    for (const [k, took] of this.refilled) {
      const names = k === 'throwaway' ? [...(this.d.reserve().throwaway ?? THROWAWAY_BLOCKS)] : [k];
      const loose = names.reduce((a, n) => a + this.d.inventory.count(n), 0);
      const keep = Math.max(loose - took, k === 'throwaway' ? this.reserve().throwawayMin : this.reserveFor(k) + this.needOf(k));
      if (loose <= keep) continue;
      const r = await this.boxWork((avoid) => s.stow(names, keep, { cancelled: () => epoch !== this.epoch, avoid }), epoch);
      this.stats.stowed = (this.stats.stowed ?? 0) + r.stowed;
      this.log.info(`build: ${r.stowed} ${k} back into my shulker box${r.reason ? ` (${r.reason})` : ''}`);
    }
    this.refilled.clear();
  }

  private finishStep(step: Step, ok: boolean, why: string): void {
    if (step.op === 'place') for (const c of cellsOf(step)) this.pending.delete(key(c));
    if (this.finished.has(this.index)) return; // a step run again after a column rebuild counts once
    this.finished.add(this.index);
    if (WORK.has(step.op)) this.stats.processed++;
    if (ok) {
      if (step.op === 'place') this.stats.placed++;
      else if (step.op === 'dig') this.stats.dug++;
      else if (step.op === 'replace') this.stats.replaced++;
      else if (step.op === 'scaffold') {
        this.stats.scaffoldsPlaced++;
        this.lent++;
        this.out(step.pos, true);
      } else if (step.op === 'unscaffold') {
        // Track B3: counted once (a stop's clean-up may have dug it already)
        if (this.out(step.pos, false)) {
          this.stats.scaffoldsRemoved++;
          this.lent = Math.max(0, this.lent - 1);
        }
      }
      if (step.op === 'place') for (const c of cellsOf(step)) this.d.cellDone?.(c);
      else if (step.op === 'dig' || step.op === 'replace') this.d.cellDone?.(step.pos);
      return;
    }
    const pos = 'pos' in step ? step.pos : step.base;
    this.stats.skipped.push({ pos, reason: `${step.op}: ${why}` });
    this.log.warn(`build: ${step.op} ${fmtCell(pos)} skipped after ${STEP_ATTEMPTS} attempts: ${why}`);
    if (step.op === 'pillar') {
      // without the column the places from its top cannot be reached: skip them, the descend digs what was built
      let j = this.index + 1;
      while (j < this.plan.steps.length && this.plan.steps[j]!.op !== 'descend') {
        const s = this.plan.steps[j]!;
        if ((s.op === 'place' || s.op === 'dig' || s.op === 'replace') && !this.finished.has(j)) {
          this.finished.add(j);
          if (s.op === 'place') for (const c of cellsOf(s)) this.pending.delete(key(c));
          this.stats.processed++;
          this.stats.skipped.push({ pos: s.pos, reason: `${s.op}: the scaffold column failed` });
        }
        j++;
      }
      this.index = j - 1;
    }
  }

  // ---- the bot's place

  private feet(): Cell | undefined {
    const p = this.d.position();
    return p ? { x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) } : undefined;
  }

  /** Track B3: a scaffold block out (`up`) or dug; the progress keeps them (a restart digs what was left). True if it was out. */
  private out(c: Cell, up: boolean): boolean {
    const k = key(c);
    const had = this.outstanding.has(k);
    if (up) this.outstanding.add(k);
    else this.outstanding.delete(k);
    if (had !== up) this.d.scaffoldAt?.(c, up);
    return had;
  }

  /** Track B3: scaffold blocks this runner put up and has not dug yet. */
  scaffoldsOut(): number {
    return this.outstanding.size;
  }

  cleaner(reason: string): BuildWork {
    return cleanerWork(this, () => this.cleanup(reason));
  }

  /** Track B3: the bot stands on a scaffold block this runner put up (a column top, or a block of it on the way down). */
  perched(): boolean {
    const f = this.feet();
    return !!f && this.outstanding.has(key(add(f, 0, -1, 0)));
  }

  private atTop(top: Cell): boolean {
    const f = this.feet();
    return !!f && f.x === top.x && f.y === top.y && f.z === top.z;
  }

  /** On resume: a column step without the bot on the column top -> dig the column and pillar again. */
  /** The current step is a column top's place / scaffold or the descend: the bot stands on (or comes down) a column. */
  private inColumnPhase(): boolean {
    const s = this.plan.steps[this.index];
    // Track B3: a pillar step that grows a column already begun counts too (the bot is on it)
    return !!s && (((s.op === 'place' || s.op === 'scaffold' || s.op === 'dig' || s.op === 'replace' || s.op === 'unscaffold') && s.top !== undefined) || s.op === 'descend' || (s.op === 'pillar' && this.outstanding.has(key(s.base))));
  }

  private checkColumn(): void {
    const s = this.plan.steps[this.index];
    if (!s) return;
    if (!this.inColumnPhase() || s.op === 'pillar') return; // Track B3: a growing column goes on from where the bot is
    let j = this.index;
    while (j >= 0 && this.plan.steps[j]!.op !== 'pillar') j--;
    const pillar = this.plan.steps[j];
    if (pillar?.op !== 'pillar' || this.atTop(add(pillar.base, 0, pillar.height, 0))) return;
    if (s.op === 'descend') return; // the descend digs what is left of the column from wherever it can
    this.log.info(`build: not on the column at ${fmtCell(pillar.base)} any more: digging it away and pillaring again`);
    this.rebuild = { base: pillar.base, height: pillar.height };
    this.index = j;
  }

  private rules() {
    return { isBlocked: (p: Cell) => this.pending.has(key(p)) };
  }

  /** Stands within reach of `t` where `ok` holds, nearest to the bot first. */
  stands(t: Cell, ok: (f: Cell) => boolean, prefer?: Cell): Cell[] {
    const out: { f: Cell; d: number }[] = [];
    const me = this.d.position();
    const rules = this.rules();
    const r = Math.ceil(BUILD_REACH);
    const lim = this.plan.safeEdge; // Track B3: no stand beside a drop that costs health
    for (let dy = -r - 1; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const f = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
          if (!canStand(this.d, f, rules) || !ok(f)) continue;
          if (lim !== undefined && edgeDrop(this.d, f, lim + 1) > lim) continue;
          const d = me ? Math.hypot(f.x + 0.5 - me.x, f.y - me.y, f.z + 0.5 - me.z) : 0;
          out.push({ f, d: prefer && key(prefer) === key(f) ? -1 : d });
        }
      }
    }
    return out.sort((a, b) => a.d - b.d).map((o) => o.f);
  }

  /** Be on a stand where `ok` holds: stay, or walk to the nearest. Returns an error or true. */
  private async standFor(t: Cell, ok: (f: Cell) => boolean, prefer: Cell | undefined, epoch: number): Promise<true | string> {
    const f = this.feet();
    if (f && this.d.onGround() && canStand(this.d, f, this.rules()) && ok(f)) return true;
    const list = this.stands(t, ok, prefer).slice(0, MAX_STANDS);
    if (list.length === 0) return 'no stand in reach';
    this.stats.walks++;
    const r = await this.d.goto(list.length === 1 ? { type: 'block', p: list[0]! } : { type: 'any', goals: list.map((p) => ({ type: 'block' as const, p })) }, { timeoutTicks: GOTO_TICKS, allowBreak: false, allowPlace: false });
    if (epoch !== this.epoch) return 'interrupted';
    if (!r.ok) return `walk: ${r.reason}`;
    const g = this.feet();
    if (!g || !ok(g)) return 'walk ended out of reach';
    return true;
  }

  // ---- steps

  private async exec(step: Step, epoch: number): Promise<true | string> {
    if (this.rebuild) {
      const r = await this.digColumn(this.rebuild, epoch);
      if (r !== true) return r;
      this.rebuild = undefined;
    }
    switch (step.op) {
      case 'place':
        if (step.pl && !plainPlacement(step.pl)) return this.placeStateful(step.pos, step.pl, step.stand, step.top, epoch);
        return this.placeStep(step.pos, step.name, step.item, step.stand, step.top, epoch, false);
      case 'scaffold':
        return this.placeStep(step.pos, undefined, undefined, step.stand, step.top, epoch, true);
      case 'pillar':
      case 'descend':
        this.clickKind = 'pillar';
        try {
          return step.op === 'pillar' ? await this.pillar(step.base, step.height, epoch) : await this.descend(step.base, step.height, epoch);
        } finally {
          this.clickKind = 'place';
        }
      case 'unscaffold':
        return this.digStep(step.pos, step.stand, epoch, step.top); // Track B7: from a column top too
      case 'dig':
        return this.digStep(step.pos, step.stand, epoch, step.top);
      case 'replace': {
        const b = this.d.blockAt(step.pos);
        if (b && blockId(b.name) === step.from) {
          const r = await this.digStep(step.pos, step.stand, epoch, step.top);
          if (r !== true) return r;
        }
        return this.placeStep(step.pos, step.to, step.item, step.stand, step.top, epoch, false);
      }
    }
  }

  /** The keeper's reserve less the scaffold blocks out in the world (they come back). */
  private reserve(): ReserveOptions {
    const r = this.d.reserve();
    return { ...r, throwawayMin: Math.max(0, r.throwawayMin - this.lent) };
  }

  /**
   * Throwaway kinds for scaffolding: those a carried tool (or the hand) harvests first (Track B3: cobblestone dug by
   * hand takes 10 s a block and drops nothing, dirt 0.75 s), then those the rest of the build does not use (`all`:
   * carried or not).
   */
  private scaffoldItems(all = false): string[] {
    const used = new Set<string>();
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const s = this.plan.steps[j]!;
      if (s.op === 'place' || s.op === 'replace') used.add(s.item);
    }
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    const rank = (k: string): number => (this.harvested(k) ? 0 : 2) + Number(used.has(k));
    return [...kinds].filter((k) => all || this.d.inventory.count(k) > 0).sort((a, b) => rank(a) - rank(b));
  }

  /** Track B3: the hand or a carried tool harvests block `k` (it drops when dug). */
  private harvested(k: string): boolean {
    if (this.d.harvests) return this.d.harvests(k);
    const m = blockMining(k);
    return !m || canHarvest(m, null) || SCAFFOLD_TOOLS.some((t) => this.d.inventory.count(t) > 0 && canHarvest(m, toolOf(t)));
  }

  private async placeStep(t: Cell, name: string | undefined, item: string | undefined, prefer: Cell | undefined, top: Cell | undefined, epoch: number, scaffold: boolean): Promise<true | string> {
    const here = this.d.blockAt(t);
    if (!here) return 'unloaded';
    if (name && blockId(here.name) === name) return true;
    if (!replaceable(here)) return scaffold && here.boxes.length > 0 ? true : `occupied (${here.name})`;
    let items: string[];
    if (scaffold) {
      items = this.scaffoldItems().slice(0, 1); // one kind: the PlaceSkill would keep the held block of any listed kind
      if (items.length === 0 && !top) {
        await this.topUpScaffold(this.plan.steps.slice(this.index).filter((s) => s.op === 'scaffold').length, epoch); // Track BJ
        if (epoch !== this.epoch) return 'interrupted';
        items = this.scaffoldItems().slice(0, 1);
      }
      if (items.length === 0 && !top) {
        items = await this.dropsIn(epoch); // Track B3
        if (epoch !== this.epoch) return 'interrupted';
      }
      if (items.length === 0 && !top) {
        const r = this.askRestock(this.scaffoldItems(true).slice(0, 1)); // Track B3
        if (r) return r;
      }
      // Track B3: on a column top the bot never walks off to fetch: the cell waits for the sweep, as a missing block does
      if (items.length === 0) return top ? 'no throwaway block left on the column top' : 'fatal:out of throwaway blocks for scaffolding';
      const rt = top ? undefined : this.toolRestock(items[0]!);
      if (rt) return rt;
    } else {
      const it = item ?? name!;
      const has = await this.haveItem(it, top, epoch);
      if (has !== true) return has;
      items = [it];
    }
    if (top) {
      if (!this.atTop(top)) return 'not on the scaffold column';
    } else {
      const s = await this.standFor(t, (f) => canPlaceFrom(this.d, f, t), prefer, epoch);
      if (s !== true) return s;
    }
    if (!scaffold && name && this.attempt === 0) {
      // Track B3: this block and the next ones the stand reaches, clicked without waiting between them
      const placed = await this.burstFrom(t, name, items[0]!, top, epoch);
      if (epoch !== this.epoch) return 'interrupted';
      if (placed) return true;
    }
    const r = await this.d.place(t, { item: items });
    if (epoch !== this.epoch) return 'interrupted';
    if (!r.ok) return `place: ${r.reason}`;
    await this.d.waitTicks(1);
    const now = this.d.blockAt(t);
    if (!now || now.boxes.length === 0 || (name && blockId(now.name) !== name)) return `placed ${now?.name ?? '?'}, not ${name ?? 'a block'}`;
    return true;
  }

  /**
   * Track B3 (decision 0128): the place step at `t` and the plain place steps right after it that the bot reaches from
   * where it stands (the same item, the same column top), clicked several a tick by placeMany: the server takes them
   * (measured: 48 blocks from one stand in 7 ticks at 16 a tick, every one accepted; a block clicked on one placed a
   * tick earlier too when the click names the new block). The steps come next in the plan's order: each then finds
   * its block there (verified like any other); a click the server refused is placed again the usual way. True when
   * the block at t is in.
   */
  private async burstFrom(t: Cell, name: string, item: string, top: Cell | undefined, epoch: number): Promise<boolean> {
    const n = this.d.burst?.() ?? 0;
    if (!this.d.placeMany || n <= 0) return false;
    const feet = this.feet();
    if (!feet) return false;
    // the blocks placed earlier in the burst count as supports
    const coming = new Map<string, BlockLike>();
    const view: BlockReader = { blockAt: (p) => coming.get(key(p)) ?? this.d.blockAt(p) };
    const solid = (nm: string): BlockLike => ({ name: nm, boxes: [[0, 0, 0, 1, 1, 1]] });
    const cells: Cell[] = [];
    let left = Math.min(BURST_MAX, usable(this.d.inventory, item, this.reserve()));
    for (let j = this.index; j < this.plan.steps.length && left > 0; j++) {
      const s = this.plan.steps[j]!;
      if (s.op !== 'place' || s.item !== item || (s.pl && !plainPlacement(s.pl)) || this.finished.has(j)) break;
      if ((s.top ? key(s.top) : '') !== (top ? key(top) : '')) break;
      const here = this.d.blockAt(s.pos);
      if (!here || !replaceable(here) || !canPlaceFrom(view, feet, s.pos)) break;
      cells.push(s.pos);
      coming.set(key(s.pos), solid(s.name));
      left--;
    }
    if (cells.length < 2) return false;
    const r = await this.d.placeMany(cells, { item, perTick: n });
    if (epoch !== this.epoch) return false;
    if (r.failed.length) this.log.debug(`build: burst of ${cells.length}: ${r.placed.length} in, ${r.failed.map((f) => `${fmtCell(f.pos)} ${f.reason}`).join(', ')}`);
    await this.d.waitTicks(1);
    const now = this.d.blockAt(t);
    return !!now && now.boxes.length > 0 && blockId(now.name) === name;
  }

  /**
   * Track B3: no throwaway block carried on the ground: the drops of a column just dug may still lie round the bot
   * (they come in a moment after the dig: e2e castle, 20 dug, 1 in after the pickup, 20 a few seconds later), so a
   * pickup, up to DROPS_TICKS for one to come in, and a second pickup first; then the scaffold kinds carried.
   */
  private async dropsIn(epoch: number): Promise<string[]> {
    await this.d.collect(DROPS_RADIUS, DROPS_TICKS).catch(() => undefined);
    for (let i = 0; i < DROPS_TICKS && this.scaffoldItems().length === 0; i++) {
      if (epoch !== this.epoch) return [];
      await this.d.waitTicks(1);
    }
    if (epoch !== this.epoch) return [];
    if (this.scaffoldItems().length === 0) await this.d.collect(DROPS_RADIUS, DROPS_TICKS).catch(() => undefined);
    if (epoch !== this.epoch) return [];
    const items = this.scaffoldItems().slice(0, 1);
    this.log.info(`build: out of scaffold blocks on the ground: ${items.length ? `${items[0]} picked up` : 'none lying round'}`);
    return items;
  }

  /**
   * Track B3: on the ground about to place scaffold blocks of `kind` that no carried tool harvests (the pickaxe broke):
   * `restock:` for SCAFFOLD_PICK, once until a tool harvests the kind again (a round that brought none goes on by hand).
   */
  private toolRestock(kind: string): string | undefined {
    if (this.harvested(kind)) {
      this.toolAsked = false;
      return undefined;
    }
    if (this.toolAsked) return undefined;
    const r = this.askRestock([SCAFFOLD_PICK]);
    if (!r) return undefined;
    this.toolAsked = true;
    this.log.info(`build: no tool I carry digs ${kind} (the scaffold blocks): a fetch round for ${SCAFFOLD_PICK}`);
    return r;
  }

  /** Track B3: `restock:<items>` once a step when the job can fetch them (else undefined: the caller stops as before). */
  private askRestock(items: readonly string[]): string | undefined {
    if (!this.d.fetchMore || items.length === 0 || this.restocked.has(this.index) || !this.d.fetchMore(items)) return undefined;
    this.restocked.add(this.index);
    return `restock:${items.join(',')}`;
  }

  /** One of `it` usable (out of a carried box on the ground when short), or why not (`fatal:` stops the build). */
  private async haveItem(it: string, top: Cell | undefined, epoch: number): Promise<true | string> {
    const r = this.reserve();
    // Track BJ: out of it on the ground: the rest of the build's need out of a carried box (Track B4: the stretch ahead
    // of every kind in one go first, room made for it)
    if (usable(this.d.inventory, it, r) < 1 && !top && this.d.supply?.takeMany) {
      await this.load(epoch);
      if (epoch !== this.epoch) return 'interrupted';
    }
    if (usable(this.d.inventory, it, r) < 1 && !top) {
      await this.refill([it], this.reserveFor(it) + this.needOf(it), epoch);
      if (epoch !== this.epoch) return 'interrupted';
    }
    if (usable(this.d.inventory, it, r) < 1 && !top && this.wrongDug > 0) {
      // Track B1: a wrong block dug for another try left its drop about; a wider pickup before giving up
      this.wrongDug = 0;
      await this.d.collect(8, 200).catch(() => undefined);
      if (epoch !== this.epoch) return 'interrupted';
    }
    if (usable(this.d.inventory, it, r) < 1) {
      // Track B3: a large build fetches more and comes back; on a column top the cell is left for its sweep
      if (!top) {
        const rs = this.askRestock([it]);
        if (rs) return rs;
      } else if (this.d.fetchMore) return `out of ${it} on the column (placed later)`;
      const kept = (r.throwaway ?? THROWAWAY_BLOCKS).includes(it) && this.d.inventory.count(it) > 0 ? ` (${this.d.inventory.count(it)} kept as the throwaway reserve)` : '';
      // Track BJ: the boxes still hold it, but nothing more fits loose
      const boxed = this.d.supply?.carried(it) ?? 0;
      if (boxed > 0 && this.d.supply?.room && this.d.supply.room([it]) <= 0) return `fatal:my inventory is full (my shulker boxes still hold ${boxed} ${it})`;
      return `fatal:out of ${it}${kept}`;
    }
    return true;
  }

  // ---- Track B1 (decision 0124): blocks whose states the click gives

  private eye(): Vec3 | undefined {
    const p = this.d.position();
    return p ? { x: p.x, y: p.y + EYE_HEIGHT, z: p.z } : undefined;
  }

  private isScaffold = (p: Cell): boolean => this.outstanding.has(key(p));

  /**
   * The block at t and its extra cells as `pl` wants them right after the click: the differences (empty: right).
   * `fixed`: only the states no later click changes (an earlier attempt may have tapped or added already).
   */
  private placedDiff(t: Cell, pl: Placement, fixed = false): string[] {
    const now = this.d.blockAt(t);
    if (!now || !(sameBlock(pl.placed, now.name) || (fixed && sameBlock(pl.name, now.name)))) return [`${now?.name ?? '?'} not ${pl.placed}`];
    const check = fixed ? Object.fromEntries(Object.entries(pl.check).filter(([k, v]) => pl.final[k] === undefined || stateTextEq(pl.final[k], v))) : pl.check;
    const out = stateDiff(check, now.states);
    for (const e of pl.extra) {
      const c = add(t, e.offset.x, e.offset.y, e.offset.z);
      const b = this.d.blockAt(c);
      if (!b || !sameBlock(e.name, b.name)) out.push(`${fmtCell(c)}: ${b?.name ?? '?'} not ${e.name}`);
      else out.push(...stateDiff(e.check, b.states).map((d) => `${fmtCell(c)}: ${d}`));
    }
    return out;
  }

  /** The block at t is the step's end (name and final states). */
  private finished_(t: Cell, pl: Placement): boolean {
    const now = this.d.blockAt(t);
    return !!now && sameBlock(pl.name, now.name) && statesMatch(pl.final, now.states);
  }

  /**
   * Place a block whose states the click gives: a stand from which an allowed face is in reach with the eye where it
   * must be, the click chosen at the real eye (the face, the point, the view), the states checked at once (a wrong
   * one dug and placed again, kept on the last attempt), then the merges and taps, the end states checked.
   */
  private async placeStateful(t: Cell, pl: Placement, prefer: Cell | undefined, top: Cell | undefined, epoch: number): Promise<true | string> {
    const last = this.attempt >= STEP_ATTEMPTS - 1;
    let here = this.d.blockAt(t);
    if (!here) return 'unloaded';
    if (this.finished_(t, pl)) return true;
    const ours = sameBlock(pl.placed, here.name) || sameBlock(pl.name, here.name);
    if (ours && this.placedDiff(t, pl, true).length > 0) {
      // an earlier attempt's block with a wrong state: dig it and place again (what the last attempt places is kept)
      const r = await this.digStep(t, undefined, epoch);
      if (r !== true) return `dig the wrong one: ${r}`;
      this.stats.redone = (this.stats.redone ?? 0) + 1;
      this.wrongDug++;
      this.digsSinceCollect++;
      await this.collectNow(4, 60);
      here = this.d.blockAt(t);
      if (!here) return 'unloaded';
    } else if (!ours && !replaceable(here)) return `occupied (${here.name})`;
    if (!sameBlock(pl.placed, here.name) && !sameBlock(pl.name, here.name)) {
      const has = await this.haveItem(pl.item, top, epoch);
      if (has !== true) return has;
      for (const e of pl.extra) {
        const c = add(t, e.offset.x, e.offset.y, e.offset.z);
        if (!replaceable(this.d.blockAt(c))) return `its second cell ${fmtCell(c)} is taken`;
      }
      if (top) {
        if (!this.atTop(top)) return 'not on the scaffold column';
      } else {
        const s = await this.standFor(t, (f) => !!canPlaceWith(this.d, f, t, pl, BUILD_REACH, this.isScaffold), prefer, epoch);
        if (s !== true) return s;
      }
      const eye = this.eye();
      if (!eye) return 'no position';
      const c = clickFor(this.d, eye, t, pl, { isScaffold: this.isScaffold, margin: 0.05 }) ?? clickFor(this.d, eye, t, pl, { isScaffold: this.isScaffold, margin: 0 });
      if (!c) return 'no click from here gives its states';
      const r = await this.d.place(t, { item: [pl.item], face: c.face, jump: false, ...(c.click ? { click: c.click } : {}), ...(c.view ? { view: c.view } : {}) });
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `place: ${r.reason}`;
      await this.d.waitTicks(1);
      const diff = this.placedDiff(t, pl);
      if (diff.length > 0) {
        this.log.info(`build: ${pl.family} ${fmtCell(t)} placed with ${diff.join(', ')} (${c.face} of ${fmtCell(c.support)}, view ${c.view ? `${c.view.yaw.toFixed(0)}/${c.view.pitch.toFixed(0)}` : '-'})`);
        if (last) return this.keepWrong(t, pl, diff);
        return `wrong state: ${diff.join(', ')}`; // the next attempt digs it
      }
    }
    // more of the same in the cell, then the taps
    here = this.d.blockAt(t);
    if (!here) return 'unloaded';
    const left = remaining(pl, here);
    for (let k = 0; k < left.merges; k++) {
      const has2 = await this.haveItem(pl.item, top, epoch);
      if (has2 !== true) return has2;
      const r = await this.d.place(t, { item: [pl.item], merge: true, face: 'up', jump: false, ...(pl.family === 'double slab' ? { click: { x: 0.5, y: 0.5, z: 0.5 } } : {}) });
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `add to it: ${r.reason}`;
      await this.d.waitTicks(1);
    }
    for (let k = 0; k < left.taps; k++) {
      if (!this.d.tap) return 'no tap';
      const view = pl.tapAvoid ? { yaw: cardinalYaw(OPPOSITE[pl.tapAvoid] as Cardinal), pitch: 30 } : undefined;
      const r = await this.d.tap(t, view);
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `tap: ${r.reason}`;
      await this.d.waitTicks(2);
    }
    if (!this.finished_(t, pl)) {
      const now = this.d.blockAt(t);
      const diff = now && sameBlock(pl.name, now.name) ? stateDiff(pl.final, now.states) : [`${now?.name ?? '?'} not ${pl.name}`];
      if (last) return this.keepWrong(t, pl, diff);
      return `not as wanted after the clicks: ${diff.join(', ')}`;
    }
    this.stats.verified = (this.stats.verified ?? 0) + 1;
    return true;
  }

  /** The last attempt placed it with a wrong state: kept and reported. */
  private keepWrong(t: Cell, pl: Placement, diff: string[]): true {
    (this.stats.wrong ??= []).push({ pos: t, name: pl.name, diff });
    this.log.warn(`build: ${pl.family} ${fmtCell(t)} kept with ${diff.join(', ')}`);
    return true;
  }

  /**
   * After the last step: the states that follow the neighbours (fences, walls, panes, rails, dust, a stair's
   * corner) and every verified block's end states again (a later neighbour may change them). A rail with the wrong
   * shape is dug and placed once more (its neighbours are all there now); the rest is reported.
   */
  private async finalCheck(epoch: number): Promise<void> {
    const wrongAt = new Set((this.stats.wrong ?? []).map((w) => key(w.pos)));
    for (const s of this.plan.steps) {
      if (s.op !== 'place' || !s.pl || wrongAt.has(key(s.pos))) continue;
      if (this.stats.skipped.some((k) => key(k.pos) === key(s.pos))) continue;
      const pl = s.pl;
      let now = this.d.blockAt(s.pos);
      if (!now || !sameBlock(pl.name, now.name)) continue; // taken away since, or never placed: skipped already
      const want = { ...pl.final, ...pl.derived };
      let diff = stateDiff(want, now.states);
      if (diff.length > 0 && pl.family === 'rail' && Object.keys(pl.derived).length > 0) {
        this.log.info(`build: rail ${fmtCell(s.pos)} has ${diff.join(', ')}: placing it again`);
        const d = await this.digStep(s.pos, undefined, epoch);
        if (epoch !== this.epoch) return;
        if (d === true) {
          this.digsSinceCollect++;
          await this.collectNow(4, 60);
          this.stats.redone = (this.stats.redone ?? 0) + 1;
          const r = await this.placeStep(s.pos, pl.name, pl.item, s.stand, undefined, epoch, false);
          if (epoch !== this.epoch) return;
          if (r !== true) this.log.info(`build: rail ${fmtCell(s.pos)} again: ${r}`);
          now = this.d.blockAt(s.pos);
          diff = now ? stateDiff(want, now.states) : ['gone'];
        }
      }
      if (diff.length > 0) {
        (this.stats.wrong ??= []).push({ pos: s.pos, name: pl.name, diff });
        this.log.warn(`build: ${pl.family} ${fmtCell(s.pos)} ends with ${diff.join(', ')}`);
      }
    }
  }

  private async digStep(t: Cell, prefer: Cell | undefined, epoch: number, top?: Cell): Promise<true | string> {
    const b = this.d.blockAt(t);
    if (!b) return 'unloaded';
    if (isAirName(b.name)) return true;
    if (top) {
      // Track B3: from the scaffold column top (no walking)
      if (!this.atTop(top)) return 'not on the scaffold column';
    } else {
      const s = await this.standFor(t, (f) => canDigFrom(f, t), prefer, epoch);
      if (s !== true) return s;
    }
    const r = await this.d.dig(t);
    if (epoch !== this.epoch) return 'interrupted';
    if (!r.ok && r.reason !== 'no_block') return `dig: ${r.reason}`;
    await this.d.waitTicks(1);
    const now = this.d.blockAt(t);
    if (now && now.boxes.length > 0) return `still ${now.name}`;
    if (++this.digsSinceCollect >= COLLECT_EVERY) await this.collectNow(6, 160);
    return true;
  }

  private async collectNow(radius: number, ticks: number): Promise<void> {
    if (this.digsSinceCollect === 0) return;
    this.digsSinceCollect = 0;
    const r = await this.d.collect(radius, ticks).catch(() => ({ ok: false as const, reason: 'error' }));
    if (!r.ok && r.reason !== 'nothing' && r.reason !== 'none') this.log.debug(`build: collect ${r.reason}`);
  }

  /** Walk to the base (unless there) and pillar up `height` blocks. */
  private async pillar(base: Cell, height: number, epoch: number): Promise<true | string> {
    const top = add(base, 0, height, 0);
    if (this.atTop(top)) return true;
    const f = this.feet();
    const onColumn = f?.x === base.x && f.z === base.z && f.y >= base.y && f.y < top.y && this.d.onGround();
    if (!onColumn) {
      if (!f || key(f) !== key(base) || !this.d.onGround()) {
        this.stats.walks++;
        const r = await this.d.goto({ type: 'block', p: base }, { timeoutTicks: GOTO_TICKS, allowBreak: false, allowPlace: false });
        if (epoch !== this.epoch) return 'interrupted';
        if (!r.ok) return `walk to the column: ${r.reason}`;
      }
      await this.prepareColumn(height, epoch); // Track BJ: on the ground at the base
      if (epoch !== this.epoch) return 'interrupted';
      const short = this.columnShort(height); // Track B3: what the column needs that is not carried: a restock first
      if (short.length) {
        const rs = this.askRestock(short);
        if (rs) return rs;
      }
      const kind = this.columnKind(height);
      const rt = kind === undefined ? undefined : this.toolRestock(kind);
      if (rt) return rt;
    }
    for (let guard = 0; guard < height + 4; guard++) {
      const g = this.feet();
      if (!g) return 'no position';
      if (g.y >= top.y) break;
      if (g.x !== base.x || g.z !== base.z) return 'left the column';
      let items = this.scaffoldItems().slice(0, 1);
      if (items.length === 0 && g.y === base.y) {
        items = await this.dropsIn(epoch); // Track B3
        if (epoch !== this.epoch) return 'interrupted';
      }
      if (items.length === 0 && g.y === base.y) {
        const rs = this.askRestock(this.scaffoldItems(true).slice(0, 1)); // Track B3
        if (rs) return rs;
      }
      // Track B3: part-way up a column that grows: the column fails (its places are skipped for the sweep, the descend
      // digs it), the build goes on
      if (items.length === 0) return g.y > base.y ? 'out of throwaway blocks on the column' : 'fatal:out of throwaway blocks for scaffolding';
      const r = await this.d.place(g, { item: items });
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `pillar: ${r.reason}`;
      this.stats.scaffoldsPlaced++;
      this.lent++;
      this.out(g, true);
      for (let i = 0; i < 20 && !this.d.onGround(); i++) await this.d.waitTicks(1);
    }
    return this.atTop(top) ? true : 'pillar ended below the top';
  }

  /** Standing on the column: dig it under the feet, top first, landing on each block. */
  private async descend(base: Cell, height: number, epoch: number): Promise<true | string> {
    for (let k = height - 1; k >= 0; k--) {
      const c = add(base, 0, k, 0);
      const b = this.d.blockAt(c);
      if (!b || b.boxes.length === 0) continue;
      const f = this.feet();
      if (f?.x !== base.x || f.z !== base.z || f.y !== c.y + 1) {
        // not standing on it (pushed off): dig it from wherever it can be reached
        const r = await this.digStep(c, undefined, epoch);
        if (r !== true) return r;
        this.stats.scaffoldsRemoved++;
        this.lent = Math.max(0, this.lent - 1);
        this.out(c, false);
        continue;
      }
      const r = await this.d.dig(c);
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `descend: ${r.reason}`;
      this.stats.scaffoldsRemoved++;
      this.lent = Math.max(0, this.lent - 1);
      this.out(c, false);
      await this.d.waitTicks(2);
      for (let i = 0; i < 30 && !this.d.onGround(); i++) await this.d.waitTicks(1);
    }
    this.digsSinceCollect++;
    await this.collectNow(4, 120);
    return true;
  }

  /** A column the bot is not standing on: dig its blocks from the ground, top first. */
  private async digColumn(c: { base: Cell; height: number }, epoch: number): Promise<true | string> {
    for (let k = c.height - 1; k >= 0; k--) {
      const p = add(c.base, 0, k, 0);
      const b = this.d.blockAt(p);
      if (!b || b.boxes.length === 0) continue;
      const r = await this.digStep(p, undefined, epoch);
      if (r !== true) return `column: ${r}`;
      this.stats.scaffoldsRemoved++;
      this.lent = Math.max(0, this.lent - 1);
      this.out(p, false);
    }
    return true;
  }
}

/** A place step's cells: its own and the ones its block fills besides (a door's upper half, a bed's head). */
function cellsOf(s: Extract<Step, { op: 'place' }>): Cell[] {
  return [s.pos, ...(s.pl?.extra ?? []).map((e) => add(s.pos, e.offset.x, e.offset.y, e.offset.z))];
}

/** `212 / 640 placed, 3 skipped` */
export function progressLine(r: BuildWork): string {
  const s = r.stats;
  const kind = r.plan.spec.kind;
  const verb = kind === 'clear' ? 'dug' : kind === 'replace' ? 'replaced' : 'placed';
  const done = kind === 'clear' ? s.dug : kind === 'replace' ? s.replaced : s.placed;
  // Track B6: the cells `skip missing` left out count as skipped
  const missing = r.plan.refused?.filter((x) => x.reason === MISSING_REASON).length ?? 0;
  return `${done} / ${r.total} ${verb}, ${s.skipped.length + missing} skipped`;
}

/** `4 min`, `40 s` */
export function etaText(s: number | undefined): string | undefined {
  if (s === undefined || !Number.isFinite(s)) return undefined;
  return s < 60 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`;
}

export { cellOf };
