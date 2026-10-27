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
import { silentLogger, type Logger } from '../../log.ts';
import type { Vec3 } from '../../world/types.ts';
import type { DigResult } from '../dig/digger.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { PlaceOptions, PlaceResult } from '../place/place.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import { usable, type InventoryCounts, type ReserveOptions } from './materials.ts';
import type { Plan, Step } from './plan.ts';
import { canDigFrom, canPlaceFrom, canStand, replaceable, BUILD_REACH, type BlockLike } from './sim.ts';
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
  log?: Logger;
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

  constructor(plan: Plan, deps: RunnerDeps) {
    this.plan = plan;
    this.d = deps;
    this.log = deps.log ?? silentLogger;
    this.total = plan.steps.filter((s) => WORK.has(s.op)).length;
    for (const s of plan.steps) if (s.op === 'place') this.pending.add(key(s.pos));
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
      this.checkColumn();
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
      await this.collectNow(6, 200);
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
    return { state: 'stopped', reason };
  }

  private finishStep(step: Step, ok: boolean, why: string): void {
    if (step.op === 'place') this.pending.delete(key(step.pos));
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
          this.pending.delete(key(s.pos));
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
  private checkColumn(): void {
    const s = this.plan.steps[this.index];
    if (!s) return;
    const inPhase = ((s.op === 'place' || s.op === 'scaffold') && s.top !== undefined) || s.op === 'descend';
    if (!inPhase) return;
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

  /** Throwaway kinds for scaffolding: those the rest of the build does not use first. */
  private scaffoldItems(): string[] {
    const used = new Set<string>();
    for (let j = this.index; j < this.plan.steps.length; j++) {
      const s = this.plan.steps[j]!;
      if (s.op === 'place' || s.op === 'replace') used.add(s.item);
    }
    const kinds = this.d.reserve().throwaway ?? THROWAWAY_BLOCKS;
    return [...kinds].filter((k) => this.d.inventory.count(k) > 0).sort((a, b) => Number(used.has(a)) - Number(used.has(b)));
  }

  private async placeStep(t: Cell, name: string | undefined, item: string | undefined, prefer: Cell | undefined, top: Cell | undefined, epoch: number, scaffold: boolean): Promise<true | string> {
    const here = this.d.blockAt(t);
    if (!here) return 'unloaded';
    if (name && blockId(here.name) === name) return true;
    if (!replaceable(here)) return scaffold && here.boxes.length > 0 ? true : `occupied (${here.name})`;
    let items: string[];
    if (scaffold) {
      items = this.scaffoldItems().slice(0, 1); // one kind: the PlaceSkill would keep the held block of any listed kind
      if (items.length === 0) return 'fatal:out of throwaway blocks for scaffolding';
    } else {
      const it = item ?? name!;
      const r = this.reserve();
      if (usable(this.d.inventory, it, r) < 1) {
        const kept = (r.throwaway ?? THROWAWAY_BLOCKS).includes(it) && this.d.inventory.count(it) > 0 ? ` (${this.d.inventory.count(it)} kept as the throwaway reserve)` : '';
        return `fatal:out of ${it}${kept}`;
      }
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
