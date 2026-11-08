// Track F5b (docs/flight.md "Cave flight (Track F5b)"): the proof an optional waypoint (the owner's `cave_shortcut`)
// is clean. The stretch through it is cut into the cave style's windows and every window is FLOWN on the model
// (cave/bench.ts flyWindow: the chain of trackers on stepBody, the planner at a generous budget) with the burn at
// its nominal, its shortest and its longest: proven when every flight lands where it was meant to, touches
// nothing and keeps the bore's margin from every solid. A plan alone was no proof: the search from standing to a
// landing 31 blocks on in a clean 3 x 3 bore came back partial at 4 s, while the chain flies it every time.
// The live command runs the proof in a worker (`proveShortcutInWorker`, this file as the Worker over a snapshot
// of the route grid) so the input loop never waits for it.
import { isMainThread, parentPort, Worker, workerData, type MessagePort } from 'node:worker_threads';
import type { Vec3 } from '../../../connection/types.ts';
import { windowRequest } from '../corridor/drive.ts';
import { boreMargin, nextWindow, type Stretch, type Window } from '../corridor/stretches.ts';
import type { RouteGrid } from '../route/grid.ts';
import { planRoute } from '../route/search.ts';
import { gridOfSnapshot, snapshotGrid, SNAPSHOT_MAX, type GridSnapshot } from '../route/worker.ts';
import { BURN } from '../route/types.ts';
import { flyWindow, type WindowRun } from './bench.ts';
import { CAVE_STYLE, caveStretchOptions, type CaveStyle } from './style.ts';

/** The burns a window is proven over: the nominal, the shortest and the longest (F0's range). */
export const PROOF_BURNS: readonly number[] = [BURN.nominal, BURN.min, BURN.max];
/** The search budget per request in a proof flight (generous: it runs once, before the flight, off the loop). */
export const PROOF_PLAN_MS = 2000;
export const PROOF_PLAN_NODES = 80_000;
/** The blocks round the points the proof's snapshot covers. */
export const PROOF_PAD = 32;
/** A proof flight that stopped and came down within this of its landing (blocks) is clean: the rest is walked. */
export const SHORT_OK = 8;

export interface ShortcutProof {
  proven: boolean;
  windows: number;
  /** Per window and burn: the flight's end, goals, hits, clearance, ticks, rockets. */
  lines: string[];
  reason?: string;
}

export interface ProofOptions {
  style?: Readonly<CaveStyle>;
  burns?: readonly number[];
  maxMs?: number;
  maxNodes?: number;
}

const centre = (c: Vec3): Vec3 => ({ x: Math.floor(c.x) + 0.5, y: Math.floor(c.y), z: Math.floor(c.z) + 0.5 });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Prove the stretch through `points` (feet cells: the branch waypoint, the optional one, the end) clean on `grid`
 * (unknown cells solid): the windows laid out as the style flies them, each flown over PROOF_BURNS from standing.
 */
export async function proveShortcut(grid: RouteGrid, points: readonly Vec3[], o: ProofOptions = {}): Promise<ShortcutProof> {
  const style = o.style ?? CAVE_STYLE;
  const solid = (x: number, y: number, z: number): boolean => grid.solid(x, y, z);
  const world = { solidAt: solid };
  const pts = points.map(centre);
  const stretch: Stretch = { space: 'under', points: pts, portals: [], end: pts[pts.length - 1]! };
  const endCell = { x: Math.floor(stretch.end.x), y: Math.floor(stretch.end.y), z: Math.floor(stretch.end.z) };
  const lines: string[] = [];
  let from = pts[0]!;
  let n = 0;
  for (let guard = 0; guard < 16; guard++) {
    if (dist(from, stretch.end) < 1.5) break;
    const win: Window | undefined = nextWindow(stretch, from, { loaded: () => true, solid, endCell, maxBlocks: style.windowBlocks, tailMin: 0, landReach: style.landReach });
    if (!win) return { proven: false, windows: n, lines, reason: `no window could be laid out from ${from.x.toFixed(0)} ${from.y.toFixed(0)} ${from.z.toFixed(0)} (no floor known)` };
    n++;
    const margin = Math.max(win.margin, boreMargin(win.width, win.height));
    // Track F6: the window is proven from standing first, as the executor proves it before a takeoff (the plan in pieces at
    // the style's budget); the flights then fly that plan over the burns. Before, every proof flight planned in the air
    // (plans 40 ticks late at 2 s) and the owner's shortcut was never proven although its plan exists
    const req = windowRequest(win, from, 16, { ...caveStretchOptions(win, style), maxMs: o.maxMs ?? style.proveMs, maxNodes: o.maxNodes ?? style.proveNodes });
    const plan = planRoute(req, grid);
    lines.push(`window ${n} (${Math.round(win.blocks)} blocks, ${win.goals.length} goals, margin ${margin.toFixed(2)}): the plan from standing ${plan.complete ? 'complete' : `partial (${plan.why ?? '?'})`} ${plan.reached}/${win.goals.length}, ${plan.ticks} ticks, ${plan.rockets} rockets, clearance ${plan.clearance.toFixed(2)}${plan.robust ? '' : ', not robust'}, ${plan.expanded} expanded in ${plan.ms.toFixed(0)} ms`);
    // (as the executor proves a window: complete, robust to the burn when the style asks, clear of the walls; a plan that is
    // not robust flew into the floor of a clean 3 x 3 bore at burn 9 when flown as the first plan)
    const robustOk = plan.robust || !style.proveRobust;
    if (!plan.complete || !robustOk || plan.clearance < style.proveClearMin) return { proven: false, windows: n, lines, reason: `window ${n}: ${!plan.complete ? `no complete plan from standing (${plan.reached}/${win.goals.length} goals)` : !robustOk ? 'the plan from standing is not robust to the burn' : `the plan keeps only ${plan.clearance.toFixed(2)} from a solid`}` };
    for (const burn of o.burns ?? PROOF_BURNS) {
      const r: WindowRun = await flyWindow(world, from, win.goals, margin, { burn, maxMs: o.maxMs ?? PROOF_PLAN_MS, maxNodes: o.maxNodes ?? PROOF_PLAN_NODES, style: true, variant: style }, undefined, plan, undefined, win.height);
      // clean: on the landing, or stopped and sunk onto the floor within SHORT_OK of it (a bail-out before the landing is the
      // style's own stop: the rest is walked), touching nothing and keeping the margin in the air
      const short = Math.hypot(r.at.x - (win.end.x + 0.5), r.at.z - (win.end.z + 0.5));
      const landed = r.end === 'done' || (r.end === 'ground' && short <= SHORT_OK);
      const ok = landed && r.hits === 0 && r.minClearance >= margin;
      lines.push(`window ${n} (${Math.round(win.blocks)} blocks, ${win.goals.length} goals, margin ${margin.toFixed(2)}), burn ${burn}: ${r.end} ${r.reached}/${r.goals}${r.end !== 'done' ? ` ${short.toFixed(1)} from the landing` : ''}, ${r.hits} hits, clearance ${r.minClearance.toFixed(2)}, ${r.ticks} ticks, ${r.rockets} rockets, ${r.plans} plans (${r.partial} partial)${r.bailed ? ', bailed out (stopped and sank)' : ''}`);
      if (!ok) return { proven: false, windows: n, lines, reason: `window ${n} at burn ${burn}: ${!landed ? `ended ${r.end} ${r.reached}/${r.goals}, ${short.toFixed(1)} from the landing${r.bailed ? ' (bailed out)' : ''}` : r.hits ? `${r.hits} hits` : `clearance ${r.minClearance.toFixed(2)} under ${margin.toFixed(2)}`}` };
    }
    from = { x: win.end.x + 0.5, y: win.end.y, z: win.end.z + 0.5 };
  }
  return { proven: true, windows: n, lines };
}

interface ProofMessage {
  points: Vec3[];
  snap: GridSnapshot;
  o: Omit<ProofOptions, 'style'> & { style?: CaveStyle };
}

/** The proof off the main thread: a snapshot of `grid` round the points (at most SNAPSHOT_MAX a side; a longer stretch is refused) flown in a Worker. */
export function proveShortcutInWorker(grid: RouteGrid, points: readonly Vec3[], o: ProofOptions = {}): Promise<ShortcutProof> {
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    lo.x = Math.min(lo.x, p.x);
    lo.y = Math.min(lo.y, p.y);
    lo.z = Math.min(lo.z, p.z);
    hi.x = Math.max(hi.x, p.x);
    hi.y = Math.max(hi.y, p.y);
    hi.z = Math.max(hi.z, p.z);
  }
  const min = { x: Math.floor(lo.x - PROOF_PAD), y: Math.floor(lo.y - PROOF_PAD), z: Math.floor(lo.z - PROOF_PAD) };
  const size = { x: Math.ceil(hi.x + PROOF_PAD) - min.x + 1, y: Math.ceil(hi.y + PROOF_PAD) - min.y + 1, z: Math.ceil(hi.z + PROOF_PAD) - min.z + 1 };
  if (Math.max(size.x, size.y, size.z) > SNAPSHOT_MAX) return Promise.resolve({ proven: false, windows: 0, lines: [], reason: `the stretch spans more than ${SNAPSHOT_MAX} blocks: too long for one proof` });
  const snap = snapshotGrid(grid, min, size);
  return new Promise<ShortcutProof>((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { bedrockbotProof: true }, name: 'cave-proof' });
    w.once('message', (m: ShortcutProof) => {
      resolve(m);
      void w.terminate();
    });
    w.once('error', (e: Error) => reject(e));
    const m: ProofMessage = { points: points.map((p) => ({ ...p })), snap, o: { ...o, ...(o.style ? { style: { ...o.style, rules: { ...o.style.rules } } } : {}) } };
    w.postMessage(m, [snap.data.buffer as ArrayBuffer]);
  });
}

/** The worker side. */
export function runProofWorker(port: MessagePort): void {
  port.once('message', (m: ProofMessage) => {
    proveShortcut(gridOfSnapshot(m.snap), m.points, m.o).then(
      (p) => port.postMessage(p),
      (e: unknown) => {
        const a: ShortcutProof = { proven: false, windows: 0, lines: [], reason: e instanceof Error ? e.message : String(e) };
        port.postMessage(a);
      },
    );
  });
}

if (!isMainThread && parentPort && (workerData as { bedrockbotProof?: boolean } | null)?.bedrockbotProof) runProofWorker(parentPort);
