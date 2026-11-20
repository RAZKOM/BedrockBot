// The job queue (Track P4, ADR 0115, docs/queue.md): an ordered list of the owner's commands that the bot runs one
// after another, as if the owner typed each one when the one before it had ended. It lives in the bot, not in the
// page: the chat (`!queue`, chat/commands-queue.ts) and the panel's Jobs view (health/panel/jobs.ts) use the same
// object, and it is kept in the config directory across restarts.
//
//   const q = new JobQueue(ports);              // ports: run a command as the owner, the process manager, the jobs
//   q.add('!get kit iron', 'Steve', 'chat');    // refused at once for what cannot be queued (QUEUE_REFUSE)
//   q.tick(now);                                // every POLL_MS: start the next job, watch the running one
//
// Rules (each has its reason in docs/queue.md):
// - A job is a command line the chat already understands. It runs through the chat handler as the first owner, so
//   it does exactly what the typed command does; the process manager's priorities (flee, guard, the night, the
//   reflex, the flight) stay as they are: the queue never moves the body itself.
// - One job at a time. The next starts only when the bot is free: no user process, no multi-step job (the obtain
//   job, `!mend`), nothing auto in control (a fight, the night, a chore, the walk home), and it has been free for
//   GAP_MS, so a due chore takes its turn between two jobs. A chore or the walk home that holds the bot longer than
//   HOLD_MAX_MS is pre-empted by the next job (as a typed command would); a fight, a flight and the night never are.
// - A job's end: the work it started (the user processes added after its dispatch, or the obtain or mend job it
//   started) has gone and stayed gone SETTLE_MS; a command that starts no work ends when its reply has come and
//   REPLY_QUIET_MS passed (or START_MAX_MS with no reply). The state comes from the process's result (events/jobs.ts
//   outcomeOf), the obtain job's end line, else the reply's words (lineState).
// - A command the owner types (in the game or the panel) that does work pauses the queue and says so; the running
//   job is left to the process manager (a newer command stacks over it or replaces it) and is watched to its end.
// - A job that fails: the next one runs (onFail `next`, the default), or the queue pauses (`stop`).
// - A restart: the job that was running is not run again (it may have half done its work): it is ended `cancelled`
//   with the reason, and the queue goes on by its onFail rule (`!queue retry <id>` puts it back).
import { outcomeOf, type JobOutcome } from '../events/jobs.ts';
import { silentLogger, type Logger } from '../log.ts';
import { PRIORITY, type Process } from './process/manager.ts';

export type JobState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type JobVia = 'chat' | 'panel' | 'console';
/** How a job's end was known: its processes, a multi-step job's end line, its reply, or the queue ended it. */
export type JobEndHow = 'process' | 'job' | 'reply' | 'restart' | 'limit' | 'removed' | 'none';
export type OnFail = 'next' | 'stop';

export interface QueueJob {
  id: number;
  /** The command line as it runs (`!get kit iron`). */
  command: string;
  /** Who added it (`Steve`, `console`). */
  by: string;
  via: JobVia;
  addedAt: number;
  state: JobState;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  /** The end line: the last reply of the job, or what the queue saw. */
  end?: string | undefined;
  how?: JobEndHow | undefined;
}

/** What the file keeps (and a restart reads). */
export interface QueueData {
  v: 1;
  paused: boolean;
  why?: string | undefined;
  onFail: OnFail;
  nextId: number;
  jobs: QueueJob[];
}

/** Waiting jobs at most. */
export const QUEUE_MAX = 32;
/** Ended jobs kept (the newest). */
export const HISTORY_KEEP = 20;
/** A command line's length at most (the chat's own limit is 256 with the prefix and `queue add`). */
export const COMMAND_MAX = 200;
/** A command that only answers (`!set`, `!wp`): its reply must have come this long after the dispatch ... */
export const START_MS = 1500;
/** ... a command that does work but started none (a refusal): this long (a process may start a few seconds late). */
export const START_WORK_MS = 5000;
/** ... and nothing more said for this long. */
export const REPLY_QUIET_MS = 1000;
/** A command that started no work and said nothing has ended after this. */
export const START_MAX_MS = 20_000;
/** The work a job started must stay gone this long (a job's next step may come a moment later). */
export const SETTLE_MS = 2000;
/** The bot must be free this long between two jobs (a chore checks every second and wants a few quiet seconds). */
export const GAP_MS = 5000;
/** A chore or the walk home holding the bot longer than this is pre-empted by the next job. */
export const HOLD_MAX_MS = 20 * 60_000;
/** A job that runs longer than this is stopped (a net under the end detection; the obtain job's kit takes up to 30 min). */
export const JOB_MAX_MS = 3 * 3600_000;
/** The queue's tick. */
export const POLL_MS = 250;
/** End lines are cut to this length. */
export const LINE_MAX = 200;

/**
 * Commands the queue never holds, and why (refused at `!queue add`). Each either never ends by itself, acts on the
 * running work, waits for the owner, or is the queue's own.
 */
export const QUEUE_REFUSE: Readonly<Record<string, string>> = {
  queue: 'the queue does not hold its own commands',
  goals: 'it only answers: type it',
  stop: 'it acts on the running work: type it when you want it',
  pause: 'it acts on the running work: type it when you want it (or !queue pause)',
  resume: 'it acts on the running work: type it when you want it',
  quit: 'it ends the bot',
  follow: 'it never ends by itself',
  learn: 'it records a flight the owner flies',
  test: 'the test bench runs its own series',
  do: 'a plan of commands waits for !yes: queue the commands themselves',
  yes: 'it answers a plan that waits',
  no: 'it answers a plan that waits',
};

/** Commands that, typed, never pause the queue: they only answer or switch, or (`quit`) end the bot, whose restart has its own rule. */
export const QUEUE_REPLY_ONLY: ReadonlySet<string> = new Set(['status', 'pos', 'help', 'commands', 'health', 'inv', 'stock', 'boxes', 'set', 'wp', 'shelter', 'mode', 'colors', 'panel', 'queue', 'goals', 'pause', 'resume', 'guard', 'quit']);
/** First arguments that make any command only answer (`!get status`, `!sleep on`). */
const REPLY_ARGS: ReadonlySet<string> = new Set(['status', 'list', 'show', 'help', 'on', 'off']);

/** Why `!name args` cannot be queued, or undefined when it can. `has`: the command is registered. */
export function queueRefusal(name: string, args: readonly string[], has: (name: string) => boolean): string | undefined {
  const n = name.toLowerCase();
  const a = (args[0] ?? '').toLowerCase();
  if (!has(n)) return `no command !${n}`;
  const r = QUEUE_REFUSE[n];
  if (r) return r;
  if (a === 'stop') return 'it acts on the running work: type it when you want it';
  if (n === 'farm' && a !== 'new' && a !== 'status') return 'it farms until stopped (!farm new sets a plot up and ends)';
  return undefined;
}

/** A typed `!name args` that does work (it moves the bot or starts a job): it pauses the queue. */
export function typedWork(name: string, args: readonly string[]): boolean {
  const n = name.toLowerCase();
  const a = (args[0] ?? '').toLowerCase();
  if (QUEUE_REPLY_ONLY.has(n)) return false;
  if (a && REPLY_ARGS.has(a)) return false;
  if (n === 'home' && a !== 'go') return false; // `!home` shows it, `!home set` sets it
  if (n === 'chests' && a !== 'scan') return false;
  return true;
}

/** Replies that read as a refusal or a failure (the chat's common forms, nl/plan.ts COMMON_FAIL, and the job words). */
const FAIL_RE = /(^usage: |^unknown command |needs a task that can walk|^refused|not available|\bfailed\b|\bstopped\b|\bcannot\b|\bcan't\b|\bunreachable\b|\bgot nothing\b|\bno way\b| must be |^unknown setting|^no command |\bgave up\b|\btimed? ?out\b|^no |^[a-z]+: no [\w ]+ (for|to|in|near|within|known|carried)\b|\bmissing\b|\bnot (found|known|set)\b)/i;
/** Replies that say the goal was reached, whatever other words they hold. */
const OK_RE = /(: done in |already carried|^arrived at |^here \(|^landed )/i;

/** The state a reply-only command or a multi-step job's end line gives. */
export function lineState(line: string | undefined): 'done' | 'failed' {
  if (!line) return 'done';
  return OK_RE.test(line) || !FAIL_RE.test(line) ? 'done' : 'failed';
}

const clip = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 3)}...` : s);

/** A multi-step job the chat starts (the obtain job of `!get`, `!mend`): its processes come and go between steps. */
export interface JobHolder {
  name: string;
  /** The job object now (undefined: none runs). */
  current(): object | undefined;
  /** Its end line once it ends, when the holder hands one out (the obtain job's `result`). */
  end?(job: object): Promise<string> | undefined;
  /** Stop that job (a running queue job removed). */
  stop?(job: object): void;
  /** Its status line (the panel's running job). */
  status?(job: object): string | undefined;
}

export interface QueuePorts {
  /** Run one command line (with its prefix) as the owner; false when nobody can run it (no owner). */
  run(command: string): boolean;
  /** The command is registered. */
  has(name: string): boolean;
  prefix?: string;
  userProcesses(): readonly Process[];
  stopProcess(p: Process): void;
  /** The process in control. */
  active(): Pick<Process, 'name' | 'kind' | 'priority'> | undefined;
  holders: readonly JobHolder[];
  /** In the game, alive and ready: a job may start. */
  ready(): boolean;
  /** One line to the owner (past the chat's rate limit). */
  say(m: string): void;
  now?(): number;
  /** Keep the data (the file); called after every change. */
  save?(d: QueueData): void;
  log?: Logger;
}

/** The running job's watch: what its dispatch started and what was said meanwhile. */
interface Watch {
  job: QueueJob;
  t0: number;
  /** START_MS or START_WORK_MS. */
  startMs: number;
  before: Set<Process>;
  hBefore: (object | undefined)[];
  procs: Map<Process, { outcome?: JobOutcome; at?: number }>;
  owned: { h: JobHolder; job: object; end?: string }[];
  replies: { m: string; at: number }[];
  seenWork: boolean;
  idleSince?: number | undefined;
  /** When the job's work went (the settle confirmed it): the job's end time. */
  workEnd?: number | undefined;
  endAt?: number | undefined;
  /** A typed command came: nothing started after it is the job's. */
  frozen: boolean;
  preempted?: string | undefined;
  /** Removed while it ran (`!queue remove`). */
  cancel?: string | undefined;
  limit?: boolean;
}

export interface QueueJobView {
  id: number;
  command: string;
  by: string;
  via: JobVia;
  state: JobState;
  addedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  end: string | null;
}

/** What the panel and `!queue` show. */
export interface QueueView {
  paused: boolean;
  why: string | null;
  onFail: OnFail;
  running: (QueueJobView & { line: string | null }) | null;
  waiting: QueueJobView[];
  /** Ended jobs, oldest first (a list that scrolls: the panel's delta is one op when a job ends). */
  ended: QueueJobView[];
  /** Why the next job does not start yet (null: it starts, or nothing waits). */
  hold: string | null;
}

export type AddResult = { ok: true; job: QueueJob; pos: number } | { ok: false; why: string };

const viewOf = (j: QueueJob): QueueJobView => ({ id: j.id, command: j.command, by: j.by, via: j.via, state: j.state, addedAt: j.addedAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null, end: j.end ?? null });

export class JobQueue {
  private readonly p: QueuePorts;
  private readonly log: Logger;
  private data: QueueData = { v: 1, paused: false, onFail: 'next', nextId: 1, jobs: [] };
  private w: Watch | undefined;
  private freeSince: number | undefined;
  private heldSince: number | undefined;
  private holdWhy: string | null = null;
  private dispatching = false;
  /** Jobs ended since the queue last ran empty (the summary line). */
  private run = { done: 0, failed: 0, other: 0 };
  private readonly listeners = new Set<() => void>();

  constructor(p: QueuePorts, saved?: QueueData) {
    this.p = p;
    this.log = p.log ?? silentLogger;
    if (saved) this.load(saved);
  }

  private now(): number {
    return this.p.now?.() ?? Date.now();
  }

  get prefix(): string {
    return this.p.prefix ?? '!';
  }

  /** Read a saved queue (a restart): a job that was running is not run again. */
  private load(d: QueueData): void {
    const jobs = Array.isArray(d.jobs) ? d.jobs.filter((j) => j && typeof j.id === 'number' && typeof j.command === 'string') : [];
    this.data = { v: 1, paused: d.paused === true, why: d.why, onFail: d.onFail === 'stop' ? 'stop' : 'next', nextId: Math.max(Number(d.nextId) || 1, ...jobs.map((j) => j.id + 1)), jobs };
    const now = this.now();
    for (const j of jobs) {
      if (j.state !== 'running') continue;
      const s = j.startedAt !== undefined ? Math.max(0, Math.round((now - j.startedAt) / 1000)) : undefined;
      j.state = 'cancelled';
      j.how = 'restart';
      j.endedAt = now;
      j.end = `stopped by a restart${s !== undefined ? ` (started ${s} s before)` : ''}; not run again (!queue retry ${j.id} puts it back)`;
      this.log.info(`queue: #${j.id} ${j.command} was running at the restart: not run again`);
      if (this.data.onFail === 'stop') this.setPaused(true, `a restart stopped #${j.id}`);
    }
    this.trim();
  }

  /** The data as the file keeps it (a copy). */
  snapshot(): QueueData {
    return JSON.parse(JSON.stringify(this.data)) as QueueData;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed(): void {
    try {
      this.p.save?.(this.snapshot());
    } catch (e) {
      this.log.warn(`queue: saving failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        /* a listener's fault is not the queue's */
      }
    }
  }

  get paused(): boolean {
    return this.data.paused;
  }

  get onFail(): OnFail {
    return this.data.onFail;
  }

  jobs(): readonly QueueJob[] {
    return this.data.jobs;
  }

  waiting(): QueueJob[] {
    return this.data.jobs.filter((j) => j.state === 'waiting');
  }

  runningJob(): QueueJob | undefined {
    return this.w?.job;
  }

  get(id: number): QueueJob | undefined {
    return this.data.jobs.find((j) => j.id === id);
  }

  // ---- the owner's edits ----------------------------------------------------------------------------------------------

  /** `!queue add <command>`: the line as typed (with or without the prefix); refused at once with the reason. */
  add(text: string, by: string, via: JobVia, front = false): AddResult {
    const pre = this.prefix;
    const t = text.trim();
    const line = t.startsWith(pre) ? t : `${pre}${t}`;
    if (line.length > COMMAND_MAX) return { ok: false, why: `the command is longer than ${COMMAND_MAX} characters` };
    const words = line.slice(pre.length).trim().split(/\s+/).filter(Boolean);
    const [name, ...args] = words;
    if (!name || !/^[a-z][\w-]*$/i.test(name)) return { ok: false, why: `not a command: ${t || '(nothing)'}` };
    const why = queueRefusal(name, args, (n) => this.p.has(n));
    if (why) return { ok: false, why: `cannot queue !${name.toLowerCase()}: ${why}` };
    if (this.waiting().length >= QUEUE_MAX) return { ok: false, why: `the queue holds ${QUEUE_MAX} waiting jobs already` };
    const job: QueueJob = { id: this.data.nextId++, command: `${pre}${[name.toLowerCase(), ...args].join(' ')}`, by, via, addedAt: this.now(), state: 'waiting' };
    if (front) {
      const i = this.data.jobs.findIndex((j) => j.state === 'waiting');
      if (i < 0) this.data.jobs.push(job);
      else this.data.jobs.splice(i, 0, job);
    } else this.data.jobs.push(job);
    const pos = this.waiting().indexOf(job) + 1;
    this.log.info(`queue: + #${job.id} ${job.command} (by ${by} via ${via}, ${pos} of ${this.waiting().length})`);
    this.changed();
    return { ok: true, job, pos };
  }

  /** `!queue remove <id>`: a waiting job goes; the running one is stopped (its processes, its job) and ends cancelled. */
  remove(id: number, by = 'the owner'): string {
    const j = this.get(id);
    if (!j) return `queue: no job #${id}`;
    if (j.state === 'waiting') {
      this.data.jobs.splice(this.data.jobs.indexOf(j), 1);
      this.changed();
      return `queue: removed #${id} ${j.command}`;
    }
    const w = this.w;
    if (w?.job === j) {
      w.cancel = `!queue remove by ${by}`;
      w.frozen = true;
      this.stopWork(w);
      this.changed();
      return `queue: stopping #${id} ${j.command}`;
    }
    return `queue: #${id} has ended (${j.state}); !queue clear ended drops the ended ones`;
  }

  /** `!queue move <id> <pos>`: 1 = the next to run. */
  move(id: number, pos: number): string {
    const j = this.get(id);
    if (j?.state !== 'waiting') return `queue: no waiting job #${id}`;
    const wait = this.waiting();
    const to = Math.max(1, Math.min(wait.length, Math.floor(pos)));
    const rest = wait.filter((x) => x !== j);
    rest.splice(to - 1, 0, j);
    const others = this.data.jobs.filter((x) => x.state !== 'waiting');
    this.data.jobs = [...others, ...rest];
    this.changed();
    return `queue: #${id} ${j.command} is ${to} of ${wait.length}`;
  }

  /** `!queue clear [ended]`: the waiting jobs go (the running one goes on); `ended`: the history goes. */
  clear(ended = false): string {
    const before = this.data.jobs.length;
    this.data.jobs = this.data.jobs.filter((j) => (ended ? j.state === 'waiting' || j.state === 'running' : j.state !== 'waiting'));
    const n = before - this.data.jobs.length;
    this.changed();
    return ended ? `queue: ${n} ended job${n === 1 ? '' : 's'} dropped` : `queue: ${n} waiting job${n === 1 ? '' : 's'} removed${this.w ? `; #${this.w.job.id} runs on (!queue remove ${this.w.job.id} stops it)` : ''}`;
  }

  /** `!queue retry <id>`: an ended job again, as the next to run. */
  retry(id: number, by: string, via: JobVia): AddResult {
    const j = this.get(id);
    if (!j) return { ok: false, why: `queue: no job #${id}` };
    if (j.state === 'waiting' || j.state === 'running') return { ok: false, why: `queue: #${id} has not ended` };
    return this.add(j.command, by, via, true);
  }

  private setPaused(on: boolean, why?: string): void {
    this.data.paused = on;
    this.data.why = on ? why : undefined;
  }

  /** `!queue pause`: no new job starts; the running one goes on. */
  pause(why = '!queue pause'): string {
    if (this.data.paused) return `queue: paused already (${this.data.why ?? 'paused'})`;
    this.setPaused(true, why);
    this.changed();
    return `queue: paused${this.w ? `; #${this.w.job.id} ${this.w.job.command} runs on to its end` : ''}; !queue resume goes on`;
  }

  /** `!queue resume`. */
  resume(): string {
    if (!this.data.paused) return 'queue: not paused';
    this.setPaused(false);
    this.freeSince = undefined;
    this.changed();
    const next = this.waiting()[0];
    return `queue: resumed${next ? `; next #${next.id} ${next.command}` : ' (nothing waits)'}`;
  }

  setOnFail(v: OnFail): string {
    this.data.onFail = v;
    this.changed();
    return `queue: a failed job ${v === 'next' ? 'is followed by the next one' : 'pauses the queue'}`;
  }

  // ---- what the bot said and what the owner typed --------------------------------------------------------------------

  /** Every reply the bot says (wired over chat.say): the running job keeps them for its end line. */
  observeReply(m: string): void {
    const w = this.w;
    if (!w || w.frozen || m.startsWith('queue:')) return; // after a typed command the replies are its own
    w.replies.push({ m, at: this.now() });
    if (w.replies.length > 20) w.replies.shift();
  }

  /** A command the owner typed (Chat's `typed` run events): work pauses the queue. */
  onTyped(name: string, args: readonly string[]): void {
    if (this.dispatching || !typedWork(name, args)) return;
    const w = this.w;
    if (w) {
      w.frozen = true;
      w.preempted ??= `!${name}`;
    }
    if (!w && this.waiting().length === 0) return;
    if (this.data.paused) {
      if (w) this.changed();
      return;
    }
    this.setPaused(true, `!${name} was typed`);
    const next = this.waiting()[0];
    this.log.info(`queue: paused: !${name} was typed${w ? ` while #${w.job.id} ran` : ''}`);
    this.p.say(`queue: paused: !${name} was typed${w ? `; #${w.job.id} ${w.job.command} is left to it` : ''}${next ? `; !queue resume goes on with #${next.id} ${next.command}` : ''}`);
    this.changed();
  }

  // ---- running ---------------------------------------------------------------------------------------------------------

  /** What keeps the next job from starting now (undefined: the bot is free). */
  private busy(): { kind: 'command' | 'safety' | 'chore'; why: string } | undefined {
    const users = this.p.userProcesses();
    if (users.length > 0) return { kind: 'command', why: `a command runs (${users[0]!.name})` };
    const h = this.p.holders.find((x) => x.current() !== undefined);
    if (h) return { kind: 'command', why: `a ${h.name} job runs` };
    const a = this.p.active();
    if (!a) return undefined;
    if (a.priority > PRIORITY.chore) return { kind: 'safety', why: `${a.name} has the bot` };
    return { kind: 'chore', why: `${a.name === 'home' ? 'the walk home' : `the ${a.name} chore`} runs` };
  }

  /** One step: start the next job when it may, watch the running one. */
  tick(now = this.now()): void {
    if (this.w) {
      this.watch(this.w, now);
      return;
    }
    const next = this.waiting()[0];
    if (!next || this.data.paused) {
      this.freeSince = undefined;
      this.heldSince = undefined;
      this.setHold(this.data.paused && next ? `paused (${this.data.why ?? 'paused'})` : null);
      return;
    }
    if (!this.p.ready()) {
      this.freeSince = undefined;
      this.setHold('the bot is not in the game, or dead');
      return;
    }
    const b = this.busy();
    if (b) {
      this.freeSince = undefined;
      if (b.kind !== 'chore') {
        this.heldSince = undefined;
        this.setHold(b.why);
        return;
      }
      this.heldSince ??= now;
      if (now - this.heldSince < HOLD_MAX_MS) {
        this.setHold(b.why);
        return;
      }
      this.log.info(`queue: ${b.why} for ${Math.round(HOLD_MAX_MS / 60_000)} min: #${next.id} starts over it`);
    } else {
      this.heldSince = undefined;
      this.freeSince ??= now;
      if (now - this.freeSince < GAP_MS) {
        this.setHold(`the gap between jobs (${Math.ceil((GAP_MS - (now - this.freeSince)) / 1000)} s)`);
        return;
      }
    }
    this.start(next, now);
  }

  private setHold(why: string | null): void {
    if (this.holdWhy === why) return;
    const was = this.holdWhy;
    this.holdWhy = why;
    // the countdown changes every second: the panel's sampler picks it up; a real change is pushed at once
    if (!(was?.startsWith('the gap') && why?.startsWith('the gap'))) for (const fn of [...this.listeners]) fn();
  }

  private start(job: QueueJob, now: number): void {
    job.state = 'running';
    job.startedAt = now;
    const w: Watch = {
      job,
      t0: now,
      startMs: START_MS,
      before: new Set(this.p.userProcesses()),
      hBefore: this.p.holders.map((h) => h.current()),
      procs: new Map(),
      owned: [],
      replies: [],
      seenWork: false,
      frozen: false,
    };
    const [name, ...args] = job.command.slice(this.prefix.length).split(/\s+/);
    if (typedWork(name ?? '', args)) w.startMs = START_WORK_MS;
    this.w = w;
    this.freeSince = undefined;
    this.heldSince = undefined;
    this.holdWhy = null;
    this.log.info(`queue: #${job.id} ${job.command} starts`);
    this.changed();
    let ran: boolean;
    this.dispatching = true;
    try {
      ran = this.p.run(job.command);
    } catch (e) {
      w.replies.push({ m: `${job.command} failed: ${e instanceof Error ? e.message : String(e)}`, at: this.now() });
      ran = true;
    } finally {
      this.dispatching = false;
    }
    if (!ran) {
      this.w = undefined;
      this.end(job, 'skipped', 'no owner to run it as (owners empty and consoleOwner off)', 'none');
      return;
    }
    this.attach(w); // the work a synchronous handler started
  }

  /** Take the work the job's dispatch started (until a typed command freezes the watch). */
  private attach(w: Watch): void {
    if (w.frozen) return;
    for (const p of this.p.userProcesses()) {
      if (w.before.has(p) || w.procs.has(p)) continue;
      const rec: { outcome?: JobOutcome; at?: number } = {};
      w.procs.set(p, rec);
      const r = (p as unknown as { result?: unknown }).result;
      if (r instanceof Promise) {
        r.then(
          (v: unknown) => {
            rec.outcome = outcomeOf(v);
            rec.at = this.now();
          },
          (e: unknown) => {
            rec.outcome = { kind: 'failed', reason: e instanceof Error ? e.message : String(e) };
            rec.at = this.now();
          },
        );
      }
    }
    this.p.holders.forEach((h, i) => {
      const cur = h.current();
      if (!cur || cur === w.hBefore[i] || w.owned.some((o) => o.job === cur)) return;
      const o: { h: JobHolder; job: object; end?: string } = { h, job: cur };
      w.owned.push(o);
      h.end?.(cur)?.then(
        (line) => {
          o.end = line;
        },
        () => undefined,
      );
    });
  }

  private live(w: Watch): boolean {
    const users = new Set(this.p.userProcesses());
    for (const p of w.procs.keys()) if (!p.done && users.has(p)) return true;
    return w.owned.some((o) => o.h.current() === o.job);
  }

  private stopWork(w: Watch): void {
    for (const o of w.owned) if (o.h.current() === o.job) o.h.stop?.(o.job);
    const users = new Set(this.p.userProcesses());
    for (const p of w.procs.keys()) if (!p.done && users.has(p)) this.p.stopProcess(p);
  }

  private watch(w: Watch, now: number): void {
    if (w.endAt !== undefined) {
      if (now >= w.endAt) this.finish(w);
      return;
    }
    this.attach(w);
    if (now - w.t0 > JOB_MAX_MS && !w.limit) {
      w.limit = true;
      w.frozen = true;
      this.log.warn(`queue: #${w.job.id} ${w.job.command} ran ${Math.round(JOB_MAX_MS / 3600_000)} h: stopping it`);
      this.stopWork(w);
    }
    if (this.live(w)) {
      w.seenWork = true;
      w.idleSince = undefined;
      return;
    }
    if (w.seenWork) {
      w.idleSince ??= now;
      if (now - w.idleSince >= SETTLE_MS) {
        w.endAt = now;
        w.workEnd = w.idleSince;
      }
      return;
    }
    // no work seen: a command that only answers (or refused)
    const last = w.replies.at(-1)?.at;
    if ((last !== undefined && now - w.t0 >= w.startMs && now - last >= REPLY_QUIET_MS) || now - w.t0 >= START_MAX_MS || w.cancel) w.endAt = now;
  }

  /** The job's end: its state and end line from what the watch saw. */
  private finish(w: Watch): void {
    this.w = undefined;
    const job = w.job;
    const last = w.replies.at(-1)?.m;
    let state: JobState;
    let end: string;
    let how: JobEndHow;
    const holder = w.owned.find((o) => o.end !== undefined) ?? w.owned[0];
    if (holder) {
      how = 'job';
      end = holder.end ?? last ?? `${holder.h.name} job ended`;
      state = lineState(end);
    } else if (w.procs.size > 0) {
      how = 'process';
      const settled = [...w.procs.values()].filter((r) => r.outcome && !(r.outcome.kind === 'stopped' && r.outcome.reason === 'replaced')).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      // every process it started was replaced by a newer one: by the owner's typed command (cancelled), else by its own next step
      const replaced = settled.length === 0 && [...w.procs.values()].some((r) => r.outcome?.kind === 'stopped');
      const o: JobOutcome = settled.at(-1)?.outcome ?? (replaced && w.preempted ? { kind: 'stopped', reason: 'replaced' } : { kind: 'finished', result: 'done' });
      // stopped: by the owner (`!stop`) or a newer command (cancelled); a death or a disconnect fails the job
      state = o.kind === 'finished' ? 'done' : o.kind === 'failed' || o.reason === 'death' || o.reason === 'dispose' ? 'failed' : 'cancelled';
      const said = o.kind === 'finished' ? o.result : `${o.kind}: ${o.reason}`;
      end = last ?? said;
      // the process decides over the words (a stopped goto says nothing of its own)
      if (o.kind === 'stopped') end = `${w.preempted ? `${w.preempted} was typed` : o.reason}${last ? ` (last: ${last})` : ''}`;
    } else {
      how = 'reply';
      end = last ?? '(no reply)';
      state = last ? lineState(last) : 'done';
    }
    if (w.limit) {
      state = 'failed';
      how = 'limit';
      end = `stopped at the queue's ${Math.round(JOB_MAX_MS / 3600_000)} h limit${last ? `: ${last}` : ''}`;
    }
    if (w.cancel) {
      state = 'cancelled';
      how = 'removed';
      end = `stopped by ${w.cancel}${last ? `: ${last}` : ''}`;
    } else if (w.preempted && state === 'failed') {
      state = 'cancelled';
      end = `${w.preempted} was typed: ${end}`;
    }
    this.end(job, state, end, how, w.cancel || w.limit ? undefined : w.workEnd);
  }

  /** `at`: when the work ended (before the settle that confirmed it), else now. */
  private end(job: QueueJob, state: JobState, end: string, how: JobEndHow, at?: number): void {
    const now = at ?? this.now();
    job.state = state;
    job.endedAt = now;
    job.end = clip(end);
    job.how = how;
    if (state === 'done') this.run.done++;
    else if (state === 'failed') this.run.failed++;
    else this.run.other++;
    const s = job.startedAt !== undefined ? Math.round((now - job.startedAt) / 100) / 10 : 0;
    this.log.info(`queue: #${job.id} ${job.command} ${state} after ${s} s (${how}): ${job.end}`);
    const failed = state === 'failed' || state === 'skipped';
    if (failed && this.data.onFail === 'stop' && !this.data.paused) {
      this.setPaused(true, `#${job.id} ${state}`);
      this.p.say(`queue: paused: #${job.id} ${job.command} ${state} (${job.end}); !queue resume goes on`);
    }
    if (this.waiting().length === 0) {
      const r = this.run;
      const n = r.done + r.failed + r.other;
      if (n > 1 || failed) this.p.say(`queue: all ${n} job${n === 1 ? '' : 's'} ended: ${r.done} done${r.failed ? `, ${r.failed} failed` : ''}${r.other ? `, ${r.other} cancelled or skipped` : ''}`);
      this.run = { done: 0, failed: 0, other: 0 };
    }
    this.trim();
    this.changed();
  }

  /** The newest HISTORY_KEEP ended jobs stay. */
  private trim(): void {
    const ended = this.data.jobs.filter((j) => j.state !== 'waiting' && j.state !== 'running');
    if (ended.length <= HISTORY_KEEP) return;
    const drop = new Set(ended.slice(0, ended.length - HISTORY_KEEP));
    this.data.jobs = this.data.jobs.filter((j) => !drop.has(j));
  }

  // ---- what it shows ---------------------------------------------------------------------------------------------------

  /** The running job's live line: its process's status, or its job's. */
  private liveLine(w: Watch): string | null {
    const users = new Set(this.p.userProcesses());
    for (const o of w.owned) if (o.h.current() === o.job) return o.h.status?.(o.job) ?? null;
    for (const p of w.procs.keys()) {
      if (p.done || !users.has(p)) continue;
      try {
        return p.status().line;
      } catch {
        return p.name;
      }
    }
    return null;
  }

  /** Why the next job does not start yet (null: nothing waits or it starts now). */
  hold(): string | null {
    return this.holdWhy;
  }

  view(endedMax = 10): QueueView {
    const w = this.w;
    const ended = this.data.jobs.filter((j) => j.state !== 'waiting' && j.state !== 'running').slice(-endedMax);
    return {
      paused: this.data.paused,
      why: this.data.paused ? (this.data.why ?? null) : null,
      onFail: this.data.onFail,
      running: w ? { ...viewOf(w.job), line: this.liveLine(w) } : null,
      waiting: this.waiting().map(viewOf),
      ended: ended.map(viewOf),
      hold: w ? null : this.holdWhy,
    };
  }

  /** `!queue`: one or two lines. */
  lines(): string[] {
    const v = this.view(3);
    const head = `queue${v.paused ? ` (paused: ${v.why ?? 'paused'})` : ''}${v.onFail === 'stop' ? ' (a failure pauses it)' : ''}:`;
    const parts: string[] = [];
    if (v.running) parts.push(`running #${v.running.id} ${v.running.command}${v.running.line ? ` (${v.running.line})` : ''}`);
    if (v.waiting.length) parts.push(`waiting ${v.waiting.map((j) => `#${j.id} ${j.command}`).join(', ')}`);
    else if (!v.running) parts.push('nothing waits');
    if (!v.running && v.hold && v.waiting.length) parts.push(`next when free: ${v.hold}`);
    const out = [`${head} ${parts.join('; ')}`];
    if (v.ended.length) out.push(`ended: ${[...v.ended].reverse().map((j) => `#${j.id} ${j.command} ${j.state}${j.end ? ` (${j.end.slice(0, 60)})` : ''}`).join('; ')}`);
    return out;
  }
}
