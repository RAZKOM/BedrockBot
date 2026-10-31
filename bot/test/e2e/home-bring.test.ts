// e2e (tag @bds), wave 10 Track AS (docs/home.md "Bring", decision 0040): `!bring` on bds-home (flat,
// peaceful, truth pack). One afk-task bot (walking, the CLI's wiring, settings in memory) in its own
// random area, a second connection (the "player") standing 30 blocks east of home, and a home of 4
// chests built by truth (known contents), read by `!chests scan` first:
//   A  5 east of home    40 torches, 2 stacks of cobblestone
//   B  5 west of home    30 torches, 1 stack of cobblestone        (A and B are 10 blocks apart)
//   C  4 south of home   8 iron ingots, 64 coal
//   D  4 north of home   1 shulker box holding 2 diamonds (filled by truth as a block, broken and
//                        stored by the bot: a box item with its NBT `Items`)
//   torch     `!bring torch 64 to <player>`: 64 torches from both chests to the player (truth: the bot's
//             inventory, the bot within 2 blocks of the player); the memory says 6 left
//   stacks    3 stacks of cobblestone from 2 chests 10 blocks apart to the player 30 blocks away (time)
//   short     `!bring iron 20` with 8 in stock: the reply says 12 short, brings 8
//   box       `!bring diamond 2`: the only source is the box: Track BJ: it holds nothing but the 2 diamonds
//             asked for, so it would be emptied anyway: the box comes whole (no empty box goes back to D)
//   get hint  `!get coal 4` with 64 coal in the chests: the hint line (then `!get stop`)
//   home      `!bring coal home` from 20 blocks away: the coal is carried to home
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from '../../src/connection/connection.ts';
import type { Vec3 } from '../../src/connection/types.ts';
import { createLogger, silentLogger } from '../../src/log.ts';
import { isShulkerBox, shulkerContents } from '../../src/skills/container/chest.ts';
import { E2E_VERSION } from './env.ts';
import { E2E, FEET_Y, HOME_TARGET, hdist, prepareServer, privateArea, sleep, startHomeBot, teleport, truthLoaded, uniqueName, until, VERBOSE, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const centre = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 });

interface Layout {
  home: Vec3;
  a: Vec3;
  b: Vec3;
  c: Vec3;
  d: Vec3;
  player: Vec3;
}

describe.skipIf(!E2E)('@bds home: !bring (Track AS)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let player: Connection | undefined;
  const playerName = uniqueName('BrOwner');
  let L: Layout | undefined;

  const clearBox = async (b: HomeBot, c: { x: number; z: number }) => {
    // the home square and the strip east to the player, on a solid floor
    for (const [x0, z0, x1, z1] of [
      [c.x - 14, c.z - 14, c.x + 14, c.z + 14],
      [c.x + 15, c.z - 5, c.x + 36, c.z + 5],
    ] as const) {
      await truthLoaded(b.truth, 'fill', [x0, F - 3, z0, x1, F - 2, z1, 'stone']);
      await truthLoaded(b.truth, 'fill', [x0, F - 1, z0, x1, F - 1, z1, 'grass_block']);
      await truthLoaded(b.truth, 'fill', [x0, F, z0, x1, F + 6, z1, 'air']);
    }
  };

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Bring');
    bot = b;
    b.settings.set('autoUnload', 'off');
    const c = area;
    const l: Layout = {
      home: { x: c.x, y: F, z: c.z },
      a: { x: c.x + 5, y: F, z: c.z },
      b: { x: c.x - 5, y: F, z: c.z },
      c: { x: c.x, y: F, z: c.z + 4 },
      d: { x: c.x, y: F, z: c.z - 4 },
      player: { x: c.x + 30, y: F, z: c.z },
    };
    L = l;
    await teleport(b, centre(l.home));
    await clearBox(b, c);
    for (const p of [l.a, l.b, l.c, l.d]) await truthLoaded(b.truth, 'set', [p.x, p.y, p.z, 'chest']);
    await b.truth.chestPut(l.a, 'torch', 40);
    await b.truth.chestPut(l.a, 'cobblestone', 64, 2);
    await b.truth.chestPut(l.b, 'torch', 30);
    await b.truth.chestPut(l.b, 'cobblestone', 64);
    await b.truth.chestPut(l.c, 'iron_ingot', 8);
    await b.truth.chestPut(l.c, 'coal', 64);
    // the box: a shulker box block filled by truth, broken and picked up by the bot, stored in D
    const mob = b.built.mobility!;
    const boxAt = { x: c.x + 2, y: F, z: c.z - 2 };
    await truthLoaded(b.truth, 'set', [boxAt.x, boxAt.y, boxAt.z, 'undyed_shulker_box']);
    await b.truth.chestPut(boxAt, 'diamond', 2);
    await b.truth.ok('clear', [b.name]);
    await sleep(500);
    const dg = await mob.skills.dig(boxAt);
    if (!dg.ok) throw new Error(`breaking the box: ${dg.reason}`);
    await mob.skills.collect(5, 100, { origin: centre(boxAt), filter: (i) => isShulkerBox(i.name) });
    const inv = mob.world.inventory;
    const slot = await until(() => {
      const i = inv.slots.findIndex((s, k) => k < 36 && !!s && isShulkerBox(s.name));
      return i >= 0 ? i : undefined;
    }, 10_000, 'the box in the inventory');
    const inside = shulkerContents(inv.rawItem(0, slot));
    if (inside.diamond !== 2) throw new Error(`the box holds ${JSON.stringify(inside)}`);
    const o = await mob.skills.open(l.d);
    if (!o.ok) throw new Error(`opening D: ${o.reason}`);
    const dep = await mob.skills.chest!.depositSlots(o.view, [{ slot, count: 1 }]);
    await mob.skills.closeContainer(o.view);
    if (dep.total !== 1) throw new Error(`storing the box: ${dep.reason}`);
    b.task.home!.set(l.home);
    // the player, 30 blocks east
    player = new Connection({ version: E2E_VERSION, username: playerName, logger: VERBOSE ? createLogger('info', playerName) : silentLogger, reconnect: false });
    await player.connect(HOME_TARGET);
    await sleep(1500);
    await b.truth.tp(playerName, centre(l.player), 270, 0);
    await sleep(1500);
    // the memory first
    const from = b.said.length;
    await b.command('!chests scan');
    const scan = await b.reply((s) => /^chests: \d+ within /.test(s), from, 120_000);
    notes.push(`scan: ${scan}`);
    const d = b.home.memory().get(l.d);
    notes.push(`D in memory: ${JSON.stringify(d?.contents)} boxes ${JSON.stringify(d?.boxes)} inBoxes ${JSON.stringify(d?.inBoxes)}`);
    if (d?.inBoxes?.diamond !== 2) throw new Error('the memory does not know the diamonds in the box');
  }, 300_000);

  afterAll(async () => {
    await player?.disconnectAndFlush('test done').catch(() => undefined);
    if (bot) {
      const l = L;
      if (l) for (const p of [l.a, l.b, l.c, l.d]) await truthLoaded(bot.truth, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
      await clearBox(bot, area).catch(() => undefined);
      await bot.truth.clearAround(centre({ x: area.x, y: F, z: area.z }), 40).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-bring e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  /** The bot at home with an empty inventory. */
  async function reset(b: HomeBot, at?: Vec3): Promise<void> {
    await teleport(b, centre(at ?? L!.home));
    await b.truth.ok('clear', [b.name]);
    await until(() => (b.built.mobility!.world.inventory.slots.slice(0, 36).every((s) => !s) ? true : undefined), 10_000, 'an empty inventory');
    await sleep(300);
  }

  async function bring(b: HomeBot, cmd: string, timeoutMs = 180_000): Promise<{ start: string; end: string; ms: number }> {
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(cmd);
    const start = await b.reply((s) => s.startsWith('bringing ') || s.startsWith('bring: '), from);
    const end = start.startsWith('bring: ') ? start : await b.reply((s) => s.startsWith('brought ') || (s.startsWith('bring: ') && s !== start), from, timeoutMs);
    return { start, end, ms: Date.now() - t0 };
  }

  async function nearPlayer(b: HomeBot): Promise<number> {
    const me = (await b.truth.pos(b.name)).location;
    const them = (await b.truth.pos(playerName)).location;
    return hdist(me, them);
  }

  it('!bring torch 64: 40 + 30 in two chests, 64 to the player 30 blocks away; 6 left in memory', async () => {
    const b = bot!;
    const l = L!;
    await reset(b);
    const r = await bring(b, `!bring torch 64 to ${playerName}`);
    const gap = await nearPlayer(b);
    const counts = await b.truth.counts(b.name);
    notes.push(`torch: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; ${gap.toFixed(2)} blocks from the player; truth inventory ${JSON.stringify(counts)})`);
    expect(r.start).toBe(`bringing 64 torches to ${playerName} (from 2 chests)`);
    expect(r.end).toBe('brought 64 torches (from 2 chests)');
    expect(counts.torch).toBe(64);
    expect(gap).toBeLessThanOrEqual(2.5);
    const ta = await b.truth.box(l.a);
    const tb = await b.truth.box(l.b);
    expect((ta.counts.torch ?? 0) + (tb.counts.torch ?? 0)).toBe(6);
    const mem = b.home.memory();
    expect((mem.get(l.a)!.contents.torch ?? 0) + (mem.get(l.b)!.contents.torch ?? 0)).toBe(6);
    const f2 = b.said.length;
    await b.command('!stock torch');
    const stock = await b.reply((s) => s.startsWith('torch: ') || s.startsWith('stock: '), f2);
    notes.push(`!stock torch after: ${stock}`);
    expect(stock).toMatch(/^torch: 6 in chest /);
  }, 240_000);

  it('3 stacks of cobblestone from 2 chests 10 blocks apart to the player 30 blocks away (measured)', async () => {
    const b = bot!;
    const l = L!;
    await reset(b);
    const r = await bring(b, `!bring cobblestone 192 to ${playerName}`);
    const gap = await nearPlayer(b);
    const counts = await b.truth.counts(b.name);
    notes.push(`3 stacks: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s from the command; ${gap.toFixed(2)} blocks from the player; truth ${JSON.stringify(counts)})`);
    expect(r.end).toBe('brought 192 cobblestone (from 2 chests)');
    expect(counts.cobblestone).toBe(192);
    expect(gap).toBeLessThanOrEqual(2.5);
    expect((await b.truth.box(l.a)).counts.cobblestone ?? 0).toBe(0);
    expect((await b.truth.box(l.b)).counts.cobblestone ?? 0).toBe(0);
  }, 240_000);

  it('!bring iron 20 with 8 in stock: the shortfall, 8 brought', async () => {
    const b = bot!;
    const l = L!;
    await reset(b);
    const r = await bring(b, `!bring iron 20 to ${playerName}`);
    const counts = await b.truth.counts(b.name);
    notes.push(`short: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; truth ${JSON.stringify(counts)})`);
    expect(r.start).toBe(`bringing 20 iron to ${playerName} (from 1 chest, only 8 known: 12 short)`);
    expect(r.end).toBe('brought 8 iron_ingots (from 1 chest; 12 short: the chests hold no more)');
    expect(counts.iron_ingot).toBe(8);
    expect((await b.truth.box(l.c)).counts.iron_ingot ?? 0).toBe(0);
    expect(await nearPlayer(b)).toBeLessThanOrEqual(2.5);
  }, 240_000);

  it('!bring diamond 2: the only source is a shulker box holding just them: the box comes whole (Track BJ)', async () => {
    const b = bot!;
    const l = L!;
    await reset(b);
    const r = await bring(b, `!bring diamond 2 to ${playerName}`);
    const counts = await b.truth.counts(b.name);
    notes.push(`box: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; truth ${JSON.stringify(counts)})`);
    expect(r.start).toBe(`bringing 2 diamonds to ${playerName} (from 1 chest, a full shulker box comes along)`);
    expect(r.end).toBe(`brought 1 shulker box holding 2 diamonds (from 1 chest; a full shulker box out of chest ${l.d.x} ${l.d.y} ${l.d.z})`);
    expect(counts.undyed_shulker_box).toBe(1);
    expect((await b.truth.box(l.d)).counts.undyed_shulker_box ?? 0).toBe(0);
    const d = b.home.memory().get(l.d)!;
    expect(d.boxes).toEqual({ empty: 0, full: 0 });
    expect(d.inBoxes).toBeUndefined();
    expect(await nearPlayer(b)).toBeLessThanOrEqual(2.5);
  }, 240_000);

  it('!get coal 4 with 64 coal in the chests: the hint line (it still goes mining)', async () => {
    const b = bot!;
    await reset(b);
    const from = b.said.length;
    await b.command('!get coal 4');
    const line = await b.reply((s) => s.startsWith('getting '), from);
    notes.push(`get hint: ${line}`);
    expect(line).toBe('getting 4 coal: the chests hold 64 (!bring coal 4 fetches it); mining coal_ore anyway');
    const f2 = b.said.length;
    await b.command('!get stop');
    notes.push(`get stop: ${await b.reply((s) => s.startsWith('stopped') || s.startsWith('get: '), f2).catch(() => 'no reply')}`);
    await sleep(500);
  }, 60_000);

  it('!bring coal home: from 20 blocks away, the coal is carried home', async () => {
    const b = bot!;
    const l = L!;
    await reset(b, { x: l.home.x + 20, y: F, z: l.home.z });
    const r = await bring(b, '!bring coal home');
    const me = (await b.truth.pos(b.name)).location;
    const counts = await b.truth.counts(b.name);
    const gap = hdist(me, centre(l.home));
    notes.push(`home: ${r.start} | ${r.end} (${(r.ms / 1000).toFixed(1)} s; ${gap.toFixed(2)} blocks from home; truth ${JSON.stringify(counts)})`);
    expect(r.start).toBe('bringing 64 coal to home (from 1 chest)');
    expect(r.end).toBe('brought 64 coal home (from 1 chest)');
    expect(counts.coal).toBe(64);
    expect(gap).toBeLessThanOrEqual(2.5);
    const f2 = b.said.length;
    await b.command('!bring status');
    notes.push(`status: ${await b.reply((s) => s.startsWith('bring: '), f2)}`);
  }, 240_000);
});
