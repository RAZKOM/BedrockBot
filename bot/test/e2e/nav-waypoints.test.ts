// e2e (tag @bds), PLAN.md task 7.10 on bds-move: waypoints and `!top` through chat on the real CLI
// (`node src/index.ts --task afk --walk`), owner = the server console (`tell <bot> !...`):
//   !wp set (coordinates and the feet), !goto <waypoint>, the automatic spawn and death waypoints,
//   !top out of a 4-deep shaft (cobblestone in the inventory), and the waypoints surviving a restart
//   (a new process with the same config dir). A test bot (move-truth.ts connectBot) builds the
//   area, asks the truth pack and reads the CLI bot's replies. The config dir is a temp dir (a
//   `{}` config file), removed at the end with the area's blocks.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TextPacket } from '../../src/connection/types.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { BOT_DIR } from './chat-helpers.ts';
import { E2E_TRANSPORT, E2E_VERSION } from './env.ts';
import { E2E, MOVE_CONTAINER, MOVE_HOST, MOVE_PORT, VERBOSE, buildLayout, connectBot, disconnectBot, fmt, hdist, sleep, uniqueName, type MoveBot } from './move-truth.ts';
import { privateOrigin, type Fill, type Layout, type Origin } from './nav-worlds.ts';
import { consoleCommand } from './skills-truth.ts';

const f = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, block: string): Fill => ({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, block });
function flat(x1: number, z1: number, x2: number, z2: number, top = -45): Fill[] {
  return [f(x1, -63, z1, x2, -62, z2, 'dirt'), f(x1, -61, z1, x2, -61, z2, 'grass_block'), f(x1, -60, z1, x2, top, z2, 'air')];
}

function wpLayout(o: Origin) {
  const area = { x1: o.x - 20, z1: o.z - 20, x2: o.x + 30, z2: o.z + 30 };
  const shaft = { x: o.x + 20, z: o.z + 20 };
  const fills: Fill[] = [...flat(area.x1, area.z1, area.x2, area.z2)];
  // a 9 x 9 platform one block up with a 1 x 1 shaft 4 deep (feet -63 at the bottom, -59 on the rim)
  fills.push(f(shaft.x - 4, -60, shaft.z - 4, shaft.x + 4, -60, shaft.z + 4, 'stone'));
  fills.push(f(shaft.x, -63, shaft.z, shaft.x, -60, shaft.z, 'air'));
  const anchor = { x: o.x + 5.5, y: -60, z: o.z + 5.5 };
  return {
    layout: { name: 'wp', anchor, fills } satisfies Layout,
    cleanup: { name: 'wp-cleanup', anchor, fills: flat(area.x1, area.z1, area.x2, area.z2) } satisfies Layout,
    start: { x: o.x + 0.5, y: -60, z: o.z + 0.5 },
    base: { x: o.x + 12, y: -60, z: o.z - 8 },
    elsewhere: { x: o.x - 10.5, y: -60, z: o.z + 10.5 },
    shaftBottom: { x: shaft.x + 0.5, y: -63, z: shaft.z + 0.5 },
  };
}

interface Cli {
  name: string;
  child: ChildProcess;
  output(): string;
  exit: Promise<number | null>;
}

function startCli(name: string, configFile: string, logDir: string): Cli {
  const child = spawn(
    process.execPath,
    ['src/index.ts', '--task', 'afk', '--walk', '--config', configFile, '--version', E2E_VERSION, '--transport', E2E_TRANSPORT, '--host', MOVE_HOST, '--port', String(MOVE_PORT), '--username', name, '--no-reconnect', '--log-dir', logDir, '--nudge-interval', '0'],
    { cwd: BOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  const take = (d: Buffer) => {
    out += d.toString();
    if (VERBOSE) process.stderr.write(d);
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { name, child, output: () => out, exit };
}

describe.skipIf(!E2E)('@bds waypoints and !top through chat (task 7.10, bds-move)', () => {
  let obs: MoveBot;
  let cli: Cli | undefined;
  const summary: string[] = [];
  const o = privateOrigin();
  const L = wpLayout(o);
  const dir = mkdtempSync(join(tmpdir(), 'bot-e2e-wp-'));
  const configFile = join(dir, 'config.json');
  const wpFile = join(dir, 'waypoints', `${MOVE_HOST}_${MOVE_PORT}.json`);
  const name = uniqueName('Wp');
  const lines: { from: string; message: string; at: number }[] = [];
  const t0 = performance.now();

  /** The CLI bot's next chat line matching `re` after `since` (ms), or an error. */
  async function replyTo(re: RegExp, since: number, timeoutMs = 60_000): Promise<string> {
    const tEnd = performance.now() + timeoutMs;
    for (;;) {
      const hit = lines.find((l) => l.at >= since && l.from === name && re.test(l.message));
      if (hit) return hit.message;
      if (performance.now() > tEnd) throw new Error(`no reply matching ${re} from ${name}; got: ${lines.filter((l) => l.at >= since && l.from === name).map((l) => l.message).join(' | ')}\n${cli?.output().slice(-3000)}`);
      await sleep(100);
    }
  }

  /** `tell <bot> !...` from the console; resolves with the reply matching `re`. */
  async function command(cmd: string, re: RegExp, timeoutMs?: number): Promise<string> {
    const since = performance.now();
    await consoleCommand(MOVE_CONTAINER, 'tell', name, cmd);
    return replyTo(re, since, timeoutMs);
  }

  async function startBot(): Promise<void> {
    cli = startCli(name, configFile, join(dir, 'logs'));
    const tEnd = performance.now() + 60_000;
    for (;;) {
      const players = (await obs.truth.ok<{ players: string[] }>('ping')).players;
      if (players.includes(name)) break;
      if (performance.now() > tEnd) throw new Error(`${name} not online: ${cli.output().slice(-2000)}`);
      await sleep(250);
    }
    await sleep(1500); // spawned, chunks loading
  }

  async function stopBot(): Promise<number | null> {
    const c = cli;
    if (!c) return null;
    cli = undefined;
    if (c.child.exitCode === null) c.child.kill('SIGTERM');
    return Promise.race([c.exit, sleep(15_000).then(() => (c.child.kill('SIGKILL'), null))]);
  }

  /** Teleport the CLI bot (truth:tp) and wait until it stands there. */
  async function tpBot(feet: Vec3): Promise<void> {
    await obs.truth.tp(name, feet, 0, 0);
    await sleep(2500); // the CLI adopts the teleport and loads the chunks
  }

  async function truthFeet(): Promise<Vec3> {
    return (await obs.truth.pos(name)).location;
  }

  beforeAll(async () => {
    writeFileSync(configFile, '{}\n');
    obs = await connectBot('WpObs');
    obs.conn.on('text', (p: TextPacket) => {
      lines.push({ from: String(p.source_name ?? '').replace(/§./g, ''), message: String(p.message), at: performance.now() });
    });
    await buildLayout(obs, L.layout);
    await startBot();
    await obs.truth.cmd('clear', [name]);
  }, 240_000);

  afterAll(async () => {
    try {
      await stopBot();
      if (obs) {
        await buildLayout(obs, L.cleanup);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      console.log(`[nav-waypoints e2e] area ${o.x},${o.z}, ${((performance.now() - t0) / 1000).toFixed(1)} s\n  ${summary.join('\n  ')}`);
      await disconnectBot(obs);
    }
  }, 240_000);

  it('!wp set / list and !goto <waypoint>; spawn is set automatically', async () => {
    await tpBot(L.start);
    const set = await command(`!wp set base ${L.base.x} ${L.base.y} ${L.base.z}`, /^waypoint base/);
    expect(set).toBe(`waypoint base set to ${L.base.x} ${L.base.y} ${L.base.z}`);
    const here = await command('!wp set here', /^waypoint here/);
    expect(here).toBe(`waypoint here set to ${Math.floor(L.start.x)} -60 ${Math.floor(L.start.z)}`);
    const list = await command('!wp', /^waypoints/);
    expect(list).toMatch(/base \S+ -60 \S+/);
    expect(list).toMatch(/spawn\* /); // from set_spawn_position at the join
    const t1 = performance.now();
    await command('!goto base', /^walking to base/);
    const arrived = await replyTo(/^(arrived|goto:)/, t1, 60_000);
    const p = await truthFeet();
    summary.push(`!goto base: "${arrived}" after ${((performance.now() - t1) / 1000).toFixed(1)} s, truth ${fmt(p)}; list: ${list}`);
    expect(arrived).toBe(`arrived at base (${L.base.x} ${L.base.y} ${L.base.z})`);
    expect(hdist(p, { x: L.base.x + 0.5, z: L.base.z + 0.5 })).toBeLessThan(0.6);
    // the file in the config dir
    expect(existsSync(wpFile)).toBe(true);
    const saved = JSON.parse(readFileSync(wpFile, 'utf8')) as { waypoints: Record<string, { x: number; y: number | null; z: number; auto: boolean }> };
    expect(saved.waypoints.base).toMatchObject({ x: L.base.x, y: L.base.y, z: L.base.z, auto: false });
    expect(saved.waypoints.spawn?.auto).toBe(true);
    summary.push(`spawn waypoint: ${JSON.stringify(saved.waypoints.spawn)}`);
  }, 120_000);

  it('!top from a 4-deep shaft (cobblestone in the inventory) reaches the surface', async () => {
    await obs.truth.cmd('give', [name, 'cobblestone', 16]);
    await tpBot(L.shaftBottom);
    const before = await truthFeet();
    const t1 = performance.now();
    await command('!top', /^going up/);
    const done = await replyTo(/^(on the surface|top:)/, t1, 60_000);
    const p = await truthFeet();
    summary.push(`!top: "${done}" after ${((performance.now() - t1) / 1000).toFixed(1)} s, from ${fmt(before)} to truth ${fmt(p)}`);
    expect(before.y).toBeCloseTo(-63, 1);
    expect(done).toMatch(/^on the surface/);
    expect(p.y).toBeGreaterThanOrEqual(-59.01);
  }, 120_000);

  it('/spawnpoint (set_spawn_position) moves the spawn waypoint', async () => {
    const sp = { x: L.elsewhere.x - 3.5, y: -60, z: L.elsewhere.z - 0.5 };
    await consoleCommand(MOVE_CONTAINER, 'spawnpoint', name, String(sp.x), String(sp.y), String(sp.z));
    await sleep(1000);
    const w = await command('!wp spawn', /^(waypoint spawn|no waypoint)/);
    summary.push(`/spawnpoint ${sp.x} ${sp.y} ${sp.z}: ${w}`);
    expect(w).toContain(`waypoint spawn (auto): ${sp.x} ${sp.y} ${sp.z},`);
  }, 60_000);

  it('a death sets the death waypoint', async () => {
    await tpBot(L.elsewhere);
    const at = await truthFeet();
    await obs.truth.cmd('kill', [name]);
    await sleep(4000); // death, respawn after 2 s
    const w = await command('!wp death', /^(waypoint death|no waypoint)/);
    summary.push(`death at ${fmt(at)}: ${w}`);
    expect(w).toContain(`waypoint death (auto): ${Math.floor(at.x)} -60 ${Math.floor(at.z)},`);
  }, 120_000);

  it('waypoints survive a restart (new process, same config dir)', async () => {
    await command('!quit', /^bye/); // a graceful leave (a killed process keeps its session: server_id_conflict)
    const c = cli!;
    const code = await Promise.race([c.exit, sleep(15_000).then(() => 'timeout')]);
    cli = undefined;
    summary.push(`first CLI exit code ${code}`);
    expect(code).toBe(0);
    await startBot();
    await tpBot(L.elsewhere);
    const list = await command('!wp list', /^waypoints/);
    expect(list).toContain(`base ${L.base.x} ${L.base.y} ${L.base.z}`);
    expect(list).toContain(`here ${Math.floor(L.start.x)} -60 ${Math.floor(L.start.z)}`);
    expect(list).toContain('death*');
    const t1 = performance.now();
    await command('!goto base', /^walking to base/);
    const arrived = await replyTo(/^(arrived|goto:)/, t1, 60_000);
    const p = await truthFeet();
    summary.push(`after the restart: ${list}; !goto base: "${arrived}" after ${((performance.now() - t1) / 1000).toFixed(1)} s, truth ${fmt(p)}`);
    expect(arrived).toMatch(/^arrived at base/);
    expect(hdist(p, { x: L.base.x + 0.5, z: L.base.z + 0.5 })).toBeLessThan(0.6);
    const status = await command('!status', /^status:/);
    summary.push(`!status: ${status}`);
    expect(status).toMatch(/blacklist 0, waypoints \d+$/);
  }, 180_000);
});
