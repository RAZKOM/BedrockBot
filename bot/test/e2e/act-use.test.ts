// e2e (tag @bds) for PLAN.md task 7.3, using blocks (skills.useBlock / UseSkill) on bds-act:
//   - a door opened, then closed (`want`), the state read from the lower half; the upper half
//     reports the same; a second 'open' does not click
//   - a fence gate opened, walked through with goto (an open gate has no collision box), closed behind
//   - a trapdoor toggled twice, a button pressed (and released by the server), a lever flipped twice
//   - "open the door, walk through with skills.goto to the far side, close it" with the current goto
//   - refusals: out of reach, iron door, 'open' on a lever; none of them sends a click
// Every state is checked with truth:block and the truth pack's playerInteractWithBlock event.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E_VERSION } from './env.ts';
import { ActArea, E2E, FEET_Y, bit, clearArea, connectActBot, pollUntil, prepareServer, stats, truthLoaded, waitBlock, type ActBot, type TruthPos } from './act-truth.ts';

describe.skipIf(!E2E)('@bds act: using doors, gates, trapdoors, buttons, levers (7.3)', () => {
  let bot: ActBot;
  const area = new ActArea();
  const { x0, z0 } = area;
  const notes: string[] = [];
  const ticks: number[] = [];

  // a stone wall along x at z = z0 with an oak door at x0, a fence along x at z = z0 + 8 with a gate at x0
  const door: Vec3 = { x: x0, y: FEET_Y, z: z0 };
  const doorTop: Vec3 = { x: x0, y: FEET_Y + 1, z: z0 };
  const gate: Vec3 = { x: x0, y: FEET_Y, z: z0 + 8 };
  const south: Vec3 = { x: x0 + 0.5, y: FEET_Y, z: z0 - 2 + 0.5 }; // in front of the door (north side)

  beforeAll(async () => {
    await prepareServer();
    bot = await connectActBot('Use');
    await bot.teleport(south);
    await clearArea(bot.truth, x0, z0 + 4, 16);
    // a closed stone room (walls 3 high) x0-3..x0+3, z0-5..z0, whose only exit is the door in its
    // south wall; a fence pen x0-3..x0+3, z0+4..z0+8 whose only exit is the gate in its south side
    await truthLoaded(bot.truth, 'fill', [x0 - 3, FEET_Y, z0 - 5, x0 + 3, FEET_Y + 2, z0, 'stone']);
    await truthLoaded(bot.truth, 'fill', [x0 - 2, FEET_Y, z0 - 4, x0 + 2, FEET_Y + 2, z0 - 1, 'air']);
    await truthLoaded(bot.truth, 'door', [door.x, door.y, door.z, 'wooden_door', 'west']);
    await truthLoaded(bot.truth, 'fill', [x0 - 3, FEET_Y, z0 + 4, x0 + 3, FEET_Y, z0 + 8, 'oak_fence']);
    await truthLoaded(bot.truth, 'fill', [x0 - 2, FEET_Y, z0 + 5, x0 + 2, FEET_Y, z0 + 7, 'air']);
    await truthLoaded(bot.truth, 'setblock', [gate.x, gate.y, gate.z, 'fence_gate', 'minecraft:cardinal_direction=south']);
    expect(await waitBlock(bot, gate, 'fence_gate')).toBeGreaterThanOrEqual(0);
    await bot.loadout([['cobblestone', 16]]); // a block in the hand: a click on a door must still open it
    await bot.loop.waitTicks(10);
  }, 120_000);

  afterAll(async () => {
    process.stdout.write(`[act-use e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${x0}, ${z0})\n  ticks call->state: ${stats(ticks)}\n  ${notes.join('\n  ')}\n`);
    await bot?.close();
  });

  const states = async (p: Vec3) => (await bot.block(p)).states;

  it('opens a door, then closes it (want), from the lower and the upper half', async () => {
    await bot.teleport(south);
    expect(bot.skills.isOpen(door)).toBe(false);
    const clicks = bot.clicks();
    const o = await bot.skills.useBlock(door, { want: 'open' });
    expect(o, JSON.stringify(o)).toMatchObject({ ok: true, kind: 'door', open: true, changed: true });
    ticks.push(o.ticks!);
    expect(bit((await states(door)).open_bit)).toBe(true);
    expect(bot.skills.isOpen(door)).toBe(true);
    expect(bot.skills.isOpen(doorTop)).toBe(true);
    expect(bot.interacts.some((e) => e.x === door.x && e.y === door.y && e.z === door.z && e.item === 'minecraft:cobblestone')).toBe(true);
    expect((await bot.block({ x: door.x, y: door.y, z: door.z - 1 })).typeId, 'no cobblestone placed by the click').toBe('minecraft:air');
    // already open: no click
    const again = await bot.skills.useBlock(doorTop, { want: 'open' });
    expect(again).toMatchObject({ ok: true, changed: false, open: true });
    expect(bot.clicks()).toBe(clicks + 1);
    // close from the upper half
    const c = await bot.skills.useBlock(doorTop, { want: 'closed' });
    expect(c, JSON.stringify(c)).toMatchObject({ ok: true, kind: 'door', open: false, changed: true });
    ticks.push(c.ticks!);
    expect(bit((await states(door)).open_bit)).toBe(false);
    expect(bot.skills.isOpen(door)).toBe(false);
    notes.push(`door: open ${o.ticks} ticks (click +${o.clickTicks}, face ${o.face}), close via upper half ${c.ticks} ticks`);
  }, 60_000);

  it('opens a fence gate, walks through it with goto and closes it behind', async () => {
    const before = { x: x0 + 0.5, y: FEET_Y, z: z0 + 6 + 0.5 };
    await bot.teleport(before);
    const o = await bot.skills.useBlock(gate, { want: 'open' });
    expect(o, JSON.stringify(o)).toMatchObject({ ok: true, kind: 'fence_gate', open: true });
    ticks.push(o.ticks!);
    expect(bit((await states(gate)).open_bit)).toBe(true);
    const c0 = bot.corrections.length;
    const g = await bot.skills.goto({ type: 'block', p: { x: x0, y: FEET_Y, z: z0 + 10 } });
    expect(g, 'goto through the gate').toEqual({ ok: true });
    const tp = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    expect(tp.location.z).toBeGreaterThan(z0 + 9);
    const c = await bot.skills.useBlock(gate, { want: 'closed' });
    expect(c, JSON.stringify(c)).toMatchObject({ ok: true, open: false });
    ticks.push(c.ticks!);
    expect(bit((await states(gate)).open_bit)).toBe(false);
    notes.push(`gate: opened ${o.ticks} ticks, walked through (${bot.skills.status().lastGoto?.ticks} ticks, corrections ${bot.corrections.length - c0}), closed behind ${c.ticks} ticks`);
    expect(bot.corrections.length - c0).toBe(0);
  }, 60_000);

  it('toggles a trapdoor, presses a button, flips a lever', async () => {
    const at = { x: x0 + 0.5, y: FEET_Y, z: z0 - 6 + 0.5 };
    await bot.teleport(at);
    const trap = { x: x0 + 2, y: FEET_Y, z: z0 - 6 };
    const button = { x: x0 - 2, y: FEET_Y, z: z0 - 6 };
    const lever = { x: x0, y: FEET_Y, z: z0 - 8 };
    await truthLoaded(bot.truth, 'setblock', [trap.x, trap.y, trap.z, 'trapdoor']);
    await truthLoaded(bot.truth, 'set', [button.x - 1, button.y, button.z, 'stone']);
    await truthLoaded(bot.truth, 'setblock', [button.x, button.y, button.z, 'wooden_button', 'facing_direction=5']);
    await truthLoaded(bot.truth, 'setblock', [lever.x, lever.y, lever.z, 'lever', 'lever_direction=up_north_south']);
    expect(await waitBlock(bot, lever, 'lever')).toBeGreaterThanOrEqual(0);

    const t1 = await bot.skills.useBlock(trap);
    expect(t1, JSON.stringify(t1)).toMatchObject({ ok: true, kind: 'trapdoor', open: true });
    expect(bit((await states(trap)).open_bit)).toBe(true);
    const t2 = await bot.skills.useBlock(trap);
    expect(t2).toMatchObject({ ok: true, open: false });
    expect(bit((await states(trap)).open_bit)).toBe(false);

    const b = await bot.skills.useBlock(button);
    expect(b, JSON.stringify(b)).toMatchObject({ ok: true, kind: 'button', open: true });
    expect(bit((await states(button)).button_pressed_bit)).toBe(true);
    const again = await bot.skills.useBlock(button);
    expect(again).toMatchObject({ ok: false, reason: 'already_pressed' });
    const released = await pollUntil(() => bot.skills.isOpen(button) === false, 5_000);
    expect(released, 'button released by the server').toBeGreaterThanOrEqual(0);

    const l1 = await bot.skills.useBlock(lever);
    expect(l1, JSON.stringify(l1)).toMatchObject({ ok: true, kind: 'lever', open: true });
    expect(bit((await states(lever)).open_bit)).toBe(true);
    const l2 = await bot.skills.useBlock(lever, { want: 'toggle' });
    expect(l2).toMatchObject({ ok: true, open: false });
    expect(bit((await states(lever)).open_bit)).toBe(false);
    for (const r of [t1, t2, b, l1, l2]) ticks.push(r.ticks!);
    notes.push(`trapdoor ${t1.ticks}/${t2.ticks} ticks, button ${b.ticks} ticks (released after ${released.toFixed(0)} ms more), lever ${l1.ticks}/${l2.ticks} ticks`);
  }, 60_000);

  /** Walk straight along +z (yaw 0) until the feet pass `z` or `ticks` run out. */
  async function walkSouth(z: number, ticks = 60): Promise<void> {
    bot.loop.setCommand({ yaw: 0, pitch: 0, forward: 1 });
    for (let i = 0; i < ticks && bot.loop.state.pos.z < z; i++) await bot.loop.waitTicks(1);
    bot.loop.release();
    await bot.loop.waitTicks(5);
  }

  it('the closed door blocks; opened, the bot walks through it and closes it behind', async () => {
    await bot.teleport(south);
    expect(bot.skills.isOpen(door)).toBe(false);
    const c0 = bot.corrections.length;
    // closed: the panel (north edge of the cell for cardinal 'west') stops the body
    await walkSouth(z0 + 2.5, 30);
    const blocked = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    expect(blocked.location.z).toBeLessThan(z0);
    const o = await bot.skills.useBlock(door, { want: 'open' });
    expect(o).toMatchObject({ ok: true, open: true });
    await walkSouth(z0 + 2.5);
    const through = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    expect(through.location.z).toBeGreaterThan(z0 + 2);
    const c = await bot.skills.useBlock(door, { want: 'closed' });
    expect(c, JSON.stringify(c)).toMatchObject({ ok: true, open: false });
    ticks.push(o.ticks!, c.ticks!);
    expect(bit((await states(door)).open_bit)).toBe(false);
    notes.push(
      `door walk-through (straight walk): stopped by the closed door at z ${(blocked.location.z - z0).toFixed(3)}, through the open one to ${(through.location.z - z0).toFixed(3)}, closed behind (${c.ticks} ticks, face ${c.face}); corrections ${bot.corrections.length - c0}`,
    );
  }, 60_000);

  // KNOWN GAP (documented in docs/interaction.md): the current nav grid takes minecraft-data's door
  // box, which is the same for every door state, so a door cell is never free and goto answers
  // 'unreachable' at once. Flips to a pass when the navigation track reads skills/interact/shapes.ts
  // doorBoxes(); then turn it into a plain `it`.
  it.fails('goto through the open door (needs door shapes in the nav grid)', async () => {
    await bot.teleport(south);
    const o = await bot.skills.useBlock(door, { want: 'open' });
    expect(o).toMatchObject({ ok: true, open: true });
    try {
      const g = await bot.skills.goto({ type: 'block', p: { x: x0, y: FEET_Y, z: z0 + 2 } }, { timeoutTicks: 400 });
      notes.push(`goto through the open door (current nav): ${JSON.stringify(g)} after ${bot.skills.status().lastGoto?.ticks} ticks`);
      expect(g).toEqual({ ok: true });
    } finally {
      await bot.skills.useBlock(door, { want: 'closed' });
    }
  }, 60_000);

  it('refuses out of reach, an iron door and open/closed on a lever, without a click', async () => {
    await bot.teleport({ x: x0 + 0.5, y: FEET_Y, z: z0 - 9 + 0.5 });
    const iron = { x: x0 + 4, y: FEET_Y, z: z0 - 12 };
    await truthLoaded(bot.truth, 'door', [iron.x, iron.y, iron.z, 'iron_door', 'south']);
    expect(await waitBlock(bot, iron, 'iron_door')).toBeGreaterThanOrEqual(0);
    const clicks = bot.clicks();
    const far = await bot.skills.useBlock(door); // 9 blocks away
    expect(far).toMatchObject({ ok: false, reason: 'out_of_reach' });
    const ironR = await bot.skills.useBlock(iron);
    expect(ironR).toMatchObject({ ok: false, reason: 'not_usable' });
    const lever = { x: x0, y: FEET_Y, z: z0 - 8 };
    const leverR = await bot.skills.useBlock(lever, { want: 'open' });
    expect(leverR).toMatchObject({ ok: false, reason: 'toggle_only' });
    const stone = await bot.skills.useBlock({ x: x0, y: FEET_Y - 1, z: z0 - 9 });
    expect(stone).toMatchObject({ ok: false, reason: 'not_usable' });
    expect(bot.clicks()).toBe(clicks);
    expect(bit((await states(door)).open_bit)).toBe(false);
    notes.push(`refusals: far ${far.reason} (${far.distance?.toFixed(2)} / corner ${far.serverDistance?.toFixed(2)}), iron ${ironR.reason}, lever open ${leverR.reason}, grass ${stone.reason}; 0 clicks`);
  }, 60_000);
});
