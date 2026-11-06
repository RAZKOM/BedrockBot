// e2e (tag @bds), flight v2 Track F4b (docs/flight.md "Corridor flight", decisions/0067): a long `!fly` along a
// coarse corridor on bds-fly3 (udp/19212, FLAT, peaceful, fall damage ON, truth pack). The corridor world of the
// unit tests (test/unit/skills/fly-corridor-world.ts) built with truth:fill in this run's private area: the start
// on the flat ground, a 3 x 3 cave mouth 150 blocks out along +x, a 140-block 3 x 3 bore, one bend to +z, 30 more
// blocks, a 2-high section 12 long (the walk) and a closed 9 x 9 x 5 chamber round the goal (about 290 blocks from
// the start, nothing reaches it from the sky), plus a 1 x 1 hole through the bore's roof 60 blocks in (the shaft).
//
// Seen first: a scripted fly-over (teleports along the corridor after the build) into a fresh world cache
// attached to the bot's world model, so the executor's cells at the mouth and the shaft are known before their
// chunks are live again, and the coarse layer (Track CB, `attachCoarseLayer` over that cache, attached to the
// navigator as index.ts does) knows the whole corridor. The cases with the stub provider's corridors
// (`setCorridorProvider(task, stub)`):
//   mouth    sky -> the mouth -> the bore (windows) -> walk the tail and the low section (FLY_F4B_RUNS, default 2)
//   shaft    sky -> down the roof hole -> the bore -> walk
//   blocked  the mouth filled with stone, the stub offers the mouth first and the shaft second: the mouth fails
//            (no floor inside it), is marked failed, the re-plan goes in through the shaft
// and with the layer's own corridors (no stub: `!fly` asks `skills.nav.coarseLayer`, modes walk + fly):
//   layer        the roof hole closed: the plan must find the mouth partway along by itself, then the trip
//   layershaft   the roof hole open again: the plan (it takes the hole), then the trip
// Scored per run: arrived in the chamber (truth), the time, rockets, damage (truth hurtlog), corrections,
// route re-plans, corridor re-plans, cruises / windows / walks. FLY_F4B_ONLY=mouth,shaft runs only those.
// Env: FLY_BDS_HOST / FLY_BDS_PORT (19212) / FLY_BDS_CONTAINER (bds-fly3) (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import type { Corridor } from '../../src/skills/fly/corridor/coarse-port.ts';
import { FlightCost } from '../../src/skills/fly/corridor/cost.ts';
import { CORRIDOR_PLAN_MS } from '../../src/skills/fly/corridor/executor.ts';
import { setCorridorProvider } from '../../src/skills/fly/corridor/registry.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { corridorLines, corridorWorld, SHAFT_AT, type CorridorWorld } from '../unit/skills/fly-corridor-world.ts';
import { E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ONLY = new Set((process.env.FLY_F4B_ONLY ?? '').split(',').filter(Boolean));
const RUNS = Number(process.env.FLY_F4B_RUNS ?? 2);
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Row {
  label: string;
  ok: boolean;
  inChamber: boolean;
  seconds: number;
  rockets: number;
  damage: number;
  causes: string[];
  corrections: number;
  routeReplans: number;
  held: number;
  plans: number;
  replans: number;
  cruises: number;
  windows: number;
  walks: number;
  legs: string;
  line: string;
}

/** The numbers of the executor's `corridor: arrived at ... / gave up on ...` log line (executor.ts run). */
function parseEnd(line: string | undefined): Omit<Row, 'label' | 'ok' | 'inChamber' | 'damage' | 'causes' | 'legs' | 'line'> {
  const num = (re: RegExp): number => {
    const m = line ? re.exec(line) : null;
    return m ? Number(m[1]) : -1;
  };
  return {
    plans: num(/(\d+) corridor plans/),
    replans: num(/\((\d+) re-plans\)/),
    cruises: num(/, (\d+) cruises/),
    windows: num(/, (\d+) windows underground/),
    walks: num(/, (\d+) walks/),
    rockets: num(/, (\d+) rockets/),
    corrections: num(/, (\d+) corrections/),
    routeReplans: num(/, (\d+) route re-plans/),
    held: num(/, (\d+) held/),
    seconds: num(/, ([\d.]+) s$/),
  };
}

describe.skipIf(!E2E)('@bds fly: corridor flight to a goal only reachable through a cave mouth (flight v2, Track F4b)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;
  const w: CorridorWorld = corridorWorld({ x: area.x, z: area.z }, { shaft: true });
  const home: Vec3 = { x: w.start.x + 0.5, y: F, z: w.start.z + 0.5 };
  /** Beside the corridor (outside every hull), where every fill's chunks are loaded. */
  const site: Vec3 = { x: w.mouthX + 72.5, y: F, z: w.start.z - 11.5 };

  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot!.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 60_000);

  /** The fly-over: far away (every corridor chunk dropped from the live model), then along the corridor (each chunk loaded again after the build, so the cache records it as built), then home. */
  async function flyOver(): Promise<void> {
    const b = bot!;
    await teleport(b, { x: home.x - 260, y: F, z: home.z });
    for (const x of [w.start.x + 60, w.mouthX, w.mouthX + 72, w.mouthX + 144]) await teleport(b, { x: x + 0.5, y: F, z: w.start.z - 11.5 });
    await teleport(b, { x: w.bendX + 12.5, y: F, z: w.goal.z + 0.5 });
    await b.built.mobility!.loop.waitTicks(20);
    await teleport(b, home);
  }

  /** One trip: `!fly` to the goal from home with the stub offering `corridors`, or (undefined) the navigator's coarse layer planning it. */
  async function trip(label: string, corridors: Corridor[] | undefined): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    const stub = corridors ? w.stub(corridors) : undefined;
    setCorridorProvider(b.task, stub);
    await teleport(b, home, -90);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!fly ${w.goal.x} ${w.goal.y} ${w.goal.z}`);
    const start = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: '), from, 60_000);
    expect(start, label).toMatch(/along a corridor/);
    const end = await b.reply((s) => (s.startsWith('arrived at') && s.includes('along a corridor')) || s.startsWith('fly: the corridor'), from, 420_000);
    await sleep(1000);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
    const line = logs.find((l) => l.startsWith('corridor: arrived at') || l.startsWith('corridor: gave up on'));
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const p = g.location;
    const inChamber = Math.abs(p.x - (w.goal.x + 0.5)) <= 4.5 && p.z >= w.goal.z - 4 && p.z <= w.goal.z + 5 && Math.abs(p.y - F) < 0.1;
    const row: Row = { label, ok: end.startsWith('arrived'), inChamber, damage: dmg.total, causes: dmg.causes, legs: /\(([^)]*)\);/.exec(end)?.[1] ?? '', line: line ?? end, ...parseEnd(line) };
    rows.push(row);
    const steps = logs.filter((l) => /^corridor: (plan|leg|underground|the window|window)|flight: (landed|ended)|takeoff/.test(l)).map((l) => l.slice(0, 300));
    notes.push(`${label}: ${end} | at ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} | damage ${Math.round(dmg.total * 10) / 10}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | marks ${stub ? stub.marks.map((m) => `${m.id} ${m.mode} ${m.outcome}`).join(', ') || 'none' : `the layer: ${coarse?.layer.info().marks ?? 0}`}\n    ${steps.join('\n    ')}`);
    return row;
  }

  const check = (r: Row): void => {
    expect(r.ok, `${r.label}: ${r.line}`).toBe(true);
    expect(r.inChamber, `${r.label}: ${r.line}`).toBe(true);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Cr');
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-corridor-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(bot.built.mobility!.world);
    // the build: stone hulls, then the air bores, all from beside the corridor
    await teleport(bot, site);
    for (const f of w.fills) await fill(f.from, f.to, f.block);
    await bot.built.mobility!.loop.waitTicks(10);
    await flyOver();
    // the coarse layer over that cache, attached to the navigator as index.ts does (its goto corridors from 96 blocks)
    const mob = bot.built.mobility!;
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
  }, 300_000);

  afterAll(async () => {
    offNav?.();
    coarse?.detach();
    if (bot) await bot.stop();
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('run', 12)}${pad('arrived', 9)}${pad('chamber', 9)}${pad('s', 7)}${pad('rockets', 9)}${pad('damage', 8)}${pad('corr', 6)}${pad('held', 6)}${pad('route re', 10)}${pad('plans', 7)}${pad('re-plans', 10)}${pad('cruise', 8)}${pad('windows', 9)}${pad('walks', 7)}legs`,
      ...rows.map((r) => `${pad(r.label, 12)}${pad(r.ok ? 'yes' : 'NO', 9)}${pad(r.inChamber ? 'yes' : 'NO', 9)}${pad(r.seconds, 7)}${pad(r.rockets, 9)}${pad(Math.round(r.damage * 10) / 10, 8)}${pad(r.corrections, 6)}${pad(r.held, 6)}${pad(r.routeReplans, 10)}${pad(r.plans, 7)}${pad(r.replans, 10)}${pad(r.cruises, 8)}${pad(r.windows, 9)}${pad(r.walks, 7)}${r.legs}`),
    ];
    console.log(`[fly-corridor e2e] area cell ${area.cell} (${area.x}, ${area.z}); seen first: scripted fly-over into a fresh world cache\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it.skipIf(!want('mouth'))('flies to the mouth, through the bore underground and walks the rest to the chamber', async () => {
    for (let i = 0; i < RUNS; i++) check(await trip(`mouth #${i + 1}`, [w.corridor]));
  }, 1_200_000);

  it.skipIf(!want('shaft'))('drops down the roof hole into the bore and goes on to the chamber', async () => {
    check(await trip('shaft', [w.viaShaft!]));
  }, 600_000);

  it.skipIf(!want('blocked'))('marks the blocked mouth failed and goes in through the shaft on the re-plan', async () => {
    const m = w.mouthX;
    await teleport(bot!, site);
    await fill({ x: m, y: F, z: w.start.z - 1 }, { x: m + 3, y: F + 2, z: w.start.z + 1 }, 'stone');
    await teleport(bot!, home);
    try {
      const r = await trip('blocked', [w.corridor, w.viaShaft!]);
      check(r);
      expect(r.replans, r.line).toBeGreaterThanOrEqual(1);
    } finally {
      await teleport(bot!, site);
      await fill({ x: m, y: F, z: w.start.z - 1 }, { x: m + 3, y: F + 2, z: w.start.z + 1 }, 'air');
      await teleport(bot!, home);
    }
  }, 600_000);

  /** The layer's corridor from home (walk + fly, as the executor asks), logged; FlightCost registered as `!fly` registers it. */
  async function layerPlan(label: string): Promise<Corridor> {
    const layer = coarse!.layer;
    layer.setCost('fly', new FlightCost());
    const req = { start: home, goal: { x: w.goal.x + 0.5, y: F, z: w.goal.z + 0.5 }, startMode: 'walk' as const, goalStanding: true, maxMs: CORRIDOR_PLAN_MS };
    const c = await layer.plan({ ...req, modes: ['fly', 'walk'] });
    const walk = await layer.plan({ ...req, modes: ['walk'] });
    notes.push(`${label} plan (fly + walk): ${corridorLines(c).join('\n    ')}\n  ${label} plan (walk only): ${corridorLines(walk).join('\n    ')}`);
    expect(c.status, corridorLines(c).join(' | ')).toBe('found');
    expect(c.legs.map((l) => l.mode)).toEqual(['fly', 'walk']);
    // the fly leg goes into the bore partway along: a waypoint inside it
    const inBore = (p: Vec3) => p.x >= w.mouthX && p.x <= w.bendX + 1 && Math.abs(p.z - (w.start.z + 0.5)) <= 2 && p.y >= F && p.y <= F + 4;
    expect(c.legs[0]!.waypoints.some(inBore), corridorLines(c).join(' | ')).toBe(true);
    expect(c.cost).toBeLessThan(walk.cost);
    return c;
  }

  const hole = (block: string) => fill({ x: w.mouthX + SHAFT_AT, y: F + 3, z: w.start.z }, { x: w.mouthX + SHAFT_AT, y: F + 4, z: w.start.z }, block);

  it.skipIf(!want('layer'))("the coarse layer's own corridor with the roof hole closed: finds the mouth partway along, then the trip along it", async () => {
    await teleport(bot!, site);
    await hole('stone');
    await bot!.built.mobility!.loop.waitTicks(10);
    await teleport(bot!, home);
    try {
      const c = await layerPlan('layer');
      // no way in but the mouth: nothing of the fly leg at the hole
      expect(c.legs[0]!.portals.some((p) => Math.floor(p.center.x) === w.mouthX + SHAFT_AT), corridorLines(c).join(' | ')).toBe(false);
      check(await trip('layer', undefined));
    } finally {
      await teleport(bot!, site);
      await hole('air');
      await bot!.built.mobility!.loop.waitTicks(10);
      await teleport(bot!, home);
    }
  }, 600_000);

  it.skipIf(!want('layershaft'))("the coarse layer's own corridor with the roof hole open: the plan and the trip", async () => {
    await layerPlan('layershaft');
    check(await trip('layershaft', undefined));
  }, 600_000);
});
