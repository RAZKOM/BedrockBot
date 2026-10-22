// e2e (tag @bds) for PLAN.md task 7.3, placing (skills.place / PlaceSkill) on bds-act:
//   - 16 blocks placed at the requested cells and faces (every face kind: up, down, the four sides;
//     on the floor, against posts, at head height, on top of placed blocks), each verified with
//     truth:block and the truth pack's playerPlaceBlock event; ticks from the call to the block
//   - an item fetched from the main inventory into the hotbar first (item_stack_request)
//   - a 3-high pillar under the feet (jump, place below, land), no correction, standing on top
//   - a one-block bridge step over a trench, then goto across it
//   - refusals: inside the body (head cell; feet cell with jump off), out of reach, no item,
//     occupied, no face; none of them sends a click
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import type { BlockFace, PlaceResult } from '../../src/skills/index.ts';
import { E2E_VERSION } from './env.ts';
import { ActArea, E2E, FEET_Y, clearArea, connectActBot, stats, truthLoaded, waitBlock, type ActBot, type TruthPos, prepareServer } from './act-truth.ts';

describe.skipIf(!E2E)('@bds act: placing blocks (7.3)', () => {
  let bot: ActBot;
  const area = new ActArea();
  const { x0, z0 } = area;
  const home: Vec3 = { x: x0 + 0.5, y: FEET_Y, z: z0 + 0.5 };
  const notes: string[] = [];
  const ticks: number[] = [];
  const clickTicks: number[] = [];

  beforeAll(async () => {
    await prepareServer();
    bot = await connectActBot('Place');
    await bot.teleport(home);
    await clearArea(bot.truth, x0, z0, 20);
    await bot.loop.waitTicks(10);
  }, 120_000);

  afterAll(async () => {
    process.stdout.write(
      `[act-place e2e] BDS ${E2E_VERSION}, area cell ${area.cell} (${x0}, ${z0})\n  ticks call->block: ${stats(ticks)}\n  ticks click->block: ${stats(clickTicks)}\n  ${notes.join('\n  ')}\n`,
    );
    await bot?.close();
  });

  async function placed(p: Vec3, r: PlaceResult, item: string, face?: BlockFace): Promise<void> {
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, block: item });
    if (face) expect(r.face).toBe(face);
    const t = await bot.block(p);
    expect(t.typeId, `truth at ${JSON.stringify(p)}`).toBe(`minecraft:${item}`);
    expect(bot.places.some((e) => e.x === p.x && e.y === p.y && e.z === p.z && e.typeId === `minecraft:${item}`), 'playerPlaceBlock event').toBe(true);
    if (r.ticks !== undefined) ticks.push(r.ticks);
    if (r.clickTicks !== undefined) clickTicks.push(r.clickTicks);
  }

  it('16 blocks at the requested cells and faces', async () => {
    await bot.teleport(home);
    await bot.loadout([
      ['cobblestone', 32],
      ['dirt', 16],
      ['oak_planks', 16],
    ]);
    // supports: four 2-high stone posts at distance 3, two stone blocks overhead
    const posts: Vec3[] = [
      { x: x0 + 3, y: FEET_Y, z: z0 },
      { x: x0 - 3, y: FEET_Y, z: z0 },
      { x: x0, y: FEET_Y, z: z0 + 3 },
      { x: x0, y: FEET_Y, z: z0 - 3 },
    ];
    for (const p of posts) await truthLoaded(bot.truth, 'fill', [p.x, p.y, p.z, p.x, p.y + 1, p.z, 'stone']);
    await truthLoaded(bot.truth, 'set', [x0 + 2, FEET_Y + 3, z0 + 1, 'stone']);
    await truthLoaded(bot.truth, 'set', [x0 - 2, FEET_Y + 3, z0 - 1, 'stone']);
    expect(await waitBlock(bot, { x: x0 - 2, y: FEET_Y + 3, z: z0 - 1 }, 'stone')).toBeGreaterThanOrEqual(0);
    const c0 = bot.corrections.length;

    const cases: { p: Vec3; face?: BlockFace; item: string }[] = [
      // up, on the floor (4)
      { p: { x: x0 + 2, y: FEET_Y, z: z0 + 2 }, face: 'up', item: 'cobblestone' },
      { p: { x: x0 - 2, y: FEET_Y, z: z0 + 2 }, face: 'up', item: 'dirt' },
      { p: { x: x0 + 2, y: FEET_Y, z: z0 - 2 }, face: 'up', item: 'oak_planks' },
      { p: { x: x0 - 2, y: FEET_Y, z: z0 - 2 }, face: 'up', item: 'cobblestone' },
      // the four sides of the posts, feet level (4)
      { p: { x: x0 + 2, y: FEET_Y, z: z0 }, face: 'west', item: 'cobblestone' },
      { p: { x: x0 - 2, y: FEET_Y, z: z0 }, face: 'east', item: 'dirt' },
      { p: { x: x0, y: FEET_Y, z: z0 + 2 }, face: 'north', item: 'oak_planks' },
      { p: { x: x0, y: FEET_Y, z: z0 - 2 }, face: 'south', item: 'cobblestone' },
      // the same at head height (4)
      { p: { x: x0 + 2, y: FEET_Y + 1, z: z0 }, face: 'west', item: 'dirt' },
      { p: { x: x0 - 2, y: FEET_Y + 1, z: z0 }, face: 'east', item: 'oak_planks' },
      { p: { x: x0, y: FEET_Y + 1, z: z0 + 2 }, face: 'north', item: 'cobblestone' },
      { p: { x: x0, y: FEET_Y + 1, z: z0 - 2 }, face: 'south', item: 'dirt' },
      // down, under the overhead blocks (2)
      { p: { x: x0 + 2, y: FEET_Y + 2, z: z0 + 1 }, face: 'down', item: 'cobblestone' },
      { p: { x: x0 - 2, y: FEET_Y + 2, z: z0 - 1 }, face: 'down', item: 'oak_planks' },
      // on top of placed blocks, face chosen by the skill (2)
      { p: { x: x0 + 2, y: FEET_Y + 1, z: z0 + 2 }, item: 'cobblestone' },
      { p: { x: x0 - 2, y: FEET_Y + 1, z: z0 - 2 }, item: 'dirt' },
    ];
    expect(cases.length).toBe(16);
    const faces: Record<string, number> = {};
    for (const c of cases) {
      const r = await bot.skills.place(c.p, { ...(c.face ? { face: c.face } : {}), item: c.item });
      await placed(c.p, r, c.item, c.face);
      faces[r.face!] = (faces[r.face!] ?? 0) + 1;
    }
    expect(Object.keys(faces).sort()).toEqual(['down', 'east', 'north', 'south', 'up', 'west']);
    expect(bot.corrections.length - c0, JSON.stringify(bot.corrections.slice(c0))).toBe(0);
    const inv = bot.world.inventory;
    expect(inv.count('cobblestone') + inv.count('dirt') + inv.count('oak_planks')).toBe(64 - 16);
    notes.push(`16 placed, faces ${JSON.stringify(faces)}`);
  }, 120_000);

  it('fetches the item from the main inventory into the hotbar', async () => {
    await bot.teleport(home);
    // eight non-block items and one dirt fill the hotbar, so the cobblestone lands in slot 9;
    // placing the dirt then empties slot 8
    const filler: [string, number][] = ['stick', 'apple', 'bread', 'bone', 'string', 'feather', 'flint', 'coal'].map((n) => [n, 1]);
    await bot.loadout([...filler, ['dirt', 1], ['cobblestone', 5]]);
    expect(bot.world.inventory.slots[8]).toMatchObject({ name: 'dirt', count: 1 });
    expect(bot.world.inventory.slots[9]).toMatchObject({ name: 'cobblestone', count: 5 });
    const d = { x: x0 + 3, y: FEET_Y, z: z0 - 3 };
    await placed(d, await bot.skills.place(d, { item: 'dirt' }), 'dirt');
    expect(bot.world.inventory.slots[8]).toBeNull();
    const p = { x: x0 + 3, y: FEET_Y, z: z0 + 3 };
    const r = await bot.skills.place(p, { item: 'cobblestone' });
    await placed(p, r, 'cobblestone');
    expect(r.slot).toBe(8);
    const tp = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    expect(tp.selectedSlot).toBe(8);
    const inv = await bot.truth.ok<{ slots: ({ typeId: string; amount: number } | null)[] }>('inv', [bot.name]);
    expect(inv.slots[8]).toMatchObject({ typeId: 'minecraft:cobblestone', amount: 4 });
    expect(inv.slots[9]).toBeNull();
    notes.push(`fetch: cobblestone 9 -> 8 by item_stack_request, placed (${r.ticks} ticks)`);
  }, 60_000);

  it('builds a 3-high pillar under the feet', async () => {
    const base = { x: x0 + 8, z: z0 + 8 };
    await bot.teleport({ x: base.x + 0.5, y: FEET_Y, z: base.z + 0.5 });
    await bot.loadout([['cobblestone', 16]]);
    const c0 = bot.corrections.length;
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = { x: base.x, y: FEET_Y + i, z: base.z };
      const r = await bot.skills.place(p, { item: 'cobblestone' });
      steps.push(`#${i}: ${r.ok ? `ok ${r.ticks} ticks (click +${r.clickTicks}), landed ${r.landed}` : r.reason} feet ${bot.loop.state.pos.y.toFixed(3)}`);
      await placed(p, r, 'cobblestone', 'up');
      expect(r.jumped).toBe(true);
      expect(r.landed).toBe(true);
      expect(bot.loop.state.pos.y).toBeCloseTo(FEET_Y + i + 1, 3);
      await bot.loop.waitTicks(3);
    }
    await bot.loop.waitTicks(10);
    const tp = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    notes.push(`pillar: ${steps.join('; ')}; truth feet ${JSON.stringify(tp.location)} onGround ${tp.isOnGround}, corrections ${bot.corrections.length - c0}`);
    expect(tp.location.y).toBeCloseTo(FEET_Y + 3, 2);
    expect(tp.isOnGround).toBe(true);
    expect(bot.corrections.length - c0).toBe(0);
    for (let i = 0; i < 3; i++) expect((await bot.block({ x: base.x, y: FEET_Y + i, z: base.z })).typeId).toBe('minecraft:cobblestone');
  }, 60_000);

  it('bridges over a 2-wide trench: one step against the block it stands on, then walks across', async () => {
    // trench along z at x = bx + 1 .. bx + 2, 3 deep; the bot on its west rim facing east
    const bx = x0 - 10;
    const bz = z0 + 8;
    await bot.teleport({ x: bx + 0.5, y: FEET_Y, z: bz + 0.5 }, -90);
    await truthLoaded(bot.truth, 'fill', [bx + 1, FEET_Y - 3, bz - 6, bx + 2, FEET_Y - 1, bz + 6, 'air']);
    const step1 = { x: bx + 1, y: FEET_Y - 1, z: bz };
    const step2 = { x: bx + 2, y: FEET_Y - 1, z: bz };
    expect(await waitBlock(bot, step2, 'air')).toBeGreaterThanOrEqual(0);
    await bot.loadout([['cobblestone', 8]]);
    const c0 = bot.corrections.length;
    // the only support of step 1 is the east side of the block under the feet
    const r1 = await bot.skills.place(step1, { item: 'cobblestone' });
    await placed(step1, r1, 'cobblestone', 'east');
    expect(r1.support).toEqual({ x: bx, y: FEET_Y - 1, z: bz });
    const g1 = await bot.skills.goto({ type: 'block', p: { x: bx + 1, y: FEET_Y, z: bz } });
    expect(g1, 'goto onto the step').toEqual({ ok: true });
    const r2 = await bot.skills.place(step2, { item: 'cobblestone' });
    await placed(step2, r2, 'cobblestone');
    const g2 = await bot.skills.goto({ type: 'block', p: { x: bx + 3, y: FEET_Y, z: bz } });
    expect(g2, 'goto across').toEqual({ ok: true });
    const tp = await bot.truth.ok<TruthPos>('pos', [bot.name]);
    notes.push(
      `bridge: step 1 via ${r1.face} of ${JSON.stringify(r1.support)} (${r1.ticks} ticks), step 2 via ${r2.face} of ${JSON.stringify(r2.support)} (${r2.ticks} ticks), across at ${JSON.stringify(tp.location)}, corrections ${bot.corrections.length - c0}`,
    );
    expect(tp.location.x).toBeGreaterThan(bx + 3);
    expect(tp.location.y).toBeCloseTo(FEET_Y, 2);
    expect(bot.corrections.length - c0).toBe(0);
  }, 60_000);


  it('refuses inside the body, out of reach, without item, occupied, without face', async () => {
    await bot.teleport(home);
    await bot.loadout([['cobblestone', 4]]);
    const clicks = bot.clicks();
    const s = bot.loop.state.pos;
    const feet = { x: Math.floor(s.x), y: FEET_Y, z: Math.floor(s.z) };
    const head = await bot.skills.place({ ...feet, y: FEET_Y + 1 });
    expect(head).toMatchObject({ ok: false, reason: 'in_body' });
    const feetNoJump = await bot.skills.place(feet, { jump: false });
    expect(feetNoJump).toMatchObject({ ok: false, reason: 'in_body' });
    const far = { x: x0 + 9, y: FEET_Y, z: z0 - 9 };
    const farR = await bot.skills.place(far);
    expect(farR).toMatchObject({ ok: false, reason: 'out_of_reach' });
    const occupied = await bot.skills.place({ x: x0 + 3, y: FEET_Y, z: z0 });
    expect(occupied).toMatchObject({ ok: false, reason: 'occupied' });
    const noFace = await bot.skills.place({ x: x0 + 1, y: FEET_Y + 4, z: z0 + 1 });
    expect(noFace).toMatchObject({ ok: false, reason: 'no_face' });
    await bot.loadout([['stick', 1]]);
    const noItem = await bot.skills.place({ x: x0 + 1, y: FEET_Y, z: z0 - 1 });
    expect(noItem).toMatchObject({ ok: false, reason: 'no_item' });
    expect(bot.clicks()).toBe(clicks);
    for (const p of [{ ...feet, y: FEET_Y + 1 }, far]) expect((await bot.block(p)).typeId).toBe('minecraft:air');
    notes.push(`refusals: head ${head.reason}, feet(jump off) ${feetNoJump.reason}, far ${farR.reason} (${farR.distance?.toFixed(2)} / corner ${farR.serverDistance?.toFixed(2)}), occupied ${occupied.reason}, no face ${noFace.reason}, no item ${noItem.reason}; 0 clicks sent`);
  }, 60_000);
});
