// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the work blocks the bot set down itself, remembered.
//
// The cooker looks for a furnace within 16 blocks of home, or of the bot when no home is set (skills/food/cook.ts). With
// no home, a furnace the bot set down and walked away from (a mine step) fell out of that circle, and the next smelt
// crafted and set down a second one (measured on a fresh world: one run in six). Every furnace the bot places is kept
// here (where, what, when) and offered again while it stands within `FURNACE_RECALL` of the bot. A block that is
// gone (dug, burnt, replaced) is forgotten when it is next looked at; one in an unloaded chunk is kept for later.
// Crafting tables have their own list in the crafter (skills/craft/crafter.ts `pendingTables`: the ones it set down and
// has not picked up yet). Task state, in memory: a restart forgets it (the furnace then counts as anyone's).
import type { BlockInfo, Vec3 } from '../../world/types.ts';

/** A furnace the bot placed is used again within this many blocks of the bot. */
export const FURNACE_RECALL = 64;
/** At most this many blocks are remembered (the oldest go first). */
export const PLACED_MAX = 32;

export interface PlacedBlock {
  /** The block's name as placed (`furnace`). */
  name: string;
  p: Vec3;
  /** Date.now() when it was placed. */
  at: number;
}

const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** `lit_furnace` stands for the furnace it is (a burning furnace keeps its place). */
const baseName = (n: string): string => n.replace(/^minecraft:/, '').replace(/^lit_/, '');

export class PlacedBlocks {
  private readonly list: PlacedBlock[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The bot set `name` down at `p`. */
  record(name: string, p: Vec3): void {
    const i = this.list.findIndex((b) => same(b.p, p));
    if (i >= 0) this.list.splice(i, 1);
    this.list.push({ name: baseName(name), p: { x: p.x, y: p.y, z: p.z }, at: this.now() });
    while (this.list.length > PLACED_MAX) this.list.shift();
  }

  forget(p: Vec3): void {
    const i = this.list.findIndex((b) => same(b.p, p));
    if (i >= 0) this.list.splice(i, 1);
  }

  all(): readonly PlacedBlock[] {
    return this.list;
  }

  /**
   * The remembered blocks of `name` within `r` of `me`, nearest first, that still stand there (`blockAt`). A cell that
   * now holds something else is forgotten; one not loaded is skipped and kept.
   */
  near(name: string, me: Vec3, r: number, blockAt: (p: Vec3) => BlockInfo | undefined): Vec3[] {
    const want = baseName(name);
    const out: { p: Vec3; d: number }[] = [];
    for (const b of [...this.list]) {
      if (b.name !== want) continue;
      const here = blockAt(b.p);
      if (!here) continue;
      if (baseName(here.name) !== want) {
        this.forget(b.p);
        continue;
      }
      const d = Math.hypot(b.p.x + 0.5 - me.x, b.p.y + 0.5 - me.y, b.p.z + 0.5 - me.z);
      if (d <= r) out.push({ p: b.p, d });
    }
    return out.sort((a, b) => a.d - b.d).map((x) => x.p);
  }
}

const memories = new WeakMap<object, PlacedBlocks>();

/** The task's memory of the blocks it placed (made on first use). */
export function placedOf(task: object): PlacedBlocks {
  let m = memories.get(task);
  if (!m) {
    m = new PlacedBlocks();
    memories.set(task, m);
  }
  return m;
}
