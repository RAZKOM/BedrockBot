// PLAN.md task 3.2: own movement model vs bedboo's engine on three courses on bds-phys.
//
//   node fetch.mjs                  # once: bedboo source into .work/ (pinned commit)
//   node run.ts --offline           # both engines on the courses without a server: trajectory divergence
//   node run.ts [--repeat 2] [--engines own,bedboo] [--courses flat-100,stairs-10,drop-3] [--label live]
//                                   # live on bds-phys (udp/19144, truth pack): corrections per course
//
// Both engines run inside the same bot InputLoop (same flags, ticks, correction and teleport
// handling); only `loop.engine` changes. Results go to results/<mode>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Connection } from '../../bot/src/connection/connection.ts';
import { createLogger, silentLogger } from '../../bot/src/log.ts';
import { IDLE_COMMAND, InputLoop, initialBody, ownEngine } from '../../bot/src/skills/input/index.ts';
import type { BodyState, CorrectionEvent, InputLoopState, MoveCommand, PhysicsEngine, Vec3 } from '../../bot/src/skills/input/index.ts';
import { Truth, consoleCommand } from '../../bot/test/e2e/skills-truth.ts';
import { bedbooAvailable, loadBedbooEngine } from './bedboo-engine.ts';
import { COURSES, type Course } from './courses.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    offline: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '2' },
    engines: { type: 'string', default: 'own,bedboo' },
    courses: { type: 'string', default: COURSES.map((c) => c.name).join(',') },
    host: { type: 'string', default: process.env.PHYS_BDS_HOST ?? '127.0.0.1' },
    port: { type: 'string', default: process.env.PHYS_BDS_PORT ?? '19144' },
    container: { type: 'string', default: process.env.PHYS_BDS_CONTAINER ?? 'bds-phys' },
    verbose: { type: 'boolean', default: false },
    /** results/<label>.json; e.g. live-strict for a run against a server with strict movement settings */
    label: { type: 'string', default: 'live' },
  },
});

const engines: PhysicsEngine[] = [];
for (const name of args.engines.split(',')) {
  if (name === 'own') engines.push(ownEngine);
  else if (name === 'bedboo') {
    if (!bedbooAvailable()) throw new Error('bedboo not fetched: run `node fetch.mjs` first');
    engines.push(loadBedbooEngine());
  } else throw new Error(`unknown engine ${name}`);
}
const courses = args.courses.split(',').map((n) => {
  const c = COURSES.find((x) => x.name === n);
  if (!c) throw new Error(`unknown course ${n}`);
  return c;
});

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = (v: Vec3): string => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
const round = (v: Vec3, d = 4): Vec3 => ({ x: +v.x.toFixed(d), y: +v.y.toFixed(d), z: +v.z.toFixed(d) });

function save(name: string, data: unknown): void {
  const dir = join(here, 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(`results -> ${file}`);
}

// ---- offline: same scripted inputs through both engines -------------------------------------------

function stateView(s: BodyState, corrections = 0): InputLoopState {
  return { ...s, corrections, teleports: 0, tick: 0n, ready: true };
}

function simulate(engine: PhysicsEngine, course: Course): { trace: Vec3[]; ticks: number; finished: boolean } {
  let s = initialBody(course.start, true);
  let cmd: MoveCommand = { ...IDLE_COMMAND, yaw: course.yaw };
  for (let i = 0; i < 20; i++) s = engine.step(s, cmd, course.world).state;
  const trace: Vec3[] = [];
  const control = course.controller();
  for (let t = 0; t < course.maxTicks; t++) {
    const c = control(stateView(s), t, course.start);
    if (!c) return { trace, ticks: t, finished: true };
    cmd = { ...cmd, ...c };
    s = engine.step(s, cmd, course.world).state;
    trace.push({ ...s.pos });
  }
  return { trace, ticks: course.maxTicks, finished: false };
}

function offline(): void {
  const out: Record<string, unknown>[] = [];
  for (const course of courses) {
    const runs = engines.map((e) => ({ engine: e.name, ...simulate(e, course) }));
    const row: Record<string, unknown> = { course: course.name };
    for (const r of runs) row[r.engine] = { ticks: r.ticks, finished: r.finished, end: round(r.trace.at(-1) ?? course.start) };
    if (runs.length === 2) {
      const [a, b] = runs as [(typeof runs)[0], (typeof runs)[0]];
      let max = 0;
      let first = -1;
      const n = Math.min(a.trace.length, b.trace.length);
      for (let i = 0; i < n; i++) {
        const d = dist(a.trace[i]!, b.trace[i]!);
        if (d > max) max = d;
        if (first < 0 && d > 1e-4) first = i;
      }
      row.maxDivergence = +max.toFixed(6);
      row.firstDivergenceTick = first;
    }
    out.push(row);
    console.log(JSON.stringify(row));
  }
  save('offline', { at: new Date().toISOString(), engines: engines.map((e) => e.name), courses: out });
}

// ---- live: corrections on bds-phys --------------------------------------------------------------

interface RunResult {
  engine: string;
  course: string;
  rep: number;
  ticks: number;
  finished: boolean;
  corrections: number;
  details: { tick: string; local: Vec3 | undefined; server: Vec3; error: number | undefined; onGround: boolean; at: Vec3 }[];
  end: Vec3;
  truthEnd: Vec3;
  truthDiff: number;
}

async function live(): Promise<void> {
  const NAME = 'PhysSpike';
  const target = { kind: 'bds', host: args.host, port: Number(args.port), transport: 'raknet', offline: true } as const;
  for (const c of [['difficulty', 'peaceful'], ['gamerule', 'domobspawning', 'false'], ['gamerule', 'dodaylightcycle', 'false'], ['time', 'set', 'noon']]) {
    await consoleCommand(args.container, ...c);
  }
  const conn = new Connection({ version: '1.26.51', username: NAME, logger: silentLogger, reconnect: { enabled: true, maxAttempts: 4, baseMs: 2_000 } });
  const loop = new InputLoop(conn, { world: courses[0]!.world, logger: args.verbose ? createLogger('info', 'input') : silentLogger });
  const truth = new Truth(conn, args.container);
  const corrections: CorrectionEvent[] = [];
  loop.onEvent((e) => {
    if (e.kind === 'correction') corrections.push(e);
  });
  loop.start();
  await conn.connect(target);
  await loop.waitTicks(20);

  async function teleport(feet: Vec3, yaw: number): Promise<void> {
    const seen = new Promise<void>((resolve) => {
      const off = loop.onEvent((e) => {
        if (e.kind === 'teleport' && dist(e.to, feet) < 0.01) {
          off();
          resolve();
        }
      });
    });
    await truth.tp(NAME, feet, yaw, 0);
    await seen;
    loop.release();
    loop.setCommand({ yaw, pitch: 0 });
    await loop.waitTicks(20);
  }

  function drive(course: Course): Promise<{ ticks: number; finished: boolean }> {
    const start = loop.state.pos;
    let t = 0;
    const control = course.controller();
    return new Promise((resolve) => {
      const off = conn.onTick(() => {
        const c = t < course.maxTicks ? control(loop.state, t, start) : null;
        if (!c) {
          off();
          loop.release();
          resolve({ ticks: t, finished: t < course.maxTicks });
          return;
        }
        loop.setCommand(c);
        t++;
      });
    });
  }

  const results: RunResult[] = [];
  for (const course of courses) {
    loop.engine = ownEngine;
    loop.world = course.world;
    await teleport(course.start, course.yaw);
    for (const f of course.build) await truth.fill(f.from, f.to, f.block);
    await loop.waitTicks(10);
    for (const engine of engines) {
      for (let rep = 1; rep <= Number(args.repeat); rep++) {
        loop.engine = engine;
        await teleport(course.start, course.yaw);
        const before = corrections.length;
        const { ticks, finished } = await drive(course);
        await loop.waitTicks(10);
        const got = corrections.slice(before);
        const t = await truth.pos(NAME);
        const end = loop.state.pos;
        const r: RunResult = {
          engine: engine.name,
          course: course.name,
          rep,
          ticks,
          finished,
          corrections: got.length,
          details: got.map((c) => ({ tick: String(c.tick), local: c.local && round(c.local), server: round(c.server), error: c.error && +c.error.toFixed(4), onGround: c.onGround, at: round(c.server) })),
          end: round(end),
          truthEnd: round(t.location),
          truthDiff: +dist(end, t.location).toFixed(5),
        };
        results.push(r);
        console.log(
          `${course.name.padEnd(10)} ${engine.name.padEnd(7)} #${rep}: ${got.length} correction(s), ${ticks} ticks${finished ? '' : ' (TIMEOUT)'}, end ${fmt(end)}, truth diff ${r.truthDiff}` +
            got.map((c) => `\n    tick ${c.tick}: local ${c.local ? fmt(c.local) : '?'} server ${fmt(c.server)} err ${c.error?.toFixed(4) ?? '?'} onGround ${c.onGround}`).join(''),
        );
      }
    }
  }
  conn.disconnect('spike done');
  save(args.label, { at: new Date().toISOString(), server: `${args.host}:${args.port}`, repeat: Number(args.repeat), results });
}

if (args.offline) offline();
else await live();
process.exit(0);
