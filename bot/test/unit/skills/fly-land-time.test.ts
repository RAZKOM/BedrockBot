// Track L1 (docs/flight.md "Landing by time (Track L1)", decisions/0076-land-by-time.md): the landing decided by time.
// The price (landprice.ts): a cheap walk beats a go-around, a long one does not, a repeat miss is not flown again; the
// landing search (landing.ts): a covered goal's candidates by the walk flood (the tunnel's mouth, not the hill over
// it), an open cell whose approach the simulation does not land is not taken (a pit), a hazard is never a landing or an
// alternative; the brain (brain.ts): a missed approach lands on an alternative instead of going round when that is cheaper.
import { describe, expect, it } from 'vitest';
import { approachBearings, approachLands, ColumnView, findLanding, LONG_PROBE, walkFlood, walkTarget, type BlockLookup, type LandingOptions, type ProbeBudget, type ProbeOutcome } from '../../../src/skills/fly/landing.ts';
import { decideGoAround, GOAROUND_COST_S, GOAROUND_P, GOAROUND_P_REPEAT, goAroundChance, holdWorth, PATH_MIN_S_PER_BLOCK, PATH_PACE, probeTicks, TICKS_PER_S, UNKNOWN_DETOUR, UNKNOWN_RISK_S, WALK_S_PER_BLOCK, walkPriceOf, walkSeconds } from '../../../src/skills/fly/landprice.ts';
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
    expect(plan.line).toMatch(/8 -59 0:path \d+ [\d.]+ s pace, no approach/);
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

describe('fly: landing by time, the walk by its path (Track L2)', () => {
  it("a probed walk is priced by the probe's planned ticks; the surface preference and the drop's extra are no time", () => {
    expect(walkSeconds({ blocks: 15, known: true, ticks: 80 })).toBeCloseTo((80 / TICKS_PER_S) * PATH_PACE);
    expect(walkPriceOf({ blocks: 15, known: true, ticks: 80 })).toBe('path');
    expect(walkPriceOf({ blocks: 15, known: true })).toBe('pace');
    expect(walkPriceOf({ blocks: 15, known: false, ticks: 80 })).toBe('unknown');
    // an unconfirmed walk keeps its detour and its risk, whatever ticks it carries
    expect(walkSeconds({ blocks: 15, known: false, ticks: 80 })).toBeCloseTo(15 * UNKNOWN_DETOUR * WALK_S_PER_BLOCK + UNKNOWN_RISK_S);
    // a path: a walk on the flat, two under a roof (each + 6), a drop of 3 (+ 30: no climbing back), a walk
    const path = [
      { x: 0, z: 0, feet: 10, move: 'start', cost: 0 },
      { x: 1, z: 0, feet: 10, move: 'walk', cost: 4.6 },
      { x: 2, z: 0, feet: 10, move: 'walk', cost: 4.6 + 6 },
      { x: 3, z: 0, feet: 10, move: 'walk', cost: 4.6 + 6 },
      { x: 4, z: 0, feet: 7, move: 'drop', cost: 15.6 + 30 },
      { x: 5, z: 0, feet: 7, move: 'walk', cost: 4.6 },
    ];
    const roof = (x: number): boolean => x === 2 || x === 3;
    expect(probeTicks(path, { underground: 6, isUnderground: (x) => roof(x), irreversibleDrop: 30, jumpRise: 1.25 })).toBeCloseTo(4 * 4.6 + 15.6);
    // (planned without the surface preference: nothing to take out for it)
    expect(probeTicks(path.map((n) => ({ ...n, cost: roof(n.x) ? n.cost - 6 : n.cost })), { underground: 0, irreversibleDrop: 30, jumpRise: 1.25 })).toBeCloseTo(4 * 4.6 + 15.6);
    // the probe's fastest pace bounds every probed walk from below (the search's stop rule)
    expect(PATH_MIN_S_PER_BLOCK).toBeLessThanOrEqual(WALK_S_PER_BLOCK);
    expect(PATH_MIN_S_PER_BLOCK).toBeGreaterThan(0.1);
  });

  // the sea round a pillar (the goal, no landing itself); a dry island west 15 blocks of walk away whose walk is slow (a
  // swim: many ticks), one east 21 blocks away whose walk is quick: the old pace (blocks x 0.3) took the west one
  const islands = () =>
    sea([
      { from: { x: -18, y: FEET, z: -2 }, to: { x: -14, y: FEET, z: 2 }, solid: true },
      { from: { x: 18, y: FEET, z: -2 }, to: { x: 22, y: FEET, z: 2 }, solid: true },
    ]);
  const islandProbe = (ticksWest: number | undefined, ticksEast: number | undefined) => (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => {
    const west = from.x < 0;
    const blocks = west ? 15 : 21;
    const ticks = west ? ticksWest : ticksEast;
    return Promise.resolve({ status: 'found', blocks, ...(ticks !== undefined ? { ticks } : {}) });
  };

  it('a short confirmed walk beats a long one the old constant preferred; the line says how each was priced', async () => {
    const w = islands();
    const goal = { x: 0, y: FEET + 2, z: 0 };
    const deps = (probe: ReturnType<typeof islandProbe>) => ({ look: w.look, obstacle: w.obstacle, probe });
    // the old pace (no ticks from the probe): the west island, 15 blocks
    const old = await findLanding(goal, 'pillar', deps(islandProbe(undefined, undefined)), { ...OPTS, from: { x: 0, z: -300 } });
    expect(old.kind, old.line).toBe('cell');
    if (old.kind !== 'cell') return;
    expect(old.cell.x).toBeLessThan(0);
    expect(old.target.walkBy).toBe('pace');
    expect(old.line).toMatch(/blocks of walk \([\d.]+ s at 0\.3 s a block\)/);
    // by the path: the west walk is a 21 s swim, the east one 5 s: the east island
    const plan = await findLanding(goal, 'pillar', deps(islandProbe(400, 100)), { ...OPTS, from: { x: 0, z: -300 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    expect(plan.cell.x, plan.line).toBeGreaterThan(0);
    expect(plan.target.walkBy).toBe('path');
    expect(plan.target.walkS).toBeCloseTo((100 / TICKS_PER_S) * PATH_PACE);
    expect(plan.line).toMatch(/21 blocks of walk \([\d.]+ s by its path\)/);
    expect(plan.line).toContain(`:path 15 ${((400 / TICKS_PER_S) * PATH_PACE).toFixed(1)} s`);
    // the west island rides along as an alternative at its own (path) price
    for (const a of plan.target.alternatives ?? []) {
      expect(a.walkBy).toBe('path');
      expect(a.walkS!).toBeGreaterThanOrEqual(plan.target.walkS!);
    }
  });

  it('a hazard is never taken, however cheap its walk: lava round the goal, a probe that prices every walk at a tick', async () => {
    const w = sea([{ from: { x: -40, y: FEET, z: -40 }, to: { x: 40, y: FEET, z: 40 }, solid: true }], [{ from: { x: -9, z: -9 }, to: { x: 9, z: 9 } }]);
    const goal = { x: 0, y: FEET + 2, z: 0 };
    const probe = (from: { x: number; z: number }): Promise<ProbeOutcome> => Promise.resolve({ status: 'found', blocks: Math.hypot(from.x, from.z), ticks: 1 });
    const plan = await findLanding(goal, 'pillar', { look: w.look, obstacle: w.obstacle, probe }, { ...OPTS, from: { x: 300, z: 0 } });
    expect(plan.kind, plan.line).toBe('cell');
    if (plan.kind !== 'cell') return;
    const near = (x: number, z: number): boolean => Math.abs(x) <= 10 && Math.abs(z) <= 10;
    expect(near(plan.cell.x, plan.cell.z)).toBe(false);
    for (const a of plan.target.alternatives ?? []) expect(near(Math.floor(a.x), Math.floor(a.z))).toBe(false);
  });

  // the tunnel of the L1 test: a covered goal (the walk flood ranks its candidates)
  const tunnel = () => {
    const w = world([
      { from: { x: -10, y: FEET, z: -10 }, to: { x: 30, y: FEET + 3, z: 10 }, solid: true },
      { from: { x: -1, y: FEET, z: -1 }, to: { x: 30, y: FEET + 2, z: 1 }, solid: false },
    ]);
    return { look: w.look, obstacle: (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true };
  };

  it("the walk flood's first cells get the longer probe; the search's total time is kept", async () => {
    const w = tunnel();
    const goal = { x: 0, y: FEET, z: 0 };
    // a clock the probes move: each takes the ms it was given (the caller's own 400 when findLanding asks none)
    let clock = 0;
    const asked: (ProbeBudget | undefined)[] = [];
    const probe = (_from: unknown, budget?: ProbeBudget): Promise<ProbeOutcome> => {
      asked.push(budget);
      clock += budget?.ms ?? 400;
      return Promise.resolve({ status: 'limited' });
    };
    const budgetMs = 6000;
    const plan = await findLanding(goal, 'tunnel', { ...w, probe, now: () => clock }, { ...OPTS, budgetMs, from: { x: 300, z: 0 } });
    expect(plan.kind, plan.line).toBe('fallback');
    expect(asked.slice(0, LONG_PROBE.count).every((b) => b?.nodes === LONG_PROBE.nodes), plan.line).toBe(true);
    expect(asked.slice(LONG_PROBE.count).every((b) => b === undefined)).toBe(true);
    expect(plan.line).toMatch(/:limited long/);
    // the search stops once its time is spent: no probe starts after budgetMs, so the overrun is at most one probe of the caller's
    expect(clock).toBeLessThanOrEqual(budgetMs + 400);
    // a long probe is cut to the time left: with 2 s in all, the first one is given the 2 s, and nothing more is started
    clock = 0;
    asked.length = 0;
    const short = await findLanding(goal, 'tunnel', { ...w, probe, now: () => clock }, { ...OPTS, budgetMs: 2000, longProbe: { count: 3, nodes: 100_000, ms: 5000 }, from: { x: 300, z: 0 } });
    expect(short.kind).toBe('fallback');
    expect(asked[0]?.ms).toBe(2000);
    expect(asked.length).toBe(1);
    expect(clock).toBeLessThanOrEqual(2000);
  });

  it('an open goal (no walk flood) keeps the caller\'s probe; count 0 turns the long probes off', async () => {
    const w = islands();
    const goal = { x: 0, y: FEET + 2, z: 0 };
    const asked: (ProbeBudget | undefined)[] = [];
    const probe = (from: { x: number; y: number; z: number }, budget?: ProbeBudget): Promise<ProbeOutcome> => (asked.push(budget), islandProbe(100, 100)(from));
    await findLanding(goal, 'pillar', { look: w.look, obstacle: w.obstacle, probe }, { ...OPTS, from: { x: 0, z: -300 } });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((b) => b === undefined)).toBe(true);
    const t = tunnel();
    asked.length = 0;
    await findLanding({ x: 0, y: FEET, z: 0 }, 'tunnel', { ...t, probe: (_f, b) => (asked.push(b), Promise.resolve({ status: 'limited' })) }, { ...OPTS, longProbe: { count: 0, nodes: 0, ms: 0 }, from: { x: 300, z: 0 } });
    expect(asked.every((b) => b === undefined)).toBe(true);
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
