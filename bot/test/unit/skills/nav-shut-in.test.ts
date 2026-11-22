// Track E9 (docs/pathfinding.md "Shut in"; decisions/0111-way-home-and-morning.md): a walk that starts where a mining
// walk left the body. The replicas are the places Track E7's fresh-world runs refused the walk home from, as the
// planner saw them (their world caches asked offline): the foot of a one-wide shaft dug straight down from the
// surface with the body on its own cobblestone pillar part of the way up (plains: `no move from the start`, 1 node
// expanded), and a pocket at the end of a dug way whose drops no jump takes back (a desert: 24 nodes expanded). The
// plain walk and the dig way's 12 blocks both end in an exhaustive `none`; the way out is a stair of 13 to 61 dug
// blocks. Planner checks first, then closed loops (FakeConnection -> InputLoop <- BotSkills / Navigator with fake dig
// actions on the generated world).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BotSkills } from '../../../src/skills/index.ts';
import type { NavActions } from '../../../src/skills/nav/actions.ts';
import { findPath, type PathNode, type PathOptions, type PathResult } from '../../../src/skills/nav/astar.ts';
import { DIG_OUT_MAX_BLOCKS, DIG_WAY_MAX_BLOCKS } from '../../../src/skills/nav/digway.ts';
import type { NavGoal } from '../../../src/skills/nav/goals.ts';
import { NavGrid } from '../../../src/skills/nav/grid.ts';
import { RULE_WORDS, walkFailWords } from '../../../src/skills/nav/reach.ts';
import { furnaceReasonText, placeFurnace } from '../../../src/skills/food/furnace.ts';
import { NightSafety } from '../../../src/tasks/night.ts';
import type { GotoOptions, SkillResult } from '../../../src/skills/types.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { fakeWorld, harness } from './fakes.ts';
import { GenWorld } from './genworld.ts';

/** The top block of the ground (a body on it has its feet at S + 1). */
const S = -30;

/** Stone under 3 dirt and grass, 64 x 48 wide, from bedrock at -64 to 12 of air over the ground. */
function ground(): GenWorld {
  const from = { x: -24, y: -64, z: -24 };
  const size = { x: 64, y: S + 13 - -64, z: 48 };
  const w = new GenWorld(from, size);
  const x1 = from.x + size.x - 1;
  const z1 = from.z + size.z - 1;
  w.fill({ x: from.x, y: -64, z: from.z }, { x: x1, y: -64, z: z1 }, 'bedrock');
  w.fill({ x: from.x, y: -63, z: from.z }, { x: x1, y: S - 4, z: z1 }, 'stone');
  w.fill({ x: from.x, y: S - 3, z: from.z }, { x: x1, y: S - 1, z: z1 }, 'dirt');
  w.fill({ x: from.x, y: S, z: from.z }, { x: x1, y: S, z: z1 }, 'grass_block');
  return w;
}

/**
 * The plains shaft: a one-wide shaft dug straight down from the surface, 15 deep; the mining walk pillared 5 back up
 * with cobblestone and the night rule's walk started from there, the feet 9 under the ground's top block (the run's
 * shaft was 11 deep with the feet 6 and 7 under it, in ground whose dirt lay deeper).
 */
function shaftWorld(): { gen: GenWorld; start: Vec3; goal: NavGoal } {
  const gen = ground();
  gen.fill({ x: 0, y: S - 14, z: 0 }, { x: 0, y: S, z: 0 }, 'air');
  gen.fill({ x: 0, y: S - 14, z: 0 }, { x: 0, y: S - 10, z: 0 }, 'cobblestone');
  return { gen, start: { x: 0.5, y: S - 9, z: 0.5 }, goal: { type: 'block', p: { x: 20, y: S + 1, z: 6 } } };
}

/**
 * The desert pocket: a dug way in whose last legs are drops of 3 (a walk goes down them, no jump comes back up): a
 * short gallery 19 under the ground, a 3-high step up to a second one, and the shaft the way came down, 3 over that.
 */
function pocketWorld(): { gen: GenWorld; start: Vec3; goal: NavGoal } {
  const gen = ground();
  const y = S - 19;
  gen.fill({ x: 0, y, z: 0 }, { x: 3, y: y + 1, z: 0 }, 'air'); // the lower gallery
  gen.fill({ x: 4, y: y + 3, z: 0 }, { x: 7, y: y + 4, z: 0 }, 'air'); // the upper one, its floor 3 over the lower one's
  gen.fill({ x: 4, y: y + 1, z: 0 }, { x: 4, y: y + 2, z: 0 }, 'air'); // the drop between them
  gen.fill({ x: 8, y: y + 6, z: 0 }, { x: 8, y: y + 9, z: 0 }, 'air'); // and the drop into the upper one
  gen.fill({ x: 8, y: y + 3, z: 0 }, { x: 8, y: y + 5, z: 0 }, 'air');
  return { gen, start: { x: 0.5, y, z: 0.5 }, goal: { type: 'near', p: { x: 30, y: S + 1, z: -10 }, r: 3 } };
}

const cell = (p: Vec3): Vec3 => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const digs = (r: PathResult): Vec3[] => r.path.flatMap((n: PathNode) => n.act?.dig ?? []);
const way = (left: number): PathOptions => ({ allowBreak: true, digWay: { left }, costs: { dig: 60 }, maxNodes: 400_000, maxMs: 20_000 });

describe('Track E9 planner: what the refused walks saw (the reproduction)', () => {
  it('the shaft: the plain walk has no move at all, the dig way of 12 blocks none either: both exhaustive, no unloaded world touched', () => {
    const { gen, start, goal } = shaftWorld();
    const plain = findPath(new NavGrid(gen), cell(start), goal, { maxNodes: 40_000 });
    expect(plain.status).toBe('none');
    expect(plain.expanded).toBe(1); // the run's line: `plans start:none/1n/1e`
    expect(plain.unknown).toBe(false);
    expect(plain.limited).toBe(false);
    const dug = findPath(new NavGrid(gen), cell(start), goal, way(DIG_WAY_MAX_BLOCKS));
    expect(dug.status).toBe('none'); // `retry:none/1n/491e`: every cell 12 digs reach, and no way up among them
    expect(dug.unknown).toBe(false);
    expect(dug.expanded).toBeGreaterThan(100);
  });

  it('the shaft: a stair of more than 12 dug blocks is the way out, natural blocks only (never the pillar the walk stands on)', () => {
    const { gen, start, goal } = shaftWorld();
    const r = findPath(new NavGrid(gen), cell(start), goal, way(DIG_OUT_MAX_BLOCKS));
    expect(r.status).toBe('found');
    expect(digs(r).length).toBeGreaterThan(DIG_WAY_MAX_BLOCKS);
    expect(digs(r).length).toBeLessThanOrEqual(30); // the run's world: 15 and 18
    for (const d of digs(r)) expect(['stone', 'dirt', 'grass_block']).toContain(gen.blockAt(d.x, d.y, d.z)?.name);
  });

  it('the pocket: the plain walk ends in its two galleries, the dig way of 12 does not reach the ground either', () => {
    const { gen, start, goal } = pocketWorld();
    const plain = findPath(new NavGrid(gen), cell(start), goal, { maxNodes: 40_000 });
    expect(plain.status).toBe('none');
    expect(plain.expanded).toBeLessThan(40); // the run's: 24
    expect(plain.unknown).toBe(false);
    expect(findPath(new NavGrid(gen), cell(start), goal, way(DIG_WAY_MAX_BLOCKS)).status).toBe('none');
    const out = findPath(new NavGrid(gen), cell(start), goal, way(DIG_OUT_MAX_BLOCKS));
    expect(out.status).toBe('found');
    expect(digs(out).length).toBeGreaterThan(DIG_WAY_MAX_BLOCKS);
    expect(digs(out).length).toBeLessThanOrEqual(64);
  });
});

interface Drive {
  result: SkillResult | undefined;
  ticks: number;
  pos: Vec3;
  skills: BotSkills;
  log: string[];
  maxFall: number;
  info: string[];
}

/** Fake dig actions on the GenWorld: 8 ticks a block (or `digTicks`). */
function fakeActions(gen: GenWorld, log: string[], loop: { waitTicks(n: number): Promise<void> }, digTicks = 8): NavActions {
  return {
    dig: async (p) => {
      log.push(`dig ${p.x},${p.y},${p.z} ${gen.blockAt(p.x, p.y, p.z)?.name}`);
      await loop.waitTicks(digTicks);
      gen.set(p.x, p.y, p.z, 'air');
      return { ok: true };
    },
  };
}

async function drive(gen: GenWorld, start: Vec3, goal: NavGoal, opts: { digWay?: boolean; health?: number; maxTicks?: number; goto?: GotoOptions; digTicks?: number } = {}): Promise<Drive> {
  const { conn, loop } = harness(start);
  const log: string[] = [];
  const info: string[] = [];
  const world = { ...fakeWorld(gen), self: { health: opts.health ?? 20, food: 20, healthKnown: true } };
  const logger = { debug() {}, info: (m: string) => info.push(m), warn: (m: string) => info.push(m), error() {} };
  const skills = new BotSkills({ loop, world, actions: fakeActions(gen, log, loop, opts.digTicks), logger, mainMs: 2000, digWay: opts.digWay ?? true });
  conn.tick(5);
  let result: SkillResult | undefined;
  const p = skills.goto(goal, opts.goto).then((r) => (result = r));
  let t = 0;
  let top = loop.state.pos.y;
  let maxFall = 0;
  const max = opts.maxTicks ?? 6000;
  while (skills.nav.busy && t < max) {
    conn.tick();
    await Promise.resolve();
    const s = loop.state;
    if (s.onGround || s.inWater) {
      maxFall = Math.max(maxFall, top - s.pos.y);
      top = s.pos.y;
    } else top = Math.max(top, s.pos.y);
    t++;
  }
  skills.cancel();
  await p;
  return { result, ticks: t, pos: loop.state.pos, skills, log, maxFall, info };
}

describe('Track E9 navigator: shut in, closed loop', () => {
  it('the shaft: the goto says it is shut in, digs a stair out of more than 12 blocks and arrives; no failure counted', async () => {
    const { gen, start, goal } = shaftWorld();
    const run = await drive(gen, start, goal);
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeGreaterThan(DIG_WAY_MAX_BLOCKS);
    expect(run.log.length).toBeLessThanOrEqual(30);
    expect(run.log.some((l) => l.endsWith(' cobblestone'))).toBe(false);
    expect(cell(run.pos)).toEqual((goal as { p: Vec3 }).p);
    const rep = run.skills.status().lastGoto!;
    expect(rep.shutIn).toBe(true);
    expect(rep.failures).toBe(0);
    expect(rep.plans.slice(0, 2).map((p) => p.status)).toEqual(['none', 'none']); // level 0, the dig way's 12
    expect(run.info.some((l) => l.includes(`goto: shut in (`) && l.includes(`digging out, up to ${DIG_OUT_MAX_BLOCKS} natural blocks`))).toBe(true);
    expect(run.maxFall).toBeLessThan(3.5);
  });

  it('a dug block of the way out is progress for the timeout: a stair slower than the budget a block still arrives', async () => {
    // measured on a fresh world: the furnace step's walk home (a budget of 20 ticks a block of the way, 1500 here) dug
    // 36 blocks of its stair and ended `timeout`: a stair gains a block towards the goal every two or three digs
    const { gen, start, goal } = shaftWorld();
    const run = await drive(gen, start, goal, { digTicks: 60, goto: { timeoutTicks: 100 }, maxTicks: 12_000 });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeGreaterThan(DIG_WAY_MAX_BLOCKS);
  });

  it('the pocket: out and to within 3 of the goal', async () => {
    const { gen, start, goal } = pocketWorld();
    const run = await drive(gen, start, goal, { maxTicks: 12_000 });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeGreaterThan(DIG_WAY_MAX_BLOCKS);
    expect(run.log.length).toBeLessThanOrEqual(DIG_OUT_MAX_BLOCKS);
    expect(run.skills.status().lastGoto!.shutIn).toBe(true);
    const g = (goal as { p: Vec3 }).p;
    expect(Math.hypot(run.pos.x - g.x, run.pos.y - g.y, run.pos.z - g.z)).toBeLessThanOrEqual(3.5);
  });

  it('the dig way off (`digWay`): as before, unreachable, nothing dug', async () => {
    const { gen, start, goal } = shaftWorld();
    const run = await drive(gen, start, goal, { digWay: false });
    expect(run.result).toEqual({ ok: false, reason: 'unreachable' });
    expect(run.log).toEqual([]);
    expect(run.skills.status().lastGoto!.shutIn).toBeUndefined();
  });

  it('a pit walled with built blocks: the try digs nothing, and the goto with `explain` names the rule that closes it', async () => {
    const gen = ground();
    // a room 3 x 3 x 3 of stone bricks 8 under the ground, the body inside
    gen.fill({ x: -2, y: S - 12, z: -2 }, { x: 2, y: S - 7, z: 2 }, 'stone_bricks');
    gen.fill({ x: -1, y: S - 11, z: -1 }, { x: 1, y: S - 9, z: 1 }, 'air');
    const run = await drive(gen, { x: 0.5, y: S - 11, z: 0.5 }, { type: 'block', p: { x: 12, y: S + 1, z: 4 } }, { goto: { explain: true } });
    expect(run.result?.ok).toBe(false);
    expect(run.log).toEqual([]);
    const r = run.result as { ok: false; reason: string; cause?: string; note?: string };
    expect(r.reason).toBe('unreachable');
    expect(r.cause).toBe('rule:built');
    expect(run.skills.status().lastGoto!.shutIn).toBe(true); // tried, with nothing to dig
  });

  // Track M11 (navigator digInside): the Realm's scene of 2026-11-22 filled iron ore into the cell the body stood in
  it('the body inside a block (ore filled into its feet cell): dug out at once, no failure counted, and the walk goes', async () => {
    const gen = ground();
    gen.fill({ x: -2, y: S, z: -1 }, { x: 3, y: S, z: 2 }, 'air');
    gen.fill({ x: -2, y: S, z: -1 }, { x: 3, y: S, z: 2 }, 'iron_ore'); // the patch at the ground's top, the feet in it
    const run = await drive(gen, { x: 0.5, y: S, z: 0.5 }, { type: 'block', p: { x: 8, y: S + 1, z: 0 } });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log[0]).toBe(`dig 0,${S},0 iron_ore`);
    expect(run.info.some((l) => l.includes(`goto: the body is inside iron_ore at 0,${S},0 (no node to start from): digging it out`))).toBe(true);
    expect(run.skills.status().lastGoto!.failures).toBe(0);
  });

  it('the body inside a block: not a built block, nor with the dig way off (as before: no standable node)', async () => {
    for (const [block, digWay] of [
      ['stone_bricks', true],
      ['iron_ore', false],
    ] as const) {
      const gen = ground();
      gen.put(0, S, 0, block);
      const run = await drive(gen, { x: 0.5, y: S, z: 0.5 }, { type: 'block', p: { x: 8, y: S + 1, z: 0 } }, { digWay, maxTicks: 400 });
      expect(run.log, block).toEqual([]);
      expect(run.result?.ok, block).toBe(false);
    }
  });

  it('on a tower a fall that hurts is still taken before any digging out (the levels come first)', async () => {
    const gen = ground();
    gen.fill({ x: 0, y: S + 1, z: 0 }, { x: 2, y: S + 9, z: 2 }, 'stone'); // 9 high: a fall of 9 costs 6 HP
    const run = await drive(gen, { x: 1.5, y: S + 10, z: 1.5 }, { type: 'block', p: { x: 12, y: S + 1, z: 1 } });
    expect(run.result, run.info.join('\n')).toEqual({ ok: true });
    expect(run.log.length).toBeLessThanOrEqual(DIG_WAY_MAX_BLOCKS);
    expect(run.skills.status().lastGoto!.shutIn).toBeUndefined();
  });
});

describe('Track E9: a refused walk says why', () => {
  it('walkFailWords: the reason alone, or with the cause the goto was asked for (a rule, the budget, the world)', () => {
    expect(walkFailWords({ reason: 'timeout' })).toBe('timeout');
    expect(walkFailWords({ reason: 'unreachable' })).toBe('unreachable');
    expect(walkFailWords({ reason: 'unreachable', note: 'budget: the searches or the walk ran out before the goal' })).toBe('unreachable: budget: the searches or the walk ran out before the goal');
    expect(RULE_WORDS.dig_budget).toBe(`at most ${DIG_WAY_MAX_BLOCKS} dug blocks a goto (${DIG_OUT_MAX_BLOCKS} out of a pit), none slow`);
  });

  it('the furnace step asks why and says it: `furnace: the walk home failed (unreachable: rule protected_area: ...)`', async () => {
    const asked: GotoOptions[] = [];
    const r = await placeFurnace(
      {
        world: { blockAt: () => undefined, inventory: { slots: [{ name: 'furnace', count: 1, networkId: 1, metadata: 0 }] } },
        loop: { state: { pos: { x: 0.5, y: 40, z: 0.5 }, ready: true } },
        skills: {
          place: () => Promise.resolve({ ok: true }),
          dig: () => Promise.resolve({ ok: true }),
          goto: (_g, o) => {
            asked.push(o ?? {});
            return Promise.resolve({ ok: false, reason: 'unreachable', cause: 'rule:protected_area', note: `rule protected_area: ${RULE_WORDS.protected_area}` });
          },
        },
        home: () => ({ x: 60, y: 64, z: 0 }),
        furnaces: () => [],
      },
      () => false,
    );
    expect(asked[0]?.explain).toBe(true);
    expect(r).toEqual({ ok: false, reason: 'walk_failed', detail: 'unreachable: rule protected_area: no digging in the base (protectRadius)' });
    expect(furnaceReasonText('walk_failed', (r as { detail?: string }).detail)).toBe('the walk home failed (unreachable: rule protected_area: no digging in the base (protectRadius))');
  });

  it('the night rule asks why too: `night: shelter unreachable (unreachable: budget: ...), attempt 1/3`', async () => {
    const lines: string[] = [];
    const asked: { explain?: boolean }[] = [];
    const n = new NightSafety({
      clock: { known: true, time: 13_000 },
      mover: {
        goto: (_g, o) => {
          asked.push(o ?? {});
          return Promise.resolve({ ok: false, reason: 'unreachable', cause: 'budget', note: 'budget: the searches or the walk ran out before the goal' });
        },
        cancel: () => undefined,
      },
      position: () => ({ x: 30.5, y: 40, z: 0.5 }),
      shelter: { x: 0, y: 64, z: 0 },
      log: { debug() {}, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} },
    });
    n.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked[0]?.explain).toBe(true);
    expect(lines.find((l) => l.includes('shelter unreachable'))).toBe('night: shelter unreachable (unreachable: budget: the searches or the walk ran out before the goal), attempt 1/3; staying put, retry in 60 s');
  });
});

describe('Track E9 guards (decision 0111)', () => {
  it('the guide has the "Shut in" part naming the constant with its value; the decision record exists', () => {
    const DOC = readFileSync(new URL('../../../../docs/pathfinding.md', import.meta.url), 'utf8');
    const ADR = readFileSync(new URL('../../../../docs/decisions/0111-way-home-and-morning.md', import.meta.url), 'utf8');
    const at = DOC.indexOf('\n### Shut in (Track E9)\n');
    expect(at).toBeGreaterThan(0);
    const next = DOC.indexOf('\n## ', at + 4);
    const part = DOC.slice(at, next < 0 ? undefined : next);
    expect(part).toContain(`DIG_OUT_MAX_BLOCKS = ${DIG_OUT_MAX_BLOCKS}`);
    expect(part).toContain('digWay');
    expect(ADR).toMatch(/shut in/i);
  });
});
