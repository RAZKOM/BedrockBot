// e2e (tag @bds), wave 11 Track AU2 (docs/flight.md "Descent geometry"): the descent from high over the
// target, chosen by the columns around it; on bds-fly (flat, peaceful, fall damage ON, truth pack). One
// afk-task bot (walking, the CLI's wiring) with the flight kit; truth-built platforms in a private area;
// every flight starts on a 3 x 3 pillar 60 blocks above the platform level, 100 blocks away (the descending
// approach of fly-land):
//   open     a 3 x 3 platform 40 up in the open, 10 landings: a circle around the platform (`spiral r24 at 0
//            out`), every landing on the platform, 0 damage
//   walled   the same platform with 20-high walls 10 blocks away on three sides, 10 landings: no circle fits
//            around it (a circle farther out on the approach line, or S-turns), every landing on the
//            platform, 0 damage
// The table is printed. Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { buildPlatform, E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, removePlatform, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_DESCENT_RUNS ?? 10);

interface Row {
  label: string;
  reply: string;
  off: number;
  y: number;
  onPlatform: boolean;
  damage: number;
  causes: string[];
  rockets: number;
  goArounds: number;
  seconds: number;
  descent: string;
}

describe.skipIf(!E2E)('@bds fly: the descent geometry (Track AU2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const rows: Row[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const c = { x: area.x, z: area.z + 100 };
  const top = F + 40;
  const pillar = { x: area.x, z: area.z };
  const pillarTop: Vec3 = { x: pillar.x + 0.5, y: top + 60, z: pillar.z + 0.5 };

  const parse = (reply: string): { rockets: number; goArounds: number; seconds: number } => {
    const m = /(\d+) rockets?, (\d+) go-arounds?, (\d+) s/.exec(reply);
    return { rockets: m ? Number(m[1]) : -1, goArounds: m ? Number(m[2]) : -1, seconds: m ? Number(m[3]) : -1 };
  };

  async function flyFromPillar(label: string): Promise<Row> {
    const b = bot!;
    await teleport(b, pillarTop);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const from = b.said.length;
    const n0 = b.logs.length;
    await b.command(`!fly ${c.x} ${top} ${c.z}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from);
    expect(start, label).toMatch(/^flying to /);
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 120_000);
    await sleep(600);
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const log = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
    const descent = /descent ([^,]+(?:, \d+ out from \d+ above)?)/.exec(log)?.[1] ?? 'none';
    const off = Math.hypot(g.location.x - (c.x + 0.5), g.location.z - (c.z + 0.5));
    const onPlatform = Math.abs(g.location.x - (c.x + 0.5)) <= 1.3 && Math.abs(g.location.z - (c.z + 0.5)) <= 1.3 && Math.abs(g.location.y - top) < 1.5 && g.isOnGround;
    const row: Row = { label, reply: end, off, y: g.location.y, onPlatform, damage: dmg.total, causes: dmg.causes, descent, ...parse(end) };
    rows.push(row);
    notes.push(`${label}: ${end} | truth ${g.location.x.toFixed(2)} ${g.location.y.toFixed(2)} ${g.location.z.toFixed(2)} off ${off.toFixed(2)} onPlatform ${onPlatform} damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${log}`);
    return row;
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Desc');
    await teleport(bot, home);
    await buildPlatform(bot, c, top, 1, home);
    // the start pillar: 3 x 3, its top 60 above the platform level
    await teleport(bot, pillarTop);
    await truthLoaded(bot.truth, 'fill', [pillar.x - 1, F, pillar.z - 1, pillar.x + 1, top + 59, pillar.z + 1, 'stone']);
    await teleport(bot, pillarTop);
  }, 240_000);

  afterAll(async () => {
    if (bot) {
      await teleport(bot, { x: pillar.x + 4.5, y: F, z: pillar.z + 0.5 }).catch(() => undefined);
      await truthLoaded(bot.truth, 'fill', [pillar.x - 1, F, pillar.z - 1, pillar.x + 1, top + 59, pillar.z + 1, 'air']).catch(() => undefined);
      await removePlatform(bot, c, top, 1).catch(() => undefined);
      await bot.stop();
    }
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('landing', 12)}${pad('off', 7)}${pad('y', 8)}${pad('on', 6)}${pad('damage', 8)}${pad('rockets', 9)}${pad('go-arounds', 12)}${pad('s', 5)}descent`,
      ...rows.map((r) => `${pad(r.label, 12)}${pad(r.off.toFixed(2), 7)}${pad(r.y.toFixed(2), 8)}${pad(r.onPlatform ? 'yes' : 'NO', 6)}${pad(r.damage, 8)}${pad(r.rockets, 9)}${pad(r.goArounds, 12)}${pad(r.seconds, 5)}${r.descent}`),
    ];
    console.log(`[fly-descent e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it(`${RUNS} landings from 60 above on the 3x3 platform in the open: a circle around the platform, all on it, 0 damage`, async () => {
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`open #${i + 1}`));
    expect(runs.every((r) => r.onPlatform), runs.map((r) => `${r.label}: ${r.reply}`).join(' | ')).toBe(true);
    expect(runs.map((r) => r.damage)).toEqual(runs.map(() => 0));
    // Track BL: flyDescent auto dives where the simulated dive is clear (the open platform), else the circle around it
    expect(runs.filter((r) => /^spiral r\d+ at 0 out/.test(r.descent) || r.descent.startsWith('dive ')).length).toBeGreaterThanOrEqual(RUNS - 1);
  }, 900_000);

  it(`${RUNS} landings with 20-high walls 10 blocks out on three sides: no circle around the platform, all on it, 0 damage`, async () => {
    const b = bot!;
    // the walls: left, right and far, from the platform level up 20, 21 long
    await teleport(b, { x: c.x + 0.5, y: top, z: c.z + 0.5 });
    await truthLoaded(b.truth, 'fill', [c.x - 10, top - 1, c.z - 10, c.x - 10, top + 18, c.z + 10, 'stone']);
    await truthLoaded(b.truth, 'fill', [c.x + 10, top - 1, c.z - 10, c.x + 10, top + 18, c.z + 10, 'stone']);
    await truthLoaded(b.truth, 'fill', [c.x - 10, top - 1, c.z + 10, c.x + 10, top + 18, c.z + 10, 'stone']);
    const runs: Row[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await flyFromPillar(`walled #${i + 1}`));
    await teleport(b, { x: c.x + 0.5, y: top, z: c.z + 0.5 });
    await truthLoaded(b.truth, 'fill', [c.x - 10, top - 1, c.z - 10, c.x - 10, top + 18, c.z + 10, 'air']);
    await truthLoaded(b.truth, 'fill', [c.x + 10, top - 1, c.z - 10, c.x + 10, top + 18, c.z + 10, 'air']);
    await truthLoaded(b.truth, 'fill', [c.x - 10, top - 1, c.z + 10, c.x + 10, top + 18, c.z + 10, 'air']);
    expect(runs.every((r) => r.onPlatform), runs.map((r) => `${r.label}: ${r.reply}`).join(' | ')).toBe(true);
    expect(runs.map((r) => r.damage)).toEqual(runs.map(() => 0));
    expect(runs.every((r) => !r.descent.includes("at 0 out")), runs.map((r) => r.descent).join(' | ')).toBe(true);
  }, 900_000);
});
