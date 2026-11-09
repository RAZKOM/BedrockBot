// Track L1 (docs/flight.md "Landing by time (Track L1)", decisions/0076-land-by-time.md): the landing decided by time.
// The price (landprice.ts): a cheap walk beats a go-around, a long one does not, a repeat miss is not flown again; the
// landing search (landing.ts): a covered goal's candidates by the walk flood (the tunnel's mouth, not the hill over
// it), an open cell whose approach the simulation does not land is not taken (a pit), a hazard is never a landing or an
// alternative; the brain (brain.ts): a missed approach lands on an alternative instead of going round when that is cheaper.
import { describe, expect, it } from 'vitest';
import { approachBearings, approachLands, ColumnView, findLanding, walkFlood, walkTarget, type BlockLookup, type LandingOptions, type ProbeOutcome } from '../../../src/skills/fly/landing.ts';
import { decideGoAround, GOAROUND_COST_S, GOAROUND_P, GOAROUND_P_REPEAT, goAroundChance, holdWorth, UNKNOWN_RISK_S, WALK_S_PER_BLOCK, walkSeconds } from '../../../src/skills/fly/landprice.ts';
import { columnKey, onTarget, type LandingTarget } from '../../../src/skills/fly/plan.ts';
import { FEET, trip, world } from './fly-worlds.ts';

const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000 };

describe('fly: landing by time, the price (Track L1)', () => {
  it('a go-around costs its measured seconds and rockets; the chance it lands depends on the miss and on the miss before', () => {
    expect(GOAROUND_COST_S).toBeGreaterThan(6);
    expect(GOAROUND_COST_S).toBeLessThan(10);
    expect(goAroundChance('over')).toBe(GOAROUND_P.over);
    expect(goAroundChance('wall')).toBeLessThan(goAroundChance('over'));
    expect(goAroundChance('wall', 'wall')).toBe(GOAROUND_P_REPEAT);
    expect(goAroundChance('over', 'wall')).toBeLessThan(goAroundChance('over'));
  });

  it('a walk: a confirmed path at the walking pace, an unknown one dearer by the detour and the risk', () => {
    expect(walkSeconds({ blocks: 0, known: true })).toBe(0);
    expect(walkSeconds({ blocks: 10, known: true })).toBeCloseTo(10 * WALK_S_PER_BLOCK);
    expect(walkSeconds({ blocks: 10, known: false })).toBeGreaterThan(walkSeconds({ blocks: 10, known: true }) + UNKNOWN_RISK_S - 0.01);
  });

  it("the owner's case: 2 s of walk is not worth a go-around, even one that would surely land", () => {
    const a = decideGoAround({ kind: 'over', targetWalkS: 0, offers: [{ what: 'the cell beside', walkS: 2, extraS: 0 }], canGoAround: true });
    expect(a.goAround).toBe(false);
    expect(a.offer).toBe(0);
    expect(a.line).toMatch(/land now on the cell beside .* against a go-around .*: landing now/);
  });

  it('a long walk is worth a go-around that will likely land; not after the same miss twice', () => {
    const far = { what: 'the hill', walkS: 60, extraS: 3 };
    const first = decideGoAround({ kind: 'over', targetWalkS: 4, offers: [far], canGoAround: true });
    expect(first.goAround).toBe(true);
    expect(first.line).toMatch(/going round/);
    // a wall miss lands after a go-around about one time in five: 0.19 x 59 s saved is worth the 7 s circuit
    expect(decideGoAround({ kind: 'wall', targetWalkS: 4, offers: [far], canGoAround: true }).goAround).toBe(true);
    // the same wall miss again: a third go-around lands 1 in 50 times; the hill now
    const again = decideGoAround({ kind: 'wall', previous: 'wall', targetWalkS: 4, offers: [far], canGoAround: true });
    expect(again.goAround).toBe(false);
    expect(again.offer).toBe(0);
  });

  it('the cheapest offer is taken (the height to lose counts); nothing to land on: round while one is left', () => {
    const a = decideGoAround({ kind: 'none', targetWalkS: 0, offers: [{ what: 'far', walkS: 30, extraS: 0 }, { what: 'near but high', walkS: 5, extraS: 4 }], canGoAround: true });
    expect(a.goAround).toBe(false);
    expect(a.offer).toBe(1);
    expect(decideGoAround({ kind: 'over', targetWalkS: 0, offers: [], canGoAround: true }).goAround).toBe(true);
    expect(decideGoAround({ kind: 'over', targetWalkS: 0, offers: [], canGoAround: false }).goAround).toBe(false);
    expect(decideGoAround({ kind: 'over', targetWalkS: 0, offers: [{ what: 'x', walkS: 90, extraS: 0 }], canGoAround: false })).toMatchObject({ goAround: false, offer: 0 });
  });

  it('the hold: the loaded part lands now unless an unloaded column could save more than the wait', () => {
    expect(holdWorth(3, 2, 2).wait).toBe(false);
    expect(holdWorth(20, 5, 2).wait).toBe(true);
    expect(holdWorth(20, 19, 2).wait).toBe(false);
  });
});

/** The sea one block deep everywhere (no landing), a 1 x 1 pillar 2 high as the goal, the extra boxes given. */
function sea(boxes: Parameters<typeof world>[0], lava: { from: { x: number; z: number }; to: { x: number; z: number } }[] = []) {
  const w = world([{ from: { x: 0, y: FEET, z: 0 }, to: { x: 0, y: FEET + 1, z: 0 }, solid: true }, ...boxes], [{ from: { x: -80, y: FEET, z: -80 }, to: { x: 80, y: FEET, z: 80 }, solid: false }]);
  const inLava = (x: number, y: number, z: number): boolean => y === FEET + 1 && lava.some((l) => x >= l.from.x && x <= l.to.x && z >= l.from.z && z <= l.to.z);
  const look: BlockLookup = (x, y, z) => {
    const b = w.look(x, y, z);
    return b && !b.solid && inLava(x, y, z) ? { name: 'lava', solid: false } : b;
  };
  return { ...w, look, obstacle: (x: number, y: number, z: number) => w.solid.solidAt(x, y, z) === true };
}

/** A probe that finds every start: its straight distance to the goal and one more. */
const anyWalk = (goal: { x: number; z: number }) => (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve({ status: 'found', blocks: Math.hypot(from.x - goal.x - 0.5, from.z - goal.z - 0.5) + 1 });

describe('fly: landing by time, the search (Track L1)', () => {
  it('a pit 29 deep is no landing (the approach simulated from where the flight comes in hits its wall); the island farther off is', async () => {
    // a mesa 30 high from x 6, a 3 x 3 pit down to one over the sea's floor at x 7..9; a dry island at x -20
    const w = sea([
      { from: { x: 6, y: FEET, z: -15 }, to: { x: 40, y: FEET + 29, z: 15 }, solid: true },
      { from: { x: 7, y: FEET + 1, z: -1 }, to: { x: 9, y: FEET + 29, z: 1 }, solid: false },
      { from: { x: -22, y: FEET, z: -2 }, to: { x: -18, y: FEET, z: 2 }, solid: true },
    ]);
    const view = new ColumnView(w.look, FEET + 1);
    const pit = walkTarget({ x: 8, z: 0, feet: FEET + 1, kind: 'open' }, new Set([columnKey(8, 0)]));
    expect(approachLands(view, pit, approachBearings(pit, { x: -300, z: 0 }), w.obstacle, 'flare', { sims: 0, max: 99 }).ok).toBe(false);
    const goal = { x: 0, y: FEET + 2, z: 0 };
    // (the mesa's top walks nowhere)
    const walk = anyWalk(goal);
    const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => (from.y > FEET + 2 ? Promise.resolve({ status: 'none' }) : walk(from));
    const plan = await findLanding(goal, 'pillar', { look: w.look, obstacle: w.obstacle, probe }, { ...OPTS, from: { x: -300, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(plan.line).toMatch(/8 -59 0:path \d+, no approach/);
    expect(plan.cell.x).toBeLessThanOrEqual(-18);
    expect(plan.target.walkS).toBeCloseTo(walkSeconds({ blocks: plan.walk, known: true }));
    expect(plan.target.walkKnown).toBe(true);
  });

  it('a covered goal (a tunnel 30 long under a low hill): the cells by the walk flood, the mouth, not the hill top over the goal', async () => {
    // the hill 4 high over x -10..30, the tunnel 3 wide and 3 high from the goal out to its mouth at x 31; the ground flat
    const w = world([
      { from: { x: -10, y: FEET, z: -10 }, to: { x: 30, y: FEET + 3, z: 10 }, solid: true },
      { from: { x: -1, y: FEET, z: -1 }, to: { x: 30, y: FEET + 2, z: 1 }, solid: false },
    ]);
    const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
    const goal = { x: 0, y: FEET, z: 0 };
    const view = new ColumnView(w.look, goal.y);
    const flood = walkFlood(view, { x: 0, z: 0, feet: FEET }, 48);
    expect(flood.entrance?.steps).toBe(31);
    expect(flood.steps(31, FEET, 0)).toBe(31);
    // the probe: from the ground through the mouth; from the hill top down its side and round (about 70)
    const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> =>
      Promise.resolve({ status: 'found', blocks: from.y === FEET ? Math.hypot(from.x - 31, from.z) + 31 : 70 });
    const plan = await findLanding(goal, 'tunnel', { look: w.look, obstacle, probe }, { ...OPTS, from: { x: 300, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(plan.cell.feet).toBe(FEET);
    expect(plan.cell.x).toBeGreaterThanOrEqual(31);
    expect(plan.walk).toBeLessThan(40);
    expect(plan.line).toMatch(/walk flood \d+ floors \(open sky 31 steps from the goal/);
    // the cheapest landings beside it ride along, each priced, none on the hill
    for (const a of plan.target.alternatives ?? []) {
      expect(a.top).toBe(FEET);
      expect(a.walkS).toBeGreaterThanOrEqual(plan.target.walkS!);
    }
  });

  it('a hazard is never a landing nor an alternative: lava round the goal, the dry ground beyond it', async () => {
    const w = sea([{ from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET, z: 40 }, solid: true }], [{ from: { x: -9, z: -9 }, to: { x: 9, z: 9 } }]);
    const goal = { x: 0, y: FEET + 2, z: 0 };
    const plan = await findLanding(goal, 'pillar', { look: w.look, obstacle: w.obstacle, probe: anyWalk(goal) }, { ...OPTS, from: { x: 300, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    const inLava = (x: number, z: number): boolean => Math.abs(x) <= 10 && Math.abs(z) <= 10; // (and the cells beside it: not sound)
    expect(inLava(plan.cell.x, plan.cell.z)).toBe(false);
    for (const k of plan.target.cells ?? []) expect(inLava(Math.floor(k / 65536) - (Math.floor(k / 65536) > 32768 ? 65536 : 0), (k % 65536) - (k % 65536 > 32768 ? 65536 : 0))).toBe(false);
    for (const a of plan.target.alternatives ?? []) expect(inLava(Math.floor(a.x), Math.floor(a.z))).toBe(false);
  });

  it('a partly loaded window answers only when asked (the hold), with the least walk the unloaded part could offer', async () => {
    // (the goal on a pillar 4 high: no landing itself)
    const w = sea([
      { from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET, z: 40 }, solid: true },
      { from: { x: 0, y: FEET + 2, z: 0 }, to: { x: 0, y: FEET + 3, z: 0 }, solid: true },
    ]);
    const half: BlockLookup = (x, y, z) => (x < -3 ? undefined : w.look(x, y, z));
    const goal = { x: 0, y: FEET + 4, z: 0 };
    expect((await findLanding(goal, 'g', { look: half, obstacle: w.obstacle, probe: anyWalk(goal) }, OPTS)).kind).toBe('unknown');
    const p = await findLanding(goal, 'g', { look: half, obstacle: w.obstacle, probe: anyWalk(goal) }, { ...OPTS, partial: true });
    expect(p.kind, p.line).toBe('cell');
    if (p.kind !== 'cell') return;
    expect(p.unloaded?.bound).toBeCloseTo(4, 0);
    expect(p.line).toMatch(/columns loaded, the nearest unloaded 4 out/);
  });
});

describe('fly: landing by time, the brain (Track L1)', () => {
  // the pit of the first search test as the target (a walk landing whose approach cannot land), the island as its alternative
  const pitWorld = () =>
    sea([
      { from: { x: 6, y: FEET, z: -15 }, to: { x: 40, y: FEET + 29, z: 15 }, solid: true },
      { from: { x: 7, y: FEET + 1, z: -1 }, to: { x: 9, y: FEET + 29, z: 1 }, solid: false },
      { from: { x: -24, y: FEET, z: -4 }, to: { x: -16, y: FEET, z: 4 }, solid: true },
      // the start's platform
      { from: { x: -306, y: FEET, z: -5 }, to: { x: -295, y: FEET, z: 5 }, solid: true },
    ]);
  const island = (walkS: number): LandingTarget => {
    const cells = new Set<number>();
    for (let x = -21; x <= -19; x++) for (let z = -1; z <= 1; z++) cells.add(columnKey(x, z));
    return walkTarget({ x: -20, z: 0, feet: FEET + 1, kind: 'open' }, cells, { walkS, walkKnown: true, name: 'the island' });
  };
  const pit = (alt: LandingTarget | undefined, walkS: number | undefined): LandingTarget =>
    walkTarget({ x: 8, z: 0, feet: FEET + 1, kind: 'open' }, new Set([columnKey(8, 0)]), { ...(walkS !== undefined ? { walkS, walkKnown: true } : {}), ...(alt ? { alternatives: [alt] } : {}) });

  it('a missed approach with a cheap alternative lands there instead of going round (one priced line, no go-around)', () => {
    const w = pitWorld();
    const r = trip(w, { x: -300.5, y: FEET + 1, z: 0.5 }, pit(island(6), 3), { maxTicks: 6000 });
    const why = `${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(1)} ${r.body.pos.y.toFixed(1)} ${r.body.pos.z.toFixed(1)}; ${r.notes.join(' | ')}`;
    expect(r.goArounds, why).toBe(0);
    expect(r.notes.some((n) => n.startsWith('landing price: land now on the island')), why).toBe(true);
    expect(r.end.ok, why).toBe(true);
    expect(onTarget(island(6), r.body.pos), why).toBe(true);
    expect(r.stats.landingPrices.length).toBeGreaterThanOrEqual(1);
  });

  it('a long walk from every landing now is worth a go-around; the same miss again is not (fewer than the old four)', () => {
    const w = pitWorld();
    // (200 s of walk: worth a go-around at any first miss, even one that lands 1 in 20 times)
    const r = trip(w, { x: -300.5, y: FEET + 1, z: 0.5 }, pit(island(200), 3), { maxTicks: 9000 });
    const why = `${r.end.ok ? 'ok' : r.end.reason} at ${r.body.pos.x.toFixed(1)} ${r.body.pos.y.toFixed(1)} ${r.body.pos.z.toFixed(1)}; ${r.notes.join(' | ')}`;
    expect(r.goArounds, why).toBeGreaterThanOrEqual(1);
    expect(r.goArounds, why).toBeLessThanOrEqual(3);
    expect(r.notes.some((n) => /^landing price: .*going round/.test(n)), why).toBe(true);
    expect(r.notes.some((n) => n.startsWith('land now: ')), why).toBe(true);
    expect(r.notes.some((n) => n.startsWith('no go-around left')), why).toBe(false);
  });

  it('an exact landing (no walk price) keeps the go-arounds as before: no priced line', () => {
    const w = pitWorld();
    const r = trip(w, { x: -300.5, y: FEET + 1, z: 0.5 }, pit(undefined, undefined), { maxTicks: 9000 });
    expect(r.stats.landingPrices.length).toBe(0);
    expect(r.notes.some((n) => n.startsWith('landing price'))).toBe(false);
  });
});
