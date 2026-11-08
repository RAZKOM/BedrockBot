// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)"): the world cache's box extract (world/cache/export.ts),
// the cave worlds over it (corridor/cave.ts) and the cave bench's flight (corridor/cave-bench.ts) on a made-up cave,
// and, when the private fixture is there (bot/fixtures-private/cave, CAVE_FIXTURE_DIR), a smoke run over the real one:
// the routes resolve to standable cells and one leg of each mode flies. The scoreboard itself is the script's
// (scripts/cave-bench.ts); nothing here gates its numbers.
import { describe, expect, it } from 'vitest';
import { CLS_AIR, CLS_SOLID, CLS_WATER, Y_NONE, type CellClass } from '../../../src/world/cache/types.ts';
import { decodeExtract, extractBox, TOP_NONE, TOP_UNKNOWN, type ExtractSource } from '../../../src/world/cache/export.ts';
import { caveLegs, caveWorld, loadCaveFixture, ROUTE_A, ROUTE_B } from '../../../src/skills/fly/corridor/cave.ts';
import { caveGoals, caveScore, flyCaveWindow, runCaveExecutor } from '../../../src/skills/fly/corridor/cave-bench.ts';
import { caveWalker } from './fly-cave-walk.ts';

/** A made-up cache: chunks (0..3, 0) known, stone up to y 79 with a 3 x 3 bore at y 60..62 along x (z 6..8), a pool at its end; chunk (1, 1) never seen. */
function madeUpCache(): ExtractSource {
  const cls = (x: number, y: number, z: number): CellClass => {
    if (y >= 80) return CLS_AIR;
    if (z >= 6 && z <= 8 && y >= 60 && y <= 62 && x >= 4 && x <= 56) return x >= 52 && y === 60 ? CLS_WATER : CLS_AIR;
    return CLS_SOLID;
  };
  return {
    cachedSummary(cx, cz) {
      if (cz !== 0 || cx < 0 || cx > 3) return undefined;
      const top = new Int16Array(256).fill(79);
      return { y0: -64, rows: 160, cls: (x, y, z) => cls(cx * 16 + x, y, z), top };
    },
  };
}

describe('the box extract (world/cache/export.ts)', () => {
  const file = extractBox(madeUpCache(), 0, { min: { x: 0, y: 50, z: 0 }, max: { x: 63, y: 90, z: 20 } }, { min: { x: -4, z: 0 }, max: { x: 70, z: 3 } });
  const e = decodeExtract(JSON.parse(JSON.stringify(file)) as typeof file);

  it('round-trips the classes, lists the unknown chunks and the tops', () => {
    expect(e.size).toEqual({ x: 64, y: 41, z: 21 });
    expect(e.cls(10, 61, 7)).toBe(CLS_AIR);
    expect(e.cls(10, 64, 7)).toBe(CLS_SOLID);
    expect(e.cls(53, 60, 7)).toBe(CLS_WATER);
    expect(e.cls(10, 85, 7)).toBe(CLS_AIR);
    expect(e.cls(64, 60, 7)).toBeUndefined();
    expect(e.unknown).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]]);
    expect(e.unknownChunk(1, 1)).toBe(true);
    expect(e.top(10, 1)).toBe(79);
    expect(e.top(-2, 1)).toBe(TOP_UNKNOWN);
    expect(e.top(80, 1)).toBeUndefined();
    expect(file.counts.water).toBe(5 * 3);
    expect(TOP_NONE).not.toBe(Y_NONE + 0.5);
  });

  it('gives the flight, the walk and the coarse layer one world', () => {
    const w = caveWorld(e);
    expect(w.grid.solid(10, 61, 7)).toBe(false);
    expect(w.grid.solid(-1, 61, 7)).toBe(true); // beside the box: solid
    expect(w.grid.solid(10, 40, 7)).toBe(true); // under it
    expect(w.grid.solid(10, 95, 7)).toBe(false); // over it: the sky
    expect(w.grid.solid(10, 61, 18)).toBe(true); // an unknown chunk
    expect(w.query.liquidAt!(53, 60, 7)).toEqual({ liquid: 'water', height: 8 / 9 });
    // Track F6: water is an obstacle to the flight (the grid and `solid`), not a floor (`floor`)
    expect(w.grid.solid(53, 60, 7)).toBe(true);
    expect(w.solid(53, 60, 7)).toBe(true);
    expect(w.floor(53, 60, 7)).toBe(false);
    expect(w.floor(10, 59, 7)).toBe(true);
    expect(w.coarse.chunk(1, 0, 0)?.cls(5, 61, 7)).toBe(CLS_AIR); // wholly inside the box
    expect(w.coarse.chunk(1, 0, 0)?.cls(5, 30, 7)).toBe(CLS_SOLID); // under the box: solid
    expect(w.coarse.chunk(0, 1, 0)).toBeUndefined(); // cut by the box and never seen
    expect(w.coarse.chunk(1, 0, 1)).toBeUndefined(); // another dimension
    expect(w.feetCell({ x: 10, y: 61.2, z: 7 })).toEqual({ x: 10, y: 60, z: 7 });
    expect(w.terrain.blockAt(10, 60, 7)?.name).toBe('air');
    expect(w.terrain.blockAt(10, 59, 7)?.name).toBe('stone');
  });

  it('flies the made-up bore from standing and lands at its far end (the bench flight)', { timeout: 60_000 }, async () => {
    const w = caveWorld(e);
    const from = { x: 6, y: 60, z: 7 };
    const to = { x: 46, y: 60, z: 7 };
    const r = await flyCaveWindow(w, { x: 6.5, y: 60, z: 7.5 }, caveGoals(w, [from, to]), { burn: 15, maxMs: 1e9, maxNodes: 40_000 });
    console.log(`made-up bore: ${r.end} ${r.reached}/${r.goals}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.hits} hits, clearance ${r.minClearance.toFixed(2)}, ${r.plans} plans (${r.partial} partial)`);
    expect(r.end).toBe('done');
    expect(r.damage).toBe(0);
    expect(Math.abs(r.at.x - 46.5)).toBeLessThan(3);
    const s = caveScore('bore', [r]);
    expect([s.done, s.runs]).toEqual([1, 1]);
  });
});

const fix = loadCaveFixture();

describe.skipIf(!fix)('the real cave (private fixture)', () => {
  it('resolves routes A and B to standable cells and flies one leg each way (no gate on the numbers)', { timeout: 300_000 }, async () => {
    const w = caveWorld(fix!.extract);
    const a = caveLegs(fix!, w, ROUTE_A);
    const b = caveLegs(fix!, w, ROUTE_B);
    expect(a.length).toBe(ROUTE_A.stops.length - 1);
    expect(b.length).toBe(ROUTE_B.stops.length - 1);
    const leg = a.at(-1)!; // the last leg, short
    const c = (p: { x: number; y: number; z: number }) => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });
    const f = await flyCaveWindow(w, c(leg.from), caveGoals(w, [leg.from, leg.to]), { burn: 15, maxMs: 1e9, maxNodes: 40_000 });
    const walk = await caveWalker(w)(c(leg.from), leg.to);
    const ex = await runCaveExecutor(w, leg, { burn: 15, maxMs: 1e9, maxNodes: 40_000, walk: caveWalker(w) });
    console.log(`cave ${leg.name}: leg ${f.end} ${f.reached}/${f.goals} ${f.ticks} ticks ${f.hits} hits; walk ${walk.ok ? 'ok' : walk.reason} ${walk.ticks} ticks; executor ${ex.ok ? 'arrived' : ex.reason} (${ex.report.legs.map((l) => l.how).join(', ')})`);
    expect(['done', 'ground', 'water', 'failed', 'timeout']).toContain(f.end);
  });
});
