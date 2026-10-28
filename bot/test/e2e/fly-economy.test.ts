// e2e (tag @bds), wave 11 Track AU2 (docs/flight.md "Rocket economy"): rockets per flight on bds-fly
// (flat, peaceful, fall damage ON, truth pack). One afk-task bot (walking, the CLI's wiring) with the
// flight kit flies 300, 600 and 1200 blocks over flat ground to a ground target and lands:
//   economy   rockets after the change <= the numbers measured before it (BEFORE, Track AU's cruise rule:
//             a rocket whenever the height fell 7 under the slope), at most one cruise rocket per 150
//             blocks of cruise beyond the climb (a rocket climbs about 18 blocks, the glide ratio is
//             about 8.5), the landing within 3 blocks with 0 damage; the table is printed
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1;
// FLY_ECON_BASELINE=1 records the numbers without the economy assertions (the "before" run).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, startFlyBot, teleport, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const BASELINE = process.env.FLY_ECON_BASELINE === '1';
/** Rockets the unchanged Track AU code took on bds-fly (measured 2026-10-30, the "before" column of docs/flight.md "Rocket economy"). */
const BEFORE: Record<number, number> = { 300: 1, 600: 5, 1200: 13 };
/** Blocks of cruise one top-up rocket must cover at least beyond the climb (the brief's floor: 18 blocks of climb x a glide ratio of 8.5; a rocket from a level glide buys about 31 blocks, 310 of glide). */
const CRUISE_PER_ROCKET = 150;

interface Row {
  distance: number;
  reply: string;
  rockets: number;
  climbRockets: number;
  cruiseRockets: number;
  goArounds: number;
  seconds: number;
  off: number;
  damage: number;
  maxY: number;
  log: string;
}

describe.skipIf(!E2E)('@bds fly: the rocket economy of 300, 600 and 1200-block flights (Track AU2)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Econ');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('blocks', 8)}${pad('rockets', 9)}${pad('climb', 7)}${pad('cruise', 8)}${pad('per 100', 9)}${pad('go-arounds', 12)}${pad('s', 5)}${pad('off', 6)}${pad('damage', 8)}max y`,
      ...rows.map((r) => `${pad(r.distance, 8)}${pad(r.rockets, 9)}${pad(r.climbRockets, 7)}${pad(r.cruiseRockets, 8)}${pad(((r.rockets * 100) / r.distance).toFixed(2), 9)}${pad(r.goArounds, 12)}${pad(r.seconds, 5)}${pad(r.off.toFixed(2), 6)}${pad(r.damage, 8)}${r.maxY.toFixed(1)}`),
    ];
    console.log(`[fly-economy e2e${BASELINE ? ', baseline' : ''}] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${rows.map((r) => `${r.distance}: ${r.reply} | ${r.log}`).join('\n  ')}`);
  }, 60_000);

  for (const distance of [300, 600, 1200]) {
    it(`${distance} blocks over flat ground: lands with 0 damage${BASELINE ? '' : `, at most ${BEFORE[distance]! + (distance === 300 ? 1 : 0)} rockets (before: ${BEFORE[distance]}) and one cruise rocket per ${CRUISE_PER_ROCKET} blocks`}`, async () => {
      const b = bot!;
      await teleport(b, home);
      await giveFlightKit(b, { rockets: 64 });
      const target = { x: area.x, y: F, z: area.z + distance };
      const since = await b.truth.now();
      const from = b.said.length;
      const n0 = b.logs.length;
      await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
      const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from);
      expect(start).toMatch(/^flying to /);
      const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 240_000);
      const g = await b.truth.glide(b.name);
      const dmg = await b.truth.damageSince(since, b.name);
      const log = b.logs.slice(n0).find((l) => l.includes('flight: landed') || l.includes('flight: ended')) ?? '';
      const m = /(\d+) rockets?, (\d+) go-arounds?, (\d+) s/.exec(end);
      const by = /rockets \((\d+) climb, (\d+) cruise/.exec(log);
      const maxY = /max y (-?[\d.]+)/.exec(log);
      const row: Row = {
        distance,
        reply: end,
        rockets: m ? Number(m[1]) : -1,
        climbRockets: by ? Number(by[1]) : -1,
        cruiseRockets: by ? Number(by[2]) : -1,
        goArounds: m ? Number(m[2]) : -1,
        seconds: m ? Number(m[3]) : -1,
        off: hdist(g.location, { x: target.x + 0.5, z: target.z + 0.5 }),
        damage: dmg.total,
        maxY: maxY ? Number(maxY[1]) : NaN,
        log,
      };
      rows.push(row);
      expect(end, row.reply).toMatch(/^landed at /);
      expect(g.isOnGround).toBe(true);
      expect(row.off).toBeLessThan(3);
      expect(dmg.total).toBe(0);
      if (!BASELINE) {
        // 300 blocks: the old cruise took 1 rocket by letting the body sink under the approach entry (a platform
        // cannot take that); the climb to the glide line (36 up) costs the second rocket's quantum: 2 is the gate there
        expect(row.rockets, `rockets: ${row.reply}`).toBeLessThanOrEqual(BEFORE[distance]! + (distance === 300 ? 1 : 0));
        // the cruise beyond the climb: the straight distance less the approach and the climb's run (about 1.25 blocks per block climbed)
        const climbRun = Math.max(0, row.maxY - F) * 1.25;
        const cruise = Math.max(0, distance - 56 - climbRun);
        expect(row.cruiseRockets, `cruise rockets over ${cruise.toFixed(0)} blocks: ${row.log}`).toBeLessThanOrEqual(Math.max(1, Math.ceil(cruise / CRUISE_PER_ROCKET)));
      }
    }, 300_000);
  }
});
