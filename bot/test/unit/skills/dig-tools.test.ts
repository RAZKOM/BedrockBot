// Tool selection (PLAN.md 4.2) and aiming / reach helpers.
import { describe, expect, it } from 'vitest';
import { viewDirection } from '../../../src/skills/input/flags.ts';
import {
  FACE,
  checkReach,
  chooseTool,
  distanceToBlock,
  faceToward,
  lookAngles,
  serverReachDistance,
} from '../../../src/skills/dig/index.ts';

const inv = (...names: (string | null)[]) => names.map((n) => (n ? { name: n } : null));

describe('chooseTool', () => {
  it('stone axe in slot 3 for a log', () => {
    const c = chooseTool('oak_log', inv('dirt', 'sand', 'stick', 'stone_axe', 'wooden_pickaxe'), 0);
    expect(c).toMatchObject({ slot: 3, item: 'stone_axe', ticks: 15, effective: true });
  });
  it('the fastest axe wins; golden is fastest', () => {
    expect(chooseTool('oak_log', inv('wooden_axe', 'iron_axe', 'diamond_axe'), 0)?.slot).toBe(2);
    expect(chooseTool('oak_log', inv('diamond_axe', 'golden_axe'), 0)?.item).toBe('golden_axe');
  });
  it('pickaxe for stone, shovel for dirt and grass', () => {
    const bar = inv('stone_axe', 'wooden_shovel', 'stone_pickaxe');
    expect(chooseTool('stone', bar, 0)?.item).toBe('stone_pickaxe');
    expect(chooseTool('dirt', bar, 0)?.item).toBe('wooden_shovel');
    expect(chooseTool('grass_block', bar, 0)?.item).toBe('wooden_shovel');
  });
  it('hand otherwise: prefers a slot without a tool, then the selected slot', () => {
    expect(chooseTool('dirt', inv('stone_axe', 'wooden_pickaxe', 'stick'), 0)?.slot).toBe(2);
    // empty slots count as "no tool"; the lowest wins when none is selected
    expect(chooseTool('dirt', inv('stone_axe'), 0)?.slot).toBe(1);
    // the selected slot wins among equals (no switch)
    expect(chooseTool('dirt', inv('stick', null, 'dirt'), 2)?.slot).toBe(2);
    expect(chooseTool('oak_log', inv(null, null), 1)).toMatchObject({ slot: 1, item: null, ticks: 60 });
  });
  it('on equal ticks, a tool that harvests beats one that does not', () => {
    // stone: wooden pickaxe harvests (23 ticks); nothing else is faster
    expect(chooseTool('stone', inv('stick', 'wooden_pickaxe'), 0)?.slot).toBe(1);
  });
  it('only hotbar slots 0..8 count', () => {
    const slots = [...inv(null, null, null, null, null, null, null, null, null), { name: 'diamond_axe' }];
    expect(chooseTool('oak_log', slots, 0)?.ticks).toBe(60);
  });
  it('undefined for unknown blocks', () => {
    expect(chooseTool('no_such_block', inv('stone_axe'), 0)).toBeUndefined();
  });
});

describe('lookAngles', () => {
  it('matches viewDirection (yaw 0 = +z, 90 = -x, pitch +90 = down)', () => {
    const eye = { x: 0.5, y: -58.38, z: 0.5 };
    for (const t of [
      { x: 2.5, y: -59.5, z: 0.5 },
      { x: 0.5, y: -60.5, z: 1.5 },
      { x: -3.5, y: -50, z: -7.5 },
      { x: 0.5, y: -40, z: 0.6 },
    ]) {
      const { yaw, pitch } = lookAngles(eye, t);
      const v = viewDirection(yaw, pitch);
      const d = Math.hypot(t.x - eye.x, t.y - eye.y, t.z - eye.z);
      expect(v.x).toBeCloseTo((t.x - eye.x) / d, 9);
      expect(v.y).toBeCloseTo((t.y - eye.y) / d, 9);
      expect(v.z).toBeCloseTo((t.z - eye.z) / d, 9);
    }
    expect(lookAngles({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toEqual({ yaw: 0, pitch: 0 });
    expect(lookAngles({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }).yaw).toBeCloseTo(90);
    expect(lookAngles({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }).pitch).toBeCloseTo(90);
  });
});

describe('faceToward', () => {
  const eye = { x: 0.5, y: -58.38, z: 0.5 };
  it('picks the face the eye sees', () => {
    expect(faceToward(eye, { x: 2, y: -60, z: 0 })).toBe(FACE.west); // block to the east: its west face
    expect(faceToward(eye, { x: -2, y: -60, z: 0 })).toBe(FACE.east);
    expect(faceToward(eye, { x: 0, y: -60, z: 2 })).toBe(FACE.north);
    expect(faceToward(eye, { x: 0, y: -60, z: -2 })).toBe(FACE.south);
    expect(faceToward(eye, { x: 0, y: -61, z: 1 })).toBe(FACE.up); // ground in front, seen from above
    expect(faceToward(eye, { x: 0, y: -61, z: 0 })).toBe(FACE.up); // under the feet
    expect(faceToward(eye, { x: 0, y: -56, z: 0 })).toBe(FACE.down); // overhead
    expect(faceToward(eye, { x: 0, y: -55, z: 1 })).toBe(FACE.down); // high and close: its underside
  });
});

describe('reach', () => {
  const eye = { x: 0.5, y: -58.38, z: 0.5 };
  it('distances', () => {
    expect(distanceToBlock(eye, { x: 2, y: -60, z: 0 })).toBeCloseTo(Math.hypot(1.5, 0.62), 9);
    expect(distanceToBlock(eye, { x: 0, y: -59, z: 0 })).toBe(0); // the eye is inside
    expect(serverReachDistance(eye, { x: 2, y: -60, z: 0 })).toBeCloseTo(Math.hypot(1.5, 1.62, 0.5), 9);
  });
  it('own reach 5 by default', () => {
    expect(checkReach(eye, { x: 5, y: -60, z: 0 })).toMatchObject({ ok: true });
    expect(checkReach(eye, { x: 7, y: -60, z: 0 })).toMatchObject({ ok: false, reason: 'too_far' });
    expect(checkReach(eye, { x: 7, y: -60, z: 0 }, 8)).toMatchObject({ ok: true });
  });
  it('server limit from the BDS 1.26.51 measurements (|eye - corner| <= 6.7 * scalar)', () => {
    // accepted: 9.946 (scalar 1.5); rejected: 10.143
    expect(checkReach({ x: -0.2, y: -58.38, z: 0.5 }, { x: -10, y: -60, z: 0 }, 50).ok).toBe(true);
    expect(checkReach({ x: 0, y: -58.38, z: 0.5 }, { x: -10, y: -60, z: 0 }, 50)).toMatchObject({ ok: false, reason: 'server_range' });
    // scalar 1.0: accepted 6.698, rejected 6.717
    expect(checkReach({ x: -3.52, y: -58.38, z: 0.5 }, { x: -10, y: -60, z: 0 }, 50, 1).ok).toBe(true);
    expect(checkReach({ x: -3.5, y: -58.38, z: 0.5 }, { x: -10, y: -60, z: 0 }, 50, 1).ok).toBe(false);
  });
});
