// Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"): what a drawn line's decision costs
// on this host, on a synthetic cave (nothing of anybody's world): a mountain with halls joined by a winding tunnel with
// ramps, the last hall open to the sky by a mouth. From the first hall: the drawn way out (the flood, the lines, the roll
// and the proof of the first line that rolls) and the hop to the last hall (the flood, the lines, the proof), each timed.
// The private fixture cannot go to the test host; this says how that host compares with the one the fixture was timed on.
//
//   node scripts/drawn-bench.ts [--halls 6] [--runs 3]
import { routeHop, routeTakeoff, routeTakeoffOptions, type SimDeps } from '../src/skills/fly/glide.ts';
import { drawWays, rollDraft } from '../src/skills/fly/learn/draw.ts';
import { ENTRY_AIR, ENTRY_SOLID, entryTouchdowns } from '../src/skills/fly/learn/entry.ts';
import { FOLLOW_MARGIN } from '../src/skills/fly/learn/follow.ts';
import { guideLength } from '../src/skills/fly/learn/guide.ts';
import { drawHops } from '../src/skills/fly/learn/hop.ts';
import { cruiseHeight, type CellQuery, type LandingTarget } from '../src/skills/fly/plan.ts';
import { gridOf } from '../src/skills/fly/route/grid.ts';
import { drawnRoute } from '../src/skills/fly/route/takeoff.ts';
import { flatWorld, withBoxes, type BlockBox } from '../src/skills/input/index.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const FEET = -60;
const n = Number(arg('halls', '6'));
const air = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BlockBox => ({ from: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, to: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, solid: false });
// halls 13 x 13 x 10 every 90 blocks along x, each 6 higher or lower than the one before in turn and 30 to one side in
// turn, joined by tunnels 11 wide and 9 high that ramp and bend; the last hall has a mouth to the east
const boxes: BlockBox[] = [{ from: { x: -40, y: FEET, z: -80 }, to: { x: 90 * n + 20, y: FEET + 89, z: 80 }, solid: true }];
const at: { x: number; y: number; z: number }[] = [];
for (let k = 0; k < n; k++) at.push({ x: 90 * k, y: FEET + 10 + (k % 2 === 0 ? 0 : 6), z: k % 2 === 0 ? 0 : 30 });
for (let k = 0; k < n; k++) {
  const a = at[k]!;
  boxes.push(air(a.x - 6, a.y, a.z - 6, a.x + 6, a.y + 9, a.z + 6));
  const b = at[k + 1];
  if (!b) {
    boxes.push(air(a.x + 7, a.y, a.z - 5, 90 * n + 20, a.y + 9, a.z + 5));
    break;
  }
  for (let j = 7; j <= 83; j++) {
    const f = (j - 7) / 76;
    const y = Math.round(a.y + (b.y - a.y) * f);
    const z = Math.round(a.z + (b.z - a.z) * f);
    boxes.push(air(a.x + j, y, z - 5, a.x + j, y + 8, z + 5));
  }
}
const world = withBoxes(flatWorld(), boxes);
const cell: CellQuery = (x, y, z) => world.solidAt(x, y, z);
const skyTop = (x: number, z: number): number => {
  for (let y = 200; y >= -64; y--) if (world.solidAt(x, y, z)) return y;
  return -64;
};
const groundAt = (x: number, z: number, fromY = 200): number => {
  for (let y = Math.floor(fromY); y >= -64; y--) if (world.solidAt(x, y, z)) return y + 1;
  return -63;
};
const deps: SimDeps & { cell: CellQuery } = { world, cell, skyTop, groundAt };
const grid = gridOf(world);
const noPlan = (): never => {
  throw new Error('a drawn line asks no planner');
};
const from = { x: at[0]!.x + 0.5, y: at[0]!.y, z: at[0]!.z + 0.5 };
const far: LandingTarget = { x: 90 * n + 600.5, z: 0.5, top: FEET, half: 1 };
const cz = cruiseHeight(from, far, skyTop, {}).y;

for (let run = 0; run < Number(arg('runs', '3')); run++) {
  // the way out
  let t = performance.now();
  const w = drawWays(grid, from, Math.ceil(cz), { radius: 90 * n + 60 });
  const drawMs = performance.now() - t;
  t = performance.now();
  const line = w.drafts.map((d) => rollDraft(w.grid, d, Math.ceil(cz))).find((x) => typeof x !== 'string');
  const rollMs = performance.now() - t;
  let out = `the way out: a flood of ${w.cells} cells and ${w.drafts.length} lines in ${drawMs.toFixed(0)} ms, rolled in ${rollMs.toFixed(0)} ms`;
  if (line && typeof line !== 'string') {
    const route = drawnRoute(line, from, 0);
    t = performance.now();
    const p = await routeTakeoff(deps, from, far, { cruiseY: cz }, 64, { route: { grid, plan: noPlan }, takeoff: routeTakeoffOptions(route, true) }, { planTicks: route.ticks });
    out += `; ${guideLength(line.guide).toFixed(0)} blocks of line, ${p.sims} simulated in ${(performance.now() - t).toFixed(0)} ms (${p.ok ? 'proven' : `refused: ${p.line.slice(0, 80)}`})`;
  } else out += '; no line rolls';
  console.log(out);
  // the hop to the last hall
  const goal = at[n - 1]!;
  const cls = (x: number, y: number, z: number): number => (world.solidAt(x, y, z) ? ENTRY_SOLID : ENTRY_AIR);
  t = performance.now();
  const d = drawHops(grid, from, goal, entryTouchdowns(cls, goal), FEET + 150, { radius: 90 * n + 60, max: 400_000 });
  const hopMs = performance.now() - t;
  const h = d.hops[0];
  let said = `the hop: ${d.cells} cells looked at and ${d.hops.length} lines in ${hopMs.toFixed(0)} ms`;
  if (h) {
    const target: LandingTarget = { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2, entry: { line: h.line, goal: { x: goal.x + 0.5, z: goal.z + 0.5, top: goal.y, half: 2 } } };
    t = performance.now();
    const p = await routeHop(deps, from, target, { cruiseY: from.y + 24 }, 64, { route: { grid, plan: noPlan }, takeoff: routeTakeoffOptions({ goals: [], margin: FOLLOW_MARGIN, weight: 2, guide: { line: h.guide, open: Infinity, off: 0 }, hop: { hand: h.hand } }, false) }, { planTicks: h.guide.ticks[h.guide.ticks.length - 1] ?? 0, yaw: h.guide.yaw });
    said += `; ${guideLength(h.guide).toFixed(0)} blocks of line, ${p.sims} simulated in ${(performance.now() - t).toFixed(0)} ms (${p.ok ? 'proven' : `refused: ${p.line.slice(0, 80)}`})`;
  } else said += `; no line (${d.why ?? d.tried.join(' | ').slice(0, 120)})`;
  console.log(said);
}
