// Track M1: `!test mobs` (skills/test/mobs.ts, chat/commands-test.ts) on bds-pve (cheats on, every player an operator): the
// series refuses near home, runs `zombie4` twice (summons with its name tag, a line per run, the summary), removes only its
// own mobs (a cow and a zombie it did not summon, next to it, are still there), and `!test stop` removes its mobs at once.
// Needs BDS_E2E=1 and bds-pve with the truth pack. About 2 min.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, E2E, FEET_Y, fill, prepareServer, privateArea, pveCmd, sleep, startPveBot, teleport, uniqueName, until, type MobInfo, type PveBot } from './pve-truth.ts';

describe.skipIf(!E2E)('pve: !test mobs (Track M1)', () => {
  let bot: PveBot | undefined;
  const ownerName = uniqueName('TmOwner');
  const area = privateArea();
  const START: Vec3 = { x: area.x - 600, y: FEET_Y, z: area.z + 400 };
  const say = (b: PveBot, body: string): void => b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: body, body, truth: false });

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveTm', {}, { owners: [ownerName] });
    await teleport(bot, centre(START));
    await fill(bot, { x: START.x - 20, y: FEET_Y - 1, z: START.z - 20 }, { x: START.x + 20, y: FEET_Y - 1, z: START.z + 20 }, 'grass_block');
    await fill(bot, { x: START.x - 20, y: FEET_Y, z: START.z - 20 }, { x: START.x + 20, y: FEET_Y + 5, z: START.z + 20 }, 'air');
    await bot.truth.clearAround(centre(START), 40);
    bot.pve.settings.set('testMode', true);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(START), 40).catch(() => undefined);
      await bot.stop();
    }
  });

  it('refuses within 150 blocks of home', async () => {
    const b = bot!;
    b.task.home!.set({ x: START.x + 40, y: FEET_Y, z: START.z });
    const n0 = b.said.length;
    say(b, '!test mobs zombie');
    await until(() => (b.said.slice(n0).some((m) => /test mobs: \d+ blocks from home/.test(m)) ? true : undefined), 15_000, 'the refusal');
  }, 30_000);

  it('runs zombie4 twice, removes only its own mobs; !test stop removes them at once', async () => {
    const b = bot!;
    b.task.home!.set({ x: START.x + 400, y: FEET_Y, z: START.z });
    // a cow 12 blocks off and a zombie 26 off (outside guard's 16 even when the fight moves the bot), held there; each carries
    // a name tag of its own (an unnamed held mob went with no hurt in 4 of 5 runs, the cow once: most likely a despawn, which
    // a named mob never does), and the series' `/kill @e[name=<tag>]` must pass both over
    const summonHeld = async (type: string, x: number): Promise<MobInfo> => {
      const name = `held${type}${Date.now() % 100000}`;
      await pveCmd('summon', type, String(START.x + x), String(FEET_Y), String(START.z + 0.5), '0', '0', 'minecraft:entity_spawned', name);
      return until(async () => (await b.truth.near({ x: START.x + x, y: FEET_Y, z: START.z + 0.5 }, 4)).find((m) => m.name === name), 10_000, `the held ${type}`);
    };
    const cow = await summonHeld('cow', 12.5);
    const other = await summonHeld('zombie', -26.5);
    for (const id of [cow.entityId, other.entityId]) {
      await b.truth.effect(id, 'slowness', 300, 255);
      await b.truth.effect(id, 'resistance', 300, 4);
    }
    const since = await b.truth.now();
    const n0 = b.said.length;
    say(b, '!test mobs zombie4 2 30s');
    await until(() => (b.said.slice(n0).some((m) => /^test mobs zombie4: \d+\/2 runs/.test(m)) ? true : undefined), 150_000, 'the summary', 500);
    const lines = b.said.slice(n0).filter((m) => m.startsWith('test mobs'));
    console.log(lines.join('\n'));
    if (process.env.TESTMOBS_OUT) appendFileSync(process.env.TESTMOBS_OUT, `${lines.join('\n')}\n`); // vitest may hold console output
    expect(lines.filter((m) => /^test mobs zombie4 run \d\/2: /.test(m))).toHaveLength(2);
    await sleep(1500);
    const held = (await b.truth.hurtlog(since)).events.filter((h) => h.victimId === cow.entityId || h.victimId === other.entityId);
    console.log(`held mobs: cow ${JSON.stringify(await b.truth.entity(cow.entityId))}, zombie ${JSON.stringify(await b.truth.entity(other.entityId))}, hurt ${JSON.stringify(held)}`);
    expect((await b.truth.entity(cow.entityId)).valid).not.toBe(false);
    expect((await b.truth.entity(other.entityId)).valid).not.toBe(false);
    // stop in the middle of a run: the series' mobs go at once
    const n1 = b.said.length;
    say(b, '!test mobs zombie4 3 120s');
    await until(() => (b.said.slice(n1).some((m) => m.startsWith('test mobs zombie4: 3 runs')) ? true : undefined), 20_000, 'the start line', 250);
    await sleep(4000);
    say(b, '!test stop');
    await until(() => (b.said.slice(n1).some((m) => /^test mobs zombie4: \d+\/3 runs \(stopped\)/.test(m))? true : undefined), 30_000, 'the stopped summary', 250);
    if (process.env.TESTMOBS_OUT) appendFileSync(process.env.TESTMOBS_OUT, `${b.said.slice(n1).filter((m) => m.startsWith('test')).join('\n')}\n`);
    await sleep(1500);
    const zombies = (await b.truth.near(centre(START), 24)).filter((m) => m.typeId === 'minecraft:zombie' && m.entityId !== other.entityId);
    expect(zombies).toEqual([]);
    expect((await b.truth.entity(other.entityId)).valid).not.toBe(false);
  }, 240_000);
});
