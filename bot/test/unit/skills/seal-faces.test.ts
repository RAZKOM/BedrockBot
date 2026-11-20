// Track E10 (docs/early-game.md "The night shell's open sides", ADR 0112): a shell cell with nothing to place against
// gets a support first (skills/survival/seal.ts faceSupports): a step down under a feet-ring cell (the river bank's
// measured case), a brace beside the head cell over a crafting table (a click opens the table), and a drop too deep
// for a support stays open and says no_face.
import { describe, expect, it } from 'vitest';
import { faceSupports, openCellsText, seal, sealCells } from '../../../src/skills/survival/seal.ts';
import { NightShell } from '../../../src/tasks/night-shell.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const stack = (name: string, count: number): ItemStack => ({ name, count, networkId: 1, metadata: 0, blockRuntimeId: 7 });
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** A world of cells: ground (solid, clickable) at y <= floor(x, z), air over it; `extra` solid cells, `noFace` solid ones a click opens. */
function world(floor: (x: number, z: number) => number, extra: string[] = [], noFace: string[] = []) {
  const placed = new Set<string>();
  const solid = (x: number, y: number, z: number): boolean => y <= floor(x, z) || extra.includes(k(x, y, z)) || noFace.includes(k(x, y, z)) || placed.has(k(x, y, z));
  const face = (x: number, y: number, z: number): boolean => solid(x, y, z) && !noFace.includes(k(x, y, z));
  return { placed, solid, face };
}

/** A placer that does what the server does: a block goes in only against a face. */
function placer(w: ReturnType<typeof world>) {
  const order: Vec3[] = [];
  const place = (p: Vec3): Promise<{ ok: boolean; reason?: string }> => {
    if (w.solid(p.x, p.y, p.z)) return Promise.resolve({ ok: false, reason: 'occupied' });
    const faced = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ].some(([dx, dy, dz]) => w.face(p.x + dx!, p.y + dy!, p.z + dz!));
    if (!faced) return Promise.resolve({ ok: false, reason: 'no_face' });
    w.placed.add(k(p.x, p.y, p.z));
    order.push(p);
    return Promise.resolve({ ok: true });
  };
  return { order, place };
}

const me: Vec3 = { x: 0.5, y: 77, z: 0.5 };

describe('faceSupports: a support before a cell with no face', () => {
  it('flat ground: the cells as before, nothing added', () => {
    const w = world(() => 76);
    const plain = sealCells(me, w.solid);
    const faced = sealCells(me, w.solid, [], w.face);
    expect(faced).toEqual(plain);
    expect(faced).toHaveLength(10);
  });

  it('a step down on one side (the river bank): the cell under that feet-ring cell first, then the side', () => {
    // the ground one lower north of the shelter (z -1), as on the measured spawn
    const w = world((_x, z) => (z < 0 ? 75 : 76));
    const cells = sealCells(me, w.solid, [], w.face);
    expect(cells).toHaveLength(11);
    const under = cells.findIndex((c) => c.x === 0 && c.y === 76 && c.z === -1);
    const feetN = cells.findIndex((c) => c.x === 0 && c.y === 77 && c.z === -1);
    const headN = cells.findIndex((c) => c.x === 0 && c.y === 78 && c.z === -1);
    expect(under).toBeGreaterThanOrEqual(0);
    expect(under).toBeLessThan(feetN);
    expect(feetN).toBeLessThan(headN);
  });

  it('the same ground, the code before (no support): the feet and head cell of that side stay open, no_face', async () => {
    const w = world((_x, z) => (z < 0 ? 75 : 76));
    const p = placer(w);
    // the order the code before used: sealCells without the support pass
    const before = sealCells(me, w.solid).filter((c) => !(c.x === 0 && c.y === 76 && c.z === -1));
    const open: Vec3[] = [];
    for (const c of before) if (!(await p.place(c)).ok) open.push(c);
    expect(open).toEqual([
      { x: 0, y: 77, z: -1 },
      { x: 0, y: 78, z: -1 },
    ]);
  });

  it('seal() closes it now: 11 blocks, every cell solid', async () => {
    const w = world((_x, z) => (z < 0 ? 75 : 76));
    const p = placer(w);
    const r = await seal({ place: p.place, dig: () => Promise.resolve({ ok: true }), solid: w.solid, face: w.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }, () => false);
    expect(r.ok).toBe(true);
    expect(r.placed).toHaveLength(11);
    for (const c of [
      [1, 77, 0],
      [-1, 77, 0],
      [0, 77, 1],
      [0, 77, -1],
      [0, 78, -1],
      [0, 79, 0],
    ] as const)
      expect(w.solid(c[0], c[1], c[2])).toBe(true);
  });

  it('the same ground with only the shell\'s own 10 blocks: walled in as far as they go (1 cell open, not refused)', async () => {
    const w = world((_x, z) => (z < 0 ? 75 : 76));
    const p = placer(w);
    const s = stack('cobblestone', 10);
    const place = async (c: Vec3): Promise<{ ok: boolean; reason?: string }> => {
      if (s.count <= 0) return { ok: false, reason: 'no_item' };
      const r = await p.place(c);
      if (r.ok) s.count--;
      return r;
    };
    const r = await seal({ place, dig: () => Promise.resolve({ ok: true }), solid: w.solid, face: w.face, position: () => me, threats: () => [], slots: () => (s.count > 0 ? [s] : []) }, () => false);
    expect(r.placed).toHaveLength(10);
    expect(r.open).toBe(1);
    // 9 blocks: refused as before (fewer than the shell's own count)
    const w9 = world((_x, z) => (z < 0 ? 75 : 76));
    const r9 = await seal({ place: placer(w9).place, dig: () => Promise.resolve({ ok: true }), solid: w9.solid, face: w9.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 9)] }, () => false);
    expect(r9.reason).toBe('blocks 9 < 11');
  });

  it('a deeper drop, or a pillar top: one support a side is enough (it touches the block the body stands on)', async () => {
    const deep = world((_x, z) => (z < 0 ? 70 : 76));
    expect(sealCells(me, deep.solid, [], deep.face)).toHaveLength(11);
    const pillar = world((x, z) => (x === 0 && z === 0 ? 76 : 60));
    const cells = sealCells(me, pillar.solid, [], pillar.face);
    expect(cells).toHaveLength(14); // 4 supports, the 9 cells, the roof's support
    const p = placer(pillar);
    const r = await seal({ place: p.place, dig: () => Promise.resolve({ ok: true }), solid: pillar.solid, face: pillar.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }, () => false);
    expect(r.ok).toBe(true);
  });

  it('nothing solid round the cells: no support, every cell open and named no_face', async () => {
    const w = world(() => -100);
    const p = placer(w);
    const r = await seal({ place: p.place, dig: () => Promise.resolve({ ok: true }), solid: w.solid, face: w.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }, () => false);
    expect(r.ok).toBe(false);
    expect(r.open).toBe(10);
    expect(r.openWhy?.every((x) => x === 'no_face')).toBe(true);
    expect(openCellsText(r).split(', ')[0]).toMatch(/^-?\d+ 77 -?\d+ no_face$/);
  });

  it('a crafting table in a feet-ring cell: a brace on the corner beside the cell over it, then that cell', async () => {
    const table = k(1, 77, 0);
    const w = world(() => 76, [], [table]);
    const cells = sealCells(me, w.solid, [], w.face);
    const over = cells.findIndex((c) => c.x === 1 && c.y === 78 && c.z === 0);
    const brace = cells.findIndex((c) => c.x === 1 && c.y === 78 && Math.abs(c.z) === 1);
    expect(brace).toBeGreaterThanOrEqual(0);
    expect(brace).toBeLessThan(over);
    const p = placer(w);
    const r = await seal({ place: p.place, dig: () => Promise.resolve({ ok: true }), solid: w.solid, face: w.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }, () => false);
    expect(r.ok).toBe(true);
    expect(w.solid(1, 78, 0)).toBe(true);
    // without the face port the table counts as a face: the code before, the cell over it open
    const w0 = world(() => 76, [], [table]);
    const p0 = placer(w0);
    const r0 = await seal({ place: p0.place, dig: () => Promise.resolve({ ok: true }), solid: w0.solid, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }, () => false);
    expect(r0.ok).toBe(false);
    // the cell over the table, and the roof's support and the roof that went against it
    expect(openCellsText(r0)).toBe('1 78 0 no_face, 1 79 0 no_face, 0 79 0 no_face');
  });

  it('faceSupports never adds a cell when every cell has a face in order', () => {
    const w = world(() => 76);
    const cells = [
      { x: 1, y: 77, z: 0 },
      { x: 1, y: 78, z: 0 },
    ];
    expect(faceSupports(cells, { x: 0, y: 77, z: 0 }, w.solid, w.face)).toEqual(cells);
  });
});

describe('the night shell names the open cells', () => {
  it('logs `x y z no_face` for a cell that stayed open and keeps it as lastOpen', async () => {
    // the body on a crafting table over a drop: nothing a click places against round it
    const w = world(() => 60, [], [k(0, 76, 0)]);
    const p = placer(w);
    const lines: string[] = [];
    const log = { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s), debug: () => undefined, error: () => undefined } as never;
    const shell = new NightShell({
      deps: () => ({ place: p.place, dig: () => Promise.resolve({ ok: true }), solid: w.solid, face: w.face, position: () => me, threats: () => [], slots: () => [stack('cobblestone', 16)] }),
      enabled: () => true,
      log,
    });
    shell.onInside(() => true);
    for (let i = 0; i < 20 && shell.working; i++) await new Promise((r) => setTimeout(r, 5));
    expect(shell.lastOpen?.split(', ')).toContain('1 77 0 no_face');
    expect(lines.some((l) => /^night shell: 10 cell\(s\) open \(1 77 0 no_face, .*\), 0 block\(s\) placed$/.test(l))).toBe(true);
  });
});
