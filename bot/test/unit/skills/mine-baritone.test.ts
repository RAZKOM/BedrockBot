// Mining v4 (wave 11 Track BD; docs/mining.md "Mining v4: MineProcess", decision 0043): the ported
// MineProcess rules (mine/baritone/mineProcess.ts) and the MineTask loop in mode `baritone` with fake
// skills on a voxel world: coalesce (the three goal shapes, both branches), prune (loaded and still the
// ore, the rule refusals, the shaft hazard below the feet, Y limits, the blacklists, nearest N by estimate,
// dropped items), the rescan on the way (a vanished target re-plans), both `mineSeenOnly` modes (off: a
// buried ore is a candidate and the real planner digs a composite path to it; on: not a target), the
// walk's own dig counted, blacklistClosestOnFailure, the until-n loop (nothing known -> explore -> ore
// known -> mined -> done at n, the rounds in the status and end lines), a pause mid-sweep keeps the job.
import { describe, expect, it } from 'vitest';
import { parseSettingValue } from '../../../src/config/settings.ts';
import { mineEndLine } from '../../../src/chat/commands-farm.ts';
import { MINE_GOAL_UPDATE_TICKS, MINE_MAX_ORE_LOCATIONS, coalesce, compositeOf, droppedItems, estimate, headingMember, memberAt, nearestCandidate, plausibleToBreak, prune, type MineCandidate, type MineGoalContext } from '../../../src/skills/mine/baritone/mineProcess.ts';
import { MineTask, type MineDeps } from '../../../src/skills/mine/miner.ts';
import type { SkillResult } from '../../../src/skills/types.ts';
import { OreMemory } from '../../../src/skills/mine/seen.ts';
import { shaftHazard, type TunnelWorld } from '../../../src/skills/mine/tunnel.ts';
import { findPath } from '../../../src/skills/nav/astar.ts';
import { breakTicksWith } from '../../../src/skills/nav/baritone/helper.ts';
import { goalKey } from '../../../src/skills/nav/blacklist.ts';
import { goalTest, type AnyGoal, type NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { blockInfoOf } from '../../../src/skills/terrain/shapes.ts';
import { MineProcess } from '../../../src/tasks/process/mine.ts';
import { BaseProcess, PRIORITY, ProcessManager, type ProcessStatus } from '../../../src/tasks/process/manager.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { flatGen } from './genworld.ts';

const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
const LIQ = new Set(['water', 'lava']);
const GRAVITY = new Set(['sand', 'gravel']);

/** Stone below y 0, air from y 0 up, in |x|, |z| <= 30, y -30..30; overrides; outside unloaded. */
class World {
  readonly blocks = new Map<string, BlockInfo>();
  private fns: ((p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void)[] = [];
  set(p: Vec3, name: string): void {
    const before = this.blockAt(p);
    const after = blockInfoOf(name);
    this.blocks.set(key(p), after);
    for (const fn of this.fns) fn(p, before, after);
  }
  load(p: Vec3, name: string): void {
    this.blocks.set(key(p), blockInfoOf(name));
  }
  fill(a: Vec3, b: Vec3, name: string): void {
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) for (let z = a.z; z <= b.z; z++) this.load({ x, y, z }, name);
  }
  blockAt(p: Vec3): BlockInfo | undefined {
    if (Math.abs(p.x) > 30 || Math.abs(p.z) > 30 || Math.abs(p.y) > 30) return undefined;
    return this.blocks.get(key(p)) ?? blockInfoOf(p.y < 0 ? 'stone' : 'air');
  }
  find(pred: (b: BlockInfo, p: Vec3) => boolean): Vec3[] {
    const out: Vec3[] = [];
    for (const [k, b] of this.blocks) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      if (pred(b, { x, y, z })) out.push({ x, y, z });
    }
    return out;
  }
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void {
    this.fns.push(fn);
    return () => (this.fns = this.fns.filter((f) => f !== fn));
  }
}

const open = (b: BlockInfo | undefined) => !!b && b.boxes.length === 0 && !LIQ.has(b.name);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** The tunnel planner's world view with the rule set's answers the tests need (protected bricks, liquids beside, gravity above). */
function tworld(w: World): TunnelWorld {
  return {
    blockAt: (p) => w.blockAt(p),
    cell: (p) => {
      const b = w.blockAt(p);
      if (!b) return undefined;
      return { open: open(b), solid: b.boxes.length > 0 && !LIQ.has(b.name), liquid: LIQ.has(b.name), gravity: GRAVITY.has(b.name), dripstone: b.name === 'pointed_dripstone', hazard: LIQ.has(b.name) };
    },
    breakRule: (p) => {
      const b = w.blockAt(p);
      if (!b) return 'unknown';
      if (open(b)) return 'air';
      if (LIQ.has(b.name)) return 'liquid';
      if (b.name === 'stone_bricks' || b.name === 'chest') return 'protected';
      for (const [dx, dy, dz] of N6) if (LIQ.has(w.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })?.name ?? '')) return 'next_to_liquid';
      if (GRAVITY.has(w.blockAt({ x: p.x, y: p.y + 1, z: p.z })?.name ?? '')) return 'gravity_above';
      return undefined;
    },
  };
}

function ctxOf(w: World, feet: Vec3, extra: Partial<MineGoalContext> = {}): MineGoalContext {
  const tw = tworld(w);
  return { blockAt: (p) => w.blockAt(p), breakRule: (p) => tw.breakRule(p), belowRule: (p) => shaftHazard(tw, p), names: new Set(['iron_ore', 'deepslate_iron_ore']), feet, ...extra };
}

const ore = (p: Vec3, name = 'iron_ore'): MineCandidate => ({ kind: 'ore', p, name });

// ---- the ported rules ---------------------------------------------------------------------------------------

describe('coalesce: Baritone MineProcess.coalesce', () => {
  it('default (no forceInternalMining): three blocks, two blocks under a falling block', () => {
    const w = new World();
    w.load({ x: 5, y: -3, z: 0 }, 'iron_ore');
    w.load({ x: 8, y: -3, z: 0 }, 'iron_ore');
    w.load({ x: 8, y: -2, z: 0 }, 'gravel');
    const c = ctxOf(w, { x: 0, y: 0, z: 0 });
    expect(coalesce(c, { x: 5, y: -3, z: 0 }, new Set())).toEqual({ type: 'threeBlocks', p: { x: 5, y: -3, z: 0 } });
    expect(coalesce(c, { x: 8, y: -3, z: 0 }, new Set())).toEqual({ type: 'twoBlocks', p: { x: 8, y: -3, z: 0 } });
  });

  it('forceInternalMining: the asked block above / below decides (the Java comments\' cases)', () => {
    const w = new World();
    const c = ctxOf(w, { x: 0, y: 0, z: 0 }, { forceInternalMining: true });
    const at = (x: number, y: number) => ({ x, y, z: 0 });
    // alone in the stone: symmetric (nothing above, nothing below), nothing two below: two blocks
    w.load(at(1, -5), 'iron_ore');
    expect(coalesce(c, at(1, -5), new Set())).toEqual({ type: 'twoBlocks', p: at(1, -5) });
    // the asked block above only: the ore's own cell (feet in it, head in the one above)
    w.load(at(2, -5), 'iron_ore');
    w.load(at(2, -4), 'iron_ore');
    expect(coalesce(c, at(2, -5), new Set())).toEqual({ type: 'block', p: at(2, -5) });
    // the asked block below and two below: two blocks of the one below
    w.load(at(3, -5), 'iron_ore');
    w.load(at(3, -6), 'iron_ore');
    w.load(at(3, -7), 'iron_ore');
    expect(coalesce(c, at(3, -5), new Set())).toEqual({ type: 'twoBlocks', p: at(3, -6) });
    // the asked block below only: the cell below
    w.load(at(4, -5), 'iron_ore');
    w.load(at(4, -6), 'iron_ore');
    expect(coalesce(c, at(4, -5), new Set())).toEqual({ type: 'block', p: at(4, -6) });
    // above, below and two below: symmetric with a goal two below: three blocks (the checkerboard)
    w.load(at(5, -4), 'iron_ore');
    w.load(at(5, -5), 'iron_ore');
    w.load(at(5, -6), 'iron_ore');
    w.load(at(5, -7), 'iron_ore');
    expect(coalesce(c, at(5, -5), new Set())).toEqual({ type: 'threeBlocks', p: at(5, -5) });
    // air above counts as a goal cell (internalMiningAirException), another candidate too
    w.load(at(6, -1), 'iron_ore');
    expect(coalesce(c, at(6, -1), new Set())).toEqual({ type: 'block', p: at(6, -1) }); // air above, stone below
    w.load(at(7, -5), 'iron_ore');
    expect(coalesce(c, at(7, -5), new Set([key(at(7, -6))]))).toEqual({ type: 'block', p: at(7, -6) }); // a candidate below only
  });

  it('the goals in the planner: done in the column, the heuristic octile to it; the blacklist keys the ore block', () => {
    const two = goalTest({ type: 'twoBlocks', p: { x: 5, y: -3, z: 0 } });
    expect([two.done(5, -3, 0, -3), two.done(5, -4, 0, -4), two.done(5, -5, 0, -5), two.done(4, -3, 0, -3)]).toEqual([true, true, false, false]);
    const three = goalTest({ type: 'threeBlocks', p: { x: 5, y: -3, z: 0 } });
    expect([three.done(5, -3, 0, -3), three.done(5, -4, 0, -4), three.done(5, -5, 0, -5), three.done(5, -6, 0, -6)]).toEqual([true, true, true, false]);
    expect(three.h(0, 0, 0)).toBe(5);
    expect(three.h(5, 10, 0)).toBe(0);
    expect(goalKey({ type: 'threeBlocks', p: { x: 5, y: -3, z: 0 } })).toBe('b:5,-3,0');
    expect(goalKey({ type: 'twoBlocks', p: { x: 5, y: -3, z: 0 } })).toBe('b:5,-3,0');
    const comp = compositeOf(ctxOf(new World(), { x: 0, y: 0, z: 0 }), [ore({ x: 5, y: -3, z: 0 }), { kind: 'drop', p: { x: 2, y: 0, z: 0 }, name: 'raw_iron' }]);
    expect(comp.goal.type).toBe('any');
    expect(comp.goals).toEqual([
      { type: 'threeBlocks', p: { x: 5, y: -3, z: 0 } },
      { type: 'block', p: { x: 2, y: 0, z: 0 } },
    ]);
    expect(memberAt(comp.goals, { x: 5, y: -5, z: 0 })).toBe(0);
    expect(memberAt(comp.goals, { x: 2, y: 0, z: 0 })).toBe(1);
    expect(memberAt(comp.goals, { x: 2, y: -1, z: 0 })).toBe(-1);
  });
});

describe('prune: Baritone MineProcess.prune over the memory\'s candidates', () => {
  it('keeps loaded ore that is still the asked block; drops what is something else now, the blacklisted, the Y limits', () => {
    const w = new World();
    const a = ore({ x: 3, y: -2, z: 0 });
    const gone = ore({ x: 4, y: -2, z: 0 }); // never loaded as ore: stone there
    const low = ore({ x: 5, y: -70, z: 0 });
    const black = ore({ x: 6, y: -2, z: 0 });
    for (const o of [a, low, black]) w.load(o.p, 'iron_ore');
    const r = prune(ctxOf(w, { x: 0, y: 0, z: 0 }, { blocked: (p) => key(p) === key(black.p), minY: -64 }), [a, gone, low, black, a]);
    expect(r.candidates.map((c) => key(c.p))).toEqual([key(a.p)]);
    expect(r.skipped).toEqual([]);
    // an unloaded position the cache remembers is kept (never read); an unloaded one without the cache flag is not
    const far = { ...ore({ x: 40, y: -2, z: 0 }), cached: true };
    const r2 = prune(ctxOf(w, { x: 0, y: 0, z: 0 }), [far, ore({ x: 41, y: -2, z: 0 })]);
    expect(r2.candidates.map((c) => c.p.x)).toEqual([40]);
    expect(r2.skipped.map((s) => s.why)).toEqual(['unloaded']);
  });

  it('plausibleToBreak: the rule set\'s refusals (protected, built, beside lava, gravity above), bedrock, the shaft hazard below the feet', () => {
    const w = new World();
    const at = (x: number) => ({ x, y: -2, z: 0 });
    w.load(at(1), 'iron_ore');
    w.load(at(2), 'iron_ore');
    w.load({ x: 2, y: -2, z: 1 }, 'lava');
    w.load(at(3), 'iron_ore');
    w.load({ x: 3, y: -1, z: 0 }, 'gravel');
    w.load(at(4), 'iron_ore');
    w.load({ x: 4, y: -1, z: 0 }, 'bedrock');
    w.load({ x: 4, y: -3, z: 0 }, 'bedrock');
    w.load(at(5), 'iron_ore');
    w.load({ x: 5, y: -4, z: 0 }, 'lava'); // 2 below the ore (below the feet): the shaft hazard
    w.load(at(8), 'iron_ore');
    w.load({ x: 8, y: -5, z: 1 }, 'pointed_dripstone'); // 3 below, beside
    const c = ctxOf(w, { x: 0, y: 0, z: 0 });
    expect(plausibleToBreak(c, ore(at(1)))).toBeUndefined();
    expect(plausibleToBreak(c, ore(at(2)))).toBe('next_to_liquid');
    expect(plausibleToBreak(c, ore(at(3)))).toBe('gravity_above');
    expect(plausibleToBreak(c, ore(at(4)))).toBe('bedrock');
    expect(plausibleToBreak(c, ore(at(5)))).toMatch(/^liquid_below at 5 -4 0/);
    expect(plausibleToBreak(c, ore(at(8)))).toMatch(/^dripstone_below at 8 -5 1/);
    // the same ore above the feet: the shaft hazard does not apply (the body never digs down into it)
    expect(plausibleToBreak(ctxOf(w, { x: 0, y: -10, z: 0 }), ore(at(5)))).toBeUndefined();
    // protected (a built block in the candidate list, e.g. `!mine stone_bricks` would never pass): skipped with the reason
    w.load(at(7), 'stone_bricks');
    const r = prune(ctxOf(w, { x: 0, y: 0, z: 0 }, { names: new Set(['iron_ore', 'stone_bricks']) }), [ore(at(1)), ore(at(2)), ore(at(3)), ore(at(7), 'stone_bricks')]);
    expect(r.candidates.map((x) => x.p.x)).toEqual([1]);
    expect(r.skipped.map((s) => `${s.p.x}:${s.why}`)).toEqual(['2:next_to_liquid', '3:gravity_above', '7:protected']);
  });

  it('nearest N by the walk estimate (octile + height), not by the straight line; the cap', () => {
    const w = new World();
    // A 4 across and 4 across (octile 5.66, straight 5.66); B 1 across and 5 down (estimate 6, straight 5.1): A first
    const a = ore({ x: 4, y: 0, z: 4 });
    const b = ore({ x: 1, y: -5, z: 0 });
    w.load(a.p, 'iron_ore');
    w.load(b.p, 'iron_ore');
    const far: MineCandidate[] = [];
    for (let i = 0; i < 70; i++) {
      const p = { x: 10 + (i % 20), y: -1 - Math.floor(i / 20), z: 10 };
      w.load(p, 'iron_ore');
      far.push(ore(p));
    }
    const feet = { x: 0, y: 0, z: 0 };
    expect(estimate(feet, a.p)).toBeCloseTo(4 * Math.SQRT2, 6);
    expect(estimate(feet, b.p)).toBe(6);
    expect(nearestCandidate(feet, [a, b])).toBe(b); // Baritone's blacklistClosestOnFailure pick: straight line
    const r = prune(ctxOf(w, feet), [...far, b, a]);
    expect(r.candidates.length).toBe(MINE_MAX_ORE_LOCATIONS);
    expect(r.candidates.slice(0, 2).map((c) => key(c.p))).toEqual([key(a.p), key(b.p)]);
    expect(prune(ctxOf(w, feet, { max: 1 }), [b, a]).candidates.map((c) => key(c.p))).toEqual([key(a.p)]);
    expect(headingMember([b, a], feet)).toBe(1);
  });

  it('dropped items of the job\'s kind are goals of their own, unless an ore within 3 blocks takes them', () => {
    const w = new World();
    const o = ore({ x: 10, y: -1, z: 0 });
    w.load(o.p, 'iron_ore');
    const ents = new Map<bigint, EntityInfo>();
    const item = (id: number, x: number, z: number, name: string): void => {
      ents.set(BigInt(id), { id: BigInt(id), type: 'minecraft:item', pos: { x: x + 0.5, y: 0.1, z: z + 0.5 }, item: { name, count: 1, networkId: 1, metadata: 0 } } as unknown as EntityInfo);
    };
    item(1, 3, 0, 'raw_iron'); // a goal
    item(2, 11, 0, 'raw_iron'); // next to the ore: its collect takes it
    item(3, 5, 0, 'rotten_flesh'); // not the job's kind
    item(4, 3, 0, 'iron_ore'); // the same cell as item 1: one goal
    const drops = droppedItems(ents, (n) => n === 'raw_iron' || n === 'iron_ore', { x: 0, y: 0, z: 0 }, 32);
    expect(drops.map((d) => `${d.kind} ${key(d.p)} ${d.name}`)).toEqual(['drop 3,0,0 raw_iron', 'drop 11,0,0 raw_iron']);
    const r = prune(ctxOf(w, { x: 0, y: 0, z: 0 }), [o], drops);
    expect(r.candidates.map((c) => `${c.kind} ${c.p.x}`)).toEqual(['drop 3', 'ore 10']);
  });
});

// ---- the loop in mode baritone -----------------------------------------------------------------------------

interface H {
  w: World;
  pos: Vec3;
  calls: string[];
  collects: { r: number; origin?: Vec3 }[];
  /** Members the fake planner finds no path to (`unreachable`, no segment). */
  unreachable: Set<string>;
  /** The fake walk digs the ore itself (the feet end in its cell) instead of stopping two below it. */
  walkDigsOre: boolean;
  /** Hold the next goto until `release` is called (the rescan test). */
  hold: boolean;
  release: ((r: SkillResult) => void) | undefined;
  lastGoto: { actions: { dig: number }; segments: number; reached?: { index: number } } | undefined;
  rescan: number;
  ticks: (() => void)[];
  slots: (ItemStack | null)[];
  deps: MineDeps;
}

const feetOf = (p: Vec3) => ({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-6), z: Math.floor(p.z) });

function harness(w: World, start: Vec3 = { x: 0, y: 0, z: 0 }): H {
  const m = new OreMemory(w);
  const tw = tworld(w);
  const h: H = {
    w,
    pos: { x: start.x + 0.5, y: start.y, z: start.z + 0.5 },
    calls: [],
    collects: [],
    unreachable: new Set(),
    walkDigsOre: false,
    hold: false,
    release: undefined,
    lastGoto: undefined,
    rescan: 0,
    ticks: [],
    slots: [{ name: 'iron_pickaxe', networkId: 1, count: 1, metadata: 0 }],
    deps: undefined as never,
  };
  const digCell = (p: Vec3): number => {
    const b = w.blockAt(p);
    if (!b || open(b)) return 0;
    w.set(p, 'air');
    return 1;
  };
  h.deps = {
    skills: {
      goto: (g, o) => {
        h.calls.push(`goto ${g.type}${o?.allowBreak ? ' break' : ''}${o?.allowPlace ? ' place' : ''}`);
        if (g.type !== 'any') {
          if (g.type === 'block') h.pos = { x: g.p.x + 0.5, y: g.p.y, z: g.p.z + 0.5 };
          return Promise.resolve({ ok: true });
        }
        if (h.hold) {
          h.hold = false;
          return new Promise((res) => (h.release = res));
        }
        // the fake planner: the member with the lowest estimate that has a path; its column dug down to the goal feet
        const feet = feetOf(h.pos);
        let best = -1;
        let bestE = Infinity;
        g.goals.forEach((mg, i) => {
          const p = 'p' in mg ? mg.p : undefined;
          if (!p || h.unreachable.has(key(p))) return;
          const e = estimate(feet, p);
          if (e < bestE) {
            bestE = e;
            best = i;
          }
        });
        if (best < 0) {
          h.lastGoto = { actions: { dig: 0 }, segments: 0 };
          return Promise.resolve({ ok: false, reason: 'unreachable' });
        }
        const mg = g.goals[best]!;
        const p = (mg as { p: Vec3 }).p;
        let digs = 0;
        let fy = p.y;
        if (mg.type === 'threeBlocks' || mg.type === 'twoBlocks') {
          fy = h.walkDigsOre || mg.type === 'twoBlocks' ? p.y : p.y - 2;
          for (let y = fy; y <= fy + 1; y++) digs += digCell({ x: p.x, y, z: p.z }); // the body cells of the goal node
        } else digs += digCell(p);
        h.pos = { x: p.x + 0.5, y: fy, z: p.z + 0.5 };
        h.lastGoto = { actions: { dig: digs }, segments: 1, reached: { index: best } };
        return Promise.resolve({ ok: true });
      },
      dig: (p) => {
        h.calls.push(`dig ${key(p)}`);
        w.set(p, 'air');
        const f = feetOf(h.pos);
        if (p.x === f.x && p.z === f.z && p.y === f.y - 1) h.pos = { ...h.pos, y: p.y };
        return Promise.resolve({ ok: true, ticks: 8 });
      },
      collect: (r, _t, o) => {
        h.collects.push({ r, ...(o?.origin ? { origin: o.origin } : {}) });
        const gained: Record<string, number> = o?.origin ? { raw_iron: 1 } : {};
        return Promise.resolve({ ok: true, gained, pickedUp: o?.origin ? 1 : 0, skipped: 0, ticks: 1, corrections: 0 });
      },
      cancel: () => {
        h.calls.push('cancel');
        const rel = h.release;
        h.release = undefined;
        rel?.({ ok: false, reason: 'interrupted' });
      },
      status: () => ({ lastGoto: h.lastGoto }),
    },
    memory: m,
    plan: () => ({ status: 'none', path: [] }),
    walkProbe: () => Promise.resolve(undefined),
    tunnelWorld: tw,
    belowRule: (p) => shaftHazard(tw, p),
    throwaways: () => 0,
    breakRule: (p) => {
      const r = tw.breakRule(p);
      if (r === 'air') return 'air';
      const f = feetOf(h.pos);
      if (p.x === f.x && p.z === f.z && p.y === f.y - 1) return 'under_feet';
      return r;
    },
    stand: () => undefined,
    blockAt: (p) => w.blockAt(p),
    inventory: { slots: h.slots },
    position: () => h.pos,
    health: () => 20,
    ready: () => true,
    waitTicks: () => Promise.resolve(),
    mode: () => 'baritone',
    rescanTicks: () => h.rescan,
  };
  return h;
}

/** A stone wall x 2..14, y 0..6, z -4..4 in front of the bot at the origin (the floor is stone below y 0). */
function wall(): World {
  const w = new World();
  w.fill({ x: 2, y: 0, z: -4 }, { x: 14, y: 6, z: 4 }, 'stone');
  return w;
}

describe('MineTask in mode baritone: one composite goal, the reached ore mined', () => {
  it('a buried ore 6 blocks into the wall (mineSeenOnly off) is a candidate; the walk ends two below it and the ore is dug with requireHarvest', async () => {
    const w = wall();
    w.load({ x: 9, y: 3, z: 0 }, 'iron_ore');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.composites).toBe(1);
    expect(t.stats.compositeMembers).toBe(1);
    expect(h.calls.filter((c) => c.startsWith('goto any'))).toEqual(['goto any break place']);
    expect(h.calls).toContain('dig 9,3,0');
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 3, z: 0 }]);
    expect(t.stats.tunnelled).toBe(2); // the walk's two body cells under the ore
    expect(t.stats.walkDug).toBe(0);
    expect(t.stats.tunnels).toEqual([]); // no direct tunnel plan, no probe
    expect(t.stats.probes).toBe(0);
    expect(t.summary()).toMatch(/mode baritone/);
  });

  it('mineSeenOnly on: the buried ore is no target (none_left, nothing dug); an exposed one is', async () => {
    const w = wall();
    w.load({ x: 9, y: 3, z: 0 }, 'iron_ore');
    const h = harness(w);
    let seenOnly = true;
    const t = new MineTask({ ...h.deps, seenOnly: () => seenOnly });
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('none_left');
    expect(t.stats.composites).toBe(0);
    expect(h.calls.filter((c) => c.startsWith('dig') || c.startsWith('goto'))).toEqual([]);
    w.load({ x: 2, y: 1, z: 0 }, 'iron_ore'); // in the wall's face: an open face to the west
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.minedAt).toEqual([{ x: 2, y: 1, z: 0 }]);
    seenOnly = false;
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 3, z: 0 }]);
  });

  it('the real planner: a composite of threeBlocks goals over a buried ore is found with dig-through moves (allowBreak)', () => {
    const gen = flatGen();
    gen.fill({ x: 2, y: -60, z: -4 }, { x: 14, y: -54, z: 4 }, 'stone');
    gen.put(9, -58, 0, 'iron_ore');
    const grid = new NavGrid(gen);
    const inv = { slots: [{ name: 'iron_pickaxe', count: 1 }], selected: 0 };
    const goal: AnyGoal = { type: 'any', goals: [{ type: 'threeBlocks', p: { x: 9, y: -58, z: 0 } }] };
    const r = findPath(grid, { x: 0, y: -60, z: 0 }, goal, { allowBreak: true, maxNodes: 200_000, maxMs: 20_000, breakTicks: (c) => breakTicksWith(c, inv) });
    expect(r.status).toBe('found');
    const end = r.path.at(-1)!;
    expect(end.x).toBe(9);
    expect(end.z).toBe(0);
    expect([-58, -59, -60]).toContain(end.y);
    const digs = r.path.reduce((n, p) => n + (p.act?.dig?.length ?? 0), 0);
    expect(digs).toBeGreaterThanOrEqual(6);
    // without allowBreak: no path into the stone
    expect(findPath(grid, { x: 0, y: -60, z: 0 }, goal, { maxNodes: 50_000, maxMs: 5_000 }).status).not.toBe('found');
  });

  it('the walk itself may dig the ore (feet in its cell): counted as mined, the vein follows, the drop collected', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    w.load({ x: 10, y: 1, z: 0 }, 'iron_ore'); // its vein
    const h = harness(w);
    h.walkDigsOre = true;
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 2 })).toBe('done');
    expect(t.stats.walkDug).toBe(1);
    expect(t.stats.mined).toBe(2);
    expect(t.stats.veins).toHaveLength(1);
    expect(h.collects.some((c) => c.origin)).toBe(true);
  });

  it('another ore of the composite dug by the walk on the way (in the goal column) counts as mined (e2e: the cave ores)', async () => {
    const w = wall();
    w.load({ x: 9, y: 3, z: 0 }, 'iron_ore');
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore'); // under it: the walk's body cells for the first one
    const h = harness(w);
    h.unreachable.add('9,1,0'); // the fake planner heads for the upper one
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 2 })).toBe('done');
    expect(t.stats.composites).toBe(1);
    expect(t.stats.walkDug).toBe(1);
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 1, z: 0 }, { x: 9, y: 3, z: 0 }]);
  });

  it('the cheapest of several: the fake planner takes the nearest by estimate; a kind whose quota is met drops out', async () => {
    const w = new World();
    const at = (x: number) => ({ x, y: -2, z: 0 });
    w.load(at(3), 'coal_ore');
    w.load(at(5), 'iron_ore');
    w.load(at(7), 'coal_ore');
    w.load(at(9), 'iron_ore');
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 3, kinds: [{ block: 'iron_ore', count: 2 }, { block: 'coal_ore', count: 1 }] })).toBe('done');
    expect(t.stats.minedAt.map((p) => p.x)).toEqual([3, 5, 9]);
    expect(w.blockAt(at(7))?.name).toBe('coal_ore');
    expect(mineEndLine(t)).toBe('mine iron+coal: iron 2/2, coal 1/1 done');
  });

  it('blacklistClosestOnFailure: a goto without a path blacklists the nearest candidate (straight line) and the next composite leaves it out', async () => {
    const w = wall();
    w.load({ x: 4, y: 1, z: 0 }, 'iron_ore'); // the nearest
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    const h = harness(w);
    h.unreachable.add('4,1,0').add('9,1,0'); // the first composite finds no path at all
    const goto0 = h.deps.skills.goto.bind(h.deps.skills);
    h.deps.skills.goto = async (g, o) => {
      const r = await goto0(g, o);
      h.unreachable.clear(); // the second composite (without 4,1,0) walks
      return r;
    };
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.calcFailed).toBe(1);
    expect(t.stats.unreachable).toEqual([{ x: 4, y: 1, z: 0 }]);
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 1, z: 0 }]);
    expect(t.stats.composites).toBe(2);
    expect(w.blockAt({ x: 4, y: 1, z: 0 })?.name).toBe('iron_ore');
  });

  it('blacklistClosestOnFailure after walking a while: the last plan found no path (e2e mine-cave, ores floating over the bot): the closest is unreachable, no 3 failures', async () => {
    const w = wall();
    w.load({ x: 4, y: 1, z: 0 }, 'iron_ore');
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    const h = harness(w);
    const goto0 = h.deps.skills.goto.bind(h.deps.skills);
    let first = true;
    h.deps.skills.goto = async (g, o) => {
      if (g.type === 'any' && first) {
        first = false;
        h.lastGoto = { actions: { dig: 0 }, segments: 2, plans: [{ status: 'found' }, { status: 'none' }] } as H['lastGoto'];
        return { ok: false, reason: 'unreachable' };
      }
      return goto0(g, o);
    };
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.calcFailed).toBe(1);
    expect(t.stats.failures).toBe(0);
    expect(t.stats.unreachable).toEqual([{ x: 4, y: 1, z: 0 }]);
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 1, z: 0 }]);
  });

  it('the rescan on the way: every rescanTicks the candidates are pruned again; the target gone cancels the walk and a new composite follows', async () => {
    const w = wall();
    w.load({ x: 4, y: 1, z: 0 }, 'iron_ore'); // the nearest, taken by someone else on the way
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    const h = harness(w);
    h.rescan = MINE_GOAL_UPDATE_TICKS;
    h.hold = true;
    h.deps.waitTicks = () => new Promise<void>((res) => h.ticks.push(res));
    const t = new MineTask(h.deps);
    const run = t.start({ block: 'iron_ore', count: 1 });
    await new Promise((r) => setTimeout(r, 2));
    expect(h.release).toBeDefined(); // the walk is on, the watcher waits for its first tick
    expect(t.stats.composites).toBe(1);
    w.set({ x: 4, y: 1, z: 0 }, 'stone');
    h.ticks.shift()!(); // 40 ticks later: the rescan
    await new Promise((r) => setTimeout(r, 2));
    expect(h.calls).toContain('cancel');
    expect(t.stats.rescans).toBe(1);
    expect(t.stats.replans).toBe(1);
    // the loop goes on: the next composite (9,1,0 alone) walks at once in the fake
    for (let i = 0; i < 10 && h.ticks.length; i++) {
      h.ticks.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    h.deps.waitTicks = () => Promise.resolve();
    for (const f of h.ticks.splice(0)) f();
    expect(await run).toBe('done');
    expect(t.stats.composites).toBe(2);
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 1, z: 0 }]);
  });

  it('the rules at prune time: beside lava skipped with the reason, under gravel skipped, a lava pocket under an ore below the feet skipped', async () => {
    const w = wall();
    w.load({ x: 5, y: 1, z: 0 }, 'iron_ore');
    w.load({ x: 5, y: 1, z: 1 }, 'lava');
    w.load({ x: 7, y: 1, z: 0 }, 'iron_ore');
    w.load({ x: 7, y: 2, z: 0 }, 'gravel');
    w.load({ x: 0, y: -5, z: 0 }, 'iron_ore');
    w.load({ x: 0, y: -7, z: 0 }, 'lava');
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore'); // the one that is mined
    const h = harness(w);
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('done');
    expect(t.stats.minedAt).toEqual([{ x: 9, y: 1, z: 0 }]);
    expect(new Map(t.stats.unsafe.map((u) => [key(u.p), u.why]))).toEqual(
      new Map([
        ['5,1,0', 'next_to_liquid'],
        ['7,1,0', 'gravity_above'],
        ['0,-5,0', 'liquid_below at 0 -7 0'],
      ]),
    );
    for (const p of ['5,1,0', '7,1,0', '0,-5,0']) expect(w.blockAt({ x: Number(p.split(',')[0]), y: Number(p.split(',')[1]), z: 0 })?.name).toBe('iron_ore');
  });

  it('no pickaxe for the nearest ore ends no_pickaxe; the setting parses', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    const h = harness(w);
    h.slots.length = 0;
    const t = new MineTask(h.deps);
    expect(await t.start({ block: 'iron_ore', count: 1 })).toBe('no_pickaxe');
    expect(parseSettingValue('mineMode', 'baritone')).toBe('baritone');
    expect(parseSettingValue('mineMode', 'V3')).toBe('v3');
    expect(() => parseSettingValue('mineMode', 'legit')).toThrow(/mineMode must be v3 or baritone/);
    expect(new MineTask({ ...h.deps, mode: () => 'v3' }).modeOf()).toBe('v3');
    expect(new MineTask({ ...h.deps, mode: undefined }).modeOf()).toBe('v3');
  });
});

// ---- mine until n: nothing known -> explore -> ore known -> mined -> done ------------------------------------

/** A guard fight stand-in: an auto process at the guard priority that wants control while `want` is set. */
class FakeGuard extends BaseProcess {
  readonly name = 'guard';
  readonly kind = 'auto' as const;
  protected override persistent = true;
  want = false;
  get priority(): number {
    return PRIORITY.guard;
  }
  override wants(): boolean {
    return this.want;
  }
  protected run(): void {}
  protected halt(): void {}
  status(): ProcessStatus {
    return { line: 'guard' };
  }
}

describe('mine until n: the explore fallback, round after round', () => {
  for (const mode of ['baritone', 'v3'] as const) {
    it(`${mode}: nothing known -> explore steps -> the memory learns ore -> mined -> explore again -> done at n; the rounds in the lines`, async () => {
      const w = new World();
      const h = harness(w);
      let steps = 0;
      let blocks = 0;
      const lines: string[] = [];
      const pm = new ProcessManager();
      const ref: { proc?: MineProcess } = {};
      const task = new MineTask({
        ...h.deps,
        mode: () => mode,
        walkProbe: () => Promise.resolve({ status: 'found' as const, path: [{ x: 0, z: 0, feet: 0 }] }),
        plan: () => ({ status: 'found', path: [{}, {}] }),
        explore: () => {
          steps++;
          blocks += 3;
          if (ref.proc && pm.active === ref.proc) lines.push(ref.proc.status().line);
          // the 2nd and the 5th step expose an ore each (the explorer's tunnel walls)
          if (steps === 2) w.set({ x: 3, y: 0, z: 0 }, 'iron_ore');
          if (steps === 5) w.set({ x: -3, y: 0, z: 0 }, 'iron_ore');
          return Promise.resolve(steps < 8); // the explorer's own budget ends it after 8 steps
        },
        exploredBlocks: () => blocks,
      });
      const proc = pm.add(new MineProcess(task, { block: 'iron_ore', count: 2 }));
      ref.proc = proc;
      await new Promise((r) => setTimeout(r, 5));
      expect(await proc.result).toBe('done');
      expect(task.stats.mined).toBe(2);
      expect(task.stats.rounds).toBe(2);
      expect(steps).toBe(5);
      expect(task.exploring).toBeUndefined();
      expect(lines[0]).toBe('mine iron_ore 0/2: exploring (round 1, 3 blocks)');
      expect(lines[2]).toBe('mine iron_ore 1/2: exploring (round 2, 9 blocks)');
      expect(mineEndLine(task)).toBe('mine iron_ore: 2/2 done');
      // the explorer gives up (its budget): none_left with how far it explored
      const t2 = new MineTask({ ...h.deps, mode: () => mode, explore: () => Promise.resolve(++steps < 12), exploredBlocks: () => 40 });
      steps = 0;
      expect(await t2.start({ block: 'iron_ore', count: 5 })).toBe('none_left');
      expect(t2.stats.rounds).toBe(1);
      expect(mineEndLine(t2)).toBe('mine iron_ore: 0/5, no seen iron_ore left, explored 1 round (40 blocks dug)');
      expect(t2.summary()).not.toMatch(/exploring/);
    });
  }

  it('a pause during a drop sweep keeps the job (mode baritone): resumes after the fight and ends done', async () => {
    const w = wall();
    w.load({ x: 9, y: 1, z: 0 }, 'iron_ore');
    const h = harness(w);
    const tick = () => new Promise<void>((res) => setTimeout(res, 1));
    h.deps.waitTicks = () => tick();
    let hold = true;
    let interrupt: (() => void) | undefined;
    const collect0 = h.deps.skills.collect.bind(h.deps.skills);
    h.deps.skills.collect = (rad, t, o) => {
      if (!hold || !o?.filter) return collect0(rad, t, o);
      hold = false;
      return new Promise((res) => (interrupt = () => res({ ok: false, reason: 'interrupted', gained: {}, pickedUp: 0, skipped: 0, ticks: 0, corrections: 0 })));
    };
    const cancel0 = h.deps.skills.cancel.bind(h.deps.skills);
    h.deps.skills.cancel = () => {
      cancel0();
      const f = interrupt;
      interrupt = undefined;
      f?.();
    };
    const pm = new ProcessManager();
    const guard = pm.add(new FakeGuard());
    const task = new MineTask(h.deps);
    const p = pm.add(new MineProcess(task, { block: 'iron_ore', count: 1 }));
    await tick();
    expect(interrupt).toBeDefined();
    guard.want = true;
    pm.tick();
    expect(pm.active).toBe(guard);
    for (let i = 0; i < 10; i++) await tick();
    expect(task.isPaused).toBe(true);
    expect(pm.has(p)).toBe(true);
    expect(p.status().line).toMatch(/\(paused, /);
    guard.want = false;
    pm.tick();
    expect(pm.active).toBe(p);
    expect(await p.result).toBe('done');
    expect(task.stats.mined).toBe(1);
  });
});

/** The goal types in the worker's plain form (no functions): a structured clone keeps them. */
describe('the goals cross the thread boundary', () => {
  it('twoBlocks / threeBlocks are plain data', () => {
    const g: NavGoal = { type: 'any', goals: [{ type: 'threeBlocks', p: { x: 1, y: 2, z: 3 } }, { type: 'twoBlocks', p: { x: 4, y: 5, z: 6 } }] };
    expect(structuredClone(g)).toEqual(g);
  });
});
