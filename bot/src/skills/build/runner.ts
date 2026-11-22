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
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import type { DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { EYE_HEIGHT } from '../dig/look.ts';
import { usable, type InventoryCounts, type ReserveOptions } from './materials.ts';
import { plainPlacement, type Plan, type Step } from './plan.ts';
import { canDigFrom, canPlaceFrom, canPlaceWith, canStand, clickFor, replaceable, BUILD_REACH, type BlockLike } from './sim.ts';
import { cardinalYaw, OPPOSITE, remaining, sameBlock, stateDiff, statesMatch, stateText, type Cardinal, type Placement } from './states.ts';

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
  log?: Logger;
}

/** Track BJ: what the runner uses of the Supply (skills/supply/supply.ts). */
export interface RunnerSupply {
  carried(names: string | readonly string[]): number;
  ensure(names: string | readonly string[], n: number, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }): Promise<{ ok: boolean; loose: number; fromBoxes: number; reason?: string }>;
  stow(names: string | readonly string[], keep: number, opts: { cancelled?: () => boolean; avoid?: (p: Cell) => boolean }): Promise<{ stowed: number; reason?: string }>;
  /** How many more of it fit loose (a margin of slots kept free): a refill takes no more. */
  room?(names: string | readonly string[]): number;
  /** A box an interrupted refill left standing or on the ground: picked up again (at the start of a run). */
  recover?(cancelled: () => boolean): Promise<void>;
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
}

export type RunnerEnd = { state: 'done' } | { state: 'stopped'; reason: string } | { state: 'paused' };

/** Attempts per step (the first + 2 retries). */
export const STEP_ATTEMPTS = 3;
/** Stands offered to one goto. */
const MAX_STANDS = 12;
/** A goto to a stand gives up after (ticks). */
const GOTO_TICKS = 1200;
/** Collect drops after this many digs. */
const COLLECT_EVERY = 16;

const WORK = new Set<Step['op']>(['place', 'dig', 'replace']);

export class BuildRunner {
  readonly plan: Plan;
  private readonly d: RunnerDeps;
  private readonly log: Logger;
  /** Next step. */
  index = 0;
  readonly stats: RunnerStats = { placed: 0, dug: 0, replaced: 0, scaffoldsPlaced: 0, scaffoldsRemoved: 0, skipped: [], processed: 0, activeMs: 0, retries: 0, walks: 0 };
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

  constructor(plan: Plan, deps: RunnerDeps) {
    this.plan = plan;
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.total = plan.steps.filter((s) => WORK.has(s.op)).length;
    for (const s of plan.steps) if (s.op === 'place') for (const c of cellsOf(s)) this.pending.add(key(c));
    for (const s of plan.steps) {
      if (s.op === 'place') for (const c of cellsOf(s)) this.footprint.add(key(c));
      else if ('pos' in s) this.footprint.add(key(s.pos));
      else for (let k = 0; k <= s.height; k++) this.footprint.add(key(add(s.base, 0, k, 0)));
    }
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
          last = r;
          if (step.op === 'place' && step.top && !this.atTop(step.top)) break; // no walking back up: skip
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
        this.outstanding.delete(key(s.pos));
      }
    }
    await this.collectNow(6, 200);
    await this.stowRest(epoch); // Track BJ
    return { state: 'stopped', reason };
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

  /** At least `target` of `items` loose, out of the carried boxes (the box beside the bot, off the footprint): true when some came out. */
  private async refill(items: readonly string[], target: number, epoch: number): Promise<boolean> {
    const s = this.d.supply;
    if (!s || s.carried(items) <= 0) return false;
    // no more than fits loose with a margin (a 2000-block wall must not fill the inventory)
    const loose = items.reduce((a, k) => a + this.d.inventory.count(k), 0);
    if (s.room) target = Math.min(target, loose + s.room(items));
    if (target <= loose) return false;
    const r = await s.ensure(items, target, { cancelled: () => epoch !== this.epoch, avoid: (p) => this.footprint.has(key(p)) });
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
    for (const it of items) {
      const need = this.needOf(it, this.index + 1, end);
      if (usable(this.d.inventory, it, this.reserve()) < need) await this.refill([it], this.reserveFor(it) + need, epoch);
    }
    // the scaffold blocks on top of the column's own places of a throwaway kind (the pillar may take that kind)
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    const scaffolds = this.plan.steps.slice(this.index + 1, end).filter((s) => s.op === 'scaffold').length;
    await this.topUpScaffold(height + scaffolds + [...items].filter((it) => kinds.includes(it)).reduce((n, it) => n + this.needOf(it, this.index + 1, end), 0), epoch);
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
      const r = await s.stow(names, keep, { cancelled: () => epoch !== this.epoch, avoid: (p) => this.footprint.has(key(p)) });
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
        this.outstanding.add(key(step.pos));
      } else if (step.op === 'unscaffold') {
        this.stats.scaffoldsRemoved++;
        this.lent = Math.max(0, this.lent - 1);
        this.outstanding.delete(key(step.pos));
      }
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
        if (s.op === 'place' && !this.finished.has(j)) {
          this.finished.add(j);
          for (const c of cellsOf(s)) this.pending.delete(key(c));
          this.stats.processed++;
          this.stats.skipped.push({ pos: s.pos, reason: 'place: the scaffold column failed' });
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

  private atTop(top: Cell): boolean {
    const f = this.feet();
    return !!f && f.x === top.x && f.y === top.y && f.z === top.z;
  }

  /** On resume: a column step without the bot on the column top -> dig the column and pillar again. */
  /** The current step is a column top's place / scaffold or the descend: the bot stands on (or comes down) a column. */
  private inColumnPhase(): boolean {
    const s = this.plan.steps[this.index];
    return !!s && (((s.op === 'place' || s.op === 'scaffold') && s.top !== undefined) || s.op === 'descend');
  }

  private checkColumn(): void {
    const s = this.plan.steps[this.index];
    if (!s) return;
    if (!this.inColumnPhase()) return;
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
    for (let dy = -r - 1; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const f = { x: t.x + dx, y: t.y + dy, z: t.z + dz };
          if (!canStand(this.d, f, rules) || !ok(f)) continue;
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
        return this.pillar(step.base, step.height, epoch);
      case 'descend':
        return this.descend(step.base, step.height, epoch);
      case 'unscaffold':
        return this.digStep(step.pos, step.stand, epoch);
      case 'dig':
        return this.digStep(step.pos, step.stand, epoch);
      case 'replace': {
        const b = this.d.blockAt(step.pos);
        if (b && blockId(b.name) === step.from) {
          const r = await this.digStep(step.pos, step.stand, epoch);
          if (r !== true) return r;
        }
        return this.placeStep(step.pos, step.to, step.item, step.stand, undefined, epoch, false);
      }
    }
  }

  /** The keeper's reserve less the scaffold blocks out in the world (they come back). */
  private reserve(): ReserveOptions {
    const r = this.d.reserve();
    return { ...r, throwawayMin: Math.max(0, r.throwawayMin - this.lent) };
  }

  /** Throwaway kinds for scaffolding: those the rest of the build does not use first (`all`: carried or not). */
  private scaffoldItems(all = false): string[] {
    const used = new Set<string>();
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const s = this.plan.steps[j]!;
      if (s.op === 'place' || s.op === 'replace') used.add(s.item);
    }
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    return [...kinds].filter((k) => all || this.d.inventory.count(k) > 0).sort((a, b) => Number(used.has(a)) - Number(used.has(b)));
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
      if (items.length === 0) return 'fatal:out of throwaway blocks for scaffolding';
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
    const r = await this.d.place(t, { item: items });
    if (epoch !== this.epoch) return 'interrupted';
    if (!r.ok) return `place: ${r.reason}`;
    await this.d.waitTicks(1);
    const now = this.d.blockAt(t);
    if (!now || now.boxes.length === 0 || (name && blockId(now.name) !== name)) return `placed ${now?.name ?? '?'}, not ${name ?? 'a block'}`;
    return true;
  }

  /** One of `it` usable (out of a carried box on the ground when short), or why not (`fatal:` stops the build). */
  private async haveItem(it: string, top: Cell | undefined, epoch: number): Promise<true | string> {
    const r = this.reserve();
    // Track BJ: out of it on the ground: the rest of the build's need out of a carried box
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

  private async digStep(t: Cell, prefer: Cell | undefined, epoch: number): Promise<true | string> {
    const b = this.d.blockAt(t);
    if (!b) return 'unloaded';
    if (isAirName(b.name)) return true;
    const s = await this.standFor(t, (f) => canDigFrom(f, t), prefer, epoch);
    if (s !== true) return s;
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
    }
    for (let guard = 0; guard < height + 4; guard++) {
      const g = this.feet();
      if (!g) return 'no position';
      if (g.y >= top.y) break;
      if (g.x !== base.x || g.z !== base.z) return 'left the column';
      const items = this.scaffoldItems().slice(0, 1);
      if (items.length === 0) return 'fatal:out of throwaway blocks for scaffolding';
      const r = await this.d.place(g, { item: items });
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `pillar: ${r.reason}`;
      this.stats.scaffoldsPlaced++;
      this.lent++;
      this.outstanding.add(key(g));
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
        this.outstanding.delete(key(c));
        continue;
      }
      const r = await this.d.dig(c);
      if (epoch !== this.epoch) return 'interrupted';
      if (!r.ok) return `descend: ${r.reason}`;
      this.stats.scaffoldsRemoved++;
      this.lent = Math.max(0, this.lent - 1);
      this.outstanding.delete(key(c));
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
      this.outstanding.delete(key(p));
    }
    return true;
  }
}

/** A place step's cells: its own and the ones its block fills besides (a door's upper half, a bed's head). */
function cellsOf(s: Extract<Step, { op: 'place' }>): Cell[] {
  return [s.pos, ...(s.pl?.extra ?? []).map((e) => add(s.pos, e.offset.x, e.offset.y, e.offset.z))];
}

/** `212 / 640 placed, 3 skipped` */
export function progressLine(r: BuildRunner): string {
  const s = r.stats;
  const kind = r.plan.spec.kind;
  const verb = kind === 'clear' ? 'dug' : kind === 'replace' ? 'replaced' : 'placed';
  const done = kind === 'clear' ? s.dug : kind === 'replace' ? s.replaced : s.placed;
  return `${done} / ${r.total} ${verb}, ${s.skipped.length} skipped`;
}

/** `4 min`, `40 s` */
export function etaText(s: number | undefined): string | undefined {
  if (s === undefined || !Number.isFinite(s)) return undefined;
  return s < 60 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`;
}

export { cellOf };
