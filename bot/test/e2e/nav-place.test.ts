// e2e (tag @bds), PLAN.md tasks 7.2 / 7.3 (planner side): pillar-up and the door / gate move on
// bds-move. They need the navigator's `place` and `useBlock` actions, which Track O's PlaceSkill and
// UseSkill provide (bot/src/skills/index.ts wires them at merge); until then every test here skips
// with a message. The nav-sim unit tests (test/unit/skills/nav-v2.test.ts) cover both moves with
// fake actions meanwhile.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, disconnectBot, fmt, teleport, waitForBlock, type MoveBot } from './move-truth.ts';
import { placeLayout, privateOrigin, trackBody } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

describe.skipIf(!E2E)('@bds nav v2: pillar-up and doors (bds-move)', () => {
  let bot: MoveBot;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = placeLayout(o);

  beforeAll(async () => {
    bot = await connectBot('NavPlace');
    if (!bot.skills.nav.actions.place && !bot.skills.nav.actions.useBlock) return;
    await buildLayout(bot, L.layout);
    await bot.truth.cmd('give', [bot.name, 'cobblestone', 64]);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nav-place e2e] area ${o.x},${o.z}\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  const SKIP_PLACE = 'skipped: the navigator has no place action yet (Track O PlaceSkill, wired in bot/src/skills/index.ts at merge)';
  const SKIP_USE = 'skipped: the navigator has no useBlock action yet (Track O UseSkill, wired in bot/src/skills/index.ts at merge)';

  it('climbs a 4-block cliff by pillaring with cobblestone in the hotbar', async (ctx) => {
    if (!bot.skills.nav.actions.place) {
      summary.push(`cliff: ${SKIP_PLACE}`);
      ctx.skip();
      return;
    }
    await teleport(bot, L.cliffStart, 0);
    const res = await bot.skills.goto({ type: 'block', p: L.cliffTop }, { timeoutTicks: 1200, allowPlace: true });
    const rep = bot.skills.status().lastGoto!;
    summary.push(`cliff: ${JSON.stringify(res)} in ${rep.ticks} ticks, places ${rep.actions.place} (failed ${rep.actions.failed}), end ${fmt(bot.loop.state.pos)}`);
    expect(res).toEqual({ ok: true });
    expect(bot.loop.state.pos.y).toBeCloseTo(L.cliffTop.y, 3);
    expect(rep.actions.place).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('a goto that starts in a 3-deep pit gets out by pillaring', async (ctx) => {
    if (!bot.skills.nav.actions.place) {
      summary.push(`pit: ${SKIP_PLACE}`);
      ctx.skip();
      return;
    }
    await teleport(bot, L.pitBottom, 0);
    const res = await bot.skills.goto({ type: 'block', p: L.pitOut }, { timeoutTicks: 1200, allowPlace: true });
    const rep = bot.skills.status().lastGoto!;
    summary.push(`pit: ${JSON.stringify(res)} in ${rep.ticks} ticks, places ${rep.actions.place}, end ${fmt(bot.loop.state.pos)}`);
    expect(res).toEqual({ ok: true });
    expect(rep.actions.place).toBeGreaterThanOrEqual(2);
  }, 120_000);

  for (const kind of ['door', 'gate'] as const) {
    it(`walks through a closed ${kind} (opened, then closed behind with closeDoors)`, async (ctx) => {
      if (!bot.skills.nav.actions.useBlock) {
        summary.push(`${kind}: ${SKIP_USE}`);
        ctx.skip();
        return;
      }
      const d = L.door;
      if (kind === 'door') {
        // Bedrock 'west' = the panel along the z edge: crossing along z needs it open
        await consoleCommand(MOVE_CONTAINER, 'setblock', String(d.x), String(d.y), String(d.z), 'wooden_door', '["minecraft:cardinal_direction"="west","upper_block_bit"=false,"open_bit"=false]');
        await consoleCommand(MOVE_CONTAINER, 'setblock', String(d.x), String(d.y + 1), String(d.z), 'wooden_door', '["minecraft:cardinal_direction"="west","upper_block_bit"=true]');
        await waitForBlock(bot, { x: d.x, y: d.y + 1, z: d.z }, 'wooden_door');
      } else {
        await bot.truth.fill({ x: d.x, y: d.y + 1, z: d.z }, { x: d.x, y: d.y + 1, z: d.z }, 'air');
        await consoleCommand(MOVE_CONTAINER, 'setblock', String(d.x), String(d.y), String(d.z), 'fence_gate', '["minecraft:cardinal_direction"="south","open_bit"=false]');
        await waitForBlock(bot, d, 'fence_gate');
      }
      await teleport(bot, L.roomInside, 0);
      const tr = trackBody(bot);
      const res = await bot.skills.goto({ type: 'block', p: L.roomOutside }, { timeoutTicks: 1200, closeDoors: true });
      await bot.loop.waitTicks(10);
      tr.stop();
      const rep = bot.skills.status().lastGoto!;
      const after = bot.world.blockAt(d);
      summary.push(`${kind}: ${JSON.stringify(res)} in ${rep.ticks} ticks, use ${rep.actions.use}, close ${rep.actions.close}, failed ${rep.actions.failed}, collisions ${tr.collided}, after: ${after?.name} open_bit ${String(after?.states.open_bit)}`);
      expect(res).toEqual({ ok: true });
      expect(rep.actions.use).toBe(1);
      expect(rep.actions.close).toBe(1);
      expect(Number(after?.states.open_bit ?? 0)).toBe(0);
    }, 120_000);
  }
});
