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
//
// A build runs as a user process (tasks/process/build.ts): guard, flee and night pre-empt it, `!pause`
// holds it, `!stop` ends it. Missing blocks refuse the build. Track B2 (ADR 0125): `fetch` works through the
// bill of materials (skills/build/bill.ts) one command at a time, as the owner, through the chat handler: what the
// home chests hold with `!bring ... home`, raw materials with `!get`, then `!craft` for what can be crafted from
// what is carried, `!furnace` when a smelt needs one, `!smelt`, and the crafts that wait on smelted items; the bill is
// made again after each command, and the build starts when nothing is missing.
import type { ChatLine } from './text.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BuildProcess, type BuildEnd } from '../tasks/process/build.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import { BaseProcess, PRIORITY, type ProcessManager, type ProcessStatus, type StopReason } from '../tasks/process/manager.ts';
import { BILL_LINE_MAX, billLines, billNeeds, billOf, billSteps, nextFetchStep, packLines, stepWords, type Bill, type FetchNow } from '../skills/build/bill.ts';
import { buildDirs, bytesText, listStructures, loadStructure, type StructureFile, type UnknownBlock } from '../skills/build/formats/index.ts';
import { materialsLine, materialsOf, usable, type Materials } from '../skills/build/materials.ts';
import { planBuildAsync, planLine, PlanError, refusedLine, type Plan } from '../skills/build/plan.ts';
import { BuildRunner, etaText, progressLine, type RunnerDeps } from '../skills/build/runner.ts';
import type { BlockReader } from '../skills/build/sim.ts';
import { BUILD_USAGE, parseSpec } from '../skills/build/spec.ts';
import { MAX_BUILD_CELLS, type BuildSpec, type Cell } from '../skills/build/types.ts';
import type { ChainOptions } from '../skills/craft/chain.ts';
import type { RecipeIndex } from '../skills/craft/recipes.ts';
import { furnacesCarried } from '../skills/food/furnace.ts';
import { sourceRecords } from '../skills/home/bring.ts';
import { supplyOf } from '../skills/supply/supply.ts'; // Track BJ
import { THROWAWAY_BLOCKS } from '../skills/survival/keeper.ts';
import type { ItemStack } from '../world/types.ts';
import type { Logger } from '../log.ts';
import { craftControlOf } from './commands-craft.ts';
import { homeControlOf } from './commands-home.ts';
import { smeltControlOf } from './commands-smelt.ts';

export const BUILD_HELP = 'fill|clear|replace|wall|floor|pillar|file ... [fetch]; materials, files, status, stop (builds walls, floors, boxes, saved structures)';
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
  /** A runner for a plan (wired to the bot's skills). */
  runner(plan: Plan): BuildRunner;
  /** Run a chat command as the owner who typed `line` (no prefix). */
  dispatch(line: ChatLine, command: string): void;
  /** Load a structure file by name. */
  load(name: string): ReturnType<typeof loadStructure>;
  say(m: string): void;
  log: Logger;
  /** Tests: the fetch's clock and wait. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

interface Fetching {
  label: string;
  cancelled: boolean;
  step: number;
  command: string;
  t0: number;
  stepAt: number;
  proc?: FetchProcess;
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
    if (this.fetching) return reply(`build: fetching materials for ${this.fetching.label} (!build stop ends it)`);
    const parsed = parseSpec(args, { feet: this.h.position(), load: (n) => this.h.load(n) });
    if (!parsed.ok) return reply(`build: ${parsed.error}${parsed.error.startsWith('unknown build') ? ` (usage: !build ${BUILD_HELP})` : ''}`);
    const plan = await this.plan(parsed.spec, reply);
    if (!plan) return;
    this.lastUnknown = parsed.unknown ?? [];
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
      return this.fetchThenBuild(line, plan, m, reply);
    }
    this.start(plan, reply);
  }

  private async plan(spec: BuildSpec, reply: (m: string) => void): Promise<Plan | undefined> {
    const start = this.h.position();
    if (!start) {
      reply('build: my position is unknown');
      return undefined;
    }
    try {
      const plan = await planBuildAsync(this.h.world, spec, { start, scaffold: this.h.scaffold(), shapeOf: this.h.shapeOf });
      this.last = plan;
      this.h.log.info(`build: planned ${planLine(plan)} in ${plan.ms.toFixed(0)} ms (${plan.steps.length} steps${plan.stateful ? `, ${plan.stateful} with states, ${plan.turned ?? 0} with a turned view` : ''})`);
      if (plan.refused?.length) this.h.log.info(`build: refused ${plan.refused.map((r) => `${r.name} at ${r.pos.x} ${r.pos.y} ${r.pos.z} (${r.reason})`).join('; ')}`);
      return plan;
    } catch (e) {
      reply(`build: ${e instanceof PlanError || e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private materialsFor(plan: Plan): Materials {
    const boxed = this.h.boxed?.bind(this.h);
    return materialsOf(plan, this.h.inventory, { throwawayMin: this.h.throwawayMin() }, boxed);
  }

  /** Track B2: the bill of materials of a plan against the inventory, the boxes and the home chests. */
  billFor(plan: Plan, m: Materials = this.materialsFor(plan)): Bill {
    const need = billNeeds(plan.materials);
    if (m.scaffoldShort > 0) need.set('cobblestone', (need.get('cobblestone') ?? 0) + m.scaffoldShort);
    const r = { throwawayMin: this.h.throwawayMin() };
    const loose = new Map<string, number>();
    const names = new Set<string>(need.keys());
    for (const s of this.h.slots?.().slice(0, 36) ?? []) if (s && s.count > 0) names.add(s.name);
    for (const n of names) {
      const u = usable(this.h.inventory, n, r);
      if (u > 0) loose.set(n, u);
    }
    const boxed = new Map<string, number>();
    for (const n of need.keys()) {
      const b = this.h.boxed?.(n) ?? 0;
      if (b > 0) boxed.set(n, b);
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
    let plan = this.proc && !this.proc.done ? this.proc.runner.plan : this.last;
    let unknown = plan === this.last ? this.lastUnknown : [];
    if (args.length > 0) {
      const parsed = parseSpec(args, { feet: this.h.position(), load: (n) => this.h.load(n), allowUnknown: true });
      if (!parsed.ok) return [`build: ${parsed.error}`];
      let err = '';
      plan = await this.plan(parsed.spec, (m) => {
        err = m;
      });
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

  private start(plan: Plan, reply: (m: string) => void): void {
    if (plan.steps.length === 0) {
      reply(`build: nothing to do (${planLine(plan)})`);
      return;
    }
    const p = new BuildProcess(this.h.runner(plan));
    this.proc = p;
    reply(`building ${planLine(plan)}`);
    void p.result.then((end) => this.ended(p, end));
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
    let line: string;
    if (end.state === 'done') line = `build ${r.plan.spec.label}: done, ${progressLine(r)} in ${secs.toFixed(0)} s${rate ? ` (${rate.toFixed(0)} blocks/min)` : ''}${scaff}${skipped}${wrong}${refused}`;
    else if (end.state === 'stopped' || end.state === 'paused') line = `build ${r.plan.spec.label}: stopped at ${progressLine(r)}: ${end.state === 'stopped' ? end.reason : 'paused'}${scaff}`;
    else line = `build ${r.plan.spec.label}: ${end.reason} at ${progressLine(r)}`;
    this.ends.push(line);
    this.h.log.info(line);
    // a !stop / !build stop / replacement answers for itself; a death is said
    if (end.state !== 'cancelled' || end.reason === 'death') this.h.say(line);
  }

  stop(): string {
    const f = this.fetching;
    if (f) {
      f.cancelled = true;
      this.fetching = undefined;
      if (f.proc && !f.proc.done) this.h.processes.stop(f.proc, 'stopped');
      return `build: fetch for ${f.label} cancelled (at step ${f.step}${f.command ? `, !${f.command}` : ''})`;
    }
    const p = this.proc;
    if (!p || p.done) return 'build: nothing to stop';
    const line = `stopped build ${p.runner.plan.spec.label}: ${progressLine(p.runner)}`;
    this.h.processes.stop(p, 'stopped');
    return line;
  }

  status(): string {
    const f = this.fetching;
    if (f) return f.step ? `build: fetching materials for ${f.label}: step ${f.step}, !${f.command} (${Math.round((this.now() - f.stepAt) / 1000)} s; ${Math.round((this.now() - f.t0) / 1000)} s in all)` : `build: fetching materials for ${f.label}`;
    const p = this.proc;
    if (!p || p.done) return `build: idle${this.ends.length ? ` (last: ${this.ends[this.ends.length - 1]})` : ''}`;
    return p.statusText();
  }

  private fetchNow(): FetchNow {
    const ctx = this.h.bill?.();
    const slots = this.h.slots?.() ?? [];
    return { slots, ...(ctx?.recipes ? { recipes: ctx.recipes } : {}), ...(ctx?.chain ? { chain: ctx.chain } : {}) };
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
   * Track B2 `fetch`: the bill's commands one after the other (bill.ts nextFetchStep: bring, get, craft, furnace,
   * smelt), the bill made again after each, until nothing is missing; then plan and start the build.
   */
  private async fetchThenBuild(line: ChatLine, plan0: Plan, m0: Materials, reply: (msg: string) => void): Promise<void> {
    const spec = plan0.spec;
    let bill = this.billFor(plan0, m0);
    if (bill.cannot.length) {
      // nothing is fetched: what nothing makes, then the materials line
      for (const l of packLines(['build: nothing fetched: cannot get', ...stepWords([bill.cannot.map((c) => `${c.n} ${c.item} (${c.why})`).join(', ')])])) reply(l);
      reply(materialsLine(spec.label, m0));
      return;
    }
    const f: Fetching = { label: spec.label, cancelled: false, step: 0, command: '', t0: this.now(), stepAt: this.now() };
    this.fetching = f;
    f.proc = new FetchProcess(
      () => this.status().replace(/^build: /, 'build '),
      (reason) => {
        if (this.fetching !== f) return;
        f.cancelled = true;
        this.fetching = undefined;
        const l = `build: fetch for ${spec.label} ended at step ${f.step}: ${reason}`;
        this.ends.push(l);
        this.h.log.info(l);
        if (reason === 'death') this.h.say(l);
      },
    );
    this.h.processes.add(f.proc);
    for (const l of packLines([`build ${spec.label}: fetching first:`, ...stepWords(billSteps(bill))])) reply(l);
    const tries = new Map<string, number>();
    let stopped: string | undefined;
    for (;;) {
      if (f.cancelled || this.fetching !== f) return;
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
      const sig = `${next.command}|${this.invSignature()}`;
      if ((tries.get(sig) ?? 0) >= 1) {
        stopped = `!${next.command} changed nothing`;
        break;
      }
      tries.set(sig, 1);
      f.step++;
      f.command = next.command;
      f.stepAt = this.now();
      await this.runStep(line, next.command, f);
      if (f.cancelled || this.fetching !== f) return;
      bill = this.billFor(plan0);
    }
    this.fetching = undefined;
    f.proc.end();
    if (stopped) {
      reply(`build: fetch for ${spec.label} stopped after ${f.step} command${f.step === 1 ? '' : 's'}: ${stopped}`);
      return;
    }
    const plan = await this.plan(spec, reply);
    if (!plan) return;
    const again = this.materialsFor(plan);
    if (!again.ok) return reply(`build: still short after fetching: ${materialsLine(spec.label, again, plan.scaffolds)}`);
    this.h.log.info(`build: fetch for ${spec.label} done in ${f.step} commands, ${Math.round((this.now() - f.t0) / 1000)} s: ${this.fetched.slice(-f.step).join(' | ')}`);
    this.start(plan, reply);
  }

  dispose(): void {
    if (this.fetching) this.fetching.cancelled = true;
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
      return supplyOf(d.task); // Track BJ: registered by commands-home
    },
    tap: (p, view) => skills.tapBlock(p, view), // Track B1
    log,
  };
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
    shapeOf: (name, states) => {
      // Track B1: the registry's boxes for a planned block (a slab's top half, a stair), undefined when unknown
      try {
        const id = world.registry.stateIdOf(name, states);
        return id === undefined ? undefined : world.registry.blockInfo(id).boxes;
      } catch {
        return undefined;
      }
    },
    processes,
    runner: (plan) => new BuildRunner(plan, runnerDeps),
    dispatch: (line, command) => d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` }),
    load: (name) => loadStructure(name, dirs),
    say: (m) => d.chat.say(m),
    log,
  });
  controllers.set(d.task, c);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    c.dispose();
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
