// e2e (tag @bds), flight v2 Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand",
// decisions/0083): the flight in the open measured on bds-fly (udp/19204, FLAT, peaceful, fall damage ON, truth pack),
// for the rockets the kit holds and for what the bot is told about them. One afk-task bot flies `!fly x y z` to a ground
// cell and lands, RUNS times a case:
//   flat400   400 blocks over flat ground
//   flat650   650 blocks over flat ground
//   hill650   650 blocks with a hill 47 high across the way from 250 to 330 out (walls every 8 blocks, 81 wide): the
//             terrain floor asks for height on the way, as the Realm's hills do
// Measured per flight, from the bot's own lines and the truth pack: the planned cruise height (`fly: to ... cruise y`),
// the climb's top and the height it went for, the flight's top, the rockets by phase, the ticks, the terrain avoidances
// with the height each gained, the corrections, the seconds, the damage, the feet from the cell's centre. Asserted: every
// flight lands within 3 of the cell with 0 damage. The numbers are the test's product: the table is printed, and with
// FLY_OPEN_OUT=<file> every row is appended to it as a JSON line.
// FLY_ROCKETS=crafted: the kit's rockets are a player's (flight duration 1, 19 to 31 ticks; fly-truth.ts).
// FLY_KIT_BURN=1: `flyKitBurn` on (the flight plans with the kit's burn; fly-truth.ts); default off, as the setting.
// FLY_OPEN_ONLY=flat650,hill650 picks cases, FLY_OPEN_RUNS=5 the runs a case (default 3).
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { CRAFTED_ROCKETS, E2E, FEET_Y, giveFlightKit, hdist, KIT_BURN, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_OPEN_RUNS ?? 3);
const ONLY = new Set((process.env.FLY_OPEN_ONLY ?? '').split(',').filter(Boolean));
const OUT = process.env.FLY_OPEN_OUT;
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Row {
  label: string;
  kit: 'plain' | 'crafted';
  kitBurn: boolean;
  ok: boolean;
  /** Heights over the start's feet: the planned cruise, the climb's top and what it went for, the flight's top. */
  cruise: number;
  climbTop: number;
  climbGoal: number;
  maxY: number;
  rockets: number;
  climbRockets: number;
  cruiseRockets: number;
  goArounds: number;
  ticks: number;
  corrections: number;
  seconds: number;
  /** The height each terrain avoidance gained, and its rockets. */
  avoidances: { gained: number; rockets: number }[];
  off: number;
  damage: number;
  line: string;
}

describe.skipIf(!E2E)('@bds fly: the open-air flight on the burn of the rockets at hand (flight v2, Track F10)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block], 60_000);

  async function fly(label: string, start: Vec3, goal: { x: number; z: number }): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, start);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!fly ${goal.x} ${F} ${goal.z}`);
    const first = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from, 60_000);
    expect(first, label).toMatch(/^flying/);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 300_000);
    const seconds = (Date.now() - t0) / 1000;
    await sleep(1000);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    const line = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
    const plan = logs.find((l) => l.startsWith('fly: to ') && l.includes('cruise y')) ?? '';
    const num = (re: RegExp, s: string, d = NaN): number => {
      const m = re.exec(s);
      return m ? Number(m[1]) : d;
    };
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const row: Row = {
      label,
      kit: CRAFTED_ROCKETS ? 'crafted' : 'plain',
      kitBurn: KIT_BURN,
      ok: line.includes('flight: landed'),
      cruise: num(/cruise y (-?[\d.]+)/, plan) - start.y,
      climbTop: num(/\(the climb to (-?[\d.]+)/, line) - start.y,
      climbGoal: num(/the climb to -?[\d.]+, for (-?[\d.]+)\)/, line) - start.y,
      maxY: num(/max y (-?[\d.]+)/, line) - start.y,
      rockets: num(/; (\d+) rockets/, line, -1),
      climbRockets: num(/\((\d+) climb/, line, -1),
      cruiseRockets: num(/, (\d+) cruise/, line, -1),
      goArounds: num(/, (\d+) go-arounds/, line, -1),
      ticks: num(/, (\d+) ticks/, line, -1),
      corrections: num(/, (\d+) corrections/, line, -1),
      seconds,
      avoidances: logs.filter((l) => l.includes('terrain cleared')).map((l) => ({ gained: num(/gained (\d+) blocks/, l), rockets: num(/, (\d+) rockets$/, l) })),
      off: hdist(g.location, { x: goal.x + 0.5, z: goal.z + 0.5 }),
      damage: dmg.total,
      line,
    };
    rows.push(row);
    if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    notes.push(`${label}: ${first} -> ${end} | ${plan} | ${line} | ${logs.filter((l) => /terrain ahead|terrain cleared|planned for rockets/.test(l)).join(' ; ')}`);
    return row;
  }

  const check = (r: Row): void => {
    expect(r.ok, `${r.label}: ${r.line}`).toBe(true);
    expect(r.off, `${r.label}: ${r.line}`).toBeLessThanOrEqual(3);
    expect(r.damage, r.label).toBe(0);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Open');
    await teleport(bot, { x: area.x + 0.5, y: F, z: area.z + 0.5 });
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');
    const table = [
      `${pad('flight', 13)}${pad('cruise', 8)}${pad('climb', 8)}${pad('for', 8)}${pad('top', 8)}${pad('rockets', 14)}${pad('ticks', 7)}${pad('s', 7)}${pad('corr', 6)}${pad('off', 6)}${pad('damage', 8)}avoidances (gained / rockets)`,
      ...rows.map((r) => `${pad(r.label, 13)}${pad(f(r.cruise), 8)}${pad(f(r.climbTop), 8)}${pad(f(r.climbGoal), 8)}${pad(f(r.maxY), 8)}${pad(`${r.rockets} (${r.climbRockets}/${r.cruiseRockets})`, 14)}${pad(r.ticks, 7)}${pad(r.seconds.toFixed(1), 7)}${pad(r.corrections, 6)}${pad(r.off.toFixed(1), 6)}${pad(r.damage, 8)}${r.avoidances.map((a) => `${a.gained}/${a.rockets}`).join(' ')}`),
    ];
    console.log(`[fly-open e2e] ${CRAFTED_ROCKETS ? 'crafted' : 'plain'} rockets, flyKitBurn ${KIT_BURN ? 'on' : 'off'}; heights over the start; area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  for (const dist of [400, 650]) {
    it.skipIf(!want(`flat${dist}`))(`${dist} blocks over flat ground: landed within 3, 0 damage`, async () => {
      const start = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
      for (let i = 0; i < RUNS; i++) check(await fly(`flat${dist} #${i + 1}`, start, { x: area.x, z: area.z + dist }));
    }, 1_200_000);
  }

  it.skipIf(!want('hill650'))('650 blocks with a hill 47 high across the way from 250 to 330 out: landed within 3, 0 damage', async () => {
    const x = area.x + 300;
    const z = area.z;
    const start = { x: x + 0.5, y: F, z: z + 0.5 };
    const walls = Array.from({ length: 11 }, (_, i) => z + 250 + i * 8);
    // (built from between two of its walls: their chunks loaded)
    const mid = { x: x + 0.5, y: F, z: z + 294.5 };
    await teleport(bot!, mid);
    for (const wz of walls) await fill(x - 40, F, wz, x + 40, F + 46, wz, 'stone');
    try {
      for (let i = 0; i < RUNS; i++) check(await fly(`hill650 #${i + 1}`, start, { x, z: z + 650 }));
    } finally {
      await teleport(bot!, mid);
      for (const wz of walls) await fill(x - 40, F, wz, x + 40, F + 46, wz, 'air').catch(() => undefined);
    }
  }, 1_800_000);
});
