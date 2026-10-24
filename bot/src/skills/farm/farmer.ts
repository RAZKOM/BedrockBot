// Farming loop (PLAN.md task 7.13, docs/farming.md), the sibling of GatherWoodTask (tasks/gatherWood.ts):
//
//   scan      farmland within `radius` of the centre; the cell above each is mature / growing / empty
//   work      harvest mature crops, replant empty farmland with the matching seed, bone meal growing
//             crops (when `useBoneMeal()` and bone meal is carried)
//   stand     pick the standing cell that reaches the most work (dig and click reach), preferring
//             cells that are not farmland; refuse a route with a drop onto farmland (trampling)
//   act       at the cell: harvest (dig, 1 tick) and replant each mature crop in reach, bone meal
//             growing ones until mature then harvest and replant, collect the drops, plant the rest
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
import type { Goal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import { closestDistance, cornerDistance, SERVER_CLICK_REACH } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import type { ClickResult } from './click.ts';
import { BONE_MEAL, FARMLAND, FARM_ITEMS, SEEDS, fieldCell, posKey, scanField, type CropDef, type FieldCell, type FieldScan } from './crops.ts';

export type FarmState = 'idle' | 'scan' | 'walk' | 'harvest' | 'bonemeal' | 'plant' | 'collect' | 'to_chest' | 'deposit' | 'waiting' | 'full' | 'stopped' | 'failed';

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
}

export interface FarmStats {
  startedAt: number | undefined;
  finishedAt: number | undefined;
  rounds: number;
  harvested: number;
  harvestedByCrop: Record<string, number>;
  planted: number;
  boneMealUsed: number;
  boneMealGrown: number;
  stands: number;
  standFailures: number;
  /** Candidate standing cells refused because their route dropped onto farmland. */
  trampleRoutesRefused: number;
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
}

/** The skills the farmer uses (BotSkills satisfies it). */
export interface FarmSkills {
  goto(goal: Goal, opts?: GotoOptions): Promise<SkillResult>;
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

type WorkKind = 'harvest' | 'plant' | 'bonemeal';

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

const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });

/** Eye position for a body standing at the centre of cell (x, z) with feet height `feet`. */
export function eyeAt(x: number, feet: number, z: number): Vec3 {
  return { x: x + 0.5, y: feet + EYE_HEIGHT, z: z + 0.5 };
}

/** True when work `w` can be done from `eye` (with `margin` blocks to spare). */
export function workInReach(eye: Vec3, kind: WorkKind, cell: FieldCell, margin = 0): boolean {
  if (kind === 'harvest') return closestDistance(eye, cell.crop) <= DIG_REACH - margin && serverReachDistance(eye, cell.crop) <= DIG_SERVER_REACH - margin;
  const b = kind === 'plant' ? cell.soil : cell.crop;
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

/** Falls up to this height onto farmland never trampled it (measured: 0/16 up to 0.75, 3/12 at 0.9 to 1.1). */
export const SAFE_FALL = 0.75;

/**
 * True when a planned route drops onto farmland from higher than SAFE_FALL. Walks, the 0.0625 step
 * from grass onto farmland (the planner calls it a drop) and jumps up onto farmland are fine.
 */
export function routeTramples(path: FarmPlan['path'], blockAt: (p: Vec3) => BlockInfo | undefined): boolean {
  for (let i = 1; i < path.length; i++) {
    const n = path[i]!;
    if (n.move !== 'drop' || path[i - 1]!.feet - n.feet <= SAFE_FALL) continue;
    if (blockAt(floorOf(n.x, n.y, n.z, n.feet))?.name === FARMLAND) return true;
  }
  return false;
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
    this.d.skills.cancel();
    this.d.cancelClick?.();
    this.end(this.gen, 'stopped');
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

  private end(gen: number, state: FarmState): FarmState {
    if (gen !== this.gen && state !== 'stopped') return this.state;
    this.state = state;
    this.stats.finishedAt = this.now();
    this.log.info(`${this.summary()}${this.lastError ? ` (${this.lastError})` : ''}`);
    for (const fn of [...this.doneFns]) fn(state);
    return state;
  }

  private async run(gen: number): Promise<FarmState> {
    const o = this.opts!;
    const radius = o.radius ?? 8;
    const minFree = o.minFreeSlots ?? 2;
    let depositFails = 0;
    while (this.alive(gen)) {
      if (o.maxRounds !== undefined && this.stats.rounds >= o.maxRounds) return this.end(gen, 'idle');
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
      const scan = this.scan(o.center, radius);
      const work = this.workOf(scan);
      if (work.length === 0) {
        // anything left on the ground in the field?
        if (this.dropsNear(o.center, radius + 2) && inv.freeSlots().length > 0) {
          this.state = 'collect';
          this.stats.collectRounds++;
          const c = await this.d.skills.collect(radius + 2, 300, { origin: o.center, filter: (i) => FARM_ITEMS.has(i.name) });
          this.addCollected(c);
          if (!this.alive(gen)) break;
          if (c.pickedUp > 0) continue;
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
        for (const w of work) this.failCell(w.cell);
        this.log.warn(`farm: no standing cell reaches any of ${work.length} work items`);
        await this.d.waitTicks(20);
        continue;
      }
      this.state = 'walk';
      const g = await this.d.skills.goto({ type: 'block', p: { x: stand.x, y: stand.y, z: stand.z } }, { timeoutTicks: 2400 });
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
      await this.workHere(gen, scan);
    }
    return this.state;
  }

  private async sleep(gen: number, ticks: number): Promise<void> {
    for (let t = 0; t < ticks && this.alive(gen); t += 20) await this.d.waitTicks(Math.min(20, ticks - t));
  }

  private scan(center: Vec3, radius: number): FieldScan {
    const w = this.d.world;
    const scan = scanField((p) => w.blockAt(p), (pred, o) => w.find(pred, o), center, radius, this.memory);
    for (const c of scan.cells) if (c.kind && c.state !== 'empty') this.memory.set(posKey(c.soil), c.kind);
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
          const value = reach.reduce((a, w) => a + (w.kind === 'harvest' ? 3 : 2), 0);
          cands.push({ x, y, z, feet, onFarmland, work: reach, score: -value + (onFarmland ? 4 : 0) + 0.3 * d });
        }
      }
    }
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands.slice(0, 12)) {
      if (!this.d.plan) return c;
      const p = this.d.plan({ type: 'block', p: { x: c.x, y: c.y, z: c.z } });
      if (!p || p.status === 'none') continue;
      if (routeTramples(p.path, blockAt)) {
        this.stats.trampleRoutesRefused++;
        this.log.info(`farm: route to ${c.x} ${c.y} ${c.z} drops onto farmland; trying another cell`);
        continue;
      }
      return c;
    }
    return undefined;
  }

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
  private async workHere(gen: number, scan: FieldScan): Promise<void> {
    const w = this.d.world;
    const fresh = (c: FieldCell): FieldCell => fieldCell((p) => w.blockAt(p), c.soil, this.memory.get(posKey(c.soil)) ?? c.kind);
    const byDistance = (cells: FieldCell[]) => {
      const eye = this.eyeNow();
      return eye ? [...cells].sort((a, b) => closestDistance(eye, a.crop) - closestDistance(eye, b.crop)) : cells;
    };
    // 1. harvest + replant
    for (const c0 of byDistance(scan.mature)) {
      if (!this.alive(gen)) return;
      const c = fresh(c0);
      if (c.state !== 'mature' || !this.inReachNow('harvest', c)) continue;
      if (!(await this.harvest(c))) continue;
      if (!this.alive(gen)) return;
      if (this.canPlant(c) && this.inReachNow('plant', c)) await this.plant(c);
    }
    // 2. bone meal growing crops in reach, then harvest + replant
    if (this.boneMealOn()) {
      for (const c0 of byDistance([...scan.growing, ...scan.empty])) {
        if (!this.alive(gen) || !this.boneMealOn()) break;
        let c = fresh(c0);
        if (c.state !== 'growing' || !this.inReachNow('bonemeal', c)) continue;
        for (let i = 0; i < (this.opts?.maxBoneMealPerCrop ?? 8) && c.state === 'growing' && this.boneMealOn() && this.alive(gen); i++) {
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
        if (!this.alive(gen)) return;
        if (c.state === 'mature') {
          this.stats.boneMealGrown++;
          if (await this.harvest(c)) {
            if (this.canPlant(c) && this.inReachNow('plant', c)) await this.plant(c);
          }
        }
      }
    }
    if (!this.alive(gen)) return;
    // 3. collect the drops around here
    const here = this.d.position();
    if (here && this.dropsNear(here, 6)) {
      this.state = 'collect';
      this.stats.collectRounds++;
      const r = await this.d.skills.collect(6, 200, { origin: here, filter: (i) => FARM_ITEMS.has(i.name) });
      this.addCollected(r);
      if (!this.alive(gen)) return;
    }
    // 4. plant what is still empty in reach (seeds may have come with the drops)
    for (const c0 of byDistance([...scan.empty, ...scan.mature])) {
      if (!this.alive(gen)) return;
      const c = fresh(c0);
      if (c.state !== 'empty' || !this.canPlant(c) || !this.inReachNow('plant', c)) continue;
      await this.plant(c);
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
    const k = c.kind?.block ?? r.block ?? '?';
    this.stats.harvestedByCrop[k] = (this.stats.harvestedByCrop[k] ?? 0) + 1;
    if (r.ticks !== undefined) this.stats.harvestTicks.push(r.ticks);
    if (c.kind) this.memory.set(posKey(c.soil), c.kind);
    return true;
  }

  private async plant(c: FieldCell): Promise<boolean> {
    const kind = c.kind;
    if (!kind) return false;
    this.state = 'plant';
    let r = await this.d.skills.place(c.crop, { face: 'up', item: kind.seed });
    if (!r.ok && r.reason === 'rejected') {
      // Seen right after harvests while drops were being picked up: the seed stack (and its stack id)
      // changed under the click. One retry with the current item after the inventory settled.
      this.stats.plantRetries++;
      await this.d.waitTicks(3);
      r = await this.d.skills.place(c.crop, { face: 'up', item: kind.seed });
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
    const found = this.d.world.find((b) => b.name === 'chest' || b.name === 'barrel', { origin: o.center, radius: (o.radius ?? 8) + 16, max: 1 });
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
    const g = await this.d.skills.goto({ type: 'near', p: centre(chest), r: 2 }, { timeoutTicks: 4000 });
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
    boneMealUsed: 0,
    boneMealGrown: 0,
    stands: 0,
    standFailures: 0,
    trampleRoutesRefused: 0,
    collectRounds: 0,
    collected: {},
    trips: 0,
    deposited: {},
    waits: 0,
    failures: 0,
    harvestTicks: [],
    plantTicks: [],
    plantRetries: 0,
  };
}

function fmt(p: Vec3): string {
  return `${p.x} ${p.y} ${p.z}`;
}

