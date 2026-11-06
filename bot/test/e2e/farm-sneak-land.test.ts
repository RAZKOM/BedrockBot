// e2e probe (tag @bds) on bds-farm (BDS_E2E=1; truth pack deployed with `node scripts/bds.mjs --profile farm pack`):
// does holding sneak during a fall onto farmland keep it from being trampled?
//
// Each try gets a fresh lane: a 2-block stone ledge `h` (1 or 2) blocks high, then 4 cells of farmland
// (moist, no crop) at the ground. The bot walks off the ledge (forward, no sprint, no sneak while on
// the ledge: sneak stops a body at an edge), and with `sneak` the key is pressed from the first airborne
// tick until it has stood on the ground for a while. The truth pack reads the lane's soil back: any
// `dirt` = trampled. Conditions are interleaved try by try. Falls are 1.0625 (h 1) and 2.0625 (h 2):
// the farmland top is 0.9375. Env SNEAK_TRIES (tries per height and condition, default 12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_VERSION } from './env.ts';
import { E2E, FEET_Y, FarmArea, SOIL_Y, clearArea, connectFarmBot, consoleCommand, FARM_CONTAINER, prepareServer, truthLoaded, type FarmBot, type TruthCrops } from './farm-truth.ts';

const TRIES = Number(process.env.SNEAK_TRIES ?? 12);
const CONDITIONS: { h: number; sneak: boolean }[] = [
  { h: 1, sneak: false },
  { h: 1, sneak: true },
  { h: 2, sneak: false },
  { h: 2, sneak: true },
];

interface Try {
  h: number;
  sneak: boolean;
  trampled: boolean;
  fall: number;
  airTicks: number;
  sneakTicks: number;
  soil: (string | null)[];
}

describe.skipIf(!E2E)('@bds farm probe: sneak while falling onto farmland', () => {
  let bot: FarmBot;
  const area = new FarmArea();
  const cx = area.x0;
  const cz = area.z0;
  const tries: Try[] = [];

  /** Lane origins: 4 columns (14 apart) x 19 rows (3 apart) in the run's cell. */
  const lanes: { x: number; z: number }[] = [];
  for (let row = 0; row < 19; row++) for (let col = 0; col < 4; col++) lanes.push({ x: cx - 28 + 14 * col, z: cz - 27 + 3 * row });

  beforeAll(async () => {
    await prepareServer();
    await consoleCommand(FARM_CONTAINER, 'gamerule', 'randomtickspeed', '0');
    bot = await connectFarmBot('Sneak');
    await bot.teleport({ x: cx + 0.5, y: FEET_Y, z: cz + 0.5 }, -90);
    await clearArea(bot.truth, cx, cz, 31, 6);
  }, 180_000);

  afterAll(async () => {
    const lines: string[] = [];
    for (const c of CONDITIONS) {
      const ts = tries.filter((t) => t.h === c.h && t.sneak === c.sneak);
      const n = ts.filter((t) => t.trampled).length;
      const falls = ts.map((t) => t.fall.toFixed(3));
      lines.push(`h ${c.h} ${c.sneak ? 'sneak' : 'plain'}: trampled ${n}/${ts.length}; falls ${[...new Set(falls)].join(' ')}; air ticks ${ts.map((t) => t.airTicks).join(' ')}; sneak ticks ${ts.map((t) => t.sneakTicks).join(' ')}`);
    }
    process.stdout.write(`[farm-sneak-land e2e] BDS ${E2E_VERSION}, area cell ${area.cell}\n  ${lines.join('\n  ')}\n`);
    if (bot) {
      await clearArea(bot.truth, cx, cz, 31, 6).catch(() => undefined);
      await consoleCommand(FARM_CONTAINER, 'gamerule', 'randomtickspeed', '1').catch(() => undefined);
      await bot.close();
    }
  });

  async function drop(lane: { x: number; z: number }, h: number, sneak: boolean): Promise<Try> {
    await truthLoaded(bot.truth, 'fill', [lane.x, FEET_Y, lane.z, lane.x + 1, FEET_Y + h - 1, lane.z, 'stone']);
    await truthLoaded(bot.truth, 'field', [lane.x + 2, SOIL_Y, lane.z, 4, 1, 'none', 0, 7]);
    await bot.teleport({ x: lane.x + 0.5, y: FEET_Y + h, z: lane.z + 0.5 }, -90);
    const loop = bot.loop;
    let left = false;
    let landed = -1;
    let airTicks = 0;
    let sneakTicks = 0;
    let top = loop.state.pos.y;
    let bottom = top;
    let ticks = 0;
    const done = new Promise<void>((resolve) => {
      const off = loop.onBeforeStep((_tick, s) => {
        ticks++;
        if (!s.onGround) {
          left = true;
          airTicks++;
          top = Math.max(top, s.pos.y);
        }
        if (left && s.onGround && landed < 0) {
          landed = ticks;
          bottom = s.pos.y;
        }
        // walk until airborne; then no keys but sneak (if asked) until 20 ticks after landing
        loop.setCommand({ yaw: -90, pitch: 0, forward: left ? 0 : 1, strafe: 0, sprint: false, jump: false, sneak: sneak && left });
        if (sneak && left) sneakTicks++;
        if ((landed >= 0 && ticks - landed >= 20) || ticks > 200) {
          off();
          loop.release();
          resolve();
        }
      });
    });
    await done;
    await loop.waitTicks(5);
    const f = await truthLoaded<TruthCrops>(bot.truth, 'crops', [lane.x + 2, SOIL_Y, lane.z, 4, 1]);
    const soil = f.soil.map((s) => (s == null ? null : String(s).replace('minecraft:', '')));
    const t: Try = { h, sneak, trampled: soil.some((s) => s !== 'farmland'), fall: top - bottom, airTicks, sneakTicks, soil };
    tries.push(t);
    return t;
  }

  it('drops off 1- and 2-block ledges onto farmland, with and without sneak', async () => {
    expect(TRIES * CONDITIONS.length).toBeLessThanOrEqual(lanes.length);
    let k = 0;
    for (let i = 0; i < TRIES; i++) {
      for (const c of CONDITIONS) {
        const t = await drop(lanes[k++]!, c.h, c.sneak);
        if (process.env.FARM_VERBOSE === '1') process.stdout.write(`try ${i} h ${c.h} sneak ${c.sneak}: ${t.trampled ? 'TRAMPLED' : 'ok'} fall ${t.fall.toFixed(3)} soil ${t.soil.join(',')}\n`);
      }
    }
    // a probe: every try landed (fall measured) and the lane was read
    expect(tries.every((t) => t.fall > 0.9)).toBe(true);
  }, 1_200_000);
});
