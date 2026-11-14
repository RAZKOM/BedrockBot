// Track F14 (docs/flight.md "The way down to the landing"): what the track costs, on made-up worlds, so that it can be
// timed on any machine (the test host under the live bot's CPU policy: `node scripts/mac-run.mjs --as-live -- node
// scripts/land-search-bench.ts`). Three numbers a side, `flyWayDown` off and on:
//
//   the search   landing.ts findLanding for a goal under a mountain (a cavern with 25 of room beside it, a tunnel 90 long
//                out to a terrace under the sky) and for a goal in a wood (a cell under a little roof in a clearing), with
//                a probe that answers at once: the search's own work (the column scan, the walk flood, the simulations);
//                with the setting on the look for a roof ends at the worlds' highest block, as the live model's ends at
//                a column's highest section (world/chunks.ts topY)
//   the rim      plan.ts landingRim over the columns within 14 blocks (the brain's look, once a landing)
//   the flight   a whole trip onto a clearing between trunks (the brain on stepBody): the wall clock a tick on average
//
//   node scripts/land-search-bench.ts [--n 20]
import { cellsAround, ColumnView, findLanding, walkTarget, type LandingOptions, type ProbeOutcome } from '../src/skills/fly/landing.ts';
import { landingRim } from '../src/skills/fly/plan.ts';
import type { BlockBox } from '../src/skills/input/index.ts';
import { FEET, trip, world } from '../test/unit/skills/fly-worlds.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const N = Number(arg('n', '20'));
const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 }, solid: true });
const hollow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 }, solid: false });
const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 10, probes: 16, budgetMs: 60_000, style: 'auto' };
const stat = (xs: number[]): string => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)]!.toFixed(1)} ms, ${s[0]!.toFixed(1)} to ${s[s.length - 1]!.toFixed(1)}`;
};

// the mountain of the unit tests (fly-way-down.test.ts)
const F = FEET + 5;
const mountain = world([solid(-40, FEET, -40, 90, FEET + 59, 40), hollow(-1, F, -1, 1, F + 2, 1), hollow(2, F, 0, 2, F + 1, 0), hollow(3, F, -4, 12, F + 24, 4), hollow(13, F, -1, 90, F + 1, 1), solid(91, FEET, -15, 120, F - 1, 15)]);
// a wood: trunks 14 high every 3 blocks from 5 to 16 out round a clearing, a cell under a little roof in it as the goal
const trunks: BlockBox[] = [];
for (let dx = -16; dx <= 16; dx += 3) for (let dz = -16; dz <= 16; dz += 3) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 5) trunks.push(solid(dx, FEET, 150 + dz, dx, FEET + 13, 150 + dz));
const wood = world([solid(-1, FEET, -1, 1, FEET + 69, 1), ...trunks, solid(2, FEET + 3, 152, 3, FEET + 3, 153)]);

const cases = [
  { name: 'a goal under a mountain', w: mountain, goal: { x: 0, y: F, z: 0 }, probe: (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve(from.y === F ? { status: 'found', blocks: Math.abs(from.x - 0.5) + Math.abs(from.z - 0.5) } : { status: 'limited' }) },
  { name: 'a goal in a wood', w: wood, goal: { x: 2, y: FEET, z: 152 }, probe: (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve({ status: 'found', blocks: Math.hypot(from.x - 2.5, from.z - 152.5) + 1 }) },
];
for (const c of cases) {
  const obstacle = (x: number, y: number, z: number): boolean => c.w.solid.solidAt(x, y, z) === true;
  for (const sky of [false, true]) {
    const ms: number[] = [];
    let line = '';
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const plan = await findLanding(c.goal, 'goal', { look: c.w.look, obstacle, probe: c.probe, ...(sky ? { skyTop: c.w.skyTop, maxY: () => FEET + 70 } : {}) }, { ...OPTS, from: { x: -300, z: 0 }, ...(sky ? { sky: true } : {}) });
      ms.push(performance.now() - t0);
      line = plan.line.replace(/, \d+ ms/, '').slice(0, 150);
    }
    console.log(`[land-search-bench] the search, ${c.name}, flyWayDown ${sky ? 'on ' : 'off'}: ${stat(ms)} (n ${N}); ${line} ...`);
  }
}

{
  const t = { x: 0.5, z: 150.5, top: FEET };
  const t0 = performance.now();
  let rim = 0;
  for (let i = 0; i < 200; i++) rim = landingRim(t, wood.skyTop).rim ?? 0;
  console.log(`[land-search-bench] the rim of a landing (the columns within 14 blocks, each top a scan down from y 200 here): ${((performance.now() - t0) / 200).toFixed(2)} ms a look (rim ${rim - FEET} over the floor)`);
}

{
  const view = new ColumnView(wood.look, FEET);
  const cell = { x: 0, z: 150, feet: FEET, kind: 'open' as const };
  const target = walkTarget(cell, cellsAround(view, cell, 'open', 3, 4), { walkS: 10, walkKnown: true });
  for (const wayDown of [false, true]) {
    const per: number[] = [];
    let said = '';
    for (let i = 0; i < Math.max(3, Math.round(N / 4)); i++) {
      const t0 = performance.now();
      const r = trip(wood, { x: 0.5, y: FEET + 70, z: 0.5 }, target, { seed: 5 + i, wayDown });
      per.push((performance.now() - t0) / r.ticks);
      said = `${r.end.ok ? 'landed' : r.end.reason} ${r.end.off.toFixed(1)} from the centre, ${r.ticks} ticks, ${r.goArounds} go-arounds, ${r.stats.landStyle ?? '-'}`;
    }
    console.log(`[land-search-bench] the flight onto a clearing in a wood, flyWayDown ${wayDown ? 'on ' : 'off'}: a tick took ${stat(per).replace(/ ms/g, ' ms')} on average over the flight (n ${per.length}); the last: ${said}`);
  }
}
