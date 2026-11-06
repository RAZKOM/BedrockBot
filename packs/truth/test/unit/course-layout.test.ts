import { describe, expect, it } from 'vitest';
import { COURSE_NAMES, LAND_ENTRY_OUT, LAND_ENTRY_UP, RING_HEIGHTS, SHAFT_DEPTH, STACK_HIGH, STACK_LOW, START_UP, chunkPieces, clipOp, courseLayout, opsVolume, type CourseLayout, type CourseOp } from '../../src/course-layout.js';

const O = { x: 1000, y: -60, z: -500 };

/** The blocks after the ops, over the layout's bounds (later ops win). */
function paint(l: CourseLayout): (x: number, y: number, z: number) => string {
  const { min, max } = l.bounds;
  const sx = max.x - min.x + 1;
  const sz = max.z - min.z + 1;
  const cells = new Map<number, string>();
  const at = (x: number, y: number, z: number): number => ((y - min.y) * sz + (z - min.z)) * sx + (x - min.x);
  for (const op of l.ops) for (let y = op.from.y; y <= op.to.y; y++) for (let z = op.from.z; z <= op.to.z; z++) for (let x = op.from.x; x <= op.to.x; x++) cells.set(at(x, y, z), op.block);
  return (x, y, z) => cells.get(at(x, y, z)) ?? 'outside';
}

const inside = (op: CourseOp, l: CourseLayout): boolean => op.from.x >= l.bounds.min.x && op.to.x <= l.bounds.max.x && op.from.y >= l.bounds.min.y && op.to.y <= l.bounds.max.y && op.from.z >= l.bounds.min.z && op.to.z <= l.bounds.max.z;

describe('course-layout (Track F4a): the obstacle courses as pure data', () => {
  it('every course is deterministic, clears its volume first, and keeps its ops inside the bounds', () => {
    for (const name of COURSE_NAMES) {
      const a = courseLayout(name, O)!;
      expect(a, name).toBeDefined();
      expect(courseLayout(name, O)).toEqual(a);
      // the ground work first: air from the feet height up, two dirt layers and the grass under it
      expect(a.ops[0]).toEqual({ from: { x: a.bounds.min.x, y: O.y, z: a.bounds.min.z }, to: a.bounds.max, block: 'air' });
      expect(a.ops[1]!.block).toBe('dirt');
      expect(a.ops[1]!.from.y).toBe(O.y - 3);
      expect(a.ops[2]!.block).toBe('grass_block');
      expect(a.ops[2]!.from.y).toBe(O.y - 1);
      for (const op of a.ops) expect(inside(op, a), `${name} ${JSON.stringify(op)}`).toBe(true);
      expect(a.legs.length).toBeGreaterThan(0);
      for (const leg of a.legs) expect(leg.goals.length, `${name}/${leg.name}`).toBeGreaterThan(0);
    }
    expect(courseLayout('nope', O)).toBeUndefined();
  });

  it('a shifted origin shifts every op and goal by the same', () => {
    const a = courseLayout('full', O)!;
    const b = courseLayout('full', { x: O.x + 32, y: O.y, z: O.z - 16 })!;
    expect(b.ops.length).toBe(a.ops.length);
    a.ops.forEach((op, i) => {
      expect(b.ops[i]!.from).toEqual({ x: op.from.x + 32, y: op.from.y, z: op.from.z - 16 });
      expect(b.ops[i]!.block).toBe(op.block);
    });
    expect(b.legs[0]!.start.pos.x).toBeCloseTo(a.legs[0]!.start.pos.x + 32, 9);
  });

  it('the rings: five 3 x 3 openings at their heights in 5 x 5 frames, each opening a waypoint', () => {
    const l = courseLayout('rings', O)!;
    const at = paint(l);
    const goals = l.legs[0]!.goals;
    expect(goals.length).toBe(RING_HEIGHTS.length);
    goals.forEach((g, i) => {
      if (g.kind !== 'box') throw new Error('a ring is a waypoint');
      const z = g.min.z + 1;
      const y = O.y + RING_HEIGHTS[i]!;
      expect(at(O.x, y, z)).toBe('air');
      expect(at(O.x + 1, y + 1, z)).toBe('air');
      expect(at(O.x + 2, y, z)).toBe('stone');
      expect(at(O.x, y - 2, z)).toBe('stone');
      expect(at(O.x, y + 3, z)).toBe('air'); // over the frame
    });
  });

  it('the stacked platforms: 3 x 3 at y+20 and y+23, the landing on the inner floor 2 high; the shaft 1 x 1 and 10 deep', () => {
    const l = courseLayout('stack', O)!;
    const at = paint(l);
    const g = l.legs[0]!.goals[0]!;
    if (g.kind !== 'land') throw new Error('a landing');
    expect(g.cells.length).toBe(9);
    expect(g.top).toBe(O.y + STACK_LOW + 1);
    expect(g.ceiling! - g.top).toBe(2);
    const c = g.cells[4]!;
    expect(at(c.x, O.y + STACK_LOW, c.z)).toBe('stone');
    expect(at(c.x, O.y + STACK_HIGH, c.z)).toBe('stone');
    expect(at(c.x, g.top, c.z)).toBe('air');
    expect(at(c.x, g.top + 1, c.z)).toBe('air');
    // the hand-over entry: 40 out along the bearing, 9 over the floor, heading in
    const s = l.legs[0]!.start;
    expect(Math.hypot(s.pos.x - (c.x + 0.5), s.pos.z - (c.z + 0.5))).toBeCloseTo(LAND_ENTRY_OUT, 6);
    expect(s.pos.y).toBe(g.top + LAND_ENTRY_UP);
    // gliding there (the hand-over's state), nothing under it
    expect(s.standing).toBeUndefined();
    expect(s.speed).toBe(1);
    expect(at(Math.floor(s.pos.x), s.pos.y - 1, Math.floor(s.pos.z))).toBe('air');
    // the rings start standing on a 1 x 1 pillar START_UP high (the server cannot start a body in the air at a
    // speed); in the full course the stations flown on to have none in the way
    const ri = courseLayout('rings', O)!;
    const rs = ri.legs[0]!.start;
    const ra = paint(ri);
    expect(rs.standing).toBe(true);
    expect(rs.pos.y).toBe(O.y + START_UP);
    for (let y = O.y; y < rs.pos.y; y++) expect(ra(Math.floor(rs.pos.x), y, Math.floor(rs.pos.z)), `pillar ${y}`).toBe('stone');
    expect(ra(Math.floor(rs.pos.x), rs.pos.y, Math.floor(rs.pos.z))).toBe('air');
    expect(ra(Math.floor(rs.pos.x), rs.pos.y + 1, Math.floor(rs.pos.z))).toBe('air');
    const fu = courseLayout('full', O)!;
    const weave = fu.legs.find((l) => l.name === 'weave')!;
    expect(weave.start.standing).toBeUndefined();
    expect(paint(fu)(Math.floor(weave.start.pos.x), weave.start.pos.y - 1, Math.floor(weave.start.pos.z))).toBe('air');
    const sh = courseLayout('shaft', O)!;
    const sa = paint(sh);
    const f = sh.legs[0]!.goals[0]!;
    if (f.kind !== 'land') throw new Error('a landing');
    expect(f.rim! - f.top).toBe(SHAFT_DEPTH);
    for (let y = O.y; y < O.y + SHAFT_DEPTH; y++) {
      expect(sa(f.cells[0]!.x, y, f.cells[0]!.z)).toBe('air');
      expect(sa(f.cells[0]!.x + 1, y, f.cells[0]!.z)).toBe('stone');
    }
    expect(sa(f.cells[0]!.x, O.y - 1, f.cells[0]!.z)).toBe('grass_block');
  });

  it('the overhang: a ledge 8 up under a roof 4 above it that reaches past the ledge; the full course: the chain from the start pad to the finish pad', () => {
    const l = courseLayout('overhang', O)!;
    const at = paint(l);
    const g = l.legs[0]!.goals[0]!;
    if (g.kind !== 'land') throw new Error('a landing');
    expect(g.ceiling! - g.top).toBe(4);
    const c = g.cells[4]!;
    expect(at(c.x, g.top - 1, c.z)).toBe('stone');
    expect(at(c.x, g.ceiling!, c.z)).toBe('stone');
    expect(at(c.x, g.ceiling!, c.z - 3)).toBe('stone'); // the roof over the air before the ledge
    expect(at(c.x, g.top - 1, c.z - 3)).toBe('air');
    const full = courseLayout('full', O)!;
    expect(full.legs.map((x) => x.name)).toEqual(['climb', 'weave', 'ledge', 'finish', 'stack', 'shaft']);
    expect(full.legs.map((x) => x.chained)).toEqual([false, true, true, true, false, false]);
    expect(full.legs[0]!.start.standing).toBe(true);
    const fa = paint(full);
    const s = full.legs[0]!.start.pos;
    expect(fa(Math.floor(s.x), s.y - 1, Math.floor(s.z))).toBe('gold_block'); // the start pad
    const pad = full.legs[3]!.goals[0]!;
    if (pad.kind !== 'land') throw new Error('a landing');
    expect(fa(pad.cells[4]!.x, O.y - 1, pad.cells[4]!.z)).toBe('gold_block'); // the finish pad
  });

  it('clipOp and chunkPieces split a build into pieces of whole chunk rows that cover the ops exactly', () => {
    const l = courseLayout('full', O)!;
    const pieces = chunkPieces(l.bounds, 40);
    expect(pieces.length).toBeGreaterThan(1);
    let covered = 0;
    for (const p of pieces) {
      const nx = Math.floor(p.max.x / 16) - Math.floor(p.min.x / 16) + 1;
      const nz = Math.floor(p.max.z / 16) - Math.floor(p.min.z / 16) + 1;
      expect(nx * nz).toBeLessThanOrEqual(40);
      for (const op of l.ops) {
        const c = clipOp(op, p);
        if (c) covered += opsVolume([c]);
      }
    }
    expect(covered).toBe(opsVolume(l.ops));
  });
});
