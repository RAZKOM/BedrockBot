// Track F15 (docs/flight.md "Takeoff from a floor the walk reaches (Track F15)"): what the floor search costs. The made-up
// building of the unit tests (test/unit/skills/floor-building.ts) in its four cases, and two worlds made to cost: a stair
// up a sheer-sided hill (many floors with an edge the walk reaches, every takeoff refused) and generated hills (the scan
// alone), each search run `--repeat` times with the
// real probe (the planner on the main thread in slices, the live budgets: floors.ts FLOOR_*) and the real takeoff
// simulations. One line per case: the search's wall-clock ms (min / median / max), the scan's, the probes' and the takeoffs'
// share, and what it found.
//
//   node scripts/floor-search-bench.ts [--repeat 10] [--out results.jsonl]
import { appendFileSync } from 'node:fs';
import { searchFloors } from '../src/skills/fly/floors.ts';
import { building, F, floorDeps, START } from '../test/unit/skills/floor-building.ts';
import { flatGen, hillyGen } from '../test/unit/skills/genworld.ts';
import type { GenWorld } from '../test/unit/skills/genworld.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const repeat = Number(arg('repeat', '10'));
const out = arg('out', '');

interface Case {
  name: string;
  gen: () => GenWorld;
  from: { x: number; y: number; z: number };
  wide: boolean;
  refuse?: boolean;
}

const cases: Case[] = [
  { name: 'roof', gen: () => building(), from: START, wide: true },
  { name: 'sky', gen: () => building({ wide: false }), from: START, wide: false },
  { name: 'closed', gen: () => building({ ladder: false }), from: START, wide: true },
  { name: 'low', gen: () => building({ r: F + 7 }), from: { x: -0.5, y: F + 7, z: -0.5 }, wide: true },
  // a stair of 30 steps up a hill with a sheer side: every step from the 12th on is a floor with an edge the walk reaches,
  // each takeoff refused: the search's bounds (FLOOR_PROBES probes, FLOOR_SIMS takeoffs)
  {
    name: 'stair-refused',
    gen: () => {
      const g = flatGen({ x: -64, y: -64, z: -64 }, { x: 128, y: 100, z: 128 });
      for (let k = 1; k <= 30; k++) g.fill({ x: -30 + 2 * k, y: F, z: -4 }, { x: -29 + 2 * k, y: F + k - 1, z: 4 }, 'stone');
      return g;
    },
    from: { x: -20.5, y: F, z: 8.5 },
    wide: true,
    refuse: true,
  },
  // generated hills (no 12-block edge within reach: the scan alone, what most searches on open ground cost)
  { name: 'hills-refused', gen: () => hillyGen(7), from: { x: 0.5, y: 0, z: 0.5 }, wide: true, refuse: true },
];

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;

for (const c of cases) {
  const ms: number[] = [];
  let last = '';
  let from = c.from;
  for (let i = 0; i < repeat; i++) {
    const gen = c.gen();
    if (c.name === 'hills-refused') {
      // stand on the ground at the centre
      for (let y = gen.maxY; y > gen.minY; y--) {
        if (gen.blockAt(0, y - 1, 0)?.solid && !gen.blockAt(0, y, 0)?.solid && !gen.blockAt(0, y + 1, 0)?.solid) {
          from = { x: 0.5, y, z: 0.5 };
          break;
        }
      }
    }
    const d = floorDeps(gen, { wide: c.wide });
    if (c.refuse) d.takeoff = () => Promise.resolve({ ok: false, why: 'refused by the bench' });
    const t0 = performance.now();
    const r = await searchFloors(d, from);
    const total = performance.now() - t0;
    ms.push(total);
    last = r.line;
    const rec = { case: c.name, run: i, ms: total, probes: r.probes, reached: r.reached, sims: r.sims, floors: r.floors, closed: r.closed, site: r.site ? `${r.site.x} ${r.site.feet} ${r.site.z}` : null, probeMs: d.stats.probeMs, takeoffMs: d.stats.takeoffMs, line: r.line };
    if (out) appendFileSync(out, `${JSON.stringify(rec)}\n`);
  }
  console.log(`${c.name}: ${ms.length} runs, ${pct(ms, 0).toFixed(0)} / ${pct(ms, 0.5).toFixed(0)} / ${pct(ms, 0.999).toFixed(0)} ms (min / median / max); ${last}`);
}
