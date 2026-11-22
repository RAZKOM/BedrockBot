// e2e (tag @bds), Track EF1 (docs/benchmarks.md "The protocol"): the common jobs side by side on a generated world
// (seed 7, bds-world by default; the flight on bds-fly3 with the same world). Not a gate: a measurement. Each run is a
// fresh bot (wired like the CLI, its world cache in a fresh directory: it has seen nothing of this world) at a fixed spot
// of the job (SPOTS, chosen by bench-survey.test.ts), given the job's kit, the job's command typed by the console, and
// watched until the job's user process has been gone for 3 s (`any`: every process) or the job's cap. Peaceful, noon
// with the clock frozen, clear weather, fall damage on. The world is reset to a fresh copy of the seed before each job's
// runs (outside this file: .work/ef1/tools/reset-world.ps1), so run i of a job meets the same ground in every arm.
//
// A row per run (one JSON line in BENCH_OUT): the job, the arm, the run, the spot, the end line, the time, the items
// gained and the target, items an hour, the time to the first item, every tick of the run in one bucket (walk, plan,
// act, dig, pickup, chest, job, idle: bench-truth.ts Sampler), the navigator's totals (gotos, failed gotos by reason,
// distance, plans, plan ms, stuck, move timeouts, corrections), the Digger's (digs, done, failed by reason, ticks, the
// break-time table's ticks), the miner's stats when the job mined, deaths, damage, the cause when the run failed or ended
// short, and the pace: the time a good player needs for the same digs and the same walk (the table's break ticks / 20 +
// the distance walked / 5.6 blocks a second, a sprint; a travel job: the straight line / 5.6) and the run's time over it.
//   BENCH_JOB    job ids, comma-separated (default every job of this server; `list` prints them)
//   BENCH_N      runs a job (default 5)
//   BENCH_FROM   the first run index (default 0)
//   BENCH_ARM    a label for the rows (before | after; default `run`)
//   BENCH_SET    settings for every run, `k=v,k=v` (`!set` values: an arm's switches)
//   BENCH_OUT    the JSONL file rows are appended to; BENCH_LOG a directory for each run's bot log
//   BENCH_BUDGET seconds for this invocation: a run starts only if its cap fits (`<out>.next` says where to go on)
// Env: BENCH_BDS_HOST / BENCH_BDS_PORT / BENCH_BDS_CONTAINER (bench-truth.ts), BENCH_VERBOSE=1.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { truthLoaded } from './get-truth.ts';
import { BENCH_CONTAINER, benchCmd, E2E, loadKit, prepareServer, Sampler, sleep, startBenchBot, teleport, type BenchBot } from './bench-truth.ts';

const N = Number(process.env.BENCH_N ?? 5);
const FROM = Number(process.env.BENCH_FROM ?? 0);
const ARM = process.env.BENCH_ARM ?? 'run';
const OUT = process.env.BENCH_OUT;
const LOG_DIR = process.env.BENCH_LOG;
/** Seconds one invocation may take: a run starts only when its cap fits (the rest from BENCH_FROM in the next one). */
const BUDGET_S = Number(process.env.BENCH_BUDGET ?? Infinity);
const SETS: [string, string][] = (process.env.BENCH_SET ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  });
const FLY_SERVER = BENCH_CONTAINER.startsWith('bds-fly');

type Kit = readonly (readonly [string, number])[];

/** The stone kit (docs/early-game.md: what `!get kit` ends with), food for the day. */
const STONE: Kit = [
  ['stone_pickaxe', 1],
  ['stone_axe', 1],
  ['stone_shovel', 1],
  ['stone_sword', 1],
  ['cobblestone', 32],
  ['bread', 16],
];

/** The live kit (the Realm bot's: netherite tools and armour, a shield), food. */
const LIVE: Kit = [
  ['netherite_pickaxe', 1],
  ['netherite_axe', 1],
  ['netherite_shovel', 1],
  ['netherite_sword', 1],
  ['netherite_helmet', 1],
  ['netherite_chestplate', 1],
  ['netherite_leggings', 1],
  ['netherite_boots', 1],
  ['shield', 1],
  ['cooked_beef', 32],
  ['cobblestone', 64],
];

/** The flight kit on top of the live kit: the elytra worn by the flight, 3 stacks of rockets. */
const FLY: Kit = [...LIVE.filter(([n]) => n !== 'netherite_chestplate'), ['elytra', 1], ['firework_rocket', 64], ['firework_rocket', 64], ['firework_rocket', 64], ['netherite_chestplate', 1]];

/** Spots: the ground's feet cell (bench-survey.test.ts, seed 7). */
interface Spot {
  x: number;
  y: number;
  z: number;
}

/**
 * The five spots every ground job uses (run i at spot i; the world is fresh for each job): land under the sky with no
 * log or leaves over it, oak within 48, coal and iron within 32 (bench-survey.test.ts on seed 7: 52 to 999 oak logs,
 * 63 to 149 iron and 337 to 748 coal ore blocks within those radii). Spot 0 and 2 are on a mountain (feet 119, 110).
 */
const SPOTS: Spot[] = [
  { x: 1300, y: 119, z: 1000 },
  { x: 1000, y: 73, z: 1300 },
  { x: 1300, y: 110, z: 1200 },
  { x: 1000, y: 65, z: 1600 },
  { x: 1300, y: 65, z: 1600 },
];

/**
 * The travel runs: from, to (both land under the sky with nothing over the column, the survey's ground): 200 and 500
 * blocks along an axis or nearly (510, 538), down and up the mountain, over the forest, round the lakes; the flights
 * about 1000 (949 to 1273) over the forest, the ocean and the mountain.
 */
const PAIRS: Record<string, [Spot, Spot][]> = {
  'goto-200': [
    [{ x: 1300, y: 119, z: 1000 }, { x: 1300, y: 76, z: 800 }],
    [{ x: 1000, y: 73, z: 1300 }, { x: 800, y: 73, z: 1300 }],
    [{ x: 1000, y: 65, z: 1600 }, { x: 1000, y: 66, z: 1400 }],
    [{ x: 1000, y: 66, z: 1000 }, { x: 800, y: 109, z: 1000 }],
    [{ x: 1100, y: 63, z: 1000 }, { x: 1300, y: 119, z: 1000 }],
  ],
  'goto-500': [
    [{ x: 1300, y: 119, z: 1000 }, { x: 800, y: 109, z: 1000 }],
    [{ x: 1000, y: 73, z: 1300 }, { x: 1000, y: 68, z: 800 }],
    [{ x: 1000, y: 65, z: 1600 }, { x: 1000, y: 64, z: 1100 }],
    [{ x: 1300, y: 110, z: 1200 }, { x: 800, y: 73, z: 1300 }],
    [{ x: 1300, y: 76, z: 800 }, { x: 800, y: 109, z: 1000 }],
  ],
  'fly-1000': [
    [{ x: 1600, y: 70, z: 2200 }, { x: 1300, y: 110, z: 1200 }],
    [{ x: 1000, y: 69, z: 2500 }, { x: 1000, y: 66, z: 1400 }],
    [{ x: 700, y: 65, z: 700 }, { x: 1300, y: 65, z: 1600 }],
    [{ x: 1800, y: 72, z: 1600 }, { x: 800, y: 73, z: 1300 }],
    [{ x: 2200, y: 68, z: 2500 }, { x: 1300, y: 63, z: 2200 }],
  ],
};

interface Ctx {
  spot: Spot;
  /** Extra numbers for the row (a setup's own counts). */
  extra: Record<string, unknown>;
  /** The straight-line distance of a travel job. */
  straight?: number;
  goal?: Spot;
}

interface Job {
  id: string;
  /** The command, from the run's context. */
  cmd: (c: Ctx) => string;
  kit: Kit;
  /** Item names whose count is the job's yield (any of them). */
  items: readonly string[];
  /** The target count (items) of the command; 0: a travel or a chore. */
  target: number;
  /** Seconds a run may take before it is stopped. */
  capS: number;
  /** `user`: done once no user process for 3 s; `any`: once no process at all. */
  doneBy?: 'user' | 'any';
  sets?: readonly [string, string][];
  /** Builds what the run needs at the spot (after the kit); may fill ctx.extra. */
  setup?: (b: BenchBot, c: Ctx) => Promise<void>;
  /** After the run: more numbers for the row. */
  after?: (b: BenchBot, c: Ctx) => Promise<void>;
  /** The yield when it is no item carried (the calves of `breed`), read after `after`. */
  yieldOf?: (c: Ctx) => number;
  travel?: boolean;
  /** Which server (fly: bds-fly*). */
  fly?: boolean;
}

const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** A flat platform of radius r at the spot: grass at the ground's level, dirt under it, air 8 high over it. */
async function platform(b: BenchBot, s: Spot, r: number): Promise<void> {
  const t = b.truth;
  await truthLoaded(t, 'fill', [s.x - r, s.y - 4, s.z - r, s.x + r, s.y - 2, s.z + r, 'dirt']);
  await truthLoaded(t, 'fill', [s.x - r, s.y - 1, s.z - r, s.x + r, s.y - 1, s.z + r, 'grass_block']);
  await truthLoaded(t, 'fill', [s.x - r, s.y, s.z - r, s.x + r, s.y + 8, s.z + r, 'air']);
}

/** A full inventory of mined loot (34 stacks) beside a pickaxe and a sword: what a day of mining leaves. */
const LOOT: Kit = [
  ['stone_pickaxe', 1],
  ['stone_sword', 1],
  ['cobblestone', 64 * 8],
  ['dirt', 64 * 5],
  ['andesite', 64 * 3],
  ['diorite', 64 * 2],
  ['granite', 64 * 2],
  ['raw_iron', 64 * 3],
  ['coal', 64 * 3],
  ['oak_log', 64 * 3],
  ['gravel', 64 * 2],
  ['sand', 64 * 2],
  ['bread', 16],
];

/** Four single chests round the home point (3 off on x, 2 off on z), the home set at the spot. */
async function homeChests(b: BenchBot, s: Spot): Promise<Vec3[]> {
  const chests = [
    { x: s.x + 3, y: s.y, z: s.z - 2 },
    { x: s.x + 3, y: s.y, z: s.z + 2 },
    { x: s.x - 3, y: s.y, z: s.z - 2 },
    { x: s.x - 3, y: s.y, z: s.z + 2 },
  ];
  for (const p of chests) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'chest']);
  b.task.home!.set({ x: s.x, y: s.y, z: s.z });
  return chests;
}

async function stored(b: BenchBot, chests: Vec3[]): Promise<number> {
  let n = 0;
  for (const p of chests) n += (await b.truth.box(p)).total;
  return n;
}

/** Counters `a` less a snapshot `b` taken before the command (nested records of numbers, a key only in `a` kept whole). */
function minus<T>(a: T, b: T): T {
  if (typeof a === 'number') return (a - (typeof b === 'number' ? b : 0)) as T;
  if (!a || typeof a !== 'object') return a;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) out[k] = minus(v, (b as Record<string, unknown> | undefined)?.[k]);
  return out as T;
}

const LOG_KINDS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log', 'poplar_log'];

const mine = (id: string, block: string, n: number, item: string, kit: Kit, capS: number): Job => ({
  id,
  cmd: () => `!mine ${block} ${n}`,
  kit,
  items: [item],
  target: n,
  capS,
});

const travel = (id: string, capS: number): Job => ({
  id,
  cmd: (c) => `!goto ${c.goal!.x} ${c.goal!.y} ${c.goal!.z}`,
  kit: STONE,
  items: [],
  target: 0,
  capS,
  travel: true,
  sets: [['autoFly', 'off']],
});

const JOBS: Job[] = [
  mine('mine-iron-stone', 'iron_ore', 16, 'raw_iron', STONE, 420),
  mine('mine-iron-live', 'iron_ore', 16, 'raw_iron', LIVE, 420),
  mine('mine-coal-stone', 'coal_ore', 32, 'coal', STONE, 300),
  mine('mine-coal-live', 'coal_ore', 32, 'coal', LIVE, 300),
  mine('mine-diamond-live', 'diamond_ore', 4, 'diamond', LIVE, 600),
  // (`!get oak_log` is the plain wood job: any log kind counts, skills/items/catalog.ts)
  { id: 'wood', cmd: () => '!get oak_log 64', kit: STONE, items: LOG_KINDS, target: 64, capS: 600 },
  { id: 'get-cobble', cmd: () => '!get cobblestone 64', kit: STONE, items: ['cobblestone'], target: 64, capS: 420 },
  { id: 'get-dirt', cmd: () => '!get dirt 64', kit: STONE, items: ['dirt'], target: 64, capS: 420 },
  {
    id: 'farm',
    cmd: () => '!farm',
    kit: STONE,
    items: ['wheat'],
    target: 80,
    capS: 400,
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 9);
      await truthLoaded(b.truth, 'field', [s.x - 4, s.y - 1, s.z - 4, 9, 9, 'wheat', 7]);
      await truthLoaded(b.truth, 'set', [s.x, s.y - 1, s.z, 'water']);
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z - 6 + 0.5 });
    },
    after: async (b, c) => {
      const s = c.spot;
      const r = await truthLoaded<{ cropCounts: Record<string, number>; growth: number[] }>(b.truth, 'crops', [s.x - 4, s.y - 1, s.z - 4, 9, 9]);
      c.extra.replanted = Object.entries(r.cropCounts).filter(([k]) => k.includes('wheat')).reduce((a, [, v]) => a + v, 0);
    },
  },
  {
    id: 'get-wheat',
    cmd: () => '!get wheat',
    kit: STONE,
    items: ['wheat'],
    target: 80,
    capS: 400,
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 9);
      await truthLoaded(b.truth, 'field', [s.x - 4, s.y - 1, s.z - 4, 9, 9, 'wheat', 7]);
      await truthLoaded(b.truth, 'set', [s.x, s.y - 1, s.z, 'water']);
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z - 6 + 0.5 });
    },
  },
  {
    id: 'breed',
    cmd: () => '!breed cow 2',
    kit: [...STONE, ['wheat', 16]],
    items: [],
    target: 2,
    capS: 120,
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 6);
      // a 7 x 7 fence ring round the spot, 4 cows inside
      await truthLoaded(b.truth, 'fill', [s.x - 3, s.y, s.z - 3, s.x + 3, s.y, s.z + 3, 'oak_fence']);
      await truthLoaded(b.truth, 'fill', [s.x - 2, s.y, s.z - 2, s.x + 2, s.y, s.z + 2, 'air']);
      for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as const) await b.truth.summon('cow', { x: s.x + dx + 0.5, y: s.y, z: s.z + dz + 0.5 });
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      await sleep(1000);
      c.extra.cows0 = (await b.truth.near({ x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, 5)).filter((m) => m.typeId === 'minecraft:cow').length;
    },
    after: async (b, c) => {
      const s = c.spot;
      await sleep(2000);
      const cows = (await b.truth.near({ x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, 5)).filter((m) => m.typeId === 'minecraft:cow').length;
      c.extra.cows = cows;
      c.extra.babies = cows - Number(c.extra.cows0 ?? 4);
      await b.truth.cleanup().catch(() => undefined);
    },
    yieldOf: (c) => Number(c.extra.babies ?? 0),
  },
  {
    id: 'unload',
    cmd: () => '!unload',
    kit: LOOT,
    items: [],
    target: 0,
    capS: 180,
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 8);
      c.extra.chests = await homeChests(b, s);
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      c.extra.carried0 = carried(b);
    },
    after: async (b, c) => {
      c.extra.stored = await stored(b, c.extra.chests as Vec3[]);
      c.extra.carried = carried(b);
      delete c.extra.chests;
    },
  },
  {
    id: 'home-chore',
    cmd: () => '',
    kit: LOOT,
    items: [],
    target: 0,
    capS: 180,
    doneBy: 'any',
    sets: [['autoUnload', 'on']],
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 8);
      c.extra.chests = await homeChests(b, s);
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      c.extra.carried0 = carried(b);
    },
    after: async (b, c) => {
      c.extra.stored = await stored(b, c.extra.chests as Vec3[]);
      c.extra.carried = carried(b);
      delete c.extra.chests;
    },
  },
  {
    id: 'bring',
    cmd: () => '!bring iron_ingot 192 home',
    kit: STONE,
    items: ['iron_ingot'],
    target: 192,
    capS: 180,
    setup: async (b, c) => {
      const s = c.spot;
      await platform(b, s, 12);
      b.task.home!.set({ x: s.x, y: s.y, z: s.z });
      const a = { x: s.x + 10, y: s.y, z: s.z - 9 };
      const d = { x: s.x - 9, y: s.y, z: s.z + 10 };
      const e = { x: s.x + 10, y: s.y, z: s.z + 10 };
      for (const p of [a, d, e]) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'chest']);
      await b.truth.chestPut(a, 'iron_ingot', 64, 2);
      await b.truth.chestPut(d, 'iron_ingot', 64, 1);
      await b.truth.chestPut(e, 'torch', 64, 2);
      await teleport(b, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      // the bot learns the chests as it would at home (a scan, not timed)
      await b.command('!chests scan');
      await sleep(8000);
    },
  },
  travel('goto-200', 300),
  travel('goto-500', 420),
  {
    id: 'fly-1000',
    cmd: (c) => `!fly ${c.goal!.x} ${c.goal!.y} ${c.goal!.z}`,
    kit: FLY,
    items: [],
    target: 0,
    capS: 300,
    travel: true,
    fly: true,
  },
];

function carried(b: BenchBot): number {
  return b.built.mobility!.world.inventory.slots.reduce((a, s) => a + (s?.count ?? 0), 0);
}

/** The cause of a failed or short run, from the row's own numbers and the end line. */
function causeOf(row: Row): string {
  const e = row.end.toLowerCase();
  if (row.deaths > 0) return 'died';
  if (row.capped) return 'capped';
  if (e.includes('inventory full')) return 'inventory full';
  if (/no pickaxe|no tool/.test(e)) return 'no tool';
  if (/unreachable|no path|no way/.test(e)) return 'unreachable';
  if (/timeout|timed out/.test(e)) return 'timeout';
  if (e.includes('stuck')) return 'stuck';
  if (row.target > 0 && row.items < row.target) return 'short';
  if (row.travel && !/arrived|walked to|landed|landing/.test(e)) return 'not arrived';
  return '';
}

interface Row {
  arm: string;
  job: string;
  run: number;
  spot: Spot;
  cmd: string;
  end: string;
  lines: string[];
  seconds: number;
  capped: boolean;
  items: number;
  target: number;
  perHour: number;
  firstS: number | null;
  shares: Record<string, number>;
  processes: Record<string, number>;
  states: Record<string, number>;
  nav: unknown;
  dig: unknown;
  miner?: unknown;
  deaths: number;
  damage: number;
  travel: boolean;
  straight?: number;
  /** Straight-line blocks a second (travel). */
  speed?: number;
  /** The good player's time for the same digs and walk (s), and the run's time over it. */
  paceS: number;
  slow: number;
  cause: string;
  extra: Record<string, unknown>;
  sets: string;
}

const only = process.env.BENCH_JOB?.split(',').map((s) => s.trim());
const chosen = JOBS.filter((j) => (only ? only.includes(j.id) : !!j.fly === FLY_SERVER));

describe.skipIf(!E2E)('@bds bench: the common jobs (Track EF1)', () => {
  const rows: Row[] = [];

  beforeAll(async () => {
    if (process.env.BENCH_JOB === 'list') {
      console.log(JOBS.map((j) => j.id).join(' '));
      return;
    }
    await prepareServer();
  }, 120_000);

  afterAll(() => {
    for (const j of chosen) {
      const rs = rows.filter((r) => r.job === j.id);
      if (!rs.length) continue;
      console.log(
        `[bench] ${ARM} ${j.id}: ${rs.length} runs, s ${rs.map((r) => r.seconds).join(' ')}, items ${rs.map((r) => r.items).join(' ')}, per h ${rs.map((r) => r.perHour).join(' ')}, slow ${rs.map((r) => r.slow).join(' ')}, causes ${rs.map((r) => r.cause || '-').join(' ')}`,
      );
    }
  });

  for (const job of chosen) {
    it(`${job.id}`, async () => {
      if (process.env.BENCH_JOB === 'list') return;
      const spots = job.travel ? PAIRS[job.id]!.map(([f]) => f) : SPOTS;
      expect(spots.length, 'no spots').toBeGreaterThan(0);
      const t0 = Date.now();
      for (let i = FROM; i < FROM + N && i < spots.length; i++) {
        // the budget: a run is started only when its cap still fits (the next invocation goes on from it)
        if ((Date.now() - t0) / 1000 + job.capS + 60 > BUDGET_S) {
          console.log(`[bench] budget ${BUDGET_S} s: next ${job.id} run ${i}`);
          if (OUT) appendFileSync(`${OUT}.next`, `${job.id} ${i}\n`);
          break;
        }
        const row = await runOnce(job, i, spots[i]!);
        rows.push(row);
        console.log(`[bench] ${JSON.stringify({ ...row, lines: row.lines.slice(-6) })}`);
        if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      }
    }, 6 * 3_600_000);
  }
});

async function runOnce(job: Job, i: number, spot: Spot): Promise<Row> {
  const b = await startBenchBot(`B${job.id.replace(/[^a-z]/g, '').slice(0, 5)}${i}`);
  const mob = b.built.mobility!;
  const w = mob.world;
  const inv = w.inventory;
  const ctx: Ctx = { spot, extra: {} };
  if (job.travel) {
    const g = PAIRS[job.id]?.[i]?.[1];
    if (!g) throw new Error(`no goal for ${job.id} run ${i}`);
    ctx.goal = g;
    ctx.straight = +Math.hypot(g.x - spot.x, g.z - spot.z).toFixed(1);
  }
  try {
    await benchCmd('gamerule', 'falldamage', 'false');
    await teleport(b, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, 4);
    await loadKit(b, job.kit);
    for (const [k, v] of [...(job.sets ?? []), ...SETS]) b.settings.set(k as Parameters<BenchBot['settings']['set']>[0], v);
    await job.setup?.(b, ctx);
    await benchCmd('gamerule', 'falldamage', 'true');
    await sleep(3000); // the survival kit puts the armour on
    const count = () => job.items.reduce((a, n) => a + inv.count(n), 0);
    const sampler = new Sampler(b, count);
    const procs = b.task.processes!;
    const d0 = b.built.respawn?.deaths ?? 0;
    let damage = 0;
    let hp = w.self.health;
    const offHp = mob.loop.onBeforeStep(() => {
      const h = w.self.health;
      if (h < hp) damage += hp - h;
      hp = h;
    });
    const said0 = b.said.length;
    // the counters from here on (a set-up's own walks, `!chests scan`, are not the job's)
    const nav0 = structuredClone(mob.skills.nav.totals);
    const dig0 = mob.skills.digger ? structuredClone(mob.skills.digger.stats) : undefined;
    const cmd = job.cmd(ctx);
    const t0 = Date.now();
    sampler.begin();
    if (cmd) await b.command(cmd);
    let seen = false;
    let quietSince: number | undefined;
    let capped = false;
    for (;;) {
      await sleep(250);
      const busy = job.doneBy === 'any' ? procs.active !== undefined || procs.userProcesses().length > 0 : procs.userProcesses().length > 0;
      if (busy) {
        seen = true;
        quietSince = undefined;
        sampler.freeze(false);
      } else if (seen || Date.now() - t0 > 20_000) {
        quietSince ??= Date.now();
        sampler.freeze(true);
        if (Date.now() - quietSince >= 3000) break;
      }
      if (Date.now() - t0 > job.capS * 1000) {
        capped = true;
        await b.command('!stop');
        await sleep(2000);
        break;
      }
    }
    const seconds = +((Date.now() - t0 - (capped ? 2000 : quietSince ? Date.now() - quietSince : 0)) / 1000).toFixed(1);
    sampler.end();
    offHp();
    await job.after?.(b, ctx);
    const lines = b.said.slice(said0);
    const nav = minus(mob.skills.nav.totals, nav0);
    const dig = mob.skills.digger && dig0 ? minus(mob.skills.digger.stats, dig0) : undefined;
    const mt = sampler.tasks.get('mine') as { stats?: Record<string, unknown>; state?: string } | undefined;
    const miner = mt?.stats ? Object.fromEntries(Object.entries(mt.stats).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) : undefined;
    const items = job.yieldOf ? job.yieldOf(ctx) : sampler.gained;
    const ideal = job.travel ? (ctx.straight ?? 0) / 5.6 : (dig?.expected ?? 0) / 20 + nav.distance / 5.6;
    const row: Row = {
      arm: ARM,
      job: job.id,
      run: i,
      spot,
      cmd,
      end: lines.at(-1) ?? '',
      lines,
      seconds,
      capped,
      items,
      target: job.target,
      perHour: seconds > 0 ? Math.round((items * 3600) / seconds) : 0,
      firstS: sampler.firstItem === undefined ? null : +(sampler.firstItem / 20).toFixed(1),
      shares: sampler.shares(),
      processes: sampler.processes,
      states: sampler.states,
      nav: { ...nav, distance: +nav.distance.toFixed(1), planMs: Math.round(nav.planMs), reports: sampler.reports.size },
      dig: dig ? { ...dig } : undefined,
      miner,
      deaths: (b.built.respawn?.deaths ?? 0) - d0,
      damage: +damage.toFixed(1),
      travel: !!job.travel,
      ...(ctx.straight !== undefined ? { straight: ctx.straight, speed: seconds > 0 ? +(ctx.straight / seconds).toFixed(2) : 0 } : {}),
      paceS: +ideal.toFixed(1),
      slow: ideal > 0 ? +(seconds / ideal).toFixed(2) : 0,
      cause: '',
      extra: ctx.extra,
      sets: [...(job.sets ?? []), ...SETS].map((s) => s.join('=')).join(','),
    };
    if (job.travel && ctx.goal) {
      row.extra.left = +near(mob.position() ?? { x: 0, y: 0, z: 0 }, ctx.goal).toFixed(1);
      row.extra.route = ctx.straight ? +(nav.distance / ctx.straight).toFixed(2) : 0;
    }
    row.cause = causeOf(row);
    return row;
  } finally {
    if (LOG_DIR) {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(join(LOG_DIR, `${ARM}-${job.id}-${i}.log`), `${b.logs.join('\n')}\n--- said\n${b.said.join('\n')}\n`);
    }
    await b.truth.ok('clear', [b.name]).catch(() => undefined);
    await b.stop().catch(() => undefined);
  }
}
