// Track F5b (docs/flight.md "Cave flight (Track F5b)"): a procedural generator of irregular caves in the style of
// the game's own cave carvers: a worm that wanders from a mouth in a rock face, its radius swelling and shrinking
// along the way, bending left and right, dipping and climbing, with vertical drops, pillars left standing in the
// rooms and water in the dips. The courses of courses.ts are clean bores; a cave is not. The GENERALISATION set
// (`caveSet`) is what the cave flying style is scored on besides the owner's real cave: the goal is "caves", not one
// cave. A cave is a fully known world (`world`, the flat ground outside the rock), the fills that build it on a
// server with the truth pack, the mouth cell, the goal cell, the floor cells every `spacing` blocks along the worm
// (the stand-in for the owner's waypoints), and a TerrainSource (`terrain`) the coarse layer plans over.
import type { Vec3 } from '../../../connection/types.ts';
import { blockInfoOf } from '../../terrain/shapes.ts';
import type { TerrainSource } from '../../terrain/query.ts';
import type { BlockInfo } from '../../../world/types.ts';
import { flatWorld } from '../../input/world.ts';
import type { BlockQuery } from '../../input/types.ts';
import { cellKey } from '../../../../../packs/truth/src/course-layout.ts';
import { rng, type Fill } from './courses.ts';
import type { RegionBox } from './types.ts';

/** The flat world's feet height (the grass top is -61). */
const FEET = -60;
/** Rock round the cave (blocks) beyond the carved cells' box. */
const SHELL = 5;
/** The worm starts this high over the ground (the mass holds that much rock under it for the drops). */
const START_UP = 24;

export interface CaveOptions {
  seed: number;
  name?: string;
  /** The worm's length in blocks (default 160). */
  length?: number;
  /** The base radius drawn per cave within this range (blocks; default 1.6 to 3.2); the bore swells by `bulge` in the middle. */
  radius?: readonly [number, number];
  bulge?: number;
  /** Vertical drops along the way (default 1): the worm dives at DROP_PITCH for a few blocks. */
  drops?: number;
  /** Pillars left standing in the wider parts (default true). */
  pillars?: boolean;
  /** Water in the dips (default true). */
  water?: boolean;
  /** How the worm bends: the random perturbation's size (degrees a block; default 6) */
  wobble?: number;
  /** Where the mouth is (the first worm point's floor; default 0, FEET + START_UP, 0) and the first heading (Bedrock yaw; default 0 = +z). */
  origin?: Vec3;
  yaw?: number;
  /** The floor cells kept as waypoints every this many blocks of the worm (default 20). */
  spacing?: number;
}

export interface Cave {
  name: string;
  seed: number;
  world: BlockQuery;
  /** The rock mass (inclusive). */
  bounds: RegionBox;
  /** The carved cells and the water cells (cellKey of course-layout.ts). */
  cells: Set<number>;
  water: Set<number>;
  /** The worm's points, one a block. */
  centre: Vec3[];
  /** The radius along the worm. */
  radii: number[];
  /** The feet cell just inside the mouth (standable), the goal cell near the end (standable). */
  start: Vec3;
  goal: Vec3;
  /** Standable floor cells every `spacing` blocks along the worm, the start first and the goal last. */
  waypoints: Vec3[];
  /** The fills that build it with the truth pack: the mass in stone, the cells in air, the water. */
  fills: Fill[];
  /** The coarse layer's view (skills/coarse/source.ts terrainSource). */
  terrain: TerrainSource & { readonly minY: number; readonly maxY: number };
  /** The cross-section's narrowest height and width along the worm (the least over the worm's points). */
  narrowest: { height: number; width: number };
  kind: string;
}

/** The worm's dive pitch at a drop and the drop's length (blocks). */
export const DROP_PITCH = -65;
export const DROP_LEN = 7;

const key = cellKey;

/** The worm cave `o`: see the file comment. */
export function wormCave(o: CaveOptions): Cave {
  const r = rng(o.seed);
  const length = o.length ?? 160;
  const [r0, r1] = o.radius ?? [1.6, 3.2];
  const base = r0 + r() * (r1 - r0);
  const bulge = o.bulge ?? 1.0;
  const wobble = o.wobble ?? 6;
  const origin = o.origin ?? { x: 0, y: FEET + START_UP, z: 0 };
  const yaw0 = o.yaw ?? 0;
  const spacing = o.spacing ?? 20;
  const drops = o.drops ?? 1;
  // the drops' places along the worm (not in the first or the last fifth)
  const dropAt = new Set<number>();
  for (let i = 0; i < drops; i++) dropAt.add(Math.floor(length * (0.2 + (0.6 * (i + r())) / Math.max(1, drops))));

  // ---- the worm -------------------------------------------------------------------------------------------
  const centre: Vec3[] = [];
  const radii: number[] = [];
  let yaw = yaw0;
  let pitch = 0;
  let dYaw = 0;
  let dPitch = 0;
  let p = { x: origin.x + 0.5, y: origin.y + 1.5, z: origin.z + 0.5 };
  let drop = 0;
  for (let t = 0; t < length; t++) {
    const rad = Math.max(1.5, base + bulge * Math.sin((Math.PI * t) / length) + (r() - 0.5) * 0.8);
    centre.push({ ...p });
    radii.push(rad);
    if (dropAt.has(t)) drop = DROP_LEN;
    // the game's carver: the deltas are smoothed random walks; the pitch is pulled back to level
    dYaw = dYaw * 0.75 + (r() - r()) * r() * wobble;
    dPitch = dPitch * 0.75 + (r() - r()) * r() * 4;
    yaw += dYaw;
    pitch = drop > 0 ? DROP_PITCH : Math.max(-25, Math.min(20, pitch * 0.8 + dPitch));
    if (drop > 0) drop--;
    const rp = (pitch * Math.PI) / 180;
    const ry = (yaw * Math.PI) / 180;
    const h = Math.cos(rp);
    p = { x: p.x - Math.sin(ry) * h, y: p.y + Math.sin(rp), z: p.z + Math.cos(ry) * h };
    if (p.y < FEET + 3) p.y = FEET + 3; // never under the ground
  }

  // ---- the carving -------------------------------------------------------------------------------------------
  const cells = new Set<number>();
  const water = new Set<number>();
  const carved: Vec3[] = [];
  const minC = { x: Infinity, y: Infinity, z: Infinity };
  const maxC = { x: -Infinity, y: -Infinity, z: -Infinity };
  centre.forEach((c, i) => {
    const rad = radii[i]!;
    const rv = Math.max(1.5, rad * 0.75);
    for (let y = Math.floor(c.y - rv); y <= Math.ceil(c.y + rv); y++) {
      if (y < FEET) continue;
      for (let z = Math.floor(c.z - rad); z <= Math.ceil(c.z + rad); z++) {
        for (let x = Math.floor(c.x - rad); x <= Math.ceil(c.x + rad); x++) {
          const dx = (x + 0.5 - c.x) / rad;
          const dy = (y + 0.5 - c.y) / rv;
          const dz = (z + 0.5 - c.z) / rad;
          if (dx * dx + dy * dy + dz * dz >= 1) continue;
          const k = key(x, y, z);
          if (cells.has(k)) continue;
          cells.add(k);
          carved.push({ x, y, z });
          minC.x = Math.min(minC.x, x);
          minC.y = Math.min(minC.y, y);
          minC.z = Math.min(minC.z, z);
          maxC.x = Math.max(maxC.x, x);
          maxC.y = Math.max(maxC.y, y);
          maxC.z = Math.max(maxC.z, z);
        }
      }
    }
  });
  // the mass: the carved box plus the shell, from the ground up; the mouth side (the first point's heading) is the
  // mass's face there, the first sphere opening onto the outside
  const back = { x: -Math.sin((yaw0 * Math.PI) / 180), z: Math.cos((yaw0 * Math.PI) / 180) };
  const bounds: RegionBox = { min: { x: minC.x - SHELL, y: FEET, z: minC.z - SHELL }, max: { x: maxC.x + SHELL, y: maxC.y + SHELL, z: maxC.z + SHELL } };
  // the face at the mouth: the mass starts at the first centre's cell along the heading
  if (Math.abs(back.z) > Math.abs(back.x)) {
    if (back.z > 0) bounds.min.z = Math.floor(origin.z + 0.5);
    else bounds.max.z = Math.floor(origin.z + 0.5);
  } else if (back.x > 0) bounds.min.x = Math.floor(origin.x + 0.5);
  else bounds.max.x = Math.floor(origin.x + 0.5);
  const inMass = (x: number, y: number, z: number): boolean => x >= bounds.min.x && x <= bounds.max.x && y >= bounds.min.y && y <= bounds.max.y && z >= bounds.min.z && z <= bounds.max.z;

  // ---- pillars: in the wider parts, a column left standing a block or two off the centre -----------------------
  const pillars: Vec3[] = [];
  if (o.pillars ?? true) {
    let next = 30;
    centre.forEach((c, i) => {
      if (i < next || radii[i]! < 2.8) return;
      next = i + 30 + Math.floor(r() * 20);
      const side = r() < 0.5 ? -1 : 1;
      const ry = (yaw0 * Math.PI) / 180;
      const px = Math.floor(c.x + side * 1.5 * Math.cos(ry) + (r() - 0.5));
      const pz = Math.floor(c.z + side * 1.5 * Math.sin(ry) + (r() - 0.5));
      for (let y = bounds.min.y; y <= bounds.max.y; y++) {
        const k = key(px, y, pz);
        if (cells.has(k)) {
          cells.delete(k);
          pillars.push({ x: px, y, z: pz });
        }
      }
    });
  }

  // ---- water in the dips: where the worm turned from going down to going up, the lowest air layer round it ---------
  if (o.water ?? true) {
    for (let i = 6; i < centre.length - 6; i++) {
      const a = centre[i - 6]!.y;
      const b = centre[i]!.y;
      const c = centre[i + 6]!.y;
      if (!(b < a - 0.5 && b < c - 0.3 && centre[i - 1]!.y >= b && centre[i + 1]!.y >= b)) continue;
      const cc = centre[i]!;
      // the floor under the centre: the lowest carved cell of the column
      let floor: number | undefined;
      for (let y = Math.floor(cc.y); y >= FEET; y--) {
        if (!cells.has(key(Math.floor(cc.x), y, Math.floor(cc.z)))) {
          floor = y + 1;
          break;
        }
      }
      if (floor === undefined) continue;
      for (let z = Math.floor(cc.z) - 2; z <= Math.floor(cc.z) + 2; z++) {
        for (let x = Math.floor(cc.x) - 2; x <= Math.floor(cc.x) + 2; x++) {
          const k = key(x, floor, z);
          if (cells.has(k) && !cells.has(key(x, floor - 1, z))) water.add(k);
        }
      }
      i += 6;
    }
  }

  // ---- the world --------------------------------------------------------------------------------------------
  const flat = flatWorld();
  const world: BlockQuery = {
    solidAt(x, y, z) {
      if (inMass(x, y, z)) return !cells.has(key(x, y, z));
      return flat.solidAt(x, y, z);
    },
    // the water pockets: source blocks (the glide ends on water; the bench scores a touchdown there as a swim)
    liquidAt: (x, y, z) => (water.has(key(x, y, z)) ? { liquid: 'water', height: 8 / 9 } : null),
  };
  const solid = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;
  const standable = (x: number, feet: number, z: number): boolean => solid(x, feet - 1, z) && !solid(x, feet, z) && !solid(x, feet + 1, z) && !water.has(key(x, feet, z));
  /** The standable floor cell under a worm point (its column first, then the ring round it), undefined when none. */
  const floorCell = (c: Vec3): Vec3 | undefined => {
    const cx = Math.floor(c.x);
    const cz = Math.floor(c.z);
    for (let ring = 0; ring <= 2; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const x = cx + dx;
          const z = cz + dz;
          for (let y = Math.floor(c.y) + 1; y >= FEET; y--) {
            if (solid(x, y, z)) {
              if (standable(x, y + 1, z)) return { x, y: y + 1, z };
              break;
            }
          }
        }
      }
    }
    return undefined;
  };
  const waypoints: Vec3[] = [];
  let lastAt = -Infinity;
  centre.forEach((c, i) => {
    const want = i === 2 || i === centre.length - 3 || (i >= 2 && i - lastAt >= spacing && i < centre.length - 3 - spacing / 2);
    if (!want) return;
    const f = floorCell(c);
    if (f) {
      waypoints.push(f);
      lastAt = i;
    }
  });
  const start = waypoints[0] ?? { x: Math.floor(origin.x), y: FEET, z: Math.floor(origin.z) };
  const goal = waypoints[waypoints.length - 1] ?? start;

  // ---- the narrowest cross-section along the worm (height under the centre, width across the heading) ----------
  let height = Infinity;
  let width = Infinity;
  centre.forEach((c, i) => {
    const cx = Math.floor(c.x);
    const cy = Math.floor(c.y);
    const cz = Math.floor(c.z);
    if (!inMass(cx, cy, cz) || solid(cx, cy, cz)) return; // (the mouth's sphere pokes out of the mass: open air there)
    const LIMIT = 16;
    let up = 0;
    while (up < LIMIT && !solid(cx, cy + up + 1, cz)) up++;
    let down = 0;
    while (down < LIMIT && !solid(cx, cy - down - 1, cz)) down++;
    height = Math.min(height, up + down + 1);
    const n = centre[Math.min(centre.length - 1, i + 1)]!;
    const hx = n.x - c.x;
    const hz = n.z - c.z;
    const ax = Math.abs(hx) >= Math.abs(hz) ? 0 : 1;
    const az = ax ? 0 : 1;
    let l = 0;
    while (l < LIMIT && !solid(cx - ax * (l + 1), cy, cz - az * (l + 1))) l++;
    let rr = 0;
    while (rr < LIMIT && !solid(cx + ax * (rr + 1), cy, cz + az * (rr + 1))) rr++;
    width = Math.min(width, l + rr + 1);
  });

  // ---- the fills (the truth pack builds the mass in stone, the cells in air, the water) ------------------------
  const fills: Fill[] = [{ from: { ...bounds.min }, to: { ...bounds.max }, block: 'stone' }];
  for (const c of carved) if (cells.has(key(c.x, c.y, c.z))) fills.push({ from: c, to: c, block: 'air' });
  // (one op a cell: the truth pack's course builder merges runs; the water goes through `water`)

  // ---- the coarse layer's view --------------------------------------------------------------------------------
  const stone = blockInfoOf('stone');
  const air = blockInfoOf('air');
  const waterB = blockInfoOf('water');
  const grass = blockInfoOf('grass_block');
  const dirt = blockInfoOf('dirt');
  const bedrock = blockInfoOf('bedrock');
  const terrain: TerrainSource & { readonly minY: number; readonly maxY: number } = {
    minY: -64,
    maxY: bounds.max.y + 8,
    blockAt(x: number, y: number, z: number): BlockInfo | undefined {
      if (x < bounds.min.x - 64 || x > bounds.max.x + 64 || z < bounds.min.z - 64 || z > bounds.max.z + 64) return undefined;
      if (y > bounds.max.y + 8) return air;
      if (inMass(x, y, z)) {
        const k = key(x, y, z);
        if (water.has(k)) return waterB;
        return cells.has(k) ? air : stone;
      }
      if (y === -64) return bedrock;
      if (y <= -62) return dirt;
      if (y === -61) return grass;
      return air;
    },
  };

  return {
    name: o.name ?? `cave${o.seed}`,
    seed: o.seed,
    world,
    bounds,
    cells,
    water,
    centre,
    radii,
    start,
    goal,
    waypoints,
    fills,
    terrain,
    narrowest: { height: Number.isFinite(height) ? height : 0, width: Number.isFinite(width) ? width : 0 },
    kind: `r ${base.toFixed(1)}${drops ? `, ${drops} drop${drops === 1 ? '' : 's'}` : ''}${pillars.length ? `, ${new Set(pillars.map((q) => `${q.x},${q.z}`)).size} pillars` : ''}${water.size ? ', water' : ''}`,
  };
}

/**
 * The GENERALISATION set: twelve caves of three widths (tight: 1.5 to 2.2 of radius, so 3 to 5 across; medium: 2 to
 * 3; wide: 2.5 to 4, with pillars), every third with two drops, lengths 140 to 200, water in the dips. Every seed is
 * fixed, so the scores are the same run to run.
 */
export function caveSet(): Cave[] {
  const out: Cave[] = [];
  const widths: { name: string; radius: readonly [number, number]; pillars: boolean }[] = [
    { name: 'tight', radius: [1.5, 2.2], pillars: false },
    { name: 'medium', radius: [2.0, 3.0], pillars: true },
    { name: 'wide', radius: [2.5, 4.0], pillars: true },
  ];
  for (let i = 0; i < 12; i++) {
    const w = widths[i % 3]!;
    const seed = 101 + i;
    out.push(wormCave({ seed, name: `${w.name}-${seed}`, radius: w.radius, pillars: w.pillars, drops: i % 3 === 2 ? 2 : 1, length: 140 + (i % 4) * 20, yaw: (i * 90) % 360, origin: { x: 0, y: FEET + START_UP, z: 0 } }));
  }
  return out;
}
