// Food gathering (PLAN.md 7.16, Track X, docs/food.md) on fakes: food values and fuel, baby flags,
// target choice with the leave rule, the hunter loop, the cooker's packet sequence against a fake
// furnace, the food process and the automatic chore's trigger (settings, day, user processes, backoff).
import { describe, expect, it } from 'vitest';
import { RuntimeSettings, SETTING_DEFS } from '../../../src/config/settings.ts';
import { cookTicksOf, Cooker, inputSlotType, planFuel } from '../../../src/skills/food/cook.ts';
import {
  BabyTracker,
  babyFlag,
  cookedOf,
  countHerd,
  findCookers,
  foodItemCount,
  foodKindOf,
  fuelValue,
  inventoryFoodPoints,
  isFuel,
  pickTarget,
  rawFoodCounts,
} from '../../../src/skills/food/finder.ts';
import { Hunter } from '../../../src/skills/food/hunter.ts';
import type { FightResult } from '../../../src/skills/combat/combat.ts';
import type { BlockInfo, ContainerView, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { COOK_NEAR, FoodController, FoodJob, NOTHING_FOUND_BACKOFF_MS, type FoodDeps } from '../../../src/tasks/process/food.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus } from '../../../src/tasks/process/manager.ts';
import type { FoodChore } from '../../../src/tasks/process/food.ts';
import { cookReply, foodReply, isChoreTime } from '../../../src/chat/commands-food.ts';

const item = (name: string, count: number, stackId?: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(stackId !== undefined ? { stackId } : {}) });

function ent(rid: number, type: string, x: number, z: number, y = -60): EntityInfo {
  return { runtimeId: BigInt(rid), uniqueId: BigInt(rid), type: `minecraft:${type}`, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 };
}

describe('food values and fuel', () => {
  it('knows the food mobs, the cooked forms and the fuels', () => {
    expect(foodKindOf('minecraft:cow')).toBe('cow');
    expect(foodKindOf('mooshroom')).toBe('mooshroom');
    expect(foodKindOf('minecraft:zombie')).toBeUndefined();
    expect(cookedOf('beef')).toBe('cooked_beef');
    expect(cookedOf('minecraft:porkchop')).toBe('cooked_porkchop');
    expect(cookedOf('cooked_beef')).toBeUndefined();
    expect(fuelValue('coal')).toBe(8);
    expect(fuelValue('charcoal')).toBe(8);
    expect(fuelValue('oak_planks')).toBe(1.5);
    expect(fuelValue('spruce_log')).toBe(1.5);
    expect(fuelValue('dried_kelp_block')).toBe(20);
    expect(isFuel('crimson_planks')).toBe(false);
    expect(isFuel('warped_stem')).toBe(false);
    expect(isFuel('cobblestone')).toBe(false);
  });

  it('counts the food carried in hunger points and items (bad foods left out)', () => {
    const slots = [item('cooked_beef', 2), item('beef', 3), item('rotten_flesh', 5), item('iron_sword', 1), null];
    expect(inventoryFoodPoints(slots)).toBe(2 * 8 + 3 * 3);
    expect(foodItemCount(slots)).toBe(5);
    expect([...rawFoodCounts(slots)]).toEqual([['beef', 3]]);
  });

  it('plans fuel: enough for the items, best fuel first, counting the fuel slot', () => {
    const slots = [item('oak_planks', 10), item('coal', 3), null];
    expect(planFuel(4, slots, null)).toEqual({ moves: [{ slot: 1, count: 1 }], name: 'coal', count: 1, covers: 8 });
    expect(planFuel(20, slots, null)?.count).toBe(3);
    // planks only: ceil(4 / 1.5) = 3
    expect(planFuel(4, [item('oak_planks', 10)], null)).toMatchObject({ name: 'oak_planks', count: 3 });
    // coal already in the slot covers it
    expect(planFuel(8, slots, item('coal', 1))).toBeUndefined();
    // a different fuel in the slot: only the same item can go on top
    expect(planFuel(20, slots, item('oak_planks', 2))).toMatchObject({ name: 'oak_planks', count: 10 });
    expect(planFuel(4, [item('dirt', 3)], null)).toBeUndefined();
    expect(cookTicksOf('smoker')).toBe(100);
    expect(cookTicksOf('lit_furnace')).toBe(200);
    expect(inputSlotType('lit_smoker')).toBe('smoker_ingredient');
    expect(inputSlotType('furnace')).toBe('furnace_ingredient');
  });
});

describe('babies and targets', () => {
  it('reads the baby actor flag from add_entity and set_entity_data', () => {
    expect(babyFlag([{ key: 'flags', value: { baby: true, onfire: false } }])).toBe(true);
    expect(babyFlag([{ key: 'flags', value: { baby: false } }])).toBe(false);
    expect(babyFlag([{ key: 'health', value: 10 }])).toBeUndefined();
    const fns = new Map<string, (p: Record<string, unknown>) => void>();
    const t = new BabyTracker({ on: (n, fn) => (fns.set(n, fn), () => fns.delete(n)) });
    fns.get('add_entity')!({ runtime_id: 7n, metadata: [{ key: 'flags', value: { baby: true } }] });
    expect(t.isBaby(7n)).toBe(true);
    fns.get('set_entity_data')!({ runtime_entity_id: 7, metadata: [{ key: 'flags', value: { baby: false } }] });
    expect(t.isBaby(7n)).toBe(false);
    t.dispose();
    expect(fns.size).toBe(0);
  });

  const me = { x: 0, y: -60, z: 0 };
  const babies = new Set([5n]);
  const q = { center: me, me, leave: 2, isBaby: (r: bigint) => babies.has(r) };

  it('never takes a kind below the leave count, never babies, nearest first', () => {
    const cows = [ent(1, 'cow', 10, 0), ent(2, 'cow', 5, 0), ent(3, 'cow', 20, 0), ent(5, 'cow', 2, 0)];
    expect(countHerd(cows, q).get('cow')).toEqual({ adults: 3, babies: 1 });
    expect(pickTarget(cows, q)?.entity.runtimeId).toBe(2n);
    // 2 adults: none may go
    expect(pickTarget(cows.filter((e) => e.runtimeId !== 2n), q)).toBeUndefined();
    expect(pickTarget(cows.filter((e) => e.runtimeId !== 2n), { ...q, leave: 0 })?.entity.runtimeId).toBe(1n);
    // ignored and out of the radius
    expect(pickTarget(cows, { ...q, ignored: (r) => r === 2n })?.entity.runtimeId).toBe(1n);
    expect(pickTarget([ent(1, 'pig', 60, 0), ent(2, 'pig', 61, 0), ent(3, 'pig', 62, 0)], q)).toBeUndefined();
    // players and other mobs are never targets
    const player = { ...ent(9, 'player', 1, 0), username: 'Steve' };
    expect(pickTarget([player, ent(10, 'zombie', 1, 0)], { ...q, leave: 0 })).toBeUndefined();
  });

  it('prefers worth: a cow a little farther beats a rabbit', () => {
    const list = [ent(1, 'rabbit', 3, 0), ent(2, 'cow', 5, 0)];
    expect(pickTarget(list, { ...q, leave: 0 })?.kind).toBe('cow');
  });

  it('finds furnaces and smokers (lit or not) near home', () => {
    const blocks = new Map<string, string>([
      ['3,-60,0', 'lit_furnace'],
      ['8,-60,0', 'smoker'],
      ['4,-60,0', 'blast_furnace'],
    ]);
    const world = {
      find(pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }): Vec3[] {
        const out: Vec3[] = [];
        for (const [k, name] of blocks) {
          const [x, y, z] = k.split(',').map(Number) as [number, number, number];
          const p = { x, y, z };
          if (Math.hypot(x - o.origin.x, z - o.origin.z) <= o.radius && pred({ name, stateId: 0, states: {}, hardness: 3.5, solid: true, boxes: [] }, p)) out.push(p);
        }
        return out;
      },
    };
    expect(findCookers(world, me, 16)).toEqual([
      { x: 3, y: -60, z: 0 },
      { x: 8, y: -60, z: 0 },
    ]);
    expect(findCookers(world, { x: 100, y: -60, z: 0 }, 16)).toEqual([]);
  });
});

// ---- hunter ---------------------------------------------------------------------------------------

function huntWorld(cows: EntityInfo[], loot = 2, failFirst = false) {
  const entities = new Map(cows.map((e) => [e.runtimeId, e]));
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const log: string[] = [];
  let pending = 0;
  const hunter = new Hunter({
    entities: () => entities,
    position: () => ({ x: 0, y: -60, z: 0 }),
    isBaby: () => false,
    inventory: { slots },
    mover: {
      goto: (g) => {
        log.push(`goto ${g.type}`);
        return Promise.resolve({ ok: true });
      },
      collect: () => {
        const beef = slots.findIndex((s) => s?.name === 'beef');
        if (beef >= 0) slots[beef] = item('beef', slots[beef]!.count + pending);
        else slots[0] = item('beef', pending);
        pending = 0;
        log.push('collect');
        return Promise.resolve({ ok: true });
      },
    },
    combat: {
      fight: (rid) => {
        log.push(`fight ${rid}`);
        if (failFirst) {
          failFirst = false;
          return Promise.resolve({ ok: false, reason: 'unreachable', runtimeId: rid, type: 'minecraft:cow', ticks: 5, attacks: 0, landed: 0, damageTaken: 0, weapon: null });
        }
        entities.delete(rid);
        pending = loot;
        return Promise.resolve({ ok: true, reason: 'killed', runtimeId: rid, type: 'minecraft:cow', ticks: 20, attacks: 2, landed: 2, damageTaken: 0, weapon: 'iron_sword' } as FightResult);
      },
    },
  });
  return { hunter, entities, slots, log };
}

describe('Hunter', () => {
  const center = { x: 0, y: -60, z: 0 };

  it('kills, picks up, stops at the wanted count', async () => {
    const h = huntWorld([ent(1, 'cow', 10, 0), ent(2, 'cow', 3, 0), ent(3, 'cow', 6, 0), ent(4, 'cow', 8, 0), ent(6, 'cow', 9, 0)]);
    const r = await h.hunter.hunt({ want: 4, center, leave: () => 2 }, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', gained: 4, killed: 2, kinds: { cow: 2 } });
    // the nearest (3 blocks) without a walk, the next (6) with a near goal first
    expect(h.log).toEqual(['fight 2', 'collect', 'goto near', 'fight 3', 'collect']);
  });

  it('stops when only `leave` adults are left', async () => {
    const h = huntWorld([ent(1, 'cow', 10, 0), ent(2, 'cow', 3, 0), ent(3, 'cow', 6, 0), ent(4, 'cow', 8, 0)], 1);
    const r = await h.hunter.hunt({ want: 10, center, leave: () => 2 }, () => false);
    expect(r).toMatchObject({ ok: false, reason: 'none_left', gained: 2, killed: 2 });
    expect(h.entities.size).toBe(2);
  });

  it('skips a target whose fight failed, and reports interruption', async () => {
    const h = huntWorld([ent(1, 'cow', 3, 0), ent(2, 'cow', 4, 0), ent(3, 'cow', 5, 0)], 2, true);
    const r = await h.hunter.hunt({ want: 2, center, leave: () => 0 }, () => false);
    expect(r.fights.map((f) => f.reason)).toEqual(['unreachable', 'killed']);
    expect(h.hunter.ignore.has(1n)).toBe(true);
    let n = 0;
    const r2 = await huntWorld([ent(1, 'cow', 3, 0), ent(2, 'cow', 4, 0)]).hunter.hunt({ want: 5, center, leave: () => 0 }, () => ++n > 1);
    expect(r2.reason).toBe('interrupted');
  });
});

// ---- cooker on a fake furnace ---------------------------------------------------------------------

function fakeFurnace(opts: { block?: string; inv: (ItemStack | null)[]; at?: Vec3 }) {
  const block = opts.block ?? 'furnace';
  const fpos = { x: 3, y: -60, z: 0 };
  const windows = new Map<number, (ItemStack | null)[]>([[0, opts.inv]]);
  const sent: { name: string; p: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const openFns = new Set<(c: { id: number; type: string; pos: Vec3 }) => void>();
  const closeFns = new Set<(id: number, s: boolean) => void>();
  let ticks = 0;
  let progress = 0;
  let fuelLeft = 0;
  let nextStack = 100;
  const containers = {
    open: undefined as { id: number; type: string; pos: Vec3 } | undefined,
    onOpen: (fn: (c: { id: number; type: string; pos: Vec3 }) => void) => (openFns.add(fn), () => openFns.delete(fn)),
    onClose: (fn: (id: number, s: boolean) => void) => (closeFns.add(fn), () => closeFns.delete(fn)),
    close: (id: number) => {
      containers.open = undefined;
      windows.delete(id);
      for (const f of [...closeFns]) f(id, false);
    },
  };
  const slotOf = (si: { slot_type: { container_id: string }; slot: number }): [number, number] => (['hotbar', 'inventory'].includes(si.slot_type.container_id) ? [0, si.slot] : [2, si.slot]);
  const respond = (id: number, ok: boolean) => {
    for (const fn of listeners.get('item_stack_response') ?? []) fn({ responses: [{ status: ok ? 'ok' : 'error', request_id: id, containers: [] }] });
  };
  const source = {
    on: (n: string, fn: (p: Record<string, unknown>) => void) => {
      const l = listeners.get(n) ?? [];
      l.push(fn);
      listeners.set(n, l);
      return () => undefined;
    },
    queue: (name: string, p: Record<string, unknown>) => {
      sent.push({ name, p });
      if (name === 'inventory_transaction') {
        windows.set(2, [null, null, null]);
        containers.open = { id: 2, type: block, pos: fpos };
        for (const f of [...openFns]) f(containers.open);
      } else if (name === 'item_stack_request') {
        const r = (p.requests as { request_id: number; actions: Record<string, unknown>[] }[])[0]!;
        const a = r.actions[0]! as { type_id: string; count: number; source: { slot_type: { container_id: string }; slot: number }; destination: { slot_type: { container_id: string }; slot: number } };
        const [sw, ss] = slotOf(a.source);
        const [dw, ds] = slotOf(a.destination);
        const src = windows.get(sw)![ss];
        const dst = windows.get(dw)![ds];
        if (!src || src.count < a.count) return respond(r.request_id, false);
        // the cooker predicted the destination; the server state is authoritative
        windows.get(sw)![ss] = src.count === a.count ? null : { ...src, count: src.count - a.count };
        const prevDst = dst?.name === src.name ? Math.max(0, dst.count - a.count) : 0;
        windows.get(dw)![ds] = { ...src, count: prevDst + a.count, stackId: nextStack++ };
        respond(r.request_id, true);
      }
    },
  };
  const world = {
    blockAt: (p: Vec3) => (p.x === fpos.x && p.y === fpos.y && p.z === fpos.z ? ({ name: block, stateId: 0, states: {}, hardness: 3.5, solid: true, boxes: [] } as BlockInfo) : undefined),
    find: (_pred: unknown, o: { origin: Vec3; radius: number }) => (Math.hypot(fpos.x - o.origin.x, fpos.z - o.origin.z) <= o.radius ? [fpos] : []),
    chunks: { runtimeIdAt: () => 42 },
    inventory: {
      get slots() {
        return windows.get(0)!;
      },
      selected: 0,
      window: (id: number): ContainerView | undefined => (windows.has(id) ? { id, slots: windows.get(id)! } : undefined),
      setItem: (w: number, slot: number, it: ItemStack | null) => {
        const s = windows.get(w);
        if (s) s[slot] = it;
      },
    },
  };
  const per = cookTicksOf(block);
  const loop = {
    state: { pos: opts.at ?? { x: 0.5, y: -60, z: 0.5 }, ready: true },
    setCommand: () => undefined,
    waitTicks: (n: number) => {
      ticks += n;
      const f = windows.get(2);
      if (f) {
        for (let i = 0; i < n; i++) {
          const input = f[0];
          if (!input) break;
          if (fuelLeft <= 0 && f[1]) {
            fuelLeft = fuelValue(f[1].name) * per;
            f[1] = f[1].count > 1 ? { ...f[1], count: f[1].count - 1 } : null;
          }
          if (fuelLeft <= 0) break;
          fuelLeft--;
          if (++progress >= per) {
            progress = 0;
            f[0] = input.count > 1 ? { ...input, count: input.count - 1 } : null;
            const out = f[2];
            f[2] = { name: cookedOf(input.name)!, networkId: 2, metadata: 0, count: (out?.count ?? 0) + 1, stackId: out?.stackId ?? nextStack++ };
          }
        }
      }
      return Promise.resolve();
    },
  };
  const walks: unknown[] = [];
  const cooker = new Cooker({
    source,
    loop,
    world,
    containers,
    mover: {
      goto: (g) => {
        walks.push(g);
        return Promise.resolve({ ok: true });
      },
    },
    home: () => ({ x: 0, y: -60, z: 0 }),
  });
  return { cooker, sent, windows, walks, ticks: () => ticks, fpos };
}

describe('Cooker', () => {
  it('walks to the furnace, puts the raw food and one coal in, waits, takes the cooked food out, closes', async () => {
    const inv: (ItemStack | null)[] = [item('iron_sword', 1, 1), item('beef', 4, 2), item('coal', 2, 3), ...Array.from({ length: 33 }, () => null)];
    const f = fakeFurnace({ inv });
    const r = await f.cooker.cook({}, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', cooked: { cooked_beef: 4 }, fuel: { coal: 1 }, block: 'furnace' });
    expect(f.walks).toEqual([{ type: 'getToBlock', p: f.fpos, reach: 4 }]);
    const reqs = f.sent.filter((s) => s.name === 'item_stack_request').map((s) => (s.p.requests as { actions: { type_id: string; source: { slot_type: { container_id: string }; slot: number }; destination: { slot_type: { container_id: string }; slot: number }; count: number }[] }[])[0]!.actions[0]!);
    expect(reqs.map((a) => `${a.type_id} ${a.count} ${a.source.slot_type.container_id}:${a.source.slot} -> ${a.destination.slot_type.container_id}:${a.destination.slot}`)).toEqual([
      'place 4 hotbar:1 -> furnace_ingredient:0',
      'place 1 hotbar:2 -> furnace_fuel:1',
      'take 4 furnace_output:2 -> hotbar:1',
    ]);
    expect(inv.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['iron_sword 1', 'cooked_beef 4', 'coal 1']);
    // 4 items x 200 ticks, plus the request round trips
    expect(r.ticks).toBeGreaterThanOrEqual(800);
    expect(f.windows.has(2)).toBe(false); // closed
  });

  it('a smoker takes smoker_ingredient and half the time', async () => {
    const inv: (ItemStack | null)[] = [item('porkchop', 3, 2), item('oak_planks', 5, 3), ...Array.from({ length: 34 }, () => null)];
    const f = fakeFurnace({ block: 'smoker', inv });
    const r = await f.cooker.cook({}, () => false);
    expect(r).toMatchObject({ ok: true, cooked: { cooked_porkchop: 3 }, fuel: { oak_planks: 2 } });
    expect(r.ticks).toBeLessThan(3 * 200);
    const first = (f.sent.find((s) => s.name === 'item_stack_request')!.p.requests as { actions: { destination: { slot_type: { container_id: string } } }[] }[])[0]!.actions[0]!;
    expect(first.destination.slot_type.container_id).toBe('smoker_ingredient');
  });

  it('after a hunt only a furnace near the bot: far from home the raw food is kept (no walk home to cook); near home it cooks', async () => {
    const far = fakeFurnace({ inv: [item('beef', 4, 2), item('coal', 2, 3), ...Array.from({ length: 34 }, () => null)], at: { x: 500.5, y: -60, z: 0.5 } });
    const r = await far.cooker.cook({ near: COOK_NEAR }, () => false);
    expect(r.reason).toBe('no_furnace_near');
    expect(far.walks).toEqual([]);
    expect(cookReply(r, 0)).toBe(`cook: no furnace or smoker within ${COOK_NEAR} blocks; the raw food is kept (!cook cooks it at home)`);
    // !cook from there still walks to the home furnace
    expect((await far.cooker.cook({}, () => false)).ok).toBe(true);
    const near = fakeFurnace({ inv: [item('beef', 4, 2), item('coal', 2, 3), ...Array.from({ length: 34 }, () => null)] });
    expect((await near.cooker.cook({ near: COOK_NEAR }, () => false)).ok).toBe(true);
  });

  it('refuses without raw food, a furnace or fuel', async () => {
    const none = fakeFurnace({ inv: [item('coal', 1), ...Array.from({ length: 35 }, () => null)] });
    expect((await none.cooker.cook({}, () => false)).reason).toBe('nothing_to_cook');
    const nofuel = fakeFurnace({ inv: [item('beef', 2, 5), ...Array.from({ length: 35 }, () => null)] });
    const r = await nofuel.cooker.cook({}, () => false);
    expect(r.reason).toBe('no_fuel');
    // the raw food came back out
    expect(nofuel.windows.get(0)!.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['beef 2']);
  });
});

// ---- the processes ----------------------------------------------------------------------------------

class UserProc extends BaseProcess {
  readonly name = 'goto';
  readonly kind = 'user' as const;
  get priority(): number {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status(): ProcessStatus {
    return { line: 'walking' };
  }
}

function choreRig(opts: { points?: number; day?: boolean; targets?: number; autoFood?: boolean; user?: boolean } = {}) {
  const settings = new RuntimeSettings();
  settings.set('foodLeave', 2); // these chore tests check the keep rule (the default is 0)
  if (opts.autoFood === false) settings.set('autoFood', false);
  const pm = new ProcessManager();
  let now = 0;
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  if (opts.points) slots[0] = item('cooked_beef', Math.ceil(opts.points / 8));
  const cows = Array.from({ length: opts.targets ?? 4 }, (_, i) => ent(i + 1, 'cow', 5 + i, 0));
  const h = huntWorld(cows);
  let day = opts.day ?? true;
  const fakeCooker = { canCook: () => false, cook: () => Promise.resolve({ ok: false, reason: 'no_furnace', cooked: {}, fuel: {}, ticks: 0 }), phase: 'idle' } as unknown as Cooker;
  const deps: FoodDeps = {
    processes: pm,
    settings,
    hunter: h.hunter,
    cooker: fakeCooker,
    position: () => ({ x: 0, y: -60, z: 0 }),
    inventory: { slots: h.slots },
    isDay: () => day,
    cancel: () => undefined,
    now: () => now,
  };
  if (opts.points) h.slots[1] = slots[0]!;
  const user = opts.user ? pm.add(new UserProc()) : undefined;
  const food = new FoodController(deps);
  return {
    pm,
    food,
    user,
    settings,
    h,
    deps,
    setDay: (d: boolean) => {
      day = d;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('food job: cooking and the way home', () => {
  it('the hunt cooks only at a furnace near the bot; the job reports where it started (no walk home from far away)', async () => {
    const r = choreRig({ targets: 2 });
    r.settings.set('foodLeave', 0);
    r.h.slots[2] = item('coal', 4);
    const asked: unknown[] = [];
    r.deps.cooker = { canCook: () => true, cook: (o: unknown) => (asked.push(o), Promise.resolve({ ok: false, reason: 'no_furnace_near', cooked: {}, fuel: {}, ticks: 0 })), phase: 'idle' } as unknown as Cooker;
    const job = new FoodJob(4, { hunt: true, cook: true });
    expect(await job.run(r.deps, () => false)).toBe(true);
    expect(asked).toEqual([{ near: COOK_NEAR }]);
    expect(job.startedAt).toEqual({ x: 0, y: -60, z: 0 });
    // !cook (no hunt) asks for the home furnace as before
    const cook = new FoodJob(0, { hunt: false, cook: true });
    r.h.slots[3] = item('beef', 2);
    await cook.run(r.deps, () => false);
    expect(asked.at(-1)).toEqual({});
  });

  it('with the default foodLeave 0 the hunt takes every wild adult in reach', async () => {
    const r = choreRig({ targets: 3 });
    r.settings.set('foodLeave', SETTING_DEFS.foodLeave.default);
    const job = new FoodJob(20, { hunt: true, cook: false });
    await job.run(r.deps, () => false);
    expect(job.killed).toBe(3);
    expect(r.h.entities.size).toBe(0);
  });
});

describe('food chore (auto trigger)', () => {
  it('settings and the chore priority', () => {
    expect(SETTING_DEFS.autoFood.default).toBe(true);
    expect(SETTING_DEFS.foodMin.default).toBe(10);
    expect(SETTING_DEFS.foodLeave.default).toBe(0); // wild animals are not kept by default; pens are (pen.ts)
    expect(PRIORITY.chore).toBe(30);
    expect(PRIORITY.chore).toBeLessThan(PRIORITY.user);
    expect(PRIORITY.chore).toBeGreaterThan(PRIORITY.home);
    expect(isChoreTime(6000)).toBe(true);
    expect(isChoreTime(23500)).toBe(true);
    expect(isChoreTime(18000)).toBe(false);
    expect(isChoreTime(12000)).toBe(false);
    expect(isChoreTime(undefined)).toBe(true);
  });

  it('starts by day with little food carried and no user process, hunts, keeps 2', async () => {
    const r = choreRig();
    r.pm.tick();
    expect(r.pm.active?.name).toBe('food');
    expect(r.pm.active?.kind).toBe('auto');
    expect(r.pm.active?.priority).toBe(30);
    for (let i = 0; i < 5; i++) await flush();
    r.pm.tick();
    expect(r.food.chore.running).toBe(false);
    expect(r.food.chore.last).toMatchObject({ killed: 2, gained: 4, reason: 'none_left' });
    expect(r.h.entities.size).toBe(2);
    expect(r.pm.active).toBeUndefined();
  });

  it('does not start with enough food, autoFood off, at night, or while a user process exists', () => {
    expect((() => {
      const r = choreRig({ points: 16 });
      r.pm.tick();
      return r.pm.active;
    })()).toBeUndefined();
    const off = choreRig({ autoFood: false });
    off.pm.tick();
    expect(off.pm.active).toBeUndefined();
    const night = choreRig({ day: false });
    night.pm.tick();
    expect(night.pm.active).toBeUndefined();
    const busy = choreRig({ user: true });
    const g = busy.user!;
    busy.pm.tick();
    expect(busy.pm.active).toBe(g);
    expect(busy.food.chore.running).toBe(false);
    // the walk ends: the chore may start (after its 1 s check interval)
    busy.pm.stop(g);
    busy.advance(1000);
    busy.pm.tick();
    expect(busy.pm.active?.name).toBe('food');
  });

  it('nothing to hunt: waits 10 minutes before looking again', () => {
    const r = choreRig({ targets: 2 });
    r.pm.tick();
    expect(r.pm.active).toBeUndefined();
    expect(r.food.chore.stats.nothingFound).toBe(1);
    r.h.entities.set(10n, ent(10, 'cow', 4, 0));
    r.advance(NOTHING_FOUND_BACKOFF_MS - 1000);
    r.pm.tick();
    expect(r.pm.active).toBeUndefined();
    r.advance(1000);
    r.pm.tick();
    expect(r.pm.active?.name).toBe('food');
  });

  it('a user command pre-empts the chore, which goes on afterwards; night pauses it', async () => {
    const r = choreRig({ targets: 6 });
    r.pm.tick();
    const chore = r.pm.active as FoodChore;
    expect(chore.name).toBe('food');
    const g = r.pm.add(new UserProc());
    expect(r.pm.active).toBe(g);
    expect(r.pm.stack().map((e) => `${e.name}:${e.state}`)).toEqual(['goto:active', 'food:paused']);
    r.pm.stop(g);
    expect(r.pm.active).toBe(chore);
    r.setDay(false);
    r.pm.tick();
    expect(r.pm.active).toBeUndefined();
    expect(chore.running).toBe(true);
    r.setDay(true);
    r.pm.tick();
    expect(r.pm.active).toBe(chore);
    for (let i = 0; i < 10; i++) await flush();
    expect(chore.running).toBe(false);
  });

  it('!food replaces a running chore and reports', async () => {
    const r = choreRig({ targets: 5 });
    r.pm.tick();
    expect(r.food.chore.running).toBe(true);
    const p = r.food.food(2);
    expect(r.food.chore.running).toBe(false);
    expect(r.pm.active).toBe(p);
    const res = await p.result;
    expect(res).toMatchObject({ ok: true, gained: 2, killed: 1 });
    expect(foodReply(res, 2, 2)).toBe('food: 2/2 items from 1 cow');
    expect(foodReply({ ok: false, reason: 'none_left', gained: 1, killed: 1, kinds: { pig: 1 } }, 6, 2)).toBe('food: 1/6 items from 1 pig, nothing left to hunt within 48 blocks (keeping 2 wild of each)');
  });
});
