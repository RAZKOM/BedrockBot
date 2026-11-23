// e2e (tag @bds), Track B3 (docs/build.md "Speed", decision 0128): how fast the server takes placements. From one
// stand, a ring of free cells on the floor around the bot (each with the floor block under it to click), placed in
// several ways and counted from the server's own answers (update_block at each cell: a new block, or the old one sent
// back for a refused click), the inventory model's count and truth:blocksdiff:
//   skill        the PlaceSkill, one cell after the other (look 2 ticks, click, wait for the block, as the builder did)
//   skill-nolook the PlaceSkill without the look ticks (the server does not check the view)
//   raw-N        raw clicks, N a tick, without waiting for the answers; the held item's count counted down by the bot
//   stale-N      the same with the held item as the inventory model has it (not counted down)
//   chain-N      a line of cells each clicked on the side of the one before (the support placed a tick earlier, or in
//                the same tick for N > 1)
// Gated by BUILD_RATE=1 on top of BDS_E2E=1 (not part of the gate); the rows go to .work/b3/rate-<stamp>.txt.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItemV4 } from '../../src/world/packets.ts';
import type { Vec3 } from '../../src/world/types.ts';
import { clickBlockTransaction } from '../../src/skills/container/chest.ts';
import { EYE_HEIGHT, type Face } from '../../src/skills/dig/look.ts';
import { faceIndex, type BlockFace } from '../../src/skills/place/face.ts';
import { wireItemOf } from '../../src/skills/place/place.ts';
import { E2E, FEET_Y, prepareServer, privateArea } from './build-truth.ts';
import { connectProbeBot, truthOk, type ProbeBot } from './build-probe.ts';

const RUN = E2E && process.env.BUILD_RATE === '1';
const OUT = fileURLToPath(new URL('../../../.work/b3/', import.meta.url));
const F = FEET_Y;

interface Row {
  way: string;
  cells: number;
  ticks: number;
  ms: number;
  accepted: number;
  rejected: number;
  silent: number;
  placed: number;
  perTick: number;
}

describe.skipIf(!RUN)('@bds build: the server place rate (Track B3)', () => {
  const area = privateArea();
  let bot: ProbeBot | undefined;
  const rows: Row[] = [];
  const stand: Vec3 = { x: area.x + 0.5, y: F, z: area.z + 0.5 };
  const c0 = { x: area.x, z: area.z };

  /** The ring of floor cells within 3 of the bot (not its own column): 48 cells. */
  const ring = (): Vec3[] => {
    const out: Vec3[] = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx !== 0 || dz !== 0) out.push({ x: c0.x + dx, y: F, z: c0.z + dz });
    return out;
  };

  const reset = async (b: ProbeBot): Promise<void> => {
    await truthOk(b.truth, 'fill', [c0.x - 8, F, c0.z - 8, c0.x + 8, F + 4, c0.z + 8, 'air']);
    await b.loadout([
      ['cobblestone', 64],
      ['cobblestone', 64],
    ]);
    await b.loop.waitTicks(10);
  };

  /** Counts the server's answers at `cells` while `fn` runs, then waits `settle` ticks. */
  const watch = async (b: ProbeBot, cells: readonly Vec3[], fn: () => Promise<void>, settle = 20): Promise<{ accepted: number; rejected: number; silent: number; ticks: number; ms: number }> => {
    const keys = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
    const seen = new Map<string, 'ok' | 'no'>();
    const off = b.world.onBlockUpdate((p, _before, after) => {
      const k = `${p.x},${p.y},${p.z}`;
      if (!keys.has(k) || seen.get(k) === 'ok') return;
      seen.set(k, after.boxes.length > 0 ? 'ok' : 'no');
    });
    const t0 = b.loop.state.tick;
    const ms0 = performance.now();
    await fn();
    // the last answer: the time until every cell has one (or the settle)
    let last = b.loop.state.tick;
    let lastMs = performance.now();
    for (let i = 0; i < settle; i++) {
      if (seen.size >= keys.size) break;
      await b.loop.waitTicks(1);
      if (seen.size > 0) {
        last = b.loop.state.tick;
        lastMs = performance.now();
      }
    }
    off();
    const accepted = [...seen.values()].filter((v) => v === 'ok').length;
    const rejected = [...seen.values()].filter((v) => v === 'no').length;
    return { accepted, rejected, silent: keys.size - seen.size, ticks: Number(last - t0), ms: lastMs - ms0 };
  };

  const placedCount = async (b: ProbeBot, cells: readonly Vec3[]): Promise<number> => {
    const d = await truthOk<{ actual: Record<string, number> }>(b.truth, 'blocksdiff', [c0.x - 3, F, c0.z - 3, c0.x + 3, F, c0.z + 3, 'cobblestone', '0*49']);
    void cells;
    return d.actual['minecraft:cobblestone'] ?? 0;
  };

  /**
   * Raw clicks: `perTick` a tick, the held item's count counted down (`predict`) or as the model has it. `rid`: the
   * support's runtime id is the placed block's when the bot placed it itself (else the model's, air until the answer).
   * `wait`: a click on a support the bot placed waits until the model shows it.
   */
  const rawClicks = async (b: ProbeBot, list: { pos: Vec3; face: BlockFace; support: Vec3 }[], perTick: number, predict: boolean, o: { rid?: boolean; wait?: boolean } = {}): Promise<void> => {
    const inv = b.world.inventory;
    const slot = inv.slots.findIndex((s, i) => i < 9 && s?.name === 'cobblestone');
    if (slot < 0) throw new Error('no cobblestone in the hotbar');
    if (slot !== inv.selected) b.hotbar.select(slot);
    await b.loop.waitTicks(2);
    const base = wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? b.hotbar.rawItem(slot));
    const reg = b.world.registry;
    const sid = reg.stateIdOf('cobblestone');
    const cobbleRid = sid === undefined ? 0 : reg.runtimeIdOf(sid);
    const mine = new Set<string>();
    let used = 0;
    for (let i = 0; i < list.length; i += perTick) {
      for (const c of list.slice(i, i + perTick)) {
        const sk = `${c.support.x},${c.support.y},${c.support.z}`;
        if (o.wait && mine.has(sk)) for (let k = 0; k < 20 && (b.world.blockAt(c.support)?.boxes.length ?? 0) === 0; k++) await b.loop.waitTicks(1);
        const held: ItemV4 = predict ? { ...base, count: Math.max(1, base.count - used) } : wireItemOf(inv.slots[slot], inv.rawItem(0, slot) ?? b.hotbar.rawItem(slot));
        const f = b.loop.state.pos;
        const rid = o.rid && mine.has(sk) ? cobbleRid : (b.world.chunks.runtimeIdAt(c.support.x, c.support.y, c.support.z) ?? 0);
        b.conn.queue('inventory_transaction', clickBlockTransaction({ pos: c.support, face: faceIndex(c.face) as Face, hotbarSlot: slot, held, eye: { x: f.x, y: f.y + EYE_HEIGHT, z: f.z }, blockRuntimeId: rid }));
        mine.add(`${c.pos.x},${c.pos.y},${c.pos.z}`);
        used++;
      }
      await b.loop.waitTicks(1);
    }
  };

  const record = async (b: ProbeBot, way: string, cells: Vec3[], fn: () => Promise<void>): Promise<void> => {
    const w = await watch(b, cells, fn, 40);
    const placed = await placedCount(b, cells);
    const row: Row = { way, cells: cells.length, ...w, placed, perTick: w.ticks > 0 ? w.accepted / w.ticks : 0 };
    rows.push(row);
    console.log(`[build-rate] ${way}: ${JSON.stringify(row)}`);
  };

  beforeAll(async () => {
    await prepareServer();
    bot = await connectProbeBot('Rate');
    await bot.teleport(stand, 0);
    await truthOk(bot.truth, 'fill', [c0.x - 8, F - 3, c0.z - 8, c0.x + 8, F - 2, c0.z + 8, 'dirt']);
    await truthOk(bot.truth, 'fill', [c0.x - 8, F - 1, c0.z - 8, c0.x + 8, F - 1, c0.z + 8, 'grass_block']);
  }, 120_000);

  afterAll(async () => {
    if (bot) {
      await truthOk(bot.truth, 'fill', [c0.x - 8, F, c0.z - 8, c0.x + 8, F + 4, c0.z + 8, 'air']).catch(() => undefined);
      await bot.close();
    }
    mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    appendFileSync(`${OUT}rate-${stamp}.txt`, rows.map((r) => `${r.way.padEnd(14)} cells ${r.cells} accepted ${r.accepted} rejected ${r.rejected} silent ${r.silent} placed ${r.placed} in ${r.ticks} ticks (${r.ms.toFixed(0)} ms): ${r.perTick.toFixed(2)} a tick`).join('\n') + '\n');
  }, 60_000);

  it('places a ring of 48 cells each way', async () => {
    const b = bot!;
    const cells = ring();
    const onFloor = cells.map((pos) => ({ pos, face: 'up' as const, support: { x: pos.x, y: pos.y - 1, z: pos.z } }));

    await reset(b);
    await record(b, 'skill', cells, async () => {
      for (const c of cells) await b.skills.place(c, { item: 'cobblestone', face: 'up' });
    });
    await reset(b);
    await record(b, 'skill-nolook', cells, async () => {
      for (const c of cells) await b.skills.place(c, { item: 'cobblestone', face: 'up', look: false });
    });
    for (const n of [1, 2, 4, 8, 16]) {
      await reset(b);
      await record(b, `raw-${n}`, cells, () => rawClicks(b, onFloor, n, true));
    }
    for (const n of [1, 4]) {
      await reset(b);
      await record(b, `stale-${n}`, cells, () => rawClicks(b, onFloor, n, false));
    }
    // a line east of the bot, each cell clicked on the east face of the one before (the first on the floor)
    const chain = (): { pos: Vec3; face: BlockFace; support: Vec3 }[] => {
      const line: { pos: Vec3; face: BlockFace; support: Vec3 }[] = [];
      for (let k = 1; k <= 3; k++) {
        const pos = { x: c0.x + k, y: F, z: c0.z + 2 };
        line.push(k === 1 ? { pos, face: 'up', support: { x: pos.x, y: F - 1, z: pos.z } } : { pos, face: 'east', support: { x: pos.x - 1, y: F, z: pos.z } });
      }
      for (let k = 1; k <= 3; k++) {
        const pos = { x: c0.x - k, y: F, z: c0.z - 2 };
        line.push(k === 1 ? { pos, face: 'up', support: { x: pos.x, y: F - 1, z: pos.z } } : { pos, face: 'west', support: { x: pos.x + 1, y: F, z: pos.z } });
      }
      // one more layer on top of the first line (each on the up face of the cell below)
      for (let k = 1; k <= 3; k++) line.push({ pos: { x: c0.x + k, y: F + 1, z: c0.z + 2 }, face: 'up', support: { x: c0.x + k, y: F, z: c0.z + 2 } });
      return line;
    };
    const outcome = (cells: Vec3[]): string => cells.map((c) => ((b.world.blockAt(c)?.boxes.length ?? 0) > 0 ? '#' : '.')).join('');
    for (const [way, n, o] of [
      ['chain', 1, {}],
      ['chain', 4, {}],
      ['chain-rid', 1, { rid: true }],
      ['chain-rid', 2, { rid: true }],
      ['chain-rid', 4, { rid: true }],
      ['chain-wait', 1, { wait: true }],
    ] as const) {
      await reset(b);
      const line = chain();
      await record(
        b,
        `${way}-${n}`,
        line.map((l) => l.pos),
        () => rawClicks(b, line, n, true, o),
      );
      console.log(`[build-rate] ${way}-${n} cells: ${outcome(line.map((l) => l.pos))}`);
    }
    expect(rows.length).toBeGreaterThan(0);
  }, 900_000);
});
