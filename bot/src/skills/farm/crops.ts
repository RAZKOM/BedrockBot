// Crops and fields (PLAN.md task 7.13): which blocks are crops, their growth stage from the block
// states, the seed that replants them, and a scan of the farmland around a centre. Pure functions over
// a block lookup, so the unit tests need no server. Measured on BDS 1.26.60.6 (docs/farming.md):
//
//   crop block   seed item        produce        growth states   mature
//   wheat        wheat_seeds      wheat          growth 0..7     7
//   carrots      carrot           carrot         growth 0..7     7
//   potatoes     potato           potato         growth 0..7     7
//   beetroot     beetroot_seeds   beetroot       growth 0..7     7
//
// A crop stands on farmland (`farmland`, states moisturized_amount 0..7, collision top 0.9375). A
// mature crop breaks in one tick by hand (hardness 0); an immature one too, but the farmer never
// breaks those.
import type { BlockInfo, Vec3 } from '../../world/types.ts';

export interface CropDef {
  /** Block name of the plant. */
  block: string;
  /** Item that plants it (clicked onto the top face of farmland). */
  seed: string;
  /** Main drop. */
  produce: string;
  /** Growth stage at which it is harvested. */
  mature: number;
}

export const CROPS: Readonly<Record<string, CropDef>> = Object.freeze({
  wheat: { block: 'wheat', seed: 'wheat_seeds', produce: 'wheat', mature: 7 },
  carrots: { block: 'carrots', seed: 'carrot', produce: 'carrot', mature: 7 },
  potatoes: { block: 'potatoes', seed: 'potato', produce: 'potato', mature: 7 },
  beetroot: { block: 'beetroot', seed: 'beetroot_seeds', produce: 'beetroot', mature: 7 },
});

/** Items worth keeping from a farm (crops and seeds; poisonous potatoes too). */
export const FARM_ITEMS: ReadonlySet<string> = new Set(['wheat', 'wheat_seeds', 'carrot', 'potato', 'poisonous_potato', 'beetroot', 'beetroot_seeds']);
export const SEEDS: ReadonlySet<string> = new Set(Object.values(CROPS).map((c) => c.seed));
export const BONE_MEAL = 'bone_meal';
export const FARMLAND = 'farmland';

export function cropOf(name: string | undefined): CropDef | undefined {
  return name ? CROPS[name] : undefined;
}

/** The crop a seed item plants. */
export function cropForSeed(item: string): CropDef | undefined {
  return Object.values(CROPS).find((c) => c.seed === item);
}

/** Growth stage from the block states (`growth`), or undefined for a block that is not a crop. */
export function growthOf(b: BlockInfo | undefined): number | undefined {
  if (!b || !cropOf(b.name)) return undefined;
  const g = Number(b.states.growth);
  return Number.isFinite(g) ? g : 0;
}

export function isMature(b: BlockInfo | undefined): boolean {
  const c = cropOf(b?.name);
  const g = growthOf(b);
  return !!c && g !== undefined && g >= c.mature;
}

export type CellState = 'mature' | 'growing' | 'empty' | 'blocked';

export interface FieldCell {
  /** The farmland block. */
  soil: Vec3;
  /** The cell above it (the crop). */
  crop: Vec3;
  state: CellState;
  /** The crop there, or (empty cells) the one remembered or chosen for it. */
  kind: CropDef | undefined;
  growth: number | undefined;
}

const AIRLIKE = new Set(['air', 'cave_air', 'void_air']);

/** Classify one farmland block (`soil`) and the cell above it. `remembered` = the crop last seen there. */
export function fieldCell(blockAt: (p: Vec3) => BlockInfo | undefined, soil: Vec3, remembered?: CropDef): FieldCell {
  const crop = { x: soil.x, y: soil.y + 1, z: soil.z };
  const above = blockAt(crop);
  const kind = cropOf(above?.name);
  if (kind) {
    const growth = growthOf(above)!;
    return { soil, crop, state: growth >= kind.mature ? 'mature' : 'growing', kind, growth };
  }
  if (above && AIRLIKE.has(above.name)) return { soil, crop, state: 'empty', kind: remembered, growth: undefined };
  return { soil, crop, state: 'blocked', kind: undefined, growth: undefined };
}

export interface FieldScan {
  cells: FieldCell[];
  mature: FieldCell[];
  growing: FieldCell[];
  empty: FieldCell[];
}

/**
 * Every farmland block within `radius` (horizontal, and 4 blocks up / down) of `center`, classified;
 * `find` is World.find. Empty cells get the crop remembered for them (`memory`), else the most
 * common crop of the field.
 */
export function scanField(
  blockAt: (p: Vec3) => BlockInfo | undefined,
  find: (pred: (b: BlockInfo, p: Vec3) => boolean, o: { origin: Vec3; radius: number; max: number }) => Vec3[],
  center: Vec3,
  radius: number,
  memory?: ReadonlyMap<string, CropDef>,
): FieldScan {
  const reach = Math.hypot(radius + 0.5, radius + 0.5, 4);
  const soils = find((b, p) => b.name === FARMLAND && Math.abs(p.x + 0.5 - center.x) <= radius + 0.5 && Math.abs(p.z + 0.5 - center.z) <= radius + 0.5 && Math.abs(p.y - center.y) <= 4, {
    origin: center,
    radius: reach,
    max: 4096,
  });
  const cells = soils.map((s) => fieldCell(blockAt, s, memory?.get(posKey(s))));
  const counts = new Map<CropDef, number>();
  for (const c of cells) if (c.kind && c.state !== 'empty') counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const c of cells) if (c.state === 'empty' && !c.kind) c.kind = common;
  return {
    cells,
    mature: cells.filter((c) => c.state === 'mature'),
    growing: cells.filter((c) => c.state === 'growing'),
    empty: cells.filter((c) => c.state === 'empty'),
  };
}

export const posKey = (p: Vec3): string => `${p.x},${p.y},${p.z}`;
