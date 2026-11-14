// e2e (tag @bds), flight v2 Track F14 (docs/flight.md "The way down to the landing", decisions/0085): a goal under a
// hill whose cave has a cavern with 22 blocks of room, and a landing at the foot of that hill; on bds-fly (udp/19204,
// FLAT, peaceful, fall damage ON, truth pack). One afk-task bot with the flight kit; a truth-built hill in a private area:
//
//   the hill    a stepped hill 62 high, 63 x 63 at its foot (a step of 2 up for every block in: a slope of 2), solid
//   the cave    in its heart at ground level: the goal's room (3 x 3 x 3), a doorway, a cavern 8 x 7 with its roof 22
//               over the floor (the floor of the fault: `open` to a search that takes 20 blocks of room for the sky), and
//               from the cavern a tunnel 3 wide and 2 high out to the hill's east foot, 32 blocks from the goal
//
// Two kinds of trip, both arriving over the hill:
//   goal        `!goto` the goal from the flat ground 250 blocks east of the hill's middle (as `!test goto` on the Realm:
//               the landing is the search's own, with its probes and simulations), then the walk in. With `flyWayDown` on
//               (the default of this suite) the landing lies under the sky by the tunnel's mouth; asserted per trip:
//               `flight: landed`, standing on the ground within 2 blocks of the landing's centre, east of the hill's
//               foot, 0 damage, and `arrived at`
//   mouth       `!fly` from a 3 x 3 pillar 70 high, 150 blocks east, to the cell two blocks before the mouth (an exact
//               landing): the hill rises 24 over it within 14 blocks, so it is flown in over that and straight down (the
//               landing's rim): `flight: landed` within 2 of it, 0 damage, and the line `way down: what stands within 14
//               blocks of the landing reaches N over its floor`
// The table is printed; FLY_FLANK_OUT=<file> appends every row as a JSON line, FLY_FLANK_NOTES=<file> the table and lines.
// FLY_FLANK_OLD=1: `flyWayDown` off, the trip as it was before the track (the landing a floor of the cavern, the flight
// down on the hill or beside it, the walk round into the tunnel), measured and printed, nothing asserted.
// FLY_FLANK_RUNS=5 the runs a case (default 5), FLY_FLANK_ONLY=goal,mouth picks cases, FLY_FLANK_SETTLE=8000 the ms a flight
// waits on the pillar before it is asked (the area's chunks). FLY_ROCKETS=crafted, FLY_KIT_BURN=1
// as in fly-truth.ts. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { CRAFTED_ROCKETS, E2E, FEET_Y, giveFlightKit, KIT_BURN, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_FLANK_RUNS ?? 5);
const ONLY = new Set((process.env.FLY_FLANK_ONLY ?? '').split(',').filter(Boolean));
const OUT = process.env.FLY_FLANK_OUT;
const OLD = process.env.FLY_FLANK_OLD === '1';
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);
const SETTLE_MS = Number(process.env.FLY_FLANK_SETTLE ?? 8000);
/** The hill: half its foot's width, and the steps (2 high each). */
const HALF = 31;
const STEPS = 31;

interface Row {
  label: string;
  old: boolean;
  kit: 'plain' | 'crafted';
  kitBurn: boolean;
  /** `landed`, or the reason the flight ended with. */
  end: string;
  /** The flight's own end: blocks from the landing's centre, the height over the ground, blocks east of the hill's middle. */
  off: number;
  up: number;
  east: number;
  /** The landing the flight had at its end: its cell as offsets from the hill's middle, and whether the sky is over it (east of the foot). */
  site: string;
  siteSky: boolean;
  damage: number;
  causes: string[];
  descent: string;
  style: string;
  rockets: number;
  goArounds: number;
  priced: number;
  rim: string;
  ticks: number;
  seconds: number;
  walk: string;
  why: string;
}

describe.skipIf(!E2E)('@bds fly: a goal under a hill, a landing at its foot (flight v2, Track F14)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const c = { x: area.x, z: area.z };
  const goal = { x: c.x, y: F, z: c.z };
  const mouth = { x: c.x + HALF + 3, y: F, z: c.z };
  const pillar = { x: c.x + 150, z: c.z };
  const pillarTop: Vec3 = { x: pillar.x + 0.5, y: F + 70, z: pillar.z + 0.5 };
  /** The goto's start: on the flat ground, farther than `flyMin` (200) from the goal. */
  const groundStart: Vec3 = { x: c.x + 250.5, y: F, z: c.z + 0.5 };
  /** A line's positions as offsets from the hill's middle (the area is random: two runs read the same). */
  const relative = (s: string): string => s.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?=[ ,;:)|]|$)/g, (m, x: string, y: string, z: string) => (Math.abs(Number(x) - c.x) < 400 && Math.abs(Number(z) - c.z) < 400 ? `[${(Number(x) - c.x).toFixed(1)} ${(Number(y) - F).toFixed(1)} ${(Number(z) - c.z).toFixed(1)}]` : m));

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block], 60_000);

  async function build(): Promise<void> {
    for (let k = 0; k < STEPS; k++) await fill(c.x - HALF + k, F + 2 * k, c.z - HALF + k, c.x + HALF - k, F + 2 * k + 1, c.z + HALF - k, 'stone');
    // the goal's room, the doorway, the cavern (22 of room), the tunnel out to the east foot
    await fill(c.x - 1, F, c.z - 1, c.x + 1, F + 2, c.z + 1, 'air');
    await fill(c.x + 2, F, c.z, c.x + 2, F + 1, c.z, 'air');
    await fill(c.x + 3, F, c.z - 3, c.x + 10, F + 21, c.z + 3, 'air');
    await fill(c.x + 11, F, c.z - 1, c.x + HALF, F + 1, c.z + 1, 'air');
  }

  async function flyFromPillar(label: string, to: { x: number; y: number; z: number }, walks: boolean): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, walks ? groundStart : pillarTop);
    await giveFlightKit(b, { rockets: 64 });
    // (a moment for the chunks round the start after the teleport, before the trip is asked)
    await sleep(SETTLE_MS);
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`${walks ? '!goto' : '!fly'} ${to.x} ${to.y} ${to.z}`);
    // (a goto that finds a roof over its start walks out from under it first and says so: not the trip's answer)
    const first = await b.reply((s) => s.startsWith('flying') || (s.startsWith('fly: ') && !s.startsWith('fly: no open sky')) || s.startsWith('goto: ') || s.startsWith('elytra worn'), from, 120_000);
    expect(first, label).toMatch(/^flying/);
    // the trip's last line: `arrived at` (or the goto's refusal) for a goto, the landing itself for an exact `!fly`
    const done = (s: string): boolean => (walks ? s.startsWith('arrived at ') || s.startsWith('goto: ') : s.startsWith('landed') || s.startsWith('fly: '));
    const end = await b.reply((s) => s !== first && done(s), from, 600_000).catch((e: unknown) => `no end (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    const seconds = (Date.now() - t0) / 1000;
    await sleep(800);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn) /, ''));
    const line = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
    const at = /(?:landed|ended \(\w+\)) at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+), ([\d.]+) from the centre/.exec(line);
    const pos = at ? { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } : undefined;
    const said = b.said.slice(from);
    // the landing the flight had at its end: the last `to` / `retargeted to` with a place
    const landing = [...logs].reverse().find((l) => /flight: (to|retargeted to) -?[\d.]+ -?\d+ -?[\d.]+ \((?!hold)/.test(l)) ?? '';
    const cell = /(?:to|retargeted to) (-?[\d.]+) (-?\d+) (-?[\d.]+)/.exec(landing);
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
      east: pos ? pos.x - c.x : NaN,
      site: cell ? `${(Number(cell[1]) - c.x).toFixed(0)} ${Number(cell[2]) - F} ${(Number(cell[3]) - c.z).toFixed(0)}` : '-',
      siteSky: cell !== null && Math.max(Math.abs(Number(cell[1]) - c.x), Math.abs(Number(cell[3]) - c.z)) > HALF + 0.9,
      damage: dmg.total,
      causes: dmg.causes,
      descent: /descent ([^,]+(?:, \d+ out from \d+ above)?)/.exec(line)?.[1] ?? 'none',
      style: /landing (flare|brake)/.exec(line)?.[1] ?? '-',
      rockets: num(/; (\d+) rockets/),
      goArounds: num(/(\d+) go-arounds/),
      priced: logs.filter((l) => l.includes('flight: landing price:')).length,
      rim: /way down: (?:[^:]*: )?what stands within (\d+) blocks of the landing reaches (\d+) over its floor/.exec(logs.find((l) => l.includes('flight: way down:')) ?? '')?.slice(1, 3).join('/') ?? '-',
      ticks: num(/(\d+) ticks, \d+ corrections/),
      seconds,
      walk: walks ? end : '-',
      why: /; (the (?:glide ended|landing lies) .*)$/.exec(line)?.[1] ?? '',
    };
    rows.push(row);
    if (OUT) appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    notes.push(`${label}: ${said.join(' | ')} | ${line} | ${logs.filter((l) => /fly: landing for|descent circle|retargeted|landing price|land now|go-around \d|brake landing instead|way down|holding over/.test(l)).join(' | ')}`);
    return row;
  }

  function check(runs: Row[], walks: boolean): void {
    if (OLD) return;
    const said = runs.map((r) => `${r.label}: ${r.end} ${r.off.toFixed(1)} off, ${r.up.toFixed(1)} up, site ${r.site}, damage ${r.damage}${r.why ? ` (${r.why})` : ''}`).join(' | ');
    expect(runs.every((r) => r.end === 'landed'), said).toBe(true);
    expect(runs.every((r) => Math.abs(r.up) < 0.1), said).toBe(true);
    expect(runs.every((r) => r.off <= 2), said).toBe(true);
    expect(runs.every((r) => r.siteSky && r.east > HALF + 0.9), said).toBe(true);
    expect(runs.map((r) => r.damage)).toEqual(runs.map(() => 0));
    if (walks) expect(runs.every((r) => r.walk.startsWith('arrived at ')), runs.map((r) => r.walk).join(' | ')).toBe(true);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Flank');
    bot.settings.set('flyWayDown', !OLD);
    await teleport(bot, { x: mouth.x + 4.5, y: F, z: mouth.z + 0.5 });
    await build();
    // the goto's start: nothing over it (the area's cell may hold what an earlier suite left)
    await teleport(bot, { x: groundStart.x, y: F + 30, z: groundStart.z });
    await fill(Math.floor(groundStart.x) - 6, F, Math.floor(groundStart.z) - 6, Math.floor(groundStart.x) + 6, F + 24, Math.floor(groundStart.z) + 6, 'air');
    await teleport(bot, pillarTop);
    await fill(pillar.x - 1, F, pillar.z - 1, pillar.x + 1, F + 69, pillar.z + 1, 'stone');
    await teleport(bot, pillarTop);
  }, 600_000);

  afterAll(async () => {
    if (bot) {
      await bot.command('!stop').catch(() => undefined);
      await teleport(bot, { x: pillar.x + 4.5, y: F, z: pillar.z + 0.5 }).catch(() => undefined);
      await fill(pillar.x - 1, F, pillar.z - 1, pillar.x + 1, F + 69, pillar.z + 1, 'air').catch(() => undefined);
      await teleport(bot, { x: mouth.x + 4.5, y: F, z: mouth.z + 0.5 }).catch(() => undefined);
      for (let k = 0; k < STEPS; k++) await fill(c.x - HALF + k, F + 2 * k, c.z - HALF + k, c.x + HALF - k, F + 2 * k + 1, c.z + HALF - k, 'air').catch(() => undefined);
      await bot.stop();
    }
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('flight', 11)}${pad('end', 12)}${pad('off', 7)}${pad('up', 7)}${pad('east', 7)}${pad('site', 12)}${pad('sky', 5)}${pad('damage', 8)}${pad('style', 7)}${pad('rockets', 9)}${pad('go-ar', 7)}${pad('priced', 8)}${pad('rim', 7)}${pad('ticks', 7)}${pad('s', 7)}descent`,
      ...rows.map((r) => `${pad(r.label, 11)}${pad(r.end, 12)}${pad(r.off.toFixed(2), 7)}${pad(r.up.toFixed(2), 7)}${pad(r.east.toFixed(1), 7)}${pad(r.site, 12)}${pad(r.siteSky ? 'yes' : 'NO', 5)}${pad(r.damage.toFixed(1), 8)}${pad(r.style, 7)}${pad(r.rockets, 9)}${pad(r.goArounds, 7)}${pad(r.priced, 8)}${pad(r.rim, 7)}${pad(r.ticks, 7)}${pad(r.seconds.toFixed(1), 7)}${r.descent}${r.walk !== '-' ? `; ${r.walk}` : ''}${r.why ? `; ${r.why}` : ''}`),
    ];
    const said = `[fly-flank e2e] ${OLD ? 'flyWayDown off: as before Track F14 (FLY_FLANK_OLD=1)' : 'flyWayDown on'}, ${CRAFTED_ROCKETS ? 'crafted' : 'plain'} rockets${KIT_BURN ? ', flyKitBurn on' : ''}\n  ${table.join('\n  ')}\n  ${notes.map(relative).join('\n  ')}`;
    console.log(said);
    if (process.env.FLY_FLANK_NOTES) appendFileSync(process.env.FLY_FLANK_NOTES, `${said}\n`);
  }, 600_000);

  it.skipIf(!want('goal'))(`${RUNS} trips to the goal under the hill: each flight stands on the ground by the tunnel's mouth within 2 of the landing the search chose, 0 damage, and the walk arrives`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`goal #${i + 1}`, goal, true));
    check(runs, true);
  }, 3_600_000);

  it.skipIf(!want('mouth'))(`${RUNS} flights to the cell before the mouth, the hill 24 over it within 14 blocks: each is flown in over that and stands on it, 0 damage`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`mouth #${i + 1}`, mouth, false));
    check(runs, false);
    if (!OLD) expect(runs.every((r) => r.rim !== '-' && r.style === 'brake'), runs.map((r) => `${r.rim} ${r.style}`).join(' | ')).toBe(true);
  }, 3_600_000);
});
