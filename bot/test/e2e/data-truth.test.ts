// e2e (tag @bds), Track U2 (decision 0094): the block and item data the bot plans with, against the server's.
//   - stack sizes: truth:itemmax gives the stack size of every item type the server registers; the bot's
//     (maxStackOf, the block data key's items) must be the same for every item both know;
//   - standing heights: an armor stand dropped on each block whose terrain class changed with minecraft-data
//     3.119.0 (and on controls), and on the blocks newer than the block data where the server has them (1.26.70),
//     lands at the server's collision top under its footprint; the bot's boxes for the state the server sent must
//     give the same height.
// Runs on any server with the truth pack (DIG_BDS_HOST / DIG_BDS_PORT / DIG_BDS_CONTAINER, flat world). Prints both
// tables.
//   BDS_E2E=1 DIG_BDS_CONTAINER=<name> DIG_BDS_PORT=<port> pnpm exec vitest run --project e2e test/e2e/data-truth.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { maxStackOf } from '../../src/skills/container/chest.ts';
import { classify } from '../../src/skills/terrain/classify.ts';
import { E2E, FEET_Y, RunArea, connectDigBot, pollUntil, prepareServer, sleep, type DigBot } from './dig-truth.ts';
import { E2E_VERSION } from './env.ts';

/** Blocks whose terrain class changed with minecraft-data 3.119.0, then controls (unchanged, known heights). */
const STAND_CASES: readonly { block: string; states: Record<string, string | number | boolean> }[] = [
  { block: 'end_portal_frame', states: { end_portal_eye_bit: true, 'minecraft:cardinal_direction': 'east' } },
  { block: 'end_portal_frame', states: { end_portal_eye_bit: false, 'minecraft:cardinal_direction': 'east' } },
  { block: 'straw_bed', states: { head_piece_bit: false, 'minecraft:cardinal_direction': 'south', occupied_bit: false } },
  { block: 'chorus_plant', states: { 'minecraft:connection_up': true } },
  { block: 'chorus_plant', states: {} },
  { block: 'ice_crystal', states: { 'minecraft:block_face': 'up' } },
  { block: 'icicle', states: { hanging: false } },
  { block: 'red_shrub', states: {} },
  { block: 'shelf_mushroom', states: { 'minecraft:cardinal_direction': 'south' } },
  // controls
  { block: 'stone', states: {} },
  { block: 'white_wool_slab', states: { 'minecraft:vertical_half': 'bottom' } },
  { block: 'oak_fence', states: {} },
  { block: 'bed', states: { head_piece_bit: false, direction: 0, occupied_bit: false } },
  { block: 'ladder', states: { facing_direction: 2 } },
];

/**
 * Blocks newer than the block data (1.26.70): their shapes come from a donor (walls, slabs, stairs) or are the
 * full-cube default (registry palette-only states). A server without them refuses the setblock: listed as not placed.
 */
const NEWER_STAND_CASES: readonly { block: string; states: Record<string, string | number | boolean> }[] = [
  { block: 'snow_bricks', states: {} },
  { block: 'brittle_ice', states: {} },
  { block: 'polished_calcite', states: {} },
  { block: 'calcite_pillar', states: {} },
  { block: 'chiseled_soulshale', states: {} },
  { block: 'chiseled_packed_ice', states: {} },
  { block: 'calcite_wall', states: {} },
  { block: 'polished_calcite_brick_wall', states: {} },
  { block: 'packed_ice_brick_slab', states: {} },
  { block: 'snow_brick_stairs', states: {} },
];

/** An armor stand's footprint (width 0.5) centred in the cell. */
const FOOT = [0.25, 0.75] as const;

/** A requested state value as the world model holds it (byte states arrive as 0 and 1). */
const asSent = (v: string | number | boolean): unknown => (typeof v === 'boolean' ? Number(v) : v);

function topUnderFoot(boxes: readonly (readonly number[])[]): number {
  let top = 0;
  for (const b of boxes) if (b[0]! < FOOT[1] && b[3]! > FOOT[0] && b[2]! < FOOT[1] && b[5]! > FOOT[0]) top = Math.max(top, b[4]!);
  return top;
}

describe.skipIf(!E2E)('@bds the bot data against the server (Track U2)', () => {
  let bot: DigBot;
  const area = new RunArea();
  const lines: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await connectDigBot('Data');
    await bot.teleport(area.home);
    const { from, to } = area.box;
    await bot.truth.okLoaded('fill', [from.x, from.y + 1, from.z, to.x, to.y, to.z, 'air']);
    await bot.truth.okLoaded('fill', [from.x, from.y, from.z, to.x, from.y, to.z, 'grass_block']);
  }, 90_000);

  afterAll(async () => {
    process.stdout.write(`[data-truth] BDS ${E2E_VERSION}\n  ${lines.join('\n  ')}\n`);
    await bot?.truth.cmd('killmobs', ['u2stand']).catch(() => undefined);
    await bot?.close();
  });

  it('every item stack size the bot plans with is the server\'s', async () => {
    const r = await bot.truth.ok<{ max: Record<string, number>; failed: string[] }>('itemmax', [], 30_000);
    const wrong: string[] = [];
    let compared = 0;
    for (const [id, max] of Object.entries(r.max)) {
      const name = id.replace(/^minecraft:/, '');
      compared++;
      const mine = maxStackOf(name);
      if (mine !== max) wrong.push(`${name} bot ${mine} server ${max}`);
    }
    lines.push(`stack sizes: ${compared} item types compared, ${wrong.length} differ${wrong.length ? `: ${wrong.join(', ')}` : ''}; ${r.failed.length} the server could not build an ItemStack of`);
    expect(compared).toBeGreaterThan(1500);
    expect(wrong).toEqual([]);
  }, 60_000);

  it('an armor stand lands where the bot\'s boxes say, on every block whose class changed', async () => {
    const rows: string[] = [];
    const wrong: string[] = [];
    const skipped: string[] = [];
    // one cell every 3 blocks on two rows 5 from home: away from the bot, inside the cleared box
    const cells: Vec3[] = [];
    for (const dz of [-5, 5]) for (let dx = -12; dx <= 6; dx += 3) cells.push({ x: area.x0 + dx, y: FEET_Y, z: area.z0 + dz });
    for (const dz of [-3, 3]) for (const dx of [-12, -9, -6, -3, 3, 6]) cells.push({ x: area.x0 + dx, y: FEET_Y, z: area.z0 + dz });
    const cases = [...STAND_CASES, ...NEWER_STAND_CASES];
    expect(cells.length).toBeGreaterThanOrEqual(cases.length);
    for (const [i, c] of cases.entries()) {
      const at = cells[i]!;
      const label = `${c.block} ${JSON.stringify(c.states)}`;
      const set = await bot.truth.cmd('setblock', [at.x, at.y, at.z, c.block, ...Object.entries(c.states).map(([k, v]) => `${k}=${v}`)]);
      if (!set.ok) {
        skipped.push(`${label}: ${set.reason}`);
        continue;
      }
      const seen = await pollUntil(() => bot.world.blockAt(at)?.name === c.block, 3_000);
      expect(seen, `${label}: the world model has ${bot.world.blockAt(at)?.name}`).toBeGreaterThanOrEqual(0);
      const info = bot.world.blockAt(at)!;
      // the server may change the states it was given (chorus_plant recomputes its arms): show what it sent
      const sent = Object.entries(c.states).some(([k, v]) => info.states[k] !== asSent(v)) ? ` sent ${JSON.stringify(info.states)}` : '';
      const cls = classify(info);
      const want = topUnderFoot(cls.boxes);
      const stand = await bot.truth.ok<{ entityId: string }>('summon', ['armor_stand', at.x + 0.5, at.y + 2.25, at.z + 0.5, 'u2stand']);
      // fall 2.25 blocks and settle
      let y = Number.NaN;
      for (let t = 0; t < 20; t++) {
        await sleep(250);
        const e = await bot.truth.ok<{ location: Vec3; valid: boolean }>('entity', [stand.entityId]);
        if (!e.valid) break;
        if (Math.abs(e.location.y - y) < 1e-6) break;
        y = e.location.y;
      }
      const got = Math.round((y - at.y) * 1e4) / 1e4;
      const ok = Math.abs(got - want) < 0.01;
      rows.push(`${(label + sent).padEnd(96)} server ${String(got).padEnd(8)} bot ${String(want).padEnd(8)} (class top ${cls.top}, unknown ${cls.unknown})${ok ? '' : '  DIFFERENT'}`);
      if (!ok) wrong.push(`${label}: server ${got}, bot ${want}`);
      await bot.truth.cmd('killmobs', ['u2stand']);
    }
    lines.push(`standing heights (armor stand footprint ${FOOT.join('-')}):`, ...rows.map((r) => `  ${r}`), ...(skipped.length ? [`  not placed: ${skipped.join('; ')}`] : []));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(wrong).toEqual([]);
  }, 300_000);
});
