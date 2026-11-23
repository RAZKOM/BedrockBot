// `!build` (wave 9, Track AL; docs/build.md), owner-only like every command: the builder.
//
//   !build fill x1 y1 z1 x2 y2 z2 <block> [fetch]       building fill 5x3x5 cobblestone: 75 to place, ...
//   !build clear x1 y1 z1 x2 y2 z2                      building clear 5x3x5: 75 to dig
//   !build replace x1 y1 z1 x2 y2 z2 <from> <to> [fetch]
//   !build wall x1 y z1 x2 z2 <height> <block> [fetch] | floor x1 y z1 x2 z2 <block> [fetch] | pillar x y z <height> <block> [fetch]
//   !build file <name> [x y z] [0|90|180|270] [skip unknown] [fetch [skip missing]]
//   !build file <name> map [x z | x y z] [skip unknown] [fetch [skip missing]]   Track B7: a map art on the map grid (skills/build/mapart.ts)
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
// Track B6 (ADR 0131): a fetch build runs by itself: a trip farther than flyMin (home for a step done there, back to the
// build) goes the way `!goto` goes (flown when autoFly and the kit allow) and lands off the build; a hold process keeps
// the home chores out from the command to the end, and a take's room never unloads what the build needs; what cannot be
// got reads the home chests again once; a full inventory stows what waits into the carried boxes (never into a box the
// build places) and says so when nothing makes room; `fetch skip missing` builds without what cannot be got.
import type { ChatLine } from './text.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BoxWorkProcess, BuildHoldProcess, BuildProcess, setBuildKeeps, type BuildEnd } from '../tasks/process/build.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from '../tasks/process/manager.ts';
import { BILL_LINE_MAX, billLines, billNeeds, billOf, billSteps, cannotText, freeSlotsOf, inventoryFullWhy, nextFetchStep, packLines, stepWords, type Bill, type FetchNow, type FetchStep } from '../skills/build/bill.ts';
import { withoutMissing } from '../skills/build/skip.ts'; // Track B6
import { buildDirs, bytesText, listStructures, loadStructure, type Structure, type StructureFile, type UnknownBlock } from '../skills/build/formats/index.ts';
import { BuildJob, buildCells, sectionsOf, type JobDeps, type Survey } from '../skills/build/job.ts';
import { materialsLine, materialsOf, usable, type Materials } from '../skills/build/materials.ts';
import { planBuildAsync, planLine, PlanError, refusedLine, type Plan, type PlanOptions } from '../skills/build/plan.ts';
import { cannotLine, fitEntries, fitLines, FULL_BYTES, FULL_MAX_LINES, materialsFullDense, materialsSummary, MORE, pageLines, REPLY_LINES, stepsLine, totalsLine, wrapAll } from '../skills/build/reply.ts'; // Track B5
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
import { groundTop } from '../skills/build/mapart.ts'; // Track B7
import { worldSource } from '../skills/terrain/query.ts'; // Track B7

export const BUILD_HELP = 'fill|clear|replace|wall|floor|pillar|file ... [fetch [skip missing]]; materials, files, status, stop, resume, more [page] (builds walls, floors, boxes, saved structures)';
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
  /**
   * Track B3: walk near a cell (back to the build after a fetch round). Track B6 (decision 0131): a trip farther than
   * `flyMin` goes the way `!goto` goes (flown when autoFly, the kit and the distance allow), aimed at `land` when given
   * (off the build), then walked near the cell; `why` names the trip in the log.
   */
  approach?(c: Cell, o?: { land?: Cell; why?: string }): Promise<boolean>;
  /** Track B6: the `flyMin` setting (a trip farther than this may fly; default: no trip flies). */
  flyMin?(): number;
  /**
   * Track B6: read the home chests again (forced, the "fresh" ones too) when they are in reach: what the bill says
   * cannot be got may be in a chest the memory read before it changed. The scan's line, or undefined (not in reach).
   */
  rescan?(): Promise<string | undefined>;
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
  /** Track B7: a column's ground top (`!build file <name> map` without a y; skills/build/mapart.ts groundTop). */
  groundTop?(x: number, z: number): number | undefined;
}

/** Track B4 (decision 0129): what a build does with the carried shulker boxes (skills/supply/supply.ts). */
export interface BuildBoxes {
  /** Everything the usable carried boxes hold, by item. */
  contents(): Map<string, number>;
  /** Free slots in the usable carried boxes (Track B6: not counting an empty box `notInto` names: a build block itself). */
  room(notInto?: (name: string) => boolean): number;
  /** Shulker boxes in the inventory (any). */
  carried(): number;
  take(want: Record<string, number>, o: { cancelled: () => boolean; avoid?: (c: Cell) => boolean }): Promise<{ taken: Record<string, number>; boxes: number; reason?: string }>;
  stow(keep: Record<string, number>, o: { cancelled: () => boolean; avoid?: (c: Cell) => boolean; notInto?: (name: string) => boolean }): Promise<{ stowed: Record<string, number>; boxes: number; reason?: string }>;
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
  /** Track B6: `skip missing`: what the bill cannot get is left out (refused) and the rest built. */
  skipMissing?: boolean;
}

/** Track B6: a trip back to the build aims this many blocks outside its box (the flight lands off the build). */
export const LAND_MARGIN = 4;

/**
 * Track B6 (decision 0131): where a trip to `goal` aims its flight when the goal is at the build (within LAND_MARGIN + 8
 * of its box, sideways): the cell LAND_MARGIN outside the box nearest the bot (`from`), at the height of the ground
 * there when it is loaded (a solid block with two free cells over it, looked for from the box's top + 2 down to its
 * bottom - 6), else the box's bottom. Undefined for a goal away from the build (home): the goal itself.
 */
export function landOff(box: { min: Cell; max: Cell }, goal: Cell, from: Cell, world?: BlockReader): Cell | undefined {
  const gap = Math.max(0, box.min.x - goal.x, goal.x - box.max.x, box.min.z - goal.z, goal.z - box.max.z);
  if (gap > LAND_MARGIN + 8) return undefined;
  const lo = { x: box.min.x - LAND_MARGIN, z: box.min.z - LAND_MARGIN };
  const hi = { x: box.max.x + LAND_MARGIN, z: box.max.z + LAND_MARGIN };
  let x = Math.min(hi.x, Math.max(lo.x, Math.floor(from.x)));
  let z = Math.min(hi.z, Math.max(lo.z, Math.floor(from.z)));
  // inside the ring (the bot stands by the build): out to its nearest side
  if (x > lo.x && x < hi.x && z > lo.z && z < hi.z) {
    const d = [x - lo.x, hi.x - x, z - lo.z, hi.z - z];
    const k = d.indexOf(Math.min(...d));
    if (k === 0) x = lo.x;
    else if (k === 1) x = hi.x;
    else if (k === 2) z = lo.z;
    else z = hi.z;
  }
  const at = (y: number) => {
    const b = world?.blockAt({ x, y, z });
    return !b || b.name === 'unknown' ? undefined : b;
  };
  const free = (y: number): boolean => {
    const b = at(y);
    return !!b && b.boxes.length === 0 && !/water|lava/.test(b.name);
  };
  for (let y = box.max.y + 2; y >= box.min.y - 6; y--) {
    const below = at(y - 1);
    if (!below) break;
    if (below.boxes.length > 0 && free(y) && free(y + 1)) return { x, y, z };
  }
  return { x, y: box.min.y, z };
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

/** `create:gearbox x 4 (not a Bedrock block)` lines (at most `max`, then `unknown: K more kinds`). */
export function unknownLines(unknown: readonly UnknownBlock[], max = MAX_UNKNOWN_LINES): string[] {
  const out = unknown.slice(0, max).map((u) => `unknown: ${u.java} x ${u.count} (${u.reason})`);
  if (unknown.length > max) out.push(`unknown: ${unknown.length - max} more kinds (${unknown.slice(max).reduce((a, u) => a + u.count, 0)} blocks)`);
  return out;
}

/** `!build files` entries: `house (schem, 7x5x7, 120 blocks, 4 unknown, 1.2 KB)`. */
export function fileEntries(list: { files: readonly StructureFile[]; more: number }): string[] {
  const entries = list.files.map((f) => {
    if (f.error) return `${f.name} (${f.format}, ${bytesText(f.bytes)}: ${f.error})`;
    const big = (f.blocks ?? 0) > MAX_BUILD_CELLS ? ': too big to build' : '';
    return `${f.name} (${f.format}, ${f.size!.x}x${f.size!.y}x${f.size!.z}, ${f.blocks} blocks${f.unknown ? `, ${f.unknown} unknown` : ''}, ${bytesText(f.bytes)}${big})`;
  });
  if (list.more) entries.push(`${list.more} more not read`);
  return entries;
}

/** `!build files` lines: `build files: house (schem, 7x5x7, 120 blocks, 4 unknown, 1.2 KB), ...`. */
export function filesLines(list: { files: readonly StructureFile[]; more: number }, max = BILL_LINE_MAX): string[] {
  if (list.files.length === 0) return ['build files: none in the build folders (.mcstructure, .json, .schem, .schematic, .litematic, .nbt)'];
  const entries = fileEntries(list);
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

/**
 * Track B5: a trailing `more` or `page` with an optional page number (`!build materials file house more 2`): the words
 * before it and the page (1 for `more` alone). A file named `more` stays a name (`file more`).
 */
export function splitMore(args: readonly string[]): { args: string[]; page?: number } {
  const a = [...args];
  const w = (i: number) => a.at(i)?.toLowerCase();
  const isMore = (s: string | undefined) => s === 'more' || s === 'page';
  if (/^\d+$/.test(w(-1) ?? '') && isMore(w(-2)) && w(-3) !== 'file') return { args: a.slice(0, -2), page: Number(w(-1)) };
  if (isMore(w(-1)) && w(-2) !== 'file') return { args: a.slice(0, -1), page: 1 };
  return { args: a };
}

/** Track B5: the full text of a reply that left something out (`!build more` pages through it; the panel's GET /api/build). */
export interface BuildFullText {
  /** Which reply: materials, refused, fetch, files, plan, status, end, stop, resume. */
  topic: string;
  /** What it is (`materials for file house at 1 2 3`). */
  title: string;
  lines: string[];
  at: number;
}

/** Track B5: where the rest of a reply is. */
const ALL = ` (all: ${MORE})`;

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
    // Track B5: every reply fits the chat (skills/build/reply.ts); what one leaves out `!build more [page]` shows
    const say = (lines: readonly string[]) => {
      for (const l of lines) reply(l);
    };
    if ((a === 'more' || a === 'page') && args.length <= 2) return say(this.more(Number(args[1] ?? 1)));
    if (a === 'stop' && args.length === 1) return say(this.fit('stop', 'build stop', [this.stop()]));
    if (a === 'status' && args.length === 1) return say(this.fit('status', 'build status', [this.status()]));
    if (a === 'files') {
      const { args: rest, page } = splitMore(args.slice(1));
      if (rest.length === 0) return say(this.files(page));
    }
    if (a === 'materials') return say(await this.materials(args.slice(1)));
    if (a === 'resume' && args.length === 1) return this.resume(line, reply);
    if (this.fetching) return reply(`build: fetching materials for ${this.fetching.label} (!build stop ends it)`);
    if (this.jobRun) return reply(`build: ${this.jobRun.job.plan.spec.label} is running (!build stop ends it)`);
    if (this.boxProc && !this.boxProc.done) return reply(`build: ${this.boxProc.behaviour()} (!build stop ends it)`);
    // Track B6: no home chore from here until the build is over (the planning, the fetch's gaps, the boxes after it)
    this.acquire();
    try {
      await this.runBuild(line, args, reply, say);
    } finally {
      this.release();
    }
  }

  // ---- Track B6 (decision 0131): the hold that keeps the chores off while a build runs

  private holds = 0;
  private holdProc: BuildHoldProcess | undefined;
  /** Track B6: the items the running build needs (BuildHost keeps: never unloaded for a take's room). */
  private keepNow = new Set<string>(); // (reassigned per bill)

  /** A build phase begins: the hold process is there until the last phase ends (release). */
  private acquire(): void {
    this.holds++;
    if (!this.holdProc || this.holdProc.done) {
      const label = () => this.jobRun?.job.plan.spec.label ?? this.fetching?.label ?? this.last?.spec.label ?? 'build';
      this.holdProc = new BuildHoldProcess(label);
      this.h.processes.add(this.holdProc);
    }
  }

  private release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds > 0) return;
    this.holdProc?.end();
    this.holdProc = undefined;
    this.keepNow.clear();
  }

  /**
   * Track B6: the items the running build's current fetch needs (none when no build runs): what its bill brings, takes
   * out, makes and makes from. Not the whole plan's materials: a take's room is made of what this round does not use (a
   * large build's round of planks unloads the glass left from the last one, as before).
   */
  keeps(): readonly string[] {
    return this.holds === 0 ? [] : [...this.keepNow];
  }

  /** Track B6: a shulker box kind the build places (an empty one is a build block, never stow room). */
  private ownBox(name: string): boolean {
    const p = this.jobRun?.job.plan ?? (this.proc && !this.proc.done ? this.proc.runner.plan : this.last);
    return isShulkerBox(name) && (p?.materials[name] ?? 0) > 0;
  }

  /** Track B6: the bill's items kept while the fetch works through it (what it brings, takes out, crafts and smelts from). */
  private keepBill(b: Bill): void {
    this.keepNow = new Set(); // (this bill's, not every bill's since the command)
    for (const i of b.items) this.keepNow.add(i.item);
    for (const x of [...b.bring, ...b.unbox]) this.keepNow.add(x.item);
    for (const s of b.smelts) this.keepNow.add(s.input);
    for (const f of b.fuel) {
      this.keepNow.add(f.item);
      if (f.from) this.keepNow.add(f.from.item);
    }
    for (const c of b.crafts) {
      this.keepNow.add(c.item);
      for (const part of (b.items.find((i) => i.item === c.item)?.from ?? '').split(', ')) if (part) this.keepNow.add(part.replace(/^\d+ /, ''));
    }
  }

  private async runBuild(line: ChatLine, args: readonly string[], reply: (m: string) => void, say: (lines: readonly string[]) => void): Promise<void> {
    const feet = this.h.position();
    let loaded: (Structure & { file?: string }) | undefined;
    const parsed = parseSpec(args, {
      feet,
      load: (n) => {
        loaded = this.h.load(n);
        return loaded;
      },
      ...(this.h.groundTop ? { ground: (x: number, z: number) => this.h.groundTop!(x, z) } : {}), // Track B7
    });
    if (!parsed.ok) return reply(`build: ${parsed.error}${parsed.error.startsWith('unknown build') ? ` (usage: !build ${BUILD_HELP})` : ''}`);
    this.lastUnknown = parsed.unknown ?? [];
    const ctx: StartCtx = { line, args: [...(parsed.args ?? args)], feet: feet ? { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) } : { x: 0, y: 0, z: 0 }, fetch: parsed.fetch, ...(loaded ? { file: { name: loaded.name, sha256: structureHash(loaded) } } : {}), ...(parsed.skipMissing ? { skipMissing: true } : {}) };
    // Track B4: the shulker boxes handed over (dropped near the bot) first, so the bill counts what they hold
    if (parsed.fetch && !(await this.pickUpHanded(reply))) return;
    // Track B3: over one section: a job, planned a section at a time
    if (buildCells(parsed.spec) > SECTION_CELLS) return this.startJob(ctx, parsed.spec, reply);
    const plan = await this.plan(parsed.spec, reply);
    if (!plan) return;
    const m = this.materialsFor(plan);
    if (!m.ok) {
      if (!parsed.fetch) return say(this.refusedFor(plan, m, plan.scaffolds, 'first'));
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

  // ---- Track B5 (ADR 0130): replies that fit the chat, the full text kept

  /** The full texts kept, by topic, and the topic of the last one (what `!build more` shows). */
  private readonly full = new Map<string, BuildFullText>();
  private lastFull: string | undefined;

  /** The full texts kept, the newest first (the panel's GET /api/build). */
  texts(): BuildFullText[] {
    return [...this.full.values()].sort((a, b) => b.at - a.at);
  }

  /** Keep a reply's full text (wrapped to the page width) and log it once, an INFO line a line. */
  private keep(topic: string, title: string, lines: readonly string[]): void {
    const all = wrapAll(lines, FULL_BYTES);
    const kept = all.length > FULL_MAX_LINES ? [...all.slice(0, FULL_MAX_LINES - 1), `(${all.length - FULL_MAX_LINES + 1} more lines not kept)`] : all;
    const old = this.full.get(topic);
    this.full.set(topic, { topic, title, lines: kept, at: this.now() });
    this.lastFull = topic;
    if (old?.title === title && old.lines.join('\n') === kept.join('\n')) return;
    this.h.log.info(`build: ${title}: the full text, ${kept.length} line${kept.length === 1 ? '' : 's'} (${MORE} pages through it)`);
    kept.forEach((l, i) => this.h.log.info(`build: [${i + 1}/${kept.length}] ${l}`));
  }

  /**
   * A reply in at most REPLY_LINES lines: the full text when it fits, else `summary` (or the generic cut, fitLines), the
   * full text (or `kept`: the same facts, denser) kept for `!build more`.
   */
  fit(topic: string, title: string, full: readonly string[], summary?: () => string[], n = REPLY_LINES, kept?: () => string[]): string[] {
    const all = wrapAll(full);
    if (all.length <= n) return all;
    this.keep(topic, title, kept?.() ?? full);
    return summary ? summary().slice(0, n) : fitLines(full, n).lines;
  }

  /** `!build more [page]`: a page of the last full text kept. */
  more(page: number, topic = this.lastFull): string[] {
    const t = topic ? this.full.get(topic) : undefined;
    if (!t) return [`build: nothing more to show (a reply that leaves something out says +N more; ${MORE} then shows the rest)`];
    this.lastFull = t.topic;
    return pageLines(t.lines, page).lines;
  }

  /** `!build files [more [page]]`: the files, or a page of all of them. */
  files(page?: number): string[] {
    const list = this.h.files?.() ?? { files: [], more: 0 };
    const full = filesLines(list, FULL_BYTES);
    if (page !== undefined) {
      this.keep('files', 'build files', full);
      return this.more(page, 'files');
    }
    return this.fit('files', 'build files', filesLines(list), () => fitEntries(`build files: ${list.files.length} file${list.files.length === 1 ? '' : 's'}: `, fileEntries(list), ALL, REPLY_LINES), REPLY_LINES, () => full);
  }

  /** The materials reply's full text: the materials line, the refused blocks, the bill, every unknown block. */
  private materialsFull(plan: Pick<Plan, 'spec' | 'scaffolds' | 'refused'>, m: Materials, bill: Bill | undefined, unknown: readonly UnknownBlock[], prefix = 'materials for ', hint = '', width = BILL_LINE_MAX): string[] {
    const head = `${materialsLine(plan.spec.label, m, plan.scaffolds).replace(/^materials for /, prefix)}`;
    const lines = [hint ? `${head} ${hint}` : head];
    // Track B1: the blocks the builder refuses, with the reason (the rest is built); on its own line past the chat's length
    if (plan.refused?.length) {
      const r = refusedLine(plan.refused, Infinity, Infinity);
      if (lines[0]!.length + 2 + r.length <= BILL_LINE_MAX) lines[0] = `${lines[0]!}; ${r}`;
      else lines.push(`build: ${r}`);
    }
    if (bill && !m.ok) lines.push(...billLines(plan.spec.label, bill, width));
    lines.push(...unknownLines(unknown, Infinity));
    return lines;
  }

  /** The materials' full text kept for `!build more`: with a bill, each fact once (materialsFullDense); else materialsFull. */
  private materialsKept(plan: Pick<Plan, 'spec' | 'scaffolds' | 'refused' | 'materials'>, m: Materials, bill: Bill | undefined, unknown: readonly UnknownBlock[], prefix = 'materials for ', hint = ''): string[] {
    if (!bill || m.ok) return this.materialsFull(plan, m, bill, unknown, prefix, hint, FULL_BYTES);
    const dense = materialsFullDense({ prefix, label: plan.spec.label, materials: plan.materials, m, bill, unknown, tail: '', scaffolds: plan.scaffolds, ...(plan.refused?.length ? { refusedText: refusedLine(plan.refused, Infinity, Infinity) } : {}) });
    if (hint) dense[0] = `${dense[0]!} ${hint}`;
    return dense;
  }

  /** A build refused for its blocks (no `fetch`): the materials, the bill, and how to fetch them. */
  private refusedFor(plan: Pick<Plan, 'spec' | 'scaffolds' | 'refused' | 'materials' | 'scaffoldPeak'>, m: Materials, scaffolds: number, when: 'first' | 'as it goes'): string[] {
    const bill = this.billFor(plan, m);
    const hint = `(add fetch to get, craft and smelt them ${when})`;
    const full = this.materialsFull({ ...plan, scaffolds }, m, bill, [], 'build: ', hint);
    return this.fit(
      'refused',
      `build ${plan.spec.label} refused`,
      full,
      () => materialsSummary({ prefix: 'build: ', label: plan.spec.label, materials: plan.materials, m, bill, ...(plan.refused ? { refused: plan.refused } : {}), tail: ` ${hint.slice(0, -1)}; all: ${MORE})` }),
      REPLY_LINES,
      () => this.materialsKept({ ...plan, scaffolds }, m, bill, [], 'build: ', hint),
    );
  }

  /** A fetch refused before any command: what cannot be got, then the totals. */
  private cannotFor(plan: Pick<Plan, 'spec' | 'materials'>, m: Materials, bill: Bill): string[] {
    const full = (w: number) => [...packLines(['build: nothing fetched: cannot get', ...stepWords([cannotText(bill.cannot)])], w), materialsLine(plan.spec.label, m)];
    return this.fit('fetch', `build ${plan.spec.label}: nothing fetched`, full(BILL_LINE_MAX), () => [
      cannotLine('build: nothing fetched: ', bill.cannot),
      totalsLine({ prefix: 'materials for ', label: plan.spec.label, materials: plan.materials, m, bill, tail: '' }, 'none', ALL),
    ], REPLY_LINES, () => full(FULL_BYTES));
  }

  /**
   * The fetch's first reply: its steps, in two lines at most (the handed-over boxes' line may come before it: three in
   * all), else in one line of each step's biggest entry (stepsLine), the steps in full kept.
   */
  private fetchFirst(label: string, bill: Bill): string[] {
    const head = `build ${label}: fetching first: `;
    const full = (w: number) => packLines([head.trimEnd(), ...stepWords(billSteps(bill))], w);
    return this.fit('fetch', `build ${label}: the fetch's steps`, full(BILL_LINE_MAX), () => [stepsLine(head, bill, ALL)], REPLY_LINES - 1, () => full(FULL_BYTES));
  }

  /** `!build materials [<build>] [more [page]]`: the materials line, then (Track B2) the bill and the unknown blocks. */
  async materials(args0: readonly string[]): Promise<string[]> {
    const { args, page } = splitMore(args0);
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
    const bill = m.ok ? undefined : this.billFor(plan, m);
    const full = this.materialsFull(plan, m, bill, unknown);
    const title = `materials for ${plan.spec.label}`;
    // Track B5: `more`: the whole of it, a page at a time
    const p = plan;
    if (page !== undefined) {
      this.keep('materials', title, wrapAll(full).length <= REPLY_LINES ? this.materialsFull(p, m, bill, unknown, 'materials for ', '', FULL_BYTES) : this.materialsKept(p, m, bill, unknown));
      return this.more(page, 'materials');
    }
    return this.fit(
      'materials',
      title,
      full,
      () => materialsSummary({ prefix: 'materials for ', label: p.spec.label, materials: p.materials, m, ...(bill ? { bill } : {}), ...(p.refused ? { refused: p.refused } : {}), unknown, tail: ALL }),
      REPLY_LINES,
      () => this.materialsKept(p, m, bill, unknown),
    );
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
    const say = (l: string) => {
      for (const x of this.fit('plan', `build ${plan.spec.label}`, [l])) reply(x);
    };
    if (plan.steps.length === 0) {
      say(`build: nothing to do (${planLine(plan)})`);
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
    say(`building ${planLine(plan)}`);
    progress?.setState('running');
    if (progress) this.watchBoxes(progress); // Track B4
    this.acquire(); // Track B6: until the boxes after it are back
    void p.result.then(async (end) => {
      try {
        progress?.setState(end.state === 'done' ? 'done' : this.disposed || (end.state === 'cancelled' && end.reason === 'dispose') ? 'running' : 'stopped');
        this.ended(p, end);
        if (end.state !== 'cancelled' && !this.disposed) await this.boxesAfter('after the build'); // Track B4
      } finally {
        this.release();
      }
    });
    this.h.processes.add(p);
  }

  private ended(p: BuildProcess, end: BuildEnd): void {
    const r = p.runner;
    const s = r.stats;
    const secs = s.activeMs / 1000;
    const rate = r.rate();
    // Track B5: the first 3 of a list and `+N more` (`!build more` has them all)
    const skips = s.skipped.map((x) => `${x.pos.x} ${x.pos.y} ${x.pos.z} (${x.reason})`);
    const skipped = s.skipped.length ? `; skipped: ${skips.slice(0, 3).join(', ')}${s.skipped.length > 3 ? `, +${s.skipped.length - 3} more` : ''}` : '';
    const scaff = s.scaffoldsPlaced ? `, ${s.scaffoldsPlaced} scaffold${s.scaffoldsPlaced === 1 ? '' : 's'} placed / ${s.scaffoldsRemoved} removed` : '';
    // Track B1: blocks left with states other than the build's, and the refused ones
    const wrongs = (s.wrong ?? []).map((w) => `${w.name} ${w.pos.x} ${w.pos.y} ${w.pos.z} (${w.diff.slice(0, 2).join(', ')})`);
    const wrong = wrongs.length ? `; ${wrongs.length} with other states: ${wrongs.slice(0, 3).join(', ')}${wrongs.length > 3 ? `, +${wrongs.length - 3} more` : ''}` : '';
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
    // Track B5: the lists in full for `!build more` when the line names only some
    const said = fitLines([line]);
    if (said.cut || skips.length > 3 || wrongs.length > 3 || (r.plan.refused?.length ?? 0) > 3) {
      this.keep('end', `build ${r.plan.spec.label}: the end`, [line, ...(skips.length ? [`skipped: ${skips.join(', ')}`] : []), ...(wrongs.length ? [`with other states: ${wrongs.join(', ')}`] : []), ...(r.plan.refused?.length ? [refusedLine(r.plan.refused, Infinity, Infinity)] : [])]);
    }
    // a !stop / !build stop / replacement answers for itself; a death is said (Track B5: in the lines it fits)
    if (end.state !== 'cancelled' || end.reason === 'death') for (const l of said.lines) this.h.say(l);
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
    const boxes = bx ? { boxed: bx.contents(), boxRoom: bx.room((n) => this.ownBox(n)), never: THROWAWAY_BLOCKS } : {};
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
    let rescanned = false;
    /** Track B6: the free slots at which a stow moved nothing (no stow again until they change). */
    let noStowAt: number | undefined;
    for (;;) {
      if (f.cancelled || this.fetching !== f) return 'cancelled';
      this.keepBill(bill); // Track B6: what this bill brings and makes from is not unloaded for a take's room
      const now = this.fetchNow();
      const free = freeSlotsOf(now.slots);
      const next = nextFetchStep(bill, noStowAt === free ? { ...now, noStow: true } : now);
      if (next.kind === 'done') break;
      if (next.kind === 'stuck') {
        // Track B6: what cannot be got may be in a home chest the memory read before it changed: read them again once
        if (bill.cannot.length && !rescanned && this.h.rescan) {
          rescanned = true;
          const r = await this.h.rescan();
          if (f.cancelled || this.fetching !== f) return 'cancelled';
          if (r !== undefined) {
            this.h.log.info(`build: fetch for ${f.label}: ${cannotText(bill.cannot)}: the home chests read again (${r})`);
            bill = billNow();
            continue;
          }
        }
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
        // Track B6: a take into a full inventory is no reason to go home: it says so
        const full = next.kind === 'run' && free === 0 && /^(bring|get) /.test(command);
        // Track B3: a step that changed nothing away from home (a craft with no free cell for its table: a round asked
        // at a column's foot inside the build) is tried once more at home. Track B6 (decision 0131): a box step never
        // (the boxes are the same there: a stow, a take out of them; main 9b11e2cb did it for the stow)
        if (!wentHome && next.kind === 'run' && !full && (await this.toHome(`!${command}`))) {
          wentHome = true;
          tries.delete(sig);
          continue;
        }
        stopped = full ? inventoryFullWhy(command, !!this.h.boxes?.()) : next.kind === 'run' ? `!${command} changed nothing` : `${command}: nothing moved`;
        break;
      }
      tries.set(sig, 1);
      // Track B6 (decision 0131): a step done at home (a take from its chests, the furnace, a smelt) from farther than
      // flyMin: the trip there first, flown when it can be
      if (next.kind === 'run' && /^(bring .* home|furnace|smelt )/.test(next.command)) await this.toHomeFor(`!${command}`);
      if (f.cancelled || this.fetching !== f) return 'cancelled';
      f.step++;
      // (a chat command is said with its prefix, a box step in words)
      f.command = next.kind === 'run' ? command : '';
      f.boxCommand = next.kind === 'run' ? undefined : command;
      f.stepAt = this.now();
      const stowed0 = f.stowed ?? 0;
      if (next.kind === 'run') await this.runStep(line, next.command, f);
      else await this.boxStep(next, f);
      if (f.cancelled || this.fetching !== f) return 'cancelled';
      // Track B6: a stow that moved nothing is not asked again at this fill (the fetch goes on with the next step)
      if (next.kind === 'stow' && (f.stowed ?? 0) === stowed0) noStowAt = freeSlotsOf(this.fetchNow().slots);
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
        const r = await bx.stow(step.keep, { cancelled, ...(avoid ? { avoid } : {}), notInto: (n) => this.ownBox(n) });
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
      if (me && Math.hypot(near.x - me.x, near.y - me.y, near.z - me.z) > BOX_NEAR && this.h.approach) await this.travel(near, 'to a shulker box left out');
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
    return this.travel(h, `home (${why})`);
  }

  /** Track B6: before a step done at home, the trip there when it is farther than flyMin (the step would walk it). */
  private async toHomeFor(why: string): Promise<void> {
    const h = this.h.home?.();
    const p = this.h.position();
    const min = this.h.flyMin?.();
    if (!h || !p || !this.h.approach || min === undefined || Math.hypot(h.x - p.x, h.z - p.z) <= min) return;
    await this.travel(h, `home for ${why}`);
  }

  /** Track B6: the box of the build running (or planned last), for the landing off it. */
  private buildBox(): { min: Cell; max: Cell } | undefined {
    const run = this.jobRun;
    if (run) return run.job.box;
    const p = this.proc && !this.proc.done ? this.proc.runner.plan : this.last;
    return p ? BuildController.boxOfSpec(p.spec) : undefined;
  }

  /**
   * Track B6 (decision 0131): a trip of the build (home, back to the build, to a box left out) through the host's
   * approach, which flies a trip farther than flyMin when it can. A goal at the build is flown to a cell LAND_MARGIN
   * outside its box on the side the bot comes from, so the flight never lands on the build or a scaffold column.
   */
  private travel(c: Cell, why: string): Promise<boolean> {
    if (!this.h.approach) return Promise.resolve(false);
    const box = this.buildBox();
    const me = this.h.position();
    const land = box && me ? landOff(box, c, me, this.h.world) : undefined;
    return this.h.approach(c, { why, ...(land ? { land } : {}) });
  }

  /**
   * Track B2 `fetch`: the bill's commands (fetchLoop), then plan and start the build.
   */
  private async fetchThenBuild(line: ChatLine, planIn: Plan, mIn: Materials, reply: (msg: string) => void, ctx?: StartCtx): Promise<void> {
    let plan0 = planIn;
    let m0 = mIn;
    let bill = await this.billChecked(plan0, m0);
    // Track B6: `skip missing`: what cannot be got is left out (refused), the rest fetched and built
    if (bill.cannot.length && ctx?.skipMissing) {
      const skip = this.missingSkips(plan0);
      const cut = withoutMissing(plan0.spec, skip);
      if (cut.refused.length) {
        this.h.log.info(`build: skip missing: ${cut.refused.length} cells left out (${[...cut.items].map(([k, n]) => `${n} ${k}`).join(', ')})`);
        const re = await this.plan(cut.spec, reply);
        if (!re) return;
        plan0 = re;
        m0 = this.materialsFor(plan0);
        if (m0.ok) return this.start(plan0, reply, ctx);
        bill = this.billFor(plan0, m0);
      }
    }
    const spec = plan0.spec;
    const say = (topic: string, l: string) => {
      for (const x of this.fit(topic, `build ${spec.label}: ${topic}`, [l])) reply(x);
    };
    if (bill.cannot.length) {
      // nothing is fetched: what nothing makes, then the materials line
      for (const l of this.cannotFor(plan0, m0, bill)) reply(l);
      return;
    }
    const f = this.beginFetch(spec.label);
    for (const l of this.fetchFirst(spec.label, bill)) reply(l);
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
      say('fetch', `build: fetch for ${spec.label} stopped after ${f.step} command${f.step === 1 ? '' : 's'}: ${stopped}`);
      return;
    }
    // Track B6: back to the build first when the fetch ended farther than flyMin from it (flown when it can be)
    const box = BuildController.boxOfSpec(spec);
    const me = this.h.position();
    const min = this.h.flyMin?.();
    if (box && me && min !== undefined && Math.max(0, box.min.x - me.x, me.x - box.max.x, box.min.z - me.z, me.z - box.max.z) > min) {
      const c = { x: Math.floor((box.min.x + box.max.x) / 2), y: box.min.y, z: box.min.z - 1 };
      await this.travel(c, 'back to the build');
    }
    const plan = await this.plan(spec, reply);
    if (!plan) return;
    const again = this.materialsFor(plan);
    if (!again.ok) return say('fetch', `build: still short after fetching: ${materialsLine(spec.label, again, plan.scaffolds)}`);
    this.h.log.info(`build: fetch for ${spec.label} done in ${f.step} commands, ${Math.round((this.now() - f.t0) / 1000)} s: ${this.fetched.slice(-f.step).join(' | ')}`);
    this.start(plan, reply, ctx);
  }

  // ---- Track B3 (ADR 0128): large builds, fetch rounds, resume

  /**
   * Track B6: the bill, and when it says something cannot be got, the home chests read again once (when in reach) and
   * the bill made again: the memory may be older than what a chest holds now.
   */
  private async billChecked(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>, m: Materials): Promise<Bill> {
    const bill = this.billFor(plan, m);
    if (!bill.cannot.length || !this.h.rescan) return bill;
    const r = await this.h.rescan();
    if (r === undefined) {
      this.h.log.info(`build: ${cannotText(bill.cannot)}: the home chests are not in reach to read again (!chests scan at home reads them)`);
      return bill;
    }
    this.h.log.info(`build: ${cannotText(bill.cannot)}: the home chests read again (${r})`);
    return this.billFor(plan, this.materialsFor(plan));
  }

  /**
   * Track B6 (decision 0131): what `skip missing` leaves out: of each build item, how many the bill cannot get. An item
   * short of a material nothing gets (logs for its planks) counts for what of it nothing else covers; passes until the
   * bill of what is left has no cannot (at most 4).
   */
  missingSkips(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>): Map<string, number> {
    const out = new Map<string, number>();
    const left = (): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const [k, v] of Object.entries(plan.materials)) {
        const n = v - (out.get(k) ?? 0);
        if (n > 0) m[k] = n;
      }
      return m;
    };
    for (let pass = 0; pass < 4; pass++) {
      const materials = left();
      const bill = this.billFor({ materials, scaffoldPeak: plan.scaffoldPeak });
      if (!bill.cannot.length) break;
      let added = false;
      const add = (item: string, n: number) => {
        if (n <= 0 || !(item in materials)) return;
        out.set(item, (out.get(item) ?? 0) + Math.min(n, materials[item]!));
        added = true;
      };
      for (const it of bill.items) if (it.short > 0) add(it.item, it.short);
      // a material that is no build item: each build item made with it, alone, shows what of it cannot be made
      if (bill.cannot.some((c) => !bill.items.some((i) => i.item === c.item))) {
        for (const it of bill.items) {
          if (it.make <= 0 || it.short > 0) continue;
          const solo = this.billFor({ materials: { [it.item]: it.need }, scaffoldPeak: 0 });
          const s = solo.items.find((i) => i.item === it.item);
          if (solo.cannot.length && s) add(it.item, s.need - s.loose - s.boxed - s.home);
        }
      }
      if (!added) break;
    }
    return out;
  }

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
      ...(this.h.approach ? { approach: (c: Cell) => this.travel(c, 'back to the build') } : {}), // Track B6: flown when far
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
  private async startJob(ctx: StartCtx, spec0: BuildSpec, reply: (m: string) => void, resumed?: { survey: Survey; left: Cell[]; leftovers: Cell[]; progress: BuildProgress }): Promise<void> {
    const start = this.h.position();
    if (!start) return reply('build: my position is unknown');
    let spec = spec0;
    let job: BuildJob;
    const deps = this.jobDeps(ctx);
    const make = (s: BuildSpec): BuildJob => {
      // Track B6: a resumed job's cells left to do, without the ones `skip missing` leaves out
      const keys = s === spec0 ? undefined : new Set(s.places.map((b) => `${b.pos.x},${b.pos.y},${b.pos.z}`));
      const left = resumed && keys ? resumed.left.filter((c) => keys.has(`${c.x},${c.y},${c.z}`)) : resumed?.left;
      return new BuildJob(s, start, resumed ? { ...deps, progress: resumed.progress } : deps, resumed ? { survey: resumed.survey, left: left!, leftovers: resumed.leftovers } : {});
    };
    try {
      job = make(spec);
    } catch (e) {
      return reply(`build: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.last = job.plan;
    const label = spec.label;
    // the whole build's bill: the scaffold blocks of a tall section's worth at most at once (none for a build no taller
    // than the ground's reach; each section's plan asks for more at its start)
    let whole = { materials: job.plan.materials, scaffoldPeak: job.box.max.y - job.box.min.y + 1 > JOB_LOW ? JOB_SCAFFOLDS : 0 };
    let m = this.materialsFor(whole);
    if (!m.ok) {
      // Track B5: in the lines that fit (refusedFor, cannotFor), the full text for `!build more`
      if (!ctx.fetch) {
        for (const l of this.refusedFor({ ...job.plan, ...whole }, m, 0, 'as it goes')) reply(l);
        return;
      }
      let bill = await this.billChecked(whole, m); // Track B6: the home chests read again before a cannot
      // Track B6: `skip missing`: what cannot be got is left out (refused), the rest fetched in rounds and built
      if (bill.cannot.length && ctx.skipMissing) {
        const cut = withoutMissing(spec, this.missingSkips(whole));
        if (cut.refused.length) {
          this.h.log.info(`build: skip missing: ${cut.refused.length} cells left out (${[...cut.items].map(([k, n]) => `${n} ${k}`).join(', ')})`);
          try {
            spec = cut.spec;
            job = make(spec);
          } catch (e) {
            return reply(`build: ${e instanceof Error ? e.message : String(e)}`);
          }
          this.last = job.plan;
          whole = { materials: job.plan.materials, scaffoldPeak: whole.scaffoldPeak };
          m = this.materialsFor(whole);
          bill = m.ok ? bill : this.billFor(whole, m);
          if (m.ok) bill = { ...bill, cannot: [] };
        }
      }
      if (bill.cannot.length) {
        for (const l of this.cannotFor(job.plan, m, bill)) reply(l);
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
    if (!resumed) for (const l of this.fit('plan', `build ${label}`, [`building ${label}: ${job.plan.work} ${verb} in ${job.sections.length} section${job.sections.length === 1 ? '' : 's'}${refused}${!m.ok ? '; fetching in rounds as it goes' : ''}`])) reply(l);
    this.h.log.info(`build: job ${label}: ${job.sections.length} sections (${job.sections.map((s) => s.cells).join(', ')} cells)${resumed ? `, resumed at ${resumed.survey.done} done` : ''}`);
    void this.runJob(ctx, job, progress).catch((e: unknown) => this.h.log.warn(`build: job ${label}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The job's processes, one after another, and a fetch round between them when it asks for one. */
  private async runJob(ctx: StartCtx, job: BuildJob, progress: BuildProgress): Promise<void> {
    const run: JobRun = { job, ctx, progress, cancelled: false };
    this.jobRun = run;
    this.acquire(); // Track B6: no chore between its processes and rounds
    try {
      await this.runJobHeld(run, job, progress);
    } finally {
      this.release();
    }
  }

  private async runJobHeld(run: JobRun, job: BuildJob, progress: BuildProgress): Promise<void> {
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
        const boxRoom = this.h.boxes?.()?.room((n) => this.ownBox(n)) ?? 0;
        const need = job.roundNeed(this.freeSlots(Object.keys(job.plan.materials)) + boxRoom, (it) => this.stackOf(it));
        this.h.log.info(`build: fetch round ${n} for ${job.plan.spec.label} (out of ${end.items.join(', ')}): ${Object.entries(need.materials).map(([k, v]) => `${v} ${k}`).join(', ')}, scaffolds ${need.scaffoldPeak}${boxRoom ? ` (with ${boxRoom} free slots in my boxes)` : ''}`);
        const stopped = await this.fetchLoop(run.ctx.line, f, () => this.billFor(need));
        if (stopped === 'cancelled' || run.cancelled) {
          end = { state: 'cancelled', reason: run.reason ?? 'stopped' };
          break;
        }
        f.proc!.end();
        if (stopped) {
          const why = `fetch round ${n}: ${stopped}`;
          for (const l of this.fit('fetch', `build ${job.plan.spec.label}: fetch round ${n}`, [`build ${job.plan.spec.label}: ${why}`])) this.h.say(l);
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
    const after = end.state !== 'cancelled' && !this.disposed ? this.boxesAfter('after the build') : undefined;
    // the task stopping (a restart) leaves it `running` whatever the process was stopped with (the task's other parts
    // stop their processes in their own order, before or after the manager's dispose)
    progress.setState(end.state === 'done' ? 'done' : this.disposed || run.reason === 'dispose' || (end.state === 'cancelled' && end.reason === 'dispose') ? 'running' : 'stopped');
    if (p) this.ended(p, end);
    await after; // Track B6: the hold stays until the boxes are back
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
    for (const l of this.fit('resume', `resuming build ${d.label}`, [`resuming build ${d.label}: ${survey.done} of ${d.total} done${what}${scaff}${boxes}`])) reply(l);
    this.lastUnknown = parsed.unknown ?? [];
    const ctx: StartCtx = { line: by, args: [...d.args], feet: d.feet, fetch: d.fetch, ...(d.file ? { file: d.file } : {}), ...(parsed.skipMissing ? { skipMissing: true } : {}) };
    // Track B6: held from here (a rescan before a cannot may wait) until the job's own hold has it
    this.acquire();
    void this.startJob(ctx, parsed.spec, reply, { survey, left, leftovers, progress })
      .catch((e: unknown) => reply(`build: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.release());
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
  const ground = worldSource(world); // Track B7: `!build file <name> map` without a y
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
    groundTop: (x, z) => groundTop(ground, x, z), // Track B7
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
    approach: async (p, o = {}) => {
      // Track B6 (decision 0131): a trip farther than flyMin goes the way `!goto` goes (commands-fly.ts wraps pve.walk:
      // flown when autoFly, the kit and the distance allow), aimed off the build; the log says whether it flew and why not
      const me = mob.position();
      const pve = d.pve;
      const why = o.why ?? 'a build trip';
      const far = me ? Math.hypot(p.x + 0.5 - me.x, p.z + 0.5 - me.z) : 0;
      if (pve && me && far > d.settings.get('flyMin')) {
        if (!d.settings.get('autoFly')) log.info(`build: trip ${why}: ${Math.round(far)} blocks: walked (no flight: autoFly is off)`);
        else {
          let flew = false;
          const off = processes.onControl((e) => {
            if (e.to === 'fly' || e.to === 'flight') flew = true;
          });
          const goal = o.land ?? p;
          const t0 = Date.now();
          let r: { ok: boolean; reason?: string };
          try {
            r = await pve.walk({ type: 'block', p: goal }, { timeoutTicks: 6000, beside: true }, `walking to ${why}`);
          } finally {
            off();
          }
          const at = mob.position();
          const left = at ? Math.round(Math.hypot(p.x + 0.5 - at.x, p.z + 0.5 - at.z)) : -1;
          log.info(`build: trip ${why}: ${Math.round(far)} blocks: ${flew ? 'flew' : 'walked (no flight: the fly log says why: no elytra or rockets at hand, a trip the elytra does not cover, a closed sky)'} in ${((Date.now() - t0) / 1000).toFixed(0)} s to ${goal.x} ${goal.y} ${goal.z}${o.land ? ' (off the build)' : ''}, ${r.ok ? 'there' : `ended: ${r.reason ?? '?'}`}; ${left} blocks from the goal`);
        }
      }
      return (await mover.goto({ type: 'near', p, r: 4 }, { timeoutTicks: 6000, allowBreak: false, allowPlace: false })).ok;
    },
    flyMin: () => d.settings.get('flyMin'), // Track B6
    // Track B6: the home chests read again (forced), only when they are in reach
    rescan: async () => {
      const hc = homeControlOf(d.task);
      if (!hc?.logistics.inReach().inReach) return undefined;
      const r = await hc.start({ kind: 'scan', force: true, retry: true }).result;
      return r?.kind === 'scan' ? `${r.report.read.length} read, ${r.report.failed.length} failed` : 'the scan stopped';
    },
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
        room: (notInto) => s.boxRoom(notInto),
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
  setBuildKeeps(d.task, () => c.keeps()); // Track B6: never unloaded for a take's room while the build runs
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
