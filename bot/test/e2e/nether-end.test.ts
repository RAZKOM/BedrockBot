// e2e (tag @bds), wave 10 Track AT (docs/nether.md "The End"): the End is read-only this track. One
// afk-task bot teleported (truth:dimtp) to the End, onto a 10 x 10 end stone platform built in the void
// east of the main island (x 300, y 60; the dragon is removed with /kill so it does not interfere):
//   void   from the east edge, `!goto` to a point 6 blocks out over the void: the walk ends with the
//          planner's reason, the bot still on the platform (truth position, dimension the_end), never
//          below its top
//   ledge  a ledge 2 blocks below the platform past its edge (an irreversible drop): `!goto` onto it is
//          refused too (the planner takes no drop over 1 block in the End: `maxDrop` 1)
// Env: NETHER_BDS_HOST / NETHER_BDS_PORT / NETHER_BDS_CONTAINER (nether-truth.ts), NETHER_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dfill, dimTeleport, E2E, netherCmd, prepareServer, sleep, startNetherBot, teleport, truthDimension, type NetherBot } from './nether-truth.ts';

describe.skipIf(!E2E)('@bds the End: no walking off the void edge (Track AT)', () => {
  const notes: string[] = [];
  let bot: NetherBot | undefined;
  const X = 300 + 16 * Math.floor(Math.random() * 8);
  const Z = 16 * Math.floor(Math.random() * 8);

  beforeAll(async () => {
    await prepareServer();
    bot = await startNetherBot('Void');
    const b = bot;
    await dimTeleport(b, 'the_end', { x: X + 4.5, y: 62, z: Z + 4.5 }, -90).catch(() => undefined);
    await dfill(b, 'the_end', { x: X, y: 60, z: Z }, { x: X + 9, y: 60, z: Z + 9 }, 'end_stone');
    await dfill(b, 'the_end', { x: X, y: 61, z: Z }, { x: X + 9, y: 64, z: Z + 9 }, 'air');
    await netherCmd('kill', '@e[type=ender_dragon]').catch(() => undefined);
    await teleport(b, { x: X + 4.5, y: 61, z: Z + 4.5 }, -90);
    await sleep(1000);
    notes.push(`end platform ${X}..${X + 9} / ${Z}..${Z + 9} at y 60`);
  }, 180_000);

  afterAll(async () => {
    console.log(`[nether-end] ${notes.join('\n[nether-end] ')}`);
    await bot?.stop();
  }, 60_000);

  /** `!goto` and the reply, the lowest feet height on the way and the truth position after. */
  async function tryGoto(b: NetherBot, to: string): Promise<{ reply: string; lowest: number; at: { x: number; y: number; z: number }; dim: string }> {
    const mob = b.built.mobility!;
    let lowest = Infinity;
    const off = mob.loop.onBeforeStep((_t, s) => {
      lowest = Math.min(lowest, s.pos.y);
    });
    const from = b.said.length;
    await b.command(`!goto ${to}`);
    const reply = await b.reply((s) => s.startsWith('arrived') || s.startsWith('goto:'), from, 60_000);
    await sleep(1500);
    off();
    const t = await truthDimension(b);
    return { reply, lowest, at: t.location, dim: t.dimension };
  }

  it('!goto over the void from the edge: the planner reason, the bot stays on the platform', async () => {
    const b = bot!;
    const mob = b.built.mobility!;
    await teleport(b, { x: X + 9.5, y: 61, z: Z + 4.5 }, -90); // on the east edge, facing the void
    const r = await tryGoto(b, `${X + 15} 61 ${Z + 4}`);
    notes.push(`void: "${r.reply}"; truth ${r.dim} at ${r.at.x.toFixed(2)} ${r.at.y.toFixed(2)} ${r.at.z.toFixed(2)}; lowest feet ${r.lowest.toFixed(2)}; costs override ${JSON.stringify(mob.skills.nav.costsOverride?.())}`);
    expect(r.reply).toMatch(/^goto: /);
    expect(r.dim).toBe('the_end');
    expect(r.at.y).toBeGreaterThanOrEqual(60.99);
    expect(r.at.x).toBeLessThan(X + 10);
    expect(r.lowest).toBeGreaterThanOrEqual(60.99);
    expect(mob.skills.nav.costsOverride?.()).toEqual({ maxDrop: 1 });
  }, 90_000);

  it('a ledge 2 blocks down past the edge: no irreversible drop in the End', async () => {
    const b = bot!;
    // the ledge X+10..X+13 / Z+2..Z+6 with its top at y 58 (feet 59: a 2-block drop from the platform's 61)
    await dfill(b, 'the_end', { x: X + 10, y: 58, z: Z + 2 }, { x: X + 13, y: 58, z: Z + 6 }, 'end_stone');
    await sleep(1000);
    const r = await tryGoto(b, `${X + 12} 59 ${Z + 4}`);
    notes.push(`ledge: "${r.reply}"; truth ${r.dim} at ${r.at.x.toFixed(2)} ${r.at.y.toFixed(2)} ${r.at.z.toFixed(2)}; lowest feet ${r.lowest.toFixed(2)}`);
    expect(r.reply).toMatch(/^goto: /);
    expect(r.at.y).toBeGreaterThanOrEqual(60.99);
    expect(r.lowest).toBeGreaterThanOrEqual(60.99);
  }, 90_000);
});
