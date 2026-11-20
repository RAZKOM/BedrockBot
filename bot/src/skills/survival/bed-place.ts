// A bed set down where the night rule sleeps in it (Track E3, docs/early-game.md "A bed", ADR 0100).
//
// The night process (tasks/process/night.ts) looks for beds within 8 blocks of the shelter or home and at the `bed`
// waypoint. So the bed goes by home when one is set (the bot walks there first), else by the shelter, else next to the
// bot (and the caller sets the `bed` waypoint). A bed is two cells: the foot where the click lands (on the top of the
// block under it) and the head one further in the direction the player faces, so the bot turns to face along the pair
// before the click. The pair's rule, for any world:
//   - the foot one or two cells out from the feet in a cardinal direction, the head one further: both at the feet's
//     height, each empty or under a cover a hand clears (leaf litter, a flower: dug first), never a liquid or anything
//     a click opens;
//   - a full solid top under each that is not a built block (the caller's rule) and no container;
//   - the cell over each free (no `tile.bed.obstructed`), neither cell in the body.
// After the placement both halves are checked (`bed` blocks at the foot and the head). By day the bed is clicked once:
// the server moves the respawn point to it even while it refuses sleep (`tile.bed.noSleep`, docs/survival.md
// "Sleep"); by night the night rule's own click does it.
import { silentLogger, type Logger } from '../../log.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../world/types.ts';
import type { DigResult } from '../dig/digger.ts';
import { EYE_HEIGHT, lookAngles } from '../dig/look.ts';
import type { NavGoal } from '../nav/goals.ts';
import { walkFailWords } from '../nav/reach.ts';
import { isInteractive, REPLACEABLE, type PlaceOptions, type PlaceResult } from '../place/place.ts';
import { clearableCover } from '../craft/table-spot.ts';
import type { GotoOptions, SkillResult } from '../types.ts';
import { isBed } from './sleep.ts';

/** The bed item on Bedrock (its colour follows the wool: metadata). */
export const BED = 'bed';
/** The walk to home or the shelter stops within this many blocks of it. */
export const BED_HOME_REACH = 3;

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface BedSpot {
  foot: Vec3;
  head: Vec3;
  /** Covers dug first (leaf litter, a flower), in the order foot, head. */
  covers: Vec3[];
}

const liquid = (n: string): boolean => n.includes('water') || n.includes('lava');

function free(b: BlockInfo | undefined): boolean {
  return b !== undefined && b.name !== 'unknown' && b.boxes.length === 0 && (b.name === 'air' || REPLACEABLE.has(b.name)) && !liquid(b.name);
}

function fullTop(b: BlockInfo | undefined): boolean {
  if (!b || !b.solid || isInteractive(b.name) || b.name.endsWith('shulker_box')) return false;
  return b.boxes.some((x) => x[0] <= 0 && x[2] <= 0 && x[3] >= 1 && x[5] >= 1 && x[4] >= 1);
}

/** Bed pairs round the feet (the foot one out first, then two out). `built` names blocks a bed may not stand on. */
export function bedSpots(blockAt: (p: Vec3) => BlockInfo | undefined, feet: Vec3, built: (name: string) => boolean = () => false): BedSpot[] {
  const f = { x: Math.floor(feet.x), y: Math.floor(feet.y + 1e-6), z: Math.floor(feet.z) };
  const inBody = (p: Vec3): boolean => feet.x + 0.3 > p.x && feet.x - 0.3 < p.x + 1 && feet.z + 0.3 > p.z && feet.z - 0.3 < p.z + 1;
  const out: { s: BedSpot; d: number }[] = [];
  for (const k of [1, 2]) {
    for (const [dx, dz] of DIRS) {
      const foot = { x: f.x + dx * k, y: f.y, z: f.z + dz * k };
      const head = { x: foot.x + dx, y: f.y, z: foot.z + dz };
      const covers: Vec3[] = [];
      let ok = true;
      for (const c of [foot, head]) {
        const here = blockAt(c);
        if (!free(here)) {
          if (!clearableCover(here)) ok = false;
          else covers.push(c);
        }
        const below = blockAt({ ...c, y: c.y - 1 });
        if (!fullTop(below) || built(below!.name)) ok = false;
        const over = blockAt({ ...c, y: c.y + 1 });
        if (!free(over) && !clearableCover(over)) ok = false;
        if (inBody(c)) ok = false;
        if (!ok) break;
      }
      if (!ok) continue;
      out.push({ s: { foot, head, covers }, d: k + covers.length * 10 });
    }
  }
  return out.sort((a, b) => a.d - b.d).map((o) => o.s);
}

/** Beds carried (main inventory). */
export function bedsCarried(slots: readonly (ItemStack | null | undefined)[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(slots.length, 36); i++) if (slots[i]?.name === BED) n += slots[i]!.count;
  return n;
}

/** Wool a bed takes (of one colour, with 3 planks). */
export const BED_WOOL = 3;

/**
 * Track E3: wild sheep the food hunt keeps for a bed: with no bed known where the bot sleeps and none carried, the
 * wool still short of a bed (of the colour carried most); else none. On a fresh world the day's food hunt took the
 * sheep and `!kill sheep 3` then found none.
 */
export function sheepForBed(slots: readonly (ItemStack | null | undefined)[], bedsKnown: number): number {
  if (bedsKnown > 0 || bedsCarried(slots) > 0) return 0;
  const wool = new Map<string, number>();
  for (let i = 0; i < Math.min(slots.length, 36); i++) {
    const s = slots[i];
    if (s?.name.endsWith('_wool')) wool.set(s.name, (wool.get(s.name) ?? 0) + s.count);
  }
  return Math.max(0, BED_WOOL - Math.max(0, ...wool.values()));
}

export interface BedPlaceDeps {
  world: { blockAt(p: Vec3): BlockInfo | undefined; readonly inventory: { readonly slots: readonly (ItemStack | null)[] } };
  loop: { readonly state: { pos: Vec3; ready: boolean }; setCommand(c: { yaw?: number; pitch?: number }): void; waitTicks(n: number): Promise<void> };
  skills: { place(p: Vec3, opts?: PlaceOptions): Promise<PlaceResult>; dig(p: Vec3): Promise<DigResult>; goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult> };
  /** Where the bed goes: home, else the shelter, else undefined (next to the bot). */
  centre(): Vec3 | undefined;
  /** Beds the night rule already knows (night.beds()): one there is enough. */
  beds(): Vec3[];
  /** Built blocks (terrain/classify.ts isBuiltBlock): a bed is not set on them. */
  built?: (name: string) => boolean;
  log?: Logger;
}

export type BedPlaceReason = 'no_bed_item' | 'walk_failed' | 'no_spot' | 'place_failed' | 'interrupted' | 'not_ready';

export type BedPlaceResult = { ok: true; head: Vec3; foot?: Vec3; walked: boolean; already: boolean } | { ok: false; reason: BedPlaceReason; detail?: string };

const fmt = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;

/** The reply part for a failed placement. */
export function bedReasonText(r: BedPlaceReason, detail?: string): string {
  switch (r) {
    case 'no_bed_item':
      return 'no bed carried (3 wool of one colour and 3 planks make one: !get bed)';
    case 'walk_failed':
      return `the walk there failed${detail ? ` (${detail})` : ''}`;
    case 'no_spot':
      return 'no two free cells in a row next to me for it';
    case 'place_failed':
      return `placing it failed${detail ? ` (${detail})` : ''}`;
    case 'interrupted':
      return 'stopped';
    case 'not_ready':
      return 'not spawned yet';
  }
}

/** The head of the bed whose half is at `p`, or undefined. */
function headAt(blockAt: (p: Vec3) => BlockInfo | undefined, foot: Vec3, head: Vec3): Vec3 | undefined {
  const a = blockAt(foot);
  const b = blockAt(head);
  if (isBed(a) && isBed(b)) return b!.states.head_piece_bit === 1 || b!.states.head_piece_bit === true ? head : foot;
  return undefined;
}

/**
 * Set a carried bed down where the night rule finds it: done at once when a bed is known there; with a centre (home or
 * the shelter), walk within BED_HOME_REACH first; then the first pair `bedSpots` allows, the bot facing along it.
 */
export async function placeBed(d: BedPlaceDeps, cancelled: () => boolean): Promise<BedPlaceResult> {
  const log = d.log ?? silentLogger;
  if (!d.loop.state.ready) return { ok: false, reason: 'not_ready' };
  const there = d.beds()[0];
  if (there) return { ok: true, head: there, walked: false, already: true };
  if (bedsCarried(d.world.inventory.slots) === 0) return { ok: false, reason: 'no_bed_item' };
  let walked = false;
  const c = d.centre();
  if (c) {
    const me = d.loop.state.pos;
    const far = Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z);
    if (far > BED_HOME_REACH + 0.5) {
      const w = await d.skills.goto({ type: 'near', p: c, r: BED_HOME_REACH }, { timeoutTicks: Math.max(600, Math.ceil(far * 20)), explain: true }); // Track E9: a refused walk says why
      if (cancelled()) return { ok: false, reason: 'interrupted' };
      if (!w.ok) return { ok: false, reason: 'walk_failed', detail: walkFailWords(w) };
      walked = true;
    }
  }
  const blockAt = (q: Vec3): BlockInfo | undefined => d.world.blockAt(q);
  const spots = bedSpots(blockAt, d.loop.state.pos, d.built);
  if (spots.length === 0) return { ok: false, reason: 'no_spot' };
  let last: string | undefined;
  next: for (const s of spots.slice(0, 4)) {
    if (cancelled()) return { ok: false, reason: 'interrupted' };
    for (const p of s.covers) {
      const g = await d.skills.dig(p);
      if (cancelled()) return { ok: false, reason: 'interrupted' };
      if (!g.ok || !free(d.world.blockAt(p))) {
        log.info(`bed: clearing ${d.world.blockAt(p)?.name ?? 'a cover'} at ${fmt(p)}: ${g.ok ? 'still there' : (g.reason ?? 'failed')}`);
        continue next;
      }
    }
    // face along the pair (the head lies the way the player faces), looking down at the foot's support
    const me = d.loop.state.pos;
    const eye = { x: me.x, y: me.y + EYE_HEIGHT, z: me.z };
    const yaw = lookAngles(eye, { x: s.head.x + 0.5, y: eye.y, z: s.head.z + 0.5 }).yaw;
    const pitch = lookAngles(eye, { x: s.foot.x + 0.5, y: s.foot.y, z: s.foot.z + 0.5 }).pitch;
    d.loop.setCommand({ yaw, pitch });
    await d.loop.waitTicks(2);
    if (cancelled()) return { ok: false, reason: 'interrupted' };
    const r = await d.skills.place(s.foot, { face: 'up', item: BED, look: false, jump: false });
    if (cancelled()) return { ok: false, reason: 'interrupted' };
    await d.loop.waitTicks(2);
    const head = headAt(blockAt, s.foot, s.head);
    if (head) {
      log.info(`bed: placed at ${fmt(s.foot)} (head ${fmt(head)})${walked ? ' (walked there first)' : ''}`);
      return { ok: true, head, foot: s.foot, walked, already: false };
    }
    last = r.ok ? `only ${d.world.blockAt(s.foot)?.name ?? 'unknown'} at the foot and ${d.world.blockAt(s.head)?.name ?? 'unknown'} at the head` : (r.reason ?? 'failed');
    log.info(`bed: place at ${fmt(s.foot)}: ${last}`);
    if (r.reason === 'interrupted') return { ok: false, reason: 'interrupted' };
  }
  return { ok: false, reason: 'place_failed', ...(last ? { detail: last } : {}) };
}
