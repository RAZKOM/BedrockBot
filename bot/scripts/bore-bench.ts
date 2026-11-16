// Track F17 (docs/flight.md "Windows beside the walk (Track F17)"): the corridor e2e's trip offline: the corridor world
// (test/unit/skills/fly-corridor-world.ts), the body `--inside` blocks inside the mouth, the executor over the stub
// corridor with the cave style's windows (cave/bench.ts flyTrip), one trip per burn. `--lead on` flies the windows'
// trackers with TrackerRules.refClear.
//
//   node scripts/bore-bench.ts [--burns 9,12,15,18,21,random,random,random] [--inside 3] [--kit plain|crafted]
//                              [--ms 600] [--style on|off] [--lead on|off] [--verbose]
import { caveTripLine, flyTrip, type CaveBenchOptions, type TripWorld } from '../src/skills/fly/cave/bench.ts';
import { corridorWorld } from '../test/unit/skills/fly-corridor-world.ts';
import { flatWorld, withBoxes } from '../src/skills/input/index.ts';
import { burnRange } from '../src/skills/fly/burn.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const w = corridorWorld({ x: 0, z: 0 });
const world = withBoxes(flatWorld(), w.fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' })));
const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
const tw: TripWorld = { name: 'bore', query: world, grid: { solid }, solid, floor: solid };
const burns = arg('burns', '9,12,15,18,21,random,random,random').split(',').map((s) => (s === 'random' ? 'random' : Number(s))) as (number | 'random')[];
const inside = Number(arg('inside', '3'));
const verbose = process.argv.includes('--verbose');
const kit = arg('kit', 'plain') === 'crafted';
for (const [i, burn] of burns.entries()) {
  const notes: string[] = [];
  const o: CaveBenchOptions = { seed: 1 + i, burn, maxMs: Number(arg('ms', '600')), style: arg('style', 'on') === 'on', note: (m) => notes.push(m), ...(kit ? { kit: burnRange(1) } : {}), ...(arg('lead', 'off') === 'on' ? { variant: { rules: { refClear: true } } } : {}) };
  const start = { x: w.mouthX + inside, y: w.start.y, z: w.start.z };
  const t = await flyTrip(tw, w.stub(), start, w.goal, o, `bore burn ${burn}`);
  console.log(caveTripLine(t));
  for (const r of t.windows) console.log(`   window: ${r.end}${r.bailed ? ' (bailed)' : ''}, ${r.reached}/${r.goals} goals, ${r.ticks} ticks, ${r.rockets} rockets, damage ${r.damage.toFixed(1)}, blocks ${r.blocks.toFixed(0)}`);
  if (verbose) for (const n of notes) console.log(`    ${n}`);
}
