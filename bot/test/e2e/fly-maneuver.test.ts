// e2e (tag @bds), flight v2 Track F1 (docs/flight.md "Manoeuvres (flight v2, Track F1)", decisions/0057):
// the brake / elevator landings on a fly server (flat, peaceful, fall damage ON, truth pack). One afk-task
// bot flies `!fly x y z` (an exact goal) to truth-built cells 150 blocks from its start in a private area;
// every case flies RUNS times (default 2) and each landing is measured: the damage (truth), the distance
// of the feet from the cell centre (truth), the rockets, the corrections, the ticks, the touchdown speed
// and the landing family flown (the `flight: landed` log line):
//   pillar     a 1 x 1 pillar 8 high (the flare slides off a block-wide top; auto flies the brake)
//   roof3      a cell under a roof 3 above on a 9 x 9 platform 20 up (the roof over its far two thirds)
//   roof4      the same with the roof 4 above
//   shaft2     the floor of a 2 x 2 shaft 10 deep (a hollow tower on the flat ground: the rim 10 up)
//   shaft1     the floor of a 1 x 1 shaft 10 deep
//   wall       a cell on the flat ground with a wall 10 high 6 blocks behind it (flyLandStyle brake)
//   farm       the owner's mob farm replica of fly-overhang.test.ts (a 9 x 7 platform 70 up under an
//              overhanging box): `!goto` the room under it with flyLandStyle brake (lands on the platform
//              under the box, walks down the ladder)
// Every landing must be on its cell with 0 damage. FLY_F1_ONLY=pillar,shaft1 runs only those cases,
// FLY_F1_RUNS=1 one run each (the smoke flight). Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER
// (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const ONLY = new Set((process.env.FLY_F1_ONLY ?? '').split(',').filter(Boolean));
const RUNS = Number(process.env.FLY_F1_RUNS ?? 2);
const want = (c: string): boolean => ONLY.size === 0 || ONLY.has(c);

interface Landing {
  label: string;
  style: string;
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
  brakeTicks: number;
  line: string;
}

/** The numbers of a `flight: landed ...` log line (controller.ts finish). */
function parseLine(line: string | undefined): Omit<Landing, 'label' | 'ok' | 'onCell' | 'off' | 'y' | 'damage' | 'causes' | 'line'> {
  const num = (re: RegExp, d = -1): number => {
    const m = line ? re.exec(line) : null;
    return m ? Number(m[1]) : d;
  };
  const style = line ? (/, landing (flare|brake)/.exec(line)?.[1] ?? '?') : '?';
  return {
    style,
    rockets: num(/; (\d+) rockets/),
    goArounds: num(/, (\d+) go-arounds/),
    corrections: num(/, (\d+) corrections/),
    ticks: num(/, (\d+) ticks/),
    vy: num(/touchdown vy (-?[\d.]+)/, NaN),
    h: num(/touchdown vy -?[\d.]+ h ([\d.]+)/, NaN),
    brakeTicks: num(/\((\d+) ticks braked/, 0),
  };
}

describe.skipIf(!E2E)('@bds fly: brake / elevator landings (flight v2, Track F1)', () => {
  const area = privateArea();
  const rows: Landing[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  const fill = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => truthLoaded(bot!.truth, 'fill', [x1, y1, z1, x2, y2, z2, block]);

  /** Build at `near` (the bot stands there for the chunks), then back home. */
  async function build(near: Vec3, steps: () => Promise<unknown>): Promise<void> {
    await teleport(bot!, near);
    await steps();
    await teleport(bot!, home);
  }

  /** `!fly` (or `command`) to the cell (gx, top, gz) from home and measure the landing; `cells`: the accepted floor cells (default the one). */
  async function land(label: string, g: { x: number; z: number }, top: number, o: { command?: string; cells?: [number, number][]; timeoutMs?: number; walk?: boolean } = {}): Promise<Landing> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    await teleport(b, home);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(o.command ?? `!fly ${g.x} ${top} ${g.z}`);
    const start = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('goto: ') || s.startsWith('elytra worn'), from, 30_000);
    expect(start, label).not.toMatch(/^elytra worn|^goto: (no|cannot|failed)/);
    const end = o.walk
      ? await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('walked to ') || s.startsWith('goto: ') || /walk to .* failed/.test(s), from, o.timeoutMs ?? 240_000)
      : await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, o.timeoutMs ?? 120_000);
    await sleep(800);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ info /, ''));
    const line = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    const g2 = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const p = parseLine(line);
    // where the flight ended (a walk afterwards moves the body): the log line's position for a walk, else the truth position
    const at = o.walk ? (/at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(line ?? '') ?? undefined) : undefined;
    const pos = at ? { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } : g2.location;
    const cells = o.cells ?? [[g.x, g.z]];
    const onCell = cells.some(([cx, cz]) => Math.floor(pos.x) === cx && Math.floor(pos.z) === cz) && Math.abs(pos.y - top) < 0.1;
    const row: Landing = { label, ok: !!line?.includes('flight: landed'), onCell, off: Math.hypot(pos.x - (g.x + 0.5), pos.z - (g.z + 0.5)), y: pos.y, damage: dmg.total, causes: dmg.causes, line: line ?? end, ...p };
    rows.push(row);
    const decisions = logs.filter((l) => /landing for |go-around|brake landing|corridor/.test(l));
    notes.push(`${label}: ${end} | at ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)} | damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${line ?? 'no flight line'} | ${decisions.join(' ; ')}`);
    return row;
  }

  const check = (r: Landing): void => {
    expect(r.ok, r.line).toBe(true);
    expect(r.onCell, `${r.label}: ${r.line}`).toBe(true);
    expect(r.damage, `${r.label}: ${r.causes.join(',')}`).toBe(0);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Brake');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('landing', 16)}${pad('style', 7)}${pad('cell', 6)}${pad('off', 7)}${pad('damage', 8)}${pad('rockets', 9)}${pad('corr', 6)}${pad('ticks', 7)}${pad('K', 5)}${pad('vy', 8)}${pad('h', 7)}go-arounds`,
      ...rows.map((r) => `${pad(r.label, 16)}${pad(r.style, 7)}${pad(r.onCell ? 'yes' : 'NO', 6)}${pad(r.off.toFixed(2), 7)}${pad(r.damage, 8)}${pad(r.rockets, 9)}${pad(r.corrections, 6)}${pad(r.ticks, 7)}${pad(r.brakeTicks, 5)}${pad(Number.isFinite(r.vy) ? r.vy.toFixed(3) : '?', 8)}${pad(Number.isFinite(r.h) ? r.h.toFixed(3) : '?', 7)}${r.goArounds}`),
    ];
    console.log(`[fly-maneuver e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it.skipIf(!want('pillar'))('a 1 x 1 pillar 8 high: the brake landing onto its top, 0 damage', async () => {
    const g = { x: area.x, z: area.z + 150 };
    const top = F + 8;
    await build({ x: g.x + 3.5, y: F, z: g.z + 0.5 }, () => fill(g.x, F, g.z, g.x, top - 1, g.z, 'stone'));
    for (let i = 0; i < RUNS; i++) check(await land(`pillar #${i + 1}`, g, top));
  }, 600_000);

  for (const r of [3, 4]) {
    it.skipIf(!want(`roof${r}`))(`a cell under a roof ${r} above (a platform 20 up): in under the roof, 0 damage`, async () => {
      const g = { x: area.x + 40 + r * 20, z: area.z + 150 };
      const P = F + 20;
      await build({ x: g.x + 0.5, y: P, z: g.z - 3.5 }, async () => {
        await fill(g.x - 4, P - 1, g.z - 4, g.x + 4, P - 1, g.z + 4, 'stone');
        await fill(g.x - 4, P + r, g.z - 2, g.x + 4, P + r, g.z + 4, 'stone');
      });
      for (let i = 0; i < RUNS; i++) check(await land(`roof${r} #${i + 1}`, g, P, { cells: [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => [g.x + dx, g.z + dz] as [number, number])) }));
    }, 600_000);
  }

  for (const w of [2, 1]) {
    it.skipIf(!want(`shaft${w}`))(`the floor of a ${w} x ${w} shaft 10 deep: over the rim, brake, sink straight down, 0 damage`, async () => {
      const g = { x: area.x - 60 - w * 30, z: area.z + 150 };
      const rim = F + 10;
      await build({ x: g.x + 6.5, y: F, z: g.z + 0.5 }, async () => {
        await fill(g.x - 3, F, g.z - 3, g.x + w + 2, rim - 1, g.z + w + 2, 'stone');
        await fill(g.x, F, g.z, g.x + w - 1, rim - 1, g.z + w - 1, 'air');
      });
      const cells = [...Array(w).keys()].flatMap((dx) => [...Array(w).keys()].map((dz) => [g.x + dx, g.z + dz] as [number, number]));
      for (let i = 0; i < RUNS; i++) check(await land(`shaft${w} #${i + 1}`, g, F, { cells }));
    }, 600_000);
  }

  it.skipIf(!want('wall'))('a cell with a wall 6 blocks behind it (flyLandStyle brake): stops short of the wall, 0 damage', async () => {
    const g = { x: area.x + 140, z: area.z + 150 };
    await build({ x: g.x + 0.5, y: F, z: g.z + 3.5 }, () => fill(g.x - 4, F, g.z + 6, g.x + 4, F + 9, g.z + 6, 'stone'));
    bot!.settings.set('flyLandStyle', 'brake');
    try {
      for (let i = 0; i < RUNS; i++) check(await land(`wall #${i + 1}`, g, F, { cells: [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dz) => [g.x + dx, g.z + dz] as [number, number])) }));
    } finally {
      bot!.settings.set('flyLandStyle', 'auto');
    }
  }, 600_000);

  it.skipIf(!want('farm'))('the mob farm (flyLandStyle brake): lands on the platform under the overhanging box, 0 damage', async () => {
    const b = bot!;
    const cx = area.x + 120;
    const cz = area.z + 300;
    const Y = F + 70;
    const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string) => fill(cx + x1, y1, cz + z1, cx + x2, y2, cz + z2, block);
    await build({ x: cx + 8.5, y: F, z: cz + 0.5 }, async () => {
      await f(-3, Y - 5, -3, 3, Y - 2, 3, 'stone');
      await f(-2, Y - 4, -2, 2, Y - 2, 2, 'air');
      await f(-4, Y - 1, -3, 4, Y - 1, 3, 'stone');
      await f(2, Y - 1, 0, 2, Y - 1, 0, 'air');
      for (let y = Y - 4; y <= Y - 1; y++) await truthLoaded(b.truth, 'setblock', [cx + 2, y, cz, 'ladder', 'facing_direction=4']);
      await f(-4, Y, -2, -1, Y + 11, 1, 'stone');
      await f(-3, Y, -1, -2, Y + 11, 0, 'air');
      await f(-26, Y + 12, -15, 5, Y + 23, 14, 'stone');
      await f(-25, Y + 13, -14, 4, Y + 22, 13, 'air');
    });
    // the platform cells (outside the shaft and the hole): any of them is the landing; the walk goes on down the ladder
    const platform: [number, number][] = [];
    for (let dx = -4; dx <= 4; dx++) for (let dz = -3; dz <= 3; dz++) if (!(dx >= -4 && dx <= -1 && dz >= -2 && dz <= 1) && !(dx === 2 && dz === 0)) platform.push([cx + dx, cz + dz]);
    b.settings.set('flyLandStyle', 'brake');
    try {
      for (let i = 0; i < RUNS; i++) {
        const r = await land(`farm #${i + 1}`, { x: cx + 3, z: cz }, Y, { command: `!goto ${cx} ${Y - 4} ${cz}`, cells: platform, walk: true, timeoutMs: 300_000 });
        expect(r.ok, r.line).toBe(true);
        expect(r.onCell, `${r.label}: ${r.line}`).toBe(true);
        expect(r.damage, r.causes.join(',')).toBe(0);
      }
    } finally {
      b.settings.set('flyLandStyle', 'auto');
    }
  }, 900_000);
});
