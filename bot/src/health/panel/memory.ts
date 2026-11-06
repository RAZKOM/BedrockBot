// Track AP (docs/panel.md "Statuses"): what the bot remembers, as counts for the panel. Chests from
// the chest memory (world/cache/chests.ts; Track AN's `unreachable` marks), herds from the herd marks
// (world/cache/herds.ts), forests and ores from the world cache's marks around the bot: a forest is a
// 16-block column with at least FOREST_LOGS log marks, an ore is a mark the bot saw (Track Z ore
// memory). Counting reads cached summaries, so setupPanel keeps the result for MEMORY_TTL_MS.
import { chestKey, partnerKeys } from '../../skills/home/memory.ts';
import type { ChestRecord } from '../../world/cache/chests.ts';
import type { HerdMark } from '../../world/cache/herds.ts';
import type { CachedMark } from '../../world/cache/types.ts';
import type { Vec3 } from '../../world/types.ts';

/** Log marks in one 16-block column that make it a forest. */
export const FOREST_LOGS = 6;
/** Radius (blocks) around the bot for forests and ores. */
export const MEMORY_RADIUS = 64;
/** setupPanel keeps a memory block this long (ms). */
export const MEMORY_TTL_MS = 15_000;

export interface PanelMemory {
  /** Containers remembered (second halves of double chests not counted), reachable, marked unreachable, opened at least once. */
  chests: { known: number; reachable: number; unreachable: number; read: number };
  /** Herd marks and the animals in them (wild + penned, adults + babies). */
  herds: number;
  animals: number;
  /** 16-block columns within MEMORY_RADIUS with at least FOREST_LOGS log marks. */
  forests: number;
  /** Seen ore marks within MEMORY_RADIUS: total and by name (`iron_ore`: 3). */
  ores: number;
  oreKinds: Record<string, number>;
  /** Radius used and how long the count took (ms). */
  radius: number;
  ms: number;
}

export interface MemorySource {
  chests?: { all(): ChestRecord[] } | undefined;
  herds?: { all(): HerdMark[] } | undefined;
  /** Marks of a column (loaded or cached); with `known` to skip columns the cache never saw without decoding. */
  marks?(cx: number, cz: number): readonly CachedMark[];
  known?(cx: number, cz: number): boolean;
  seenMarks?(origin: Vec3, radius: number): CachedMark[];
}

export const isLog = (n: string): boolean => (n.endsWith('_log') && !n.startsWith('stripped_')) || n === 'crimson_stem' || n === 'warped_stem';
export const isOre = (n: string): boolean => n.endsWith('_ore') || n === 'ancient_debris';


/** Count what the bot remembers (any source may be missing: its counts are 0). */
export function buildMemory(src: MemorySource, origin: Vec3 | undefined, radius = MEMORY_RADIUS): PanelMemory {
  const t0 = performance.now();
  const records = src.chests?.all() ?? [];
  const partners = partnerKeys(records); // the same rule as `!chests` (skills/home/memory.ts chestsLine)
  const own = records.filter((r) => !partners.has(chestKey(r)));
  const chests = { known: own.length, reachable: 0, unreachable: 0, read: 0 };
  for (const r of own) {
    if (r.unreachable) chests.unreachable++;
    else chests.reachable++;
    if (r.readAt > 0) chests.read++;
  }
  const herdList = src.herds?.all() ?? [];
  let animals = 0;
  for (const h of herdList) for (const rec of [h.wild, h.penned]) for (const c of Object.values(rec)) animals += c.adults + c.babies;
  let forests = 0;
  const oreKinds: Record<string, number> = {};
  let ores = 0;
  if (origin) {
    if (src.marks) {
      const r2 = (radius + 8) ** 2;
      for (let cx = Math.floor((origin.x - radius) / 16); cx <= Math.floor((origin.x + radius) / 16); cx++) {
        for (let cz = Math.floor((origin.z - radius) / 16); cz <= Math.floor((origin.z + radius) / 16); cz++) {
          if ((cx * 16 + 8 - origin.x) ** 2 + (cz * 16 + 8 - origin.z) ** 2 > r2) continue;
          if (src.known && !src.known(cx, cz)) continue;
          let logs = 0;
          for (const m of src.marks(cx, cz)) if (isLog(m.name)) logs++;
          if (logs >= FOREST_LOGS) forests++;
        }
      }
    }
    for (const m of src.seenMarks?.(origin, radius) ?? []) {
      if (!isOre(m.name)) continue;
      ores++;
      oreKinds[m.name] = (oreKinds[m.name] ?? 0) + 1;
    }
  }
  return { chests, herds: herdList.length, animals, forests, ores, oreKinds, radius, ms: Math.round((performance.now() - t0) * 100) / 100 };
}

/** One row of GET /api/chests (the list behind the memory block's link). */
export interface PanelChestRow {
  x: number;
  y: number;
  z: number;
  kind: string;
  label: string | null;
  /** Slots used / window size when last read (0 / 0 = never opened). */
  stacks: number;
  size: number;
  /** The top kinds inside (at most 4) when read. */
  top: [string, number][];
  unreachable: string | null;
  /** Wall-clock ms of the last read (0 = never). */
  readAt: number;
}

/** The remembered containers, nearest first (second halves of double chests left out). */
export function chestRows(records: readonly ChestRecord[], origin?: Vec3): PanelChestRow[] {
  const partners = partnerKeys(records);
  const d = (r: ChestRecord): number => (origin ? Math.hypot(r.x - origin.x, r.y - origin.y, r.z - origin.z) : 0);
  return records
    .filter((r) => !partners.has(chestKey(r)))
    .sort((a, b) => d(a) - d(b))
    .map((r) => ({
      x: r.x,
      y: r.y,
      z: r.z,
      kind: r.kind,
      label: r.label ?? null,
      stacks: r.stacks,
      size: r.size,
      top: Object.entries(r.contents)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
      unreachable: r.unreachable ?? null,
      readAt: r.readAt,
    }));
}
