// Track E10 (docs/early-game.md "Sheep for the bed", ADR 0112): a hunt for a job's material that found none within 32 and
// had no remembered herd left to walk to looks further, by day, in the shape of Track E8's water search: legs
// HUNT_SEARCH_OUT out from where the search starts along x and z, HUNT_SEARCH_STEP at a time, the mobs the server sent
// looked at after each step (it sends those round the bot as it goes), at most HUNT_SEARCH_MS. The first one of the kind
// seen ends the search: the job walks to it and hunts again. Measured round a fresh plains world's spawn (a spectator over a
// 64-block grid): sheep stand alone or in twos; within 32 of where a kit ended 0 to 3, within 128 of it 6, while the
// server sends a player the mobs within about 64 to 80 only: a look of 32 and two walks to remembered marks found none
// in 3 of 10 runs. (A desert had none within 256: the search ends and says how far it looked.)
// The steps are the job's own `!goto` steps: dusk ends them like any walk (`jobDusk`), and the flights count.
import { searchLegs } from '../skills/farm/water.ts';
import { entityFeet } from '../skills/combat/hostiles.ts';
import type { EntityInfo, Vec3 } from '../world/types.ts';

/** The legs go this far out (x, z) from where the search starts. */
export const HUNT_SEARCH_OUT = 96;
/** A look after each step of this length. */
export const HUNT_SEARCH_STEP = 32;
/** The search walks at most this long (ms), the walk to a mob seen not counted. */
export const HUNT_SEARCH_MS = 300_000;
/** A mob seen this close needs no walk first: the hunt's own look (32) takes it. */
export const HUNT_SEEN_NEAR = 24;

/** The search's step points from `from`, leg by leg (Track E8's legs: +x, +z, -x, -z). */
export function huntLegs(from: Vec3): Vec3[][] {
  const c = { x: Math.floor(from.x), y: Math.floor(from.y) - 1, z: Math.floor(from.z) };
  return searchLegs(c, HUNT_SEARCH_OUT, HUNT_SEARCH_STEP);
}

/** The highest cell at (x, z) a body stands in (two open cells over a solid one), near `y`; undefined: none known. */
export function standAt(solid: (x: number, y: number, z: number) => boolean | undefined, x: number, z: number, y: number, span = 40): number | undefined {
  for (let yy = Math.round(y) + span; yy >= Math.round(y) - span; yy--) {
    const below = solid(x, yy - 1, z);
    if (below === undefined) continue;
    if (below && solid(x, yy, z) === false && solid(x, yy + 1, z) === false) return yy;
  }
  return undefined;
}

/** What the search needs from the job (commands-kit.ts ObtainController.search). */
export interface SearchPorts {
  position(): Vec3 | undefined;
  /** The nearest mob of the kind the server has sent, if any. */
  seen(): Vec3 | undefined;
  standY(x: number, z: number, near: number): number | undefined;
  /** One `!goto` step of the job. */
  walk(p: Vec3): Promise<void>;
  /** Dusk ended the last step (read and cleared). */
  cut(): boolean;
  /** The owner stopped the job, or the bot died. */
  stopped(): boolean;
  now(): number;
}

export interface SearchResult {
  /** One seen and walked to: hunt again. */
  found: boolean;
  /** Dusk cut the walk. */
  cut: boolean;
  /** The end line's note (`looked for sheep: ...`); none when cut or stopped. */
  note?: string;
}

/**
 * The search walk: the legs from where the bot stands, a look before each step, the first mob seen walked to when it is
 * more than HUNT_SEEN_NEAR off; a step that moves less than a quarter of HUNT_SEARCH_STEP gives the leg up (water, a
 * cliff); at most HUNT_SEARCH_MS.
 */
export async function huntSearch(p: SearchPorts, mob: string): Promise<SearchResult> {
  const from = p.position();
  if (!from) return { found: false, cut: false };
  const t0 = p.now();
  let walked = 0;
  const d2 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
  const walk = async (to: Vec3): Promise<number> => {
    const was = p.position() ?? from;
    await p.walk(to);
    const now = p.position() ?? was;
    walked += d2(was, now);
    return d2(was, now);
  };
  const found = async (s: Vec3): Promise<SearchResult> => {
    const note = searchNote(mob, walked, p.now() - t0, d2(s, from));
    if (d2(s, p.position() ?? from) > HUNT_SEEN_NEAR) await walk({ x: s.x, y: Math.floor(s.y), z: s.z });
    p.cut(); // a walk to it cut by dusk: the hunt after the night finds it or searches again
    return { found: true, cut: false, note };
  };
  for (const leg of huntLegs(from)) {
    for (const at of leg) {
      if (p.stopped()) return { found: false, cut: false };
      if (p.now() - t0 > HUNT_SEARCH_MS) break;
      const s = p.seen();
      if (s) return found(s);
      const y = p.standY(at.x, at.z, (p.position() ?? from).y) ?? Math.round((p.position() ?? from).y);
      const moved = await walk({ x: at.x, y, z: at.z });
      if (p.cut()) return { found: false, cut: true };
      if (moved < HUNT_SEARCH_STEP / 4) break;
    }
  }
  const s = p.seen();
  if (s && !p.stopped()) return found(s);
  return { found: false, cut: false, note: searchNote(mob, walked, p.now() - t0, undefined) };
}

/** `looked for sheep: walked 412 along the axes in 240 s, none seen` / `... seen 71 off` */
export function searchNote(mob: string, walked: number, ms: number, seen: number | undefined): string {
  return `looked for ${mob}: walked ${Math.round(walked)} along the axes in ${Math.round(ms / 1000)} s, ${seen === undefined ? 'none seen' : `one seen ${Math.round(seen)} off`}`;
}

/** The bot's side of the search's ports (wired in commands-kit.ts). */
export interface SearchSource {
  position(): Vec3 | undefined;
  entities(): Iterable<EntityInfo>;
  dead(runtimeId: EntityInfo['runtimeId']): boolean;
  /** Solid for standing on (undefined: not loaded). */
  solid(x: number, y: number, z: number): boolean | undefined;
}

/** `seen` and `standY` of the obtain host: the nearest mob of a kind (x, z) and a standing cell near a height. */
export function searchPorts(src: SearchSource): { seen(kind: string): Vec3 | undefined; standY(x: number, z: number, near: number): number | undefined } {
  return {
    seen: (kind) => {
      const at = src.position();
      if (!at) return undefined;
      let best: Vec3 | undefined;
      let bd = Infinity;
      for (const e of src.entities()) {
        if (e.type.replace(/^minecraft:/, '') !== kind || src.dead(e.runtimeId)) continue;
        const p = entityFeet(e);
        const d = Math.hypot(p.x - at.x, p.z - at.z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    },
    standY: (x, z, near) => standAt((xx, yy, zz) => src.solid(xx, yy, zz), x, z, near),
  };
}