// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079) on bds-pve: the reflex never strikes a friend, and
// the bot's work goes on while mobs attack it.
//   friendly   a player (a second client), a villager, a wolf tamed to that player, a cow, an iron golem and an enderman
//              that has not attacked, all held in reach (slowness 255), while three zombies come in: guard on, the reflex
//              on, 40 s; the server's melee log must show no hit by the bot on any of them (the zombies only)
//   goto       a 40-block walk with three zombies summoned round the start: it arrives, no death
//   mine       `!mine sand 12` on a line of sand with three zombies round it: the job ends, no death
//   eat        food 6, eating to full with three zombies round it: the food goes up, no death
// Bare hands (no weapon, no armour): the worst kit. Needs BDS_E2E=1 and bds-pve with the truth pack (meleelog, tame).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { centre, cleanSpot, connectPlayer, E2E, FEET_Y, fill, prepareServer, privateArea, sleep, startPveBot, teleport, tracked, uniqueName, until, type PveBot } from './pve-truth.ts';

/** A result line: the console, and M1_OUT when set (vitest may hold console output). */
function note(line: string): void {
  console.log(line);
  if (process.env.M1_OUT) appendFileSync(process.env.M1_OUT, `${line}\n`);
}

interface MeleeRecord {
  victimId: string;
  victimType: string;
  victimName: string | null;
  damagerName: string | null;
  damagerType: string | null;
  damage: number;
}

describe.skipIf(!E2E)('pve: Track M1 friendly fire and work under attack', () => {
  let bot: PveBot | undefined;
  let friend: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  const ownerName = uniqueName('M1Owner');
  const area = privateArea();
  let spot = 0;
  const nextSpot = (): Vec3 => {
    const i = spot++;
    return { x: area.x + 300 + 48 * i, y: FEET_Y, z: area.z + 300 };
  };
  const melee = async (b: PveBot, since: number): Promise<MeleeRecord[]> => (await b.truth.ok<{ events: MeleeRecord[] }>('meleelog', [since, '*'], 20_000)).events;

  async function fresh(b: PveBot): Promise<Vec3> {
    const at = nextSpot();
    const c = centre(at);
    await teleport(b, c);
    await fill(b, { x: at.x - 20, y: FEET_Y - 1, z: at.z - 20 }, { x: at.x + 50, y: FEET_Y - 1, z: at.z + 20 }, 'grass_block');
    await fill(b, { x: at.x - 20, y: FEET_Y, z: at.z - 20 }, { x: at.x + 50, y: FEET_Y + 5, z: at.z + 20 }, 'air');
    await cleanSpot(b, c, { r: 20, up: 5, entities: 60 }); // Track M5: the layers under the spot too, and its cells read back
    b.task.home?.set(at);
    await b.truth.setHealth(b.name, 20);
    await b.truth.ok('setfood', [b.name, 20, 5]);
    return c;
  }

  async function zombies(b: PveBot, c: Vec3, n = 3): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + 0.4;
      const m = await b.truth.summon('zombie', { x: c.x + 7 * Math.cos(a), y: FEET_Y, z: c.z + 7 * Math.sin(a) });
      ids.push(m.entityId);
    }
    return ids;
  }

  beforeAll(async () => {
    await prepareServer({ time: 'midnight' });
    bot = await startPveBot('PveM1', {}, { owners: [ownerName] });
    await bot.truth.ok('clear', [bot.name]);
    await bot.truth.ok('unequip', [bot.name]);
    await bot.truth.ok('give', [bot.name, 'bread', 16]);
    // the reflex is on by default again since Track M2 (ADR 0079 decision 26); these cases are about it
    expect(bot.pve.settings.get('mobReflex')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      bot.pve.stop();
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    await friend?.close().catch(() => undefined);
  });

  it('friendly: no strike on a player, a villager, a tamed wolf, a cow, an iron golem or a calm enderman', async () => {
    const b = bot!;
    const c = await fresh(b);
    friend = await connectPlayer(uniqueName('M1Friend'));
    await sleep(1500);
    await b.truth.tp(friend.name, { x: c.x + 1.6, y: FEET_Y, z: c.z }, 0, 0);
    const held: { type: string; at: Vec3; id?: string }[] = [
      { type: 'villager_v2', at: { x: c.x - 1.6, y: FEET_Y, z: c.z } },
      { type: 'wolf', at: { x: c.x, y: FEET_Y, z: c.z + 1.6 } },
      { type: 'cow', at: { x: c.x, y: FEET_Y, z: c.z - 1.8 } },
      { type: 'iron_golem', at: { x: c.x + 2.2, y: FEET_Y, z: c.z + 2.2 } },
      { type: 'enderman', at: { x: c.x - 2.0, y: FEET_Y, z: c.z - 2.0 } },
    ];
    for (const h of held) {
      const m = await b.truth.summon(h.type, h.at);
      h.id = m.entityId;
      await b.truth.effect(m.entityId, 'slowness', 120, 255);
      await b.truth.effect(m.entityId, 'weakness', 120, 255); // an enderman or a golem that turns on someone hurts nobody
      await b.truth.effect(m.entityId, 'resistance', 120, 4);
      await tracked(b, m);
    }
    const wolf = held.find((h) => h.type === 'wolf')!;
    await b.truth.ok('tame', [wolf.id!, friend.name]);
    b.pve.setGuard({ on: true, radius: 16 });
    const since = await b.truth.now();
    const reflex0 = b.pve.reflex.totals.hits;
    const zs = await zombies(b, c);
    await sleep(40_000);
    b.pve.setGuard({ on: false });
    b.pve.stop();
    const log = await melee(b, since);
    const byBot = log.filter((h) => h.damagerName === b.name);
    const friendly = byBot.filter((h) => !zs.includes(h.victimId));
    note(`friendly: ${byBot.length} hits by the bot (reflex strikes ${b.pve.reflex.totals.hits - reflex0}), on ${[...new Set(byBot.map((h) => h.victimType))].join(', ') || 'nothing'}; friendly ${friendly.length}`);
    expect(friendly).toEqual([]);
    await b.truth.cleanup();
    await friend.close();
    friend = undefined;
  }, 120_000);

  it('goto: a 40-block walk with three zombies round the start arrives', async () => {
    const b = bot!;
    const c = await fresh(b);
    const deaths0 = b.built.respawn!.deaths;
    await zombies(b, c);
    const t0 = Date.now();
    const r = await b.pve.walk({ type: 'block', p: { x: Math.floor(c.x) + 40, y: FEET_Y, z: Math.floor(c.z) } }, {}, 'm1 walk');
    note(`goto under attack: ${r.ok ? 'arrived' : `failed ${r.reason}`} in ${((Date.now() - t0) / 1000).toFixed(1)} s, health ${b.pve.health()}, reflex ${b.pve.reflex.totals.hits}`);
    expect(r.ok).toBe(true);
    expect(b.built.respawn!.deaths).toBe(deaths0);
    await b.truth.cleanup();
  }, 120_000);

  it('mine: `!mine sand 12` with three zombies round it ends', async () => {
    const b = bot!;
    const c = await fresh(b);
    const deaths0 = b.built.respawn!.deaths;
    b.task.home?.set({ x: Math.floor(c.x) + 200, y: FEET_Y, z: Math.floor(c.z) }); // the home area is never dug
    // a line of sand standing on the ground
    await fill(b, { x: Math.floor(c.x) + 2, y: FEET_Y, z: Math.floor(c.z) + 2 }, { x: Math.floor(c.x) + 13, y: FEET_Y, z: Math.floor(c.z) + 2 }, 'sand');
    await zombies(b, c);
    const said0 = b.said.length;
    const body = '!mine sand 12';
    b.chat.handle({ type: 'chat', source: ownerName, xuid: '', message: body, body, truth: false });
    const jobs = (): number => b.task.processes?.find('mine').length ?? 0;
    await until(() => (jobs() > 0 ? true : undefined), 5000, 'the mine job', 100);
    // Track M2: the job's own end (its state) and then its done line, which comes back from the server as chat a moment
    // after the job ends (twice in Track M1 the line was read before it arrived)
    const proc = b.task.processes!.find('mine')[0] as unknown as { result: Promise<string>; task: { lastError?: string } };
    const state = await Promise.race([proc.result, sleep(150_000).then(() => 'still running')]);
    const ended = Date.now();
    const lineNow = b.said.slice(said0).some((m) => /^mine sand: \d+\/12/.test(m));
    const doneLine = await until(() => b.said.slice(said0).find((m) => /^mine sand: \d+\/12/.test(m)), 10_000, 'the done line', 100).catch(() => undefined);
    note(`mine under attack: ended ${state}${proc.task.lastError ? ` (${proc.task.lastError})` : ''}, line ${doneLine ?? 'NONE'} (${lineNow ? 'there at the end' : `${Date.now() - ended} ms after the end`}); said ${b.said.slice(said0).join(' | ').slice(0, 300)}; health ${b.pve.health()}`);
    expect(b.built.respawn!.deaths).toBe(deaths0);
    expect(state).not.toBe('stopped'); // a fight or a flight must pause the job, never end it
    const got = /mine sand: (\d+)\/12/.exec(doneLine ?? '');
    expect(Number(got?.[1] ?? 0)).toBeGreaterThanOrEqual(8);
    await b.truth.cleanup();
  }, 200_000);

  it('eat: eating to full with three zombies round it', async () => {
    const b = bot!;
    const c = await fresh(b);
    const deaths0 = b.built.respawn!.deaths;
    await b.truth.ok('setfood', [b.name, 6, 0]);
    await until(() => (b.pve.food() <= 6 ? true : undefined), 5000, 'food 6');
    await zombies(b, c);
    const kit = b.pve.kit?.();
    expect(kit).toBeDefined();
    // the kit's own automatic eating may take the bite first (`busy`): the food bar is the measure
    let bites = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && b.pve.food() < 20) {
      const r = await kit!.eat();
      if (r.ok) bites++;
      await sleep(250);
    }
    note(`eat under attack: ${bites} bites of our own, food ${b.pve.food()}, health ${b.pve.health()}, reflex ${b.pve.reflex.totals.hits}`);
    expect(b.pve.food()).toBeGreaterThanOrEqual(16);
    expect(b.built.respawn!.deaths).toBe(deaths0);
    await b.truth.cleanup();
  }, 120_000);
});
