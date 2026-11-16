// Track V1 follow-up 3 (ADR 0090 decision 13): a drop stays dropped. The bot's own throws matched to its drop requests
// (by entity id: time, place and item), the throw's direction (a free one, not into a wall), and the walk out of reach.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setThrown, THROW_AWAY_R, throwAway, throwDirection, thrownFor, ThrownItems, THROWN_KEEP_MS, THROWN_MATCH_MS } from '../../../src/skills/inventory/thrown.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';

const ent = (id: bigint, name: string, count: number, pos: Vec3, type = 'minecraft:item'): EntityInfo => ({
  runtimeId: id,
  uniqueId: id,
  type,
  ...(type === 'minecraft:item' ? { item: { name, networkId: 1, count, metadata: 0 } } : {}),
  pos,
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  headYaw: 0,
  onGround: false,
  updatedAt: 0,
});
const feet = { x: 10.5, y: 64, z: 10.5 };

describe('ThrownItems: the bot\'s own throws by entity id', () => {
  it('an item spawned at the body within the match window after the announced drop is the throw', () => {
    let t = 0;
    const th = new ThrownItems({ position: () => feet, now: () => t });
    th.expect('minecraft:cobblestone', 128);
    t = 150;
    th.added(ent(1n, 'cobblestone', 64, { x: 10.6, y: 65.3, z: 10.4 }));
    th.added(ent(2n, 'cobblestone', 64, { x: 10.5, y: 65.3, z: 10.5 }));
    th.added(ent(3n, 'cobblestone', 64, { x: 10.5, y: 65.3, z: 10.5 })); // more than announced: not ours
    expect([th.has(1n), th.has(2n), th.has(3n)]).toEqual([true, true, false]);
    t = 150 + THROWN_KEEP_MS;
    expect(th.has(1n)).toBe(false);
  });

  it('not the throw: another item, one spawned away from the body (a dig, a mob\'s drop), one too late, a mob', () => {
    let t = 0;
    const th = new ThrownItems({ position: () => feet, now: () => t });
    th.expect('rotten_flesh', 10);
    th.added(ent(1n, 'bone', 2, { x: 10.5, y: 65.3, z: 10.5 }));
    th.added(ent(2n, 'rotten_flesh', 1, { x: 13.5, y: 64.2, z: 10.5 })); // a zombie killed 3 blocks out
    th.added(ent(3n, 'rotten_flesh', 1, { x: 10.5, y: 67.5, z: 10.5 })); // a block broken over the head
    th.added(ent(4n, 'zombie', 1, { x: 10.5, y: 65, z: 10.5 }, 'minecraft:zombie'));
    t = THROWN_MATCH_MS + 1;
    th.added(ent(5n, 'rotten_flesh', 10, { x: 10.5, y: 65.3, z: 10.5 }));
    expect([1n, 2n, 3n, 4n, 5n].map((i) => th.has(i))).toEqual([false, false, false, false, false]);
  });

  it('registered under the inventory model (one per bot), the collector reads it there (BotSkills.collect)', () => {
    const inv = {};
    const th = new ThrownItems({ position: () => feet });
    setThrown(inv, th);
    expect(thrownFor(inv)).toBe(th);
    setThrown(inv, undefined);
    expect(thrownFor(inv)).toBeUndefined();
    const skills = readFileSync(new URL('../../../src/skills/index.ts', import.meta.url), 'utf8');
    expect(skills).toMatch(/ignore: \(id\) => thrownFor\(inventory\)\?\.has\(id\)/);
    const kit = readFileSync(new URL('../../../src/skills/survival/index.ts', import.meta.url), 'utf8');
    expect(kit).toMatch(/entityTracker\.onAdd\(\(e\) => t\.added\(e\)\)/);
    const home = readFileSync(new URL('../../../src/chat/commands-home.ts', import.meta.url), 'utf8');
    expect(home).toMatch(/drop: async \(name, count\) => \{[\s\S]{0,300}throwAway\(/);
  });
});

describe('throwDirection: away from walls', () => {
  it('a free direction whose back is free too; none in a 1-wide tunnel end', () => {
    const wallEast = (p: Vec3) => p.x >= 12; // a wall 2 blocks east
    const d = throwDirection(wallEast, feet)!;
    expect(d.x).toBeLessThanOrEqual(0);
    const open = throwDirection(() => false, feet)!;
    expect(open).toEqual({ x: 1, z: 0 });
    // walled in on every side but west, west's back (east) blocked: west still chosen
    const pocket = (p: Vec3) => !(p.z === 10 && p.x <= 10);
    expect(throwDirection(pocket, feet)).toEqual({ x: -1, z: 0 });
    expect(throwDirection(() => true, feet)).toBeUndefined();
    expect(throwDirection(() => undefined, feet)).toBeUndefined(); // not loaded: never thrown into
  });
});

describe('throwAway: face, drop, walk out of reach', () => {
  const setUp = (landAt: Vec3 | undefined) => {
    let t = 0;
    let pos = { ...feet };
    const ents = new Map<bigint, EntityInfo>();
    const th = new ThrownItems({ position: () => pos, now: () => t });
    const calls: string[] = [];
    const gotos: NavGoal[] = [];
    const deps = {
      position: () => pos,
      solidAt: (p: Vec3) => p.y < 64,
      lookAt: (p: Vec3) => {
        calls.push(`look ${Math.sign(p.x - feet.x)},${Math.sign(p.z - feet.z)} up ${(p.y - feet.y).toFixed(2)}`);
        return Promise.resolve();
      },
      waitTicks: (n: number) => {
        t += n * 50;
        return Promise.resolve();
      },
      drop: () => {
        calls.push('drop');
        th.expect('cobblestone', 64);
        const e = ent(9n, 'cobblestone', 64, { x: pos.x, y: pos.y + 1.3, z: pos.z });
        ents.set(9n, e);
        th.added(e);
        if (landAt) e.pos = landAt;
        return Promise.resolve({ ok: true, dropped: 64 });
      },
      thrown: () => th,
      entities: () => ents,
      goto: (g: NavGoal) => {
        gotos.push(g);
        pos = { x: feet.x - 5, y: feet.y, z: feet.z };
        return Promise.resolve({ ok: true as const });
      },
    };
    return { deps, calls, gotos, ents };
  };

  it('looks up into a free direction before the drop and walks away from stacks that landed in reach', async () => {
    const s = setUp({ x: feet.x + 1.2, y: 64.1, z: feet.z });
    const r = await throwAway(s.deps);
    expect(s.calls).toEqual(['look 1,0 up 2.82', 'drop']);
    expect(r).toMatchObject({ ok: true, dropped: 64, seen: 1, away: 'ok' });
    const g = s.gotos[0]!;
    expect(g.type).toBe('runAway');
    if (g.type === 'runAway') {
      expect(g.r).toBe(THROW_AWAY_R);
      expect(typeof g.from === 'function' ? g.from() : g.from).toEqual([{ x: feet.x + 1.2, y: 64.1, z: feet.z }]);
    }
  });

  it('no walk when the throw carried them out of reach', async () => {
    const s = setUp({ x: feet.x + 3.6, y: 64.1, z: feet.z });
    const r = await throwAway(s.deps);
    expect(r).toMatchObject({ dropped: 64, seen: 1 });
    expect(r.away).toBeUndefined();
    expect(s.gotos).toEqual([]);
  });
});
