// Track AR (docs/panel.md "Map"), decision 0062 (docs/map.md "Overlays"): GET /api/marks, what the map
// draws beyond the tiles and the live overlays: the remembered containers with what the chest memory
// knows is in them (world/cache/chests.ts, second halves of double chests left out), the herd marks
// (world/cache/herds.ts) and, from the world cache's block marks, ores by kind, spawners, beds,
// furnaces / crafting tables, farmland and forests (16-block columns with FOREST_LOGS log marks or
// more). Within a radius of the bot, or of the map's window (`?cx=&cz=&r=` in chunks), nearest first,
// capped per kind.
import { chestKey, partnerKeys } from '../../skills/home/memory.ts';
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { HerdMark } from '../../world/cache/herds.ts';
import type { CachedMark } from '../../world/cache/types.ts';
import type { Vec3 } from '../../world/types.ts';
import { FOREST_LOGS, isLog, isOre } from './memory.ts';

export const MARKS_RADIUS = 256;
export const MARKS_MAX = 200;
/** Decision 0062: the block marks per kind at most (farmland fields are large). */
export const BLOCK_MARKS_MAX: Readonly<Record<BlockMarkKind, number>> = { ore: 400, spawner: 50, bed: 50, station: 100, farmland: 1500, forest: 100 };

/** Decision 0062: the kinds of block marks the map draws (each is an overlay, client/mapdefs.ts). */
export const BLOCK_MARK_KINDS = ['ore', 'spawner', 'bed', 'station', 'farmland', 'forest'] as const;
export type BlockMarkKind = (typeof BLOCK_MARK_KINDS)[number];

/** The kind of a cache mark name, undefined for marks the map does not draw (logs count as forests, doors and chests elsewhere). */
export function blockMarkKind(name: string): Exclude<BlockMarkKind, 'forest'> | undefined {
  if (isOre(name)) return 'ore';
  if (name === 'mob_spawner' || name === 'trial_spawner') return 'spawner';
  if (name.endsWith('_bed') || name === 'bed') return 'bed';
  if (name === 'crafting_table' || name.endsWith('furnace') || name === 'smoker' || name === 'lit_smoker') return 'station';
  if (name === 'farmland') return 'farmland';
  return undefined;
}

export interface PanelChestMark {
  x: number;
  y: number;
  z: number;
  kind: string;
  label: string | null;
  unreachable: boolean;
  /** Decision 0062: slots used / size when last read (0 / 0 = never opened), the top kinds inside, when read (ms, 0 = never). */
  stacks?: number;
  size?: number;
  top?: [string, number][];
  readAt?: number;
}

export interface PanelMarks {
  chests: PanelChestMark[];
  /** Herds: the mean position, the animals counted (wild + penned) and the biggest kind. */
  herds: { x: number; y: number; z: number; n: number; kind: string; penned: boolean }[];
  /** Decision 0062: block marks by kind: [x, y, z, name] (forest: [x, y, z, logs] at the logs' mean). */
  blocks?: Partial<Record<BlockMarkKind, [number, number, number, string | number][]>>;
}

export interface MarksSource {
  chests?: { all(): ChestRecord[] } | undefined;
  herds?: { near(origin: Vec3, radius: number): HerdMark[] } | undefined;
  /** Decision 0062: a column's summary (loaded first, else remembered) for the block marks; `known` skips columns the cache never saw. */
  summary?(cx: number, cz: number): { markList(): CachedMark[] } | undefined;
  known?(cx: number, cz: number): boolean;
}

/** Decision 0062: the block marks of the columns within `radius` of `origin`, nearest first, capped per kind. */
export function blockMarks(src: MarksSource, origin: Vec3, radius: number): NonNullable<PanelMarks['blocks']> {
  const lists: Record<BlockMarkKind, { d: number; v: [number, number, number, string | number] }[]> = { ore: [], spawner: [], bed: [], station: [], farmland: [], forest: [] };
  if (!src.summary) return {};
  const d2 = (x: number, z: number): number => (x - origin.x) ** 2 + (z - origin.z) ** 2;
  const r2 = radius * radius;
  for (let cx = Math.floor((origin.x - radius) / 16); cx <= Math.floor((origin.x + radius) / 16); cx++) {
    for (let cz = Math.floor((origin.z - radius) / 16); cz <= Math.floor((origin.z + radius) / 16); cz++) {
      if (src.known && !src.known(cx, cz)) continue;
      const s = src.summary(cx, cz);
      if (!s) continue;
      let logs = 0;
      let lx = 0;
      let ly = 0;
      let lz = 0;
      for (const m of s.markList()) {
        if (isLog(m.name)) {
          logs++;
          lx += m.x;
          ly += m.y;
          lz += m.z;
          continue;
        }
        const k = blockMarkKind(m.name);
        if (!k) continue;
        const d = d2(m.x + 0.5, m.z + 0.5);
        if (d <= r2) lists[k].push({ d, v: [m.x, m.y, m.z, m.name] });
      }
      if (logs >= FOREST_LOGS) {
        const fx = Math.round(lx / logs);
        const fz = Math.round(lz / logs);
        const d = d2(fx, fz);
        if (d <= r2) lists.forest.push({ d, v: [fx, Math.round(ly / logs), fz, logs] });
      }
    }
  }
  const out: NonNullable<PanelMarks['blocks']> = {};
  for (const k of BLOCK_MARK_KINDS) {
    const l = lists[k];
    if (l.length) out[k] = l.sort((a, b) => a.d - b.d).slice(0, BLOCK_MARKS_MAX[k]).map((e) => e.v);
  }
  return out;
}

export function mapMarks(src: MarksSource | undefined, origin: Vec3 | undefined, radius = MARKS_RADIUS, max = MARKS_MAX): PanelMarks {
  if (!src || !origin) return { chests: [], herds: [] };
  const records = src.chests?.all() ?? [];
  const partners = partnerKeys(records);
  const d = (p: { x: number; z: number }): number => Math.hypot(p.x - origin.x, p.z - origin.z);
  const chests = records
    .filter((r) => !partners.has(chestKey(r)) && d(r) <= radius)
    .sort((a, b) => d(a) - d(b))
    .slice(0, max)
    .map((r) => ({
      x: r.x,
      y: r.y,
      z: r.z,
      kind: r.kind,
      label: r.label ?? null,
      unreachable: !!r.unreachable,
      stacks: r.stacks,
      size: r.size,
      top: Object.entries(r.contents)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6),
      readAt: r.readAt,
    }));
  const herds = (src.herds?.near(origin, radius) ?? []).slice(0, max).map((h) => {
    const kinds = new Map<string, number>();
    for (const rec of [h.wild, h.penned]) for (const [k, c] of Object.entries(rec)) kinds.set(k, (kinds.get(k) ?? 0) + c.adults + c.babies);
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    let n = 0;
    for (const v of kinds.values()) n += v;
    return { x: h.x, y: h.y, z: h.z, n, kind: top?.[0] ?? 'animal', penned: Object.keys(h.penned).length > 0 };
  });
  const out: PanelMarks = { chests, herds };
  if (src.summary) out.blocks = blockMarks(src, origin, radius);
  return out;
}

/** Decision 0062: the centre and radius (blocks) of `?cx=&cz=&r=` (chunks, r at most 16), else undefined (around the bot). */
export function marksWindow(url: string | undefined): { origin: Vec3; radius: number } | undefined {
  const q = new URL(url ?? '/', 'http://localhost').searchParams;
  const cx = Number(q.get('cx'));
  const cz = Number(q.get('cz'));
  const r = Number(q.get('r'));
  if (!q.has('cx') || !q.has('cz') || !Number.isInteger(cx) || !Number.isInteger(cz)) return undefined;
  const rc = Number.isFinite(r) ? Math.max(1, Math.min(16, Math.floor(r))) : 8;
  return { origin: { x: cx * 16 + 8, y: 64, z: cz * 16 + 8 }, radius: rc * 16 + 8 };
}
