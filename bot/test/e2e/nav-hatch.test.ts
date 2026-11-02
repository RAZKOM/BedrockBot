// e2e (tag @bds), Track BG2 (decisions/0048-trapdoor-moves.md "Realm findings (BG2)", docs/pathfinding.md
// "Trapdoors"): a farm-style hatch on bds-move, built in a private area:
//   - a stone platform (floor layer -54, feet -53) with a spruce trapdoor in its WALKING layer (-53), a wall
//     block beside it, a ladder under it on that wall (-57 .. -54: up into the floor layer), a room 3 high
//     under the platform (feet -57, floor -58; a crafting table and a barrel in it);
//   - the held item varies: a netherite pickaxe, a block (cobblestone), a red shulker box; the bot carries
//     throwaway blocks and plans with allowPlace and allowBreak;
//   - per item: down from the platform into the room (opened, closed behind from the ladder) and up again
//     (opened from below while on the ladder, closed behind from the platform), twice each.
// The probe case measures the cause: a click on the trapdoor from the ladder with each item, sneaking and not.
// 0 corrections expected. MOVE_AREA pins the area; NAV_TRACE=1 prints the per-tick body state of a goto.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, waitForBlock, type MoveBot } from './move-truth.ts';
import { privateOrigin, trackBody, type Fill, type Layout } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

const TRACE = process.env.NAV_TRACE === '1';
const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });

describe.skipIf(!E2E)('@bds nav: the farm hatch with an item in the hand (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const flat = (x1: number, z1: number, x2: number, z2: number): Fill[] => [f(x1, -64, z1, x2, -64, z2, 'bedrock'), f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, -45, z2, 'air')];
  // the hatch column; the room east of it (x + 1 .. x + 2, z - 3 .. z)
  const H = { x: o.x + 6, z: o.z + 8 };
  const hatch: Vec3 = { x: H.x, y: -53, z: H.z };
  const roomGoal: Vec3 = { x: H.x + 1, y: -57, z: H.z };
  const platformGoal: Vec3 = { x: H.x + 3, y: -53, z: H.z - 4 }; // on the platform, off the hatch
  const platformStart: Vec3 = { x: H.x + 3.5, y: -53, z: H.z - 3.5 };
  const fills: Fill[] = [
    ...flat(o.x - 4, o.z - 4, o.x + 20, o.z + 20),
    f(H.x - 4, -58, H.z - 6, H.x + 4, -54, H.z + 2, 'stone'), // the platform's body
    f(H.x + 1, -57, H.z - 3, H.x + 2, -55, H.z, 'air'), // the room
    f(H.x, -57, H.z, H.x, -54, H.z, 'air'), // the shaft (the ladder goes in)
    f(H.x - 1, -53, H.z, H.x - 1, -52, H.z, 'stone'), // the wall block beside the hatch
  ];
  const layout: Layout = { name: 'hatch', anchor: { x: H.x + 0.5, y: -53, z: H.z - 5.5 }, fills };

  const ITEMS = [
    ['netherite_pickaxe', 'a pickaxe'],
    ['cobblestone', 'a block'],
    ['red_shulker_box', 'a shulker box'],
  ] as const;

  /** A spruce trapdoor at the hatch: `direction` 0..3 (open panel at x 0 / x 1 / z 0 / z 1), open or closed. */
  async function trapdoor(direction: number, open: boolean): Promise<void> {
    await consoleCommand(MOVE_CONTAINER, 'setblock', String(hatch.x), String(hatch.y), String(hatch.z), 'spruce_trapdoor', `["direction"=${direction},"open_bit"=${open},"upside_down_bit"=false]`);
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const b = bot.world.blockAt(hatch);
      if (b?.name === 'spruce_trapdoor' && Number(b.states.direction) === direction && Number(b.states.open_bit) === (open ? 1 : 0)) return;
      await bot.loop.waitTicks(1);
    }
    throw new Error(`trapdoor at ${fmt(hatch)} not seen`);
  }

  /** Inventory: `item` selected in slot 0, 32 cobblestone as throwaway blocks in slot 8 (the bot carries blocks). */
  async function hold(item: string | undefined): Promise<void> {
    await bot.truth.ok('clear', [bot.name]);
    if (item) await bot.truth.ok('give', [bot.name, item, 1]);
    await bot.truth.ok('give', [bot.name, 'dirt', 32]);
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      const s = bot.world.inventory.slots;
      if ((!item || s.some((x) => x?.name === item)) && s.some((x) => x?.name === 'dirt')) break;
      await bot.loop.waitTicks(1);
    }
    const slot = item ? bot.world.inventory.slots.findIndex((x) => x?.name === item) : bot.world.inventory.slots.findIndex((x) => !x);
    expect(slot, `${item} in the hotbar`).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(9);
    bot.hotbar.select(slot);
    await bot.loop.waitTicks(3);
  }

  beforeAll(async () => {
    bot = await connectBot('NavHatchR');
    await buildLayout(bot, layout);
    await consoleCommand(MOVE_CONTAINER, 'fill', ...[H.x, -57, H.z, H.x, -54, H.z].map(String), 'ladder', '["facing_direction"=5]');
    await consoleCommand(MOVE_CONTAINER, 'setblock', String(H.x + 2), '-57', String(H.z), 'crafting_table');
    await consoleCommand(MOVE_CONTAINER, 'setblock', String(H.x + 2), '-55', String(H.z), 'barrel');
    await waitForBlock(bot, { x: H.x, y: -54, z: H.z }, 'ladder', 10_000);
    await waitForBlock(bot, { x: H.x + 2, y: -55, z: H.z }, 'barrel', 10_000);
    await bot.loop.waitTicks(10);
  }, 240_000);

  afterAll(async () => {
    console.log(`[nav-hatch e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    try {
      if (bot) {
        await teleport(bot, layout.anchor);
        for (const fl of flat(o.x - 4, o.z - 4, o.x + 20, o.z + 20)) await bot.truth.fill(fl.from, fl.to, fl.block);
      }
    } finally {
      await disconnectBot(bot);
    }
  }, 120_000);

  async function go(label: string, from: Vec3 | undefined, goal: Vec3) {
    if (from) await teleport(bot, from, 180);
    const before = bot.corrections.length;
    const tr = trackBody(bot);
    const trace: string[] = [];
    const offTrace = bot.loop.onBeforeStep((tick, s) => {
      if (TRACE) queueMicrotask(() => trace.push(`tick ${tick} p ${fmt(s.pos)} v ${fmt(s.vel)} g ${s.onGround} ch ${s.collidedHorizontally} | ${JSON.stringify(bot.loop.command)}`));
    });
    const opts = { timeoutTicks: 1200, allowPlace: true, allowBreak: true };
    const plan = bot.skills.nav.plan({ type: 'block', p: goal }, bot.loop.state.pos, opts);
    const res = await bot.skills.goto({ type: 'block', p: goal }, opts);
    await bot.loop.waitTicks(10);
    tr.stop();
    offTrace();
    const got = bot.corrections.slice(before);
    if (TRACE && got.length) console.log(`[nav-hatch trace] ${label}\n${trace.join('\n')}`);
    const rep = bot.skills.status().lastGoto!;
    const td = await truthDiff(bot);
    const m = plan ? plan.path.map((n) => n.move) : [];
    const line =
      `${label}: ${res.ok ? 'ok' : JSON.stringify(res)} in ${rep.ticks} ticks, ${rep.distance.toFixed(1)} blocks, plan ${plan?.status ?? 'none'} (${m.join(' ')}), ` +
      `actions ${JSON.stringify(rep.actions)}, ${got.length} correction(s), stuck ${rep.stuck}, end ${fmt(td.local)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`;
    summary.push(line);
    return { res, rep, tr, got, td, m, line };
  }

  const isOpen = () => Number(bot.world.blockAt(hatch)?.states.open_bit);
  /** Corrections over 0.05 (a 0.015 sideways nudge while climbing past the opened panel shows up now and then; see 0048 "Realm findings"). */
  const big = (cs: { error?: number }[]) => cs.filter((c) => (c.error ?? 1) > 0.05).length;

  it('a click on the closed hatch from the ladder while sneaking: BDS uses the held item (rejected); UseSkill releases sneak and opens it', async () => {
    const rows: string[] = [];
    for (const item of [undefined, 'netherite_pickaxe', 'netherite_sword', 'cobblestone', 'red_shulker_box']) {
      await hold(item);
      for (const keepSneak of [true, false]) {
        await trapdoor(1, false);
        await teleport(bot, { x: H.x + 0.5, y: -55, z: H.z + 0.5 }, 90);
        bot.loop.setCommand({ sneak: true }); // the navigator's hold on a ladder
        await bot.loop.waitTicks(5);
        const r = await bot.skills.useBlock(hatch, { want: 'open', keepSneak });
        rows.push(`${item ?? 'empty hand'}, ${keepSneak ? 'sneak kept (raw)' : 'UseSkill'}: ${r.ok ? 'opened' : r.reason} (face ${r.face}, restores ${r.restores ?? 0})`);
        if (!keepSneak || !item) expect(r.ok, rows.at(-1)).toBe(true);
        else expect(r, rows.at(-1)).toMatchObject({ ok: false, reason: 'rejected' });
        if (!keepSneak) expect(bot.loop.command.sneak).toBe(true); // pressed again after the click
        bot.loop.setCommand({ sneak: false });
        await bot.loop.waitTicks(2);
      }
    }
    summary.push(`clicks from the ladder:\n    ${rows.join('\n    ')}`);
  }, 240_000);

  for (const [item, what] of ITEMS) {
    for (const dir of [1, 0]) {
      it(`with ${what} in the hand (panel ${dir === 1 ? 'opposite' : 'on the side of'} the ladder): down and up through the hatch twice, closed behind every time`, async () => {
        await hold(item);
        await trapdoor(dir, false);
        await teleport(bot, platformStart, 180);
        for (let round = 1; round <= 2; round++) {
          const down = await go(`${item} dir ${dir} down ${round}`, undefined, roomGoal);
          expect(down.res, down.line).toEqual({ ok: true });
          expect(down.rep.actions, down.line).toMatchObject({ use: 1, close: 1, failed: 0, place: 0, dig: 0 });
          expect(big(down.got), down.line).toBe(0);
          expect(Math.abs(down.td.local.y - -57)).toBeLessThan(1e-3);
          expect(isOpen(), down.line).toBe(0);
          const up = await go(`${item} dir ${dir} up ${round}`, undefined, platformGoal);
          expect(up.res, up.line).toEqual({ ok: true });
          expect(up.rep.actions, up.line).toMatchObject({ use: 1, close: 1, failed: 0, place: 0, dig: 0 });
          expect(big(up.got), up.line).toBe(0);
          expect(Math.abs(up.td.local.y - -53)).toBeLessThan(1e-3);
          expect(isOpen(), up.line).toBe(0);
        }
        expect(bot.world.inventory.slots[bot.world.inventory.selected]?.name).toBe(item);
      }, 300_000);
    }
  }
});
