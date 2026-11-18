// e2e (tag @bds), Track E3 (docs/early-game.md "A bed", ADR 0100): `!bed` sets a carried bed down where the night rule
// sleeps in it, the respawn point moves to it, and at night the bot sleeps through.
//   1. no home or shelter: the bed goes next to the bot and the `bed` waypoint is set at it; `!bed` again says one
//      stands there; a bed under a cover (leaf litter) round the feet is cleared first.
//   2. with home set 10 blocks off: the bot walks home and sets the bed there; by day it clicks it (`tile.bed.noSleep`)
//      and the respawn point moves: killed, it comes back next to the bed.
//   3. night with the daylight cycle on (the bot is the only player): the night rule walks to the bed, sleeps
//      (truth: isSleeping), the server skips the night and the bot is up in the morning.
// Env: CRAFT_BDS_HOST / CRAFT_BDS_PORT / CRAFT_BDS_CONTAINER (craft-truth.ts), CRAFT_VERBOSE=1.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { waypointStoreOf } from '../../src/chat/commands-nav.ts';
import { NightProcess } from '../../src/tasks/process/night.ts';
import { clearArea, craftCmd, E2E, FEET_Y, loadKit, prepareServer, privateArea, sleep, startCraftBot, teleport, until, type CraftBot } from './craft-truth.ts';

const F = FEET_Y;

function note(line: string): void {
  console.log(line);
  if (process.env.EARLY_OUT) appendFileSync(process.env.EARLY_OUT, `${line}\n`);
}

async function bedsAround(b: CraftBot, c: Vec3, r: number): Promise<Vec3[]> {
  const out: Vec3[] = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) {
      const p = { x: c.x + dx, y: F, z: c.z + dz };
      const bl = await b.truth.block(p);
      if (bl.typeId === 'minecraft:bed') out.push(p);
    }
  return out;
}

describe.skipIf(!E2E)('@bds early bed: !bed, the respawn point, a night slept through (Track E3)', () => {
  const area = privateArea();
  let bot: CraftBot | undefined;
  const at = { x: area.x, y: F, z: area.z };
  const home = { x: area.x + 10, y: F, z: area.z };
  const mid = { x: area.x + 5, y: F, z: area.z };

  beforeAll(async () => {
    await prepareServer();
    const b = await startCraftBot('EarlyBed');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.settings.set('autoFood', 'off');
    await craftCmd('gamerule', 'keepinventory', 'true');
    await teleport(b, { x: at.x + 0.5, y: F, z: at.z + 0.5 });
    await clearArea(b.truth, mid, 12, 4);
  }, 180_000);

  afterAll(async () => {
    await craftCmd('gamerule', 'dodaylightcycle', 'false').catch(() => undefined);
    await craftCmd('time', 'set', 'noon').catch(() => undefined);
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await clearArea(bot.truth, mid, 12, 4).catch(() => undefined);
      await bot.stop();
    }
  }, 120_000);

  it('no home: the bed next to the bot (a cover cleared first), the bed waypoint set', async () => {
    const b = bot!;
    const night = b.task.processes!.find('night').find((x): x is NightProcess => x instanceof NightProcess)!;
    expect(night.bedAttached).toBe(true);
    // leaf litter in the four cells round the feet (the cover rule)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) await craftCmd('setblock', String(at.x + dx), String(F), String(at.z + dz), 'leaf_litter');
    await loadKit(b, [['bed', 1]]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!bed');
    const line = await b.reply((s) => /^bed( placed|:)/.test(s) && !s.includes('placing'), from, 30_000);
    const s = (Date.now() - t0) / 1000;
    note(`[early-bed] no home: ${line} (${s.toFixed(1)} s)`);
    expect(line).toMatch(/^bed placed at .* here \(respawn point set, bed waypoint set\)/);
    const beds = await bedsAround(b, at, 3);
    expect(beds.length).toBe(2);
    expect(b.built.mobility!.world.inventory.count('bed')).toBe(0);
    const wp = waypointStoreOf(b.task)?.get('bed');
    expect(wp?.auto).toBe(true);
    night.bedsChanged();
    expect(night.beds().length).toBe(1);
    const from2 = b.said.length;
    await b.command('!bed');
    expect(await b.reply((s2) => s2.startsWith("bed:"), from2, 10_000)).toMatch(/one stands at/);
    // taken down again for the next case (the waypoint too)
    for (const p of beds) await craftCmd('setblock', String(p.x), String(p.y), String(p.z), 'air');
    waypointStoreOf(b.task)?.delete('bed');
    night.bedsChanged();
  }, 120_000);

  it('home 10 blocks off: walks home, the bed there, the respawn point moved (killed, back by the bed)', async () => {
    const b = bot!;
    const night = b.task.processes!.find('night').find((x): x is NightProcess => x instanceof NightProcess)!;
    expect(b.task.home).toBeDefined();
    b.task.home!.set(home); // as `!home set` there
    await teleport(b, { x: at.x + 0.5, y: F, z: at.z + 0.5 });
    await loadKit(b, [['bed', 1]]);
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!bed');
    const line = await b.reply((s) => /^bed( placed|:)/.test(s) && !s.includes('placing'), from, 60_000);
    const s = (Date.now() - t0) / 1000;
    note(`[early-bed] home: ${line} (${s.toFixed(1)} s)`);
    expect(line).toMatch(/^bed placed at .* by home \(respawn point set\)/);
    const beds = await bedsAround(b, home, 4);
    expect(beds.length).toBe(2);
    night.bedsChanged();
    expect(night.beds().length).toBe(1);
    // the respawn point: killed far from the bed, the bot comes back next to it
    await teleport(b, { x: at.x + 0.5, y: F, z: at.z + 0.5 });
    const deaths0 = b.logs.filter((l) => l.includes('died (death')).length;
    await craftCmd('kill', b.name);
    await until(() => (b.logs.filter((l) => l.includes('died (death')).length > deaths0 ? true : undefined), 20_000, 'the death', 100);
    await sleep(4000);
    const p = (await b.truth.pos(b.name)).location;
    const d = Math.min(...beds.map((q) => Math.hypot(p.x - (q.x + 0.5), p.z - (q.z + 0.5))));
    note(`[early-bed] respawned at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}, ${d.toFixed(1)} from the bed`);
    expect(d).toBeLessThan(3);
  }, 180_000);

  it('night with the daylight cycle on: asleep in the bed, the night skipped, up in the morning', async () => {
    const b = bot!;
    await sleep(3000);
    const t0 = Date.now();
    await craftCmd('gamerule', 'dodaylightcycle', 'true');
    await craftCmd('time', 'set', '13000');
    const asleep = await until(
      async () => {
        const s = await b.truth.ok<{ sleeping: boolean; timeOfDay: number }>('sleeping', [b.name]);
        return s.sleeping ? s : undefined;
      },
      60_000,
      'asleep',
      500,
    );
    const asleepS = (Date.now() - t0) / 1000;
    const morning = await until(
      async () => {
        const s = await b.truth.ok<{ sleeping: boolean; timeOfDay: number }>('sleeping', [b.name]);
        return !s.sleeping && s.timeOfDay < 12000 ? s : undefined;
      },
      60_000,
      'the morning',
      500,
    );
    const total = (Date.now() - t0) / 1000;
    await craftCmd('gamerule', 'dodaylightcycle', 'false');
    note(`[early-bed] night: asleep ${asleepS.toFixed(1)} s after dusk (time ${asleep.timeOfDay}), up at time ${morning.timeOfDay} ${total.toFixed(1)} s after dusk`);
    expect(morning.timeOfDay).toBeLessThan(2000);
  }, 180_000);
});
