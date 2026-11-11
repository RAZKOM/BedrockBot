// e2e (tag @bds), Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", decisions/0068): a real cave from the
// bot's world cache rebuilt on bds-fly2 (udp/19210, FLAT, peaceful, fall damage ON, truth pack) and travelled the
// three ways the owner's waypoints name. The cave is PRIVATE data: the extract and the waypoints come from the private
// fixture (bot/fixtures-private/cave, CAVE_FIXTURE_DIR; git-ignored) and this suite skips without it. Nothing of the
// cave is in the repository; the replica keeps the real heights and is moved in x and z by a multiple of 16 (to
// FLY_CAVE_AT, default -96000,-96000), so its cells line up with the real chunks.
//
// The build (`truth:cave`, packs/truth/src/cave.ts): stone over the extract's box, then its air and water as boxes
// (cave-layout.ts greedyBoxes; every cell of the cache that is not air or water, the unknown chunks too, is stone),
// sent in parts of at most 1800 characters. FLY_CAVE_REUSE=1 skips it (a replica of the same fixture is still there); FLY_CAVE_REUSE=surroundings builds only the box again (a newer fixture of the same box).
// The home waypoint (outside the box) gets a 5 x 5 stone pad at its real height; the ground between it and the box is
// the flat world's, far under it (the real terrain is not built).
//
// Seen first, as fly-corridor: a scripted fly-over of the box (teleports onto its surface) into a fresh world cache,
// the coarse layer over that cache attached to the navigator (index.ts's wiring), FlightCost registered.
//   tripC  `!fly` from the home pad to cave_start (the entrance by cave_2): today's live behaviour (UNDER_FLY as is)
//   tripOut  Track F9a: `!goto` from cave_start to the home pad (the Realm's `!test goto home from cave_start`): the takeoff
//          from inside the cave; flights, `roof` ends, rockets that fired nothing and the seconds in the row's `how`
//   walkA  route A walked stop to stop (`skills.goto` near each waypoint); a failed leg is teleported over
//   walkB  route B walked the same way (Track W3: as far as walking goes; the shortcut itself is flight only)
//   flyA / flyB  every leg of routes A and B as a corridor trip with the underground stretches flown (underFly on)
//   flyC   Track F6: cave_start to cave_end as one corridor trip on the layer's own corridor (no waypoints), FLY_CAVE_RUNS times
//   flyS   Track F6: the shortcut (cave_5, cave_shortcut, cave_end as a waypoint route, flight only), FLY_CAVE_RUNS times,
//          after the model's proof of it (cave/proof.ts) on the fixture
// Scored per run (the table goes to the log, docs/flight.md has the measured ones): arrived, the distance left, the
// time, rockets, damage (truth hurtlog), corrections, re-plans, corridor plans / windows / walks, ticks in water.
// Gated: the build, the fly-over and every run completing. The numbers themselves are measured, not gated.
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts; run with 19210 / bds-fly2), FLY_CAVE_AT="x,z",
// FLY_CAVE_REUSE=1, FLY_CAVE_ONLY=tripC,tripOut,walkA,walkB,flyA,flyB,flyC,flyS, FLY_CAVE_EXIT=1 (Track F9a: tripOut with flyCaveExit on; Track F9d: that is the way out along a line drawn from the flood, with no recording), FLY_CAVE_LEARNED=<folder> (Track F9b: tripOut with flyLearned on and that folder's `!learn` recordings of the real cave, moved with the replica; private, read only), FLY_CAVE_ENTRY=1 (Track F9c, with FLY_CAVE_LEARNED: trip C with flyLearnedEntry on, its end along a recorded way in; and FLY_CAVE_ONLY=round: in along a learned entry, then out from where it stands along a learned exit), FLY_CAVE_LEGS=3,4 (the legs of A and B by index, walked or flown), FLY_CAVE_STYLE=1 (the cave style on the flown runs), FLY_CAVE_PLAIN=1 (Track L1: trip C with flyCorridor off, the `!test cavestart` way: go-arounds, the flight and the landing in the table),
// FLY_CAVE_RUNS (flyC / flyS runs, default 5 / 3), FLY_CAVE_LEG_S (the time a run may take, default 180), FLY_CAVE_REPORT=file (the table written there too), FLY_VERBOSE=1.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boxMessages, CAVE_AIR, CAVE_STONE, CAVE_WATER, greedyBoxes } from '../../../packs/truth/src/cave-layout.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { proveShortcut } from '../../src/skills/fly/cave/proof.ts'; // Track F6
import { WaypointProvider, type RoutePoint } from '../../src/skills/fly/cave/route.ts'; // Track F6
import { fixtureExportedAt, fixtureFreshness } from '../../src/skills/fly/learn/fresh.ts';
import { caveLegs, caveWorld, loadCaveFixture, REPLICA_SHELL, replicaTerraces, ROUTE_A, ROUTE_B, shift, type CaveLeg } from '../../src/skills/fly/corridor/cave.ts';
import { setCorridorProvider, setCorridorUnderFly } from '../../src/skills/fly/corridor/registry.ts';
import { PathStore } from '../../src/skills/fly/learn/store.ts'; // Track F9b
import { CLS_AIR, CLS_WATER } from '../../src/world/cache/types.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { buildPlatform, E2E, FEET_Y, giveFlightKit, prepareServer, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const fix = loadCaveFixture();
const ONLY = new Set((process.env.FLY_CAVE_ONLY ?? '').split(',').filter(Boolean));
const LEGS = new Set((process.env.FLY_CAVE_LEGS ?? '').split(',').filter(Boolean).map(Number));
/** Track F6: the runs of flyC and flyS (the brief's bars: 5 of 5 and 3 of 3). */
const RUNS = process.env.FLY_CAVE_RUNS ? Number(process.env.FLY_CAVE_RUNS) : undefined;
const LEG_MS = Number(process.env.FLY_CAVE_LEG_S ?? 180) * 1000;
const REUSE = process.env.FLY_CAVE_REUSE === '1';
/**
 * Track F9c round 2: FLY_CAVE_REUSE=surroundings builds the box again and leaves the shell and the terraces as they stand
 * (a newer fixture of the same box: the terraces come from the same column tops). A whole build over a replica that
 * stands does not work: `buildSurroundings` sends its fills from stops on the flat ground, which a standing replica has
 * under stone (the bot is put inside a terrace, and the fills' chunks are never loaded for it).
 */
const BOX_ONLY = process.env.FLY_CAVE_REUSE === 'surroundings';
/** Track F9b: a folder of `!learn` recordings of the real cave (private, read only): tripOut flies with them (moved with the replica into a temp folder the bot reads) and `flyLearned` on. */
const LEARNED = process.env.FLY_CAVE_LEARNED;
/** Track F9c: with FLY_CAVE_LEARNED, trip C flies with `flyLearnedEntry` on (the recorded ways in), and `round` flies in and out. */
const ENTRY = process.env.FLY_CAVE_ENTRY === '1';
/** Track F9e: FLY_CAVE_DRAWN_ENTRY=1: trip C and `round` fly with `flyCaveEntry` on (a way in drawn from the world; with no FLY_CAVE_LEARNED there is no recording at all). FLY_CAVE_ONLY=under: cave_start to cave_end by `!goto`, with `flyCaveHop` on unless FLY_CAVE_HOP=0. */
const DRAWN_IN = process.env.FLY_CAVE_DRAWN_ENTRY === '1';
/** A trip in ends along a line (a recorded one, or a drawn one): flown the plain way, its end line the walk's or the arrival's. */
const ENTERING = (ENTRY && LEARNED !== undefined) || DRAWN_IN;
/** Track L1: trip C the Realm's way (`!test cavestart`): flyCorridor off, the plain flight, then the rest from the landing. */
const PLAIN = process.env.FLY_CAVE_PLAIN === '1';
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);
const wantLeg = (i: number): boolean => LEGS.size === 0 || LEGS.has(i);
/** The characters of one `truth:cave part` message (a scriptevent message holds 2048). */
// (round 2: FLY_CAVE_PART_CHARS cuts the parts elsewhere: on the PC one part of one fixture could never be sent, `spawn EPERM`
// on every attempt, the same part each run: the command line itself was refused, which only its text can explain)
const PART_CHARS = Number(process.env.FLY_CAVE_PART_CHARS ?? 1800);
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
    let sendRetries = 0;
    const ok = async (args: (string | number)[], ms: number): Promise<Record<string, unknown>> => {
      // A command that could not be started at all is sent again (round 2: on the PC `docker exec` failed to start once
      // in a few hundred, `spawn EPERM`, with nothing wrong with the message; a part sent twice is the same part), and a
      // failure says which message it was.
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await b.truth.cmd<Record<string, unknown>>('cave', args, ms);
          if (!r.ok) throw new Error(`truth:cave ${String(args[0])} failed: ${r.reason} ${JSON.stringify(r.data)}`);
          return r.data;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          if (!/spawn (EPERM|EAGAIN|EMFILE|EBUSY)/.test(why) || attempt >= 5) throw new Error(`truth:cave ${String(args[0])} ${String(args[2] ?? '')} (${args.map(String).join(' ').length} characters), attempt ${attempt}: ${why}`, { cause: err });
          sendRetries++;
          await sleep(200 * attempt);
        }
      }
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
      `build: box ${e.size.x} x ${e.size.y} x ${e.size.z} (${e.size.x * e.size.y * e.size.z} cells), ${boxes.length} boxes in ${parts.length} parts (${parts.reduce((n, p) => n + p.length, 0)} characters${sendRetries ? `, ${sendRetries} sent again` : ''}); boxes ${s(t0, tBoxes)} s, sent ${s(tBoxes, tSent)} s, built ${s(tSent, tBuilt)} s (${String(r.pieces)} pieces, ${String(r.ticks)} ticks), total ${s(t0, tBuilt)} s`,
    );
  }

  /**
   * Track F8: the box's surroundings as the Realm has them, not a mesa on the flat world: a stone shell REPLICA_SHELL thick
   * round the box's sides (the box's edge slices the cave open: the layer's corridor into cave_start went in through that
   * cut face, where the fixture and the Realm have rock) and the real terrain's heights round it, a chunk at a time, from
   * the extract's column tops (`replicaTerraces`: the chunk's lowest known top). Built before the box (the box's own cells
   * are set after, so a chunk the box cuts may be filled whole here).
   */
  async function buildSurroundings(b: FlyBot): Promise<void> {
    const t0 = performance.now();
    const LIMIT = 32_768; // blocks a fill command may set
    const STOP = 128; // the fills are sent from a grid of teleport stops this far apart (a fill wants its chunks loaded: TICK_DISTANCE 10)
    interface Box {
      x1: number;
      y1: number;
      z1: number;
      x2: number;
      y2: number;
      z2: number;
    }
    const jobs: Box[] = [];
    const pieces = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void => {
      const area = (x2 - x1 + 1) * (z2 - z1 + 1);
      const step = Math.max(1, Math.floor(LIMIT / area));
      for (let y = y1; y <= y2; y += step) jobs.push({ x1, y1: y, z1, x2, y2: Math.min(y2, y + step - 1), z2 });
    };
    const y0 = FEET_Y - 1;
    // the terraces (real chunks of the tops rectangle, shifted to the replica)
    const terrace = replicaTerraces(e, homeReal ? { home: homeReal } : {});
    const r = e.topsRect;
    let terraces = 0;
    if (r) {
      for (let cx = r.min.x >> 4; cx <= r.max.x >> 4; cx++) {
        for (let cz = r.min.z >> 4; cz <= r.max.z >> 4; cz++) {
          const top = terrace(cx, cz);
          if (top === undefined || top < y0) continue;
          pieces(cx * 16 + d.x, y0, cz * 16 + d.z, cx * 16 + 15 + d.x, top, cz * 16 + 15 + d.z);
          terraces++;
        }
      }
    }
    // the shell: the ring round the footprint from the flat ground to the box's top, a chunk's length a piece
    const top = min.y + e.size.y - 1;
    const s = REPLICA_SHELL;
    const walls: Box[] = [
      { x1: min.x - s, y1: y0, z1: min.z - s, x2: min.x - 1, y2: top, z2: min.z + e.size.z - 1 + s },
      { x1: min.x + e.size.x, y1: y0, z1: min.z - s, x2: min.x + e.size.x - 1 + s, y2: top, z2: min.z + e.size.z - 1 + s },
      { x1: min.x, y1: y0, z1: min.z - s, x2: min.x + e.size.x - 1, y2: top, z2: min.z - 1 },
      { x1: min.x, y1: y0, z1: min.z + e.size.z, x2: min.x + e.size.x - 1, y2: top, z2: min.z + e.size.z - 1 + s },
    ];
    for (const w of walls) {
      const alongX = w.x2 - w.x1 > w.z2 - w.z1;
      const lo = alongX ? w.x1 : w.z1;
      const hi = alongX ? w.x2 : w.z2;
      for (let a = lo; a <= hi; a = ((a >> 4) + 1) * 16) {
        const to = Math.min(hi, ((a >> 4) + 1) * 16 - 1);
        if (alongX) pieces(a, w.y1, w.z1, to, w.y2, w.z2);
        else pieces(w.x1, w.y1, a, w.x2, w.y2, to);
      }
    }
    // every job from the stop nearest its centre (the stop's own chunk last: the body stands there while they are sent)
    const groups = new Map<string, { x: number; z: number; jobs: Box[] }>();
    for (const j of jobs) {
      const cx = (j.x1 + j.x2) / 2;
      const cz = (j.z1 + j.z2) / 2;
      const sx = Math.round(cx / STOP) * STOP;
      const sz = Math.round(cz / STOP) * STOP;
      const k = `${sx},${sz}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { x: sx, z: sz, jobs: [] }));
      g.jobs.push(j);
    }
    let fills = 0;
    for (const g of groups.values()) {
      const own = (j: Box): boolean => g.x >= j.x1 && g.x <= j.x2 && g.z >= j.z1 && g.z <= j.z2;
      g.jobs.sort((p, q) => Number(own(p)) - Number(own(q)));
      await teleport(b, { x: g.x + 0.5, y: FEET_Y, z: g.z + 0.5 });
      // (round 2: a stop inside stone means a replica already stands here: its fills would wait for chunks that never load)
      const model = b.built.mobility!.loop;
      await model.waitTicks(10);
      if (model.world.solidAt(g.x, FEET_Y, g.z) === true || model.world.solidAt(g.x, FEET_Y + 1, g.z) === true) throw new Error(`the build's stop at ${g.x} ${FEET_Y} ${g.z} is inside stone: a replica already stands here. A whole build needs a world without one (its stops are on the flat ground); FLY_CAVE_REUSE=surroundings builds only the box again`);
      for (const j of g.jobs) {
        await truthLoaded(b.truth, 'fill', [j.x1, j.y1, j.z1, j.x2, j.y2, j.z2, 'stone'], 60_000);
        fills++;
      }
    }
    notes.push(`surroundings: ${terraces} terrace chunks at the real heights and the shell round the box in ${fills} fills from ${groups.size} stops, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }

  /** Track F8: the feet height of the replica's ground at a real column outside the box (a terrace, else the flat world). */
  const groundFeet = (x: number, z: number): number => {
    const t = replicaTerraces(e, homeReal ? { home: homeReal } : {})(x >> 4, z >> 4);
    return t !== undefined && t >= FEET_Y - 1 ? t + 1 : FEET_Y;
  };

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
    // the ground between home and the box (the cruise of trip C; the live bot has seen its own terrain there): Track F8, the
    // terraces' heights where the real tops are known, the flat world's elsewhere
    let m = 0;
    if (home) {
      const to = centre(start);
      const len = Math.hypot(to.x - home.x, to.z - home.z);
      for (let s = 0; s < len; s += 96) {
        const t = s / len;
        const x = Math.floor(home.x + (to.x - home.x) * t);
        const z = Math.floor(home.z + (to.z - home.z) * t);
        await teleport(b, { x: x + 0.5, y: groundFeet(x - d.x, z - d.z), z: z + 0.5 });
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
    if (!REUSE) {
      if (BOX_ONLY) notes.push('build: the surroundings reused, the box built again (FLY_CAVE_REUSE=surroundings)');
      else await buildSurroundings(bot); // Track F8: before the box (a chunk the box cuts is filled whole, the box's cells set after)
      await buildReplica(bot);
    } else notes.push('build: reused (FLY_CAVE_REUSE=1)');
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

  /**
   * Track F9b / F9c: the recorded paths (FLY_CAVE_LEARNED), moved as the replica is (x and z; the heights are the real ones),
   * in a temporary folder the bot reads as its paths folder; `done` puts the environment back and removes the folder.
   */
  function learnedPaths(run: string): { done(): void } | undefined {
    if (!LEARNED) return undefined;
    const paths0 = process.env.BEDROCKBOT_PATHS_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'bb-cave-paths-'));
    const all = new PathStore(LEARNED).all();
    // (round 2: a fixture older than the recordings is another cave than the one they were made in: said, and loudly)
    const fresh = fixtureFreshness(fixtureExportedAt(fix!.dir), all.map((p) => p.recorded));
    notes.push(`${run}: ${fresh.line}`);
    if (fresh.stale) console.warn(`[fly-cave e2e] ${fresh.line}`);
    for (const p of all) writeFileSync(join(dir, `${p.name}.json`), JSON.stringify({ ...p, samples: p.samples.map((q) => ({ ...q, x: q.x + d.x, z: q.z + d.z })), rockets: p.rockets.map((q) => ({ ...q, x: q.x + d.x, z: q.z + d.z })) }));
    process.env.BEDROCKBOT_PATHS_DIR = dir;
    notes.push(`${run}: ${all.length} recorded paths moved with the replica`);
    return {
      done: () => {
        if (paths0 === undefined) delete process.env.BEDROCKBOT_PATHS_DIR;
        else process.env.BEDROCKBOT_PATHS_DIR = paths0;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** One trip in: `!fly` from the home pad to cave_start (trip C's run; Track F9c: with FLY_CAVE_ENTRY=1 and the recordings, its end along the learned entry). */
  async function tripIn(run: string, i: number): Promise<void> {
    const b = bot!;
    {
      setCorridorUnderFly(b.task, undefined);
      if (process.env.FLY_CAVE_STYLE === '1') b.settings.set('flyCave', 'on'); // Track F8: the trip in flies underground in the cave style
      b.settings.set('flyLearnedEntry', LEARNED !== undefined && ENTRY); // Track F9c: the recorded ways in (default off)
      b.settings.set('flyCaveEntry', DRAWN_IN); // Track F9e: the drawn way in (default off)
      // Track L1: FLY_CAVE_PLAIN=1 flies the Realm's way (`!test cavestart`: no corridor for the trip, the plain flight to the
      // goal's landing, then the rest from there: the corridor's windows with flyCave on, else the walk)
      if (PLAIN) b.settings.set('flyCorridor', 'off');
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
      // Track L1: when the flight ended (its `flight: ended` line), for the flight's share of the trip's time
      let flightEnd: number | undefined;
      const watch = setInterval(() => {
        if (flightEnd === undefined && b.logs.slice(n0).some((l) => /flight: (landed|ended \()/.test(l))) flightEnd = performance.now();
      }, 100);
      await b.command(`!fly ${goal.x - 0.5} ${goal.y} ${goal.z - 0.5}`);
      // Track R1: the trip's own end line (the corridor's arrival or failure, a landing's), not any `fly:` line on the way
      // (Track L1, plain: a landing near the goal is not the end; the walk or the corridor from there is)
      // (Track F9c: a goal with a recorded way in is flown the plain way too)
      const endOf = PLAIN || ENTERING
        ? (s: string) => s.startsWith('arrived') || s.startsWith('walked to') || s.startsWith('fly: the corridor to ') || s.startsWith('fly: landed, but') || s.startsWith('fly: the trip to')
        : (s: string) => s.startsWith('arrived') || s.startsWith('landed') || s.startsWith('fly: the corridor to ') || s.startsWith('fly: landed, but');
      const end = await b.reply(endOf, from, 600_000).catch((err: unknown) => `no end line: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      const tEnd = performance.now();
      clearInterval(watch);
      await b.command('!stop');
      await sleep(1000);
      const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
      const line = logs.find((l) => l.startsWith('corridor: arrived at') || l.startsWith('corridor: gave up on'));
      const dmg = await b.truth.damageSince(since, b.name);
      const off = await offFrom(b, goal);
      const parsed = parseEnd(line);
      // Track L1: the flight's go-arounds, its landing's distance from the goal and the decisions it priced
      const ended = logs.find((l) => /^flight: (landed|ended \()/.test(l));
      const gas = Number(/, (\d+) go-arounds?[ ,]/.exec(ended ?? '')?.[1] ?? -1);
      const at = /^flight: (?:landed|ended \([^)]*\)) at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(ended ?? '');
      const landedOff = at ? Math.hypot(Number(at[1]) - goal.x, Number(at[3]) - goal.z) : -1;
      const landedDy = at ? Number(at[2]) - goal.y : 0;
      const flightS = flightEnd !== undefined ? (flightEnd - t0) / 1000 : -1;
      const totalS = (tEnd - t0) / 1000;
      const ok = (end.startsWith('arrived') || end.startsWith('walked to')) && off < 3;
      // Track F9c: the learned entry's own numbers (the brain's line when the body stands), the flights and the bail-outs
      const stood = logs.find((l) => /^flight: (learned|drawn) entry: standing/.test(l));
      const entry = ENTERING ? `; ${stood?.startsWith('flight: drawn') ? 'drawn ' : ''}entry ${stood ? `${/(\d+) ticks after the commit/.exec(stood)?.[1] ?? '?'} ticks from the commit, ${/(\d+) from the line's last open sky/.exec(stood)?.[1] ?? '?'} from the last open sky, ${/standing ([\d.]+) from the goal/.exec(stood)?.[1] ?? '?'} from the goal` : (logs.find((l) => /(learned|drawn) entry: .*(given up|lost)|no learned entry|no drawn entry|comes too late|could not be taken/.test(l))?.slice(0, 160) ?? 'not flown')}` : '';
      const flights = logs.filter((l) => /^flight: (landed|ended \()/.test(l)).length;
      const bails = logs.filter((l) => l.includes('bailing out')).length;
      const how = (PLAIN || ENTERING ? `GA ${gas}, flight ${flightS.toFixed(0)} s, landed ${landedOff.toFixed(0)} off (dy ${landedDy.toFixed(0)}), total ${totalS.toFixed(0)} s` : (/\(([^)]*)\);/.exec(end)?.[1] ?? '')) + `, ${flights} flight${flights === 1 ? '' : 's'}, ${bails} bail-outs${entry}`;
      rows.push({ run, leg: `${i} home -> cave_start`, ok, off, ...parsed, seconds: PLAIN || ENTERING ? totalS : parsed.seconds >= 0 ? parsed.seconds : totalS, damage: dmg.total, water: water - w0, how });
      notes.push(`${run} ${i}: ${end}\n    ${logs.filter((l) => /^corridor: |flight: (landed|ended|holding|go-around|no go-around|land now|price|learned entry|drawn entry|retargeted)|fly: (landing for|learned entry|drawn entry|the learned entry)|takeoff|fly: no takeoff|route: .*bailing|walked|fly: landed|the first rocket|recorded way in/.test(l)).slice(0, 48).map((l) => l.slice(0, /^fly: (learned|drawn) entry/.test(l) ? 4000 : 330)).join('\n    ')}`);
      if (ENTERING && !stood) notes.push(`${run} ${i}, the whole log (${logs.length} lines, the first 160):\n    ${logs.slice(0, 160).map((l) => l.slice(0, 400)).join('\n    ')}`);
      expect(end.length).toBeGreaterThan(0);
    }
  }

  it.skipIf(!want('tripC') || !home)("trip C: `!fly` from the home pad to cave_start (the entrance by cave_2), today's live behaviour (Track F8: FLY_CAVE_STYLE=1 flies in with the cave style, FLY_CAVE_RUNS times; Track F9c: FLY_CAVE_LEARNED and FLY_CAVE_ENTRY=1, its end along a recorded way in)", async () => {
    const runs = RUNS ?? 1;
    const paths = ENTRY ? learnedPaths('tripC') : undefined;
    try {
      for (let i = 0; i < runs; i++) await tripIn('tripC', i);
    } finally {
      bot!.settings.set('flyLearnedEntry', false);
      bot!.settings.set('flyCaveEntry', false);
      paths?.done();
    }
  }, 3_600_000);

  /**
   * The ground beside the line home, as the live bot has seen its own (the fly-over's stops lie on the line itself, 96 apart: a
   * climb that leaves the cave by its mouth flies some 40 blocks beside it, over columns no stop had loaded, and a takeoff's
   * proof counts a climb into columns the model does not know as a hit: Track BL). Once a suite.
   */
  let seenBeside = false;
  async function seeBeside(run: string): Promise<void> {
    if (seenBeside) return;
    seenBeside = true;
    const b = bot!;
    const goal = home!;
    {
      const to = centre(start);
      const len = Math.hypot(goal.x - to.x, goal.z - to.z);
      const u = { x: (goal.x - to.x) / len, z: (goal.z - to.z) / len };
      let n = 0;
      for (let s = 32; s <= Math.min(480, len - 64); s += 64) {
        for (const side of [-64, 64]) {
          const x = Math.floor(to.x + u.x * s - u.z * side);
          const z = Math.floor(to.z + u.z * s + u.x * side);
          await teleport(b, { x: x + 0.5, y: Math.max(groundFeet(x - d.x, z - d.z), e.box.max.y + 2), z: z + 0.5 });
          n++;
        }
      }
      notes.push(`${run}: ${n} more points seen beside the first 480 blocks of the line home`);
    }
  }

  /** One trip out: `!goto` from cave_start to the home pad (tripOut's run). `stand`: the body is put on cave_start first; without it the trip begins where the trip in left it (a round trip). */
  async function tripBack(run: string, i: number, stand: boolean): Promise<void> {
    const b = bot!;
    const goal = home!;
    const what = `${goal.x - 0.5} ${goal.y} ${goal.z - 0.5}`;
    const break0 = b.settings.get('allowBreak');
    try {
      {
        if (stand) await standAt(b, start);
        else {
          await b.command('!stop');
          await sleep(500);
          await giveFlightKit(b, { rockets: 64 });
        }
        setCorridorUnderFly(b.task, undefined);
        // the Realm's settings for `!test goto home from cave_start`: autoFly, walks may dig, no pillars, flyCave with FLY_CAVE_STYLE=1
        b.settings.set('autoFly', true);
        b.settings.set('allowBreak', true);
        if (process.env.FLY_CAVE_STYLE === '1') b.settings.set('flyCave', 'on');
        b.settings.set('flyCaveExit', process.env.FLY_CAVE_EXIT === '1'); // the way out under the roof (default off)
        b.settings.set('flyLearned', LEARNED !== undefined); // Track F9b: the recorded paths as ways out (default off)
        const since = await b.truth.now();
        const n0 = b.logs.length;
        const from = b.said.length;
        const w0 = water;
        const t0 = performance.now();
        // when each flight ended, for the time the takeoff out of the cave took (the first flight that did not end `roof` or short)
        const ends: number[] = [];
        // (Track F9b: and how far from cave_start the first flight left the ground: the walk before the takeoff)
        let walked: number | undefined;
        const at0 = centre(start);
        const watch = setInterval(() => {
          const now = b.logs.slice(n0);
          const n = now.filter((l) => /flight: (landed|ended \()/.test(l)).length;
          while (ends.length < n) ends.push(performance.now());
          if (walked === undefined && now.some((l) => /fly: to .*(takeoff|then heading|elytra)/.test(l))) {
            const p = b.built.mobility!.loop.state.pos;
            walked = Math.hypot(p.x - at0.x, p.z - at0.z);
          }
        }, 100);
        await b.command(`!goto ${what}`);
        const end = await b.reply((s) => s.startsWith('arrived at') || s.startsWith('goto:'), from, Math.max(LEG_MS, 420_000)).catch((err: unknown) => `no end line: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
        const tEnd = performance.now();
        clearInterval(watch);
        await b.command('!stop');
        await sleep(1000);
        b.settings.set('autoFly', false);
        const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
        const dmg = await b.truth.damageSince(since, b.name);
        const off = await offFrom(b, goal);
        const flights = logs.filter((l) => /^flight: (landed|ended \()/.test(l));
        const roofs = flights.filter((l) => l.startsWith('flight: ended (roof)')).length;
        const rockets = flights.reduce((n, l) => n + Number(/; (\d+) rockets \(/.exec(l)?.[1] ?? 0), 0);
        const wasted = logs.filter((l) => l.includes('fired nothing')).length;
        const takeoffs = logs.filter((l) => /^fly: to .*(takeoff|then heading|elytra)/.test(l)).map((l) => (/a (route|vertical) takeoff/.exec(l)?.[1] ?? (l.includes('ledge') ? 'ledge' : 'jump')));
        // the first flight that got out: not `roof`, and it flew more than a takeoff's worth of ticks
        const outAt = flights.findIndex((l) => !l.startsWith('flight: ended (roof)') && Number(/, (\d+) ticks/.exec(l)?.[1] ?? 0) > 200);
        const outEnd = outAt >= 0 ? ends[outAt] : undefined;
        const outS = outEnd !== undefined ? (outEnd - t0) / 1000 : -1;
        const totalS = (tEnd - t0) / 1000;
        rows.push({ run, leg: `${i} cave_start -> home`, ok: end.startsWith('arrived at') && off < 3, off, seconds: totalS, rockets, damage: dmg.total, corrections: -1, replans: -1, plans: -1, windows: flights.length, walks: -1, water: water - w0, how: `${flights.length} flights (${takeoffs.join(', ')}${logs.some((l) => l.includes('out along the learned line')) ? ', along a learned line' : ''}${logs.some((l) => l.includes('out along the drawn line')) ? ', along a drawn line' : ''}), the first ${walked === undefined ? '?' : walked.toFixed(0)} blocks from cave_start, ${roofs} roof, ${wasted} rockets fired nothing, the flight home down after ${outS.toFixed(0)} s, total ${totalS.toFixed(0)} s` });
        notes.push(`${run} ${i}: ${end}\n    ${logs.filter((l) => /takeoff|^flight: (to |landed|ended|nothing clears|route: (start|the corridor|the plan's corridor)|the rocket used)|^fly: (to |the walk|no takeoff|the takeoff|the flight came|leg )|fired nothing|the first rocket|learned line|drawn line|up out of the pit|straight up until/.test(l)).slice(0, 60).map((l) => l.slice(0, l.startsWith("fly: route takeoff") ? 1800 : 330)).join('\n    ')}`);
        // (Track F9b: a run that did not arrive: everything the flight and the trip said, to see where it went wrong)
        if (!end.startsWith('arrived at')) notes.push(`${run} ${i}, the whole log (${logs.length} lines, the first 200):\n    ${logs.slice(0, 200).map((l) => l.slice(0, 400)).join('\n    ')}`);
        expect(end.length).toBeGreaterThan(0);
      }
    } finally {
      b.settings.set('autoFly', false);
      b.settings.set('allowBreak', break0);
      b.settings.set('flyCaveExit', false);
      b.settings.set('flyLearned', false);
    }
  }

  it.skipIf(!want('tripOut') || !home)('trip out (Track F9a): `!goto` from cave_start to the home pad, the takeoff from inside the cave (measured, FLY_CAVE_RUNS times)', async () => {
    const runs = RUNS ?? 5;
    await seeBeside('tripOut');
    // Track F9b: the recorded paths, where the bot looks for them (flyLearned on)
    const paths = learnedPaths('tripOut');
    try {
      for (let i = 0; i < runs; i++) await tripBack('tripOut', i, true);
    } finally {
      paths?.done();
    }
  }, 7_200_000);

  it.skipIf(!ONLY.has('round') || !home)('round trips (Track F9c; FLY_CAVE_ONLY=round with FLY_CAVE_LEARNED and FLY_CAVE_ENTRY=1): in to cave_start along a learned entry, then out again from where it stands along a learned exit (measured, FLY_CAVE_RUNS times)', async () => {
    const runs = RUNS ?? 3;
    await seeBeside('round');
    const paths = learnedPaths('round');
    try {
      for (let i = 0; i < runs; i++) {
        await tripIn('round in', i);
        bot!.settings.set('flyLearnedEntry', false);
        bot!.settings.set('flyCaveEntry', false);
        // (out from where the trip in left the body when that is cave_start; else from cave_start itself, and the row says so)
        const off = await offFrom(bot!, centre(start));
        if (off >= 3) notes.push(`round ${i}: the trip in ended ${off.toFixed(1)} from cave_start: the trip out begins on cave_start`);
        await tripBack('round out', i, off >= 3);
      }
    } finally {
      bot!.settings.set('flyLearnedEntry', false);
      bot!.settings.set('flyCaveEntry', false);
      paths?.done();
    }
  }, 7_200_000);

  /**
   * Track F9e: one trip under the roof: `!goto` from cave_start to cave_end with the Realm's settings (autoFly, walks may dig,
   * flyCave with FLY_CAVE_STYLE=1) and `flyCaveHop` on or off. The row: arrived, the seconds, the damage, the flights, and
   * of the hop: its line's length, the ticks to the flier's place and to standing.
   */
  async function tripUnder(run: string, i: number, hopOn: boolean): Promise<void> {
    const b = bot!;
    // (FLY_CAVE_UNDER="cave_8,cave_end": another pair of waypoints than cave_start and cave_end)
    const [fromName, toName] = (process.env.FLY_CAVE_UNDER ?? 'cave_start,cave_end').split(',') as [string, string];
    const cellOf = (n: string): Vec3 => {
      const p = fix!.waypoints.get(n);
      const cell = p ? world.feetCell(p) : undefined;
      if (!cell) throw new Error(`no waypoint ${n} with a floor`);
      return cell;
    };
    const goal = centre(cellOf(toName));
    const what = `${goal.x - 0.5} ${goal.y} ${goal.z - 0.5}`;
    const break0 = b.settings.get('allowBreak');
    try {
      await standAt(b, cellOf(fromName));
      setCorridorUnderFly(b.task, undefined);
      b.settings.set('autoFly', true);
      b.settings.set('allowBreak', true);
      if (process.env.FLY_CAVE_STYLE === '1') b.settings.set('flyCave', 'on');
      b.settings.set('flyCaveHop', hopOn);
      const since = await b.truth.now();
      const n0 = b.logs.length;
      const from = b.said.length;
      const w0 = water;
      const t0 = performance.now();
      await b.command(`!goto ${what}`);
      const said = await b.reply((x) => x.startsWith('arrived at') || x.startsWith('goto:'), from, process.env.FLY_CAVE_LEG_S ? LEG_MS : 900_000).catch((err: unknown) => `no end line: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      const totalS = (performance.now() - t0) / 1000;
      await b.command('!stop');
      await sleep(1000);
      b.settings.set('autoFly', false);
      const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
      const dmg = await b.truth.damageSince(since, b.name);
      const off = await offFrom(b, goal);
      const flights = logs.filter((l) => /^flight: (landed|ended \()/.test(l));
      const rockets = flights.reduce((n, l) => n + Number(/; (\d+) rockets \(/.exec(l)?.[1] ?? 0), 0);
      const decided = logs.find((l) => l.startsWith('fly: hop: '));
      const took = logs.find((l) => l.startsWith('flight: hop: '));
      const stood = logs.find((l) => /^flight: (learned|drawn) entry: standing/.test(l));
      const hop = decided ? `the hop ${decided.includes('-> along') ? `${/(\d+) blocks of line/.exec(decided)?.[1] ?? '?'} blocks of line, decided in ${/(\d+) ms\)$/.exec(decided)?.[1] ?? '?'} ms${took ? `, the flier's place after ${/after (\d+) ticks/.exec(took)?.[1] ?? '?'} ticks on ${/, (\d+) rockets?/.exec(took)?.[1] ?? '?'} rockets` : ', never at the flier\'s place'}${stood ? `, standing ${/standing ([\d.]+) from the goal/.exec(stood)?.[1] ?? '?'} from the goal` : ', not standing by it'}` : 'not proven'}` : 'no hop asked';
      rows.push({ run, leg: `${i} ${fromName} -> ${toName}`, ok: said.startsWith('arrived at') && off < 3, off, seconds: totalS, rockets, damage: dmg.total, corrections: -1, replans: -1, plans: -1, windows: flights.length, walks: -1, water: water - w0, how: `${hop}; ${flights.length} flights, total ${totalS.toFixed(0)} s` });
      notes.push(`${run} ${i}: ${said}\n    ${logs.filter((l) => /^fly: (hop|to |the walk|no takeoff|the takeoff|leg |the corridor)|^flight: (to |landed|ended|hop|drawn entry|learned entry|route takeoff|nothing clears)|drawn line|fired nothing|^corridor: (arrived|gave up)/.test(l)).slice(0, 60).map((l) => l.slice(0, l.startsWith('fly: hop') ? 2400 : 330)).join('\n    ')}`);
      if (!said.startsWith('arrived at')) notes.push(`${run} ${i}, the whole log (${logs.length} lines, the first 200):\n    ${logs.slice(0, 200).map((l) => l.slice(0, 400)).join('\n    ')}`);
      expect(said.length).toBeGreaterThan(0);
    } finally {
      b.settings.set('autoFly', false);
      b.settings.set('allowBreak', break0);
      b.settings.set('flyCaveHop', false);
    }
  }

  it.skipIf(!ONLY.has('under'))('under one roof (Track F9e; FLY_CAVE_ONLY=under): `!goto` from cave_start to cave_end, the hop along a drawn line with flyCaveHop on (FLY_CAVE_HOP=0: off, the trip as before) (measured, FLY_CAVE_RUNS times)', async () => {
    const runs = RUNS ?? 5;
    for (let i = 0; i < runs; i++) await tripUnder(process.env.FLY_CAVE_HOP === '0' ? 'under, hop off' : 'under, hop on', i, process.env.FLY_CAVE_HOP !== '0');
  }, 7_200_000);

  /**
   * A route walked stop to stop (`skills.goto` near each waypoint); a failed leg, or the leg after one FLY_CAVE_LEGS
   * skips, starts from its own stop (teleported). Track W3: the legs filter, route B, the nav log of each leg in the notes.
   */
  async function walkRoute(run: string, legs: CaveLeg[]): Promise<number> {
    const b = bot!;
    const mob = b.built.mobility!;
    let here = false; // the body is at the leg's start
    let done = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      if (!wantLeg(i)) {
        here = false;
        continue;
      }
      if (!here) await standAt(b, leg.from);
      const goal = centre(leg.to);
      const since = await b.truth.now();
      const n0 = b.logs.length;
      const w0 = water;
      const t0 = performance.now();
      const r = await mob.skills.goto({ type: 'near', p: goal, r: 1.5 }, { timeoutTicks: Math.round(LEG_MS / 50) });
      const seconds = (performance.now() - t0) / 1000;
      await sleep(300);
      const off = await offFrom(b, goal);
      const dmg = await b.truth.damageSince(since, b.name);
      const ok = r.ok && off < 2.5;
      here = ok;
      rows.push({ run, leg: `${i} ${leg.name}`, ok, off, seconds, rockets: 0, damage: dmg.total, corrections: -1, replans: -1, plans: -1, windows: 0, walks: 1, water: water - w0, how: r.ok ? 'walk' : `walk: ${r.reason}${r.note ? ` (${r.note})` : ''}` });
      const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
      notes.push(`${run} ${i} ${leg.name}: ${ok ? 'arrived' : 'failed'}, ${dmg.total} damage\n    ${logs.slice(0, 60).map((l) => l.slice(0, 400)).join('\n    ')}`);
      done++;
    }
    return done;
  }

  it.skipIf(!want('walkA'))('walk A: route A walked stop to stop (a failed leg teleported over)', async () => {
    const done = await walkRoute('walkA', legsA);
    expect(done).toBe(legsA.filter((_, i) => wantLeg(i)).length);
  }, 7_200_000);

  it.skipIf(!want('walkB'))('walk B: route B walked stop to stop, as far as walking goes (the shortcut is flight only; measured)', async () => {
    const done = await walkRoute('walkB', legsB);
    expect(done).toBe(legsB.filter((_, i) => wantLeg(i)).length);
  }, 1_800_000);

  /** One leg as a corridor trip with the underground stretches flown. */
  async function flyLeg(run: string, i: number, leg: CaveLeg): Promise<void> {
    await flyBetween(run, `${i} ${leg.name}`, leg.from, leg.to);
  }

  /** Track F6: a corridor trip from `from` to `to` (replica feet cells of the fixture's) with the underground stretches flown, as one row. */
  async function flyBetween(run: string, name: string, fromCell: Vec3, toCell: Vec3): Promise<void> {
    const b = bot!;
    await standAt(b, fromCell);
    setCorridorUnderFly(b.task, true);
    if (process.env.FLY_CAVE_STYLE === '1') b.settings.set('flyCave', 'on'); // Track F5b: the cave style on the measured runs
    const goal = centre(toCell);
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const w0 = water;
    const t0 = performance.now();
    const trip = b.fly.corridor({ x: goal.x - 0.5, y: goal.y, z: goal.z - 0.5 }, name);
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
      leg: name,
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
    notes.push(`${run} ${name}: ${rep ? (rep.ok ? 'arrived' : `gave up: ${rep.reason ?? ''}`) : 'timeout'}\n    ${logs.filter((l) => /^corridor: |route: .*bailing|flight: (landed|ended)|takeoff|fly: no takeoff/.test(l)).slice(0, 24).map((l) => l.slice(0, 220)).join('\n    ')}`);
  }

  /** Track F6: a real cell of the fixture is covered (a solid cell of the extract above it). */
  function coveredReal(cell: Vec3): boolean {
    if (cell.x < e.box.min.x || cell.x > e.box.max.x || cell.z < e.box.min.z || cell.z > e.box.max.z) return false;
    for (let y = e.box.max.y; y > cell.y + 1; y--) if (world.solid(Math.floor(cell.x), y, Math.floor(cell.z)) === true) return true;
    return false;
  }

  it.skipIf(!want('flyC'))('fly C (Track F6): cave_start to cave_end as one corridor trip on the layer’s corridor, the underground flown (measured)', async () => {
    const runs = RUNS ?? 5;
    const end = legsA[legsA.length - 1]!.to;
    try {
      for (let i = 0; i < runs; i++) await flyBetween('flyC', `${i} cave_start -> cave_end`, start, end);
    } finally {
      setCorridorUnderFly(bot!.task, undefined);
    }
    expect(rows.filter((r) => r.run === 'flyC').length).toBe(runs);
  }, 7_200_000);

  it.skipIf(!want('flyS'))('fly S (Track F6): the shortcut as a waypoint route (cave_5, cave_shortcut, cave_end), proven on the model first (measured)', async () => {
    const runs = RUNS ?? 3;
    const stops = ['cave_5', 'cave_shortcut', 'cave_end'].map((n) => {
      const p = fix!.waypoints.get(n);
      const cell = p ? world.feetCell(p) : undefined;
      if (!cell) throw new Error(`no waypoint ${n} with a floor`);
      return { name: n, cell };
    });
    // the model's proof on the fixture (what `!fly route cave` asks before taking the shortcut)
    const proof = await proveShortcut(world.grid, stops.map((s) => s.cell));
    notes.push(`flyS: the shortcut ${proof.proven ? 'PROVEN' : `not proven (${proof.reason ?? '?'})`} on the model, ${proof.windows} windows\n    ${proof.lines.join('\n    ')}`);
    // the route in replica coordinates as the trip's corridor (the executor proves and flies its windows)
    const pts: RoutePoint[] = stops.map((s) => ({ name: s.name, cell: { x: s.cell.x + d.x, y: s.cell.y, z: s.cell.z + d.z } }));
    const provider = new WaypointProvider(pts, { covered: (c) => coveredReal({ x: c.x - d.x, y: c.y, z: c.z - d.z }) });
    setCorridorProvider(bot!.task, provider);
    try {
      for (let i = 0; i < runs; i++) await flyBetween('flyS', `${i} cave_5 -> cave_shortcut -> cave_end`, stops[0]!.cell, stops[2]!.cell);
    } finally {
      setCorridorProvider(bot!.task, undefined);
      setCorridorUnderFly(bot!.task, undefined);
    }
    expect(rows.filter((r) => r.run === 'flyS').length).toBe(runs);
  }, 3_600_000);

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
