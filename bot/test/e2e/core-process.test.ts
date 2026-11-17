// PLAN.md task 7.8 on bds-core (difficulty normal; Track Q, docs/processes.md): the process manager
// on the real afk task.
//   1. a guard fight interrupts a running `!gather` (trees placed with truth:tree outside the base:
//      findTrees never lists a tree with a log within protectRadius of home, docs/wood.md "Not trees");
//      the gather is paused, resumes on its own afterwards and finishes;
//   2. `!goto` with `!status` (the process stack and an ETA, checked against the real arrival), then
//      `!pause` (the bot stands), `!resume` (walks again), `!stop` (ends it) on a second goto;
//   3. flee pre-empts a guard fight (health set low mid-fight), and the fight resumes after the flight; with `mobReflex`
//      off, the flight on foot as it runs without the reflex;
//   4. the same fight with the reflex on (the default): Track M2's hold (ADR 0079 decision 23) keeps the bot standing at
//      low health with the one zombie in reach, and two melee hits within 3 s start the flight after all.
// Each test leaves guard off, no user process behind and the reflex on (afterEach), so one failure cannot cascade.
// Needs BDS_E2E=1 and bds-core with the truth pack (`node scripts/bds.mjs --profile core up` and `... pack`).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import {
  armWithIronSword,
  centre,
  clearArea,
  E2E,
  FEET_Y,
  hdist,
  prepareServer,
  privateArea,
  sleep,
  startCoreBot,
  teleport,
  truthLoaded,
  until,
  type CoreBot,
} from './core-truth.ts';

/** How long case 4 watches the hold at low health: under HOLD_HITS_MS (3 s), so the next drop is a second hit within it. */
const HOLD_WATCH_MS = 2000;

describe.skipIf(!E2E)('core: process manager (task 7.8)', () => {
  let bot: CoreBot | undefined;
  const area = privateArea();
  const HOME = { x: area.x, y: FEET_Y, z: area.z };
  /** Where the gather works: west of home, outside the base (protectRadius + 16; set in beforeAll). */
  let WORK: Vec3 = HOME;
  const measurements: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await startCoreBot('CoreProc', { home: HOME });
    await teleport(bot, centre(HOME));
    await bot.truth.clearAround(centre(HOME), 64);
    await clearArea(bot.truth, HOME, 20, 10);
    WORK = { x: HOME.x - (bot.settings.get('protectRadius') + 16), y: FEET_Y, z: HOME.z };
    await teleport(bot, centre(WORK));
    await bot.truth.clearAround(centre(WORK), 32);
    await clearArea(bot.truth, WORK, 16, 10);
    await teleport(bot, centre(HOME));
    await armWithIronSword(bot);
    await bot.truth.ok('give', [bot.name, 'iron_axe', 1]);
    await bot.truth.setHealth(bot.name, 20);
  }, 180_000);

  // one test's failure must not leak into the next: guard off, no user process, held or not, no mobs of
  // this run, full health and the sword back (2026-11-05: a failed gather left guard on and the
  // next test's `!stop` reply read "guarding r=16" instead of "idle")
  afterEach(async () => {
    const b = bot;
    if (!b) return;
    b.pve.setGuard({ on: false });
    b.pve.settings.set('mobReflex', true);
    b.processes.unhold();
    b.processes.stopUser();
    await b.truth.cleanup().catch(() => undefined);
    await b.truth.setHealth(b.name, 20).catch(() => undefined);
    await armWithIronSword(b).catch(() => undefined);
  }, 30_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.cleanup().catch(() => undefined);
      await bot.truth.clearAround(centre(HOME), 64).catch(() => undefined);
      await clearArea(bot.truth, HOME, 20, 10).catch(() => undefined);
      if (WORK !== HOME) {
        await teleport(bot, centre(WORK)).catch(() => undefined);
        await bot.truth.clearAround(centre(WORK), 32).catch(() => undefined);
        await clearArea(bot.truth, WORK, 16, 10).catch(() => undefined);
      }
      await bot.stop();
    }
    console.log(`measurements (area cell ${area.cell}):\n  ${measurements.join('\n  ')}`);
  }, 60_000);

  it('a guard fight interrupts a running gather; the gather resumes and finishes', async () => {
    const b = bot!;
    await teleport(b, centre(WORK));
    b.pve.setGuard({ on: true });
    const trees = [
      { x: WORK.x + 6, z: WORK.z },
      { x: WORK.x - 5, z: WORK.z + 4 },
    ];
    const protect = b.settings.get('protectRadius');
    for (const t of trees) expect(hdist({ x: t.x, y: FEET_Y, z: t.z }, HOME), 'tree outside the base').toBeGreaterThan(protect + 8);
    for (const t of trees) await truthLoaded(b.truth, 'tree', [t.x, FEET_Y, t.z, 4, 'oak']);
    // the world model must show the logs before the gather looks for trees
    const w = b.built.mobility!.world;
    await until(() => (trees.every((t) => w.blockAt({ x: t.x, y: FEET_Y + 3, z: t.z })?.name.endsWith('_log')) ? true : undefined), 10_000, 'logs in the world model');
    const n0 = b.said.length;
    const t0 = Date.now();
    await b.command('!gather 8');
    expect(await b.reply((s) => s.startsWith('gathering'), n0)).toBe('gathering 8 logs (no chest: keeping them)');
    const gather = b.task.gather!;
    // mid-gather: at least one log broken
    await until(() => (gather.task.stats.logsBroken >= 1 ? true : undefined), 60_000, 'first log broken', 100);
    const brokenAtFight = gather.task.stats.logsBroken;
    const me = b.task.position()!;
    const mob = await b.truth.summon('zombie', { x: Math.floor(me.x) + 0.5, y: FEET_Y, z: Math.floor(me.z) + 7.5 });
    const tSummon = Date.now();
    const fight = await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? b.pve.behaviour() : undefined), 10_000, 'guard fight', 50);
    const preemptMs = Date.now() - tSummon;
    const stack = b.processes.stack().map((e) => `${e.name}:${e.state}`);
    expect(stack).toEqual(['guard:active', 'gather:paused']);
    expect(gather.status()).toMatch(/\(paused/);
    await until(async () => ((await b.truth.entity(mob.entityId)).valid === false ? true : undefined), 60_000, 'zombie dead', 250);
    const killMs = Date.now() - tSummon;
    const resumed = await until(() => (b.pve.behaviour().startsWith('gathering') ? Date.now() : undefined), 20_000, 'gather resumed', 50);
    await until(() => (gather.task.state === 'done' ? true : gather.task.state === 'failed' ? false : undefined), 180_000, 'gather done', 250).then((ok) => {
      if (!ok) throw new Error(`gather failed: ${gather.task.lastError}`);
    });
    const doneMs = Date.now() - t0;
    const inv = await b.truth.ok<{ counts: Record<string, number> }>('inv', [b.name]);
    const logs = Object.entries(inv.counts).filter(([k]) => k.endsWith('_log')).reduce((a, [, v]) => a + v, 0);
    const end = await b.reply((s) => s.startsWith('gather done'), n0, 10_000);
    const line =
      `gather + guard: "${fight}" ${preemptMs} ms after the summon (gather paused at ${brokenAtFight} logs broken), zombie dead after ${killMs} ms, ` +
      `gather resumed ${resumed - tSummon} ms after the summon, done after ${doneMs} ms with ${logs} logs (truth), ${gather.task.stats.treesFelled} trees, ` +
      `${gather.task.stats.corrections} corrections; resumes ${b.metrics.snapshot().counters['process.gather.resumed'] ?? 0}; reply "${end}"`;
    console.log(line);
    measurements.push(line);
    expect(logs).toBeGreaterThanOrEqual(8);
    expect(b.metrics.snapshot().counters['process.gather.resumed']).toBeGreaterThanOrEqual(1);
    expect(b.processes.userProcesses()).toHaveLength(0);
  }, 300_000);

  it('!status shows the stack with an ETA; !pause, !resume and !stop during a goto', async () => {
    const b = bot!;
    await b.truth.setHealth(b.name, 20);
    await teleport(b, centre(HOME));
    // walk 1: 40 blocks north, ETA against the real arrival
    const g1 = { x: HOME.x, y: FEET_Y, z: HOME.z - 40 };
    let n = b.said.length;
    const t0 = Date.now();
    await b.command(`!goto ${g1.x} ${g1.y} ${g1.z}`);
    await b.reply((s) => s.startsWith('walking to'), n);
    await sleep(1500);
    n = b.said.length;
    const tStatus = Date.now();
    await b.command('!status');
    const status = await b.reply((s) => s.startsWith('status:'), n);
    const stackLine = await b.reply((s) => s.startsWith('processes:'), n);
    expect(status).toContain(`behaviour walking to ${g1.x} ${g1.y} ${g1.z}`);
    const m = /\[active\] walking to (-?\d+) (-?\d+) (-?\d+), (\d+) blocks left, eta (\d+) s/.exec(stackLine);
    expect(m, stackLine).not.toBeNull();
    const etaS = Number(m![5]);
    const left = Number(m![4]);
    await b.reply((s) => s.startsWith('arrived at'), n, 60_000);
    const actualS = (Date.now() - tStatus) / 1000;
    const line1 = `goto 40 blocks: "${stackLine}" ${tStatus - t0} ms after the command; ETA ${etaS} s for ${left} blocks, arrived ${actualS.toFixed(1)} s after the !status (chat round trip included)`;
    console.log(line1);
    measurements.push(line1);
    expect(Math.abs(actualS - etaS)).toBeLessThanOrEqual(3);

    // walk 2: 60 blocks back south past home; pause, resume, stop
    const g2 = { x: HOME.x, y: FEET_Y, z: HOME.z + 20 };
    n = b.said.length;
    await b.command(`!goto ${g2.x} ${g2.y} ${g2.z}`);
    await b.reply((s) => s.startsWith('walking to'), n);
    await sleep(2000);
    n = b.said.length;
    await b.command('!pause');
    expect(await b.reply((s) => s.startsWith('paused'), n)).toBe(`paused: walking to ${g2.x} ${g2.y} ${g2.z} (!resume to continue)`);
    await sleep(700);
    const p1 = (await b.truth.pos(b.name)).location;
    await sleep(2000);
    const p2 = (await b.truth.pos(b.name)).location;
    n = b.said.length;
    await b.command('!status');
    const held = await b.reply((s) => s.startsWith('processes:'), n);
    expect(held).toContain(`[held] walking to ${g2.x} ${g2.y} ${g2.z}`);
    expect(hdist(p1, p2)).toBeLessThan(0.3);
    n = b.said.length;
    await b.command('!resume');
    expect(await b.reply((s) => s.startsWith('resumed'), n)).toBe(`resumed: walking to ${g2.x} ${g2.y} ${g2.z}`);
    await sleep(2000);
    const p3 = (await b.truth.pos(b.name)).location;
    expect(hdist(p2, p3)).toBeGreaterThan(3);
    n = b.said.length;
    await b.command('!stop');
    expect(await b.reply((s) => s.startsWith('stopped'), n)).toMatch(new RegExp(`^stopped \\(was walking to ${g2.x} ${g2.y} ${g2.z}, \\d+ blocks left\\); idle$`));
    // the stopped walk stays quiet (commands-nav.ts: `interrupted` is not reported; the !stop line named it)
    await sleep(700);
    expect(b.said.slice(n).filter((s) => s.startsWith('goto:'))).toEqual([]);
    const p4 = (await b.truth.pos(b.name)).location;
    await sleep(2000);
    const p5 = (await b.truth.pos(b.name)).location;
    expect(hdist(p4, p5)).toBeLessThan(0.3);
    expect(hdist(p5, g2)).toBeGreaterThan(5);
    expect(b.processes.stack()).toHaveLength(0);
    const line2 = `pause/resume/stop: held still ${hdist(p1, p2).toFixed(2)} blocks over 2 s; ${hdist(p2, p3).toFixed(1)} blocks in 2 s after !resume; after !stop ${hdist(p4, p5).toFixed(2)} blocks over 2 s, ${hdist(p5, g2).toFixed(1)} from the goal; "${held}"`;
    console.log(line2);
    measurements.push(line2);
  }, 180_000);

  it('flee pre-empts a guard fight; the fight resumes after the flight', async () => {
    const b = bot!;
    // the flight on foot without the reflex: with it on, one zombie in reach at low health is stood against, not run from
    // (Track M2, holdGround; the next test). This case is about the process stack, so it takes the setting's other side,
    // as afk-processes and gaunt-flee do (afterEach turns it on again)
    b.pve.settings.set('mobReflex', false);
    await b.truth.setHealth(b.name, 20);
    const start = { x: HOME.x + 12, y: FEET_Y, z: HOME.z };
    await teleport(b, centre(start));
    b.pve.setGuard({ on: false });
    const since = await b.truth.now();
    // slow (cannot follow the flight), harmless, and immune for 16 s so the first fight cannot end
    // before the flight; guard goes on only once the effects are applied
    const mob = await b.truth.summon('zombie', { x: start.x + 0.5, y: FEET_Y, z: start.z + 4.5 });
    await b.truth.effect(mob.entityId, 'slowness', 120, 255);
    await b.truth.effect(mob.entityId, 'weakness', 120, 255);
    await b.truth.effect(mob.entityId, 'resistance', 16, 4);
    const t0 = Date.now();
    b.pve.setGuard({ on: true, radius: 16 });
    await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? true : undefined), 10_000, 'guard fight', 50);
    const fightMs = Date.now() - t0;
    await sleep(1000);
    const tLow = Date.now();
    await b.truth.setHealth(b.name, 5);
    const seen: string[] = [];
    await until(
      () => {
        const s = b.processes.stack().map((e) => `${e.name}:${e.state}`).join(' ');
        if (!seen.includes(s)) seen.push(s);
        return b.pve.behaviour() === 'fleeing' ? true : undefined;
      },
      5_000,
      'fleeing',
      20,
    );
    const fleeMs = Date.now() - tLow;
    const fleeStack = b.processes.stack().map((e) => `${e.name}:${e.state}`);
    expect(fleeStack[0]).toBe('flee:active');
    await until(async () => (hdist((await b.truth.pos(b.name)).location, centre(HOME)) < 2 ? true : undefined), 30_000, 'at home after the flight', 250);
    const homeMs = Date.now() - tLow;
    const alive = await b.truth.entity(mob.entityId);
    expect(alive.valid === false ? 0 : (alive.health ?? 0)).toBeGreaterThan(0);
    // health back: the guard fight resumes and kills the zombie once its resistance is gone
    await b.truth.setHealth(b.name, 20);
    const tAgain = Date.now();
    await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? true : undefined), 15_000, 'fight resumed', 50).catch((e: unknown) => {
      throw new Error(`${String(e)}; health ${b.pve.health()}, status ${JSON.stringify(b.pve.status())}, stack ${JSON.stringify(b.processes.stack())}`);
    });
    const againMs = Date.now() - tAgain;
    await until(async () => ((await b.truth.entity(mob.entityId)).valid === false ? true : undefined), 60_000, 'zombie dead', 250);
    const log = await b.truth.hurtlog(since);
    const taken = log.events.filter((h) => h.victimName === b.name).reduce((a, h) => a + h.damage, 0);
    const line =
      `flee vs fight: fight ${fightMs} ms after the summon; "fleeing" ${fleeMs} ms after health 5 (stack ${fleeStack.join(' ')}; seen ${seen.join(' | ')}); ` +
      `home (${hdist(start, HOME).toFixed(0)} blocks) ${homeMs} ms after health 5; fight again ${againMs} ms after health 20; zombie dead ${Date.now() - t0} ms after the summon; bot took ${taken.toFixed(1)}; flees ${b.pve.stats.flees}`;
    console.log(line);
    measurements.push(line);
    expect(b.metrics.snapshot().counters['process.flee.started']).toBeGreaterThanOrEqual(1);
    b.pve.setGuard({ on: false });
    await b.truth.cleanup();
  }, 150_000);

  it('with the reflex on, one zombie in reach at low health: the ground is held; two melee hits within 3 s and the bot runs', async () => {
    const b = bot!;
    expect(b.pve.settings.get('mobReflex')).toBe(true); // the default (ADR 0079 decision 26)
    await b.truth.setHealth(b.name, 20);
    const start = { x: HOME.x + 12, y: FEET_Y, z: HOME.z };
    await teleport(b, centre(start));
    b.pve.setGuard({ on: false });
    // the zombie of the case before: slow, harmless, immune for 16 s
    const mob = await b.truth.summon('zombie', { x: start.x + 0.5, y: FEET_Y, z: start.z + 4.5 });
    await b.truth.effect(mob.entityId, 'slowness', 120, 255);
    await b.truth.effect(mob.entityId, 'weakness', 120, 255);
    await b.truth.effect(mob.entityId, 'resistance', 16, 4);
    b.pve.setGuard({ on: true, radius: 16 });
    await until(() => (b.pve.behaviour().startsWith('fighting zombie') ? true : undefined), 10_000, 'guard fight', 50);
    await sleep(1000);
    const started0 = b.metrics.snapshot().counters['process.flee.started'] ?? 0;
    // health 5 (fleeHealth 8), one melee hit (the drop is laid on the zombie in reach): the bot holds the ground
    await b.truth.setHealth(b.name, 5);
    const held: string[] = [];
    const tLow = Date.now();
    let holdsSeen = false;
    while (Date.now() - tLow < HOLD_WATCH_MS) {
      const s = `${b.pve.behaviour()} [${b.processes.stack().map((e) => `${e.name}:${e.state}`).join(' ')}]`;
      if (!held.includes(s)) held.push(s);
      if (b.pve.health() < 8 && b.pve.holds(b.pve.position())) holdsSeen = true;
      expect(b.pve.behaviour(), `held: ${held.join(' | ')}`).not.toBe('fleeing');
      await sleep(20);
    }
    expect(holdsSeen, `held: ${held.join(' | ')}`).toBe(true);
    expect(b.processes.stack()[0]?.name).toBe('guard');
    expect(b.metrics.snapshot().counters['process.flee.started'] ?? 0).toBe(started0);
    // a second melee hit within 3 s of the first: the fist (here the blade) is not keeping it out, run (holdGround)
    const tHit = Date.now();
    await b.truth.setHealth(b.name, 4);
    await until(() => (b.pve.behaviour() === 'fleeing' ? true : undefined), 5_000, 'fleeing after the second hit', 20).catch((e: unknown) => {
      throw new Error(`${String(e)}; held: ${held.join(' | ')}; now ${b.pve.behaviour()}, health ${b.pve.health()}`);
    });
    const fleeMs = Date.now() - tHit;
    const fleeStack = b.processes.stack().map((e) => `${e.name}:${e.state}`);
    expect(fleeStack[0]).toBe('flee:active');
    expect(b.metrics.snapshot().counters['process.flee.started'] ?? 0).toBe(started0 + 1);
    // away from the zombie: past the hold's 8 blocks, where the stand no longer applies
    const away = await until(
      async () => {
        const [me, z] = await Promise.all([b.truth.pos(b.name), b.truth.entity(mob.entityId)]);
        const d = z.valid === false ? Infinity : hdist(me.location, z.location);
        return d > 8 ? d : undefined;
      },
      15_000,
      'more than 8 from the zombie',
      250,
    );
    const line =
      `hold vs flee (reflex on): held ${HOLD_WATCH_MS / 1000} s at health 5 with the zombie in reach (${held.join(' | ')}); ` +
      `"fleeing" ${fleeMs} ms after the second hit (stack ${fleeStack.join(' ')}); ${away === Infinity ? 'zombie gone' : `${away.toFixed(1)} blocks from it`}`;
    console.log(line);
    measurements.push(line);
    b.pve.setGuard({ on: false });
    await b.truth.cleanup();
  }, 90_000);
});

