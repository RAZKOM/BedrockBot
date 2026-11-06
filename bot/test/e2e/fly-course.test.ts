// e2e (tag @bds), Track F4a (docs/flight.md "Obstacle course (Track F4a)", decisions/0067): the obstacle courses of
// the flight benchmark on the server (bds-fly2: udp/19210, FLAT, peaceful, fall damage ON, truth pack). The truth pack
// builds each course in the private area (`truth:course build`: the layout of packs/truth/src/course-layout.ts, the
// one the offline bench flies), and the bare route driver (`flyRoute`, the tracker on the real body) flies its legs:
//   rings     five 3 x 3 openings at heights 7, 12, 6, 14 and 8 (from standing on a pillar 11 up; the slalom too)
//   slalom    five 3-wide gates 14 apart, alternating 3 left and right
//   tunnel    the 3 x 3 S-tunnel 8 up, entered from the air (the pillar 9 up)
//   stair     the 45-degree staircase 3 high, from standing at its foot, out of its top
//   overhang  the landing on a ledge under a roof 4 above it (from the route hand-over's entry, put there falling)
//   stack     the landing on the inner one of the stacked platforms (2 high)
//   shaft     the landing on the floor of a 1 x 1 shaft 10 deep
//   full      the stations chained: climb (start pad, stair, rings), weave (slalom, tunnel), ledge (the overhang),
//             finish (from the ledge onto the finish pad); stack and shaft from their entries
// Per leg: done or not, the goals passed, ticks, rockets, the server's damage (truth), corrections, re-plans. The
// table goes to the log (docs/flight.md has the measured ones). Gated: every course builds, every leg is flown, and
// each passage station (rings, slalom, tunnel, stair) passes all its goals in at least one of its runs.
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_COURSE_ONLY=rings,full,
// FLY_COURSE_RUNS (default 2 per station, 1 for the full course).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { obstacleCourse, type Course } from '../../src/skills/fly/route/courses.ts';
import { flyRoute, type RouteLiveReport } from '../../src/skills/fly/route/live.ts';
import { RoutePlannerClient } from '../../src/skills/fly/route/worker.ts';
import { E2E, FEET_Y, prepareServer, privateArea, sleep, startFlyBot, teleport, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ONLY = new Set((process.env.FLY_COURSE_ONLY ?? '').split(',').filter(Boolean));
const RUNS = Number(process.env.FLY_COURSE_RUNS ?? 2);
const STATIONS = ['rings', 'slalom', 'tunnel', 'stair', 'overhang', 'stack', 'shaft'] as const;
const LANDINGS: ReadonlySet<string> = new Set(['overhang', 'stack', 'shaft']);
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Row {
  leg: string;
  run: number;
  end: string;
  reached: number;
  goals: number;
  ticks: number;
  rockets: number;
  damage: number;
  causes: string[];
  corrections: number;
  replans: number;
  hits: number;
  chained: boolean;
}

describe.skipIf(!E2E)('@bds fly: the obstacle courses (Track F4a)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const planner = new RoutePlannerClient();

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Co');
    await teleport(bot, home);
    await bot.command('!set autoFly off');
    await sleep(300);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    await planner.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('leg', 16)}${pad('run', 4)}${pad('end', 9)}${pad('goals', 7)}${pad('ticks', 7)}${pad('rockets', 9)}${pad('damage', 8)}${pad('corr', 6)}${pad('replans', 9)}local hits`,
      ...rows.map((r) => `${pad(r.leg + (r.chained ? ' +' : ''), 16)}${pad(r.run, 4)}${pad(r.end, 9)}${pad(`${r.reached}/${r.goals}`, 7)}${pad(r.ticks, 7)}${pad(r.rockets, 9)}${pad(r.damage, 8)}${pad(r.corrections, 6)}${pad(r.replans, 9)}${r.hits}`),
    ];
    console.log(`[fly-course e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  /** Build (or clear) course `name` with its origin at `o` (the ground's feet height). */
  async function course(sub: 'build' | 'clear', name: string, o: Vec3): Promise<void> {
    const r = await bot!.truth.cmd<{ pieces: number; volume: number; ticks: number }>('course', [sub, name, o.x, o.y, o.z], 180_000);
    if (!r.ok) throw new Error(`truth:course ${sub} ${name} failed: ${r.reason} ${JSON.stringify(r.data)}`);
    notes.push(`course ${sub} ${name} at ${o.x} ${o.y} ${o.z}: ${r.data.volume} blocks in ${r.data.pieces} pieces, ${r.data.ticks} ticks`);
  }

  /** The kit without the flight's ground work: the elytra worn, rockets in slot 0, full health. */
  async function kit(rockets: number): Promise<void> {
    const b = bot!;
    const inv = b.built.mobility!.world.inventory;
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('clear', [b.name]);
    await b.truth.equip(b.name, 'Chest', 'elytra');
    await b.truth.setslot(b.name, 0, 'firework_rocket', rockets);
    await until(() => (inv.slots[0]?.name === 'firework_rocket' ? true : undefined), 10_000, 'the rockets in the inventory model');
    await until(async () => ((await b.truth.chestSlot(b.name))?.typeId.endsWith('elytra') ? true : undefined), 10_000, 'the elytra worn');
    await b.built.mobility!.loop.waitTicks(10);
  }

  /** The local world model holds the course's cells around `at` (a plan over stale cells goes through stone). */
  async function worldHolds(c: Course, at: Vec3): Promise<void> {
    const w = bot!.built.mobility!.loop.world;
    const probes: Vec3[] = [];
    for (let dz = -8; dz <= 60; dz += 4) for (let dx = -8; dx <= 8; dx += 4) for (const dy of [0, 4, 8, 12]) probes.push({ x: Math.floor(at.x) + dx, y: F + dy, z: Math.floor(at.z) + dz });
    await until(() => (probes.every((p) => w.solidAt(p.x, p.y, p.z) === c.world.solidAt(p.x, p.y, p.z)) ? true : undefined), 20_000, 'the world model to hold the course', 250).catch((e: unknown) => notes.push(`world model: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Put the body at a leg's start: standing on its floor, or in the air there with the glide asked for. */
  async function startAt(c: Course): Promise<void> {
    const b = bot!;
    const mob = b.built.mobility!;
    const s = c.start;
    if (s.standing) {
      await teleport(b, s.pos, s.yaw);
      await worldHolds(c, s.pos);
      await kit(16);
      await teleport(b, s.pos, s.yaw);
      mob.loop.setCommand({ yaw: s.yaw, pitch: 0, forward: 0, strafe: 0, jump: false, sneak: false });
      await mob.loop.waitTicks(5);
      return;
    }
    await teleport(b, { x: s.pos.x, y: F, z: s.pos.z }, s.yaw);
    await worldHolds(c, s.pos);
    await kit(16);
    await b.truth.tp(b.name, s.pos, s.yaw, 0);
    mob.loop.setCommand({ yaw: s.yaw, pitch: 0, forward: 0, strafe: 0, glide: true, jump: true, sneak: false });
    await until(() => (mob.loop.state.gliding ? true : undefined), 4000, 'the glide at the start', 25);
    mob.loop.setCommand({ jump: false });
    await mob.loop.waitTicks(2);
  }

  /** Fly one leg from where the body is now. */
  async function fly(label: string, run: number, c: Course, chained: boolean): Promise<Row> {
    const b = bot!;
    const mob = b.built.mobility!;
    const since = await b.truth.now();
    const lines: string[] = [];
    const flight = flyRoute(
      { loop: mob.loop, world: mob.loop.world, queue: (n, p) => b.conn.queue(n as never, p as never), inventory: mob.world.inventory, hotbar: b.task.pve!.hotbar, entities: mob.world.entityTracker },
      {
        goals: c.goals,
        margin: c.margin,
        maxTicks: 900,
        maxMs: 600,
        maxNodes: 40_000,
        planner: (grid) => planner.plannerOver(grid),
        ...(c.library ? { library: c.library } : {}),
        ...(c.weight !== undefined ? { weight: c.weight } : {}),
        note: (m) => lines.push(m),
      },
    );
    const report: RouteLiveReport = await flight.done;
    await sleep(800);
    const dmg = await b.truth.damageSince(since, b.name);
    const row: Row = { leg: label, run, end: report.end, reached: report.reached, goals: report.goals, ticks: report.ticks, rockets: report.rockets, damage: dmg.total, causes: dmg.causes, corrections: report.corrections, replans: report.stats.replans, hits: report.hits, chained };
    rows.push(row);
    const labels = c.labels ?? [];
    notes.push(`${label} #${run}: ${report.end} ${report.reached}/${report.goals}${report.reached < report.goals && labels[report.reached] ? ` (stopped before ${labels[report.reached]})` : ''}, ${report.ticks} ticks, ${report.rockets} rockets, damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''}, ${report.corrections} corrections, plans ${report.stats.plans} (${report.stats.replans} re, ${report.stats.partial} partial), held fires ${report.heldFires} | ${lines.filter((l) => !l.includes('passed at')).slice(0, 6).join(' ; ')}`);
    return row;
  }

  STATIONS.forEach((name, i) => {
    it.skipIf(!want(name))(`${name}: built by truth:course, flown ${RUNS} times`, async () => {
      const o: Vec3 = { x: area.x + 60 * i, y: F, z: area.z + 40 };
      const [c] = obstacleCourse(name, o);
      await course('build', name, o);
      const got: Row[] = [];
      try {
        for (let run = 1; run <= RUNS; run++) {
          await bot!.command('!stop');
          await sleep(500);
          await startAt(c!);
          got.push(await fly(name, run, c!, false));
        }
      } finally {
        await teleport(bot!, home);
        await course('clear', name, o).catch(() => undefined);
      }
      expect(got.length).toBe(RUNS);
      // gated: each passage station, from its standing start, passes every goal in one of its runs (the damage is
      // measured: docs/flight.md "Obstacle course (Track F4a)" has the rates; offline every run is clean, on the server
      // the re-plans answer for a state 10 ticks old). The landings start where the brain hands over (gliding at 1.0 a
      // tick), which the bare driver cannot make on the server (the body falls from the teleport): measured, not gated
      // (the brain's route landings are fly-route-land's)
      if (!LANDINGS.has(name)) expect(got.some((r) => r.end === 'done'), `${name}: ${got.map((r) => `${r.end} ${r.reached}/${r.goals} damage ${r.damage}`).join('; ')}`).toBe(true);
    }, 900_000);
  });

  it.skipIf(!want('full'))('full: the stations chained, from the start pad to the finish pad', async () => {
    const o: Vec3 = { x: area.x - 80, y: F, z: area.z + 40 };
    const legs = obstacleCourse('full', o);
    await course('build', 'full', o);
    const runs = Number(process.env.FLY_COURSE_RUNS ?? 1);
    try {
      for (let run = 1; run <= runs; run++) {
        let last: Row | undefined;
        for (const c of legs) {
          const label = c.name.replace('full/', 'full ');
          const on = c.chained === true && last?.end === 'done';
          if (!on) {
            await bot!.command('!stop');
            await sleep(500);
            await startAt(c);
          }
          last = await fly(label, run, c, on);
        }
      }
    } finally {
      await teleport(bot!, home);
      await course('clear', 'full', o).catch(() => undefined);
    }
    expect(rows.filter((r) => r.leg.startsWith('full')).length).toBe(legs.length * runs);
  }, 1_800_000);
});
