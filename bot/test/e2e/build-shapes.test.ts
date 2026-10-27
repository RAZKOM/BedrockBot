// e2e (tag @bds), wave 9 Track AL (docs/build.md): scaffolding and structure files on bds-build (flat,
// peaceful, truth pack). One afk-task bot (walking, the CLI's wiring) in its own random area:
//   overhang  a JSON layer structure (a 3-high post and a block one cell beside its top, nothing under
//             it) needs one support scaffold: built, blocksdiff 0 with the scaffold cell air again
//   pillar    `!build pillar ... 7 cobblestone`: 6 blocks from the ground, the 7th from a one-block
//             scaffold column the bot pillars up on; blocksdiff 0, the bot back on the ground
//   probe     the truth pack's probe.mcstructure placed by BDS (truth:place) matches the builder's
//             reader cell by cell (the index order), then a hand-built .mcstructure (gate, with stairs
//             and logs) is built by `!build file gate x y z 90` and matches the rotated reader output
// Env: BUILD_BDS_HOST / BUILD_BDS_PORT / BUILD_BDS_CONTAINER (build-truth.ts), BUILD_VERBOSE=1.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { placeStructure, readMcstructure } from '../../src/skills/build/formats/index.ts';
import { clearArea, E2E, FEET_Y, prepareServer, privateArea, settled, sleep, startBuildBot, teleport, truthLoaded, type BuildBot } from './build-truth.ts';

const F = FEET_Y;
const PROBE = fileURLToPath(new URL('../../../packs/truth/structures/truth/probe.mcstructure', import.meta.url));
const GATE = fileURLToPath(new URL('../unit/fixtures/build/gate.mcstructure', import.meta.url));
const OVERHANG = { name: 'overhang', layers: [['#..'], ['#..'], ['#.#']], legend: { '#': 'cobblestone' } };

describe.skipIf(!E2E)('@bds build: scaffolds and structure files (Track AL)', () => {
  const area = privateArea();
  const notes: string[] = [];
  const builds = mkdtempSync(join(tmpdir(), 'bedrockbot-builds-'));
  let bot: BuildBot | undefined;
  const home: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };

  beforeAll(async () => {
    writeFileSync(join(builds, 'overhang.json'), JSON.stringify(OVERHANG));
    copyFileSync(GATE, join(builds, 'gate.mcstructure'));
    await prepareServer();
    bot = await startBuildBot('Shape', builds);
    await teleport(bot, home);
    await clearArea(bot.truth, area, 20, 12);
    await sleep(500);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await clearArea(bot.truth, area, 20, 12).catch(() => undefined);
      await bot.truth.clearAround(home, 40).catch(() => undefined);
      await bot.stop();
    }
    rmSync(builds, { recursive: true, force: true });
    console.log(`[build-shapes e2e] area cell ${area.cell} (${area.x}, ${area.z})\n  ${notes.join('\n  ')}`);
  }, 120_000);

  async function give(items: Record<string, number>): Promise<void> {
    const b = bot!;
    await b.truth.ok('clear', [b.name]);
    for (const [k, v] of Object.entries(items)) for (let n = v; n > 0; n -= 64) await b.truth.ok('give', [b.name, k, Math.min(64, n)]);
    await sleep(800);
  }

  it('a JSON structure with an overhang: one support scaffold, removed again', async () => {
    const b = bot!;
    await teleport(b, home);
    await give({ cobblestone: 4, dirt: 16 });
    const at = { x: area.x + 3, y: F, z: area.z - 1 };
    const from = b.said.length;
    await b.command(`!build file overhang ${at.x} ${at.y} ${at.z}`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
    expect(first).toBe(`building file overhang at ${at.x} ${at.y} ${at.z}: 4 to place, 1 scaffold`);
    const end = await b.reply((s) => s.startsWith('build file '), from, 300_000);
    const solid = new Set(['0,0', '0,1', '0,2', '2,2']);
    const diff = await b.truth.blocksDiff(at, { x: at.x + 2, y: at.y + 2, z: at.z }, (c) => (solid.has(`${c.x - at.x},${c.y - at.y}`) ? 'cobblestone' : 'air'));
    await sleep(1500);
    const counts = await b.truth.counts(b.name);
    notes.push(`overhang: ${end} | blocksdiff ${diff.diffs} of ${diff.count} ${JSON.stringify(diff.first)} | inventory ${JSON.stringify(counts)}`);
    expect(end).toMatch(/^build file overhang at .*: done, 4 \/ 4 placed, 0 skipped in \d+ s \(\d+ blocks\/min\), 1 scaffold placed \/ 1 removed$/);
    expect(diff.diffs).toBe(0);
    expect(counts.dirt ?? 0).toBe(16); // the scaffold block came back
  }, 360_000);

  it('a 7-block pillar: pillaring up on a scaffold column, the bot back on the ground', async () => {
    const b = bot!;
    await teleport(b, home);
    await give({ cobblestone: 7, dirt: 16 });
    const at = { x: area.x + 4, y: F, z: area.z + 4 };
    const mob = b.built.mobility!;
    let maxY = -Infinity;
    const off = mob.loop.onBeforeStep(() => {
      maxY = Math.max(maxY, mob.loop.state.pos.y);
    });
    const from = b.said.length;
    try {
      await b.command(`!build pillar ${at.x} ${at.y} ${at.z} 7 cobblestone`);
      const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
      expect(first).toBe('building pillar 7 cobblestone: 7 to place, 1 scaffold');
      const end = await b.reply((s) => s.startsWith('build pillar '), from, 300_000);
      const diff = await b.truth.blocksDiff(at, { x: at.x, y: at.y + 6, z: at.z }, () => 'cobblestone');
      await sleep(1000);
      const feet = await settled(b);
      const truthPos = await b.truth.pos(b.name);
      const counts = await b.truth.counts(b.name);
      notes.push(`pillar: ${end} | blocksdiff ${diff.diffs} of ${diff.count} | max feet y ${maxY.toFixed(2)} | end feet ${feet.y.toFixed(2)} (truth ${truthPos.location.y.toFixed(2)}, on ground ${truthPos.isOnGround}) | inventory ${JSON.stringify(counts)} | corrections ${mob.loop.state.corrections}`);
      expect(end).toMatch(/^build pillar 7 cobblestone: done, 7 \/ 7 placed, 0 skipped .*, 1 scaffold placed \/ 1 removed$/);
      expect(diff.diffs).toBe(0);
      expect(maxY).toBeGreaterThanOrEqual(F + 1 - 0.01);
      expect(Math.abs(truthPos.location.y - F)).toBeLessThan(0.01);
      expect(truthPos.isOnGround).toBe(true);
    } finally {
      off();
    }
  }, 360_000);

  it('.mcstructure: the reader matches BDS (truth:place), and !build file builds a rotated one', async () => {
    const b = bot!;
    await teleport(b, home);
    // the probe, placed by the server
    const p = { x: area.x - 8, y: F, z: area.z + 6 };
    await truthLoaded(b.truth, 'place', ['truth:probe', p.x, p.y, p.z]);
    const probe = readMcstructure(readFileSync(PROBE), 'probe');
    const want = new Map(placeStructure(probe, p).map((x) => [`${x.pos.x},${x.pos.y},${x.pos.z}`, x.name]));
    const pd = await b.truth.blocksDiff(p, { x: p.x + 2, y: p.y + 1, z: p.z + 2 }, (c) => want.get(`${c.x},${c.y},${c.z}`) ?? 'air');
    notes.push(`probe placed by BDS vs reader: ${pd.diffs} of ${pd.count} differ ${JSON.stringify(pd.first)}`);
    expect(pd.diffs).toBe(0);
    // the gate, built by the bot, rotated 90 degrees
    const gate = readMcstructure(readFileSync(GATE), 'gate');
    const at = { x: area.x + 3, y: F, z: area.z - 8 };
    const blocks = placeStructure(gate, at, 90);
    const need: Record<string, number> = { dirt: 16 };
    for (const x of blocks) need[x.name] = (need[x.name] ?? 0) + 1;
    await give(need);
    const from = b.said.length;
    await b.command(`!build file gate ${at.x} ${at.y} ${at.z} 90`);
    const first = await b.reply((s) => s.startsWith('building ') || s.startsWith('build'), from);
    expect(first).toMatch(new RegExp(`^building file gate at ${at.x} ${at.y} ${at.z} \\(90\\): 11 to place`));
    const end = await b.reply((s) => s.startsWith('build file '), from, 300_000);
    const gw = new Map(blocks.map((x) => [`${x.pos.x},${x.pos.y},${x.pos.z}`, x.name]));
    // rotated 90: x size 2 (old z), z size 3 (old x)
    const gd = await b.truth.blocksDiff(at, { x: at.x + 1, y: at.y + 2, z: at.z + 2 }, (c) => gw.get(`${c.x},${c.y},${c.z}`) ?? 'air');
    notes.push(`gate: ${end} | blocksdiff ${gd.diffs} of ${gd.count} ${JSON.stringify(gd.first)}`);
    expect(end).toMatch(/^build file gate at .* \(90\): done, 11 \/ 11 placed, 0 skipped/);
    expect(gd.diffs).toBe(0);
  }, 360_000);
});
