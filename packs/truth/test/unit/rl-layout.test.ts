import { describe, expect, it } from 'vitest';
import { fnv1aOf } from '../../src/protocol.js';
import { FEET_Y, LOG, SCENARIOS, arenaBox, parseOptions, planArena, planChecksum, simulate } from '../../src/rl-layout.js';

describe('rl-layout planArena', () => {
  it('is deterministic per (scenario, seed, origin)', () => {
    const a = planArena('forest_small', 7);
    const b = planArena('forest_small', 7);
    expect(a.ops).toEqual(b.ops);
    expect(planChecksum(a)).toBe(planChecksum(b));
  });

  it('different seeds and scenarios give different arenas', () => {
    const sums = new Set<string>();
    for (let seed = 0; seed < 10; seed++) sums.add(planChecksum(planArena('forest_small', seed)));
    expect(sums.size).toBe(10);
    expect(planChecksum(planArena('forest', 1))).not.toBe(planChecksum(planArena('forest_small', 1)));
  });

  it('the checksum does not depend on the origin (same blocks, shifted box)', () => {
    expect(planChecksum(planArena('forest_small', 3, 1000, -200))).toBe(planChecksum(planArena('forest_small', 3)));
  });

  it('places trees inside the walls, apart from each other and off the start column', () => {
    for (const name of Object.keys(SCENARIOS)) {
      const def = SCENARIOS[name]!;
      for (let seed = 0; seed < 20; seed++) {
        const p = planArena(name, seed, 64, -32);
        expect(p.trees.length).toBeGreaterThanOrEqual(def.trees[0]);
        expect(p.trees.length).toBeLessThanOrEqual(def.trees[1]);
        for (const t of p.trees) {
          expect(Math.abs(t.x - 64)).toBeLessThanOrEqual(def.half - 3);
          expect(Math.abs(t.z + 32)).toBeLessThanOrEqual(def.half - 3);
          expect(Math.max(Math.abs(t.x - 64), Math.abs(t.z + 32))).toBeGreaterThanOrEqual(def.startClear);
          if (def.startMax !== undefined) expect(Math.max(Math.abs(t.x - 64), Math.abs(t.z + 32))).toBeLessThanOrEqual(def.startMax);
          for (const u of p.trees) if (u !== t) expect(Math.max(Math.abs(t.x - u.x), Math.abs(t.z - u.z))).toBeGreaterThanOrEqual(def.spacing);
        }
      }
    }
  });

  it('simulated blocks: full trunks, start column clear, barrier ring, log count', () => {
    const p = planArena('forest_small', 11);
    const grid = simulate(p);
    const { min, max } = p.box;
    const sx = max.x - min.x + 1;
    const sz = max.z - min.z + 1;
    const at = (x: number, y: number, z: number) => grid[((y - min.y) * sz + (z - min.z)) * sx + (x - min.x)];
    expect(grid.filter((b) => b === LOG).length).toBe(p.logs);
    for (const t of p.trees) {
      for (let y = FEET_Y; y < FEET_Y + t.height; y++) expect(at(t.x, y, t.z)).toBe(LOG);
      expect(at(t.x, FEET_Y - 1, t.z)).toBe('minecraft:dirt');
    }
    expect(at(0, FEET_Y, 0)).toBe('minecraft:air');
    expect(at(0, FEET_Y + 1, 0)).toBe('minecraft:air');
    expect(at(0, FEET_Y - 1, 0)).toBe('minecraft:grass_block');
    expect(at(min.x, FEET_Y, 0)).toBe('minecraft:barrier');
    expect(at(max.x, FEET_Y + 3, 0)).toBe('minecraft:barrier');
    expect(at(max.x, FEET_Y + 4, 0)).toBe('minecraft:air');
    expect(planChecksum(p)).toBe(fnv1aOf(grid));
    expect(p.box).toEqual(arenaBox(SCENARIOS.forest_small!, 0, 0));
  });

  it('rejects unknown scenarios and non-integer seeds', () => {
    expect(() => planArena('nope', 1)).toThrow(/unknown scenario/);
    expect(() => planArena('forest_small', 1.5)).toThrow(/integer/);
  });

  it('parses key=value options', () => {
    expect(parseOptions(['origin=10,-20', 'Tool=iron_axe'])).toEqual({ origin: '10,-20', tool: 'iron_axe' });
    expect(() => parseOptions(['bad'])).toThrow();
  });
});
