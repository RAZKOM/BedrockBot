// Track CA: the walk out's first leg (commands-fly.ts openSkyLeg) is the nearest open sky by walking
// (skills/home/reach.ts probeOpenSky). The owner's case (2026-11-06): at the foot of a diagonal mineshaft
// the straight line to home points at the surface over the bot's head; the only way there is up the
// shaft, which comes out near home, so the walk climbed out and walked back. The exit is the shaft's top.
import { describe, expect, it } from 'vitest';
import { NavGrid } from '../../../src/skills/nav/index.ts';
import { probeOpenSky, type ProbeNav } from '../../../src/skills/home/reach.ts';
import { flatGen } from './genworld.ts';

const F = -60; // feet on the flat world's grass
const navOf = (grid: NavGrid): ProbeNav => ({ grid, planOptions: () => ({}) });

/** A stone hill x 0..30, z -5..5, y F..F+15 (top at F+15), a room at its foot x 24..26 and a 1-wide staircase rising towards -x to its top. */
function mineshaft() {
  const gen = flatGen();
  gen.fill({ x: 0, y: F, z: -5 }, { x: 30, y: F + 15, z: 5 }, 'stone');
  gen.fill({ x: 24, y: F, z: 0 }, { x: 26, y: F + 2, z: 0 }, 'air');
  for (let k = 0; k <= 16; k++) gen.fill({ x: 24 - k, y: F + k, z: 0 }, { x: 24 - k, y: F + k + 2, z: 0 }, 'air');
  return gen;
}

describe('probeOpenSky (Track CA)', () => {
  it('from the foot of a mineshaft: the top of the shaft, by path', async () => {
    const grid = new NavGrid(mineshaft());
    const r = await probeOpenSky(navOf(grid), { x: 26.5, y: F, z: 0.5 });
    expect('at' in r).toBe(true);
    if (!('at' in r)) return;
    expect(r.at.x).toBeLessThanOrEqual(9); // up the staircase, not the hill top over the room (x 26)
    expect(r.at.x).toBeGreaterThanOrEqual(0);
    expect(r.at.y).toBeGreaterThanOrEqual(F + 15);
    expect(r.at.z).toBe(0);
    expect(r.blocks).toBeGreaterThan(20);
  });

  it('already under open sky: an exit where the bot stands', async () => {
    const grid = new NavGrid(mineshaft());
    const r = await probeOpenSky(navOf(grid), { x: -20.5, y: F, z: 0.5 });
    expect('at' in r && r.blocks < 4).toBe(true);
  });

  it('walled in: no exit, and why', async () => {
    const gen = mineshaft();
    gen.fill({ x: 23, y: F, z: 0 }, { x: 23, y: F + 3, z: 0 }, 'stone'); // the staircase's first steps closed
    const r = await probeOpenSky(navOf(new NavGrid(gen)), { x: 25.5, y: F, z: 0.5 });
    expect('why' in r).toBe(true);
  });
});
