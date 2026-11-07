// e2e (tag @bds), Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", decisions/0068): a real cave from the
// bot's world cache rebuilt on bds-fly2 (udp/19210, FLAT, peaceful, fall damage ON, truth pack) and travelled the
// three ways the owner's waypoints name. The cave is PRIVATE data: the extract and the waypoints come from the private
// fixture (bot/fixtures-private/cave, CAVE_FIXTURE_DIR; git-ignored) and this suite skips without it. Nothing of the
// cave is in the repository; the replica keeps the real heights and is moved in x and z by a multiple of 16 (to
// FLY_CAVE_AT, default -96000,-96000), so its cells line up with the real chunks.
//
// The build (`truth:cave`, packs/truth/src/cave.ts): stone over the extract's box, then its air and water as boxes
// (cave-layout.ts greedyBoxes; every cell of the cache that is not air or water, the unknown chunks too, is stone),
// sent in parts of at most 1800 characters. FLY_CAVE_REUSE=1 skips it (a replica of the same fixture is still there).
// The home waypoint (outside the box) gets a 5 x 5 stone pad at its real height; the ground between it and the box is
// the flat world's, far under it (the real terrain is not built).
//
// Seen first, as fly-corridor: a scripted fly-over of the box (teleports onto its surface) into a fresh world cache,
// the coarse layer over that cache attached to the navigator (index.ts's wiring), FlightCost registered.
//   tripC  `!fly` from the home pad to cave_start (the entrance by cave_2): today's live behaviour (UNDER_FLY as is)
//   walkA  route A walked stop to stop (`skills.goto` near each waypoint); a failed leg is teleported over
//   flyA / flyB  every leg of routes A and B as a corridor trip with the underground stretches flown (underFly on)
// Scored per run (the table goes to the log, docs/flight.md has the measured ones): arrived, the distance left, the
// time, rockets, damage (truth hurtlog), corrections, re-plans, corridor plans / windows / walks, ticks in water.
// Gated: the build, the fly-over and every run completing. The numbers themselves are measured, not gated.
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts; run with 19210 / bds-fly2), FLY_CAVE_AT="x,z",
// FLY_CAVE_REUSE=1, FLY_CAVE_ONLY=tripC,walkA,flyA,flyB, FLY_CAVE_LEGS=3,4 (the legs of A and B by index), FLY_CAVE_STYLE=1 (Track F5b's cave style on the flown runs),
// FLY_CAVE_LEG_S (the time a run may take, default 180), FLY_CAVE_REPORT=file (the table written there too), FLY_VERBOSE=1.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxMessages, CAVE_AIR, CAVE_STONE, CAVE_WATER, greedyBoxes } from '../../../packs/truth/src/cave-layout.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { caveLegs, caveWorld, loadCaveFixture, ROUTE_A, ROUTE_B, shift, type CaveLeg } from '../../src/skills/fly/corridor/cave.ts';
import { setCorridorUnderFly } from '../../src/skills/fly/corridor/registry.ts';
import { CLS_AIR, CLS_WATER } from '../../src/world/cache/types.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { buildPlatform, E2E, giveFlightKit, prepareServer, sleep, startFlyBot, teleport, type FlyBot } from './fly-truth.ts';

const fix = loadCaveFixture();
const ONLY = new Set((process.env.FLY_CAVE_ONLY ?? '').split(',').filter(Boolean));
const LEGS = new Set((process.env.FLY_CAVE_LEGS ?? '').split(',').filter(Boolean).map(Number));
const LEG_MS = Number(process.env.FLY_CAVE_LEG_S ?? 180) * 1000;
const REUSE = process.env.FLY_CAVE_REUSE === '1';
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);
const wantLeg = (i: number): boolean => LEGS.size === 0 || LEGS.has(i);
/** The characters of one `truth:cave part` message (a scriptevent message holds 2048). */
const PART_CHARS = 1800;
/** Parts in flight at once. */
const PART_JOBS = 6;

/** Where the replica's box starts in x and z (its min corner snapped to the chunk grid), FLY_CAVE_AT or the default. */
function replicaAt(): { x: number; z: number } {
  const pinned = process.env.FLY_CAVE_AT?.split(',').map(Number);
  if (pinned?.length === 2 && pinned.every(Number.isFinite)) return { x: pinned[0]!, z: pinned[1]! };
  return { x: -96000, z: -96000 };
}

interface Row {
  run: string;
  leg: string;
  ok: boolean;
  /** The distance from the goal's feet cell at the end. */
  off: number;
  seconds: number;
  rockets: number;
  damage: number;
  corrections: number;
  replans: number;
  plans: number;
  windows: number;
  walks: number;
  water: number;
  how: string;
}

/** The numbers of the executor's `corridor: arrived at ... / gave up on ...` line (as fly-corridor.test.ts). */
function parseEnd(line: string | undefined): Pick<Row, 'plans' | 'windows' | 'walks' | 'rockets' | 'corrections' | 'replans' | 'seconds'> {
  const num = (re: RegExp): number => {
    const m = line ? re.exec(line) : null;
    return m ? Number(m[1]) : -1;
  };
  return { plans: num(/(\d+) corridor plans/), windows: num(/, (\d+) windows underground/), walks: num(/, (\d+) walks/), rockets: num(/, (\d+) rockets/), corrections: num(/, (\d+) corrections/), replans: num(/, (\d+) route re-plans/), seconds: num(/, ([\d.]+) s$/) };
}

describe.skipIf(!E2E || !fix)('@bds fly: a real cave rebuilt from the world cache (Track F5a)', () => {
  const e = fix!.extract;
  const world = caveWorld(e);
  const at = replicaAt();
  const d: Vec3 = { x: Math.floor(at.x / 16) * 16 - Math.floor(e.box.min.x / 16) * 16, y: 0, z: Math.floor(at.z / 16) * 16 - Math.floor(e.box.min.z / 16) * 16 };
  const min = shift(e.box.min, d);
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;
  let water = 0;
  let offWater: (() => void) | undefined;
  const legsA = caveLegs(fix!, world, ROUTE_A);
  const legsB = caveLegs(fix!, world, ROUTE_B);
  const homeReal = fix!.waypoints.get('home');
  const start = legsA[0]!.from;
  const centre = (p: Vec3): Vec3 => ({ x: p.x + d.x + 0.5, y: p.y, z: p.z + d.z + 0.5 });
  const home: Vec3 | undefined = homeReal ? centre({ x: Math.floor(homeReal.x), y: Math.floor(homeReal.y), z: Math.floor(homeReal.z) }) : undefined;

  /** Send the build: begin, the parts (PART_JOBS at a time), build; the seconds each step took. */
  async function buildReplica(b: FlyBot): Promise<void> {
    const t0 = performance.now();
    const code = (x: number, y: number, z: number): number => {
      const c = e.cls(e.box.min.x + x, e.box.min.y + y, e.box.min.z + z);
      return c === CLS_AIR ? CAVE_AIR : c === CLS_WATER ? CAVE_WATER : CAVE_STONE;
    };
    const boxes = [...greedyBoxes(e.size, code, CAVE_AIR), ...greedyBoxes(e.size, code, CAVE_WATER)];
    const parts = boxMessages(boxes, PART_CHARS);
    const tBoxes = performance.now();
    const session = `c${Math.random().toString(36).slice(2, 8)}`;
    const ok = async (args: (string | number)[], ms: number): Promise<Record<string, unknown>> => {
      const r = await b.truth.cmd<Record<string, unknown>>('cave', args, ms);
      if (!r.ok) throw new Error(`truth:cave ${String(args[0])} failed: ${r.reason} ${JSON.stringify(r.data)}`);
      return r.data;
    };
    await ok(['begin', session, min.x, min.y, min.z, e.size.x, e.size.y, e.size.z], 30_000);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < parts.length; i = next++) await ok(['part', session, i, parts[i]!], 60_000);
    };
    await Promise.all(Array.from({ length: PART_JOBS }, worker));
    const tSent = performance.now();
    const r = await ok(['build', session, parts.length], 1_800_000);
    const tBuilt = performance.now();
    const s = (a: number, z: number) => ((z - a) / 1000).toFixed(1);
    notes.push(
      `build: box ${e.size.x} x ${e.size.y} x ${e.size.z} (${e.size.x * e.size.y * e.size.z} cells), ${boxes.length} boxes in ${parts.length} parts (${parts.reduce((n, p) => n + p.length, 0)} characters); boxes ${s(t0, tBoxes)} s, sent ${s(tBoxes, tSent)} s, built ${s(tSent, tBuilt)} s (${String(r.pieces)} pieces, ${String(r.ticks)} ticks), total ${s(t0, tBuilt)} s`,
    );
  }

  /** Teleports over the box's surface (every 96 blocks), so the cache records the replica's chunks, then home. */
  async function flyOver(b: FlyBot): Promise<void> {
    const xs: number[] = [];
    const zs: number[] = [];
    for (let x = e.box.min.x + 8; x <= e.box.max.x + 48; x += 96) xs.push(Math.min(x, e.box.max.x - 8));
    for (let z = e.box.min.z + 8; z <= e.box.max.z + 48; z += 96) zs.push(Math.min(z, e.box.max.z - 8));
    let n = 0;
    for (const x of xs) {
      for (const z of zs) {
        const top = e.top(x, z);
        const y = top !== undefined && top > -1000 ? Math.min(top + 1, e.box.max.y) : e.box.max.y;
        const feet = world.feetCell({ x, y, z });
        if (!feet) continue;
        await teleport(b, centre(feet));
        n++;
      }
    }
    // the flat ground between home and the box (the cruise of trip C; the live bot has seen its own terrain there)
    let m = 0;
    if (home) {
      const to = centre(start);
      const len = Math.hypot(to.x - home.x, to.z - home.z);
      for (let s = 0; s < len; s += 96) {
        const t = s / len;
        await teleport(b, { x: Math.floor(home.x + (to.x - home.x) * t) + 0.5, y: -60, z: Math.floor(home.z + (to.z - home.z) * t) + 0.5 });
        m++;
      }
    }
    await b.built.mobility!.loop.waitTicks(20);
    notes.push(`fly-over: ${n} of ${xs.length * zs.length} surface points, ${m} on the flat ground from home towards the box`);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Cv');
    await bot.command('!set autoFly off');
    await sleep(300);
    const mob = bot.built.mobility!;
    offWater = mob.loop.onBeforeStep((_t, s) => {
      if (s.inWater) water++;
    });
    // away from the box while it is built (the build loads its chunks under ticking areas), then the cache and the fly-over
    const away: Vec3 = home ?? { x: min.x - 400.5, y: -60, z: min.z - 0.5 };
    if (home) await buildPlatform(bot, { x: home.x - 0.5, z: home.z - 0.5 }, home.y, 2, home);
    else await teleport(bot, away);
    if (!REUSE) await buildReplica(bot);
    else notes.push('build: reused (FLY_CAVE_REUSE=1)');
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-cave-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(mob.world);
    await flyOver(bot);
    await teleport(bot, away);
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
  }, 2_400_000);

  afterAll(async () => {
    offWater?.();
    offNav?.();
    coarse?.detach();
    if (bot) {
      setCorridorUnderFly(bot.task, undefined);
      await bot.stop();
    }
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const table = [
      `${pad('run', 7)}${pad('leg', 30)}${pad('ok', 5)}${pad('off', 7)}${pad('s', 7)}${pad('rockets', 9)}${pad('damage', 8)}${pad('corr', 6)}${pad('re', 5)}${pad('plans', 7)}${pad('windows', 9)}${pad('walks', 7)}${pad('water', 7)}how`,
      ...rows.map((r) => `${pad(r.run, 7)}${pad(r.leg, 30)}${pad(r.ok ? 'yes' : 'NO', 5)}${pad(r1(r.off), 7)}${pad(r1(r.seconds), 7)}${pad(r.rockets, 9)}${pad(r1(r.damage), 8)}${pad(r.corrections, 6)}${pad(r.replans, 5)}${pad(r.plans, 7)}${pad(r.windows, 9)}${pad(r.walks, 7)}${pad(r.water, 7)}${r.how}`),
    ];
    const text = `[fly-cave e2e] replica moved by a multiple of 16 to (${min.x}, ${min.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`;
    console.log(text);
    if (process.env.FLY_CAVE_REPORT) writeFileSync(process.env.FLY_CAVE_REPORT, `${text}\n`);
  }, 60_000);

  /** The body's distance from a replica feet cell (the truth's position). */
  async function offFrom(b: FlyBot, goal: Vec3): Promise<number> {
    const p = (await b.truth.glide(b.name)).location;
    return Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z);
  }

  /** Stand the body at a leg's start (in the replica), the kit given, the commands at rest. */
  async function standAt(b: FlyBot, cell: Vec3): Promise<void> {
    await b.command('!stop');
    await sleep(500);
    await teleport(b, centre(cell));
    await giveFlightKit(b, { rockets: 64 });
    await teleport(b, centre(cell));
  }

  it.skipIf(!want('tripC') || !home)("trip C: `!fly` from the home pad to cave_start (the entrance by cave_2), today's live behaviour", async () => {
    const b = bot!;
    setCorridorUnderFly(b.task, undefined);
    await b.command('!stop');
    await sleep(500);
    await teleport(b, home!);
    await giveFlightKit(b, { rockets: 64 });
    await teleport(b, home!);
    const goal = centre(start);
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const w0 = water;
    const t0 = performance.now();
    await b.command(`!fly ${goal.x - 0.5} ${goal.y} ${goal.z - 0.5}`);
    const end = await b.reply((s) => s.startsWith('arrived') || s.startsWith('landed') || (s.startsWith('fly: ') && !s.startsWith('fly: flying')), from, 600_000).catch((err: unknown) => `no end line: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    await b.command('!stop');
    await sleep(1000);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
    const line = logs.find((l) => l.startsWith('corridor: arrived at') || l.startsWith('corridor: gave up on'));
    const dmg = await b.truth.damageSince(since, b.name);
    const off = await offFrom(b, goal);
    const parsed = parseEnd(line);
    rows.push({ run: 'tripC', leg: 'home -> cave_start', ok: end.startsWith('arrived') && off < 3, off, ...parsed, seconds: parsed.seconds >= 0 ? parsed.seconds : (performance.now() - t0) / 1000, damage: dmg.total, water: water - w0, how: /\(([^)]*)\);/.exec(end)?.[1] ?? '' });
    notes.push(`tripC: ${end}\n    ${logs.filter((l) => /^corridor: (plan|leg|underground|window)|flight: (landed|ended)|takeoff|fly: no takeoff/.test(l)).slice(0, 30).map((l) => l.slice(0, 260)).join('\n    ')}`);
    expect(end.length).toBeGreaterThan(0);
  }, 900_000);

  it.skipIf(!want('walkA'))('walk A: route A walked stop to stop (a failed leg teleported over)', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    await standAt(b, legsA[0]!.from);
    let here = true; // the body is at the leg's start
    let done = 0;
    for (let i = 0; i < legsA.length; i++) {
      const leg = legsA[i]!;
      if (!here) await standAt(b, leg.from);
      const goal = centre(leg.to);
      const since = await b.truth.now();
      const w0 = water;
      const t0 = performance.now();
      const r = await mob.skills.goto({ type: 'near', p: goal, r: 1.5 }, { timeoutTicks: Math.round(LEG_MS / 50) });
      const seconds = (performance.now() - t0) / 1000;
      await sleep(300);
      const off = await offFrom(b, goal);
      const dmg = await b.truth.damageSince(since, b.name);
      const ok = r.ok && off < 2.5;
      here = ok;
      rows.push({ run: 'walkA', leg: `${i} ${leg.name}`, ok, off, seconds, rockets: 0, damage: dmg.total, corrections: -1, replans: -1, plans: -1, windows: 0, walks: 1, water: water - w0, how: r.ok ? 'walk' : `walk: ${r.reason}${r.note ? ` (${r.note})` : ''}` });
      done++;
    }
    expect(done).toBe(legsA.length);
  }, 7_200_000);

  /** One leg as a corridor trip with the underground stretches flown. */
  async function flyLeg(run: string, i: number, leg: CaveLeg): Promise<void> {
    const b = bot!;
    await standAt(b, leg.from);
    setCorridorUnderFly(b.task, true);
    if (process.env.FLY_CAVE_STYLE === '1') b.settings.set('flyCave', 'on'); // Track F5b: the cave style on the measured runs
    const goal = centre(leg.to);
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const w0 = water;
    const t0 = performance.now();
    const trip = b.fly.corridor({ x: goal.x - 0.5, y: goal.y, z: goal.z - 0.5 }, leg.name);
    if (!trip) throw new Error('no corridor provider: the coarse layer is not attached');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LEG_MS);
    });
    const rep = await Promise.race([trip, timedOut]);
    clearTimeout(timer);
    if (!rep) {
      await b.command('!stop');
      await trip.catch(() => undefined);
    }
    await sleep(800);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
    const dmg = await b.truth.damageSince(since, b.name);
    const off = await offFrom(b, goal);
    rows.push({
      run,
      leg: `${i} ${leg.name}`,
      ok: rep?.ok === true && off < 2.5,
      off,
      seconds: rep?.seconds ?? (performance.now() - t0) / 1000,
      rockets: rep?.rockets ?? -1,
      damage: dmg.total,
      corrections: rep?.corrections ?? -1,
      replans: rep?.trackerReplans ?? -1,
      plans: rep?.plans ?? -1,
      windows: rep?.windows ?? -1,
      walks: rep?.walks ?? -1,
      water: water - w0,
      how: rep ? `${rep.legs.map((l) => `${l.how}${l.ok ? '' : ' x'}`).join(', ')}${rep.ok ? '' : `; ${rep.reason ?? ''}`}` : `timeout ${LEG_MS / 1000} s`,
    });
    notes.push(`${run} ${i} ${leg.name}: ${rep ? (rep.ok ? 'arrived' : `gave up: ${rep.reason ?? ''}`) : 'timeout'}\n    ${logs.filter((l) => /^corridor: (plan|leg|underground|window|the window)|flight: (landed|ended)|takeoff|fly: no takeoff/.test(l)).slice(0, 16).map((l) => l.slice(0, 220)).join('\n    ')}`);
  }

  it.skipIf(!want('flyA'))('fly A: every leg of route A as a corridor trip, the underground stretches flown (measured)', async () => {
    let n = 0;
    try {
      for (let i = 0; i < legsA.length; i++) {
        if (!wantLeg(i)) continue;
        await flyLeg('flyA', i, legsA[i]!);
        n++;
      }
    } finally {
      setCorridorUnderFly(bot!.task, undefined);
    }
    expect(rows.filter((r) => r.run === 'flyA').length).toBe(n);
  }, 7_200_000);

  it.skipIf(!want('flyB'))('fly B: every leg of route B (the shortcut, flight only) as a corridor trip, the underground stretches flown (measured)', async () => {
    let n = 0;
    try {
      for (let i = 0; i < legsB.length; i++) {
        if (!wantLeg(i)) continue;
        await flyLeg('flyB', i, legsB[i]!);
        n++;
      }
    } finally {
      setCorridorUnderFly(bot!.task, undefined);
    }
    expect(rows.filter((r) => r.run === 'flyB').length).toBe(n);
  }, 1_800_000);
});
