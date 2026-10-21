// Observation builder (PLAN.md sections 4.5 and 9) from the bot's own world model, never from the
// truth pack, so what is learned transfers to a Realm.
//
// grid: 9 x 9 x 5 class ids around the feet block, flat, x-major: index = (ix * 9 + iz) * 5 + iy with
// dx = ix - 4, dz = iz - 4 (world axes, not rotated with the yaw) and dy = iy - 1 (feet - 1 .. feet + 3).
import { DEFAULT_REACH, EYE_HEIGHT, distanceToBlock } from '../skills/dig/look.ts';
import { classify } from '../world/find.ts';
import type { BlockInfo, EntityInfo, FindOptions, ItemStack, Vec3 } from '../world/types.ts';
import { GRID_CLASSES, GRID_SHAPE, GRID_Y_MIN, type GridClass, type Observation } from './schema.ts';

const CLASS_ID: Readonly<Record<GridClass, number>> = Object.fromEntries(GRID_CLASSES.map((c, i) => [c, i])) as Record<GridClass, number>;

/** The parts of World the builder reads. */
export interface ObsWorld {
  blockAt(p: Vec3): BlockInfo | undefined;
  find(pred: (b: BlockInfo, p: Vec3) => boolean, opts: FindOptions): Vec3[];
  readonly entities: ReadonlyMap<bigint, EntityInfo>;
  readonly self: { health: number; food: number };
  readonly inventory: { readonly slots: readonly (ItemStack | null)[] };
}

/** The bot's own body (the input loop's simulation) and view. */
export interface ObsBody {
  pos: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', 'light_block']);
const WATER_NAMES = new Set(['water', 'flowing_water']);
const LAVA_NAMES = new Set(['lava', 'flowing_lava']);

/** Grid class of one block (undefined = not loaded). */
export function blockClass(b: BlockInfo | undefined): GridClass {
  if (!b || b.name === 'unknown') return 'unknown';
  if (AIR_NAMES.has(b.name)) return 'air';
  const c = classify(b.name);
  if (c === 'log') return 'log';
  if (c === 'leaves') return 'leaves';
  if (WATER_NAMES.has(b.name)) return 'water';
  if (LAVA_NAMES.has(b.name)) return 'lava';
  if (b.solid) return 'solid';
  return 'other';
}

/** Is this item a natural log (what the reward counts)? */
export const isLogItem = (name: string): boolean => classify(name) === 'log';

/** Item counts by name over the 36 inventory slots. */
export function inventoryCounts(slots: readonly (ItemStack | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of slots) if (s && s.count > 0) out[s.name] = (out[s.name] ?? 0) + s.count;
  return out;
}

export function logCount(slots: readonly (ItemStack | null)[]): number {
  let n = 0;
  for (const s of slots) if (s && isLogItem(s.name)) n += s.count;
  return n;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function buildGrid(world: Pick<ObsWorld, 'blockAt' | 'entities'>, feet: Vec3): number[] {
  const [sx, sz, sy] = GRID_SHAPE;
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + 1e-6);
  const fz = Math.floor(feet.z);
  const hx = (sx - 1) / 2;
  const hz = (sz - 1) / 2;
  const grid = new Array<number>(sx * sz * sy);
  const p = { x: 0, y: 0, z: 0 };
  for (let ix = 0; ix < sx; ix++) {
    for (let iz = 0; iz < sz; iz++) {
      for (let iy = 0; iy < sy; iy++) {
        p.x = fx + ix - hx;
        p.y = fy + iy + GRID_Y_MIN;
        p.z = fz + iz - hz;
        grid[(ix * sz + iz) * sy + iy] = CLASS_ID[blockClass(world.blockAt(p))];
      }
    }
  }
  // Item drops mark their cell when it is otherwise passable.
  for (const e of world.entities.values()) {
    if (e.type !== 'minecraft:item') continue;
    const ix = Math.floor(e.pos.x) - fx + hx;
    const iy = Math.floor(e.pos.y + 1e-6) - fy - GRID_Y_MIN;
    const iz = Math.floor(e.pos.z) - fz + hz;
    if (ix < 0 || ix >= sx || iy < 0 || iy >= sy || iz < 0 || iz >= sz) continue;
    const i = (ix * sz + iz) * sy + iy;
    if (grid[i] === CLASS_ID.air || grid[i] === CLASS_ID.other) grid[i] = CLASS_ID.item_drop;
  }
  return grid;
}

export interface NearestLog {
  p: Vec3;
  dx: number;
  dy: number;
  dz: number;
  dist: number;
  inReach: boolean;
}

/** Search radius for nearest_log and goto_nearest_log (blocks). */
export const LOG_SEARCH_RADIUS = 48;

/** Nearest block matching `block` (`log` = any natural log, else a block name) to the feet. */
export function nearestLog(world: Pick<ObsWorld, 'find'>, feet: Vec3, block = 'log', reach = DEFAULT_REACH): NearestLog | undefined {
  const origin = { x: feet.x, y: feet.y + 0.5, z: feet.z };
  const pred = block === 'log' ? (b: BlockInfo) => classify(b.name) === 'log' : (b: BlockInfo) => b.name === block;
  const found = world.find(pred, { origin, radius: LOG_SEARCH_RADIUS, max: 1, ...(block === 'log' || classify(block) === 'log' ? { class: 'log' as const } : {}) });
  const p = found[0];
  if (!p) return undefined;
  const dx = p.x + 0.5 - feet.x;
  const dy = p.y + 0.5 - feet.y;
  const dz = p.z + 0.5 - feet.z;
  const eye = { x: feet.x, y: feet.y + EYE_HEIGHT, z: feet.z };
  return { p, dx, dy, dz, dist: Math.hypot(dx, dy, dz), inReach: distanceToBlock(eye, p) <= reach };
}

export function buildObservation(world: ObsWorld, body: ObsBody, lastSkill: Observation['last_skill']): { obs: Observation; nearest: NearestLog | undefined } {
  const feet = body.pos;
  const nearest = nearestLog(world, feet);
  const obs: Observation = {
    grid: buildGrid(world, feet),
    self: {
      pos: [r3(feet.x), r3(feet.y), r3(feet.z)],
      yaw: r3(normYaw(body.yaw)),
      pitch: r3(body.pitch),
      health: world.self.health,
      food: world.self.food,
      on_ground: body.onGround,
    },
    inventory: inventoryCounts(world.inventory.slots),
    nearest_log: nearest ? { dx: r3(nearest.dx), dy: r3(nearest.dy), dz: r3(nearest.dz), dist: r3(nearest.dist), in_reach: nearest.inReach } : null,
    last_skill: lastSkill,
  };
  return { obs, nearest };
}

/** Yaw in [-180, 180). */
export function normYaw(yaw: number): number {
  let y = ((yaw + 180) % 360 + 360) % 360 - 180;
  if (Object.is(y, -0)) y = 0;
  return y;
}
