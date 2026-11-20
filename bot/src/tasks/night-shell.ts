// The night shell (Track E1, docs/early-game.md "The first night", ADR 0098): a shelter under the open sky is no
// shelter. With `nightShell` on (default off), once the night rule has the bot inside its shelter after dusk and
// the sky is open over it, the bot walls itself in there with throwaway blocks: Track M1's shell (skills/survival/
// seal.ts: the four cells round the feet, the four round the head, the one over the head; a solid cell is left as
// it is). At dawn, before the walk home, it digs one side open again, the side farthest from the hostiles and only
// cells it placed itself; with a hostile within 16 then it stays shut until none is or NIGHT_SHELL_DAWN_WAIT ticks
// pass. Measured: a bot with no blade standing on an open shelter all night was shot (see the
// doc); the same bot in the shell took no damage.
//
// Rules:
//   - only under the open sky (nothing but air or a tree's leaves and logs in the NIGHT_SHELL_SKY cells over the
//     head): a shelter under a roof is a real one and is never walled; a canopy is no roof (arrows come from the side);
//   - only with blocks for every open cell carried (never the dig-in: the hole is not left at dawn by this rule);
//   - at most NIGHT_SHELL_TRIES tries a night (a mob in a cell, a pre-emption), counted from dusk;
//   - the shell is never opened on a cell it did not place.
import type { Logger } from '../log.ts';
import { openCellsText, openSide, SEAL_CELLS, seal, sealCells, sealItems, type SealDeps } from '../skills/survival/seal.ts';
import { clearableCover } from '../skills/craft/table-spot.ts';
import type { BlockInfo, Vec3 } from '../world/types.ts';

/** Cells over the head that must all be non-solid for the shelter to count as under the open sky. */
export const NIGHT_SHELL_SKY = 24;
/** Shell tries a night. */
export const NIGHT_SHELL_TRIES = 2;
/**
 * At dawn (23000) with a hostile within 16 the shell stays shut at most this many ticks, checked each second: 1800
 * takes the clock to about 800, the sun up and the undead burning (measured: opened at 23000 with a skeleton near, the
 * bot was shot from 20 to 6 in 25 s at the open side).
 */
export const NIGHT_SHELL_DAWN_WAIT = 1800;

export interface NightShellDeps {
  /** The seal's ports (pve's sealDeps), undefined without a placer. */
  deps(): SealDeps | undefined;
  enabled(): boolean;
  log: Logger;
  /** The world's block (the covers in the shell's cells); without it no cover is cleared. */
  blockAt?: (p: Vec3) => BlockInfo | undefined;
  /** Wall clock in ms (tests); Date.now by default. */
  now?: () => number;
}

const key = (p: Vec3): string => `${p.x},${p.y},${p.z}`;

/** A tree's own blocks: a canopy over the shelter is no roof (measured: a kit ended under oak leaves 2 over the head). */
export const isTreeBlock = (name: string | undefined): boolean => name !== undefined && /(_leaves|_log|_wood|azalea)$/.test(name.replace(/^minecraft:/, ''));

/**
 * Is nothing but air or a tree's leaves and logs over the head for `NIGHT_SHELL_SKY` cells (unknown cells count as a
 * roof: not walled in blind)? The first roof cell, or undefined when open.
 */
export function roofOver(me: Vec3, solid: SealDeps['solid'], name?: SealDeps['block'], cells = NIGHT_SHELL_SKY): { y: number; name: string } | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  for (let dy = 2; dy < 2 + cells; dy++) {
    const s = solid(fx, fy + dy, fz);
    if (s === false) continue;
    const n = name?.(fx, fy + dy, fz);
    if (s === true && isTreeBlock(n)) continue;
    return { y: fy + dy, name: n ?? 'unknown' };
  }
  return undefined;
}

export function underOpenSky(me: Vec3, solid: SealDeps['solid'], name?: SealDeps['block'], cells = NIGHT_SHELL_SKY): boolean {
  return roofOver(me, solid, name, cells) === undefined;
}

/** Track E7: an enclosed spot's roof is within this many cells over the head. */
export const ENCLOSED_ROOF = 6;
/** Track E7: at most this many of the 8 cells round the feet and the head open (one side: the way in). */
export const ENCLOSED_OPEN_MAX = 2;
/** Track E7: enclosed spots are looked for within this many blocks (horizontally) of the start, ENCLOSED_DY up and down. */
export const ENCLOSED_RADIUS = 12;
export const ENCLOSED_DY = 8;

/**
 * Track E7 (docs/early-game.md "Dusk"): the nearest cell the body can walk to from `near` where it stands enclosed: a
 * full floor, the feet and the head cells free, a roof that is no tree within ENCLOSED_ROOF over the head, and at most
 * ENCLOSED_OPEN_MAX of the 8 cells round the feet and the head open (a tunnel's end, a cave's niche, a hut with a door
 * gap). The search floods from the cell under `near` over cells a body stands in (a step up or down a cell at a time), so
 * a pocket behind rock is never chosen; nearest by steps. Unknown cells count as open and as no floor (nothing is chosen
 * blind). The walls keep the arrows off from the sides; the one open side is the way in.
 */
export function enclosedSpot(near: Vec3, solid: SealDeps['solid'], name?: SealDeps['block'], radius = ENCLOSED_RADIUS): Vec3 | undefined {
  const cx = Math.floor(near.x);
  const cz = Math.floor(near.z);
  let cy = Math.floor(near.y + 1e-3);
  const stands = (x: number, y: number, z: number): boolean => solid(x, y - 1, z) === true && solid(x, y, z) === false && solid(x, y + 1, z) === false;
  // the body may be in the air (a jump, a step): the floor under it
  for (let i = 0; i < 3 && !stands(cx, cy, cz); i++) cy--;
  if (!stands(cx, cy, cz)) return undefined;
  const ring = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const enclosed = (x: number, y: number, z: number): boolean => {
    let open = 0;
    for (const [rx, rz] of ring) for (const yy of [y, y + 1]) if (solid(x + rx, yy, z + rz) !== true) open++;
    if (open > ENCLOSED_OPEN_MAX) return false;
    const roof = roofOver({ x: x + 0.5, y, z: z + 0.5 }, solid, name, ENCLOSED_ROOF);
    return roof !== undefined && roof.name !== 'unknown';
  };
  const seen = new Set<string>([`${cx},${cy},${cz}`]);
  let queue: Vec3[] = [{ x: cx, y: cy, z: cz }];
  while (queue.length > 0) {
    const next: Vec3[] = [];
    for (const c of queue) {
      if (enclosed(c.x, c.y, c.z)) return c;
      for (const [rx, rz] of ring) {
        const x = c.x + rx;
        const z = c.z + rz;
        if (Math.hypot(x - cx, z - cz) > radius) continue;
        for (const y of [c.y, c.y + 1, c.y - 1]) {
          if (Math.abs(y - cy) > ENCLOSED_DY || !stands(x, y, z)) continue;
          // a step up needs the cell over the head free here; a step down the cell over the head free there
          if (y > c.y && solid(c.x, c.y + 2, c.z) !== false) continue;
          if (y < c.y && solid(x, c.y + 1, z) !== false) continue;
          const k = `${x},${y},${z}`;
          if (seen.has(k)) continue;
          seen.add(k);
          next.push({ x, y, z });
          break;
        }
      }
    }
    queue = next;
  }
  return undefined;
}

/**
 * The side to dig open at dawn: the feet and head cells of a side whose solid cells were all placed by the shell
 * (never a wall that was there), the one farthest from the threats; undefined when no side qualifies.
 */
export function shellExit(me: Vec3, placed: ReadonlySet<string>, solid: SealDeps['solid'], threats: readonly Vec3[]): Vec3[] | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  let best: { cells: Vec3[]; score: number } | undefined;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const cells = [
      { x: fx + dx, y: fy, z: fz + dz },
      { x: fx + dx, y: fy + 1, z: fz + dz },
    ];
    if (cells.some((c) => solid(c.x, c.y, c.z) !== false && !placed.has(key(c)))) continue;
    const cx = fx + 0.5 + dx;
    const cz = fz + 0.5 + dz;
    const score = threats.length ? Math.min(...threats.map((t) => Math.hypot(t.x - cx, t.z - cz))) : 0;
    if (!best || score > best.score) best = { cells, score };
  }
  return best?.cells;
}

/**
 * Track E7: the way out when no side opens at the feet (shellExit found none): the body stands in a hole, every side's
 * feet cell a wall that was there. The body steps up through a side instead: that side's head cell, the roof over the
 * head and the cell over the side's head cell must each be free or placed by the shell; the solid ones of them are the
 * cells to dig (the shell's own, never a wall that was there). The side farthest from the threats; undefined when no
 * side qualifies. Measured on a fresh world: a shelter in a one-deep hole inside the base, the shell opened one head
 * cell, and the bot stood under its own roof with no step out (`no move from the start`; the base is never dug).
 */
export function shellStepOut(me: Vec3, placed: ReadonlySet<string>, solid: SealDeps['solid'], threats: readonly Vec3[]): Vec3[] | undefined {
  const fx = Math.floor(me.x);
  const fy = Math.floor(me.y + 1e-3);
  const fz = Math.floor(me.z);
  let best: { cells: Vec3[]; score: number } | undefined;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    // the step up needs a floor: the side's feet cell is the wall the body steps onto
    if (solid(fx + dx, fy, fz + dz) !== true) continue;
    const need = [
      { x: fx + dx, y: fy + 1, z: fz + dz },
      { x: fx, y: fy + 2, z: fz },
      { x: fx + dx, y: fy + 2, z: fz + dz },
    ];
    if (need.some((c) => solid(c.x, c.y, c.z) !== false && !placed.has(key(c)))) continue;
    const cx = fx + 0.5 + dx;
    const cz = fz + 0.5 + dz;
    const score = threats.length ? Math.min(...threats.map((t) => Math.hypot(t.x - cx, t.z - cz))) : 0;
    if (!best || score > best.score) best = { cells: need.filter((c) => solid(c.x, c.y, c.z) !== false), score };
  }
  return best?.cells;
}

export class NightShell {
  private readonly d: NightShellDeps;
  /** Cells the shell placed tonight (a side of them is opened at dawn). */
  readonly placed = new Set<string>();
  /**
   * Every cell the shell placed and left standing (the rest of last night's shell): the next night's shell needs only
   * the open side again, and its roof does not count as a roof over the shelter. Cleared with the shelter.
   */
  readonly built = new Set<string>();
  private busy: Promise<void> | undefined;
  private tries = 0;
  private opening: Promise<void> | undefined;
  readonly stats = { closed: 0, opened: 0, refused: 0, dawnWaits: 0 };
  lastReason: string | undefined;
  /** Track E10: the cells the last shell left open and why (`x y z no_face, ...`), undefined once one closed. */
  lastOpen: string | undefined;

  constructor(d: NightShellDeps) {
    this.d = d;
  }

  /** A shell stands (some of its blocks are placed). */
  get closed(): boolean {
    return this.placed.size > 0;
  }

  get working(): boolean {
    return this.busy !== undefined || this.opening !== undefined;
  }

  /** Dusk: a fresh budget. */
  newNight(): void {
    this.tries = 0;
    this.lastReason = undefined;
  }

  /** A new shelter: the old shell is not this one's. */
  forget(): void {
    this.built.clear();
    this.placed.clear();
  }

  /**
   * Inside the shelter at night (NightSafety.check): wall in when the rules allow. `stillWanted` is checked between
   * the cells (left the shelter, dawn): the job then ends with what is placed.
   */
  onInside(stillWanted: () => boolean): void {
    if (!this.d.enabled() || this.busy || this.opening || this.tries >= NIGHT_SHELL_TRIES) return;
    const deps = this.d.deps();
    if (!deps) return;
    const me = deps.position();
    const cells = sealCells(me, deps.solid, [], deps.face);
    if (cells.length === 0) return;
    const roof = roofOver(me, (x, y, z) => (this.built.has(`${x},${y},${z}`) ? false : deps.solid(x, y, z)), deps.block);
    if (roof) {
      if (this.lastReason !== 'roof') this.d.log.info(`night shell: a roof over the shelter (${roof.name} at y ${roof.y}): not walling in`);
      this.lastReason = 'roof';
      this.tries = NIGHT_SHELL_TRIES; // once a night
      return;
    }
    const have = sealItems(deps.slots()).total;
    // Track E10: a support under a cell over a step down comes on top of the shell's own 10 (SEAL_CELLS + 1); a bot with
    // the 10 walls in with what it has (the cells planned last stay open), as it did before the supports
    if (have < Math.min(cells.length, SEAL_CELLS + 1)) {
      if (this.lastReason !== 'blocks') this.d.log.info(`night shell: ${have} throwaway blocks for ${cells.length} open cells; standing in the open`);
      this.lastReason = 'blocks';
      this.stats.refused++;
      this.tries = NIGHT_SHELL_TRIES; // once a night
      return;
    }
    this.tries++;
    this.lastReason = undefined;
    // no dig-in: the hole would not be left at dawn by this rule
    const { block: _noDigIn, ...surface } = deps;
    void _noDigIn;
    // a cover in a cell (leaf litter, a flower, a tuft) takes no block and gives the cell over it no face: dug first
    // (measured: a shelter on leaf litter, 2 placed and 5 cells open)
    const covers = this.d.blockAt ? cells.filter((c) => clearableCover(this.d.blockAt!(c))) : [];
    this.busy = (async () => {
      for (const c of covers) {
        if (!stillWanted()) break;
        const name = this.d.blockAt!(c)?.name;
        const r = await deps.dig(c).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        this.d.log.info(`night shell: ${name ?? 'cover'} at ${key(c)} ${r.ok ? 'cleared' : `not cleared (${r.reason ?? 'failed'})`}`);
      }
      return seal(surface, () => !stillWanted());
    })()
      .then((r) => {
        for (const p of r.placed) {
          this.placed.add(key(p));
          this.built.add(key(p));
        }
        if (r.ok) this.stats.closed++;
        // Track E10: a shell that does not close says which cells stayed open and why (`x y z no_face`)
        this.lastOpen = r.ok ? undefined : (r.reason ?? openCellsText(r)) || 'not placed';
        this.d.log.info(`night shell: ${r.ok ? 'walled in' : `${r.open} cell(s) open (${this.lastOpen})`}, ${r.placed.length} block(s) placed`);
      })
      .catch((e: unknown) => {
        this.d.log.warn(`night shell: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.busy = undefined;
      });
  }

  /** Dawn: dig one side open (cells placed by the shell only), then resolve (the walk home follows). */
  open(): Promise<void> {
    if (this.opening) return this.opening;
    if (!this.closed) return Promise.resolve();
    const deps = this.d.deps();
    if (!deps) return Promise.resolve();
    this.opening = (async () => {
      await this.busy;
      // a hostile near at dawn: stay shut until it is gone or the sun is well up (the walk home waits too)
      if (deps.threats().length) {
        const t0 = this.d.now?.() ?? Date.now();
        this.d.log.info(`night shell: ${deps.threats().length} hostile(s) within 16 at dawn: shut for up to ${NIGHT_SHELL_DAWN_WAIT / 20} s`);
        let waited = 0;
        while (deps.threats().length && waited < NIGHT_SHELL_DAWN_WAIT) {
          await (deps.settle ? deps.settle(20) : new Promise((r) => setTimeout(r, 1000)));
          waited += 20;
        }
        const s = ((this.d.now?.() ?? Date.now()) - t0) / 1000;
        this.d.log.info(`night shell: ${deps.threats().length ? `still ${deps.threats().length} hostile(s) near after ${s.toFixed(0)} s: opening` : `clear after ${s.toFixed(0)} s: opening`}`);
        this.stats.dawnWaits++;
      }
      const me = deps.position();
      // a side at the feet; standing in a hole, a step up through a side (Track E7); else what the shell placed of a side
      const side = shellExit(me, this.built, deps.solid, deps.threats()) ?? shellStepOut(me, this.built, deps.solid, deps.threats()) ?? openSide(me, deps.threats()).filter((c) => this.built.has(key(c)));
      let dug = 0;
      for (const c of side) {
        if (deps.solid(c.x, c.y, c.z) !== true) continue;
        const r = await deps.dig(c).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
        if (r.ok) {
          dug++;
          this.built.delete(key(c));
        } else this.d.log.warn(`night shell: could not dig ${key(c)} open (${r.reason ?? 'failed'})`);
      }
      this.stats.opened++;
      this.d.log.info(`night shell: opened (${dug} of ${side.length} cell(s) dug), ${this.built.size} block(s) of it left standing`);
      this.placed.clear();
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
}
