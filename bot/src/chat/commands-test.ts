// Track T1 (docs/runbook.md "The Realm as a test server (Track T1)", ADR 0075): the bot as its own test operator, owner-only
// like every command, everything behind `testMode` (default off) and the bot's operator rights:
//   !test [status]                                     testMode, the op verdict, the series running or the last summary
//   !test op                                           probe the rights now (`/testfor @s`)
//   !test kit                                          the kit the runs restore (testKit: start | file | a list)
//   !test cavestart [n] [from <x y z | wp>]            /tp to the start (default: where the bot stands), `!fly cave_start`
//   !test cave [n]                                     /tp to cave_start, `!fly cave_end`
//   !test route <prefix> [n] [noshortcut]              /tp to <prefix>_start, `!fly route <prefix> [noshortcut]`
//   !test goto <x y z | wp> from <x y z | wp> [n]      /tp to the start, `!goto <goal>`
//   !test mobs <set> [n] [<s>s] [force] [bare]         Track M1: summon a named set of mobs round the bot (at least 150 blocks
//                                                      from home), count deaths, damage and time; removes only its own mobs.
//                                                      Track M2: asks for keepInventory and mobGriefing first and refuses
//                                                      without keepInventory, a creeper set under mobGriefing (unless force)
//                                                      and a ring of mostly unstandable ground. Track T2: `bare` moves the
//                                                      hotbar's blades into the main inventory for the series and back after
//                                                      (skills/test/bare.ts)
//   !test inv <full|early|split|rockets|fullbar>       Track T3: save the inventory, clear the slots a command gives back
//                                                      exactly (gear, the elytra, boxes and items with NBT stay in place)
//                                                      and fill them with a preset for the room chore (skills/test/inv.ts)
//   !test inv restore [sweep] | status                 the saved inventory back; what the room chore did since
//   !test stop                                         end the run in progress and the series
// Each run restores health, food and the kit and teleports to the start first (skills/test/recovery.ts), runs the trip as
// the owner's own command and records it (skills/test/series.ts): a chat line per run, a summary, and one JSON line per
// run in <config dir>/tests/<time>-<series>.jsonl. With testMode on, a death is recovered (respawn, kit, /tp back to the
// run's start) and the afk task's walk home after the respawn is skipped while a series runs.
// testMode off: `!test` only answers, no command is ever sent and the respawn goes as before.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Vec3 } from '../connection/types.ts';
import type { Logger } from '../log.ts';
import { CommandRunner, type CommandSource } from '../skills/test/command.ts';
import { formatKit, kitView, parseKitText, snapshotKit, type KitEntry } from '../skills/test/kit.ts';
import { NEEDS_OP, OpDetector, type OpSource, type OpStatus } from '../skills/test/ops.ts';
import { claimRespawn, fmtCell, Harness, Recovery, type HarnessPorts } from '../skills/test/recovery.ts';
import { summaryLine, TEST_LIMITS, TestSeries, type RunKind, type RunSpec, type SeriesSummary } from '../skills/test/series.ts';
import { MobSeries, mobSummaryLine, parseMobsArgs, type MobsSpec } from '../skills/test/mobs.ts'; // Track M1
import { safeCell } from '../skills/combat/dodge.ts'; // Track M2: the ring's ground
import { gridOf } from '../skills/combat/targeting.ts';
import type { CommandDeps } from '../tasks/process/deps.ts';
import type { RespawnController } from '../tasks/respawn.ts';
import type { ChatLine } from './text.ts';
import { flyControlOf } from './commands-fly.ts';
import { corridorTripRunning, stopCorridorTrip } from './commands-corridor.ts';
import { waypointStoreOf } from './commands-nav.ts';
import { survivalKitOf } from './commands-survival.ts'; // Track T2: the bare series' moves
import { isBlade } from '../skills/test/bare.ts';
import { INV_SAVE_FILE, InvTest, parseInvArgs, type InvSnapshot } from '../skills/test/inv.ts'; // Track T3
import { setSaveGuard } from '../skills/test/guard.ts'; // Track T3 follow-up
import { BaseProcess, PRIORITY, type ProcessKind } from '../tasks/process/manager.ts';
import { homeControlOf } from './commands-home.ts';
import { readKit } from '../skills/fly/kit.ts';

export const TEST_COMMANDS = ['test'] as const;
/** At most this many runs in one series. */
export const MAX_RUNS = 50;
/** The kit file in the tests folder (testKit `file`). */
export const KIT_FILE = 'kit.json';
/** Track T3 follow-up: how often the save's time limit is looked at (ms). */
const INV_TICK_MS = 5000;

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
  /** Track M1: the mob series running, if any. */
  mobs(): MobSeries | undefined;
  /** The last finished series' summary. */
  last(): SeriesSummary | undefined;
  /** Resolves when the series running ends (at once when none). */
  done(): Promise<SeriesSummary | undefined>;
  /** The tests folder in use, if any. */
  dir(): string | undefined;
  /** Track T3: the inventory presets. */
  inv: InvTest;
}

/** Track T3: a user process that does nothing, so no chore moves items while the preset's or the restore's commands go out. */
class InvHold extends BaseProcess {
  readonly name = 'test inv';
  readonly kind: ProcessKind = 'user';
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status() {
    return { line: 'test inv: the commands go out' };
  }
}

/** Track T3: a save file read back (undefined when missing or not one). */
export function readInvSave(file: string): InvSnapshot | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as InvSnapshot;
    return v?.version === 1 && Array.isArray(v.slots) && v.slots.length === 36 ? v : undefined;
  } catch {
    return undefined;
  }
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
  return { error: 'usage: !test [status | op | kit | stop] | cavestart [n] [from <p>] | cave [n] | route <prefix> [n] [noshortcut] | goto <p> from <p> [n] | inv <preset | restore | status>' };
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
  let mobSeries: MobSeries | undefined; // Track M1
  let seriesDone: Promise<SeriesSummary | undefined> = Promise.resolve(undefined);
  let lastSummary: SeriesSummary | undefined;
  /** The kit of the last series (the death path outside a series restores it too). */
  let lastKit: KitEntry[] | undefined;

  const enabled = (): boolean => settings.get('testMode');
  const recovery = new Recovery({
    enabled,
    ensureOp: () => ops.ensure(),
    restore: () => harness.restore(series?.spec.start ?? (mobSeries ? mobStart : undefined), currentKit(), TEST_LIMITS.elytraMin),
    say: (m) => chat.say(m),
    log,
  });
  const currentKit = (): KitEntry[] | undefined => {
    if (series || mobSeries) return lastKit;
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
  claimRespawn(task, () => enabled() && (series !== undefined || mobSeries !== undefined));

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
    const fc = flyControlOf(task);
    fc?.supersede();
    stopCorridorTrip(task);
    if (fc?.current()?.land('stopped') !== true && fc?.controller.active) fc.controller.landNow('stopped');
    // let a flight in the air come down before its process goes
    for (let i = 0; i < 200 && (loop?.state.gliding ?? false); i++) await new Promise((r) => setTimeout(r, 100));
    d.pve?.stopCommands();
  };

  // ---- Track T3: !test inv ----
  const invFile = (): string | undefined => {
    const f = dir();
    return f ? join(f, INV_SAVE_FILE) : undefined;
  };
  const inv = new InvTest({
    run: (c) => runner.run(c, { pace: true }),
    inventory: () => world?.inventory ?? { slots: [] },
    busy: () => {
      if (series || mobSeries) return `a test series runs (!test stop)`;
      const fc = flyControlOf(task);
      if ((loop?.state.gliding ?? false) || (fc?.controller.active ?? false) || corridorTripRunning(task)) return 'a flight runs';
      const user = d.processes?.userProcesses()[0];
      if (user) return `${user.name} runs (!stop)`;
      if (d.pve?.combat.busy) return 'a fight runs';
      const a = d.processes?.active;
      if (a) return `${a.name} has control${a.name === 'room' ? ' (a room pass: try again in a moment)' : ''}`;
      if (d.mobility?.skills.status().busy) return 'a skill runs';
      return undefined;
    },
    hold: async () => {
      const pm = d.processes;
      if (!pm) return 'no process manager';
      const h = pm.add(new InvHold());
      for (let i = 0; i < 50 && pm.active !== h; i++) await new Promise((r) => setTimeout(r, 100));
      if (pm.active !== h) {
        const other = pm.active?.name ?? 'something';
        pm.stop(h);
        return `${other} keeps control`;
      }
      return () => void pm.stop(h);
    },
    fireworksBox: () => (world ? readKit(world.inventory).boxSlot : -1),
    passes: () => homeControlOf(task)?.room?.passes ?? [],
    persist: (snap) => {
      const f = invFile();
      if (!f) return undefined;
      try {
        if (snap) {
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, `${JSON.stringify(snap)}\n`, 'utf8');
        } else rmSync(f, { force: true });
        return basename(f);
      } catch (e) {
        log.warn(`test inv: could not write ${f}: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
    load: () => {
      const f = invFile();
      return f ? readInvSave(f) : undefined;
    },
    settle: async () => {
      await new Promise((r) => setTimeout(r, 800));
      await loop?.waitTicks(4);
    },
    // Track T3 follow-up: a restore waits out what keeps the bot safe, takes control from a chore below the owner's
    // commands, and is refused by the owner's own work (a series, a flight, a command)
    restoreBlock: () => {
      if (series || mobSeries) return { line: 'a test series runs (!test stop)', wait: false };
      const fc = flyControlOf(task);
      if ((loop?.state.gliding ?? false) || (fc?.controller.active ?? false) || corridorTripRunning(task)) {
        return (fc?.fleeing() ?? false) ? { line: 'the flee flight', wait: true } : { line: 'a flight runs', wait: false };
      }
      const user = d.processes?.userProcesses().find((p) => p.name !== 'test inv');
      if (user) return { line: `${user.name} runs (!stop)`, wait: false };
      if (d.pve?.combat.busy) return { line: 'the fight', wait: true };
      const a = d.processes?.active;
      if (a && a.priority > PRIORITY.user) return { line: `${a.name}`, wait: true }; // flee, guard, night shelter
      if (a?.name === 'room') return { line: 'the room pass', wait: true };
      if (!a && d.mobility?.skills.status().busy) return { line: 'a skill', wait: true };
      return undefined; // a chore below the owner's commands: the hold pauses it
    },
    announce: (m) => chat.say(m),
    canCommand: async () => {
      if (!enabled()) return 'testMode is off (!set testMode on)';
      const op = await ops.ensure();
      return op.state === 'op' ? undefined : op.line;
    },
    log,
  });
  // Track T3 follow-up (skills/test/guard.ts): the movers of items ask here while a save waits
  setSaveGuard(task, {
    waiting: (who) => inv.waiting(who),
    // the food chore: the restore first (the saved inventory has the food), unless no command can go (then it goes on)
    restoreFirst: (why) => enabled() && ops.status().state !== 'not_op' && inv.restoreFirst(why),
  });
  let offWarned = false;
  const invTick = setInterval(() => {
    try {
      if (!inv.saved()) return;
      if (!enabled()) {
        if (!offWarned) log.warn(`test inv: ${inv.waiting()} but testMode is off: no restore of my own (!set testMode on, then !test inv restore); the unload waits for it`);
        offWarned = true;
        return;
      }
      offWarned = false;
      inv.tick();
    } catch (e) {
      log.warn(`test inv: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, INV_TICK_MS);
  invTick.unref();

  // ---- Track M1: !test mobs ----
  let mobStart: Vec3 | undefined;
  const startMobs = async (spec: MobsSpec, reply: (m: string) => void): Promise<void> => {
    const pve = d.pve;
    if (!pve || !world) {
      reply(d.needsWalking('test'));
      return;
    }
    let kit: KitEntry[];
    try {
      ({ kit } = resolveKit(settings.get('testKit'), () => snapshotKit(kitView(world.inventory)), dir()));
    } catch (e) {
      reply(`test: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    lastKit = kit;
    const folder = dir();
    const file = folder ? join(folder, recordFileName(`mobs ${spec.set}`)) : undefined;
    const tag = `m1t${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
    const s = new MobSeries(spec, {
      run: (c) => runner.run(c),
      standable: (x, y, z) => {
        const g = gridOf(pve.mover);
        return g ? safeCell(g, x + 0.5, y, z + 0.5) : undefined;
      },
      restore: (start) => harness.restore(start, kit, TEST_LIMITS.elytraMin),
      position: () => harnessPorts.position() ?? pve.position(),
      home: () => task.home?.get(),
      health: () => harnessPorts.health() ?? pve.health(),
      deaths: () => respawn.deaths,
      recovered: () => recovery.settled(),
      entities: () => world.entities,
      dead: (rid) => pve.mobs.get(rid)?.dead === true,
      counters: () => ({ reflex: pve.reflex.totals.hits, taken: pve.taken, floors: pve.floors }),
      onDamage: (fn) => pve.mobs.onHit((_g, dmg) => fn(dmg)),
      say: (m) => chat.say(m),
      write: (rec) => {
        if (!file) return;
        try {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
        } catch (e) {
          log.warn(`test: could not write ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      // Track T2: the survival kit's slot move (its inventory screen, the containers' predicted move) and the combat
      // skill's hotbar puller, whose hold keeps the stowed blades out of the fight's weapon pull until the series ends
      ...(survivalKitOf(task)
        ? {
            bare: {
              slots: () => world.inventory.slots,
              move: (from: number, to: number) => survivalKitOf(task)?.moveSlot(from, to) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
              swap: (a: number, b: number) => survivalKitOf(task)?.swapSlots(a, b) ?? Promise.resolve({ ok: false, reason: 'no survival kit' }),
              hold: (on: boolean) => {
                pve.combat.puller.hold = on ? isBlade : undefined;
              },
              idle: () => {
                const fc = flyControlOf(task);
                return !(loop?.state.gliding ?? false) && !(fc?.controller.active ?? false) && !(fc?.fleeing() ?? false);
              },
              log,
            },
          }
        : {}),
      log,
    }, tag);
    const no = s.refusal();
    if (no) {
      reply(no);
      return;
    }
    mobSeries = s;
    // Track M2: the server's keepInventory and mobGriefing and the ring's ground, said in the first line; a refusal ends it here
    const pf = await s.preflight();
    log.info(`test mobs ${spec.set}: ${pf.line}${pf.refusal ? `; refused: ${pf.refusal}` : ''}`);
    if (pf.refusal) {
      mobSeries = undefined;
      reply(`${pf.refusal} (${pf.line})`);
      return;
    }
    // Track T2: `bare`: the blades out of the hotbar now (refused when no slot can take a blade); run() puts them back
    const bare = await s.stowBlades();
    if (bare.refusal) {
      mobSeries = undefined;
      log.info(`test mobs ${spec.set}: refused: ${bare.refusal}`);
      reply(bare.refusal);
      return;
    }
    const p0 = harnessPorts.position() ?? pve.position();
    mobStart = { x: Math.floor(p0.x), y: Math.floor(p0.y + 1e-3), z: Math.floor(p0.z) };
    reply(`test mobs ${spec.set}: ${spec.runs} run${spec.runs === 1 ? '' : 's'} of ${spec.mobs.length} mob${spec.mobs.length === 1 ? '' : 's'} (${spec.seconds} s each) from ${fmtCell(mobStart)}, ${pf.line}${spec.force ? ', force' : ''}${spec.bare ? `, bare (${bare.stowed}${settings.get('fleeFly') ? '' : '; fleeFly is off'})` : ''}, name tag ${tag}${file ? `; ${basename(file)}` : ''}`);
    seriesDone = (async () => {
      try {
        const sum = await s.run();
        const out = mobSummaryLine(sum);
        log.info(out);
        chat.say(out);
        return undefined;
      } catch (e) {
        log.error(`test mobs failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        chat.say(`test mobs failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      } finally {
        if (mobSeries === s) mobSeries = undefined;
      }
    })();
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
      busy: () => (d.processes?.userProcesses().length ?? 0) > 0 || (flyControlOf(task)?.controller.active ?? false) || (loop?.state.gliding ?? false) || corridorTripRunning(task),
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
    help: '[status | op | kit | stop] | cavestart [n] [from <p>] | cave [n] | route <prefix> [n] [noshortcut] | goto <p> from <p> [n] | mobs <set> [n] [<s>s] [force] [bare] | inv <full|early|split|rockets|fullbar|restore|status> (repeated test runs with /tp, re-kit and heals between them; needs testMode on, cheats on and the bot op\'d)',
    group: 'control',
    example: '!test goto base from 0 64 0 3',
    auto: 'after a death in testMode: the kit back and /tp to the run start',
    run: ({ args, reply, line }) => {
      const sub = args[0]?.toLowerCase() ?? 'status';
      if (sub === 'status') {
        const now = mobSeries ? mobSeries.status() : series ? series.status() : lastSummary ? `last: ${summaryLine(lastSummary)}` : 'no series yet';
        reply(`test: testMode ${enabled() ? 'on' : 'off'}; ${opLine(ops.status())}; ${now}${inv.preset ? `; inv preset ${inv.preset} on (!test inv restore)` : ''}`);
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
        if (mobSeries) {
          mobSeries.stop(); // Track M1: its mobs go at once
          reply(`test: stopping mobs ${mobSeries.spec.set} after run ${mobSeries.current}; its mobs removed`);
          return;
        }
        if (!series) {
          reply('test: no series running');
          return;
        }
        series.stop();
        reply(`test: stopping ${series.spec.name} after run ${series.current}`);
        return;
      }
      if (sub === 'inv') {
        // Track T3: status answers always; a preset or a restore needs testMode, the walking task and the bot op'd
        const a = parseInvArgs(args.slice(1));
        if ('error' in a) return reply(a.error);
        if (a.kind === 'status') return reply(inv.status());
        // Track T3 follow-up: every refusal is one INFO line with its reason, and the first reply is said before this
        // handler returns (the panel's command route takes the replies said meanwhile: the Realm's refusals came after an
        // await and the panel showed `replies: []`)
        const refuse = (m: string): void => {
          log.info(`test inv: refused: ${m}`);
          reply(m);
        };
        if (!enabled()) return refuse(`test: testMode is off (!set testMode on; ${NEEDS_OP})`);
        if (!loop || !d.processes || !world) return refuse(d.needsWalking('test'));
        let said = false;
        const say = (m: string): void => {
          said = true;
          reply(m);
        };
        const what = a.kind === 'restore' ? 'restore' : a.preset;
        const go = async (): Promise<void> => {
          if (ops.status().state !== 'op') {
            const op = await ops.ensure();
            if (op.state !== 'op') return refuse(`test: ${op.state === 'unknown' ? `${NEEDS_OP} (${op.line})` : op.line}`);
          }
          if (a.kind === 'restore') await inv.restore(say, { sweep: a.sweep });
          else await inv.start(a.preset, say);
        };
        // the checks that need no command run now (InvTest's refusals are synchronous up to its first await)
        void go().catch((e: unknown) => {
          log.error(`test inv failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          reply(`test inv failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        if (!said) reply(`test inv ${what}: started${ops.status().state === 'op' ? '' : ' (the operator check first)'}; ${a.kind === 'restore' ? 'the result follows' : 'the plan line follows'} in chat`);
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
      if (inv.busy) {
        reply('test: an inventory preset is going out (!test inv status)');
        return;
      }
      if (series || mobSeries) {
        reply(`test: ${(series ?? mobSeries)!.status()} (!test stop ends it)`);
        return;
      }
      if (sub === 'mobs') {
        const m = parseMobsArgs(args.slice(1));
        if ('error' in m) {
          reply(m.error);
          return;
        }
        void (async () => {
          const op = await ops.ensure();
          if (op.state !== 'op') {
            reply(`test: ${op.state === 'unknown' ? `${NEEDS_OP} (${op.line})` : op.line}`);
            return;
          }
          if (series || mobSeries) return;
          await startMobs(m, reply);
        })();
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
    clearInterval(invTick);
    setSaveGuard(task, undefined);
    series?.stop();
    mobSeries?.stop();
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
    mobs: () => mobSeries,
    last: () => lastSummary,
    done: () => seriesDone,
    dir,
    inv,
  };
  controls.set(task, control);
  return control;
}
