// Track R8 (docs/pathfinding.md "A `!goto` that stands as near as it gets (Track R8)"; decisions/0072-reachability.md
// "R8"): a `!goto` (GotoOptions.beside) that walked as near to its goal as it could get, then stood and searched for 44 to
// 65 s and answered `unreachable`. Two shapes from the Realm, in made-up geometry: a goal cell inside a nether portal (a
// cell no move enters), and a goal cell over a lone block left in a dug-out pit (R7's `in the air` end, the node on the
// lone block, which no walk reaches). The real navigator in the reach bench's closed loop, the default and the live
// settings; "before" is Navigator.nearEnds off.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dimensionWords } from '../../../src/chat/commands-nav.ts';
import type { BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { NEAR_END, NEAR_REACH, shortWhy } from '../../../src/skills/nav/navigator.ts';
import { runPair, type PairRun, type SimOptions } from './reach-sim.ts';

const GX = 20;
const GZ = 20;

/** A 48 x 48 world, stone to `top - 1`, grass at `top`: the feet level on the grass is top + 1. */
function ground(top: number): Vox {
  const v = new Vox(48, 48);
  for (let x = 0; x < 48; x++)
    for (let z = 0; z < 48; z++) {
      v.set(x, -64, z, V.bedrock);
      for (let y = -63; y < top; y++) v.set(x, y, z, V.stone);
      v.set(x, top, z, V.grass);
    }
  return v;
}

/** Case 1: a nether portal frame along x, its bottom row flush with the grass, the portal 2 wide and 3 high; the goal its lower west cell. */
const P_G = -60;
function portalWorld(): Vox {
  const v = ground(-61);
  for (let x = GX - 1; x <= GX + 2; x++) {
    v.set(x, P_G - 1, GZ, V.obsidian);
    v.set(x, P_G + 3, GZ, V.obsidian);
  }
  for (let y = P_G - 1; y <= P_G + 3; y++) {
    v.set(GX - 1, y, GZ, V.obsidian);
    v.set(GX + 2, y, GZ, V.obsidian);
  }
  for (let y = P_G; y <= P_G + 2; y++) for (let x = GX; x <= GX + 1; x++) v.set(x, y, GZ, V.portal);
  return v;
}

/**
 * Case 2: the grass at -49 (feet -48), a pit dug out round the goal's column (half-width `half`) down to a stone floor at
 * -61, and one stone post left standing in it, its top 3 under the goal's cell (feet -51). The goal is the cell where the
 * ground was, -48.
 */
const T_G = -48;
function pitWorld(half: number): Vox {
  const v = ground(-49);
  v.fill({ x: GX - half, y: -60, z: GZ - half }, { x: GX + half, y: -49, z: GZ + half }, V.air);
  v.fill({ x: GX, y: -60, z: GZ }, { x: GX, y: T_G - 4, z: GZ }, V.stone);
  return v;
}

interface Row {
  mode: string;
  config: string;
  case: string;
  k: number;
  reply: string;
  note?: string;
  cause?: string;
  ticks: number;
  /** Ticks from the body's last move to the answer. */
  still: number;
  /** Ticks from the first near end (the body stood where no search got it nearer) to the answer. */
  near?: number;
  damage: number;
  end: string;
  /** Feet to the goal cell's floor centre at the end. */
  fromGoal: number;
  plans: number;
  failures: number;
  died: boolean;
}
const rows: Row[] = [];
const CONFIGS: [string, SimOptions][] = [
  ['default', {}],
  ['live', { allowBreak: true, allowPlace: false, digPenalty: 500 }],
];
const N = Number(process.env.R8_N ?? 1);
const BEFORE_N = Number(process.env.R8_BEFORE_N ?? 1);
const MODES = (process.env.R8_MODES ?? 'before,after').split(',');

function push(mode: string, config: string, name: string, k: number, r: PairRun, goal: { x: number; y: number; z: number }): Row {
  const e = r.endPos;
  const row: Row = {
    mode,
    config,
    case: name,
    k,
    reply: r.reply,
    ...(r.note ? { note: r.note } : {}),
    ...(r.cause ? { cause: r.cause } : {}),
    ticks: r.ticks,
    still: r.stillTicks ?? -1,
    ...(r.nearTicks !== undefined ? { near: r.nearTicks } : {}),
    damage: +r.damage.toFixed(2),
    end: `${e.x},${e.y},${e.z}`,
    fromGoal: +Math.hypot(e.x - (goal.x + 0.5), e.y - goal.y, e.z - (goal.z + 0.5)).toFixed(2),
    plans: r.plans,
    failures: r.failures,
    died: r.died,
  };
  rows.push(row);
  return row;
}

interface Case {
  name: string;
  world: () => Vox;
  start: { x: number; y: number; z: number };
  goal: { x: number; y: number; z: number };
  /** The answer after R8 (a regexp on the reply), and the most ticks it may take from the body's last move. */
  after: RegExp;
  note?: RegExp;
  stillMax: number;
}

const CASES: Case[] = [
  {
    name: 'a goal cell inside a nether portal',
    world: portalWorld,
    start: { x: GX, y: P_G, z: GZ + 15 },
    goal: { x: GX, y: P_G, z: GZ },
    after: /^arrived$/,
    note: /^the goal's cell 20,-60,20 \(portal\) cannot be stood on \(portal: a cell the walk never enters\): stopped [\d.]+ blocks from it$/,
    stillMax: 5,
  },
  {
    name: 'a goal cell over a lone post in a dug-out pit',
    world: () => pitWorld(5),
    start: { x: GX + 15, y: T_G, z: GZ },
    goal: { x: GX, y: T_G, z: GZ },
    after: /^goto: stopped short \([\d.]+ blocks from the goal's cell 20,-48,20 \(air, 3 over the floor\): the rest needs a block placed \(a goto places no blocks\)\)$/,
    stillMax: 200,
  },
];

describe('Track R8: a !goto that stood near its goal and searched for a minute (the real navigator, the closed loop)', () => {
  for (const mode of MODES) {
    for (const [config, o] of CONFIGS) {
      for (const c of CASES) {
        it(`${mode}: ${config}: ${c.name}`, async () => {
          const n = mode === 'before' ? BEFORE_N : N;
          for (let k = 0; k < n; k++) {
            const w: BenchWorld = { cls: 'fixture', seed: 0, vox: c.world(), loadRadius: 4, coarse: false, pairs: [{ start: c.start, goal: c.goal, tag: c.name }] };
            const r = await runPair(w, w.pairs[0]!, new Map(), {
              speed: 1.25,
              timeoutTicks: 6000,
              startPos: { x: c.start.x + 0.5, y: c.start.y, z: c.start.z + 0.3 + (0.4 * k) / Math.max(1, n - 1) },
              ...o,
              gotoOpts: { beside: true },
              ...(mode === 'before' ? { noNear: true } : {}),
            });
            const row = push(mode, config, c.name, k, r, c.goal);
            const tail = r.log.slice(-20).join('\n');
            expect(r.died, tail).toBe(false);
            expect(r.damage, tail).toBe(0);
            if (mode === 'before') {
              expect(r.reply, tail).toMatch(/^goto: unreachable/);
            } else {
              expect(r.reply, tail).toMatch(c.after);
              if (c.note) expect(r.note ?? '', tail).toMatch(c.note);
              expect(row.still, tail).toBeLessThanOrEqual(c.stillMax);
              expect(row.fromGoal, tail).toBeLessThanOrEqual(NEAR_END);
            }
          }
        }, 900_000);
      }
    }
  }
});

describe('Track R8: the rules round the near end', () => {
  const live: SimOptions = { allowBreak: true, allowPlace: false, digPenalty: 500 };
  it('far from the goal (a post in a pit 25 wide: the edge 11.5 from it) the ladder runs as before and the answer is unreachable', async () => {
    const w: BenchWorld = { cls: 'fixture', seed: 0, vox: pitWorld(12), loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 18, y: T_G, z: GZ }, goal: { x: GX, y: T_G, z: GZ }, tag: 'far' }] };
    const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 6000, startPos: { x: GX + 18.5, y: T_G, z: GZ + 0.5 }, gotoOpts: { beside: true } });
    push('after', 'default', 'far: a post in a pit 25 wide', 0, r, { x: GX, y: T_G, z: GZ });
    expect(r.reply, r.log.slice(-12).join('\n')).toMatch(/^goto: unreachable/);
    expect(r.nearTicks).toBeUndefined();
  }, 900_000);
  it('without `beside` (every caller but !goto) the answer is unreachable, as before', async () => {
    const w: BenchWorld = { cls: 'fixture', seed: 0, vox: pitWorld(5), loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: T_G, z: GZ }, goal: { x: GX, y: T_G, z: GZ }, tag: 'strict' }] };
    const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 6000, ...live });
    push('after', 'live', 'strict: the post in the pit, no beside', 0, r, { x: GX, y: T_G, z: GZ });
    expect(r.reply).toMatch(/^goto: unreachable/);
  }, 900_000);
  it('a goal cell over a path block (its top 0.9375): arrived on the path block with no note', async () => {
    for (const [config, o] of CONFIGS) {
      const v = ground(-61);
      v.set(GX, -61, GZ, V.path);
      const w: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: -60, z: GZ }, goal: { x: GX, y: -60, z: GZ }, tag: 'path' }] };
      const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, ...o, gotoOpts: { beside: true } });
      push('after', config, 'a goal cell over a path block', 0, r, { x: GX, y: -60, z: GZ });
      expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
      expect(r.note).toBeUndefined();
      expect(r.endPos.y).toBeCloseTo(-60.06, 2); // (the path block's top 0.9375 over its cell's floor)
      expect(Math.hypot(r.endPos.x - (GX + 0.5), r.endPos.z - (GZ + 0.5))).toBeLessThan(0.5);
    }
  }, 900_000);
  it('a goal cell holding a cobweb: next to it with the note', async () => {
    const v = ground(-61);
    v.set(GX, -60, GZ, V.web);
    const w: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: -60, z: GZ }, goal: { x: GX, y: -60, z: GZ }, tag: 'web' }] };
    const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, gotoOpts: { beside: true } });
    push('after', 'default', 'a goal cell holding a cobweb', 0, r, { x: GX, y: -60, z: GZ });
    expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    expect(r.note).toMatch(/^the goal's cell 20,-60,20 \(web\) cannot be stood on \(web: a cell the walk never enters\): stopped [\d.]+ blocks from it$/);
  }, 900_000);
  it('within reach of the cell (a fence on a tower 3 high, the eye 3 from the cell): arrived next to the tower with the note', async () => {
    const v = ground(-61);
    for (let y = -60; y <= -58; y++) v.set(GX, y, GZ, V.stone);
    v.set(GX, -57, GZ, V.fence);
    const goal = { x: GX, y: -56, z: GZ };
    const w: BenchWorld = { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: GX + 15, y: -60, z: GZ }, goal, tag: 'tower' }] };
    const r = await runPair(w, w.pairs[0]!, new Map(), { speed: 1.25, timeoutTicks: 2400, gotoOpts: { beside: true } });
    push('after', 'default', 'within reach: a fence on a tower 3 high', 0, r, goal);
    expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    expect(r.note).toMatch(/^the goal's cell 20,-56,20 \(on oak_fence\) cannot be reached \(the rest needs a block placed \(a goto places no blocks\)\): stopped [\d.]+ blocks from it$/);
    expect(r.short?.within).toBe(true);
    expect(r.short!.eye).toBeLessThanOrEqual(NEAR_REACH);
  }, 900_000);
  it('the words', () => {
    expect(shortWhy({ cls: 'rule', rules: ['place'] })).toBe('the rest needs a block placed (a goto places no blocks)');
    expect(shortWhy({ cls: 'rule', rules: ['built', 'gravity'] })).toBe('the rest needs a built block broken (no breaking built blocks) and digging under sand or gravel');
    expect(shortWhy({ cls: 'rule', rules: ['falls'], fall: { blocks: 9, damage: 6, budget: 2 } })).toBe('the rest needs a 9-block fall (6 HP) over the fall budget of 2 HP');
    expect(shortWhy({ cls: 'world', rules: [] })).toBe('no walk, swim or dig gets nearer');
    expect(shortWhy({ cls: 'budget', rules: [] })).toBe("no way nearer found within the searches' budget");
    expect(shortWhy(undefined, 'x')).toBe('x');
  });
  it("a waypoint's dimension in words (before: `in the the_end`)", () => {
    expect([0, 1, 2].map(dimensionWords)).toEqual(['the overworld', 'the Nether', 'the End']);
    expect(dimensionWords(undefined)).not.toMatch(/the the/);
  });
});

describe('Track R8: (results)', () => {
  it('rows', () => {
    const out = process.env.R8_OUT;
    if (out) writeFileSync(out, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
