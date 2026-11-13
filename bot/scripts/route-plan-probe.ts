// Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"): what the kit's burn costs the
// route search. The first plan of each standard course (route/courses.ts: bores, curves, corners, the S-bend, the
// staircase) from its own start, at the live budget, once with the plain rocket's range and once with a kit's in the
// start state (`RouteState.kit`: 19 to 31 for flight duration 1). A longer burn has longer branches to sweep, so a search
// expands fewer nodes a second; this prints how many, and whether the plan is still complete and robust inside the budget.
// One line a course and a range. Timings are the machine's: measure them on the test host (`mac-run.mjs --as-live`).
//
//   node scripts/route-plan-probe.ts [--told 1] [--ms 800] [--nodes 40000] [--only tunnel,stair] [--rockets 16]
import { burnRange } from '../src/skills/fly/burn.ts';
import { standardCourses } from '../src/skills/fly/route/courses.ts';
import { gridOf } from '../src/skills/fly/route/grid.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import { NO_BOOST, type RouteState } from '../src/skills/fly/route/types.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const told = has('told') ? burnRange(Number(arg('told', '1'))) : undefined;
const maxMs = Number(arg('ms', '800'));
const maxNodes = Number(arg('nodes', '40000'));
const only = has('only') ? arg('only', '').split(',') : undefined;

let complete = 0;
let n = 0;
for (const c of standardCourses()) {
  if (only && !only.some((o) => c.name.includes(o))) continue;
  const grid = gridOf(c.world);
  const yaw = (c.start.yaw * Math.PI) / 180;
  const standing = c.start.standing === true;
  const start: RouteState = {
    pos: { ...c.start.pos },
    vel: standing ? { x: 0, y: 0, z: 0 } : { x: -Math.sin(yaw) * c.start.speed, y: 0, z: Math.cos(yaw) * c.start.speed },
    yaw: c.start.yaw,
    boost: { ...NO_BOOST },
    gliding: !standing,
    rockets: Number(arg('rockets', String(c.start.rockets))),
    ...(told ? { kit: told } : {}),
    wp: 0,
  };
  const p = planRoute({ start, goals: c.goals, margin: c.margin, maxNodes, maxMs, ...(c.library !== undefined ? { library: c.library } : {}), ...(c.weight !== undefined ? { weight: c.weight } : {}) }, grid);
  n++;
  if (p.complete) complete++;
  console.log(`${c.name.padEnd(16)} told ${told ? `${told.min} to ${told.max}` : '9 to 21  '}: ${p.complete ? 'complete' : `partial ${p.reached}/${c.goals.length}`}${p.robust ? '' : ' (not robust)'}, ${p.ticks} ticks, ${p.rockets} rockets, ${p.expanded} expanded of ${p.nodes} nodes in ${p.ms.toFixed(0)} ms (${(p.expanded / Math.max(1, p.ms) * 1000).toFixed(0)} a second), budget ${p.budget}`);
}
console.log(`${n} courses, ${complete} complete within ${maxMs} ms and ${maxNodes} nodes, told ${told ? `${told.min} to ${told.max}` : 'nothing (9 to 21)'}`);
