import { describe, expect, it } from 'vitest';
import { DIG_OUT_STATIONS, W1_STATIONS, WATER_STATIONS, waterStation, type WaterStation } from '../../src/water-layout.js';

const O = { x: 9600, y: -60, z: 9600 };

/** The blocks after the ops, over the station's bounds (later ops win). */
function paint(s: WaterStation): (x: number, y: number, z: number) => string {
  const { min, max } = s.bounds;
  const sx = max.x - min.x + 1;
  const sz = max.z - min.z + 1;
  const cells = new Map<number, string>();
  const at = (x: number, y: number, z: number): number => ((y - min.y) * sz + (z - min.z)) * sx + (x - min.x);
  for (const op of s.ops) for (let y = op.from.y; y <= op.to.y; y++) for (let z = op.from.z; z <= op.to.z; z++) for (let x = op.from.x; x <= op.to.x; x++) cells.set(at(x, y, z), op.block);
  return (x, y, z) => (x < min.x || x > max.x || y < min.y || y > max.y || z < min.z || z > max.z ? 'outside' : (cells.get(at(x, y, z)) ?? 'outside'));
}

const inBounds = (p: { x: number; y: number; z: number }, s: WaterStation): boolean => p.x >= s.bounds.min.x && p.x <= s.bounds.max.x + 1 && p.y >= s.bounds.min.y && p.y <= s.bounds.max.y && p.z >= s.bounds.min.z && p.z <= s.bounds.max.z + 1;
const solid = (b: string): boolean => b === 'stone' || b === 'dirt' || b === 'grass_block' || b === 'stone_bricks';

/** Cells reachable by walking (feet + head air, a floor under the feet, a step of 1) from `from`. */
function walkable(s: WaterStation, from: { x: number; y: number; z: number }): Set<string> {
  const b = paint(s);
  const seen = new Set<string>();
  const stack = [{ x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }];
  const stand = (x: number, y: number, z: number): boolean => b(x, y, z) === 'air' && b(x, y + 1, z) === 'air' && solid(b(x, y - 1, z));
  while (stack.length) {
    const c = stack.pop()!;
    const k = `${c.x},${c.y},${c.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      for (const dy of [0, 1, -1]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (stand(n.x, n.y, n.z)) stack.push(n);
      }
    }
  }
  return seen;
}

describe('water-layout (Track W1): the water course as pure data', () => {
  it('every station is deterministic, clears its footprint first and keeps its ops, start and goal inside the bounds', () => {
    for (const name of WATER_STATIONS) {
      const s = waterStation(name, O)!;
      expect(s, name).toBeDefined();
      expect(waterStation(name, O)).toEqual(s);
      expect(s.ops[0]).toEqual({ from: { x: s.bounds.min.x, y: O.y, z: s.bounds.min.z }, to: s.bounds.max, block: 'air' });
      expect(s.ops[1]!.block).toBe('dirt');
      expect(s.ops[2]!.block).toBe('grass_block');
      for (const op of s.ops) {
        expect(op.from.x <= op.to.x && op.from.y <= op.to.y && op.from.z <= op.to.z, `${name} ${JSON.stringify(op)}`).toBe(true);
        expect(inBounds(op.from, s) && inBounds(op.to, s), `${name} ${JSON.stringify(op)}`).toBe(true);
      }
      for (const p of [s.start, s.goal, ...(s.deepStart ? [s.deepStart] : []), ...s.kicks.map((k) => k.p), ...s.flows.map((f) => f.p)]) expect(inBounds(p, s), `${name} ${JSON.stringify(p)}`).toBe(true);
      // the goal is a dry cell to stand in
      const b = paint(s);
      expect(b(s.goal.x, s.goal.y, s.goal.z), name).toBe('air');
      expect(b(s.goal.x, s.goal.y + 1, s.goal.z), name).toBe('air');
      expect(solid(b(s.goal.x, s.goal.y - 1, s.goal.z)), name).toBe(true);
    }
    expect(waterStation('nope', O)).toBeUndefined();
  });

  it('the goal is never reached on foot: every station needs the water', () => {
    for (const name of W1_STATIONS) {
      const s = waterStation(name, O)!;
      if (name === 'lip') continue; // starts in the water
      const reach = walkable(s, s.start);
      expect(reach.size, name).toBeGreaterThan(1);
      expect(reach.has(`${s.goal.x},${s.goal.y},${s.goal.z}`), name).toBe(false);
    }
  });

  it('pool2 and pool6 are 2 and 6 deep; pool6 has a start on the floor', () => {
    const p2 = waterStation('pool2', O)!;
    const b2 = paint(p2);
    expect([b2(O.x, O.y - 1, O.z + 8), b2(O.x, O.y - 2, O.z + 8), b2(O.x, O.y - 3, O.z + 8)]).toEqual(['water', 'water', 'dirt']);
    const p6 = waterStation('pool6', O)!;
    const b6 = paint(p6);
    for (let y = O.y; y <= O.y + 5; y++) expect(b6(O.x, y, O.z + 8)).toBe('water');
    expect(b6(O.x, O.y - 1, O.z + 8)).toBe('grass_block');
    expect(p6.surfaceY).toBe(O.y + 5);
    expect(p6.deepStart).toEqual({ x: O.x + 0.5, y: O.y, z: O.z + 8.5 });
  });

  it('column: a 1 x 1 water column 8 high in stone, entered under water from a basin, the goal on top beside its last cell', () => {
    const s = waterStation('column', O)!;
    const b = paint(s);
    for (let y = O.y - 2; y <= O.y + 5; y++) {
      expect(b(O.x, y, O.z + 4)).toBe('water');
      expect([b(O.x - 1, y, O.z + 4), b(O.x + 1, y, O.z + 4), b(O.x, y, O.z + 5)]).toEqual(['stone', 'stone', 'stone']);
    }
    expect(b(O.x, O.y + 6, O.z + 4)).toBe('air');
    expect([b(O.x, O.y - 2, O.z + 3), b(O.x, O.y - 1, O.z + 3), b(O.x, O.y, O.z + 3)]).toEqual(['water', 'water', 'stone']); // the inlet under the block
    expect(b(O.x, O.y - 1, O.z + 2)).toBe('water'); // the basin
    expect(s.goal).toEqual({ x: O.x + 1, y: O.y + 6, z: O.z + 4 });
  });

  it('no station has a water face towards air but the top of its water (a fill flows out there on BDS)', () => {
    for (const name of WATER_STATIONS) {
      const s = waterStation(name, O)!;
      const b = paint(s);
      const wet = new Set(s.kicks.map((k) => `${k.p.x},${k.p.y},${k.p.z}`));
      for (const op of s.ops) {
        if (op.block !== 'water') continue;
        for (let y = op.from.y; y <= op.to.y; y++)
          for (let z = op.from.z; z <= op.to.z; z++)
            for (let x = op.from.x; x <= op.to.x; x++) {
              if (b(x, y, z) !== 'water') continue;
              for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]] as const) {
                const n = b(x + dx, y + dy, z + dz);
                if (wet.has(`${x + dx},${y + dy},${z + dz}`)) continue; // the kick: the flow wanted there
                expect(n, `${name} ${x - O.x},${y - O.y},${z - O.z} -> ${dx},${dy},${dz}`).not.toBe('air');
              }
            }
      }
    }
  });

  it('waterfall: a kick in front of the notch source over air down to the pool; the flow fills the column', () => {
    const s = waterStation('waterfall', O)!;
    const b = paint(s);
    expect(s.kicks).toEqual([{ p: { x: O.x, y: O.y + 9, z: O.z + 5 }, block: 'flowing_water' }]);
    expect(b(O.x, O.y + 9, O.z + 6)).toBe('water'); // the notch
    for (let y = O.y; y <= O.y + 9; y++) expect(b(O.x, y, O.z + 5), `y ${y}`).toBe('air'); // the fall forms from the kick
    expect(b(O.x, O.y - 1, O.z + 5)).toBe('water'); // into the pool
    expect(s.flows.length).toBe(20);
    for (const f of s.flows) expect(f.depth >= 8 || f.p.y === O.y + 9).toBe(true);
    for (const f of s.flows) expect(b(f.p.x, f.p.y, f.p.z), JSON.stringify(f)).toBe('air'); // the flow fills air only
    // the shelf the goal stands on is beside the column's top, the wall behind it
    expect(b(O.x + 1, O.y + 8, O.z + 5)).toBe('stone');
    expect(b(O.x + 1, O.y + 8, O.z + 6)).toBe('stone');
  });

  it('lip: the rim is 2 above the water top cell (one block of wall over the water)', () => {
    const s = waterStation('lip', O)!;
    const b = paint(s);
    expect([b(O.x, O.y - 1, O.z + 4), b(O.x, O.y - 2, O.z + 4), b(O.x, O.y - 3, O.z + 4), b(O.x, O.y - 4, O.z + 4)]).toEqual(['air', 'water', 'water', 'outside']);
    expect(b(O.x, O.y - 1, O.z + 7)).toBe('grass_block');
    expect(s.surfaceY).toBe(O.y - 2);
    // the one step out: a cell of the lip cut to the water level + 1 at the far corner
    expect([b(O.x - 3, O.y - 2, O.z + 2), b(O.x - 3, O.y - 1, O.z + 2), b(O.x - 3, O.y, O.z + 2)]).toEqual(['dirt', 'air', 'air']);
    for (const [x, z] of [[O.x - 3, O.z + 3], [O.x - 3, O.z + 6], [O.x + 3, O.z + 4], [O.x, O.z + 7], [O.x, O.z + 1]] as const) expect(b(x, O.y - 1, z), `${x} ${z}`).toBe('grass_block');
  });

  it('tunnel: two rooms joined only by a 3-long water passage under a roof', () => {
    const s = waterStation('tunnel', O)!;
    const b = paint(s);
    for (let z = O.z + 8; z <= O.z + 10; z++) {
      expect([b(O.x, O.y - 2, z), b(O.x, O.y - 1, z), b(O.x, O.y, z)], `z ${z}`).toEqual(['water', 'water', 'stone']);
      expect([b(O.x - 1, O.y - 1, z), b(O.x + 1, O.y - 1, z)]).toEqual(['stone', 'stone']);
    }
    for (const z of [O.z + 7, O.z + 11]) expect([b(O.x, O.y - 1, z), b(O.x, O.y, z), b(O.x, O.y + 2, z)]).toEqual(['water', 'air', 'air']);
    expect(b(O.x, O.y + 3, O.z + 9)).toBe('stone');
  });

  it('Track W2: the dig-out pools have no way out but over the rim: the start in the water, the rim 2 (bank3: 4) above its top cell all round', () => {
    expect(WATER_STATIONS).toEqual([...W1_STATIONS, ...DIG_OUT_STATIONS]);
    const rim: Record<(typeof DIG_OUT_STATIONS)[number], string> = { lipDirt: 'grass_block', lipStone: 'stone', bank3: 'grass_block', lipBuilt: 'stone_bricks' };
    for (const name of DIG_OUT_STATIONS) {
      const s = waterStation(name, O)!;
      const b = paint(s);
      expect(s.surfaceY, name).toBe(O.y - 2);
      expect(b(Math.floor(s.start.x), s.start.y, Math.floor(s.start.z)), name).toBe('water');
      // the pit: water 2 deep, air over it up to the rim's top
      expect([b(O.x, O.y - 3, O.z + 4), b(O.x, O.y - 2, O.z + 4), b(O.x, O.y - 1, O.z + 4)], name).toEqual(['water', 'water', 'air']);
      const top = name === 'bank3' ? O.y + 1 : O.y - 1;
      // every rim cell beside the pit: solid from the water's level to the rim's top, nothing to stand on lower
      for (let i = -2; i <= 2; i++) {
        for (const [x, z] of [[O.x + i, O.z + 1], [O.x + i, O.z + 7], [O.x - 3, O.z + 4 + i], [O.x + 3, O.z + 4 + i]] as const) {
          expect(b(x, O.y - 1, z), `${name} ${x - O.x},${z - O.z}`).toBe(rim[name]);
          for (let y = O.y - 2; y <= top; y++) expect(solid(b(x, y, z)), `${name} ${x - O.x},${y - O.y},${z - O.z}`).toBe(true);
          expect(b(x, top + 1, z), `${name} ${x - O.x},${z - O.z}`).toBe('air');
        }
      }
      expect(s.goal.y, name).toBe(top + 1);
    }
  });
});
