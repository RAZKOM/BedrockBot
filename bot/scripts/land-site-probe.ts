// Track F11 (docs/flight.md "The flight comes down where it planned to"): whole arrivals offline over a real place, the
// brain on stepBody over the world cache's extract of it (world/cache/export.ts), from the cruise down onto the landing
// the search chose for a goal under a roof. Prints offsets from the chosen site only (its centre and its floor), never a
// coordinate of the place.
//
//   node scripts/land-site-probe.ts [--fixture <dir>] [--headings realm|compass|a,b,c] [--kit plain,crafted] [--model plain,kit]
//        [--n 2] [--dist 170] [--above 72,77,82] [--hold 20,40] [--no-hold] [--old] [--trace <flight>] [--quiet] [--search]
//        [--sites 24] [--time]
//
// The fixture (private, git-ignored: bot/fixtures-private/<name>, or LAND_SITE_FIXTURE_DIR): `extract.json`, and
// `site.json` with the goal's feet cell, the landing cell the live search chose there (`site`, with its walk in blocks and
// seconds), the alternatives it carried and the heading the flights came in on (`heading`, Bedrock yaw).
//
// A flight: the body starts in the air `--dist` blocks before the goal on the heading, `--above` over the site's floor,
// gliding at 1.5 a tick towards the goal, as a cruise arrives. The target holds over the goal at first (its ground "not
// loaded yet") and becomes the site `--hold` ticks into the hold, as the live search answers (`--no-hold`: the site from
// the start). `--headings`: `realm` (the fixture's own), `compass` (it and seven more, 45 degrees apart) or a list.
// `--kit`: the rockets the body really burns (plain: 9 to 21 ticks, crafted: 19 to 31), each rocket's burn drawn by a
// seeded generator; `--model`: what the brain is told (`plain`: nothing, `flyKitBurn` off; `kit`: the kit's range).
// `--old`: the descent as it was before Track F11 (plan.ts LAND_SWITCH), to measure what the track changed. `--search`:
// the landing search itself is run on the extract (the walk priced by a flood, no navigator) and its answer flown instead
// of the fixture's site. `--sites n`: n other open cells of the place as the landing, one after the other (every k-th of
// the search's candidates round the goal, each with the cells round it; no approach simulation chooses among them).
// `--time`: the wall clock a tick took (the brain's step and the body's), mean and longest. A flight's damage is what the
// server would count (physics.ts wallImpactDamage, glideFallStep). One line a flight; the last line of a block counts them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { damageForCounted } from '../src/skills/fall/damage.ts';
import { burnRange, type BurnRange } from '../src/skills/fly/burn.ts';
import { caveWorld } from '../src/skills/fly/corridor/cave.ts';
import { simulateFlight } from '../src/skills/fly/glide.ts';
import { perched } from '../src/skills/fly/ground.ts';
import { candidatesNear, cellsAround, ColumnView, findLanding, isHazardName, walkSlack, walkTarget, type BlockLookup, type CellBlock, type LandingCell, type ProbeOutcome } from '../src/skills/fly/landing.ts';
import { columnKey, hdist, LAND_SWITCH, yawDir, type LandingTarget } from '../src/skills/fly/plan.ts';
import type { TerrainQuery } from '../src/skills/fly/terrain.ts';
import { glideFallStep, wallImpactDamage } from '../src/skills/input/physics.ts';
import { decodeExtract, TOP_NONE, TOP_UNKNOWN, type CacheExtractFile } from '../src/world/cache/export.ts';
import { CLS_AIR, CLS_AVOID, CLS_SOLID, CLS_WATER } from '../src/world/cache/types.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

interface Cell {
  x: number;
  y: number;
  z: number;
}
interface SiteFile {
  goal: Cell;
  site: Cell;
  walk: number;
  walkS: number;
  alternatives?: (Cell & { walk: number; walkS: number })[];
  heading: number;
}

const dir = resolve(arg('fixture', process.env.LAND_SITE_FIXTURE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../fixtures-private/home-2026-11-13')));
if (!existsSync(join(dir, 'extract.json')) || !existsSync(join(dir, 'site.json'))) {
  console.log('no fixture (extract.json and site.json in bot/fixtures-private/home-2026-11-13 or LAND_SITE_FIXTURE_DIR): nothing to fly');
  process.exit(0);
}
if (has('old')) LAND_SWITCH.clear = false;
const e = decodeExtract(JSON.parse(readFileSync(join(dir, 'extract.json'), 'utf8')) as CacheExtractFile);
const fix = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')) as SiteFile;
const cave = caveWorld(e);
const b = e.box;
const inBox = (x: number, z: number): boolean => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z;
// the flight's world: the extract's cells in the box; beside it the extract's column tops (solid up to the top, air over
// it; a column the cache never saw is air)
const outsideTop = (x: number, z: number): number | undefined => {
  const t = e.top(x, z);
  return t === undefined || t === TOP_UNKNOWN || t === TOP_NONE ? undefined : t;
};
const clsAt = (x: number, y: number, z: number): number => {
  if (inBox(x, z)) return cave.cls(x, y, z);
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
const look: BlockLookup = (x, y, z) => BLOCKS[clsAt(x, y, z)];
// the flight's column tops and safe ground, as the bot's own (commands-fly.ts skyTop / groundAt) over this world
const topMemo = new Map<number, number | undefined>();
const skyTop = (x: number, z: number, fromY?: number): number | undefined => {
  if (fromY === undefined) {
    const k = columnKey(x, z);
    if (!topMemo.has(k)) topMemo.set(k, skyTop(x, z, 319));
    return topMemo.get(k);
  }
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
  const blk = look(x, top, z);
  if (blk && isHazardName(blk.name)) return undefined;
  for (let y = top + 1; y <= top + 3; y++) if (clsAt(x, y, z) === CLS_WATER) return undefined;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const t = skyTop(x + dx, z + dz, fromY);
    if (t !== undefined && Math.abs(t - top) > 1) return undefined;
  }
  // (Track F11: nor a perch, as the bot's; the extract has no shapes, so a fence is a block here)
  const feetAt = (cx: number, cz: number): number | undefined => {
    const t = skyTop(cx, cz, fromY);
    return t === undefined ? undefined : t + 1;
  };
  if (LAND_SWITCH.clear && perched(feetAt, x, z, top + 1, (cx, cz) => clsAt(cx, feetAt(cx, cz)!, cz) !== CLS_WATER)) return undefined;
  return top + 1;
};
const terrain: TerrainQuery = (x, z) => ({ top: skyTop(x, z), src: 'live' });

// the landing: the fixture's site as the search builds its target (the cells round it at its height, its walk's price,
// its alternatives), or the search's own answer on the extract
const view = new ColumnView(look, fix.goal.y);
const targetOf = (c: Cell, walk: number, walkS: number): LandingTarget => {
  const cell: LandingCell = { x: c.x, z: c.z, feet: c.y, kind: 'open' };
  return walkTarget(cell, cellsAround(view, cell, 'open', walkSlack(walk), 4), { walkS, walkKnown: true, walkBy: 'path', name: 'the alternative' });
};
let site: LandingTarget = { ...targetOf(fix.site, fix.walk, fix.walkS), name: 'the site', ...(fix.alternatives?.length ? { alternatives: fix.alternatives.map((a) => targetOf(a, a.walk, a.walkS)) } : {}) };
const centre0 = { x: fix.site.x + 0.5, z: fix.site.z + 0.5 };
const relCells = (s: string): string => s.replace(/(-?\d+) (-?\d+) (-?\d+)/g, (_m, x: string, y: string, z: string) => `[${Number(x) - fix.site.x} ${Number(y) - fix.site.y} ${Number(z) - fix.site.z}]`);
if (has('search')) {
  // the walk: a flood over the floors from the goal (landing.ts walkFlood ranks by it); every reached cell "walks" its
  // straight distance times 1.6 at the pace price: enough to choose among the open cells as the live probe did
  const probe = (from: { x: number; y: number; z: number }): Promise<ProbeOutcome> => Promise.resolve({ status: 'found', blocks: 1.6 * Math.hypot(from.x - fix.goal.x, from.z - fix.goal.z) + 3 * Math.abs(from.y - fix.goal.y) });
  const plan = await findLanding(fix.goal, 'the goal', { look, obstacle: solidAt, probe, dryGround: (x, z) => groundAt(x, z) }, { radius: 48, headroom: 4, maxUnder: 10, probes: 16, budgetMs: 6000, style: 'auto', from: { x: fix.goal.x - yawDir(fix.heading).x * 150, z: fix.goal.z - yawDir(fix.heading).z * 150 } });
  console.log(`[land-site-probe] the search: ${relCells(plan.line.replace(/\(\d+ -?\d+ -?\d+\)/, ''))}`);
  if (plan.kind !== 'cell' && plan.kind !== 'goal' && plan.kind !== 'fallback') process.exit(0);
  site = plan.target;
}
// `--sites n`: instead of the one site, n other open landing cells of the place (every k-th of the search's candidates
// round the goal, each with the cells round it): how the descent does on whatever stands round each of them
const sites: LandingTarget[] = [site];
if (has('sites')) {
  const open = candidatesNear(view, fix.goal, { radius: 48, headroom: 4 }).list.filter((c) => c.kind === 'open');
  const n = Number(arg('sites', '12'));
  sites.length = 0;
  for (let i = 0; i < n && open.length; i++) {
    const c = open[Math.floor(((i + 0.5) * open.length) / n)]!;
    sites.push({ ...targetOf({ x: c.x, y: c.feet, z: c.z }, 40, 10), name: `site ${i + 1}` });
  }
}
let siteTop = site.top;
let centre = { x: site.x, z: site.z };

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
  damage: number;
  hits: number;
  vy: number;
  h: number;
  descents: string;
  goArounds: number;
  rockets: number;
  style: string;
  /** The wall clock a tick took (the brain's step and the body's), mean and longest, ms. */
  tickMs: number;
  tickMaxMs: number;
}

const flightOf: Record<string, number> = { plain: 0, crafted: 1 };
const rel = (p: { x: number; y: number; z: number }): string => `[${(p.x - centre0.x).toFixed(1)} ${(p.y - fix.site.y).toFixed(1)} ${(p.z - centre0.z).toFixed(1)}]`;
const relNote = (s: string): string => relCells(s.replace(/(-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/g, (_m, x: string, y: string, z: string) => rel({ x: Number(x), y: Number(y), z: Number(z) })));

async function fly(label: string, heading: number, above: number, hold: number | undefined, seed: number, kit: BurnRange, model: BurnRange | undefined, trace: boolean): Promise<Row> {
  const d = yawDir(heading);
  const dist = Number(arg('dist', '170'));
  const goalAt = { x: fix.goal.x + 0.5, z: fix.goal.z + 0.5 };
  const aim = hold === undefined ? centre : goalAt;
  // (a cruise is at least its clearance over every column on its way: where a hill stands on this heading the body starts over it)
  let ridge = -Infinity;
  for (let s = 0; s <= dist; s++) ridge = Math.max(ridge, skyTop(Math.floor(aim.x - d.x * s), Math.floor(aim.z - d.z * s)) ?? -Infinity);
  const start = { x: aim.x - d.x * dist, y: Math.max(siteTop + above, ridge + 1 + 12), z: aim.z - d.z * dist };
  const held: LandingTarget = { x: goalAt.x, z: goalAt.z, top: fix.goal.y, half: 1, hold: true };
  const r0 = rng(7000 + seed);
  const burns = Array.from({ length: 64 }, () => kit.min + Math.floor(r0() * (kit.max - kit.min + 1)));
  const notes: string[] = [];
  let retargeted = hold === undefined;
  let fall = 0;
  let damage = 0;
  let prev: { vy: number; h: number; y: number; gliding: boolean } | undefined;
  let lastAir = { vy: 0, h: 0 };
  let lastPhase = '';
  // (the wall clock of a tick: the brain's step and the body's, from one call of `until` to the next)
  let tickAt = performance.now();
  let tickMax = 0;
  let tickSum = 0;
  let tickN = 0;
  const r = await simulateFlight(
    { world: query, groundAt, skyTop: (x, z) => skyTop(x, z), terrain },
    start,
    hold === undefined ? site : held,
    { cruiseY: start.y, margin: 15, clearance: 12, goArounds: 4, descent: 'auto', landStyle: 'auto', seed, ...(model ? { burn: model } : {}), note: (m: string) => notes.push(m) },
    {
      rockets: 40,
      yaw: heading,
      maxTicks: 4000,
      burn: (i) => burns[i] ?? kit.nominal,
      endLag: 2,
      airborne: { x: d.x * 1.5, y: -0.1, z: d.z * 1.5 },
      until: (brain, body) => {
        const now = performance.now();
        if (brain.stats.ticks > 1) {
          tickMax = Math.max(tickMax, now - tickAt);
          tickSum += now - tickAt;
          tickN++;
        }
        tickAt = now;
        const h = Math.hypot(body.vel.x, body.vel.z);
        if (prev?.gliding) {
          // the damage the server would count: a glide into a wall (the speed the tick lost), the fall counted while gliding
          if (body.collidedHorizontally) damage += wallImpactDamage(prev.h, h);
          if (body.onGround) damage += damageForCounted(fall);
          else fall = glideFallStep(fall, prev.vy, body.pos.y - prev.y);
        }
        if (body.gliding) lastAir = { vy: body.vel.y, h };
        prev = { vy: body.vel.y, h, y: body.pos.y, gliding: body.gliding ?? false };
        if (!retargeted && brain.stats.holdTicks >= (hold ?? 0)) {
          retargeted = true;
          brain.retarget(site, { pos: body.pos, vel: body.vel, onGround: body.onGround, gliding: body.gliding ?? false, boostTicks: body.boostTicks ?? 0 });
          if (trace) console.log(`      (retargeted to the site at tick ${brain.stats.ticks})`);
        }
        if (trace) {
          const s = `${brain.phase} ${brain.descending ?? ''}`;
          if (s !== lastPhase || brain.stats.ticks % 10 === 0) console.log(`  t ${String(brain.stats.ticks).padStart(4)} ${s.padEnd(22)} at ${rel(body.pos)} ${hdist(body.pos, centre).toFixed(1).padStart(5)} out, vy ${body.vel.y.toFixed(2)} h ${h.toFixed(2)}${body.collidedHorizontally ? ' HIT' : ''}`);
          lastPhase = s;
          for (const n of notes.splice(0)) console.log(`      ${relNote(n)}`);
        }
        return false;
      },
    },
  );
  if (trace) for (const n of notes.splice(0)) console.log(`      ${relNote(n)}`);
  const at = r.end?.landedAt ?? r.body.pos;
  const off = hdist(at, centre);
  const up = at.y - siteTop;
  const onSite = r.end !== undefined && (site.cells?.has(columnKey(Math.floor(at.x), Math.floor(at.z))) ?? off <= site.half) && Math.abs(up) < 0.6 && !r.wet;
  return {
    label,
    end: r.end ? (r.end.ok ? 'landed' : (r.end.reason ?? '?')) : `no end (${r.phase})`,
    onSite,
    off,
    up,
    ticks: r.ticks,
    damage,
    hits: r.hits,
    vy: lastAir.vy,
    h: lastAir.h,
    descents: `${r.stats.descents.join('; ')}${r.end && !r.end.ok && r.end.why ? `; ${r.end.why}` : ''}`,
    goArounds: r.stats.goArounds,
    rockets: r.stats.rockets,
    style: r.stats.landStyle ?? '-',
    tickMs: tickN ? tickSum / tickN : 0,
    tickMaxMs: tickMax,
  };
}

const headingsArg = arg('headings', 'realm');
const headings = headingsArg === 'realm' ? [fix.heading] : headingsArg === 'compass' ? Array.from({ length: 8 }, (_, k) => (fix.heading + k * 45) % 360) : headingsArg.split(',').map(Number);
const aboves = arg('above', '72,77,82').split(',').map(Number);
const holds: (number | undefined)[] = has('no-hold') ? [undefined] : arg('hold', '20,40').split(',').map(Number);
const N = Number(arg('n', '2'));
const TRACE = has('trace') ? Number(arg('trace', '0')) : undefined;

console.log(`[land-site-probe] the site: ${site.cells?.size ?? 1} cells, half ${site.half.toFixed(1)}, ${(site.alternatives ?? []).length} alternatives; the goal ${Math.round(hdist(fix.goal, fix.site))} blocks from it, ${fix.site.y - fix.goal.y} under its floor; ${LAND_SWITCH.clear ? 'the descent as it is' : 'the descent as before Track F11 (--old)'}`);
for (const kitName of arg('kit', 'crafted').split(',')) {
  for (const modelName of arg('model', 'plain').split(',')) {
    const kit = burnRange(flightOf[kitName] ?? 0);
    const model = modelName === 'kit' && (flightOf[kitName] ?? 0) > 0 ? kit : undefined;
    const rows: Row[] = [];
    let k = 0;
    for (const [si, s0] of sites.entries()) {
      site = s0;
      siteTop = s0.top;
      centre = { x: s0.x, z: s0.z };
      for (const [hi, heading] of headings.entries()) {
        for (const above of aboves) {
          for (const hold of holds) {
            for (let s = 0; s < N; s++) {
              const label = `#${k} ${has('sites') ? `site ${si + 1} (${s0.cells?.size ?? 1} cells), ` : ''}heading ${hi === 0 ? "the fixture's" : `+${hi * 45}`.padStart(13)}, ${above} over, ${hold === undefined ? 'no hold' : `hold ${hold}`}`;
              const row = await fly(label, heading, above, hold, 11 + k, kit, model, TRACE === k);
              rows.push(row);
              if (!has('quiet')) console.log(`${row.label.padEnd(52)} ${row.end.padEnd(11)} ${row.onSite ? 'ON THE SITE' : 'off the site'} ${row.off.toFixed(1).padStart(5)} from its centre, ${row.up >= 0 ? '+' : ''}${row.up.toFixed(1)} over its floor; ${String(row.ticks).padStart(4)} ticks, touchdown vy ${row.vy.toFixed(2)} h ${row.h.toFixed(2)}, damage ${row.damage.toFixed(1)}, ${row.hits} hits, ${row.goArounds} go-arounds, ${row.rockets} rockets, ${row.style}; ${row.descents}`);
              k++;
            }
          }
        }
      }
    }
    const on = rows.filter((r) => r.onSite);
    const within2 = on.filter((r) => r.off <= 2);
    const range = (xs: number[], d = 1): string => (xs.length ? `${Math.min(...xs).toFixed(d)} to ${Math.max(...xs).toFixed(d)} (mean ${(xs.reduce((a, c) => a + c, 0) / xs.length).toFixed(d)})` : '-');
    console.log(`[land-site-probe] kit ${kitName} (${kit.min} to ${kit.max}), the brain told ${model ? `${model.min} to ${model.max}` : 'nothing (9 to 21)'}: n ${rows.length}; on the site's floor ${on.length}, within 2 of its centre ${within2.length}; off it ${rows.length - on.length} (${range(rows.filter((r) => !r.onSite).map((r) => r.off))} from the centre, ${range(rows.filter((r) => !r.onSite).map((r) => r.up))} over the floor); damage ${range(rows.map((r) => r.damage))}, flights with damage ${rows.filter((r) => r.damage > 0).length}; hits ${rows.reduce((a, r) => a + r.hits, 0)}; touchdown vy ${range(rows.map((r) => r.vy), 2)}, h ${range(rows.map((r) => r.h), 2)}; ticks ${range(rows.map((r) => r.ticks), 0)}; brake landings ${rows.filter((r) => r.style === 'brake').length}, flare ${rows.filter((r) => r.style === 'flare').length}; go-arounds ${rows.reduce((a, r) => a + r.goArounds, 0)}; rockets ${range(rows.map((r) => r.rockets))}${has('time') ? `; a tick took ${(rows.reduce((a, r) => a + r.tickMs, 0) / rows.length).toFixed(3)} ms on average, ${Math.max(...rows.map((r) => r.tickMaxMs)).toFixed(1)} ms at the longest` : ''}`);
  }
}
