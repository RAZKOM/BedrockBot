import { describe, expect, it } from 'vitest';
import { visitOrderBanded } from '../../../src/skills/home/discovery.ts';

describe('scan visit order (walking-aware nearest neighbour)', () => {
  it('reads a wall of stacked chests row by row before crossing to another room or floor', () => {
    // a 2-wide, 3-tall wall at x 0..1, y 0..2 (same room, path ~4 from home), a chest across the room (path 6 but 10 blocks away)
    // and a chest one floor up right above the bot (path 30 from home: another room via the stairs)
    const wall = [0, 1].flatMap((x) => [0, 1, 2].map((y) => ({ p: { x, y, z: 0 }, blocks: 4 })));
    const across = { p: { x: 10, y: 0, z: 0 }, blocks: 6 };
    const upstairs = { p: { x: 0, y: 4, z: 1 }, blocks: 30 };
    const order = visitOrderBanded([upstairs, across, ...wall], { x: 0.5, y: 0, z: 2.5 }, (it) => it.blocks);
    const names = order.map((it) => (it === across ? 'across' : it === upstairs ? 'upstairs' : `wall ${it.p.x},${it.p.y}`));
    expect(names.slice(0, 6).every((n) => n.startsWith('wall'))).toBe(true);
    expect(names.slice(6)).toEqual(['across', 'upstairs']);
  });
});
