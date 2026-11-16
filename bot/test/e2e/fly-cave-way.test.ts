// e2e (tag @bds), Track F17 (docs/flight.md "Windows beside the walk (Track F17)", decisions/0091): `!goto` from the open
// to a goal deep in a cave, as the owner asks it: the flight to the mouth, the walk from its landing along the landing
// probe's way (Track W2), and with `flyCaveWindows` the windows proven beside that walk. The hook cave
// (test/unit/skills/fly-cave-way-world.ts: a stone mesa with its mouth 260 blocks out on its far side, a passage 2
// high, a 3 x 3 bore of 72 winding back towards the start, a bend across and a bore back to a chamber round the goal,
// about 34 blocks from the mouth in a straight line and 160 on foot) built with truth:fill in this run's private area,
// seen first by a scripted fly-over into a fresh world cache with the coarse layer over it (as index.ts attaches it),
// on the server FLY_BDS_PORT / FLY_BDS_CONTAINER (fly-truth.ts).
// (The corridor world of the corridor e2e is no such case: its chamber lies 170 blocks from its mouth, and a `!goto`
// lands beside the chamber's hull and digs the 2 blocks in.)
//
// The live flight settings (flyCave on, flyCaveEntry, flyCaveHop, flyLandMobs, flyWayDown, flyLandOver, fireworksMin 32);
// per run `!goto` to the chamber's centre from the start, on each side: `off` (flyCaveWindows off: the walk as it was)
// and `on`. Scored per run: arrived (the reply, and the body in the chamber by the truth pack), the seconds from the
// command to the reply, damage (the truth pack's hurt log), the walk handed the probe's way (its `walk: from the landing
// cell` line), windows flown and landed (the `fly: window N` lines), the windows' proofs (the `fly: the window from`
// lines). FLY_F17_RUNS (3 a side), FLY_F17_SIDES (off,on), FLY_F17_TRACE=1 (every log line of a run, the windows'
// trackers included), FLY_ROCKETS=crafted (the Realm's rockets, fly-truth.ts), FLY_VERBOSE=1.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { silentLogger } from '../../src/log.ts';
import { attachCoarseLayer, type CoarseLayerImpl } from '../../src/skills/coarse/index.ts';
import { WorldCache } from '../../src/world/cache/cache.ts';
import { hookWorld, type HookWorld } from '../unit/skills/fly-cave-way-world.ts';
import { E2E, FEET_Y, giveFlightKit, prepareServer, privateArea, sleep, startFlyBot, teleport, truthLoaded, type FlyBot } from './fly-truth.ts';

const F = FEET_Y;
const RUNS = Number(process.env.FLY_F17_RUNS ?? 3);
const SIDES = (process.env.FLY_F17_SIDES ?? 'off,on').split(',') as ('off' | 'on')[];

interface Row {
  side: 'off' | 'on';
  run: number;
  ok: boolean;
  inChamber: boolean;
  seconds: number;
  damage: number;
  causes: string[];
  way: boolean;
  windows: number;
  landed: number;
  proofs: number;
  taken: number;
  reply: string;
}

describe.skipIf(!E2E)('@bds fly: windows beside the walk to a goal deep in a cave (Track F17)', () => {
  const area = privateArea();
  const rows: Row[] = [];
  const notes: string[] = [];
  let bot: FlyBot | undefined;
  let cache: WorldCache | undefined;
  let cacheDir: string | undefined;
  let coarse: { layer: CoarseLayerImpl; detach: () => void } | undefined;
  let offNav: (() => void) | undefined;
  const w: HookWorld = hookWorld({ x: area.x, z: area.z });
  const home: Vec3 = { x: w.start.x + 0.5, y: F, z: w.start.z + 0.5 };
  // (beside the mesa, every fill's chunks loaded)
  const site: Vec3 = { x: w.mouthX - 45.5, y: F, z: w.start.z - 8.5 };
  const fill = (a: Vec3, b: Vec3, block: string) => truthLoaded(bot!.truth, 'fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 60_000);

  async function flyOver(): Promise<void> {
    const b = bot!;
    await teleport(b, { x: home.x - 260, y: F, z: home.z });
    for (const x of [w.start.x + 60, w.start.x + 120, w.mouthX - 100, w.mouthX - 60, w.mouthX - 20, w.mouthX + 20]) await teleport(b, { x: x + 0.5, y: F, z: w.start.z - 8.5 });
    await teleport(b, { x: w.mouthX - 45.5, y: F, z: w.goal.z + 12.5 });
    await b.built.mobility!.loop.waitTicks(20);
    await teleport(b, home);
  }

  async function trip(side: 'off' | 'on', run: number): Promise<Row> {
    const b = bot!;
    await b.command('!stop');
    await sleep(800);
    b.settings.set('flyCaveWindows', side === 'on');
    await teleport(b, home, -90);
    await giveFlightKit(b, { rockets: 64 });
    const since = await b.truth.now();
    const n0 = b.logs.length;
    const from = b.said.length;
    const t0 = Date.now();
    await b.command(`!goto ${w.goal.x} ${w.goal.y} ${w.goal.z}`);
    const reply = await b.reply((s) => s.startsWith('arrived') || s.startsWith('goto:'), from, 300_000).catch((e: unknown) => `no reply: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    await sleep(1000);
    const logs = b.logs.slice(n0).map((l) => l.replace(/^\S+ (info|warn|error) /, ''));
    const g = await b.truth.glide(b.name);
    const dmg = await b.truth.damageSince(since, b.name);
    const p = g.location;
    const c = w.chamber;
    const inChamber = p.x >= c.x0 && p.x < c.x1 + 1 && p.z >= c.z0 && p.z < c.z1 + 1 && Math.abs(p.y - F) < 0.1;
    const windows = logs.filter((l) => /^fly: window \d+ of the walk/.test(l));
    const proofs = logs.filter((l) => l.startsWith('fly: the window from '));
    const row: Row = {
      side,
      run,
      ok: reply.startsWith('arrived'),
      inChamber,
      seconds,
      damage: Math.round(dmg.total * 10) / 10,
      causes: dmg.causes,
      way: logs.some((l) => l.startsWith('walk: from the landing cell along')),
      windows: windows.length,
      landed: windows.filter((l) => l.includes(' landed at ')).length,
      proofs: proofs.length,
      taken: logs.filter((l) => /^fly: the walk to .* stopped at .* for a window under the roof/.test(l)).length,
      reply,
    };
    rows.push(row);
    // (FLY_F17_TRACE=1: every line of the log, the windows' trackers included)
    const trace = process.env.FLY_F17_TRACE === '1';
    const picked = trace ? logs : logs.filter((l) => /^(fly|walk|flight|corridor: window|landing|goto: plan|route: the reference)[: ]/.test(l));
    const steps = (picked.length ? picked : logs).map((l) => l.slice(0, trace ? 900 : 320));
    notes.push(`${side} #${run}: ${reply} (${seconds} s) | at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)} | damage ${row.damage}${dmg.causes.length ? ` (${dmg.causes.join(',')})` : ''}\n    ${steps.slice(0, trace ? 600 : 80).join('\n    ')}`);
    return row;
  }

  beforeAll(async () => {
    const t0 = Date.now();
    const stage = (what: string): void => void process.stdout.write(`[fly-cave-way e2e] ${((Date.now() - t0) / 1000).toFixed(1)} s: ${what}\n`);
    await prepareServer();
    stage('server prepared');
    bot = await startFlyBot('Fw');
    stage('bot up');
    const s = bot.settings;
    s.set('flyCave', 'on');
    s.set('flyCaveEntry', true);
    s.set('flyCaveHop', true);
    s.set('flyLandMobs', true);
    s.set('flyWayDown', true);
    s.set('flyLandOver', true);
    s.set('fireworksMin', 32);
    cacheDir = mkdtempSync(join(tmpdir(), 'bb-f17-e2e-'));
    cache = new WorldCache({ dir: cacheDir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(bot.built.mobility!.world);
    await teleport(bot, site);
    stage('at the site');
    for (const [i, f] of w.fills.entries()) {
      await fill(f.from, f.to, f.block);
      stage(`fill ${i + 1} of ${w.fills.length} (${f.block})`);
    }
    await bot.built.mobility!.loop.waitTicks(10);
    await flyOver();
    stage('flown over');
    const mob = bot.built.mobility!;
    coarse = attachCoarseLayer(mob.world);
    if (!coarse) throw new Error('no coarse layer: the world has no cache');
    offNav = mob.skills.nav.attachCoarse(coarse.layer, { minBlocks: () => 96 });
  }, 600_000);

  afterAll(async () => {
    offNav?.();
    coarse?.detach();
    if (bot) await bot.stop();
    cache?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('side', 6)}${pad('run', 5)}${pad('arrived', 9)}${pad('chamber', 9)}${pad('s', 8)}${pad('damage', 8)}${pad('way', 5)}${pad('proofs', 8)}${pad('taken', 7)}${pad('windows', 9)}landed`,
      ...rows.map((r) => `${pad(r.side, 6)}${pad(r.run, 5)}${pad(r.ok ? 'yes' : 'NO', 9)}${pad(r.inChamber ? 'yes' : 'NO', 9)}${pad(r.seconds, 8)}${pad(r.damage, 8)}${pad(r.way ? 'yes' : 'no', 5)}${pad(r.proofs, 8)}${pad(r.taken, 7)}${pad(r.windows, 9)}${r.landed}`),
    ];
    for (const side of SIDES) {
      const rs = rows.filter((r) => r.side === side);
      if (!rs.length) continue;
      const s = rs.map((r) => r.seconds).sort((a, b) => a - b);
      table.push(`${side}: ${rs.filter((r) => r.ok).length}/${rs.length} arrived, seconds p50 ${s[Math.floor(s.length / 2)]} (${s[0]}-${s[s.length - 1]}), damage max ${Math.max(...rs.map((r) => r.damage))}, windows ${rs.reduce((a, r) => a + r.windows, 0)} (${rs.reduce((a, r) => a + r.landed, 0)} landed)`);
    }
    console.log(`[fly-cave-way e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}`);
  }, 60_000);

  it(`!goto to the chamber from the open, ${RUNS} runs a side (${SIDES.join(', ')})`, async () => {
    for (let i = 0; i < RUNS; i++) {
      for (const side of SIDES) {
        const r = await trip(side, i + 1);
        expect(r.ok, `${side} #${i + 1}: ${r.reply}`).toBe(true);
        expect(r.inChamber, `${side} #${i + 1}: ${r.reply}`).toBe(true);
        expect(r.damage, `${side} #${i + 1}: ${r.causes.join(',')}`).toBe(0);
        if (side === 'off') expect(r.windows).toBe(0);
      }
    }
  }, 3_600_000);
});
