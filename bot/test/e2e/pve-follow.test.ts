// PLAN.md tasks 7.5 and 7.6 on bds-pve: the bot follows a summoned pig that is teleported 3 blocks
// every 2 s for about 100 blocks and stays within 4 blocks; a second client (a real player, the
// owner) types `!come` and the bot reaches it; `!follow` keeps it within 4 blocks while the owner
// moves, survives the owner leaving view (last known position, then waiting), `!status` names the
// behaviour and `!stop` ends it. Needs BDS_E2E=1 and bds-pve with the truth pack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  centre,
  connectPlayer,
  E2E,
  FEET_Y,
  hdist,
  prepareServer,
  privateArea,
  sleep,
  startPveBot,
  teleport,
  tracked,
  uniqueName,
  until,
  type PveBot,
} from './pve-truth.ts';

describe.skipIf(!E2E)('pve: follow and come (tasks 7.5, 7.6)', () => {
  let bot: PveBot | undefined;
  let owner: Awaited<ReturnType<typeof connectPlayer>> | undefined;
  const ownerName = uniqueName('PveOwner');
  const area = privateArea();
  const START = { x: area.x - 60, y: FEET_Y, z: area.z };
  const measurements: string[] = [];

  beforeAll(async () => {
    await prepareServer({ time: 'noon' });
    bot = await startPveBot('PveFollow', {}, { owners: [ownerName] });
    await teleport(bot, centre(START));
    await bot.truth.clearAround(centre(START), 48);
  }, 120_000);

  afterAll(async () => {
    await owner?.close().catch(() => undefined);
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements:\n  ${measurements.join('\n  ')}`);
  });

  it('follows a pig teleported 3 blocks every 2 s for 100 blocks, staying within 4 blocks', async () => {
    const b = bot!;
    const pig = await b.truth.summon('pig', { x: START.x + 3.5, y: FEET_Y, z: START.z + 0.5 });
    await b.truth.effect(pig.entityId, 'slowness', 600, 255); // it only moves when teleported
    const rid = await tracked(b, pig);
    b.pve.follow({ runtimeId: rid });
    expect(b.pve.behaviour()).toMatch(/^following pig/);
    const samples: number[] = [];
    let x = START.x + 3.5;
    const steps = 34;
    for (let i = 0; i < steps; i++) {
      await sleep(2000);
      const [me, p] = await Promise.all([b.truth.pos(b.name), b.truth.entity(pig.entityId)]);
      samples.push(hdist(me.location, p.location));
      x += 3;
      await b.truth.moveMob(pig.entityId, { x, y: FEET_Y, z: START.z + 0.5 });
    }
    await sleep(2500);
    const [me, p] = await Promise.all([b.truth.pos(b.name), b.truth.entity(pig.entityId)]);
    samples.push(hdist(me.location, p.location));
    const travelled = x - (START.x + 3.5);
    const max = Math.max(...samples);
    const mean = samples.reduce((a, c) => a + c, 0) / samples.length;
    const st = b.pve.follower.status();
    const line = `follow pig: ${travelled} blocks in ${steps} teleports, distance before each teleport max ${max.toFixed(2)} mean ${mean.toFixed(2)}, ${st.plans} plans, corrections ${b.built.mobility!.loop.state.corrections}`;
    console.log(line);
    measurements.push(line);
    expect(travelled).toBeGreaterThanOrEqual(100);
    expect(max).toBeLessThanOrEqual(4);
    b.pve.stop();
    expect(b.pve.behaviour()).toBe('idle');
    await b.truth.cleanup();
  }, 150_000);

  it('!come from a second client: the bot reaches the owner; !follow, leaving view, !status, !stop', async () => {
    const b = bot!;
    const here = await b.truth.pos(b.name);
    owner = await connectPlayer(ownerName);
    const o = owner;
    const target = { x: Math.floor(here.location.x) + 20.5, y: FEET_Y, z: Math.floor(here.location.z) + 6.5 };
    await b.truth.tp(o.name, target, 0, 0);
    await until(() => {
      for (const e of b.built.mobility!.world.entities.values()) if (e.username === o.name && hdist(e.pos, target) < 0.5) return true;
      return undefined;
    }, 15_000, 'owner tracked at its position');

    // !come
    const n0 = b.said.length;
    const t0 = Date.now();
    o.say('!come');
    const reached = await until(async () => {
      const [me, them] = await Promise.all([b.truth.pos(b.name), b.truth.pos(o.name)]);
      const d = hdist(me.location, them.location);
      return d <= 2.5 ? d : undefined;
    }, 60_000, 'bot next to the owner', 250);
    const comeMs = Date.now() - t0;
    await until(() => (b.said.slice(n0).some((s) => s.startsWith('here')) ? true : undefined), 10_000, 'come reply');
    const line1 = `!come: within ${reached.toFixed(2)} blocks of the owner ${comeMs} ms after the chat line (${hdist(here.location, target).toFixed(1)} blocks away); replies: ${b.said.slice(n0).join(' | ')}`;
    console.log(line1);
    measurements.push(line1);
    expect(comeMs).toBeLessThan(60_000);

    // !follow (default: the sender) while the owner moves 8 blocks every 3 s
    o.say('!follow');
    await until(() => (b.pve.behaviour() === `following ${o.name}` ? true : undefined), 5_000, 'following the owner');
    const dists: number[] = [];
    let pos = { ...target };
    for (let i = 0; i < 4; i++) {
      pos = { x: pos.x + 8, y: FEET_Y, z: pos.z + (i % 2 === 0 ? 3 : -3) };
      await b.truth.tp(o.name, pos, 0, 0);
      await sleep(3000);
      const [me, them] = await Promise.all([b.truth.pos(b.name), b.truth.pos(o.name)]);
      dists.push(hdist(me.location, them.location));
    }
    const n1 = b.said.length;
    o.say('!status');
    const status = await until(() => b.said.slice(n1).find((s) => s.startsWith('status:')), 10_000, '!status reply');
    expect(status).toContain(`behaviour following ${o.name}`);

    // leaving view: far away (beyond the view distance), then back
    const far = { x: pos.x + 400, y: FEET_Y, z: pos.z };
    await b.truth.tp(o.name, far, 0, 0);
    const lostState = await until(() => {
      const s = b.pve.follower.status().state;
      return s === 'lost' || s === 'waiting' ? s : undefined;
    }, 20_000, 'follow lost the target', 100);
    await until(() => (b.pve.follower.status().state === 'waiting' ? true : undefined), 20_000, 'waiting at the last known position');
    const waitAt = await b.truth.pos(b.name);
    const back = { x: waitAt.location.x + 6, y: FEET_Y, z: waitAt.location.z + 2 };
    await b.truth.tp(o.name, back, 0, 0);
    await until(async () => {
      const [me, them] = await Promise.all([b.truth.pos(b.name), b.truth.pos(o.name)]);
      return hdist(me.location, them.location) <= 4 && b.pve.follower.status().state !== 'waiting' ? true : undefined;
    }, 30_000, 'following again after the owner came back', 500);
    const line2 = `!follow: distance 3 s after each 8-block jump ${dists.map((d) => d.toFixed(2)).join(', ')}; out of view -> ${lostState} -> waiting at ${hdist(waitAt.location, pos).toFixed(1)} blocks from the last known position; resumed when back; status "${status}"`;
    console.log(line2);
    measurements.push(line2);
    expect(Math.max(...dists)).toBeLessThanOrEqual(4);

    const n2 = b.said.length;
    o.say('!stop');
    const stopped = await until(() => b.said.slice(n2).find((s) => s.startsWith('stopped')), 10_000, '!stop reply');
    expect(stopped).toContain(`was following ${o.name}`);
    expect(b.pve.behaviour()).toBe('idle');
  }, 180_000);
});
