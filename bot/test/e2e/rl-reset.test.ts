// e2e (tag @bds) for PLAN.md task 6.1: `rl:reset <scenario> <seed>` in the truth pack. Needs bds-rl
// (udp/19156, docker/compose.rl.yml, truth pack deployed) and BDS_E2E=1:
//   BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e rl-reset
// Done when: 20 consecutive resets, each under 2 s from sending the scriptevent (the bot's own
// command_request) to the parsed reply; identical truth:checksum over the arena box for the same seed,
// different for different seeds; the player at the start with a clear inventory and the axe.
// Between resets the arena is vandalised (blocks set, an item dropped, junk given) so a reset that
// skipped anything would change the checksum or the inventory.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rleDecode } from '../../../packs/truth/src/protocol.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { E2E, connectRlBot, runOrigin, type RlBot } from './rl-truth.ts';

/** Asymmetric matchers typed for object literals (they are `any` otherwise). */
const hasAll = (xs: string[]): string[] => {
  const m: unknown = expect.arrayContaining(xs);
  return m as string[];
};

interface ResetData {
  scenario: string;
  seed: number;
  box: { min: Vec3; max: Vec3 };
  start: Vec3;
  yaw: number;
  tool: string;
  checksum: string;
  trees: number;
  logs: number;
  buildMs: number;
  waitedTicks: number;
  removedEntities: number;
}

const SEEDS = [0, 1, 2, 3];
const RESETS = 20;

describe.skipIf(!E2E)('@bds rl:reset against bds-rl (6.1)', () => {
  let bot: RlBot;
  const origin = runOrigin();
  const rows: { i: number; seed: number; ms: number; hash: string; planned: string; buildMs: number; removed: number; model: boolean }[] = [];
  let warmup = 0;

  beforeAll(async () => {
    bot = await connectRlBot('RlReset', { origin });
  }, 90_000);

  afterAll(async () => {
    const lines = rows.map((r) => `#${String(r.i).padStart(2)} seed ${r.seed}  ${String(r.ms.toFixed(0)).padStart(5)} ms  truth ${r.hash}  plan ${r.planned}  build ${r.buildMs} ms  removed ${r.removed}  model ${r.model ? 'ok' : 'MISMATCH'}`);
    const ms = rows.map((r) => r.ms);
    process.stdout.write(
      `[rl-reset e2e] origin ${origin.join(',')}; warm-up reset (chunk load at the new origin) ${warmup.toFixed(0)} ms\n  ${lines.join('\n  ')}\n  reset ms: min ${Math.min(...ms).toFixed(0)} mean ${(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)).toFixed(0)} max ${Math.max(...ms).toFixed(0)}\n`,
    );
    await bot?.close();
  });

  async function reset(seed: number): Promise<{ data: ResetData; ms: number }> {
    const t0 = performance.now();
    const r = await bot.task.commands.scriptevent('rl:reset', ['forest_small', seed, `origin=${origin[0]},${origin[1]}`], 30_000);
    const ms = performance.now() - t0;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return { data: r.data as ResetData, ms };
  }

  it('20 consecutive resets: < 2 s each, same checksum per seed, different across seeds, player reset', async () => {
    const w0 = await reset(SEEDS[0]!);
    warmup = w0.ms;
    const byseed = new Map<number, Set<string>>();
    for (let i = 0; i < RESETS; i++) {
      const seed = SEEDS[i % SEEDS.length]!;
      // Vandalise the arena and the inventory first.
      const box = w0.data.box;
      await bot.truth.ok('set', [box.min.x + 3 + i, -60, box.min.z + 3, 'stone']);
      await bot.truth.ok('set', [box.max.x - 3, -61, box.max.z - 3 - i, 'air']);
      await bot.truth.ok('spawnitem', [box.min.x + 5.5, -59, box.min.z + 5.5, 'oak_log', 1]);
      await bot.truth.ok('give', [bot.name, 'dirt', 7]);

      const { data, ms } = await reset(seed);
      expect(ms, `reset #${i} took ${ms.toFixed(0)} ms`).toBeLessThan(2000);
      expect(data).toMatchObject({ scenario: 'forest_small', seed, tool: 'minecraft:stone_axe' });
      expect(data.removedEntities).toBeGreaterThanOrEqual(1);
      const { min, max } = data.box;
      const sum = await bot.truth.ok<{ hash: string; count: number }>('checksum', [min.x, min.y, min.z, max.x, max.y, max.z], 30_000);
      expect(sum.hash, `truth checksum vs the plan's (seed ${seed})`).toBe(data.checksum);
      (byseed.get(seed) ?? byseed.set(seed, new Set()).get(seed)!).add(sum.hash);

      const pos = await bot.truth.ok<{ location: Vec3; rotation: { yaw: number } }>('pos', [bot.name]);
      expect(Math.hypot(pos.location.x - data.start.x, pos.location.z - data.start.z), JSON.stringify(pos)).toBeLessThan(0.05);
      expect(Math.abs(pos.location.y - data.start.y)).toBeLessThan(0.1);
      const inv = await bot.truth.ok<{ counts: Record<string, number>; slots: ({ typeId: string } | null)[]; equipment: Record<string, unknown> }>('inv', [bot.name]);
      expect(inv.counts).toEqual({ 'minecraft:stone_axe': 1 });
      expect(inv.slots[0]?.typeId).toBe('minecraft:stone_axe');
      expect(inv.equipment).toEqual({});

      // The bot's own world model catches up with the same blocks (what the observations use).
      const t1 = performance.now();
      let model = false;
      while (performance.now() - t1 < 3000) {
        if ((model = modelChecksum(min, max) === data.checksum)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      rows.push({ i, seed, ms, hash: sum.hash, planned: data.checksum, buildMs: data.buildMs, removed: data.removedEntities, model });
      expect(model, `world model checksum; differences: ${model ? '' : await modelDiff(min, max)}`).toBe(true);
    }
    // Stable afterwards: random ticks (grass/dirt conversion, leaf decay) must not change the arena.
    const last = rows.at(-1)!;
    await new Promise((r) => setTimeout(r, 20_000));
    const { min, max } = w0.data.box;
    const later = await bot.truth.ok<{ hash: string }>('checksum', [min.x, min.y, min.z, max.x, max.y, max.z], 30_000);
    expect(later.hash, 'arena checksum 20 s after the last reset').toBe(last.planned);
    for (const [seed, set] of byseed) expect(set.size, `seed ${seed}: ${[...set].join(', ')}`).toBe(1);
    const all = [...byseed.values()].map((s) => [...s][0]);
    expect(new Set(all).size, `checksums per seed: ${all.join(', ')}`).toBe(SEEDS.length);
  }, 240_000);

  it('bad requests answer with a reason, not silence', async () => {
    const a = await bot.task.commands.scriptevent('rl:reset', ['nope', 1]);
    expect(a).toMatchObject({ ok: false, reason: 'bad_args' });
    const b = await bot.task.commands.scriptevent('rl:reset', ['forest_small', 'x']);
    expect(b).toMatchObject({ ok: false, reason: 'bad_args' });
    const c = await bot.task.commands.scriptevent('rl:reset', ['forest_small', 1, 'tool=not_an_item', `origin=${origin[0]},${origin[1]}`]);
    expect(c).toMatchObject({ ok: false, reason: 'unknown_item' });
    const h = await bot.task.commands.scriptevent('rl:help');
    expect(h).toMatchObject({ ok: true, data: { scenarios: hasAll(['forest_small', 'forest', 'single_tree']) } });
  }, 60_000);

  /** Blocks where the bot's model and truth:blocks disagree (first 20). */
  async function modelDiff(min: Vec3, max: Vec3): Promise<string> {
    const out: string[] = [];
    for (let y = min.y; y <= max.y && out.length < 20; y++) {
      const b = await bot.truth.ok<{ palette: string[]; runs: [number, number][] }>('blocks', [min.x, y, min.z, max.x, y, max.z]);
      const ids = rleDecode(b.palette, b.runs);
      let n = 0;
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          const t = ids[n++];
          const m = bot.task.world.blockAt({ x, y, z });
          const mn = m ? `minecraft:${m.name}` : 'unloaded';
          if (mn !== t && out.length < 20) out.push(`${x},${y},${z} truth ${t} model ${mn}`);
        }
      }
    }
    return out.join('; ');
  }

  function modelChecksum(min: Vec3, max: Vec3): string | undefined {
    return bot.task.world.checksum(min, max);
  }
});
