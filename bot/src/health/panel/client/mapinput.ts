// The map screen's gestures (decision 0062, docs/map.md "Views"): touch first. One pointer pans (and
// turns follow mode off), or in box mode drags a box or one of its corners; two pointers pinch about
// their midpoint; the wheel zooms about the pointer; a short still press is a tap (right-click /
// long-press too). The view state is mapview.ts's; this module only moves it and calls back.
import type { El, Ev } from './dom.ts';
import type { MapBox } from './mapdefs.ts';

/** Zoom limits in CSS pixels per block. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 48;
/** A press that moves less than this many CSS pixels is a tap. */
const TAP_SLOP = 8;
/** A corner handle within this many CSS pixels is grabbed. */
const HANDLE = 24;

export interface ViewState {
  x: number;
  z: number;
  /** Device pixels per block. */
  scale: number;
  follow: boolean;
  boxMode: boolean;
  box: MapBox | null;
}

export interface GestureHost {
  V: ViewState;
  dpr(): number;
  toWorld(sx: number, sy: number): [number, number];
  toScreen(x: number, z: number): [number, number];
  /** The view moved or zoomed: resize, ask for the window, draw. */
  layout(): void;
  drawSoon(): void;
  setFollow(on: boolean): void;
  /** A tap (or right-click) on block (bx, bz) outside box mode. */
  tap(bx: number, bz: number): void;
  /** The box changed by a drag; `end` = the pointer is up. */
  boxMoved(end: boolean): void;
  /** A tap in box mode: a one-block box there. */
  boxTap(bx: number, bz: number): void;
}

/** The box's corner handles: 0 = first, 1 = second, 2 = x1/z2, 3 = x2/z1. */
export const boxCorners = (b: MapBox): [number, number][] => [
  [b.x1, b.z1],
  [b.x2, b.z2],
  [b.x1, b.z2],
  [b.x2, b.z1],
];

/** A box with corner k moved to (x, z). */
export function moveCorner(b: MapBox, k: number, x: number, z: number): MapBox {
  if (k === 0) return { ...b, x1: x, z1: z };
  if (k === 1) return { ...b, x2: x, z2: z };
  if (k === 2) return { ...b, x1: x, z2: z };
  return { ...b, x2: x, z1: z };
}

export function setupGestures(cv: El, h: GestureHost): { zoomAt: (sx: number, sy: number, f: number) => void } {
  const V = h.V;
  const pts = new Map<number, { x: number; y: number }>();
  let gest: { x: number; y: number; vx: number; vz: number; moved: boolean; multi: boolean; corner: number; boxing: boolean } | null = null;
  let pinch: { d: number; scale: number; wx: number; wz: number } | null = null;
  const clamp = (s: number): number => Math.max(MIN_SCALE * h.dpr(), Math.min(MAX_SCALE * h.dpr(), s));
  const point = (ev: Ev | undefined): [number, number] => {
    const rc = cv.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    return [((ev?.clientX ?? 0) - rc.left) * h.dpr(), ((ev?.clientY ?? 0) - rc.top) * h.dpr()];
  };
  const block = (p: [number, number]): [number, number] => {
    const w = h.toWorld(p[0], p[1]);
    return [Math.floor(w[0]), Math.floor(w[1])];
  };
  const mid = (): { p: [number, number]; d: number } => {
    const [a, b] = [...pts.values()];
    return { p: point({ clientX: (a!.x + b!.x) / 2, clientY: (a!.y + b!.y) / 2 }), d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1 };
  };
  function zoomAt(sx: number, sy: number, f: number): void {
    const before = h.toWorld(sx, sy);
    V.scale = clamp(V.scale * f);
    const after = h.toWorld(sx, sy);
    if (!V.follow) {
      V.x += before[0] - after[0];
      V.z += before[1] - after[1];
    }
    h.layout();
  }

  cv.addEventListener('pointerdown', (ev) => {
    pts.set(ev?.pointerId ?? 0, { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0 });
    if (ev?.pointerId !== undefined) cv.setPointerCapture?.(ev.pointerId);
    if (pts.size === 2) {
      const m = mid();
      const wm = h.toWorld(m.p[0], m.p[1]);
      pinch = { d: m.d, scale: V.scale, wx: wm[0], wz: wm[1] };
      if (gest) gest.multi = true;
      return;
    }
    const p = point(ev);
    let corner = -1;
    if (V.boxMode && V.box) {
      boxCorners(V.box).forEach(([cx, cz], k) => {
        const q = h.toScreen(cx + 0.5, cz + 0.5);
        if (corner < 0 && Math.hypot(q[0] - p[0], q[1] - p[1]) < HANDLE * h.dpr()) corner = k;
      });
    }
    gest = { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0, vx: V.x, vz: V.z, moved: false, multi: false, corner, boxing: V.boxMode && (ev?.button ?? 0) === 0 };
    if (gest.boxing && corner < 0) {
      const [bx, bz] = block(p);
      V.box = { x1: bx, z1: bz, x2: bx, z2: bz, y1: 0, y2: 0 };
    }
  });

  cv.addEventListener('pointermove', (ev) => {
    const id = ev?.pointerId ?? 0;
    if (!pts.has(id)) return;
    pts.set(id, { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0 });
    if (pinch && pts.size >= 2) {
      const m = mid();
      V.scale = clamp((pinch.scale * m.d) / pinch.d);
      if (!V.follow) {
        const now = h.toWorld(m.p[0], m.p[1]);
        V.x += pinch.wx - now[0];
        V.z += pinch.wz - now[1];
      }
      h.layout();
      return;
    }
    const gs = gest;
    if (!gs || gs.multi) return;
    const x = ev?.clientX ?? 0;
    const y = ev?.clientY ?? 0;
    if (!gs.moved && Math.hypot(x - gs.x, y - gs.y) > TAP_SLOP) gs.moved = true;
    if (!gs.moved) return;
    if (gs.boxing && V.box) {
      const [bx, bz] = block(point(ev));
      V.box = gs.corner < 0 ? { ...V.box, x2: bx, z2: bz } : moveCorner(V.box, gs.corner, bx, bz);
      h.boxMoved(false);
      return;
    }
    if (V.follow) h.setFollow(false);
    V.x = gs.vx - ((x - gs.x) * h.dpr()) / V.scale;
    V.z = gs.vz - ((y - gs.y) * h.dpr()) / V.scale;
    h.layout();
  });

  const up = (ev?: Ev): void => {
    pts.delete(ev?.pointerId ?? 0);
    if (pts.size < 2) pinch = null;
    const gs = gest;
    if (pts.size > 0 || !gs) return;
    gest = null;
    if (ev?.type === 'pointercancel' || gs.multi) return;
    if (gs.boxing && V.box && (gs.moved || gs.corner >= 0)) {
      h.boxMoved(true);
      return;
    }
    if (gs.moved) return;
    const [bx, bz] = block(point(ev));
    if (V.boxMode) h.boxTap(bx, bz);
    else h.tap(bx, bz);
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', (ev) => {
    ev?.preventDefault?.();
    if (pts.size || gest) return;
    const [bx, bz] = block(point(ev));
    h.tap(bx, bz);
  });
  cv.addEventListener(
    'wheel',
    (ev) => {
      ev?.preventDefault?.();
      const p = point(ev);
      zoomAt(p[0], p[1], (ev?.deltaY ?? 0) < 0 ? 1.25 : 0.8);
    },
    { passive: false },
  );
  return { zoomAt };
}
