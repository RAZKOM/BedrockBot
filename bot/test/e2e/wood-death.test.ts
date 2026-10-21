// e2e (tag @bds): GatherWood survives a death (PLAN.md 4.6 + the minimum of 5.1). The CLI bot
// gathers 15 logs in a small forest; while it carries logs it is killed with truth:kill. The
// respawn controller (tasks/respawn.ts) presses respawn, the bot reappears at its spawn point next
// to the chest (set with /spawnpoint), the task resumes from find-tree and finishes. Items dropped at
// the death are not required to come back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_VERSION } from './env.ts';
import {
  E2E,
  WoodArea,
  WOOD_CONTAINER,
  buildLayout,
  connectWoodBot,
  consoleCommand,
  logCount,
  prepareServer,
  sleep,
  startGatherCli,
  waitOnline,
  type GatherCli,
  type TruthContainer,
  type TruthInv,
  type WoodBot,
} from './wood-truth.ts';
import { FEET_Y, gatherForest } from './wood-worlds.ts';

const TARGET = 15;

describe.skipIf(!E2E)('@bds wood: GatherWood resumes after a death', () => {
  let obs: WoodBot;
  let cli: GatherCli | undefined;
  const area = new WoodArea();
  const layout = gatherForest(area.x0, area.z0, area.cell + 7, 12);
  const chest = layout.chest!;
  const notes: string[] = [];

  beforeAll(async () => {
    await prepareServer();
    obs = await connectWoodBot('DObs');
    await obs.teleport(layout.start);
    await buildLayout(obs.truth, layout);
  }, 180_000);

  afterAll(async () => {
    cli?.kill();
    process.stdout.write(`[wood-death e2e] BDS ${E2E_VERSION}, area cell ${area.cell}\n  ${notes.join('\n  ')}\n`);
    await obs?.close();
  });

  it('is killed while carrying logs, respawns next to the chest and still delivers the target', async () => {
    cli = startGatherCli(['--target-logs', String(TARGET), '--chest', `${chest.x},${chest.y},${chest.z}`, '--exit-when-done', '--duration', '600', '--respawn-delay', '2']);
    const c = cli;
    await waitOnline(obs.truth, c.name);
    await consoleCommand(WOOD_CONTAINER, 'spawnpoint', c.name, String(layout.start.x - 0.5), String(FEET_Y), String(layout.start.z - 0.5));
    await obs.truth.ok('tp', [c.name, layout.start.x, layout.start.y, layout.start.z, 0, 0]);
    await obs.teleport({ x: area.x0 + 0.5, y: FEET_Y, z: area.z0 + 30.5 });
    // wait until it carries at least 3 logs, then kill it
    const t0 = performance.now();
    let carried = 0;
    while (performance.now() - t0 < 180_000) {
      const inv = await obs.truth.ok<TruthInv>('inv', [c.name]);
      carried = logCount(inv.counts);
      if (carried >= 3) break;
      await sleep(500);
    }
    expect(carried, 'never carried 3 logs').toBeGreaterThanOrEqual(3);
    const killed = await obs.truth.ok<{ killed: boolean }>('kill', [c.name]);
    expect(killed.killed).toBe(true);
    notes.push(`killed while carrying ${carried} logs after ${((performance.now() - c.startedAt) / 1000).toFixed(1)} s`);
    const code = await Promise.race([c.exit, sleep(540_000).then(() => 'timeout' as const)]);
    const out = c.output();
    const box = await obs.truth.ok<TruthContainer>('container', [chest.x, chest.y, chest.z]);
    const lines = out.split('\n').filter((l) => /paused|resumed|died|respawn|gather: (done|failed)/i.test(l));
    notes.push(`exit ${String(code)}, chest ${logCount(box.counts)} logs, ${((performance.now() - c.startedAt) / 1000).toFixed(1)} s`, ...lines.slice(-8).map((l) => `  cli: ${l.trim()}`));
    expect(code, out.split('\n').slice(-30).join('\n')).toBe(0);
    expect(out).toContain('gather: paused (dead)');
    expect(out).toContain('gather: resumed');
    expect(out).toMatch(/gather: done after .* 1 deaths/);
    expect(logCount(box.counts)).toBeGreaterThanOrEqual(TARGET);
  }, 720_000);
});
