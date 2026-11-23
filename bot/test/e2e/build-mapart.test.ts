// e2e (tag @bds), Track B7 (docs/build.md "Map art"; ADR 0132): the Bedrock map grid and map colours measured on the
// server, and a map art file built at a map-aligned corner from shulker boxes, stopped and resumed. On a flat, peaceful
// server with the truth pack (bds-build by default; BUILD_BDS_PORT / BUILD_BDS_CONTAINER point it at another one).
//
// The grid: the bot is given an empty map at several places (negative coordinates too) and uses it; the server's map
// packet (clientbound_map_item_data) gives the map's origin and scale. The colours: every kind of the map art's palette is
// set on the flat ground in five rows (level with the block north of it, 1 and 3 higher, 1 and 3 lower), a fresh map
// is made over them and its pixels are read and compared with Java's map colours (base x 220/255 level, x 255/255
// higher, x 180/255 lower).
//
// The build (BUILD_MAPART_FILE: a `.litematic` map art; it is never committed): `!build file <name> map <x> <z> fetch` at
// a map area far from home, fed from shulker boxes dropped by the bot for the first stretch, the rest in home chests so
// the whole bill is covered; one `!build stop` and `!build resume`, then it runs as long as BUILD_MAPART_S allows (840
// s by default: one loop of 15 minutes with the setup), is stopped, and every cell placed is compared with the file.
//   BUILD_MAPART=1        run it
//   BUILD_MAPART_FILE     the map art (without it only the grid and the colours are measured)
//   BUILD_MAPART_S        seconds of building (840)
//   BUILD_MAPART_OUT      a file each run's lines are appended to
//   BUILD_MAPART_VALLEY=1 Track B8 (ADR 0133): `... map <x> <z> valley fetch`: the art re-heighted with its supports; after
//                         the run a map of the built part is made and its pixels compared with the art's expected ones
//   BUILD_MAPART_MEASURE=0 skip the grid and colour measurements (Track B7's; they take about 3 minutes)
//   BUILD_MAPART_SHADE=1  Track B8: measure the shade of steps of 1 to 3 up and down at both pixel parities
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { randomInt } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeCounts } from '../../src/chat/commands-build.ts';
import { homeControlOf } from '../../src/chat/commands-home.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { readStructure } from '../../src/skills/build/formats/index.ts';
import { tiles } from '../../src/skills/build/job.ts';
import { MAP_COLOURS, mapCorner, mapLayout, mapText, MAP_SIDE, pixelColour, stepShade, type Shade } from '../../src/skills/build/mapart.ts';
import { parseSpec } from '../../src/skills/build/spec.ts';
import { BuildProgress, loadProgress } from '../../src/skills/build/progress.ts';
import { resolveBlocks } from '../../src/skills/build/states.ts';
import { isShulkerBox } from '../../src/skills/container/chest.ts';
import { SECTION_CELLS } from '../../src/skills/build/types.ts';
import { useItemTransaction } from '../../src/skills/survival/eat.ts';
import { wireItemOf } from '../../src/skills/place/place.ts';
import type { Hotbar } from '../../src/world/hotbar.ts';
import { E2E, FEET_Y, prepareServer, sleep, startBuildBot, teleport, truthLoaded, until, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const RUN = E2E && process.env.BUILD_MAPART === '1';
const FILE = process.env.BUILD_MAPART_FILE;
const BUILD_S = Number(process.env.BUILD_MAPART_S ?? 840);
const OUT = process.env.BUILD_MAPART_OUT;
/** The cells of the first sections whose blocks the handed-over boxes hold (the rest are in the home chests). */
const HANDED_CELLS = Number(process.env.BUILD_MAPART_HANDED ?? 6144);
const VALLEY = process.env.BUILD_MAPART_VALLEY === '1';
const MEASURE = process.env.BUILD_MAPART_MEASURE !== '0';
const SHADE = process.env.BUILD_MAPART_SHADE === '1';
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

/** Java's map colours (MapColor base RGB) of the map art's kinds and common map art blocks, by Bedrock name (Track B8: in mapart.ts). */
const JAVA_BASE = MAP_COLOURS;
/** The rows of the colour test: the block's height against the grass north of it. */
const ROWS: { name: string; dy: number; java: number }[] = [
  { name: 'level', dy: 0, java: 220 },
  { name: 'up 1', dy: 1, java: 255 },
  { name: 'down 1', dy: -1, java: 180 },
  { name: 'up 3', dy: 3, java: 255 },
  { name: 'down 3', dy: -3, java: 180 },
];

interface MapPacket {
  map_id: bigint | number;
  origin?: { x: number; y: number; z: number };
  scale?: number;
  width?: number;
  height?: number;
  x_offset?: number;
  y_offset?: number;
  pixels?: number[];
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const rgba = (v: number): [number, number, number, number] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];

describe.skipIf(!RUN)('@bds build: the Bedrock map grid and colours, and a map art built at a map-aligned corner (Track B7)', () => {
  const notes: string[] = [];
  const builds = RUN ? mkdtempSync(join(tmpdir(), 'bedrockbot-builds-')) : '';
  let bot: BuildBot | undefined;
  const packets: MapPacket[] = [];
  // the map art: a map square far out (k: the map's centre at 128 k); the bot stands at the art's middle at the command,
  // the home is south of it
  const art = FILE
    ? (() => {
        const name = basename(FILE).replace(/\.litematic$/, '');
        const s = readStructure(readFileSync(FILE), 'litematic', name);
        const corner = { x: 128 * (370 + randomInt(30)) - 64, z: 128 * (370 + randomInt(30)) - 64 };
        const layout = mapLayout(s.size, corner);
        // Track B8: a valley build starts from the north-west (whole tiles of the art first; the south edge's row of 1 last)
        const mid = VALLEY ? { x: layout.x + 40, y: F, z: layout.z + 40 } : { x: layout.x + Math.floor(s.size.x / 2), y: F, z: layout.z + Math.floor(s.size.z / 2) };
        return { name, s, corner, layout, mid, home: { x: mid.x, y: F, z: layout.z + s.size.z + 6 } };
      })()
    : undefined;

  beforeAll(async () => {
    if (FILE) copyFileSync(FILE, join(builds, basename(FILE)));
    await prepareServer();
    bot = await startBuildBot('Mapart', builds, art ? { home: art.home } : {}, { values: { buildProgress: join(builds, 'progress.json') }, settings: { buildColumnMax: 32, autoUnload: false, autoMend: false } });
    bot.conn.on('clientbound_map_item_data', (p) => packets.push(p as unknown as MapPacket));
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      await bot.truth.ok('clear', [bot.name]).catch(() => undefined);
      await bot.stop().catch(() => undefined);
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-mapart e2e]\n  ${notes.join('\n  ')}`);
    if (OUT) appendFileSync(OUT, `${new Date().toISOString()}\n  ${notes.join('\n  ')}\n`);
  }, 300_000);

  /** Use an empty map where the bot stands: the map packet with an origin (and the pixels that come with it, joined). */
  async function useMap(b: BuildBot): Promise<{ id: string; origin: Vec3; scale: number | undefined; pixels: Int32Array; got: number }> {
    const mob = b.built.mobility!;
    await b.truth.ok('clear', [b.name]);
    await sleep(300);
    await b.truth.ok('give', [b.name, 'empty_map', 1]);
    const slot = await until(() => {
      const i = mob.world.inventory.slots.findIndex((s, k) => k < 9 && s?.name === 'empty_map');
      return i >= 0 ? i : undefined;
    }, 10_000, 'the empty map in the hotbar');
    const hotbar = (mob.skills as unknown as { parts: { hotbar?: Hotbar } }).parts.hotbar;
    if (mob.world.inventory.selected !== slot) {
      if (!hotbar) throw new Error('no hotbar to select the map with');
      hotbar.select(slot);
      await mob.loop.waitTicks(4);
    }
    const from = packets.length;
    const p = mob.loop.state.pos;
    b.conn.queue('inventory_transaction', useItemTransaction({ hotbarSlot: slot, held: wireItemOf(mob.world.inventory.slots[slot], mob.world.inventory.rawItem(0, slot)), eye: { x: p.x, y: p.y + 1.62, z: p.z } }));
    await until(() => (mob.world.inventory.slots.some((s) => s?.name === 'filled_map') ? true : undefined), 10_000, 'the filled map');
    const filled = mob.world.inventory.slots.findIndex((s) => s?.name === 'filled_map');
    const raw = mob.world.inventory.rawItem(0, filled);
    // the map's id: from a packet that came, or from the item's NBT (then the map's data is asked for)
    let pk = await until(() => packets.slice(from).find((x) => x.origin !== undefined), 3_000, 'a map packet').catch(() => undefined);
    if (!pk) {
      const s = json(raw);
      const m = /"map_uuid":\{"type":"long","value":(\[[^\]]+\]|"?-?\d+"?)/.exec(s) ?? /"map_uuid":(\[[^\]]+\]|"?-?\d+"?)/.exec(s);
      notes.push(`the filled map item: ${s.slice(0, 400)}`);
      if (!m) throw new Error('no map_uuid on the filled map');
      const v = JSON.parse(m[1]!) as unknown;
      const id = Array.isArray(v) ? BigInt.asIntN(64, (BigInt(Number(v[0]) | 0) << 32n) | BigInt(Number(v[1]) >>> 0)) : BigInt(String(v));
      b.conn.queue('map_info_request', { map_id: id, client_pixels: [] });
      pk = await until(() => packets.slice(from).find((x) => x.origin !== undefined), 10_000, 'a map packet after map_info_request');
    }
    const id = String(pk.map_id);
    // the pixels: every packet of this map within 4 s, joined by their offsets
    await sleep(4000);
    const pixels = new Int32Array(MAP_SIDE * MAP_SIDE);
    let got = 0;
    for (const q of packets.slice(from)) {
      if (String(q.map_id) !== id || !q.pixels?.length || !q.width) continue;
      const w = q.width;
      q.pixels.forEach((v, i) => {
        const x = (q.x_offset ?? 0) + (i % w);
        const y = (q.y_offset ?? 0) + Math.floor(i / w);
        if (x < MAP_SIDE && y < MAP_SIDE) {
          pixels[y * MAP_SIDE + x] = v;
          got++;
        }
      });
    }
    return { id, origin: pk.origin!, scale: pk.scale, pixels, got };
  }

  /**
   * Track B8 (ADR 0133): a map made over the built part, its pixels against the art's. Each column whose top among the
   * placed cells is an art block (a support is never a top) must show that block's map colour with the shade its height
   * against the column north of it gives (that column's top placed cell, or the flat ground when nothing is placed there).
   */
  async function compareMap(b: BuildBot, cells: readonly { pos: Vec3; name: string }[], prog: BuildProgress, supports: ReadonlySet<string>): Promise<void> {
    const top = new Map<string, { x: number; z: number; y: number; name: string; art: boolean }>();
    for (const c of cells) {
      if (!prog.has(c.pos)) continue;
      const k = `${c.pos.x},${c.pos.z}`;
      const t = top.get(k);
      if (!t || c.pos.y > t.y) top.set(k, { x: c.pos.x, z: c.pos.z, y: c.pos.y, name: c.name, art: !supports.has(`${c.pos.x},${c.pos.y},${c.pos.z}`) });
    }
    // the map square holding the most placed art columns
    const bySquare = new Map<string, { n: number; x: number; z: number }>();
    for (const t of top.values()) {
      if (!t.art) continue;
      const q = mapCorner(t.x, t.z);
      const e = bySquare.get(`${q.x},${q.z}`) ?? { n: 0, x: 0, z: 0 };
      bySquare.set(`${q.x},${q.z}`, { n: e.n + 1, x: e.x + t.x, z: e.z + t.z });
    }
    const best = [...bySquare].sort((p, q) => q[1].n - p[1].n)[0];
    if (!best) {
      notes.push('map: no art block placed to compare');
      return;
    }
    const [sx, sz] = best[0].split(',').map(Number) as [number, number];
    const inSquare = (x: number, z: number) => x >= sx && x < sx + MAP_SIDE && z >= sz && z < sz + MAP_SIDE;
    // stand on the ground in that square off the placed cells, nearest the middle of what was placed there
    const mx = Math.round(best[1].x / best[1].n);
    const mz = Math.round(best[1].z / best[1].n);
    let spot: Vec3 | undefined;
    for (let r = 0; r < 64 && !spot; r++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        for (const dz of [-r, r]) {
          const x = mx + dx;
          const z = mz + dz;
          let free = inSquare(x, z);
          for (let ax = -1; ax <= 1 && free; ax++) for (let az = -1; az <= 1 && free; az++) if (top.has(`${x + ax},${z + az}`)) free = false;
          if (free) {
            spot = { x, y: F, z };
            break;
          }
        }
      }
    }
    if (!spot) throw new Error('map: no free ground in the square to stand on');
    await teleport(b, centre(spot));
    await sleep(3000);
    const m = await useMap(b);
    let n = 0;
    let same = 0;
    let missing = 0;
    const bad: string[] = [];
    const badAt: { x: number; y: number; z: number }[] = [];
    for (const t of top.values()) {
      if (!t.art || !inSquare(t.x, t.z)) continue;
      const north = top.get(`${t.x},${t.z - 1}`);
      const ny = north ? north.y : F - 1;
      // what a Bedrock map shows for the step (a step of 1 shades at one parity only: stepShade)
      const shade: Shade = stepShade(t.y - ny, t.x, t.z, 'bedrock');
      const want = pixelColour(t.name, shade);
      if (!want) continue;
      const px = t.x - (m.origin.x - 64);
      const pz = t.z - (m.origin.z - 64);
      if (px < 0 || pz < 0 || px >= MAP_SIDE || pz >= MAP_SIDE) continue;
      const got = rgba(m.pixels[pz * MAP_SIDE + px]!);
      n++;
      if (got[3] === 0) {
        missing++;
        continue;
      }
      const d = Math.max(...want.map((c, j) => Math.abs(c - got[j]!)));
      if (d <= 3) same++;
      else {
        badAt.push(t);
        if (bad.length < 6) bad.push(`${t.x} ${t.y} ${t.z} ${t.name} ${shade}: ${got.slice(0, 3).join(',')} (want ${want.join(',')})`);
      }
    }
    // what the world holds around the first differing pixels (the server's blocks, not the bot's view)
    for (const t of badAt.slice(0, 3)) {
      const d = await b.truth.blocksDiff({ x: t.x - 1, y: F - 1, z: t.z - 1 }, { x: t.x + 1, y: t.y + 2, z: t.z + 1 }, (c) => (c.y === F - 1 ? 'grass_block' : 'air'));
      notes.push(`map: around ${t.x} ${t.y} ${t.z}: ${JSON.stringify(d.first)}`);
    }
    const rows = new Map<number, number>();
    for (const t of badAt) rows.set(t.z, (rows.get(t.z) ?? 0) + 1);
    if (badAt.length) notes.push(`map: differing pixels by z: ${[...rows].map(([z, k]) => `${z}: ${k}`).join(', ')}`);
    notes.push(`map ${m.id} of the square from ${sx} ${sz} (origin ${m.origin.x} ${m.origin.z}, ${m.got} pixels, made at ${spot.x} ${spot.z}): ${n} art pixels compared, ${same} with the art's colour and shade, ${n - same - missing} other, ${missing} not drawn${bad.length ? `: ${bad.join(' | ')}` : ''}`);
    expect(n).toBeGreaterThan(0);
    expect(n - same - missing).toBe(0);
    expect(same).toBeGreaterThan(0);
  }

  it.skipIf(!MEASURE)('measures the map grid: the map a player makes covers which 128 x 128 square', async () => {
    const b = bot!;
    const spots: Vec3[] = [
      { x: 41_000, y: F, z: 41_000 },
      { x: 41_063, y: F, z: 41_100 },
      { x: 41_064, y: F, z: 40_935 },
      { x: 41_023, y: F, z: 41_023 },
      { x: 41_024, y: F, z: 41_024 },
      { x: -300, y: F, z: -700 },
    ];
    const seen: string[] = [];
    for (const s of spots) {
      await teleport(b, centre(s));
      const m = await useMap(b);
      const java = mapCorner(s.x, s.z, -64);
      seen.push(`at ${s.x} ${s.z}: origin ${m.origin.x} ${m.origin.y} ${m.origin.z}, scale ${m.scale}, ${m.got} pixels; Java's map there runs from ${java.x} ${java.z}`);
    }
    notes.push(`grid: ${seen.join(' | ')}`);
    expect(seen.length).toBe(spots.length);
  }, 600_000);

  it.skipIf(!MEASURE)('measures the map colours of the map art palette and common map art blocks (5 heights each)', async () => {
    const b = bot!;
    const kinds = Object.keys(JAVA_BASE);
    const PER = 40; // kinds a band (2 columns each)
    const BAND = 3 * ROWS.length + 3;
    const bands = Math.ceil(kinds.length / PER);
    // a map area with room: its corner from the map made there (its origin is its centre: checked by the pixels below)
    const at = { x: 42_000, y: F, z: 42_000 };
    await teleport(b, centre(at));
    const probe = await useMap(b);
    const gx = probe.origin.x - 64 + 20;
    const gz = probe.origin.z - 64 + 12;
    const x2 = gx + 2 * PER + 4;
    const z2 = gz + BAND * bands + 4;
    // flat grass over the test patch
    await truthLoaded(b.truth, 'fill', [gx - 4, F - 3, gz - 4, x2, F - 2, z2, 'dirt']);
    await truthLoaded(b.truth, 'fill', [gx - 4, F - 1, gz - 4, x2, F - 1, z2, 'grass_block']);
    await truthLoaded(b.truth, 'fill', [gx - 4, F, gz - 4, x2, F + 6, z2, 'air']);
    const cell = (i: number, ri: number) => ({ x: gx + 2 * (i % PER), z: gz + BAND * Math.floor(i / PER) + 3 * ri });
    for (const [ri, r] of ROWS.entries()) {
      for (const [i, k] of kinds.entries()) {
        const { x, z } = cell(i, ri);
        // higher: the block |dy| over the grass north of it (air under it); lower: the grass north of it raised |dy|
        if (r.dy > 0) await truthLoaded(b.truth, 'set', [x, F - 1 + r.dy, z, k]);
        else {
          for (let yy = F; yy < F - 1 - r.dy; yy++) await truthLoaded(b.truth, 'set', [x, yy, z - 1, 'dirt']);
          if (r.dy < 0) await truthLoaded(b.truth, 'set', [x, F - 1 - r.dy, z - 1, 'grass_block']);
          await truthLoaded(b.truth, 'set', [x, F - 1, z, k]);
        }
      }
    }
    await sleep(1000);
    await teleport(b, centre({ x: gx + PER, y: F, z: gz + BAND }));
    const m = await useMap(b);
    const pix = (x: number, z: number): [number, number, number, number] => rgba(m.pixels[(z - (m.origin.z - 64)) * MAP_SIDE + (x - (m.origin.x - 64))]!);
    const grass = ROWS.map((_r, ri) => pix(gx - 2, gz + 3 * ri).slice(0, 3).join(','));
    notes.push(`colours: map ${m.id} origin ${m.origin.x} ${m.origin.z}, ${m.got} pixels; grass ${grass[0]} (Java level ${JAVA_BASE.grass_block!.map((c) => Math.floor((c * 220) / 255)).join(',')})`);
    const table: string[] = [];
    const differ: string[] = [];
    for (const [i, k] of kinds.entries()) {
      const cells = ROWS.map((r, ri) => {
        const { x, z } = cell(i, ri);
        const got = pix(x, z);
        const want = JAVA_BASE[k]!.map((c) => Math.floor((c * r.java) / 255));
        const d = Math.max(...want.map((c, j) => Math.abs(c - got[j]!)));
        if (d > 3 && !differ.includes(k)) differ.push(k);
        return `${r.name} ${got.slice(0, 3).join(',')}${d > 3 ? ` (Java ${want.join(',')})` : ''}`;
      });
      table.push(`${k}: ${cells.join('; ')}`);
    }
    notes.push(`colour table:\n    ${table.join('\n    ')}`);
    notes.push(`colours unlike Java's: ${differ.join(', ') || 'none'}`);
    expect(m.got).toBeGreaterThan(0);
  }, 600_000);

  // Track B8: the shade of a step by its size and the pixel's parity (x + z even or odd). Java's map shades with
  // (dy * 4/5 + ((x + z) & 1 - 0.5) * 0.4) against 0.6, so a step of 1 sits on the threshold at one parity; this
  // measures where Bedrock puts it. Stone over flat grass; steps -3..3 at both parities, 6 samples each.
  it.skipIf(!SHADE)('measures the shade of a step of 1, 2 and 3, up and down, at both parities', async () => {
    const b = bot!;
    const at = { x: 43_000, y: F, z: 43_000 };
    await teleport(b, centre(at));
    const probe = await useMap(b);
    const gx = probe.origin.x - 64 + 20;
    const gz = probe.origin.z - 64 + 20;
    const steps = [-3, -2, -1, 0, 1, 2, 3];
    await truthLoaded(b.truth, 'fill', [gx - 4, F - 3, gz - 4, gx + 80, F - 2, gz + 40, 'dirt']);
    await truthLoaded(b.truth, 'fill', [gx - 4, F - 1, gz - 4, gx + 80, F - 1, gz + 40, 'grass_block']);
    await truthLoaded(b.truth, 'fill', [gx - 4, F, gz - 4, gx + 80, F + 6, gz + 40, 'air']);
    const cells: { x: number; z: number; dy: number }[] = [];
    for (const [si, dy] of steps.entries()) for (let k = 0; k < 12; k++) cells.push({ x: gx + 2 * k + (k % 2 === 0 ? 0 : 1) + 26 * Math.floor(si / 4), z: gz + 4 * (si % 4), dy });
    // two rows of each step: z even and z odd, x of both parities in each
    const all = cells.flatMap((c) => [c, { ...c, z: c.z + 17 }]);
    for (const c of all) {
      if (c.dy > 0) await truthLoaded(b.truth, 'set', [c.x, F - 1 + c.dy, c.z, 'stone']);
      else {
        for (let yy = F; yy < F - 1 - c.dy; yy++) await truthLoaded(b.truth, 'set', [c.x, yy, c.z - 1, 'dirt']);
        if (c.dy < 0) await truthLoaded(b.truth, 'set', [c.x, F - 1 - c.dy, c.z - 1, 'grass_block']);
        await truthLoaded(b.truth, 'set', [c.x, F - 1, c.z, 'stone']);
      }
    }
    await sleep(1000);
    await teleport(b, centre({ x: gx + 26, y: F, z: gz + 30 }));
    const m = await useMap(b);
    const pix = (x: number, z: number) => rgba(m.pixels[(z - (m.origin.z - 64)) * MAP_SIDE + (x - (m.origin.x - 64))]!)[0];
    const shadeOf = (r: number) => (Math.abs(r - 112) <= 2 ? 'higher' : Math.abs(r - 96) <= 2 ? 'level' : Math.abs(r - 79) <= 2 ? 'lower' : `?${r}`);
    const table = new Map<string, Map<string, number>>();
    for (const c of all) {
      const k = `step ${c.dy > 0 ? '+' : ''}${c.dy} at x+z ${(c.x + c.z) & 1 ? 'odd' : 'even'}`;
      const t = table.get(k) ?? new Map<string, number>();
      const s = shadeOf(pix(c.x, c.z));
      t.set(s, (t.get(s) ?? 0) + 1);
      table.set(k, t);
    }
    notes.push(`shades (stone 112 higher, 96 level, 79 lower; map ${m.id}):\n    ${[...table].sort().map(([k, t]) => `${k}: ${[...t].map(([s, n]) => `${s} x ${n}`).join(', ')}`).join('\n    ')}`);
    expect(m.got).toBeGreaterThan(0);
  }, 600_000);
  it.skipIf(!FILE)('builds the map art at a map-aligned corner from shulker boxes, with a stop and a resume', async () => {
    const b = bot!;
    const { name, s, corner, layout, mid, home } = art!;
    const resolved = resolveBlocks(s.blocks);
    notes.push(`file: ${s.blocks.length} blocks in ${s.size.x}x${s.size.y}x${s.size.z}, ${resolved.refused.length} refused, ${(s.unknown ?? []).length} unknown kinds`);
    // the home south of the art: two chests (three for a valley build: its supports too) with the boxes of what the
    // carried ones lack
    const chests = [
      { x: home.x - 2, y: F, z: home.z + 2 },
      { x: home.x + 2, y: F, z: home.z + 2 },
      ...(VALLEY ? [{ x: home.x + 8, y: F, z: home.z + 2 }] : []),
    ];
    // the art's cells as the build places them (min corner at layout x, ground y + 1 on the flat world), in section order
    const at: Vec3 = { x: layout.x, y: F, z: layout.z };
    // Track B8: the valley art's cells and supports as the bot's own spec makes them (the flat ground: the world's blocks
    // a support clicks are those under the art's lowest layer)
    const vs = VALLEY ? parseSpec(['file', name, 'map', String(corner.x + 10), String(F), String(corner.z + 10), 'valley'], { feet: mid, load: () => s, solid: (_x, y) => y <= F - 1 }) : undefined;
    if (vs && !vs.ok) throw new Error(vs.error);
    const valleyPlaces = vs?.ok ? vs.spec.places : undefined;
    const supportKeys = new Set((valleyPlaces ?? []).slice(s.blocks.length).map((p) => `${p.pos.x},${p.pos.y},${p.pos.z}`));
    if (vs?.ok) notes.push(`valley spec: ${vs.spec.label}; ${vs.spec.note ?? ''}; ${s.blocks.length} art blocks, ${supportKeys.size} supports`);
    const cells = valleyPlaces
      ? resolveBlocks(valleyPlaces).cells.map((r) => ({ pos: r.block.pos, item: r.placement.item, name: r.block.name }))
      : resolved.cells.map((r) => ({ pos: { x: at.x + r.block.pos.x, y: at.y + r.block.pos.y, z: at.z + r.block.pos.z }, item: r.placement.item, name: r.block.name }));
    const box = { min: { x: at.x, y: cells.reduce((a, c) => Math.min(a, c.pos.y), Infinity), z: at.z }, max: { x: at.x + s.size.x - 1, y: cells.reduce((a, c) => Math.max(a, c.pos.y), -Infinity), z: at.z + s.size.z - 1 } };
    const order = tiles(cells, box, mid, SECTION_CELLS).flat();
    const carriedPart = order.slice(0, HANDED_CELLS);
    const count = (list: readonly { item: string }[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const c of list) m.set(c.item, (m.get(c.item) ?? 0) + 1);
      return m;
    };
    const all = count(cells);
    const handed = count(carriedPart);
    const rest = new Map([...all].map(([k, n]) => [k, n - (handed.get(k) ?? 0)] as const).filter(([, n]) => n > 0));
    const stacksOf = (m: Map<string, number>): [string, number][] => [...m].flatMap(([k, n]) => [...Array(Math.ceil(n / 64)).keys()].map((i) => [k, Math.min(64, n - 64 * i)] as [string, number]));
    const boxesOf = (m: Map<string, number>): [string, number][][] => {
      const st = stacksOf(m);
      return [...Array(Math.ceil(st.length / 27)).keys()].map((i) => st.slice(27 * i, 27 * i + 27));
    };
    const handedBoxes = boxesOf(handed);
    const homeBoxes = boxesOf(rest);
    notes.push(`map: corner ${corner.x} ${corner.z} (${mapText(layout)}), home at ${home.x} ${home.z}; ${handedBoxes.length} boxes handed over (${HANDED_CELLS} cells' worth), ${homeBoxes.length} in the home chests`);
    expect(handedBoxes.length).toBeLessThanOrEqual(12);
    expect(homeBoxes.length).toBeLessThanOrEqual(27 * chests.length);

    // the home chests: the boxes dropped on the bot (it picks them up), carried to a chest and put in, a chest's worth a go
    const mob = b.built.mobility!;
    await teleport(b, centre({ x: home.x, y: F, z: home.z - 3 }));
    await sleep(2000);
    for (const c of chests) await truthLoaded(b.truth, 'set', [c.x, c.y, c.z, 'chest']);
    const boxArgs = (stacks: [string, number][]): (string | number)[] => stacks.flatMap(([k, n]) => [k, n, 1]);
    const boxSlots = (): number[] => mob.world.inventory.slots.flatMap((x, k) => (k < 36 && x && isShulkerBox(x.name) ? [k] : []));
    const inChests = async (): Promise<number> => {
      let n = 0;
      for (const c of chests) {
        const r = await truthLoaded<{ counts?: Record<string, number> }>(b.truth, 'container', [c.x, c.y, c.z]);
        n += Object.entries(r.counts ?? {}).filter(([k]) => k.includes('shulker_box')).reduce((a, [, v]) => a + v, 0);
      }
      return n;
    };
    await b.truth.ok('clear', [b.name]);
    for (const [ci, c] of chests.entries()) {
      const part = homeBoxes.filter((_bx, i) => i % chests.length === ci);
      const spot = { x: c.x, y: F, z: c.z - 4 };
      await teleport(b, centre(spot));
      await sleep(500);
      for (const [i, bx] of part.entries()) {
        await truthLoaded(b.truth, 'boxmix', [spot.x + 2 + (i % 3), F, spot.z - 1 + (Math.floor(i / 3) % 3), ...boxArgs(bx)]);
        await sleep(250);
      }
      const lying = await until(async () => {
        const r = await b.truth.ok<{ items: { typeId: string; amount: number }[] }>('boxitems', [spot.x + 0.5, F, spot.z + 0.5, 12]);
        const n = r.items.filter((x) => x.typeId.includes('shulker_box')).reduce((a, x) => a + x.amount, 0);
        return n + boxSlots().length >= part.length ? n : undefined;
      }, 20_000, `${part.length} boxes lying or carried`).catch(async (e: unknown) => {
        const r = await b.truth.ok<{ items: { typeId: string; amount: number }[] }>('boxitems', [spot.x + 0.5, F, spot.z + 0.5, 40]);
        notes.push(`chest ${ci}: ${boxSlots().length} carried, lying ${JSON.stringify(r.items)}; ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      });
      for (let k = 0; k < 4 && boxSlots().length < part.length; k++) {
        await mob.skills.collect(8, 100, { origin: centre(spot), filter: (it) => isShulkerBox(it.name) });
        await sleep(500);
      }
      notes.push(`chest ${ci}: ${lying} boxes dropped, ${boxSlots().length} picked up`);
      expect(boxSlots().length).toBe(part.length);
      await teleport(b, centre({ x: c.x, y: F, z: c.z - 2 }));
      await sleep(500);
      const o = await mob.skills.open(c);
      if (!o.ok) throw new Error(`opening the chest: ${o.reason}`);
      const dep = await mob.skills.chest!.depositSlots(o.view, boxSlots().map((k) => ({ slot: k, count: 1 })));
      await mob.skills.closeContainer(o.view);
      if (dep.total !== part.length) throw new Error(`storing the boxes: ${dep.total} of ${part.length} (${dep.reason})`);
    }
    expect(await inChests()).toBe(homeBoxes.length);    await teleport(b, centre(home));
    await b.truth.ok('clear', [b.name]);
    await b.truth.ok('give', [b.name, 'iron_pickaxe', 1]);
    // Track B8: the scaffold blocks a kind the build does not place (the supports are cobblestone)
    await b.truth.ok('give', [b.name, VALLEY ? 'netherrack' : 'cobblestone', 64 * 4]);
    await sleep(800);
    const scan = await homeControlOf(b.task)!.logistics.scan(() => false, { force: true, retry: true });
    const homeHas = homeCounts(b.task);
    notes.push(`home scan: ${scan.found} found, ${scan.read.length} read; holds ${[...homeHas.values()].reduce((a, v) => a + v, 0)} items of ${homeHas.size} kinds`);

    // the boxes handed over, dropped beside the bot at the art's middle (picked up by `!build ... fetch`)
    await teleport(b, centre(mid));
    await sleep(3000);
    for (const [i, bx] of handedBoxes.entries()) {
      await truthLoaded(b.truth, 'boxmix', [mid.x + 3 + (i % 4), F + 3, mid.z - 1 + Math.floor(i / 4), ...boxArgs(bx)]);
      await sleep(200);
    }
    await sleep(6000);

    // the command: the map corner from x z, the y from the ground
    const progressFile = join(builds, 'progress.json');
    const t0 = Date.now();
    let from = b.said.length;
    const vw = VALLEY ? ' valley' : '';
    await b.command(`!build file ${name} map ${corner.x + 10} ${corner.z + 10}${vw} fetch`);
    let start = await b.reply((x) => x.startsWith('building ') || (x.startsWith('build: ') && !x.startsWith('build: picked')), from, 600_000);
    if (start.startsWith('build: map: the ground of ')) {
      // the bot does not see every column of the art from its middle: the y given (the flat ground's)
      notes.push(`without a y (${((Date.now() - t0) / 1000).toFixed(1)} s): ${start}`);
      from = b.said.length;
      await b.command(`!build file ${name} map ${corner.x + 10} ${F} ${corner.z + 10}${vw} fetch`);
      start = await b.reply((x) => x.startsWith('building ') || (x.startsWith('build: ') && !x.startsWith('build: picked')), from, 600_000);
    }
    notes.push(`start (${((Date.now() - t0) / 1000).toFixed(0)} s): ${start} | ${b.said.slice(from).filter((x) => x.startsWith('build: picked')).join(' | ')}`);
    expect(start).toMatch(new RegExp(`^building file ${name} map${vw} at ${layout.x} ${F} ${layout.z} \\(`));
    const work = Number(/: (\d+) to place in/.exec(start)?.[1] ?? 0);
    const placedNow = (): number => Number(/(\d+) \/ (\d+) placed/.exec(b.build.status())?.[1] ?? 0);
    const trace: string[] = [];
    const poll = setInterval(() => trace.push(`${((Date.now() - t0) / 1000).toFixed(0)} s ${placedNow()}`), 60_000);
    let stopAt: number;
    let building: number;
    try {
      // a third of the time, then a stop and a resume
      await sleep((BUILD_S * 1000) / 3);
      const p1 = placedNow();
      stopAt = (Date.now() - t0) / 1000;
      notes.push(`stop at ${stopAt.toFixed(0)} s (${p1} placed): ${b.build.stop()}`);
      const ts = Date.now();
      await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 300_000, 'the stop to end', 250);
      const pause = (Date.now() - ts) / 1000;
      from = b.said.length;
      await b.command('!build resume');
      const resumed = await b.reply((x) => x.startsWith('resuming build ') || x.startsWith('build: '), from, 300_000);
      notes.push(`resume ${pause.toFixed(1)} s after the stop: ${resumed}`);
      expect(resumed).toMatch(new RegExp(`^resuming build file ${name} map${vw} at `));
      const tResume = Date.now();
      await sleep(Math.max(0, BUILD_S * 1000 - (Date.now() - t0)));
      building = stopAt * 1000 + (Date.now() - tResume);
    } finally {
      clearInterval(poll);
    }
    const placed = placedNow();
    const s1 = (Date.now() - t0) / 1000;
    notes.push(`end of the loop at ${s1.toFixed(0)} s: ${b.build.status()} | ${b.build.stop()}`);
    await until(() => (b.processes.userProcesses().length === 0 ? true : undefined), 300_000, 'the last stop to end', 250);
    notes.push(`progress: ${trace.join(' | ')}`);
    notes.push(`fetch steps: ${b.build.fetched.join(' | ')}`);
    notes.push(`logs: ${b.logs.filter((l) => / build: (time |fetch round \d+ .* done|job |section \d+ of \d+ \(|resum|.*shulker box|.*left out)/.test(l)).slice(-40).join(' || ')}`);
    if (OUT) writeFileSync(`${OUT}.log`, `${b.logs.join('\n')}\n--- said\n${b.said.join('\n')}\n`);
    // every cell the progress file marks placed holds the art's block
    const data = loadProgress(progressFile);
    expect(data).toBeDefined();
    const prog = new BuildProgress(undefined, data!);
    const want = new Map(cells.map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c.name] as const));
    let compared = 0;
    let diffs = 0;
    const firsts: unknown[] = [];
    // the cells marked, in 32 x 32 tiles: the bot stands by each tile while its cells are compared (chunks loaded)
    const done = cells.filter((c) => prog.has(c.pos));
    const byTile = new Map<string, typeof done>();
    for (const c of done) {
      const k = `${Math.floor((c.pos.x - box.min.x) / 32)},${Math.floor((c.pos.z - box.min.z) / 32)}`;
      byTile.set(k, [...(byTile.get(k) ?? []), c]);
    }
    for (const list of byTile.values()) {
      const lo = { x: Math.min(...list.map((c) => c.pos.x)), y: Math.min(...list.map((c) => c.pos.y)), z: Math.min(...list.map((c) => c.pos.z)) };
      const hi = { x: Math.max(...list.map((c) => c.pos.x)), y: Math.max(...list.map((c) => c.pos.y)), z: Math.max(...list.map((c) => c.pos.z)) };
      await teleport(b, centre({ x: Math.floor((lo.x + hi.x) / 2), y: F, z: Math.floor((lo.z + hi.z) / 2) }));
      await sleep(1500);
      for (let y = lo.y; y <= hi.y; y++) {
        if (!list.some((c) => c.pos.y === y)) continue;
        const d = await b.truth.blocksDiff({ x: lo.x, y, z: lo.z }, { x: hi.x, y, z: hi.z }, (c) => {
          const w = want.get(`${c.x},${c.y},${c.z}`);
          if (w === undefined || !prog.has(c)) return '*';
          compared++;
          return w;
        });
        diffs += d.diffs;
        if (firsts.length < 5) firsts.push(...d.first.slice(0, 5 - firsts.length));
      }
    }
    const hours = building / 3_600_000;
    const rate = placed / Math.max(hours, 1e-9);
    notes.push(`placed ${placed} of ${work} to place (${cells.length} in the file) in ${(building / 1000).toFixed(0)} s of building: ${rate.toFixed(0)} blocks an hour; projected ${(work / rate).toFixed(1)} h for what is planned; blocksdiff ${diffs} of ${compared} placed cells ${JSON.stringify(firsts)}; scaffolds left ${prog.scaffoldCells().length}`);
    // Track B8: the art's blocks and the supports placed, a rate of each; the projected time for the whole art
    const artDone = done.filter((c) => !supportKeys.has(`${c.pos.x},${c.pos.y},${c.pos.z}`)).length;
    const supDone = done.length - artDone;
    const artRate = artDone / Math.max(hours, 1e-9);
    notes.push(`art blocks ${artDone} and supports ${supDone} placed: ${artRate.toFixed(0)} art blocks an hour, ${(done.length / Math.max(hours, 1e-9)).toFixed(0)} cells an hour; projected ${(s.blocks.length / Math.max(artRate, 1e-9)).toFixed(1)} h for the ${s.blocks.length} art blocks`);
    if (OUT) appendFileSync(OUT, `mapart ${new Date().toISOString()}${VALLEY ? ' valley' : ''} placed ${placed} of ${work} in ${(building / 1000).toFixed(0)} s, ${rate.toFixed(0)}/h (art ${artDone}, ${artRate.toFixed(0)}/h; supports ${supDone}), diffs ${diffs} of ${compared}\n`);
    expect(compared).toBeGreaterThan(0);
    expect(diffs).toBe(0);
    if (VALLEY) await compareMap(b, cells, prog, supportKeys);
  }, 900_000);
});