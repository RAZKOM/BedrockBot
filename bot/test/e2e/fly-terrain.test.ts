// e2e (tag @bds), Track BL (docs/flight.md "Terrain-safe cruise", "Dive descent", "Takeoff sites", "Flight
// re-check on long walks"): on bds-fly (flat, peaceful, fall damage ON, truth pack), one afk-task bot (walking,
// the CLI's wiring) with the flight kit, truth-built structures in a private area; every case runs RUNS times:
//   wall     a wall 80 high, 81 wide, 180 out on a 300-block flight, built after the takeoff: 0 crashes, landed
//   tower    a 9 x 9 tower 100 high 220 out on a 300-block flight: 0 crashes, landed
//   ridge    a mountain profile (thin walls stepping up to 100 and down again) 300..420 out on a 700-block flight
//   dive     from a 3 x 3 platform 100 / 200 up to a ground target 250 / 350 out, flyDescent dive and spiral:
//            0 damage, the times compared
//   site     under a roof (91 x 86, 3 up) whose only open sky within reach is 27+ blocks BEHIND the start
//            (the goal 400 ahead): `!goto` walks there, takes off away from the goal, turns and arrives
//   nosite   under a roof 121 x 121: no site within flySiteSearch: the walk out (Track AU2's legs) instead
//   recheck  `!goto` 400 away with too few rockets: walks; rockets given after 6 s: the walk stops and flies
// The table is printed. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA,
// FLY_VERBOSE=1, FLY_TERRAIN_RUNS (default 2), FLY_TERRAIN_ONLY (a comma list of the case names above).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_TERRAIN_RUNS ?? 2);
const ONLY = process.env.FLY_TERRAIN_ONLY?.split(',');
const want = (name: string): boolean => !ONLY || ONLY.includes(name);

interface Row {
  label: string;
  reply: string;
  rockets: number;
  goArounds: number;
  seconds: number;
  damage: number;
  off: number;
  crashes: number;
  log: string;
}

describe.skipIf(!E2E)('@bds fly: terrain-safe cruise, dive descent, takeoff sites, walk re-check (Track BL)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  /** Fill a box (teleporting next to it first so its chunks are loaded), then back to `back`. */
  async function fill(a: Vec3, b: Vec3, block: string, back?: Vec3): Promise<void> {
    const bt = bot!;
    const mid = { x: Math.floor((a.x + b.x) / 2) + 0.5, y: F + 120, z: Math.floor((a.z + b.z) / 2) + 0.5 };
    if (back) await teleport(bt, mid);
    await truthLoaded(bt.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 40_000);
    if (back) await teleport(bt, back);
  }

  /** Parse the end reply / flight log of a flight and record its row. */
  async function record(label: string, end: string, target: { x: number; z: number }, since: number, n0: number): Promise<Row> {
    const b = bot!;
    await sleep(600);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const logs = b.logs.slice(n0);
    const log = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
    const m = /(\d+) rockets?, (\d+) go-arounds?, (\d+) s/.exec(end) ?? /(\d+) rockets?, (\d+) go-arounds?, (\d+) s/.exec(log);
    const crashes = logs.filter((l) => l.includes('held by the server') || l.includes('glide ended by contact')).length;
    const row: Row = { label, reply: end, rockets: m ? Number(m[1]) : -1, goArounds: m ? Number(m[2]) : -1, seconds: m ? Number(m[3]) : -1, damage: dmg.total, off: hdist(g.location, target), crashes, log };
    rows.push(row);
    const extra = logs.filter((l) => /terrain ahead|terrain cleared|dive descent|takeoff-site|take off from|stopped at|held by|contact/.test(l)).map((l) => l.replace(/^\S+ info /, ''));
    notes.push(`${label}: ${end} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${log} | ${extra.join(' ; ')}`);
    return row;
  }

  /** `!fly` to a ground target from `start`, `during` run once the bot glides; returns the row. */
  async function fly(label: string, start: Vec3, target: Vec3, during?: () => Promise<void>): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, start);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const from = b.said.length;
    const n0 = b.logs.length;
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const first = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from);
    expect(first).toMatch(/^flying to /);
    if (during) {
      await until(async () => ((await b.truth.glide(b.name)).isGliding ? true : undefined), 30_000, 'gliding');
      await during();
    }
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 300_000);
    return record(label, end, { x: target.x + 0.5, z: target.z + 0.5 }, since, n0);
  }

  /** `!goto` a goal and wait for the arrival; `during` runs right after the command. */
  async function goto(label: string, start: Vec3, goal: Vec3, kit: { rockets: number }, during?: () => Promise<void>): Promise<{ row: Row; said: string[] }> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, start);
    await giveFlightKit(b, kit);
    const since = await b.truth.now();
    const from = b.said.length;
    const n0 = b.logs.length;
    await b.command(`!goto ${goal.x} ${goal.y} ${goal.z}`);
    if (during) await during();
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: '), from, 400_000);
    const said = b.said.slice(from);
    return { row: await record(label, `${said.join(' | ')}`, { x: goal.x + 0.5, z: goal.z + 0.5 }, since, n0).then((r) => ({ ...r, reply: arrived })), said };
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Terr');
    bot.settings.set('autoFly', true);
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [`${pad('case', 22)}${pad('rockets', 9)}${pad('go-arounds', 12)}${pad('s', 5)}${pad('damage', 8)}${pad('off', 7)}crashes`, ...rows.map((r) => `${pad(r.label, 22)}${pad(r.rockets, 9)}${pad(r.goArounds, 12)}${pad(r.seconds, 5)}${pad(r.damage, 8)}${pad(r.off.toFixed(1), 7)}${r.crashes}`)];
    console.log(`[fly-terrain e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it.runIf(want('wall'))('a wall 80 high 180 out, built after the takeoff: landed, 0 crashes, 0 damage', async () => {
    const x = area.x;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    const wallA = { x: x - 40, y: F, z: z + 180 };
    const wallB = { x: x + 40, y: F + 79, z: z + 182 };
    for (let i = 0; i < RUNS; i++) {
      const r = await fly(`wall #${i + 1}`, start, { x, y: F, z: z + 300 }, () => fill(wallA, wallB, 'stone'));
      await fill(wallA, wallB, 'air', start);
      expect(r.reply, r.log).toMatch(/^landed at /);
      expect(r.crashes, r.log).toBe(0);
      expect(r.damage).toBe(0);
    }
  }, 900_000);

  it.runIf(want('tower'))('a tower 100 high 220 out on a 300-block flight: landed, 0 crashes, 0 damage', async () => {
    const x = area.x + 300;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    await fill({ x: x - 4, y: F, z: z + 216 }, { x: x + 4, y: F + 99, z: z + 224 }, 'stone', start);
    for (let i = 0; i < RUNS; i++) {
      const r = await fly(`tower #${i + 1}`, start, { x, y: F, z: z + 300 });
      expect(r.reply, r.log).toMatch(/^landed at /);
      expect(r.crashes, r.log).toBe(0);
      expect(r.damage).toBe(0);
    }
    await fill({ x: x - 4, y: F, z: z + 216 }, { x: x + 4, y: F + 99, z: z + 224 }, 'air', start);
  }, 900_000);

  it.runIf(want('ridge'))('a mountain profile up to 100 high 300..420 out on a 700-block flight: landed, 0 crashes, 0 damage', async () => {
    const x = area.x + 600;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    const steps = [20, 40, 60, 80, 100, 100, 100, 80, 60, 40, 20];
    const walls = steps.map((h, i) => ({ a: { x: x - 40, y: F, z: z + 300 + i * 12 }, b: { x: x + 40, y: F + h - 1, z: z + 301 + i * 12 } }));
    // built from the ridge's middle (one teleport: its chunks loaded), then back to the start
    const mid = { x: x + 0.5, y: F, z: z + 290.5 };
    await teleport(bot!, mid);
    for (const w of walls) await fill(w.a, w.b, 'stone');
    await teleport(bot!, start);
    for (let i = 0; i < RUNS; i++) {
      const r = await fly(`ridge #${i + 1}`, start, { x, y: F, z: z + 700 });
      expect(r.reply, r.log).toMatch(/^landed at /);
      expect(r.crashes, r.log).toBe(0);
      expect(r.damage).toBe(0);
    }
    await teleport(bot!, mid);
    for (const w of walls) await fill(w.a, w.b, 'air');
    await teleport(bot!, start);
  }, 1_200_000);

  it.runIf(want('dive'))('dive against spiral from 100 and 200 up: 0 damage, the dive sooner', async () => {
    const b = bot!;
    for (const [up, out] of [
      [100, 250],
      [200, 350],
    ] as const) {
      const x = area.x + 900;
      const z = area.z + 2000;
      const top = F + up;
      const start = { x: x + 0.5, y: top, z: z + 0.5 };
      await fill({ x: x - 1, y: top - 1, z: z - 1 }, { x: x + 1, y: top - 1, z: z + 1 }, 'stone', { x: x + 3.5, y: F, z: z + 0.5 });
      for (const mode of ['dive', 'spiral'] as const) {
        b.settings.set('flyDescent', mode);
        for (let i = 0; i < RUNS; i++) {
          const r = await fly(`${mode} ${up} up #${i + 1}`, start, { x, y: F, z: z + out });
          expect(r.reply, r.log).toMatch(/^landed at /);
          expect(r.damage).toBe(0);
        }
      }
      await fill({ x: x - 1, y: top - 1, z: z - 1 }, { x: x + 1, y: top - 1, z: z + 1 }, 'air', { x: x + 3.5, y: F, z: z + 0.5 });
    }
    b.settings.set('flyDescent', 'auto');
  }, 1_800_000);

  it.runIf(want('site'))('under a roof whose open sky is behind the start: walks there, takes off away from the goal, arrives', async () => {
    const x = area.x + 1200;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    const roofA = { x: x - 45, y: F + 3, z: z - 25 };
    const roofB = { x: x + 45, y: F + 3, z: z + 60 };
    await fill(roofA, roofB, 'stone', start);
    for (let i = 0; i < RUNS; i++) {
      const { row, said } = await goto(`site #${i + 1}`, start, { x, y: F, z: z + 400 }, { rockets: 64 });
      // Track F3: the route takeoff comes before the site search in the chain, and under a roof 3 high it flies out to the open
      // sky 27 blocks behind the start by itself (bds-fly, 2026-11-06: arrived with 0 damage); either way out is accepted
      const site = said.some((s) => /^walking \d+ blocks to take off from -?\d+ -?\d+ -?\d+, then flying/.test(s));
      const route = row.log.includes('route takeoff');
      expect(site || route, said.join(' | ')).toBe(true);
      expect(row.reply, said.join(' | ')).toMatch(/^arrived at /);
      expect(row.crashes, row.log).toBe(0);
      expect(row.damage).toBe(0);
    }
    await fill(roofA, roofB, 'air', start);
  }, 1_200_000);

  it.runIf(want('nosite'))('under a roof wider than the site search: no site, the walk out instead, arrives', async () => {
    const x = area.x + 1500;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    const roofA = { x: x - 60, y: F + 3, z: z - 60 };
    const roofB = { x: x + 60, y: F + 3, z: z + 60 };
    await fill(roofA, roofB, 'stone', start);
    for (let i = 0; i < RUNS; i++) {
      const { row, said } = await goto(`nosite #${i + 1}`, start, { x, y: F, z: z + 400 }, { rockets: 64 });
      expect(said.some((s) => /^walking \d+ blocks to take off/.test(s)), said.join(' | ')).toBe(false);
      expect(said.some((s) => /walking towards .* and taking off outside/.test(s)), said.join(' | ')).toBe(true);
      expect(row.reply, said.join(' | ')).toMatch(/^arrived at /);
      expect(row.damage).toBe(0);
    }
    await fill(roofA, roofB, 'air', start);
  }, 1_200_000);

  it.runIf(want('recheck'))('too few rockets at the start, rockets given on the way: the walk stops and flies', async () => {
    const b = bot!;
    const x = area.x + 1800;
    const z = area.z + 2000;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    for (let i = 0; i < RUNS; i++) {
      const { row, said } = await goto(`recheck #${i + 1}`, start, { x, y: F, z: z + 400 }, { rockets: 2 }, async () => {
        await sleep(6000);
        await b.truth.setslot(b.name, 1, 'minecraft:firework_rocket', 64);
      });
      expect(said[0], said.join(' | ')).not.toMatch(/^flying/);
      expect(said.some((s) => s.startsWith('flying')), said.join(' | ')).toBe(true);
      expect(row.reply, said.join(' | ')).toMatch(/^arrived at /);
      expect(row.damage).toBe(0);
    }
  }, 1_200_000);
});
