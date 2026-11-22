// e2e (tag @bds), Track B1 (decision 0124, docs/build.md "Block states"): a fixture with every block family the
// builder gives states to, built by hand on bds-build (truth:setblock, truth:door), saved by the server (truth:save,
// a world structure) and written to a .mcstructure from the server's own block states (truth:blockstates). For
// each rotation (0, 90, 180) the server places its saved copy turned (truth:place: the expected states, turned by
// the game, not by the builder's rotateStates), the bot builds `!build file b1states x y z <rot>` beside it, and
// the two are compared cell by cell with truth:blocksdiff, the states that matter per block named in its palette
// (what the click chooses, what the taps and merges set, what the neighbours give; not power, age, contents).
// Two fixtures (b1states, b1states2: one inventory of 36 slots does not hold every family's item). Then a Java .schem
// (Track B2's reader) with stairs turned 90 and 270 against states written out by hand: one turn, not two.
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1,
// BUILD_STATES_ROTS (default `0,90,180`), BUILD_STATES_FIXTURES (default both), BUILD_STATES_JAVA=0 (skip the .schem).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { writeMcstructure } from '../../src/skills/build/formats/index.ts';
import { writeSchem, type JavaCell } from '../../src/skills/build/formats/schem.ts';
import { placementOf, resolveBlocks, stateText } from '../../src/skills/build/states.ts';
import type { BuildBlock } from '../../src/skills/build/types.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, sleep, startBuildBot, teleport, truthLoaded, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const FIX = 'b1states';
const ROTS = (process.env.BUILD_STATES_ROTS ?? '0,90,180').split(',').map((s) => Number(s.trim())) as (0 | 90 | 180 | 270)[];
const OUT = fileURLToPath(new URL('../../../.work/b1/', import.meta.url));

type St = Record<string, string | number | boolean>;
/** The fixture: [dx, dy, dz, block, states]; doors are [dx, dy, dz, 'door:<block>', {direction, hinge, open}]. */
const FIXTURE: [number, number, number, string, St?][] = [
  // row A: stairs, slabs, a log
  [0, 0, 0, 'oak_stairs', { weirdo_direction: 0, upside_down_bit: false }],
  [2, 0, 0, 'oak_stairs', { weirdo_direction: 2, upside_down_bit: false }],
  [4, 0, 0, 'oak_stairs', { weirdo_direction: 3, upside_down_bit: true }],
  [6, 0, 0, 'oak_slab', { 'minecraft:vertical_half': 'top' }],
  [8, 0, 0, 'oak_double_slab', { 'minecraft:vertical_half': 'bottom' }],
  [10, 0, 0, 'oak_log', { pillar_axis: 'x' }],
  // row B: facing by the view, six-way blocks
  [0, 0, 3, 'furnace', { 'minecraft:cardinal_direction': 'north' }],
  [2, 0, 3, 'white_glazed_terracotta', { facing_direction: 5 }],
  [4, 0, 3, 'carved_pumpkin', { 'minecraft:cardinal_direction': 'west' }],
  [6, 0, 3, 'barrel', { facing_direction: 1, open_bit: false }],
  [8, 0, 3, 'piston', { facing_direction: 3 }],
  [10, 0, 3, 'cobblestone'],
  [10, 1, 3, 'cobblestone'],
  [10, 2, 3, 'dispenser', { facing_direction: 0, triggered_bit: false }],
  // row C: two-cell blocks, a trapdoor
  [0, 0, 6, 'cobblestone'],
  [0, 1, 6, 'cobblestone'],
  [1, 0, 6, 'door:wooden_door', { direction: 'west', hinge: true, open: false }],
  [4, 0, 6, 'door:spruce_door', { direction: 'west', hinge: true, open: true }],
  [8, 0, 6, 'bed', { direction: 3, head_piece_bit: true, occupied_bit: false }],
  [7, 0, 6, 'bed', { direction: 3, head_piece_bit: false, occupied_bit: false }],
  [10, 0, 6, 'trapdoor', { direction: 0, upside_down_bit: true, open_bit: true }],
  // row D: a wall with attached blocks on both sides, a redstone line
  ...[0, 1, 2, 3, 4, 5, 6].flatMap((x) => [0, 1, 2].map((y) => [x, y, 9, 'cobblestone'] as [number, number, number, string])),
  [0, 1, 8, 'torch', { torch_facing_direction: 'south' }],
  [1, 1, 8, 'ladder', { facing_direction: 2 }],
  [2, 1, 8, 'stone_button', { facing_direction: 2, button_pressed_bit: false }],
  [3, 1, 8, 'lever', { lever_direction: 'north', open_bit: true }],
  [4, 1, 8, 'wall_sign', { facing_direction: 2 }],
  [5, 1, 8, 'frame', { facing_direction: 2, item_frame_map_bit: false, item_frame_photo_bit: false }],
  [6, 1, 8, 'skeleton_skull', { facing_direction: 2 }],
  [0, 2, 10, 'end_rod', { facing_direction: 2 }],
  [1, 2, 10, 'cobblestone'],
  [1, 1, 10, 'lantern', { hanging: true }],
  [2, 0, 10, 'redstone_wire', { redstone_signal: 0 }],
  [3, 0, 10, 'unpowered_repeater', { 'minecraft:cardinal_direction': 'west', repeater_delay: 2 }],
  [4, 0, 10, 'unpowered_comparator', { 'minecraft:cardinal_direction': 'west', output_subtract_bit: true, output_lit_bit: false }],
  [5, 0, 10, 'rail', { rail_direction: 1 }],
  [6, 0, 10, 'rail', { rail_direction: 1 }],
  [7, 0, 10, 'stone_pressure_plate', { redstone_signal: 0 }],
  [9, 0, 10, 'standing_sign', { ground_sign_direction: 4 }],
  [11, 0, 10, 'fence_gate', { 'minecraft:cardinal_direction': 'north', open_bit: true, in_wall_bit: false }],
  // row E: power sources, more in one cell, a tall plant
  [0, 0, 12, 'redstone_torch', { torch_facing_direction: 'top' }],
  [3, 0, 12, 'observer', { 'minecraft:facing_direction': 'east', powered_bit: false }],
  [6, 0, 12, 'candle', { candles: 2, lit: false }],
  [8, 0, 12, 'snow_layer', { height: 2, covered_bit: false }],
  [10, 1, 12, 'sunflower', { upper_block_bit: true }],
  [10, 0, 12, 'sunflower', { upper_block_bit: false }],
];
/**
 * The second fixture: the families that do not fit in the first one's inventory (36 slots): standing and
 * hanging blocks, a hopper into a block, amethyst, a crafter, walls that connect, more in one cell.
 */
const FIXTURE2: [number, number, number, string, St?][] = [
  // row A: facing by the view, a hopper pointing into a block, a crafter
  [0, 0, 0, 'chest', { 'minecraft:cardinal_direction': 'south' }],
  [2, 0, 0, 'anvil', { 'minecraft:cardinal_direction': 'east' }],
  [4, 0, 0, 'bell', { attachment: 'standing', direction: 1 }],
  [6, 0, 0, 'hopper', { facing_direction: 5 }],
  [7, 0, 0, 'cobblestone'],
  [9, 0, 0, 'amethyst_cluster', { 'minecraft:block_face': 'up' }],
  [11, 0, 0, 'crafter', { orientation: 'west_up' }],
  // row B: walls (connections), a rod, petals, a pickle pair, a standing lantern, a grindstone
  [0, 0, 3, 'cobblestone_wall'],
  [1, 0, 3, 'cobblestone_wall'],
  [3, 0, 3, 'lightning_rod', { facing_direction: 1 }],
  [5, 0, 3, 'pink_petals', { 'minecraft:cardinal_direction': 'west' }],
  [7, 0, 3, 'sea_pickle', { cluster_count: 1, dead_bit: true }],
  [9, 0, 3, 'lantern', { hanging: false }],
  [11, 0, 3, 'grindstone', { attachment: 'standing', direction: 0 }],
  // row C: a wall with a tripwire hook, a hanging sign under a block and one on the wall
  ...[0, 1, 2, 3, 4].flatMap((x) => [0, 1, 2].map((y) => [x, y, 6, 'cobblestone'] as [number, number, number, string])),
  [1, 1, 7, 'tripwire_hook', { direction: 0 }],
  [3, 2, 7, 'cobblestone'],
  [3, 1, 7, 'oak_hanging_sign', { hanging: true, facing_direction: 3, attached_bit: false }],
  [0, 1, 7, 'oak_hanging_sign', { hanging: false, facing_direction: 5, attached_bit: false }],
];
interface Fixture {
  name: string;
  cells: [number, number, number, string, St?][];
  size: Vec3;
  /** z offsets from the area's centre: the hand-built source, the server's turned copies, the bot's builds. */
  z: { source: number; expected: number; build: number };
}
const ALL_FIXTURES: Fixture[] = [
  { name: FIX, cells: FIXTURE, size: { x: 12, y: 3, z: 13 }, z: { source: -45, expected: -20, build: 8 } },
  { name: `${FIX}2`, cells: FIXTURE2, size: { x: 12, y: 3, z: 8 }, z: { source: 40, expected: 62, build: 84 } },
];
/** BUILD_STATES_FIXTURES (`b1states,b1states2`, the default: both) picks the fixtures. */
const PICK = process.env.BUILD_STATES_FIXTURES?.split(',').map((s) => s.trim());
const FIXTURES = ALL_FIXTURES.filter((f) => !PICK || PICK.includes(f.name));

describe.skipIf(!E2E)('@bds build: block states, two-cell blocks, redstone parts (Track B1)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const sourceOf = (f: Fixture): Vec3 => ({ x: area.x - 40, y: F, z: area.z + f.z.source });
  const sites = (f: Fixture, i: number) => ({ expected: { x: area.x - 40 + 24 * i, y: F, z: area.z + f.z.expected }, build: { x: area.x - 40 + 24 * i, y: F, z: area.z + f.z.build } });
  const saved = new Map<string, BuildBlock[]>();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  /** Clear a fixture-sized site (and a margin) with the bot near it (the chunks must be loaded). */
  async function site(corner: Vec3): Promise<void> {
    const b = bot!;
    await teleport(b, { x: corner.x - 3.5, y: F, z: corner.z - 3.5 });
    await clearArea(b.truth, { x: corner.x + 6, z: corner.z + 6 }, 11, 6);
  }

  /** The server's blocks of a box, states as the bot's palette names them (the script API adds aliases). */
  async function readBox(min: Vec3, size: Vec3): Promise<BuildBlock[]> {
    const b = bot!;
    const reg = b.built.mobility!.world.registry;
    const r = await truthLoaded<{ palette: { typeId: string; states: St }[]; runs: [number, number][] }>(b.truth, 'blockstates', [min.x, min.y, min.z, min.x + size.x - 1, min.y + size.y - 1, min.z + size.z - 1]);
    const out: BuildBlock[] = [];
    let i = 0;
    for (const [pi, n] of r.runs) {
      const e = r.palette[pi]!;
      const name = e.typeId.replace(/^minecraft:/, '');
      for (let k = 0; k < n; k++, i++) {
        if (name === 'air') continue;
        const x = i % size.x;
        const z = Math.floor(i / size.x) % size.z;
        const y = Math.floor(i / (size.x * size.z));
        const id = reg.stateIdOf(name);
        const keys = id === undefined ? Object.keys(e.states) : Object.keys(reg.blockInfo(id).states);
        const states = Object.fromEntries(Object.entries(e.states).filter(([s]) => keys.includes(s)));
        out.push({ pos: { x, y, z }, name, states });
      }
    }
    return out;
  }

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    await prepareServer();
    bot = await startBuildBot('States', builds);
    await teleport(bot, home);
    // the fixtures, by hand
    const t = bot.truth;
    for (const f of FIXTURES) {
      const source = sourceOf(f);
      await site(source);
      for (const [dx, dy, dz, name, st] of f.cells) {
        const p = { x: source.x + dx, y: source.y + dy, z: source.z + dz };
        if (name.startsWith('door:')) {
          await truthLoaded(t, 'door', [p.x, p.y, p.z, name.slice(5), String(st!.direction), st!.hinge ? 1 : 0, st!.open ? 1 : 0]);
          continue;
        }
        await truthLoaded(t, 'setblock', [p.x, p.y, p.z, name, ...Object.entries(st ?? {}).map(([k, v]) => `${k}=${String(v)}`)]);
      }
      await sleep(1000);
      await truthLoaded(t, 'save', [f.name, source.x, source.y, source.z, source.x + f.size.x - 1, source.y + f.size.y - 1, source.z + f.size.z - 1, 'world']);
      const fixture = await readBox(source, f.size);
      saved.set(f.name, fixture);
      writeFileSync(join(builds, `${f.name}.mcstructure`), writeMcstructure(f.size, fixture));
      const families = new Map<string, number>();
      for (const c of resolveBlocks(fixture).cells) families.set(c.placement.family, (families.get(c.placement.family) ?? 0) + 1);
      notes.push(`${f.name}: ${fixture.length} blocks, families ${[...families].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      notes.push(`${f.name} states: ${fixture.map((x) => `${x.pos.x},${x.pos.y},${x.pos.z} ${x.name}${JSON.stringify(x.states)}`).join(' | ')}`);
    }
  }, 300_000);

  afterAll(async () => {
    if (bot) {
      for (const f of FIXTURES) for (const c of [sourceOf(f), ...ROTS.flatMap((_, i) => [sites(f, i).expected, sites(f, i).build])]) await site(c).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    const text = `[build-states e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}\n`;
    console.log(text);
    try {
      appendFileSync(join(OUT, `states-e2e-${stamp}.txt`), text);
    } catch {
      // the raw results folder is optional
    }
  }, 300_000);

  it('the fixtures use every family and nothing is refused', () => {
    const fam = new Set<string>();
    for (const f of FIXTURES) {
      const r = resolveBlocks(saved.get(f.name) ?? []);
      expect(r.refused.map((x) => `${x.block.name}: ${x.reason}`)).toEqual([]);
      for (const c of r.cells) fam.add(c.placement.family);
    }
    if (PICK) return; // a picked fixture alone does not hold every family
    for (const f of ['stairs', 'slab', 'double slab', 'pillar', 'facing', 'glazed terracotta', 'six-way', 'door', 'bed', 'trapdoor', 'fence gate', 'torch', 'ladder', 'button', 'lever', 'wall sign', 'frame', 'head', 'end rod', 'lantern', 'dust', 'repeater', 'comparator', 'rail', 'floor', 'standing sign', 'candles', 'snow layer', 'tall plant', 'bell', 'grindstone', 'hopper', 'amethyst', 'lightning rod', 'tripwire hook', 'hanging sign', 'sea pickle']) {
      expect(fam, f).toContain(f);
    }
  });

  for (const fx of FIXTURES) for (const [i, rot] of ROTS.entries()) {
    it(`${fx.name} built turned ${rot}: every block as the server's own turned copy, state by state`, async () => {
      const b = bot!;
      const FIXN = fx.name;
      const SIZE = fx.size;
      const fixture = saved.get(FIXN) ?? [];
      const { expected: E, build: X } = sites(fx, i);
      const turned = rot === 90 || rot === 270 ? { x: SIZE.z, y: SIZE.y, z: SIZE.x } : SIZE;
      // the server's copy, turned by the game
      await site(E);
      await truthLoaded(b.truth, 'place', [FIXN, E.x, E.y, E.z, rot]);
      await sleep(1000);
      const want = await readBox(E, turned);
      // the bot's build
      await site(X);
      const kit: Record<string, number> = { dirt: 64 };
      for (const blk of fixture) {
        const p = placementOf(blk);
        if ('refuse' in p || 'companion' in p) continue;
        kit[p.item] = (kit[p.item] ?? 0) + 1 + p.merges;
      }
      await b.truth.ok('clear', [b.name]);
      for (const [k, v] of Object.entries(kit)) for (let n = v; n > 0; n -= 64) await b.truth.ok('give', [b.name, k, Math.min(64, n)]);
      await sleep(800);
      await teleport(b, { x: X.x - 2.5, y: F, z: X.z - 2.5 });
      const from = b.said.length;
      const t0 = performance.now();
      await b.command(`!build file ${FIXN} ${X.x} ${X.y} ${X.z} ${rot}`);
      const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from, 30_000);
      const end = await b.reply((s) => s.startsWith('build file '), from, 900_000);
      const secs = (performance.now() - t0) / 1000;
      const plan = b.build.last;
      // compare: the states that matter per block, from the server's copy
      const at = new Map(want.map((w) => [`${w.pos.x},${w.pos.y},${w.pos.z}`, w]));
      const keysAt = new Map<string, string[]>();
      for (const c of resolveBlocks(want).cells) {
        const p = c.placement;
        keysAt.set(`${c.block.pos.x},${c.block.pos.y},${c.block.pos.z}`, [...new Set([...Object.keys(p.check), ...Object.keys(p.final), ...Object.keys(p.derived)])]);
        for (const e of p.extra) keysAt.set(`${c.block.pos.x + e.offset.x},${c.block.pos.y + e.offset.y},${c.block.pos.z + e.offset.z}`, Object.keys(e.check));
      }
      const entry = (x: number, y: number, z: number): string => {
        const k = `${x},${y},${z}`;
        const w = at.get(k);
        if (!w) return 'air';
        const keys = keysAt.get(k) ?? [];
        const st = keys.filter((s) => w.states?.[s] !== undefined).map((s) => `${s}=${stateText(w.states![s])}`);
        return st.length ? `${w.name}[${st.join(';')}]` : w.name;
      };
      let diffs = 0;
      const firsts: unknown[] = [];
      let compared = 0;
      for (let y = 0; y < turned.y; y++) {
        for (let z = 0; z < turned.z; z++) {
          const d = await b.truth.blocksDiff({ x: X.x, y: X.y + y, z: X.z + z }, { x: X.x + turned.x - 1, y: X.y + y, z: X.z + z }, (c) => entry(c.x - X.x, c.y - X.y, c.z - X.z));
          diffs += d.diffs;
          compared += d.count;
          firsts.push(...d.first);
        }
      }
      notes.push(`${FIXN} rot ${rot}: ${first} | ${end} | wall ${secs.toFixed(0)} s | plan: ${plan?.stateful ?? 0} with states, ${plan?.turned ?? 0} turned views, unmade ${JSON.stringify(plan?.unmade ?? [])}, ${plan?.steps.length ?? 0} steps | blocksdiff ${diffs} of ${compared} ${JSON.stringify(firsts)}`);
      expect(end).toMatch(/: done, /);
      expect(diffs).toBe(0);
    }, 1_000_000);
  }

  // Track B2's Java reader and this track's turner together: a Sponge .schem (Java names and states) built turned;
  // the expected states are written out by hand (clockwise seen from above: north -> east -> south -> west), so a
  // state turned twice, or not at all, is a difference. BUILD_STATES_JAVA=0 skips it.
  it.skipIf(process.env.BUILD_STATES_JAVA === '0')('a rotated .schem with stairs, a log, a furnace and a chest: each state turned once', async () => {
    const b = bot!;
    const size = { x: 3, y: 1, z: 3 };
    const cells: JavaCell[] = [
      { pos: { x: 0, y: 0, z: 0 }, java: 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]' },
      { pos: { x: 2, y: 0, z: 0 }, java: 'minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]' },
      { pos: { x: 0, y: 0, z: 2 }, java: 'minecraft:oak_log[axis=x]' },
      { pos: { x: 2, y: 0, z: 2 }, java: 'minecraft:furnace[facing=north,lit=false]' },
      { pos: { x: 1, y: 0, z: 2 }, java: 'minecraft:chest[facing=west,type=single,waterlogged=false]' },
    ];
    writeFileSync(join(builds, 'b1java.schem'), writeSchem(size, cells));
    const CW = ['north', 'east', 'south', 'west'];
    const turn = (d: string, q: number) => CW[(CW.indexOf(d) + q) % 4]!;
    const WEIRDO: Record<string, number> = { east: 0, west: 1, south: 2, north: 3 };
    const expectAt = (q: number): Map<string, string> => {
      const pos = (x: number, z: number): string => {
        let [px, pz, sx, sz] = [x, z, size.x, size.z];
        for (let i = 0; i < q; i++) [px, pz, sx, sz] = [sz - 1 - pz, px, sz, sx];
        return `${px},0,${pz}`;
      };
      return new Map([
        [pos(0, 0), `oak_stairs[weirdo_direction=${WEIRDO[turn('east', q)]};upside_down_bit=0]`],
        [pos(2, 0), `oak_stairs[weirdo_direction=${WEIRDO[turn('north', q)]};upside_down_bit=1]`],
        [pos(0, 2), `oak_log[pillar_axis=${q % 2 ? 'z' : 'x'}]`],
        [pos(2, 2), `furnace[minecraft:cardinal_direction=${turn('north', q)}]`],
        [pos(1, 2), `chest[minecraft:cardinal_direction=${turn('west', q)}]`],
      ]);
    };
    for (const [i, rot] of ([90, 270] as const).entries()) {
      const X = { x: area.x - 40 + 24 * i, y: F, z: area.z - 70 };
      await site(X);
      await b.truth.ok('clear', [b.name]);
      for (const [k, v] of Object.entries({ dirt: 64, oak_stairs: 2, oak_log: 1, furnace: 1, chest: 1 })) await b.truth.ok('give', [b.name, k, v]);
      await sleep(800);
      await teleport(b, { x: X.x - 2.5, y: F, z: X.z - 2.5 });
      const from = b.said.length;
      await b.command(`!build file b1java ${X.x} ${X.y} ${X.z} ${rot}`);
      const end = await b.reply((s) => s.startsWith('build file ') || s.startsWith('build: '), from, 300_000);
      const want = expectAt(rot / 90);
      const d = await b.truth.blocksDiff(X, { x: X.x + 2, y: X.y, z: X.z + 2 }, (c) => want.get(`${c.x - X.x},${c.y - X.y},${c.z - X.z}`) ?? 'air');
      notes.push(`b1java.schem rot ${rot}: ${end} | blocksdiff ${d.diffs} of ${d.count} ${JSON.stringify(d.first)}`);
      expect(end).toMatch(/: done, /);
      expect(d.diffs, `${rot}: ${JSON.stringify(d.first)}`).toBe(0);
      await site(X);
    }
  }, 900_000);
});
