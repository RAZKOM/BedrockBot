// Track M1: `!test mobs` (skills/test/mobs.ts) on fakes: the arguments, the commands it sends (summons with the series' name
// tag, the removal of that tag only), the refusal near home, a run that clears, a death, and `!test stop` removing the mobs.
import { describe, expect, it } from 'vitest';
import { COUNT_EVERY_MS, countCommand, groundText, hasCreeper, testforCount, MOB_SETS, MOBS_MIN_HOME, MobSeries, mobRunLine, mobSummaryLine, parseMobsArgs, preflightRefusal, removeCommand, ringCells, ringGround, ruleAnswer, summonCommand, type MobSeriesPorts, type MobsSpec } from '../../../src/skills/test/mobs.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { mob } from './pve-fakes.ts';

describe('!test mobs arguments and commands', () => {
  it('a set, runs, seconds', () => {
    expect(parseMobsArgs(['mixed4', '3', '90s'])).toMatchObject({ set: 'mixed4', runs: 3, seconds: 90 });
    expect(parseMobsArgs(['zombie'])).toMatchObject({ set: 'zombie', runs: 1, seconds: 60 });
    expect(parseMobsArgs(['dragons'])).toHaveProperty('error');
    expect(parseMobsArgs([])).toHaveProperty('error');
    expect(parseMobsArgs(['zombie', '99'])).toHaveProperty('error');
    expect(parseMobsArgs(['zombie', '5s'])).toHaveProperty('error');
    expect(MOB_SETS.mixed8).toHaveLength(8);
  });

  it('summons relative to the bot with the name tag; removes only that tag', () => {
    expect(summonCommand({ type: 'zombie' }, 0, 4, 'm1tabc')).toMatch(/^\/summon zombie ~-?\d+\.\d ~0 ~-?\d+\.\d 0 0 minecraft:entity_spawned m1tabc$/);
    expect(summonCommand({ type: 'zombie', event: 'minecraft:as_baby' }, 1, 4, 'm1tabc')).toContain('minecraft:as_baby m1tabc');
    expect(summonCommand({ type: 'phantom', flying: true }, 0, 1, 't')).toContain(' ~10 ');
    expect(removeCommand('m1tabc')).toBe('/kill @e[name=m1tabc]');
  });
});

function fakePorts(o: { home?: Vec3; die?: boolean } = {}) {
  const ents = new Map<bigint, EntityInfo>();
  const dead = new Set<bigint>();
  const sent: string[] = [];
  let clock = 0;
  let deaths = 0;
  let rid = 100n;
  const hitFns = new Set<(d: number) => void>();
  const counters = { reflex: 0, taken: {} as Record<string, number>, floors: {} as Record<string, number> };
  const lines: string[] = [];
  const recs: object[] = [];
  const ports: MobSeriesPorts = {
    run: (cmd) => {
      sent.push(cmd);
      const m = /^\/summon (\S+) /.exec(cmd);
      if (m) {
        const r = rid++;
        ents.set(r, mob(r, `minecraft:${m[1]}`, { x: 3.5, y: -60, z: 0.5 }));
      }
      if (cmd.startsWith('/kill @e[name=')) for (const k of [...ents.keys()]) if (k >= 100n) ents.delete(k);
      return Promise.resolve({ ok: true });
    },
    restore: () => Promise.resolve({ ok: true, steps: [], commands: 0 }),
    position: () => ({ x: 0.5, y: -60, z: 0.5 }),
    home: () => o.home,
    health: () => 20,
    deaths: () => deaths,
    recovered: () => Promise.resolve(),
    entities: () => ents,
    dead: (r) => dead.has(r),
    counters: () => counters,
    onDamage: (fn) => {
      hitFns.add(fn);
      return () => hitFns.delete(fn);
    },
    say: (m) => lines.push(m),
    write: (r) => recs.push(r),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      // the bot fights: after 5 s every summoned mob is dead; one hit taken at 1 s
      if (clock === 1000) for (const fn of hitFns) fn(2.5);
      if (clock >= 1000) counters.reflex += 1;
      if (clock >= 5000) for (const k of ents.keys()) if (k >= 100n) dead.add(k);
      if (o.die && clock >= 2000 && deaths === 0) deaths = 1;
      return Promise.resolve();
    },
  };
  return { ports, sent, lines, recs, ents };
}

describe('!test mobs before the first run (Track M2)', () => {
  const answer = (v: string) => ({ ok: true, messageId: 'commands.gamerule.query', params: ['keepinventory', v] });
  it('reads a game rule from its answer', () => {
    expect(ruleAnswer(answer('true'))).toBe(true);
    expect(ruleAnswer(answer('false'))).toBe(false);
    expect(ruleAnswer({ ok: true, messageId: 'commands.gamerule.query', params: ['keepinventory = true'] })).toBe(true);
    expect(ruleAnswer({ ok: false, error: 'timeout' })).toBeUndefined();
    expect(ruleAnswer({ ok: false, messageId: 'commands.generic.permission.selector', params: [] })).toBeUndefined();
  });

  it('force is a word of the command', () => {
    expect(parseMobsArgs(['creeper4', '2', 'force'])).toMatchObject({ set: 'creeper4', runs: 2, force: true });
    expect(parseMobsArgs(['creeper4'])).not.toHaveProperty('force');
  });

  const flat = { standable: 16, slope: 0, of: 16 };
  const spec = (set: string, force = false): MobsSpec => ({ ...(parseMobsArgs([set]) as MobsSpec), force });
  it('refuses with keepInventory off or unknown', () => {
    expect(preflightRefusal(spec('zombie'), { keepInventory: false, mobGriefing: false, ground: flat })).toMatch(/keepInventory is off/);
    expect(preflightRefusal(spec('zombie'), { keepInventory: undefined, mobGriefing: false, ground: flat })).toMatch(/keepInventory is unknown/);
    expect(preflightRefusal(spec('zombie'), { keepInventory: true, mobGriefing: true, ground: flat })).toBeUndefined();
  });

  it('refuses a creeper set under mobGriefing unless forced', () => {
    for (const set of ['creeper', 'creeper4', 'mixed4', 'mixed8']) {
      expect(hasCreeper(spec(set))).toBe(true);
      expect(preflightRefusal(spec(set), { keepInventory: true, mobGriefing: true, ground: flat })).toMatch(/mobGriefing is on .* "force"/);
      expect(preflightRefusal(spec(set), { keepInventory: true, mobGriefing: undefined, ground: flat })).toMatch(/mobGriefing is unknown/);
      expect(preflightRefusal(spec(set, true), { keepInventory: true, mobGriefing: true, ground: flat })).toBeUndefined();
      expect(preflightRefusal(spec(set), { keepInventory: true, mobGriefing: false, ground: flat })).toBeUndefined();
    }
    expect(hasCreeper(spec('skeleton4'))).toBe(false);
  });

  it('refuses a ring of mostly unstandable ground', () => {
    const start = { x: 0, y: -60, z: 0 };
    // a wall on one side (x > 2): the points there are not standable
    const half = ringGround(start, (x) => x <= 2);
    expect(half.of).toBe(16);
    expect(half.standable).toBeGreaterThan(4);
    expect(half.standable).toBeLessThan(12);
    expect(preflightRefusal(spec('zombie'), { keepInventory: true, mobGriefing: false, ground: { standable: 7, slope: 0, of: 16 } })).toMatch(/not standable ground: rough \(7\/16 level\)/);
    expect(preflightRefusal(spec('zombie'), { keepInventory: true, mobGriefing: false, ground: { standable: 8, slope: 0, of: 16 } })).toBeUndefined();
    expect(preflightRefusal(spec('zombie'), { keepInventory: true, mobGriefing: false, ground: undefined })).toMatch(/not standable/);
    expect(ringGround(start, () => undefined).standable).toBe(0); // an unknown map is not ground
    expect(ringCells(start).every((c) => Math.abs(Math.hypot(c.x + 0.5 - 0.5, c.z + 0.5 - 0.5) - 7) < 1)).toBe(true);
  });

  it('Track M2: a hillside is a slope, said in the first line and refused (its mobs go downhill)', () => {
    const start = { x: 0, y: -60, z: 0 };
    // the ground falling 1 a block towards -z: standable at y = -60 + z for |z| small
    const hill = (x: number, y: number, z: number): boolean => y === -60 + Math.max(-6, Math.min(6, z));
    const g = ringGround(start, hill);
    expect(g.standable).toBeLessThan(8);
    expect(g.slope).toBeGreaterThan(0);
    expect(groundText(g)).toMatch(/^a slope \(\d+\/16 level, \d+ on other levels\)$/);
    expect(preflightRefusal(spec('zombie'), { keepInventory: true, mobGriefing: false, ground: g })).toMatch(/is a slope \(its mobs would go downhill\): a slope/);
    expect(groundText({ standable: 16, slope: 0, of: 16 })).toBe('flat (16/16 level)');
    expect(groundText({ standable: 12, slope: 3, of: 16 })).toBe('mostly flat (12/16 level, 3 on other levels)');
    expect(groundText(undefined)).toBe('unknown');
  });

  it('preflight asks the server and says what it found', async () => {
    const sent: string[] = [];
    const ports = { ...fakePorts().ports };
    ports.run = (cmd: string) => {
      sent.push(cmd);
      return Promise.resolve(cmd.includes('keepinventory') ? answer('true') : { ok: true, messageId: 'commands.gamerule.query', params: ['mobgriefing', 'true'] });
    };
    ports.standable = () => true;
    const s = new MobSeries(spec('creeper4'), ports, 'm1tp');
    const pf = await s.preflight();
    expect(sent).toEqual(['/gamerule keepinventory', '/gamerule mobgriefing']);
    expect(pf.line).toBe('keepInventory on, mobGriefing on, ground flat (16/16 level)');
    expect(pf.refusal).toMatch(/force/);
    const ok = await new MobSeries(spec('zombie4'), ports, 'm1tp').preflight();
    expect(ok.refusal).toBeUndefined();
  });
});

describe('MobSeries', () => {
  it('refuses closer than 150 blocks to home', () => {
    const f = fakePorts({ home: { x: 100, y: -60, z: 0 } });
    const s = new MobSeries(parseMobsArgs(['zombie']) as never, f.ports, 'm1tx');
    expect(s.refusal()).toMatch(new RegExp(`at least ${MOBS_MIN_HOME}`));
    const far = new MobSeries(parseMobsArgs(['zombie']) as never, fakePorts({ home: { x: 400, y: -60, z: 0 } }).ports, 'm1tx');
    expect(far.refusal()).toBeUndefined();
  });

  it('a run: summons the set, counts the damage, clears, removes its tag; the summary', async () => {
    const f = fakePorts();
    const s = new MobSeries(parseMobsArgs(['zombie4', '2']) as never, f.ports, 'm1tq');
    const sum = await s.run();
    expect(f.sent.filter((c) => c.startsWith('/summon zombie'))).toHaveLength(8);
    expect(f.sent.filter((c) => c === '/kill @e[name=m1tq]').length).toBeGreaterThanOrEqual(2);
    expect(f.sent.every((c) => !c.startsWith('/kill') || c === '/kill @e[name=m1tq]')).toBe(true);
    expect(sum).toMatchObject({ runs: 2, deaths: 0, cleared: 2, damage: [2.5, 0] });
    expect(f.lines[0]).toMatch(/^test mobs zombie4 run 1\/2: alive, damage 2.5 \(lowest 20\), hits none, cleared in 5 s, reflex \d+, floors none$/);
    expect(mobSummaryLine(sum)).toMatch(/^test mobs zombie4: 2\/2 runs, 0 deaths, cleared 2\/2, damage 2.5\/0 \(mean 1.3\), clear median 5 s/);
  });

  it('the hits and floors of a run from the live counters (the PvE controller hands out the same objects)', async () => {
    const f = fakePorts();
    const live = { reflex: 0, taken: { zombie: 2 } as Record<string, number>, floors: { backoff: 1 } as Record<string, number> };
    f.ports.counters = () => live;
    const ports0 = { ...f.ports };
    f.ports.sleep = async (ms) => {
      await ports0.sleep(ms);
      live.floors.fly = 1;
      live.taken.skeleton = 3;
    };
    const s = new MobSeries(parseMobsArgs(['skeleton']) as never, f.ports, 'm1tk');
    await s.run();
    expect(f.recs[0]).toMatchObject({ floors: { fly: 1 }, hits: { skeleton: 3 } });
    expect(mobRunLine(f.recs[0] as never)).toMatch(/hits skeleton 3, .*floors fly 1$/);
  });

  it('Track M4: a mob that left the bot\'s view is not cleared while the server still has it', async () => {
    expect(countCommand('m1tz')).toBe('/testfor @e[name=m1tz]');
    expect(testforCount({ ok: true, successCount: 3, messageId: 'commands.testfor.success', params: ['Zombie, Zombie, Zombie'] })).toBe(3);
    expect(testforCount({ ok: true, messageId: 'commands.testfor.success', params: ['m1tz, m1tz'] })).toBe(2);
    expect(testforCount({ ok: false, messageId: 'commands.generic.noTargetMatch', params: [] })).toBe(0);
    expect(testforCount({ ok: false, error: 'timeout' })).toBeUndefined();
    expect(testforCount({ ok: false, messageId: 'commands.generic.permission.selector' })).toBeUndefined();
    // the bot flies off at 2 s: every summoned mob leaves its entity list alive; the server keeps them all
    const f = fakePorts();
    const run0 = f.ports.run.bind(f.ports);
    let onServer = 0;
    f.ports.run = (cmd) => {
      if (cmd.startsWith('/summon')) onServer++;
      if (cmd.startsWith('/kill')) onServer = 0;
      if (cmd.startsWith('/testfor')) {
        f.sent.push(cmd);
        return Promise.resolve(onServer > 0 ? { ok: true, successCount: onServer, messageId: 'commands.testfor.success', params: [] } : { ok: false, messageId: 'commands.generic.noTargetMatch', params: [] });
      }
      return run0(cmd);
    };
    const sleep0 = f.ports.sleep.bind(f.ports);
    let t = 0;
    f.ports.sleep = async (ms) => {
      await sleep0(ms);
      t += ms;
      if (t >= 2000) for (const k of [...f.ents.keys()]) if (k >= 100n) f.ents.delete(k); // out of view (not dead)
    };
    const s = new MobSeries(parseMobsArgs(['zombie4', '20s']) as never, f.ports, 'm1tz');
    await s.run();
    const rec = f.recs[0] as { cleared: boolean; left: number; outOfSight?: number; end: string };
    expect(rec).toMatchObject({ cleared: false, left: 4, outOfSight: 4, end: 'timeout' });
    expect(f.lines[0]).toMatch(/4 left after 2\d(\.\d)? s \(4 out of sight\)/);
    // asked at most every COUNT_EVERY_MS while none was in sight (20 s: about 9 asks), not every poll
    const asks = f.sent.filter((c) => c.startsWith('/testfor')).length;
    expect(asks).toBeGreaterThanOrEqual(5);
    expect(asks).toBeLessThanOrEqual(20_000 / COUNT_EVERY_MS + 1);
  });

  it('Track M4: mobs gone from view that the server no longer has are cleared (by the server)', async () => {
    const f = fakePorts();
    const run0 = f.ports.run.bind(f.ports);
    f.ports.run = (cmd) => (cmd.startsWith('/testfor') ? Promise.resolve({ ok: false, messageId: 'commands.generic.noTargetMatch', params: [] }) : run0(cmd));
    const sleep0 = f.ports.sleep.bind(f.ports);
    let t = 0;
    f.ports.sleep = async (ms) => {
      await sleep0(ms);
      t += ms;
      if (t >= 2000) for (const k of [...f.ents.keys()]) if (k >= 100n) f.ents.delete(k);
    };
    const s = new MobSeries(parseMobsArgs(['zombie4']) as never, f.ports, 'm1ty');
    await s.run();
    expect(f.recs[0]).toMatchObject({ cleared: true, clearedBy: 'server', left: 0 });
    expect(f.lines[0]).toContain('(the server has none)');
  });

  it('a death ends the run `died`; stop removes the mobs at once', async () => {
    const f = fakePorts({ die: true });
    const s = new MobSeries(parseMobsArgs(['skeleton']) as never, f.ports, 'm1td');
    const sum = await s.run();
    expect(sum.deaths).toBe(1);
    expect(mobRunLine(f.recs[0] as never)).toContain('DIED');
    const g = fakePorts();
    const s2 = new MobSeries(parseMobsArgs(['skeleton', '3']) as never, g.ports, 'm1ts');
    s2.stop();
    expect(g.sent).toEqual(['/kill @e[name=m1ts]']);
  });
});
