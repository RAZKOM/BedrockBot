// Track F4a (docs/flight.md "Obstacle course (Track F4a)", decisions/0067): the flight benchmark's obstacle courses
// built on the server. The layouts are pure data (course-layout.ts, shared with the bot's offline bench); this file
// only executes their ops. The chunks of a course need not be loaded: the build holds a ticking area (the pack's
// TickingAreaManager) over each piece of the course while it fills it, so nobody has to stand there. Stable
// @minecraft/server 2.10.0 only. Registered by main.ts through `courseHandlers()`.
//
//   course list                         -> {names}
//   course build name x y z             -> {name, origin, bounds, ops, volume, pieces, legs, ticks}: clears the
//                                          course's volume (air from y up, dirt and grass under it) and builds it;
//                                          x y z is the feet height of the ground at the course's start
//   course clear name x y z             -> the same without the stations (the flat ground back)
// (Track F5a: `build` also builds the real-cave replica, cave.ts.)
import { BlockVolume, system, world, type Dimension } from '@minecraft/server';
import { TruthError, blockPos, type Vec3 } from './protocol.js';
import { COURSE_NAMES, chunkPieces, clipOp, courseLayout, opsVolume, type CourseOp } from './course-layout.js';

export interface CourseDeps {
  reply(cmd: string, id: string | null, ok: boolean, data: unknown, reason?: string): void;
  replyError(cmd: string, id: string | null, e: unknown): void;
  overworld(): Dimension;
}

type CourseHandler = (args: string[], ctx: { cmd: string; id: string | null; async: boolean }) => unknown;

/** fillBlocks takes at most this many blocks a call. */
const FILL_SLAB = 32768;
/** The job yields after this many blocks filled (a few fillBlocks calls a tick). */
const BLOCKS_PER_STEP = 65536;
/** ... or after this many fillBlocks calls. */
const CALLS_PER_STEP = 256;
/** The ticking areas of a build are named so (an area left by a build that failed is removed by the next). */
const AREA_PREFIX = 'truth_course_';
/** A piece's chunks must load within this many ticks. */
const LOAD_TIMEOUT = 600;

/** Fill one op, split into fillBlocks calls of at most FILL_SLAB blocks; yields the blocks of each call. */
function* fillOp(dim: Dimension, op: CourseOp): Generator<number> {
  const id = `minecraft:${op.block}`;
  const sx = op.to.x - op.from.x + 1;
  const sz = op.to.z - op.from.z + 1;
  const layer = sx * sz;
  if (layer <= FILL_SLAB) {
    const slabH = Math.max(1, Math.floor(FILL_SLAB / layer));
    for (let y0 = op.from.y; y0 <= op.to.y; y0 += slabH) {
      const y1 = Math.min(op.to.y, y0 + slabH - 1);
      dim.fillBlocks(new BlockVolume({ ...op.from, y: y0 }, { ...op.to, y: y1 }), id);
      yield layer * (y1 - y0 + 1);
    }
    return;
  }
  const rows = Math.max(1, Math.floor(FILL_SLAB / sx));
  for (let y = op.from.y; y <= op.to.y; y++) {
    for (let z0 = op.from.z; z0 <= op.to.z; z0 += rows) {
      const z1 = Math.min(op.to.z, z0 + rows - 1);
      dim.fillBlocks(new BlockVolume({ x: op.from.x, y, z: z0 }, { x: op.to.x, y, z: z1 }), id);
      yield sx * (z1 - z0 + 1);
    }
  }
}

/** Run the ops as a job; resolves when they are all filled. */
function runOps(dim: Dimension, ops: readonly CourseOp[]): Promise<void> {
  return new Promise((resolve, reject) => {
    system.runJob(
      (function* () {
        try {
          let done = 0;
          let calls = 0;
          for (const op of ops) {
            for (const n of fillOp(dim, op)) {
              done += n;
              // (Track F5a: a cave build is tens of thousands of small boxes: a step ends after CALLS_PER_STEP calls too)
              if (done >= BLOCKS_PER_STEP || ++calls >= CALLS_PER_STEP) {
                done = 0;
                calls = 0;
                yield;
              }
            }
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      })(),
    );
  });
}

/** Create a ticking area and wait for its chunks (at most LOAD_TIMEOUT ticks). */
export function loadArea(id: string, dim: Dimension, from: Vec3, to: Vec3): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = system.runTimeout(() => reject(new TruthError('unloaded_chunk', `the ticking area ${id} did not load in ${LOAD_TIMEOUT} ticks`, { from, to })), LOAD_TIMEOUT);
    world.tickingAreaManager.createTickingArea(id, { dimension: dim, from, to }).then(
      () => {
        system.clearRun(timer);
        resolve();
      },
      (e: unknown) => {
        system.clearRun(timer);
        reject(e);
      },
    );
  });
}

/** Build `ops` over `bounds` piece by piece, each piece under its own ticking area while it is filled (Track F5a: cave.ts too). */
export async function build(dim: Dimension, bounds: { min: Vec3; max: Vec3 }, ops: readonly CourseOp[]): Promise<number> {
  const mgr = world.tickingAreaManager;
  for (const a of mgr.getAllTickingAreas()) if (a.identifier.startsWith(AREA_PREFIX)) mgr.removeTickingArea(a);
  const room = Math.max(1, mgr.maxChunkCount - mgr.chunkCount);
  const pieces = chunkPieces(bounds, Math.min(room, 256));
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const id = `${AREA_PREFIX}${i}`;
    await loadArea(id, dim, piece.min, piece.max);
    try {
      const mine: CourseOp[] = [];
      for (const op of ops) {
        const c = clipOp(op, piece);
        if (c) mine.push(c);
      }
      await runOps(dim, mine);
    } finally {
      if (mgr.hasTickingArea(id)) mgr.removeTickingArea(id);
    }
  }
  return pieces.length;
}

export function courseHandlers(deps: CourseDeps): Record<string, CourseHandler> {
  const { reply, replyError, overworld } = deps;
  return {
    course(args, ctx) {
      const sub = args[0];
      if (sub === 'list') return { names: [...COURSE_NAMES] };
      if (sub !== 'build' && sub !== 'clear') throw new TruthError('bad_args', 'usage: course list | build name x y z | clear name x y z');
      const name = args[1] ?? '';
      const origin = blockPos(args, 2);
      const layout = courseLayout(name, origin);
      if (!layout) throw new TruthError('bad_args', `unknown course ${name}`, { names: [...COURSE_NAMES] });
      const dim = overworld();
      const hr = dim.heightRange;
      if (layout.bounds.min.y < hr.min || layout.bounds.max.y >= hr.max) throw new TruthError('out_of_bounds', `the course spans y ${layout.bounds.min.y}..${layout.bounds.max.y}`, { minY: hr.min, maxY: hr.max - 1 });
      // clear: the ground work only (the first three ops: the air, the dirt, the grass)
      const ops = sub === 'clear' ? layout.ops.slice(0, 3) : layout.ops;
      ctx.async = true;
      const { cmd, id } = ctx;
      const t0 = system.currentTick;
      build(dim, layout.bounds, ops).then(
        (pieces) => reply(cmd, id, true, { name, origin: layout.origin, bounds: layout.bounds, ops: ops.length, volume: opsVolume(ops), pieces, legs: layout.legs.length, ticks: system.currentTick - t0 }),
        (e: unknown) => replyError(cmd, id, e),
      );
      return undefined;
    },
  };
}
