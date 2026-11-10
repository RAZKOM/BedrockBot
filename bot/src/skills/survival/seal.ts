// Seal in (Track M1, docs/pve.md "Never die to common mobs (Track M1)", ADR 0079): the last floor against mobs. With no way
// away (a flight caught or cornered, the health 4 or less with a melee mob next to it) and the `sealIn` setting on, the bot
// walls itself in where it stands: the four cells round its feet, the four round its head, the one over its head, each
// only when it is not solid already; then it eats and waits, and opens one side again (the side away from the mobs) once
// the health is back.
//
// The block: throwaway blocks first (cobblestone, cobbled deepslate, dirt, netherrack, then stone and its kinds), never a
// block that falls (sand, gravel, concrete powder), burns away from a creeper's fire as easily (wool, leaves), is worth
// keeping (ores, metal and gem blocks, logs) or does something when placed (TNT, a chest, a shulker box, a bed). Several
// kinds may be used for one shell. The order: the feet ring first (it stands on the ground; the head ring needs it under
// it), the side facing the nearest mob first in each ring, the cell over the head last.
import type { Logger } from '../../log.ts';
import type { ItemStack, Vec3 } from '../../world/types.ts';

/** Blocks the shell may use, best first. */
export const SEAL_BLOCKS: readonly string[] = [
  'cobblestone',
  'cobbled_deepslate',
  'dirt',
  'netherrack',
  'stone',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'deepslate',
  'blackstone',
  'end_stone',
  'sandstone',
  'red_sandstone',
  'mud_bricks',
  'stone_bricks',
  'bricks',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks',
];

/** Cells of a full shell (4 round the feet, 4 round the head, 1 over the head). */
export const SEAL_CELLS = 9;

/** Throwaway kinds to use, most plentiful of the best kinds first; total = what the inventory holds of them. */
export function sealItems(slots: readonly (ItemStack | null | undefined)[]): { items: string[]; total: number } {
  const counts = new Map<string, number>();
  for (const s of slots) {
    if (!s || s.count <= 0) continue;
    const n = s.name.startsWith('minecraft:') ? s.name.slice(10) : s.name;
    if (!SEAL_BLOCKS.includes(n)) continue;
    counts.set(n, (counts.get(n) ?? 0) + s.count);
  }
  const items = [...counts.keys()].sort((a, b) => SEAL_BLOCKS.indexOf(a) - SEAL_BLOCKS.indexOf(b));
  let total = 0;
  for (const v of counts.values()) total += v;
  return { items, total };
}

/** The cells round a body standing at `me` (feet) that a shell fills, solid ones left out, in placing order. */
export function sealCells(me: Vec3, solid: (x: number, y: number, z: number) => boolean | undefined, threats: readonly Vec3[] = []): Vec3[] {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  // the side facing the nearest threat first
  const sides: { dx: number; dz: number }[] = [
    { dx: 1, dz: 0 },
    { dx: -1, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: 0, dz: -1 },
  ];
  const near = threats.reduce<Vec3 | undefined>((b, t) => (!b || Math.hypot(t.x - me.x, t.z - me.z) < Math.hypot(b.x - me.x, b.z - me.z) ? t : b), undefined);
  if (near) {
    const ax = near.x - me.x;
    const az = near.z - me.z;
    sides.sort((a, b) => b.dx * ax + b.dz * az - (a.dx * ax + a.dz * az));
  }
  const out: Vec3[] = [];
  for (const dy of [0, 1]) {
    for (const s of sides) {
      const c = { x: fx + s.dx, y: fy + dy, z: fz + s.dz };
      if (solid(c.x, c.y, c.z) !== true) out.push(c);
    }
  }
  const roof = { x: fx, y: fy + 2, z: fz };
  if (solid(roof.x, roof.y, roof.z) !== true) {
    // the roof needs a face to go against: over the head there is only the head ring's edges (round 2 on bds-gaunt: 8
    // placed and the roof open in every run of the seal-5 cell). Without a solid block beside or over it, a support first,
    // on the head ring block of the side facing the nearest mob
    const touching = sides.some((s) => solid(fx + s.dx, fy + 2, fz + s.dz) === true) || solid(fx, fy + 3, fz) === true;
    if (!touching) out.push({ x: fx + sides[0]!.dx, y: fy + 2, z: fz + sides[0]!.dz });
    out.push(roof);
  }
  return out;
}

/** The side to open again: the one farthest from every threat (the feet and the head cell of it). */
export function openSide(me: Vec3, threats: readonly Vec3[]): Vec3[] {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  let best: { dx: number; dz: number; score: number } | undefined;
  for (const s of [
    { dx: 1, dz: 0 },
    { dx: -1, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: 0, dz: -1 },
  ]) {
    const cx = fx + 0.5 + s.dx;
    const cz = fz + 0.5 + s.dz;
    const score = threats.length ? Math.min(...threats.map((t) => Math.hypot(t.x - cx, t.z - cz))) : 0;
    if (!best || score > best.score) best = { ...s, score };
  }
  const b = best!;
  return [
    { x: fx + b.dx, y: fy, z: fz + b.dz },
    { x: fx + b.dx, y: fy + 1, z: fz + b.dz },
  ];
}

/**
 * Blocks a bare hand digs in about a second and that drop a block the shell can use (dirt): the dig-in's cells. Never sand or
 * gravel (they fall in after the bot), never stone (a hand gets nothing from it and needs 7.5 s a block).
 */
export const DIG_IN_BLOCKS: readonly string[] = ['dirt', 'grass_block', 'podzol', 'mycelium', 'grass_path', 'dirt_path', 'farmland'];
/** Cells the dig-in digs straight down (the body ends 3 under the ground, the first cell dug becomes the roof). */
export const DIG_IN_DEPTH = 3;

/**
 * The dig-in (no blocks for a shell on the surface): the DIG_IN_DEPTH cells under the feet, top first, when each is a
 * DIG_IN_BLOCKS block, the floor under the last one is solid, every cell round the new feet and head is solid (no cave
 * opening, no liquid: a liquid is not solid) and the roof (the first cell dug) has a solid side to place against.
 * Undefined when any of that is not known to hold.
 */
export function digInCells(me: Vec3, solid: (x: number, y: number, z: number) => boolean | undefined, name: (x: number, y: number, z: number) => string | undefined): Vec3[] | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  const cells: Vec3[] = [];
  for (let k = 1; k <= DIG_IN_DEPTH; k++) {
    const n = name(fx, fy - k, fz);
    if (n === undefined || !DIG_IN_BLOCKS.includes(n.startsWith('minecraft:') ? n.slice(10) : n)) return undefined;
    cells.push({ x: fx, y: fy - k, z: fz });
  }
  if (solid(fx, fy - DIG_IN_DEPTH - 1, fz) !== true) return undefined;
  const ring = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (const y of [fy - DIG_IN_DEPTH, fy - DIG_IN_DEPTH + 1]) for (const [dx, dz] of ring) if (solid(fx + dx, y, fz + dz) !== true) return undefined;
  if (!ring.some(([dx, dz]) => solid(fx + dx, fy - 1, fz + dz) === true)) return undefined;
  return cells;
}

export interface SealDeps {
  place: (p: Vec3, opts: { item: string[]; look?: boolean; jump?: boolean; timeoutTicks?: number }) => Promise<{ ok: boolean; reason?: string }>;
  dig: (p: Vec3) => Promise<{ ok: boolean; reason?: string }>;
  solid: (x: number, y: number, z: number) => boolean | undefined;
  position: () => Vec3;
  threats: () => Vec3[];
  slots: () => readonly (ItemStack | null | undefined)[];
  /** The block's name (the dig-in's check); without it there is no dig-in. */
  block?: (x: number, y: number, z: number) => string | undefined;
  /** Wait a few ticks (the fall after a dig, the dropped block's pickup). */
  settle?: (ticks: number) => Promise<void>;
  /**
   * Step onto the middle of this cell (the dig-in: a body on a cell's edge stands on its neighbour and never falls in);
   * `fall`: the cell is the dug hole, walk into it without sneaking (a sneaking body stops at the edge).
   */
  centre?: (cell: Vec3, opts?: { fall?: boolean }) => Promise<boolean>;
  log?: Logger;
}

export interface SealResult {
  ok: boolean;
  placed: Vec3[];
  /** Cells left open (a mob in it, no support, no blocks). */
  open: number;
  /** The shell is a hole dug under the feet (leave it through the roof). */
  dugIn?: boolean;
  /** The surface shell's cells left open, from the feet cell (dx, dy, dz: dy 0 the feet ring, 1 the head ring, 2 the roof). */
  openCells?: Vec3[];
  reason?: string;
}

/** Can the shell go up here: blocks enough for the surface shell, or a dig-in. */
export function canSealHere(d: Pick<SealDeps, 'solid' | 'position' | 'slots' | 'block'>): boolean {
  const me = d.position();
  if (sealItems(d.slots()).total >= sealCells(me, d.solid).length) return true;
  return d.block !== undefined && digInCells(me, d.solid, d.block) !== undefined;
}

/** Tries to get the body into the first dug cell (an arrow's knockback puts it on the edge, where it stands on a neighbour). */
const DIG_IN_FALL_TRIES = 3;

/**
 * Dig the hole straight down (digInCells), then roof it with a dug block. Each dig is the cell under the body's feet as they
 * are then (never a column worked out before), and the first one is the only one the body can miss: on the surface an
 * arrow's knockback moves it (measured: about half a block, enough to stand on the next cell's edge). So after the first dig
 * the body walks onto the hole's middle until it drops in (DIG_IN_FALL_TRIES); once its feet are in the hole the walls hold
 * it, and every later dig is under it.
 */
async function digIn(d: SealDeps, cells: Vec3[], cancelled: () => boolean): Promise<SealResult> {
  if (d.centre && !(await d.centre(cells[0]!))) return { ok: false, placed: [], open: 1, reason: 'dig-in: could not stand on the middle of the cell' };
  const top = cells[0]!;
  for (let k = 0; k < cells.length; k++) {
    if (cancelled()) return { ok: false, placed: [], open: 1, dugIn: true, reason: 'cancelled' };
    const me = d.position();
    // the cell under the feet now (the first: the planned one, the body stands on it after the centring)
    const c = k === 0 ? top : { x: Math.floor(me.x), y: Math.floor(me.y + 1e-3) - 1, z: Math.floor(me.z) };
    if (k > 0 && (c.x !== top.x || c.z !== top.z)) return { ok: false, placed: [], open: 1, dugIn: true, reason: `dig-in: the body left the hole (${c.x} ${c.z})` };
    const r = await d.dig(c);
    if (!r.ok) return { ok: false, placed: [], open: 1, dugIn: true, reason: `dig-in: ${r.reason ?? 'dig failed'}` };
    await d.settle?.(6);
    // fell in: the feet are in the dug cell now (else the next dig is out of the body's column)
    for (let i = 0; d.position().y > c.y + 0.5 && i < DIG_IN_FALL_TRIES; i++) {
      if (cancelled()) return { ok: false, placed: [], open: 1, dugIn: true, reason: 'cancelled' };
      if (k === 0 && d.centre) await d.centre(c, { fall: true });
      await d.settle?.(6);
    }
    if (d.position().y > c.y + 0.5) return { ok: false, placed: [], open: 1, dugIn: true, reason: `dig-in: did not fall into ${c.x} ${c.y} ${c.z}` };
  }
  await d.settle?.(6);
  const me = d.position();
  const roof = sealCells(me, d.solid);
  const placed: Vec3[] = [];
  for (const c of roof) {
    let done = false;
    for (let i = 0; i < 4 && !done && !cancelled(); i++) {
      const { items } = sealItems(d.slots());
      if (items.length === 0) {
        await d.settle?.(5); // the dropped dirt not picked up yet
        continue;
      }
      const r = await d.place(c, { item: items, look: false, jump: false, timeoutTicks: 10 });
      if (r.ok) {
        placed.push(c);
        done = true;
      }
    }
  }
  const open = roof.length - placed.length;
  d.log?.info(`seal: dug in ${cells.length} deep, ${placed.length} block(s) placed${open ? `, ${open} cell(s) still open` : ''}`);
  return { ok: open === 0, placed, open, dugIn: true };
}

/** Passes over the surface shell's cells: the second after the body is put back on its cell's middle. */
const SEAL_PASSES = 2;

/**
 * Place the shell (a dig-in when the blocks are short). The body goes onto its cell's middle first (round 2: a body 0.6 wide
 * standing 0.4 off the middle overlaps the next cell, whose block then cannot go in, and the arrows came through that gap);
 * each cell gets up to 3 tries (a mob standing in it: the reflex knocks it out); the cells still open get a second pass after
 * the body is centred again (an arrow's knockback moves it while it builds).
 */
export async function seal(d: SealDeps, cancelled: () => boolean): Promise<SealResult> {
  let me = d.position();
  const { items, total } = sealItems(d.slots());
  const first = sealCells(me, d.solid, d.threats());
  if (first.length === 0) return { ok: true, placed: [], open: 0 };
  if (total < first.length) {
    const hole = d.block ? digInCells(me, d.solid, d.block) : undefined;
    if (hole) return digIn(d, hole, cancelled);
    return { ok: false, placed: [], open: first.length, reason: `blocks ${total} < ${first.length}` };
  }
  const home = { x: Math.floor(me.x), y: Math.floor(me.y + 1e-3) - 1, z: Math.floor(me.z) };
  const placed: Vec3[] = [];
  let open = 0;
  let openCells: Vec3[] = [];
  for (let pass = 0; pass < SEAL_PASSES; pass++) {
    if (d.centre) await d.centre(home);
    me = d.position();
    // the cells round the body's cell (the same cell as at the start unless the centring failed)
    const cells = sealCells(me, d.solid, d.threats());
    const feet = { x: Math.floor(me.x), y: Math.floor(me.y + 1e-3), z: Math.floor(me.z) };
    open = 0;
    openCells = [];
    for (const c of cells) {
      let done = false;
      for (let i = 0; i < 3 && !done && !cancelled(); i++) {
        if (d.solid(c.x, c.y, c.z) === true) {
          done = true;
          break;
        }
        const r = await d.place(c, { item: sealItems(d.slots()).items.length ? sealItems(d.slots()).items : items, look: false, jump: false, timeoutTicks: 10 });
        if (r.ok) {
          placed.push(c);
          done = true;
        }
      }
      if (cancelled()) return { ok: false, placed, open: cells.length - placed.length, reason: 'cancelled' };
      if (!done) {
        open++;
        openCells.push({ x: c.x - feet.x, y: c.y - feet.y, z: c.z - feet.z });
      }
    }
    if (open === 0) break;
  }
  d.log?.info(`seal: ${placed.length} block(s) placed${open ? `, ${open} cell(s) still open (${openCells.map((c) => `${c.x} ${c.y} ${c.z}`).join(', ')})` : ''}`);
  return { ok: open === 0, placed, open, ...(open ? { openCells } : {}) };
}
