// Track T1 (docs/runbook.md "The Realm as a test server (Track T1)", ADR 0075): the bot as its own test operator, owner-only
// like every command, everything behind `testMode` (default off) and the bot's operator rights:
//   !test [status]                                     testMode, the op verdict, the series running or the last summary
//   !test op                                           probe the rights now (`/testfor @s`)
//   !test kit                                          the kit the runs restore (testKit: start | file | a list)
//   !test cavestart [n] [from <x y z | wp>]            /tp to the start (default: where the bot stands), `!fly cave_start`
//   !test cave [n]                                     /tp to cave_start, `!fly cave_end`
//   !test route <prefix> [n] [noshortcut]              /tp to <prefix>_start, `!fly route <prefix> [noshortcut]`
//   !test goto <x y z | wp> from <x y z | wp> [n]      /tp to the start, `!goto <goal>`
//   !test stop                                         end the run in progress and the series
// Each run restores health, food and the kit and teleports to the start first (skills/test/recovery.ts), runs the trip as
// the owner's own command and records it (skills/test/series.ts): a chat line per run, a summary, and one JSON line per
// run in <config dir>/tests/<time>-<series>.jsonl. With testMode on, a death is recovered (respawn, kit, /tp back to the
// run's start) and the afk task's walk home after the respawn is skipped while a series runs.
// testMode off: `!test` only answers, no command is ever sent and the respawn goes as before.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import { CommandRunner, type CommandSource } from '../skills/test/command.ts';
import { formatKit, kitView, parseKitText, snapshotKit, type KitEntry } from '../skills/test/kit.ts';
import { NEEDS_OP, OpDetector, type OpSource, type OpStatus } from '../skills/test/ops.ts';
import { claimRespawn, fmtCell, Harness, Recovery, type HarnessPorts } from '../skills/test/recovery.ts';
import { summaryLine, TEST_LIMITS, TestSeries, type RunKind, type RunSpec, type SeriesSummary } from '../skills/test/series.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { RespawnController } from '../tasks/respawn.ts';
import type { ChatLine } from './text.ts';
import { flyControlOf } from './commands-fly.ts';
import { stopCorridorTrip } from './commands-corridor.ts';
import { waypointStoreOf } from './commands-nav.ts';

export const TEST_COMMANDS = ['test'] as const;
/** At most this many runs in one series. */
export const MAX_RUNS = 50;
/** The kit file in the tests folder (testKit `file`). */
export const KIT_FILE = 'kit.json';

export interface TestExtra {
  respawn: RespawnController;
  /** The tests folder (JSONL records, kit.json); default: env BEDROCKBOT_TESTS_DIR, else `tests` next to settings.json, else none (records only in the log). */
  testsDir?: string;
  logger?: Logger;
}

/** What the harness built for a task (tests, status). */
export interface TestControl {
  runner: CommandRunner;
  ops: OpDetector;
  recovery: Recovery;
  harness: Harness;
  /** The series running, if any. */
  current(): TestSeries | undefined;
  /** The last finished series' summary. */
  last(): SeriesSummary | undefined;
  /** Resolves when the series running ends (at once when none). */
  done(): Promise<SeriesSummary | undefined>;
  /** The tests folder in use, if any. */
  dir(): string | undefined;
}

const controls = new WeakMap<object, TestControl>();
export function testControlOf(task: object): TestControl | undefined {
  return controls.get(task);
}

/** The tests folder: the option, else BEDROCKBOT_TESTS_DIR, else `tests` next to settings.json. */
export function testsDirOf(settingsFile: string | undefined, option?: string, env: string | undefined = process.env.BEDROCKBOT_TESTS_DIR): string | undefined {
  if (option) return option;
  if (env) return env;
  return settingsFile ? join(dirname(settingsFile), 'tests') : undefined;
}

/** `20261108-211502-route-r1.jsonl` */
export function recordFileName(series: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${stamp}-${series.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '') || 'test'}.jsonl`;
}

/** The kit for a series from the `testKit` setting (`start`: the snapshot given; `file`: the kit file; else the list). Throws on a bad file or list. */
export function resolveKit(setting: string, snapshot: () => KitEntry[], dir: string | undefined): { kit: KitEntry[]; from: string } {
  const s = setting.trim();
  if (s === '' || s === 'start') return { kit: snapshot(), from: 'start' };
  if (s === 'file') {
    if (!dir) throw new Error(`testKit file: no tests folder (settings in memory only)`);
    const f = join(dir, KIT_FILE);
    if (!existsSync(f)) throw new Error(`testKit file: no ${KIT_FILE} in the tests folder`);
    const text0 = readFileSync(f, 'utf8');
    const raw: unknown = JSON.parse(text0.charCodeAt(0) === 0xfeff ? text0.slice(1) : text0);
    const text = Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'string' ? raw : undefined;
    if (text === undefined) throw new Error(`testKit file: ${KIT_FILE} must be a list of strings or one string`);
    return { kit: parseKitText(text), from: KIT_FILE };
  }
  return { kit: parseKitText(s), from: 'testKit' };
}

/** `!test ...` arguments -> what to run, or an error line. `point` resolves `x y z` or a waypoint name (pure, tests). */
export function parseTestArgs(
  args: readonly string[],
  point: (words: readonly string[]) => Vec3 | string,
  here: () => Vec3 | undefined,
): { spec: RunSpec; runs: number; note?: string } | { error: string } {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);
  const takeN = (words: string[]): number | string => {
    const i = words.findIndex((w) => /^\d+$/.test(w));
    if (i < 0) return 1;
    const n = Number(words.splice(i, 1)[0]);
    return n >= 1 && n <= MAX_RUNS ? n : `test: runs must be 1..${MAX_RUNS}`;
  };
  const resolve = (words: readonly string[]): Vec3 | { error: string } => {
    const r = point(words);
    return typeof r === 'string' ? { error: r } : r;
  };
  const spec = (kind: RunKind, name: string, start: Vec3, command: string, goal?: Vec3): RunSpec => ({ kind, name, start, command, ...(goal ? { goal } : {}) });
  if (sub === 'cavestart' || sub === 'cave') {
    // the run count before `from` (the start's coordinates after it are numbers too)
    const fi = sub === 'cavestart' ? rest.findIndex((w) => w.toLowerCase() === 'from') : -1;
    const words = fi >= 0 ? rest.slice(0, fi) : [...rest];
    const n = takeN(words);
    if (typeof n === 'string') return { error: n };
    let start: Vec3 | undefined;
    if (sub === 'cavestart') {
      if (fi >= 0) {
        const p = resolve(rest.slice(fi + 1));
        if ('error' in p) return p;
        start = p;
      } else start = here();
      if (!start) return { error: 'test: position unknown' };
      const goal = point(['cave_start']);
      if (typeof goal === 'string') return { error: goal };
      if (words.length) return { error: 'usage: !test cavestart [n] [from <x y z | waypoint>]' };
      return { spec: spec('cavestart', 'cavestart', start, 'fly cave_start', goal), runs: n };
    }
    if (words.length) return { error: 'usage: !test cave [n]' };
    const from = point(['cave_start']);
    if (typeof from === 'string') return { error: from };
    const goal = point(['cave_end']);
    if (typeof goal === 'string') return { error: goal };
    return { spec: spec('cave', 'cave', from, 'fly cave_end', goal), runs: n };
  }
  if (sub === 'route') {
    const words = [...rest];
    const prefix = words.shift();
    if (!prefix || /^\d+$/.test(prefix)) return { error: 'usage: !test route <prefix> [n] [noshortcut]' };
    const n = takeN(words);
    if (typeof n === 'string') return { error: n };
    const ns = words.findIndex((w) => w.toLowerCase() === 'noshortcut');
    if (ns >= 0) words.splice(ns, 1);
    if (words.length) return { error: 'usage: !test route <prefix> [n] [noshortcut]' };
    const from = point([`${prefix}_start`]);
    if (typeof from === 'string') return { error: from };
    const goal = point([`${prefix}_end`]);
    if (typeof goal === 'string') return { error: goal };
    return { spec: spec('route', `route ${prefix}`, from, `fly route ${prefix}${ns >= 0 ? ' noshortcut' : ''}`, goal), runs: n };
  }
  if (sub === 'goto') {
    const words = [...rest];
    const fi = words.findIndex((w) => w.toLowerCase() === 'from');
    if (fi < 1) return { error: 'usage: !test goto <x y z | waypoint> from <x y z | waypoint> [n]' };
    const goalWords = words.slice(0, fi);
    const after = words.slice(fi + 1);
    // a trailing run count after the start's words (`from 1 2 3 5`, `from base 5`)
    let n = 1;
    if (after.length === 4 || (after.length === 2 && /^\d+$/.test(after[1]!))) {
      n = Number(after.pop());
      if (!(n >= 1 && n <= MAX_RUNS)) return { error: `test: runs must be 1..${MAX_RUNS}` };
    }
    const goal = resolve(goalWords);
    if ('error' in goal) return goal;
    const from = resolve(after);
    if ('error' in from) return from;
    const target = goalWords.length === 1 ? goalWords[0]! : `${goal.x} ${goal.y} ${goal.z}`;
    return { spec: spec('goto', `goto ${target}`, from, `goto ${target}`, goal), runs: n };
  }
  return { error: 'usage: !test [status | op | kit | stop] | cavestart [n] [from <p>] | cave [n] | route <prefix> [n] [noshortcut] | goto <p> from <p> [n]' };
}

export function registerTestCommands(d: CommandDeps, extra: TestExtra): TestControl {
  const { chat, task, settings } = d;
  const log = extra.logger ?? d.log;
  const conn = d.conn;
  const source: CommandSource & OpSource = {
    get state() {
      return conn.state;
    },
    on: (name: string, fn: (p: unknown) => void) => conn.on(name, fn),
    queue: (name: string, params: Record<string, unknown>) => conn.queue(name, params),
  };
  const runner = new CommandRunner(source, { log });
  const ops = new OpDetector(source, { run: (c) => runner.run(c), log });
  ops.start();
  const respawn = extra.respawn;
  const loop = d.mobility?.loop;
  const world = d.world;
  const dir = (): string | undefined => testsDirOf(settings.file, extra.testsDir);

  const harnessPorts: HarnessPorts = {
    run: (c) => runner.run(c),
    position: () => (loop?.state.ready ? { ...loop.state.pos } : d.position()),
    health: () => world?.self.health ?? respawn.health,
    food: () => world?.self.food,
    onGround: () => loop?.state.onGround ?? true,
    gliding: () => loop?.state.gliding ?? false,
    view: () => kitView(world?.inventory ?? { slots: [] }),
    waitChunks: (ms) => (world ? world.waitForChunks(2, { timeoutMs: ms }).catch(() => undefined) : Promise.resolve()),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log,
  };
  const harness = new Harness(harnessPorts);

  let series: TestSeries | undefined;
  let seriesDone: Promise<SeriesSummary | undefined> = Promise.resolve(undefined);
  let lastSummary: SeriesSummary | undefined;
  /** The kit of the last series (the death path outside a series restores it too). */
  let lastKit: KitEntry[] | undefined;

  const enabled = (): boolean => settings.get('testMode');
  const recovery = new Recovery({
    enabled,
    ensureOp: () => ops.ensure(),
    restore: () => harness.restore(series?.spec.start, currentKit(), TEST_LIMITS.elytraMin),
    say: (m) => chat.say(m),
    log,
  });
  const currentKit = (): KitEntry[] | undefined => {
    if (series) return lastKit;
    try {
      const k = resolveKit(settings.get('testKit'), () => lastKit ?? [], dir());
      return k.kit;
    } catch (e) {
      log.warn(`test: kit: ${e instanceof Error ? e.message : String(e)}`);
      return lastKit;
    }
  };
  respawn.onEvent((e) => {
    if (e.kind === 'death' && enabled()) recovery.onDeath();
  });
  respawn.afterRespawn((_feet, _death, signal) => recovery.onRespawn(signal));
  // while a series runs (testMode on), the recovery's /tp takes the bot back to the run's start: no walk home after the respawn
  claimRespawn(task, () => enabled() && series !== undefined);

  // every reply the bot sends while a series runs (the trips' end lines)
  const replyFns = new Set<(m: string) => void>();
  const say0 = chat.say.bind(chat);
  chat.say = (m: string) => {
    for (const fn of [...replyFns]) fn(m);
    return say0(m);
  };

  const opLine = (s: OpStatus): string => s.line;

  const pointOf = (words: readonly string[]): Vec3 | string => {
    if (words.length === 3) {
      const p = d.parseBlock(words);
      return p ?? 'test: x y z must be numbers';
    }
    if (words.length !== 1) return 'test: a point is x y z or a waypoint name';
    const w = waypointStoreOf(task)?.get(words[0]!);
    if (!w) return `test: no waypoint "${words[0]}" (!wp list)`;
    if (w.y === null) return `test: waypoint ${w.name} has no height; set it again where it should be`;
    return { x: w.x, y: w.y, z: w.z };
  };

  const stopTrip = async (): Promise<void> => {
    stopCorridorTrip(task);
    const fc = flyControlOf(task);
    if (fc?.current()?.land('stopped') !== true && fc?.controller.active) fc.controller.landNow('stopped');
    // let a flight in the air come down before its process goes
    for (let i = 0; i < 200 && (loop?.state.gliding ?? false); i++) await new Promise((r) => setTimeout(r, 100));
    d.pve?.stopCommands();
  };

  const startSeries = (spec: RunSpec, runs: number, line: ChatLine, reply: (m: string) => void): void => {
    let kit: KitEntry[];
    let from: string;
    try {
      ({ kit, from } = resolveKit(settings.get('testKit'), () => snapshotKit(kitView(world?.inventory ?? { slots: [] })), dir()));
    } catch (e) {
      reply(`test: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    lastKit = kit;
    const folder = dir();
    const file = folder ? join(folder, recordFileName(spec.name)) : undefined;
    const write = (rec: object): void => {
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
      } catch (e) {
        log.warn(`test: could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const s = new TestSeries(spec, {
      restore: (start) => harness.restore(start, kit, TEST_LIMITS.elytraMin),
      heal: () => harness.heal(),
      dispatch: (cmd) => {
        const body = `${chat.prefix}${cmd}`;
        chat.handle({ ...line, body, message: body });
      },
      onReply: (fn) => {
        replyFns.add(fn);
        return () => replyFns.delete(fn);
      },
      busy: () => (d.processes?.userProcesses().length ?? 0) > 0 || (flyControlOf(task)?.controller.active ?? false) || (loop?.state.gliding ?? false),
      position: () => harnessPorts.position(),
      gliding: () => harnessPorts.gliding(),
      health: () => harnessPorts.health(),
      deaths: () => respawn.deaths,
      recovered: () => recovery.settled(),
      stopTrip,
      healBelow: () => TEST_LIMITS.healBelow,
      write,
      say: (m) => chat.say(m),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
    }, { runs, timeoutMs: TEST_LIMITS.runMs, stuckMs: TEST_LIMITS.stuckMs });
    series = s;
    const cave = spec.kind !== 'goto' && String(settings.get('flyCave')) !== 'on' ? '; flyCave is off: the underground is walked' : '';
    reply(`test ${spec.name}: ${runs} run${runs === 1 ? '' : 's'} from ${fmtCell(spec.start)}, !${spec.command}; kit (${from}) ${kit.length} entr${kit.length === 1 ? 'y' : 'ies'}${file ? `; ${basename(file)}` : ''}${cave}`);
    log.info(`test ${spec.name}: kit ${formatKit(kit) || 'none'}${file ? `; records ${file}` : '; no tests folder (records only in the log)'}`);
    seriesDone = (async () => {
      try {
        const sum = await s.run();
        lastSummary = sum;
        const lineOut = summaryLine(sum);
        log.info(lineOut);
        chat.say(lineOut);
        return sum;
      } catch (e) {
        log.error(`test ${spec.name} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        chat.say(`test ${spec.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      } finally {
        if (series === s) series = undefined;
      }
    })();
  };

  chat.register({
    name: 'test',
    help: '[status | op | kit | stop] | cavestart [n] [from <p>] | cave [n] | route <prefix> [n] [noshortcut] | goto <p> from <p> [n] (repeated test runs with /tp, re-kit and heals between them; needs testMode on, cheats on and the bot op\'d)',
    group: 'control',
    example: '!test goto base from 0 64 0 3',
    auto: 'after a death in testMode: the kit back and /tp to the run start',
    run: ({ args, reply, line }) => {
      const sub = args[0]?.toLowerCase() ?? 'status';
      if (sub === 'status') {
        const now = series ? series.status() : lastSummary ? `last: ${summaryLine(lastSummary)}` : 'no series yet';
        reply(`test: testMode ${enabled() ? 'on' : 'off'}; ${opLine(ops.status())}; ${now}`);
        return;
      }
      if (sub === 'op') {
        void ops.probe().then((s) => reply(`test: ${opLine(s)}`));
        return;
      }
      if (sub === 'kit') {
        try {
          const k = resolveKit(settings.get('testKit'), () => snapshotKit(kitView(world?.inventory ?? { slots: [] })), dir());
          const text = formatKit(k.kit) || 'nothing';
          reply(`test kit (${k.from}): ${text.length > 200 ? `${text.slice(0, 197)}...` : text}`);
        } catch (e) {
          reply(`test: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      if (sub === 'stop') {
        if (!series) {
          reply('test: no series running');
          return;
        }
        series.stop();
        reply(`test: stopping ${series.spec.name} after run ${series.current}`);
        return;
      }
      if (!enabled()) {
        reply(`test: testMode is off (!set testMode on; ${NEEDS_OP})`);
        return;
      }
      if (!loop || !d.processes || !world) {
        reply(d.needsWalking('test'));
        return;
      }
      if (series) {
        reply(`test: ${series.status()} (!test stop ends it)`);
        return;
      }
      const parsed = parseTestArgs(args, pointOf, () => harnessPorts.position());
      if ('error' in parsed) {
        reply(parsed.error);
        return;
      }
      void (async () => {
        const op = await ops.ensure();
        if (op.state !== 'op') {
          reply(`test: ${op.state === 'unknown' ? `${NEEDS_OP} (${op.line})` : op.line}`);
          return;
        }
        if (series) return;
        startSeries(parsed.spec, parsed.runs, line, reply);
      })();
    },
  });

  const stop = task.stop.bind(task);
  task.stop = () => {
    series?.stop();
    ops.stop();
    runner.dispose();
    stop();
  };

  const control: TestControl = {
    runner,
    ops,
    recovery,
    harness,
    current: () => series,
    last: () => lastSummary,
    done: () => seriesDone,
    dir,
  };
  controls.set(task, control);
  return control;
}
