// Track F9d (docs/flight.md "Drawn lines (Track F9d)", "The route landing that arrived too high"): the e2e gate
// fly-route-land's flights offline, every tick of them, so that two trees can be compared without a server's noise:
// the brain on stepBody over the gate's synthetic cells (the stacked platforms with 2 of air, the 1 x 1 hole 2 deep),
// 150 blocks out, at every pair of burns for the first two rockets (9 to 21 ticks each: the climb's rocket and the
// cruise's top-up), from fuzzed starts and first looks. One line a flight: the burns, a hash of every tick's position,
// the hand-over's line, how it ended. The hash is the comparison: the same code flies the same ticks.
//
//   node scripts/route-land-probe.ts [--case stack2|stack3|hole1|hole2|shaft1|room3|pocket|room|cliff] [--dist 150] [--burns 9,15,21] [--pairs] [--starts 0:0:0,0.3:0.3:20] [--lag 2]
//        [--trace <burn>/<burn>] [--quiet] [--stop handover] [--nodes 40000] [--ticks 1500] [--seed 5,6] [--live] [--lag 2] [--notes]
//        [--told 1]
//
// Track F10: `--told 1` (or 2, 3): the brain, the landing's plan and its tracker are told the rockets burn as those of that
// flight duration do (19 to 31 for 1: `flyKitBurn` on with crafted rockets); the burns flown are still `--burns`. Without
// it nothing is told, as before (the flights of this probe are the same tick for tick as they were).
//
// A burn written `a/b` is a first rocket of a ticks and b for the later ones. `--live`: the brain's options as the bot's
// flight has them (the terrain columns, the clearance and the margin of the settings' defaults, the brain's own seed)
// instead of the unit tests' (seed 5, no terrain). `--lag a,b`: each burn's end seen that many ticks late, a flight each.
// `--pairs`: every first burn with every later burn (169 flights a start); without it every rocket burns the same.
// `--starts` are dx:dz:yaw from the start cell's centre (blocks, the body's first look). The route planner runs in
// this thread on a node budget alone (no wall clock; `--nodes`), so a flight is the same every time it is flown.
// `--stop handover` ends each flight on the tick the route tracker takes the body (the cruise's part, no search at all).
// `--dist`: how far out the cells are (150: the gate's; 300: the unit test's whole trips, test/unit/skills/fly-route-landing.test.ts,
// whose cells are `stack2`, `stack3` (40 to the side here), `room` and `cliff`). The last line counts the hand-overs inside the
// band the planner lands from at once (ROUTE_HAND_BAND: the height over the cell and the speed) and gives their range.
import { createHash } from 'node:crypto';
import { burnRange } from '../src/skills/fly/burn.ts';
import { simulateFlight } from '../src/skills/fly/glide.ts';
import { findLanding, type LandingOptions } from '../src/skills/fly/landing.ts';
import { ROUTE_HAND_BAND } from '../src/skills/fly/brain.ts';
import { cruiseHeight, type LandingTarget } from '../src/skills/fly/plan.ts';
import { gridOf } from '../src/skills/fly/route/grid.ts';
import { planRoute } from '../src/skills/fly/route/search.ts';
import type { BlockBox } from '../src/skills/input/index.ts';
import { FEET, world } from '../test/unit/skills/fly-worlds.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const T = Number(arg('dist', '150'));
const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 12, probes: 16, budgetMs: 60_000, exact: 1, style: 'auto' };
const CASES: Record<string, { boxes: BlockBox[]; goal: { x: number; y: number; z: number } }> = {
  // the gate's cells (test/e2e/fly-route-land.test.ts): a 3 x 3 platform 20 up and another 2 of air over it; a 1 x 1 hole 2 deep
  stack2: {
    boxes: [
      { from: { x: -1, y: FEET + 20, z: T - 1 }, to: { x: 1, y: FEET + 20, z: T + 1 }, solid: true },
      { from: { x: -1, y: FEET + 23, z: T - 1 }, to: { x: 1, y: FEET + 23, z: T + 1 }, solid: true },
    ],
    goal: { x: 0, y: FEET + 21, z: T },
  },
  hole1: { boxes: [{ from: { x: -90, y: FEET - 2, z: T }, to: { x: -90, y: FEET - 1, z: T }, solid: false }], goal: { x: -90, y: FEET - 2, z: T } },
  // (the gate's other cells, to hold a change against the flights it should not touch)
  stack3: {
    boxes: [
      { from: { x: 39, y: FEET + 20, z: T - 1 }, to: { x: 41, y: FEET + 20, z: T + 1 }, solid: true },
      { from: { x: 39, y: FEET + 24, z: T - 1 }, to: { x: 41, y: FEET + 24, z: T + 1 }, solid: true },
    ],
    goal: { x: 40, y: FEET + 21, z: T },
  },
  hole2: { boxes: [{ from: { x: -120, y: FEET - 2, z: T }, to: { x: -119, y: FEET - 1, z: T }, solid: false }], goal: { x: -120, y: FEET - 2, z: T } },
  shaft1: {
    boxes: [
      { from: { x: 137, y: FEET, z: T - 3 }, to: { x: 143, y: FEET + 9, z: T + 3 }, solid: true },
      { from: { x: 140, y: FEET, z: T }, to: { x: 140, y: FEET + 9, z: T }, solid: false },
    ],
    goal: { x: 140, y: FEET, z: T },
  },
  room3: {
    boxes: [
      { from: { x: 197, y: FEET, z: T - 3 }, to: { x: 203, y: FEET + 3, z: T + 3 }, solid: true },
      { from: { x: 198, y: FEET, z: T - 3 }, to: { x: 202, y: FEET + 2, z: T + 2 }, solid: false },
    ],
    goal: { x: 200, y: FEET, z: T },
  },
  pocket: {
    boxes: [
      { from: { x: -220, y: FEET, z: 180 }, to: { x: -180, y: FEET + 29, z: 192 }, solid: true },
      { from: { x: -201, y: FEET + 10, z: 180 }, to: { x: -199, y: FEET + 12, z: 182 }, solid: false },
    ],
    goal: { x: -200, y: FEET + 10, z: 181 },
  },
  // the unit test's other cells, straight ahead of the start: a cell under a roof 3 above at ground level (walls on three sides), a pocket in a cliff face
  room: {
    boxes: [
      { from: { x: -3, y: FEET + 3, z: T - 3 }, to: { x: 3, y: FEET + 3, z: T + 3 }, solid: true },
      { from: { x: -3, y: FEET, z: T - 3 }, to: { x: -3, y: FEET + 2, z: T + 3 }, solid: true },
      { from: { x: 3, y: FEET, z: T - 3 }, to: { x: 3, y: FEET + 2, z: T + 3 }, solid: true },
      { from: { x: -3, y: FEET, z: T + 3 }, to: { x: 3, y: FEET + 2, z: T + 3 }, solid: true },
    ],
    goal: { x: 0, y: FEET, z: T },
  },
  cliff: {
    boxes: [
      { from: { x: -40, y: FEET, z: T + 1 }, to: { x: 40, y: FEET + 29, z: T + 40 }, solid: true },
      { from: { x: -1, y: FEET + 10, z: T + 1 }, to: { x: 1, y: FEET + 12, z: T + 3 }, solid: false },
    ],
    goal: { x: 0, y: FEET + 10, z: T + 2 },
  },
};

const name = arg('case', 'stack2');
const c = CASES[name];
if (!c) throw new Error(`no case ${name}`);
const burnList = arg('burns', '9,10,11,12,13,14,15,16,17,18,19,20,21').split(',');
const burns = burnList.filter((x) => !x.includes('/')).map(Number);
const starts = arg('starts', '0:0:0').split(',').map((s) => s.split(':').map(Number) as [number, number, number]);
const lags = arg('lag', '2').split(',').map(Number);
const live = has('live');
const seeds: (number | undefined)[] = has('seed') ? arg('seed', '5').split(',').map(Number) : [live ? undefined : 5];
const traceOf = has('trace') ? arg('trace', '') : undefined;
const stopAtHandover = arg('stop', '') === 'handover';
const nodes = Number(arg('nodes', '40000'));
const maxTicks = Number(arg('ticks', '1500'));
const told = has('told') ? burnRange(Number(arg('told', '1'))) : undefined;

const w = world(c.boxes);
const grid = gridOf(w.solid);
const obstacle = (x: number, y: number, z: number): boolean => w.solid.solidAt(x, y, z) === true;
const deps = { look: w.look, obstacle, probe: () => Promise.resolve({ status: 'found' as const, blocks: 3 }) };

let n = 0;
let bad = 0;
const worst = { over: 0, error: 0 };
const hand = { n: 0, inBand: 0, low: Infinity, high: -Infinity, slow: Infinity, fast: -Infinity, routeTicks: 0, landRockets: 0 };
for (const [dx, dz, yaw] of starts) {
  const start = { x: 0.5 + dx, y: FEET, z: 0.5 + dz };
  const plan = await findLanding(c.goal, name, { ...deps, route: { grid, rockets: 2, ...(told ? { kit: told } : {}) } }, { ...OPTS, from: { x: start.x, z: start.z } });
  if (plan.kind !== 'goal') throw new Error(plan.line);
  const target: LandingTarget = plan.target;
  const cz = cruiseHeight(start, target, w.skyTop, {});
  if (!has('quiet')) console.log(`${name} from ${dx} ${dz} looking ${yaw}: ${plan.line}; cruise y ${cz.y.toFixed(2)}`);
  const pairs: [number, number][] = has('pairs') ? burns.flatMap((a) => burns.map((b) => [a, b] as [number, number])) : burns.map((a) => [a, a] as [number, number]);
  for (const x of burnList.filter((y) => y.includes('/'))) pairs.push(x.split('/').map(Number) as [number, number]);
  for (const [first, rest, lag, seed] of pairs.flatMap(([a, b]) => lags.flatMap((l) => seeds.map((s) => [a, b, l, s] as const)))) {
    const notes: string[] = [];
    const hash = createHash('sha1');
    const trace: string[] = [];
    let handed: string | undefined;
    let ticksAtHand = 0;
    const r = await simulateFlight(
      { world: w.solid, groundAt: (x, z, fromY) => w.dryGround(x, z, fromY), skyTop: w.skyTop, ...(live ? { terrain: (x: number, z: number) => ({ top: w.skyTop(x, z), src: 'live' as const }) } : {}) },
      start,
      target,
      { cruiseY: cz.y, ...(told ? { burn: told } : {}), ...(seed !== undefined ? { seed } : {}), ...(live ? { margin: 15, clearance: 12, goArounds: 4, descent: 'auto' as const, landStyle: 'auto' as const } : {}), note: (m) => notes.push(m), route: { grid, plan: (req) => planRoute({ ...req, maxMs: 1e9, maxNodes: Math.min(req.maxNodes, nodes) }, grid), maxMs: 1e9, maxNodes: nodes } },
      {
        rockets: 64,
        yaw,
        maxTicks,
        burn: (rocket) => (rocket === 0 ? first : rest),
        endLag: lag,
        until: (brain, body) => {
          const line = `${body.pos.x.toFixed(6)} ${body.pos.y.toFixed(6)} ${body.pos.z.toFixed(6)} ${brain.phase}`;
          hash.update(line);
          if (traceOf === `${first}/${rest}`) trace.push(`${brain.stats.ticks} ${line} v ${Math.hypot(body.vel.x, body.vel.z).toFixed(3)} ${body.vel.y.toFixed(3)} boost ${body.boostTicks ?? 0}`);
          if (handed === undefined && brain.phase === 'route') {
            handed = notes.find((m) => m.startsWith('route landing: handing over'));
            ticksAtHand = brain.stats.ticks;
          }
          return stopAtHandover && handed !== undefined;
        },
      },
    );
    n++;
    const over = handed ? Number(/, ([\d.]+) over the cell/.exec(handed)?.[1] ?? NaN) : NaN;
    const out = handed ? Number(/tracker (\d+) out/.exec(handed)?.[1] ?? NaN) : NaN;
    const speed = handed ? Number(/at ([\d.]+) a tick/.exec(handed)?.[1] ?? NaN) : NaN;
    const e = r.end;
    const ok = stopAtHandover ? handed !== undefined : e?.ok === true && r.hits === 0 && !r.wet;
    if (!ok) bad++;
    if (over > worst.over) worst.over = over;
    if (handed) {
      hand.n++;
      if (over >= ROUTE_HAND_BAND.low && over <= ROUTE_HAND_BAND.high && speed >= ROUTE_HAND_BAND.slow && speed <= ROUTE_HAND_BAND.fast) hand.inBand++;
      hand.low = Math.min(hand.low, over);
      hand.high = Math.max(hand.high, over);
      hand.slow = Math.min(hand.slow, speed);
      hand.fast = Math.max(hand.fast, speed);
      hand.routeTicks = Math.max(hand.routeTicks, r.stats.routeTicks);
      hand.landRockets = Math.max(hand.landRockets, r.stats.rocketsBy.land);
    }
    if (r.stats.routeMaxError > worst.error) worst.error = r.stats.routeMaxError;
    console.log(
      `${name} ${dx}:${dz}:${yaw} burns ${first}/${rest}${lags.length > 1 ? ` lag ${lag}` : ''}${seeds.length > 1 ? ` seed ${seed}` : ''} ${hash.digest('hex').slice(0, 12)} ${ok ? 'ok ' : 'BAD'} ${e ? (e.ok ? 'landed' : e.reason) : `no end (${r.phase})`} off ${e ? e.off.toFixed(2) : '?'} ticks ${r.ticks} hits ${r.hits} rockets ${r.stats.rockets} (${r.stats.rocketsBy.climb} climb, ${r.stats.rocketsBy.cruise} cruise, ${r.stats.rocketsBy.land} land, ${r.stats.rocketsBy.goaround} go-around) go-arounds ${r.stats.goArounds} max y ${r.stats.maxY.toFixed(1)} hand-over ${handed ? `tick ${ticksAtHand} ${out} out ${over.toFixed(1)} over at ${speed.toFixed(2)}` : 'none'} route ${r.stats.routeTicks} ticks ${r.stats.routePlans} plans ${r.stats.routeReplans} re-plans max error ${r.stats.routeMaxError.toFixed(2)} style ${r.stats.landStyle ?? '-'}${r.stats.descents.length ? `; ${r.stats.descents.join('; ')}` : ''}`,
    );
    if (traceOf === `${first}/${rest}`) console.log(trace.join('\n'));
    if (traceOf === `${first}/${rest}` || has('notes')) console.log(notes.map((m) => `   ${m}`).join('\n'));
  }
}
console.log(
  `${name}${T !== 150 ? ` ${T} out` : ''}: ${n} flights, ${bad} not landed clean on the cell; ${hand.n} hand-overs${hand.n ? ` ${hand.low.toFixed(1)} to ${hand.high.toFixed(1)} over the cell at ${hand.slow.toFixed(2)} to ${hand.fast.toFixed(2)} a tick, ${hand.inBand} in the band (${ROUTE_HAND_BAND.low} to ${ROUTE_HAND_BAND.high} over at ${ROUTE_HAND_BAND.slow} to ${ROUTE_HAND_BAND.fast})` : ''}${stopAtHandover ? '' : `; the most route ticks ${hand.routeTicks}, the most rockets while landing ${hand.landRockets}`}; the largest tracker error ${worst.error.toFixed(2)}`,
);
