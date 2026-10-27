// Trip readiness on bds-gaunt (wave 7, Track W; docs/pve.md "Trip readiness"): food set to 6 (truth),
// then `!come` from a second client 30 blocks away: the reply says `eating first`, the status line is
// `preparing: eating`, the bot eats to a full food bar (truth uselog / food) without moving, then walks
// to the player. At night without a chestplate `!come` is refused and `!come now` goes anyway.
// The kit's own automatic eating is switched off here so the test sees the trip rule alone (with it on
// the kit would eat at food < 18 by itself before the command). Needs BDS_E2E=1 and bds-gaunt with the
// truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { survivalKitOf } from '../../src/chat/commands-survival.ts';
import { centre, connectPlayer, E2E, FEET_Y, hdist, prepareServer, privateArea, saidSince, startGauntBot, teleport, uniqueName, until, type GauntBot } from './gaunt-truth.ts';

describe.skipIf(!E2E)('gaunt: trip readiness (Track W)', () => {
  let bot: GauntBot | undefined;
  let player: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  const playerName = uniqueName('GtPlayer');
  const area = privateArea();
  const START = { x: area.x, y: FEET_Y, z: area.z };
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startGauntBot('GtTrip', {}, { owners: [playerName] });
    await teleport(bot, centre(START));
    await bot.truth.clearAround(centre(START), 64);
    player = await connectPlayer(playerName);
  }, 120_000);

  afterAll(async () => {
    await player?.close().catch(() => undefined);
    if (bot) {
      await bot.truth.time('noon').catch(() => undefined);
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${lines.join('\n  ')}`);
  });

  it('food 6, then !come: eats first (reply and status), food full, then walks to the player', async () => {
    const b = bot!;
    const p = player!;
    const kit = survivalKitOf(b.task);
    expect(kit).toBeDefined();
    kit!.overrides.autoEat = false;
    await b.truth.ok('clear', [b.name]);
    await b.truth.give(b.name, 'bread', 8);
    await b.truth.ok('unequip', [b.name]);
    const world = b.built.mobility!.world;
    await until(() => (world.inventory.slots.some((s) => s?.name === 'bread') ? true : undefined), 5000, 'bread in the model');
    const here = (await b.truth.pos(b.name)).location;
    const target = { x: Math.floor(here.x) + 30.5, y: FEET_Y, z: Math.floor(here.z) + 0.5 };
    await b.truth.tp(p.name, target, 0, 0);
    await until(() => (b.pve.playerFeet(p.name) && hdist(b.pve.playerFeet(p.name)!, target) < 0.5 ? true : undefined), 15_000, 'player tracked');
    await b.truth.setFood(b.name, 6, 0);
    await until(() => (world.self.food === 6 ? true : undefined), 5000, 'food 6 in the model');
    const use0 = (await b.truth.uselog(Number.MAX_SAFE_INTEGER)).now;
    const n0 = b.said.length;
    const t0 = Date.now();
    p.say('!come');
    const reply = await until(() => saidSince(b, n0, 'coming to'), 10_000, '!come reply');
    expect(reply).toBe(`coming to ${p.name} (eating first)`);
    const status = await until(() => (b.pve.behaviour().startsWith('preparing') ? b.pve.behaviour() : undefined), 5000, 'preparing status', 50);
    expect(status).toBe('preparing: eating');
    // eats without moving, until full
    let maxMove = 0;
    const full = await until(async () => {
      const [pos, f] = await Promise.all([b.truth.pos(b.name), b.truth.food(b.name)]);
      if (!b.pve.behaviour().startsWith('preparing')) maxMove = Math.max(maxMove, 0);
      else maxMove = Math.max(maxMove, hdist(pos.location, here));
      return f.food >= 20 ? f : undefined;
    }, 20_000, 'food 20', 200);
    const fullMs = Date.now() - t0;
    const uses = (await b.truth.uselog(use0, b.name)).events.filter((e) => e.kind === 'complete');
    await until(async () => {
      const [me, them] = await Promise.all([b.truth.pos(b.name), b.truth.pos(p.name)]);
      return hdist(me.location, them.location) <= 2.5 ? true : undefined;
    }, 60_000, 'bot next to the player');
    const arriveMs = Date.now() - t0;
    await until(() => saidSince(b, n0, 'here ('), 10_000, 'here reply');
    const line = `!come with food 6: "${reply}", status "${status}"; ${uses.length} bites (${uses.map((u) => u.typeId).join(', ')}), food 6 -> ${full.food} after ${(fullMs / 1000).toFixed(1)} s, moved ${maxMove.toFixed(2)} while preparing; next to the player (30 blocks) after ${(arriveMs / 1000).toFixed(1)} s`;
    console.log(line);
    lines.push(line);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    expect(maxMove).toBeLessThan(1);
    kit!.overrides.autoEat = true;
  }, 120_000);

  it('at night without a chestplate !come is refused; !come now goes anyway', async () => {
    const b = bot!;
    const p = player!;
    await b.truth.time('midnight');
    await until(() => {
      const t = b.pve.timeOfDay();
      return t !== undefined && t >= 17_000 && t < 19_000 ? true : undefined;
    }, 20_000, 'night in the bot clock');
    const here = (await b.truth.pos(b.name)).location;
    const target = { x: Math.floor(here.x) - 25.5, y: FEET_Y, z: Math.floor(here.z) + 3.5 };
    await b.truth.tp(p.name, target, 0, 0);
    await until(() => (b.pve.playerFeet(p.name) && hdist(b.pve.playerFeet(p.name)!, target) < 0.5 ? true : undefined), 15_000, 'player tracked');
    const n0 = b.said.length;
    p.say('!come');
    const refused = await until(() => saidSince(b, n0, 'come:'), 10_000, 'refusal');
    expect(refused).toContain('no chestplate');
    await new Promise((r) => setTimeout(r, 1500));
    expect(hdist((await b.truth.pos(b.name)).location, here)).toBeLessThan(0.5);
    const n1 = b.said.length;
    const t0 = Date.now();
    p.say('!come now');
    const ok = await until(() => saidSince(b, n1, 'coming to'), 10_000, '!come now reply');
    await until(async () => {
      const [me, them] = await Promise.all([b.truth.pos(b.name), b.truth.pos(p.name)]);
      return hdist(me.location, them.location) <= 2.5 ? true : undefined;
    }, 60_000, 'bot next to the player');
    const line = `night, no chestplate: !come -> "${refused}"; !come now -> "${ok}", arrived after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    console.log(line);
    lines.push(line);
  }, 120_000);
});
