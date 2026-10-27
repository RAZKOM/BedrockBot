// e2e (tag @bds), wave 8 Track AC (decision 0024): the world registry resolves every runtime id of a
// 1-chunk strip of blocks whose states changed since minecraft-data's 1.26.30 data (stairs of 4 kinds in all
// 4 facings plus corners, slabs, doors, trapdoors, walls, fences, panes and bars, candles, copper, redstone
// wire, new 1.26 blocks) to the name and states the truth pack reports for the same position
// (truth:palettestates, the Script API view of truth:block for a box; legacy Script API states such as
// `direction` on doors, which the network hash leaves out, are not compared). Prints the table that
// docs/versions.md ("Block states") reproduces.
//
// Needs bds-reg (docker/compose.reg.yml, udp/19192) with the truth pack and BDS_E2E=1.
// Env: REG_BDS_HOST (127.0.0.1), REG_BDS_PORT (19192), REG_BDS_CONTAINER (bds-reg); version and transport from env.ts.
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { bdsTarget, E2E_VERSION } from './env.ts';
import { E2E, Truth, leave, pollUntil, sleep, standStill, uniqueName } from './world-truth.ts';

const REG_HOST = process.env.REG_BDS_HOST ?? '127.0.0.1';
const REG_PORT = Number(process.env.REG_BDS_PORT ?? 19192);
const REG_CONTAINER = process.env.REG_BDS_CONTAINER ?? 'bds-reg';
/** Flat world: grass top at y -61. */
const Y = -60;

interface Spec {
  name: string;
  states?: string[];
  door?: [dir: string, hinge: 0 | 1, open: 0 | 1];
}

/** One row per group, 16 cells wide (x), rows 2 apart (z). Adjacent cells of a row connect (stairs corners, fences, walls, panes, wire). */
function strip(): Spec[][] {
  const stairs = (name: string): Spec[] => [
    ...[0, 1, 2, 3].map((d) => ({ name, states: [`weirdo_direction=${d}`] })),
    ...['inner_left', 'inner_right', 'outer_left', 'outer_right'].map((c) => ({ name, states: ['weirdo_direction=0', `minecraft:corner=${c}`] })),
  ];
  const s = (name: string, ...states: string[]): Spec => ({ name, states });
  return [
    [...stairs('oak_stairs'), ...stairs('stone_brick_stairs')],
    [...stairs('cut_copper_stairs'), ...stairs('white_wool_stairs')],
    // an L of stairs (the server shapes the corner) and upside-down ones
    [s('oak_stairs', 'weirdo_direction=0'), s('oak_stairs', 'weirdo_direction=2'), s('white_concrete_stairs', 'weirdo_direction=1', 'upside_down_bit=true'), s('cut_copper_stairs', 'weirdo_direction=3', 'upside_down_bit=true')],
    [
      s('oak_slab', 'minecraft:vertical_half=bottom'),
      s('oak_slab', 'minecraft:vertical_half=top'),
      s('oak_double_slab'),
      s('white_wool_slab', 'minecraft:vertical_half=bottom'),
      s('white_wool_slab', 'minecraft:vertical_half=top'),
      s('white_wool_double_slab'),
      s('poplar_slab', 'minecraft:vertical_half=top'),
      s('black_wool_slab'),
      s('cut_copper_slab', 'minecraft:vertical_half=top'),
    ],
    [
      { name: 'wooden_door', door: ['south', 0, 0] },
      { name: 'poplar_door', door: ['east', 1, 1] },
      { name: 'iron_door', door: ['north', 0, 0] },
      { name: 'copper_door', door: ['west', 1, 0] },
      s('trapdoor', 'open_bit=true'),
      s('poplar_trapdoor', 'direction=2'),
      s('iron_trapdoor', 'upside_down_bit=true'),
      s('copper_trapdoor'),
      s('fence_gate'),
      s('poplar_fence_gate', 'open_bit=true'),
    ],
    [s('cobblestone_wall'), s('cobblestone_wall'), s('cobblestone_wall'), s('blackstone_wall'), s('oak_fence'), s('oak_fence'), s('oak_fence'), s('nether_brick_fence'), s('poplar_fence')],
    [s('glass_pane'), s('glass_pane'), s('glass_pane'), s('red_stained_glass_pane'), s('iron_bars'), s('copper_bars'), s('redstone_wire'), s('redstone_wire'), s('redstone_wire')],
    [
      s('candle', 'candles=2', 'lit=true'),
      s('white_candle'),
      s('candle_cake'),
      s('copper_block'),
      s('exposed_copper'),
      s('waxed_oxidized_copper'),
      s('copper_bulb', 'lit=true'),
      s('copper_grate'),
      s('copper_chest'),
      s('copper_lantern'),
      s('lightning_rod'),
    ],
    [
      s('poplar_planks'),
      s('poplar_log', 'pillar_axis=x'),
      s('stripped_poplar_wood'),
      s('orange_poplar_leaves'),
      s('poplar_sapling'),
      s('red_shrub'),
      s('shelf_mushroom'),
      s('disc_press'),
      s('ice_crystal'),
      s('icicle'),
      s('poplar_shelf'),
    ],
  ];
}

interface TruthBlock {
  x: number;
  y: number;
  z: number;
  typeId: string;
  states: { name: string; type: string; value: boolean | number | string }[];
}

const norm = (v: unknown): unknown => (v === true ? 1 : v === false ? 0 : v);

describe.skipIf(!E2E)('@bds world registry vs truth for 1.26.60 block states (bds-reg)', () => {
  let conn: Connection;
  let world: World;
  let truth: Truth;
  let stop: (() => void) | undefined;
  const name = uniqueName('WReg');
  // private area: a random chunk-aligned cell of a 256-block grid at x, z 8192.. (8 x 8 cells)
  const cell = randomInt(64);
  const x0 = 8192 + 256 * (cell % 8) + 128;
  const z0 = 8192 + 256 * Math.floor(cell / 8) + 128;
  const feet: Vec3 = { x: x0 + 8.5, y: Y, z: z0 - 4.5 };
  const rows = strip();
  const depth = 2 * rows.length;

  beforeAll(async () => {
    conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
    world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
    truth = new Truth(conn, REG_CONTAINER);
    await conn.connect(bdsTarget(REG_HOST, REG_PORT));
    await world.waitForChunks(2, { timeoutMs: 30_000 });
    await truth.ok('tp', [name, feet.x, feet.y, feet.z]);
    stop = standStill(conn, () => feet);
    await world.waitForChunks(2, { center: feet, timeoutMs: 30_000 });
    // truth reads only work in chunks the server ticks for scripts: retry until the area is loaded
    for (let i = 0; ; i++) {
      const r = await truth.cmd('fill', [x0, Y, z0, x0 + 15, Y + 2, z0 + depth, 'air']);
      if (r.ok) break;
      if (i > 50) throw new Error(`area never loaded: ${JSON.stringify(r.data)}`);
      await sleep(200);
    }
    await truth.ok('fill', [x0, Y - 1, z0, x0 + 15, Y - 1, z0 + depth, 'grass_block']);
  }, 90_000);

  afterAll(async () => {
    try {
      await truth?.ok('fill', [x0, Y, z0, x0 + 15, Y + 2, z0 + depth, 'air']);
    } catch {
      // best effort
    }
    stop?.();
    truth?.dispose();
    world?.dispose();
    await leave(conn);
  });

  it('resolves every runtime id of the strip to the truth name and states (0 unknown)', async () => {
    const t0 = performance.now();
    let placed = 0;
    for (let r = 0; r < rows.length; r++) {
      for (let i = 0; i < rows[r]!.length; i++) {
        const sp = rows[r]![i]!;
        const p = { x: x0 + i, y: Y, z: z0 + 2 * r };
        if (sp.door) await truth.ok('door', [p.x, p.y, p.z, sp.name, ...sp.door]);
        else await truth.ok('setblock', [p.x, p.y, p.z, sp.name, ...(sp.states ?? [])]);
        placed++;
      }
    }
    const placeMs = performance.now() - t0;
    await sleep(1500); // neighbour updates (corners, connections) settle; the client sees them within a tick or two
    const box = await truth.ok<{ blocks: TruthBlock[] }>('palettestates', [x0, Y, z0, x0 + 15, Y + 1, z0 + depth]);
    const cells = box.blocks.filter((b) => b.typeId !== 'minecraft:air');
    // the model must have caught up with the last updates
    const caught = await pollUntil(() => cells.every((b) => world.blockAt(b)?.name === b.typeId.slice(10)), 3000);
    const table: string[] = [];
    const bad: string[] = [];
    let extra = 0;
    for (const b of cells) {
      const info = world.blockAt(b);
      const want = b.typeId.slice(10);
      const truthStates = Object.fromEntries(b.states.map((s) => [s.name, norm(s.value)]));
      const ours = info?.states ?? {};
      const rid = world.chunks.runtimeIdAt(b.x, b.y, b.z);
      const sameStates = Object.entries(ours).every(([k, v]) => truthStates[k] === v);
      const ok = info !== undefined && info.stateId >= 0 && info.name === want && sameStates;
      if (info && info.stateId >= world.registry.stateCount - world.registry.extraStateCount) extra++;
      const st = Object.entries(ours)
        .map(([k, v]) => `${k.replace('minecraft:', '')}=${String(v)}`)
        .join(' ');
      table.push(`| ${want} | ${st} | ${rid} | ${info?.stateId ?? 'none'}${info && info.stateId >= world.registry.stateCount - world.registry.extraStateCount ? ' (palette)' : ''} | ${ok ? 'yes' : 'NO'} |`);
      if (!ok) bad.push(`${b.x},${b.y},${b.z}: truth ${want} ${JSON.stringify(truthStates)}, model ${info?.name} ${JSON.stringify(ours)} (rid ${rid})`);
    }
    console.log(`[world-registry] ${placed} placements (${Math.round(placeMs)} ms), ${cells.length} non-air blocks, ${extra} resolved to palette-only states, ${bad.length} mismatches, caught up ${caught >= 0 ? `${Math.round(caught)} ms` : 'no'}`);
    console.log(['| block | states (model) | runtime id | state id | = truth |', '|---|---|---|---|---|', ...table].join('\n'));
    expect(bad, bad.join('\n')).toEqual([]);
    expect(cells.length).toBeGreaterThanOrEqual(placed); // doors add an upper half; nothing popped off
    expect(world.registry.unknownRuntimeIds.size, world.registry.unknownSummary()).toBe(0);
    // the corner state really occurs in the strip
    expect(cells.some((b) => b.states.some((s) => s.name === 'minecraft:corner' && s.value !== 'none'))).toBe(true);
  }, 120_000);

  it('resolves one of every block type (truth:palettestrip, 256 per batch) with 0 unknown ids', async () => {
    const t0 = performance.now();
    const COLS = 16;
    const N = 256;
    // the batch grid (2 apart, 32 x 32) sits north of the bot (the strip is south), inside the area the server ticks
    const bx = x0 - 8;
    const bz = z0 - 8 - 2 * COLS;
    let total = Infinity;
    let checked = 0;
    let named = 0;
    const wrong: string[] = [];
    const clear = async () => {
      await truth.ok('fill', [bx - 2, Y, bz - 2, bx + 2 * COLS + 1, Y + 3, bz + 2 * COLS + 1, 'air']);
      await truth.ok('fill', [bx - 2, Y - 1, bz - 2, bx + 2 * COLS + 1, Y - 1, bz + 2 * COLS + 1, 'grass_block']);
    };
    try {
      for (let from = 0; from < total; from += N) {
        await clear();
        const strip = await truth.ok<{ total: number }>('palettestrip', [bx, Y, bz, from, N, COLS, 2]);
        if (from === 0) total = (await truth.ok<{ total: number }>('palette', [0, 1])).total;
        await sleep(1500);
        const box = await truth.ok<{ blocks: TruthBlock[] }>('palettestates', [bx, Y, bz, bx + 2 * (COLS - 1), Y, bz + 2 * (Math.ceil(strip.total / COLS) - 1)]);
        for (const b of box.blocks) {
          if ((b.x - bx) % 2 !== 0 || (b.z - bz) % 2 !== 0) continue;
          const info = world.blockAt(b);
          if (!info) continue;
          checked++;
          if (info.stateId >= 0 && info.name === b.typeId.slice(10)) named++;
          else wrong.push(`${b.typeId} -> ${info.name} ${JSON.stringify(info.states)}`);
        }
      }
    } finally {
      await clear().catch(() => undefined);
    }
    console.log(`[world-registry] all types: ${total} types placed, ${checked} probe cells read, ${named} resolved to the truth name, ${wrong.length} not, ${world.registry.unknownRuntimeIds.size} unknown runtime ids, ${Math.round(performance.now() - t0)} ms${wrong.length ? `: ${wrong.join('; ')}` : ''}`);
    // a few cells can change between the model read and the truth read (fire burning out, water spreading)
    expect(wrong.length, wrong.join('\n')).toBeLessThanOrEqual(5);
    expect(checked).toBeGreaterThan(total * 0.95);
    expect(world.registry.unknownRuntimeIds.size, world.registry.unknownSummary()).toBe(0);
  }, 180_000);
});
