// e2e (tag @bds): knockback through set_entity_motion. A primed TNT (console `summon tnt`) explodes
// next to the bot on bds-move; BDS pushes the player with set_entity_motion (tagged with an input
// tick), which the InputLoop applies and replays. Counts corrections around the push.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleCommand } from './skills-truth.ts';
import { E2E, MOVE_CONTAINER, buildLayout, connectBot, describeCorrections, disconnectBot, fmt, teleport, truthDiff, type MoveBot } from './move-truth.ts';
import { WALL_LAYOUT } from './nav-worlds.ts';

describe.skipIf(!E2E)('@bds knockback (set_entity_motion) on bds-move', () => {
  let bot: MoveBot;
  const summary: string[] = [];

  beforeAll(async () => {
    bot = await connectBot('NavKnock');
  }, 120_000);

  afterAll(async () => {
    console.log(`[nav-knockback e2e]\n  ${summary.join('\n  ')}`);
    await disconnectBot(bot);
  });

  it('applies the explosion push and stays in sync with the server', async () => {
    await teleport(bot, { x: 10.5, y: -60, z: -100.5 }, 0);
    const before = bot.corrections.length;
    const motionsBefore = bot.loop.state.motions;
    const h0 = bot.skills.status().health;
    await consoleCommand(MOVE_CONTAINER, 'summon', 'tnt', '12.5', '-60', '-100.5');
    // fuse 80 ticks, then the push and the fall
    await bot.loop.waitTicks(130);
    const got = bot.corrections.slice(before);
    const motions = bot.events.filter((e) => e.kind === 'motion');
    const td = await truthDiff(bot);
    const st = bot.skills.status();
    summary.push(
      `tnt: ${bot.loop.state.motions - motionsBefore} motion(s) ${motions.map((m) => (m.kind === 'motion' ? `[tick ${m.tick} v ${fmt(m.velocity)} replayed ${m.replayed}]` : '')).join('')}, ` +
        `${got.length} correction(s), health ${h0} -> ${st.health}, end ${fmt(bot.loop.state.pos)}, truth diff ${td.diff.toFixed(4)}${describeCorrections(got)}`,
    );
    expect(bot.loop.state.motions - motionsBefore).toBeGreaterThan(0);
    expect(td.diff).toBeLessThan(0.05);
    expect(got.length).toBeLessThanOrEqual(1);
    // repair the crater for the other layouts
    await buildLayout(bot, WALL_LAYOUT);
  }, 120_000);
});
