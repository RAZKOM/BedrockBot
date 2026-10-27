// `!get <item> [n]` (wave 8, Track AD; docs/get.md), owner-only like every command: one front door
// to gathering, mining, hunting and farming. The catalog (skills/items/catalog.ts) says how an item
// is got; the command runs the existing command for it as the owner (`!gather 16`, `!mine coal_ore 8`,
// `!food 6`, `!kill spider 6`, `!farm`), so the processes, their replies and !stop work as before:
//
//   !get <item> [n] | [n] <item>    getting 16 oak_log: gathering wood    (then the command's own replies)
//   !get stop                       stops whichever job `!get` started (or any gather / mine / food / farm)
//   !get status                     get: 4 coal via !mine coal_ore 4: mine coal_ore 2/4 (dig, 0 skipped); stash: ...
//   !get bread                      get: I do not know how to get bread; I can get: wood (...), ores (...), ...
//
// Farming runs one round of the field around the bot (until nothing is left to do), or until n of
// that crop were harvested, then the farm process is stopped. The stash step (skills/container/
// stash.ts) is built here once per bot on the task's shared Containers and registered for the work
// processes (mine and food find it through the ProcessManager, the gather task gets it set); a
// control change of the manager (guard, flee, night, a new command) cancels a running stash step.
import type { Containers } from '../world/containers.ts';
import type { Logger } from '../log.ts';
import { setStash, Stash, stashFor, stepLine } from '../skills/container/stash.ts';
import { lookup, parseGetArgs, unknownReply, type Lookup } from '../skills/items/catalog.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { settingsMover } from '../tasks/process/goto.ts';
import type { Process, ProcessManager } from '../tasks/process/manager.ts';
import type { ChatLine } from './text.ts';
import { survivalKitOf } from './commands-survival.ts';

/** The processes `!get` may start (by the command it runs). */
export const GET_PROCESSES: Record<string, string> = { gather: 'gather', mine: 'mine', food: 'food', kill: 'kill', farm: 'farm' };
/** Farm: how often the round / crop count is checked (ms). */
const FARM_CHECK_MS = 1000;

export interface GetExtra {
  /** The afk task's shared Containers (the stash step counts its round trips on it). */
  containers?: Containers | undefined;
  /** Logger for the stash and get lines. */
  logger?: Logger | undefined;
}

type Found = Extract<Lookup, { command: string }>;

export interface GetJob {
  item: Found;
  /** `mine coal_ore 4` */
  command: string;
  process: Process | undefined;
  startedAt: number;
  timer?: ReturnType<typeof setInterval> | undefined;
}

/** `getting 16 oak_log: gathering wood (any log kind counts)` */
export function startLine(f: Found): string {
  const what = f.strategy === 'farm' && f.count === 0 ? f.item : `${f.count} ${f.item}`;
  const how = f.strategy === 'farm' && f.count === 0 ? `${f.doing} (one round of the field)` : f.doing;
  return `getting ${what}: ${how}${f.note ? ` (${f.note})` : ''}`;
}

/** Everything `!get` needs from the bot, faked in the unit tests. */
export interface GetHost {
  /** Run a chat command as the owner who typed `line` (`mine coal_ore 4`, no prefix). */
  dispatch(line: ChatLine, command: string): void;
  processes: Pick<ProcessManager, 'userProcesses' | 'stop' | 'find'>;
  stash?: Stash | undefined;
}

export class GetController {
  private readonly h: GetHost;
  job: GetJob | undefined;

  constructor(h: GetHost) {
    this.h = h;
  }

  /** `!get <args>`: the reply (the command it runs then answers for itself). */
  run(line: ChatLine, args: readonly string[], reply: (m: string) => void): void {
    const a = (args[0] ?? '').toLowerCase();
    if (args.length === 0) return reply('usage: !get <item> [n] | stop | status');
    if (args.length === 1 && a === 'stop') return reply(this.stop());
    if (args.length === 1 && a === 'status') return reply(this.status());
    const p = parseGetArgs(args);
    if ('error' in p) return reply(`usage: !get <item> [n] (${p.error})`);
    const f = lookup(p.name, p.count);
    if (f.strategy === 'unknown') return reply(unknownReply(f.name));
    this.clearJob();
    reply(startLine(f));
    const kind = f.command.split(' ')[0]!;
    const before = new Set(this.h.processes.userProcesses());
    this.h.dispatch(line, f.command);
    const started = this.h.processes.userProcesses().find((x) => !before.has(x) && x.name === GET_PROCESSES[kind]);
    const job: GetJob = { item: f, command: f.command, process: started, startedAt: Date.now() };
    this.job = job;
    if (f.strategy === 'farm' && started) job.timer = setInterval(() => this.checkFarm(job, reply), FARM_CHECK_MS);
  }

  /** Farm: one round of the field, or n of the crop harvested: stop the farm process. */
  private checkFarm(job: GetJob, reply: (m: string) => void): void {
    const p = job.process;
    const task = (p as unknown as { task?: { state: string; stats: { harvested: number; harvestedByCrop: Record<string, number>; rounds: number } } } | undefined)?.task;
    if (!p || p.done || !task) return this.clearJob(job);
    const st = task.stats;
    const got = st.harvestedByCrop[job.item.target ?? ''] ?? 0;
    const want = job.item.count;
    const enough = want > 0 ? got >= want : task.state === 'waiting' && st.rounds >= 1;
    if (!enough) return;
    this.h.processes.stop(p, 'stopped');
    this.clearJob(job);
    reply(`get ${job.item.item}: ${got} ${job.item.target ?? ''} harvested (${st.harvested} crops in all)${want > 0 ? '' : ', the field is done'}`);
  }

  private clearJob(job: GetJob | undefined = this.job): void {
    if (job?.timer) clearInterval(job.timer);
    if (job) job.timer = undefined;
  }

  /** The process `!get` started, if it still runs; else any running gather / mine / food / farm. */
  private running(): Process | undefined {
    const p = this.job?.process;
    if (p && !p.done) return p;
    const names = new Set(Object.values(GET_PROCESSES));
    return this.h.processes.userProcesses().find((x) => names.has(x.name) && !x.done);
  }

  stop(): string {
    const p = this.running();
    this.clearJob();
    if (!p) return 'get: nothing to stop';
    const line = p.status().line;
    this.h.processes.stop(p, 'stopped');
    return `stopped ${line}`;
  }

  status(): string {
    const p = this.running();
    const s = this.h.stash;
    const last = s?.attempts[s.attempts.length - 1];
    const stash = s ? `; stash: ${s.stats.attempts} attempts (${s.stats.ok} ok, ${s.stats.full} full)${last ? `, last: ${last.steps.map(stepLine).join('; ') || 'nothing to move'}` : ''}` : '';
    if (!p) return `get: idle${this.job ? ` (last: ${this.job.item.count || ''} ${this.job.item.item} via !${this.job.command})` : ''}${stash}`;
    const job = this.job;
    const j = job?.process === p ? `${job.item.count || ''} ${job.item.item} via !${job.command}: ` : '';
    return `get: ${j}${p.status().line}${stash}`;
  }

  dispose(): void {
    this.clearJob();
  }
}

/** Every controller by task (tests and !status). */
const controllers = new WeakMap<object, GetController>();

export function getControllerOf(task: object): GetController | undefined {
  return controllers.get(task);
}

/**
 * Register `!get` on the afk task (tasks/registry.ts, one line) and build the bot's stash step.
 * Without walking it answers `get needs a task that can walk`.
 */
export function registerGetCommands(d: CommandDeps, extra: GetExtra = {}): GetController | undefined {
  const { processes, mobility: mob } = d;
  if (!processes || !mob) {
    d.chat.register({ name: 'get', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('get')) });
    return undefined;
  }
  const log = extra.logger ?? d.log;
  const world = mob.world;
  const stash =
    stashFor(processes) ??
    new Stash({
      skills: settingsMover(mob.skills, d.settings),
      inventory: world.inventory,
      blockAt: (p) => world.blockAt(p),
      position: () => mob.position(),
      settings: d.settings,
      ...(extra.containers ? { containers: extra.containers } : {}),
      drop: (name) => survivalKitOf(d.task)?.drop(name) ?? Promise.resolve({ ok: false, dropped: 0, reason: 'no survival kit' }),
      log,
      say: (m) => d.chat.say(m),
    });
  setStash(processes, stash);
  // a pre-emption (guard, flee, night) or a new command moves control: the stash step stops
  const offControl = processes.onControl(() => {
    if (stash.busy) stash.cancel();
  });
  const g = d.task.gather?.task;
  if (g) g.stash = { ifFull: (job) => stash.ifFull(job) };
  const c = new GetController({
    dispatch: (line, command) => d.chat.handle({ ...line, body: `${d.chat.prefix}${command}`, message: `${d.chat.prefix}${command}` }),
    processes,
    stash,
  });
  controllers.set(d.task, c);
  const stop = d.task.stop.bind(d.task);
  d.task.stop = () => {
    c.dispose();
    offControl();
    stop();
  };
  d.chat.register({
    name: 'get',
    help: '<item> [n] | stop | status (wood, ores, stone, dirt, sand, food, crops ...: picks gather / mine / food / farm)',
    run: ({ line, args, reply }) => {
      c.run(line, args, reply);
    },
  });
  log.info('get: !get and the stash step ready');
  return c;
}
