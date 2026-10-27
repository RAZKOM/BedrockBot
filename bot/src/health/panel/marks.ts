// Track AR (docs/panel.md "Map"): GET /api/marks, what the panel's map draws beyond /map.json: the
// remembered containers (world/cache/chests.ts, second halves of double chests left out) and the herd
// marks (world/cache/herds.ts) within MARKS_RADIUS of the bot, nearest first, capped.
import { chestKey, partnerKeys } from '../../skills/home/memory.ts';
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { HerdMark } from '../../world/cache/herds.ts';
import type { Vec3 } from '../../world/types.ts';

export const MARKS_RADIUS = 256;
export const MARKS_MAX = 200;

export interface PanelMarks {
  chests: { x: number; y: number; z: number; kind: string; label: string | null; unreachable: boolean }[];
  /** Herds: the mean position, the animals counted (wild + penned) and the biggest kind. */
  herds: { x: number; y: number; z: number; n: number; kind: string; penned: boolean }[];
}

export interface MarksSource {
  chests?: { all(): ChestRecord[] } | undefined;
  herds?: { near(origin: Vec3, radius: number): HerdMark[] } | undefined;
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
    .map((r) => ({ x: r.x, y: r.y, z: r.z, kind: r.kind, label: r.label ?? null, unreachable: !!r.unreachable }));
  const herds = (src.herds?.near(origin, radius) ?? []).slice(0, max).map((h) => {
    const kinds = new Map<string, number>();
    for (const rec of [h.wild, h.penned]) for (const [k, c] of Object.entries(rec)) kinds.set(k, (kinds.get(k) ?? 0) + c.adults + c.babies);
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    let n = 0;
    for (const v of kinds.values()) n += v;
    return { x: h.x, y: h.y, z: h.z, n, kind: top?.[0] ?? 'animal', penned: Object.keys(h.penned).length > 0 };
  });
  return { chests, herds };
}
