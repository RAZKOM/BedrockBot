// Track F14 (docs/flight.md "The way down to the landing (Track F14)"): whole arrivals offline over a real place, the
// brain on stepBody over the world cache's extract of it (world/cache/export.ts), for goals under a mountain: the
// landing search itself is run on the extract with the navigator's own probe (as the live bot runs it), and the flight
// comes in at the cruise's height, holds over the goal and is given the search's site, as on the Realm. Prints offsets
// from the chosen site only (its centre and its floor), heights, counts and times; never a coordinate of the place.
//
//   node scripts/land-flank-probe.ts [--fixture <dir>] [--to cave_8,cave_9] [--headings 4|a,b,c] [--from <waypoint>|<yaw>]
//        [--hold 10,30] [--no-hold 100] [--n 1] [--dist 170] [--kit crafted] [--model plain|kit] [--down] [--map 40]
//        [--trace <flight>] [--quiet] [--lines] [--walks] [--time]
//
// The fixture (private, git-ignored: bot/fixtures-private/<name>, or LAND_FLANK_FIXTURE_DIR): `extract.json` and
// `waypoints.json` (corridor/cave.ts loadCaveFixture).
//
// A flight: the body starts in the air `--dist` blocks before the goal on the heading, at the cruise's height (12 over
// the highest column on its way, as plan.ts cruiseHeight), gliding at 1.5 a tick towards the goal. The target holds over
// the goal ("its ground is not loaded yet"); `--hold` ticks into the hold the landing search runs from where the body is
// and its answer becomes the target (`--no-hold d`: the search runs d blocks before the goal instead, before any hold).
// `--headings`: 4 (the heading from `--from` and three more, 90 degrees apart), 8, or a list of yaws. `--kit`: the
// rockets the body really burns; `--model`: what the brain is told (`plain`: nothing, `flyKitBurn` off). `--down`: with
// this track's setting (`flyWayDown`) on, in the search and in the brain. `--map r`: the column tops round the goal, as
// heights over its floor, r each way (for the eye). `--lines`: under each flight the search's line, what is over the site
// it chose (a roof, the open sky) and the flight's own lines of the landing. `--walks`: the walk from where each flight
// stood to the goal, by the navigator's probe with a large budget (the price of the place the flight ended on). `--time`:
// the wall clock a tick took. One line a flight; the last line of a block counts them. The open-ground landings of the
// same sweep are built and flown by scripts/land-rise-probe.ts.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { damageForCounted } from '../src/skills/fall/damage.ts';
import { burnRange, type BurnRange } from '../src/skills/fly/burn.ts';
import { caveWorld, loadCaveFixture } from '../src/skills/fly/corridor/cave.ts';
import { simulateFlight } from '../src/skills/fly/glide.ts';
import { perched } from '../src/skills/fly/ground.ts';
import { findLanding, isHazardName, type BlockLookup, type CellBlock, type LandingOptions, type LandingPlan, type ProbeOutcome } from '../src/skills/fly/landing.ts';
import { landingProbe } from '../src/skills/fly/landprobe.ts';
import { PATH_PACE, TICKS_PER_S } from '../src/skills/fly/landprice.ts';
import { columnKey, hdist, yawDir, yawTo, type FlightBody, type LandingTarget } from '../src/skills/fly/plan.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { glideFallStep, wallImpactDamage } from '../src/skills/input/physics.ts';
import { BotSkills } from '../src/skills/index.ts';
import { TOP_NONE, TOP_UNKNOWN } from '../src/world/cache/export.ts';
import { CLS_AIR, CLS_AVOID, CLS_SOLID, CLS_WATER } from '../src/world/cache/types.ts';
import type { Vec3 } from '../src/world/types.ts';
import { LAND_BUDGET_MS, LAND_PROBE_NODES } from '../src/chat/commands-fly.ts';
import { harness } from '../test/unit/skills/fakes.ts';
import { caveSkillsWorld } from '../test/unit/skills/fly-cave-walk.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const dir = resolve(arg('fixture', process.env.LAND_FLANK_FIXTURE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../fixtures-private/cave-2026-11-14-wide')));
const fix = existsSync(dir) ? loadCaveFixture(dir) : undefined;
if (!fix) {
  console.log('no fixture (extract.json and waypoints.json in bot/fixtures-private/cave-2026-11-14-wide or LAND_FLANK_FIXTURE_DIR): nothing to fly');
  process.exit(0);
}
const e = fix.extract;
const cave = caveWorld(e);
const b = e.box;
const inBox = (x: number, z: number): boolean => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
const unknownAt = (x: number, z: number): boolean => inBox(x, z) && e.unknownChunk(x >> 4, z >> 4);
// the flight's world: the extract's cells in the box; beside it the extract's column tops (solid up to the top, air over
// it); a chunk the cache never saw is air to the body and unknown to every query
const outsideTop = (x: number, z: number): number | undefined => {
  const t = e.top(x, z);
  return t === undefined || t === TOP_UNKNOWN || t === TOP_NONE ? undefined : t;
};
const clsAt = (x: number, y: number, z: number): number => {
  if (unknownAt(x, z)) return CLS_AIR;
  if (inBox(x, z)) return y > b.max.y ? CLS_AIR : y < b.min.y ? CLS_SOLID : e.cls(x, y, z)!;
  const t = outsideTop(x, z);
  return t !== undefined && y <= t ? CLS_SOLID : CLS_AIR;
};
const solidAt = (x: number, y: number, z: number): boolean => {
  const c = clsAt(x, y, z);
  return c === CLS_SOLID || c === CLS_AVOID;
};
const query = { solidAt, liquidAt: (x: number, y: number, z: number) => (clsAt(x, y, z) === CLS_WATER ? { liquid: 'water' as const, height: 8 / 9 } : null) };
const BLOCKS: CellBlock[] = [
  { name: 'air', solid: false },
  { name: 'stone', solid: true },
  { name: 'water', solid: false },
  { name: 'magma', solid: true },
];
// (the landing search reads live cells only: nothing outside the box, nothing of a chunk the cache never saw)
const look: BlockLookup = (x, y, z) => (!inBox(x, z) || unknownAt(x, z) ? undefined : BLOCKS[clsAt(x, y, z)]);
const topMemo = new Map<number, number | undefined>();
const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
  if (fromY === undefined) {
    const k = columnKey(x, z);
    if (!topMemo.has(k)) topMemo.set(k, skyTop(x, z, 319));
    return topMemo.get(k);
  }
  if (unknownAt(x, z)) return undefined;
  if (!inBox(x, z)) {
    const t = outsideTop(x, z);
    return t === undefined ? undefined : Math.min(t, Math.floor(fromY));
  }
  for (let y = Math.min(b.max.y + 1, Math.floor(fromY)); y >= b.min.y - 1; y--) if (solidAt(x, y, z)) return y;
  return undefined;
};
const groundAt = (x: number, z: number, fromY?: number): number | undefined => {
  const top = skyTop(x, z, fromY);
  if (top === undefined) return undefined;
  const blk = BLOCKS[clsAt(x, top, z)];
  if (blk && isHazardName(blk.name)) return undefined;
  for (let y = top + 1; y <= top + 3; y++) if (clsAt(x, y, z) === CLS_WATER) return undefined;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const t = skyTop(x + dx, z + dz, fromY);
    if (t !== undefined && Math.abs(t - top) > 1) return undefined;
  }
  const feetAt = (cx: number, cz: number): number | undefined => {
    const t = skyTop(cx, cz, fromY);
    return t === undefined ? undefined : t + 1;
  };
  if (perched(feetAt, x, z, top + 1, (cx, cz) => clsAt(cx, feetAt(cx, cz)!, cz) !== CLS_WATER)) return undefined;
  return top + 1;
};
const terrain: TerrainQuery = (x, z) => {
  const t = skyTop(x, z);
  return t === undefined ? { top: undefined, src: 'unknown' } : { top: t, src: 'live' };
};

// the navigator over the place (the landing search's probe and the price of the walk from where a flight stood)
const { loop } = harness({ x: b.min.x + 8.5, y: 100, z: b.min.z + 8.5 });
const skills = new BotSkills({ loop, world: caveSkillsWorld(cave) });
const nav = skills.nav;
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
// (the probes' wall-clock budgets five times the live ones, so that this machine's load does not decide what is confirmed;
// the nodes are the live ones)
const MS = 5;
const OPTS: LandingOptions = { radius: 48, headroom: 4, maxUnder: 10, probes: 16, budgetMs: LAND_BUDGET_MS * MS, style: 'auto', partial: true };

const cellOf = (name: string): Vec3 => {
  const p = fix.waypoints.get(name);
  if (!p) throw new Error(`no waypoint ${name}`);
  return cave.feetCell(p) ?? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
};

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
  /** Standing on the site's cells at its floor's height. */
  onSite: boolean;
  /** Blocks from the site's centre, and the height over its floor. */
  off: number;
  up: number;
  ticks: number;
  /** Ticks from the retarget to standing. */
  landTicks: number;
  damage: number;
  hits: number;
  vy: number;
  h: number;
  descents: string;
  goArounds: number;
  rockets: number;
  /** Rockets fired after the retarget. */
  landRockets: number;
  style: string;
  /** The site's walk as the search priced it, and the walk from where the flight stood (the probe's price; undefined: no probe asked or none found). */
  siteWalkS: number | undefined;
  walkS: number | undefined;
  prices: string[];
  notes: string[];
  tickMs: number;
  tickMaxMs: number;
}

const walkMemo = new Map<string, number | undefined>();
/** The walk from feet cell `from` to `goal` by the navigator's probe with a large budget, in seconds (undefined: no path found). */
async function walkFrom(from: Vec3, goal: Vec3): Promise<number | undefined> {
  const k = `${Math.floor(from.x)},${Math.floor(from.y)},${Math.floor(from.z)}>${goal.x},${goal.y},${goal.z}`;
  if (walkMemo.has(k)) return walkMemo.get(k);
  const o = await landingProbe(nav, goal, { budget: { nodes: 600_000, ms: 60_000 }, surface: false })({ x: Math.floor(from.x) + 0.5, y: Math.floor(from.y + 0.01), z: Math.floor(from.z) + 0.5 });
  const s = o.status === 'found' && o.ticks !== undefined ? (o.ticks / TICKS_PER_S) * PATH_PACE : undefined;
  walkMemo.set(k, s);
  return s;
}

/** What is over a site's cells: the lowest solid over their feet (a roof) and the column's top, as heights over the floor. */
function overSaid(site: LandingTarget): string {
  const cells = site.cells ? [...site.cells].map((k) => ({ x: Math.floor(k / 65536), z: k % 65536 })) : [{ x: Math.floor(site.x), z: Math.floor(site.z) }];
  let roofed = 0;
  let low = Infinity;
  let top = -Infinity;
  for (const c of cells) {
    // (the cells' keys are the columns' low 16 bits: the place lies in the positive quadrant)
    let ceiling: number | undefined;
    for (let y = site.top; y <= b.max.y + 1; y++)
      if (solidAt(c.x, y, c.z)) {
        ceiling = y - site.top;
        break;
      }
    if (ceiling !== undefined) {
      roofed++;
      low = Math.min(low, ceiling);
    }
    top = Math.max(top, (skyTop(c.x, c.z) ?? site.top - 1) + 1 - site.top);
  }
  return roofed === 0 ? `${cells.length} cells under the open sky` : `${roofed} of ${cells.length} cells under a roof, the lowest ${low} over the floor; the ground over them up to ${top} over the floor`;
}

const flightOf: Record<string, number> = { plain: 0, crafted: 1 };
const DOWN = has('down');

async function fly(label: string, goal: Vec3, heading: number, hold: number | undefined, lookAt: number | undefined, seed: number, kit: BurnRange, model: BurnRange | undefined, trace: boolean): Promise<Row> {
  const d = yawDir(heading);
  const dist = Number(arg('dist', '170'));
  const goalAt = { x: goal.x + 0.5, z: goal.z + 0.5 };
  // the cruise: 12 over the highest column on its way (plan.ts cruiseHeight), at least the glide's need
  let ridge = -Infinity;
  for (let s = 0; s <= dist; s++) ridge = Math.max(ridge, skyTop(Math.floor(goalAt.x - d.x * s), Math.floor(goalAt.z - d.z * s)) ?? -Infinity);
  const start = { x: goalAt.x - d.x * dist, y: Math.max(goal.y + 10 + 12, ridge + 1 + 12), z: goalAt.z - d.z * dist };
  const held: LandingTarget = { x: goalAt.x, z: goalAt.z, top: goal.y, half: 1, hold: true };
  const r0 = rng(7000 + seed);
  const burns = Array.from({ length: 64 }, () => kit.min + Math.floor(r0() * (kit.max - kit.min + 1)));
  const notes: string[] = [];
  const kept: string[] = [];
  let site: LandingTarget | undefined;
  let plan: LandingPlan | undefined;
  let searching: Promise<void> | undefined;
  let asked = false;
  let retargetAt: number | undefined;
  let rocketsAt = 0;
  let fall = 0;
  let damage = 0;
  let prev: { vy: number; h: number; y: number; gliding: boolean } | undefined;
  let lastAir = { vy: 0, h: 0 };
  let lastPhase = '';
  let tickAt = performance.now();
  let tickMax = 0;
  let tickSum = 0;
  let tickN = 0;
  let searchMs = 0;
  let searched = false;
  const centre = (): { x: number; z: number } => (site ? { x: site.x, z: site.z } : goalAt);
  const rel = (p: { x: number; y: number; z: number }): string => `[${(p.x - centre().x).toFixed(1)} ${(p.y - (site?.top ?? goal.y)).toFixed(1)} ${(p.z - centre().z).toFixed(1)}]`;
  const relNote = (s: string): string =>
    s
      .replace(/(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/g, (_m, x: string, y: string, z: string) => rel({ x: Number(x), y: Number(y), z: Number(z) }))
      .replace(/(-?\d+) (-?\d+) (-?\d+)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - Math.floor(centre().x)} ${Number(y) - (site?.top ?? goal.y)} ${Number(z) - Math.floor(centre().z)}]`);
  const r = await simulateFlight(
    { world: query, groundAt, skyTop: (x, z) => skyTop(x, z), terrain },
    start,
    held,
    { cruiseY: start.y, margin: 15, clearance: 12, goArounds: 4, descent: 'auto', landStyle: 'auto', seed, ...(model ? { burn: model } : {}), ...(DOWN ? { wayDown: true } : {}), note: (m: string) => notes.push(m) },
    {
      rockets: 40,
      yaw: heading,
      maxTicks: 6000,
      burn: (i) => burns[i] ?? kit.nominal,
      endLag: 2,
      airborne: { x: d.x * 1.5, y: -0.1, z: d.z * 1.5 },
      wait: () => searching,
      until: (brain, body) => {
        const now = performance.now();
        // (the wall clock of a tick: the brain's step and the body's; not the tick the landing search ran in, which is
        // timed by itself)
        if (brain.stats.ticks > 1 && !searched) {
          tickMax = Math.max(tickMax, now - tickAt);
          tickSum += now - tickAt;
          tickN++;
        }
        searched = false;
        tickAt = now;
        const h = Math.hypot(body.vel.x, body.vel.z);
        if (prev?.gliding) {
          if (body.collidedHorizontally) damage += wallImpactDamage(prev.h, h);
          if (body.onGround) damage += damageForCounted(fall);
          else fall = glideFallStep(fall, prev.vy, body.pos.y - prev.y);
        }
        if (body.gliding) lastAir = { vy: body.vel.y, h };
        prev = { vy: body.vel.y, h, y: body.pos.y, gliding: body.gliding ?? false };
        const fb: FlightBody = { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 };
        // the look for a landing: once, from where the body is; the flight stands still while it runs (offline it takes
        // no ticks; live it took 204 to 607 ms)
        if (!asked && (hold !== undefined ? brain.stats.holdTicks >= hold : hdist(body.pos, goalAt) <= (lookAt ?? 100))) {
          asked = true;
          searched = true;
          const t0 = performance.now();
          const probe = landingProbe(nav, goal, { budget: { nodes: LAND_PROBE_NODES, ms: 400 * MS }, surface: false });
          searching = findLanding(goal, 'the goal', { look, obstacle: solidAt, probe: (f, bud): Promise<ProbeOutcome> => probe(f, bud ? { nodes: bud.nodes, ms: bud.ms * MS } : undefined), dryGround: (x, z) => groundAt(x, z), yieldNow, ...(DOWN ? { skyTop: (x: number, z: number) => skyTop(x, z), maxY: (x: number, z: number) => (inBox(x, z) ? b.max.y : outsideTop(x, z)) } : {}) }, { ...OPTS, from: { x: body.pos.x, z: body.pos.z }, ...(DOWN ? { sky: true } : {}) }).then((p) => {
            plan = p;
            searchMs = performance.now() - t0;
            searching = undefined;
          });
          return false;
        }
        if (plan && retargetAt === undefined) {
          retargetAt = brain.stats.ticks;
          rocketsAt = brain.stats.rockets;
          if (plan.kind === 'cell' || plan.kind === 'goal' || plan.kind === 'fallback') {
            site = plan.target;
            brain.retarget(site, fb);
          }
          const line = `(the search, ${searchMs.toFixed(0)} ms: ${relNote(plan.line.replace(/^landing for the goal: /, ''))})`;
          kept.push(line);
          if (site) kept.push(`(the site: ${overSaid(site)})`);
          if (trace) console.log(`      ${line}\n      (retargeted at tick ${brain.stats.ticks}, the body at ${rel(body.pos)}, ${hdist(body.pos, centre()).toFixed(0)} out)`);
        }
        const fresh = notes.splice(0);
        for (const n of fresh) if (/landing price|land now|go-around|descent|no way down|way down|holding|brake landing/.test(n)) kept.push(relNote(n));
        if (trace) {
          const s = `${brain.phase} ${brain.descending ?? ''}`;
          if (s !== lastPhase || brain.stats.ticks % 10 === 0) console.log(`  t ${String(brain.stats.ticks).padStart(4)} ${s.padEnd(22)} at ${rel(body.pos)} ${hdist(body.pos, centre()).toFixed(1).padStart(5)} out, vy ${body.vel.y.toFixed(2)} h ${h.toFixed(2)}${body.collidedHorizontally ? ' HIT' : ''}`);
          lastPhase = s;
          for (const n of fresh) console.log(`      ${relNote(n)}`);
        }
        return false;
      },
    },
  );
  for (const n of notes.splice(0)) {
    if (/landing price|land now|go-around|descent|no way down|way down/.test(n)) kept.push(relNote(n));
    if (trace) console.log(`      ${relNote(n)}`);
  }
  const at = r.end?.landedAt ?? r.body.pos;
  const off = hdist(at, centre());
  const up = at.y - (site?.top ?? goal.y);
  const onSite = site !== undefined && r.end !== undefined && (site.cells?.has(columnKey(Math.floor(at.x), Math.floor(at.z))) ?? off <= site.half) && Math.abs(up) < 0.6 && !r.wet;
  const walkS = has('walks') && r.end ? await walkFrom(at, goal) : undefined;
  return {
    label,
    end: r.end ? (r.end.ok ? 'landed' : (r.end.reason ?? '?')) : `no end (${r.phase})`,
    onSite,
    off,
    up,
    ticks: r.ticks,
    landTicks: retargetAt !== undefined ? r.ticks - retargetAt : 0,
    damage,
    hits: r.hits,
    vy: lastAir.vy,
    h: lastAir.h,
    descents: `${r.stats.descents.join('; ')}${r.end && !r.end.ok && r.end.why ? `; ${relNote(r.end.why)}` : ''}`,
    goArounds: r.stats.goArounds,
    rockets: r.stats.rockets,
    landRockets: r.stats.rockets - rocketsAt,
    style: r.stats.landStyle ?? '-',
    siteWalkS: site?.walkS,
    walkS,
    prices: r.stats.landingPrices,
    notes: kept,
    tickMs: tickN ? tickSum / tickN : 0,
    tickMaxMs: tickMax,
  };
}

const names = arg('to', 'cave_8,cave_9,cave_10,cave_11,cave_14,cave_15,cave_16,cave_17,cave_18,cave_19').split(',');
const fromArg = arg('from', 'home');
const N = Number(arg('n', '1'));
const TRACE = has('trace') ? Number(arg('trace', '0')) : undefined;
const holds: (number | undefined)[] = arg('hold', '10,30').split(',').filter(Boolean).map(Number);
const lookAts: number[] = has('no-hold') ? arg('no-hold', '100').split(',').map(Number) : [];
const range = (xs: number[], dgt = 1): string => (xs.length ? `${Math.min(...xs).toFixed(dgt)} to ${Math.max(...xs).toFixed(dgt)} (mean ${(xs.reduce((a, c) => a + c, 0) / xs.length).toFixed(dgt)})` : '-');

console.log(`[land-flank-probe] ${DOWN ? 'flyWayDown on' : 'as on the base (flyWayDown off)'}; the box ${e.size.x} x ${e.size.y} x ${e.size.z}, ${e.unknown.length} chunks of it unknown`);
const all: Row[] = [];
let k = 0;
for (const name of names) {
  const goal = cellOf(name);
  // the heading the live flights came in on: from the home (outside the box: its waypoint), or a yaw
  const home = fix.waypoints.get(fromArg);
  const first = home ? yawTo(home, { x: goal.x + 0.5, z: goal.z + 0.5 }) : Number(fromArg);
  const hs = arg('headings', '4');
  const headings = /^\d+$/.test(hs) && Number(hs) <= 16 && !hs.includes(',') ? Array.from({ length: Number(hs) }, (_, i) => (first + (i * 360) / Number(hs)) % 360) : hs.split(',').map(Number);
  if (has('map')) {
    const r = Number(arg('map', '40'));
    console.log(`[land-flank-probe] ${name}: the column tops round the goal, as feet heights over the goal's floor (every 4th column, ${r} each way; north up, the goal at the centre):`);
    for (let dz = -r; dz <= r; dz += 4) {
      let line = '';
      for (let dx = -r; dx <= r; dx += 4) {
        const t = skyTop(goal.x + dx, goal.z + dz);
        line += t === undefined ? '   ?' : String(t + 1 - goal.y).padStart(4);
      }
      console.log(`   ${line}`);
    }
  }
  const rows: Row[] = [];
  for (const [hi, heading] of headings.entries()) {
    for (const mode of [...holds.map((h) => ({ hold: h, lookAt: undefined as number | undefined })), ...lookAts.map((l) => ({ hold: undefined as number | undefined, lookAt: l }))]) {
      for (let s = 0; s < N; s++) {
        const label = `#${k} ${name}, heading ${hi === 0 ? 'home' : `+${Math.round((hi * 360) / headings.length)}`}, ${mode.hold !== undefined ? `hold ${mode.hold}` : `look ${mode.lookAt} out`}`;
        const row = await fly(label, goal, heading, mode.hold, mode.lookAt, 11 + k, burnRange(flightOf[arg('kit', 'crafted')] ?? 0), arg('model', 'plain') === 'kit' ? burnRange(flightOf[arg('kit', 'crafted')] ?? 0) : undefined, TRACE === k);
        rows.push(row);
        all.push(row);
        if (!has('quiet')) {
          console.log(`${row.label.padEnd(40)} ${row.end.padEnd(11)} ${row.onSite ? 'ON THE SITE' : 'off the site'} ${row.off.toFixed(1).padStart(5)} from its centre, ${row.up >= 0 ? '+' : ''}${row.up.toFixed(1)} over its floor; ${String(row.ticks).padStart(4)} ticks (${row.landTicks} from the retarget), touchdown vy ${row.vy.toFixed(2)} h ${row.h.toFixed(2)}, damage ${row.damage.toFixed(1)}, ${row.hits} hits, ${row.goArounds} go-arounds, ${row.rockets} rockets (${row.landRockets} from the retarget), ${row.style}; site walk ${row.siteWalkS?.toFixed(1) ?? '?'} s${row.walkS !== undefined ? `, walk from where it stood ${row.walkS.toFixed(1)} s` : has('walks') ? ', no walk found from where it stood' : ''}; ${row.descents}`);
          if (has('lines')) for (const n of row.notes) console.log(`      ${n}`);
        }
        k++;
      }
    }
  }
  const on = rows.filter((r) => r.onSite);
  const offRows = rows.filter((r) => !r.onSite);
  console.log(`[land-flank-probe] ${name}: n ${rows.length}; on the site's floor ${on.length} (within 2 of its centre ${on.filter((r) => r.off <= 2).length}); off it ${offRows.length} (${range(offRows.map((r) => r.off))} from the centre, ${range(offRows.map((r) => r.up))} over the floor${has('walks') ? `, walk from there ${range(offRows.filter((r) => r.walkS !== undefined).map((r) => r.walkS!))} s, ${offRows.filter((r) => r.walkS === undefined).length} with no walk found` : ''}); site walk ${range(rows.filter((r) => r.siteWalkS !== undefined).map((r) => r.siteWalkS!))} s; damage ${range(rows.map((r) => r.damage))}, flights with damage ${rows.filter((r) => r.damage > 0).length}; hits ${rows.reduce((a, r) => a + r.hits, 0)}; touchdown vy ${range(rows.map((r) => r.vy), 2)}, h ${range(rows.map((r) => r.h), 2)}; ticks from the retarget ${range(rows.map((r) => r.landTicks), 0)}; rockets from the retarget ${range(rows.map((r) => r.landRockets))}; go-arounds ${rows.reduce((a, r) => a + r.goArounds, 0)}; priced misses ${rows.reduce((a, r) => a + r.prices.length, 0)}; ends ${[...new Set(rows.map((r) => r.end))].map((x) => `${x} ${rows.filter((r) => r.end === x).length}`).join(', ')}`);
}
const onAll = all.filter((r) => r.onSite);
console.log(`[land-flank-probe] all: n ${all.length}; on the site's floor ${onAll.length} (within 2 of its centre ${onAll.filter((r) => r.off <= 2).length}); off it ${all.length - onAll.length}; flights with damage ${all.filter((r) => r.damage > 0).length} (${range(all.filter((r) => r.damage > 0).map((r) => r.damage))}); hits ${all.reduce((a, r) => a + r.hits, 0)}; ticks from the retarget ${range(all.map((r) => r.landTicks), 0)}; rockets from the retarget ${range(all.map((r) => r.landRockets))}; go-arounds ${all.reduce((a, r) => a + r.goArounds, 0)}; priced misses ${all.reduce((a, r) => a + r.prices.length, 0)}${has('time') ? `; a tick took ${(all.reduce((a, r) => a + r.tickMs, 0) / Math.max(1, all.length)).toFixed(3)} ms on average, ${Math.max(...all.map((r) => r.tickMaxMs)).toFixed(1)} ms at the longest` : ''}`);
loop.stop?.();
