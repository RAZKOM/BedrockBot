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
import { silentLogger, type Logger } from '../log.ts';
import type { ChainOptions } from '../skills/craft/chain.ts';
import { EARLY_KIT, foodCarried, itemAlias, nextAction, type ObtainAction, type ObtainTarget } from '../skills/items/obtain.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { Process, ProcessManager } from '../tasks/process/manager.ts';
import { craftControlOf } from './commands-craft.ts';
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
/** Poll period while a step runs (ms). */
const POLL_MS = 500;

/** The process each step command starts. */
const STEP_PROCESS: Readonly<Record<string, string>> = { gather: 'gather', mine: 'mine', kill: 'kill', food: 'food', craft: 'craft' };
/** Owner commands that end the job (they move the bot or start other work); `!get` replaces it itself. */
export const OBTAIN_ABORT_ON: ReadonlySet<string> = new Set(['stop', 'goto', 'come', 'follow', 'kill', 'gather', 'mine', 'farm', 'food', 'sleep', 'home', 'top', 'fly', 'land', 'nether', 'overworld', 'craft', 'explore', 'quarry', 'tunnel', 'build', 'bring', 'unload', 'milk', 'rockets']);

type Slots = readonly (ItemStack | null | undefined)[];

export interface ObtainHost {
  /** Run a command as the owner who typed `line` (`mine stone 3`, no prefix). */
  dispatch(line: ChatLine, command: string): void;
  processes: Pick<ProcessManager, 'userProcesses' | 'stop'>;
  slots(): Slots;
  recipes: Parameters<typeof nextAction>[0];
  /** The crafter's plan options (kept items, reserves) and whether a table stands near. */
  options(): ChainOptions;
  onCommand(fn: (e: CommandEvent) => void): () => void;
  wait(ms: number): Promise<void>;
  now?(): number;
  log?: Logger;
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
  /** Resolves with the end line. */
  result: Promise<string>;
}

/** Item counts of the main inventory (0 to 35). */
function counts(slots: Slots): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s && s.count > 0) m.set(s.name, (m.get(s.name) ?? 0) + s.count);
  }
  return m;
}

/** Items gained between two counts (what was crafted away is not a loss here: any new item counts). */
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
    return { label: name, targets: [{ item: name, n: n ?? 1 }] };
  }

  /**
   * The first step for `targets`, without running it: undefined when it can start, else the refusal (`no recipe`,
   * done already, no rule for a material).
   */
  check(targets: readonly ObtainTarget[]): ObtainAction {
    return nextAction(this.h.recipes, targets, this.h.slots(), this.h.options());
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
    const carried = (t: ObtainTarget) => t.item !== 'food' && this.h.slots().some((s) => s?.name === t.item && s.count >= t.n);
    const want = targets.filter((t) => !carried(t));
    reply(`getting ${label === 'kit' ? `the kit (${targetsText(want)})` : targetsText(want)}: first !${first.command}`);
    let resolve!: (s: string) => void;
    const job: ObtainJob = { label, targets, startedAt: this.now(), steps: [], step: undefined, process: undefined, aborted: undefined, result: new Promise((r) => (resolve = r)) };
    this.job = job;
    void this.run(line, job).then(
      (end) => {
        if (this.job === job) this.job = undefined;
        this.last = { label, line: end };
        this.log.info(end);
        if (!job.silent) reply(end);
        resolve(end);
      },
      (e: unknown) => {
        if (this.job === job) this.job = undefined;
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
    for (let i = 0; i < OBTAIN_MAX_STEPS; i++) {
      if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}`;
      const a = nextAction(this.h.recipes, job.targets, this.h.slots(), this.h.options());
      if (a.kind === 'done') return `${head()}: done in ${took()} (${list()})`;
      if (a.kind === 'stuck') return `${head()}: stopped after ${took()}: ${a.reason}`;
      job.step = a;
      const before = counts(this.h.slots());
      const t0 = this.now();
      const reply = await this.step(line, job, a.command);
      const g = gained(before, counts(this.h.slots()));
      job.steps.push({ command: a.command, ms: this.now() - t0, reply, gained: g });
      this.log.info(`${head()}: !${a.command} -> ${g} items gained in ${Math.round((this.now() - t0) / 100) / 10} s${reply ? ` (${reply})` : ''}`);
      if (job.aborted) return `${head()}: stopped by ${job.aborted} after ${took()}`;
      const why = reply ? ` (${reply.length > 120 ? `${reply.slice(0, 117)}...` : reply})` : '';
      // food is the last step and some is carried: done, with what is short (no animals left near is common by day one)
      if (g === 0 && a.kind === 'food' && foodCarried(this.h.slots()) > 0) return `${head()}: done in ${took()} (${list()}); food ${foodCarried(this.h.slots())} of ${job.targets.find((t) => t.item === 'food')?.n ?? 0}: !${a.command} got nothing${why}`;
      if (g === 0) return `${head()}: stopped after ${took()}: !${a.command} got nothing${why}`;
    }
    return `${head()}: stopped after ${took()}: ${OBTAIN_MAX_STEPS} steps and not done`;
  }

  /** Dispatch one command, wait for its process to end; the last reply seen meanwhile. */
  private async step(line: ChatLine, job: ObtainJob, command: string): Promise<string | undefined> {
    const name = STEP_PROCESS[command.split(' ')[0]!];
    const before = new Set(this.h.processes.userProcesses());
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
      while (!p.done && !job.aborted && this.now() - t0 < OBTAIN_STEP_MS) await this.h.wait(POLL_MS);
      if (!p.done) {
        this.h.processes.stop(p, 'stopped');
        job.aborted ??= `the step's ${Math.round(OBTAIN_STEP_MS / 60_000)}-minute limit (!${command})`;
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
    const s = j.step && j.step.kind !== 'done' && j.step.kind !== 'stuck' ? `!${j.step.command}` : 'planning';
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
export function registerKitCommands(d: CommandDeps): ObtainController | undefined {
  const get = getControllerOf(d.task);
  const craft = craftControlOf(d.task);
  const world = d.mobility?.world;
  if (!get || !craft || !world || !d.processes) return undefined;
  const c = new ObtainController({
    dispatch: (line, command) => d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` }),
    processes: d.processes,
    slots: () => world.inventory.slots,
    recipes: craft.recipes,
    options: () => craft.chainOptions(),
    onCommand: (fn) => d.chat.onCommand(fn),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: d.log,
  });
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
      if (!isKit && craft.recipes.byOutput(item).length === 0) return false;
      const { label, targets } = ObtainController.targetsFor(isKit ? 'kit' : item, n);
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

/** Words of `!get` that name the early kit. */
export function kitWords(args: readonly string[]): boolean {
  const w = args.map((a) => a.toLowerCase());
  return w[0] === 'kit' && (w.length === 1 || (w.length === 2 && (w[1] === 'early' || w[1] === 'starter')));
}