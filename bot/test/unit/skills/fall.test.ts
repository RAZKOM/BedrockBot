// Track BI: long falls and the water bucket clutch without a server: the measured Bedrock damage model
// (skills/fall/damage.ts), the waterloggable table and the clutch target rule (waterlog.ts), the live policy
// (policy.ts), the planner's long drops and their costs (fall/plan.ts through nav/astar.ts), the note on a
// refused fall (explain.ts), and the FallGuard's clutch in a closed loop: the click's tick and reach, the
// water in the movement model, the pickup (clutch.ts).
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import { FallGuard, CLUTCH_REACH } from '../../../src/skills/fall/clutch.ts';
import { countedFall, epfFactor, fallDamage, fallEpf, landingFactor, landingTick, maxDropFor } from '../../../src/skills/fall/damage.ts';
import { EXPLAIN_MS, explainFallRefusal } from '../../../src/skills/fall/explain.ts';
import { acceptsDrop } from '../../../src/skills/fall/plan.ts';
import { clutchHelps, fallPolicy, shouldClutch, type FallPolicy, type FallPolicyInputs } from '../../../src/skills/fall/policy.ts';
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
    for (const n of ['oak_slab', 'oak_stairs', 'oak_fence', 'cobblestone_wall', 'glass_pane', 'iron_bars', 'oak_leaves', 'azalea_leaves_flowered', 'azalea_leaves', 'cherry_leaves', 'scaffolding', 'lantern', 'copper_grate', 'mangrove_roots', 'ladder', 'campfire', 'chest', 'spruce_trapdoor', 'standing_sign', 'oak_hanging_sign']) expect(isWaterloggable(n), n).toBe(true);
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
    expect(refused('azalea_leaves_flowered')).toMatch(/inside/); // review B2: not a plain full block
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

  it('B1: a water bucket never makes a drop beyond the budget plannable (a failed clutch must not kill)', () => {
    const g = plateau();
    for (const health of [9, 15]) expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ bucket: true, health }) }).status, `health ${health}`).toBe('none');
    expect(findPath(new NavGrid(g), TOP, BELOW, { falls: policy({ bucket: true, healthKnown: false }) }).status).toBe('none');
  });

  it('B4: within the budget a drop the FallGuard will clutch (more than half the budget) is priced as the clutch + a quarter of the HP; a small one stays a damage drop', () => {
    const g = plateau();
    const p = policy({ bucket: true }); // budget 12, 8 HP > 6: the guard clutches it
    const r = findPath(new NavGrid(g), TOP, BELOW, { falls: p });
    expect(r.status).toBe('found');
    expect(longDrop(r)!.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + p.clutchCost + 0.25 * 8 * p.hpCost, 3);
    // absorption 8: budget 20, 8 HP is not more than half: no clutch, the damage drop
    const q = policy({ bucket: true, absorption: 8 });
    expect(longDrop(findPath(new NavGrid(g), TOP, BELOW, { falls: q }))!.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + 8 * q.hpCost, 3);
    // a tie goes to the damage drop: clutchCost = 0.75 x the HP cost
    const tie = { ...p, clutchCost: 0.75 * 8 * p.hpCost };
    expect(longDrop(findPath(new NavGrid(g), TOP, BELOW, { falls: tie }))!.cost).toBeCloseTo(dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + 8 * p.hpCost, 3);
    // onto a top slab, inside the no-water area, over clutchMax: the plain damage drop
    const plain = dropCost(DEFAULT_COSTS, 12) + DEFAULT_COSTS.irreversibleDrop + 8 * p.hpCost;
    expect(longDrop(findPath(new NavGrid(g), TOP, BELOW, { falls: { ...p, noWater: { x: 5, y: -60, z: 5, r: 40 } } }))!.cost).toBeCloseTo(plain, 3);
    expect(longDrop(findPath(new NavGrid(g), TOP, BELOW, { falls: { ...p, clutchMax: 10 } }))!.cost).toBeCloseTo(plain, 3);
    const slab = plateau({ landing: 'oak_slab', landingStates: { 'minecraft:vertical_half': 'top' } });
    const viaSlab = findPath(new NavGrid(slab), TOP, { type: 'block', p: { x: 11, y: -60, z: 5 } }, { falls: p });
    expect(viaSlab.status).toBe('found');
    expect(longDrop(viaSlab)!.x).not.toBe(11); // a top slab takes no clutch: the clutch drop lands on the grass beside and walks
  });

  it('a ladder in the column is no fall (the climb moves take it)', () => {
    const g = plateau();
    for (let z = 0; z <= 10; z++) g.fill({ x: 11, y: -60, z }, { x: 11, y: -52, z }, 'ladder', { facing_direction: 5 });
    const r = findPath(new NavGrid(g), TOP, BELOW, { falls: policy() });
    expect(longDrop(r)?.y === -60 && longDrop(r)?.x === 11).toBe(false);
  });

  it('acceptsDrop: the live policy re-checked before the step off (health dropped, the bucket gone)', () => {
    const g = plateau();
    const grid = new NavGrid(g);
    const from = { y: -48, feet: -48 };
    const to = { x: 11, y: -60, z: 5 };
    expect(acceptsDrop(grid, DEFAULT_COSTS, policy(), from, to)).toBe(true);
    expect(acceptsDrop(grid, DEFAULT_COSTS, policy({ health: 12 }), from, to)).toBe(false);
    expect(acceptsDrop(grid, DEFAULT_COSTS, policy({ hostileDistance: 5 }), from, to)).toBe(false);
    expect(acceptsDrop(grid, DEFAULT_COSTS, undefined, from, to)).toBe(false);
    expect(acceptsDrop(grid, { ...DEFAULT_COSTS, maxDrop: 1 }, policy(), from, to)).toBe(false);
  });
});

describe('B4: the reactive clutch rule (shouldClutch)', () => {
  const s = (o: Partial<Parameters<typeof shouldClutch>[0]>) => shouldClutch({ damage: 8, health: 20, absorption: 0, margin: 8, ...o });
  it('only when it matters: past half of what is above the margin, past the margin, or a kill', () => {
    expect(s({ damage: 1 }).yes).toBe(false);
    expect(s({ damage: 6 }).yes).toBe(false); // exactly half of 12
    expect(s({ damage: 6.5 }).yes).toBe(true);
    expect(s({ damage: 3, health: 10 }).yes).toBe(true); // 2 above the margin
    expect(s({ damage: 30 }).yes).toBe(true);
    expect(s({ damage: 8, absorption: 8 }).yes).toBe(false); // 20 above the margin
  });
  it('never in creative; in the base and in a fight only when the fall would kill', () => {
    expect(s({ damage: 30, noDamage: true }).yes).toBe(false);
    expect(s({ damage: 10, inBase: true })).toEqual({ yes: false, reason: 'inside the base (only a fall that would kill)' });
    expect(s({ damage: 20, inBase: true }).yes).toBe(true);
    expect(s({ damage: 10, inCombat: true }).yes).toBe(false);
    expect(s({ damage: 25, inCombat: true }).yes).toBe(true);
  });
  it('clutchHelps (the planner side) matches', () => {
    expect(clutchHelps(6, { hpBudget: 12 })).toBe(false);
    expect(clutchHelps(6.5, { hpBudget: 12 })).toBe(true);
    expect(clutchHelps(1, { hpBudget: 0 })).toBe(true);
  });
});

describe('the note on a refused fall', () => {
  it('names the drop, its damage and the refusal', () => {
    const g = plateau();
    const grid = new NavGrid(g);
    const nav = { grid, planOptions: () => ({}) };
    const guard = (p: FallPolicy | undefined) => ({ policy: () => p, settings: () => ({ longFalls: true, fallMargin: 8, clutch: true, clutchMaxDrop: 40 }), damageOf: (h: number, l?: string) => fallDamage(h, l) });
    expect(explainFallRefusal(nav, guard(policy({ health: 12 })), TOP, BELOW)).toBe('the way down is a 12-block drop (8 HP), refused: it would leave 4 HP, the margin is 8');
    expect(explainFallRefusal(nav, guard(policy({ burning: true })), TOP, BELOW)).toBe('the way down is a 12-block drop (8 HP), refused: on fire');
    expect(explainFallRefusal(nav, guard(undefined), TOP, BELOW)).toBe('the way down is a 12-block drop (8 HP); long falls are off (!set longFalls on)');
    expect(explainFallRefusal(nav, guard(undefined), undefined, BELOW)).toBeUndefined();
    // the budget: a big world is cut off, never a long block of the tick
    const big = new NavGrid(hillyGen(7));
    const t0 = performance.now();
    explainFallRefusal({ grid: big, planOptions: () => ({}) }, guard(policy()), { x: -60, y: -40, z: -60 }, { type: 'block', p: { x: 60, y: -40, z: 60 } });
    expect(performance.now() - t0).toBeLessThan(EXPLAIN_MS * 8);
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

  it('the drop is re-checked before the step off: health drops to 12 on the way to the edge -> no drop, unreachable with the note', async () => {
    const g = plateau();
    const start = { x: 2, y: -48, z: 5 };
    const h = harness(start);
    const self = { health: 20, food: 20, healthKnown: true };
    const world = { ...fakeWorld(g), self };
    const skills = new BotSkills({ loop: h.loop, world, maxFailures: 1 });
    h.conn.tick(3);
    let res: unknown;
    void skills.goto(BELOW).then((r) => (res = r));
    let minFeet = Infinity;
    for (let t = 0; t < 600 && res === undefined; t++) {
      if (t === 5) self.health = 12; // planned with 20 (budget 12); now the 8 HP would leave 4
      h.conn.tick();
      await flush();
      minFeet = Math.min(minFeet, h.loop.state.pos.y);
    }
    expect(minFeet).toBeGreaterThan(-48.1); // never stepped off
    expect(res).toEqual({ ok: false, reason: 'unreachable', note: 'the way down is a 12-block drop (8 HP), refused: it would leave 4 HP, the margin is 8' });
    skills.dispose();
  });

  it('M1: two chained 13-block drops at 20 HP (margin 8): the second is refused while the first landing\'s health packet has not come', async () => {
    // a tower (feet -34) on a wide step (feet -47) on the ground (feet -60): 13 + 13 blocks, 10 HP each
    const g = flatGen({ x: -32, y: -64, z: -32 }, { x: 72, y: 40, z: 64 });
    g.fill({ x: 0, y: -60, z: 0 }, { x: 9, y: -48, z: 10 }, 'stone');
    g.fill({ x: 0, y: -47, z: 0 }, { x: 6, y: -35, z: 10 }, 'stone');
    const h = harness({ x: 3, y: -34, z: 5 });
    const self = { health: 20, food: 20, healthKnown: true };
    const skills = new BotSkills({ loop: h.loop, world: { ...fakeWorld(g), self }, maxFailures: 1 });
    h.conn.tick(3);
    let res: { ok: boolean } | undefined;
    void skills.goto({ type: 'block', p: { x: 30, y: -60, z: 5 } }).then((r) => (res = r));
    let minFeet = Infinity;
    let landed = -1;
    let budgetAfterLanding: number | undefined;
    for (let t = 0; t < 800 && res === undefined; t++) {
      h.conn.tick();
      await flush();
      const y = h.loop.state.pos.y;
      minFeet = Math.min(minFeet, y);
      if (landed < 0 && h.loop.state.onGround && y < -46.9) {
        landed = t;
      }
      if (landed >= 0 && t === landed + 2) {
        budgetAfterLanding = skills.falls.policy()!.hpBudget; // the guard sees the landing on the next tick
      }
      if (landed >= 0 && t === landed + 30) self.health = 10; // the landing's health packet, 30 ticks late
    }
    expect(landed).toBeGreaterThan(0);
    expect(budgetAfterLanding).toBeCloseTo(2, 3); // 20 still shown - 10 pending - 8
    expect(minFeet).toBeGreaterThan(-47.1); // the first drop taken, never the second
    expect(res?.ok).toBe(false);
    skills.dispose();
  });

  /** A FallGuard over a GenWorld with a fake inventory / hotbar / server: the click places water like BDS does. */
  function clutchRig(g: GenWorld, start: Vec3, opts: { bucket?: boolean; health?: number; gameMode?: string; keepFullBucket?: boolean; throwOnPickup?: boolean } = {}) {
    const h = harness(start);
    h.loop.world = blockQueryOf(g);
    const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
    if (opts.bucket ?? true) slots[3] = { name: 'water_bucket', networkId: 1, count: 1, metadata: 0 };
    const inv = { slots, selected: 0, window: (id: number) => (id === 120 ? { slots: [null, null, null, null] } : undefined) };
    const clicks: { tick: bigint; pos: Vec3; slot: number; held: string; eye: Vec3; feet: Vec3 }[] = [];
    const handlers = new Map<string, ((p: Record<string, unknown>) => void)[]>();
    const source = {
      on(name: string, fn: (p: Record<string, unknown>) => void) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
      emit(name: string, p: Record<string, unknown>) {
        for (const fn of handlers.get(name) ?? []) fn(p);
      },
      queue(name: string, p: unknown) {
        if (name !== 'inventory_transaction') return;
        const d = (p as { transaction: { transaction_data: { block_position: Vec3; hotbar_slot: number; player_pos: Vec3 } } }).transaction.transaction_data;
        const held = slots[d.hotbar_slot]?.name ?? 'air';
        if (held === 'bucket' && opts.throwOnPickup) throw new Error('boom');
        clicks.push({ tick: h.loop.state.tick, pos: { ...d.block_position }, slot: d.hotbar_slot, held, eye: d.player_pos, feet: { ...h.loop.state.pos } });
        // the server: a water bucket on a full block's top puts a source above; an empty bucket on water takes it
        const q = d.block_position;
        if (held === 'water_bucket') {
          g.set(q.x, q.y + 1, q.z, 'water');
          if (!opts.keepFullBucket) slots[d.hotbar_slot] = { name: 'bucket', networkId: 2, count: 1, metadata: 0 };
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
      world: { self: { health: opts.health ?? 20, healthKnown: true, runtimeId: 7n, ...(opts.gameMode ? { gameMode: opts.gameMode } : {}) }, inventory: inv, chunks: { runtimeIdAt: () => 0 }, blockAt: (p) => g.blockAt(p.x, p.y, p.z), onBlockUpdate: (fn) => g.onBlockUpdate(fn) },
      grid: new NavGrid(g),
      source: () => source,
      hotbar: () => hotbar,
    });
    return { h, guard, clicks, selects, inv, source };
  }

  /** A fall from feet y over a stone block at (0, -61, 0) in a flat world, run for `ticks`. */
  async function fallRun(y: number, opts: Parameters<typeof clutchRig>[2] & { setup?: (g: GenWorld) => void; before?: (r: ReturnType<typeof clutchRig>) => void; ticks?: number; x?: number } = {}) {
    const g = flatGen({ x: -16, y: -64, z: -16 }, { x: 32, y: 60, z: 32 });
    g.put(0, -61, 0, 'stone');
    opts.setup?.(g);
    const r = clutchRig(g, { x: opts.x ?? 0.5, y, z: 0.5 }, opts);
    opts.before?.(r);
    for (let t = 0; t < (opts.ticks ?? 120); t++) {
      r.h.conn.tick();
      await flush();
    }
    return { ...r, g };
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

  describe('review fixes: when the FallGuard does not clutch, and how it always ends', () => {
  const placeClicks = (c: { held: string }[]) => c.filter((k) => k.held === 'water_bucket').length;

  it('M2: a vine wall beside the fall (not in the feet cell) slows nothing: the clutch still fires', async () => {
    // the body at x 0.75 (box 0.45 .. 1.05), vines in column x 1 all the way down: the server counts the fall in full
    const r = await fallRun(-30, { x: 0.75, setup: (g) => g.fill({ x: 1, y: -60, z: 0 }, { x: 1, y: -35, z: 0 }, 'vine', { vine_direction_bits: 8 }) });
    expect(placeClicks(r.clicks)).toBe(1);
    expect(r.guard.last).toMatchObject({ placed: true, recovered: true });
    r.guard.dispose();
  });

  it('B3: no clutch through a ladder column, a cobweb, or with Slow Falling', async () => {
    const ladder = await fallRun(-30, { setup: (g) => g.fill({ x: 0, y: -60, z: 0 }, { x: 0, y: -40, z: 0 }, 'ladder', { facing_direction: 2 }), ticks: 300 });
    expect(placeClicks(ladder.clicks), 'ladder').toBe(0);
    ladder.guard.dispose();
    const web = await fallRun(-30, { setup: (g) => g.put(0, -56, 0, 'web'), ticks: 300 });
    expect(placeClicks(web.clicks), 'web').toBe(0); // the web ends the fall; 4 blocks below it are 1 HP: no clutch
    web.guard.dispose();
    const slow = await fallRun(-30, {
      before: (r) => {
        r.h.conn.tick(); // the guard subscribes to mob_effect on its first tick
        r.source.emit('mob_effect', { runtime_entity_id: 7n, event_id: 'add', effect_id: 27 });
      },
    });
    expect(placeClicks(slow.clicks), 'slow falling').toBe(0);
    slow.guard.dispose();
  });

  it('B4: no clutch for a fall within the margin, in creative, in a fight or in the base unless it kills', async () => {
    const small = await fallRun(-54); // 6 blocks: 3 HP of 12 above the margin
    expect(placeClicks(small.clicks)).toBe(0);
    expect(small.guard.last?.reason ?? 'none').toMatch(/none|enough above the margin/);
    small.guard.dispose();
    const creative = await fallRun(-30, { gameMode: 'creative' });
    expect(placeClicks(creative.clicks)).toBe(0);
    creative.guard.dispose();
    const fight16 = await fallRun(-40, { before: (r) => (r.guard.inCombat = () => true) }); // 20 blocks, 16 HP < 20: no
    expect(placeClicks(fight16.clicks)).toBe(0);
    fight16.guard.dispose();
    const fightKill = await fallRun(-30, { before: (r) => (r.guard.inCombat = () => true) }); // 30 blocks, 26 HP: kills, clutch
    expect(placeClicks(fightKill.clicks)).toBe(1);
    fightKill.guard.dispose();
    const base = await fallRun(-40, { before: (r) => (r.guard.protect = () => ({ x: 0, y: -60, z: 0, r: 48 })) });
    expect(placeClicks(base.clicks)).toBe(0);
    expect(base.guard.last?.reason).toMatch(/base/);
    base.guard.dispose();
    const baseKill = await fallRun(-30, { before: (r) => (r.guard.protect = () => ({ x: 0, y: -60, z: 0, r: 48 })) });
    expect(placeClicks(baseKill.clicks)).toBe(1);
    expect(baseKill.guard.last).toMatchObject({ placed: true, recovered: true });
    baseKill.guard.dispose();
  });

  it('H1: a bucket that never empties: the guard gives up within its timeout, counts the water left and releases the navigator', async () => {
    const r = await fallRun(-30, { keepFullBucket: true, ticks: 260 });
    expect(placeClicks(r.clicks)).toBe(1);
    expect(r.guard.busy).toBe(false);
    expect(r.guard.settling).toBe(false);
    expect(r.guard.recovering).toBe(false);
    expect(r.guard.stats.waterLeft).toBe(1);
    expect(r.guard.last?.reason).toMatch(/no pickup within/);
    expect(r.inv.selected).toBe(0);
    r.guard.dispose();
  });

  it('an exception mid-clutch and a dispose mid-clutch finish it: the slot and the pitch come back, the water is counted', async () => {
    const r = await fallRun(-30, { throwOnPickup: true });
    expect(r.guard.busy).toBe(false);
    expect(r.guard.stats.waterLeft).toBe(1);
    expect(r.guard.last?.reason).toMatch(/error/);
    expect(r.inv.selected).toBe(0);
    expect(r.h.loop.command.pitch).toBe(0);
    r.guard.dispose();
    const d = await fallRun(-30, { ticks: 24 }); // armed (the bucket selected, looking down), not landed yet
    expect(d.guard.busy).toBe(true);
    expect(d.inv.selected).toBe(3);
    d.guard.dispose();
    expect(d.guard.busy).toBe(false);
    expect(d.inv.selected).toBe(0);
    expect(d.h.loop.command.pitch).toBe(0);
  });
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
