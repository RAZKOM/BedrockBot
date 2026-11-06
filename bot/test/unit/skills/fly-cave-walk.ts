// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)"): the walk navigator in a closed loop over the cave
// (FakeConnection -> InputLoop <- BotSkills, as nav-sim.test.ts), the cave benchmark's walk legs and its walk-only
// baseline. The world is cave.ts's `terrain` (stone, water, air blocks).
import type { Logger } from '../../../src/log.ts';
import { BotSkills } from '../../../src/skills/index.ts';
import type { CaveWalk } from '../../../src/skills/fly/corridor/cave-bench.ts';
import type { CaveWorld } from '../../../src/skills/fly/corridor/cave.ts';
import type { BlockInfo, Vec3 } from '../../../src/world/types.ts';
import { harness } from './fakes.ts';

/** The world BotSkills reads, over the cave's blocks. */
function caveSkillsWorld(w: CaveWorld) {
  const t = w.terrain;
  const byState = new Map<number, BlockInfo>();
  const blockAt = (x: number, y: number, z: number): BlockInfo | undefined => {
    const b = t.blockAt(x, y, z);
    if (b) byState.set(b.stateId, b);
    return b;
  };
  return {
    self: { health: 20, food: 20 },
    chunks: { stateIdAt: (x: number, y: number, z: number) => blockAt(x, y, z)?.stateId, runtimeIdAt: () => 0, maxY: t.maxY, minY: t.minY },
    registry: {
      blockInfo: (stateId: number): BlockInfo => {
        const b = byState.get(stateId);
        if (!b) throw new Error(`state ${stateId} not in the cave`);
        return b;
      },
    },
    onBlockUpdate: () => () => {},
  };
}

/** A CaveWalk: the navigator walks from `from` to the feet cell, at most `ticksPerBlock` a block of the straight distance (and 600 more). */
export function caveWalker(w: CaveWorld, o: { ticksPerBlock?: number; logger?: Logger } = {}): CaveWalk {
  return async (from, to) => {
    const { conn, loop } = harness(from);
    const skills = new BotSkills({ loop, world: caveSkillsWorld(w), ...(o.logger ? { logger: o.logger } : {}) });
    conn.tick(5);
    let result: { ok: boolean; reason?: string } | undefined;
    // (near the cell: a waypoint in a cave's water is not a cell to stand on)
    const p = skills.goto({ type: 'near', p: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }, r: 1.5 }).then((r) => (result = r as { ok: boolean; reason?: string }));
    const max = 600 + Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * (o.ticksPerBlock ?? 40));
    let t = 0;
    let waterTicks = 0;
    while (skills.nav.busy && t < max) {
      conn.tick();
      if (loop.state.inWater) waterTicks++;
      t++;
      if (t % 50 === 0) await new Promise((r) => setImmediate(r)); // the planner's worker-less slices
    }
    skills.cancel();
    await p;
    const at: Vec3 = { ...loop.state.pos };
    loop.stop?.();
    const ok = result?.ok === true || (Math.hypot(at.x - (to.x + 0.5), at.z - (to.z + 0.5)) <= 1.5 && Math.abs(at.y - to.y) <= 1);
    return { ok, at, ticks: t, waterTicks, ...(ok ? {} : { reason: result?.reason ?? (t >= max ? 'timeout' : 'failed') }) };
  };
}
