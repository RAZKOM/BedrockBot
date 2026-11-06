// Track V (wave 7, docs/pve.md "Targeting") on fakes: reachability (within reach now, or standing on /
// at most 1.5 above a standable cell), flying mobs fought only within reach and ignored for 10 s after
// hitting us out of reach, the creeper rank, creepers not engaged below health 10 (wantsFlee), the
// ignore rules after a fight, and the guard process picking the reachable zombie over an unreachable
// phantom in the same tick.
import { describe, expect, it } from 'vitest';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { ignoreMsAfter, pickThreat, reachability, wantsFlee, type GridLike, type TargetingHost } from '../../../src/skills/combat/targeting.ts';
import { silentLogger } from '../../../src/log.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FlatGrid } from './combat-fakes.ts';
import { FakeSource, mob } from './pve-fakes.ts';

function host(ents: Map<bigint, EntityInfo>, opts: { me?: Vec3; health?: number; grid?: GridLike; home?: Vec3 } = {}) {
  const src = new FakeSource();
  const me = opts.me ?? { x: 0.5, y: -60, z: 0.5 };
  const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => me });
  src.emit('start_game', { entity_id: -42n });
  const h: TargetingHost & { src: FakeSource } = {
    src,
    mobs,
    ignore: new Map(),
    d: { world: { entities: ents }, home: () => opts.home },
    processes: { userProcesses: () => [] },
    guardRadius: 16,
    mover: { nav: { busy: false, ...(opts.grid ? { grid: opts.grid } : {}) } },
    log: silentLogger,
    health: () => opts.health ?? 20,
    position: () => me,
  };
  return h;
}

describe('reachability', () => {
  const me = { x: 0.5, y: -60, z: 0.5 };
  it('within reach now, on a standable cell, or not at all (flying, on a pillar top too high, mid-air)', () => {
    const g = new FlatGrid();
    expect(reachability(g, me, mob(2n, 'minecraft:zombie', { x: 0.5, y: -60, z: 2.5 }))).toBe('now');
    expect(reachability(g, me, mob(2n, 'minecraft:zombie', { x: 8.5, y: -60, z: 0.5 }))).toBe('cell');
    // a phantom 3 blocks up and 8 away: flying, out of reach
    expect(reachability(g, me, mob(3n, 'minecraft:phantom', { x: 8.5, y: -57, z: 0.5 }))).toBe(false);
    // the same phantom swooping into reach
    expect(reachability(g, me, mob(3n, 'minecraft:phantom', { x: 0.5, y: -59, z: 2 }))).toBe('now');
    // a zombie 4 blocks up in the air (not on anything)
    expect(reachability(g, me, mob(4n, 'minecraft:zombie', { x: 8.5, y: -56, z: 0.5 }))).toBe(false);
    // the same zombie on a 4-high pillar: standable
    for (let y = -60; y <= -57; y++) g.add(8, y, 0);
    expect(reachability(g, me, mob(4n, 'minecraft:zombie', { x: 8.5, y: -56, z: 0.5 }))).toBe('cell');
    // 8 blocks above: too high whatever it stands on
    expect(reachability(g, me, mob(5n, 'minecraft:zombie', { x: 8.5, y: -52, z: 0.5 }))).toBe(false);
    // no grid: benefit of the doubt
    expect(reachability(undefined, me, mob(4n, 'minecraft:zombie', { x: 8.5, y: -56, z: 0.5 }))).toBe('cell');
  });
});

describe('pickThreat', () => {
  it('picks the reachable zombie over an unreachable phantom that hit us, and ignores the phantom for 10 s', () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:phantom', { x: 0.5, y: -57, z: 4 }, { headYaw: 180, yaw: 180 })], // just flew out of reach
      [8n, mob(8n, 'minecraft:zombie', { x: 10.5, y: -60, z: 0.5 })],
    ]);
    const h = host(ents, { grid: new FlatGrid() });
    // the phantom targets us and hits us
    h.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'target_eid', value: -42n }] });
    h.src.emit('set_health', { health: 20 });
    h.src.emit('set_health', { health: 18 });
    expect(h.mobs.lastHitBy?.runtimeId).toBe(7n);
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(8n);
    expect((h.ignore.get(7n) ?? 0) - performance.now()).toBeGreaterThan(9_000);
  });

  it('a creeper within 6 blocks outranks the mob that hit us; below health 10 it is still first (to keep away) and wants a flight', () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: -60, z: 2.5 }, { headYaw: 180, yaw: 180 })],
      [8n, mob(8n, 'minecraft:creeper', { x: 5.5, y: -60, z: 0.5 })],
    ]);
    const h = host(ents);
    h.src.emit('set_health', { health: 20 });
    h.src.emit('set_health', { health: 17 });
    expect(h.mobs.lastHitBy?.runtimeId).toBe(7n);
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(8n);
    expect(wantsFlee(h, ents.get(8n)!)).toBe(false);
    const low = host(ents, { health: 8 });
    expect(pickThreat(low, low.position(), false)?.e.runtimeId).toBe(8n);
    expect(wantsFlee(low, ents.get(8n)!)).toBe(true);
    // in place (health below fleeHealth): creepers are never picked
    ents.get(8n)!.pos = { x: 0.5, y: -60, z: -2 };
    expect(pickThreat(low, low.position(), true)?.e.runtimeId).toBe(7n);
    // far creeper: no flight wanted
    ents.get(8n)!.pos = { x: 12.5, y: -60, z: 0.5 };
    expect(wantsFlee(low, ents.get(8n)!)).toBe(false);
    expect(wantsFlee(low, ents.get(7n)!)).toBe(false);
  });

  it('ignore rules after a fight', () => {
    expect(ignoreMsAfter('out_of_range')).toBe(10_000);
    expect(ignoreMsAfter('unreachable')).toBe(30_000); // Track AO: was 10 s
    expect(ignoreMsAfter('creeper_avoided')).toBe(0);
    expect(ignoreMsAfter('interrupted')).toBe(0);
    expect(ignoreMsAfter('killed')).toBe(0);
    expect(ignoreMsAfter('took_cover')).toBe(3_000);
    expect(ignoreMsAfter('timeout')).toBe(30_000);
  });
});

describe('pickThreat guard centre (Realm death 2026-11-05: idle 1400 blocks from home)', () => {
  const zombie = (): Map<bigint, EntityInfo> => new Map([[8n, mob(8n, 'minecraft:zombie', { x: 4.5, y: -60, z: 0.5 })]]);
  it('watches home while the bot idles within the radius of home', () => {
    // home 10 blocks east of the bot: the zombie 4 west of home... is 6 from home: fought
    expect(pickThreat(host(zombie(), { home: { x: 10, y: -60, z: 0 } }), { x: 0.5, y: -60, z: 0.5 }, false)?.e.runtimeId).toBe(8n);
    // home 12 east, the bot 12 west of home: a mob 20 from home but next to the bot... is out of the home radius
    const far = new Map([[9n, mob(9n, 'minecraft:zombie', { x: -6.5, y: -60, z: 0.5 })]]);
    expect(pickThreat(host(far, { home: { x: 12, y: -60, z: 0 } }), { x: 0.5, y: -60, z: 0.5 }, false)).toBeUndefined();
  });
  it('watches the bot itself when it idles far from home', () => {
    const h = host(zombie(), { home: { x: 183, y: -60, z: -1440 } });
    expect(pickThreat(h, { x: 0.5, y: -60, z: 0.5 }, false)?.e.runtimeId).toBe(8n);
  });
});
