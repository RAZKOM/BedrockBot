// Track F10 (docs/flight.md "The open-air flight on the burn of the rockets at hand"): whole open-air flights offline,
// the brain on stepBody over synthetic ground, with the burn of each rocket drawn from a kit's range, so that the climb's
// top, the rockets by phase and the ticks can be compared between kits, between what the brain is told and between two
// trees without a server's noise.
//
//   node scripts/open-burn-probe.ts [--case flat,ridge,hill,step,far] [--dist 650,1200] [--kit plain,crafted,f2,f3] [--model plain,kit]
//        [--n 30] [--burns 19,25,31] [--lag 2] [--trace <flight>] [--hash] [--quiet] [--retarget 40]
//
// Every list is flown in every combination, a block of lines each.
// `--kit`: the rockets the body really burns (plain: 9 to 21 ticks; crafted: 19 to 31; f2, f3: flight durations 2 and 3).
// `--model`: what the brain is told its rockets burn: `plain` (nothing: 9 to 21 whatever the kit, the bot with `flyKitBurn`
// off) or `kit` (the kit's own range, `flyKitBurn` on; for the plain kit nothing either way). `--burns`: every rocket of a
// flight burns that many ticks, a flight each; without it `--n` flights, each rocket's burn drawn from the kit's range by a
// seeded generator (the same burns whatever the model). `--lag`: a burn's end is seen that many ticks late, as the input
// loop sees it. `--trace k`: every tick of flight k, with the brain's notes. `--hash`: a hash of every tick's position a
// flight and one over all of them (two trees fly the same ticks when the hashes are the same). `--retarget up`: 120 ticks
// into the flight the target becomes a point `up` blocks over the goal, 60 blocks before it (as a learned entry's line
// takes a flight over: the Realm's trips into the cave). One line a flight; the last line of a block gives the ranges.
//
// The cases (the start on flat ground, the goal a 7 x 7 cell on the ground `--dist` out):
//   flat    nothing between
//   ridge   a ridge 47 over the ground from 180 to 480 out (the cruise height is set by it; the terrain floor asks for 20
//           more 200 blocks before it)
//   hill    a ridge 47 over the ground from 300 to 360 out
//   step    the goal's side 30 higher from 400 out on
//   far     flat, and the flight may climb only 40 over its start (flyMaxClimb): the cruise is under the glide's line and
//           is topped up on the way
import { createHash } from 'node:crypto';
import { burnRange, type BurnRange } from '../src/skills/fly/burn.ts';
import { simulateFlight } from '../src/skills/fly/glide.ts';
import { cruiseHeight, type LandingTarget } from '../src/skills/fly/plan.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import type { BlockBox } from '../src/skills/input/index.ts';
import { FEET, world } from '../test/unit/skills/fly-worlds.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const N = Number(arg('n', '30'));
const LAG = Number(arg('lag', '2'));
const TRACE = has('trace') ? Number(arg('trace', '0')) : undefined;
const FIXED = has('burns') ? arg('burns', '').split(',').map(Number) : undefined;
const RETARGET = has('retarget') ? Number(arg('retarget', '40')) : undefined;
const flightOf: Record<string, number> = { plain: 0, crafted: 1, f2: 2, f3: 3 };

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  label: string;
  end: string;
  landed: boolean;
  ticks: number;
  rockets: number;
  by: string;
  /** The flight's top over the ground, over the planned cruise height, and over the height the climb went for (the cruise height, or the terrain floor's highest ask where that is higher). */
  maxY: number;
  over: number;
  overGoal: number;
  avoid: number;
  goArounds: number;
  hits: number;
  hash: string;
}

async function block(CASE: string, DIST: number, KIT: string, MODEL: string): Promise<void> {
  const kit: BurnRange = burnRange(flightOf[KIT] ?? 0);
  const model: BurnRange | undefined = MODEL === 'kit' && (flightOf[KIT] ?? 0) > 0 ? kit : undefined;
  const boxes: BlockBox[] = [];
  let goalUp = 0;
  if (CASE === 'ridge') boxes.push({ from: { x: -40, y: FEET, z: 180 }, to: { x: 40, y: FEET + 46, z: 480 }, solid: true });
  if (CASE === 'hill') boxes.push({ from: { x: -40, y: FEET, z: 300 }, to: { x: 40, y: FEET + 46, z: 360 }, solid: true });
  if (CASE === 'step') {
    boxes.push({ from: { x: -60, y: FEET, z: 400 }, to: { x: 60, y: FEET + 29, z: DIST + 60 }, solid: true });
    goalUp = 30;
  }
  const w = world(boxes);
  const terrain: TerrainQuery = (x, z) => ({ top: w.skyTop(x, z), src: 'live' });
  const start = { x: 0.5, y: FEET, z: 0.5 };
  const target: LandingTarget = { x: 0.5, z: DIST + 0.5, top: FEET + goalUp, half: 3, ground: FEET + goalUp };
  const cz = cruiseHeight(start, target, w.skyTop, { clearance: 12, margin: 15, maxClimb: CASE === 'far' ? 40 : 120 });

  async function fly(label: string, burnOf: (rocket: number) => number, trace: boolean): Promise<Row> {
    const hash = createHash('sha1');
    const notes: string[] = [];
    let last = '';
    let floorMax = -Infinity;
    let retargeted = false;
    const r = await simulateFlight(
      { world: w.solid, groundAt: w.dryGround, skyTop: w.skyTop, terrain },
      start,
      target,
      {
        cruiseY: cz.y,
        margin: 15,
        clearance: 12,
        descent: 'auto',
        ...(model ? { burn: model } : {}),
        note: (m: string) => {
          const need = /needs y (-?\d+)/.exec(m);
          if (need) floorMax = Math.max(floorMax, Number(need[1]));
          if (trace) notes.push(m);
        },
      },
      {
        rockets: 64,
        yaw: 0,
        maxTicks: 6000,
        burn: burnOf,
        endLag: LAG,
        until: (brain, body) => {
          hash.update(`${body.pos.x.toFixed(4)} ${body.pos.y.toFixed(4)} ${body.pos.z.toFixed(4)};`);
          if (RETARGET !== undefined && !retargeted && brain.stats.ticks >= 120) {
            retargeted = true;
            brain.retarget({ x: target.x, z: target.z - 60, top: target.top + RETARGET, half: 2 }, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 });
          }
          if (trace) {
            const s = `${brain.phase} boost ${(body.boostTicks ?? 0) > 0}`;
            const line = `  t ${brain.stats.ticks} ${brain.phase.padEnd(8)} y ${(body.pos.y - FEET).toFixed(1).padStart(6)} z ${body.pos.z.toFixed(0).padStart(4)} vy ${body.vel.y.toFixed(2).padStart(5)} h ${Math.hypot(body.vel.x, body.vel.z).toFixed(2)} boost ${String(body.boostTicks ?? 0).padStart(2)} rockets ${brain.stats.rockets}`;
            if (s !== last || brain.stats.ticks % 10 === 0) console.log(line);
            last = s;
            for (const n of notes.splice(0)) console.log(`      ${n}`);
          }
          return RETARGET !== undefined && brain.phase === 'approach';
        },
      },
    );
    const s = r.stats;
    const e = r.end;
    const goal = Math.max(cz.y, floorMax);
    return {
      label,
      end: e ? (e.ok ? `landed ${e.off.toFixed(1)} off` : `${e.reason} ${e.off.toFixed(0)} off`) : RETARGET !== undefined && r.phase === 'approach' ? `at the aim, ${(r.body.pos.y - (target.top + RETARGET)).toFixed(0)} over it` : `no end (${r.phase})`,
      landed: e?.ok === true || (RETARGET !== undefined && r.phase === 'approach'),
      ticks: r.ticks,
      rockets: s.rockets,
      by: `${s.rocketsBy.climb}/${s.rocketsBy.cruise}/${s.rocketsBy.goaround}`,
      maxY: s.maxY - FEET,
      over: s.maxY - cz.y,
      overGoal: s.maxY - goal,
      avoid: s.avoidances.length,
      goArounds: s.goArounds,
      hits: r.hits,
      hash: hash.digest('hex').slice(0, 12),
    };
  }

  const rows: Row[] = [];
  const flights: { label: string; burnOf: (rocket: number) => number }[] = [];
  if (FIXED) for (const b of FIXED) flights.push({ label: `burn ${b}`, burnOf: () => b });
  else {
    for (let k = 0; k < N; k++) {
      const r = rng(1000 + k);
      const burns = Array.from({ length: 64 }, () => kit.min + Math.floor(r() * (kit.max - kit.min + 1)));
      flights.push({ label: `#${k} ${burns.slice(0, 5).join(',')}`, burnOf: (i) => burns[i] ?? kit.nominal });
    }
  }
  const head = `[open-burn-probe] ${CASE} ${DIST}, kit ${KIT} (${kit.min} to ${kit.max}), the brain told ${model ? `${model.min} to ${model.max}` : 'nothing (9 to 21)'}`;
  if (!has('quiet')) console.log(`${head}; cruise ${(cz.y - FEET).toFixed(1)} over the ground (highest column ${cz.highest === undefined ? 'none' : (cz.highest - FEET).toFixed(0)}, the glide needs ${(cz.needed - FEET).toFixed(0)}); a burn's end seen ${LAG} late`);
  for (const [k, f] of flights.entries()) {
    const row = await fly(f.label, f.burnOf, TRACE === k);
    rows.push(row);
    if (!has('quiet')) console.log(`${row.label.padEnd(22)} ${row.end.padEnd(18)} ${String(row.ticks).padStart(5)} ticks  ${String(row.rockets).padStart(2)} rockets (${row.by})  top ${row.maxY.toFixed(1).padStart(6)} (${row.over >= 0 ? '+' : ''}${row.over.toFixed(1)} over the cruise, ${row.overGoal >= 0 ? '+' : ''}${row.overGoal.toFixed(1)} over what the climb went for)  ${row.avoid} avoidances, ${row.goArounds} go-arounds, ${row.hits} hits${has('hash') ? `  ${row.hash}` : ''}`);
  }
  const range = (xs: number[]): string => `${Math.min(...xs).toFixed(1)} to ${Math.max(...xs).toFixed(1)} (mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)})`;
  console.log(`${head}: n ${rows.length}, arrived ${rows.filter((r) => r.landed).length}; top over the cruise ${range(rows.map((r) => r.over))}, over what the climb went for ${range(rows.map((r) => r.overGoal))}; rockets ${range(rows.map((r) => r.rockets))}; ticks ${range(rows.map((r) => r.ticks))}; go-arounds ${rows.reduce((a, r) => a + r.goArounds, 0)}; hits ${rows.reduce((a, r) => a + r.hits, 0)}${has('hash') ? `; all ${createHash('sha1').update(rows.map((r) => r.hash).join()).digest('hex').slice(0, 12)}` : ''}`);
}

for (const c of arg('case', 'ridge').split(',')) for (const dist of arg('dist', '650').split(',').map(Number)) for (const k of arg('kit', 'crafted').split(',')) for (const m of arg('model', 'plain').split(',')) await block(c, dist, k, m);
