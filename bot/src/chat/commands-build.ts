// `!build` (wave 9, Track AL; docs/build.md), owner-only like every command: the builder.
//
//   !build fill x1 y1 z1 x2 y2 z2 <block> [fetch]       building fill 5x3x5 cobblestone: 75 to place, ...
//   !build clear x1 y1 z1 x2 y2 z2                      building clear 5x3x5: 75 to dig
//   !build replace x1 y1 z1 x2 y2 z2 <from> <to> [fetch]
//   !build wall x1 y z1 x2 z2 <height> <block> [fetch] | floor x1 y z1 x2 z2 <block> [fetch] | pillar x y z <height> <block> [fetch]
//   !build file <name> [x y z] [0|90|180|270] [skip unknown] [fetch]
//                                                       a structure file (.mcstructure, the JSON layer format; Track B2:
//                                                       .schem, .schematic, .litematic, .nbt from Java)
//   !build materials [<build>]                          materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone
//                                                       (Track B2: then the bill: what it has, makes and gets, the unknowns)
//   !build files                                        Track B2: the structure files with their size and block count
//   !build status                                       build: 212 / 640 placed, 3 skipped, eta 4 min
//   !build stop                                         stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped
//   !build resume                                       Track B3: resuming build file castle at ...: 5120 of 20480 done
//
// A build runs as a user process (tasks/process/build.ts): guard, flee and night pre-empt it, `!pause`
// holds it, `!stop` ends it. Missing blocks refuse the build. Track B2 (ADR 0125): `fetch` works through the
// bill of materials (skills/build/bill.ts) one command at a time, as the owner, through the chat handler: what the
// home chests hold with `!bring ... home`, raw materials with `!get`, then `!craft` for what can be crafted from
// what is carried, `!furnace` when a smelt needs one, `!smelt`, and the crafts that wait on smelted items; the bill is
// made again after each command, and the build starts when nothing is missing.
// Track B3 (ADR 0128): a build over SECTION_CELLS cells, or one whose blocks do not fit in the inventory, is a job
// (skills/build/job.ts) planned and built a section at a time; with `fetch` the bill of the whole build is checked
// first and the blocks come in rounds (what fits), the bot going back to where it left after each. Every build keeps
// its progress (skills/build/progress.ts); `!build resume` goes on with the last one, and a build that was running
// when the bot went away goes on by itself once it is back (`buildResume`).
import type { ChatLine } from './text.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BoxWorkProcess, BuildProcess, type BuildEnd } from '../tasks/process/build.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from '../tasks/process/manager.ts';
import { BILL_LINE_MAX, billLines, billNeeds, billOf, billSteps, nextFetchStep, packLines, stepWords, type Bill, type FetchNow, type FetchStep } from '../skills/build/bill.ts';
import { buildDirs, bytesText, listStructures, loadStructure, type Structure, type StructureFile, type UnknownBlock } from '../skills/build/formats/index.ts';
import { BuildJob, buildCells, sectionsOf, type JobDeps, type Survey } from '../skills/build/job.ts';
import { materialsLine, materialsOf, usable, type Materials } from '../skills/build/materials.ts';
import { planBuildAsync, planLine, PlanError, refusedLine, type Plan, type PlanOptions } from '../skills/build/plan.ts';
import { BuildProgress, buildProgressFile, fileHash, loadProgress, type ProgressData } from '../skills/build/progress.ts';
import { BuildRunner, etaText, progressLine, SCAFFOLD_PICK, timeLine, type RunnerDeps, type RunnerHooks } from '../skills/build/runner.ts';
import type { BlockReader } from '../skills/build/sim.ts';
import { BUILD_USAGE, parseSpec } from '../skills/build/spec.ts';
import { BuildPlannerClient, shapeKey, snapshotBox, snapshotWorld, SNAP_MAX } from '../skills/build/worker.ts';
import { MAX_BUILD_CELLS, SECTION_CELLS, type BuildSpec, type Cell } from '../skills/build/types.ts';
import { resolveBlocks } from '../skills/build/states.ts';
import { isShulkerBox, maxStackOf } from '../skills/container/chest.ts';
import type { ChainOptions } from '../skills/craft/chain.ts';
import type { RecipeIndex } from '../skills/craft/recipes.ts';
import { furnacesCarried } from '../skills/food/furnace.ts';
import { sourceRecords } from '../skills/home/bring.ts';
import { supplyOf } from '../skills/supply/supply.ts'; // Track BJ
import { THROWAWAY_BLOCKS } from '../skills/survival/keeper.ts';
import { canHarvestWith } from '../skills/items/obtain.ts'; // Track B3: the scaffold tool
import { usableSlots } from '../skills/items/wear.ts';
import { survivalKitOf } from './commands-survival.ts';
import type { ItemStack } from '../world/types.ts';
import type { Logger } from '../log.ts';
import { craftControlOf } from './commands-craft.ts';
import { homeControlOf } from './commands-home.ts';
import { smeltControlOf } from './commands-smelt.ts';

export const BUILD_HELP = 'fill|clear|replace|wall|floor|pillar|file ... [fetch]; materials, files, status, stop, resume (builds walls, floors, boxes, saved structures)';
/** Track B3: after the bot is back, this long before a build that was running goes on (the chunks come in). */
const RESUME_DELAY_MS = 5000;
/** Track B3: a build that was running goes on by itself only while the bot is within this many blocks of its box (sideways). */
export const AUTO_RESUME_NEAR = 128;
/** How long `fetch` works in all (ms). */
const FETCH_TIMEOUT_MS = 60 * 60_000;
/** How long one fetch command may run (a furnace smelts 64 items in 640 s). */
const FETCH_STEP_MS = 20 * 60_000;
/** Commands one fetch runs at most. */
const MAX_FETCH_STEPS = 40;
const FETCH_POLL_MS = 1000;
/** How long a dispatched command has to show its process. */
const FETCH_START_MS = 3000;
/** Processes a fetch command may start (commands-get GET_PROCESSES, !bring, !craft, !furnace, !smelt). */
const FETCH_PROCESSES = new Set(['gather', 'mine', 'food', 'kill', 'bring', 'craft', 'furnace', 'smelt']);
/** Unknown blocks `!build materials` names one a line. */
const MAX_UNKNOWN_LINES = 8;
/** Track B3: within this many blocks of home a fetch step is not tried again at home. */
const HOME_NEAR = 6;

/** Track B2: what the bill of materials reads besides the inventory (the task's crafter, smelter and chest memory). */
export interface BillContext {
  recipes?: Pick<RecipeIndex, 'byOutput'> & Partial<Pick<RecipeIndex, 'outputs2'>>;
  chain?: ChainOptions;
  /** A furnace stands where `!smelt` looks, or one is carried. */
  furnaceNear(): boolean;
  /** Items in the home chests (the chest memory). */
  home(): Map<string, number>;
}

/** What the controller needs from the bot (faked in the unit tests). */
export interface BuildHost {
  world: BlockReader;
  position(): Cell | undefined;
  inventory: { count(name: string): number };
  /** Track B2: the inventory slots (the bill's pool, the fetch's craft checks); without it the bill reads only `inventory`. */
  slots?(): readonly (ItemStack | null | undefined)[];
  /** Track BJ: items of a kind inside the carried shulker boxes (the task's Supply); the materials count them. */
  boxed?(name: string): number;
  /** Track B2: recipes, the furnaces and the home chests for the bill. */
  bill?(): BillContext | undefined;
  /** Track B2: the structure files (`!build files`). */
  files?(): { files: StructureFile[]; more: number };
  throwawayMin(): number;
  scaffold(): boolean;
  /** Track B1: a block's collision boxes by name and states (the world registry), for the planner's stands. */
  shapeOf?: (name: string, states: Readonly<Record<string, unknown>> | undefined) => readonly (readonly number[])[] | undefined;
  processes: Pick<ProcessManager, 'add' | 'stop' | 'find' | 'userProcesses'>;
  /** A runner for a plan (wired to the bot's skills); Track B3: with a large build's hooks. */
  runner(plan: Plan, hooks?: RunnerHooks): BuildRunner;
  /** Run a chat command as the owner who typed `line` (no prefix). */
  dispatch(line: ChatLine, command: string): void;
  /** Load a structure file by name. */
  load(name: string): Structure & { file?: string };
  say(m: string): void;
  log: Logger;
  /** Tests: the fetch's clock and wait. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Track B3: plan one section of a large build (the planner worker); default planBuildAsync on `world`. */
  planSection?(spec: BuildSpec, o: PlanOptions): Promise<Plan>;
  /** Track B3: the `buildColumnMax` setting (default 6). */
  columnMax?(): number;
  /** Track B3: walk near a cell (back to the build after a fetch round). */
  approach?(c: Cell): Promise<boolean>;
  /** Track B3: the progress file (undefined: kept in memory only). */
  progressFile?(): string | undefined;
  /** Track B3: an item's stack size (default maxStackOf). */
  stack?(item: string): number;
  /** Track B3: the home (`!home set`): a fetch step that changed nothing away from it is tried once more there. */
  home?(): Cell | undefined;
  /** Track B4 (decision 0129): the carried shulker boxes as the build's source and store (the task's Supply). */
  boxes?(): BuildBoxes | undefined;
  /** Track B4: cancel the running skill (a box step or the walk to a left box pre-empted). */
  cancel?(): void;
}

/** Track B4 (decision 0129): what a build does with the carried shulker boxes (skills/supply/supply.ts). */
export interface BuildBoxes {
  /** Everything the usable carried boxes hold, by item. */
  contents(): Map<string, number>;
  /** Free slots in the usable carried boxes. */
  room(): number;
  /** Shulker boxes in the inventory (any). */
  carried(): number;
  take(want: Record<string, number>, o: { cancelled: () => boolean; avoid?: (c: Cell) => boolean }): Promise<{ taken: Record<string, number>; boxes: number; reason?: string }>;
  stow(keep: Record<string, number>, o: { cancelled: () => boolean; avoid?: (c: Cell) => boolean }): Promise<{ stowed: Record<string, number>; boxes: number; reason?: string }>;
  /** Boxes out in the world now: standing (an interrupted break), on the ground. */
  outstanding(): { standing: Cell[]; left: Cell[] };
  recover(cancelled: () => boolean): Promise<void>;
  /** One watcher of `outstanding` (called before a box's place request goes); undefined clears it. */
  watch(fn: (() => void) | undefined): void;
  /** Boxes a session before left (a progress file): picked up by the next recover. */
  adopt(cells: { standing?: readonly Cell[]; left?: readonly Cell[] }): void;
  /** Shulker boxes lying on the ground within `r` of the bot picked up: how many came in. */
  pickUp(r: number, cancelled: () => boolean): Promise<number>;
}

/** Track B4: `!build ... fetch` picks up the shulker boxes lying within this many blocks first (handed over). */
export const HANDED_RADIUS = 8;
/** Track B4: a box left in the world farther than this is walked to before the recovery. */
const BOX_NEAR = 12;

const itemsText = (m: Readonly<Record<string, number>>): string =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');

/** A fetch's step now in words: `!bring oak_log 4 home`, or (Track B4) a box step. */
function stepWords_(f: Pick<Fetching, 'command' | 'boxCommand'>): string {
  return f.boxCommand ?? (f.command ? `!${f.command}` : '');
}

/** Track B4: a fetch step as words (the log, the no-progress check, `fetched`). */
export function stepCommand(s: FetchStep): string {
  if (s.kind === 'run') return s.command;
  if (s.kind === 'unbox') return `take out of my boxes: ${itemsText(s.want)}`;
  if (s.kind === 'stow') return `stow into my boxes: ${Object.keys(s.keep).join(', ')}`;
  return s.kind;
}

interface Fetching {
  label: string;
  cancelled: boolean;
  step: number;
  command: string;
  t0: number;
  stepAt: number;
  proc?: FetchProcess;
  /** Track B3: a large build's round (its number). */
  round?: number;
  /** Track B4: the box step running (a take out of or a stow into the carried boxes), and its words. */
  box?: BoxWorkProcess;
  boxCommand?: string | undefined;
  /** Track B4: cells no box goes on in this fetch (the build's). */
  avoid?: (c: Cell) => boolean;
  /** Track B4: box steps run, items taken out and stowed (the round's line). */
  boxSteps?: number;
  taken?: number;
  stowed?: number;
}

/** Track B3: no stand of a build beside a drop deeper than this (a fall of more than 3 blocks costs health). */
export const SAFE_EDGE = 3;
/** Track B3: inventory slots a fetch round leaves free (the pickups, a tool, food). */
export const SLOT_MARGIN = 4;
/** Track B3: fetch rounds a build runs at most. */
export const MAX_ROUNDS = 100;
/** Track B3: a job no taller than this needs no scaffold blocks in its whole bill; a taller one JOB_SCAFFOLDS at once. */
export const JOB_LOW = 4;
export const JOB_SCAFFOLDS = 24;

/** Track B3: what a build was started with (kept in its progress). */
interface StartCtx {
  line: ChatLine;
  args: string[];
  feet: Cell;
  fetch: boolean;
  file?: { name: string; sha256: string };
}

/** Track B3: a large build running: its job, its progress, the round in progress. */
interface JobRun {
  job: BuildJob;
  ctx: StartCtx;
  progress: BuildProgress;
  cancelled: boolean;
  reason?: StopReason;
  /** The scaffold tool could not be got: said once. */
  toolSaid?: boolean;
}

/** Track B3: the hash of a structure: its file's bytes, else its blocks (a structure made in code). */
export function structureHash(s: Structure & { file?: string }): string {
  return fileHash(s.file, () => JSON.stringify([s.size, s.blocks.map((b) => [b.pos.x, b.pos.y, b.pos.z, b.name, b.states ?? null])]));
}

/** Track B3: the line a saved build's fetch runs as (who started it). */
function lineOf(o: ProgressData['owner']): ChatLine | undefined {
  if (!o) return undefined;
  return { type: o.type as ChatLine['type'], source: o.source, message: '', body: '', xuid: o.xuid, truth: false };
}

/**
 * Track B2: the fetch as a user process (named build, like the build it starts): each command's own process pre-empts it
 * and it gets control back in between, so the home chore (idle only without a user process) does not unload what a step
 * brought before the next step uses it; `!stop` and a death end it. It does nothing with control: the controller runs the steps.
 */
export class FetchProcess extends BaseProcess {
  readonly name = 'build';
  readonly kind = 'user' as const;
  private readonly line: () => string;
  private readonly stopped: (reason: StopReason) => void;

  constructor(line: () => string, stopped: (reason: StopReason) => void) {
    super();
    this.line = line;
    this.stopped = stopped;
  }

  get priority(): number {
    return PRIORITY.user;
  }

  protected run(): void {}

  protected halt(): void {}

  protected override onStopped(reason: StopReason): void {
    this.stopped(reason);
  }

  /** The fetch is over (the build starts, or it stopped with its line said). */
  end(): void {
    this.finish();
  }

  behaviour(): string {
    return 'fetching build materials';
  }

  status(): ProcessStatus {
    return { line: this.line() };
  }
}

/** `create:gearbox x 4 (not a Bedrock block)` lines. */
export function unknownLines(unknown: readonly UnknownBlock[]): string[] {
  const out = unknown.slice(0, MAX_UNKNOWN_LINES).map((u) => `unknown: ${u.java} x ${u.count} (${u.reason})`);
  if (unknown.length > MAX_UNKNOWN_LINES) out.push(`unknown: ${unknown.length - MAX_UNKNOWN_LINES} more kinds (${unknown.slice(MAX_UNKNOWN_LINES).reduce((a, u) => a + u.count, 0)} blocks)`);
  return out;
}

/** `!build files` lines: `build files: house (schem, 7x5x7, 120 blocks, 4 unknown, 1.2 KB), ...`. */
export function filesLines(list: { files: readonly StructureFile[]; more: number }, max = BILL_LINE_MAX): string[] {
  if (list.files.length === 0) return ['build files: none in the build folders (.mcstructure, .json, .schem, .schematic, .litematic, .nbt)'];
  const entries = list.files.map((f) => {
    if (f.error) return `${f.name} (${f.format}, ${bytesText(f.bytes)}: ${f.error})`;
    const big = (f.blocks ?? 0) > MAX_BUILD_CELLS ? ': too big to build' : '';
    return `${f.name} (${f.format}, ${f.size!.x}x${f.size!.y}x${f.size!.z}, ${f.blocks} blocks${f.unknown ? `, ${f.unknown} unknown` : ''}, ${bytesText(f.bytes)}${big})`;
  });
  if (list.more) entries.push(`${list.more} more not read`);
  const out: string[] = [];
  let cur = 'build files:';
  for (const e of entries) {
    const next = `${cur}${cur.endsWith(':') ? ' ' : ', '}${e}`;
    if (Buffer.byteLength(next, 'utf8') > max && !cur.endsWith(':')) {
      out.push(cur);
      cur = `build files: ${e}`;
    } else cur = next;
  }
  out.push(cur);
  return out;
}

export class BuildController {
  private readonly h: BuildHost;
  /** The last plan (for `!build materials` without arguments). */
  last: Plan | undefined;
  /** Track B2: the unknown blocks of the last plan's file. */
  private lastUnknown: UnknownBlock[] = [];
  /** The process of the running build. */
  proc: BuildProcess | undefined;
  /** A `fetch` in progress. */
  private fetching: Fetching | undefined;
  /** Track B3: a large build running (between its processes and rounds too). */
  private jobRun: JobRun | undefined;
  /** Every build's end line, newest last (tests, status). */
  readonly ends: string[] = [];
  /** Track B2: every fetch command run, oldest first (tests, e2e evidence). */
  readonly fetched: string[] = [];

  constructor(h: BuildHost) {
    this.h = h;
  }

  private now(): number {
    return this.h.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.h.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }

  async run(line: ChatLine, args: readonly string[], reply: (m: string) => void): Promise<void> {
    const a = (args[0] ?? '').toLowerCase();
    if (args.length === 0) return reply(`usage: !build ${BUILD_HELP}`);
    if (a === 'stop' && args.length === 1) return reply(this.stop());
    if (a === 'status' && args.length === 1) return reply(this.status());
    if (a === 'files' && args.length === 1) {
      for (const l of filesLines(this.h.files?.() ?? { files: [], more: 0 })) reply(l);
      return;
    }
    if (a === 'materials') {
      for (const l of await this.materials(args.slice(1))) reply(l);
      return;
    }
    if (a === 'resume' && args.length === 1) return this.resume(line, reply);
    if (this.fetching) return reply(`build: fetching materials for ${this.fetching.label} (!build stop ends it)`);
    if (this.jobRun) return reply(`build: ${this.jobRun.job.plan.spec.label} is running (!build stop ends it)`);
    if (this.boxProc && !this.boxProc.done) return reply(`build: ${this.boxProc.behaviour()} (!build stop ends it)`);
    const feet = this.h.position();
    let loaded: (Structure & { file?: string }) | undefined;
    const parsed = parseSpec(args, {
      feet,
      load: (n) => {
        loaded = this.h.load(n);
        return loaded;
      },
    });
    if (!parsed.ok) return reply(`build: ${parsed.error}${parsed.error.startsWith('unknown build') ? ` (usage: !build ${BUILD_HELP})` : ''}`);
    this.lastUnknown = parsed.unknown ?? [];
    const ctx: StartCtx = { line, args: [...args], feet: feet ? { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) } : { x: 0, y: 0, z: 0 }, fetch: parsed.fetch, ...(loaded ? { file: { name: loaded.name, sha256: structureHash(loaded) } } : {}) };
    // Track B4: the shulker boxes handed over (dropped near the bot) first, so the bill counts what they hold
    if (parsed.fetch && !(await this.pickUpHanded(reply))) return;
    // Track B3: over one section: a job, planned a section at a time
    if (buildCells(parsed.spec) > SECTION_CELLS) return this.startJob(ctx, parsed.spec, reply);
    const plan = await this.plan(parsed.spec, reply);
    if (!plan) return;
    const m = this.materialsFor(plan);
    if (!m.ok) {
      if (!parsed.fetch) {
        const l = `build: ${materialsLine(plan.spec.label, m, plan.scaffolds).replace(/^materials for /, '')}`;
        const hint = '(add fetch to get, craft and smelt them first)';
        // the hint on its own line when the chat would cut it off (256 characters)
        if (l.length + 1 + hint.length <= BILL_LINE_MAX) reply(`${l} ${hint}`);
        else {
          reply(l);
          reply(`build: ${hint.slice(1, -1)}`);
        }
        for (const l of billLines(plan.spec.label, this.billFor(plan, m))) reply(l);
        return;
      }
      // Track B3: more than the inventory holds: fetched in rounds as the build goes
      if (!this.fits(plan)) return this.startJob(ctx, parsed.spec, reply);
      return this.fetchThenBuild(line, plan, m, reply, ctx);
    }
    this.start(plan, reply, ctx);
  }

  /** Track B3: the options every plan is made with. */
  private planOptions(): Omit<PlanOptions, 'start'> {
    return { scaffold: this.h.scaffold(), shapeOf: this.h.shapeOf, maxColumn: this.h.columnMax?.() ?? 6, safeEdge: SAFE_EDGE };
  }

  private stackOf(item: string): number {
    return Math.max(1, this.h.stack?.(item) ?? maxStackOf(item));
  }

  /** Track B3: inventory slots the build's items may fill: the 36 less the slots of other items, less SLOT_MARGIN. */
  private freeSlots(items: Iterable<string>): number {
    const mine = new Set(items);
    for (const k of THROWAWAY_BLOCKS) mine.add(k);
    let other = 0;
    for (const s of this.h.slots?.().slice(0, 36) ?? []) if (s && s.count > 0 && !mine.has(s.name)) other++;
    return Math.max(1, 36 - other - SLOT_MARGIN);
  }

  /** Track B3: the plan's blocks (and its scaffold blocks) fit in the inventory at once (unknown without the slots: yes). */
  private fits(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>): boolean {
    if (!this.h.slots) return true;
    const need = billNeeds(plan.materials);
    let stacks = Math.ceil((plan.scaffoldPeak + this.h.throwawayMin()) / 64);
    for (const [it, n] of need) stacks += Math.ceil(n / this.stackOf(it));
    return stacks <= this.freeSlots(need.keys());
  }

  private async plan(spec: BuildSpec, reply: (m: string) => void): Promise<Plan | undefined> {
    const start = this.h.position();
    if (!start) {
      reply('build: my position is unknown');
      return undefined;
    }
    try {
      const plan = await planBuildAsync(this.h.world, spec, { ...this.planOptions(), start });
      this.last = plan;
      this.h.log.info(`build: planned ${planLine(plan)} in ${plan.ms.toFixed(0)} ms (${plan.steps.length} steps${plan.stateful ? `, ${plan.stateful} with states, ${plan.turned ?? 0} with a turned view` : ''})`);
      if (plan.refused?.length) this.h.log.info(`build: refused ${plan.refused.map((r) => `${r.name} at ${r.pos.x} ${r.pos.y} ${r.pos.z} (${r.reason})`).join('; ')}`);
      return plan;
    } catch (e) {
      reply(`build: ${e instanceof PlanError || e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private materialsFor(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>): Materials {
    const boxed = this.h.boxed?.bind(this.h);
    return materialsOf(plan, this.h.inventory, { throwawayMin: this.h.throwawayMin() }, boxed);
  }

  /** Track B2: the bill of materials of a plan against the inventory, the boxes and the home chests (Track B3: or of a round's need). */
  billFor(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>, m: Materials = this.materialsFor(plan)): Bill {
    const own = billNeeds(plan.materials);
    const need = new Map(own);
    if (m.scaffoldShort > 0) need.set('cobblestone', (need.get('cobblestone') ?? 0) + m.scaffoldShort);
    const r = { throwawayMin: this.h.throwawayMin() };
    const loose = new Map<string, number>();
    const names = new Set<string>(need.keys());
    for (const s of this.h.slots?.().slice(0, 36) ?? []) if (s && s.count > 0) names.add(s.name);
    for (const n of names) {
      let u = usable(this.h.inventory, n, r);
      // Track B3: a scaffold short counts every carried throwaway block beyond the build's own already (the scaffold
      // takes the reserve too): only the build's own may cover a need, or the short is counted as carried twice
      if (m.scaffoldShort > 0 && THROWAWAY_BLOCKS.includes(n)) u = Math.min(u, own.get(n) ?? 0);
      if (u > 0) loose.set(n, u);
    }
    // Track B4: everything the carried boxes hold (the making draws on it too); without the box layer the build's own items
    const bx = this.h.boxes?.();
    const boxed = bx ? bx.contents() : new Map<string, number>();
    if (!bx) {
      for (const n of need.keys()) {
        const b = this.h.boxed?.(n) ?? 0;
        if (b > 0) boxed.set(n, b);
      }
    }
    const ctx = this.h.bill?.();
    const carriedThrowaway = THROWAWAY_BLOCKS.reduce((a, k) => a + this.h.inventory.count(k), 0);
    return billOf({
      need,
      loose,
      boxed,
      home: ctx?.home() ?? new Map(),
      ...(ctx?.recipes ? { recipes: ctx.recipes } : {}),
      ...(ctx?.chain ? { chain: ctx.chain } : {}),
      furnaceNear: ctx?.furnaceNear() ?? false,
      reserve: { kinds: THROWAWAY_BLOCKS, short: Math.max(0, r.throwawayMin - carriedThrowaway) },
    });
  }

  /** `!build materials [<build>]`: the materials line, then (Track B2) the bill and the unknown blocks. */
  async materials(args: readonly string[]): Promise<string[]> {
    let plan: Plan | undefined = this.proc && !this.proc.done ? this.proc.runner.plan : this.last;
    let unknown = plan === this.last ? this.lastUnknown : [];
    if (args.length > 0) {
      const parsed = parseSpec(args, { feet: this.h.position(), load: (n) => this.h.load(n), allowUnknown: true });
      if (!parsed.ok) return [`build: ${parsed.error}`];
      let err = '';
      if (buildCells(parsed.spec) > SECTION_CELLS) {
        // Track B3: a large build's materials from its blocks (no plan: the scaffold blocks come as it goes)
        try {
          const s = sectionsOf(parsed.spec, this.h.position() ?? { x: 0, y: 0, z: 0 });
          plan = { spec: parsed.spec, steps: [], work: s.cells, already: 0, occupied: 0, skipped: [], scaffolds: 0, scaffoldPeak: 0, materials: s.materials, ms: 0, ...(s.refused.length ? { refused: s.refused } : {}) };
        } catch (e) {
          return [`build: ${e instanceof Error ? e.message : String(e)}`];
        }
      } else {
        plan = await this.plan(parsed.spec, (m) => {
          err = m;
        });
      }
      if (!plan) return [err];
      unknown = parsed.unknown ?? [];
      this.lastUnknown = unknown;
    }
    if (!plan) return [`build: no build yet (usage: !build materials <${Object.values(BUILD_USAGE)[0]}|...>)`];
    if (plan.spec.kind === 'clear') return [`materials for ${plan.spec.label}: nothing (${plan.work} to dig)`];
    const m = this.materialsFor(plan);
    const lines = [materialsLine(plan.spec.label, m, plan.scaffolds)];
    // Track B1: the blocks the builder refuses, with the reason (the rest is built); on its own line past the chat's length
    if (plan.refused?.length) {
      const r = refusedLine(plan.refused);
      if (lines[0]!.length + 2 + r.length <= BILL_LINE_MAX) lines[0] = `${lines[0]!}; ${r}`;
      else lines.push(`build: ${r}`);
    }
    if (!m.ok) lines.push(...billLines(plan.spec.label, this.billFor(plan, m)));
    lines.push(...unknownLines(unknown));
    return lines;
  }

  /** Track B3: a new progress record for a build (the file, or memory only). */
  private newProgress(ctx: StartCtx, spec: BuildSpec, box: { min: Cell; max: Cell }, total: number): BuildProgress {
    const file = this.h.progressFile?.();
    const p = new BuildProgress(
      file,
      { args: ctx.args, feet: ctx.feet, label: spec.label, kind: spec.kind, ...(ctx.file ? { file: ctx.file } : {}), box, total, fetch: ctx.fetch, owner: { type: ctx.line.type, source: ctx.line.source, xuid: ctx.line.xuid } },
      { warn: (m) => this.h.log.warn(m), ...(this.h.now ? { now: () => this.h.now!() } : {}) },
    );
    this.progress = p;
    return p;
  }

  /** The targets' box of a one-plan build (its progress record's box). */
  private static boxOfSpec(spec: BuildSpec): { min: Cell; max: Cell } | undefined {
    if (spec.box) return spec.box;
    let min: Cell | undefined;
    let max: Cell | undefined;
    for (const b of spec.places) {
      min = min ? { x: Math.min(min.x, b.pos.x), y: Math.min(min.y, b.pos.y), z: Math.min(min.z, b.pos.z) } : { ...b.pos };
      max = max ? { x: Math.max(max.x, b.pos.x), y: Math.max(max.y, b.pos.y), z: Math.max(max.z, b.pos.z) } : { ...b.pos };
    }
    return min && max ? { min, max } : undefined;
  }

  private start(plan: Plan, reply: (m: string) => void, ctx?: StartCtx): void {
    if (plan.steps.length === 0) {
      reply(`build: nothing to do (${planLine(plan)})`);
      return;
    }
    // Track B3: its progress (a restart or !build resume goes on with it)
    const box = ctx ? BuildController.boxOfSpec(plan.spec) : undefined;
    let progress: BuildProgress | undefined;
    try {
      progress = ctx && box ? this.newProgress(ctx, plan.spec, box, plan.work + plan.already) : undefined;
    } catch (e) {
      this.h.log.warn(`build: no progress kept: ${e instanceof Error ? e.message : String(e)}`);
    }
    const p = new BuildProcess(this.h.runner(plan, progress ? { cellDone: (c) => progress.mark(c), scaffoldAt: (c, up) => progress.scaffold(c, up) } : undefined));
    this.proc = p;
    reply(`building ${planLine(plan)}`);
    progress?.setState('running');
    if (progress) this.watchBoxes(progress); // Track B4
    void p.result.then((end) => {
      progress?.setState(end.state === 'done' ? 'done' : this.disposed || (end.state === 'cancelled' && end.reason === 'dispose') ? 'running' : 'stopped');
      this.ended(p, end);
      if (end.state !== 'cancelled' && !this.disposed) void this.boxesAfter('after the build'); // Track B4
    });
    this.h.processes.add(p);
  }

  private ended(p: BuildProcess, end: BuildEnd): void {
    const r = p.runner;
    const s = r.stats;
    const secs = s.activeMs / 1000;
    const rate = r.rate();
    const skipped = s.skipped.length ? `; skipped: ${s.skipped.slice(0, 3).map((x) => `${x.pos.x} ${x.pos.y} ${x.pos.z} (${x.reason})`).join(', ')}${s.skipped.length > 3 ? ', ...' : ''}` : '';
    const scaff = s.scaffoldsPlaced ? `, ${s.scaffoldsPlaced} scaffold${s.scaffoldsPlaced === 1 ? '' : 's'} placed / ${s.scaffoldsRemoved} removed` : '';
    // Track B1: blocks left with states other than the build's, and the refused ones
    const wrong = s.wrong?.length ? `; ${s.wrong.length} with other states: ${s.wrong.slice(0, 3).map((w) => `${w.name} ${w.pos.x} ${w.pos.y} ${w.pos.z} (${w.diff.slice(0, 2).join(', ')})`).join(', ')}${s.wrong.length > 3 ? ', ...' : ''}` : '';
    const refused = r.plan.refused?.length ? `; ${refusedLine(r.plan.refused)}` : '';
    // Track B3: a large build's sections and fetch rounds
    const job = r instanceof BuildJob ? ` (${r.sections.length} section${r.sections.length === 1 ? '' : 's'}${r.rounds ? `, ${r.rounds} fetch round${r.rounds === 1 ? '' : 's'}` : ''})` : '';
    let line: string;
    if (end.state === 'done') line = `build ${r.plan.spec.label}: done, ${progressLine(r)} in ${secs.toFixed(0)} s${rate ? ` (${rate.toFixed(0)} blocks/min)` : ''}${job}${scaff}${skipped}${wrong}${refused}`;
    else if (end.state === 'stopped' || end.state === 'paused') line = `build ${r.plan.spec.label}: stopped at ${progressLine(r)}: ${end.state === 'stopped' ? end.reason : 'paused'}${scaff}`;
    else if (end.state === 'restock') line = `build ${r.plan.spec.label}: stopped at ${progressLine(r)}: out of ${end.items.join(', ')}${scaff}`;
    else line = `build ${r.plan.spec.label}: ${end.reason} at ${progressLine(r)}`;
    this.ends.push(line);
    this.h.log.info(line);
    this.h.log.info(`build: time ${timeLine(s.time) || 'under a second each'} (${s.walks} walks, ${s.retries} retries)`); // Track B3
    // a !stop / !build stop / replacement answers for itself; a death is said
    if (end.state !== 'cancelled' || end.reason === 'death') this.h.say(line);
  }

  stop(): string {
    const run = this.jobRun;
    if (run) run.cancelled = true; // Track B3: a large build ends (between rounds too)
    // Track B4: the box work outside a build (the pickup at the start, a recovery) ends too
    const bp = this.boxProc;
    if (bp && !bp.done) this.h.processes.stop(bp, 'stopped');
    const f = this.fetching;
    if (f) {
      f.cancelled = true;
      this.fetching = undefined;
      if (f.proc && !f.proc.done) this.h.processes.stop(f.proc, 'stopped');
      // Track B4: a box step stopped mid-way may leave its box out: picked up once it has wound down
      const box = f.box;
      if (box && !box.done) this.h.processes.stop(box, 'stopped');
      void this.boxesAfter('after the stop', () => box?.running ?? false);
      const at = stepWords_(f);
      if (run) return `stopped build ${run.job.plan.spec.label}: ${progressLine(run.job)} (in fetch round ${f.round ?? 0}, at step ${f.step}${at ? `, ${at}` : ''})`;
      return `build: fetch for ${f.label} cancelled (at step ${f.step}${at ? `, ${at}` : ''})`;
    }
    const p = this.proc;
    if (!p || p.done) {
      if (bp && !bp.done) return `build: ${bp.behaviour()} stopped`;
      return run ? `stopped build ${run.job.plan.spec.label}: ${progressLine(run.job)}` : 'build: nothing to stop';
    }
    const line = `stopped build ${p.runner.plan.spec.label}: ${progressLine(p.runner)}`;
    this.h.processes.stop(p, 'stopped');
    // Track B3: scaffold blocks out (the bot may stand on a column): taken down in a process of its own
    const out = p.runner.scaffoldsOut?.() ?? 0;
    const boxesOut = this.h.boxes?.()?.outstanding();
    const nBoxes = boxesOut ? boxesOut.standing.length + boxesOut.left.length : 0;
    if (out > 0 && p.runner.cleaner) {
      const clean = new BuildProcess(p.runner.cleaner('stopped'));
      this.proc = clean;
      this.h.processes.add(clean);
      void clean.result.then((end) => {
        this.h.log.info(`build: scaffold after the stop: ${end.state}${'reason' in end ? ` (${end.reason})` : ''}, ${p.runner.stats.scaffoldsRemoved} of ${p.runner.stats.scaffoldsPlaced} removed`);
        this.progress?.flush();
        // Track B4: then the boxes a refill left out
        if (end.state !== 'cancelled') void this.boxesAfter('after the stop', () => p.runner.busy);
      });
      return `${line}; taking ${out} scaffold block${out === 1 ? '' : 's'} down`;
    }
    // Track B4: a box a refill was using when the stop came is picked up once the runner has wound down
    void this.boxesAfter('after the stop', () => p.runner.busy);
    return nBoxes ? `${line}; picking up ${nBoxes} shulker box${nBoxes === 1 ? '' : 'es'}` : line;
  }

  /** Track B3: the bot stands on a column of the running build (paused too): Skills.perch. */
  perched(): boolean {
    const p = this.proc;
    return !!p && !p.done && (p.runner.perched?.() ?? false);
  }

  status(): string {
    const f = this.fetching;
    const run = this.jobRun;
    const of = run ? `; ${progressLine(run.job)}, ${run.job.detail()}` : '';
    if (f) return f.step ? `build: fetching materials for ${f.label}: step ${f.step}, ${stepWords_(f)} (${Math.round((this.now() - f.stepAt) / 1000)} s; ${Math.round((this.now() - f.t0) / 1000)} s in all)${of}` : `build: fetching materials for ${f.label}${of}`;
    const p = this.proc;
    if (!p || p.done) return run ? `build: ${progressLine(run.job)}, ${run.job.detail()}` : `build: idle${this.ends.length ? ` (last: ${this.ends[this.ends.length - 1]})` : ''}`;
    return p.statusText();
  }

  private fetchNow(): FetchNow {
    const ctx = this.h.bill?.();
    const slots = this.h.slots?.() ?? [];
    // Track B4: the carried boxes (the making's materials come out of them, what it made goes into them)
    const bx = this.h.boxes?.();
    const boxes = bx ? { boxed: bx.contents(), boxRoom: bx.room(), never: THROWAWAY_BLOCKS } : {};
    return { slots, ...(ctx?.recipes ? { recipes: ctx.recipes } : {}), ...(ctx?.chain ? { chain: ctx.chain } : {}), ...boxes, stack: (it: string) => this.stackOf(it) };
  }

  /** A signature of the inventory (the no-progress check). */
  private invSignature(): string {
    const by = new Map<string, number>();
    for (const s of this.h.slots?.().slice(0, 36) ?? []) if (s && s.count > 0) by.set(s.name, (by.get(s.name) ?? 0) + s.count);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(',');
  }

  /** Dispatch one fetch command and wait for the processes it starts. */
  private async runStep(line: ChatLine, command: string, f: Fetching): Promise<void> {
    const before = new Set(this.h.processes.userProcesses());
    this.fetched.push(command);
    this.h.log.info(`build: fetch for ${f.label}: step ${f.step}: !${command}`);
    this.h.dispatch(line, command);
    const t0 = this.now();
    let started = this.h.processes.userProcesses().filter((p) => !before.has(p) && FETCH_PROCESSES.has(p.name));
    while (!f.cancelled && started.length === 0 && this.now() - t0 < FETCH_START_MS) {
      await this.sleep(100);
      started = this.h.processes.userProcesses().filter((p) => !before.has(p) && FETCH_PROCESSES.has(p.name));
    }
    while (!f.cancelled && started.some((p) => !p.done) && this.now() - t0 < FETCH_STEP_MS && this.now() - f.t0 < FETCH_TIMEOUT_MS) await this.sleep(FETCH_POLL_MS);
  }

  /**
   * The fetch as a user process (FetchProcess): started at once (no tick passes without a user process between a build
   * and its fetch, so the home chore cannot unload what was brought).
   */
  private beginFetch(label: string, round?: number): Fetching {
    const f: Fetching = { label, cancelled: false, step: 0, command: '', t0: this.now(), stepAt: this.now(), ...(round ? { round } : {}) };
    this.fetching = f;
    f.proc = new FetchProcess(
      () => this.status().replace(/^build: /, 'build '),
      (reason) => {
        if (this.fetching !== f) return;
        f.cancelled = true;
        this.fetching = undefined;
        if (this.jobRun) {
          this.jobRun.cancelled = true;
          this.jobRun.reason = reason;
        }
        const l = `build: fetch for ${label} ended at step ${f.step}: ${reason}`;
        this.ends.push(l);
        this.h.log.info(l);
        if (reason === 'death') this.h.say(l);
      },
    );
    this.h.processes.add(f.proc);
    return f;
  }

  /**
   * The bill's commands one after the other (bill.ts nextFetchStep: bring, get, craft, furnace, smelt), the bill made
   * again after each, until nothing is missing. `cancelled`, the reason it stopped, or undefined (done).
   */
  private async fetchLoop(line: ChatLine, f: Fetching, billNow: () => Bill): Promise<string | undefined> {
    let bill = billNow();
    const tries = new Map<string, number>();
    let stopped: string | undefined;
    let wentHome = false;
    for (;;) {
      if (f.cancelled || this.fetching !== f) return 'cancelled';
      const next = nextFetchStep(bill, this.fetchNow());
      if (next.kind === 'done') break;
      if (next.kind === 'stuck') {
        stopped = next.why;
        break;
      }
      if (f.step >= MAX_FETCH_STEPS || this.now() - f.t0 > FETCH_TIMEOUT_MS) {
        stopped = `${f.step} commands in ${Math.round((this.now() - f.t0) / 1000)} s and still short`;
        break;
      }
      const command = stepCommand(next);
      const sig = `${command}|${this.invSignature()}`;
      if ((tries.get(sig) ?? 0) >= 1) {
        // Track B3: a step that changed nothing away from home (a craft with no free cell for its table: a round asked
        // at a column's foot inside the build) is tried once more at home (Track B4: a box with no free cell beside the bot too)
        if (!wentHome && (await this.toHome(next.kind === 'run' ? `!${command}` : command))) {
          wentHome = true;
          tries.delete(sig);
          continue;
        }
        stopped = next.kind === 'run' ? `!${command} changed nothing` : `${command}: nothing moved`;
        break;
      }
      tries.set(sig, 1);
      f.step++;
      // (a chat command is said with its prefix, a box step in words)
      f.command = next.kind === 'run' ? command : '';
      f.boxCommand = next.kind === 'run' ? undefined : command;
      f.stepAt = this.now();
      if (next.kind === 'run') await this.runStep(line, next.command, f);
      else await this.boxStep(next, f);
      if (f.cancelled || this.fetching !== f) return 'cancelled';
      bill = billNow();
    }
    this.fetching = undefined;
    return stopped;
  }

  /**
   * Track B4 (decision 0129): a fetch step with the carried boxes (bill.ts nextFetchStep `unbox` / `stow`) as a process
   * of its own (it pre-empts the fetch's process, which gets control back after it): the materials taken out, or what
   * the round made put in, each box set down off the build's cells and picked up again. A pre-emption runs it again
   * for what is left.
   */
  private async boxStep(step: Extract<FetchStep, { kind: 'unbox' | 'stow' }>, f: Fetching): Promise<void> {
    const bx = this.h.boxes?.();
    if (!bx) return;
    const command = stepCommand(step);
    this.fetched.push(command);
    this.h.log.info(`build: fetch for ${f.label}: step ${f.step}: ${command}`);
    const avoid = f.avoid ?? this.avoidNow();
    const done: Record<string, number> = {};
    const p = new BoxWorkProcess(
      step.kind === 'unbox' ? 'taking materials out of my shulker boxes' : 'putting what I made into my shulker boxes',
      async (cancelled) => {
        if (step.kind === 'unbox') {
          const rest: Record<string, number> = {};
          for (const [k, n] of Object.entries(step.want)) if (n - (done[k] ?? 0) > 0) rest[k] = n - (done[k] ?? 0);
          if (Object.keys(rest).length === 0) return 'nothing left to take';
          const r = await bx.take(rest, { cancelled, ...(avoid ? { avoid } : {}) });
          for (const [k, n] of Object.entries(r.taken)) done[k] = (done[k] ?? 0) + n;
          f.taken = (f.taken ?? 0) + Object.values(r.taken).reduce((a, b) => a + b, 0);
          return `took ${itemsText(r.taken) || 'nothing'} out of ${r.boxes} box${r.boxes === 1 ? '' : 'es'}${r.reason ? ` (${r.reason})` : ''}`;
        }
        const r = await bx.stow(step.keep, { cancelled, ...(avoid ? { avoid } : {}) });
        f.stowed = (f.stowed ?? 0) + Object.values(r.stowed).reduce((a, b) => a + b, 0);
        return `put ${itemsText(r.stowed) || 'nothing'} into ${r.boxes} box${r.boxes === 1 ? '' : 'es'}${r.reason ? ` (${r.reason})` : ''}`;
      },
      () => this.h.cancel?.(),
    );
    f.box = p;
    f.boxSteps = (f.boxSteps ?? 0) + 1;
    this.h.processes.add(p);
    const line = await p.result;
    if (f.box === p) delete f.box;
    this.h.log.info(`build: fetch for ${f.label}: ${line}`);
  }

  /** Track B4: the cells no box goes on now: the running job's build and its section's stands, else the last plan's cells. */
  private avoidNow(): ((c: Cell) => boolean) | undefined {
    const run = this.jobRun;
    if (run) return (c) => run.job.noBox(c);
    const plan = this.last;
    if (!plan) return undefined;
    const cells = new Set<string>();
    const k = (c: Cell) => `${c.x},${c.y},${c.z}`;
    for (const s of plan.steps) {
      if ('pos' in s) cells.add(k(s.pos));
      else for (let y = 0; y <= s.height; y++) cells.add(k({ ...s.base, y: s.base.y + y }));
      if ('stand' in s && s.stand) cells.add(k(s.stand));
    }
    for (const b of plan.spec.places) cells.add(k(b.pos));
    const box = plan.spec.kind === 'clear' || plan.spec.kind === 'replace' ? plan.spec.box : undefined;
    return (c) => cells.has(k(c)) || (!!box && c.x >= box.min.x && c.x <= box.max.x && c.y >= box.min.y && c.y <= box.max.y && c.z >= box.min.z && c.z <= box.max.z);
  }

  /** Track B4: the box work outside a fetch (the pickup at the start, the recovery after a stop) and its process. */
  private boxProc: BoxWorkProcess | undefined;
  /** Track B4: bumped by a resume: a recovery still waiting for the stopped work to wind down gives way. */
  private boxGen = 0;

  /**
   * Track B4: `!build ... fetch` first picks up the shulker boxes lying within HANDED_RADIUS (the owner dropped them for
   * the build) and says how many it took. False when it was stopped (the build does not start).
   */
  private async pickUpHanded(reply: (m: string) => void): Promise<boolean> {
    const bx = this.h.boxes?.();
    if (!bx) return true;
    let got = 0;
    const p = new BoxWorkProcess(
      'picking up the shulker boxes handed over',
      async (cancelled) => {
        got += await bx.pickUp(HANDED_RADIUS, cancelled);
        return `${got}`;
      },
      () => this.h.cancel?.(),
    );
    this.boxProc = p;
    this.h.processes.add(p);
    const end = await p.result;
    if (this.boxProc === p) this.boxProc = undefined;
    if (got > 0) reply(`build: picked up ${got} shulker box${got === 1 ? '' : 'es'} lying near me (${bx.carried()} carried now)`);
    this.h.log.info(`build: handed-over boxes: ${got} picked up (${end})`);
    return !end.startsWith('cancelled');
  }

  /**
   * Track B4: the boxes a stop, a cancelled fetch or a build's end left in the world (`outstanding`), picked up in a
   * process of their own once `busy` (the work being stopped winding down) is over.
   */
  private async boxesAfter(why: string, busy: () => boolean = () => false): Promise<void> {
    const bx = this.h.boxes?.();
    if (!bx) return;
    const gen = this.boxGen;
    for (let i = 0; i < 600 && busy(); i++) await this.sleep(50);
    if (gen !== this.boxGen) return; // a resume came meanwhile: its job picks them up first
    const out = bx.outstanding();
    const n = out.standing.length + out.left.length;
    if (n === 0) return;
    this.h.log.info(`build: ${n} shulker box${n === 1 ? '' : 'es'} left out ${why}: picking ${n === 1 ? 'it' : 'them'} up`);
    const p = new BoxWorkProcess(
      'picking up my shulker boxes',
      async (cancelled) => {
        await this.recoverBoxes(bx, cancelled);
        const o = bx.outstanding();
        return `${o.standing.length + o.left.length} left`;
      },
      () => this.h.cancel?.(),
    );
    this.boxProc = p;
    this.h.processes.add(p);
    const end = await p.result;
    if (this.boxProc === p) this.boxProc = undefined;
    this.h.log.info(`build: shulker boxes ${why}: ${end}`);
  }

  /** Track B4: every box out walked near (the nearest first) and recovered, a few passes. */
  private async recoverBoxes(bx: BuildBoxes, cancelled: () => boolean): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      const o = bx.outstanding();
      const cells = [...o.standing, ...o.left];
      if (cells.length === 0 || cancelled()) return;
      const me = this.h.position();
      const near = me ? cells.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0]! : cells[0]!;
      if (me && Math.hypot(near.x - me.x, near.y - me.y, near.z - me.z) > BOX_NEAR && this.h.approach) await this.h.approach(near);
      if (cancelled()) return;
      await bx.recover(cancelled);
    }
  }

  /**
   * Track B4: while a build has a progress record, the boxes out are kept in it (saved before a box's place request
   * goes); the watcher stays until the boxes are back after the build.
   */
  private watchBoxes(progress: BuildProgress): void {
    const bx = this.h.boxes?.();
    if (!bx) return;
    const fn = (): void => {
      if (this.progress !== progress) return;
      progress.setBoxes(bx.outstanding());
    };
    bx.watch(fn);
    fn();
  }

  /** Track B3: walk to home when it is set and farther than HOME_NEAR (true when the bot got there). */
  private async toHome(why: string): Promise<boolean> {
    const h = this.h.home?.();
    const p = this.h.position();
    if (!h || !p || !this.h.approach || Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z) <= HOME_NEAR) return false;
    this.h.log.info(`build: ${why} changed nothing here: trying it at home`);
    return this.h.approach(h);
  }

  /**
   * Track B2 `fetch`: the bill's commands (fetchLoop), then plan and start the build.
   */
  private async fetchThenBuild(line: ChatLine, plan0: Plan, m0: Materials, reply: (msg: string) => void, ctx?: StartCtx): Promise<void> {
    const spec = plan0.spec;
    const bill = this.billFor(plan0, m0);
    if (bill.cannot.length) {
      // nothing is fetched: what nothing makes, then the materials line
      for (const l of packLines(['build: nothing fetched: cannot get', ...stepWords([bill.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')])])) reply(l);
      reply(materialsLine(spec.label, m0));
      return;
    }
    const f = this.beginFetch(spec.label);
    for (const l of packLines([`build ${spec.label}: fetching first:`, ...stepWords(billSteps(bill))])) reply(l);
    let first = true;
    const stopped = await this.fetchLoop(line, f, () => {
      if (first) {
        first = false;
        return bill;
      }
      return this.billFor(plan0);
    });
    if (stopped === 'cancelled') return;
    f.proc!.end();
    if (stopped) {
      reply(`build: fetch for ${spec.label} stopped after ${f.step} command${f.step === 1 ? '' : 's'}: ${stopped}`);
      return;
    }
    const plan = await this.plan(spec, reply);
    if (!plan) return;
    const again = this.materialsFor(plan);
    if (!again.ok) return reply(`build: still short after fetching: ${materialsLine(spec.label, again, plan.scaffolds)}`);
    this.h.log.info(`build: fetch for ${spec.label} done in ${f.step} commands, ${Math.round((this.now() - f.t0) / 1000)} s: ${this.fetched.slice(-f.step).join(' | ')}`);
    this.start(plan, reply, ctx);
  }

  // ---- Track B3 (ADR 0128): large builds, fetch rounds, resume

  /** The scaffold tool (SCAFFOLD_PICK) only when the bill can make or get it; else the build goes on digging by hand (said once a job). */
  private toolGettable(): boolean {
    const bill = this.billFor({ materials: { [SCAFFOLD_PICK]: 1 }, scaffoldPeak: 0 });
    if (bill.cannot.length === 0) return true;
    const run = this.jobRun;
    if (run && !run.toolSaid) {
      run.toolSaid = true;
      this.h.log.info(`build: no tool for the scaffold blocks and ${SCAFFOLD_PICK} cannot be got (${bill.cannot.map((c) => `${c.n} ${c.item}: ${c.why}`).join(', ')}): digging them by hand`);
    }
    return false;
  }

  /** The deps a job is built with. */
  private jobDeps(ctx: StartCtx): JobDeps {
    const r = () => ({ throwawayMin: this.h.throwawayMin() });
    return {
      world: this.h.world,
      position: () => this.h.position(),
      plan: (spec, o) => (this.h.planSection ? this.h.planSection(spec, o) : planBuildAsync(this.h.world, spec, o)),
      runner: (plan, hooks) => this.h.runner(plan, hooks),
      options: this.planOptions(),
      ...(ctx.fetch ? { canFetch: (items: readonly string[]) => (this.jobRun?.job.rounds ?? 0) < MAX_ROUNDS && (!items.includes(SCAFFOLD_PICK) || this.toolGettable()) } : {}),
      have: (item) => usable(this.h.inventory, item, r()) + (this.h.boxed?.(item) ?? 0),
      scaffoldHave: () => Math.max(0, THROWAWAY_BLOCKS.reduce((a, k) => a + this.h.inventory.count(k) + (this.h.boxed?.(k) ?? 0), 0) - this.h.throwawayMin()),
      ...(this.h.approach ? { approach: (c: Cell) => this.h.approach!(c) } : {}),
      // Track B4: the boxes a stop, a death or a restart left out, picked up before anything is built
      ...(this.h.boxes ? { boxesFirst: (cancelled: () => boolean) => this.boxesFirst(cancelled) } : {}),
      ...(this.h.cancel ? { cancel: () => this.h.cancel!() } : {}),
      log: this.h.log,
    };
  }

  /** Track B4: JobDeps.boxesFirst: the boxes out walked to and picked up (said once when there were any). */
  private async boxesFirst(cancelled: () => boolean): Promise<void> {
    const bx = this.h.boxes?.();
    if (!bx) return;
    const o = bx.outstanding();
    const n = o.standing.length + o.left.length;
    if (n === 0) return;
    this.h.log.info(`build: ${n} shulker box${n === 1 ? '' : 'es'} left out before (${[...o.standing, ...o.left].map((c) => `${c.x} ${c.y} ${c.z}`).join(', ')}): picking ${n === 1 ? 'it' : 'them'} up first`);
    await this.recoverBoxes(bx, cancelled);
    const after = bx.outstanding();
    const left = after.standing.length + after.left.length;
    this.h.log.info(`build: boxes left out before: ${n - left} of ${n} picked up`);
  }

  /**
   * A job: a large build, or one fetched in rounds, or a resumed one. Its whole bill first (with `fetch`: what cannot be
   * got refuses it before any command; without: what is missing refuses it, as for a small build), then it runs.
   */
  private startJob(ctx: StartCtx, spec: BuildSpec, reply: (m: string) => void, resumed?: { survey: Survey; left: Cell[]; leftovers: Cell[]; progress: BuildProgress }): void {
    const start = this.h.position();
    if (!start) return reply('build: my position is unknown');
    let job: BuildJob;
    const deps = this.jobDeps(ctx);
    try {
      job = new BuildJob(spec, start, resumed ? { ...deps, progress: resumed.progress } : deps, resumed ? { survey: resumed.survey, left: resumed.left, leftovers: resumed.leftovers } : {});
    } catch (e) {
      return reply(`build: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.last = job.plan;
    const label = spec.label;
    // the whole build's bill: the scaffold blocks of a tall section's worth at most at once (none for a build no taller
    // than the ground's reach; each section's plan asks for more at its start)
    const whole = { materials: job.plan.materials, scaffoldPeak: job.box.max.y - job.box.min.y + 1 > JOB_LOW ? JOB_SCAFFOLDS : 0 };
    const m = this.materialsFor(whole);
    if (!m.ok) {
      if (!ctx.fetch) {
        reply(`build: ${materialsLine(label, m).replace(/^materials for /, '')} (add fetch to get, craft and smelt them as it goes)`.slice(0, BILL_LINE_MAX));
        for (const l of billLines(label, this.billFor(whole, m))) reply(l);
        return;
      }
      const bill = this.billFor(whole, m);
      if (bill.cannot.length) {
        for (const l of packLines(['build: nothing fetched: cannot get', ...stepWords([bill.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')])])) reply(l);
        reply(materialsLine(label, m).slice(0, BILL_LINE_MAX));
        return;
      }
    }
    let progress = resumed?.progress;
    try {
      progress ??= this.newProgress(ctx, spec, job.box, job.plan.work);
    } catch (e) {
      return reply(`build: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resumed) {
      // a progress record made after the job: its marks go through the job's hook from now
      deps.progress = progress;
    }
    const refused = job.plan.refused?.length ? `, ${refusedLine(job.plan.refused)}` : '';
    const verb = spec.kind === 'clear' ? 'to dig' : spec.kind === 'replace' ? 'to replace' : 'to place';
    if (!resumed) reply(`building ${label}: ${job.plan.work} ${verb} in ${job.sections.length} section${job.sections.length === 1 ? '' : 's'}${refused}${!m.ok ? '; fetching in rounds as it goes' : ''}`);
    this.h.log.info(`build: job ${label}: ${job.sections.length} sections (${job.sections.map((s) => s.cells).join(', ')} cells)${resumed ? `, resumed at ${resumed.survey.done} done` : ''}`);
    void this.runJob(ctx, job, progress).catch((e: unknown) => this.h.log.warn(`build: job ${label}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The job's processes, one after another, and a fetch round between them when it asks for one. */
  private async runJob(ctx: StartCtx, job: BuildJob, progress: BuildProgress): Promise<void> {
    const run: JobRun = { job, ctx, progress, cancelled: false };
    this.jobRun = run;
    progress.setState('running');
    this.watchBoxes(progress); // Track B4
    let end: BuildEnd;
    let p: BuildProcess | undefined;
    try {
      for (;;) {
        p = new BuildProcess(job);
        this.proc = p;
        this.h.processes.add(p);
        end = await p.result;
        if (end.state !== 'restock') break;
        if (run.cancelled) {
          end = { state: 'cancelled', reason: run.reason ?? 'stopped' };
          break;
        }
        // a fetch round: started before any await (FetchProcess replaces the build process at once)
        const n = job.rounds + 1;
        const f = this.beginFetch(`${job.plan.spec.label} (round ${n})`, n);
        f.avoid = (c) => job.noBox(c); // Track B4
        // Track B4: what a round brings fits in the free slots and the carried boxes' room (what it made goes there)
        const boxRoom = this.h.boxes?.()?.room() ?? 0;
        const need = job.roundNeed(this.freeSlots(Object.keys(job.plan.materials)) + boxRoom, (it) => this.stackOf(it));
        this.h.log.info(`build: fetch round ${n} for ${job.plan.spec.label} (out of ${end.items.join(', ')}): ${Object.entries(need.materials).map(([k, v]) => `${v} ${k}`).join(', ')}, scaffolds ${need.scaffoldPeak}${boxRoom ? ` (with ${boxRoom} free slots in my boxes)` : ''}`);
        const stopped = await this.fetchLoop(ctx.line, f, () => this.billFor(need));
        if (stopped === 'cancelled' || run.cancelled) {
          end = { state: 'cancelled', reason: run.reason ?? 'stopped' };
          break;
        }
        f.proc!.end();
        if (stopped) {
          const why = `fetch round ${n}: ${stopped}`;
          this.h.say(`build ${job.plan.spec.label}: ${why}`);
          end = { state: 'stopped', reason: why };
          // the scaffold blocks of the section down again, in a process of its own
          const clean = new BuildProcess(job.cleaner(why));
          this.proc = clean;
          this.h.processes.add(clean);
          await clean.result;
          break;
        }
        const boxed = f.boxSteps ? ` (${f.boxSteps} with my boxes: ${f.taken ?? 0} taken out, ${f.stowed ?? 0} put in)` : '';
        this.h.log.info(`build: fetch round ${n} for ${job.plan.spec.label} done in ${f.step} commands, ${Math.round((this.now() - f.t0) / 1000)} s${boxed}`);
        job.roundDone();
      }
    } finally {
      if (this.jobRun === run) this.jobRun = undefined;
    }
    // Track B4: a box the build left out (a stop: !build stop picks it up itself) is picked up after it
    if (end.state !== 'cancelled' && !this.disposed) void this.boxesAfter('after the build');
    // the task stopping (a restart) leaves it `running` whatever the process was stopped with (the task's other parts
    // stop their processes in their own order, before or after the manager's dispose)
    progress.setState(end.state === 'done' ? 'done' : this.disposed || run.reason === 'dispose' || (end.state === 'cancelled' && end.reason === 'dispose') ? 'running' : 'stopped');
    if (p) this.ended(p, end);
  }

  /** Track B3: the progress kept in memory (no file: --no-config), the last build's. */
  private progress: BuildProgress | undefined;

  /** `!build resume`: the last build goes on where it stopped (its cells checked against the world first). */
  resume(line: ChatLine | undefined, reply: (m: string) => void): void {
    if (this.fetching || this.jobRun || (this.proc && !this.proc.done)) return reply('build: a build is running (!build stop ends it)');
    // Track B4: a recovery of boxes after a stop gives way (running or still waiting): the resumed job picks them up first (boxesFirst)
    this.boxGen++;
    if (this.boxProc && !this.boxProc.done) this.h.processes.stop(this.boxProc, 'stopped');
    const file = this.h.progressFile?.();
    const d = file ? loadProgress(file, (m) => this.h.log.warn(m)) : this.progress?.data;
    if (!d) return reply('build: nothing to resume');
    if (d.state === 'done') return reply(`build: ${d.label} is done (nothing to resume)`);
    let loaded: (Structure & { file?: string }) | undefined;
    const parsed = parseSpec(d.args, {
      feet: d.feet,
      load: (n) => {
        loaded = this.h.load(n);
        return loaded;
      },
    });
    if (!parsed.ok) return reply(`build: cannot resume ${d.label}: ${parsed.error}`);
    if (d.file && loaded && structureHash(loaded) !== d.file.sha256) return reply(`build: cannot resume ${d.label}: ${d.file.name} changed since it started`);
    const by = line ?? lineOf(d.owner);
    if (!by) return reply(`build: cannot resume ${d.label}: no owner to run it as`);
    let progress: BuildProgress;
    try {
      progress = file ? new BuildProgress(file, d, { warn: (m) => this.h.log.warn(m), ...(this.h.now ? { now: () => this.h.now!() } : {}) }) : this.progress!;
    } catch (e) {
      return reply(`build: cannot resume ${d.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.progress = progress;
    // Track B4: the boxes the run before left out are the Supply's to pick up (first: JobDeps.boxesFirst), then watched
    const bx = this.h.boxes?.();
    const boxCells = progress.boxCells();
    const nBoxes = boxCells.standing.length + boxCells.left.length;
    if (bx && nBoxes) bx.adopt(boxCells);
    this.watchBoxes(progress);
    const { survey, left, leftovers } = BuildJob.survey(parsed.spec, this.h.world, progress);
    const changed = survey.air + survey.other;
    const ex = survey.examples.map((e) => `${e.pos.x} ${e.pos.y} ${e.pos.z} ${e.name}`).join(', ');
    const verb = parsed.spec.kind === 'clear' ? 'dug' : parsed.spec.kind === 'replace' ? 'replaced' : 'placed';
    const what = changed ? `; ${changed} changed since${survey.air ? `, ${survey.air} air again (${parsed.spec.kind === 'clear' ? 'left' : `${verb} again`})` : ''}${survey.other ? `, ${survey.other} another block (left)` : ''}: ${ex}` : '';
    const scaff = survey.leftovers ? `; ${survey.leftovers} scaffold block${survey.leftovers === 1 ? '' : 's'} left from before (dug first)` : '';
    const boxes = bx && nBoxes ? `; ${nBoxes} shulker box${nBoxes === 1 ? '' : 'es'} left out (picked up first)` : '';
    reply(`resuming build ${d.label}: ${survey.done} of ${d.total} done${what}${scaff}${boxes}`.slice(0, BILL_LINE_MAX));
    this.lastUnknown = parsed.unknown ?? [];
    const ctx: StartCtx = { line: by, args: [...d.args], feet: d.feet, fetch: d.fetch, ...(d.file ? { file: d.file } : {}) };
    return this.startJob(ctx, parsed.spec, reply, { survey, left, leftovers, progress });
  }

  /** Track B3: a build that was running when the bot went away (the file says `running`): resumed, said in the chat. */
  autoResume(): void {
    if (this.fetching || this.jobRun || (this.proc && !this.proc.done)) return;
    const file = this.h.progressFile?.();
    const d = loadProgress(file, (m) => this.h.log.warn(m));
    if (d?.state !== 'running') return;
    // not across the world unattended (a respawn at the world spawn, a server that kept no position): !build resume walks
    const at = this.h.position();
    const far = at ? Math.max(0, d.box.min.x - at.x, at.x - d.box.max.x, d.box.min.z - at.z, at.z - d.box.max.z) : Infinity;
    if (far > AUTO_RESUME_NEAR) {
      const why = `build: ${d.label} was running when I went away, but it is ${Number.isFinite(far) ? `${Math.round(far)} blocks` : 'too far'} away: !build resume goes on`;
      this.h.log.info(why);
      this.h.say(why);
      return;
    }
    this.h.log.info(`build: ${d.label} was running when I went away: resuming it`);
    try {
      this.resume(undefined, (m) => this.h.say(m));
    } catch (e) {
      this.h.log.warn(`build: resume: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Track B3: the task stopped (a restart or a quit): what runs now ends `running` in the progress. */
  private disposed = false;

  dispose(): void {
    this.disposed = true;
    if (this.fetching) this.fetching.cancelled = true;
    // Track B3: a build running when the task stops (a restart) stays `running`: it goes on when the bot is back
    if (this.jobRun) this.jobRun.reason = 'dispose';
    this.progress?.flush();
  }
}

/** Every controller by task (tests). */
const controllers = new WeakMap<object, BuildController>();

export function buildControllerOf(task: object): BuildController | undefined {
  return controllers.get(task);
}

export interface BuildExtra {
  /** CLI / test values (`builds` folder, `no-config`, `config`). */
  values?: Readonly<Record<string, unknown>>;
  logger?: Logger;
}

/** Track B2: what the home chests hold by item (loose and in shulker boxes), from the chest memory. */
export function homeCounts(task: object): Map<string, number> {
  const out = new Map<string, number>();
  const records = homeControlOf(task)?.logistics.records() ?? [];
  for (const r of sourceRecords(records)) {
    for (const [k, v] of Object.entries(r.contents)) out.set(k, (out.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(r.inBoxes ?? {})) out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}

/**
 * Register `!build` on the afk task (tasks/registry.ts, one line). Without walking it answers
 * `build needs a task that can walk`.
 */
export function registerBuildCommands(d: CommandDeps, extra: BuildExtra = {}): BuildController | undefined {
  const { processes, mobility: mob, skills } = d;
  if (!processes || !mob || !skills) {
    d.chat.register({ name: 'build', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('build')) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const world = mob.world;
  const mover = settingsMover(skills, d.settings);
  const dirs = buildDirs(extra.values ?? {});
  const runnerDeps: RunnerDeps = {
    blockAt: (p) => world.blockAt(p),
    position: () => mob.position(),
    onGround: () => mob.loop.state.onGround,
    goto: (g, o) => mover.goto(g, o),
    place: (p, o) => skills.place(p, o),
    dig: (p) => skills.dig(p),
    collect: (r, t) => skills.collect(r, t),
    waitTicks: (n) => mob.loop.waitTicks(n),
    inventory: world.inventory,
    reserve: () => ({ throwawayMin: d.settings.get('throwawayMin') }),
    cancel: () => skills.cancel(),
    get supply() {
      return supplyOf(d.task); // Track BJ: registered by commands-home (Track B4: with takeMany, stowMany, contents, freeSlots)
    },
    tap: (p, view) => skills.tapBlock(p, view), // Track B1
    placeMany: (cells, o) => skills.placeMany(cells, o), // Track B3
    burst: () => d.settings.get('buildBurst'),
    // Track B3: a tool the kit keeps from wearing out (a few uses left) does not count, as for the digger
    harvests: (block) => canHarvestWith(usableSlots(world.inventory.slots, survivalKitOf(d.task)?.toolOk ?? (() => true)), block),
    log,
  };
  // Track B3: a large build's sections planned in a worker on a snapshot of their area (the main thread on a failure)
  const reader: BlockReader = { blockAt: (p) => world.blockAt(p) };
  const shapeOf = (name: string, states: Readonly<Record<string, unknown>> | undefined): readonly (readonly number[])[] | undefined => {
    // Track B1: the registry's boxes for a planned block (a slab's top half, a stair), undefined when unknown
    try {
      const id = world.registry.stateIdOf(name, states);
      return id === undefined ? undefined : world.registry.blockInfo(id).boxes;
    } catch {
      return undefined;
    }
  };
  let planner: BuildPlannerClient | undefined;
  const planSection = async (spec: BuildSpec, o: PlanOptions): Promise<Plan> => {
    const area = o.area;
    const box = area ? snapshotBox(area) : undefined;
    if (!area || !box || box.size.x * box.size.y * box.size.z > SNAP_MAX) return planBuildAsync(reader, spec, o);
    const shapes = new Map<string, readonly (readonly number[])[] | undefined>();
    const byKey = new Map(spec.places.map((b) => [`${b.pos.x},${b.pos.y},${b.pos.z}`, b] as const));
    for (const r of resolveBlocks(spec.places).cells) {
      shapes.set(shapeKey(r.placement.name, r.block.states), shapeOf(r.placement.name, r.block.states));
      for (const e of r.placement.extra) {
        const b2 = byKey.get(`${r.block.pos.x + e.offset.x},${r.block.pos.y + e.offset.y},${r.block.pos.z + e.offset.z}`);
        shapes.set(shapeKey(e.name, b2?.states), shapeOf(e.name, b2?.states));
      }
    }
    const skipKeys: string[] = [];
    if (o.skip && spec.box) {
      const b = spec.box;
      for (let y = b.min.y; y <= b.max.y; y++) for (let x = b.min.x; x <= b.max.x; x++) for (let z = b.min.z; z <= b.max.z; z++) if (o.skip({ x, y, z })) skipKeys.push(`${x},${y},${z}`);
    }
    const { shapeOf: _shapes, skip: _skip, ...wire } = o;
    try {
      const snap = snapshotWorld(reader, box);
      planner ??= new BuildPlannerClient({ log });
      return await planner.plan(spec, { ...wire, ...(skipKeys.length ? { skipKeys } : {}) }, snap, [...shapes]);
    } catch (e) {
      log.warn(`build: plan worker: ${e instanceof Error ? e.message : String(e)}; planning on the main thread`);
      return planBuildAsync(reader, spec, o);
    }
  };
  // a runner with a large build's hooks (the supply looked up when it is used, as in runnerDeps)
  const withHooks = (hooks: RunnerHooks): RunnerDeps => {
    const o: RunnerDeps = { ...runnerDeps, ...hooks };
    Object.defineProperty(o, 'supply', { get: () => runnerDeps.supply, enumerable: true });
    return o;
  };
  const progressFile = buildProgressFile(extra.values);
  const c = new BuildController({
    world: { blockAt: (p) => world.blockAt(p) },
    position: () => mob.position(),
    inventory: world.inventory,
    slots: () => world.inventory.slots, // Track B2
    boxed: (name) => supplyOf(d.task)?.carried(name) ?? 0, // Track BJ
    // Track B2: the crafter, the smelter and the home logistics register after !build (tasks/registry.ts): looked up per call
    bill: () => {
      const craft = craftControlOf(d.task);
      return {
        ...(craft ? { recipes: craft.recipes, chain: craft.chainOptions() } : {}),
        furnaceNear: () => (smeltControlOf(d.task)?.furnaces().length ?? 0) > 0 || furnacesCarried(world.inventory.slots) > 0,
        home: () => homeCounts(d.task),
      };
    },
    files: () => listStructures(dirs),
    throwawayMin: () => d.settings.get('throwawayMin'),
    scaffold: () => d.settings.get('buildScaffold'),
    shapeOf,
    processes,
    runner: (plan, hooks) => new BuildRunner(plan, hooks ? withHooks(hooks) : runnerDeps),
    dispatch: (line, command) => d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` }),
    load: (name) => loadStructure(name, dirs),
    say: (m) => d.chat.say(m),
    log,
    // Track B3
    planSection,
    columnMax: () => d.settings.get('buildColumnMax'),
    approach: async (p) => (await mover.goto({ type: 'near', p, r: 4 }, { timeoutTicks: 6000, allowBreak: false, allowPlace: false })).ok,
    progressFile: () => progressFile,
    home: () => {
      const h = d.task.home?.get();
      return h ? { x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) } : undefined;
    },
    // Track B4 (decision 0129): the carried boxes as the build's source and store (the Supply: registered by commands-home)
    boxes: () => {
      const s = supplyOf(d.task);
      if (!s) return undefined;
      const carried = () => world.inventory.slots.slice(0, 36).filter((x) => !!x && x.count > 0 && isShulkerBox(x.name)).length;
      return {
        contents: () => s.contents(),
        room: () => s.boxRoom(),
        carried,
        take: (w, o) => s.takeMany(w, o),
        stow: (k, o) => s.stowMany(k, o),
        outstanding: () => s.outstanding(),
        recover: (c) => s.recover(c),
        watch: (fn) => s.watch(fn),
        adopt: (cells) => s.adopt(cells),
        pickUp: async (r, cancelled) => {
          const before = carried();
          if (cancelled()) return 0;
          await skills.collect(r, 400, { filter: (i) => isShulkerBox(i.name) });
          return Math.max(0, carried() - before);
        },
      };
    },
    cancel: () => skills.cancel(),
  });
  controllers.set(d.task, c);
  skills.perch = () => c.perched(); // Track B3: on a build's column the guard strikes without a step (decision 0051's rule)
  // Track B3: a build that was running when the bot went away goes on once it is back (buildResume), once a session:
  // RESUME_DELAY_MS after the spawn, alive, and with no command of its own running (a `!chests scan`, a `!goto`: after it);
  // with buildResume off it waits for the setting (turned on later in the session, the build goes on then)
  let resumeTried = false;
  let spawnAt = 0;
  const offSpawn = d.conn.onSpawn(() => {
    resumeTried = false;
    spawnAt = Date.now();
  });
  const resumeTimer = setInterval(() => {
    if (resumeTried || d.conn.state !== 'spawned' || !mob.loop.state.ready || d.task.alive?.() === false || !mob.position()) return;
    spawnAt ||= Date.now();
    if (Date.now() - spawnAt < RESUME_DELAY_MS || processes.userProcesses().length > 0) return;
    if (!d.settings.get('buildResume')) return; // turned on later in the session: it goes on then
    resumeTried = true;
    c.autoResume();
  }, 1000);
  resumeTimer.unref?.();
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    clearInterval(resumeTimer);
    offSpawn();
    c.dispose();
    void planner?.stop();
    stop();
  };
  d.chat.register({
    name: 'build',
    tier: 'front', group: 'work', example: '!build wall 100 64 -54 109 -54 4 cobblestone', // Track AM tiers (merge)
    help: BUILD_HELP,
    run: ({ line, args, reply }) => {
      void c.run(line, args, reply).catch((e: unknown) => {
        reply(`build: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
  });
  log.info(`build: !build ready (structure folders: ${dirs.join(', ')})`);
  return c;
}

export { etaText };
