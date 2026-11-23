// Track B6 (decision 0131, docs/build.md "Skip what cannot be got"): `!build ... fetch skip missing` builds without the
// blocks the bill cannot get. Given how many of each build item cannot be got, the cells left out are that many of the
// item's cells, the highest first (a build goes bottom up: what is left out is its top), each with its second cells
// (a door's upper half, a bed's head); they are refused like the builder's own refusals (listed in the plan line).
import { resolveBlocks } from './states.ts';
import { blockId, key, type BuildBlock, type BuildSpec, type Cell } from './types.ts';

/** The reason a left-out cell is listed with. */
export const MISSING_REASON = 'cannot get it (skip missing)';

export interface SkipResult {
  spec: BuildSpec;
  /** The cells left out, with MISSING_REASON. */
  refused: { pos: Cell; name: string; reason: string }[];
  /** Items left out by item (the bill's units: a double slab is two slabs). */
  items: Map<string, number>;
}

/**
 * `spec` without `n` items' worth of cells of each item in `skip` (item -> n, the bill's `cannot` of build items). An
 * item the spec places nowhere is ignored. The spec's earlier `refused` stay.
 */
export function withoutMissing(spec: BuildSpec, skip: ReadonlyMap<string, number>): SkipResult {
  const resolved = resolveBlocks(spec.places);
  const out = new Set<string>();
  const refused: SkipResult['refused'] = [];
  const items = new Map<string, number>();
  const byItem = new Map<string, (typeof resolved.cells)[number][]>();
  for (const c of resolved.cells) {
    if (!skip.has(c.placement.item)) continue;
    let l = byItem.get(c.placement.item);
    if (!l) byItem.set(c.placement.item, (l = []));
    l.push(c);
  }
  for (const [item, want] of skip) {
    const cells = (byItem.get(item) ?? []).slice().sort((a, b) => b.block.pos.y - a.block.pos.y || a.block.pos.x - b.block.pos.x || a.block.pos.z - b.block.pos.z);
    let left = want;
    for (const c of cells) {
      if (left <= 0) break;
      const p = c.block.pos;
      out.add(key(p));
      for (const e of c.placement.extra) out.add(key({ x: p.x + e.offset.x, y: p.y + e.offset.y, z: p.z + e.offset.z }));
      refused.push({ pos: { ...p }, name: blockId(c.block.name), reason: MISSING_REASON });
      const units = 1 + c.placement.merges;
      left -= units;
      items.set(item, (items.get(item) ?? 0) + units);
    }
  }
  if (out.size === 0) return { spec, refused: [], items };
  const places: BuildBlock[] = spec.places.filter((b) => !out.has(key(b.pos)));
  return { spec: { ...spec, places, refused: [...(spec.refused ?? []), ...refused] }, refused, items };
}
