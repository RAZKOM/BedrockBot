// Track F17 (docs/flight.md "Windows beside the walk (Track F17)"): the passage round each landing probe's way of the
// private cave fixture, node by node: the head room over the feet and the width at the body's height (waywin.ts
// wayClearance, capped at 5; `+` 5 or more wide), `*` a node under open sky. Needs the ways way-window-bench.ts cached
// (fixtures-private/<fixture>/f17-ways.json); prints nothing of the fixture but the profile.
//
//   node scripts/way-profile.ts [cave_8,cave_9,...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureDir } from '../src/skills/nav/bench/fixture.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { wayAlong, wayClearance, type WayNode } from '../src/skills/fly/cave/waywin.ts';

const dir = fixtureDir('cave-2026-11-14-wide');
const ways = JSON.parse(readFileSync(join(dir, 'f17-ways.json'), 'utf8')) as Record<string, { nodes: WayNode[] }>;
const cw = caveWorld(loadCaveFixture(dir)!.extract);
for (const tag of (process.argv[2] ?? 'cave_8,cave_9,cave_16,cave_17,cave_19').split(',')) {
  const way = ways[tag]!.nodes;
  const along = wayAlong(way);
  const row: string[] = [];
  let open = 0;
  for (let i = 0; i < way.length; i++) {
    const c = wayClearance(way, i, i, cw.solid);
    let roof = false;
    for (let y = Math.floor(way[i]!.feet) + 2; y < Math.floor(way[i]!.feet) + 60; y++) {
      if (cw.solid(way[i]!.x, y, way[i]!.z) === true) {
        roof = true;
        break;
      }
    }
    if (!roof) open++;
    row.push(`${c.height}${c.width >= 5 ? '+' : c.width}${roof ? '' : '*'}`);
  }
  const h = way.map((_, i) => wayClearance(way, i, i, cw.solid).height);
  const hist = [1, 2, 3, 4, 5].map((k) => `${k}${k === 5 ? '+' : ''}: ${h.filter((x) => x === k).length}`).join(', ');
  console.log(`${tag}: ${way.length} nodes, ${along[way.length - 1]!.toFixed(0)} blocks; head room over the feet (nodes) ${hist}; ${open} nodes under open sky; drop ${(way[0]!.feet - way[way.length - 1]!.feet).toFixed(0)}`);
  console.log(`   ${row.join(' ')}`);
}
