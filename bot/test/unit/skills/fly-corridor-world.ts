// Track F4b: the corridor world of the unit tests and the e2e (test/e2e/fly-corridor.test.ts), built from the
// same boxes offline (withBoxes over the flat ground) and on the server (truth:fill, stone hulls then air
// bores): a start on the flat ground, a 3 x 3 cave mouth MOUTH_OUT blocks out along +x, a 3 x 3 bore
// STRAIGHT long, one 90-degree bend to +z, AFTER more blocks of 3 x 3, a 2-high section LOW long (the walk),
// and a 9 x 9 x 5 chamber closed on every side but the low section's. The goal is the chamber's centre
// cell, about 290 blocks from the start; nothing reaches it from the sky. `shaft: true` also opens a 1 x 1
// hole through the bore's roof SHAFT_AT blocks in (a second way in: the shaft drop).
import { flatWorld, withBoxes, type BlockBox } from '../../../src/skills/input/index.ts';
import { StubCorridorProvider, corridorOf, legOf, portalOf, volumeOf, type Corridor, type Portal, type Volume } from '../../../src/skills/fly/corridor/coarse-port.ts';
import type { Vec3 } from '../../../src/world/types.ts';

export const F = -60;
export const MOUTH_OUT = 150;
export const STRAIGHT = 140;
export const AFTER = 30;
export const LOW = 12;
export const SHAFT_AT = 60;

export interface CorridorWorld {
  origin: Vec3;
  /** The mouth's plane (the first bore column) and the bend's bore columns (x of the bore after the bend). */
  mouthX: number;
  bendX: number;
  /** Feet cells: the start, the fly leg's end (before the low section), the goal (the chamber's centre). */
  start: Vec3;
  flyEnd: Vec3;
  goal: Vec3;
  /** The fills in order (stone hulls first, then the air bores); `solidAt` is the same world offline. */
  fills: { from: Vec3; to: Vec3; block: 'stone' | 'air' }[];
  solidAt(x: number, y: number, z: number): boolean;
  /** The coarse layer's view of it: volumes and portals. */
  volumes: Volume[];
  mouth: Portal;
  tunnelPortals: Portal[];
  lowPortals: Portal[];
  /** The shaft through the roof (with `shaft`). */
  shaft?: Portal;
  /** The stub corridor: fly start -> mouth -> bore -> flyEnd, then walk flyEnd -> low section -> goal. */
  corridor: Corridor;
  /** With `shaft`: the same corridor in through the shaft instead of the mouth. */
  viaShaft?: Corridor;
  stub(corridors?: Corridor[], volumes?: Volume[]): StubCorridorProvider;
}

/** The corridor world at `origin` (the start's feet cell on the flat ground, feet y F). */
export function corridorWorld(origin: { x: number; z: number }, o: { after?: number; shaft?: boolean } = {}): CorridorWorld {
  const ox = Math.floor(origin.x);
  const oz = Math.floor(origin.z);
  const M = ox + MOUTH_OUT;
  const endX = M + STRAIGHT - 1; // the straight bore's last column
  const bx0 = endX - 2; // the bore after the bend: x bx0 .. endX
  const bendX = endX - 1;
  const bz1 = oz + 1 + (o.after ?? AFTER); // its last row
  const lz0 = bz1 + 1;
  const lz1 = lz0 + LOW - 1;
  const cz0 = lz1 + 1;
  const cz1 = cz0 + 8;
  const sx = M + SHAFT_AT;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => ({ from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 } });
  const hulls = [box(M, F, oz - 3, endX + 2, F + 4, oz + 3), box(bx0 - 2, F, oz - 3, endX + 2, F + 4, bz1 + 2), box(bx0 - 2, F, lz0 - 1, endX + 2, F + 3, lz1 + 1), box(bendX - 6, F, cz0 - 2, bendX + 6, F + 6, cz1 + 2)];
  const bores = [box(M, F, oz - 1, endX, F + 2, oz + 1), box(bx0, F, oz - 1, endX, F + 2, bz1), box(bx0, F, lz0, endX, F + 1, lz1), box(bendX - 4, F, cz0, bendX + 4, F + 4, cz1)];
  if (o.shaft) bores.push(box(sx, F + 3, oz, sx, F + 4, oz));
  const fills = [...hulls.map((b) => ({ ...b, block: 'stone' as const })), ...bores.map((b) => ({ ...b, block: 'air' as const }))];
  const boxes: BlockBox[] = fills.map((f) => ({ from: f.from, to: f.to, solid: f.block === 'stone' }));
  const world = withBoxes(flatWorld(), boxes);
  const solidAt = (x: number, y: number, z: number): boolean => world.solidAt(x, y, z) === true;

  // the coarse view: the sky over the flat ground before the hull and over the hull, the bores as caves
  const skyFlat = volumeOf('0:sky:flat', 'sky', { x: ox - 400, y: F, z: oz - 400 }, { x: M - 1, y: 319, z: oz + 400 });
  const skyHull = volumeOf('0:sky:hull', 'sky', { x: M, y: F + 7, z: oz - 400 }, { x: M + 600, y: 319, z: oz + 400 });
  const boreA = volumeOf('0:cave:a', 'cave', bores[0]!.from, bores[0]!.to);
  const boreB = volumeOf('0:cave:b', 'cave', bores[1]!.from, bores[1]!.to);
  const low = volumeOf('0:cave:low', 'cave', bores[2]!.from, bores[2]!.to);
  const chamber = volumeOf('0:cave:chamber', 'cave', bores[3]!.from, bores[3]!.to);
  const shaftV = o.shaft ? volumeOf('0:cave:shaft', 'cave', bores[4]!.from, bores[4]!.to, { minSpan: 1, headroom: { min: 5, max: 5 } }) : undefined;
  const volumes = [boreA, boreB, low, chamber, ...(shaftV ? [shaftV] : []), skyFlat, skyHull];
  const mouth = portalOf({ a: skyFlat.id, b: boreA.id, axis: 'x', center: { x: M, y: F, z: oz }, height: 3, width: 3, floorY: F });
  // the chunk borders inside the bores (x = 16k along the straight, z = 16k after the bend)
  const tunnelPortals: Portal[] = [];
  for (let x = Math.ceil((M + 1) / 16) * 16; x <= endX - 3; x += 16) tunnelPortals.push(portalOf({ a: boreA.id, b: boreA.id, axis: 'x', center: { x, y: F, z: oz }, height: 3, width: 3, floorY: F }));
  for (let z = Math.ceil((oz + 3) / 16) * 16; z <= bz1 - 4; z += 16) tunnelPortals.push(portalOf({ a: boreB.id, b: boreB.id, axis: 'z', center: { x: bendX, y: F, z }, height: 3, width: 3, floorY: F }));
  const lowPortals = [portalOf({ a: boreB.id, b: low.id, axis: 'z', center: { x: bendX, y: F, z: lz0 }, height: 2, width: 3, floorY: F }), portalOf({ a: low.id, b: chamber.id, axis: 'z', center: { x: bendX, y: F, z: cz0 }, height: 2, width: 3, floorY: F })];
  const start = { x: ox, y: F, z: oz };
  const flyEnd = { x: bendX, y: F, z: bz1 - 3 };
  const goal = { x: bendX, y: F, z: cz0 + 4 };
  const walk = legOf('walk', flyEnd, goal, lowPortals, [boreB.id, low.id, chamber.id]);
  const corridor = corridorOf([legOf('fly', start, flyEnd, [mouth, ...tunnelPortals], [skyFlat.id, boreA.id, boreB.id]), walk]);
  let shaft: Portal | undefined;
  let viaShaft: Corridor | undefined;
  if (shaftV) {
    // the hole's top cell (the sky over the hull above it, the shaft below), then the shaft's foot into the bore
    shaft = portalOf({ a: skyHull.id, b: shaftV.id, axis: 'y', center: { x: sx, y: F + 4, z: oz }, height: 1, width: 1 });
    const foot = portalOf({ a: shaftV.id, b: boreA.id, axis: 'y', center: { x: sx, y: F + 3, z: oz }, height: 1, width: 1 });
    const after = tunnelPortals.filter((p) => p.axis !== 'x' || p.center.x > sx);
    viaShaft = corridorOf([legOf('fly', start, flyEnd, [shaft, foot, ...after], [skyFlat.id, skyHull.id, shaftV.id, boreA.id, boreB.id]), walk]);
  }
  return {
    origin: start,
    mouthX: M,
    bendX,
    start,
    flyEnd,
    goal,
    fills,
    solidAt,
    volumes,
    mouth,
    tunnelPortals,
    lowPortals,
    ...(shaft ? { shaft } : {}),
    corridor,
    ...(viaShaft ? { viaShaft } : {}),
    stub: (corridors = [corridor], vols = volumes) => new StubCorridorProvider({ corridors, volumes: vols }),
  };
}

/** A corridor as lines (the tests' and the e2e's logs): per leg its mode, length and the portals it crosses (axis, centre, clearance, floor). */
export function corridorLines(c: Corridor): string[] {
  const p3 = (v: Vec3) => `${v.x} ${v.y} ${v.z}`;
  return [
    `${c.status}, ${c.legs.length} legs, ${Math.round(c.blocks)} blocks, cost ${Math.round(c.cost)}, ${c.expanded} expanded, ${c.ms.toFixed(1)} ms${c.reason ? ` (${c.reason})` : ''}`,
    ...c.legs.map((l) => `  ${l.mode} ${Math.round(l.blocks)} from ${p3(l.from)} to ${p3(l.to)}: ${l.portals.map((q) => `${q.axis}@${p3(q.center)} ${q.clearance.height}x${q.clearance.width}${q.floorY !== undefined ? ` f${q.floorY}` : ''}`).join(', ')}`),
  ];
}

