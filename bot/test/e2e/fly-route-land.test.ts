// e2e (tag @bds), flight v2 Track F3 (docs/flight.md "Route landings and takeoffs (Track F3)", decisions/0064):
// the route landings and takeoffs on bds-fly3 (udp/19212, FLAT, peaceful, fall damage ON, truth pack). One
// afk-task bot flies `!fly x y z` (an exact goal) from its start to truth-built cells 150 blocks out that the
// flare and the brake families refuse or fly badly, RUNS times each (default 2), then `!fly` back to the start
// from inside the cell (the takeoff out). Measured per landing: the damage (truth), the feet from the cell
// centre (truth), on the cells or not, the rockets, the corrections, the ticks, the landing flown (the
// `flight: landed` log line: `landing route (...)` or the family); per takeoff: the damage and the landing near
// the start.
//   stack2    the owner's case: a 3 x 3 platform 20 up and another 3 x 3 directly over it 3 higher (2 blocks of
//             air over the inner floor); the landing on the inner platform
//   stack3    the same with 3 blocks of air
//   hole1     a 1 x 1 hole 2 deep in the ground
//   hole2     a 2 x 1 hole 2 deep
//   shaft1    the floor of a 1 x 1 shaft 10 deep (Track F1's case: the brake family lands it first)
//   room3     a cell under a roof 3 above at ground level (a room open on one side; the F1 open point)
//   pocket    a 3 x 3 x 3 pocket in a cliff face 30 high, 10 up
// FLY_F3_ONLY=stack2,hole1 runs only those cases, FLY_F3_RUNS=1 one run each, FLY_F3_TAKEOFF=0 skips the
// takeoffs. Env: FLY_BDS_HOST / FLY_BDS_PORT (19212) / FLY_BDS_CONTAINER (bds-fly3) (fly-truth.ts), FLY_AREA,
// FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ONLY = new Set((process.env.FLY_F3_ONLY ?? '').split(',').filter(Boolean));
const RUNS = Number(process.env.FLY_F3_RUNS ?? 2);
const TAKEOFF = process.env.FLY_F3_TAKEOFF !== '0';
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Row {
  label: string;
  how: string;
  ok: boolean;
  onCell: boolean;
  off: number;
  y: number;
  damage: number;
  causes: string[];
  rockets: number;
  goArounds: number;
  corrections: number;
  ticks: number;
  vy: number;
  h: number;
  routeTicks: number;
  line: string;
}

/** The numbers of a `flight: landed ...` log line (controller.ts finish). */
function parseLine(line: string | undefined): Pick<Row, 'how' | 'rockets' | 'goArounds' | 'corrections' | 'ticks' | 'vy' | 'h' | 'routeTicks'> {
  const num = (re: RegExp, d = -1): number => {
    const m = line ? re.exec(line) : null;
    return m ? Number(m[1]) : d;
  };
  const route = line ? /landing route \((\d+) ticks/.exec(line) : null;
  const how = route ? 'route' : line ? (/, landing (flare|brake)/.exec(line)?.[1] ?? '?') : '?';
  return {
    how,
    rockets: num(/; (\d+) rockets/),
    goArounds: num(/, (\d+) go-arounds/),
    corrections: num(/, (\d+) corrections/),
    ticks: num(/, (\d+) ticks/),
    vy: num(/touchdown vy (-?[\d.]+)/, NaN),
    h: num(/touchdown vy -?[\d.]+ h ([\d.]+)/, NaN),
    routeTicks: route ? Number(route[1]) : 0,
  };
}

describe.skipIf(!E2E)('@bds fly: route landings and takeoffs (flight v2, Track F3)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block], 60_000);

  /** Build at `near` (the bot stands there for the chunks), then back home. */
  async function build(near: Vec3, steps: () => Promise<unknown>): Promise<void> {
    await teleport(bot!, near);
    await steps();
    await bot!.built.mobility!.loop.waitTicks(10);
    await teleport(bot!, home);
  }

  /** `!fly x y z` from home (or `from`) and measure the landing; `cells`: the accepted floor cells. */
  async function land(label: string, g: { x: number; z: number }, top: number, o: { cells?: [number, number][]; from?: Vec3; timeoutMs?: number; half?: number } = {}): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    if (o.from) await teleport(b, o.from);
    else {
      await teleport(b, home);
      await giveFlightKit(b, { rockets: 64 });
    }
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!fly ${g.x} ${top} ${g.z}`);
    const start = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from, 60_000);
    expect(start, label).not.toMatch(/^elytra worn/);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, o.timeoutMs ?? 150_000);
    await sleep(1000);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ info /, '').replace(/^\S+ warn /, ''));
    const line = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    const g2 = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const p = parseLine(line);
    const pos = g2.location;
    const cells = o.cells ?? [[g.x, g.z]];
    const onCell = cells.some(([cx, cz]) => Math.floor(pos.x) === cx && Math.floor(pos.z) === cz) && Math.abs(pos.y - top) < (o.half !== undefined ? 1.2 : 0.1);
    const row: Row = { label, ok: !!line?.includes('flight: landed'), onCell, off: Math.hypot(pos.x - (g.x + 0.5), pos.z - (g.z + 0.5)), y: pos.y, damage: dmg.total, causes: dmg.causes, line: line ?? end, ...p };
    rows.push(row);
    const decisions = logs.filter((l) => /landing for |go-around|brake landing|route|takeoff/.test(l)).map((l) => l.slice(0, 400));
    notes.push(`${label}: ${start} -> ${end} | at ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${line ?? 'no flight line'} | ${decisions.join(' ; ')}`);
    return row;
  }

  const check = (r: Row): void => {
    expect(r.ok, `${r.label}: ${r.line}`).toBe(true);
    expect(r.onCell, `${r.label}: ${r.line}`).toBe(true);
    expect(r.damage, `${r.label}: ${r.causes.join(',')}`).toBe(0);
  };

  /** The takeoff out: `!fly` back to a cell near home from where the bot stands; the landing near it with 0 damage. */
  async function out(label: string, from: Vec3): Promise<void> {
    if (!TAKEOFF) return;
    const r = await land(`${label} out`, { x: Math.floor(home.x) + 4, z: Math.floor(home.z) }, F, { from, cells: [-2, -1, 0, 1, 2].flatMap((dx) => [-2, -1, 0, 1, 2].map((dz) => [Math.floor(home.x) + 4 + dx, Math.floor(home.z) + dz] as [number, number])), half: 2, timeoutMs: 180_000 });
    expect(r.ok, `${r.label}: ${r.line}`).toBe(true);
    expect(r.damage, `${r.label}: ${r.causes.join(',')}`).toBe(0);
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Rl');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('landing', 16)}${pad('how', 7)}${pad('cell', 6)}${pad('off', 7)}${pad('damage', 8)}${pad('rockets', 9)}${pad('corr', 6)}${pad('ticks', 7)}${pad('route', 7)}${pad('vy', 8)}${pad('h', 7)}go-arounds`,
      ...rows.map((r) => `${pad(r.label, 16)}${pad(r.how, 7)}${pad(r.onCell ? 'yes' : 'NO', 6)}${pad(r.off.toFixed(2), 7)}${pad(r.damage, 8)}${pad(r.rockets, 9)}${pad(r.corrections, 6)}${pad(r.ticks, 7)}${pad(r.routeTicks, 7)}${pad(Number.isFinite(r.vy) ? r.vy.toFixed(3) : '?', 8)}${pad(Number.isFinite(r.h) ? r.h.toFixed(3) : '?', 7)}${r.goArounds}`),
    ];
    console.log(`[fly-route-land e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  const nine = (g: { x: number; z: number }): [number, number][] => [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => [g.x + dx, g.z + dz] as [number, number]));

  for (const gap of [2, 3]) {
    it.skipIf(!want(`stack${gap}`))(`the stacked platforms with ${gap} of air: the route landing on the inner platform, 0 damage; then the takeoff out`, async () => {
      const g = { x: area.x + (gap - 2) * 40, z: area.z + 150 };
      const top = F + 21;
      await build({ x: g.x + 0.5, y: top, z: g.z + 0.5 }, async () => {
        await fill(g.x - 1, top - 1, g.z - 1, g.x + 1, top - 1, g.z + 1, 'stone');
        await fill(g.x - 1, top + gap, g.z - 1, g.x + 1, top + gap, g.z + 1, 'stone');
      });
      for (let i = 0; i < RUNS; i++) {
        const r = await land(`stack${gap} #${i + 1}`, g, top, { cells: nine(g) });
        check(r);
        if (i === RUNS - 1) await out(`stack${gap}`, { x: g.x + 0.5, y: top, z: g.z + 0.5 });
      }
    }, 900_000);
  }

  for (const w of [1, 2]) {
    it.skipIf(!want(`hole${w}`))(`a ${w} x 1 hole 2 deep in the ground: the landing on its floor, 0 damage; then the takeoff out`, async () => {
      const g = { x: area.x - 60 - w * 30, z: area.z + 150 };
      await build({ x: g.x + 3.5, y: F, z: g.z + 0.5 }, () => fill(g.x, F - 2, g.z, g.x + w - 1, F - 1, g.z, 'air'));
      const cells = [...Array(w).keys()].map((dx) => [g.x + dx, g.z] as [number, number]);
      for (let i = 0; i < RUNS; i++) {
        const r = await land(`hole${w} #${i + 1}`, g, F - 2, { cells });
        check(r);
        if (i === RUNS - 1) await out(`hole${w}`, { x: g.x + 0.5, y: F - 2, z: g.z + 0.5 });
      }
    }, 900_000);
  }

  it.skipIf(!want('shaft1'))('the floor of a 1 x 1 shaft 10 deep: the brake family first, 0 damage; then the takeoff out (the vertical takeoff)', async () => {
    const g = { x: area.x + 140, z: area.z + 150 };
    const rim = F + 10;
    await build({ x: g.x + 6.5, y: F, z: g.z + 0.5 }, async () => {
      await fill(g.x - 3, F, g.z - 3, g.x + 3, rim - 1, g.z + 3, 'stone');
      await fill(g.x, F, g.z, g.x, rim - 1, g.z, 'air');
    });
    for (let i = 0; i < RUNS; i++) {
      const r = await land(`shaft1 #${i + 1}`, g, F);
      check(r);
      if (i === RUNS - 1) await out('shaft1', { x: g.x + 0.5, y: F, z: g.z + 0.5 });
    }
  }, 900_000);

  it.skipIf(!want('room3'))('a cell under a roof 3 above at ground level (a room open towards the start): the route landing, 0 damage; then the takeoff out', async () => {
    const g = { x: area.x + 200, z: area.z + 150 };
    await build({ x: g.x + 0.5, y: F, z: g.z - 6.5 }, async () => {
      await fill(g.x - 3, F, g.z - 3, g.x + 3, F + 3, g.z + 3, 'stone');
      await fill(g.x - 2, F, g.z - 3, g.x + 2, F + 2, g.z + 2, 'air');
    });
    const cells: [number, number][] = [-2, -1, 0, 1, 2].flatMap((dx) => [-2, -1, 0, 1, 2].map((dz) => [g.x + dx, g.z + dz] as [number, number]));
    for (let i = 0; i < RUNS; i++) {
      const r = await land(`room3 #${i + 1}`, g, F, { cells });
      check(r);
      if (i === RUNS - 1) await out('room3', { x: g.x + 0.5, y: F, z: g.z + 0.5 });
    }
  }, 900_000);

  it.skipIf(!want('pocket'))('a 3 x 3 x 3 pocket in a cliff face 30 high, 10 up: the route landing, 0 damage', async () => {
    const cx = area.x - 200;
    const cz = area.z + 180;
    const top = F + 10;
    const g = { x: cx, z: cz + 1 };
    await build({ x: cx + 0.5, y: F, z: cz - 6.5 }, async () => {
      for (let z = cz; z <= cz + 12; z += 4) await fill(cx - 20, F, z, cx + 20, F + 29, Math.min(cz + 12, z + 3), 'stone');
      await fill(cx - 1, top, cz, cx + 1, top + 2, cz + 2, 'air');
    });
    const cells: [number, number][] = [-1, 0, 1].flatMap((dx) => [0, 1, 2].map((dz) => [cx + dx, cz + dz] as [number, number]));
    for (let i = 0; i < RUNS; i++) check(await land(`pocket #${i + 1}`, g, top, { cells }));
  }, 900_000);
});
