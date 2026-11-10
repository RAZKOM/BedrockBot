// Track F9b (docs/flight.md "Learned exits (Track F9b)"; decisions/0078-learned-exits.md): which recorded flights are
// of use where the bot stands. A flight is matched by its geometry alone, never by the recording's name:
//
//   - an EXIT: the flight left the ground within MATCH_NEAR of the body and its line comes out under open sky (the
//     way out of a cave from where the body stands);
//   - an ENTRY: the flight stood again within MATCH_NEAR of a goal that has a roof over it and came from under open
//     sky (the way in to a place underground; built here for the next track, not flown yet).
//
// Several takes of one line are several matches, the one that begins (or ends) nearest first. What a match is worth
// is decided by its proof, not here (the takeoff tries a line that itself grazes a block after the others:
// route/takeoff.ts planTakeoffRoute).
import type { Vec3 } from '../../../connection/types.ts';
import { guideHead, guideLength, guidesOf, guideTail, GUIDE_STEP, type Guide } from './guide.ts';
import type { LearnedPath } from './recorder.ts';

/** A flight matches when it left the ground (an entry: stood again) within this of the place, horizontally and in height. */
export const MATCH_NEAR = 4;
export const MATCH_UP = 3;
/** The line counts as out under open sky where this many points in a row have nothing over them. */
export const OPEN_POINTS = 4;
/** An exit's line is kept this far past its first point under open sky (blocks): the hand-over to the climb needs air ahead. */
export const OUT_AFTER = 16;
/** An entry's line is kept from this far before its last point under open sky (blocks): the approach has to line up on it. */
export const IN_BEFORE = 24;

/** Nothing solid over the cell of (x, y, z) up to the height the caller flies at (an unknown cell is a roof). */
export type OpenSky = (x: number, y: number, z: number) => boolean;

export interface GuideMatch {
  /** The line to fly: an exit's from the takeoff to OUT_AFTER past its first open sky, an entry's from IN_BEFORE before its last open sky to the touchdown. */
  guide: Guide;
  /** How far the flight's takeoff (an entry: its touchdown) lies from the place asked about (blocks). */
  off: number;
  /** Blocks along `guide` to its first point under open sky (an exit), or to its last (an entry). */
  open: number;
}

export interface MatchOptions {
  near?: number;
  up?: number;
  after?: number;
  before?: number;
}

const near = (p: Vec3, q: Vec3, o: MatchOptions): number | undefined => {
  const h = Math.hypot(p.x - q.x, p.z - q.z);
  return h <= (o.near ?? MATCH_NEAR) && Math.abs(p.y - q.y) <= (o.up ?? MATCH_UP) ? Math.hypot(h, p.y - q.y) : undefined;
};

/** The index of the first point from which OPEN_POINTS points in a row are under open sky (searching forwards from `from`), or -1. */
function firstOpen(g: Guide, sky: OpenSky, from = 0): number {
  let run = 0;
  for (let i = from; i < g.points.length; i++) {
    const p = g.points[i]!;
    run = sky(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) ? run + 1 : 0;
    if (run >= OPEN_POINTS) return i - OPEN_POINTS + 1;
  }
  return -1;
}

/**
 * The recorded flights that are a way OUT from `from` (feet): they left the ground within MATCH_NEAR of it (MATCH_UP in
 * height), began under a roof and come out under open sky. Each as its line up to OUT_AFTER past the first open sky, the
 * nearest takeoff first. `flights` counts every flight of the recordings, `near` those that left the ground here.
 */
export function matchExits(paths: readonly LearnedPath[], from: Vec3, sky: OpenSky, o: MatchOptions = {}): { matches: GuideMatch[]; flights: number; near: number } {
  const matches: GuideMatch[] = [];
  let flights = 0;
  let here = 0;
  for (const p of paths) {
    for (const g of guidesOf(p)) {
      flights++;
      if (!g.grounded) continue;
      const off = near(g.points[0]!, from, o);
      if (off === undefined) continue;
      here++;
      const out = firstOpen(g, sky);
      // (a flight that begins under open sky is no way out of anything: the ordinary takeoff's business)
      if (out <= 0) continue;
      const head = guideHead(g, out + Math.round((o.after ?? OUT_AFTER) / GUIDE_STEP) + 1);
      matches.push({ guide: head, off, open: out * GUIDE_STEP });
    }
  }
  matches.sort((a, b) => a.off - b.off);
  return { matches, flights, near: here };
}

/**
 * The recorded flights that are a way IN to `to` (feet, a place with a roof over it): they stood again within MATCH_NEAR
 * of it and came from under open sky. Each as its line from IN_BEFORE before the last open sky to the touchdown, the
 * nearest touchdown first. (For the track that flies the way in: nothing in the bot asks yet.)
 */
export function matchEntries(paths: readonly LearnedPath[], to: Vec3, sky: OpenSky, o: MatchOptions = {}): { matches: GuideMatch[]; flights: number; near: number } {
  const matches: GuideMatch[] = [];
  let flights = 0;
  let here = 0;
  for (const p of paths) {
    for (const g of guidesOf(p)) {
      flights++;
      if (!g.landed) continue;
      const end = g.points[g.points.length - 1]!;
      const off = near(end, to, o);
      if (off === undefined) continue;
      here++;
      if (sky(Math.floor(end.x), Math.floor(end.y), Math.floor(end.z))) continue; // a landing in the open needs no way in
      // the last point under open sky before the roof the flight ends under
      let last = -1;
      for (let i = g.points.length - 1; i >= 0; i--) {
        const q = g.points[i]!;
        if (sky(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z))) {
          last = i;
          break;
        }
      }
      if (last < 0) continue;
      const cut = Math.max(0, last - Math.round((o.before ?? IN_BEFORE) / GUIDE_STEP));
      const tail = guideTail(g, cut);
      matches.push({ guide: tail, off, open: guideLength({ points: tail.points.slice(0, last - cut + 1) }) });
    }
  }
  matches.sort((a, b) => a.off - b.off);
  return { matches, flights, near: here };
}
