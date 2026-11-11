// Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"; decisions/0082-drawn-entries-and-hops.md):
// a HOP: a flight between two places under one roof that never leaves the cave. The owner: "if it's pathfinding from
// underground to another spot underground, I should try to find it without having to get out first". It is the drawn
// way out's first half and the drawn way in's second on one line:
//
//   1 the flood     by cost from the body's cell to a standable cell by the goal (`floodTo`: aimed at it, a hole in the
//                   roof over the way passed, the open air beyond it not);
//   2 the line      the way's points on the taut line between the two heights (`rise`), pulled straight and rounded as a
//                   way out is; no tail: it ends a block over the touchdown, then on it. It may climb: where it does the
//                   follower's rockets carry it;
//   3 the speeds    for every point (`lineSpeeds`), coming down to HOP_END on the touchdown;
//   4 the rockets   the takeoff's, then the follower's own by speed, and a LAST one in a place set by the line's end:
//                   HOP_LAST_FROM to HOP_LAST_TO blocks before the touchdown. A rocket burns 9 to 21 ticks, which is 15 to
//                   35 blocks of flight, and nobody knows which: one fired later than that could still burn where the
//                   touchdown's brake begins, and a body that has none in that place may come to the end too slow to
//                   fly. So a hop shorter than HOP_MIN is not flown at all: it is walked, as before;
//   5 the flight    the guide follower from standing (learn/follow.ts, as on a way out) to HOP_HAND blocks before the
//                   touchdown, then the entry's flier (learn/entry.ts EntryFlier, as on a way in: the governor, the brake
//                   over the touchdown, the sink) from that place on the same line. The brain flies both (brain.ts
//                   guideTakeoff, entry);
//   6 the PROOF     the whole of it simulated from standing to standing (glide.ts routeHop): every burn from 9 to 21, the
//                   mixes, a first rocket that fires nothing; each must stand within ENTRY_GOAL of the goal with no hit
//                   (with a first rocket that fires nothing it may come down short of the goal instead, with no hit: the
//                   body stands by its start again and the trip asks again).
//
// A hop that is not proven is not flown: the trip goes on as it would without one.
import type { Vec3 } from '../../../connection/types.ts';
import type { RouteGrid } from '../route/grid.ts';
import { DRAW_BERTHS, DRAW_CAP_MAX, DRAW_HEADROOM, DRAW_LIFT, DRAW_ROCKET_TICK, DRAW_THIN, floodTo, lineSpeeds, pull, rememberedGrid, resample, rise, round } from './draw.ts';
import { ticksOf } from './drawin.ts';
import { ENTRY_KEEP_LAST, type EntryLine } from './entry.ts';
import { guideLength, type Guide } from './guide.ts';

/** The entry's flier takes the body this far before the touchdown (blocks along the line: where its touchdown may begin). */
export const HOP_HAND = ENTRY_KEEP_LAST;
/** The last rocket goes between these distances before the touchdown (blocks along the line): the longest burn's flight (21 ticks at 1.67 a tick: 35) and the brake's room before it; and 12 blocks of room to be in. */
export const HOP_LAST_FROM = 56;
export const HOP_LAST_TO = 44;
/** A hop shorter than this (blocks of line) is not flown: its takeoff's rocket would be the last one, and may burn past the touchdown. */
export const HOP_MIN = HOP_LAST_TO + 4;
/** The speed on the touchdown (blocks a tick), the last HOP_SLOW blocks coming down to it. */
export const HOP_END = 0.75;
export const HOP_SLOW = 12;
/** The flood's reach (blocks from the start, straight) and cells. */
export const HOP_RADIUS = 320;
export const HOP_FLOOD_MAX = 150_000;

/** A drawn hop: the line for the follower, the same line for the entry's flier, and what the log says of it. */
export interface DrawnHop {
  guide: Guide;
  line: EntryLine;
  /** Blocks along the line where the entry's flier takes the body. */
  hand: number;
  /** The touchdown's cell, the flood's cells to it, the berth the line was drawn with. */
  cell: { x: number; y: number; z: number };
  steps: number;
  berth: number;
  /** The line's height from its lowest to its highest point (blocks). */
  climb: number;
  at: string;
}

/**
 * One hop's line from the flood's way to a touchdown cell, or the words for why it is none. `goal`: the goal's own cell
 * (the proof measures against it; the touchdown may be a cell beside it).
 */
export function drawHop(grid: RouteGrid, from: Vec3, way: { x: number; y: number; z: number; steps: number; cost: number; way: { x: number; y: number; z: number }[] }, goal: { x: number; y: number; z: number }, berth: number, beside: boolean, name: string): { guide: Guide; line: EntryLine; hand: number; climb: number } | string {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y + 1e-6);
  const sz = Math.floor(from.z);
  for (let k = 1; k < DRAW_HEADROOM; k++) if (grid.solid(sx, sy + k, sz)) return `only ${k} of air over the start (a jump needs ${DRAW_HEADROOM} to take a glide)`;
  const td = { x: way.x + 0.5, y: way.y, z: way.z + 0.5 };
  const lifted = { x: from.x, y: from.y + DRAW_LIFT, z: from.z };
  const risen = rise(grid, way, lifted.y, berth, beside, { end: td.y + DRAW_LIFT });
  const pulled = pull(grid, [lifted, ...risen.slice(beside ? Math.min(DRAW_THIN - 1, Math.max(0, risen.length - 2)) : 0)], berth);
  const line = resample(round(grid, pulled, Math.min(berth, DRAW_BERTHS[DRAW_BERTHS.length - 1]!)));
  const points = [{ ...from }, ...line, td];
  const n = points.length;
  const length = guideLength({ points });
  if (length < HOP_MIN) return `${length.toFixed(0)} blocks of line: too short to fly (a rocket burns up to 35 blocks of flight; under ${HOP_MIN} it is walked)`;
  const speeds = lineSpeeds(points).map((v, i) => Math.min(v, HOP_END + ((DRAW_CAP_MAX - HOP_END) * Math.min(HOP_SLOW, n - 1 - i)) / HOP_SLOW));
  const p1 = points[Math.min(n - 1, 4)]!;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  const guide: Guide = {
    path: name,
    flight: 0,
    points,
    ticks: ticksOf(points, speeds),
    rockets: [{ tick: DRAW_ROCKET_TICK, at: 1 }],
    yaw: (Math.atan2(-(p1.x - from.x), p1.z - from.z) * 180) / Math.PI,
    grounded: true,
    landed: true,
    drawn: true,
    speeds,
    hop: { from: Math.max(1, length - HOP_LAST_FROM), to: length - HOP_LAST_TO },
  };
  const centre = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 };
  return { guide, line: { guide, lead: 0, open: 0, from: 0, to: 0, touchdown: td, recorded: { ...td }, off: 0, goal: centre }, hand: length - HOP_HAND, climb: hi - lo };
}

/**
 * The drawn hops from where the body stands (feet `from`) to a goal's touchdown cells (learn/entry.ts entryTouchdowns:
 * the goal's own first), under the roof up to `top`: the flood to the first of `cells` it reaches, that way drawn with
 * the berths of DRAW_BERTHS that give different lines, the widest first. `tried` says what the others failed on; `why`
 * when there is nothing at all.
 */
export function drawHops(grid: RouteGrid, from: Vec3, goal: { x: number; y: number; z: number }, cells: readonly { x: number; y: number; z: number }[], top: number, o: { radius?: number; max?: number; stands?: (c: { x: number; y: number; z: number }) => boolean } = {}): { hops: DrawnHop[]; cells: number; tried: string[]; why?: string } {
  const g = rememberedGrid(grid, from);
  const stands = o.stands ?? ((c: { x: number; y: number; z: number }): boolean => g.solid(c.x, c.y - 1, c.z) && !g.solid(c.x, c.y, c.z) && !g.solid(c.x, c.y + 1, c.z));
  const tried: string[] = [];
  let looked = 0;
  for (const c of cells) {
    if (!stands(c)) continue;
    const f = floodTo(g, from, c, { radius: o.radius ?? HOP_RADIUS, max: o.max ?? HOP_FLOOD_MAX, top });
    looked += f.cells;
    if (!f.way) {
      tried.push(`no way under the roof to the cell ${c.x - goal.x} ${c.y - goal.y} ${c.z - goal.z} from the goal's (${f.cells} cells looked at)`);
      // (a goal the flood does not reach is not reached by way of the cell beside it either: one flood says so)
      break;
    }
    const hops: DrawnHop[] = [];
    const seen: string[] = [];
    for (const [berth, beside] of DRAW_BERTHS.flatMap((b) => [[b, true], [b, false]] as const)) {
      const at = `${f.way.steps} cells of the flood to the cell ${c.x - goal.x} ${c.y - goal.y} ${c.z - goal.z} from the goal's, a berth of ${berth}${beside ? '' : ' over the floor and under the roof'}`;
      const d = drawHop(g, from, f.way, goal, berth, beside, `hop ${hops.length + 1}`);
      if (typeof d === 'string') {
        tried.push(`${at}: ${d}`);
        if (/too short|of air over the start/.test(d)) break;
        continue;
      }
      const sig = d.guide.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`).join(';');
      if (seen.includes(sig)) continue;
      seen.push(sig);
      hops.push({ ...d, cell: { x: c.x, y: c.y, z: c.z }, steps: f.way.steps, berth, at });
    }
    return { hops, cells: looked, tried };
  }
  return { hops: [], cells: looked, tried, why: tried.length ? tried[tried.length - 1]! : 'no cell a body can stand in within reach of the goal' };
}
