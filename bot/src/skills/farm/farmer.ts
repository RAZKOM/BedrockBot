// Farming loop (PLAN.md task 7.13, docs/farming.md), the sibling of GatherWoodTask (tasks/gatherWood.ts):
//
//   scan      farmland within `radius` of the centre; the cell above each is mature / growing / empty
//   work      harvest mature crops, replant empty farmland with the matching seed, bone meal growing
//             crops (when `useBoneMeal()` and bone meal is carried)
//   stand     pick the standing cell that reaches the most work (dig and click reach), preferring
//             cells that are not farmland; refuse a route with a drop onto farmland (trampling)
//   act       at the cell: harvest (dig, 1 tick) each mature crop in reach, bone meal growing ones
//             until mature then harvest them, let the drops next to the body be picked up, plant the
//             empty cells in reach, collect the drops, plant the rest
//   pause     pause() (the process manager pre-empts `!farm`) cancels the running skill and holds the
//             loop; resume() goes on with a fresh scan (Track Z)
//
// Planting never races a pickup (Track Z, measured on BDS 1.26.60.6, docs/farming.md): the click
// carries the held stack (count, stack id); when the server merges a picked-up seed into that stack
// after the client built the click but before it processes it, it refuses the click (`rejected`:
// update_block with the old block, then a full inventory resync). Harvest drops are picked up about
// 10 ticks after they spawn, so the farmer harvests everything in reach first and waits (at most
// SETTLE_TICKS) while a drop of the seed lies within pickup range before each planting.
//   deposit   inventory full -> walk to the chest, deposit crops and surplus seeds, come back
//   wait      nothing to do -> re-scan every `waitTicks` (1200) until stop()
//
// Trampling (measured on BDS 1.26.60.6, docs/farming.md): walking over farmland never tramples it;
// falls of 0.75 blocks or less never did, 0.9 to 1.25 sometimes, 1.5 and more always; a jump in
// place on farmland (fall 1.25) trampled 4 of 6 times. The planner has no hook for a per-cell rule,
// so the farmer (1) never plans to jump while standing on farmland, (2) prefers standing cells off
// the farmland, and (3) checks the planned route (`plan`) and refuses one whose drop lands on farmland.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../world/types.ts';
import type { CollectOptions, CollectResult } from '../collect/collect.ts';
import type { DepositResult, OpenResult } from '../container/chest.ts';
import type { DigOptions, DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT, serverReachDistance } from '../dig/look.ts';
import type { Goal, NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import { closestDistance, cornerDistance, SERVER_CLICK_REACH } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import type { ClickResult } from './click.ts';
import { BONE_MEAL, CROPS, FARMLAND, FARM_ITEMS, SEEDS, fieldCell, posKey, scanField, type CropDef, type FieldCell, type FieldScan } from './crops.ts';

export type FarmState = 'idle' | 'done' | 'scan' | 'walk' | 'harvest' | 'bonemeal' | 'till' | 'plant' | 'collect' | 'to_chest' | 'deposit' | 'waiting' | 'full' | 'paused' | 'stopped' | 'failed';

export interface FarmOptions {
  /** Centre of the field (feet position or block). */
  center: Vec3;
  /** Farmland within this many blocks (x and z) of the centre. Default 8. */
  radius?: number;
  /** Chest for the harvest; default the nearest chest within radius + 16 of the centre. */
  chest?: Vec3;
  /** Deposit when fewer than this many inventory slots are free. Default 2. */
  minFreeSlots?: number;
  /** Ticks between two scans when there is nothing to do. Default 1200. */
  waitTicks?: number;
  /** Bone meal clicks per crop at most. Default 8. */
  maxBoneMealPerCrop?: number;
  /** Planning margin on the reaches (the body stops up to 0.3 off the cell centre). Default 0.35. */
  reachMargin?: number;
  /** A cell whose harvest / plant failed this often is left alone until the next wait. Default 3. */
  cellAttempts?: number;
  /** Stop after this many rounds (tests); default unlimited. */
  maxRounds?: number;
  /**
   * Follow the field (`!farm`; docs/farming.md "Following the field"): every round scans around the start, around
   * where the bot worked and around farmland found at the edge of a scan, so a field longer than the radius is
   * worked as the bot walks along it; empty farmland with no known crop gets the seed carried most; and the job
   * ends `done` when nothing is ready to harvest or plant (instead of waiting for crops to grow). Default off:
   * the old wait-and-rescan around `center` (`!farm r wait`).
   */
  follow?: boolean;
  /** Following: no scan centre farther than this from `center`. Default FARM_FOLLOW_RANGE (64). */
  maxRange?: number;
}

/** Following the field: scan centres at most this far from the start, and at most this many of them. */
export const FARM_FOLLOW_RANGE = 64;
export const FARM_FOLLOW_AREAS = 128;

export interface FarmStats {
  startedAt: number | undefined;
  finishedAt: number | undefined;
  rounds: number;
  harvested: number;
  harvestedByCrop: Record<string, number>;
  planted: number;
  /** Trampled farmland (dirt) re-tilled with a hoe. */
  tilled: number;
  boneMealUsed: number;
  boneMealGrown: number;
  stands: number;
  standFailures: number;
  /** Candidate standing cells refused because their route dropped onto farmland. */
  trampleRoutesRefused: number;
  /** Standing cells reached by stepping down one terrace onto farmland (no other route; TERRACE_FALL). */
  terraceSteps: number;
  collectRounds: number;
  collected: Record<string, number>;
  trips: number;
  deposited: Record<string, number>;
  waits: number;
  failures: number;
  /** Bot ticks per harvest dig (from the dig result). */
  harvestTicks: number[];
  /** Bot ticks per planting (call to the block update). */
  plantTicks: number[];
  /** Plantings retried once after a `rejected` answer. */
  plantRetries: number;
  /** Track Z: `rejected` answers to plantings (first tries and retries). */
  plantRejected: number;
  /** Track Z: ticks waited for drops next to the body to be picked up before a planting. */
  settleTicks: number;
  /** Track Z: times the loop was paused (pre-empted) and resumed. */
  pauses: number;
}

/** The skills the farmer uses (BotSkills satisfies it). */
export interface FarmSkills {
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
  dig(p: Vec3, opts?: DigOptions): Promise<DigResult>;
  place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>;
  collect(radius: number, timeoutTicks: number, opts?: CollectOptions): Promise<CollectResult>;
  open(p: Vec3): Promise<OpenResult>;
  deposit(view: ContainerView, filter: (i: ItemStack) => boolean): Promise<DepositResult>;
  closeContainer(view: ContainerView | number): Promise<boolean>;
  cancel(): void;
}

/** A planned route, for the trampling check (Navigator.plan). */
export interface FarmPlan {
  status: 'found' | 'partial' | 'none';
  path: readonly { x: number; y: number; z: number; feet: number; move: string }[];
}

export interface FarmDeps {
  skills: FarmSkills;
  /** Plan only, from the body to the goal (Navigator.plan); enables the trampling check. */
  plan?: (goal: Goal) => FarmPlan | undefined;
  /** Feet height when the body can stand in cell (x, y, z), NaN when not, undefined when unknown (NavGrid.stand). */
  stand: (x: number, y: number, z: number) => number | undefined;
  world: {
    blockAt(p: Vec3): BlockInfo | undefined;
    find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number; class?: 'chest' }): Vec3[];
    readonly inventory: { readonly slots: readonly (ItemStack | null)[]; freeSlots(): number[]; count(name: string): number };
    /** Item drops (entity tracker), for "is anything left to collect". */
    readonly entities?: ReadonlyMap<bigint, { type: string; pos: Vec3; item?: ItemStack }>;
  };
  /** Bone meal / berry clicks (skills/farm/click.ts). */
  click: (p: Vec3, item: string | null) => Promise<ClickResult>;
  /** Cancel a running click (stop()). */
  cancelClick?: () => void;
  /** Feet position when known. */
  position: () => Vec3 | undefined;
  /** The bot can act (spawned, input loop ready, alive). */
  ready: () => boolean;
  waitTicks: (n: number) => Promise<void>;
  /** Setting `useBoneMeal` (default true); read on every round (Track Q's settings can drive it). */
  useBoneMeal?: () => boolean;
  log?: Logger;
  now?: () => number;
}

/** Reaches used for planning (the skills check their own: dig 5, click 5 and the server's 7.19). */
export const DIG_REACH = 5;
export const CLICK_REACH = 5;
export const DIG_SERVER_REACH = 10;

type WorkKind = 'harvest' | 'plant' | 'bonemeal' | 'till';

/** Hoes, any of which re-tills trampled farmland (dirt with air above). */
export const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe'] as const;
/** With a hoe carried a trampled cell is repaired, so a route may fall this far onto farmland (no fall damage up to 3). */
export const HOE_FALL = 3;

interface Work {
  kind: WorkKind;
  cell: FieldCell;
}

interface StandCell {
  x: number;
  y: number;
  z: number;
  feet: number;
  onFarmland: boolean;
  work: Work[];
  score: number;
}


/** Eye position for a body standing at the centre of cell (x, z) with feet height `feet`. */
export function eyeAt(x: number, feet: number, z: number): Vec3 {
  return { x: x + 0.5, y: feet + EYE_HEIGHT, z: z + 0.5 };
}

/** True when work `w` can be done from `eye` (with `margin` blocks to spare). */
export function workInReach(eye: Vec3, kind: WorkKind, cell: FieldCell, margin = 0): boolean {
  if (kind === 'harvest') return closestDistance(eye, cell.crop) <= DIG_REACH - margin && serverReachDistance(eye, cell.crop) <= DIG_SERVER_REACH - margin;
  const b = kind === 'plant' || kind === 'till' ? cell.soil : cell.crop;
  return closestDistance(eye, b) <= CLICK_REACH - margin && cornerDistance(eye, b) <= SERVER_CLICK_REACH - margin;
}

/** The block the body stands on in node (x, y, z) with feet height `feet`. */
export function floorOf(x: number, y: number, z: number, feet: number): Vec3 {
  return feet - y > 1e-6 ? { x, y, z } : { x, y: y - 1, z };
}

/** Extra margin around the body (0.6 wide) within which a cell is not planted: BDS refused plantings next to the body. */
export const BODY_PAD = 0.15;

/** The body at `feet` (0.6 x 1.8), grown by `pad` horizontally, touches cell `p`. */
export function bodyNear(p: Vec3, feet: Vec3, pad: number): boolean {
  const w = 0.3 + pad;
  return feet.x + w > p.x && feet.x - w < p.x + 1 && feet.z + w > p.z && feet.z - w < p.z + 1 && feet.y < p.y + 1 && feet.y + 1.8 > p.y;
}

/** Track Z: a drop this close to the feet (horizontally, blocks) is about to be picked up: plantings wait for it. */
export const PICKUP_RANGE = 2;
/** Track Z: a drop older than this (ms since first seen) that is still lying there is not being picked up. */
export const PICKUP_FRESH_MS = 1000;
/** Track Z: at most this many ticks of waiting for such a pickup before a planting (drops are picked up about 10 ticks after they spawn). */
export const SETTLE_TICKS = 16;

/** Standing cells (best first) whose routes are planned before giving up on a round. */
export const STAND_TRIES = 24;

/** Falls up to this height onto farmland never trampled it (measured: 0/16 up to 0.75, 3/12 at 0.9 to 1.1). */
export const SAFE_FALL = 0.75;

/**
 * True when a planned route drops onto farmland from higher than SAFE_FALL. Walks, the 0.0625 step
 * from grass onto farmland (the planner calls it a drop) and jumps up onto farmland are fine.
 */
export function routeTramples(path: FarmPlan['path'], blockAt: (p: Vec3) => BlockInfo | undefined): boolean {
  return farmlandDrop(path, blockAt) > SAFE_FALL;
}

/** Moves that go down without a fall (a ladder or vine, out of water). */
const CONTROLLED: ReadonlySet<string> = new Set(['climb', 'climbOut', 'swim', 'swimOut']);

/** The deepest fall of a planned route onto farmland (0 = none; drops, parkour and the like). */
export function farmlandDrop(path: FarmPlan['path'], blockAt: (p: Vec3) => BlockInfo | undefined): number {
  let worst = 0;
  for (let i = 1; i < path.length; i++) {
    const n = path[i]!;
    const fall = path[i - 1]!.feet - n.feet;
    if (fall <= SAFE_FALL || fall <= worst || CONTROLLED.has(n.move)) continue;
    if (blockAt(floorOf(n.x, n.y, n.z, n.feet))?.name === FARMLAND) worst = fall;
  }
  return worst;
}

/**
 * A terraced field (rows of farmland one block apart, no path between them): when no route reaches the work
 * without a fall onto farmland, one that steps down a single terrace (at most this high) is taken (measured: 1 in
 * 4 such falls trampled). Deeper falls are never taken.
 */
export const TERRACE_FALL = 1.1;

/** Following: add scan centre `p` unless one is within half the radius of it already, it is beyond `range` from the start, or there are FARM_FOLLOW_AREAS. */
export function addArea(areas: Vec3[], p: Vec3, start: Vec3, radius: number, range: number): boolean {
  if (areas.length >= FARM_FOLLOW_AREAS) return false;
  if (Math.hypot(p.x - start.x, p.z - start.z) > range) return false;
  if (areas.some((a) => Math.abs(a.x - p.x) <= radius / 2 && Math.abs(a.z - p.z) <= radius / 2 && Math.abs(a.y - p.y) <= 4)) return false;
  areas.push({ ...p });
  return true;
}

export class FarmTask {
  readonly name = 'farm';
  state: FarmState = 'idle';
  readonly stats: FarmStats = newStats();
  opts: FarmOptions | undefined;
  lastError: string | undefined;
  private readonly d: FarmDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private gen = 0;
  /** soil position -> the crop last seen growing there (replant the same). */
  private readonly memory = new Map<string, CropDef>();
  private readonly cellFails = new Map<string, number>();
  private readonly standFails = new Map<string, number>();
  private readonly doneFns = new Set<(s: FarmState) => void>();
  private chest: Vec3 | undefined;
  private paused = false;
  private beforePause: FarmState = 'scan';

  constructor(deps: FarmDeps) {
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => Date.now());
  }

  get running(): boolean {
    return !['idle', 'stopped', 'failed'].includes(this.state);
  }

  /** Start (or restart). Resolves when the loop ends (stop(), maxRounds, or a failure). */
  start(opts: FarmOptions): Promise<FarmState> {
    this.gen++;
    this.d.skills.cancel();
    this.opts = opts;
    Object.assign(this.stats, newStats());
    this.stats.startedAt = this.now();
    this.soils.clear();
    this.cellFails.clear();
    this.standFails.clear();
    this.lastError = undefined;
    this.chest = opts.chest;
    this.state = 'scan';
    this.log.info(`farm: radius ${opts.radius ?? 8} around ${fmt(opts.center)}, chest ${opts.chest ? fmt(opts.chest) : 'nearest'}`);
    const gen = this.gen;
    return this.run(gen).catch((e: unknown) => {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log.error(`farm: ${this.lastError}`);
      return this.end(gen, 'failed');
    });
  }

  stop(): void {
    if (!this.running) return;
    this.gen++;
    this.paused = false;
    this.d.skills.cancel();
    this.d.cancelClick?.();
    this.end(this.gen, 'stopped');
  }

  /** Pre-empted (process manager): cancel the running skill at once and hold the loop until resume(). */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.stats.pauses++;
    this.beforePause = this.state;
    this.state = 'paused';
    this.d.skills.cancel();
    this.d.cancelClick?.();
    this.log.info('farm: paused');
  }

  /** Go on after pause() with a fresh scan. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // a short pause may end before the loop noticed it (e.g. inside a wait): show what it does again
    if (this.state === 'paused') this.state = this.beforePause;
    this.log.info('farm: resumed');
  }

  get isPaused(): boolean {
    return this.paused;
  }

  onDone(fn: (s: FarmState) => void): () => void {
    this.doneFns.add(fn);
    return () => this.doneFns.delete(fn);
  }

  status(): Record<string, unknown> {
    const s = this.stats;
    const end = s.finishedAt ?? this.now();
    return {
      state: this.state,
      radius: this.opts?.radius ?? null,
      center: this.opts?.center ?? null,
      chest: this.chest ?? null,
      elapsedS: s.startedAt ? +((end - s.startedAt) / 1000).toFixed(1) : 0,
      lastError: this.lastError ?? null,
      ...s,
      harvestTicks: undefined,
      plantTicks: undefined,
    };
  }

  /** One line for chat. */
  summary(): string {
    const s = this.stats;
    return `farm: ${this.state}, ${s.harvested} harvested, ${s.planted} planted, ${s.boneMealUsed} bone meal, ${s.trips} trips, ${s.rounds} rounds`;
  }

  // ---- the loop ----------------------------------------------------------------------------------

  private alive(gen: number): boolean {
    return gen === this.gen;
  }

  /** Alive and not paused: the work steps go on. */
  private go(gen: number): boolean {
    return gen === this.gen && !this.paused;
  }

  private end(gen: number, state: FarmState): FarmState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.log.info(`${this.summary()}; ${this.stats.plantRejected} plantings rejected, ${this.stats.settleTicks} ticks waited for pickups${this.lastError ? ` (${this.lastError})` : ''}`);
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private async run(gen: number): Promise<FarmState> {
    const o = this.opts!;
    const radius = o.radius ?? 8;
    const minFree = o.minFreeSlots ?? 2;
    let depositFails = 0;
    /** Following: the scan centres (the start first). */
    const areas: Vec3[] = [{ ...o.center }];
    this.areas = areas;
    while (this.alive(gen)) {
      if (o.maxRounds !== undefined && this.stats.rounds >= o.maxRounds) return this.end(gen, 'idle');
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
      const inv = this.d.world.inventory;
      if (inv.freeSlots().length < minFree && this.depositables().length > 0) {
        const chest = this.findChest();
        if (!chest) {
          this.state = 'full';
          this.lastError = 'inventory full and no chest';
          this.log.warn(`farm: ${this.lastError}; waiting`);
          await this.sleep(gen, o.waitTicks ?? 1200);
          continue;
        }
        const ok = await this.depositTrip(gen, chest);
        if (!this.alive(gen)) break;
        if (this.paused) continue; // pre-empted on the way: not a failed trip
        if (!ok) {
          if (++depositFails >= 3) {
            this.lastError = 'deposit failed 3 times in a row';
            return this.end(gen, 'failed');
          }
          await this.d.waitTicks(40);
        } else depositFails = 0;
        continue;
      }

      this.state = 'scan';
      this.stats.rounds++;
      const scan = o.follow ? this.scanFollow(areas, radius, o.maxRange ?? FARM_FOLLOW_RANGE) : this.scan(o.center, radius);
      // farmland seen this run that is dirt now (trampled): re-tilled and replanted when a hoe is carried
      const work = [...this.workOf(scan), ...(this.hoe() ? this.trampled().map((cell) => ({ kind: 'till' as const, cell })) : [])];
      if (work.length === 0) {
        // anything left on the ground in the field? (following: around the bot, which is where it last worked)
        const dropsAt = o.follow ? (this.d.position() ?? o.center) : o.center;
        if (this.dropsNear(dropsAt, radius + 2) && inv.freeSlots().length > 0) {
          this.state = 'collect';
          this.stats.collectRounds++;
          // dropsNear looks in a square; the collect radius is a circle: cover the square's corners (Track Z: a
          // drop in a corner of a 9 x 9 field was 6.4 blocks from the centre and stayed there)
          const c = await this.d.skills.collect(Math.ceil((radius + 2) * Math.SQRT2), 300, { origin: dropsAt, filter: (i) => FARM_ITEMS.has(i.name) });
          this.addCollected(c);
          if (!this.alive(gen)) break;
          if (c.pickedUp > 0) continue;
        }
        if (o.follow) {
          const lost = this.trampled().length;
          if (lost) this.log.warn(`farm: ${lost} trampled farmland left as dirt (no hoe carried)`);
          this.log.info(`farm: nothing left to harvest or plant (${scan.cells.length} farmland in ${areas.length} area${areas.length === 1 ? '' : 's'}, ${scan.growing.length} growing)`);
          return this.end(gen, 'done');
        }
        this.state = 'waiting';
        this.stats.waits++;
        this.cellFails.clear();
        this.standFails.clear();
        this.log.info(`farm: nothing to do (${scan.cells.length} farmland, ${scan.growing.length} growing); next scan in ${o.waitTicks ?? 1200} ticks`);
        await this.sleep(gen, o.waitTicks ?? 1200);
        continue;
      }

      const stand = this.chooseStand(work, o.reachMargin ?? 0.35);
      if (!stand) {
        this.stats.failures++;
        // only the work the refused cells were chosen for: the rest of a big field is tried next round (a Realm
        // terraced field: failing every item ended the job after 94 of 1491 cells)
        for (const w of this.refusedWork.length ? this.refusedWork : work) this.failCell(w.cell);
        this.log.warn(`farm: no standing cell reaches ${this.refusedWork.length || work.length} of ${work.length} work items`);
        await this.d.waitTicks(20);
        continue;
      }
      this.state = 'walk';
      const g = await this.d.skills.goto({ type: 'block', p: { x: stand.x, y: stand.y, z: stand.z } }, { timeoutTicks: 2400, avoidFarmlandDrops: true });
      if (!this.alive(gen)) break;
      if (!g.ok) {
        if (g.reason === 'interrupted') {
          await this.d.waitTicks(10);
          continue;
        }
        this.stats.standFailures++;
        const k = `${stand.x},${stand.y},${stand.z}`;
        this.standFails.set(k, (this.standFails.get(k) ?? 0) + 1);
        this.log.warn(`farm: goto ${k}: ${g.reason}`);
        continue;
      }
      this.stats.stands++;
      await this.workHere(gen, scan, work.filter((w) => w.kind === 'till').map((w) => w.cell));
      // following: where it worked is scanned from now on (the field beyond the start's radius comes into view)
      const at = this.d.position();
      if (o.follow && at) addArea(areas, at, o.center, radius, o.maxRange ?? FARM_FOLLOW_RANGE);
    }
    return this.state;
  }

  /** Following: the scan centres of the current run (status, tests). */
  areas: readonly Vec3[] = [];

  /**
   * Following (docs/farming.md "Following the field"): the union of the scans around every centre in `areas`
   * (cells deduplicated); farmland within 1 of a scan's edge adds a centre there, so the next round sees the
   * field beyond it. Empty cells with no known crop get the carried seed the bot has most of.
   */
  private scanFollow(areas: Vec3[], radius: number, range: number): FieldScan {
    const seen = new Map<string, FieldCell>();
    // (areas grows while it is walked: an array's for-of visits the centres added during the loop too)
    for (const a of areas) {
      const s = this.scan(a, radius);
      for (const c of s.cells) {
        seen.set(posKey(c.soil), c);
        if (Math.abs(c.soil.x + 0.5 - a.x) >= radius - 1 || Math.abs(c.soil.z + 0.5 - a.z) >= radius - 1) addArea(areas, { x: c.soil.x + 0.5, y: c.soil.y + 1, z: c.soil.z + 0.5 }, areas[0]!, radius, range);
      }
    }
    const cells = [...seen.values()];
    const carried = this.carriedCrop();
    // empty farmland: the crop remembered for it (or the field's most common one) when its seed is carried, else the
    // seed carried most (an empty field, or the field's own seed ran out: the owner wants every empty cell planted)
    for (const c of cells) if (c.state === 'empty' && (!c.kind || this.d.world.inventory.count(c.kind.seed) === 0)) c.kind = carried;
    return { cells, mature: cells.filter((c) => c.state === 'mature'), growing: cells.filter((c) => c.state === 'growing'), empty: cells.filter((c) => c.state === 'empty') };
  }

  /** The crop of the seed item carried most (for farmland nothing is remembered for), undefined without seeds. */
  private carriedCrop(): CropDef | undefined {
    let best: { c: CropDef; n: number } | undefined;
    for (const c of Object.values(CROPS)) {
      const n = this.d.world.inventory.count(c.seed);
      if (n > 0 && (!best || n > best.n)) best = { c, n };
    }
    return best?.c;
  }

  private async sleep(gen: number, ticks: number): Promise<void> {
    for (let t = 0; t < ticks && this.go(gen); t += 20) await this.d.waitTicks(Math.min(20, ticks - t));
  }

  private scan(center: Vec3, radius: number): FieldScan {
    const w = this.d.world;
    const scan = scanField((p) => w.blockAt(p), (pred, o) => w.find(pred, o), center, radius, this.memory);
    for (const c of scan.cells) {
      if (c.kind && c.state !== 'empty') this.memory.set(posKey(c.soil), c.kind);
      this.soils.set(posKey(c.soil), c.soil);
    }
    return scan;
  }

  private canPlant(c: FieldCell): boolean {
    return !!c.kind && this.d.world.inventory.count(c.kind.seed) > 0;
  }

  private boneMealOn(): boolean {
    return (this.d.useBoneMeal?.() ?? true) && this.d.world.inventory.count(BONE_MEAL) > 0;
  }

  private workOf(scan: FieldScan): Work[] {
    const ok = (c: FieldCell) => (this.cellFails.get(posKey(c.soil)) ?? 0) < (this.opts?.cellAttempts ?? 3);
    const out: Work[] = [];
    for (const c of scan.mature) if (ok(c)) out.push({ kind: 'harvest', cell: c });
    for (const c of scan.empty) if (ok(c) && this.canPlant(c)) out.push({ kind: 'plant', cell: c });
    if (this.boneMealOn()) for (const c of scan.growing) if (ok(c)) out.push({ kind: 'bonemeal', cell: c });
    return out;
  }

  private failCell(c: FieldCell): void {
    const k = posKey(c.soil);
    this.cellFails.set(k, (this.cellFails.get(k) ?? 0) + 1);
  }

  /** Standing cells around the work, best first; the first whose route does not trample wins. */
  private chooseStand(work: Work[], margin: number): StandCell | undefined {
    const blockAt = (p: Vec3) => this.d.world.blockAt(p);
    const pos = this.d.position();
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const w of work) {
      x0 = Math.min(x0, w.cell.soil.x);
      x1 = Math.max(x1, w.cell.soil.x);
      z0 = Math.min(z0, w.cell.soil.z);
      z1 = Math.max(z1, w.cell.soil.z);
      y0 = Math.min(y0, w.cell.soil.y);
      y1 = Math.max(y1, w.cell.soil.y);
    }
    const cands: StandCell[] = [];
    for (let x = x0 - 4; x <= x1 + 4; x++) {
      for (let z = z0 - 4; z <= z1 + 4; z++) {
        for (let y = y0 - 1; y <= y1 + 2; y++) {
          const feet = this.d.stand(x, y, z);
          if (feet === undefined || !Number.isFinite(feet)) continue;
          if ((this.standFails.get(`${x},${y},${z}`) ?? 0) >= 2) continue;
          const onFarmland = blockAt(floorOf(x, y, z, feet))?.name === FARMLAND;
          const eye = eyeAt(x, feet, z);
          const reach = work.filter((w) => !(w.cell.crop.x === x && w.cell.crop.z === z) && workInReach(eye, w.kind, w.cell, margin));
          if (reach.length === 0) continue;
          const d = pos ? Math.hypot(x + 0.5 - pos.x, feet - pos.y, z + 0.5 - pos.z) : 0;
          // most work in reach, harvests weigh more (they free cells to plant); off the farmland; near the bot
          const value = reach.reduce((a, w) => a + (w.kind === 'harvest' ? 3 : 2), 0); // tills count like plantings
          cands.push({ x, y, z, feet, onFarmland, work: reach, score: -value + (onFarmland ? 4 : 0) + 0.3 * d });
        }
      }
    }
    cands.sort((a, b) => a.score - b.score);
    this.refusedWork = [];
    let terrace: StandCell | undefined;
    const tried = new Set<Work>();
    for (const c of cands.slice(0, STAND_TRIES)) {
      if (!this.d.plan) return c;
      for (const w of c.work) tried.add(w);
      const p = this.d.plan({ type: 'block', p: { x: c.x, y: c.y, z: c.z } });
      if (!p || p.status === 'none') continue;
      const fall = farmlandDrop(p.path, blockAt);
      if (fall > SAFE_FALL) {
        this.stats.trampleRoutesRefused++;
        // a hoe repairs a trampled cell (re-till + replant): then any fall without damage is fine
        if (!terrace && fall <= (this.hoe() ? HOE_FALL : TERRACE_FALL)) terrace = c;
        continue;
      }
      return c;
    }
    if (terrace) {
      this.stats.terraceSteps++;
      this.log.info(`farm: every route steps down onto farmland; taking the one-terrace step to ${terrace.x} ${terrace.y} ${terrace.z}`);
      return terrace;
    }
    if (this.stats.trampleRoutesRefused) this.log.info(`farm: ${Math.min(cands.length, STAND_TRIES)} standing cells refused (routes drop onto farmland or none found)`);
    this.refusedWork = [...tried];
    return undefined;
  }

  /** Every farmland block seen this run (soil key -> position): one that turns to dirt was trampled. */
  private readonly soils = new Map<string, Vec3>();

  /** A hoe carried, else undefined. */
  private hoe(): string | undefined {
    return HOES.find((h) => this.d.world.inventory.count(h) > 0);
  }

  /** Farmland seen this run that is dirt with air above now (trampled), not failed too often, as empty cells. */
  private trampled(): FieldCell[] {
    const w = this.d.world;
    const out: FieldCell[] = [];
    for (const [k, soil] of this.soils) {
      if (w.blockAt(soil)?.name !== 'dirt' || (this.cellFails.get(k) ?? 0) >= (this.opts?.cellAttempts ?? 3)) continue;
      const above = w.blockAt({ x: soil.x, y: soil.y + 1, z: soil.z });
      if (above && above.name !== 'air') continue;
      out.push({ soil, crop: { x: soil.x, y: soil.y + 1, z: soil.z }, state: 'empty', kind: this.memory.get(k), growth: undefined });
    }
    return out;
  }

  /** The work the standing cells refused by the last chooseStand() were picked for. */
  private refusedWork: Work[] = [];

  private eyeNow(): Vec3 | undefined {
    const p = this.d.position();
    return p ? { x: p.x, y: p.y + EYE_HEIGHT, z: p.z } : undefined;
  }

  private inReachNow(kind: WorkKind, c: FieldCell): boolean {
    const eye = this.eyeNow();
    if (!eye) return false;
    // the server refuses a placement into a cell the body touches (and pads the body a little)
    if (kind === 'plant' && bodyNear(c.crop, { x: eye.x, y: eye.y - EYE_HEIGHT, z: eye.z }, BODY_PAD)) return false;
    return workInReach(eye, kind, c, 0.05);
  }

  /** Everything in reach of where the bot stands: harvest + replant, bone meal, collect, plant. */
  private async workHere(gen: number, scan: FieldScan, tills: FieldCell[] = []): Promise<void> {
    const w = this.d.world;
    const fresh = (c: FieldCell): FieldCell => fieldCell((p) => w.blockAt(p), c.soil, this.memory.get(posKey(c.soil)) ?? c.kind);
    const byDistance = (cells: FieldCell[]) => {
      const eye = this.eyeNow();
      return eye ? [...cells].sort((a, b) => closestDistance(eye, a.crop) - closestDistance(eye, b.crop)) : cells;
    };
    const plantAll = async (cells: FieldCell[]): Promise<boolean> => {
      for (const c0 of byDistance(cells)) {
        if (!this.go(gen)) return false;
        const c = fresh(c0);
        if (c.state !== 'empty' || !this.canPlant(c) || !this.inReachNow('plant', c)) continue;
        await this.plant(gen, c);
      }
      return this.go(gen);
    };
    // 1. harvest everything mature in reach (planting waits: the drops are picked up meanwhile)
    for (const c0 of byDistance(scan.mature)) {
      if (!this.go(gen)) return;
      const c = fresh(c0);
      if (c.state !== 'mature' || !this.inReachNow('harvest', c)) continue;
      await this.harvest(c);
    }
    // 2. bone meal growing crops in reach, then harvest them
    if (this.boneMealOn()) {
      for (const c0 of byDistance([...scan.growing, ...scan.empty])) {
        if (!this.go(gen) || !this.boneMealOn()) break;
        let c = fresh(c0);
        if (c.state !== 'growing' || !this.inReachNow('bonemeal', c)) continue;
        for (let i = 0; i < (this.opts?.maxBoneMealPerCrop ?? 8) && c.state === 'growing' && this.boneMealOn() && this.go(gen); i++) {
          this.state = 'bonemeal';
          const r = await this.d.click(c.crop, BONE_MEAL);
          if (!r.ok) {
            this.log.info(`farm: bone meal on ${fmt(c.crop)}: ${r.reason}`);
            if (r.reason !== 'interrupted') this.failCell(c);
            break;
          }
          this.stats.boneMealUsed++;
          c = fresh(c);
        }
        if (!this.go(gen)) return;
        if (c.state === 'mature') {
          this.stats.boneMealGrown++;
          await this.harvest(c);
        }
      }
    }
    // 2b. re-till trampled farmland in reach (it is planted below with the rest)
    const tilled: FieldCell[] = [];
    for (const c of byDistance(tills)) {
      const hoe = this.hoe();
      if (!this.go(gen) || !hoe) break;
      if (w.blockAt(c.soil)?.name !== 'dirt' || !this.inReachNow('till', c)) continue;
      this.state = 'till';
      const r = await this.d.click(c.soil, hoe);
      if (!this.go(gen)) return;
      if (!r.ok || w.blockAt(c.soil)?.name !== FARMLAND) {
        if (!r.ok && r.reason === 'interrupted') return;
        this.failCell(c);
        this.log.info(`farm: till ${fmt(c.soil)} with ${hoe}: ${r.ok ? `now ${w.blockAt(c.soil)?.name}` : r.reason}`);
        continue;
      }
      this.stats.tilled++;
      if (!this.memory.has(posKey(c.soil))) {
        const k = c.kind ?? this.carriedCrop();
        if (k) this.memory.set(posKey(c.soil), k);
      }
      tilled.push(fresh(c));
    }
    // 3. replant the harvested cells (and any empty one) in reach
    if (!(await plantAll([...scan.mature, ...scan.empty, ...scan.growing, ...tilled]))) return;
    // 4. collect the drops around here
    const here = this.d.position();
    if (here && this.dropsNear(here, 6)) {
      this.state = 'collect';
      this.stats.collectRounds++;
      const r = await this.d.skills.collect(6, 200, { origin: here, filter: (i) => FARM_ITEMS.has(i.name) });
      this.addCollected(r);
      if (!this.go(gen)) return;
    }
    // 5. plant what is still empty in reach (seeds may have come with the drops)
    await plantAll([...scan.empty, ...scan.mature, ...scan.growing, ...tilled]);
  }

  /** First time each item drop was seen (ms): only fresh drops are still waiting for their pickup delay. */
  private readonly dropSeen = new Map<bigint, number>();

  /** Note the drops in the world now (called after each harvest, so a drop's first sighting is about its spawn). */
  private noteDrops(): void {
    const ents = this.d.world.entities;
    if (!ents) return;
    const now = this.now();
    for (const [id, e] of ents) if (e.type === 'minecraft:item' && !this.dropSeen.has(id)) this.dropSeen.set(id, now);
    if (this.dropSeen.size > 512) for (const id of [...this.dropSeen.keys()]) if (!ents.has(id)) this.dropSeen.delete(id);
  }

  /**
   * A fresh drop of `item` (seen less than PICKUP_FRESH_MS ago) lies within pickup range of the body:
   * the server is about to merge it into the held stack. An older drop that is still there is out of
   * the server's pickup range (it would have been picked up) and does not count.
   */
  private pickupPending(item: string): boolean {
    const ents = this.d.world.entities;
    const p = this.d.position();
    if (!ents || !p) return false;
    this.noteDrops();
    const now = this.now();
    for (const [id, e] of ents) {
      if (e.type !== 'minecraft:item' || e.item?.name !== item) continue;
      if (now - (this.dropSeen.get(id) ?? now) > PICKUP_FRESH_MS) continue;
      if (Math.abs(e.pos.x - p.x) <= PICKUP_RANGE && Math.abs(e.pos.z - p.z) <= PICKUP_RANGE && e.pos.y > p.y - 1.5 && e.pos.y < p.y + 2.8) return true;
    }
    return false;
  }

  /** Wait (at most SETTLE_TICKS) until no drop of `item` is about to be picked up. */
  private async settle(gen: number, item: string): Promise<void> {
    for (let i = 0; i < SETTLE_TICKS && this.go(gen) && this.pickupPending(item); i++) {
      this.stats.settleTicks++;
      await this.d.waitTicks(1);
    }
  }

  private async harvest(c: FieldCell): Promise<boolean> {
    this.state = 'harvest';
    const r = await this.d.skills.dig(c.crop);
    if (!r.ok) {
      if (r.reason !== 'interrupted') this.failCell(c);
      this.log.info(`farm: harvest ${fmt(c.crop)}: ${r.reason}`);
      return false;
    }
    this.stats.harvested++;
    this.noteDrops();
    const k = c.kind?.block ?? r.block ?? '?';
    this.stats.harvestedByCrop[k] = (this.stats.harvestedByCrop[k] ?? 0) + 1;
    if (r.ticks !== undefined) this.stats.harvestTicks.push(r.ticks);
    if (c.kind) this.memory.set(posKey(c.soil), c.kind);
    return true;
  }

  private async plant(gen: number, c: FieldCell): Promise<boolean> {
    const kind = c.kind;
    if (!kind) return false;
    this.state = 'plant';
    await this.settle(gen, kind.seed);
    if (!this.go(gen)) return false;
    let r = await this.d.skills.place(c.crop, { face: 'up', item: kind.seed });
    if (!r.ok && r.reason === 'rejected') {
      // A pickup merged into the seed stack between the click and the server reading it (the held
      // stack no longer matched). Should not happen after settle(); kept as a safety net: one retry
      // with the current item after the server's inventory resync.
      this.stats.plantRejected++;
      this.stats.plantRetries++;
      await this.d.waitTicks(3);
      await this.settle(gen, kind.seed);
      r = await this.d.skills.place(c.crop, { face: 'up', item: kind.seed });
      if (!r.ok && r.reason === 'rejected') this.stats.plantRejected++;
    }
    if (!r.ok) {
      if (r.reason !== 'interrupted') this.failCell(c);
      this.log.info(`farm: plant ${kind.seed} at ${fmt(c.crop)}: ${r.reason}`);
      return false;
    }
    this.stats.planted++;
    if (r.ticks !== undefined) this.stats.plantTicks.push(r.ticks);
    return true;
  }

  private addCollected(c: CollectResult): void {
    for (const [k, v] of Object.entries(c.gained)) if (v > 0) this.stats.collected[k] = (this.stats.collected[k] ?? 0) + v;
  }

  private dropsNear(p: Vec3, r: number): boolean {
    const ents = this.d.world.entities;
    if (!ents) return false;
    for (const e of ents.values()) {
      if (e.type !== 'minecraft:item' || !e.item || !FARM_ITEMS.has(e.item.name)) continue;
      if (Math.abs(e.pos.x - p.x) <= r && Math.abs(e.pos.z - p.z) <= r && Math.abs(e.pos.y - p.y) <= 4) return true;
    }
    return false;
  }

  // ---- deposit -------------------------------------------------------------------------------------

  private findChest(): Vec3 | undefined {
    if (this.chest) return this.chest;
    const o = this.opts!;
    const isChest = (b: { name: string }) => b.name === 'chest' || b.name === 'barrel';
    let found = this.d.world.find(isChest, { origin: o.center, radius: (o.radius ?? 8) + 16, max: 1 });
    // following the field: the bot may be far from the start by now
    const at = o.follow ? this.d.position() : undefined;
    if (!found.length && at) found = this.d.world.find(isChest, { origin: at, radius: (o.radius ?? 8) + 16, max: 1 });
    this.chest = found[0];
    if (this.chest) this.log.info(`farm: using the chest at ${fmt(this.chest)}`);
    return this.chest;
  }

  /**
   * Stacks to deposit: produce (wheat, beetroot, poisonous potatoes) and surplus seeds. Of each seed
   * item (wheat_seeds, carrot, potato, beetroot_seeds) the largest stack stays for replanting.
   */
  depositables(): ItemStack[] {
    const slots = this.d.world.inventory.slots.slice(0, 36);
    const keep = new Set<ItemStack>();
    for (const seed of SEEDS) {
      let best: ItemStack | undefined;
      for (const s of slots) if (s?.name === seed && (!best || s.count > best.count)) best = s;
      if (best) keep.add(best);
    }
    return slots.filter((s): s is ItemStack => !!s && FARM_ITEMS.has(s.name) && !keep.has(s));
  }

  private async depositTrip(gen: number, chest: Vec3): Promise<boolean> {
    this.state = 'to_chest';
    this.stats.trips++;
    const g = await this.d.skills.goto({ type: 'getToBlock', p: chest, reach: 4, face: false }, { timeoutTicks: 4000, avoidFarmlandDrops: true }); // within reach from any height
    if (!this.alive(gen)) return false;
    if (!g.ok) {
      this.lastError = `goto chest: ${g.reason}`;
      this.log.warn(`farm: ${this.lastError}`);
      return false;
    }
    this.state = 'deposit';
    const o = await this.d.skills.open(chest);
    if (!this.alive(gen)) return false;
    if (!o.ok) {
      this.lastError = `open chest: ${o.reason}`;
      this.log.warn(`farm: ${this.lastError}`);
      return false;
    }
    const chosen = new Set(this.depositables());
    const r = await this.d.skills.deposit(o.view, (i) => chosen.has(i));
    for (const [k, v] of Object.entries(r.moved)) this.stats.deposited[k] = (this.stats.deposited[k] ?? 0) + v;
    await this.d.skills.closeContainer(o.view);
    this.log.info(`farm: deposited ${JSON.stringify(r.moved)}${r.ok ? '' : ` (${r.reason})`}`);
    if (!r.ok) this.lastError = `deposit: ${r.reason}`;
    return r.total > 0;
  }
}

function newStats(): FarmStats {
  return {
    startedAt: undefined,
    finishedAt: undefined,
    rounds: 0,
    harvested: 0,
    harvestedByCrop: {},
    planted: 0,
    tilled: 0,
    boneMealUsed: 0,
    boneMealGrown: 0,
    stands: 0,
    standFailures: 0,
    trampleRoutesRefused: 0,
    terraceSteps: 0,
    collectRounds: 0,
    collected: {},
    trips: 0,
    deposited: {},
    waits: 0,
    failures: 0,
    harvestTicks: [],
    plantTicks: [],
    plantRetries: 0,
    plantRejected: 0,
    settleTicks: 0,
    pauses: 0,
  };
}

function fmt(p: Vec3): string {
  return `${p.x} ${p.y} ${p.z}`;
}

