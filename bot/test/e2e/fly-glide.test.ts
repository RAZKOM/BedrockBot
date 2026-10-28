// e2e (tag @bds), wave 11 Track AU (docs/flight.md): the glide itself on bds-fly (flat, peaceful,
// fall damage ON, truth pack). One afk-task bot (walking, the CLI's wiring) with the flight kit:
//   glide   `!fly x y z` 100 blocks over flat ground: a takeoff from flat ground (a jump, start_gliding
//           while falling, one rocket), the cruise and a landing on the ground with 0 damage (the
//           truth hurt log), standing (truth:glide isOnGround, not gliding), within 3 blocks of the aim
//   kit     the elytra is on the back during the flight and the chestplate is back on afterwards
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, startFlyBot, teleport, until, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds fly: takeoff, a 100-block glide and a landing on flat ground (Track AU)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Glide');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-glide e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it('flies 100 blocks from flat ground and lands with 0 damage within 3 blocks of the aim; the chestplate is back on', async () => {
    const b = bot!;
    await giveFlightKit(b, { rockets: 64 });
    const target = { x: area.x, y: F, z: area.z + 100 };
    const since = await b.truth.now();
    const from = b.said.length;
    let sawElytra = false;
    const t0 = Date.now();
    await b.command(`!fly ${target.x} ${target.y} ${target.z}`);
    const start = await b.reply((s) => s.startsWith('flying to ') || s.startsWith('fly: ') || s.startsWith('elytra worn'), from);
    expect(start).toMatch(/^flying to \d+ -60 \d+ \(100 blocks/);
    // the elytra is on the back while it flies
    await until(async () => {
      const c = await b.truth.chestSlot(b.name);
      if (c?.typeId === 'minecraft:elytra') sawElytra = true;
      return sawElytra ? true : undefined;
    }, 15_000, 'the elytra in the chest slot');
    const end = await b.reply((s) => s.startsWith('landed') || s.startsWith('fly: '), from, 60_000);
    const ms = Date.now() - t0;
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const flightLog = b.logs.filter((l) => l.includes('flight: landed') || l.includes('flight: ended')).at(-1);
    notes.push(`glide: ${end}; ${(ms / 1000).toFixed(1)} s; truth pos ${g.location.x.toFixed(2)} ${g.location.y.toFixed(2)} ${g.location.z.toFixed(2)} ground ${g.isOnGround} gliding ${g.isGliding}; damage ${dmg.total} (${dmg.causes.join(',') || 'none'}); ${flightLog ?? ''}`);
    expect(end).toMatch(/^landed at /);
    expect(g.isOnGround).toBe(true);
    expect(g.isGliding).toBe(false);
    expect(hdist(g.location, { x: target.x + 0.5, z: target.z + 0.5 })).toBeLessThan(3); // the ground: the slide after touchdown is not measured against a platform edge
    expect(Math.abs(g.location.y - F)).toBeLessThan(0.1);
    expect(dmg.total).toBe(0);
    expect(sawElytra).toBe(true);
    // the chestplate is back on and the elytra in the inventory
    const chest = await until(async () => {
      const c = await b.truth.chestSlot(b.name);
      return c?.typeId === 'minecraft:iron_chestplate' ? c : undefined;
    }, 15_000, 'the chestplate back on');
    expect(chest.typeId).toBe('minecraft:iron_chestplate');
    const counts = await b.truth.counts(b.name);
    expect(counts.elytra).toBe(1);
    expect(counts.firework_rocket).toBeGreaterThanOrEqual(56); // 1 to 4 rockets (a go-around costs one)
    await teleport(b, home);
  }, 120_000);
});
