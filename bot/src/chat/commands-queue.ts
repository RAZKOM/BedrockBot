// `!queue` and `!goals` (Track P4, ADR 0115, docs/queue.md): the job queue of the afk task and the list of standing
// goals, in the game and (the same paths) in the panel's Jobs view.
//
//   !queue                         what runs, what waits, the last ends
//   !queue add <command>           e.g. `!queue add !get kit iron`, `!queue add fly home` (the `!` is optional)
//   !queue remove <id>             a waiting job goes; the running one is stopped (its processes, its job)
//   !queue move <id> <pos>         1 = the next to run
//   !queue clear [ended]           the waiting jobs (the running one goes on); `ended`: the history
//   !queue pause | resume          no new job starts / go on
//   !queue retry <id>              an ended job again, next in line
//   !queue onfail next | stop      after a failed job: the next one runs (default) or the queue pauses
//   !goals                         the standing goals: switch, target, last run, how they share the body with the queue
//
// The queue runs each job through the chat handler as the first owner (the line the panel's commands become), keeps
// its data in <config dir>/queue/<server id>.json (BEDROCKBOT_QUEUE_DIR for tests; memory only with --no-config), and
// ticks every POLL_MS. Registered last by the afk task, so every command a job may name is there.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fromPanel } from '../events/actor.ts';
import { StandingGoals } from '../tasks/goals.ts';
import { JobQueue, POLL_MS, type JobHolder, type JobVia, type QueueData } from '../tasks/queue.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import { waypointsLocation } from '../waypoints/store.ts';
import { senderLabel, type OwnerConfig, type Sender } from './chat.ts';
import { obtainControlOf } from './commands-kit.ts';
import { mendControlOf } from './commands-mend.ts';
import { askBoxOf } from './commands-ask.ts'; // Track P5
import type { ChatLine } from './text.ts';

const queues = new WeakMap<object, JobQueue>();
const goalLists = new WeakMap<object, StandingGoals>();

/** The standing goals of a task (the panel, tests). */
export function goalsOf(task: object): StandingGoals | undefined {
  return goalLists.get(task);
}

/** The job queue of a task (the panel, tests). */
export function queueOf(task: object): JobQueue | undefined {
  return queues.get(task);
}

/** The chat line a queued job runs as: the panel's (health/panel/index.ts panelLine): the first owner name, else the first owner XUID, else the console. */
export function ownerLine(owners: OwnerConfig, text: string): ChatLine | undefined {
  const name = owners.names[0];
  if (name) return { type: 'chat', source: name, message: text, body: text, xuid: '', truth: false };
  const xuid = owners.xuids[0];
  if (xuid) return { type: 'chat', source: 'panel', message: text, body: text, xuid, truth: false };
  if (owners.allowConsole) return { type: 'announcement', source: 'Server', message: `[Server] ${text}`, body: text, xuid: '', truth: false };
  return undefined;
}

/** Where the queue is kept: BEDROCKBOT_QUEUE_DIR/<server>.json, else <config dir>/queue/<server>.json, else memory only. */
export function queueFileOf(values: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!values) return undefined;
  const loc = waypointsLocation(values, env);
  const name = `${loc.server.replace(/[^\w.-]/g, '_')}.json`;
  if (env.BEDROCKBOT_QUEUE_DIR) return join(env.BEDROCKBOT_QUEUE_DIR, name);
  return loc.file ? join(dirname(dirname(loc.file)), 'queue', basename(name)) : undefined;
}

/** The saved queue, or undefined (no file, unreadable: an empty queue, logged). */
export function loadQueueFile(file: string | undefined, warn: (m: string) => void = () => undefined): QueueData | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as QueueData;
    if (d?.v === 1 && Array.isArray(d.jobs)) return d;
    warn(`queue: ${file} is not a queue file (v 1): starting empty`);
  } catch (e) {
    warn(`queue: ${file} could not be read (${e instanceof Error ? e.message : String(e)}): starting empty`);
  }
  return undefined;
}

/** Written atomically (a temp file, then a rename). */
export function saveQueueFile(file: string, d: QueueData): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(d, null, 1)}\n`);
  renameSync(tmp, file);
}

const viaOf = (sender: Sender): JobVia => (fromPanel() ? 'panel' : sender.kind === 'console' ? 'console' : 'chat');

export const QUEUE_HELP = 'add <command> | remove <id> | move <id> <pos> | clear [ended] | pause | resume | retry <id> | onfail next|stop';

export interface QueueExtra {
  /** The CLI values (the config file locates the queue file). */
  values?: Readonly<Record<string, unknown>>;
  /** A file of its own (tests). */
  file?: string;
}

export function registerQueueCommands(d: CommandDeps, extra: QueueExtra = {}): JobQueue | undefined {
  const { processes, mobility } = d;
  if (!processes || !mobility) {
    d.chat.register({ name: 'queue', help: '(needs walking)', run: ({ reply }) => reply(d.needsWalking('queue')) });
    return undefined;
  }
  const task = d.task;
  const file = extra.file ?? queueFileOf(extra.values);
  const saved = loadQueueFile(file, (m) => d.log.warn(m));
  // the multi-step jobs: their processes come and go between steps, the job object stays until its end line
  const holders: JobHolder[] = [
    {
      name: 'get',
      current: () => obtainControlOf(task)?.job,
      end: (j) => (j as { result?: Promise<string> }).result,
      stop: () => void obtainControlOf(task)?.stop(),
      status: () => obtainControlOf(task)?.status(),
    },
    {
      name: 'mend',
      current: () => mendControlOf(task)?.job(),
      stop: (j) => {
        (j as { aborted?: string }).aborted = '!queue remove';
      },
      status: (j) => `mend: ${(j as { phase?: string }).phase ?? 'running'}`,
    },
  ];
  const queue = new JobQueue(
    {
      run: (command) => {
        const line = ownerLine(d.chat.owners, command);
        if (!line) return false;
        d.chat.handle(line); // not typed: the queue's own dispatch
        return true;
      },
      has: (name) => d.chat.has(name),
      prefix: d.chat.prefix,
      userProcesses: () => processes.userProcesses(),
      stopProcess: (p) => void processes.stop(p, 'stopped'),
      active: () => processes.active,
      holders,
      ready: () => d.conn.state === 'spawned' && mobility.loop.state.ready && (task.alive?.() ?? true),
      dead: () => d.conn.state === 'spawned' && task.alive?.() === false,
      say: (m) => void d.chat.sayKept(m),
      save: (data) => {
        if (file) saveQueueFile(file, data);
      },
      log: d.log,
      // Track P5 (ADR 0116): askOwner asks after a failed job; `!yes` / `!no` taken by a question do not pause the queue
      ask: (spec) => (d.settings.get('askOwner') ? askBoxOf(task)?.ask({ ...spec, waitMs: Number(d.settings.get('askWaitS')) * 1000 }).answer : undefined),
      isAnswer: (name) => (name === 'yes' || name === 'no') && askBoxOf(task)?.takes(name) !== undefined,
    },
    saved,
  );
  d.log.info(`queue: ${file ? `kept in ${file}` : 'in memory only (--no-config)'}${saved ? ` (${queue.waiting().length} waiting, ${queue.paused ? 'paused' : 'not paused'})` : ''}`);
  const goals = new StandingGoals({
    task,
    settings: (k) => d.settings.get(k),
    processes,
    queue: () => ({ running: queue.runningJob() !== undefined, waiting: queue.waiting().length }),
  });
  queues.set(task, queue);
  goalLists.set(task, goals);

  // every reply: the running job keeps them for its end line
  const say = d.chat.say.bind(d.chat);
  d.chat.say = (m: string) => {
    queue.observeReply(m);
    return say(m);
  };
  // a command the owner typed (the game, the panel) that does work pauses the queue
  const offCommand = d.chat.onCommand((e) => {
    if (e.kind === 'run' && e.typed) queue.onTyped(e.name, e.args ?? []);
  });
  const timer = setInterval(() => {
    try {
      queue.tick();
      goals.sweep();
    } catch (e) {
      d.log.warn(`queue: tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, POLL_MS);
  timer.unref?.();
  // `!status`: the queue's line under the process stack while it holds anything
  const lines = task.processLines?.bind(task);
  if (lines) {
    task.processLines = () => {
      const v = queue.view(0);
      return [...lines(), ...(v.running || v.waiting.length ? [queue.lines()[0]!] : [])];
    };
  }
  const stop = task.stop.bind(task);
  task.stop = () => {
    clearInterval(timer);
    offCommand();
    goals.dispose();
    queues.delete(task);
    goalLists.delete(task);
    stop();
  };

  d.chat.register({
    name: 'queue',
    help: `[${QUEUE_HELP}] (jobs run one after another, each as if typed when the one before ended; a command typed meanwhile pauses the queue)`,
    tier: 'more',
    group: 'control',
    example: '!queue add !get kit iron',
    auto: 'the next queued job starts by itself once the bot has been free 5 s (a chore runs first when it is due); a job left running at a restart is not run again',
    run: ({ reply, args, sender }) => {
      const a = (args[0] ?? '').toLowerCase();
      const id = Number(args[1]);
      const who = senderLabel(sender);
      if (a === '' || a === 'list' || a === 'status') {
        for (const l of queue.lines()) reply(l);
        return;
      }
      if (a === 'add') {
        const r = queue.add(args.slice(1).join(' '), who, viaOf(sender));
        reply(r.ok ? `queue: added #${r.job.id} ${r.job.command} (${r.pos} of ${queue.waiting().length}${queue.paused ? '; the queue is paused: !queue resume' : ''})` : `queue: ${r.why}`);
        return;
      }
      if (a === 'remove' || a === 'rm' || a === 'del') {
        reply(Number.isInteger(id) ? queue.remove(id, who) : 'usage: !queue remove <id>');
        return;
      }
      if (a === 'move') {
        const pos = Number(args[2]);
        reply(Number.isInteger(id) && Number.isFinite(pos) ? queue.move(id, pos) : 'usage: !queue move <id> <pos> (1 = next)');
        return;
      }
      if (a === 'clear') {
        reply(queue.clear((args[1] ?? '').toLowerCase() === 'ended'));
        return;
      }
      if (a === 'pause') {
        reply(queue.pause(`!queue pause by ${who}`));
        return;
      }
      if (a === 'resume') {
        reply(queue.resume());
        return;
      }
      if (a === 'retry') {
        if (!Number.isInteger(id)) {
          reply('usage: !queue retry <id>');
          return;
        }
        const r = queue.retry(id, who, viaOf(sender));
        reply(r.ok ? `queue: #${id} again as #${r.job.id} ${r.job.command} (next)` : r.why);
        return;
      }
      if (a === 'onfail') {
        const v = (args[1] ?? '').toLowerCase();
        reply(v === 'next' || v === 'stop' ? queue.setOnFail(v) : `queue: after a failed job ${queue.onFail === 'next' ? 'the next one runs' : 'the queue pauses'} (usage: !queue onfail next|stop)`);
        return;
      }
      reply(`usage: !queue [${QUEUE_HELP}]`);
    },
  });
  d.chat.register({
    name: 'goals',
    help: '(what the bot keeps up by itself: each chore with its setting, target, last run, and whether it waits for the queue)',
    tier: 'more',
    group: 'info',
    example: '!goals',
    auto: 'each goal switched on runs by itself when the bot is free (its own setting: autoFood, autoMilk, autoRockets, ...)',
    run: ({ reply }) => {
      const parts = goals.parts();
      let line = 'goals:';
      for (const p of parts) {
        if (line.length + p.length + 2 > 240) {
          reply(line);
          line = 'goals:';
        }
        line += `${line === 'goals:' ? ' ' : '; '}${p}`;
      }
      reply(`${line}; !set <setting> on|off switches one`);
    },
  });
  return queue;
}
