// Track AH (wave 9, combat v3, docs/pve.md "Targeting" and "Shield") on fakes: re-targeting within
// reach on the strike cycle (the mob that hit us first, the 0.3-block bonus against flapping, a target
// that left reach dropped at once, the next mob within reach after a kill, back to the requested
// target), the crowd rule (`crowded`, the flee trigger, not twice in a row), the shield (offhand item
// stack request, shot prediction from `target_eid` and the bow sound, raised while not striking, the
// creeper's 10 ticks).
import { describe, expect, it } from 'vitest';
import { CombatController } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import { angleDiff } from '../../../src/skills/nav/follower.ts';
import { i64, SHOT_PERIOD, shotDue } from '../../../src/skills/combat/shield.ts';
import { crowded, crowdThreat, ignoreMsAfter, pickInReach, wantsFlee, type ReachCandidate } from '../../../src/skills/combat/targeting.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';

const sword: ItemStack = { name: 'iron_sword', networkId: 309, count: 1, metadata: 0, stackId: 9 };
const shieldItem: ItemStack = { name: 'shield', networkId: 358, count: 1, metadata: 0, stackId: 12 };

/** An inventory with windows (0 and 119), like world/inventory.ts. */
class FakeInventory {
  selected = 0;
  readonly windows = new Map<number, (ItemStack | null)[]>();
  constructor(slots: (ItemStack | null)[]) {
    this.windows.set(0, slots);
    this.windows.set(119, [null]);
  }
  get slots(): (ItemStack | null)[] {
    return this.windows.get(0)!;
  }
  window(id: number): { slots: (ItemStack | null)[] } | undefined {
    const s = this.windows.get(id);
    return s ? { slots: s } : undefined;
  }
  setItem(w: number, slot: number, item: ItemStack | null): void {
    this.windows.get(w)![slot] = item;
  }
}

/** A source that answers `interact open_inventory` and item stack requests like BDS. */
class ServerSource extends FakeSource {
  openFns = new Set<(c: { id: number; type: string }) => void>();
  closeFns = new Set<(id: number, byServer: boolean) => void>();
  open: { id: number; type: string } | undefined;
  status: unknown = 'ok';
  override queue(name: string, params: Record<string, unknown>): void {
    super.queue(name, params);
    if (name === 'interact') {
      this.open = { id: 2, type: 'inventory' };
      for (const fn of [...this.openFns]) fn(this.open);
    } else if (name === 'item_stack_request') {
      const rid = (params.requests as { request_id: number }[])[0]!.request_id;
      queueMicrotask(() => this.emit('item_stack_response', { responses: [{ status: this.status, request_id: rid }] }));
    }
  }
  containers() {
    return {
      open: this.open,
      onOpen: (fn: (c: { id: number; type: string }) => void) => {
        this.openFns.add(fn);
        return () => this.openFns.delete(fn);
      },
      onClose: (fn: (id: number, byServer: boolean) => void) => {
        this.closeFns.add(fn);
        return () => this.closeFns.delete(fn);
      },
      close: (id: number) => {
        this.open = undefined;
        for (const fn of [...this.closeFns]) fn(id, false);
      },
      move: () => Promise.resolve({ ok: false }),
    };
  }
}

function setup(entities: Map<bigint, EntityInfo>, opts: { slots?: (ItemStack | null)[]; health?: number; offhand?: ItemStack } = {}) {
  const src = new ServerSource();
  const loop = new FakeLoop();
  const mover = new FakeMover();
  const inv = new FakeInventory(opts.slots ?? Array.from({ length: 36 }, (_, i) => (i === 0 ? sword : null)));
  if (opts.offhand) inv.setItem(119, 0, opts.offhand);
  const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: opts.health ?? 20 });
  const combat = new CombatController({
    loop,
    mover,
    entities: () => entities,
    mobs,
    inventory: inv,
    hotbar: {
      select: (s) => {
        inv.selected = s;
        return true;
      },
      rawItem: () => undefined,
    },
    source: src,
    selfRuntimeId: () => 1n,
    containers: () => src.containers(),
  });
  const attacks = () => src.sent.filter((p) => p.name === 'inventory_transaction').map((p) => (p.params.transaction as { transaction_data: { entity_runtime_id: bigint } }).transaction_data.entity_runtime_id);
  /** The mob targets the bot and the bot's health drops by `dmg`: lastHitBy = that mob. */
  const hitBy = (rid: bigint, health: number) => {
    src.emit('set_entity_data', { runtime_entity_id: rid, metadata: [{ key: 'target_eid', value: -42n }] });
    src.emit('set_health', { health });
  };
  const die = (rid: bigint) => {
    src.emit('entity_event', { runtime_entity_id: rid, event_id: 'death_animation', data: 0 });
  };
  return { src, loop, mover, mobs, combat, attacks, inv, hitBy, die };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('pickInReach', () => {
  const c = (rid: bigint, reach: number, extra: Partial<ReachCandidate> = {}): ReachCandidate => ({ e: mob(rid, 'minecraft:zombie', { x: 0, y: -60, z: 0 }), reach, hitUs: false, creeper: false, ...extra });
  it('the mob that hit us, then a creeper, then the nearest; the current target keeps 0.3', () => {
    expect(pickInReach([c(1n, 2.0), c(2n, 1.5)], undefined)!.e.runtimeId).toBe(2n);
    expect(pickInReach([c(1n, 2.0), c(2n, 1.8)], 1n)!.e.runtimeId).toBe(1n); // within the bonus: no flapping
    expect(pickInReach([c(1n, 2.0), c(2n, 1.6)], 1n)!.e.runtimeId).toBe(2n); // 0.4 nearer: switch
    expect(pickInReach([c(1n, 1.0), c(2n, 3.0, { hitUs: true })], 1n)!.e.runtimeId).toBe(2n);
    expect(pickInReach([c(1n, 1.0), c(2n, 3.0, { creeper: true })], 1n)!.e.runtimeId).toBe(2n);
    expect(pickInReach([c(1n, 3.0, { hitUs: true }), c(2n, 1.0, { creeper: true })], undefined)!.e.runtimeId).toBe(1n);
    expect(pickInReach([], 1n)).toBeUndefined();
  });
});

describe('who hit us', () => {
  it('the mob whose arm_swing came with the hit, not just the nearest one targeting us', () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 1.2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 0, y: -60, z: -2.5 })],
    ]);
    const s = setup(ents);
    for (const r of [7n, 8n]) s.src.emit('set_entity_data', { runtime_entity_id: r, metadata: [{ key: 'target_eid', value: -42n }] });
    s.src.emit('set_health', { health: 18 });
    expect(s.mobs.lastHitBy).toMatchObject({ runtimeId: 7n, why: 'target' }); // the old guess: the nearest
    s.src.emit('entity_event', { runtime_entity_id: 8n, event_id: 'arm_swing', data: 0 });
    s.src.emit('set_health', { health: 15 });
    expect(s.mobs.lastHitBy).toMatchObject({ runtimeId: 8n, why: 'swing' });
  });
});

describe('re-targeting inside a fight', () => {
  it('a target that leaves reach while another threat is in reach is dropped at once', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 2.2, y: -60, z: 0 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toEqual([7n]);
    ents.get(7n)!.pos = { x: 0, y: -60, z: 6 }; // knocked back out of reach by our strike: it comes back
    s.loop.step(1);
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.loop.step(9); // the next strike cycle: still out of reach, 8 in reach -> switch
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.loop.step(12);
    expect(s.attacks().slice(0, 2)).toEqual([7n, 8n]);
    s.die(8n);
    s.loop.step(1);
    // 8 dead, 7 out of reach: back to the requested target
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.die(7n);
    s.loop.step(1);
    const r = await fight;
    expect(r).toMatchObject({ ok: true, reason: 'killed', runtimeId: 7n, retargets: 1, kills: 2 });
  });

  it('a target walking out of reach (not knocked back by us) is dropped at once: no chase', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 2.2, y: -60, z: 0 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(7n, { reach: 0 }); // no strikes
    s.loop.step(1);
    ents.get(7n)!.pos = { x: 0, y: -60, z: 5 };
    s.loop.step(1);
    expect(s.combat.target?.runtimeId).toBe(8n);
    expect(s.mover.gotos).toHaveLength(0);
    s.combat.cancel();
    expect((await fight).retargets).toBe(1);
  });

  it('on the strike cycle the mob that hit us becomes the target; not before the cycle', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 0, y: -60, z: -2.6 }, { yaw: 0 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toEqual([7n]);
    s.hitBy(8n, 17);
    s.loop.step(5);
    expect(s.combat.target?.runtimeId).toBe(7n); // waits for the strike cycle
    s.loop.step(5);
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.loop.step(10);
    expect(s.attacks().at(-1)).toBe(8n);
    s.combat.cancel();
    const r = await fight;
    expect(r).toMatchObject({ reason: 'interrupted', runtimeId: 7n, retargets: 1 });
    expect(s.combat.totals.retargets).toBe(1);
  });

  it('two mobs at the same distance: no flapping (current target bonus)', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 2, y: -60, z: 0 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(8n);
    for (let i = 0; i < 40; i++) {
      s.loop.step(1);
      s.loop.pos = { x: 0, y: -60, z: 0 }; // stand still
    }
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.combat.cancel();
    expect((await fight).retargets).toBe(0);
  });

  it('after the kill the next threat within reach is fought in the same fight', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:husk', { x: -2, y: -60, z: 1 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    s.die(7n);
    s.loop.step(1);
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.die(8n);
    s.loop.step(1);
    expect(await fight).toMatchObject({ ok: true, reason: 'killed', runtimeId: 7n, retargets: 0, kills: 2 });
  });

  it('retarget: false keeps the old single-target behaviour', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 2.2, y: -60, z: 0 })],
    ]);
    const s = setup(ents);
    const fight = s.combat.fight(7n, { retarget: false });
    s.loop.step(1);
    ents.get(7n)!.pos = { x: 0, y: -60, z: 6 };
    s.hitBy(8n, 17);
    s.loop.step(20);
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.die(7n);
    s.loop.step(1);
    expect(await fight).toMatchObject({ reason: 'killed', retargets: 0, kills: 1 });
  });
});

describe('crowd rule', () => {
  const three = () =>
    new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })],
      [8n, mob(8n, 'minecraft:zombie', { x: 2, y: -60, z: 0 })],
      [9n, mob(9n, 'minecraft:husk', { x: -3, y: -60, z: 1 })],
    ]);
  it('3 melee mobs within 4 blocks below health 12 end the fight `crowded`; not in a fight started right after', async () => {
    const ents = three();
    const s = setup(ents, { health: 11 });
    const r = s.combat.fight(7n);
    s.loop.step(1);
    expect(await r).toMatchObject({ ok: false, reason: 'crowded', runtimeId: 7n });
    expect(s.combat.totals.crowded).toBe(1);
    expect(ignoreMsAfter('crowded')).toBe(0);
    // no flight followed (a fight starts again at once): defend
    const again = s.combat.fight(7n);
    s.loop.step(5);
    expect(s.combat.busy).toBe(true);
    s.combat.cancel();
    expect((await again).reason).toBe('interrupted');
    s.loop.step(60);
    const later = s.combat.fight(7n);
    s.loop.step(1);
    expect((await later).reason).toBe('crowded');
  });

  it('not at health 12, not with an archer as the third, not with the rule off', async () => {
    const s = setup(three(), { health: 12 });
    const r1 = s.combat.fight(7n);
    s.loop.step(3);
    expect(s.combat.busy).toBe(true);
    s.combat.cancel();
    await r1;
    const ents = three();
    ents.set(9n, mob(9n, 'minecraft:skeleton', { x: -3, y: -60, z: 1 }));
    const s2 = setup(ents, { health: 5 });
    const r2 = s2.combat.fight(7n);
    s2.loop.step(3);
    expect(s2.combat.busy).toBe(true);
    s2.combat.cancel();
    await r2;
    const s3 = setup(three(), { health: 5 });
    s3.combat.crowdRule = false;
    const r3 = s3.combat.fight(7n);
    s3.loop.step(3);
    expect(s3.combat.busy).toBe(true);
    s3.combat.cancel();
    await r3;
  });

  it('targeting: crowded / crowdThreat / wantsFlee are the flee trigger', () => {
    const ents = three();
    const src = new FakeSource();
    const me = { x: 0, y: -60, z: 0 };
    const mobs = new MobTracker(src, { entities: () => ents, selfRuntimeId: () => 1n, selfPos: () => me });
    let hp = 11;
    const combat = { crowdRule: true, busy: false, crowdedRecently: false };
    const h = { mobs, d: { world: { entities: ents } }, health: () => hp, position: () => me, combat };
    expect(crowded(h, me).map((e) => e.runtimeId)).toEqual([7n, 8n, 9n]);
    expect(crowdThreat(h, me)?.runtimeId).toBe(7n);
    expect(wantsFlee(h, ents.get(9n)!)).toBe(true);
    hp = 12;
    expect(crowdThreat(h, me)).toBeUndefined();
    expect(wantsFlee(h, ents.get(9n)!)).toBe(false);
    hp = 11;
    combat.crowdRule = false;
    expect(crowdThreat(h, me)).toBeUndefined();
    combat.crowdRule = true;
    // while a fight runs, the fight decides (it ends `crowded`, then the flight comes)
    combat.busy = true;
    expect(crowdThreat(h, me)).toBeUndefined();
    combat.crowdedRecently = true;
    expect(crowdThreat(h, me)?.runtimeId).toBe(7n);
    combat.busy = false;
    ents.get(9n)!.pos = { x: -5, y: -60, z: 0 }; // 5 blocks: only 2 within 4
    expect(crowdThreat(h, me)).toBeUndefined();
  });
});

describe('shield', () => {
  it('i64 and the shot window', () => {
    expect(i64([-5, 12])).toBe(-21474836468n);
    expect(i64(7n)).toBe(7n);
    expect(i64([0, -1])).toBe(4294967295n);
    // from targeting (first shot about 62 ticks later): up from 47 to 69
    expect(shotDue(40, 0, false)).toBe(false);
    expect(shotDue(SHOT_PERIOD - 14, 0, false)).toBe(true);
    expect(shotDue(SHOT_PERIOD + 8, 0, false)).toBe(true);
    expect(shotDue(SHOT_PERIOD + 9, 0, false)).toBe(false);
    // after a heard shot: 8 ticks of trail, then the next window
    expect(shotDue(5, 0, true)).toBe(true);
    expect(shotDue(20, 0, true)).toBe(false);
    expect(shotDue(2 * SHOT_PERIOD - 5, 0, true)).toBe(true);
  });

  it('a shield in the inventory goes to the offhand (inventory screen, place to offhand slot 1)', async () => {
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, (_, i) => (i === 0 ? sword : i === 3 ? shieldItem : null));
    const s = setup(new Map(), { slots });
    for (let i = 0; i < 30; i++) {
      s.loop.step(1);
      await flush();
    }
    const req = s.src.sent.find((p) => p.name === 'item_stack_request');
    expect(s.src.sent.some((p) => p.name === 'interact' && p.params.action_id === 'open_inventory')).toBe(true);
    expect((req!.params.requests as { actions: unknown[] }[])[0]!.actions[0]).toEqual({
      type_id: 'place',
      legacy_type_id: 1,
      count: 1,
      source: { slot_type: { container_id: 'hotbar' }, slot: 3, stack_id: 12 },
      destination: { slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 },
    });
    expect(s.inv.window(119)!.slots[0]?.name).toBe('shield');
    expect(s.inv.slots[3]).toBeNull();
    expect(s.combat.shield.equipped()).toBe(true);
    expect(s.combat.shield.stats.equips).toBe(1);
    // a refused move is not repeated at once
    const s2 = setup(new Map(), { slots: Array.from({ length: 36 }, (_, i) => (i === 12 ? shieldItem : null)) });
    s2.src.status = 50;
    for (let i = 0; i < 80; i++) {
      s2.loop.step(1);
      await flush();
    }
    expect(s2.src.sent.filter((p) => p.name === 'item_stack_request')).toHaveLength(1);
    expect((s2.src.sent.find((p) => p.name === 'item_stack_request')!.params.requests as { actions: { source: unknown }[] }[])[0]!.actions[0]!.source).toEqual({ slot_type: { container_id: 'inventory' }, slot: 12, stack_id: 12 });
    expect(s2.combat.shield.stats.failed).toBe(1);
  });

  it('raised while an archer targeting us is due to shoot and the bot is not striking; lowered on the strike', async () => {
    const ents = new Map<bigint, EntityInfo>([
      [7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 9 })],
      [8n, mob(8n, 'minecraft:skeleton', { x: 6, y: -60, z: 6 })],
    ]);
    const s = setup(ents, { offhand: shieldItem });
    s.src.emit('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'target_eid', value: -42n }] });
    const fight = s.combat.fight(7n);
    const sneaks: boolean[] = [];
    for (let i = 0; i < 75; i++) {
      s.loop.step(1);
      s.loop.pos = { x: 0, y: -60, z: 0 };
      sneaks.push(s.loop.cmd.sneak);
    }
    expect(sneaks.slice(0, 40).some(Boolean)).toBe(false);
    expect(sneaks.slice(48, 68).every(Boolean)).toBe(true); // the predicted first shot (about 62 ticks)
    expect(sneaks.at(-1)).toBe(false);
    // the bow sound: the next window is predicted from it
    s.src.emit('level_sound_event', { sound_id: 'bow', entity_unique_id: [-1, -8 >>> 0] });
    s.loop.step(1);
    expect(s.loop.cmd.sneak).toBe(true); // the arrow is in flight
    s.loop.step(15);
    expect(s.loop.cmd.sneak).toBe(false);
    // within reach of the melee target: never raised
    ents.get(7n)!.pos = { x: 0, y: -60, z: 2 };
    let raised = 0;
    for (let i = 0; i < 61; i++) {
      s.loop.step(1);
      s.loop.pos = { x: 0, y: -60, z: 0 };
      if (s.loop.cmd.sneak) raised++;
    }
    expect(raised).toBe(0);
    s.combat.cancel();
    expect((await fight).shieldTicks).toBeGreaterThan(20);
  });

  it('for 10 ticks after a creeper fuse lights: backs off facing it, shield up; then runs', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 3.2 })]]);
    const s = setup(ents, { offhand: shieldItem });
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(1);
    s.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    s.loop.step(1);
    expect(s.loop.cmd).toMatchObject({ forward: -1, sneak: true, sprint: false });
    expect(Math.abs(angleDiff(s.loop.cmd.yaw, 0))).toBeLessThan(10); // facing it (+z)
    s.loop.step(9);
    expect(s.loop.cmd).toMatchObject({ forward: -1, sneak: true });
    s.loop.step(3);
    expect(s.loop.cmd).toMatchObject({ forward: 1, sprint: true, sneak: false });
    s.combat.cancel();
    expect((await fight).shieldTicks).toBe(10);
  });
});
