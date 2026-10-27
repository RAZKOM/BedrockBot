// e2e (tag @bds), wave 9 Track AN (docs/home.md "Walking distance"): containers chosen by walking
// distance on bds-home (flat, peaceful, truth pack). One afk-task bot in its own random area with a
// home of 6 chests:
//   a, b      on the floor 3 to 4 blocks from home (a holds 5 coal)
//   pillar    3 blocks above the floor on a stone pillar (the stacked chests case): read from the floor
//   walled    2 chests walled in (a 3 x 3 x 3 stone block around each: no standable neighbour)
//   far       12 blocks from home in a straight line, but in a walled room whose door is on the far side
//             (about 37 path blocks)
//   scan      `!chests scan` probes all 6, reads the 3 reachable ones, remembers 3 unreachable ones with
//             their reasons; the scan line has the counts; `!chests unreachable` lists them; `!chests`
//             counts them apart
//   walk 0    `!set homeChestWalk 0` and `!chests scan`: radius only, the far chest is read too (the walled
//             ones stay unreachable: their walks fail)
// Env: HOME_BDS_HOST / HOME_BDS_PORT / HOME_BDS_CONTAINER (home-truth.ts), HOME_VERBOSE=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { chestKey } from '../../src/world/cache/chests.ts';
import { E2E, FEET_Y, prepareServer, privateArea, startHomeBot, teleport, truthLoaded, type HomeBot } from './home-truth.ts';

const F = FEET_Y;
const R = 20;

interface ReachLayout {
  home: Vec3;
  a: Vec3;
  b: Vec3;
  pillar: Vec3;
  walledA: Vec3;
  walledB: Vec3;
  far: Vec3;
}

async function clear(b: HomeBot, c: { x: number; z: number }): Promise<void> {
  const t = b.truth;
  await truthLoaded(t, 'fill', [c.x - R, F - 3, c.z - R, c.x + R, F - 2, c.z + R, 'stone']);
  await truthLoaded(t, 'fill', [c.x - R, F - 1, c.z - R, c.x + R, F - 1, c.z + R, 'grass_block']);
  await truthLoaded(t, 'fill', [c.x - R, F, c.z - R, c.x + R, F + 6, c.z + R, 'air']);
}

async function build(b: HomeBot, c: { x: number; z: number }): Promise<ReachLayout> {
  const L: ReachLayout = {
    home: { x: c.x, y: F, z: c.z },
    a: { x: c.x + 3, y: F, z: c.z + 2 },
    b: { x: c.x - 3, y: F, z: c.z - 2 },
    pillar: { x: c.x, y: F + 3, z: c.z - 6 },
    walledA: { x: c.x - 6, y: F, z: c.z + 5 },
    walledB: { x: c.x - 6, y: F, z: c.z - 6 },
    far: { x: c.x + 12, y: F, z: c.z },
  };
  const t = b.truth;
  await teleport(b, { x: c.x + 0.5, y: F, z: c.z + 0.5 });
  await clear(b, c);
  const set = (p: Vec3, name: string) => truthLoaded(t, 'set', [p.x, p.y, p.z, name]);
  const fill = (p: Vec3, q: Vec3, name: string) => truthLoaded(t, 'fill', [p.x, p.y, p.z, q.x, q.y, q.z, name]);
  await set(L.a, 'chest');
  await set(L.b, 'chest');
  await fill({ x: L.pillar.x, y: F, z: L.pillar.z }, { x: L.pillar.x, y: F + 2, z: L.pillar.z }, 'stone');
  await set(L.pillar, 'chest');
  for (const w of [L.walledA, L.walledB]) {
    await fill({ x: w.x - 1, y: F, z: w.z - 1 }, { x: w.x + 1, y: F + 2, z: w.z + 1 }, 'stone');
    await set(w, 'chest');
  }
  // the far chest's room: x +10..+14, z -12..+12, 3 high, hollow, the door (2 high) on the far side at x +14, z 0
  await fill({ x: c.x + 10, y: F, z: c.z - 12 }, { x: c.x + 14, y: F + 2, z: c.z + 12 }, 'stone');
  await fill({ x: c.x + 11, y: F, z: c.z - 11 }, { x: c.x + 13, y: F + 2, z: c.z + 11 }, 'air');
  await fill({ x: c.x + 14, y: F, z: c.z }, { x: c.x + 14, y: F + 1, z: c.z }, 'air');
  await set(L.far, 'chest');
  await t.chestPut(L.a, 'coal', 5);
  return L;
}

describe.skipIf(!E2E)('@bds home: containers by walking distance (Track AN)', () => {
  const area = privateArea();
  const notes: string[] = [];
  let bot: HomeBot | undefined;
  let L: ReachLayout | undefined;

  beforeAll(async () => {
    await prepareServer();
    const b = await startHomeBot('Reach');
    bot = b;
    b.settings.set('autoUnload', 'off');
    b.home.chore.sessionScan = false; // the test runs the scans itself
    L = await build(b, area);
    b.task.home!.set(L.home);
  }, 180_000);

  afterAll(async () => {
    if (bot) {
      const t = bot.truth;
      if (L) for (const p of [L.a, L.b, L.pillar, L.walledA, L.walledB, L.far]) await truthLoaded(t, 'container', [p.x, p.y, p.z, 'clear']).catch(() => undefined);
      await clear(bot, area).catch(() => undefined);
      await bot.stop();
    }
    console.log(`[home-reach e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  it('!chests scan: probes 6, reads the 3 reachable ones (one on a pillar), remembers 3 unreachable ones', async () => {
    const b = bot!;
    const l = L!;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command('!chests scan');
    expect(await b.reply((s) => s.startsWith('chests: reading '), from)).toBe('chests: reading the containers within 16 blocks of home (walks of up to 32 blocks)');
    const end = await b.reply((s) => /^chests: \d+ within /.test(s), from, 180_000);
    const rep = b.home.logistics.lastScan!;
    notes.push(`scan: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    notes.push(`probes: ${rep.probes} in ${rep.probeMs} ms (${((rep.probeMs ?? 0) / Math.max(1, rep.probes ?? 0)).toFixed(1)} ms per candidate)`);
    const probeLine = b.logs.filter((x) => x.includes('chests: probed ')).at(-1);
    notes.push(`log: ${probeLine}`);
    expect(end).toMatch(/^chests: 6 within 16 blocks, 3 reachable within 32 path blocks, read 3, 3 unreachable, in \d+(\.\d)? s$/);
    const mem = b.home.memory();
    for (const [what, p] of Object.entries({ a: l.a, b: l.b, pillar: l.pillar })) {
      const rec = mem.get(p);
      notes.push(`${what}: readAt ${rec?.readAt ?? 0}, contents ${JSON.stringify(rec?.contents)}`);
      expect(rec?.readAt ?? 0).toBeGreaterThan(0);
      expect(rec!.unreachable).toBeUndefined();
    }
    expect(mem.get(l.a)!.contents).toEqual((await b.truth.box(l.a)).counts);
    for (const [what, p] of Object.entries({ walledA: l.walledA, walledB: l.walledB, far: l.far })) {
      const rec = mem.get(p);
      notes.push(`${what}: unreachable ${rec?.unreachable}`);
      expect(rec?.readAt).toBe(0);
    }
    expect(mem.get(l.walledA)!.unreachable).toMatch(/^no path/);
    expect(mem.get(l.walledB)!.unreachable).toMatch(/^no path/);
    const farPath = /^path (\d+) blocks$/.exec(mem.get(l.far)!.unreachable ?? '');
    expect(farPath).not.toBeNull();
    expect(Number(farPath![1])).toBeGreaterThan(32);
    expect(Number(farPath![1])).toBeLessThan(50);
    // the walks: only to the 3 reachable ones
    expect(b.logs.filter((x) => x.includes('chests: chest at '))).toEqual([]);
  }, 240_000);

  it('!chests unreachable lists them with the reasons; !chests counts them apart', async () => {
    const b = bot!;
    const l = L!;
    const from = b.said.length;
    await b.command('!chests unreachable');
    const line = await b.reply((s) => s.startsWith('chests: 3 unreachable: ') || s.startsWith('chests: none'), from);
    notes.push(`!chests unreachable: ${line}`);
    for (const p of [l.walledA, l.walledB, l.far]) expect(line).toContain(`chest ${p.x} ${p.y} ${p.z}: `);
    expect(line).toMatch(/: path \d+ blocks \(0 min ago\)/);
    const f2 = b.said.length;
    await b.command('!chests');
    const list = await b.reply((s) => s.startsWith('chests: '), f2);
    notes.push(`!chests: ${list}`);
    expect(list).toMatch(/^chests: 6 remembered \(3 reachable, 3 unreachable: !chests unreachable\): 6 chests \| /);
  }, 60_000);

  it('!set homeChestWalk 0, !chests scan: radius only, the far chest is read too', async () => {
    const b = bot!;
    const l = L!;
    const from = b.said.length;
    await b.command('!set homeChestWalk 0');
    expect(await b.reply((s) => s.startsWith('homeChestWalk = '), from)).toMatch(/^homeChestWalk = 0/);
    const f2 = b.said.length;
    const t0 = Date.now();
    await b.command('!chests scan');
    expect(await b.reply((s) => s.startsWith('chests: reading '), f2)).toBe('chests: reading the containers within 16 blocks of home');
    const end = await b.reply((s) => /^chests: \d+ within /.test(s), f2, 240_000);
    notes.push(`walk 0 scan: ${end} (${((Date.now() - t0) / 1000).toFixed(1)} s from the command)`);
    const mem = b.home.memory();
    expect(mem.get(l.far)!.readAt).toBeGreaterThan(0);
    expect(mem.get(l.far)!.unreachable).toBeUndefined();
    expect(mem.get(l.walledA)!.unreachable).toMatch(/^goto: /);
    expect(mem.get(l.walledB)!.unreachable).toMatch(/^goto: /);
    expect(end).toMatch(/^chests: 6 within 16 blocks, read 1, 2 unreachable, 3 read less than 10 min ago, in \d+(\.\d)? s$/);
    notes.push(`walled: ${mem.get(l.walledA)!.unreachable} / ${mem.get(l.walledB)!.unreachable}; far: read ${chestKey(l.far)}`);
    b.settings.reset('homeChestWalk');
  }, 300_000);
});
