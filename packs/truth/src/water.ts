// Track W1 (docs/pathfinding.md "Water (Track W1)", decisions/0070-water-travel.md): the water course of the
// walking and following tests built on the server. The stations are pure data (water-layout.ts, shared with the
// bot's unit tests); this file runs their fills through the obstacle course's builder (course.ts `build`: one
// ticking area per piece while it is filled) and then their kicks: console setblocks that start a flow (a fill
// does not), under a ticking area held until the flow has settled. Stable @minecraft/server 2.10.0 only.
// Registered by main.ts through `waterHandlers()`.
//
//   water list                         -> {names}
//   water build name x y z             -> {name, origin, bounds, start, deepStart?, goal, surfaceY, ops, kicks,
//                                         ticks}: clears the station's footprint (air from y up, dirt and grass
//                                         under it), builds it and lets its water flow; x y z is the feet height
//                                         of the ground at the station's start
//   water clear name x y z             -> the same without the station (the flat ground back)
import { system, world } from '@minecraft/server';
import { build, loadArea, type CourseDeps } from './course.js';
import type { CourseOp } from './course-layout.js';
import { TruthError, blockPos } from './protocol.js';
import { WATER_STATIONS, waterStation } from './water-layout.js';

type WaterHandler = (args: string[], ctx: { cmd: string; id: string | null; async: boolean }) => unknown;

/** The ticking area that holds a station while its kicked water flows. */
const KICK_AREA = 'truth_water_kick';
/** Ticks the flow gets after the kicks (a 10-high fall settles in about 50; water flows a cell per 5 ticks). */
const FLOW_TICKS = 120;

const wait = (ticks: number): Promise<void> => new Promise((resolve) => system.runTimeout(resolve, ticks));

export function waterHandlers(deps: CourseDeps): Record<string, WaterHandler> {
  const { reply, replyError, overworld } = deps;
  return {
    water(args, ctx) {
      const sub = args[0];
      if (sub === 'list') return { names: [...WATER_STATIONS] };
      if (sub !== 'build' && sub !== 'clear') throw new TruthError('bad_args', 'usage: water list | build name x y z | clear name x y z');
      const name = args[1] ?? '';
      const st = waterStation(name, blockPos(args, 2));
      if (!st) throw new TruthError('bad_args', `unknown water station ${name}`, { names: [...WATER_STATIONS] });
      const dim = overworld();
      const hr = dim.heightRange;
      if (st.bounds.min.y < hr.min || st.bounds.max.y >= hr.max) throw new TruthError('out_of_bounds', `the station spans y ${st.bounds.min.y}..${st.bounds.max.y}`, { minY: hr.min, maxY: hr.max - 1 });
      // clear: the ground work only (the first three ops: the air, the dirt, the grass)
      const ops = (sub === 'clear' ? st.ops.slice(0, 3) : st.ops) as unknown as CourseOp[]; // fillOp only prefixes minecraft:
      const kicks = sub === 'clear' ? [] : st.kicks;
      ctx.async = true;
      const { cmd, id } = ctx;
      const t0 = system.currentTick;
      const run = async (): Promise<void> => {
        await build(dim, st.bounds, ops);
        if (kicks.length) {
          const mgr = world.tickingAreaManager;
          if (mgr.hasTickingArea(KICK_AREA)) mgr.removeTickingArea(KICK_AREA);
          await loadArea(KICK_AREA, dim, st.bounds.min, st.bounds.max);
          try {
            for (const k of kicks) dim.runCommand(`setblock ${k.p.x} ${k.p.y} ${k.p.z} ${k.block}`);
            await wait(FLOW_TICKS);
          } finally {
            if (mgr.hasTickingArea(KICK_AREA)) mgr.removeTickingArea(KICK_AREA);
          }
        }
      };
      run().then(
        () =>
          reply(cmd, id, true, {
            name: st.name,
            origin: st.origin,
            bounds: st.bounds,
            start: st.start,
            ...(st.deepStart ? { deepStart: st.deepStart } : {}),
            goal: st.goal,
            surfaceY: st.surfaceY,
            ops: ops.length,
            kicks: kicks.length,
            ticks: system.currentTick - t0,
          }),
        (e: unknown) => replyError(cmd, id, e),
      );
      return undefined;
    },
  };
}
