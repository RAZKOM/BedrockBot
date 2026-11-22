// The opt-in perf project (`pnpm test:perf`, Track REL3, docs/testing.md "The perf project"): fly-land-mobs.test.ts's
// former time bound (Track M3: the landing's look at the hostiles over 200 entities under a millisecond a tick), as it
// was. The unit case keeps the look over 50, 200 and 800 entities.
import { describe, expect, it } from 'vitest';
import { cellPrice, LAND_MOBS, landMobsNear, touchdownThreat, type CreeperTrack } from '../../src/skills/fly/landmobs.ts';
import type { EntityInfo } from '../../src/world/types.ts';

const entity = (id: number, type: string, x: number, y: number, z: number): EntityInfo => ({ runtimeId: BigInt(id), uniqueId: BigInt(-id), type, pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, headYaw: 0, onGround: true, updatedAt: 0 });

describe('the landing look at hostiles, wall clock', () => {
  const crowd = (n: number): EntityInfo[] => {
    const types = ['minecraft:zombie', 'minecraft:creeper', 'minecraft:skeleton', 'minecraft:item', 'minecraft:cow', 'minecraft:phantom', 'minecraft:arrow', 'minecraft:sheep'];
    return Array.from({ length: n }, (_, k) => entity(k + 1, types[k % types.length]!, ((k * 37) % 160) - 80 + 0.5, 64, ((k * 91) % 160) - 80 + 0.5));
  };
  it('the hostiles near a place and the touchdown look over 200 entities: under a millisecond a tick (a tick is 50)', () => {
    const lines: string[] = [];
    for (const n of [50, 200, 800]) {
      const ents = crowd(n);
      const states = { get: () => undefined, targetsUs: () => false };
      const track: CreeperTrack = new Map();
      const reps = 2000;
      let found = 0;
      const t0 = performance.now();
      for (let i = 0; i < reps; i++) {
        const mobs = landMobsNear(ents, states, { x: 0.5, z: 0.5 });
        found = mobs.length;
        touchdownThreat(mobs, { x: 0.5, y: 64, z: 0.5 }, 40, i, track);
      }
      const us = ((performance.now() - t0) / reps) * 1000;
      const t1 = performance.now();
      const mobs = landMobsNear(ents, states, { x: 0.5, z: 0.5 });
      for (let i = 0; i < reps; i++) cellPrice({ x: i % 30, z: 3, feet: 64 }, mobs);
      const cellUs = ((performance.now() - t1) / reps) * 1000;
      lines.push(`${n} entities (${found} hostile within ${LAND_MOBS.scan}): the look ${us.toFixed(1)} us a tick, a cell's price ${cellUs.toFixed(2)} us`);
      if (n === 200) expect(us).toBeLessThan(1000);
    }
    console.log(lines.join('\n'));
  });
});
