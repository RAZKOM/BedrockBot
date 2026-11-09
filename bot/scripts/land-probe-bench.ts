// Track L2 (docs/flight.md "Landing by time", "L2"): the landing search's probes on the owner's cave (Track F5a's private
// fixture, bot/fixtures-private/cave or CAVE_FIXTURE_DIR), from the command line. Prints shapes, counts, ticks and times
// only, never a coordinate of the fixture (a cell is named by its offset from the goal).
//
//   1. the order:  the candidates findLanding probes, in its order (a probe that answers `limited` at once), with their flood steps
//   2. the need:   each of the first --cells of them probed with a large budget (--max nodes:ms), surface preference on and off:
//                  found or not, the nodes expanded and the search ms it took (what budget would have confirmed it)
//   3. the search: findLanding with the real probe for every --budgets entry (the long probe's nodes:ms, its count --long),
//                  as the live bot runs it (6 s in all, the caller's probe 6 000 nodes / 400 ms): the answer, its price,
//                  the probes and the wall time
//   4. the pace:   the navigator in a closed loop (test/unit/skills/fly-cave-walk.ts caveWalker) from up to --walks cells
//                  the probes confirmed to the goal: its ticks against the probe's planned ticks (landprice.ts PATH_PACE)
//
//   node scripts/land-probe-bench.ts [--to cave_start] [--from home] [--cells 8] [--max 400000:20000]
//        [--budgets 6000:400,20000:800,60000:1500,150000:3000] [--long 3] [--walks 6] [--surface on|off|both]
import type { Logger } from '../src/log.ts';
import type { Vec3 } from '../src/world/types.ts';
import { BotSkills } from '../src/skills/index.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { findLanding, type BlockLookup, type LandingOptions, type ProbeBudget, type ProbeOutcome } from '../src/skills/fly/landing.ts';
import { landingProbe } from '../src/skills/fly/landprobe.ts';
import { PATH_PACE, TICKS_PER_S, WALK_S_PER_BLOCK } from '../src/skills/fly/landprice.ts';
import { LAND_BUDGET_MS, LAND_PROBE_MS, LAND_PROBE_NODES } from '../src/chat/commands-fly.ts';
import { harness } from '../test/unit/skills/fakes.ts';
import { caveSkillsWorld, caveWalker } from '../test/unit/skills/fly-cave-walk.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const budgetOf = (s: string): ProbeBudget => {
  const [n, m] = s.split(':').map(Number);
  return { nodes: n!, ms: m! };
};

const fix = loadCaveFixture();
if (!fix) {
  console.log('no cave fixture (bot/fixtures-private/cave): nothing to measure');
  process.exit(0);
}
const world = caveWorld(fix.extract);
const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return world.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};
const goal = cellOf(arg('to', 'cave_start'));
const from = cellOf(arg('from', 'home'));
const rel = (p: { x: number; y?: number; feet?: number; z: number }): string => `dx ${Math.round(p.x - goal.x)} dy ${Math.round((p.y ?? p.feet ?? goal.y) - goal.y)} dz ${Math.round(p.z - goal.z)}`;
const parts = new Set(arg('parts', '1,2,3,4').split(','));
const surfaces = arg('surface', 'both') === 'both' ? [true, false] : [arg('surface', 'on') === 'on'];

// the navigator over the cave (BotSkills on the fake connection, as the closed-loop walker builds it)
const { loop } = harness({ x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 });
const skills = new BotSkills({ loop, world: caveSkillsWorld(world) });
const nav = skills.nav;
const look: BlockLookup = (x, y, z) => world.terrain.blockAt(x, y, z);
const obstacle = (x: number, y: number, z: number): boolean => world.solid(x, y, z) === true;
// (the fixture's box is smaller than the search window: the search answers from the loaded part, as the hold's look does)
const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 10, probes: 16, budgetMs: LAND_BUDGET_MS, style: 'auto', partial: true, from: { x: from.x + 0.5, z: from.z + 0.5 } };
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

// 1. the order
const order: Vec3[] = [];
await findLanding(goal, 'goal', { look, obstacle, yieldNow, probe: (f: Vec3): Promise<ProbeOutcome> => (order.push(f), Promise.resolve({ status: 'limited' })) }, { ...OPTS, budgetMs: 600_000, longProbe: { count: 0, nodes: 0, ms: 0 } });
console.log(`goal: the feet cell of ${arg('to', 'cave_start')}; flight from ${arg('from', 'home')} (${rel(from)})`);
console.log(`1. the order: ${order.length} probes: ${order.map((c, i) => `#${i + 1} ${rel(c)}`).join(', ')}`);

// 2. the need
const cells = order.slice(0, Number(arg('cells', '8')));
const max = budgetOf(arg('max', '400000:20000'));
const confirmed: { cell: Vec3; ticks: number; blocks: number }[] = [];
for (const surface of parts.has('2') ? surfaces : []) {
  console.log(`2. the need (surface preference ${surface ? 'on' : 'off'}, at most ${max.nodes} nodes / ${max.ms} ms):`);
  for (const [i, c] of cells.entries()) {
    let line = '';
    const probe = landingProbe(nav, goal, {
      budget: max,
      surface,
      onProbe: (s) => {
        const o = s.outcome;
        line = `  #${i + 1} ${rel(c)}: ${o.status}${o.status === 'found' ? ` ${o.blocks.toFixed(0)} blocks, ${o.ticks!.toFixed(0)} ticks (${((o.ticks! / TICKS_PER_S) * PATH_PACE).toFixed(1)} s; ${(o.blocks * WALK_S_PER_BLOCK).toFixed(1)} s at the old pace), path cost ${s.cost.toFixed(0)}` : ''}; ${s.expanded} nodes, ${s.ms.toFixed(0)} ms search, ${s.wallMs.toFixed(0)} ms wall`;
      },
    });
    const o = await probe(c);
    console.log(line);
    if (o.status === 'found' && surface === surfaces[0]) confirmed.push({ cell: c, ticks: o.ticks!, blocks: o.blocks });
  }
}

// 3. the search
const budgets = arg('budgets', '6000:400,20000:800,60000:1500,150000:3000').split(',').map(budgetOf);
const count = Number(arg('long', '3'));
for (const surface of parts.has('3') ? surfaces : []) {
  for (const [k, b] of [[0, { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS }] as const, ...budgets.map((x) => [count, x] as const)]) {
    const probes: string[] = [];
    let searchMs = 0;
    const probe = landingProbe(nav, goal, {
      budget: { nodes: LAND_PROBE_NODES, ms: LAND_PROBE_MS },
      surface,
      onProbe: (s) => {
        searchMs += s.ms;
        probes.push(`${s.budget.nodes === LAND_PROBE_NODES ? '' : 'L '}${s.outcome.status}${s.outcome.status === 'found' ? ` ${s.outcome.ticks!.toFixed(0)}t` : ''} ${s.expanded}n ${s.ms.toFixed(0)}/${s.wallMs.toFixed(0)}ms`);
      },
    });
    const t0 = performance.now();
    const plan = await findLanding(goal, 'goal', { look, obstacle, yieldNow, probe }, { ...OPTS, longProbe: { count: k, ...b } });
    const wall = performance.now() - t0;
    const what = plan.kind === 'cell' || plan.kind === 'fallback' || plan.kind === 'goal' ? `${plan.kind} at ${rel(plan.cell)}, ${Math.round(plan.walk)} blocks, ${plan.target.walkS?.toFixed(1)} s (${plan.target.walkBy ?? '-'}), ${plan.target.alternatives?.length ?? 0} alternatives` : plan.kind;
    console.log(`3. the search, surface ${surface ? 'on' : 'off'}, ${k ? `${k} long probes of ${b.nodes} nodes / ${b.ms} ms` : 'no long probe'}: ${what}; ${probes.length} probes, ${searchMs.toFixed(0)} ms in probes, ${wall.toFixed(0)} ms wall: ${probes.join(', ')}`);
  }
}

// 4. the pace
const walks = Number(arg('walks', '6'));
// the walker's navigation lines (the last few of a failed walk say why)
const navLines: string[] = [];
const keep = (level: string) => (msg: string) => {
  navLines.push(`${level} ${msg.replace(/\{[^}]*\}/g, '{goal}').replace(/-?\d+(\.\d+)? -?\d+(\.\d+)? -?\d+(\.\d+)?/g, '<cell>')}`);
  if (navLines.length > 400) navLines.shift();
};
const logger: Logger = { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
const walker = caveWalker(world, { logger });
const ratios: number[] = [];
// (also the walks the landing does not choose but that calibrate the pace: other waypoints of the cave to the goal)
const extra = arg('walk-from', 'cave_2').split(',').filter((n) => fix.waypoints.has(n));
const walkList: { cell: Vec3; ticks: number; blocks: number; name?: string }[] = [...confirmed.slice(0, walks)];
if (!parts.has('2')) {
  for (const c of cells.slice(0, walks)) {
    const o = await landingProbe(nav, goal, { budget: max, surface: false })(c);
    if (o.status === 'found') walkList.push({ cell: c, ticks: o.ticks!, blocks: o.blocks });
  }
}
for (const n of extra) {
  const cell = cellOf(n);
  const o = await landingProbe(nav, goal, { budget: max, surface: false })(cell);
  if (o.status === 'found') walkList.push({ cell, ticks: o.ticks!, blocks: o.blocks, name: n });
  else console.log(`4. the pace: ${n}: the probe answered ${o.status}`);
}
for (const c of parts.has('4') ? walkList : []) {
  navLines.length = 0;
  const r = await walker({ x: c.cell.x + 0.5, y: c.cell.y, z: c.cell.z + 0.5 }, goal);
  const ratio = r.ticks / Math.max(1, c.ticks);
  if (r.ok) ratios.push(ratio);
  console.log(`4. the pace: ${c.name ?? rel(c.cell)}: ${r.ok ? 'walked' : `failed (${r.reason}) at ${rel(r.at)}`} in ${r.ticks} ticks (${r.waterTicks} in water) against ${c.ticks.toFixed(0)} planned (x ${ratio.toFixed(2)}), ${c.blocks.toFixed(0)} blocks (${(r.ticks / 20 / Math.max(1, c.blocks)).toFixed(2)} s a block)`);
  if (!r.ok) for (const l of navLines.slice(-8)) console.log(`     ${l.slice(0, 300)}`);
}
ratios.sort((a, b) => a - b);
if (ratios.length) console.log(`4. the pace: real / planned ticks over ${ratios.length} walks: median ${ratios[Math.floor(ratios.length / 2)]!.toFixed(2)}, ${ratios[0]!.toFixed(2)} to ${ratios[ratios.length - 1]!.toFixed(2)} (PATH_PACE ${PATH_PACE})`);
loop.stop?.();
process.exit(0);
