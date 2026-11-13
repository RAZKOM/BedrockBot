// Track R4 (docs/pathfinding.md "A fall closed for a moment (Track R4)"; decisions/0072-reachability.md "R4"): a goto
// whose only way is a small fall that hurts, with a hostile brought near while it walks. Before R4 the long-fall
// policy turned every fall that hurts off while a hostile was within 16 blocks and the goto ended `unreachable (rule
// falls ...)` at once, at full health, a few blocks from its goal (the Realm, 2026-11-12). Now it holds where it stands
// and plans again once the hostile has gone (FALL_HOLD_TICKS at most), and `hostileFallHp` (off by default) lets a
// fall that costs little against the health at hand be taken with the hostile there.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fallDamage } from '../../../src/skills/fall/damage.ts';
import { fallPolicy, HOSTILE_FALL_RESERVE, type FallPolicyInputs } from '../../../src/skills/fall/policy.ts';
import type { BenchWorld } from '../../../src/skills/nav/bench/worlds.ts';
import { V, Vox } from '../../../src/skills/nav/bench/vox.ts';
import { FALL_HOLD_TICKS } from '../../../src/skills/nav/navigator.ts';
import type { PathNode } from '../../../src/skills/nav/astar.ts';
import { cellKey, NavGrid } from '../../../src/skills/nav/grid.ts';
import { fallOnPath, fallWords, relaxOptions, rulesOnPath } from '../../../src/skills/nav/reach.ts';
import { flatGen } from './genworld.ts';
import type { ReplaySource } from '../world/helpers.ts';
import { runPair, type PairRun, type SimOptions } from './reach-sim.ts';

const live = (o: Partial<FallPolicyInputs> = {}): FallPolicyInputs => ({ enabled: true, health: 20, healthKnown: true, absorption: 0, margin: 8, epf: 0, burning: false, hostileDistance: Infinity, bucket: true, clutchOn: true, waterWorks: true, clutchMax: 40, ...o });

describe('Track R4: the fall policy with a hostile near', () => {
  it('blocks every fall that hurts as before with hostileFallHp off, and says the block passes and what the budget is then', () => {
    const p = fallPolicy(live({ hostileDistance: 9.6 }))!;
    expect(p.blocked).toBe('a hostile 10 blocks away');
    expect(p.hpBudget).toBe(0);
    expect(p.clutch).toBe(false);
    expect(p.afterBlock).toBe(12);
    expect(fallPolicy(live({ burning: true }))!.afterBlock).toBe(12);
    expect(fallPolicy(live({ healthKnown: false }))!.afterBlock).toBe(12);
    // under the margin: no block that passes by itself (the health comes back with food, in minutes)
    expect(fallPolicy(live({ health: 7 }))!.afterBlock).toBeUndefined();
    expect(fallPolicy(live({ health: 7, hostileDistance: 5 }))!.afterBlock).toBeUndefined();
    expect(fallPolicy(live())!.afterBlock).toBeUndefined();
  });

  it('hostileFallHp caps the budget, leaves margin + HOSTILE_FALL_RESERVE, and never clutches', () => {
    const p = fallPolicy(live({ hostileDistance: 6, hostileFallHp: 2 }))!;
    expect(p.blocked).toBeUndefined();
    expect(p.hpBudget).toBe(2);
    expect(p.hostileCap).toBe(2);
    expect(p.afterBlock).toBe(12);
    expect(p.clutch).toBe(false);
    // 16 health: 16 - 8 - 7 = 1 left for the fall
    expect(fallPolicy(live({ hostileDistance: 6, hostileFallHp: 2, health: 16 }))!.hpBudget).toBe(1);
    // 15 health or less: blocked as before
    const low = fallPolicy(live({ hostileDistance: 6, hostileFallHp: 2, health: 8 + HOSTILE_FALL_RESERVE }))!;
    expect(low.blocked).toBe('a hostile 6 blocks away');
    expect(low.hpBudget).toBe(0);
    // no hostile: the full budget and the clutch, the cap does nothing
    const free = fallPolicy(live({ hostileFallHp: 2 }))!;
    expect(free.hpBudget).toBe(12);
    expect(free.clutch).toBe(true);
    expect(free.hostileCap).toBeUndefined();
  });
});

describe('Track R4: the "why" search and the reply', () => {
  it('a landing refused lately is named (not taken for the world) and the fall rule lifted plans through it', () => {
    const p = fallPolicy(live())!;
    const o = relaxOptions({ falls: { ...p, refused: [123], blocked: 'x', afterBlock: 4 } }, ['falls'], { hp: 20, dug: 0 });
    expect(o.falls?.refused).toBeUndefined();
    expect(o.falls?.blocked).toBeUndefined();
    expect(o.falls?.afterBlock).toBeUndefined();
    expect(fallWords({ blocks: 5, damage: 2, budget: 12, lately: true })).toBe('a 5-block fall (2 HP), its landing refused at the step-off lately');
  });

  it('a fall within the budget whose landing was refused lately counts as the falls rule, with its landing cell', () => {
    const g = new NavGrid(flatGen());
    const path: PathNode[] = [
      { x: 0, y: -55, z: 0, feet: -55, move: 'start', cost: 0 },
      { x: 1, y: -60, z: 0, feet: -60, move: 'drop', cost: 10 },
    ];
    const p = fallPolicy(live())!;
    expect(rulesOnPath(g, path, { falls: p })).toEqual([]);
    expect(fallOnPath(g, path, { falls: p })).toBeUndefined();
    const refused = { ...p, refused: [cellKey(1, -60, 0)] };
    expect(rulesOnPath(g, path, { falls: refused })).toEqual(['falls']);
    const f = fallOnPath(g, path, { falls: refused })!;
    expect(f.lately).toBe(true);
    expect(f.cell).toBe(cellKey(1, -60, 0));
    expect(fallWords(f)).toBe(`a 5-block fall (${f.damage} HP), its landing refused at the step-off lately`);
    // blocked by a hostile: named as before, with the reason
    const blocked = fallOnPath(g, path, { falls: fallPolicy(live({ hostileDistance: 9 }))! })!;
    expect(blocked.lately).toBeUndefined();
    expect(fallWords(blocked)).toBe(`a 5-block fall (${blocked.damage} HP), no fall that hurts now: a hostile 9 blocks away`);
  });
});

/**
 * A tower of planks 5 high (4 x 4, a built block: the dig way never digs it) on a grass floor: the only way down is a
 * 5-block fall. The goal is on the floor 10 blocks from the tower's edge.
 */
function towerWorld(): BenchWorld {
  const v = new Vox(48, 48);
  for (let x = 0; x < 48; x++)
    for (let z = 0; z < 48; z++) {
      v.set(x, -64, z, V.bedrock);
      for (let y = -63; y <= -62; y++) v.set(x, y, z, V.stone);
      v.set(x, -61, z, V.grass);
      if (x >= 10 && x <= 13 && z >= 10 && z <= 13) for (let y = -60; y <= -56; y++) v.set(x, y, z, V.planks);
    }
  return { cls: 'fixture', seed: 0, vox: v, loadRadius: 4, coarse: false, pairs: [{ start: { x: 11, y: -55, z: 11 }, goal: { x: 24, y: -60, z: 12 }, tag: 'tower' }] };
}

/** The zombie the "server" brings near at tick `from` and takes away (struck down, or gone) at tick `to`. */
function zombie(from: number, to: number): SimOptions['onTick'] {
  return (t: number, src: ReplaySource) => {
    if (t === from) src.emit('add_entity', { unique_id: -77n, runtime_id: 77n, entity_type: 'minecraft:zombie', position: { x: 11.5, y: -60, z: 23.5 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0 });
    if (t === to) src.emit('remove_entity', { entity_id_self: -77n });
  };
}

const FALL = fallDamage(5, 'grass_block');
const held = (r: PairRun): boolean => r.log.some((l) => l.includes('holding up to'));

describe('Track R4: the closed loop (tower: the only way a 5-block fall, a zombie 12 blocks off)', () => {
  const bw = towerWorld();
  const pair = bw.pairs[0]!;

  it('with no hostile the tower is walked off (the control)', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25 });
    expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    expect(r.damage).toBeCloseTo(FALL, 5);
  }, 120_000);

  it('before R4 (no hold): the zombie near ends it unreachable over the fall at full health', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25, fallHoldTicks: 0, onTick: zombie(0, 100_000) });
    expect(r.reply).toMatch(/^goto: unreachable \(rule falls: a 5-block fall \(\d+ HP\), no fall that hurts now: a hostile \d+ blocks away[;)]/);
    expect(r.damage).toBe(0);
    record('before', 0, 100_000, r);
  }, 120_000);

  it('before R4, the Realm sequence: the zombie comes while the body walks to the edge, the step-off check refuses, unreachable', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25, fallHoldTicks: 0, onTick: zombie(10, 100_000) });
    record('before-edge', 10, 100_000, r);
    expect(r.log.some((l) => l.includes('no longer safe'))).toBe(true);
    expect(r.reply).toMatch(/^goto: unreachable \(rule falls: a 5-block fall \(\d+ HP\), no fall that hurts now: a hostile \d+ blocks away[;)]/);
    expect(r.damage).toBe(0);
  }, 120_000);

  for (const [from, stay] of [
    [0, 40],
    [0, 200],
    [3, 60],
    [5, 100],
    [8, 40],
    [10, 160],
    [12, 80],
    [15, 300],
    [20, 120],
    [25, 60],
  ] as const) {
    it(`the zombie from tick ${from} for ${stay} ticks: the goto holds, then walks off and arrives, the fall its only damage`, async () => {
      const r = await runPair(bw, pair, new Map(), { speed: 1.25, onTick: zombie(from, from + stay) });
      record('hold', from, stay, r);
      expect(r.reply, r.log.slice(-14).join('\n')).toBe('arrived');
      expect(r.damage).toBeCloseTo(FALL, 5);
      expect(r.died).toBe(false);
      // the zombie came before the body stepped off: the goto held, and not longer than the zombie stayed and a second
      if (held(r)) expect(holdTicks(r)).toBeLessThanOrEqual(stay + 40);
    }, 120_000);
  }

  it('the hold came in most of the ten (the zombie before the step-off)', () => {
    expect(rows.filter((x) => x.mode === 'hold' && x.held).length).toBeGreaterThanOrEqual(8);
    // and some of them the Realm's way: refused at the edge by the step-off check, then held
    expect(rows.filter((x) => x.mode === 'hold' && x.held && x.atEdge).length).toBeGreaterThanOrEqual(3);
  });

  it('a zombie that stays: the goto holds FALL_HOLD_TICKS, then reports unreachable and says what it waited for', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25, onTick: zombie(0, 100_000) });
    expect(held(r)).toBe(true);
    expect(r.reply).toMatch(new RegExp(`no fall that hurts now: a hostile \\d+ blocks away; held ${FALL_HOLD_TICKS / 20} s for a hostile \\d+ blocks away[;)]`));
    expect(r.damage).toBe(0);
    expect(r.ticks).toBeGreaterThanOrEqual(FALL_HOLD_TICKS);
    record('stays', 0, 100_000, r);
  }, 120_000);

  it('hostileFallHp 2: the 2 HP fall is taken with the zombie there, no hold', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25, falls: { hostileFallHp: 2 }, onTick: zombie(0, 100_000) });
    record('cap2', 0, 100_000, r);
    expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    expect(held(r)).toBe(false);
    expect(r.damage).toBeCloseTo(FALL, 5);
  }, 120_000);

  it('hostileFallHp 2 at 15 health: the cap leaves margin + 7, so it holds as with the setting off', async () => {
    const r = await runPair(bw, pair, new Map(), { speed: 1.25, health: 8 + HOSTILE_FALL_RESERVE, falls: { hostileFallHp: 2 }, onTick: zombie(0, 60) });
    record('cap2-h15', 0, 60, r);
    expect(r.reply, r.log.slice(-12).join('\n')).toBe('arrived');
    expect(held(r)).toBe(true);
    expect(r.damage).toBeCloseTo(FALL, 5);
  }, 120_000);

  it('(results)', () => {
    const out = process.env.R4_OUT;
    if (out) writeFileSync(out, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

interface Row {
  mode: string;
  from: number;
  stay: number;
  reply: string;
  ticks: number;
  damage: number;
  held: boolean;
  holdTicks: number;
  /** The step-off check refused the drop at the edge (the Realm case) before the hold. */
  atEdge: boolean;
  died: boolean;
}
const rows: Row[] = [];
/** Ticks from the hold's start to its end, read off the log (`... has passed after 3.2 s`, `held 30.0 s`). */
function holdTicks(r: PairRun): number {
  let t = 0;
  for (const l of r.log) {
    const m = /has passed after ([\d.]+) s|held ([\d.]+) s for/.exec(l);
    if (m) t += Math.round(Number(m[1] ?? m[2]) * 20);
  }
  return t;
}
function record(mode: string, from: number, stay: number, r: PairRun): void {
  rows.push({ mode, from, stay, reply: r.reply, ticks: r.ticks, damage: +r.damage.toFixed(2), held: held(r), holdTicks: holdTicks(r), atEdge: r.log.some((l) => l.includes('no longer safe')), died: r.died });
}
