// Track M1 (docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the reflex's guard tests on fakes.
// Who it may strike (never a player, a pet, a villager, a golem, a neutral mob the server does not say
// targets the bot, the warden), the order (a lit creeper, a mob that just hit us, then the one that can
// hit soonest), the hurt time (10 ticks per mob, a hurt from another strike), the line of sight, and the
// layer itself: strikes without touching the movement keys, at most 3 a tick, nothing while off.
import { describe, expect, it } from 'vitest';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { HURT_TICKS, MAX_PER_TICK, Reflex, REFLEX_REACH, reflexPicks, reflexTarget } from '../../../src/skills/combat/reflex.ts';
import type { EntityInfo, Vec3 } from '../../../src/world/types.ts';
import { FlatGrid } from './combat-fakes.ts';
import { FakeLoop, FakeSource, mob } from './pve-fakes.ts';

const F = -60;
const SELF_UID = -42n;

function setup(list: EntityInfo[], me: Vec3 = { x: 0.5, y: F, z: 0.5 }) {
  const ents = new Map<bigint, EntityInfo>(list.map((e) => [e.runtimeId, e]));
  const src = new FakeSource();
  let clock = 1000;
  const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => me, now: () => clock });
  src.emit('start_game', { entity_id: SELF_UID });
  src.emit('set_health', { health: 20 });
  for (const e of list) src.emit('add_entity', { runtime_id: e.runtimeId, attributes: [], metadata: [] });
  return {
    ents,
    src,
    mobs,
    me,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    targets: (rid: bigint) => src.emit('set_entity_data', { runtime_entity_id: rid, metadata: [{ key: 'target_eid', value: SELF_UID }] }),
    hurt: (rid: bigint) => src.emit('entity_event', { runtime_entity_id: rid, event_id: 'hurt_animation', data: 2 }),
    die: (rid: bigint) => src.emit('entity_event', { runtime_entity_id: rid, event_id: 'death_animation' }),
    ignite: (rid: bigint) => src.emit('set_entity_data', { runtime_entity_id: rid, metadata: [{ key: 'flags', value: { ignited: true } }] }),
  };
}

const at = (x: number, z = 0.5): Vec3 => ({ x, y: F, z });

describe('reflexTarget: who the reflex may strike at all', () => {
  it('never a player (by type or with a username), a villager, a cow, a pet wolf, an iron golem, the warden', () => {
    const list = [
      mob(2n, 'minecraft:player', at(2), { username: 'Someone' }),
      mob(3n, 'minecraft:zombie', at(2), { username: 'NamedLikeAZombie' }),
      mob(4n, 'minecraft:villager_v2', at(2)),
      mob(5n, 'minecraft:cow', at(2)),
      mob(6n, 'minecraft:wolf', at(2)),
      mob(7n, 'minecraft:iron_golem', at(2)),
      mob(8n, 'minecraft:warden', at(2)),
      mob(9n, 'minecraft:creaking', at(2)),
      mob(10n, 'minecraft:cat', at(2)),
    ];
    const s = setup(list);
    // even when the server says they target the bot and the guess blames them
    for (const e of list) {
      s.targets(e.runtimeId);
      s.mobs.hitAt.set(e.runtimeId, s.now());
    }
    for (const e of list) expect(reflexTarget(e, s.mobs), e.type).toBe(e.runtimeId === 6n); // a wolf that bit us is fair game
  });

  it('a neutral mob only once it attacked: target_eid and a hit blamed on it, neither alone', () => {
    const ender = mob(11n, 'minecraft:enderman', at(2));
    const wolf = mob(12n, 'minecraft:wolf', at(2.5));
    const s = setup([ender, wolf]);
    expect(reflexTarget(ender, s.mobs)).toBe(false);
    // the guess blames the wolf (it swung) but the server never said it targets us
    s.mobs.hitAt.set(wolf.runtimeId, s.now());
    s.mobs.lastHitBy = { runtimeId: wolf.runtimeId, type: wolf.type, at: s.now(), why: 'swing', damage: 2 };
    expect(reflexTarget(wolf, s.mobs)).toBe(false);
    // an enderman the bot looked at targets it, but has not hit it yet
    s.targets(ender.runtimeId);
    expect(reflexTarget(ender, s.mobs)).toBe(false);
    s.mobs.hitAt.set(ender.runtimeId, s.now());
    expect(reflexTarget(ender, s.mobs)).toBe(true);
    s.advance(10_001);
    expect(reflexTarget(ender, s.mobs)).toBe(false);
  });

  it('hostiles yes, the dead no', () => {
    const z = mob(13n, 'minecraft:zombie', at(2));
    const sk = mob(14n, 'minecraft:skeleton', at(2));
    const s = setup([z, sk]);
    expect(reflexTarget(z, s.mobs)).toBe(true);
    expect(reflexTarget(sk, s.mobs)).toBe(true);
    s.die(z.runtimeId);
    expect(reflexTarget(z, s.mobs)).toBe(false);
  });
});

describe('reflexPicks: the order and the gates', () => {
  const base = (s: ReturnType<typeof setup>, extra: Partial<Parameters<typeof reflexPicks>[0]> = {}) => reflexPicks({ entities: s.ents.values(), mobs: s.mobs, me: s.me, struck: new Map(), tick: 100, ...extra });

  it('the nearest melee mob first; one out of reach is left out', () => {
    const near = mob(20n, 'minecraft:zombie', at(2.3));
    const far = mob(21n, 'minecraft:zombie', at(0.5, 4.3));
    const out = mob(22n, 'minecraft:zombie', at(0.5, -6));
    const s = setup([far, near, out]);
    expect(base(s).map((c) => c.e.runtimeId)).toEqual([20n, 21n]);
  });

  it('a lit creeper before everything; a mob that hit us before a nearer one', () => {
    const z = mob(30n, 'minecraft:zombie', at(2.0));
    const hitter = mob(31n, 'minecraft:zombie', at(0.5, 4.0));
    const cr = mob(32n, 'minecraft:creeper', at(-3.5));
    const s = setup([z, hitter, cr]);
    s.mobs.hitAt.set(hitter.runtimeId, s.now());
    expect(base(s).map((c) => c.e.runtimeId)).toEqual([31n, 30n, 32n]);
    s.ignite(cr.runtimeId);
    expect(base(s)[0]!.e.runtimeId).toBe(32n);
  });

  it('the soonest to reach us: a spider (longer reach, faster) at the same distance before a zombie', () => {
    const z = mob(40n, 'minecraft:zombie', at(3.6));
    const sp = mob(41n, 'minecraft:spider', at(-3.1)); // its box is wider: same eye-to-box distance about
    const s = setup([z, sp]);
    const p = base(s);
    expect(p.map((c) => c.e.runtimeId)).toEqual([41n, 40n]);
  });

  it('hurt time: our own strike 10 ticks, a hurt from another strike 400 ms', () => {
    const z = mob(50n, 'minecraft:zombie', at(2.3));
    const s = setup([z]);
    expect(base(s, { struck: new Map([[50n, 100 - HURT_TICKS + 1]]) })).toHaveLength(0);
    expect(base(s, { struck: new Map([[50n, 100 - HURT_TICKS]]) })).toHaveLength(1);
    s.hurt(z.runtimeId);
    expect(base(s)).toHaveLength(0);
    s.advance(401);
    expect(base(s)).toHaveLength(1);
  });

  it('nothing through a wall; with the shield up only what is about to hit', () => {
    const z = mob(60n, 'minecraft:zombie', at(0.5, 3.4));
    const s = setup([z]);
    const g = new FlatGrid();
    for (let x = -3; x <= 3; x++) for (let y = F; y <= F + 2; y++) g.add(x, y, 2);
    expect(base(s, { grid: g })).toHaveLength(0);
    expect(base(s, { maxEta: 5 })).toHaveLength(0); // 2.9 blocks off: 9 ticks from a hit
    z.pos = at(0.5, 2.2);
    expect(base(s, { maxEta: 5 })).toHaveLength(1);
  });

  it('with the shield raised (a strike lowers it): a lit creeper within its blast, a melee mob about to hit from outside the arc, nothing else', () => {
    // the bot looks towards +z (yaw 0)
    const front = mob(80n, 'minecraft:zombie', at(0.5, 2.0));
    const behind = mob(81n, 'minecraft:zombie', at(0.5, -1.0));
    const sk = mob(82n, 'minecraft:skeleton', at(2.0));
    const cr = mob(83n, 'minecraft:creeper', at(-3.0));
    const s = setup([front, behind, sk, cr]);
    const ids = (g: { yaw: number }) => base(s, { guarded: g }).map((c) => c.e.runtimeId);
    // the zombie in front is blocked by the shield, the one behind is not; never the skeleton; the creeper only lit
    expect(ids({ yaw: 0 })).toEqual([81n]);
    s.ignite(cr.runtimeId);
    expect(ids({ yaw: 0 })).toEqual([83n, 81n]);
    // looking the other way: the one at +z is behind now
    expect(ids({ yaw: 180 })).toEqual([83n, 80n]);
    // unguarded: all four
    expect(base(s)).toHaveLength(4);
  });

  it('reach: up to REFLEX_REACH eye to box', () => {
    const z = mob(70n, 'minecraft:zombie', at(0.5 + 0.3 + REFLEX_REACH - 0.2)); // box edge 0.3 from its centre; the eye 1.62 up, the box reaches it
    const s = setup([z]);
    expect(base(s)).toHaveLength(1);
    z.pos = at(0.5 + 0.3 + REFLEX_REACH + 0.2);
    expect(base(s)).toHaveLength(0);
  });
});

describe('Reflex: the layer', () => {
  function layer(list: EntityInfo[], on = true) {
    const s = setup(list);
    const loop = new FakeLoop();
    loop.pos = { ...s.me };
    loop.setCommand({ yaw: 33, forward: 1, sprint: true });
    const strikes: { rid: bigint; tick: bigint }[] = [];
    const st = { on };
    const r = new Reflex({
      loop,
      entities: () => s.ents,
      mobs: s.mobs,
      attack: (rid) => {
        strikes.push({ rid, tick: loop.tick });
        return true;
      },
      enabled: () => st.on,
    });
    return { s, loop, strikes, r, st };
  }

  it('strikes without touching the keys, each mob once per hurt time, at most 3 a tick', () => {
    const list = [mob(80n, 'minecraft:zombie', at(2.2)), mob(81n, 'minecraft:zombie', at(-1.2)), mob(82n, 'minecraft:husk', at(0.5, 2.5)), mob(83n, 'minecraft:zombie', at(0.5, -1.5))];
    const { loop, strikes, r } = layer(list);
    loop.pos = { x: 0.5, y: F, z: 0.5 };
    const before = loop.command;
    loop.step(1);
    expect(strikes).toHaveLength(MAX_PER_TICK);
    expect(loop.command.yaw).toBe(before.yaw);
    expect(loop.command.forward).toBe(before.forward);
    expect(loop.command.sprint).toBe(before.sprint);
    loop.step(1);
    expect(strikes).toHaveLength(4); // the fourth the next tick
    loop.step(HURT_TICKS - 2);
    expect(strikes).toHaveLength(4);
    loop.step(1);
    expect(strikes.length).toBeGreaterThan(4); // the first three again after 10 ticks
    expect(r.totals.hits).toBe(strikes.length);
    r.dispose();
  });

  it('nothing while off; never a player or a villager in reach', () => {
    const list = [mob(90n, 'minecraft:player', at(1.5), { username: 'Owner' }), mob(91n, 'minecraft:villager_v2', at(-0.8)), mob(92n, 'minecraft:zombie', at(0.5, 2.0))];
    const { loop, strikes, st, r } = layer(list, false);
    loop.pos = { x: 0.5, y: F, z: 0.5 };
    loop.step(5);
    expect(strikes).toHaveLength(0);
    st.on = true;
    loop.step(30);
    expect(new Set(strikes.map((x) => x.rid))).toEqual(new Set([92n]));
    r.dispose();
  });
});
