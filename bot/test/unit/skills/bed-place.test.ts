// Track E3 (docs/early-game.md "A bed", ADR 0100): where `!bed` sets a bed down, the job's day click, and the sheep the
// food hunt keeps for a bed. On a fresh world the day's food hunt took the sheep and `!kill sheep 3` found none; a bed
// that is crafted and only carried is never slept in (the night rule looks for placed beds).
import { describe, expect, it } from 'vitest';
import { bedSpots, bedsCarried, placeBed, sheepForBed, type BedPlaceDeps } from '../../../src/skills/survival/bed-place.ts';
import { BedJob, type BedJobDeps } from '../../../src/tasks/process/bed.ts';
import { pickTarget } from '../../../src/skills/food/finder.ts';
import { noDyeRecipe } from '../../../src/skills/items/obtain.ts';
import type { BlockInfo, EntityInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const b = (name: string, solid = false, states: Record<string, unknown> = {}): BlockInfo => ({ name, stateId: 0, states: states, hardness: solid ? 1 : 0, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const AIR = b('air');
const GRASS = b('grass_block', true);
const LITTER = b('leaf_litter');
const STONE = b('stone', true);

function world(cells: Record<string, BlockInfo>, ground = 68): (p: Vec3) => BlockInfo {
  return (p) => cells[`${p.x},${p.y},${p.z}`] ?? (p.y <= ground ? GRASS : AIR);
}
const feet = { x: 15.5, y: 69, z: 45.5 };
const item = (name: string, count = 1): ItemStack => ({ name, networkId: 1, count, metadata: 0 });

describe('bedSpots: two free cells in a row from the feet', () => {
  it('open ground: the four directions one out first (foot, head one further), then two out', () => {
    const s = bedSpots(world({}), feet);
    expect(s).toHaveLength(8);
    expect(s[0]).toEqual({ foot: { x: 16, y: 69, z: 45 }, head: { x: 17, y: 69, z: 45 }, covers: [] });
    expect(s.slice(0, 4).map((x) => x.foot)).toEqual([
      { x: 16, y: 69, z: 45 },
      { x: 14, y: 69, z: 45 },
      { x: 15, y: 69, z: 46 },
      { x: 15, y: 69, z: 44 },
    ]);
    expect(s[4]!.foot).toEqual({ x: 17, y: 69, z: 45 });
  });

  it('a wall, a hole under the head, a block over the foot, a built floor: those pairs are skipped', () => {
    const cells: Record<string, BlockInfo> = {
      '17,69,45': STONE, // east: the head cell is a wall
      '13,68,45': AIR, // west: no floor under the head
      '15,70,46': STONE, // south: a block over the foot (tile.bed.obstructed)
      '15,68,44': b('oak_planks', true), // north: the foot on a built floor
    };
    const built = (n: string): boolean => n.endsWith('_planks');
    const s = bedSpots(world(cells), feet, built);
    const feetOut = s.map((x) => `${x.foot.x},${x.foot.z}`);
    expect(feetOut).not.toContain('16,45');
    expect(feetOut).not.toContain('14,45');
    expect(feetOut).not.toContain('15,46');
    expect(feetOut).not.toContain('15,44');
  });

  it('leaf litter in the pair is dug first (after the free pairs)', () => {
    const cells: Record<string, BlockInfo> = { '16,69,45': LITTER, '14,69,45': LITTER, '15,69,46': LITTER, '15,69,44': LITTER };
    const s = bedSpots(world(cells), feet);
    expect(s[0]!.covers).toEqual([]); // the two-out pairs whose cells are free come first
    const withCover = s.find((x) => x.covers.length > 0)!;
    expect(withCover.covers).toEqual([withCover.foot]);
  });

  it('water or a container in a cell: never', () => {
    const cells: Record<string, BlockInfo> = {};
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) cells[`${15 + dx},69,${45 + dz}`] = b('water');
    cells['15,69,47'] = b('chest', true);
    // only the two-out pairs past the water are left, and not the one with the chest
    expect(bedSpots(world(cells), feet).map((s) => `${s.foot.x},${s.foot.z}`)).toEqual(['17,45', '13,45', '15,43']);
  });
});

describe('sheepForBed: the sheep the food hunt keeps', () => {
  it('3 with no bed and no wool; fewer with wool of one colour; none with a bed known or carried', () => {
    expect(sheepForBed([], 0)).toBe(3);
    expect(sheepForBed([item('white_wool', 2)], 0)).toBe(1);
    expect(sheepForBed([item('white_wool', 1), item('black_wool', 1)], 0)).toBe(2);
    expect(sheepForBed([item('white_wool', 3)], 0)).toBe(0);
    expect(sheepForBed([], 1)).toBe(0);
    expect(sheepForBed([item('bed')], 0)).toBe(0);
    expect(bedsCarried([item('bed', 2), null, item('cobblestone', 5)])).toBe(2);
  });

  it('the hunt leaves that many wild sheep and still takes the others', () => {
    const ent = (rid: number, type: string, x: number): EntityInfo => ({ runtimeId: BigInt(rid), uniqueId: BigInt(rid), type: `minecraft:${type}`, pos: { x, y: -60, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 });
    const me = { x: 0, y: -60, z: 0 };
    const q = { center: me, me, leave: 0, isBaby: () => false };
    const list = [ent(1, 'sheep', 2), ent(2, 'sheep', 3), ent(3, 'sheep', 4), ent(4, 'cow', 20)];
    expect(pickTarget(list, q)?.kind).toBe('sheep');
    const keep = (k: string): number => (k === 'sheep' ? 3 : 0);
    expect(pickTarget(list, { ...q, keep })?.kind).toBe('cow');
    // a fourth sheep may go
    expect(pickTarget([...list, ent(5, 'sheep', 5)], { ...q, keep })?.kind).toBe('sheep');
  });
});

function fakeDeps(cells: Record<string, BlockInfo>, slots: (ItemStack | null)[], over: Partial<BedPlaceDeps> = {}) {
  const placed: { p: Vec3; item: unknown; yaw?: number }[] = [];
  const cmds: { yaw?: number; pitch?: number }[] = [];
  const state = { pos: { ...feet }, ready: true };
  const d: BedPlaceDeps = {
    world: {
      blockAt: (p) => world(cells)(p),
      inventory: { slots },
    },
    loop: {
      state,
      setCommand: (c) => cmds.push(c),
      waitTicks: () => Promise.resolve(),
    },
    skills: {
      place: async (p, o) => {
        await Promise.resolve();
        placed.push({ p, item: o?.item, ...(cmds.at(-1)?.yaw !== undefined ? { yaw: cmds.at(-1)!.yaw! } : {}) });
        // the server: the head lies the way the player faces (yaw -90 east, 90 west, 0 south, 180 north)
        const yaw = cmds.at(-1)?.yaw ?? 0;
        const dir = Math.round((((yaw % 360) + 360) % 360) / 90) % 4; // 0 south, 1 west, 2 north, 3 east
        const off = [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }][dir]!;
        cells[`${p.x},${p.y},${p.z}`] = b('bed', false, { head_piece_bit: 0, direction: dir });
        cells[`${p.x + off.x},${p.y},${p.z + off.z}`] = b('bed', false, { head_piece_bit: 1, direction: dir });
        slots[0] = null;
        return { ok: true };
      },
      dig: async (p) => {
        await Promise.resolve();
        cells[`${p.x},${p.y},${p.z}`] = AIR;
        return { ok: true } as never;
      },
      goto: async (g) => {
        await Promise.resolve();
        const p = (g as { p: Vec3 }).p;
        state.pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
        return { ok: true };
      },
    },
    centre: () => undefined,
    beds: () => [],
    ...over,
  };
  return { d, placed, cmds, state };
}

describe('placeBed', () => {
  it('faces along the pair: the head where bedSpots put it', async () => {
    const cells: Record<string, BlockInfo> = {};
    const { d, placed } = fakeDeps(cells, [item('bed')]);
    const r = await placeBed(d, () => false);
    expect(r).toEqual({ ok: true, head: { x: 17, y: 69, z: 45 }, foot: { x: 16, y: 69, z: 45 }, walked: false, already: false });
    expect(placed[0]!.item).toBe('bed');
  });

  it('a bed known there: done at once; none carried: no_bed_item; with a centre: the walk first', async () => {
    const known = fakeDeps({}, [item('bed')], { beds: () => [{ x: 1, y: 2, z: 3 }] });
    expect(await placeBed(known.d, () => false)).toEqual({ ok: true, head: { x: 1, y: 2, z: 3 }, walked: false, already: true });
    const none = fakeDeps({}, [item('cobblestone', 3)]);
    expect(await placeBed(none.d, () => false)).toEqual({ ok: false, reason: 'no_bed_item' });
    const homeAt = { x: 40, y: 69, z: 45 };
    const walk = fakeDeps({}, [item('bed')], { centre: () => homeAt });
    const r = await placeBed(walk.d, () => false);
    expect(r.ok && r.walked).toBe(true);
    expect(r.ok && Math.abs(r.head.x - homeAt.x) <= 3).toBe(true);
  });

  it('leaf litter in the cells: dug, then the bed', async () => {
    const cells: Record<string, BlockInfo> = {};
    for (let dx = -2; dx <= 3; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) cells[`${15 + dx},69,${45 + dz}`] = LITTER;
    const { d } = fakeDeps(cells, [item('bed')]);
    const r = await placeBed(d, () => false);
    expect(r.ok).toBe(true);
  });
});

describe('BedJob: the day click and the waypoint', () => {
  const ok = { ok: true as const, head: { x: 2, y: 0, z: 0 }, foot: { x: 1, y: 0, z: 0 }, walked: false, already: false };
  it('by day the foot is clicked (noSleep: the respawn point moved); the waypoint without home', async () => {
    const clicked: Vec3[] = [];
    const d: BedJobDeps = { place: () => Promise.resolve(ok), night: () => false, click: (p) => (clicked.push(p), Promise.resolve({ ok: false, reason: 'not_night' })), mark: () => true, cancel: () => undefined };
    const j = new BedJob();
    expect(await j.run(d, () => false)).toBe(true);
    expect(clicked).toEqual([{ x: 1, y: 0, z: 0 }]);
    expect(j.result()).toEqual({ ok: true, reason: 'done', place: ok, spawnSet: true, marked: true });
  });

  it('by night no click (the night rule sleeps in it); a bed already there: no click, no waypoint', async () => {
    let clicks = 0;
    const base: BedJobDeps = { place: () => Promise.resolve(ok), night: () => true, click: () => (clicks++, Promise.resolve({ ok: true })), mark: () => true, cancel: () => undefined };
    const j = new BedJob();
    await j.run(base, () => false);
    expect(clicks).toBe(0);
    expect(j.result().spawnSet).toBe(false);
    const j2 = new BedJob();
    await j2.run({ ...base, night: () => false, place: () => Promise.resolve({ ...ok, already: true }) }, () => false);
    expect(clicks).toBe(0);
    expect(j2.result().marked).toBe(false);
  });

  it('a failed placement ends the job with its reason', async () => {
    const j = new BedJob();
    await j.run({ place: () => Promise.resolve({ ok: false as const, reason: 'no_spot' as const }), night: () => false, cancel: () => undefined }, () => false);
    expect(j.result()).toMatchObject({ ok: false, reason: 'no_spot' });
  });
});

describe('the obtain job never dyes (Track E3)', () => {
  it('a recipe with a dye in it is left out of its plans', () => {
    const r = (input: { name?: string; tag?: string }[]) => ({ id: 'x', networkId: 1, shaped: false, width: 0, height: 0, input: input.map((i) => ({ ...i, metadata: 0, count: 1 })), output: [{ name: 'red_wool', count: 1, metadata: 0 }], block: 'crafting_table', priority: 0 });
    expect(noDyeRecipe(r([{ name: 'white_wool' }, { name: 'red_dye' }]) as never)).toBe(false);
    expect(noDyeRecipe(r([{ name: 'bed' }, { name: 'bone_meal' }]) as never)).toBe(false);
    expect(noDyeRecipe(r([{ name: 'white_wool' }, { tag: 'minecraft:dyes' }]) as never)).toBe(false);
    expect(noDyeRecipe(r([{ name: 'white_wool' }, { name: 'white_wool' }, { name: 'white_wool' }, { tag: 'minecraft:planks' }]) as never)).toBe(true);
  });
});
