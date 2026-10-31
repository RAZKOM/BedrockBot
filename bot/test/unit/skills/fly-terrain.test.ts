// Track BL (docs/flight.md "Terrain-safe cruise", "High cruise", "Dive descent", "Takeoff sites", "Flight
// re-check on long walks"): the terrain floor, unknown-is-not-air, the dive, the takeoff-site search's
// pure parts, and whole trips on the offline simulator over ridges and towers partly unknown or cache-only.
import { describe, expect, it } from 'vitest';
import { assumedTop, BUILD_TOP, HIGH_CRUISE_Y, highCruiseWanted, strictObstacle, terrainFloor, TerrainMemo, UNKNOWN_SLACK, type TerrainColumn } from '../../../src/skills/fly/terrain.ts';
import { planDive } from '../../../src/skills/fly/dive.ts';
import { preferSite, RECHECK_FAIL_RADIUS, RECHECK_SEARCH_MS, RecheckState, siteCandidates, siteSeconds, WALK_S_PER_BLOCK } from '../../../src/skills/fly/sites.ts';
import { simulateFlight } from '../../../src/skills/fly/glide.ts';
import { flatWorld, withBoxes } from '../../../src/skills/input/index.ts';
import { flyTrip, FEET } from './fly-trip.ts';

interface Box {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  solid: boolean;
}
/** A ridge across the route (x -150..150): rising from z0 over `rise` blocks to `height` above the ground, flat for `top` blocks, falling again. */
function ridge(z0: number, height: number, rise = 60, top = 30): Box[] {
  const out: Box[] = [];
  const steps = Math.ceil(height / 4);
  for (let k = 1; k <= steps; k++) {
    const h = Math.min(height, k * 4);
    const za = z0 + Math.round(((k - 1) / steps) * rise);
    const zb = z0 + rise + top + Math.round(((steps - k + 1) / steps) * rise);
    out.push({ from: { x: -150, y: FEET, z: za }, to: { x: 150, y: FEET + h - 1, z: zb }, solid: true });
  }
  return out;
}
const flat = (top: number) => (): TerrainColumn => ({ top, src: 'live' });

describe('fly terrain: the floor and unknown-is-not-air (terrain.ts)', () => {
  it('assumedTop is the highest known top plus UNKNOWN_SLACK, rising a quarter block per block beyond, capped at the build top', () => {
    expect(assumedTop(64, 0)).toBe(64 + UNKNOWN_SLACK);
    expect(assumedTop(64, 40)).toBe(64 + UNKNOWN_SLACK + 10);
    expect(assumedTop(300, 400)).toBe(BUILD_TOP);
  });

  it('terrainFloor: a known ridge ahead lifts the floor to its top + 1 + clearance (+ the distance / 10 still to glide)', () => {
    const q = (x: number, z: number): TerrainColumn => ({ top: z >= 100 && z <= 120 ? 150 : 64, src: 'live' });
    const f = terrainFloor(q, { x: 0, z: 0 }, { x: 0, z: 1000 }, { clearance: 12 });
    expect(f.top).toBe(150);
    expect(f.src).toBe('live');
    expect(f.at).toBeGreaterThanOrEqual(99);
    expect(f.need).toBeCloseTo(150 + 1 + 12 + f.at / 10, 0);
    expect(f.unknown).toBe(0);
  });

  it('terrainFloor: unknown columns are not air: they stand at the assumed top over the highest known one', () => {
    const q = (x: number, z: number): TerrainColumn => (z > 50 ? { top: undefined, src: 'unknown' } : { top: 64, src: 'live' });
    const f = terrainFloor(q, { x: 0, z: 0 }, { x: 0, z: 1000 }, { clearance: 12 });
    expect(f.src).toBe('assumed');
    expect(f.unknown).toBeGreaterThan(0);
    expect(f.need).toBeGreaterThan(64 + UNKNOWN_SLACK + 12);
    // the same scan over known flat ground at 64 needs far less
    expect(terrainFloor(flat(64), { x: 0, z: 0 }, { x: 0, z: 1000 }, { clearance: 12 }).need).toBeLessThan(f.need ?? -Infinity);
  });

  it('strictObstacle: live cells from the live obstacle, cache-only columns solid to their top, unknown columns solid to the assumed top', () => {
    const q = (x: number): TerrainColumn => (x === 0 ? { top: 70, src: 'live' } : x === 1 ? { top: 90, src: 'cache' } : { top: undefined, src: 'unknown' });
    const o = strictObstacle(q, (_x, y) => y <= 70, 70);
    expect(o(0, 70, 0)).toBe(true);
    expect(o(0, 71, 0)).toBe(false);
    expect(o(1, 90, 0)).toBe(true);
    expect(o(1, 91, 0)).toBe(false);
    expect(o(2, 70 + UNKNOWN_SLACK, 0)).toBe(true);
    expect(o(2, 70 + UNKNOWN_SLACK + 1, 0)).toBe(false);
  });

  it('highCruiseWanted: always / off; auto only for a long trip over unknown terrain whose glide needs nearly the high cruise anyway', () => {
    expect(highCruiseWanted('always', { distance: 100, needed: 80, unknown: 0 })).toBe(true);
    expect(highCruiseWanted('off', { distance: 3000, needed: 320, unknown: 50 })).toBe(false);
    expect(highCruiseWanted('auto', { distance: 2300, needed: 300, unknown: 10 })).toBe(true);
    expect(highCruiseWanted('auto', { distance: 2300, needed: 300, unknown: 0 })).toBe(false);
    expect(highCruiseWanted('auto', { distance: 1200, needed: 300, unknown: 10 })).toBe(false);
    expect(highCruiseWanted('auto', { distance: 2300, needed: 200, unknown: 10 })).toBe(false);
    expect(HIGH_CRUISE_Y).toBe(328);
  });

  it('TerrainMemo keeps known columns until their chunk is invalidated and asks unknown ones again after the TTL', () => {
    let calls = 0;
    let src: 'live' | 'unknown' = 'unknown';
    const m = new TerrainMemo(() => (calls++, { top: src === 'live' ? 70 : undefined, src }), 3);
    m.query(5, 5);
    m.query(5, 5);
    expect(calls).toBe(1);
    for (let i = 0; i < 3; i++) m.tick();
    src = 'live';
    expect(m.query(5, 5).src).toBe('live');
    expect(calls).toBe(2);
    m.query(5, 5);
    expect(calls).toBe(2);
    m.invalidateChunk(0, 0);
    m.query(5, 5);
    expect(calls).toBe(3);
  });
});

describe('fly terrain: whole trips over ridges and towers (the offline simulator)', () => {
  it('the economy sink line no longer flies into a ridge 100 high halfway along a 1200-block trip (the Realm 2026-10-31 roof endings)', () => {
    const old = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(560, 100) });
    const now = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(560, 100), terrain: true });
    expect(old.end.ok && old.hits === 0 && old.steered === 0).toBe(false);
    expect(now.end.ok).toBe(true);
    expect(now.hits).toBe(0);
    expect(now.steered).toBe(0);
    expect(now.avoidances.length).toBeGreaterThan(0);
  });

  it('a ridge 80 high late in the glide (900 of 1200) is climbed over early, not steered round at the last moment', () => {
    const old = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(860, 80) });
    const now = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(860, 80), terrain: true });
    expect(old.steered).toBeGreaterThan(0);
    expect(now.end.ok).toBe(true);
    expect(now.steered).toBe(0);
    expect(now.hits).toBe(0);
  });

  it('a ridge whose columns are unknown to the model until the body is within 96 blocks (the chunks load late) is not flown into', () => {
    const r = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(560, 100), terrain: true, unknown: (_x, z) => z >= 400 && z <= 900, view: 96 });
    expect(r.end.ok).toBe(true);
    expect(r.hits).toBe(0);
  });

  it('a ridge only the world cache knows (its chunks not loaded) is climbed over to its cached top', () => {
    const r = flyTrip({ dist: 1200, up: 0, half: 1, extra: ridge(560, 100), terrain: true, cacheOnly: (_x, z) => z >= 400 && z <= 900 });
    expect(r.end.ok).toBe(true);
    expect(r.hits).toBe(0);
    expect(r.steered).toBe(0);
  });

  it('a tower 90 high 200 out on a 300-block trip is climbed over without a hit', () => {
    const tower: Box[] = [{ from: { x: -6, y: FEET, z: 195 }, to: { x: 6, y: FEET + 89, z: 205 }, solid: true }];
    const r = flyTrip({ dist: 300, up: 0, half: 1, extra: tower, terrain: true });
    expect(r.end.ok).toBe(true);
    expect(r.hits).toBe(0);
  });

  it('flat trips cost no more rockets with the terrain floor (300: 2, 1200: 7)', () => {
    expect(flyTrip({ dist: 300, up: 0, half: 1, terrain: true }).rockets).toBeLessThanOrEqual(2);
    expect(flyTrip({ dist: 1200, up: 0, half: 1, terrain: true }).rockets).toBeLessThanOrEqual(7);
  });
});

describe('fly terrain: the dive descent (dive.ts, brain.ts)', () => {
  for (const [up, dist] of [
    [100, 250],
    [200, 350],
    [300, 450],
  ] as const) {
    it(`from ${up} above a 3x3 platform ${dist} out the dive lands at least three times sooner than the spiral, no hit, no go-around`, () => {
      const dive = flyTrip({ dist, up: 0, half: 1, startUp: up, terrain: true, descent: 'dive' });
      const spiral = flyTrip({ dist, up: 0, half: 1, startUp: up, terrain: true, descent: 'spiral' });
      expect(dive.end.ok).toBe(true);
      expect(dive.hits).toBe(0);
      expect(dive.goArounds).toBe(0);
      expect(dive.dives).toBeGreaterThan(0);
      expect(spiral.end.ok).toBe(true);
      expect(dive.ticks * 3).toBeLessThan(spiral.ticks);
    });
  }

  it('planDive refuses a dive whose corridor meets terrain (a wall between the body and the landing)', () => {
    const target = { x: 0.5, z: 200.5, top: FEET, half: 1, ground: FEET }; // 100 above, 200 out
    const body = { pos: { x: 0.5, y: FEET + 100, z: 0.5 }, vel: { x: 0, y: 0, z: 1.5 }, onGround: false, gliding: true, boostTicks: 0 };
    const clear = planDive(body, 0, target, { obstacle: (_x, y) => y < FEET });
    const walled = planDive(body, 0, target, { obstacle: (_x, y, z) => y < FEET || (z >= 40 && z <= 150 && y < FEET + 60) });
    expect(clear.ok).toBe(true);
    expect(walled.ok).toBe(false);
  });
});

describe('fly terrain: takeoff sites and the walk re-check (sites.ts)', () => {
  it('siteSeconds / preferSite: walk to a site and fly when the whole walk takes flyPreferRatio times longer', () => {
    expect(siteSeconds(20, 0)).toBeCloseTo(20 * WALK_S_PER_BLOCK + 8, 5);
    expect(preferSite(600, 30, 580, 1.5)).toBe(true);
    expect(preferSite(100, 30, 80, 1.5)).toBe(false);
  });

  it('siteCandidates: open-sky cells in any direction (behind the goal too), cheapest walk + flight first, none near the feet or far above', () => {
    // a forest everywhere except a clearing 30 blocks BEHIND the start (the goal is 600 ahead) and a roof top 20 up beside it
    const landable = (x: number, z: number): number | undefined => (x >= -4 && x <= 4 && z >= -34 && z <= -26 ? FEET : x >= 10 && x <= 14 && z >= -4 && z <= 4 ? FEET + 20 : undefined);
    const c = siteCandidates({ x: 0.5, y: FEET, z: 0.5 }, { x: 0.5, z: 600.5 }, 48, landable);
    expect(c.length).toBeGreaterThan(0);
    expect(c.every((s) => s.z <= -26)).toBe(true);
    expect(c[0]!.z).toBe(-26);
    expect(siteCandidates({ x: 0.5, y: FEET, z: 0.5 }, { x: 0.5, z: 600.5 }, 48, landable, (_x, z) => z < -28).every((s) => s.z >= -28)).toBe(true);
  });

  it('RecheckState: looks again every N blocks walked, when the kit becomes ready, when out from under a roof; one search per RECHECK_SEARCH_MS; never near a refused takeoff', () => {
    const s = new RecheckState();
    let now = 0;
    expect(s.due({ x: 0, z: 0 }, true, false, 24, now)).toBeUndefined(); // the first look only notes the state
    expect(s.due({ x: 0, z: 10 }, true, false, 24, (now += 1000))).toBeUndefined();
    expect(s.due({ x: 0, z: 25 }, true, false, 24, (now += 1000))).toBe('distance');
    expect(s.due({ x: 0, z: 26 }, true, true, 24, (now += 1000))).toBeUndefined(); // out from under a roof, but within RECHECK_SEARCH_MS
    now += RECHECK_SEARCH_MS;
    expect(s.due({ x: 0, z: 27 }, true, false, 24, now)).toBeUndefined();
    expect(s.due({ x: 0, z: 28 }, true, true, 24, now + 1000)).toBe('sky');
    const k = new RecheckState();
    k.due({ x: 0, z: 0 }, false, true, 24, 0);
    expect(k.due({ x: 0, z: 30 }, false, true, 24, 1000)).toBeUndefined(); // no kit: never
    expect(k.due({ x: 0, z: 31 }, true, true, 24, 2000)).toBe('kit');
    const f = new RecheckState();
    f.refused({ x: 0, z: 40 }, 0);
    f.due({ x: 0, z: 0 }, true, true, 24, 0);
    expect(f.due({ x: 0, z: 40 - RECHECK_FAIL_RADIUS + 2 }, true, true, 24, 1000)).toBeUndefined();
    expect(f.due({ x: 0, z: 40 + RECHECK_FAIL_RADIUS + 2 }, true, true, 24, 2000)).toBe('distance');
  });

  it('the takeoff simulation with the terrain columns: a climbing turn into an unknown hillside counts as a hit (unknown is not air)', async () => {
    const world = withBoxes(flatWorld(), []);
    const target = { x: 0.5, z: -600.5, top: FEET, half: 1, ground: FEET };
    // everything beyond 30 blocks unknown: the climb heading away (+z) turns back over the unknown columns low
    const terrain = (x: number, z: number): TerrainColumn => (Math.hypot(x, z) > 30 ? { top: undefined, src: 'unknown' } : { top: FEET - 1, src: 'live' });
    const base = { world, groundAt: (_x: number, _z: number) => FEET, skyTop: () => FEET - 1 };
    const opts = { cruiseY: FEET + 40, margin: 15 };
    const open = await simulateFlight(base, { x: 0.5, y: FEET, z: 0.5 }, target, { ...opts, takeoffYaw: 0 }, { rockets: 10, yaw: 0, maxTicks: 300, until: (b) => b.phase === 'approach' });
    const strict = await simulateFlight({ ...base, terrain }, { x: 0.5, y: FEET, z: 0.5 }, target, { ...opts, takeoffYaw: 0 }, { rockets: 10, yaw: 0, maxTicks: 300, until: (b) => b.phase === 'approach' });
    expect(open.hits).toBe(0);
    // the strict simulation either climbs over the assumed terrain (its floor) or reports the corridor
    expect(strict.unknownHits === 0 ? strict.body.pos.y > FEET + UNKNOWN_SLACK : strict.hits > 0).toBe(true);
  });
});
