// Track F5b (docs/flight.md "Cave flight (Track F5b)"): a waypoint route as a corridor. `!fly via <wp> ...` and
// `!fly route <prefix>` hand the corridor executor (corridor/executor.ts) a provider whose corridor is the
// owner's waypoints in order: the waypoints are hints, the corridor's windows (stretches.ts nextWindow, the via
// anchors and the bend points between them) are the plan, and everything else is the executor's: the cruise
// where a leg runs under open sky, the windows underground when the cave style is on (`flyCave`), the walk
// where it is off, where a window is too short, or where the flight failed. An optional waypoint (the owner's
// `cave_shortcut`) is taken only when proof.ts `proveShortcut` flies the stretch through it clean on the model
// over the burn's range; otherwise the full route is flown.
import type { Vec3 } from '../../../connection/types.ts';
import { firstAhead } from '../corridor/stretches.ts';
import { corridorOf, volumeOf, type CoarseMode, type Corridor, type CorridorLeg, type CorridorProvider, type PlanRequest, type Portal, type PortalId, type PortalOutcome, type Volume } from '../corridor/coarse-port.ts';

/** A waypoint route's point: a feet cell and its name. */
export interface RoutePoint {
  name: string;
  cell: Vec3;
}

export interface WaypointProviderOptions {
  /** The point is covered (no open sky over it): flown as an underground stretch; false: the cruise. */
  covered: (cell: Vec3) => boolean;
  dim?: number;
  /** A re-plan asked from within this of the last plan's start walks its first segment (the flight failed there). */
  stuck?: number;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const centre = (c: Vec3): Vec3 => ({ x: Math.floor(c.x) + 0.5, y: Math.floor(c.y), z: Math.floor(c.z) + 0.5 });

/** The provider's corridor from the body's position through the points still ahead to the last one. */
export class WaypointProvider implements CorridorProvider {
  readonly requests: PlanRequest[] = [];
  readonly marks: { id: PortalId; mode: CoarseMode; outcome: PortalOutcome }[] = [];
  readonly revision = 1;
  private readonly points: RoutePoint[];
  private readonly o: WaypointProviderOptions;
  private lastStart: Vec3 | undefined;
  private walkFirst = false;

  constructor(points: readonly RoutePoint[], o: WaypointProviderOptions) {
    this.points = points.map((p) => ({ name: p.name, cell: { x: Math.floor(p.cell.x), y: Math.floor(p.cell.y), z: Math.floor(p.cell.z) } }));
    this.o = o;
  }

  plan(req: PlanRequest): Promise<Corridor> {
    this.requests.push(req);
    const stuck = this.lastStart !== undefined && dist(this.lastStart, req.start) <= (this.o.stuck ?? 4);
    this.lastStart = { ...req.start };
    this.walkFirst = stuck;
    const pts = this.points.map((p) => centre(p.cell));
    const k = Math.min(pts.length - 1, firstAhead(pts, req.start));
    const ahead = pts.slice(k);
    const legs: CorridorLeg[] = [];
    let from = { ...req.start };
    let rest = ahead;
    if (stuck && rest.length > 0) {
      // the flight failed from here twice: the first segment is walked, the route goes on from its end
      const to = rest[0]!;
      legs.push(this.leg('walk', from, to, [to]));
      from = to;
      rest = rest.slice(1);
    }
    if (rest.length) legs.push(this.leg('fly', from, rest[rest.length - 1]!, rest));
    return Promise.resolve(corridorOf(legs, { dim: this.o.dim ?? 0 }));
  }

  /** A leg through `via` (its points in order; the last is the leg's end), with a portal at every change between sky and cover. */
  private leg(mode: CoarseMode, from: Vec3, to: Vec3, via: readonly Vec3[]): CorridorLeg {
    const waypoints = [{ ...from }, ...via.slice(0, -1).map((p) => ({ ...p })), { ...to }];
    const portals: Portal[] = [];
    let blocks = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1]!;
      const b = waypoints[i]!;
      blocks += dist(a, b);
      if (this.o.covered(b) !== this.o.covered(a) && (i < waypoints.length - 1 || i > 1)) {
        // the change between a and b: a portal centred on b, across the way in; on the leg's last segment (b is its end,
        // no inner waypoint) on a instead (the entrance point: the cruise lands 2 blocks past it towards b)
        const q = i < waypoints.length - 1 ? b : a;
        const axis = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? 'x' : 'z';
        const x = Math.floor(q.x);
        const z = Math.floor(q.z);
        portals.push({
          id: `wp:${axis}:${x}:${q.y}:${z}`,
          a: this.o.covered(a) ? 'wp:cave' : 'wp:sky',
          b: this.o.covered(b) ? 'wp:cave' : 'wp:sky',
          axis,
          min: axis === 'x' ? { x, y: q.y, z: z - 1 } : { x: x - 1, y: q.y, z },
          max: axis === 'x' ? { x, y: q.y + 2, z: z + 1 } : { x: x + 1, y: q.y + 2, z },
          center: { ...q },
          clearance: { height: 3, width: 3 },
          floorY: q.y,
          known: 'known',
        });
      }
    }
    return { mode, from: { ...from }, to: { ...to }, portals, volumes: [], waypoints, blocks, cost: blocks * (mode === 'walk' ? 4 : 1), unknownFraction: 0, minClearance: { height: 3, width: 3 } };
  }

  markPortal(id: PortalId, mode: CoarseMode, outcome: PortalOutcome): void {
    this.marks.push({ id, mode, outcome });
  }

  volumeAt(p: Vec3, dim?: number): Volume | undefined {
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const under = this.o.covered(c);
    return volumeOf(under ? 'wp:cave' : 'wp:sky', under ? 'cave' : 'sky', { x: c.x - 8, y: c.y - 8, z: c.z - 8 }, { x: c.x + 8, y: c.y + 8, z: c.z + 8 }, { dim: dim ?? this.o.dim ?? 0 });
  }
}

/** The numbered route `<prefix>_start, <prefix>_1 .. <prefix>_N, <prefix>_end` out of the named waypoints (undefined when start or end is missing). */
export function orderedRoute(prefix: string, named: readonly RoutePoint[]): RoutePoint[] | undefined {
  const byName = new Map(named.map((p) => [p.name.toLowerCase(), p]));
  const start = byName.get(`${prefix}_start`.toLowerCase());
  const end = byName.get(`${prefix}_end`.toLowerCase());
  if (!start || !end) return undefined;
  const out = [start];
  for (let i = 1; ; i++) {
    const p = byName.get(`${prefix}_${i}`.toLowerCase());
    if (!p) break;
    out.push(p);
  }
  out.push(end);
  return out;
}

/** The route with the shortcut taken: the points up to the one nearest the shortcut (straight-line), the shortcut, the end. */
export function shortcutRoute(route: readonly RoutePoint[], shortcut: RoutePoint): { points: RoutePoint[]; branch: RoutePoint } {
  let k = 0;
  let bd = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const d = dist(route[i]!.cell, shortcut.cell);
    if (d < bd) {
      bd = d;
      k = i;
    }
  }
  return { points: [...route.slice(0, k + 1), shortcut, route[route.length - 1]!], branch: route[k]! };
}

