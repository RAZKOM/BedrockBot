// Track K7 (ADR 0121, docs/flight.md "Renewing an elytra at an anvil (Track K7)"): the anvil's rules as measured on BDS
// 1.26.60.6 (skills/items/anvil.ts), the planner's choices and refusals and the job on fakes (tasks/process/repair.ts), the
// wire requests of one operation (skills/items/anvil-use.ts), `!repair`'s arguments and replies (chat/commands-repair.ts).
import { describe, expect, it } from 'vitest';
import { SETTING_DEFS } from '../../../src/config/settings.ts';
import { SETTING_GROUPS } from '../../../src/chat/help.ts';
import { parseRepairArgs } from '../../../src/chat/commands-repair.ts';
import {
  checkOp,
  chooseBase,
  combineOp,
  customNameOf,
  isAnvil,
  materialOp,
  mergeEnchants,
  minCost,
  nextPenalty,
  penaltyLine,
  pieceOf,
  renewalsLeft,
  repairCostOf,
  repairMaterials,
  TOO_EXPENSIVE,
  unitsNeeded,
  type AnvilPiece,
} from '../../../src/skills/items/anvil.ts';
import { AnvilUser, OPTIONAL_WIRE_TYPE, type AnvilDeps } from '../../../src/skills/items/anvil-use.ts';
import type { ElytraState } from '../../../src/skills/supply/elytra.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { packLines, planRepair, REPLY_MAX, RepairController, RepairJob, repairLines, type RepairDeps, type RepairReport } from '../../../src/tasks/process/repair.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const M = { id: 26, lvl: 1 };
const U3 = { id: 17, lvl: 3 };
const U2 = { id: 17, lvl: 2 };
const ely = (left: number, repairCost = 0, enchants: { id: number; lvl: number }[] = []): AnvilPiece => ({ name: 'elytra', left, max: 432, repairCost, enchants });

describe('the anvil rules (measured on BDS 1.26.60.6)', () => {
  it('a phantom membrane gives back 108 uses for 1 level; exactly the units the damage needs are taken', () => {
    expect(unitsNeeded(ely(132))).toBe(3); // damage 300: 3 (4 placed: the server takes 3)
    expect(unitsNeeded(ely(332))).toBe(1); // damage 100: 1
    expect(unitsNeeded(ely(1))).toBe(4);
    expect(unitsNeeded(ely(432))).toBe(0);
    expect(unitsNeeded(ely(1), 2)).toBe(2);
    const op = materialOp(ely(132), 'phantom_membrane', 4)!;
    expect(op).toMatchObject({ kind: 'material', units: 3, cost: 3, gain: 300, result: { left: 432, repairCost: 1 } });
    expect(materialOp(ely(432), 'phantom_membrane', 4)).toBeUndefined();
    expect(materialOp(ely(132), 'phantom_membrane', 0)).toBeUndefined();
  });

  it('the prior-work penalty: 0 -> 1 -> 3 -> 7 -> 15 -> 31, each operation costing the tag too (1, 2, 4, 8 levels a membrane)', () => {
    let p = ely(1);
    const costs: number[] = [];
    const tags: number[] = [];
    for (let i = 0; i < 4; i++) {
      const op = materialOp(p, 'phantom_membrane', 1)!;
      costs.push(op.cost);
      tags.push(op.result.repairCost);
      p = { ...p, left: op.result.left, repairCost: op.result.repairCost };
    }
    expect(costs).toEqual([1, 2, 4, 8]);
    expect(tags).toEqual([1, 3, 7, 15]);
    expect(p.left).toBe(432);
    expect(nextPenalty(15)).toBe(31);
    expect(nextPenalty(1, 3)).toBe(7); // a combine: 2 x the larger + 1
  });

  it('two elytras combined: both uses + 51, 2 levels when the target is damaged; the sacrifice tag counts too', () => {
    expect(combineOp(ely(132), ely(82))).toMatchObject({ kind: 'combine', cost: 2, result: { left: 265, repairCost: 1 } }); // damage 300 + 350 -> 167
    expect(combineOp(ely(109, 1), ely(1))).toMatchObject({ cost: 3, result: { left: 161, repairCost: 3 } });
    expect(combineOp(ely(132), ely(109, 1))).toMatchObject({ cost: 3, result: { left: 292, repairCost: 3 } });
    expect(combineOp(ely(240, 1), ely(132, 1))).toMatchObject({ cost: 4, result: { left: 423, repairCost: 3 } });
    expect(combineOp(ely(432), ely(432)).cost).toBe(0); // a full target: no repair levels
  });

  it('enchantments: one the target lacks costs level x multiplier (Mending 4, its book 2, Unbreaking 2 a level); the same one nothing', () => {
    expect(combineOp(ely(132, 0, [M]), ely(82)).cost).toBe(2);
    expect(combineOp(ely(132), ely(82, 0, [M])).cost).toBe(6);
    expect(combineOp(ely(132, 0, [M]), ely(82, 0, [M])).cost).toBe(2);
    expect(combineOp(ely(132), ely(82, 0, [U3])).cost).toBe(8);
    expect(combineOp(ely(132, 0, [U3]), ely(82, 0, [U3])).cost).toBe(2);
    const book: AnvilPiece = { name: 'enchanted_book', left: 0, max: 432, repairCost: 0, enchants: [M], book: true };
    expect(combineOp(ely(1), book)).toMatchObject({ kind: 'book', cost: 2, result: { left: 1, repairCost: 1, enchants: [M] } });
    expect(mergeEnchants([], [U3, M])).toEqual({ enchants: [U3, M], cost: 10 });
  });

  it('too expensive at 40 levels or more: 15 + 15 + Mending 4 + Unbreaking III 6 = 40 refused; with Unbreaking II 38 paid', () => {
    expect(TOO_EXPENSIVE).toBe(40);
    expect(combineOp(ely(432, 15), ely(432, 0, [M, U3])).cost).toBe(25);
    const forty = combineOp(ely(432, 15), ely(432, 15, [U3, M]));
    expect(forty.cost).toBe(40);
    expect(checkOp(forty, 100)).toMatchObject({ kind: 'expensive' });
    expect(checkOp(combineOp(ely(432, 15), ely(432, 15, [U2, M])), 100)).toBeUndefined();
  });

  it('the checks before paying: nothing to gain, too expensive, the levels, the last renewal (unless asked)', () => {
    expect(checkOp(combineOp(ely(432), ely(432)), 30)).toMatchObject({ kind: 'nothing' });
    expect(checkOp(combineOp(ely(432), ely(432, 0, [M])), 30)).toBeUndefined(); // an enchantment added is a gain
    expect(checkOp(materialOp(ely(132), 'phantom_membrane', 4)!, 1)).toEqual({ kind: 'levels', why: 'not enough levels: it costs 3 and I have 1' });
    expect(checkOp(materialOp(ely(132), 'phantom_membrane', 4)!, undefined)).toMatchObject({ kind: 'unknown_levels' });
    const last = materialOp(ely(1, 31), 'phantom_membrane', 4)!; // 35 levels, the tag 63: every later one would cost 64 or more
    expect(last.cost).toBe(35);
    expect(checkOp(last, 40)).toMatchObject({ kind: 'last' });
    expect(checkOp(last, 40)!.why).toContain('the next one would cost 64 or more');
    expect(checkOp(last, 40, { last: true })).toBeUndefined();
    expect(checkOp(materialOp(ely(1, 63), 'phantom_membrane', 1)!, 100)).toMatchObject({ kind: 'expensive' });
  });

  it('renewals left before too expensive, the penalty line', () => {
    expect([0, 1, 3, 7, 15, 31, 63].map((r) => renewalsLeft(r))).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(minCost(31)).toBe(32);
    expect(penaltyLine(materialOp(ely(132), 'phantom_membrane', 4)!)).toBe('prior-work penalty 0 -> 1 (the next renewal 2 levels or more, 5 more before too expensive)');
    expect(penaltyLine(combineOp(ely(132, 3), ely(82, 1)))).toBe('prior-work penalty 3 (+1) -> 7 (the next renewal 8 levels or more, 3 more before too expensive)');
  });

  it('the base of a combine: the piece whose enchantments the other lacks (cheaper either way the result is the same)', () => {
    const c = chooseBase(ely(132), ely(82, 0, [M]));
    expect(c.base).toBe('b');
    expect(c.op.cost).toBe(2);
    expect(c.why).toBe('the other one is the base: its Mending stays at no cost (2 levels, the other way round 6)');
    expect(chooseBase(ely(132, 0, [M]), ely(82)).base).toBe('a');
    expect(chooseBase(ely(132), ely(82)).why).toBe('it is the base (the one at hand; either way 2 levels)');
    // the result is the same either way round
    expect(combineOp(ely(132), ely(82, 0, [M])).result).toEqual(combineOp(ely(82, 0, [M]), ely(132)).result);
  });

  it('the tags read from an item: RepairCost and the anvil name; anvil blocks; repair materials', () => {
    const raw = { extra: { nbt: { nbt: { value: { Damage: { value: 300 }, RepairCost: { value: 7 }, display: { value: { Name: { value: 'Wings' } } } } } } } };
    expect(repairCostOf(raw)).toBe(7);
    expect(repairCostOf(undefined)).toBe(0);
    expect(customNameOf(raw)).toBe('Wings');
    expect(pieceOf({ name: 'elytra', damage: 300 }, raw)).toEqual({ name: 'elytra', left: 132, max: 432, repairCost: 7, enchants: [], customName: 'Wings' });
    expect(pieceOf({ name: 'elytra', damage: 300, repairCost: 3 })).toMatchObject({ repairCost: 3 });
    expect(pieceOf({ name: 'dirt' })).toBeUndefined();
    expect(['anvil', 'chipped_anvil', 'damaged_anvil', 'minecraft:anvil'].every(isAnvil)).toBe(true);
    expect(isAnvil('crafting_table')).toBe(false);
    expect(repairMaterials('elytra')).toEqual(['phantom_membrane']);
    expect(repairMaterials('iron_pickaxe')).toEqual(['iron_ingot']);
    expect(repairMaterials('dirt')).toBeUndefined();
  });
});

describe('the plan (planRepair)', () => {
  const mats = (have: number) => ({ name: 'phantom_membrane', have });
  it('membranes first (they spend no second elytra), as many as the damage needs and there are', () => {
    const p = planRepair({ target: ely(132), material: mats(10), spares: [{ piece: ely(400), slot: 5 }], levels: 30 });
    expect(p).toMatchObject({ ok: true, kind: 'material', units: 3 });
    expect(planRepair({ target: ely(1), material: mats(2), spares: [], levels: 30 })).toMatchObject({ ok: true, kind: 'material', units: 2, op: { cost: 2, result: { left: 217 } } });
  });

  it('no membranes: the best second elytra combined, the Mending one the base', () => {
    const p = planRepair({ target: ely(132), material: mats(0), spares: [{ piece: ely(82, 0, [M]), slot: 3 }, { piece: ely(20), slot: 4 }], levels: 30 });
    expect(p).toMatchObject({ ok: true, kind: 'combine', base: 'spare', spare: { slot: 3 }, op: { cost: 2, result: { left: 265, enchants: [M] } } });
    expect(planRepair({ target: ely(132), material: mats(10), spares: [{ piece: ely(82), slot: 3 }], levels: 30, mode: 'combine' })).toMatchObject({ ok: true, kind: 'combine', base: 'target' });
  });

  it('refusals with a plain reason', () => {
    expect(planRepair({ target: ely(132), material: mats(0), spares: [], levels: 30 })).toMatchObject({ ok: false, kind: 'no_means', why: 'no phantom membrane and no second elytra to combine with (carried, in the carried boxes or in the chests at home in reach)' });
    expect(planRepair({ target: ely(132), material: mats(0), spares: [{ piece: ely(82), slot: 3 }], levels: 30, mode: 'membranes' })).toMatchObject({ ok: false, kind: 'no_means' });
    expect(planRepair({ target: ely(132), material: mats(5), spares: [], levels: 30, mode: 'combine' })).toMatchObject({ ok: false, kind: 'no_means', why: 'no second elytra to combine with (carried, in a carried box or in the chests at home in reach)' });
    expect(planRepair({ target: ely(432), material: mats(5), spares: [], levels: 30 })).toMatchObject({ ok: false, kind: 'nothing' });
    expect(planRepair({ target: ely(132), material: mats(5), spares: [], levels: 1 })).toMatchObject({ ok: false, kind: 'levels', why: 'not enough levels: it costs 3 and I have 1' });
    // both full, one with Mending and Unbreaking III, both tagged 15: the way that adds them costs 40, the other gains nothing
    const r = planRepair({ target: ely(432, 15), material: mats(0), spares: [{ piece: ely(432, 15, [U3, M]), slot: 3 }], levels: 100, mode: 'combine' });
    expect(r).toMatchObject({ ok: false, kind: 'expensive' });
    expect(r.ok ? '' : r.why).toBe('too expensive: it would cost 40 levels and the anvil refuses 40 or more (prior-work penalty 15 + 15)');
    expect(planRepair({ target: ely(1, 31), material: mats(4), spares: [], levels: 50 })).toMatchObject({ ok: false, kind: 'last' });
    expect(planRepair({ target: ely(1, 31), material: mats(4), spares: [], levels: 50, last: true })).toMatchObject({ ok: true, op: { cost: 35 } });
  });
});

describe('!repair arguments and replies', () => {
  it('parses the item, the mode and last', () => {
    expect(parseRepairArgs([])).toEqual({ item: 'elytra' });
    expect(parseRepairArgs(['status'])).toBe('status');
    expect(parseRepairArgs(['elytra', 'membranes'])).toEqual({ item: 'elytra', mode: 'membranes' });
    expect(parseRepairArgs(['combine', 'last'])).toEqual({ item: 'elytra', mode: 'combine', last: true });
    expect(parseRepairArgs(['iron_pickaxe'])).toEqual({ item: 'iron_pickaxe' });
    expect(parseRepairArgs(['dirt'])).toEqual({ error: expect.stringMatching(/^repair: dirt has no uses to renew/) as string });
    expect(parseRepairArgs(['elytra', 'shield', 'x'])).toEqual({ error: expect.stringMatching(/^usage/) as string });
  });

  it('a reply never passes the chat limit: a long one is two lines', () => {
    const op = combineOp(ely(82, 15, [U3, M]), ely(132, 15));
    const r: RepairReport = { ok: true, item: 'elytra', reason: 'done', op, paid: op.cost, levels: { before: 70, after: 70 - op.cost }, base: 'the base was the other one (82/432, Unbreaking III, Mending, penalty 15): its Unbreaking III and Mending stay at no cost (32 levels, the other way round 42)', fetched: ['an elytra out of the chests at home'], worn: true };
    const lines = repairLines(r);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(REPLY_MAX);
    expect(lines[1]).toMatch(/^repair: /);
    expect(packLines(['repair: a', 'b'])).toEqual(['repair: a; b']);
  });

  it('the setting: off by default, in the flight group', () => {
    expect(SETTING_DEFS.autoRepair.default).toBe(false);
    expect(SETTING_GROUPS.find(([g]) => g === 'flight')![1]).toContain('autoRepair');
  });
});

// ---- the job on fakes ------------------------------------------------------------------------------------------------
type Slots = (ItemStack | null)[];
const item = (name: string, o: Partial<ItemStack> = {}): ItemStack => ({ name, networkId: 1, count: 1, metadata: 0, ...o });
const elyItem = (left: number, o: Partial<ItemStack> = {}): ItemStack => item('elytra', { damage: 432 - left, ...o });

function fakeDeps(o: { slots: Slots; worn?: ItemStack | null; level?: number; anvil?: Vec3 | undefined; home?: number; settings?: Record<string, unknown> }) {
  const slots = o.slots;
  const armour: (ItemStack | null)[] = [null, o.worn ?? null, null, null];
  const calls: string[] = [];
  let level = o.level ?? 30;
  const settings: Record<string, unknown> = { toolWearLimit: 10, autoRepair: false, ...o.settings };
  const elytraState = (): ElytraState => {
    const back = armour[1];
    const carried = slots.map((s, i) => ({ s, i })).filter((x) => x.s?.name === 'elytra');
    const left = (s: ItemStack): number => 432 - (s.damage ?? 0);
    const mend = (s: ItemStack): boolean => (s.enchants ?? []).some((e) => e.id === 26);
    const current = back ? { source: 'back' as const, left: left(back), mending: mend(back) } : carried[0] ? { source: 'kit' as const, slot: carried[0].i, left: left(carried[0].s!), mending: mend(carried[0].s!) } : undefined;
    const spares = carried.slice(back ? 0 : 1).map((x) => ({ source: 'loose' as const, slot: x.i, left: left(x.s!), mending: mend(x.s!) }));
    return { ...(current ? { current } : {}), spares, home: 0, homeInReach: false };
  };
  const count = (names: readonly string[]): number => slots.reduce((a, s) => a + (s && names.includes(s.name) ? s.count : 0), 0);
  const d: RepairDeps = {
    processes: new ProcessManager(),
    settings: { get: ((k: string) => settings[k]) as never },
    inventory: { slots, window: (id) => (id === 120 ? { slots: armour } : undefined) },
    elytra: elytraState,
    level: () => level,
    position: () => ({ x: 0.5, y: 0, z: 0.5 }),
    home: () => ({ x: 0, y: 0, z: 0 }),
    anvils: () => (o.anvil ? [o.anvil] : []),
    available: (names) => ({ loose: count(names), boxes: 0, home: o.home ?? 0, homeInReach: (o.home ?? 0) > 0 }),
    fetch: (names, n) => {
      calls.push(`fetch ${n} ${names.join(',')}`);
      const got = Math.min(n, o.home ?? 0);
      const free = slots.findIndex((s, i) => i >= 9 && !s);
      if (got > 0) slots[free] = item(names[0]!, { count: got });
      return Promise.resolve({ loose: count(names) });
    },
    walkTo: () => {
      calls.push('walk');
      return Promise.resolve(true);
    },
    inReach: () => true,
    anvil: {
      takeOff: (to) => {
        calls.push(`takeOff ${to}`);
        slots[to] = armour[1]!;
        armour[1] = null;
        return Promise.resolve(true);
      },
      use: (_at, u, predict) => {
        calls.push(`use input ${u.input} material ${u.material?.slot}x${u.material?.count}${u.name ? ` name ${u.name}` : ''}`);
        const t = slots[u.input]!;
        const before = level;
        const m = slots[u.material!.slot]!;
        slots[u.material!.slot] = m.count > u.material!.count ? { ...m, count: m.count - u.material!.count } : null;
        slots[u.input] = predict(t);
        level -= 3;
        return Promise.resolve({ ok: true, slot: u.input, levelsBefore: before, levelsAfter: level, item: slots[u.input] });
      },
    },
    wear: (from) => {
      calls.push(`wear ${from}`);
      armour[1] = slots[from]!;
      slots[from] = null;
      return Promise.resolve({ ok: true });
    },
    isDay: () => true,
    threat: () => undefined,
    cancel: () => undefined,
  };
  return { d, calls, slots, armour, settings };
}
const empty = (): Slots => Array.from({ length: 36 }, () => null);

describe('the job (RepairJob) on fakes', () => {
  const anvil = { x: 2, y: 0, z: 0 };
  it('a worn elytra: taken off into a free slot, renewed with the membranes it needs, put on again', async () => {
    const slots = empty();
    slots[2] = item('phantom_membrane', { count: 4 });
    const f = fakeDeps({ slots, worn: elyItem(132, { customName: 'Wings' }), anvil });
    const r = await new RepairJob({ item: 'elytra' }).run(f.d, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', worn: true, op: { kind: 'material', units: 3, cost: 3 } });
    expect(f.calls).toEqual(['takeOff 9', 'use input 9 material 2x3 name Wings', 'wear 9']);
    expect(f.armour[1]).toMatchObject({ name: 'elytra', damage: 0, repairCost: 1 });
    expect(f.slots[2]).toMatchObject({ count: 1 });
    expect(repairLines(r)[0]).toBe('repair: elytra 132 -> 432/432 with 3 phantom membranes for 3 levels (level 30 -> 27); prior-work penalty 0 -> 1 (the next renewal 2 levels or more, 5 more before too expensive); on my back again');
  });

  it('a combine whose base is the Mending spare: the spare goes in, the one at hand is the sacrifice', async () => {
    const slots = empty();
    slots[1] = elyItem(132);
    slots[3] = elyItem(82, { enchants: [M] });
    const f = fakeDeps({ slots, anvil });
    const r = await new RepairJob({ item: 'elytra' }).run(f.d, () => false);
    expect(r).toMatchObject({ ok: true, op: { kind: 'combine', cost: 2 } });
    expect(f.calls).toEqual(['use input 3 material 1x1']);
    expect(r.base).toBe('the base was the other one (82/432, Mending): its Mending stays at no cost (2 levels, the other way round 6)');
    expect(f.slots[3]).toMatchObject({ damage: 167, enchants: [M] });
  });

  it('refused before anything moves: too few levels, no anvil, no means; membranes fetched from home when short', async () => {
    const s1 = empty();
    s1[1] = elyItem(132);
    s1[2] = item('phantom_membrane', { count: 4 });
    const f1 = fakeDeps({ slots: s1, anvil, level: 1 });
    expect(await new RepairJob({ item: 'elytra' }).run(f1.d, () => false)).toMatchObject({ ok: false, reason: 'refused', why: 'not enough levels: it costs 3 and I have 1' });
    expect(f1.calls).toEqual([]);
    const f2 = fakeDeps({ slots: s1, anvil: undefined });
    expect((await new RepairJob({ item: 'elytra' }).run(f2.d, () => false)).why).toBe('no anvil within 24 blocks (I never place one)');
    const s3 = empty();
    s3[1] = elyItem(132);
    const f3 = fakeDeps({ slots: s3, anvil });
    expect((await new RepairJob({ item: 'elytra' }).run(f3.d, () => false)).why).toMatch(/^no phantom membrane and no second elytra/);
    const f4 = fakeDeps({ slots: s3, anvil, home: 8 });
    const r4 = await new RepairJob({ item: 'elytra' }).run(f4.d, () => false);
    expect(r4).toMatchObject({ ok: true, fetched: ['3 phantom membranes'] });
    expect(f4.calls[0]).toBe('fetch 3 phantom_membrane');
  });

  it('the chore: off by default; on, it leaves a Mending elytra to mending and one with uses enough alone', () => {
    const slots = empty();
    slots[1] = elyItem(60);
    slots[2] = item('phantom_membrane', { count: 4 });
    const f = fakeDeps({ slots, anvil });
    const c = new RepairController(f.d);
    expect(c.chore.wants()).toBe(false); // autoRepair off
    f.settings.autoRepair = true;
    const c2 = new RepairController(f.d);
    expect(c2.chore.reason()).toBeUndefined();
    expect(c2.chore.wants()).toBe(true);
    slots[1] = elyItem(60, { enchants: [M] });
    expect(new RepairController(f.d).chore.reason()).toBe('the elytra has Mending: it is mended with experience (!mend)');
    slots[1] = elyItem(400);
    expect(new RepairController(f.d).chore.wants()).toBe(false);
  });

  it('the takeoff hint: offered when the renewal would cover the trip, the levels when only they are short', () => {
    const slots = empty();
    slots[1] = elyItem(40);
    slots[2] = item('phantom_membrane', { count: 4 });
    const f = fakeDeps({ slots, anvil });
    const c = new RepairController(f.d);
    expect(c.tripHint({ distance: 2000 })).toBe('; !repair renews it at an anvil (4 phantom membranes, 4 levels: 432/432)');
    const f2 = fakeDeps({ slots, anvil, level: 2 });
    expect(new RepairController(f2.d).tripHint({ distance: 2000 })).toBe('; !repair at an anvil would cover it with 4 levels (I have 2)');
    slots[2] = null;
    expect(new RepairController(f.d).tripHint({ distance: 2000 })).toBe('');
  });
});

// ---- the wire requests ----------------------------------------------------------------------------------------------
describe('one operation over the protocol (AnvilUser)', () => {
  function wire(respond: (actions: Record<string, unknown>[], names: string[], cause: string) => Record<string, unknown>) {
    const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
    const sent: { name: string; p: Record<string, unknown> }[] = [];
    const openFns = new Set<(c: { id: number; type: string; pos: Vec3 }) => void>();
    const closeFns = new Set<(id: number, byServer: boolean) => void>();
    const windows = new Map<number, (ItemStack | null)[]>([[0, empty()]]);
    let gen = 0;
    const self = { level: 30 as number | undefined };
    const containers = {
      open: undefined as { id: number; type: string; pos: Vec3 } | undefined,
      onOpen: (fn: (c: { id: number; type: string; pos: Vec3 }) => void) => (openFns.add(fn), () => openFns.delete(fn)),
      onClose: (fn: (id: number, b: boolean) => void) => (closeFns.add(fn), () => closeFns.delete(fn)),
      close: (id: number) => {
        sent.push({ name: 'container_close', p: { window_id: id } });
        containers.open = undefined;
        for (const f of [...closeFns]) f(id, false);
      },
    };
    const source = {
      on: (name: string, fn: (p: Record<string, unknown>) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
      queue: (name: string, p: Record<string, unknown>) => {
        sent.push({ name, p });
        if (name === 'inventory_transaction') {
          const c = { id: 7, type: 'anvil', pos: { x: 2, y: 0, z: 0 } };
          containers.open = c;
          queueMicrotask(() => openFns.forEach((f) => f(c)));
        }
        if (name === 'item_stack_request') {
          const req = (p.requests as { request_id: number; actions: Record<string, unknown>[]; custom_names: string[]; cause: string }[])[0]!;
          const res = { request_id: req.request_id, ...respond(req.actions, req.custom_names, req.cause) };
          queueMicrotask(() => (handlers.get('item_stack_response') ?? []).forEach((f) => f({ responses: [res] })));
        }
      },
    };
    const inventory = {
      get slots() {
        return windows.get(0)!;
      },
      selected: 8,
      get contentGeneration() {
        return gen;
      },
      window: (id: number) => (windows.has(id) ? { slots: windows.get(id)! } : undefined),
      setItem: (w: number, s: number, it: ItemStack | null) => {
        if (!windows.has(w)) windows.set(w, []);
        windows.get(w)![s] = it;
      },
      rawItem: () => undefined,
      requestResync: () => {
        gen++;
      },
    };
    const deps: AnvilDeps = {
      source,
      loop: { state: { pos: { x: 0.5, y: 0, z: 0.5 }, ready: true }, setCommand: () => undefined, waitTicks: () => Promise.resolve() },
      world: { blockAt: () => ({ name: 'anvil' }) as never, chunks: { runtimeIdAt: () => 1 }, inventory, self },
      containers,
    };
    return { user: new AnvilUser(deps), sent, inventory, self };
  }

  it('fill, then the optional craft (legacy 15), the name sent back with cause anvil_text, the result into the target slot', async () => {
    const w = wire((actions) => {
      const craft = actions[0]!.type_id === 'optional';
      return craft
        ? { status: 'ok', containers: [{ slot_type: { container_id: 'hotbar' }, slots: [{ slot: 1, count: 1, item_stack_id: 99, durability_correction: 0 }] }, { slot_type: { container_id: 'anvil_material' }, slots: [{ slot: 2, count: 0 }] }] }
        : { status: 'ok', containers: [{ slot_type: { container_id: 'anvil_input' }, slots: [{ slot: 1, count: 1, item_stack_id: 50 }] }, { slot_type: { container_id: 'anvil_material' }, slots: [{ slot: 2, count: 3, item_stack_id: 51 }] }] };
    });
    w.inventory.slots[1] = elyItem(132, { stackId: 10, customName: 'Wings' });
    w.inventory.slots[2] = item('phantom_membrane', { count: 4, stackId: 11 });
    const r = await w.user.use({ x: 2, y: 0, z: 0 }, { input: 1, material: { slot: 2, count: 3 }, name: 'Wings' }, (t) => ({ ...t, damage: 0 }));
    expect(r).toMatchObject({ ok: true, slot: 1 });
    const reqs = w.sent.filter((s) => s.name === 'item_stack_request').map((s) => (s.p.requests as { actions: Record<string, unknown>[]; custom_names: string[]; cause: string; request_id: number }[])[0]!);
    expect(reqs[0]!.actions.map((a) => [a.type_id, a.count, (a.destination as { slot_type: { container_id: string }; slot: number }).slot_type.container_id])).toEqual([
      ['place', 1, 'anvil_input'],
      ['place', 3, 'anvil_material'],
    ]);
    const craft = reqs[1]!;
    expect(craft.actions[0]).toEqual({ type_id: 'optional', legacy_type_id: OPTIONAL_WIRE_TYPE, recipe_network_id: 0, filtered_string_index: 0 });
    expect(craft.actions.slice(1).map((a) => [a.type_id, a.count, (a.source as { stack_id: number }).stack_id])).toEqual([
      ['consume', 1, 50],
      ['consume', 3, 51],
      ['place', 1, craft.request_id],
    ]);
    expect(craft.custom_names).toEqual(['Wings']);
    expect(craft.cause).toBe('anvil_text');
    expect(w.inventory.slots[1]).toMatchObject({ name: 'elytra', damage: 0, stackId: 99 });
    expect(w.inventory.slots[2]).toMatchObject({ count: 1 });
    expect(w.sent.some((s) => s.name === 'container_close')).toBe(true);
  });

  it('a refused craft (status 9): the target and the material are placed back', async () => {
    const w = wire((actions) =>
      actions[0]!.type_id === 'optional' ? { status: 9 } : actions[0]!.type_id === 'place' && (actions[0]!.source as { slot_type: { container_id: string } }).slot_type.container_id.startsWith('anvil') ? { status: 'ok' } : { status: 'ok', containers: [{ slot_type: { container_id: 'anvil_input' }, slots: [{ slot: 1, count: 1, item_stack_id: 50 }] }, { slot_type: { container_id: 'anvil_material' }, slots: [{ slot: 2, count: 3, item_stack_id: 51 }] }] },
    );
    w.inventory.slots[1] = elyItem(132, { stackId: 10 });
    w.inventory.slots[2] = item('phantom_membrane', { count: 3, stackId: 11 });
    const r = await w.user.use({ x: 2, y: 0, z: 0 }, { input: 1, material: { slot: 2, count: 3 } }, (t) => ({ ...t, damage: 0 }));
    expect(r).toMatchObject({ ok: false, reason: 'refused', status: 9 });
    const reqs = w.sent.filter((s) => s.name === 'item_stack_request').map((s) => (s.p.requests as { actions: Record<string, unknown>[] }[])[0]!.actions);
    expect(reqs.length).toBe(4); // fill, craft, the target back, the material back
    expect(reqs[2]![0]).toMatchObject({ type_id: 'place', count: 1, source: { slot_type: { container_id: 'anvil_input' }, slot: 1, stack_id: 50 } });
    expect(reqs[3]![0]).toMatchObject({ type_id: 'place', count: 3, source: { slot_type: { container_id: 'anvil_material' }, slot: 2, stack_id: 51 } });
    expect(w.inventory.slots[1]).toMatchObject({ name: 'elytra', damage: 300 });
    expect(w.inventory.slots[2]).toMatchObject({ name: 'phantom_membrane', count: 3 });
  });
});
