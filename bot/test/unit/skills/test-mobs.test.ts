// Track M1: `!test mobs` (skills/test/mobs.ts) on fakes: the arguments, the commands it sends (summons with the series' name
// tag, the removal of that tag only), the refusal near home, a run that clears, a death, and `!test stop` removing the mobs.
import { describe, expect, it } from 'vitest';
import { MOB_SETS, MOBS_MIN_HOME, MobSeries, mobRunLine, mobSummaryLine, parseMobsArgs, removeCommand, summonCommand, type MobSeriesPorts } from '../../../src/skills/test/mobs.ts';
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
