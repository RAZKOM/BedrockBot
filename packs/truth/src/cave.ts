// Track F5a (docs/flight.md "Real-cave benchmark (Track F5a)", decisions/0068): a real cave rebuilt on the server
// from the bot's world cache. The cells come with the build (cave-layout.ts: stone everywhere, then the boxes of air
// and water), never from the pack: the cave is private data. A build is a session of messages:
//
//   cave begin <session> x y z sx sy sz   -> {session}: the box's min corner (blocks) and size
//   cave part <session> <i> <letters>     -> {session, part, boxes}: part i of the encoded boxes (any order)
//   cave build <session> <parts>          -> {session, boxes, volume, pieces, ticks}: stone over the box, then the
//                                            boxes in the order of the parts; the pieces under a ticking area each
//                                            (course.ts build); the session is dropped
//   cave drop <session>                   -> {session}: forget a session
// Stable @minecraft/server 2.10.0 only. Registered by main.ts through `caveHandlers()`.
import { system, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, type Vec3 } from './protocol.js';
import { build } from './course.js';
import type { CourseOp } from './course-layout.js';
import { CAVE_BLOCKS, decodeBoxes } from './cave-layout.js';

export interface CaveDeps {
  reply(cmd: string, id: string | null, ok: boolean, data: unknown, reason?: string): void;
  replyError(cmd: string, id: string | null, e: unknown): void;
  overworld(): Dimension;
}

type CaveHandler = (args: string[], ctx: { cmd: string; id: string | null; async: boolean }) => unknown;

interface Session {
  min: Vec3;
  size: Vec3;
  parts: Map<number, string>;
}

/** Sessions kept at most (an abandoned one is dropped when a new one would pass this). */
const MAX_SESSIONS = 4;

export function caveHandlers(deps: CaveDeps): Record<string, CaveHandler> {
  const { reply, replyError, overworld } = deps;
  const sessions = new Map<string, Session>();
  return {
    cave(args, ctx) {
      const sub = args[0];
      const name = args[1] ?? '';
      if (!name) throw new TruthError('bad_args', 'usage: cave begin|part|build|drop <session> ...');
      if (sub === 'begin') {
        const min = blockPos(args, 2);
        const size = blockPos(args, 5);
        if (size.x <= 0 || size.y <= 0 || size.z <= 0) throw new TruthError('bad_args', 'cave begin: an empty box');
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
        sessions.set(name, { min, size, parts: new Map() });
        return { session: name };
      }
      const s = sessions.get(name);
      if (!s) throw new TruthError('no_session', `no cave session ${name}`);
      if (sub === 'part') {
        const i = Number(args[2]);
        const data = args[3] ?? '';
        if (!Number.isInteger(i) || i < 0) throw new TruthError('bad_args', 'cave part: a part number');
        const boxes = decodeBoxes(data).length; // checked now: a bad part fails its own message
        s.parts.set(i, data);
        return { session: name, part: i, boxes };
      }
      if (sub === 'drop') {
        sessions.delete(name);
        return { session: name };
      }
      if (sub !== 'build') throw new TruthError('bad_args', `cave: unknown ${sub}`);
      const n = Number(args[2]);
      const missing: number[] = [];
      for (let i = 0; i < n; i++) if (!s.parts.has(i)) missing.push(i);
      if (missing.length) throw new TruthError('missing_parts', `cave build: ${missing.length} parts missing`, { missing: missing.slice(0, 20) });
      const max = { x: s.min.x + s.size.x - 1, y: s.min.y + s.size.y - 1, z: s.min.z + s.size.z - 1 };
      const dim = overworld();
      const hr = dim.heightRange;
      if (s.min.y < hr.min || max.y >= hr.max) throw new TruthError('out_of_bounds', `the cave spans y ${s.min.y}..${max.y}`, { minY: hr.min, maxY: hr.max - 1 });
      const ops: CourseOp[] = [{ from: s.min, to: max, block: 'stone' }];
      for (let i = 0; i < n; i++) {
        for (const q of decodeBoxes(s.parts.get(i)!)) {
          const block = CAVE_BLOCKS[q.b];
          if (!block) throw new TruthError('bad_args', `cave build: block code ${q.b}`);
          ops.push({ from: { x: s.min.x + q.x0, y: s.min.y + q.y0, z: s.min.z + q.z0 }, to: { x: s.min.x + q.x1, y: s.min.y + q.y1, z: s.min.z + q.z1 }, block });
        }
      }
      sessions.delete(name);
      ctx.async = true;
      const { cmd, id } = ctx;
      const t0 = system.currentTick;
      build(dim, { min: s.min, max }, ops).then(
        (pieces) => reply(cmd, id, true, { session: name, boxes: ops.length - 1, volume: s.size.x * s.size.y * s.size.z, pieces, ticks: system.currentTick - t0 }),
        (e: unknown) => replyError(cmd, id, e),
      );
      return undefined;
    },
  };
}
