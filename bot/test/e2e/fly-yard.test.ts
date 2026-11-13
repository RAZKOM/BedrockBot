// e2e (tag @bds), flight v2 Track F11 (docs/flight.md "The flight comes down where it planned to", decisions/0084): a
// landing on a floor ringed by taller roofs and fence lines, come to from high over it; on bds-fly (udp/19204, FLAT,
// peaceful, fall damage ON, truth pack). One afk-task bot with the flight kit; a truth-built yard in a private area:
//
//   the yard    14 x 14 of the flat ground, closed all round: a house with a stepped roof 7 to 10 high along its west
//               side, a block 6 high with a part 12 high along its east side, oak fences along the north and the south
//               and in the corners between; a small building 5 to 7 high stands in its north-west corner and a tower
//               25 high on the west house, 15 blocks from where the landings are (the descent circle fits at radius 10)
//   the goal    the end of a passage one block wide and two high inside the east block (16 blocks of walk from its
//               mouth in the yard): under a roof, so the landing search chooses a cell of the yard by its mouth
//
// Every flight starts on a 3 x 3 pillar 70 over the yard, 150 blocks east of it, so the body arrives 50 to 60 over the
// landing and comes down in a circle round it, over the roofs:
//   goal        `!fly` to the goal: the landing is the search's (a walk landing of the yard's cells), then the walk in
//   exact       `!fly` to a cell of the yard (an exact landing, half 1): `near`, three blocks from the east block, 13 from
//               the tower (a circle of 8 fits round it); `mid`, in the middle of the yard, 9 from the tower (no circle fits
//               round it: the circle beside the approach line, as before the track)
// Asserted per flight: `flight: landed`, standing on the yard's floor, within 2 blocks of the landing's centre, 0 damage;
// for `goal` the walk arrives. The table is printed; FLY_YARD_OUT=<file> appends every row as a JSON line.
// FLY_YARD_OLD=1: the flight as it was before the track (plan.ts LAND_SWITCH for the circle, `flyLandOver` off for the
// nearest safe ground), measured and printed, nothing asserted.
// FLY_YARD_RUNS=5 the runs a case (default 5), FLY_YARD_ONLY=goal,exact,mid picks cases. FLY_ROCKETS=crafted, FLY_KIT_BURN=1
// as in fly-truth.ts. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { LAND_SWITCH } from '../../src/skills/fly/plan.ts';
import { CRAFTED_ROCKETS, E2E, FEET_Y, giveFlightKit, KIT_BURN, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_YARD_RUNS ?? 5);
const ONLY = new Set((process.env.FLY_YARD_ONLY ?? '').split(',').filter(Boolean));
const OUT = process.env.FLY_YARD_OUT;
const OLD = process.env.FLY_YARD_OLD === '1';
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Row {
  label: string;
  old: boolean;
  kit: 'plain' | 'crafted';
  kitBurn: boolean;
  /** `landed`, or the reason the flight ended with. */
  end: string;
  /** The flight's own end: blocks from the landing's centre, the height over the yard's floor, inside the yard on its floor. */
  off: number;
  up: number;
  onFloor: boolean;
  damage: number;
  causes: string[];
  descent: string;
  style: string;
  rockets: number;
  goArounds: number;
  ticks: number;
  seconds: number;
  /** The landing: the cells of a walk landing (0: an exact one). */
  cells: number;
  walk: string;
  why: string;
}

describe.skipIf(!E2E)('@bds fly: a landing ringed by roofs and fences, from high over it (flight v2, Track F11)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  // the yard's middle; the yard is x - 6 .. x + 7, z - 6 .. z + 7
  const c = { x: area.x, z: area.z };
  const goal = { x: c.x + 9, y: F, z: c.z - 3 };
  const mid = { x: c.x + 1, y: F, z: c.z + 1 };
  const near = { x: c.x + 5, y: F, z: c.z + 2 };
  const pillar = { x: c.x + 150, z: c.z };
  const pillarTop: Vec3 = { x: pillar.x + 0.5, y: F + 70, z: pillar.z + 0.5 };
  const inYard = (p: { x: number; z: number }): boolean => p.x >= c.x - 6 && p.x < c.x + 8 && p.z >= c.z - 6 && p.z < c.z + 8;
  /** A line's positions as offsets from the yard's middle (the area is random: two runs read the same). */
  const relative = (s: string): string => s.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?=[ ,;:)|]|$)/g, (m, x: string, y: string, z: string) => (Math.abs(Number(x) - c.x) < 400 && Math.abs(Number(z) - c.z) < 400 ? `[${(Number(x) - c.x).toFixed(1)} ${(Number(y) - F).toFixed(1)} ${(Number(z) - c.z).toFixed(1)}]` : m));

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block], 60_000);

  async function build(): Promise<void> {
    // the west house: a stepped roof, 7 at the eaves to 10 at the ridge, solid
    const heights = [7, 7, 8, 9, 10, 9, 8, 7, 7];
    for (const [i, h] of heights.entries()) await fill(c.x - 15 + i, F, c.z - 6, c.x - 15 + i, F + h - 1, c.z + 5, 'stone');
    // the tower on it
    await fill(c.x - 8, F, c.z - 2, c.x - 7, F + 24, c.z - 1, 'stone');
    // the small building in the north-west corner
    await fill(c.x - 6, F, c.z - 6, c.x - 2, F + 4, c.z - 3, 'stone');
    await fill(c.x - 5, F + 5, c.z - 5, c.x - 3, F + 6, c.z - 4, 'stone');
    // the east block, 6 high, a part of it 12 high, and the passage inside it: in from the yard, round two corners, to the goal
    await fill(c.x + 8, F, c.z - 4, c.x + 14, F + 5, c.z + 4, 'stone');
    await fill(c.x + 12, F + 6, c.z - 1, c.x + 13, F + 11, c.z, 'stone');
    await fill(c.x + 8, F, c.z + 3, c.x + 13, F + 1, c.z + 3, 'air');
    await fill(c.x + 13, F, c.z - 3, c.x + 13, F + 1, c.z + 3, 'air');
    await fill(c.x + 9, F, c.z - 3, c.x + 13, F + 1, c.z - 3, 'air');
    // the fences: the north and the south sides, and the corners between them and the buildings
    await fill(c.x - 7, F, c.z - 7, c.x + 8, F, c.z - 7, 'oak_fence');
    await fill(c.x + 8, F, c.z - 7, c.x + 8, F, c.z - 5, 'oak_fence');
    await fill(c.x - 7, F, c.z + 8, c.x + 8, F, c.z + 8, 'oak_fence');
    await fill(c.x + 8, F, c.z + 5, c.x + 8, F, c.z + 8, 'oak_fence');
    await fill(c.x - 7, F, c.z + 6, c.x - 7, F, c.z + 8, 'oak_fence');
  }

  async function flyFromPillar(label: string, to: { x: number; y: number; z: number }, walks: boolean): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, pillarTop);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!fly ${to.x} ${to.y} ${to.z}`);
    const first = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from, 60_000);
    expect(first, label).toMatch(/^flying/);
    // the trip's last line: the landing itself, or the walk after it
    const done = (s: string): boolean => (walks ? s.startsWith('walked to ') || s.startsWith('fly: landed, but') || s.startsWith('fly: missed') || s.startsWith('landed (') :s.startsWith('landed') || s.startsWith('fly: '));
    const end = await b.reply((s) => s !== first && done(s), from, 300_000).catch((e: unknown) => `no end (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    const seconds = (Date.now() - t0) / 1000;
    await sleep(800);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    const line = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
    const at = /(?:landed|ended \(\w+\)) at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+), ([\d.]+) from the centre/.exec(line);
    const pos = at ? { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } : undefined;
    const said = b.said.slice(from);
    const landing = [...logs].reverse().find((l) => /flight: (to|retargeted to) [^(]*\(\d+ cells/.test(l));
    const dmg = await b.truth.damageSince(since, b.name);
    const num = (re: RegExp, d = NaN): number => {
      const m = re.exec(line);
      return m ? Number(m[1]) : d;
    };
    const row: Row = {
      label,
      old: OLD,
      kit: CRAFTED_ROCKETS ? 'crafted' : 'plain',
      kitBurn: KIT_BURN,
      end: line.includes('flight: landed') ? 'landed' : (/ended \((\w+)\)/.exec(line)?.[1] ?? 'no end'),
      off: at ? Number(at[4]) : NaN,
      up: pos ? pos.y - F : NaN,
      onFloor: pos !== undefined && inYard(pos) && Math.abs(pos.y - F) < 0.1,
      damage: dmg.total,
      causes: dmg.causes,
      descent: /descent ([^,]+(?:, \d+ out from \d+ above)?)/.exec(line)?.[1] ?? 'none',
      style: /landing (flare|brake)/.exec(line)?.[1] ?? '-',
      rockets: num(/; (\d+) rockets/),
      goArounds: num(/(\d+) go-arounds/),
      ticks: num(/(\d+) ticks, \d+ corrections/),
      seconds,
      cells: Number(/\((\d+) cells/.exec(landing ?? '')?.[1] ?? 0),
      walk: walks ? (said.find((s) => s.startsWith('walked to ') || s.startsWith('fly: landed, but')) ?? end) : '-',
      why: /; (the glide ended .*)$/.exec(line)?.[1] ?? '',
    };
    rows.push(row);
    if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    notes.push(`${label}: ${said.join(' | ')} | ${line} | ${logs.filter((l) => /descent circle|retargeted|landing price|land now|go-around \d|brake landing instead/.test(l)).join(' | ')}`);
    return row;
  }

  function check(runs: Row[], walks: boolean): void {
    if (OLD) return;
    const said = runs.map((r) => `${r.label}: ${r.end} ${r.off.toFixed(1)} off, ${r.up.toFixed(1)} up, damage ${r.damage}${r.why ? ` (${r.why})` : ''}`).join(' | ');
    expect(runs.every((r) => r.end === 'landed'), said).toBe(true);
    expect(runs.every((r) => r.onFloor), said).toBe(true);
    expect(runs.every((r) => r.off <= 2), said).toBe(true);
    expect(runs.map((r) => r.damage)).toEqual(runs.map(() => 0));
    if (walks) expect(runs.every((r) => r.walk.startsWith('walked to ')), runs.map((r) => r.walk).join(' | ')).toBe(true);
  }

  beforeAll(async () => {
    if (OLD) LAND_SWITCH.clear = false;
    await prepareServer();
    bot = await startFlyBot('Yard');
    // (before the track in everything: the nearest safe ground's rules off as well)
    if (OLD) bot.settings.set('flyLandOver', false);
    await teleport(bot, { x: mid.x + 0.5, y: F, z: mid.z + 0.5 });
    await build();
    await teleport(bot, pillarTop);
    await fill(pillar.x - 1, F, pillar.z - 1, pillar.x + 1, F + 69, pillar.z + 1, 'stone');
    await teleport(bot, pillarTop);
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      await bot.command('!stop').catch(() => undefined);
      await teleport(bot, { x: pillar.x + 4.5, y: F, z: pillar.z + 0.5 }).catch(() => undefined);
      await fill(pillar.x - 1, F, pillar.z - 1, pillar.x + 1, F + 69, pillar.z + 1, 'air').catch(() => undefined);
      await teleport(bot, { x: c.x + 0.5, y: F + 30, z: c.z + 0.5 }).catch(() => undefined);
      await fill(c.x - 16, F, c.z - 8, c.x + 15, F + 25, c.z + 9, 'air').catch(() => undefined);
      await bot.stop();
    }
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('flight', 11)}${pad('end', 12)}${pad('off', 7)}${pad('up', 7)}${pad('floor', 7)}${pad('damage', 8)}${pad('style', 7)}${pad('rockets', 9)}${pad('go-ar', 7)}${pad('ticks', 7)}${pad('s', 7)}${pad('cells', 7)}descent`,
      ...rows.map((r) => `${pad(r.label, 11)}${pad(r.end, 12)}${pad(r.off.toFixed(2), 7)}${pad(r.up.toFixed(2), 7)}${pad(r.onFloor ? 'yes' : 'NO', 7)}${pad(r.damage.toFixed(1), 8)}${pad(r.style, 7)}${pad(r.rockets, 9)}${pad(r.goArounds, 7)}${pad(r.ticks, 7)}${pad(r.seconds.toFixed(1), 7)}${pad(r.cells, 7)}${r.descent}${r.walk !== '-' ? `; ${r.walk}` : ''}${r.why ? `; ${r.why}` : ''}`),
    ];
    const said = `[fly-yard e2e] ${OLD ? 'the descent as before Track F11 (FLY_YARD_OLD=1)' : 'the descent as it is'}, ${CRAFTED_ROCKETS ? 'crafted' : 'plain'} rockets${KIT_BURN ? ', flyKitBurn on' : ''}\n  ${table.join('\n  ')}\n  ${notes.map(relative).join('\n  ')}`;
    console.log(said);
    // (FLY_YARD_NOTES=<file>: the table and every flight's lines kept: a passing run prints nothing)
    if (process.env.FLY_YARD_NOTES) appendFileSync(process.env.FLY_YARD_NOTES, `${said}\n`);
  }, 180_000);

  it.skipIf(!want('goal'))(`${RUNS} flights to the goal under the roof: each stands on the yard's floor within 2 of the landing the search chose, 0 damage, and walks in`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`goal #${i + 1}`, goal, true));
    check(runs, true);
  }, 1_800_000);

  it.skipIf(!want('exact'))(`${RUNS} flights to a cell of the yard three blocks from the east block: each stands on it, 0 damage`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`near #${i + 1}`, near, false));
    check(runs, false);
  }, 1_800_000);

  it.skipIf(!want('mid'))(`${RUNS} flights to the cell in the middle of the yard: each stands on it, 0 damage`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`mid #${i + 1}`, mid, false));
    check(runs, false);
  }, 1_800_000);
});
