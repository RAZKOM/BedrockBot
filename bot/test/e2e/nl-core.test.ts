// PLAN.md 7.18 on bds-core (Track Y, docs/natural-language.md): the natural-language front end on the
// real afk task and the real chat, with a FakeProvider standing in for the model (no model service).
//   1. `!do walk home then guard`, `!yes`: the bot walks to the home waypoint, then guard goes on;
//   2. `!do walk home`, `!no`: the plan is dropped and the bot stays where it is; the same through
//      chat addressed to the bot (`say <bot>, walk home`);
//   3. `!do go to narnia` (the model names a waypoint that does not exist): the bot asks a question.
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
// Env: CORE_BDS_HOST / CORE_BDS_PORT / CORE_BDS_CONTAINER (core-truth.ts); a random private area per run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/nl/fake.ts';
import { NL_PROVIDER_KEY } from '../../src/nl/provider.ts';
import { centre, clearArea, coreCmd, E2E, FEET_Y, hdist, prepareServer, privateArea, sleep, startCoreBot, teleport, type CoreBot } from './core-truth.ts';

const plan = (...steps: Record<string, unknown>[]) => ({ steps });

describe.skipIf(!E2E)('core: natural language (task 7.18)', () => {
  let bot: CoreBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  const AWAY = { x: area.x + 14, y: FEET_Y, z: area.z + 6 };
  const measurements: string[] = [];
  const provider = new FakeProvider([
    ['walk home then guard', plan({ command: 'goto', waypoint: 'home' }, { command: 'guard', mode: 'on' })],
    ['walk home', plan({ command: 'goto', waypoint: 'home' })],
    ['go to narnia', plan({ command: 'goto', waypoint: 'narnia' })],
  ]);

  beforeAll(async () => {
    await prepareServer();
    // in-memory waypoints (no config dir) and the fake model
    bot = await startCoreBot('CoreNl', { home: HOME }, { values: { 'no-config': true, [NL_PROVIDER_KEY]: provider } });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 48);
    await clearArea(bot.truth, HOME, 20, 6);
    await bot.truth.setHealth(bot.name, 20);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      bot.pve.setGuard({ on: false });
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 48).catch(() => undefined);
      await clearArea(bot.truth, HOME, 20, 6).catch(() => undefined);
      await bot.stop();
    }
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('!do walk home then guard, !yes: walks home, then guard on', async () => {
    const b = bot!;
    b.pve.setGuard({ on: false });
    await teleport(b, centre(AWAY));
    let n = b.said.length;
    const t0 = Date.now();
    await b.command('!do walk home then guard');
    const line = await b.reply((s) => s.startsWith('plan:'), n);
    const planMs = Date.now() - t0;
    expect(line).toBe('plan: goto home, then guard on (!yes to run, !no to drop)');
    // nothing runs before !yes
    await sleep(1000);
    expect(b.processes.userProcesses()).toHaveLength(0);
    expect(b.pve.guard.on).toBe(false);
    n = b.said.length;
    const t1 = Date.now();
    await b.command('!yes');
    expect(await b.reply((s) => s.startsWith('walking to'), n)).toBe(`walking to home (${HOME.x} ${HOME.y} ${HOME.z})`);
    // guard waits for the walk
    expect(b.pve.guard.on).toBe(false);
    const arrived = await b.reply((s) => s.startsWith('arrived at'), n, 60_000);
    const arriveMs = Date.now() - t1;
    expect(arrived).toBe(`arrived at home (${HOME.x} ${HOME.y} ${HOME.z})`);
    expect(await b.reply((s) => s.startsWith('guard '), n, 10_000)).toMatch(/^guard on, radius \d+$/);
    expect(await b.reply((s) => s.startsWith('plan done'), n, 10_000)).toBe('plan done (2 steps)');
    const guardMs = Date.now() - t1;
    expect(b.pve.guard.on).toBe(true);
    const at = (await b.truth.pos(b.name)).location;
    expect(hdist(at, centre(HOME))).toBeLessThan(1.5);
    // the order in the chat: walking, arrived, guard, plan done
    const order = b.said.slice(n).filter((s) => /^(walking to|arrived at|guard |plan done)/.test(s));
    expect(order.map((s) => s.split(' ')[0])).toEqual(['walking', 'arrived', 'guard', 'plan']);
    const m = `walk home then guard: plan line ${planMs} ms after !do, arrived ${arriveMs} ms after !yes (${hdist(centre(AWAY), centre(HOME)).toFixed(1)} blocks), guard on ${guardMs} ms after !yes, end ${at.x.toFixed(2)} ${at.z.toFixed(2)}`;
    console.log(m);
    measurements.push(m);
    b.pve.setGuard({ on: false });
  }, 120_000);

  it('!no drops a plan (also when the plan came from chat addressed to the bot)', async () => {
    const b = bot!;
    await teleport(b, centre(AWAY));
    for (const ask of [() => b.command('!do walk home'), () => coreCmd('say', `${b.name},`, 'walk', 'home')]) {
      let n = b.said.length;
      await ask();
      expect(await b.reply((s) => s.startsWith('plan:'), n)).toBe('plan: goto home (!yes to run, !no to drop)');
      n = b.said.length;
      await b.command('!no');
      expect(await b.reply((s) => s.startsWith('plan dropped'), n)).toBe('plan dropped');
      const p1 = (await b.truth.pos(b.name)).location;
      n = b.said.length;
      await b.command('!yes');
      expect(await b.reply((s) => s.startsWith('no plan waiting'), n)).toBe('no plan waiting (!do <what to do>)');
      await sleep(1500);
      const p2 = (await b.truth.pos(b.name)).location;
      expect(hdist(p1, p2)).toBeLessThan(0.3);
      expect(hdist(p2, centre(AWAY))).toBeLessThan(1);
      expect(b.processes.userProcesses()).toHaveLength(0);
    }
    measurements.push('!no: two plans dropped (!do and addressed chat), bot stayed at AWAY');
  }, 60_000);

  it('an unknown waypoint yields a question', async () => {
    const b = bot!;
    const n = b.said.length;
    await b.command('!do go to narnia');
    const q = await b.reply((s) => s.startsWith('I know no waypoint'), n);
    expect(q).toMatch(/^I know no waypoint "narnia" \(known: [a-z0-9_, -]*home[a-z0-9_, -]*\)\. Which one, or which x y z\?$/);
    await sleep(1000);
    expect(b.said.slice(n).some((s) => s.startsWith('plan:'))).toBe(false);
    expect(b.processes.userProcesses()).toHaveLength(0);
    measurements.push(`unknown waypoint: "${q}"`);
    // the model saw the waypoints and the command reference
    const sys = provider.requests.at(-1)!.system;
    expect(sys).toMatch(/waypoints: .*home/);
    expect(sys).toContain('[chat: !goto <waypoint> | x y z');
    expect(provider.requests.at(-1)!.user).toBe('request from console: go to narnia');
  }, 30_000);
});
