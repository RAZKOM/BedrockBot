// e2e (tag @bds), PLAN.md task 7.15 (and the CLI wiring of 7.12): the real CLI (`node src/index.ts
// --task afk --walk --health-port <953x>`) on bds-cache with a temporary cache root
// (BEDROCKBOT_CACHE_DIR). GET /map.json validates against the zod schema (live tiles around the bot,
// the bot, the cache block), an incremental request sends fewer tiles, GET /map returns the page, and
// after a graceful exit (`--exit-on-chat`) the region files are in <root>/<server id>/.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MapJsonSchema } from '../../src/health/map/schema.ts';
import { serverIdFor } from '../../src/world/cache/index.ts';
import { CACHE_CONTAINER, CACHE_HOST, CACHE_PORT, E2E, prepareServer, sleep, uniqueName } from './cache-truth.ts';
import { CLI_TARGET_ARGS } from './env.ts';
import { consoleCommand } from './skills-truth.ts';

const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
/** Health ports reserved for this track: 9530 to 9539. CACHE_HEALTH_PORT pins one. */
const PORTS = process.env.CACHE_HEALTH_PORT ? [Number(process.env.CACHE_HEALTH_PORT)] : [9531, 9532, 9533, 9534, 9535, 9536, 9537, 9538];

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url);
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
}

describe.skipIf(!E2E)('@bds debug map: /map and /map.json on the CLI health server (bds-cache)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-cache-e2e-cli-'));
  const logDir = mkdtempSync(join(tmpdir(), 'bb-cache-e2e-logs-'));
  let child: ChildProcess | undefined;
  let output = '';
  const summary: string[] = [];

  afterAll(async () => {
    console.log(`[cache-map e2e]\n  ${summary.join('\n  ')}`);
    if (child?.exitCode === null) {
      child.kill();
      await sleep(500);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it('serves a valid /map.json and the /map page; the cache is written on exit', async () => {
    await prepareServer();
    const name = uniqueName('CacheMap');
    const token = `bye-${name}`;
    let port = 0;
    for (const p of PORTS) {
      output = '';
      const c = spawn(
        process.execPath,
        ['src/index.ts', '--task', 'afk', '--walk', ...CLI_TARGET_ARGS, '--host', CACHE_HOST, '--port', String(CACHE_PORT), '--username', name, '--health-port', String(p), '--exit-on-chat', token, '--no-reconnect', '--log-dir', logDir, '--nudge-interval', '0'],
        { cwd: BOT_DIR, env: { ...process.env, BEDROCKBOT_CACHE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      c.stdout.on('data', (d: Buffer) => (output += d.toString()));
      c.stderr.on('data', (d: Buffer) => (output += d.toString()));
      // healthy, or the port was taken
      const t0 = performance.now();
      let up = false;
      while (performance.now() - t0 < 60_000 && c.exitCode === null) {
        try {
          if ((await fetch(`http://127.0.0.1:${p}/healthz`)).status === 200) {
            up = true;
            break;
          }
        } catch {
          // not listening yet
        }
        await sleep(250);
      }
      if (up) {
        child = c;
        port = p;
        break;
      }
      if (c.exitCode === null) c.kill();
      await sleep(300);
    }
    expect(port, `CLI never became healthy:\n${output.slice(-3000)}`).not.toBe(0);
    const base = `http://127.0.0.1:${port}`;

    // tiles appear as columns load
    let json: ReturnType<typeof MapJsonSchema.parse> | undefined;
    const t0 = performance.now();
    while (performance.now() - t0 < 30_000) {
      const r = await getJson(`${base}/map.json?r=6`);
      expect(r.status).toBe(200);
      json = MapJsonSchema.parse(r.body);
      if (json.tiles.length >= 150 && json.bot) break;
      await sleep(500);
    }
    const j = json!;
    const tMap = performance.now();
    const full = await fetch(`${base}/map.json?r=12`);
    const fullText = await full.text();
    const fullMs = performance.now() - tMap;
    const big = MapJsonSchema.parse(JSON.parse(fullText));
    const inc = MapJsonSchema.parse((await getJson(`${base}/map.json?r=12&since=${big.rev}&win=${big.window.cx0},${big.window.cz0},${big.window.cx1},${big.window.cz1}`)).body);
    const page = await fetch(`${base}/map`);
    const html = await page.text();
    summary.push(
      `CLI on port ${port}: /map.json r=6 ${j.tiles.length} tiles (${j.tiles.filter((t) => t.live).length} live), bot ${JSON.stringify(j.bot)}, ${j.entities.length} entities, cache ${JSON.stringify(j.cache)}`,
      `/map.json r=12: ${big.tiles.length} tiles, ${fullText.length} B in ${fullMs.toFixed(0)} ms; incremental (since ${big.rev}): ${inc.tiles.length} tiles; /map ${page.status} ${html.length} B`,
    );
    expect(j.tiles.length).toBeGreaterThanOrEqual(150);
    expect(j.bot).not.toBeNull();
    expect(j.cache).not.toBeNull();
    expect(j.server).toContain(String(CACHE_PORT));
    expect(inc.tiles.length).toBeLessThan(big.tiles.length);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<canvas');

    // graceful exit: the cache is closed and written
    await consoleCommand(CACHE_CONTAINER, 'say', token);
    const t1 = performance.now();
    while (child!.exitCode === null && performance.now() - t1 < 20_000) await sleep(100);
    expect(child!.exitCode, output.slice(-2000)).toBe(0);
    const dir = join(root, serverIdFor(`${CACHE_HOST}:${CACHE_PORT}`));
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.bin'));
    summary.push(`exit 0; ${files.length} region file(s) in ${dir}: ${files.join(' ')}`);
    expect(files.length).toBeGreaterThan(0);
    expect(output).toContain('world cache:');
  }, 180_000);
});
