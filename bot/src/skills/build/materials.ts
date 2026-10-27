// Materials (wave 9, Track AL; docs/build.md "Materials"): the blocks a plan places, against the
// inventory. The survival keeper's throwaway reserve (`throwawayMin` throwaway blocks: cobblestone,
// dirt, cobbled_deepslate, netherrack) is never used by a build: a throwaway kind is available to the
// build only beyond what the reserve needs after the other throwaway kinds are counted. Scaffold
// blocks are throwaway blocks too; they are picked up again, so the reserve may lend them.
import { THROWAWAY_BLOCKS } from '../survival/keeper.ts';
import type { Plan } from './plan.ts';

export interface InventoryCounts {
  count(name: string): number;
}

export interface MaterialLine {
  item: string;
  need: number;
  /** Usable for the build (the reserve taken off). */
  have: number;
  missing: number;
}

export interface Materials {
  lines: MaterialLine[];
  /** Throwaway blocks short of the reserve after the build (needs any throwaway kind). */
  reserveShort: number;
  /** Throwaway blocks short of the scaffold peak (after the build and with the reserve lent). */
  scaffoldShort: number;
  ok: boolean;
}

export interface ReserveOptions {
  throwawayMin: number;
  throwaway?: readonly string[];
}

/** Of `item`, how many the build may use (the throwaway reserve kept). */
export function usable(inv: InventoryCounts, item: string, r: ReserveOptions): number {
  const kinds = r.throwaway ?? THROWAWAY_BLOCKS;
  const have = inv.count(item);
  if (!kinds.includes(item)) return have;
  const others = kinds.filter((k) => k !== item).reduce((n, k) => n + inv.count(k), 0);
  return Math.max(0, have - Math.max(0, r.throwawayMin - others));
}

export function materialsOf(plan: Pick<Plan, 'materials' | 'scaffoldPeak'>, inv: InventoryCounts, r: ReserveOptions): Materials {
  const kinds = r.throwaway ?? THROWAWAY_BLOCKS;
  const lines = Object.entries(plan.materials)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([item, need]) => {
      const have = usable(inv, item, r);
      return { item, need, have, missing: Math.max(0, need - have) };
    });
  const throwawayAfter = kinds.reduce((n, k) => n + inv.count(k), 0) - lines.filter((l) => kinds.includes(l.item)).reduce((n, l) => n + Math.min(l.need, l.have), 0);
  const reserveShort = Math.max(0, r.throwawayMin - throwawayAfter);
  const scaffoldShort = Math.max(0, plan.scaffoldPeak - Math.max(0, throwawayAfter));
  return { lines, reserveShort, scaffoldShort, ok: lines.every((l) => l.missing === 0) && scaffoldShort === 0 };
}

/**
 * `materials for fill 5x3x5 cobblestone: 75 cobblestone; need 75 more cobblestone` /
 * `...: have everything` (+ the scaffold and reserve notes).
 */
export function materialsLine(label: string, m: Materials, scaffolds = 0): string {
  const want = m.lines.map((l) => `${l.need} ${l.item}`).join(', ') || 'nothing';
  const missing = m.lines.filter((l) => l.missing > 0).map((l) => `${l.missing} more ${l.item}`);
  if (m.scaffoldShort) missing.push(`${m.scaffoldShort} more throwaway blocks for scaffolding`);
  const notes: string[] = [];
  if (scaffolds) notes.push(`${scaffolds} scaffold block${scaffolds === 1 ? '' : 's'}, picked up again`);
  if (m.reserveShort) notes.push(`throwaway reserve ${m.reserveShort} short, never built with`);
  return `materials for ${label}: ${want}; ${missing.length ? `need ${missing.join(', ')}` : 'have everything'}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}
