// e2e (tag @bds), Track Z (PLAN.md 7.14 + 7.12; docs/mining.md "Ore memory across restarts") on bds-dig
// (flat world, truth pack):
//   run 1   an in-process bot with a world cache (the CLI's layout: <root>/<server id>) stands next to a
//           small cave with 4 exposed coal ores; its OreMemory scan records them, which flags their
//           cache marks `seen`; the cache is closed (written) and the bot disconnects
//   run 2   a NEW PROCESS (the CLI, `--task afk --walk`, BEDROCKBOT_CACHE_DIR = the same root,
//           `--set mineSeenOnly=on`: the legit rule) is put 48 blocks from the cave, beyond the miner's
//           32-block scan, after a control cave with 4 more exposed coal ores was built 48 blocks on the
//           other side (never seen by anyone). `!mine coal_ore 4` (console tell) targets the
//           remembered ores first (log: `(cache, ...)`), mines all 4 of them (truth: gone, 4 coal in
//           the inventory), and never touches the control ores.
// Env: DIG_BDS_HOST / DIG_BDS_PORT / DIG_BDS_CONTAINER (dig-truth.ts), MINE_VERBOSE=1 (CLI output).
// Own random area (x, z from 40 000, 256-block cells), run-unique truth ids, temp cache root removed.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReplyParser, textOf, type Reply } from '../../../packs/truth/src/protocol.ts';
import { Connection } from '../../src/connection/connection.ts';
import { silentLogger } from '../../src/log.ts';
import { OreMemory } from '../../src/skills/mine/seen.ts';
import { InputLoop, flatWorld } from '../../src/skills/input/index.ts';
import { serverIdFor, WorldCache } from '../../src/world/cache/index.ts';
import { World } from '../../src/world/index.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { DIG_CONTAINER, DIG_HOST, DIG_PORT, DIG_TARGET, DigTruth, FEET_Y } from './dig-truth.ts';
import { CLI_TARGET_ARGS, E2E_VERSION } from './env.ts';
import { consoleCommand, sleep, uniqueName } from './world-truth.ts';

const E2E = process.env.BDS_E2E === '1';
const VERBOSE = process.env.MINE_VERBOSE === '1';
const F = FEET_Y;
const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string, every = 250): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

/** A connection that only answers truth replies (and sees chat). */
async function observer(prefix: string, truth: DigTruth): Promise<{ conn: Connection; name: string; close(): Promise<void> }> {
  const name = uniqueName(prefix);
  const conn = new Connection({ version: E2E_VERSION, username: name, logger: silentLogger, reconnect: false });
  const parser = new ReplyParser();
  conn.on('text', (p) => {
    let r: Reply | null;
    try {
      r = parser.feed(textOf(p));
    } catch {
      return;
    }
    if (r && r.cmd !== 'event') truth.receive(r);
  });
  await conn.connect(DIG_TARGET);
  return { conn, name, close: () => conn.disconnectAndFlush('test done') };
}

describe.skipIf(!E2E)('@bds mine: ore memory survives a restart (Track Z)', () => {
  const truth = new DigTruth(DIG_CONTAINER);
  const cell = randomInt(64);
  const ax = 40_000 + 256 * (cell % 8) + 128;
  const az = 40_000 + 256 * Math.floor(cell / 8) + 128;
  const S = { x: ax - 48, z: az }; // run 2 start
  const cx = ax - 96; // the control cave, never seen
  const root = mkdtempSync(join(tmpdir(), 'bb-mine-mem-'));
  const dir = join(root, serverIdFor(`${DIG_HOST}:${DIG_PORT}`));
  const notes: string[] = [];
  const ores = (x0: number): Vec3[] => [
    { x: x0 - 2, y: F, z: az - 2 },
    { x: x0 + 1, y: F + 1, z: az - 2 },
    { x: x0 - 1, y: F + 1, z: az + 2 },
    { x: x0 + 2, y: F, z: az + 2 },
  ];
  const remembered = ores(ax);
  const control = ores(cx);
  let obs: Awaited<ReturnType<typeof observer>> | undefined;
  let cli: ChildProcess | undefined;
  let out = '';

  const fill = (a: Vec3, b: Vec3, block: string) => truth.okLoaded('fill', [a.x, a.y, a.z, b.x, b.y, b.z, block], 30_000);
  /** Stone 9 x 5 x 7 with a 3-wide corridor along x (open at both ends) and the ores in its walls. */
  async function buildCave(x0: number, list: Vec3[]): Promise<void> {
    await fill({ x: x0 - 4, y: F - 1, z: az - 3 }, { x: x0 + 4, y: F + 3, z: az + 3 }, 'stone');
    await fill({ x: x0 - 4, y: F, z: az - 1 }, { x: x0 + 4, y: F + 2, z: az + 1 }, 'air');
    for (const p of list) await truth.okLoaded('set', [p.x, p.y, p.z, 'coal_ore']);
  }
  async function clearCave(x0: number): Promise<void> {
    await fill({ x: x0 - 6, y: F, z: az - 5 }, { x: x0 + 6, y: F + 4, z: az + 5 }, 'air');
    await fill({ x: x0 - 6, y: F - 1, z: az - 5 }, { x: x0 + 6, y: F - 1, z: az + 5 }, 'grass_block');
  }
  const blockName = async (p: Vec3) => String((await truth.okLoaded<{ typeId: string }>('block', [p.x, p.y, p.z])).typeId).replace('minecraft:', '');

  beforeAll(async () => {
    for (const c of [['difficulty', 'peaceful'], ['gamerule', 'domobspawning', 'false'], ['time', 'set', 'noon']]) await consoleCommand(DIG_CONTAINER, ...c);
  });

  afterAll(async () => {
    if (cli?.exitCode === null) cli.kill();
    try {
      if (obs) {
        await truth.ok('tp', [obs.name, S.x + 0.5, F, S.z + 0.5, 0, 0]).catch(() => undefined);
        await sleep(2000);
        await clearCave(ax).catch(() => undefined);
        await clearCave(cx).catch(() => undefined);
        await obs.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    console.log(`[mine-memory e2e] area cell ${cell} (${ax}, ${az})\n  ${notes.join('\n  ')}`);
    if (VERBOSE) console.log(out);
  }, 120_000);

  it('run 1 sees 4 ores (cache marks flagged seen); run 2, a new CLI process, mines them from memory 48 blocks away and ignores never-seen ore', async () => {
    // ---- run 1: in-process bot with the cache in the CLI's directory layout
    const name1 = uniqueName('MineMem');
    const conn = new Connection({ version: E2E_VERSION, username: name1, logger: silentLogger, reconnect: false });
    const world = new World(conn, { version: E2E_VERSION, logger: silentLogger });
    const cache = new WorldCache({ dir, flushIntervalMs: 0, logger: silentLogger });
    cache.attach(world);
    const loop = new InputLoop(conn, { world: flatWorld(), logger: silentLogger });
    const parser = new ReplyParser();
    conn.on('text', (p) => {
      let r: Reply | null;
      try {
        r = parser.feed(textOf(p));
      } catch {
        return;
      }
      if (r && r.cmd !== 'event') truth.receive(r);
    });
    loop.start();
    await conn.connect(DIG_TARGET);
    await world.waitForChunks(2, { timeoutMs: 30_000 });
    await truth.ok('tp', [name1, ax - 7.5, F, az + 0.5, -90, 0]);
    await world.waitForChunks(3, { center: { x: ax, y: F, z: az }, timeoutMs: 30_000 });
    await clearCave(ax);
    await buildCave(ax, remembered);
    await until(() => (remembered.every((p) => world.blockAt(p)?.name === 'coal_ore') ? true : undefined), 10_000, 'ores in the world model');
    const memory = new OreMemory(world);
    const t0 = performance.now();
    const added = memory.scan({ x: ax - 7.5, y: F, z: az + 0.5 }, 32);
    const scanMs = performance.now() - t0;
    const seenMarks = cache.seenMarks({ x: ax, y: F, z: az }, 16);
    notes.push(`run 1: scan recorded ${added} ores in ${scanMs.toFixed(1)} ms, ${memory.persisted} cache marks flagged seen: ${seenMarks.map((m) => key(m)).join(' ')}`);
    expect(added).toBe(4);
    expect(memory.persisted).toBe(4);
    expect(new Set(seenMarks.map(key))).toEqual(new Set(remembered.map(key)));
    memory.dispose();
    loop.stop();
    cache.close();
    world.dispose();
    await conn.disconnectAndFlush('restart');
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin'));
    notes.push(`run 1 closed: region files ${files.join(' ')}`);
    expect(files.length).toBeGreaterThan(0);

    // ---- run 2: a new process with the same cache root
    obs = await observer('MineObs', truth);
    await truth.ok('tp', [obs.name, S.x + 0.5, F, S.z + 0.5, 0, 0]);
    await sleep(3000);
    // the control cave is built BEFORE the new bot joins: it arrives with the chunks, 48 blocks away
    // (beyond the miner's scan), never seen (a block placed while the bot watches counts as seen)
    await clearCave(cx);
    await buildCave(cx, control);
    const name2 = uniqueName('MineCli');
    const logDir = mkdtempSync(join(tmpdir(), 'bb-mine-log-'));
    cli = spawn(
      process.execPath,
      ['src/index.ts', '--task', 'afk', '--walk', '--host', DIG_HOST, '--port', String(DIG_PORT), ...CLI_TARGET_ARGS, '--username', name2, '--no-reconnect', '--log-dir', logDir, '--set', 'mineSeenOnly=on', ...(process.env.MINE_MODE === 'baritone' ? ['--set', 'mineMode=baritone'] : [])], // Track BD: MINE_MODE
      { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BEDROCKBOT_CACHE_DIR: root } },
    );
    cli.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    cli.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    cli.on('exit', () => rmSync(logDir, { recursive: true, force: true }));
    await until(async () => ((await truth.ok<{ players: string[] }>('ping')).players.includes(name2) ? true : undefined), 60_000, 'CLI bot online');
    await sleep(2000);
    await truth.ok('tp', [name2, S.x + 0.5, F, S.z + 0.5, -90, 0]);
    await truth.ok('clear', [name2]);
    await truth.ok('give', [name2, 'stone_pickaxe', 1]);
    await sleep(5000); // chunks around S (both caves at 48 blocks are loaded too)
    const tCmd = Date.now();
    await consoleCommand(DIG_CONTAINER, 'tell', name2, '!mine', 'coal_ore', '4');
    await until(
      async () => {
        const left = await Promise.all(remembered.map(blockName));
        return left.every((n) => n !== 'coal_ore') ? true : undefined;
      },
      240_000,
      'the 4 remembered ores mined',
      1000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; CLI output tail:\n${out.split('\n').slice(-40).join('\n')}`);
    });
    const minedMs = Date.now() - tCmd;
    // the last drop is collected after the dig (up to 120 ticks, then a pickup walk)
    const inv = await until(async () => {
      const i = await truth.ok<{ counts: Record<string, number> }>('inv', [name2]);
      return (i.counts['minecraft:coal'] ?? 0) >= 4 || Date.now() - tCmd > minedMs + 20_000 ? i : undefined;
    }, 30_000, 'coal collected', 500);
    const controlLeft = await Promise.all(control.map(blockName));
    const targets = out.split('\n').filter((l) => l.includes('mine: target'));
    const first = targets[0] ?? '';
    notes.push(`run 2: 4 remembered ores mined ${minedMs} ms after !mine; inventory ${JSON.stringify(inv.counts)}; control ${controlLeft.join(',')}`);
    notes.push(`targets: ${targets.map((l) => l.replace(/^.*mine: target /, '')).join(' | ')}`);
    notes.push(`CLI: ${out.split('\n').filter((l) => /world cache:|mine coal_ore|mining 4|remembered/.test(l)).slice(0, 6).join(' | ')}`);
    expect(first).toMatch(/\(cache, (4[0-9]|5[0-9])\.\d blocks/); // remembered, 40+ blocks away: beyond the 32-block scan
    expect(targets.every((l) => remembered.some((p) => l.includes(`at ${p.x} ${p.y} ${p.z}`)))).toBe(true);
    expect(inv.counts['minecraft:coal'] ?? 0).toBe(4);
    expect(controlLeft.every((n) => n === 'coal_ore')).toBe(true);
  }, 480_000);
});
