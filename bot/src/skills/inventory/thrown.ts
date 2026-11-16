// Track V1 follow-up 3 (ADR 0090 decision 13, docs/inventory.md "A drop stays dropped"): what the bot throws away
// stays on the ground.
//
// On the Realm (2026-11-16) the room chore dropped 434 cobblestone at its feet three times in 12 s: the bot stood still,
// the stacks lay in its pickup reach and the server handed them back once their pickup delay (about 2 s) ran out. A
// collect after a fight (`collect r=8`) walks to every item in reach, the bot's own throwaways too. Bedrock picks items
// up on the server side when the player's box (grown by about 1 block sideways) touches them, so the body cannot refuse
// a pickup it stands in. Two rules:
//
//   1. the collector skips the item actors the bot threw itself (`ThrownItems`): every drop request the keeper sends
//      (`!drop`, the room chore's junk and stone, the stash step's filler, the keeper's junk at 36 of 36) is announced
//      first; an add_item_entity of that item spawned at the bot's body within THROWN_MATCH_MS is the throw, and its
//      runtime id is skipped by every collect for THROWN_KEEP_MS (the despawn time of an item). Matched by entity id, so
//      a zombie's rotten flesh dropped next to the bot's own is still picked up;
//   2. the body (`throwAway`, the room chore's junk and stone steps): it faces a free direction (no block within 3 cells
//      at the feet and the head, so the throw does not bounce back), looks a little up, drops, and walks out of reach of
//      what it threw (at least THROW_AWAY_R blocks) before the pickup delay ends.
import type { EntityInfo, Vec3 } from '../../world/types.ts';
import type { NavGoal } from '../nav/goals.ts';
import type { GotoOptions, SkillResult } from '../types.ts';

/** A thrown item actor is skipped by the collector this long (ms): an item on the ground despawns after 5 minutes. */
export const THROWN_KEEP_MS = 5 * 60_000;
/** An add_item_entity this soon after the drop request is matched to it (ms). */
export const THROWN_MATCH_MS = 2_000;
/** A thrown item spawns at the thrower's body: at most this far from the feet sideways (blocks). */
export const THROWN_SPAWN_H = 1.5;
/** ... and between these heights above the feet (the eye is at 1.62). */
export const THROWN_SPAWN_Y: readonly [number, number] = [-0.5, 2.5];
/** The body walks this far from what it threw (blocks; the pickup box reaches about 1.3 from the body's centre). */
export const THROW_AWAY_R = 4;
/** Thrown items nearer than this after the drop send the body away (blocks, sideways). */
export const THROW_CLEAR_R = 3;

interface Pending {
  name: string;
  left: number;
  at: number;
  feet: Vec3 | undefined;
}

/** The item actors the bot threw itself (one per bot, registered under its inventory model: `thrownFor`). */
export class ThrownItems {
  private readonly pending: Pending[] = [];
  private readonly ids = new Map<bigint, { name: string; count: number; until: number }>();
  private readonly now: () => number;
  private readonly position: () => Vec3 | undefined;
  readonly stats = { expected: 0, matched: 0 };

  constructor(o: { position: () => Vec3 | undefined; now?: () => number }) {
    this.position = o.position;
    this.now = o.now ?? (() => Date.now());
  }

  /** A drop request for `count` of `name` goes out now (announced before it is sent: the item actor may come first). */
  expect(name: string, count: number): void {
    const t = this.now();
    this.trim(t);
    this.pending.push({ name: bare(name), left: count, at: t, feet: this.position() });
    this.stats.expected++;
  }

  /** An entity was added (EntityTracker.onAdd): the bot's own throw when it matches an announced drop. */
  added(e: EntityInfo): void {
    if (e.type !== 'minecraft:item' || !e.item) return;
    const t = this.now();
    this.trim(t);
    const name = bare(e.item.name);
    const p = this.pending.find((x) => x.name === name && x.left > 0 && spawnedAt(e.pos, x.feet));
    if (!p) return;
    p.left -= e.item.count;
    this.ids.set(e.runtimeId, { name, count: e.item.count, until: t + THROWN_KEEP_MS });
    this.stats.matched++;
  }

  /** Did the bot throw this item actor (within THROWN_KEEP_MS)? */
  has(runtimeId: bigint): boolean {
    const x = this.ids.get(runtimeId);
    if (!x) return false;
    if (x.until > this.now()) return true;
    this.ids.delete(runtimeId);
    return false;
  }

  /** The runtime ids thrown and still remembered. */
  list(): bigint[] {
    this.trim(this.now());
    return [...this.ids.keys()];
  }

  private trim(t: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) if (t - this.pending[i]!.at > THROWN_MATCH_MS || this.pending[i]!.left <= 0) this.pending.splice(i, 1);
    for (const [id, x] of this.ids) if (x.until <= t) this.ids.delete(id);
    while (this.ids.size > 512) this.ids.delete(this.ids.keys().next().value!);
  }
}

const bare = (n: string): string => (n.startsWith('minecraft:') ? n.slice(10) : n);

/** An item actor at `p` spawned at the body standing at `feet` (unknown feet: yes). */
function spawnedAt(p: Vec3, feet: Vec3 | undefined): boolean {
  if (!feet) return true;
  const dy = p.y - feet.y;
  return Math.hypot(p.x - feet.x, p.z - feet.z) <= THROWN_SPAWN_H && dy >= THROWN_SPAWN_Y[0] && dy <= THROWN_SPAWN_Y[1];
}

const registry = new WeakMap<object, ThrownItems>();

/** The survival kit registers (or, at dispose, removes) the bot's ThrownItems under its inventory model. */
export function setThrown(inventory: object, t: ThrownItems | undefined): void {
  if (t) registry.set(inventory, t);
  else registry.delete(inventory);
}

/** The bot's ThrownItems for `inventory`, if a survival kit runs on it. */
export function thrownFor(inventory: object | undefined): ThrownItems | undefined {
  return inventory ? registry.get(inventory) : undefined;
}

/** The 8 directions on the ground, the axes first. */
const DIRS: readonly { x: number; z: number }[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
  { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
  { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
];

/**
 * A direction to throw in from `feet`: no block (and nothing unloaded) within 3 cells at the feet and the head, so the
 * items fly away and do not bounce back; one whose opposite is free too first (the body steps back that way).
 */
export function throwDirection(solidAt: (p: Vec3) => boolean | undefined, feet: Vec3): { x: number; z: number } | undefined {
  const fy = Math.floor(feet.y + 1e-6);
  const free = (d: { x: number; z: number }, n: number): boolean => {
    for (let k = 1; k <= n; k++)
      for (const dy of [0, 1]) {
        const s = solidAt({ x: Math.floor(feet.x + d.x * k), y: fy + dy, z: Math.floor(feet.z + d.z * k) });
        if (s !== false) return false;
      }
    return true;
  };
  const open = DIRS.filter((d) => free(d, 3));
  return open.find((d) => free({ x: -d.x, z: -d.z }, 2)) ?? open[0];
}

export interface ThrowAwayDeps {
  /** The feet. */
  position(): Vec3 | undefined;
  /** A block with a collision box at `p` (undefined: not loaded). */
  solidAt(p: Vec3): boolean | undefined;
  lookAt(p: Vec3): Promise<void>;
  waitTicks(n: number): Promise<void>;
  /** The drop itself (SurvivalKit.drop through the keeper, which announces it to ThrownItems). */
  drop(): Promise<{ ok: boolean; dropped: number; reason?: string }>;
  thrown(): ThrownItems | undefined;
  entities(): ReadonlyMap<bigint, EntityInfo>;
  goto(goal: NavGoal, opts?: GotoOptions): Promise<SkillResult>;
}

export interface ThrowAwayResult {
  ok: boolean;
  dropped: number;
  reason?: string;
  /** The walk out of reach: 'ok', why it failed, or undefined when none was needed. */
  away?: string;
  /** Thrown item actors seen. */
  seen: number;
}

/** Face a free direction, drop, and walk out of reach of what was thrown (see the file comment). */
export async function throwAway(d: ThrowAwayDeps): Promise<ThrowAwayResult> {
  const feet = d.position();
  const dir = feet ? throwDirection((p) => d.solidAt(p), feet) : undefined;
  if (feet && dir) {
    // a little above the eye, 4 blocks out: the throw carries further than looking straight ahead
    await d.lookAt({ x: feet.x + dir.x * 4, y: feet.y + 1.62 + 1.2, z: feet.z + dir.z * 4 });
    await d.waitTicks(2); // the new look goes out with the next input, before the drop request
  }
  const known = new Set(d.thrown()?.list() ?? []);
  const r = await d.drop();
  const out: ThrowAwayResult = { ok: r.ok, dropped: r.dropped, ...(r.reason ? { reason: r.reason } : {}), seen: 0 };
  if (r.dropped <= 0) return out;
  const mine = (): EntityInfo[] => {
    const ids = d.thrown()?.list() ?? [];
    const ents = d.entities();
    return ids.filter((id) => !known.has(id)).flatMap((id) => (ents.has(id) ? [ents.get(id)!] : []));
  };
  for (let i = 0; i < 10 && mine().length === 0; i++) await d.waitTicks(1);
  // the items land in a few ticks; their pickup delay is about 2 s
  await d.waitTicks(6);
  const items = mine();
  out.seen = items.length;
  const at = d.position();
  if (!at || items.length === 0) return out;
  if (!items.some((e) => Math.hypot(e.pos.x - at.x, e.pos.z - at.z) < THROW_CLEAR_R)) return out;
  const from = (): Vec3[] => mine().map((e) => e.pos);
  const g = await d.goto({ type: 'runAway', from: () => from(), r: THROW_AWAY_R }, { timeoutTicks: 120 });
  out.away = g.ok ? 'ok' : (g.reason ?? 'failed');
  return out;
}
