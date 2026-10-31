// Track BH: long falls and the water bucket clutch without a server: the measured Bedrock damage model
// (skills/fall/damage.ts), the waterloggable table and the clutch target rule (waterlog.ts), the live policy
// (policy.ts), the planner's long drops and their costs (fall/plan.ts through nav/astar.ts), the note on a
// refused fall (explain.ts), and the FallGuard's clutch in a closed loop: the click's tick and reach, the
// water in the movement model, the pickup (clutch.ts).
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { FallGuard, CLUTCH_REACH } from '../../../src/skills/fall/clutch.ts';
import { countedFall, epfFactor, fallDamage, fallEpf, landingFactor, landingTick, maxDropFor } from '../../../src/skills/fall/damage.ts';
import { explainFallRefusal } from '../../../src/skills/fall/explain.ts';
import { fallPolicy, type FallPolicy, type FallPolicyInputs } from '../../../src/skills/fall/policy.ts';
import { clutchTarget, isWaterloggable } from '../../../src/skills/fall/waterlog.ts';
import { DEFAULT_COSTS, NavGrid, dropCost, findPath, type PathResult } from '../../../src/skills/nav/index.ts';
import { cornerDistance } from '../../../src/skills/place/place.ts';
import { classify } from '../../../src/skills/terrain/classify.ts';
import { blockQueryOf } from '../../../src/skills/terrain/query.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { flatGen, hillyGen, rng, surfaceFeet, type GenWorld } from './genworld.ts';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const cls = (name: string, states?: Record<string, unknown>) => classify(blockInfoOf(name, states));

describe('fall damage model (measured on BDS 1.26.60.6)', () => {
  it('matches the measured damage of falls from rest onto stone (walk-off and teleport runs)', () => {
    const measured: Record<number, number> = { 3: 0, 3.25: 0, 3.5: 1, 3.75: 1, 4: 1, 4.5: 2, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, 11: 8, 12: 8, 13: 10, 14: 11, 15: 12, 16: 13, 18: 15, 20: 16, 22: 19 };
    for (const [h, d] of Object.entries(measured)) expect(fallDamage(Number(h)), `h ${h}`).toBe(d);
    expect(countedFall(12)).toBeCloseTo(10.807, 2); // the 18th tick reaches 12.002: lands, D(17) counts
    expect(landingTick(12)).toBe(18);
    expect(countedFall(2)).toBeLessThan(3);
  });

  it('soft landings scale the counted distance: hay 0.2, honey and beds 0.5, water / slime / powder snow 0', () => {
    expect(landingFactor('hay_block')).toBe(0.2);
    expect(landingFactor('minecraft:honey_block')).toBe(0.5);
    for (const n of ['water', 'flowing_water', 'slime', 'powder_snow']) expect(landingFactor(n)).toBe(0);
    expect(landingFactor('stone')).toBe(1);
    // measured: hay 6 / 12 / 22 -> 0 / 0 / 2; honey 6 / 12 / 22 -> 0 / 3 / 8 (honey's top is at 1)
    expect([6, 12, 22].map((h) => fallDamage(h, 'hay_block'))).toEqual([0, 0, 2]);
    expect([6, 12, 22].map((h) => fallDamage(h, 'honey_block'))).toEqual([0, 3, 8]);
    expect(fallDamage(40, 'water')).toBe(0);
  });

  it('armour enchantments: 3 x Feather Falling + Protection levels, x 0.04 each, capped at 20 (measured)', () => {
    const boots = (e: { id: number; lvl: number }[]) => [null, null, null, { name: 'diamond_boots', enchants: e }];
    expect(fallEpf(boots([]))).toBe(0);
    expect(fallEpf(boots([{ id: 2, lvl: 4 }]))).toBe(12);
    expect(fallEpf(boots([{ id: 0, lvl: 4 }]))).toBe(4);
    expect(fallEpf(boots([{ id: 2, lvl: 4 }, { id: 0, lvl: 4 }]))).toBe(16);
    const all = [{ name: 'diamond_helmet', enchants: [{ id: 0, lvl: 4 }] }, { name: 'diamond_chestplate', enchants: [{ id: 0, lvl: 4 }] }, { name: 'diamond_leggings', enchants: [{ id: 0, lvl: 4 }] }, { name: 'diamond_boots', enchants: [{ id: 2, lvl: 4 }, { id: 0, lvl: 4 }] }];
    expect(fallEpf(all)).toBe(20);
    // Feather Falling only counts on the boots
    expect(fallEpf([{ name: 'diamond_helmet', enchants: [{ id: 2, lvl: 4 }] }])).toBe(0);
    // measured damage (8 / 12 / 22 blocks: 5 / 8 / 19 bare)
    const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 2);
    near(fallDamage(8, 'stone', epfFactor(12)), 2.6);
    near(fallDamage(22, 'stone', epfFactor(12)), 9.88);
    near(fallDamage(12, 'stone', epfFactor(3)), 7.04);
    near(fallDamage(22, 'stone', epfFactor(4)), 15.96);
    near(fallDamage(12, 'stone', epfFactor(16)), 2.88);
    near(fallDamage(22, 'stone', epfFactor(20)), 3.8);
    expect(maxDropFor(12)).toBe(15);
    expect(maxDropFor(12, epfFactor(20))).toBeGreaterThan(60);
  });
});

describe('waterloggable blocks and the clutch target (measured on BDS 1.26.60.6)', () => {
  it('knows the measured waterloggable blocks and the ones that take the water above', () => {
    for (const n of ['oak_slab', 'oak_stairs', 'oak_fence', 'cobblestone_wall', 'glass_pane', 'iron_bars', 'oak_leaves', 'scaffolding', 'lantern', 'copper_grate', 'mangrove_roots', 'ladder', 'campfire', 'chest', 'spruce_trapdoor', 'standing_sign', 'oak_hanging_sign']) expect(isWaterloggable(n), n).toBe(true);
    for (const n of ['stone', 'glass', 'hay_block', 'soul_sand', 'dirt', 'grass_block', 'stone_double_slab', 'oak_planks']) expect(isWaterloggable(n), n).toBe(false);
  });

  it('water above a full non-waterloggable block, inside a bottom slab, refused elsewhere', () => {
    const air = cls('air');
    expect(clutchTarget(1, 2, 3, cls('stone'), air)).toEqual({ ok: true, water: { x: 1, y: 3, z: 3 }, click: { x: 1, y: 2, z: 3 }, layer: 0 });
    expect(clutchTarget(1, 2, 3, cls('oak_slab', { 'minecraft:vertical_half': 'bottom' }), undefined)).toEqual({ ok: true, water: { x: 1, y: 2, z: 3 }, click: { x: 1, y: 2, z: 3 }, layer: 1 });
    const refused = (b: string, states?: Record<string, unknown>, above = air) => {
      const t = clutchTarget(0, 0, 0, cls(b, states), above);
      expect(t.ok, b).toBe(false);
      return t.ok ? '' : t.reason;
    };
    expect(refused('oak_slab', { 'minecraft:vertical_half': 'top' })).toMatch(/waterlogged|inside/);
    expect(refused('oak_leaves')).toMatch(/inside/);
    expect(refused('copper_grate')).toMatch(/inside/);
    expect(refused('oak_fence')).toMatch(/inside/);
    expect(refused('glass_pane')).toMatch(/inside/);
    expect(refused('lantern')).toMatch(/inside/);
    expect(refused('stone_pressure_plate')).toMatch(/full solid top/);
    expect(refused('chest')).toMatch(/used/);
    expect(refused('crafting_table')).toMatch(/used/);
    expect(refused('stone', undefined, cls('short_grass'))).toMatch(/above/);
    expect(refused('water')).toMatch(/water/);
  });
});

const live = (o: Partial<FallPolicyInputs> = {}): FallPolicyInputs => ({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: true, waterWorks: true, clutchMax: 40, ...o });

describe('the live fall policy', () => {
  it('budget = health + absorption - margin; off when health is unknown, burning, a hostile near, or too low', () => {
    expect(fallPolicy(live())!.hpBudget).toBe(12);
    expect(fallPolicy(live({ absorption: 4 }))!.hpBudget).toBe(16);
    expect(fallPolicy(live({ enabled: false }))).toBeUndefined();
    expect(fallPolicy(live({ healthKnown: false }))).toMatchObject({ hpBudget: 0, blocked: 'health unknown', clutch: false });
    expect(fallPolicy(live({ burning: true, bucket: true }))).toMatchObject({ hpBudget: 0, blocked: 'on fire', clutch: false });
    expect(fallPolicy(live({ hostileDistance: 9.6 }))!.blocked).toBe('a hostile 10 blocks away');
    expect(fallPolicy(live({ health: 7 }))!.blocked).toBe('health 7 with margin 8');
    expect(fallPolicy(live({ epf: 12 }))!.factor).toBeCloseTo(0.52);
  });

  it('a clutch needs the bucket, the setting and water that works (not the Nether)', () => {
    expect(fallPolicy(live({ bucket: true }))!.clutch).toBe(true);
    expect(fallPolicy(live({ bucket: true, waterWorks: false }))!.clutch).toBe(false);
    expect(fallPolicy(live({ bucket: true, clutchOn: false }))!.clutch).toBe(false);
    expect(fallPolicy(live({ bucket: false }))!.clutch).toBe(false);
  });
});

/** A 11 x 11 plateau 12 blocks over the flat ground (top -49, feet -48), nothing else: the only way down is a fall. */
function plateau(opts: { landing?: string; landingStates?: Record<string, unknown>; stairs?: boolean } = {}): GenWorld {
  const g = flatGen({ x: -32, y: -64, z: -32 }, { x: 64, y: 40, z: 64 });
  g.fill({ x: 0, y: -60, z: 0 }, { x: 10, y: -49, z: 10 }, 'stone');
  if (opts.landing) g.fill({ x: 11, y: -61, z: 0 }, { x: 11, y: -61, z: 10 }, opts.landing, opts.landingStates);
  if (opts.stairs) {
    // a 1-wide staircase down the west side (x -1 .. -12 at z 5), one block per step
    for (let i = 0; i < 11; i++) g.fill({ x: -1 - i, y: -60, z: 5 }, { x: -1 - i, y: -50 - i, z: 5 }, 'stone');
  }
  return g;
}
const TOP: Vec3 = { x: 9, y: -48, z: 5 };
const BELOW: NavGoalBlock = { type: 'block', p: { x: 20, y: -60, z: 5 } };
interface NavGoalBlock { type: 'block'; p: Vec3 }
const policy = (o: Partial<FallPolicyInputs> = {}): FallPolicy => fallPolicy(live(o))!;
const longDrop = (r: PathResult) => r.path.find((n, i) => i > 0 && n.move === 'drop' && r.path[i - 1]!.feet - n.feet > 3);

describe('planner: long drops (fall/plan.ts through astar)', () => {
  it('no policy: the plateau is a trap (none); with the budget: one 12-block drop costing the fall, the penalty and 8 HP x hpCost', () => {
    const g = plateau();
    expect(findPath(new NavGrid(g), TOP, BELOW).status).toBe('none');
    const p = policy();
    const r = findPath(new NavGrid(g), TOP, BELOW, { falls: p });
    expect(r.status).toBe('found');
    const d = longDrop(r)!;
    expect(d).toBeDefined();
    expect(r.path[r.path.indexOf(d) - 1]!.feet - d.feet).toBe(12);
    expect(d.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + 8 * p.hpCost, 3);
  });

  it('refuses the drop when the damage exceeds the budget, and with maxDrop 1 (the End)', () => {
    const g = plateau();
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ health: 15 }) }).status).toBe('none'); // budget 7 < 8
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ health: 16 }) }).status).toBe('found'); // budget 8
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ healthKnown: false }) }).status).toBe('none');
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy(), costs: { maxDrop: 1 } }).status).toBe('none');
    // Feather Falling IV: 8 x 0.52 = 4.16 fits a budget of 5
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ health: 13, epf: 12 }) }).status).toBe('found');
  });

  it('walks the staircase down when there is one (cheaper than the HP)', () => {
    const g = plateau({ stairs: true });
    const r = findPath(new NavGrid(g), TOP, { type: 'block', p: { x: -14, y: -60, z: 5 } }, { falls: policy() });
    expect(r.status).toBe('found');
    expect(longDrop(r)).toBeUndefined();
  });

  it('a soft landing needs no budget: hay below the edge (0 HP from 12)', () => {
    const g = plateau({ landing: 'hay_block' });
    const r = findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ healthKnown: false }) });
    expect(r.status).toBe('found');
    expect(longDrop(r)!.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop, 3);
  });

  it('a water bucket: the clutch drop (clutchCost, no HP) even without budget; refused onto a top slab and inside the no-water area', () => {
    const g = plateau();
    const p = policy({ bucket: true, health: 9 });
    const r = findPath(new NavGrid(g), TOP, BELOW, { falls: p });
    expect(r.status).toBe('found');
    expect(longDrop(r)!.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + p.clutchCost, 3);
    const slab = plateau({ landing: 'oak_slab', landingStates: { 'minecraft:vertical_half': 'top' } });
    // the slab strip is the landing all along the east edge; south / north / west the grass still takes a clutch
    const viaSlab = findPath(new NavGrid(slab), TOP, { type: 'block', p: { x: 11, y: -60, z: 5 } }, { falls: p });
    expect(viaSlab.status).toBe('found');
    expect(viaSlab.path.at(-1)!.move).not.toBe('drop'); // landed elsewhere and walked onto the slab
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: { ...p, noWater: { x: 5, y: -60, z: 5, r: 40 } } }).status).toBe('none');
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: { ...p, clutchMax: 10 } }).status).toBe('none');
  });
});

describe('the note on a refused fall', () => {
  it('names the drop, its damage and the refusal', () => {
    const g = plateau();
    const grid = new NavGrid(g);
    const nav = {
      grid,
      fallPolicy: undefined as (() => FallPolicy | undefined) | undefined,
      plan(goal: NavGoalBlock) {
        return findPath(grid, TOP, goal, { falls: this.fallPolicy?.() });
      },
    };
    const guard = (p: FallPolicy | undefined) => ({ policy: () => p, settings: () => ({ longFalls: true, fallMargin: 8, clutch: true, clutchMaxDrop: 40 }), damageOf: (h: number, l?: string) => fallDamage(h, l) });
    expect(explainFallRefusal(nav as never, guard(policy({ health: 12 })), BELOW)).toBe('the way down is a 12-block drop (8 HP), refused: it would leave 4 HP, the margin is 8');
    expect(explainFallRefusal(nav as never, guard(policy({ burning: true })), BELOW)).toBe('the way down is a 12-block drop (8 HP), refused: on fire');
    expect(explainFallRefusal(nav as never, guard(undefined), BELOW)).toBe('the way down is a 12-block drop (8 HP); long falls are off (!set longFalls on)');
    expect(nav.fallPolicy).toBeUndefined(); // restored
  });
});

describe('closed loop: the navigator drops 12 blocks; the FallGuard clutches', () => {
  it('walks off the plateau and arrives (health known: the policy allows the 8 HP)', async () => {
    const g = plateau();
    const h = harness(TOP);
    const world = { ...fakeWorld(g), self: { health: 20, food: 20, healthKnown: true } };
    const skills = new BotSkills({ loop: h.loop, world });
    h.conn.tick(3);
    let res: unknown;
    void skills.goto(BELOW).then((r) => (res = r));
    for (let t = 0; t < 600 && skills.nav.busy; t++) {
      h.conn.tick();
      await flush();
    }
    expect(res).toEqual({ ok: true });
    expect(Math.floor(h.loop.state.pos.x)).toBe(20);
    skills.dispose();
  });

  it('health 12: unreachable with the note', async () => {
    const g = plateau();
    const h = harness(TOP);
    const world = { ...fakeWorld(g), self: { health: 12, food: 20, healthKnown: true } };
    const skills = new BotSkills({ loop: h.loop, world, maxFailures: 1 });
    h.conn.tick(3);
    let res: unknown;
    void skills.goto(BELOW).then((r) => (res = r));
    for (let t = 0; t < 600 && res === undefined; t++) {
      h.conn.tick();
      await flush();
    }
    expect(res).toEqual({ ok: false, reason: 'unreachable', note: 'the way down is a 12-block drop (8 HP), refused: it would leave 4 HP, the margin is 8' });
    skills.dispose();
  });

  /** A FallGuard over a GenWorld with a fake inventory / hotbar / server: the click places water like BDS does. */
  function clutchRig(g: GenWorld, start: Vec3, opts: { bucket?: boolean } = {}) {
    const h = harness(start);
    h.loop.world = blockQueryOf(g);
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    if (opts.bucket ?? true) slots[3] = { name: 'water_bucket', networkId: 1, count: 1, metadata: 0 };
    const inv = { slots, selected: 0, window: (id: number) => (id === 120 ? { slots: [null, null, null, null] } : undefined) };
    const clicks: { tick: bigint; pos: Vec3; slot: number; held: string; eye: Vec3; feet: Vec3 }[] = [];
    const source = {
      queue(name: string, p: unknown) {
        if (name !== 'inventory_transaction') return;
        const d = (p as { transaction: { transaction_data: { block_position: Vec3; hotbar_slot: number; player_pos: Vec3 } } }).transaction.transaction_data;
        const held = slots[d.hotbar_slot]?.name ?? 'air';
        clicks.push({ tick: h.loop.state.tick, pos: { ...d.block_position }, slot: d.hotbar_slot, held, eye: d.player_pos, feet: { ...h.loop.state.pos } });
        // the server: a water bucket on a full block's top puts a source above; an empty bucket on water takes it
        const q = d.block_position;
        if (held === 'water_bucket') {
          g.set(q.x, q.y + 1, q.z, 'water');
          slots[d.hotbar_slot] = { name: 'bucket', networkId: 2, count: 1, metadata: 0 };
        } else if (held === 'bucket' && g.blockAt(q.x, q.y, q.z)?.name === 'water') {
          g.set(q.x, q.y, q.z, 'air');
          slots[d.hotbar_slot] = { name: 'water_bucket', networkId: 1, count: 1, metadata: 0 };
        }
      },
    };
    const selects: number[] = [];
    const hotbar = {
      select: (s: number) => {
        selects.push(s);
        inv.selected = s;
        return true;
      },
      rawItem: () => undefined,
    };
    const guard = new FallGuard({
      loop: h.loop,
      world: { self: { health: 20, healthKnown: true }, inventory: inv, chunks: { runtimeIdAt: () => 0 }, blockAt: (p) => g.blockAt(p.x, p.y, p.z), onBlockUpdate: (fn) => g.onBlockUpdate(fn) },
      grid: new NavGrid(g),
      source: () => source,
      hotbar: () => hotbar,
    });
    return { h, guard, clicks, selects, inv };
  }

  it('reactive clutch from 30 blocks: one click on the stone top within reach before the landing, lands in the water, picks it up, slot restored', async () => {
    const g = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 48, z: 32 });
    g.put(0, -61, 0, 'stone');
    const { h, guard, clicks, selects, inv } = clutchRig(g, { x: 0.5, y: -30, z: 0.5 });
    let landedTick = -1n;
    let inWater = false;
    for (let t = 0; t < 120; t++) {
      h.conn.tick();
      await flush();
      const s = h.loop.state;
      if (landedTick < 0n && (s.onGround || s.inWater)) landedTick = s.tick;
      // the body touches the water from the tick after it reaches the floor (inWater is the start of a tick)
      if (landedTick >= 0n && s.tick <= landedTick + 2n && s.inWater) inWater = true;
    }
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    const place = clicks[0]!;
    expect(place.held).toBe('water_bucket');
    expect(place.pos).toEqual({ x: 0, y: -61, z: 0 });
    expect(cornerDistance(place.eye, place.pos)).toBeLessThanOrEqual(CLUTCH_REACH + 1e-9);
    expect(place.tick).toBeLessThan(landedTick);
    expect(inWater).toBe(true);
    const pickup = clicks[1]!;
    expect(pickup.held).toBe('bucket');
    expect(pickup.pos).toEqual({ x: 0, y: -60, z: 0 });
    expect(g.blockAt(0, -60, 0)?.name).toBe('air');
    expect(inv.slots[3]?.name).toBe('water_bucket');
    expect(guard.last).toMatchObject({ placed: true, recovered: true, pickups: 1 });
    expect(guard.last!.predicted).toBeGreaterThan(15);
    expect(selects.at(-1)).toBe(0); // back to the slot it held before
    expect(guard.busy).toBe(false);
    guard.dispose();
  });

  it('no clutch for a fall that does not hurt, none without a bucket, and refused onto a fence-free top slab', async () => {
    for (const c of [
      { y: -57, bucket: true, block: 'stone', want: 0 }, // 3 blocks: harmless
      { y: -40, bucket: false, block: 'stone', want: 0 },
      { y: -40, bucket: true, block: 'oak_slab', states: { 'minecraft:vertical_half': 'top' }, want: 0 },
    ]) {
      const g = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 48, z: 32 });
      g.put(0, -61, 0, c.block, c.states);
      const { h, guard, clicks } = clutchRig(g, { x: 0.5, y: c.y, z: 0.5 }, { bucket: c.bucket });
      for (let t = 0; t < 60; t++) {
        h.conn.tick();
        await flush();
      }
      expect(clicks.length, JSON.stringify(c)).toBe(c.want);
      if (c.block === 'oak_slab') expect(guard.last?.reason).toMatch(/inside/);
      guard.dispose();
    }
  });
});

describe('planner cost of the long-drop scan', () => {
  it('300 random paths on the hilly world: with falls on the searches stay in budget', () => {
    const w = hillyGen(42);
    const run = (falls: FallPolicy | undefined) => {
      const r = rng(4321);
      const grid = new NavGrid(w);
      const times: number[] = [];
      let drops = 0;
      while (times.length < 300) {
        const sx = Math.floor(r() * 124) - 62;
        const sz = Math.floor(r() * 124) - 62;
        const gx = Math.floor(r() * 124) - 62;
        const gz = Math.floor(r() * 124) - 62;
        const sf = surfaceFeet(w, sx, sz);
        const gf = surfaceFeet(w, gx, gz);
        if (sf === undefined || gf === undefined) continue;
        const res = findPath(grid, { x: sx, y: Math.floor(sf), z: sz }, { type: 'block', p: { x: gx, y: Math.floor(gf), z: gz } }, falls ? { falls } : {});
        if (res.path.length === 0) continue;
        times.push(res.ms);
        if (longDrop(res)) drops++;
      }
      times.sort((a, b) => a - b);
      return { p50: times[150]!, p99: times[297]!, drops };
    };
    run(undefined); // warm-up
    const off = run(undefined);
    const on = run(policy({ bucket: true }));
    console.log(`[fall perf] 300 paths: falls off p50 ${off.p50.toFixed(2)} p99 ${off.p99.toFixed(2)} ms; on p50 ${on.p50.toFixed(2)} p99 ${on.p99.toFixed(2)} ms, ${on.drops} paths with a long drop`);
    expect(on.p99).toBeLessThan(Math.max(80, off.p99 * 2.5));
  });
});
