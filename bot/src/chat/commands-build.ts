// `!build` (wave 9, Track AL; docs/build.md), owner-only like every command: the builder.
//
//   !build fill x1 y1 z1 x2 y2 z2 <block> [fetch]       building fill 5x3x5 cobblestone: 75 to place, ...
//   !build clear x1 y1 z1 x2 y2 z2                      building clear 5x3x5: 75 to dig
//   !build replace x1 y1 z1 x2 y2 z2 <from> <to> [fetch]
//   !build wall x1 y z1 x2 z2 <height> <block> [fetch] | floor x1 y z1 x2 z2 <block> [fetch] | pillar x y z <height> <block> [fetch]
//   !build file <name> [x y z] [0|90|180|270] [fetch]   a structure file (.mcstructure or the JSON layer format)
//   !build materials [<build>]                          materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone
//   !build status                                       build: 212 / 640 placed, 3 skipped, eta 4 min
//   !build stop                                         stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped
//
// A build runs as a user process (tasks/process/build.ts): guard, flee and night pre-empt it, `!pause`
// holds it, `!stop` ends it. Missing blocks refuse the build (`fetch` runs `!get` for them first, as
// the owner, through the chat handler, then starts the build once those jobs ended).
import type { ChatLine } from './text.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { BuildProcess, type BuildEnd } from '../tasks/process/build.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import type { ProcessManager } from '../tasks/process/manager.ts';
import { buildDirs, loadStructure } from '../skills/build/formats/index.ts';
import { materialsLine, materialsOf, type Materials } from '../skills/build/materials.ts';
import { planBuildAsync, planLine, PlanError, type Plan } from '../skills/build/plan.ts';
import { BuildRunner, etaText, progressLine, type RunnerDeps } from '../skills/build/runner.ts';
import type { BlockReader } from '../skills/build/sim.ts';
import { BUILD_USAGE, parseSpec } from '../skills/build/spec.ts';
import type { BuildSpec, Cell } from '../skills/build/types.ts';
import { lookup } from '../skills/items/catalog.ts';
import { supplyOf } from '../skills/supply/supply.ts'; // Track BJ
import type { Logger } from '../log.ts';

export const BUILD_HELP = 'fill|clear|replace|wall|floor|pillar|file ... [fetch]; materials, status, stop (builds walls, floors, boxes, saved structures)';
/** How long `fetch` waits for the `!get` jobs (ms). */
const FETCH_TIMEOUT_MS = 30 * 60_000;
const FETCH_POLL_MS = 1000;
/** Processes a `!get` may start (commands-get GET_PROCESSES; farm never ends by itself and is not used for fetching). */
const FETCH_PROCESSES = new Set(['gather', 'mine', 'food', 'kill']);

/** What the controller needs from the bot (faked in the unit tests). */
export interface BuildHost {
  world: BlockReader;
  position(): Cell | undefined;
  inventory: { count(name: string): number };
  /** Track BJ: items of a kind inside the carried shulker boxes (the task's Supply); the materials count them. */
  boxed?(name: string): number;
  throwawayMin(): number;
  scaffold(): boolean;
  processes: Pick<ProcessManager, 'add' | 'stop' | 'find' | 'userProcesses'>;
  /** A runner for a plan (wired to the bot's skills). */
  runner(plan: Plan): BuildRunner;
  /** Run a chat command as the owner who typed `line` (no prefix). */
  dispatch(line: ChatLine, command: string): void;
  /** Load a structure file by name. */
  load(name: string): ReturnType<typeof loadStructure>;
  say(m: string): void;
  log: Logger;
}

export class BuildController {
  private readonly h: BuildHost;
  /** The last plan (for `!build materials` without arguments). */
  last: Plan | undefined;
  /** The process of the running build. */
  proc: BuildProcess | undefined;
  /** A `fetch` in progress. */
  private fetching: { label: string; cancelled: boolean } | undefined;
  /** Every build's end line, newest last (tests, status). */
  readonly ends: string[] = [];

  constructor(h: BuildHost) {
    this.h = h;
  }

  async run(line: ChatLine, args: readonly string[], reply: (m: string) => void): Promise<void> {
    const a = (args[0] ?? '').toLowerCase();
    if (args.length === 0) return reply(`usage: !build ${BUILD_HELP}`);
    if (a === 'stop' && args.length === 1) return reply(this.stop());
    if (a === 'status' && args.length === 1) return reply(this.status());
    if (a === 'materials') return reply(await this.materials(args.slice(1)));
    const parsed = parseSpec(args, { feet: this.h.position(), load: (n) => this.h.load(n) });
    if (!parsed.ok) return reply(`build: ${parsed.error}${parsed.error.startsWith('unknown build') ? ` (usage: !build ${BUILD_HELP})` : ''}`);
    const plan = await this.plan(parsed.spec, reply);
    if (!plan) return;
    const m = this.materialsFor(plan);
    if (!m.ok) {
      if (!parsed.fetch) return reply(`build: ${materialsLine(plan.spec.label, m, plan.scaffolds).replace(/^materials for /, '')} (add fetch to get them with !get first)`);
      return this.fetchThenBuild(line, parsed.spec, m, reply);
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
      const plan = await planBuildAsync(this.h.world, spec, { start, scaffold: this.h.scaffold() });
      this.last = plan;
      this.h.log.info(`build: planned ${planLine(plan)} in ${plan.ms.toFixed(0)} ms (${plan.steps.length} steps)`);
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

  /** `!build materials [<build>]`. */
  async materials(args: readonly string[]): Promise<string> {
    let plan = this.proc && !this.proc.done ? this.proc.runner.plan : this.last;
    if (args.length > 0) {
      const parsed = parseSpec(args, { feet: this.h.position(), load: (n) => this.h.load(n) });
      if (!parsed.ok) return `build: ${parsed.error}`;
      let err = '';
      plan = await this.plan(parsed.spec, (m) => {
        err = m;
      });
      if (!plan) return err;
    }
    if (!plan) return `build: no build yet (usage: !build materials <${Object.values(BUILD_USAGE)[0]}|...>)`;
    if (plan.spec.kind === 'clear') return `materials for ${plan.spec.label}: nothing (${plan.work} to dig)`;
    return materialsLine(plan.spec.label, this.materialsFor(plan), plan.scaffolds);
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
    let line: string;
    if (end.state === 'done') line = `build ${r.plan.spec.label}: done, ${progressLine(r)} in ${secs.toFixed(0)} s${rate ? ` (${rate.toFixed(0)} blocks/min)` : ''}${scaff}${skipped}`;
    else if (end.state === 'stopped' || end.state === 'paused') line = `build ${r.plan.spec.label}: stopped at ${progressLine(r)}: ${end.state === 'stopped' ? end.reason : 'paused'}${scaff}`;
    else line = `build ${r.plan.spec.label}: ${end.reason} at ${progressLine(r)}`;
    this.ends.push(line);
    this.h.log.info(line);
    // a !stop / !build stop / replacement answers for itself; a death is said
    if (end.state !== 'cancelled' || end.reason === 'death') this.h.say(line);
  }

  stop(): string {
    if (this.fetching) {
      this.fetching.cancelled = true;
      const l = this.fetching.label;
      this.fetching = undefined;
      return `build: fetch for ${l} cancelled`;
    }
    const p = this.proc;
    if (!p || p.done) return 'build: nothing to stop';
    const line = `stopped build ${p.runner.plan.spec.label}: ${progressLine(p.runner)}`;
    this.h.processes.stop(p, 'stopped');
    return line;
  }

  status(): string {
    if (this.fetching) return `build: fetching materials for ${this.fetching.label} (!get)`;
    const p = this.proc;
    if (!p || p.done) return `build: idle${this.ends.length ? ` (last: ${this.ends[this.ends.length - 1]})` : ''}`;
    return p.statusText();
  }

  /** `fetch`: `!get` every missing block (one after the other), then plan and start the build. */
  private async fetchThenBuild(line: ChatLine, spec: BuildSpec, m: Materials, reply: (msg: string) => void): Promise<void> {
    const missing = m.lines.filter((l) => l.missing > 0);
    if (m.scaffoldShort > 0) missing.push({ item: 'cobblestone', need: m.scaffoldShort, have: 0, missing: m.scaffoldShort });
    const unknown = missing.filter((l) => lookup(l.item, l.missing).strategy === 'unknown' || lookup(l.item).strategy === 'farm');
    if (unknown.length) return reply(`build: cannot fetch ${unknown.map((u) => u.item).join(', ')} (!get does not know how); ${materialsLine(spec.label, m)}`);
    const f = { label: spec.label, cancelled: false };
    this.fetching = f;
    reply(`build ${spec.label}: fetching ${missing.map((l) => `${l.missing} ${l.item}`).join(', ')} with !get first`);
    for (const l of missing) {
      if (f.cancelled) return;
      const before = new Set(this.h.processes.userProcesses());
      this.h.dispatch(line, `get ${l.item} ${l.missing}`);
      const started = this.h.processes.userProcesses().filter((p) => !before.has(p) && FETCH_PROCESSES.has(p.name));
      const t0 = Date.now();
      while (!f.cancelled && started.some((p) => !p.done) && Date.now() - t0 < FETCH_TIMEOUT_MS) await new Promise((r) => setTimeout(r, FETCH_POLL_MS));
    }
    if (f.cancelled || this.fetching !== f) return;
    this.fetching = undefined;
    const plan = await this.plan(spec, reply);
    if (!plan) return;
    const again = this.materialsFor(plan);
    if (!again.ok) return reply(`build: still short after fetching: ${materialsLine(spec.label, again, plan.scaffolds)}`);
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
    log,
  };
  const c = new BuildController({
    world: { blockAt: (p) => world.blockAt(p) },
    position: () => mob.position(),
    inventory: world.inventory,
    boxed: (name) => supplyOf(d.task)?.carried(name) ?? 0, // Track BJ
    throwawayMin: () => d.settings.get('throwawayMin'),
    scaffold: () => d.settings.get('buildScaffold'),
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
