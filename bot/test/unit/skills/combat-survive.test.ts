// Track V (wave 7, docs/pve.md "Creepers", "Ranged mobs", "Weapon pull") on fakes: the creeper hit and
// run, creepers not engaged below health 10 (`creeper_avoided`), a creeper coming close fought first and
// the fight going back to its target, flying targets never chased, arrow hits counted, the weapon moved
// from the main inventory before the first strike, and cover from an archer below health 10.
import { describe, expect, it } from 'vitest';
import { CombatController, coverCell } from '../../../src/skills/combat/combat.ts';
import { MobTracker } from '../../../src/skills/combat/hostiles.ts';
import type { HotbarMoveContainers } from '../../../src/skills/container/hotbar-moves.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { FakeLoop, FakeMover, FakeSource, mob } from './pve-fakes.ts';
import { FlatGrid } from './combat-fakes.ts';

const sword: ItemStack = { name: 'iron_sword', networkId: 309, count: 1, metadata: 0, stackId: 9 };

function setup(entities: Map<bigint, EntityInfo>, opts: { slots?: (ItemStack | null)[]; containers?: HotbarMoveContainers; grid?: FlatGrid } = {}) {
  const src = new FakeSource();
  const loop = new FakeLoop();
  const mover = new FakeMover();
  const slots: (ItemStack | null)[] = opts.slots ?? Array.from({ length: 36 }, (_, i) => (i === 0 ? sword : null));
  const inv = { slots, selected: 0 };
  const mobs = new MobTracker(src, { entities: () => entities, selfRuntimeId: () => 1n, selfPos: () => loop.state.pos });
  src.emit('start_game', { entity_id: -42n });
  src.emit('set_health', { health: 20 });
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
    ...(opts.containers ? { containers: () => opts.containers } : {}),
    ...(opts.grid ? { grid: () => opts.grid } : {}),
  });
  const attacks = () => src.sent.filter((p) => p.name === 'inventory_transaction');
  return { src, loop, mover, mobs, combat, attacks, inv };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('creepers', () => {
  it('hit and run: sprint in, strike, sprint away to 8 blocks, wait for the fuse, close in again', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 3.2 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(1); // within reach at once (box 2.9 away)
    s.loop.step(1);
    expect(s.loop.cmd).toMatchObject({ forward: 1, sprint: true });
    s.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: true } }] });
    s.loop.step(40);
    expect(s.loop.pos.z).toBeLessThan(3.2 - 8 + 0.3); // 8 blocks away (feet)
    expect(s.attacks()).toHaveLength(1);
    const z = s.loop.pos.z;
    s.loop.step(5);
    expect(s.loop.pos.z).toBeCloseTo(z, 5); // waits while the fuse burns
    s.src.emit('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { ignited: false } }] });
    s.loop.step(12);
    expect(s.mover.gotos.at(-1)).toMatchObject({ goal: { type: 'near' }, sprint: true }); // closing in again, sprinting
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    expect((await fight).reason).toBe('killed');
  });

  it('never more than 10 ticks within 3 blocks', () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 2.5 })]]);
    const s = setup(ents);
    void s.combat.fight(7n, { reach: 0 }); // no strike: only the 10-tick rule moves us away
    let inside = 0;
    for (let i = 0; i < 40; i++) {
      s.loop.step(1);
      ents.get(7n)!.pos = { x: s.loop.pos.x, y: -60, z: s.loop.pos.z + 2.5 }; // it follows at 2.5
      if (Math.abs(ents.get(7n)!.pos.z - s.loop.pos.z) < 3) inside++;
      if (s.loop.cmd.forward === 1 && Math.abs(s.loop.cmd.yaw) > 90) break; // running away
    }
    expect(inside).toBeLessThanOrEqual(12); // 11 ticks inside, then the turn away starts
    s.combat.cancel();
  });

  it('below health 10 a creeper is not engaged: run to 11 blocks, creeper_avoided, no strike', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:creeper', { x: 0, y: -60, z: 3 })]]);
    const s = setup(ents);
    s.src.emit('set_health', { health: 8 });
    const fight = s.combat.fight(7n);
    s.loop.step(60);
    const r = await fight;
    expect(r).toMatchObject({ ok: false, reason: 'creeper_avoided', attacks: 0 });
    expect(Math.hypot(s.loop.pos.x, s.loop.pos.z - 3)).toBeGreaterThanOrEqual(10.9);
    expect(s.combat.totals.creepersAvoided).toBe(1);
  });

  it('a creeper coming within 6 blocks is fought first, then the fight goes back to its target', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 12 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(2);
    expect(s.combat.target?.runtimeId).toBe(7n);
    ents.set(8n, mob(8n, 'minecraft:creeper', { x: -3.5, y: -60, z: 0 }));
    s.loop.step(1);
    expect(s.combat.target).toMatchObject({ runtimeId: 8n, type: 'minecraft:creeper' });
    s.src.emit('entity_event', { runtime_entity_id: 8n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    ents.delete(8n);
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    const r = await fight;
    expect(r).toMatchObject({ reason: 'killed', runtimeId: 7n, interludes: [{ type: 'minecraft:creeper', reason: 'killed' }] });
  });
  it('an unreachable creeper is not fought in between again for 200 ticks', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 20 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n, { stallTicks: 0 });
    ents.set(8n, mob(8n, 'minecraft:creeper', { x: 4.5, y: -60, z: 0 })); // e.g. behind a wall
    // Track AO: one failed approach ends it (was 3)
    s.loop.step(10);
    expect(s.combat.target?.runtimeId).toBe(8n);
    s.mover.finish({ ok: false, reason: 'unreachable' });
    await flush();
    s.loop.step(1);
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.loop.step(50);
    expect(s.combat.target?.runtimeId).toBe(7n);
    s.combat.cancel();
    expect((await fight).interludes).toEqual([{ type: 'minecraft:creeper', reason: 'unreachable' }]);
  });
});

describe('flying mobs and archers', () => {
  it('a phantom out of reach is never chased: no goto, unreachable after 20 ticks', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:phantom', { x: 0, y: -55, z: 6 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(25);
    const r = await fight;
    expect(r.reason).toBe('unreachable');
    expect(s.mover.gotos).toHaveLength(0);
    expect(s.loop.pos).toEqual({ x: 0, y: -60, z: 0 });
  });

  it('a phantom swooping into reach is struck', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:phantom', { x: 0, y: -59, z: 2 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(1);
    s.combat.cancel();
    expect((await fight).reason).toBe('interrupted');
  });

  it('counts own damage while the nearest hostile is an archer; sprints straight at it', async () => {
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:skeleton', { x: 0, y: -60, z: 12 })]]);
    const s = setup(ents);
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.mover.gotos[0]).toMatchObject({ sprint: true });
    s.src.emit('set_health', { health: 17 });
    s.loop.pos = { x: 0, y: -60, z: 9 };
    s.loop.step(1);
    expect(s.loop.cmd).toMatchObject({ forward: 1, sprint: true });
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    const r = await fight;
    expect(r.arrowHits).toBe(1);
    expect(s.combat.totals.arrowHits).toBe(1);
  });

  it('below health 10 an archer makes the bot walk behind a wall instead (took_cover)', async () => {
    // a 2-high wall at z = 3 from x = 3 to 6 (beside the bot, which stands in the open); the skeleton at z = 10
    const grid = new FlatGrid();
    for (let x = 3; x <= 6; x++) for (const y of [-60, -59]) grid.add(x, y, 3);
    const mobEye = { x: 0.5, y: -58.5, z: 10.5 };
    const cell = coverCell(grid, { x: 0.5, y: -60, z: 0.5 }, mobEye);
    expect(cell).toBeDefined();
    expect(cell!.z).toBeLessThan(3); // behind the wall
    expect(cell!.x).toBeGreaterThanOrEqual(3);
    expect(Math.hypot(cell!.x + 0.5 - 0.5, cell!.z + 0.5 - 0.5)).toBeLessThanOrEqual(6);
    expect(coverCell(grid, { x: cell!.x + 0.5, y: -60, z: cell!.z + 0.5 }, mobEye)).toEqual(cell); // standing there: already covered
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:skeleton', { x: 0.5, y: -60, z: 10.5 })]]);
    const s = setup(ents, { grid });
    s.loop.pos = { x: 0.5, y: -60, z: 0.5 };
    s.src.emit('set_health', { health: 7 });
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.mover.gotos[0]).toMatchObject({ goal: { type: 'block', p: cell }, sprint: true });
    s.mover.finish({ ok: true });
    s.loop.pos = { x: cell!.x + 0.5, y: -60, z: cell!.z + 0.5 };
    s.loop.step(1);
    expect((await fight).reason).toBe('took_cover');
    expect(s.combat.totals.cover).toBe(1);
  });
});

describe('weapon pull', () => {
  it('moves the sword from the main inventory before the first strike', async () => {
    let open: { id: number; type: string } | undefined;
    const opens = new Set<(c: { id: number; type: string }) => void>();
    const closes = new Set<(id: number, byServer: boolean) => void>();
    const moves: string[] = [];
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    slots[0] = { name: 'cooked_beef', networkId: 2, count: 5, metadata: 0 };
    slots[20] = sword;
    const containers: HotbarMoveContainers = {
      get open() {
        return open;
      },
      onOpen: (fn) => {
        opens.add(fn);
        return () => opens.delete(fn);
      },
      onClose: (fn) => {
        closes.add(fn);
        return () => closes.delete(fn);
      },
      close: (id) => {
        open = undefined;
        for (const f of [...closes]) f(id, false);
      },
      move: (a, b) => {
        moves.push(`${a.slot}->${b.slot}`);
        slots[b.slot] = slots[a.slot]!;
        slots[a.slot] = null;
        return Promise.resolve({ ok: true });
      },
    };
    const ents = new Map<bigint, EntityInfo>([[7n, mob(7n, 'minecraft:zombie', { x: 0, y: -60, z: 2 })]]);
    const s = setup(ents, { slots, containers });
    s.src.queue = (name: string, params: Record<string, unknown>) => {
      s.src.sent.push({ name, params });
      if (name === 'interact') {
        open = { id: 3, type: 'inventory' };
        for (const f of opens) f(open);
      }
    };
    const fight = s.combat.fight(7n);
    s.loop.step(1);
    expect(s.attacks()).toHaveLength(0); // waits for the weapon
    for (let i = 0; i < 6 && moves.length === 0; i++) {
      await flush();
      s.loop.step(1);
    }
    await flush();
    s.loop.step(1);
    expect(moves).toEqual(['20->1']);
    expect(s.inv.selected).toBe(1);
    expect(s.attacks()).toHaveLength(1);
    expect(s.attacks()[0]!.params).toMatchObject({ transaction: { transaction_data: { hotbar_slot: 1 } } });
    s.src.emit('entity_event', { runtime_entity_id: 7n, event_id: 'death_animation', data: 0 });
    s.loop.step(1);
    expect(await fight).toMatchObject({ reason: 'killed', pulled: true, weapon: 'iron_sword' });
  });
});
