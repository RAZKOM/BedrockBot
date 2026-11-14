// Track F14 (docs/flight.md "The way down to the landing"): the open-ground landings of the kind that ended off their
// site on the Realm on 2026-11-14 (short flights, 118 to 175 blocks, that arrived 60 over a landing with a rise or
// something tall beside it), built on the flat ground and flown whole (the brain on stepBody, from standing on a pillar)
// with `flyWayDown` off and on. Made-up geometry (a hill 50 high across the way makes the cruise arrive high, as theirs
// did); one line a flight, one a case.
//
//   node scripts/land-rise-probe.ts [--cases wood,ridge,bank,tower] [--n 3] [--dist 118,155,175] [--quiet]
//
//   wood    a walk landing of 8 cells in a clearing; trunks every 3 blocks from 5 to 16 out all round it (14 high within
//           9 blocks, 10 beyond), and a
//           block 12 x 12 and 10 high 31 out on the way in (under the descent circle beside the approach line)
//   ridge   a walk landing of 6 cells on open ground; a ridge 9 high across the way in, 34 to 38 blocks before it
//   bank    a walk landing of 21 cells on open ground; a bank 9 high and 3 thick across the way in, 24 to 26 blocks
//           before it (nothing within 14 blocks of the landing: no rim from the start)
//   tower   the goal itself, 13 cells; a tower 3 x 3 and 26 high 8 blocks from its centre, beside the way in
// Each case from four sides (the start pillar north, east, south and west of the landing) at each `--dist`, `--n` seeds.
import { cellsAround, ColumnView, walkTarget } from '../src/skills/fly/landing.ts';
import type { LandingTarget } from '../src/skills/fly/plan.ts';
import type { BlockBox } from '../src/skills/input/index.ts';
import { FEET, trip, world } from '../test/unit/skills/fly-worlds.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: Math.min(x0, x1), y: y0, z: Math.min(z0, z1) }, to: { x: Math.max(x0, x1), y: y1, z: Math.max(z0, z1) }, solid: true });

/** A point `out` blocks from the landing on side `k` (0: north, 1: east, 2: south, 3: west), `lat` blocks to its left. */
const at = (k: number, out: number, lat = 0): { x: number; z: number } => {
  const d = [{ x: 0, z: -1 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }][k]!;
  return { x: Math.round(d.x * out - d.z * lat), z: Math.round(d.z * out + d.x * lat) };
};

interface Case {
  name: string;
  boxes: (side: number) => BlockBox[];
  cells: number;
  walkS: number;
}
const CASES: Case[] = [
  {
    name: 'wood',
    cells: 1.6,
    walkS: 1.8,
    boxes: (side) => {
      const out: BlockBox[] = [];
      // (the trunks within 9 blocks are 14 high: no descent circle fits round the landing itself)
      for (let dx = -16; dx <= 16; dx += 3) for (let dz = -16; dz <= 16; dz += 3) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 5) out.push(solid(dx, FEET, dz, dx, FEET + (Math.hypot(dx, dz) <= 9 ? 13 : 9), dz));
      const a = at(side, 31, -6);
      const b = at(side, 42, 6);
      out.push(solid(a.x, FEET, a.z, b.x, FEET + 9, b.z));
      return out;
    },
  },
  {
    name: 'ridge',
    cells: 1.5,
    walkS: 1,
    boxes: (side) => {
      const a = at(side, 34, -40);
      const b = at(side, 38, 40);
      return [solid(a.x, FEET, a.z, b.x, FEET + 8, b.z)];
    },
  },
  {
    name: 'bank',
    cells: 2.5,
    walkS: 5,
    boxes: (side) => {
      const a = at(side, 24, -40);
      const b = at(side, 26, 40);
      return [solid(a.x, FEET, a.z, b.x, FEET + 8, b.z)];
    },
  },
  {
    name: 'tower',
    cells: 2,
    walkS: 0,
    boxes: (side) => {
      const a = at(side, 7, 3);
      const b = at(side, 9, 5);
      return [solid(a.x, FEET, a.z, b.x, FEET + 25, b.z)];
    },
  },
];

const N = Number(arg('n', '3'));
const dists = arg('dist', '118,155,175').split(',').map(Number);
const want = new Set(arg('cases', 'wood,ridge,bank,tower').split(','));
const range = (xs: number[], d = 1): string => (xs.length ? `${Math.min(...xs).toFixed(d)} to ${Math.max(...xs).toFixed(d)} (mean ${(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(d)})` : '-');

for (const c of CASES.filter((k) => want.has(k.name))) {
  for (const wayDown of [false, true]) {
    const rows: { on: boolean; off: number; ticks: number; goArounds: number; rockets: number; hits: number; vy: number; priced: number; end: string; rims: number }[] = [];
    for (let side = 0; side < 4; side++) {
      for (const dist of dists) {
        for (let s = 0; s < N; s++) {
          const p = at(side, dist);
          // the start: a 3 x 3 pillar 60 high on that side; a hill 50 high across the way, 60 % of it out from the landing,
          // so that the cruise is flown over it and the flight arrives 60 over the landing (the Realm's flights cruised
          // 13 over the highest column on their way, 55 to 73 over their landing)
          const h0 = at(side, Math.round(dist * 0.6) - 8, -30);
          const h1 = at(side, Math.round(dist * 0.6) + 8, 30);
          const w = world([solid(p.x - 1, FEET, p.z - 1, p.x + 1, FEET + 59, p.z + 1), solid(h0.x, FEET, h0.z, h1.x, FEET + 49, h1.z), ...c.boxes(side)]);
          const view = new ColumnView(w.look, FEET);
          const cell = { x: 0, z: 0, feet: FEET, kind: 'open' as const };
          const target: LandingTarget = walkTarget(cell, cellsAround(view, cell, 'open', c.cells, 4), { walkS: c.walkS, walkKnown: true });
          const seed = 5 + s + 10 * side + dist;
          let r: ReturnType<typeof trip> | undefined;
          let err = '';
          try {
            r = trip(w, { x: p.x + 0.5, y: FEET + 60, z: p.z + 0.5 }, target, { seed, wayDown });
          } catch (e) {
            err = e instanceof Error ? e.message.slice(0, 120) : String(e);
          }
          if (!r) {
            rows.push({ on: false, off: NaN, ticks: 0, goArounds: 0, rockets: 0, hits: 0, vy: 0, priced: 0, end: `no end (${err})`, rims: 0 });
            continue;
          }
          const on = r.end.ok || (r.end.onTarget && Math.abs(r.end.landedAt.y - FEET) < 0.6);
          rows.push({ on, off: r.end.off, ticks: r.ticks, goArounds: r.goArounds, rockets: r.rockets, hits: r.hits, vy: r.lastAir.vy, priced: r.stats.landingPrices.length, end: r.end.ok ? 'landed' : r.end.reason, rims: r.stats.rims ?? 0 });
          if (!has('quiet')) console.log(`${c.name} ${wayDown ? 'on ' : 'off'} side ${side} dist ${dist} seed ${seed}: ${r.end.ok ? 'landed' : r.end.reason} ${on ? 'ON THE SITE' : 'off the site'} ${r.end.off.toFixed(1)} from its centre, ${(r.end.landedAt.y - FEET).toFixed(1)} over its floor; ${r.ticks} ticks, ${r.rockets} rockets, ${r.goArounds} go-arounds, ${r.stats.landingPrices.length} priced, ${r.hits} hits, touchdown vy ${r.lastAir.vy.toFixed(2)}, ${r.stats.landStyle ?? '-'}; ${r.descents.join('; ')}${r.notes.filter((n) => /^(way down|land now|landing price)/.test(n)).map((n) => `\n      ${n}`).join('')}`);
        }
      }
    }
    const onRows = rows.filter((r) => r.on);
    console.log(`[land-rise-probe] ${c.name}, flyWayDown ${wayDown ? 'on' : 'off'}: n ${rows.length}; on the site ${onRows.length}; off it ${rows.length - onRows.length} (${range(rows.filter((r) => !r.on && Number.isFinite(r.off)).map((r) => r.off))} from the centre); ends ${[...new Set(rows.map((r) => r.end))].map((e) => `${e} ${rows.filter((r) => r.end === e).length}`).join(', ')}; go-arounds ${rows.reduce((s, r) => s + r.goArounds, 0)}, priced misses ${rows.reduce((s, r) => s + r.priced, 0)}, rims given ${rows.reduce((s, r) => s + r.rims, 0)}; hits ${rows.reduce((s, r) => s + r.hits, 0)}; touchdown vy ${range(rows.map((r) => r.vy), 2)}; ticks ${range(rows.map((r) => r.ticks), 0)}; rockets ${range(rows.map((r) => r.rockets))}`);
  }
}
