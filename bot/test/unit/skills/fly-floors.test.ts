// Track F15 (docs/flight.md "Takeoff from a floor the walk reaches (Track F15)"; decisions/0087): a trip out of a room in
// a building in the air. A made-up building on a generated world: a room (11 standable cells, 3 high) whose only way out
// is a ladder in a wall column up to a closed hatch in its ceiling, the ceiling a 9 x 8 roof platform 64 over the ground;
// once under a wider roof 19 over the platform, once under the open sky; with no ladder (truly closed); 11 over the
// ground (the edges too low for a ledge takeoff). The rules guarded:
//   - before: every takeoff family the flight had refuses from the room (no edge on the start's floor, no open-sky site);
//   - the order: the first decision and the walk out as they were; the floors only once that walk and its glide down found
//     no way, from where the body stands then, once a place;
//   - the floor scan finds the roof platform (an edge cell of it), never the start's own floor;
//   - the search probes the walk to the floors (the planner climbs the ladder and opens the hatch), simulates the takeoff
//     there and takes the first that clears; after: the whole flight from there lands on the goal, every burn, no hit;
//   - a closed room: the walk reaches no floor, said so with the size of all it reaches; a low platform: no floor with an
//     edge, said so; the search keeps its bounds (probes, takeoffs); a walk not worth it is not taken;
//   - the reply when nothing is found names the takeoffs first and the walk's own words last, within a chat line.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOOR_ONCE_MS, FLOOR_ONCE_R, LAND_HERE_DY, LAND_HERE_H, landingHere, noTakeoffNote } from '../../../src/chat/commands-fly.ts';
import { edgeCell, FLOOR_PROBES, FLOOR_SIMS, ledgeFloors, searchFloors } from '../../../src/skills/fly/floors.ts';
import { findLedges, landedOn, simulateFlight } from '../../../src/skills/fly/glide.ts';
import { cruiseHeight } from '../../../src/skills/fly/plan.ts';
import { siteCandidates } from '../../../src/skills/fly/sites.ts';
import { building, F, floorDeps, goal, R, rig, START } from './floor-building.ts';

describe('before: every takeoff the flight had refuses from the room (the Realm, 2026-11-14)', () => {
  it('no edge on the start\'s floor; the open-sky sites within 48 are none (a thin roof, the platform near the refused takeoff)', () => {
    const gen = building();
    const { cell } = rig(gen);
    const l = findLedges(cell, START, 0);
    expect(l.ledges).toHaveLength(0);
    expect(l.why).toMatch(/^no edge on the 1[12]-cell platform$/);
    // the open-sky site search's ground rule (commands-fly.ts takeoffSite: a cell on a thin roof is no ground) over the
    // building's columns, and its skip near the refused takeoff: none under the wider roof, none on the open-sky platform
    for (const wide of [true, false]) {
      const g = building({ wide });
      const c = rig(g).cell;
      const sky = (x: number, z: number): number | undefined => {
        let top: number | undefined;
        for (let y = 60; y >= -64; y--) if (c(x, y, z)) {
          top = y;
          break;
        }
        if (top === undefined) return undefined;
        const f = top + 1;
        return c(x, f - 2, z) === false && c(x, f - 3, z) === false ? undefined : f;
      };
      const cands = siteCandidates(START, goal(), 48, sky, (x, z) => Math.hypot(x + 0.5 - START.x, z + 0.5 - START.z) < 8);
      expect(cands, `wide ${wide}`).toHaveLength(0);
    }
  });
});

describe('the floor scan (floors.ts ledgeFloors)', () => {
  it('from the room: the roof platform (one floor, an edge cell of it, 4 levels up); never the start\'s own floor', async () => {
    const gen = building();
    const { cell } = rig(gen);
    const s = await ledgeFloors(cell, START);
    const roof = s.floors.filter((f) => f.feet === R + 4);
    expect(roof).toHaveLength(1);
    expect(roof[0]!.cells).toBeGreaterThanOrEqual(60);
    expect(roof[0]!.edges).toBeGreaterThanOrEqual(20);
    expect(edgeCell(cell, roof[0]!.x, roof[0]!.feet, roof[0]!.z)).toBe(true);
    expect(s.floors.some((f) => f.feet === R)).toBe(false);
    // the wider roof's top is a floor too (above it lies open sky; 23 levels up) and the ground (60 below) is out of the scan
    expect(s.floors.every((f) => f.feet >= R - 16 && f.feet <= R + 32)).toBe(true);
  });

  it('an edge is a side or a corner onto 12 blocks of fall; 11 is not', async () => {
    const { cell } = rig(building({ r: F + 7 }));
    const s = await ledgeFloors(cell, { x: -0.5, y: F + 7, z: -0.5 });
    expect(s.floors.filter((f) => f.feet === F + 11)).toHaveLength(0);
    const high = rig(building());
    expect(edgeCell(high.cell, 4, R + 4, 4)).toBe(true);
    expect(edgeCell(high.cell, 0, R + 4, 0)).toBe(false);
  });
});

describe('the search (floors.ts searchFloors)', () => {
  it('under the wider roof: the walk up the ladder and through the hatch to the platform, its ledge takeoff clears', async () => {
    const d = floorDeps(building());
    const r = await searchFloors(d, START);
    expect(r.site, r.line).toBeDefined();
    expect(r.site!.feet).toBe(R + 4);
    expect(r.site!.walk).toBeGreaterThan(4);
    expect(r.site!.takeoff.ledge).toBeDefined();
    expect(r.line).toMatch(/4 levels up/);
    expect(r.probes).toBe(1);
    expect(r.sims).toBe(1);
  });

  it('under the open sky: the same platform, taken off from', async () => {
    const d = floorDeps(building({ wide: false }), { wide: false });
    const r = await searchFloors(d, START);
    expect(r.site, r.line).toBeDefined();
    expect(r.site!.feet).toBe(R + 4);
  });

  it('a room with no ladder: the walk reaches no floor; said so, with all it reaches', async () => {
    const d = floorDeps(building({ ladder: false }));
    const r = await searchFloors(d, START);
    expect(r.site).toBeUndefined();
    expect(r.closed).toBeGreaterThan(0);
    expect(r.closed).toBeLessThan(40);
    expect(r.said).toMatch(/^none of \d+ with an edge within 24, all it reaches is \d+ cells$/);
    expect(d.stats.takeoffs).toBe(0);
  });

  it('the platform 11 over the ground: no floor with an edge; said so, nothing probed', async () => {
    const d = floorDeps(building({ r: F + 7, wide: false }), { wide: false });
    const r = await searchFloors(d, { x: -0.5, y: F + 7, z: -0.5 });
    expect(r.site).toBeUndefined();
    expect(r.said).toBe('none within 24 has an edge with 12 blocks of fall');
    expect(d.stats.probes).toBe(0);
    // under the wider roof its top is a floor with an edge (24 levels up), which no walk reaches: said so
    const w = floorDeps(building({ r: F + 7 }));
    const rw = await searchFloors(w, { x: -0.5, y: F + 7, z: -0.5 });
    expect(rw.site).toBeUndefined();
    expect(rw.said).toMatch(/^none of 1 with an edge within 24, all it reaches is \d+ cells$/);
    expect(w.stats.takeoffs).toBe(0);
  });

  it('every takeoff refused: the floors reached are said with the first one\'s reason; the bounds hold', async () => {
    // a field of pillars round the room: many floors with edges, each reached (their tops walkable from a ramp), each refused
    const gen = building();
    for (let i = 0; i < 8; i++) {
      const x = -40 + i * 10;
      gen.fill({ x, y: F, z: 20 }, { x: x + 1, y: R + 3, z: 21 }, 'stone');
    }
    const d = floorDeps(gen);
    d.takeoff = () => Promise.resolve({ ok: false, why: 'refused by the test' });
    const r = await searchFloors(d, START);
    expect(r.site).toBeUndefined();
    expect(r.probes).toBeLessThanOrEqual(FLOOR_PROBES);
    expect(r.sims).toBeLessThanOrEqual(FLOOR_SIMS);
    expect(r.said).toMatch(/^1 reached, -?\d+ \d+ -?\d+: refused by the test$/);
  });

  it('a walk not worth it: not taken, no takeoff simulated', async () => {
    const d = floorDeps(building(), { worth: () => false });
    const r = await searchFloors(d, START);
    expect(r.site).toBeUndefined();
    expect(d.stats.takeoffs).toBe(0);
    expect(r.line).toMatch(/not worth it/);
  });
});

describe('after: the whole flight from the floor found lands on the goal (every burn, 10 a case)', () => {
  for (const wide of [true, false]) {
    it(`${wide ? 'under the wider roof' : 'under the open sky'}: 10 flights from the platform, landed, no hit, dry`, async () => {
      const gen = building({ wide });
      const d = floorDeps(gen, { wide });
      const s = await searchFloors(d, START);
      expect(s.site, s.line).toBeDefined();
      const { deps, skyTop } = rig(gen);
      const t = goal();
      const tk = s.site!.takeoff;
      const at = tk.ledge ? { x: tk.ledge.x + 0.5, y: tk.ledge.feet, z: tk.ledge.z + 0.5 } : { x: s.site!.x + 0.5, y: s.site!.feet, z: s.site!.z + 0.5 };
      const cz = cruiseHeight(at, t, skyTop, {});
      let landed = 0;
      for (const burn of [9, 10, 12, 13, 15, 16, 18, 19, 20, 21]) {
        const sim = await simulateFlight(deps, at, t, { cruiseY: cz.y, ...(tk.ledge ? { ledge: { yaw: tk.ledge.yaw } } : { takeoffYaw: tk.takeoffYaw! }) }, { rockets: 64, burn, ...(tk.ledge ? {} : { yaw: tk.takeoffYaw! }) });
        if (landedOn(t, sim)) landed++;
        expect(sim.hits, `burn ${burn}`).toBe(0);
        expect(sim.wet).toBe(false);
      }
      expect(landed).toBe(10);
    }, 120_000);
  }
});

describe('the reply when no takeoff is found (commands-fly.ts noTakeoffNote)', () => {
  const roof = 'fly: no open sky here (roof at y 134, 3 blocks up); walk outside first';
  it('an unreachable walk: the takeoff here, the floors, then the walk\'s own words; within a chat line', () => {
    const r = noTakeoffNote({ ok: false, reason: 'unreachable', note: 'world: no walk, swim or dig gets there', cause: 'world' }, roof, 'none of 1 with an edge within 24, all it reaches is 25 cells');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unreachable');
    expect(r.cause).toBe('world');
    expect(r.note).toBe('no takeoff here (a roof 3 up) or from any floor the walk reaches (none of 1 with an edge within 24, all it reaches is 25 cells); the walk: world: no walk, swim or dig gets there');
    expect(`goto: ${r.reason} (${r.note})`.length).toBeLessThanOrEqual(256);
  });
  it('any other end stands as it is (arrived, a timeout, interrupted)', () => {
    const ok = { ok: true as const };
    expect(noTakeoffNote(ok, roof, 'x')).toBe(ok);
    const t = { ok: false as const, reason: 'timeout' };
    expect(noTakeoffNote(t, roof, 'x')).toBe(t);
    const i = { ok: false as const, reason: 'interrupted' };
    expect(noTakeoffNote(i, roof, 'x')).toBe(i);
  });
});

describe('a landing where the body stands is not flown (commands-fly.ts landingHere; the Realm, 2026-11-15)', () => {
  it('the Realm\'s case: the landing 1 block off at the same height (the walk\'s re-check at the cave mouth): no flight', () => {
    expect(landingHere({ x: 40.5, y: 90, z: 20.5 }, { x: 41.5, z: 19.5, top: 90 })).toBe(true);
    expect(landingHere({ x: 0.5, y: 70, z: 0.5 }, { x: 8.5, z: 0.5, top: 70 })).toBe(true);
    expect(landingHere({ x: 0.5, y: 70, z: 0.5 }, { x: 5.5, z: 5.5, top: 60 })).toBe(true);
  });
  it('a glide down a cliff (a few blocks off by the plane, 12 or more below) and anything farther than 8 blocks stay flights', () => {
    expect(landingHere({ x: 0.5, y: 70, z: 0.5 }, { x: 3.5, z: 0.5, top: 58 })).toBe(false);
    expect(landingHere({ x: 0.5, y: 70, z: 0.5 }, { x: 3.5, z: 0.5, top: 82 })).toBe(false);
    expect(landingHere({ x: 0.5, y: 70, z: 0.5 }, { x: 9.5, z: 0.5, top: 70 })).toBe(false);
    expect(LAND_HERE_H).toBe(8);
    expect(LAND_HERE_DY).toBe(12);
  });
  it('autoFly asks it of every landing it would fly to, and remembers the spot as a refused takeoff (the re-check does not ask again there)', () => {
    const src = readFileSync(new URL('../../../src/chat/commands-fly.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const autoFly = async'), src.indexOf('const sayFlight ='));
    const plan = body.indexOf('const f = await planFlight(from, goalBlock, label, half, false);');
    const here = body.indexOf('if (landingHere(from, f.target)) {');
    expect(plan).toBeGreaterThan(0);
    expect(here).toBeGreaterThan(plan);
    expect(body.slice(here, here + 200)).toMatch(/refusedTakeoffs\.push\(\{ x: from\.x, z: from\.z, at: Date\.now\(\) \}\)/);
    expect(body.indexOf('Object.assign(f.target, tk);')).toBeGreaterThan(here);
  });
});

describe('the floor search is the trip\'s last try and changes no trip that flies or walks today (commands-fly.ts floorFallback)', () => {
  const src = readFileSync(new URL('../../../src/chat/commands-fly.ts', import.meta.url), 'utf8');
  const between = (a: string, b: string): string => {
    const i = src.indexOf(a);
    const j = src.indexOf(b, i);
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    return src.slice(i, j);
  };
  it('the first decision is as it was: takeoffSite (the open-sky sites) and autoFly never search the floors', () => {
    expect(between('const takeoffSite = async', 'const floorSite = async')).not.toMatch(/searchFloors<|floorSite\(|floorFallback\(/);
    expect(between('const autoFly = async', 'const sayFlight =')).not.toMatch(/searchFloors<|floorSite\(|floorFallback\(/);
    expect(between('const walkOut = async', 'const noWay =')).not.toMatch(/searchFloors<|floorSite\(|floorFallback\(/);
    expect(between('const glideFallback = async', 'const retryShort =')).not.toMatch(/searchFloors<|floorSite\(|floorFallback\(/);
  });
  it('one search, from floorFallback only: after the walk out and its glide down found no way, from where the body stands then', () => {
    expect([...src.matchAll(/searchFloors</g)]).toHaveLength(1);
    expect([...src.matchAll(/await floorSite\(/g)]).toHaveLength(1);
    expect([...src.matchAll(/floorFallback\(r, /g)]).toHaveLength(1);
    const fb = between('const floorFallback = async', 'const walk0 = pve.walk.bind(pve);');
    expect(fb.indexOf('if (!noWay(r)')).toBeGreaterThan(0);
    expect(fb.indexOf('const from = position();')).toBeGreaterThan(fb.indexOf('if (!noWay(r)'));
    expect(fb.indexOf('await floorSite(from, goalTarget')).toBeGreaterThan(fb.indexOf('const from = position();'));
    // the walk: the walk out (whose walk is the walk with its glide down), then the floors, only for a walk-out decision
    const walk = between('pve.walk = async', '// ---- Track M3');
    expect(walk).toMatch(/const walkOrGlide = async \(\): Promise<SkillResult> => glideFallback\(await plain\(\), goal\.p, name, 1, plain\);/);
    expect(walk).toMatch(/const r = await runAuto\(f, \(\) => goal\.p, name, 1, f\.kind === 'walk_out' \? walkOrGlide : plain, legWalk\);\n\s+\/\/[^\n]*\n\s+return f\.kind === 'walk_out' \? floorFallback\(r, f\.roof, goal\.p, name, 1, plain, legWalk\) : r;/);
  });
  it('once a place: a search that led to a floor the trip did not arrive from is not asked again within 16 blocks for 5 minutes, so no loop between a floor and a failing walk', () => {
    const fb = between('const floorFallback = async', 'const walk0 = pve.walk.bind(pve);');
    const check = fb.indexOf('floorTried.find(');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(fb.indexOf('await floorSite('));
    expect(fb.indexOf('floorTried.push(')).toBeGreaterThan(fb.indexOf('if (!s.site)'));
    const run = fb.indexOf('const end = await runAuto({ kind: \'site\'');
    expect(fb.indexOf('floorTried.push(')).toBeLessThan(run);
    // a trip that arrived leaves no mark (the next trip from the room takes the floor again)
    expect(fb.slice(run)).toMatch(/if \(end\.ok\) floorTried\.splice\(floorTried\.indexOf\(mark\), 1\);\n\s+return end;/);
    expect(FLOOR_ONCE_R).toBe(16);
    expect(FLOOR_ONCE_MS).toBe(300_000);
  });
  it('its takeoffs never fly the route takeoff', () => {
    expect(between('const floorSite = async', 'const planFlight = async')).toMatch(/takeoffFor\(at, goalTarget, skyHere\(at, goalTarget\), rockets, true, \{ route: false, said \}\)/);
  });
});
