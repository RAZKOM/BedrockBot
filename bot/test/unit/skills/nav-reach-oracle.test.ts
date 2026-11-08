// Track R1 (docs/pathfinding.md "Reachability (Track R1)"; decisions/0072-reachability.md): the reachability
// oracle (nav/bench/oracle.ts) is checked two ways. Hand-built worlds, one per rule, give the verdict the rules say
// (reachable, closed by that rule, closed by the world). And on small generated worlds the oracle and the planner
// (findPath, the same rules, a budget it never reaches) agree on every pair: the oracle is written apart from the
// planner, so a disagreement is a bug in one of them.
import { describe, expect, it } from 'vitest';
import { fallDamage } from '../../../src/skills/fall/damage.ts';
import { fallPolicy } from '../../../src/skills/fall/policy.ts';
import { findPath, type PathOptions } from '../../../src/skills/nav/astar.ts';
import { breakTicksWith } from '../../../src/skills/nav/baritone/helper.ts';
import { oracle, OWNER_RULES, verdict, type OracleRules } from '../../../src/skills/nav/bench/oracle.ts';
import { HEIGHT, MIN_Y, V, VOX_BLOCKS, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { benchWorld, rng, standable } from '../../../src/skills/nav/bench/worlds.ts';
import { DIG_WAY_MAX_BLOCKS, harmlessFalls } from '../../../src/skills/nav/digway.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { GenWorld } from './genworld.ts';

const TOOLS = ['iron_pickaxe', 'iron_shovel'];
const RULES: OracleRules = { ...OWNER_RULES, tools: TOOLS };
const FLOOR = 0; // the grass top of the hand-built worlds; feet at 1

/** A flat world: bedrock, stone to -1, dirt, grass at 0. */
function flat(sx = 32, sz = 32): Vox {
  const v = new Vox(sx, sz);
  v.fill({ x: 0, y: MIN_Y, z: 0 }, { x: sx - 1, y: MIN_Y, z: sz - 1 }, V.bedrock);
  v.fill({ x: 0, y: MIN_Y + 1, z: 0 }, { x: sx - 1, y: FLOOR - 3, z: sz - 1 }, V.stone);
  v.fill({ x: 0, y: FLOOR - 2, z: 0 }, { x: sx - 1, y: FLOOR - 1, z: sz - 1 }, V.dirt);
  v.fill({ x: 0, y: FLOOR, z: 0 }, { x: sx - 1, y: FLOOR, z: sz - 1 }, V.grass);
  return v;
}

/** The same world as a GenWorld (the planner's terrain source). Only the rows y0 .. y1 are copied. */
function genOf(v: Vox, y0 = -24, y1 = 40): GenWorld {
  const g = new GenWorld({ x: 0, y: y0, z: 0 }, { x: v.sx, y: y1 - y0 + 1, z: v.sz });
  for (let y = y0; y <= y1; y++)
    for (let z = 0; z < v.sz; z++)
      for (let x = 0; x < v.sx; x++) {
        const id = v.get(x, y, z);
        if (id > 0) g.put(x, y, z, VOX_BLOCKS[id]![0], VOX_BLOCKS[id]![1]);
      }
  return g;
}

const POLICY = () => fallPolicy({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: false, clutchOn: true, waterWorks: true, clutchMax: 40 })!;
const INV = { slots: TOOLS.map((name) => ({ name, count: 1 })), selected: 0 };

/** The planner under the owner's rules (dig way, the fall policy) or the plain walk, with a budget it never reaches. */
function planner(v: Vox, s: Vec3, g: Vec3, mode: 'plain' | 'rules', protect?: OracleRules['protect']): boolean {
  const gen = genOf(v);
  const o: PathOptions = {
    maxNodes: 3_000_000,
    maxMs: 120_000,
    allowOpen: true,
    breakTicks: (c) => breakTicksWith(c, INV),
    costs: { dig: 60 },
    ...(protect ? { protectedArea: protect } : {}),
    ...(mode === 'plain' ? { falls: harmlessFalls(POLICY()) } : { allowBreak: true, digWay: { left: DIG_WAY_MAX_BLOCKS }, falls: POLICY(), digOut: true }),
  };
  return findPath(new NavGrid(gen), s, { type: 'block', p: g }, o).status === 'found';
}

const S: Vec3 = { x: 4, y: FLOOR + 1, z: 16 };

describe('Track R1 oracle: one hand-built world per rule', () => {
  it('flat ground: plain reachable', () => {
    const v = flat();
    const r = verdict(v, S, { x: 28, y: 1, z: 16 }, RULES);
    expect(r.verdict).toBe('reachable');
    expect(r.plain).toBe(true);
  });

  it('a 2-high step of dirt: no plain way, the dig way cuts a stair (1 block)', () => {
    const v = flat();
    v.fill({ x: 10, y: 1, z: 0 }, { x: 31, y: 2, z: 31 }, V.dirt);
    const r = verdict(v, S, { x: 20, y: 3, z: 16 }, RULES);
    expect(r.verdict).toBe('reachable');
    expect(r.plain).toBe(false);
    expect(r.dug).toBe(1);
    expect(planner(v, S, { x: 20, y: 3, z: 16 }, 'rules')).toBe(true);
    expect(planner(v, S, { x: 20, y: 3, z: 16 }, 'plain')).toBe(false);
  });

  it('the same step of stone bricks: closed by the built rule', () => {
    const v = flat();
    v.fill({ x: 10, y: 1, z: 0 }, { x: 31, y: 2, z: 31 }, V.bricks);
    const r = verdict(v, S, { x: 20, y: 3, z: 16 }, RULES);
    expect(r.verdict).toBe('rule');
    expect(r.rules).toContain('built');
    expect(r.rules).toContain('place');
  });

  it('the dirt step inside the protected base: closed by the protected area', () => {
    const v = flat();
    v.fill({ x: 10, y: 1, z: 0 }, { x: 31, y: 2, z: 31 }, V.dirt);
    const protect = { x: 16.5, y: 1, z: 16.5, r: 40 };
    const r = verdict(v, S, { x: 20, y: 3, z: 16 }, { ...RULES, protect });
    expect(r.verdict).toBe('rule');
    expect(r.rules).toContain('protected_area');
    expect(planner(v, S, { x: 20, y: 3, z: 16 }, 'rules', protect)).toBe(false);
  });

  it('water behind the step: closed by the liquid rule', () => {
    const v = flat();
    v.fill({ x: 10, y: 1, z: 0 }, { x: 31, y: 2, z: 31 }, V.dirt);
    // water in the step's top row, 3 wide, all along its face: every cut of the face is beside it
    v.fill({ x: 11, y: 2, z: 0 }, { x: 13, y: 2, z: 31 }, V.water);
    const r = verdict(v, S, { x: 20, y: 3, z: 16 }, RULES);
    expect(r.verdict).toBe('rule');
    expect(r.rules).toContain('liquid');
  });

  it('gravel over the face: closed by the gravity rule', () => {
    const v = flat();
    v.fill({ x: 10, y: 1, z: 0 }, { x: 31, y: 2, z: 31 }, V.dirt);
    v.fill({ x: 10, y: 3, z: 0 }, { x: 31, y: 3, z: 31 }, V.gravel); // every cell of the step's top row is under gravel
    const r = verdict(v, S, { x: 20, y: 4, z: 16 }, RULES);
    expect(r.verdict).toBe('rule');
    expect(r.rules).toContain('gravity');
  });

  it('a 6-deep drop: no plain way, the fall within the budget; a 20-deep one kills: closed by the fall policy', () => {
    const v = flat();
    v.fill({ x: 10, y: -5, z: 0 }, { x: 31, y: 0, z: 31 }, V.air);
    const g = { x: 20, y: -5, z: 16 };
    // no stair either: the low ground is bedrock-hard obsidian walls the dig way cannot cut
    v.fill({ x: 10, y: -6, z: 0 }, { x: 10, y: 0, z: 31 }, V.air);
    v.fill({ x: 9, y: -6, z: 0 }, { x: 9, y: 0, z: 31 }, V.obsidian);
    const r = verdict(v, { x: 5, y: 1, z: 16 }, g, RULES);
    expect(r.verdict).toBe('reachable');
    expect(r.dmg).toBe(fallDamage(7, 'stone')); // into the 7-deep column by the wall, then up a step
    const deep = flat();
    deep.fill({ x: 10, y: -20, z: 0 }, { x: 31, y: 0, z: 31 }, V.air);
    deep.fill({ x: 9, y: -20, z: 0 }, { x: 9, y: 0, z: 31 }, V.obsidian);
    const d = verdict(deep, { x: 5, y: 1, z: 16 }, { x: 20, y: -20, z: 16 }, RULES);
    expect(d.verdict).toBe('rule');
    expect(d.rules).toEqual(expect.arrayContaining(['dig_budget']));
  });

  it('a 1x1 tower 5 high: only placing gets on top', () => {
    const v = flat();
    v.fill({ x: 16, y: 1, z: 16 }, { x: 16, y: 5, z: 16 }, V.bricks);
    const r = verdict(v, S, { x: 16, y: 6, z: 16 }, RULES);
    expect(r.verdict).toBe('rule');
    expect(r.rules).toEqual(['place']);
  });

  it('a room of bedrock: closed by the world', () => {
    const v = flat();
    v.fill({ x: 14, y: 1, z: 14 }, { x: 20, y: 5, z: 20 }, V.bedrock);
    v.fill({ x: 15, y: 1, z: 15 }, { x: 19, y: 3, z: 19 }, V.air);
    v.fill({ x: 14, y: -3, z: 14 }, { x: 20, y: 0, z: 20 }, V.bedrock);
    const r = verdict(v, S, { x: 17, y: 1, z: 17 }, RULES);
    expect(r.verdict).toBe('world');
  });

  it('a house with a door: walked in through the door; without the door the built rule', () => {
    const v = flat();
    v.fill({ x: 14, y: 1, z: 12 }, { x: 20, y: 4, z: 20 }, V.planks);
    v.fill({ x: 15, y: 1, z: 13 }, { x: 19, y: 3, z: 19 }, V.air);
    v.fill({ x: 14, y: -3, z: 12 }, { x: 20, y: 0, z: 20 }, V.planks);
    const closed = verdict(v, S, { x: 17, y: 1, z: 16 }, RULES);
    expect(closed.verdict).toBe('rule');
    expect(closed.rules).toContain('built');
    v.set(17, 1, 20, V.doorZLo);
    v.set(17, 2, 20, V.doorZHi);
    const r = verdict(v, { x: 17, y: 1, z: 25 }, { x: 17, y: 1, z: 16 }, RULES);
    expect(r.verdict).toBe('reachable');
    expect(r.plain).toBe(true);
    expect(planner(v, { x: 17, y: 1, z: 25 }, { x: 17, y: 1, z: 16 }, 'plain')).toBe(true);
  });

  it('a flooded tunnel under a bedrock wall: dived through within the air budget, not when it is too long', () => {
    for (const [len, ok] of [
      [4, true],
      [16, false],
    ] as const) {
      const v = flat(48, 16);
      // a 1x2 tunnel of water under the ground at z 8 between two pools; a bedrock wall over it all across
      v.fill({ x: 4, y: -2, z: 8 }, { x: 6 + len + 3, y: -1, z: 8 }, V.water);
      v.fill({ x: 4, y: 0, z: 8 }, { x: 5, y: 0, z: 8 }, V.water);
      v.fill({ x: 7 + len + 1, y: 0, z: 8 }, { x: 6 + len + 3, y: 0, z: 8 }, V.water);
      v.fill({ x: 7, y: 0, z: 0 }, { x: 6 + len, y: 10, z: 15 }, V.bedrock);
      const g = { x: 6 + len + 6, y: 1, z: 8 };
      const o = oracle(v, { x: 1, y: 1, z: 8 }, g, { ...RULES, digBudget: 0, fallBudget: 0 });
      expect(o.reachable, `tunnel ${len}`).toBe(ok);
      expect(planner(v, { x: 1, y: 1, z: 8 }, g, 'plain'), `planner, tunnel ${len}`).toBe(ok);
    }
  });
});

/** Small worlds of hills, walls, water and pits for the cross-check. */
function smallWorld(seed: number): Vox {
  const r = rng(seed);
  const v = new Vox(24, 24);
  for (let z = 0; z < 24; z++)
    for (let x = 0; x < 24; x++) {
      const h = Math.round(2 * Math.sin((x + seed) / 3) + 2 * Math.cos((z - seed) / 4) + (r() < 0.08 ? 2 : 0));
      v.fill({ x, y: MIN_Y, z }, { x, y: MIN_Y, z }, V.bedrock);
      v.fill({ x, y: -12, z }, { x, y: h - 2, z }, V.stone);
      v.fill({ x, y: h - 1, z }, { x, y: h, z }, r() < 0.1 ? V.sand : V.dirt);
    }
  for (let k = 0; k < 3; k++) {
    const x0 = Math.floor(r() * 20);
    const z0 = Math.floor(r() * 20);
    const id = [V.bricks, V.stone, V.water, V.air, V.lava][Math.floor(r() * 5)]!;
    const w = 1 + Math.floor(r() * 3);
    const d = 1 + Math.floor(r() * 8);
    for (let z = z0; z < z0 + d; z++)
      for (let x = x0; x < x0 + w; x++) {
        const t = v.top(x, z);
        if (id === V.air) v.fill({ x, y: t - 4, z }, { x, y: t, z }, V.air);
        else if (id === V.water || id === V.lava) v.set(x, t, z, id);
        else v.fill({ x, y: t + 1, z }, { x, y: t + 3, z }, id);
      }
  }
  return v;
}

describe('Track R1 oracle: agrees with the planner on small generated worlds', () => {
  it('80 pairs on 20 worlds: the same verdict, plain walk and the owner\'s rules', () => {
    const bad: string[] = [];
    let pairs = 0;
    let digOnly = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const v = smallWorld(seed);
      const r = rng(seed * 31);
      const nodes: Vec3[] = [];
      for (let z = 1; z < 23; z++)
        for (let x = 1; x < 23; x++) {
          const t = v.top(x, z) + 1;
          if (t < MIN_Y + HEIGHT && standable(v, x, t, z)) nodes.push({ x, y: t, z });
        }
      for (let k = 0; k < 4; k++) {
        const s = nodes[Math.floor(r() * nodes.length)]!;
        const g = nodes[Math.floor(r() * nodes.length)]!;
        pairs++;
        for (const mode of ['plain', 'rules'] as const) {
          const o = oracle(v, s, g, mode === 'plain' ? { ...RULES, digBudget: 0, fallBudget: 0 } : RULES, { witness: false }).reachable;
          const p = planner(v, s, g, mode);
          if (mode === 'rules' && o && !oracle(v, s, g, { ...RULES, digBudget: 0, fallBudget: 0 }, { witness: false }).reachable) digOnly++;
          if (o !== p) bad.push(`seed ${seed} ${JSON.stringify(s)} -> ${JSON.stringify(g)} ${mode}: oracle ${o} planner ${p}`);
        }
      }
    }
    console.log(`[reach-oracle] ${pairs} pairs, ${digOnly} reachable only with digs or falls, ${bad.length} disagreements${bad.length ? `:\n  ${bad.join('\n  ')}` : ''}`);
    expect(bad).toEqual([]);
  }, 120_000);

  it('the pairs the plain walk cannot do: the same verdict under the owner rules (digs, falls)', () => {
    const bad: string[] = [];
    let pairs = 0;
    let reach = 0;
    for (let seed = 101; seed <= 200 && pairs < 60; seed++) {
      const v = smallWorld(seed);
      const r = rng(seed * 17);
      const nodes: Vec3[] = [];
      for (let z = 1; z < 23; z++)
        for (let x = 1; x < 23; x++) {
          const t = v.top(x, z) + 1;
          if (t < MIN_Y + HEIGHT && standable(v, x, t, z)) nodes.push({ x, y: t, z });
        }
      for (let k = 0; k < 40 && pairs < 60; k++) {
        const s = nodes[Math.floor(r() * nodes.length)]!;
        const g = nodes[Math.floor(r() * nodes.length)]!;
        if (oracle(v, s, g, { ...RULES, digBudget: 0, fallBudget: 0 }, { witness: false }).reachable) continue;
        pairs++;
        const o = oracle(v, s, g, RULES, { witness: false }).reachable;
        if (o) reach++;
        const p = planner(v, s, g, 'rules');
        if (o !== p) bad.push(`seed ${seed} ${JSON.stringify(s)} -> ${JSON.stringify(g)}: oracle ${o} planner ${p}`);
      }
    }
    console.log(`[reach-oracle] ${pairs} pairs the plain walk cannot do, ${reach} reachable under the rules, ${bad.length} disagreements${bad.length ? `:\n  ${bad.join('\n  ')}` : ''}`);
    expect(pairs).toBeGreaterThanOrEqual(40);
    expect(bad).toEqual([]);
  }, 300_000);

  it('the bench worlds are reproducible from the seed', () => {
    const a = benchWorld('caves', 5);
    const b = benchWorld('caves', 5);
    expect(a.pairs).toEqual(b.pairs);
    expect(Buffer.from(a.vox.data).equals(Buffer.from(b.vox.data))).toBe(true);
  });
});
