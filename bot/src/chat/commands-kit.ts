// Getting crafted items from scratch (Track E1, docs/early-game.md, ADR 0098): `!get stone_pickaxe`, `!get bed`,
// `!get kit`. The planner (skills/items/obtain.ts) names the next command from what is carried; this controller runs
// it as the owner (`!gather 12`, `!mine stone 3`, `!kill sheep 3`, `!food 6`, `!craft stone_pickaxe 1`), waits for
// the process it started to end, and asks again, until every target is carried, a step gets nothing, or the owner
// moves the bot with another command. Each command answers for itself as usual; the job adds a start line and an
// end line:
//
//   !get stone_pickaxe    getting 1 stone_pickaxe: first !gather 9 (then the commands it takes)
//   !get kit              getting the kit (crafting_table, stone_sword, stone_pickaxe, stone_axe, 6 food): ...
//   (end)                 get kit: done in 212 s, 7 steps (gather 15, craft wooden_pickaxe 1, mine stone 8, ...)
//   (a step got nothing)  get kit: stopped after 4 steps: !mine stone 8 got nothing (mine stone: stopped at 0/8, ...)
//   !get stop             stops the job and the process of its step
//
// It only runs commands the owner could type; their rules (allowBreak, the walk's limits, guard and night
// pre-empting them) are unchanged.
//
// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101), each in its own method:
//   - worn tools: the plan counts a worn tool as not carried (skills/items/wear.ts), so a step that needs one makes a
//     fresh one first; a mine step cut short by its pickaxe wearing out does not cap the material (`replaced the
//     stone_pickaxe (worn)` in the end line);
//   - the crafting table: held standing between the job's crafts (the crafter's holdTables) and counted as carried,
//     picked up before a step that walks off and at the end (`picked up the crafting table`), left by home (`the
//     crafting table stays by home`); the furnace it set down is used again (`used the furnace at x y z again`);
//   - a death (`deathReturn`, off): by day and within reach, back to the death spot for the drops, the furnace's output
//     taken, the job goes on (`recovered 31 of 34 stacks`); off, the job ends `stopped by a death` with what is left.
import type { Vec3 } from '../connection/types.ts';
import { silentLogger, type Logger } from '../log.ts';
import { DEATH_COLLECT_RADIUS, deathReturnPlan, stacksRecovered } from '../skills/items/death-return.ts';
import { affordable, canHarvestWith, COAL_NEAR, EARLY_KIT, foodCarried, haveCount, IRON_KIT, itemAlias, nextAction, type ObtainAction, type ObtainOptions, type ObtainTarget } from '../skills/items/obtain.ts';
import { replacedBy, usableSlots, type ToolOk } from '../skills/items/wear.ts';
import { claimRespawn } from '../skills/test/recovery.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { RecoverProcess, WorkProcess, type RecoverRequest, type RecoverResult } from '../tasks/process/recover.ts';
import type { DeathRecord, RespawnHook } from '../tasks/respawn.ts';
import { WINDOW_ARMOR, WINDOW_OFFHAND } from '../world/inventory.ts';
import { survivalKitOf } from './commands-survival.ts';
import { smeltControlOf, smeltLine } from './commands-smelt.ts';
import { bedControlOf } from './commands-bed.ts'; // Track E3
import { foodControllerOf, foodExtrasOf } from './commands-food.ts'; // Track E3: the herd memory
import { cellKey } from '../skills/food/herds.ts'; // Track E3
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { Process, ProcessManager } from '../tasks/process/manager.ts';
import { craftControlOf } from './commands-craft.ts';
import { smeltInputsOf } from '../skills/food/smelt.ts';
import { getControllerOf } from './commands-get.ts';
import type { ItemStack } from '../world/types.ts';
import type { CommandEvent } from './chat.ts';
import type { ChatLine } from './text.ts';

/** Steps a job may take (the early kit takes 6 to 9). */
export const OBTAIN_MAX_STEPS = 24;
/** One step's process may run this long before it is stopped and the job ends (ms). */
export const OBTAIN_STEP_MS = 10 * 60_000;
/** How long a command may take to start its process (ms): a refusal starts none. */
export const OBTAIN_START_MS = 1500;
/** Track E3: walks to a remembered herd a job makes when a hunt for a material found none within 32. */
export const OBTAIN_HERD_WALKS = 2;
/** Poll period while a step runs (ms). */
const POLL_MS = 500;
/** Track E4: after a death the job waits this long for the respawn (ms). */
export const OBTAIN_DEATH_WAIT_MS = 120_000;
/** Track E4: a table the job left standing is walked back to within this many blocks when the job leaves. */
export const TABLE_SWEEP = 24;
/** Track E4: a table within this many blocks of home stays standing (the home's table). */
export const TABLE_HOME_KEEP = 16;
/** Track E4: the steps that walk off (the tables are picked up before them). */
const WALKS: ReadonlySet<ObtainAction['kind']> = new Set(['gather', 'mine', 'hunt', 'food']);

/** The process each step command starts. */
const STEP_PROCESS: Readonly<Record<string, string>> = { goto: 'goto', gather: 'gather', mine: 'mine', kill: 'kill', food: 'food', craft: 'craft', smelt: 'smelt', furnace: 'furnace', cook: 'cook', bed: 'bed' };
/** Owner commands that end the job (they move the bot or start other work); `!get` replaces it itself. */
export const OBTAIN_ABORT_ON: ReadonlySet<string> = new Set(['stop', 'goto', 'come', 'follow', 'kill', 'gather', 'mine', 'farm', 'food', 'sleep', 'home', 'top', 'fly', 'land', 'nether', 'overworld', 'craft', 'explore', 'quarry', 'tunnel', 'build', 'bring', 'unload', 'milk', 'rockets', 'smelt', 'furnace', 'cook', 'bed']);

type Slots = readonly (ItemStack | null | undefined)[];

export interface ObtainHost {
  /** Run a command as the owner who typed `line` (`mine stone 3`, no prefix). */
  dispatch(line: ChatLine, command: string): void;
  processes: Pick<ProcessManager, 'userProcesses' | 'stop'>;
  slots(): Slots;
  recipes: Parameters<typeof nextAction>[0];
  /** The crafter's plan options (kept items, reserves), whether a table stands near; Track E2: a furnace, coal, the worn items. */
  options(): ObtainOptions;
  onCommand(fn: (e: CommandEvent) => void): () => void;
  wait(ms: number): Promise<void>;
  now?(): number;
  /**
   * Track E3: the nearest remembered herd (food/herds.ts, within 200) with wild adults of `kind`, its cells in `skip`
   * left out: where a hunt that found none within 32 walks next.
   */
  herd?(kind: string, skip: ReadonlySet<string>): { x: number; y: number; z: number; key: string } | undefined;
  log?: Logger;
  /** Track E4: the crafter's tables (held between the job's crafts, picked up when it leaves). */
  tables?: ObtainTables;
  /** Track E4: the furnace the smelts use now (to tell a reuse). */
  furnace?(): Vec3 | undefined;
  /** Track E4: what a death needs (`deathReturn`). */
  deaths?: ObtainDeaths;
}

/** Track E4: the crafting tables of a job. */
export interface ObtainTables {
  hold(on: boolean): void;
  /** Tables this job's crafter left standing (they count as carried for the plan). */
  standing(): number;
  /** Pick the standing tables up (walking back within TABLE_SWEEP; one within TABLE_HOME_KEEP of home stays). */
  sweep(): { process?: Process; result: Promise<{ picked: number; kept: number; left: Vec3[] } | undefined> };
}

/** Track E4: a death in a job. */
export interface ObtainDeaths {
  /** The `deathReturn` setting. */
  enabled(): boolean;
  /** The world clock (undefined: unknown). */
  time(): number | undefined;
  /** Every slot that drops at a death: the main inventory, the armour, the offhand. */
  allSlots(): readonly (ItemStack | null | undefined)[];
  /** Walk back to the spot and pick the drops up (a user process). */
  recover(req: RecoverRequest): { process?: Process; result: Promise<RecoverResult> };
  /** The furnace a smelt left its input in, if any. */
  heldFurnace(): Vec3 | undefined;
  /** Take what that furnace holds (a smelt process): the reply line and the items taken. */
  collectFurnace(at: Vec3): { process?: Process; result: Promise<{ line: string; taken: number }> };
  /** The walk home the respawn would have made (the job does not go back). */
  goHome(): void;
}

/** Track E4: a death seen while the job ran. */
interface JobDeath {
  record: DeathRecord;
  ms: number;
  /** The slots at the death (the last snapshot taken while alive). */
  slots: (ItemStack | null)[];
  /** The step it died in. */
  step: string | undefined;
  /** Set by the respawn hook (after the settle): where the bot came back. */
  feet?: Vec3;
}

export interface ObtainStepRecord {
  command: string;
  ms: number;
  /** The last reply seen while the step ran. */
  reply: string | undefined;
  gained: number;
}

export interface ObtainJob {
  label: string;
  targets: readonly ObtainTarget[];
  startedAt: number;
  steps: ObtainStepRecord[];
  step: ObtainAction | undefined;
  process: Process | undefined;
  aborted: string | undefined;
  /** Stopped by `stop()` (its caller replies): no end line. */
  silent?: boolean;
  /** Track E2: raw materials a mine step came back short of (`raw_iron`: `!mine iron_ore 33 got 14`): the soft targets they no longer cover are dropped. */
  capped: Map<string, string>;
  /** Track E3: remembered herds walked to (cell keys). */
  herds: Set<string>;
  /** Resolves with the end line. */
  result: Promise<string>;
  /** Track E4: what happened on the way (`replaced the stone_pickaxe (worn)`), in the end line. */
  notes: string[];
  /** Track E4: a death not handled yet. */
  death?: JobDeath | undefined;
  /** Track E4: walks back to a death spot so far. */
  returns: number;
  /** Track E4: the furnaces this job set down and the step count then (a smelt there after a walk is a reuse). */
  furnaces: { p: Vec3; step: number }[];
  /** Track E4: what the job does between steps (status). */
  phase?: string | undefined;
}

/** Item counts of the main inventory (0 to 35). */
function counts(slots: Slots, worn: Slots = []): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s && s.count > 0) m.set(s.name, (m.get(s.name) ?? 0) + s.count);
  }
  // Track E2: armour put on and a shield moved to the offhand right after the craft are still the step's gain
  for (const s of worn) if (s && s.count > 0) m.set(s.name, (m.get(s.name) ?? 0) + s.count);
  return m;
}

/** Items gained between two counts (what was crafted away is not a loss here: any new item counts). */
/** Track E4: a usable pickaxe harvested `block` in `before` and none does now (the rest are past the worn-tool limit). */
function pickaxeWore(before: Slots, now: Slots, block: string, toolOk: ToolOk): boolean {
  return canHarvestWith(usableSlots(before, toolOk), block) && !canHarvestWith(usableSlots(now, toolOk), block);
}

function gained(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [k, v] of b) if (v > (a.get(k) ?? 0)) n += v - (a.get(k) ?? 0);
  return n;
}

/** `crafting_table, stone_sword, 6 food` */
export function targetsText(targets: readonly ObtainTarget[]): string {
  return targets.map((t) => (t.n === 1 && t.item !== 'food' ? t.item : `${t.n} ${t.item}`)).join(', ');
}

export class ObtainController {
  private readonly h: ObtainHost;
  private readonly log: Logger;
  job: ObtainJob | undefined;
  /** The last finished job (status). */
  last: { label: string; line: string } | undefined;
  private dispatching = false;
  private readonly offCommand: () => void;

  constructor(h: ObtainHost) {
    this.h = h;
    this.log = h.log ?? silentLogger;
    this.offCommand = h.onCommand((e) => {
      const j = this.job;
      if (e.kind !== 'run' || this.dispatching || !j || j.aborted || !OBTAIN_ABORT_ON.has(e.name)) return;
      j.aborted = `!${e.name}`;
      this.log.info(`get ${j.label}: dropped by !${e.name}`);
    });
  }

  private now(): number {
    return this.h.now?.() ?? Date.now();
  }

  get busy(): boolean {
    return this.job !== undefined;
  }

  /** The kit's targets, or the item's. */
  static targetsFor(name: string, n: number | undefined): { label: string; targets: ObtainTarget[] } {
    if (name === 'kit') return { label: 'kit', targets: EARLY_KIT.map((t) => ({ ...t })) };
    if (name === 'kit_iron') return { label: 'kit iron', targets: IRON_KIT.map((t) => ({ ...t })) };
    return { label: name, targets: [{ item: name, n: n ?? 1 }] };
  }

  /**
   * The first step for `targets`, without running it: undefined when it can start, else the refusal (`no recipe`,
   * done already, no rule for a material).
   */
  check(targets: readonly ObtainTarget[]): ObtainAction {
    return nextAction(this.h.recipes, targets, this.planSlots(), this.h.options());
  }

  /**
   * Track E4: the slots the planner sees: what is carried, with the tables this job left standing counted as carried
   * (one stands for the next craft; before, the kit's table target crafted a second one).
   */
  private planSlots(): Slots {
    const n = this.h.tables?.standing() ?? 0;
    const slots = this.h.slots();
    if (n <= 0) return slots;
    const out = slots.slice(0, 36).map((s) => s ?? null);
    while (out.length < 36) out.push(null);
    const i = out.indexOf(null);
    if (i < 0) return slots;
    out[i] = { name: 'crafting_table', count: n, networkId: 0, metadata: 0 };
    return out;
  }

  /** The plan options with the job's capped materials. */
  private opts(job: ObtainJob): ObtainOptions {
    return { ...this.h.options(), capped: new Set(job.capped.keys()) };
  }

  /** Start a job; `reply` gets the start line now and the end line later. */
  start(line: ChatLine, label: string, targets: readonly ObtainTarget[], reply: (m: string) => void): ObtainJob | undefined {
    if (this.job) this.stop('replaced');
    const first = this.check(targets);
    if (first.kind === 'done') {
      reply(`get ${label}: already carried (${targetsText(targets)})`);
      return undefined;
    }
    if (first.kind === 'stuck') {
      reply(`get ${label}: ${first.reason}`);
      return undefined;
    }
    const worn = this.h.options().worn;
    const carried = (t: ObtainTarget) => t.item !== 'food' && haveCount(this.h.slots(), t.item, worn) >= t.n;
    const want = targets.filter((t) => !carried(t));
    reply(`getting ${label.startsWith('kit') ? `the ${label} (${targetsText(want)})` : targetsText(want)}: first !${first.command}`);
    let resolve!: (s: string) => void;
    const job: ObtainJob = { label, targets, startedAt: this.now(), steps: [], step: undefined, process: undefined, aborted: undefined, capped: new Map(), herds: new Set(), result: new Promise((r) => (resolve = r)), notes: [], returns: 0, furnaces: [] };
    this.job = job;
    this.reply = reply;
    this.alive = [];
    this.h.tables?.hold(true);
    void this.run(line, job).then(
      (end) => {
        if (this.job === job) this.job = undefined;
        if (!this.job) this.h.tables?.hold(false);
        this.last = { label, line: end };
        this.log.info(end);
        if (!job.silent) reply(end);
        resolve(end);
      },
      (e: unknown) => {
        if (this.job === job) this.job = undefined;
        if (!this.job) this.h.tables?.hold(false);
        const end = `get ${label}: failed (${e instanceof Error ? e.message : String(e)})`;
        this.last = { label, line: end };
        reply(end);
        resolve(end);
      },
    );
    return job;
  }

  private async run(line: ChatLine, job: ObtainJob): Promise<string> {
    const head = (): string => `get ${job.label}`;
    const took = (): string => `${Math.round((this.now() - job.startedAt) / 1000)} s, ${job.steps.length} step${job.steps.length === 1 ? '' : 's'}`;
    const list = (): string => job.steps.map((s) => s.command).join(', ');
    // Track E2: the soft targets dropped (the material came back short) and why
    const short = (): string => {
      const d = affordable(this.h.recipes, job.targets, this.h.slots(), this.opts(job)).dropped;
      return d.length ? `; short: ${d.map((t) => t.item).join(', ')} (${[...job.capped.values()].join('; ')})` : '';
    };
    // Track E4: what happened on the way goes before the step list too
    const notes = (): string => (job.notes.length ? `; ${job.notes.join('; ')}` : '');
    const tail = (): string => short() + notes();
    // Track E4: the job leaves: the tables it left standing are picked up first (not when the owner took over)
    const leave = async (end: () => string): Promise<string> => {
      if (!job.aborted) await this.sweep(job);
      return end();
    };
    for (let i = 0; i < OBTAIN_MAX_STEPS; i++) {
      if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}${notes()}`;
      if (!job.death) this.snapshot();
      // Track E4: a death between or in the steps: back for the drops (deathReturn), or the end
      if (job.death) {
        const end = await this.afterDeath(job, head, took);
        if (end) return `${end}${notes()}`;
        continue;
      }
      const a = nextAction(this.h.recipes, job.targets, this.planSlots(), this.opts(job));
      // Track E2: what fell short goes before the step list (a long list is cut by the chat line's limit)
      if (a.kind === 'done') return leave(() => `${head()}: done in ${took()}${tail()}${tail() ? `; steps: ${list()}` : ` (${list()})`}`);
      if (a.kind === 'stuck') return leave(() => `${head()}: stopped after ${took()}: ${a.reason}${tail()}`);
      job.step = a;
      // Track E4: a step that walks off takes the tables with it
      if (WALKS.has(a.kind)) await this.sweep(job);
      if (job.aborted || job.death) continue;
      const toolOk = this.h.options().toolOk;
      const slotsBefore = this.h.slots().map((s) => (s ? { ...s } : null));
      const before = counts(this.h.slots(), this.h.options().worn);
      const furnaceBefore = this.h.options().furnaceNear === true;
      const bedBefore = this.h.options().bedNear === true; // Track E3
      const t0 = this.now();
      const soft = job.targets.some((t) => t.soft);
      const reply = await this.step(line, job, a.command, soft && (a.kind === 'mine' || a.kind === 'hunt'), a.kind === 'mine' && toolOk ? { block: a.block, toolOk } : undefined);
      // Track E4: a death in the step: its gain does not count (the inventory is on the ground)
      if (job.death) continue;
      const after = counts(this.h.slots(), this.h.options().worn);
      // Track E2: a furnace set down is progress though no item was gained (one fewer carried)
      // Track E3: so is a bed set down where the night rule sleeps
      const g = gained(before, after) + (a.kind === 'furnace' && !furnaceBefore && this.h.options().furnaceNear === true ? 1 : 0) + (a.kind === 'bed' && !bedBefore && this.h.options().bedNear === true ? 1 : 0);
      job.steps.push({ command: a.command, ms: this.now() - t0, reply, gained: g });
      this.log.info(`${head()}: !${a.command} -> ${g} items gained in ${Math.round((this.now() - t0) / 100) / 10} s${reply ? ` (${reply})` : ''}`);
      this.noteStep(job, a, slotsBefore, toolOk);
      // Track E4: a mine step whose pickaxe wore out caps nothing (the next plan makes a fresh one and mines the rest)
      const wornOut = a.kind === 'mine' && toolOk !== undefined && pickaxeWore(slotsBefore, this.h.slots(), a.block, toolOk);
      // Track E2: a mine step that came back short caps its material (the soft targets it no longer covers are dropped)
      // Track E3: a hunt that found none within 32 walks to the nearest remembered herd of the kind (twice at most),
      // then hunts again (measured on a fresh world: no sheep within 32 of home, `!get bed` stopped there)
      if (a.kind === 'hunt' && (after.get(a.item) ?? 0) <= (before.get(a.item) ?? 0) && job.herds.size < OBTAIN_HERD_WALKS) {
        const m = this.h.herd?.(a.mob, job.herds);
        if (m) {
          job.herds.add(m.key);
          const walk = `goto ${Math.round(m.x)} ${Math.round(m.y)} ${Math.round(m.z)}`;
          const t1 = this.now();
          const wr = await this.step(line, job, walk);
          job.steps.push({ command: walk, ms: this.now() - t1, reply: wr, gained: 0 });
          this.log.info(`${head()}: no ${a.mob} within 32: walked to the herd remembered at ${walk.slice(5)}${wr ? ` (${wr})` : ''}`);
          if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}${notes()}`;
          continue;
        }
      }
      // Track E3: so does a hunt (the bed's wool: `!kill sheep 3` with fewer sheep near)
      let capped = false;
      if ((a.kind === 'mine' || a.kind === 'hunt') && soft) {
        const got = (after.get(a.item) ?? 0) - (before.get(a.item) ?? 0);
        // a hunt caps only when it got none: sheep of another colour leave the wool short, and the next hunt takes more
        if (a.kind === 'mine' ? got < a.n && !wornOut : got <= 0) {
          job.capped.set(a.item, `!${a.command} got ${Math.max(0, got)}${a.kind === 'hunt' ? ` ${a.item}` : ''}`);
          capped = true;
        }
      }
      if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}${notes()}`;
      const why = reply ? ` (${reply.length > 120 ? `${reply.slice(0, 117)}...` : reply})` : '';
      // food is the last step and some is carried: done, with what is short (no animals left near is common by day one);
      // Track E2: in a kit with soft targets (the iron kit) also with none carried: everything else is made, and the
      // kit's food was eaten during the mine and the smelt (measured on a fresh world: 14 minutes, 0 of 6 at the end)
      if (g === 0 && a.kind === 'food' && (foodCarried(this.h.slots()) > 0 || soft)) return leave(() => `${head()}: done in ${took()}${tail()}; food ${foodCarried(this.h.slots())} of ${job.targets.find((t) => t.item === 'food')?.n ?? 0}: !${a.command} got nothing${why}; steps: ${list()}`);
      // Track E3: a hunt for a soft target's material that got nothing drops that target and the job goes on
      if (g === 0 && capped && a.kind === 'hunt' && affordable(this.h.recipes, job.targets, this.h.slots(), this.opts(job)).dropped.length > 0) continue;
      // Track E4: a pickaxe worn out before the first ore is no dead end (the next plan replaces it)
      if (g === 0 && !wornOut) return leave(() => `${head()}: stopped after ${took()}: !${a.command} got nothing${why}${notes()}`);
    }
    return leave(() => `${head()}: stopped after ${took()}: ${OBTAIN_MAX_STEPS} steps and not done${notes()}`);
  }

  /** Track E4: add a note once. */
  private note(job: ObtainJob, s: string): void {
    if (!job.notes.includes(s)) job.notes.push(s);
  }

  /** Track E4: what a step did that the end line tells: a worn tool replaced, a furnace used again. */
  private noteStep(job: ObtainJob, a: ObtainAction, before: Slots, toolOk: ToolOk | undefined): void {
    if (a.kind === 'craft' && toolOk) {
      const w = replacedBy(before, a.item, toolOk);
      if (w && haveCount(this.h.slots(), a.item) > haveCount(before, a.item)) {
        this.note(job, `replaced the ${w} (worn)`);
        this.log.info(`get ${job.label}: replaced the worn ${w} with a ${a.item}`);
      }
    }
    const f = this.h.furnace?.();
    if (!f) return;
    const mine = job.furnaces.find((x) => x.p.x === f.x && x.p.y === f.y && x.p.z === f.z);
    if (a.kind === 'furnace' && !mine) job.furnaces.push({ p: { ...f }, step: job.steps.length });
    // a smelt at the furnace this job set down after a step walked it off (before: no home, a second furnace crafted)
    else if ((a.kind === 'smelt' || a.kind === 'cook') && mine && job.steps.slice(mine.step).some((s) => /^(mine|gather|food|kill) /.test(s.command))) this.note(job, `used the furnace at ${f.x} ${f.y} ${f.z} again`);
  }

  /** Track E4: pick up the tables this job left standing (before a step that walks off, and at the end). */
  private async sweep(job: ObtainJob): Promise<void> {
    const t = this.h.tables;
    if (!t || t.standing() <= 0) return;
    job.phase = 'picking up the crafting table';
    const s = t.sweep();
    job.process = s.process;
    try {
      const r = await s.result;
      if (!r) return;
      if (r.picked > 0) this.note(job, r.picked === 1 ? 'picked up the crafting table' : `picked up ${r.picked} crafting tables`);
      if (r.kept > 0) this.note(job, 'the crafting table stays by home');
      for (const p of r.left) this.note(job, `a crafting table left at ${p.x} ${p.y} ${p.z}`);
    } finally {
      job.process = undefined;
      job.phase = undefined;
    }
  }

  /**
   * Track E4: after a death in the job. Off (`deathReturn`): the end line. On: wait for the respawn, then by the rules
   * (skills/items/death-return.ts) walk back for the drops, take what the furnace holds, and go on (undefined); or the
   * end line with the reason.
   */
  private async afterDeath(job: ObtainJob, head: () => string, took: () => string): Promise<string | undefined> {
    const dd = this.h.deaths;
    const death = job.death!;
    const at = death.step ? ` (at !${death.step})` : '';
    const cause = death.record.cause.replace(/^death\.attack\./, '');
    let held = dd?.heldFurnace();
    let heldText = held ? `; the furnace at ${held.x} ${held.y} ${held.z} holds the smelt` : '';
    if (!dd?.enabled()) {
      job.death = undefined;
      return `${head()}: stopped by a death (${cause}) after ${took()}${at}${heldText}; !set deathReturn on walks back for the drops`;
    }
    job.phase = 'waiting for the respawn';
    const t0 = this.now();
    while (!death.feet && !job.aborted && this.now() - t0 < OBTAIN_DEATH_WAIT_MS) await this.h.wait(POLL_MS);
    job.phase = undefined;
    if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}`;
    if (!death.feet) {
      job.death = undefined;
      return `${head()}: stopped by a death (${cause}) after ${took()}${at}: no respawn seen`;
    }
    // (the stopped smelt has told by now where its input is)
    held = dd.heldFurnace();
    heldText = held ? `; the furnace at ${held.x} ${held.y} ${held.z} holds the smelt` : '';
    const plan = deathReturnPlan({ at: death.record.at, cause: death.record.cause, feet: death.feet, sinceMs: this.now() - death.ms, time: dd.time(), returns: job.returns });
    if (!plan.go) {
      job.death = undefined;
      dd.goHome();
      return `${head()}: stopped by a death (${cause}) after ${took()}${at}: not going back: ${plan.why}${heldText}`;
    }
    job.returns++;
    const spot = death.record.at!;
    const fmt = (p: Vec3) => `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
    this.reply?.(`${head()}: died${at} (${cause}); walking back ${Math.round(plan.distance)} blocks to ${fmt(spot)} for the drops`);
    job.phase = 'walking back for the drops';
    const r0 = this.now();
    const rec = dd.recover({ spot, walkTicks: plan.walkTicks, collectTicks: plan.collectTicks, radius: DEATH_COLLECT_RADIUS });
    job.process = rec.process;
    let r: RecoverResult;
    try {
      r = await rec.result;
    } finally {
      job.process = undefined;
      job.phase = undefined;
    }
    if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}`;
    // a second death on the way back is the next loop's (its own return, at most DEATH_RETURN_MAX a job)
    if (job.death !== death) return undefined;
    const got = stacksRecovered(death.slots, dd.allSlots());
    let furnace = '';
    let taken = 0;
    if (held) {
      job.phase = 'taking the smelt out of the furnace';
      const f = dd.collectFurnace(held);
      job.process = f.process;
      try {
        const fr = await f.result;
        taken = fr.taken;
        furnace = `; ${fr.line}`;
      } finally {
        job.process = undefined;
        job.phase = undefined;
      }
      if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}`;
      if (job.death !== death) return undefined;
    }
    job.death = undefined;
    const secs = Math.round((this.now() - r0) / 1000);
    const lost = Object.entries(got.lost).map(([k, v]) => `${v} ${k}`);
    const line = `recovered ${got.got} of ${got.of} stacks`;
    this.note(job, line);
    job.steps.push({ command: `recover ${got.got}/${got.of}`, ms: this.now() - r0, reply: r.reason, gained: got.got });
    this.log.info(`${head()}: after the death: ${line} in ${secs} s (${r.arrived ? 'arrived' : r.reason})${lost.length ? `; lost ${lost.join(', ')}` : ''}${furnace}`);
    if (got.got === 0 && taken === 0) return `${head()}: stopped by a death (${cause}) after ${took()}${at}: nothing recovered (${r.arrived ? 'no drops left at the spot' : r.reason})${heldText}`;
    this.reply?.(`${head()}: ${line} in ${secs} s${lost.length ? ` (lost ${lost.slice(0, 4).join(', ')})` : ''}${furnace}; going on with the job`);
    return undefined;
  }

  /** The job's reply (the start line's): the live lines after a death. */
  private reply: ((m: string) => void) | undefined;

  /** Track E4: the slots a death drops, kept while the job runs (the death event may come after the clear). */
  private alive: (ItemStack | null)[] = [];

  private snapshot(): void {
    const all = this.h.deaths?.allSlots();
    if (!all) return;
    const s = all.map((x) => (x && x.count > 0 ? { ...x } : null));
    if (s.some((x) => x)) this.alive = s;
  }

  /** Track E4: the bot died (tasks/respawn.ts event): the job notes it; the step's process was stopped by the death. */
  onDeath(record: DeathRecord): void {
    const j = this.job;
    if (!j || j.aborted) return;
    const now = (this.h.deaths?.allSlots() ?? []).map((x) => (x && x.count > 0 ? { ...x } : null));
    const slots = now.filter((x) => x).length >= this.alive.filter((x) => x).length ? now : this.alive;
    j.death = { record, ms: this.now(), slots, step: j.step && j.step.kind !== 'done' && j.step.kind !== 'stuck' ? j.step.command : undefined };
    this.log.info(`get ${j.label}: died (${record.cause}) at ${j.death.step ? `!${j.death.step}` : 'a plan'}; ${slots.filter((x) => x).length} stacks dropped`);
  }

  /** Track E4: the respawn settled (tasks/respawn.ts afterRespawn): the job may walk back now. */
  readonly afterRespawn: RespawnHook = (feet) => {
    const d = this.job?.death;
    if (d && !d.feet) d.feet = { ...feet };
  };

  /** Track E4: the job takes the respawn (the afk task's walk home is skipped) while it goes back for the drops. */
  claimsRespawn(): boolean {
    return this.job?.death !== undefined && (this.h.deaths?.enabled() ?? false);
  }

  /** Dispatch one command, wait for its process to end; the last reply seen meanwhile. */
  private async step(line: ChatLine, job: ObtainJob, command: string, soft = false, wear?: { block: string; toolOk: ToolOk }): Promise<string | undefined> {
    const name = STEP_PROCESS[command.split(' ')[0]!];
    const before = new Set(this.h.processes.userProcesses());
    const startSlots = wear ? this.h.slots().map((s) => (s ? { ...s } : null)) : [];
    let last: string | undefined;
    const seen = (m: string): void => {
      last = m;
    };
    this.replies = seen;
    try {
      this.dispatching = true;
      try {
        this.h.dispatch(line, command);
      } finally {
        this.dispatching = false;
      }
      const t0 = this.now();
      let p: Process | undefined;
      while (!p && this.now() - t0 < OBTAIN_START_MS && !job.aborted) {
        p = this.h.processes.userProcesses().find((x) => !before.has(x) && x.name === name);
        if (!p) await this.h.wait(100);
      }
      job.process = p;
      if (!p) return last;
      while (!p.done && !job.aborted && this.now() - t0 < OBTAIN_STEP_MS) {
        if (!job.death) this.snapshot(); // Track E4: what a death would drop
        // Track E4: the worn-tool limit mid-step: the miner (and the digger with the worn pickaxe already in hand) digs
        // on until it breaks; the job ends the step at the limit and the next plan crafts a fresh pickaxe
        if (wear && pickaxeWore(startSlots, this.h.slots(), wear.block, wear.toolOk)) {
          this.log.info(`get ${job.label}: the pickaxe reached the worn-tool limit during !${command}: ending the step to replace it`);
          this.h.processes.stop(p, 'stopped');
          await this.h.wait(300);
          return 'the pickaxe reached the worn-tool limit';
        }
        await this.h.wait(POLL_MS);
      }
      if (!p.done) {
        this.h.processes.stop(p, 'stopped');
        // Track E2: a mine step for soft targets ends at the limit with what it got (the job goes on)
        if (soft) last = `the step's ${Math.round(OBTAIN_STEP_MS / 60_000)}-minute limit`;
        else job.aborted ??= `the step's ${Math.round(OBTAIN_STEP_MS / 60_000)}-minute limit (!${command})`;
      }
      // the process's own end reply comes after its result: a moment for it
      await this.h.wait(300);
      return last;
    } finally {
      job.process = undefined;
      if (this.replies === seen) this.replies = undefined;
    }
  }

  /** Every reply the bot sends (wired over chat.say): the running step keeps the last one. */
  replies: ((m: string) => void) | undefined;
  observeReply(m: string): void {
    if (!m.startsWith('get') && !m.startsWith('getting')) this.replies?.(m);
  }

  /** `!get stop` (or a replacing `!get`): the job and its step's process. */
  stop(why = 'stopped'): string | undefined {
    const j = this.job;
    if (!j) return undefined;
    j.aborted = why === 'stopped' ? '!get stop' : why;
    j.silent = true;
    const p = j.process;
    if (p && !p.done) this.h.processes.stop(p, 'stopped');
    this.job = undefined;
    return `stopped get ${j.label} after ${j.steps.length} step${j.steps.length === 1 ? '' : 's'}${j.step && j.step.kind !== 'done' && j.step.kind !== 'stuck' ? ` (at !${j.step.command})` : ''}`;
  }

  status(): string | undefined {
    const j = this.job;
    if (!j) return undefined;
    const s = j.phase ?? (j.step && j.step.kind !== 'done' && j.step.kind !== 'stuck' ? `!${j.step.command}` : 'planning');
    return `get ${j.label}: step ${j.steps.length + 1} ${s}${j.process ? `: ${j.process.status().line}` : ''} (${Math.round((this.now() - j.startedAt) / 1000)} s)`;
  }

  dispose(): void {
    this.stop('dispose');
    this.offCommand();
  }
}

const kits = new WeakMap<object, ObtainController>();

/** The obtain controller of a task (tests). */
export function obtainControlOf(task: object): ObtainController | undefined {
  return kits.get(task);
}

/**
 * Register the obtain job on `!get` (tasks/registry.ts, after the crafter): `!get <craftable>` and `!get kit`.
 * Needs `!get` (walking) and `!craft`; without them `!get` keeps the catalog's reply.
 */
/** Track E4: what the afk task hands the obtain job for a death (tasks/registry.ts). */
export interface KitExtra {
  respawn?: { onEvent(fn: (e: { kind: string; death?: DeathRecord }) => void): () => void; afterRespawn(hook: RespawnHook): void };
  clock?: { readonly time: number | undefined };
  /** The afk task's walk home after a respawn (skipped while the job claims the respawn). */
  goHome?: () => void;
}

export function registerKitCommands(d: CommandDeps, extra: KitExtra = {}): ObtainController | undefined {
  const get = getControllerOf(d.task);
  const craft = craftControlOf(d.task);
  const world = d.mobility?.world;
  if (!get || !craft || !world || !d.processes) return undefined;
  const processes = d.processes;
  const { skills, pve } = d;
  const home = (): Vec3 | undefined => d.task.home?.get();
  /** Every slot a death drops (the main inventory, the armour, the offhand). */
  const allSlots = (): (ItemStack | null)[] => [...world.inventory.slots.slice(0, 36), ...(world.inventory.window(WINDOW_ARMOR)?.slots ?? []), ...(world.inventory.window(WINDOW_OFFHAND)?.slots ?? [])];
  const cancelSkills = (): void => {
    if (pve?.mover.nav.busy) pve.mover.cancel();
    skills?.cancel();
  };
  const crafter = craft.crafter;
  const tables: ObtainTables = {
    hold: (on) => {
      crafter.holdTables = on;
    },
    standing: () => crafter.pendingTables.filter((p) => world.blockAt(p)?.name === 'crafting_table').length,
    sweep: () => {
      const keep = (p: Vec3): boolean => {
        const h = home();
        return !!h && Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) <= TABLE_HOME_KEEP;
      };
      const p = processes.add(
        new WorkProcess(
          'tables',
          'picking up the crafting table',
          async (cancelled) => {
            const r = await crafter.sweepTables({ radius: TABLE_SWEEP, keep, cancelled });
            return { picked: r.picked.length, kept: r.kept.length, left: r.left };
          },
          cancelSkills,
        ),
      );
      return { process: p, result: p.result };
    },
  };
  const deaths: ObtainDeaths | undefined =
    skills && pve
      ? {
          enabled: () => d.settings.get('deathReturn'),
          time: () => extra.clock?.time,
          allSlots,
          recover: (req) => {
            const mover = settingsMover(skills, d.settings);
            const p = processes.add(new RecoverProcess({ goto: (g, o) => mover.goto(g, o), collect: (r, t, o) => skills.collect(r, t, o), cancel: cancelSkills, log: d.log }, req));
            return { process: p, result: p.result };
          },
          heldFurnace: () => smeltControlOf(d.task)?.held(),
          collectFurnace: (at) => {
            const s = smeltControlOf(d.task);
            if (!s) return { result: Promise.resolve({ line: 'no smelter', taken: 0 }) };
            const p = s.collect(at);
            return { process: p, result: p.result.then((r) => ({ line: smeltLine(r), taken: Object.values(r.cook?.cooked ?? {}).reduce((a, b) => a + b, 0) })) };
          },
          goHome: () => extra.goHome?.(),
        }
      : undefined;
  const c = new ObtainController({
    dispatch: (line, command) => d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` }),
    processes,
    slots: () => world.inventory.slots,
    recipes: craft.recipes,
    options: () => {
      // Track E2: a furnace where the cooker looks, a coal ore near, the worn armour and the offhand
      const me = d.mobility?.loop.state.pos;
      const coal = me ? coalNearOutsideBase(world, me, d.mobility?.skills.nav.breakRules().protectedArea) : false;
      const worn = [...(world.inventory.window(WINDOW_ARMOR)?.slots ?? []), ...(world.inventory.window(WINDOW_OFFHAND)?.slots ?? [])];
      // Track E3: a bed where the night rule sleeps; Track E4: the worn-tool rule (a worn pickaxe harvests nothing for the plan)
      const toolOk = survivalKitOf(d.task)?.toolOk;
      return { ...craft.chainOptions(), furnaceNear: (smeltControlOf(d.task)?.furnaces().length ?? 0) > 0, coalNear: coal, worn, bedNear: (bedControlOf(d.task)?.beds().length ?? 0) > 0, ...(toolOk ? { toolOk } : {}) };
    },
    onCommand: (fn) => d.chat.onCommand(fn),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    herd: (kind, skip) => {
      // Track E3: the food commands' herd memory
      const food = foodControllerOf(d.task);
      const herds = food ? foodExtrasOf(food)?.herds : undefined;
      const me = d.mobility?.loop.state.pos;
      if (!herds || !me) return undefined;
      const m = herds.next(me, { leave: d.settings.get('foodLeave'), kinds: [kind], skip });
      return m ? { x: m.x, y: m.y, z: m.z, key: cellKey(m.cx, m.cz) } : undefined;
    },
    log: d.log,
    tables,
    furnace: () => smeltControlOf(d.task)?.furnaces()[0],
    ...(deaths ? { deaths } : {}),
  });
  // Track E4: deaths in a job; the job's walk back holds the afk task's walk home (respawnClaimed)
  extra.respawn?.onEvent((e) => {
    if (e.kind === 'death' && e.death) c.onDeath(e.death);
  });
  extra.respawn?.afterRespawn(c.afterRespawn);
  claimRespawn(d.task, () => c.claimsRespawn(), 'obtain');
  // every reply goes through chat.say: the running step keeps the last one for the end line
  const say = d.chat.say.bind(d.chat);
  d.chat.say = (m: string) => {
    c.observeReply(m);
    return say(m);
  };
  get.obtain = {
    run: (line, name, n, reply) => {
      if (craft.recipes.size === 0) return false;
      const item = itemAlias(name);
      const isKit = name === 'kit' || kitWords(name.split('_'));
      const iron = ironKitWords(name.split('_'));
      // Track E2: a smelted item (`iron_ingot`) is the obtain job's too (mined, then smelted)
      if (!isKit && !iron && craft.recipes.byOutput(item).length === 0 && !smeltInputsOf(item)) return false;
      const { label, targets } = ObtainController.targetsFor(iron ? 'kit_iron' : isKit ? 'kit' : item, n);
      get.stop();
      c.start(line, label, targets, reply);
      return true;
    },
    stop: () => c.stop(),
    status: () => c.status(),
  };
  kits.set(d.task, c);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    c.dispose();
    get.obtain = undefined;
    stop();
  };
  return c;
}

/** Track E2: words of `!get` that name the iron kit (`kit iron`, `iron kit`). */
export function ironKitWords(args: readonly string[]): boolean {
  const w = args.map((a) => a.toLowerCase());
  return w.length === 2 && ((w[0] === 'kit' && w[1] === 'iron') || (w[0] === 'iron' && w[1] === 'kit'));
}

/**
 * Track E5: a coal ore known within COAL_NEAR of `me` and outside the base round home (`area`, the break rules'
 * protectRadius sphere). The miner refuses ore inside the base (`protected_area`); measured on a fresh mountain world
 * with home set, the fuel step `!mine coal_ore 4` refused 816 known coal ores and got nothing. With none outside the
 * base the fuel is planks or logs.
 */
export function coalNearOutsideBase(world: { find(pred: (b: { name: string }, p: Vec3) => boolean, opts: { origin: Vec3; radius: number; max: number }): unknown[] }, me: Vec3, area: { x: number; y: number; z: number; r: number } | undefined): boolean {
  const inBase = (p: Vec3): boolean => !!area && Math.hypot(p.x + 0.5 - area.x, p.y + 0.5 - area.y, p.z + 0.5 - area.z) <= area.r;
  return world.find((b, p) => (b.name === 'coal_ore' || b.name === 'deepslate_coal_ore') && !inBase(p), { origin: me, radius: COAL_NEAR, max: 1 }).length > 0;
}

/** Words of `!get` that name the early kit. */
export function kitWords(args: readonly string[]): boolean {
  const w = args.map((a) => a.toLowerCase());
  return w[0] === 'kit' && (w.length === 1 || (w.length === 2 && (w[1] === 'early' || w[1] === 'starter')));
}