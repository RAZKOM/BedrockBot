// Track AO (wave 9, docs/pve.md "Path-reachable targets", decision 0036) on fakes and a generated flat
// world: the line of sight for "within reach", the probe plan to a mob (pathReach.ts: a glass box, a
// long wall with a detour, the open), the guard pick with the path rule (ignored for 30 s with a
// reason, the next candidate in the same evaluation, waiting while a better one is probed, one probe
// for a crowd), the restraint while a user process walks (guardWhileWalking), a hit clearing the
// ignore, the combat skill's fast failure (one failed approach, the stall watchdog) and the settings.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { CombatController } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { mobGoal, PathReach, pathVerdict, type PathVerdict } from '../../../src/skills/combat/pathReach.ts';
import { afterFight, lineOfSight, parseWalkRule, PATH_IGNORE_MS, pickThreat, userWalking, type IgnoreNote, type TargetingHost, type WalkRule } from '../../../src/skills/combat/targeting.ts';
import { probePath, type ProbeNav } from '../../../src/skills/home/reach.ts';
import { NavGrid } from '../../../src/skills/nav/index.ts';
import { silentLogger } from '../../../src/log.ts';
import type { EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FlatGrid } from './combat-fakes.ts';
import { flatGen } from './genworld.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const F = -60;
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A fake probe source: verdicts by runtime id; counts the lookups that started a probe. */
class FakeReach {
  verdicts = new Map<bigint, PathVerdict | 'pending'>();
  started: bigint[] = [];
  lookup(e: EntityInfo): PathVerdict | 'pending' | 'none' {
    const v = this.verdicts.get(e.runtimeId);
    if (v === undefined || v === 'pending') {
      if (!this.started.includes(e.runtimeId)) this.started.push(e.runtimeId);
      return 'pending';
    }
    return v;
  }
}

function host(ents: Map<bigint, EntityInfo>, opts: { me?: Vec3; grid?: FlatGrid; walking?: string[]; rule?: WalkRule; reach?: number; pr?: FakeReach | PathReach | undefined } = {}) {
  const src = new FakeSource();
  const me = opts.me ?? { x: 0.5, y: F, z: 0.5 };
  const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => me });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
  const ignoreWhy = new Map<bigint, IgnoreNote>();
  const h: TargetingHost & { src: FakeSource; ignoreWhy: Map<bigint, IgnoreNote> } = {
    src,
    mobs,
    ignore: new Map(),
    ignoreWhy,
    d: { world: { entities: ents }, home: () => undefined },
    processes: { userProcesses: () => (opts.walking ?? []).map((name) => ({ name })) },
    guardRadius: 16,
    guardReach: opts.reach ?? 24,
    guardWhileWalking: opts.rule ?? 'near',
    ...(opts.pr ? { pathReach: opts.pr } : {}),
    mover: { nav: { busy: false, ...(opts.grid ? { grid: opts.grid } : {}) } },
    log: silentLogger,
    health: () => 20,
    position: () => me,
  };
  return h;
}

describe('line of sight (Track AO)', () => {
  it('glass between blocks it, a 1-block window does not', () => {
    const g = new FlatGrid();
    const eye = { x: 0.5, y: F + 1.62, z: 0.5 };
    const z = mob(7n, 'minecraft:zombie', { x: 0.5, y: F, z: 3.3 });
    expect(lineOfSight(g, eye, z)).toBe(true);
    for (let x = -3; x <= 3; x++) for (let y = F; y <= F + 2; y++) g.add(x, y, 2);
    expect(lineOfSight(g, eye, z)).toBe(false);
    g.solid.delete(`0,${F + 1},2`); // the window at head height
    expect(lineOfSight(g, eye, z)).toBe(true);
  });
});

describe('probe plans to a mob (pathReach.ts)', () => {
  const navOf = (grid: NavGrid): ProbeNav => ({ grid, planOptions: () => ({}) });
  const ME: Vec3 = { x: 0.5, y: F, z: 0.5 };

  it('the open: found, about the straight distance; a glass box: no path; a long glass wall: a detour too long for guardReach', async () => {
    const gen = flatGen();
    const open = await probePath(navOf(new NavGrid(gen)), mobGoal({ x: 6.5, y: F, z: 0.5 }), ME);
    const vOpen = pathVerdict(open!);
    expect(vOpen.ok).toBe(true);
    if (vOpen.ok) expect(vOpen.blocks).toBeLessThan(6);
    // a zombie in a 3-high glass box 4 blocks away (the e2e wall test with the way round closed)
    gen.fill({ x: -1, y: F, z: 3 }, { x: 1, y: F + 2, z: 5 }, 'glass');
    gen.put(0, F, 4, 'air');
    gen.put(0, F + 1, 4, 'air');
    const boxed = await probePath(navOf(new NavGrid(gen)), mobGoal({ x: 0.5, y: F, z: 4.5 }), ME);
    expect(pathVerdict(boxed!)).toMatchObject({ ok: false });
    // behind a 41-long glass wall: the way round is about 45 blocks
    gen.fill({ x: -20, y: F, z: 10 }, { x: 20, y: F + 2, z: 10 }, 'glass');
    const far = await probePath(navOf(new NavGrid(gen)), mobGoal({ x: 0.5, y: F, z: 12.5 }), { x: 0.5, y: F, z: 8.5 });
    const v = pathVerdict(far!);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.blocks).toBeGreaterThan(24);
    expect(far!.ms).toBeLessThan(300);
  });

  it('PathReach: one probe at a time, cached 5 s, again when the mob moved more than 3 blocks; no navigator = none', async () => {
    const gen = flatGen();
    let probes = 0;
    const pr = new PathReach({
      nav: () => navOf(new NavGrid(gen)),
      probe: (n, g, f) => {
        probes++;
        return probePath(n, g, f);
      },
    });
    const a = mob(7n, 'minecraft:zombie', { x: 5.5, y: F, z: 0.5 });
    const b = mob(8n, 'minecraft:zombie', { x: -5.5, y: F, z: 0.5 });
    expect(pr.lookup(a, ME)).toBe('pending');
    expect(pr.lookup(b, ME)).toBe('pending'); // a's probe runs: b waits
    expect(pr.probing).toBe(true);
    for (let i = 0; i < 20 && pr.probing; i++) await flush();
    expect(pr.lookup(a, ME)).toMatchObject({ ok: true });
    expect(pr.lookup(a, ME)).toMatchObject({ ok: true });
    expect(probes).toBe(1);
    expect(pr.stats.probes).toBe(1);
    a.pos = { x: 9.5, y: F, z: 0.5 }; // moved 4 blocks
    expect(pr.lookup(a, ME)).toBe('pending');
    expect(probes).toBe(2);
    expect(new PathReach({ nav: () => undefined }).lookup(a, ME)).toBe('none');
  });
});

describe('guard pick with the path rule (Track AO)', () => {
  it('no path: ignored for 30 s with the reason, the next candidate picked in the same evaluation', () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: F, z: 4.5 })], // nearer, behind glass
      [8n, mob(8n, 'minecraft:zombie', { x: 9.5, y: F, z: 0.5 })],
    ]);
    const pr = new FakeReach();
    pr.verdicts.set(7n, { ok: false, reason: 'no path' });
    pr.verdicts.set(8n, { ok: true, blocks: 9 });
    const h = host(ents, { grid: new FlatGrid(), pr });
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(8n);
    expect((h.ignore.get(7n) ?? 0) - performance.now()).toBeGreaterThan(PATH_IGNORE_MS - 1000);
    expect(h.ignoreWhy.get(7n)?.reason).toBe('no path');
    // too long for guardReach: ignored with the length
    pr.verdicts.set(8n, { ok: true, blocks: 30 });
    h.ignore.clear();
    pr.verdicts.set(7n, { ok: false, reason: 'no path' });
    expect(pickThreat(h, h.position(), false)).toBeUndefined();
    expect(h.ignoreWhy.get(8n)?.reason).toBe('path 30 blocks > guardReach 24');
  });

  it('waits while the better candidate is probed (only mobs within reach meanwhile); a crowd of 10 starts one probe', () => {
    const ents = new Map<bigint, EntityInfo>();
    for (let i = 0; i < 10; i++) ents.set(BigInt(10 + i), mob(BigInt(10 + i), 'minecraft:zombie', { x: 6.5 + i, y: F, z: 0.5 }));
    const pr = new FakeReach();
    const h = host(ents, { grid: new FlatGrid(), pr });
    expect(pickThreat(h, h.position(), false)).toBeUndefined();
    expect(pr.started).toEqual([10n]); // only the best-ranked one is probed
    pr.verdicts.set(11n, { ok: true, blocks: 7 });
    expect(pickThreat(h, h.position(), false)).toBeUndefined(); // 10 is still pending: no worse pick meanwhile
    // a zombie within reach is fought at once
    ents.set(30n, mob(30n, 'minecraft:zombie', { x: 0.5, y: F, z: 2.5 }));
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(30n);
  });

  it('within reach behind glass is no target without a path; guardReach 0 = the old terrain rule', () => {
    const g = new FlatGrid();
    for (let x = -3; x <= 3; x++) for (let y = F; y <= F + 2; y++) g.add(x, y, 2);
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: F, z: 3.3 })]]);
    const pr = new FakeReach();
    pr.verdicts.set(7n, { ok: false, reason: 'no path' });
    const h = host(ents, { grid: g, pr });
    expect(pickThreat(h, h.position(), false)).toBeUndefined();
    expect(h.ignoreWhy.get(7n)?.reason).toBe('no path');
    const old = host(ents, { grid: g, pr, reach: 0 });
    expect(pickThreat(old, old.position(), false)?.e.runtimeId).toBe(7n);
  });

  it('a mob that hit us after it was ignored is a target again', () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0.5, y: F, z: 2.5 }, { headYaw: 180, yaw: 180 })]]);
    const h = host(ents, { grid: new FlatGrid() });
    afterFight(h, ents.get(7n)!, { reason: 'unreachable' });
    expect(h.ignoreWhy.get(7n)?.reason).toBe('fight unreachable');
    expect(pickThreat(h, h.position(), false)).toBeUndefined();
    h.src.emit('set_health', { health: 17 });
    expect(h.mobs.lastHitBy?.runtimeId).toBe(7n);
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(7n);
    expect(h.ignore.has(7n)).toBe(false);
  });
});

describe('guard while a user process walks (guardWhileWalking)', () => {
  const ents = () =>
    new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 5.5, y: F, z: 0.5 })],
      [8n, mob(8n, 'minecraft:skeleton', { x: -5.5, y: F, z: 0.5 })],
    ]);

  it('near: a melee mob within 6 path blocks, an archer only when it aims at the bot; farther ones left alone, not ignored', () => {
    const e = ents();
    const pr = new FakeReach();
    pr.verdicts.set(7n, { ok: true, blocks: 5 });
    pr.verdicts.set(8n, { ok: true, blocks: 5 });
    const h = host(e, { grid: new FlatGrid(), pr, walking: ['goto'], rule: 'near' });
    expect(userWalking(h)).toBe(true);
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(7n);
    e.delete(7n);
    expect(pickThreat(h, h.position(), false)).toBeUndefined(); // the skeleton does not aim at us
    h.src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: -42n }] });
    expect(pickThreat(h, h.position(), false)?.e.runtimeId).toBe(8n);
    // a zombie whose path is 9 blocks (round a fence): left alone during the walk, not ignored
    const e2 = ents();
    pr.verdicts.set(7n, { ok: true, blocks: 9 });
    const h2 = host(e2, { grid: new FlatGrid(), pr, walking: ['come'], rule: 'near' });
    expect(pickThreat(h2, h2.position(), false)).toBeUndefined();
    expect(h2.ignore.size).toBe(0);
    // a zombie 12 blocks away: no probe at all
    const e3 = new Map<bigint, EntityInfo>([[9n, mob(9n, 'minecraft:zombie', { x: 12.5, y: F, z: 0.5 })]]);
    const pr3 = new FakeReach();
    const h3 = host(e3, { grid: new FlatGrid(), pr: pr3, walking: ['goto'], rule: 'near' });
    expect(pickThreat(h3, h3.position(), false)).toBeUndefined();
    expect(pr3.started).toEqual([]);
  });

  it('reach: within reach only; all: as idle (guardReach); a kill job or !pause is no walk', () => {
    const e = ents();
    const pr = new FakeReach();
    pr.verdicts.set(7n, { ok: true, blocks: 5 });
    const reach = host(e, { grid: new FlatGrid(), pr, walking: ['goto'], rule: 'reach' });
    expect(pickThreat(reach, reach.position(), false)).toBeUndefined();
    e.set(9n, mob(9n, 'minecraft:zombie', { x: 0.5, y: F, z: 2.5 }));
    expect(pickThreat(reach, reach.position(), false)?.e.runtimeId).toBe(9n);
    e.delete(9n);
    const all = host(e, { grid: new FlatGrid(), pr, walking: ['goto'], rule: 'all' });
    expect(pickThreat(all, all.position(), false)?.e.runtimeId).toBe(7n);
    expect(userWalking(host(e, { walking: ['kill'] }))).toBe(false);
    const held = host(e, { walking: ['goto'] });
    (held.processes as { paused?: boolean }).paused = true;
    expect(userWalking(held)).toBe(false);
  });
});

describe('fast failure in the combat skill (Track AO)', () => {
  const sword: ItemStack = { name: 'iron_sword', networkId: 309, count: 1, metadata: 0, stackId: 9 };
  function setup(entities: Map<bigint, EntityInfo>) {
    const src = new FakeSource();
    const loop = new FakeLoop();
    const mover = new FakeMover();
    const inv = { slots: Array.from({ length: 36 }, (_, i) => (i === 0 ? sword : null)), selected: 0 };
    const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
    src.emit('start_game', { entity_id: -42n });
    src.emit('set_health', { health: 20 });
    const combat = new CombatController({ loop, mover, entities: () => entities, mobs, inventory: inv, hotbar: { select: () => true, rawItem: () => undefined }, source: src, selfRuntimeId: () => 1n });
    return { src, loop, mover, combat };
  }

  it('one approach ending unreachable ends the fight (was 3)', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: F, z: 10 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(2);
    expect(s.mover.gotos).toHaveLength(1);
    s.mover.finish({ ok: false, reason: 'unreachable' });
    await flush();
    s.loop.step(1);
    expect((await fight).reason).toBe('unreachable');
  });

  it('the stall watchdog: no closer and no hit for 60 ticks ends the fight unreachable; getting closer keeps it going', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: F, z: 10 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    // the zombie walks up 0.6 blocks every 20 ticks for 100 ticks: progress
    let done = false;
    void fight.then(() => (done = true));
    for (let i = 0; i < 5; i++) {
      s.loop.step(20);
      ents.get(7n)!.pos.z -= 0.6;
    }
    await flush();
    expect(done).toBe(false);
    // then it stands (behind a fence, say): 60 ticks later the fight ends
    s.loop.step(61);
    const r = await fight;
    expect(r.reason).toBe('unreachable');
    expect(r.ticks).toBeLessThan(170);
  });
});

describe('settings (Track AO)', () => {
  it('guardReach 0..64 (default 24), guardWhileWalking reach|near|all (default near)', () => {
    const s = new RuntimeSettings();
    expect(s.get('guardReach')).toBe(24);
    expect(s.set('guardReach', '0')).toBe(0);
    expect(() => s.set('guardReach', '65')).toThrow();
    expect(s.get('guardWhileWalking')).toBe('near');
    expect(s.set('guardWhileWalking', 'REACH')).toBe('reach');
    expect(() => s.set('guardWhileWalking', 'sometimes')).toThrow();
    expect(parseWalkRule(' all ')).toBe('all');
    expect(() => parseWalkRule('x')).toThrow();
  });
});
