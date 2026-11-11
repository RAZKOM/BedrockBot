// Track F9e (docs/flight.md "Drawn lines, the way in and under one roof (Track F9e)"; decisions/0082-drawn-entries-and-hops.md):
// a way INTO a place under a roof that nobody recorded. Track F9c flies in along a recorded flight's line (learn/entry.ts:
// the line with its lead-in, the flier, the proof from every state the hand-over allows); where there is no recording the
// flight landed by the mouth and the walk followed. This file DRAWS the line a recording would have given, from the world
// alone, as learn/draw.ts does for the way out:
//
//   1 the flood     the same flood (`floodOut`), run from the touchdown outwards: the cheapest ways from a standable cell
//                   by the goal through the air under the roof to the cells under the real sky;
//   2 the line      the way's points on the taut line between the touchdown's height and the opening's (`rise`), pulled
//                   straight and rounded as a way out is, and carried on DRAW_IN_OUT blocks into the open air along the
//                   freest heading, rising DRAW_IN_RISE a block; then REVERSED: it begins in the open and ends on the
//                   touchdown. A glide climbs only on speed it has: a line that climbs more than DRAW_IN_CLIMB on its way
//                   in is no way in (the opening lies under the goal), and no rocket is fired near a touchdown under a
//                   roof;
//   3 the speeds    a drawn line has no recorder's clock. Each point gets the speed a glide may have there (`lineSpeeds`:
//                   a falling line at about a block a tick, less before a top or a tight corner), DRAW_IN_OPEN at the most
//                   in the open and DRAW_IN_END on the touchdown; the times are those speeds added up. The flier's
//                   governor (learn/follow.ts) flies it no faster.
//
// What comes out is a `GuideMatch` as learn/match.ts gives one for a recording: `entryLine` cuts its hand-over window (24
// blocks of open air ending 20 before the roof) and draws its lead-in, `proveEntry` flies it from every state the
// hand-over allows, `EntryFlier` flies it. Several openings and several berths are several candidates; the proof picks.
import type { Vec3 } from '../../../connection/types.ts';
import type { RouteGrid } from '../route/grid.ts';
import { DRAW_BERTHS, drawLine, floodOutSteps, lineSpeeds, rememberedGrid, resample, type DrawnWay } from './draw.ts';
import { chooseTouchdown, ENTRY_LEAD_IN, ENTRY_WINDOW, ENTRY_WINDOW_END, entryAim, type EntryLine, type EntryProof, type EntryWorld } from './entry.ts';
import { guideLength, type Guide } from './guide.ts';
import type { GuideMatch } from './match.ts';

/** The line goes on this far past the roof into the open (blocks): the hand-over window and its distance from the roof (learn/entry.ts) and a few more; at least DRAW_IN_MIN of it must be free. */
export const DRAW_IN_OUT = ENTRY_WINDOW + ENTRY_WINDOW_END + 6;
export const DRAW_IN_MIN = ENTRY_WINDOW + ENTRY_WINDOW_END;
/** ... rising this much a block away from the roof (14 degrees: what a glide at a block a tick comes down by itself). */
export const DRAW_IN_RISE = 0.36;
/** Of the headings free that far, the line takes the one that lies highest over the ground under it and under its lead-in, counted up to this (blocks: the cruise's clearance over that ground and a little, learn/entry.ts ENTRY_AIM_CLEARANCE). */
export const DRAW_IN_OVER = 16;
/** A way in may climb this much in all (blocks): the last blocks' pull-up onto the touchdown, not a passage that rises. */
export const DRAW_IN_CLIMB = 1.5;
/** The speed of the line in the open (blocks a tick) and on the touchdown, the last DRAW_IN_SLOW blocks coming down to it. */
export const DRAW_IN_OPEN = 1.2;
export const DRAW_IN_END = 0.75;
export const DRAW_IN_SLOW = 10;
/** The floods of one decision: the touchdown's cell must have this much air over the feet (a body stands in two). */
export const DRAW_IN_HEADROOM = 2;

/** A drawn way in: the line as a match (learn/match.ts), and what the log says of it. */
export interface DrawnEntry {
  match: GuideMatch;
  /** The cell under open sky the flood's way ended in, the flood's cells to it, the berth the line was drawn with. */
  exit: { x: number; y: number; z: number };
  steps: number;
  berth: number;
  /** Blocks of the line under the roof, and the height it comes down there. */
  under: number;
  drop: number;
  at: string;
}

/** Nothing solid over the cell of a point up to `top`. */
function sky(grid: RouteGrid, p: Vec3, top: number): boolean {
  for (let y = Math.floor(p.y) + 1; y <= top; y++) if (grid.solid(Math.floor(p.x), y, Math.floor(p.z))) return false;
  return true;
}

/** The times of a line flown at `speeds` (blocks a tick at each point): ticks after its first point. */
export function ticksOf(points: readonly Vec3[], speeds: readonly number[]): number[] {
  const ticks: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    ticks.push(ticks[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / Math.max(0.1, (speeds[i - 1]! + speeds[i]!) / 2));
  }
  return ticks;
}

/**
 * One way of the flood as a way in, or the words for why it is none: the line drawn outwards from the touchdown
 * (`drawLine` with a way in's tail), reversed, its climb counted, its speeds and times set.
 */
export function drawEntry(grid: RouteGrid, touchdown: Vec3, way: DrawnWay, top: number, berth: number, beside: boolean, name: string): { guide: Guide; open: number; under: number; drop: number } | string {
  const out = drawLine(grid, touchdown, way, top, berth, beside, { out: DRAW_IN_OUT, rise: DRAW_IN_RISE, min: DRAW_IN_MIN, up: false, headroom: DRAW_IN_HEADROOM, over: DRAW_IN_OVER, lead: ENTRY_LEAD_IN });
  if (typeof out === 'string') return out;
  const points = resample([...out.points].reverse());
  const n = points.length;
  // the last point under open sky (the roof begins after it), from the touchdown backwards
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (sky(grid, points[i]!, top)) {
      last = i;
      break;
    }
  }
  if (last < DRAW_IN_MIN) return `only ${Math.max(0, last)} blocks of the line under open sky before its roof (the hand-over needs ${DRAW_IN_MIN})`;
  // it comes down all the way: what it climbs from the roof's edge on is counted
  let climb = 0;
  for (let i = last + 1; i < n; i++) climb += Math.max(0, points[i]!.y - points[i - 1]!.y);
  if (climb > DRAW_IN_CLIMB) return `the way in climbs ${climb.toFixed(1)} blocks under its roof (a glide comes down all the way; no rocket near a touchdown under a roof)`;
  const speeds = lineSpeeds(points).map((v, i) => Math.min(v, DRAW_IN_END + ((DRAW_IN_OPEN - DRAW_IN_END) * Math.min(DRAW_IN_SLOW, n - 1 - i)) / DRAW_IN_SLOW));
  const p1 = points[Math.min(n - 1, 4)]!;
  const guide: Guide = { path: name, flight: 0, points, ticks: ticksOf(points, speeds), rockets: [], yaw: (Math.atan2(-(p1.x - points[0]!.x), p1.z - points[0]!.z) * 180) / Math.PI, grounded: false, landed: true, drawn: true };
  return { guide, open: guideLength({ points: points.slice(0, last + 1) }), under: guideLength(guide) - last, drop: points[last]!.y - touchdown.y };
}

/**
 * The drawn ways in to a touchdown (feet, the middle of a standable cell by the goal), under the roof up to `top`: the
 * flood's ways from it to the sky, each drawn with the berths of DRAW_BERTHS that give different lines, the flood's
 * cheapest way first and of its lines the widest berth first. `tried` says in a line each what the others failed on;
 * `why` when there is nothing at all. `yieldNow` is awaited between the flood's slices and between the lines (a way in is
 * drawn while the bot flies).
 */
export async function drawEntries(grid: RouteGrid, touchdown: Vec3, top: number, o: { radius?: number; max?: number; exits?: number; apart?: number; yieldNow?: () => Promise<void> } = {}): Promise<{ entries: DrawnEntry[]; cells: number; ways: number; tried: string[]; why?: string }> {
  const g = rememberedGrid(grid, touchdown);
  const steps = floodOutSteps(g, touchdown, top, o);
  let flood: { ways: DrawnWay[]; cells: number };
  for (;;) {
    const r = steps.next();
    if (r.done) {
      flood = r.value;
      break;
    }
    if (o.yieldNow) await o.yieldNow();
  }
  const tried: string[] = [];
  if (!flood.ways.length) return { entries: [], cells: flood.cells, ways: 0, tried, why: `no way under the roof from the goal to the open sky (a flood of ${flood.cells} cells)` };
  const entries: DrawnEntry[] = [];
  const fx = Math.floor(touchdown.x);
  const fy = Math.floor(touchdown.y + 1e-6);
  const fz = Math.floor(touchdown.z);
  for (const way of flood.ways) {
    const seen: string[] = [];
    for (const [berth, beside] of DRAW_BERTHS.flatMap((b) => [[b, true], [b, false]] as const)) {
      if (o.yieldNow) await o.yieldNow();
      const at = `the opening ${way.x - fx} ${way.y - fy} ${way.z - fz} from the touchdown (${way.steps} cells of the flood), a berth of ${berth}${beside ? '' : ' over the floor and under the roof'}`;
      const d = drawEntry(g, touchdown, way, top, berth, beside, `drawn in ${entries.length + 1}`);
      if (typeof d === 'string') {
        tried.push(`${at}: ${d}`);
        continue;
      }
      const sig = d.guide.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`).join(';');
      if (seen.includes(sig)) continue;
      seen.push(sig);
      entries.push({ match: { guide: d.guide, off: 0, open: d.open }, exit: { x: way.x, y: way.y, z: way.z }, steps: way.steps, berth, under: d.under, drop: d.drop, at });
    }
  }
  return { entries, cells: flood.cells, ways: flood.ways.length, tried };
}

/** A drawn way in whose cruise would come to its lead-in's start more than this over it is refused (blocks: three laps of the circle beside it, brain.ts entryHelix, lose about 60). */
export const DRAW_IN_AIM_OVER = 60;
/** Drawn ways in proven at most for one goal (each a whole proof of up to 39 flights, after its own three states). */
export const DRAW_IN_TRIES = 3;

/** What `chooseDrawnEntry` decided: the line, its proof and its touchdown cell when one cleared; the words for the log either way. */
export interface DrawnEntryChoice {
  line?: EntryLine;
  proof?: EntryProof;
  cell?: Vec3;
  entry?: DrawnEntry;
  /** The flood's cells, its ways to the sky, the lines drawn, and what each try said. */
  cells: number;
  ways: number;
  lines: number;
  tried: string[];
  sims: number;
}

/**
 * The drawn way in to a goal (a feet cell): the flood from the first cell of `cells` a body can stand in (learn/entry.ts
 * entryTouchdowns: the goal's own first), its lines in turn, each against the touchdown cells as a recorded take is
 * (`chooseTouchdown`: its own three states first, then the whole proof; the first cell that clears); the first line that
 * clears is the way in. `draw` is the world the line is drawn on, `w` the proof's (its cells are the ones a proof made on
 * the world cache is confirmed by later: the flood's are not among them). `ground` (a column's highest block): a line
 * whose cruise would have to come to it more than DRAW_IN_AIM_OVER over its lead-in's start is refused (entryAim: the
 * ground beside the lead-in sets how low the cruise may be; a cliff beside it leaves no way down onto it). At most
 * DRAW_IN_TRIES whole proofs, and none begun once `spent` says so.
 */
export async function chooseDrawnEntry(w: EntryWorld, draw: RouteGrid, goal: Vec3, cells: readonly Vec3[], top: number, o: { radius?: number; yieldNow?: () => Promise<void>; spent?: () => boolean; stands?: (c: Vec3) => boolean; ground?: (x: number, z: number) => number | undefined; clearance?: number } = {}): Promise<DrawnEntryChoice> {
  const stands = o.stands ?? ((c: Vec3): boolean => draw.solid(c.x, c.y - 1, c.z) && !draw.solid(c.x, c.y, c.z) && !draw.solid(c.x, c.y + 1, c.z));
  const start = cells.find((c) => stands(c));
  if (!start) return { cells: 0, ways: 0, lines: 0, tried: ['no cell a body can stand in within reach of the goal'], sims: 0 };
  const run = o.yieldNow ? { yieldNow: o.yieldNow } : {};
  const d = await drawEntries(draw, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 }, top, { ...(o.radius !== undefined ? { radius: o.radius } : {}), ...run });
  const tried: string[] = [];
  let sims = 0;
  let proofs = 0;
  if (d.why) tried.push(d.why);
  else if (!d.entries.length) tried.push(`no drawn way in (${d.tried.slice(0, 2).join('; ')})`);
  for (const en of d.entries) {
    if (proofs >= DRAW_IN_TRIES) break;
    if (o.spent?.()) {
      tried.push(`${en.match.guide.path}: not tried (the time is up)`);
      break;
    }
    const pick = await chooseTouchdown(w, en.match, goal, cells, run);
    sims += pick.sims;
    if (pick.proofs) proofs++;
    const head = `${en.match.guide.path} (${en.at}; ${en.match.open.toFixed(0)} blocks in the open, ${en.under.toFixed(0)} under the roof coming down ${en.drop.toFixed(0)})`;
    tried.push(`${head}: ${pick.said}${pick.proof ? '' : ': refused'}`);
    if (pick.line && pick.proof && pick.cell) {
      // the cruise's height over the lead-in's start (learn/entry.ts entryAim: its clearance over the ground under the
      // lead-in and beside it): too far over it, there is no way down onto the line
      if (o.ground) {
        const high = entryAim(pick.line, { top: o.ground, ...(o.clearance !== undefined ? { clearance: o.clearance } : {}) }).y - pick.line.guide.points[0]!.y;
        if (high > DRAW_IN_AIM_OVER) {
          tried[tried.length - 1] += `; but the ground beside its lead-in keeps the cruise ${Math.round(high)} over the line's start (a cliff beside it; over ${DRAW_IN_AIM_OVER} there is no way down onto it): refused`;
          continue;
        }
      }
      return { line: pick.line, proof: pick.proof, cell: pick.cell, entry: en, cells: d.cells, ways: d.ways, lines: d.entries.length, tried, sims };
    }
  }
  return { cells: d.cells, ways: d.ways, lines: d.entries.length, tried, sims };
}
