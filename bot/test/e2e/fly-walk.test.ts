// e2e (tag @bds), wave 11 Track AU2 (docs/flight.md "Fly, then walk"): `!goto` to a goal that cannot be
// landed on lands on the nearest landable cell and walks the rest, as one command; on bds-fly (flat,
// peaceful, fall damage ON, truth pack). One afk-task bot (walking, the CLI's wiring) with the flight kit:
//   pit     a goal 3 blocks under the floor 300 blocks away (a truth-built trench with a stair): the reply
//           says `flying N blocks to M blocks from <goal>, then walking`, one landing, 0 damage, the bot
//           ends standing at the goal
//   house   a goal inside a truth-built house (7 x 7, a doorway) 300 blocks away: the bot ends inside it
// Env: FLY_BDS_HOST / FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts), FLY_AREA, FLY_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { E2E, FEET_Y, giveFlightKit, hdist, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;

describe.skipIf(!E2E)('@bds fly: fly, then walk (Track AU2)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    await prepareServer();
    bot = await startFlyBot('Walk');
    await teleport(bot, home);
  }, 120_000);

  afterAll(async () => {
    if (bot) await bot.stop();
    console.log(`[fly-walk e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 60_000);

  /**
   * `!goto` the goal and wait for the arrival. The flight's decision is either said up front (`flying N
   * blocks to M blocks from <goal>, then walking`, when the goal's ground is known) or in flight once
   * the chunks there are loaded (`fly: landing M blocks from <goal> (no landing spot on it), then walking`).
   */
  async function gotoAndMeasure(label: string, start: Vec3, goal: Vec3): Promise<{ flying: string; decision: string | undefined; arrived: string; pos: Vec3; damage: number; landings: number; flightLog: string | undefined; said: string[] }> {
    const b = bot!;
    await b.command('!stop');
    await sleep(1500);
    await teleport(b, start);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    await b.command(`!goto ${goal.x} ${goal.y} ${goal.z}`);
    const flying = await b.reply((s) => s.startsWith('flying') || s.startsWith('fly: ') || s.startsWith('goto: '), from, 20_000);
    const arrived = await b.reply((s) => s.startsWith('arrived at ') || s.startsWith('goto: '), from, 240_000);
    const said = b.said.slice(from);
    const decision = said.find((s) => /^flying \d+ blocks to \d+ blocks from .*, then walking$/.test(s) || /^fly: landing \d+ blocks from .* \(no landing spot on it\), then walking$/.test(s));
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const logs = b.logs.slice(n0);
    const landings = logs.filter((l) => l.includes('flight: landed') || l.includes('flight: ended')).length;
    const flightLog = logs.find((l) => l.includes('flight: landed') || l.includes('flight: ended'));
    const retarget = logs.filter((l) => l.includes('retargeted') || l.includes('landing cell') || l.includes('not known yet') || l.includes('only cached') || l.includes('not landable')).map((l) => l.replace(/^\S+ info /, ''));
    notes.push(`${label}: ${said.join(' | ')} | truth ${g.location.x.toFixed(2)} ${g.location.y.toFixed(2)} ${g.location.z.toFixed(2)} | landings ${landings} damage ${dmg.total}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''} | ${flightLog ?? ''} | ${retarget.join(' ; ')}`);
    return { flying, decision, arrived, pos: g.location, damage: dmg.total, landings, flightLog, said };
  }

  it('a goal 3 blocks under the floor 300 blocks away: lands beside the pit and walks down the stair into it', async () => {
    const b = bot!;
    const gx = area.x + 120;
    const gz = area.z + 300;
    const goal = { x: gx, y: F - 3, z: gz };
    // the trench: one block wide along z, a step deeper each block: 1 deep at gz - 2, 2 at gz - 1, 3 at gz
    await teleport(b, { x: gx + 3.5, y: F, z: gz + 0.5 });
    await truthLoaded(b.truth, 'fill', [gx, F - 1, gz - 2, gx, F - 1, gz, 'air']);
    await truthLoaded(b.truth, 'fill', [gx, F - 2, gz - 1, gx, F - 2, gz, 'air']);
    await truthLoaded(b.truth, 'fill', [gx, F - 3, gz, gx, F - 3, gz, 'air']);
    const start = { x: gx + 0.5, y: F, z: area.z + 0.5 };
    const r = await gotoAndMeasure('pit', start, goal);
    expect(r.flying).toMatch(/^flying/);
    expect(r.decision, r.said.join(' | ')).toBeDefined();
    expect(r.flightLog).toMatch(/flight: landed/);
    expect(r.arrived).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    expect(hdist(r.pos, { x: gx + 0.5, z: gz + 0.5 })).toBeLessThan(1.5);
    expect(Math.abs(r.pos.y - (F - 3))).toBeLessThan(0.6);
    expect(r.landings).toBe(1);
    expect(r.damage).toBe(0);
    await teleport(b, { x: gx + 3.5, y: F, z: gz + 0.5 });
    await truthLoaded(b.truth, 'fill', [gx, F - 3, gz - 2, gx, F - 1, gz, 'dirt']);
    await teleport(b, home);
  }, 420_000);

  it('a goal inside a house 300 blocks away: lands outside and walks in through the door', async () => {
    const b = bot!;
    const hx = area.x + 180;
    const hz = area.z + 300;
    const goal = { x: hx, y: F, z: hz };
    // the house: 7 x 7 outside, walls 3 high with the roof on top, a doorway 2 high on the -z side (the way the bot comes)
    await teleport(b, { x: hx + 6.5, y: F, z: hz + 0.5 });
    await truthLoaded(b.truth, 'fill', [hx - 3, F, hz - 3, hx + 3, F + 3, hz + 3, 'oak_planks']);
    await truthLoaded(b.truth, 'fill', [hx - 2, F, hz - 2, hx + 2, F + 2, hz + 2, 'air']);
    await truthLoaded(b.truth, 'fill', [hx, F, hz - 3, hx, F + 1, hz - 3, 'air']);
    const start = { x: hx + 0.5, y: F, z: area.z + 0.5 };
    const r = await gotoAndMeasure('house', start, goal);
    expect(r.flying).toMatch(/^flying/);
    expect(r.decision, r.said.join(' | ')).toBeDefined();
    expect(r.flightLog).toMatch(/flight: landed/);
    expect(r.arrived).toBe(`arrived at ${goal.x} ${goal.y} ${goal.z}`);
    // inside: within the interior box, on the floor
    expect(Math.abs(r.pos.x - (hx + 0.5))).toBeLessThanOrEqual(2.5);
    expect(Math.abs(r.pos.z - (hz + 0.5))).toBeLessThanOrEqual(2.5);
    expect(Math.abs(r.pos.y - F)).toBeLessThan(0.6);
    expect(r.landings).toBe(1);
    expect(r.damage).toBe(0);
    await teleport(b, { x: hx + 6.5, y: F, z: hz + 0.5 });
    await truthLoaded(b.truth, 'fill', [hx - 3, F, hz - 3, hx + 3, F + 3, hz + 3, 'air']);
    await teleport(b, home);
  }, 420_000);
});
