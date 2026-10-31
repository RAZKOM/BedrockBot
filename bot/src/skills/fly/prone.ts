// Track BH (docs/flight.md "Prone after a glide"): a glide that ends under less than 1.8 blocks of headroom
// (in a tree canopy, under a slab roof, in a 1-high gap) leaves the body in the crawl / swim pose on BDS: the
// server keeps its box 0.6 high (InputLoopState.prone) and the planner, which plans a standing body, has no
// start node there (`goto: no standable node ... on oak_leaves`, the Realm, 2026-10-31 04:46Z). The way out:
// break the blocks over the body that keep it from standing (only those: the cells a standing box would
// take over the prone one), leaves first, each one only if the break rules allow it (protected blocks,
// containers, the base's protectRadius: the navigator's own rules); then the server stands the body up.
import type { Vec3 } from '../../connection/types.ts';

export interface ProneDeps {
  pos(): Vec3;
  prone(): boolean;
  /** The block in a cell (undefined = not loaded). */
  block(x: number, y: number, z: number): { name: string; solid: boolean } | undefined;
  /** Why the cell may not be broken (the navigator's break rules), undefined when it may. */
  breakBlocker(x: number, y: number, z: number): string | undefined;
  dig(p: Vec3): Promise<{ ok: boolean; reason?: string }>;
  waitTicks(n: number): Promise<void>;
}

export interface ProneResult {
  ok: boolean;
  /** The blocks broken (`oak_leaves 12 70 -3`). */
  dug: string[];
  why?: string;
}

/** The standing body's height and half width (the cells it needs over the prone 0.6). */
const STAND = 1.8;
const HALF = 0.3;

/** The cells a standing body at `p` would take that are solid now (the ones to break), leaves first, then the nearest the head. */
export function headCells(p: Vec3, block: ProneDeps['block']): { x: number; y: number; z: number; name: string }[] {
  const out: { x: number; y: number; z: number; name: string }[] = [];
  const x0 = Math.floor(p.x - HALF + 1e-3);
  const x1 = Math.floor(p.x + HALF - 1e-3);
  const z0 = Math.floor(p.z - HALF + 1e-3);
  const z1 = Math.floor(p.z + HALF - 1e-3);
  const y0 = Math.floor(p.y + 1e-3);
  const y1 = Math.floor(p.y + STAND - 1e-3);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const b = block(x, y, z);
        if (b?.solid) out.push({ x, y, z, name: b.name });
      }
    }
  }
  const leafy = (n: string): number => (/leaves|vine|azalea|mangrove_roots/.test(n) ? 0 : 1);
  return out.sort((a, b) => leafy(a.name) - leafy(b.name) || a.y - b.y);
}

/**
 * Break what keeps the body from standing, then wait for the server to stand it up (40 ticks at most).
 * `ok` once it stands (or it was not prone); otherwise why not (a protected block over it, a dig failed).
 */
export async function recoverProne(d: ProneDeps): Promise<ProneResult> {
  const dug: string[] = [];
  if (!d.prone()) return { ok: true, dug };
  for (let round = 0; round < 3 && d.prone(); round++) {
    const cells = headCells(d.pos(), (x, y, z) => d.block(x, y, z));
    for (const c of cells) {
      const why = d.breakBlocker(c.x, c.y, c.z);
      if (why) return { ok: false, dug, why: `${c.name} at ${c.x} ${c.y} ${c.z} over me may not be broken (${why})` };
    }
    for (const c of cells) {
      const r = await d.dig({ x: c.x, y: c.y, z: c.z });
      if (!r.ok) return { ok: false, dug, why: `breaking ${c.name} at ${c.x} ${c.y} ${c.z} failed (${r.reason ?? 'failed'})` };
      dug.push(`${c.name} ${c.x} ${c.y} ${c.z}`);
    }
    for (let i = 0; i < 40 && d.prone(); i++) await d.waitTicks(1);
  }
  return d.prone() ? { ok: false, dug, why: 'still prone after clearing the cells over me' } : { ok: true, dug };
}
