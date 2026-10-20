// e2e (tag @bds) for digging, PLAN.md Phase 4 tasks 4.1 (break-time table, dig()) and 4.2 (tool
// selection, hotbar switching), plus the server reach limit. Needs the bds-dig container (udp/19148,
// docker/compose.dig.yml, truth pack deployed) and BDS_E2E=1:
//   BDS_E2E=1 pnpm --filter bot test:e2e
// Prints the measured break-time table. DIG_VERBOSE=1 logs every dig.
//
// Self-healing: every run digs in its own random area and never reuses a dig position (see
// dig-truth.ts), so a killed earlier run, a concurrent run of this suite (every track's e2e gate
// runs the whole project) or a leftover server-side break timer cannot affect it; afterEach
// cancels any dig still running so its abort_break goes out even when an assertion threw.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/connection/types.ts';
import { blockMining, toolOf } from '../../src/data/mining.ts';
import { estimateBreak, serverReachDistance, type DigResult } from '../../src/skills/dig/index.ts';
import { E2E, FEET_Y, RunArea, connectDigBot, killItemsNear, pollUntil, prepareServer, type DigBot } from './dig-truth.ts';

const DROPS: Record<string, string> = { grass_block: 'dirt', dirt: 'dirt', oak_log: 'oak_log' };

interface Row {
  label: string;
  block: string;
  item: string;
  expected: number;
  ticks: number | undefined;
  ms: number | undefined;
  restores: number | undefined;
  ok: boolean;
  reason: string | undefined;
}

function expectedTicks(block: string, item: string | null): number {
  return estimateBreak(blockMining(block)!, toolOf(item)).ticks;
}

/**
 * The measured tick count may be one below the table: it is counted on the bot's 20 Hz driver from
 * the tick that queued start_break, while the server counts from the server tick that processed it,
 * which can fall into the same 50 ms. It must never be more than 2 above (PLAN.md 4.1).
 */
function expectTicks(r: DigResult, expected: number, label: string): void {
  expect(r.ok, `${label}: ${JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`).toBe(true);
  expect(r.ticks, `${label}: measured ${r.ticks} vs table ${expected}`).toBeGreaterThanOrEqual(expected - 1);
  expect(r.ticks, `${label}: measured ${r.ticks} vs table ${expected}`).toBeLessThanOrEqual(expected + 2);
}

describe.skipIf(!E2E)('@bds dig against bds-dig', () => {
  let bot: DigBot;
  /** This run's area: the bot stands at area.home; every case digs a fresh position next to it. */
  const area = new RunArea();
  const rows: Row[] = [];
  const notes: string[] = [];

  async function place(p: Vec3, block: string): Promise<void> {
    await bot.truth.ok('set', [p.x, p.y, p.z, block]);
    const waited = await pollUntil(() => bot.world.blockAt(p)?.name === block, 2_000);
    expect(waited, `${block} at ${p.x},${p.y},${p.z} not seen by the world model (has ${bot.world.blockAt(p)?.name}, updates ${JSON.stringify(bot.world.updates.stats)})`).toBeGreaterThanOrEqual(0);
  }

  /** Empty inventory, then the items in order (truth:give fills the first free slot: 0, 1, 2, ...). */
  async function loadout(items: string[]): Promise<void> {
    // Drops of earlier cases that were not picked up yet would land in the new loadout.
    await killItemsNear(area.home);
    await bot.loop.waitTicks(2);
    await bot.truth.ok('clear', [bot.name]);
    for (const i of items) await bot.truth.ok('give', [bot.name, i, 1]);
    const ok = await pollUntil(() => items.every((name, slot) => bot.world.inventory.slots[slot]?.name === name) && bot.world.inventory.slots.slice(items.length, 9).every((s) => !s), 3_000);
    expect(ok, `inventory model: ${JSON.stringify(bot.world.inventory.slots.slice(0, 9).map((s) => s?.name ?? null))}`).toBeGreaterThanOrEqual(0);
    if (bot.world.inventory.selected !== 0) bot.hotbar.select(0);
    await bot.loop.waitTicks(2);
  }

  async function breakEventFor(p: Vec3, since: number): Promise<DigBot['breaks'][number] | undefined> {
    let ev: DigBot['breaks'][number] | undefined;
    await pollUntil(() => {
      ev = bot.breaks.slice(since).find((b) => b.player === bot.name && b.x === p.x && b.y === p.y && b.z === p.z);
      return ev !== undefined;
    }, 2_000);
    return ev;
  }

  /** Places `block` at a fresh position, digs it with `opts`, checks the table, the truth event, the drop and the block. */
  async function digCase(label: string, block: string, opts: Parameters<DigBot['digger']['dig']>[1], heldItem: string | null): Promise<DigResult> {
    const target = area.next();
    await place(target, block);
    const expected = expectedTicks(block, heldItem);
    const breaksBefore = bot.breaks.length;
    const itemsBefore = bot.itemsAdded.length;
    const r = await bot.digger.dig(target, opts);
    rows.push({ label, block, item: heldItem ?? 'hand', expected, ticks: r.ticks, ms: r.ms, restores: r.restores, ok: r.ok, reason: r.ok ? undefined : r.reason });
    expectTicks(r, expected, label);
    expect(r.item ?? null).toBe(heldItem);
    // truth: the block is gone and the pack saw a playerBreakBlock with that tool
    const t = await bot.truth.ok<{ typeId: string }>('block', [target.x, target.y, target.z]);
    expect(t.typeId).toBe('minecraft:air');
    const ev = await breakEventFor(target, breaksBefore);
    expect(ev, `${label}: no playerBreakBlock event`).toBeDefined();
    expect(ev?.typeId).toBe(`minecraft:${block}`);
    expect(ev?.tool ?? null).toBe(heldItem ? `minecraft:${heldItem}` : null);
    // the drop: an item entity next to the block (it is picked up right after, so look at additions)
    const center = { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 };
    let drop: DigBot['itemsAdded'][number] | undefined;
    await pollUntil(() => {
      drop = bot.itemsAdded.slice(itemsBefore).find((d) => Math.hypot(d.e.pos.x - center.x, d.e.pos.y - center.y, d.e.pos.z - center.z) < 1.5);
      return drop !== undefined;
    }, 2_000);
    expect(drop, `${label}: no item entity near the block`).toBeDefined();
    expect(drop?.e.item?.name).toBe(DROPS[block]);
    return r;
  }

  beforeAll(async () => {
    await prepareServer();
    bot = await connectDigBot('Dig');
    const others = (await bot.truth.ok<{ players: string[] }>('ping')).players.filter((p) => p !== bot.name);
    notes.push(`run area cell ${area.cell} home (${area.x0}, ${area.z0}); other players online at start: ${others.length ? others.join(', ') : 'none'}`);
    await bot.teleport(area.home);
    const { from, to } = area.box;
    await bot.truth.okLoaded('fill', [from.x, from.y + 1, from.z, to.x, to.y, to.z, 'air']);
    await bot.truth.okLoaded('fill', [from.x, from.y, from.z, to.x, from.y, to.z, 'grass_block']);
    expect(bot.loop.state.ready).toBe(true);
  }, 90_000);

  afterEach(async () => {
    // A dig still running (an assertion threw mid-case) is aborted on the server.
    await bot?.release();
  });

  afterAll(async () => {
    const pad = (s: unknown, n: number) => String(s).padEnd(n);
    const table = [
      `${pad('case', 34)}${pad('block', 12)}${pad('item', 15)}${pad('table', 7)}${pad('ticks', 7)}${pad('ms', 8)}restores`,
      ...rows.map((r) => `${pad(r.label, 34)}${pad(r.block, 12)}${pad(r.item, 15)}${pad(r.expected, 7)}${pad(r.ticks ?? '-', 7)}${pad(r.ms?.toFixed(0) ?? '-', 8)}${r.restores ?? '-'}${r.ok ? '' : `  FAILED ${r.reason ?? ''}`}`),
    ];
    // process.stdout, not console.log: vitest hides console output of passing tests.
    process.stdout.write(`[dig e2e] break times on BDS 1.26.51 (ticks = bot ticks from start_break to update_block)\n  ${table.join('\n  ')}\n  ${notes.join('\n  ')}\n`);
    await bot?.close();
  });

  describe('4.1 break-time table: grass_block, dirt, oak_log by hand and with each axe', () => {
    for (const item of [null, 'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe'] as const) {
      it(`with ${item ?? 'hand'}`, async () => {
        for (const block of ['grass_block', 'dirt', 'oak_log']) {
          // Fresh inventory per block: by hand, the previous drop would be picked up into slot 0.
          await loadout(item ? [item] : []);
          await digCase(`4.1 ${block} / ${item ?? 'hand'}`, block, { tool: 0 }, item);
        }
      }, 120_000);
    }
  });

  describe('4.2 tool selection', () => {
    it('picks the stone axe in slot 3 for a log (15 ticks) and switches the server-side slot', async () => {
      await loadout(['dirt', 'sand', 'stick', 'stone_axe', 'wooden_pickaxe']);
      expect(bot.world.inventory.selected).toBe(0);
      const inv = await bot.truth.ok<{ slots: ({ typeId: string } | null)[] }>('inv', [bot.name]);
      expect(inv.slots[3]?.typeId).toBe('minecraft:stone_axe');
      const r = await digCase('4.2 best tool for oak_log', 'oak_log', { tool: 'best' }, 'stone_axe');
      expect(r.slot).toBe(3);
      expect(r.expected).toBe(15);
      const pos = await bot.truth.ok<{ selectedSlot: number }>('pos', [bot.name]);
      expect(pos.selectedSlot).toBe(3);
    }, 60_000);

    it('a pickaxe on a log breaks at hand speed (60 ticks)', async () => {
      await loadout(['dirt', 'sand', 'stick', 'stone_axe', 'wooden_pickaxe']);
      const r = await digCase('4.2 wooden_pickaxe on oak_log', 'oak_log', { tool: 4 }, 'wooden_pickaxe');
      expect(r.expected).toBe(60);
      const pos = await bot.truth.ok<{ selectedSlot: number }>('pos', [bot.name]);
      expect(pos.selectedSlot).toBe(4);
    }, 60_000);

    it('"best" for dirt with only an axe and a pickaxe uses a slot without a tool (hand speed)', async () => {
      await loadout(['stone_axe', 'wooden_pickaxe', 'stick']);
      const r = await digCase('4.2 best for dirt (no shovel)', 'dirt', { tool: 'best' }, 'stick');
      expect(r.slot).toBe(2);
    }, 60_000);

    it('two blocks back to back both break on time (break cooldown honoured)', async () => {
      await loadout(['stone_axe']);
      const a = await digCase('4.2 back-to-back #1', 'oak_log', { tool: 'best' }, 'stone_axe');
      const b = await digCase('4.2 back-to-back #2', 'oak_log', { tool: 'best' }, 'stone_axe');
      expect(a.ok && b.ok).toBe(true);
    }, 60_000);
  });

  describe('cancel and reach', () => {
    it('cancel() sends abort_break: the block stays', async () => {
      await loadout([]);
      const target = area.next();
      await place(target, 'oak_log');
      const pending = bot.digger.dig(target, { tool: 0 });
      await bot.loop.waitTicks(20);
      bot.digger.cancel();
      const r = await pending;
      expect(r).toMatchObject({ ok: false, reason: 'interrupted' });
      await bot.loop.waitTicks(60); // past the 60-tick break time
      const t = await bot.truth.ok<{ typeId: string }>('block', [target.x, target.y, target.z]);
      expect(t.typeId).toBe('minecraft:oak_log');
    }, 60_000);

    it('refuses a block beyond its own reach without sending anything', async () => {
      await loadout([]);
      const far = { x: area.x0 + 7, y: FEET_Y, z: area.z0 };
      await place(far, 'dirt');
      const r = await bot.digger.dig(far);
      expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
      await bot.loop.waitTicks(20);
      const t = await bot.truth.ok<{ typeId: string }>('block', [far.x, far.y, far.z]);
      expect(t.typeId).toBe('minecraft:dirt');
      await bot.truth.ok('set', [far.x, far.y, far.z, 'air']);
    }, 60_000);

    it('server pick range (scalar 1.5): accepted at |eye - block corner| 9.85, ignored at 10.24 without a kick', async () => {
      await loadout([]);
      // Own reach checks off: this test probes the server.
      const loose = { reach: 50, pickRangeScalar: 10 };
      const results: string[] = [];
      for (const [bx, dz, accept] of [
        [-0.3, 0, true],
        [0.1, -2, false],
      ] as const) {
        // a fresh block per attempt, same geometry: block 10 west of home, bot bx east of home
        const block = { x: area.x0 - 10, y: FEET_Y, z: area.z0 + dz };
        const feet = { x: area.x0 + bx, y: FEET_Y, z: block.z + 0.5 };
        await bot.teleport(feet);
        await place(block, 'dirt');
        const corrections = bot.loop.state.corrections;
        const eye = { x: feet.x, y: FEET_Y + 1.62, z: feet.z };
        const d = serverReachDistance(eye, block);
        const r = await bot.digger.dig(block, loose);
        const t = await bot.truth.ok<{ typeId: string }>('block', [block.x, block.y, block.z]);
        results.push(`corner distance ${d.toFixed(3)}: ${r.ok ? `broke after ${r.ticks} ticks` : `${r.reason}, ${r.restores} restore(s)`}, truth ${t.typeId}`);
        if (accept) {
          expectTicks(r, 15, `reach ${d.toFixed(3)}`);
          expect(t.typeId).toBe('minecraft:air');
        } else {
          expect(r).toMatchObject({ ok: false, reason: 'timeout' });
          expect(r.restores).toBeGreaterThanOrEqual(1);
          expect(t.typeId).toBe('minecraft:dirt');
        }
        expect(bot.conn.state).toBe('spawned');
        expect(bot.kicks).toEqual([]);
        expect(bot.loop.state.corrections - corrections).toBe(0);
      }
      notes.push(`server reach: ${results.join('; ')}`);
      await bot.teleport(area.home);
    }, 60_000);
  });
});
