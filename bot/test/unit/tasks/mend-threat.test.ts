// Track K5 (ADR 0110, docs/survival.md "Mending (Track K5)"): which hostiles stop a Mending hold (tasks/mend-threat.ts).
// A hostile within 16 used to stop every hold; at a home by a lake that was every hour. Now only one that can hurt the
// bot during the hold does: a hit, strike reach, a lit creeper, a shooter with a line, a walker with a path within what it
// walks in the hold. On fakes: a real MobTracker over no packets, a grid with walls, a path probe that answers as told.
import { describe, expect, it } from 'vitest';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import type { PathVerdict } from '../../../src/skills/combat/pathReach.ts';
import type { GridLike } from '../../../src/skills/combat/targeting.ts';
import { HOLD_MAX_TICKS } from '../../../src/tasks/mend-hand.ts';
import { holdThreat, nearHostile, walkBound, walkThreat, type HoldThreatDeps } from '../../../src/tasks/mend-threat.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';

const me: Vec3 = { x: 0.5, y: 64, z: 0.5 };
let nextId = 1n;
const mob = (type: string, x: number, z = 0.5, y = 64): EntityInfo => ({ runtimeId: nextId++, type: `minecraft:${type}`, pos: { x, y, z } }) as EntityInfo;

/** A grid with solid cells at `walls` ("x,y,z"); every other cell open. */
const gridWith = (walls: Set<string>): GridLike => ({
  stand: () => 64,
  cls: (x, y, z) => (walls.has(`${x},${y},${z}`) ? ({ boxes: [{}], top: 1, leaves: false } as unknown as ReturnType<GridLike['cls']>) : ({ boxes: [], top: 0, leaves: false } as unknown as ReturnType<GridLike['cls']>)),
});
/** A wall at x = 3 from z -10 to 10, y 64 to 66 (the room's side). */
const wallX3 = (): Set<string> => {
  const s = new Set<string>();
  for (let z = -10; z <= 10; z++) for (let y = 64; y <= 66; y++) s.add(`3,${y},${z}`);
  return s;
};

const rig = (ents: EntityInfo[], o: { verdict?: (e: EntityInfo) => PathVerdict | 'pending' | 'none'; old?: PathVerdict; walls?: Set<string>; noPath?: boolean } = {}) => {
  const map = new Map(ents.map((e) => [e.runtimeId, e]));
  const mobs = new MobTracker({ on: () => () => undefined }, { entities: () => map, selfRuntimeId: () => 0n, selfPos: () => me });
  const asked: bigint[] = [];
  const d: HoldThreatDeps = {
    entities: () => map,
    mobs,
    grid: () => gridWith(o.walls ?? new Set()),
    path: () =>
      o.noPath
        ? undefined
        : {
            lookup: (e) => {
              asked.push(e.runtimeId);
              return o.verdict ? o.verdict(e) : { ok: false, reason: 'no path' };
            },
            peek: () => o.old,
          },
  };
  return { d, mobs, asked, map };
};

describe('the hold rule (holdThreat)', () => {
  it('the walk bounds for a 70-tick hold: zombie 11.2, spider 14.6, creeper 11, enderman 24.4 path blocks', () => {
    expect(walkBound('minecraft:zombie', false, HOLD_MAX_TICKS)).toBeCloseTo(11.2);
    expect(walkBound('minecraft:spider', false, HOLD_MAX_TICKS)).toBeCloseTo(14.6);
    expect(walkBound('minecraft:creeper', false, HOLD_MAX_TICKS)).toBeCloseTo(11);
    expect(walkBound('minecraft:enderman', false, HOLD_MAX_TICKS)).toBeCloseTo(24.4);
    expect(walkBound('minecraft:zombie', true, HOLD_MAX_TICKS)).toBeCloseTo(16.8);
  });

  it("the Realm's case: drowned in a lake beside a walled room, no path to the bot: no threat (the old rule said 3 within 16)", () => {
    const ents = [mob('drowned', 6.5, 4.5, 62), mob('drowned', 9.5, -3.5, 62), mob('drowned', 10.5, 0.5, 62), mob('zombie', 20.5)];
    const r = rig(ents, { walls: wallX3() });
    expect(holdThreat(r.d, me, HOLD_MAX_TICKS)).toBeUndefined();
    expect(nearHostile(r.d, me, 16)).toMatch(/^a drowned \d+ blocks off \(within 16\)$/);
    // every walker within its bound was asked for its way; the zombie 20 off is past its bound and not probed
    expect(r.asked.length).toBe(3);
  });

  it('a walker with a path within its bound is a threat; a longer path or past the bound is not', () => {
    const z = mob('zombie', 8.5);
    expect(holdThreat(rig([z], { verdict: () => ({ ok: true, blocks: 9 }) }).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 8 blocks off with a clear way to me (9 path blocks)');
    expect(holdThreat(rig([mob('zombie', 8.5)], { verdict: () => ({ ok: true, blocks: 30 }) }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    expect(holdThreat(rig([mob('zombie', 13.5)], { verdict: () => ({ ok: true, blocks: 13 }) }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    // a spider walks farther in the same hold
    expect(holdThreat(rig([mob('spider', 13.5)], { verdict: () => ({ ok: true, blocks: 14 }) }).d, me, HOLD_MAX_TICKS)?.why).toMatch(/^a spider 13 blocks off with a clear way/);
    // a short hold: the bound shrinks with the ticks
    expect(holdThreat(rig([mob('zombie', 8.5)], { verdict: () => ({ ok: true, blocks: 9 }) }).d, me, 20)).toBeUndefined();
  });

  it('strike reach with a line, whatever the path; behind a wall in reach: not a threat', () => {
    expect(holdThreat(rig([mob('zombie', 2.5)]).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 2 blocks off in strike reach');
    expect(holdThreat(rig([mob('zombie', 4.5)], { walls: wallX3() }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
  });

  it('a shooter within 16 with a line on the bot is a threat; behind a wall, or past 16, not', () => {
    expect(holdThreat(rig([mob('skeleton', 12.5)]).d, me, HOLD_MAX_TICKS)?.why).toBe('a skeleton 12 blocks off with a line on me');
    expect(holdThreat(rig([mob('witch', 10.5)]).d, me, HOLD_MAX_TICKS)?.why).toBe('a witch 10 blocks off with a line on me');
    expect(holdThreat(rig([mob('skeleton', 12.5)], { walls: wallX3() }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    expect(holdThreat(rig([mob('skeleton', 20.5)]).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    // a drowned that holds something (a trident) shoots
    const dr = mob('drowned', 12.5);
    const r = rig([dr]);
    r.mobs.mobs.set(dr.runtimeId, { runtimeId: dr.runtimeId, health: 20, maxHealth: 20, ignited: false, targetUid: undefined, lastHurtAt: undefined, lastHurtData: undefined, hurts: 0, dead: false, heldNetworkId: 555 });
    expect(holdThreat(r.d, me, HOLD_MAX_TICKS)?.why).toBe('a drowned 12 blocks off with a line on me');
  });

  it('a mob that hit the bot in the last 10 s, wherever it stands; a lit creeper within 8; a dead mob never', () => {
    const z = mob('zombie', 14.5);
    const r = rig([z], { walls: wallX3() });
    r.mobs.hitAt.set(z.runtimeId, performance.now());
    expect(holdThreat(r.d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 14 blocks off hit me in the last 10 s');
    const c = mob('creeper', 6.5);
    const rc = rig([c], { walls: wallX3() });
    rc.mobs.mobs.set(c.runtimeId, { runtimeId: c.runtimeId, health: 20, maxHealth: 20, ignited: true, targetUid: undefined, lastHurtAt: undefined, lastHurtData: undefined, hurts: 0, dead: false });
    expect(holdThreat(rc.d, me, HOLD_MAX_TICKS)?.why).toBe('a creeper 6 blocks off with its fuse lit');
    const dz = mob('zombie', 2.5);
    const rd = rig([dz]);
    rd.mobs.mobs.set(dz.runtimeId, { runtimeId: dz.runtimeId, health: 0, maxHealth: 20, ignited: false, targetUid: undefined, lastHurtAt: undefined, lastHurtData: undefined, hurts: 0, dead: true });
    expect(holdThreat(rd.d, me, HOLD_MAX_TICKS)).toBeUndefined();
  });

  it('a probe still running: a threat (pending) within 6 only; no probes at all: every walker within its bound counts', () => {
    const near = holdThreat(rig([mob('zombie', 5.5)], { verdict: () => 'pending', walls: wallX3() }).d, me, HOLD_MAX_TICKS);
    expect(near).toMatchObject({ pending: true, why: 'a zombie 5 blocks off, its way to me not known yet' });
    expect(holdThreat(rig([mob('zombie', 9.5)], { verdict: () => 'pending', walls: wallX3() }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    // a sure threat behind a pending one wins
    const both = holdThreat(rig([mob('zombie', 6.0), mob('skeleton', 12.5)], { verdict: () => 'pending' }).d, me, HOLD_MAX_TICKS);
    expect(both).toMatchObject({ pending: false, why: 'a skeleton 12 blocks off with a line on me' });
    expect(holdThreat(rig([mob('zombie', 9.5)], { noPath: true, walls: wallX3() }).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 9 blocks off (no way to tell its way to me)');
    expect(holdThreat(rig([mob('zombie', 9.5)], { verdict: () => 'none', walls: wallX3() }).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 9 blocks off (no way to tell its way to me)');
  });

  it('a probe running again for a mob that moved: one that had a path counts by its straight distance, one that had none still has none', () => {
    expect(holdThreat(rig([mob('zombie', 9.5)], { verdict: () => 'pending', old: { ok: true, blocks: 14 }, walls: wallX3() }).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 9 blocks off with a clear way to me (9 path blocks)');
    expect(holdThreat(rig([mob('drowned', 5.5)], { verdict: () => 'pending', old: { ok: false, reason: 'no path' }, walls: wallX3() }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    // a cached path counts 3 blocks shorter (the mob may have come that much nearer since it was found)
    expect(holdThreat(rig([mob('zombie', 9.5)], { verdict: () => ({ ok: true, blocks: 14 }) }).d, me, HOLD_MAX_TICKS)?.why).toBe('a zombie 9 blocks off with a clear way to me (14 path blocks)');
    expect(holdThreat(rig([mob('zombie', 9.5)], { verdict: () => ({ ok: true, blocks: 14.5 }) }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
  });

  it('a flying mob within its bound with a line is a threat; behind a roof or a wall, not', () => {
    expect(holdThreat(rig([mob('phantom', 10.5, 0.5, 70)]).d, me, HOLD_MAX_TICKS)?.why).toBe('a phantom 12 blocks off flying, with a line on me');
    expect(holdThreat(rig([mob('phantom', 10.5, 0.5, 65)], { walls: wallX3() }).d, me, HOLD_MAX_TICKS)).toBeUndefined();
  });

  it('players and passive mobs are never threats', () => {
    const p = { runtimeId: 99n, type: 'minecraft:player', username: 'someone', pos: { x: 1.5, y: 65.62, z: 0.5 } } as EntityInfo;
    expect(holdThreat(rig([p, mob('cow', 1.5)]).d, me, HOLD_MAX_TICKS)).toBeUndefined();
    expect(nearHostile(rig([p, mob('cow', 1.5)]).d, me, 16)).toBeUndefined();
  });
});

describe('Track K6: the walk to orbs that lie with hostiles near (walkThreat)', () => {
  // the hold and the walk: 70 + 100 ticks; the orbs 5 blocks off on the open side (x -4.5)
  const T = HOLD_MAX_TICKS + 100;
  const orb: Vec3 = { x: -4.5, y: 64, z: 0.5 };

  it('the walk bound over hold and walk: a zombie 23.2 path blocks (it is 11.2 for the hold alone)', () => {
    expect(walkBound('minecraft:zombie', false, T)).toBeCloseTo(23.2, 1);
  });

  it("the Realm's case: drowned behind the wall with no path: the walk is made", () => {
    const ents = [mob('drowned', 6.5, 4.5, 62), mob('drowned', 9.5, -3.5, 62), mob('drowned', 10.5, 0.5, 62)];
    const r = rig(ents, { walls: wallX3() });
    expect(nearHostile(r.d, me, 16)).toBeDefined();
    expect(walkThreat(r.d, me, orb, T, 16)).toBeUndefined();
  });

  it('a walker with a path within its bound stops the walk; one past the bound in path blocks does not', () => {
    expect(walkThreat(rig([mob('zombie', 12.5)], { verdict: () => ({ ok: true, blocks: 14 }) }).d, me, orb, T, 16)?.why).toBe('a zombie 12 blocks off with a clear way to me (14 path blocks)');
    expect(walkThreat(rig([mob('zombie', 12.5)], { verdict: () => ({ ok: true, blocks: 40 }) }).d, me, orb, T, 16)).toBeUndefined();
  });

  it('a mob near the orbs counts though it is past 16 of the bot; one past 16 of both is not looked at', () => {
    const z = mob('zombie', -19.5);
    expect(walkThreat(rig([z], { verdict: () => ({ ok: true, blocks: 21 }) }).d, me, orb, T, 16)?.why).toMatch(/^a zombie 20 blocks off with a clear way/);
    expect(walkThreat(rig([mob('zombie', 30.5)], { verdict: () => ({ ok: true, blocks: 31 }) }).d, me, orb, T, 16)).toBeUndefined();
  });

  it('a shooter with a line on the bot or on the orbs stops it, at any distance within 16; behind the wall it does not', () => {
    expect(walkThreat(rig([mob('skeleton', 14.5)]).d, me, orb, T, 16)?.why).toBe('a skeleton 14 blocks off with a line on me or the orbs');
    expect(walkThreat(rig([mob('skeleton', 12.5)], { walls: wallX3() }).d, me, orb, T, 16)).toBeUndefined();
  });

  it('strike reach of the orbs, a hit, a lit creeper: each stops the walk', () => {
    expect(walkThreat(rig([mob('zombie', -6.5)], { walls: wallX3() }).d, me, orb, T, 16)?.why).toBe('a zombie 7 blocks off in strike reach of me or the orbs');
    const z = mob('zombie', 14.5);
    const r = rig([z], { walls: wallX3() });
    r.mobs.hitAt.set(z.runtimeId, performance.now());
    expect(walkThreat(r.d, me, orb, T, 16)?.why).toBe('a zombie 14 blocks off hit me in the last 10 s');
    const c = mob('creeper', 7.5);
    const rc = rig([c], { walls: wallX3() });
    rc.mobs.mobs.set(c.runtimeId, { runtimeId: c.runtimeId, health: 20, maxHealth: 20, ignited: true, targetUid: undefined, lastHurtAt: undefined, lastHurtData: undefined, hurts: 0, dead: false });
    expect(walkThreat(rc.d, me, orb, T, 16)?.why).toBe('a creeper 7 blocks off with its fuse lit');
  });

  it('a way not known: no probes at all stops it; a probe running is pending, unless the old verdict was no path', () => {
    expect(walkThreat(rig([mob('zombie', 9.5)], { noPath: true, walls: wallX3() }).d, me, orb, T, 16)?.why).toBe('a zombie 9 blocks off (no way to tell its way to me)');
    expect(walkThreat(rig([mob('zombie', 12.5)], { verdict: () => 'pending', walls: wallX3() }).d, me, orb, T, 16)).toMatchObject({ pending: true });
    expect(walkThreat(rig([mob('zombie', 12.5)], { verdict: () => 'pending', old: { ok: true, blocks: 30 }, walls: wallX3() }).d, me, orb, T, 16)).toMatchObject({ pending: true });
    expect(walkThreat(rig([mob('drowned', 9.5)], { verdict: () => 'pending', old: { ok: false, reason: 'no path' }, walls: wallX3() }).d, me, orb, T, 16)).toBeUndefined();
  });
});