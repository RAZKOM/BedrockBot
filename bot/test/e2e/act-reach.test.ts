// e2e (tag @bds) for PLAN.md task 7.3: the server's click range for placing and using, measured with
// raw click transactions (the skills refuse beyond SERVER_CLICK_REACH before sending anything).
// The bot stands at a chosen distance from the clicked block (eye to the block's min corner, the
// measure that fits every geometry, see docs/interaction.md) and clicks:
//   place  the top face of a grass block (dirt in the hand), accepted = truth:block shows dirt above
//   use    a lever on the floor, accepted = truth open_bit flips
// Accepted at 7.10 and 7.15, refused at 7.25 and 7.35, for both; the table is printed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickBlockTransaction } from '../../src/skills/container/chest.ts';
import { wireItemOf, SERVER_CLICK_REACH } from '../../src/skills/place/place.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E_VERSION } from './env.ts';
import { ActArea, E2E, FEET_Y, bit, clearArea, connectActBot, prepareServer, truthLoaded, type ActBot } from './act-truth.ts';

const EYE = 1.62;
const DISTANCES = [7.1, 7.15, 7.25, 7.35];

describe.skipIf(!E2E)('@bds act: server click range (7.3)', () => {
  let bot: ActBot;
  const area = new ActArea();
  const { x0, z0 } = area;
  const rows: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await connectActBot('Reach');
    await bot.teleport({ x: x0 + 0.5, y: FEET_Y, z: z0 + 0.5 });
    await clearArea(bot.truth, x0, z0, 20);
    await bot.loadout([['dirt', 16]]);
  }, 120_000);

  afterAll(async () => {
    process.stdout.write(`[act-reach e2e] BDS ${E2E_VERSION}, area cell ${area.cell}; SERVER_CLICK_REACH ${SERVER_CLICK_REACH}\n  ${rows.join('\n  ')}\n`);
    await bot?.close();
  });

  /** Stand so that the eye is `d` from block `b`'s min corner, west of it, same z row. */
  async function standAt(b: Vec3, d: number): Promise<number> {
    const eyeY = FEET_Y + EYE;
    const dy = b.y - eyeY;
    const dz = -0.5; // eye at z + 0.5
    const dx = Math.sqrt(d * d - dy * dy - dz * dz);
    await bot.teleport({ x: b.x - dx, y: FEET_Y, z: b.z + 0.5 }, -90);
    const s = bot.loop.state.pos;
    return Math.hypot(b.x - s.x, b.y - (s.y + EYE), b.z - s.z);
  }

  function click(b: Vec3, face: number): void {
    const s = bot.loop.state.pos;
    const slot = bot.world.inventory.selected;
    bot.conn.queue(
      'inventory_transaction',
      clickBlockTransaction({
        pos: b,
        face: face as 1,
        hotbarSlot: slot,
        held: wireItemOf(bot.world.inventory.slots[slot], bot.world.inventory.rawItem(0, slot)),
        eye: { x: s.x, y: s.y + EYE, z: s.z },
        blockRuntimeId: bot.world.chunks.runtimeIdAt(b.x, b.y, b.z) ?? 0,
      }),
    );
  }

  it('placing: accepted up to about 7.19 (eye to the clicked block min corner)', async () => {
    const results: [number, boolean][] = [];
    for (const [i, d] of DISTANCES.entries()) {
      const s = { x: x0 + 2, y: FEET_Y - 1, z: z0 - 6 + 3 * i };
      const target = { ...s, y: FEET_Y };
      const real = await standAt(s, d);
      click(s, 1);
      await bot.loop.waitTicks(10);
      const t = await truthLoaded<{ typeId: string }>(bot.truth, 'block', [target.x, target.y, target.z]);
      const ok = t.typeId === 'minecraft:dirt';
      results.push([real, ok]);
      rows.push(`place d=${real.toFixed(3)}: ${ok ? 'accepted' : 'refused'}`);
    }
    for (const [d, ok] of results) expect(ok, `place at ${d.toFixed(3)}`).toBe(d < SERVER_CLICK_REACH);
  }, 120_000);

  it('using: the same limit for a lever', async () => {
    const results: [number, boolean][] = [];
    for (const [i, d] of DISTANCES.entries()) {
      const lever = { x: x0 + 2, y: FEET_Y, z: z0 + 4 + 3 * i };
      await truthLoaded(bot.truth, 'setblock', [lever.x, lever.y, lever.z, 'lever', 'lever_direction=up_north_south']);
      const real = await standAt(lever, d);
      click(lever, 4);
      await bot.loop.waitTicks(10);
      const t = await truthLoaded<{ states: Record<string, unknown> }>(bot.truth, 'block', [lever.x, lever.y, lever.z]);
      const ok = bit(t.states.open_bit);
      results.push([real, ok]);
      rows.push(`use (lever) d=${real.toFixed(3)}: ${ok ? 'accepted' : 'refused'}`);
    }
    for (const [d, ok] of results) expect(ok, `use at ${d.toFixed(3)}`).toBe(d < SERVER_CLICK_REACH);
  }, 120_000);
});
