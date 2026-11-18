// Track E3 (docs/early-game.md "The furnace wait", ADR 0100): a smelt that outlasts the day, or one by night, waits in a
// shell next to the furnace (smeltShell, default off). On a fresh world the bot died at its furnace at dusk 186 s into a
// 33-item smelt (arrows, a witch's poison, a creeper).
import { describe, expect, it } from 'vitest';
import { shellStandCell, SmeltShell, smeltOutlastsDay, smeltShellBrace, type SmeltShellDeps } from '../../../src/tasks/smelt-shell.ts';
import type { SealDeps } from '../../../src/skills/survival/seal.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';
import { silentLogger } from '../../../src/log.ts';

const F = 64;
const furnace = { x: 10, y: F, z: 10 };

function grid(extra: Record<string, boolean> = {}) {
  const cells = new Map<string, boolean>(Object.entries(extra));
  cells.set(`${furnace.x},${furnace.y},${furnace.z}`, true);
  const solid = (x: number, y: number, z: number): boolean => cells.get(`${x},${y},${z}`) ?? y < F;
  return { cells, solid };
}

describe('smeltOutlastsDay: when the smelt is shelled', () => {
  it('by night always; by day when 200 ticks an item and the margin pass dusk', () => {
    expect(smeltOutlastsDay(18000, 1)).toBe(true); // night
    expect(smeltOutlastsDay(24000 + 18000, 1)).toBe(true); // absolute time, night
    expect(smeltOutlastsDay(1000, 33)).toBe(false); // 6600 + 400 < 11000
    expect(smeltOutlastsDay(6000, 33)).toBe(true); // 7000 > 6000
    expect(smeltOutlastsDay(11000, 3)).toBe(false); // 600 + 400 = 1000: just
    expect(smeltOutlastsDay(11100, 3)).toBe(true);
    expect(smeltOutlastsDay(23500, 33)).toBe(false); // after dawn the day is ahead
    expect(smeltOutlastsDay(undefined, 33)).toBe(false);
    expect(smeltOutlastsDay(18000, 0)).toBe(false);
  });
});

describe('shellStandCell', () => {
  it('a cardinal neighbour of the furnace with feet and head free and a floor; nearest to the bot first', () => {
    const { solid } = grid();
    expect(shellStandCell(furnace, solid, undefined, { x: 8.5, y: F, z: 10.5 })).toEqual({ x: 9, y: F, z: 10 });
    expect(shellStandCell(furnace, solid, undefined, { x: 12.5, y: F, z: 10.5 })).toEqual({ x: 11, y: F, z: 10 });
  });
  it('walls, a low roof and holes are skipped; none left: undefined', () => {
    const { solid } = grid({ [`9,${F},10`]: true, [`11,${F + 1},10`]: true, [`10,${F - 1},11`]: false, [`10,${F},9`]: true });
    expect(shellStandCell(furnace, solid)).toBeUndefined();
  });
});

function shellDeps(o: { time: number; shelters?: Vec3[]; blocks?: number; enabled?: boolean; threats?: Vec3[]; supports?: boolean }) {
  const { cells, solid } = grid();
  const pos = { x: 8.5, y: F, z: 10.5 };
  const placed: Vec3[] = [];
  const dug: Vec3[] = [];
  let time = o.time;
  const slots: (ItemStack | null)[] = [{ name: 'cobblestone', count: o.blocks ?? 32, networkId: 1, metadata: 0 }];
  const seal: SealDeps = {
    place: async (p) => {
        await Promise.resolve();
      // a face to click: a solid neighbour that is not the furnace (a click on it opens its window)
      const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => ({ x: p.x + x!, y: p.y + y!, z: p.z + z! }));
      if (o.supports && !faces.some((q) => solid(q.x, q.y, q.z) && !(q.x === furnace.x && q.y === furnace.y && q.z === furnace.z))) return { ok: false, reason: 'no_support' };
      cells.set(`${p.x},${p.y},${p.z}`, true);
      placed.push(p);
      return { ok: true };
    },
    dig: async (p) => {
        await Promise.resolve();
      cells.set(`${p.x},${p.y},${p.z}`, false);
      dug.push(p);
      return { ok: true };
    },
    solid,
    position: () => pos,
    threats: () => o.threats ?? [],
    slots: () => slots,
    settle: async () => {
        await Promise.resolve();
      time += 20;
    },
  };
  const walks: Vec3[] = [];
  const d: SmeltShellDeps = {
    enabled: () => o.enabled ?? true,
    deps: () => seal,
    time: () => time,
    shelters: () => o.shelters ?? [],
    walkTo: async (cell) => {
        await Promise.resolve();
      walks.push(cell);
      pos.x = cell.x + 0.5;
      pos.z = cell.z + 0.5;
      return true;
    },
    log: silentLogger,
  };
  return { d, placed, dug, walks, cells, pos, setTime: (t: number) => (time = t) };
}

describe('SmeltShell', () => {
  it('by night: onto the cell by the furnace, walled in (the furnace is one wall), out again at dawn on a side it placed', async () => {
    const h = shellDeps({ time: 18000 });
    const s = new SmeltShell(h.d);
    expect(await s.close(furnace, 8, () => false)).toBe('closed');
    expect(h.walks).toEqual([{ x: 9, y: F, z: 10 }]);
    // the feet ring less the furnace's cell (3), the head ring (4), a support for the roof and the roof: 9, none at the furnace
    expect(h.placed).toHaveLength(9);
    expect(h.placed.some((p) => p.x === 10 && p.y === F && p.z === 10)).toBe(false);
    expect(await s.open(() => false)).toBe(true);
    expect(h.dug).toHaveLength(2);
    expect(h.dug.every((c) => h.placed.some((p) => p.x === c.x && p.y === c.y && p.z === c.z))).toBe(true);
    expect(s.closed).toBe(false);
  });

  it('the cell over the furnace: no face but the furnace; a brace on its diagonal, then the seal closes (measured: 6 placed, 3 open)', async () => {
    const h = shellDeps({ time: 18000, supports: true });
    const s = new SmeltShell(h.d);
    expect(await s.close(furnace, 8, () => false)).toBe('closed');
    // the 9 cells and the brace beside the furnace's top
    expect(h.placed).toHaveLength(10);
    const brace = h.placed.find((p) => p.x === 10 && p.y === F + 1 && Math.abs(p.z - 10) === 1);
    expect(brace).toBeDefined();
    expect(h.cells.get(`10,${F + 1},10`)).toBe(true);
    expect(h.cells.get(`9,${F + 2},10`)).toBe(true);
    expect(smeltShellBrace(furnace, { x: 9, y: F, z: 10 }, h.cells.size ? (x, y, z) => h.cells.get(`${x},${y},${z}`) ?? y < F : () => false)).toBeUndefined();
  });

  it('by day a short smelt is not shelled; off, a shelter near, or blocks short: no shell', async () => {
    expect(await new SmeltShell(shellDeps({ time: 1000 }).d).close(furnace, 8, () => false)).toBe('day');
    expect(await new SmeltShell(shellDeps({ time: 18000, enabled: false }).d).close(furnace, 8, () => false)).toBe('off');
    expect(await new SmeltShell(shellDeps({ time: 18000, shelters: [{ x: 20, y: F, z: 10 }] }).d).close(furnace, 8, () => false)).toBe('shelter');
    expect(await new SmeltShell(shellDeps({ time: 18000, shelters: [{ x: 40, y: F, z: 10 }] }).d).close(furnace, 8, () => false)).toBe('closed');
    expect(await new SmeltShell(shellDeps({ time: 18000, blocks: 5 }).d).close(furnace, 8, () => false)).toBe('blocks');
  });

  it('by day a smelt that outlasts the day: shelled, opened at once when it ends by day', async () => {
    const h = shellDeps({ time: 8000 });
    const s = new SmeltShell(h.d);
    expect(await s.close(furnace, 33, () => false)).toBe('closed');
    expect(await s.open(() => false)).toBe(true);
    expect(h.dug).toHaveLength(2);
  });

  it('a pre-emption by night leaves it standing (the resume finds it shut)', async () => {
    const h = shellDeps({ time: 18000 });
    const s = new SmeltShell(h.d);
    await s.close(furnace, 8, () => false);
    expect(await s.open(() => true)).toBe(false);
    expect(s.closed).toBe(true);
    expect(h.dug).toHaveLength(0);
    // the resume: nothing to place again
    expect(await s.close(furnace, 0, () => false)).toBe('closed');
    expect(h.placed).toHaveLength(9);
  });
});
