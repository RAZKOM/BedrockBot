// Item icons of the panel (decision 0046): the inventory view of a block, drawn from its Java model.
// Every face of every (unrotated) box is a parallelogram under the model's `display.gui` transform
// (an orthographic view, the one the game uses for blocks: rotation [30, 225, 0], scale 0.625); each
// output pixel asks which faces cover it, takes their texels, shades them like the game does (top
// 100 %, left 80 %, right 60 %) and lays them over each other front to back, so glass and leaves
// show what is behind them. No GPU, no canvas: plain arithmetic on RGBA arrays, 32 x 32 pixels.
import { faceTexture, type FaceName, type ModelElement, type ResolvedModel, type Vec } from './models.ts';
import type { Raster } from './png.ts';

type Pick = 0 | 1;

/** The game's FaceInfo: the four corners of a face as from (0) / to (1) on x, y, z, in the order the
 *  texture corners (u0,v0) (u0,v1) (u1,v1) (u1,v0) are laid on them. */
const FACE_VERTS: Record<FaceName, readonly (readonly [Pick, Pick, Pick])[]> = {
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};

const NORMALS: Record<FaceName, Vec> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };

/** The uv a face has when the model gives none (from the box). */
function defaultUv(face: FaceName, f: Vec, t: Vec): [number, number, number, number] {
  switch (face) {
    case 'down': return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'up': return [f[0], f[2], t[0], t[2]];
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'east': return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
  }
}

const rad = (d: number): number => (d * Math.PI) / 180;

/** The game's rotationXYZ: z first, then y, then x. */
function rotator(r: Vec): (v: Vec) => Vec {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(r[0])), Math.sin(rad(r[0])), Math.cos(rad(r[1])), Math.sin(rad(r[1])), Math.cos(rad(r[2])), Math.sin(rad(r[2]))] as const;
  return ([x, y, z]) => {
    const x1 = x * cz - y * sz;
    const y1 = x * sz + y * cz;
    const x2 = x1 * cy + z * sy;
    const z2 = -x1 * sy + z * cy;
    return [x2, y1 * cx - z2 * sx, y1 * sx + z2 * cx];
  };
}

export interface RenderOptions {
  size: number;
  /** The raster (first frame) of a texture reference of the model, undefined when the file is missing. */
  texture: (ref: string) => Raster | undefined;
  /** `0xRRGGBB` of a face's `tintindex` (grass, leaves); an index without one stays untinted. */
  tint?: (index: number) => number | undefined;
}

interface Hit {
  z: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const SHADE_TOP = 1;
const SHADE_LEFT = 0.8;
const SHADE_RIGHT = 0.6;

/** The model as the inventory shows it: `size` x `size` RGBA, or undefined when nothing is visible (no `display.gui`, no texture found). */
export function renderModel(m: ResolvedModel, o: RenderOptions): Raster | undefined {
  const gui = m.gui;
  if (!gui) return undefined;
  const { size } = o;
  const rot = rotator(gui.rotation);
  const layers: Hit[][] = Array.from({ length: size * size }, () => []);
  const px = 16 / size;
  // model units (0..16, box corners) -> view: centred, scaled, rotated, moved; X right, Y down, Z towards the viewer, all in the 16-wide slot
  const view = ([x, y, z]: Vec): Vec => {
    const p = rot([((x - 8) / 16) * gui.scale[0], ((y - 8) / 16) * gui.scale[1], ((z - 8) / 16) * gui.scale[2]]);
    return [8 + (p[0] + gui.translation[0] / 16) * 16, 8 - (p[1] + gui.translation[1] / 16) * 16, p[2] + gui.translation[2] / 16];
  };
  let drawn = false;
  for (const el of m.elements as readonly ModelElement[]) {
    for (const name of Object.keys(el.faces) as FaceName[]) {
      const face = el.faces[name]!;
      const ref = faceTexture(m, face.texture);
      const tex = ref === undefined ? undefined : o.texture(ref);
      if (!tex) continue;
      const n = rot(NORMALS[name]);
      if (n[2] <= 1e-6) continue; // faces away from the viewer
      const shade = n[1] > 0.5 ? SHADE_TOP : n[0] <= 0 ? SHADE_LEFT : SHADE_RIGHT;
      const tintRgb = face.tintindex === undefined ? undefined : o.tint?.(face.tintindex);
      const v = FACE_VERTS[name].map((s): Vec => view([s[0] ? el.to[0] : el.from[0], s[1] ? el.to[1] : el.from[1], s[2] ? el.to[2] : el.from[2]]));
      const [v0, v1, , v3] = v as [Vec, Vec, Vec, Vec];
      const ax = v3[0] - v0[0], ay = v3[1] - v0[1], az = v3[2] - v0[2];
      const bx = v1[0] - v0[0], by = v1[1] - v0[1], bz = v1[2] - v0[2];
      const det = ax * by - bx * ay;
      if (Math.abs(det) < 1e-9) continue;
      const [u0, w0, u1, w1] = face.uv ?? defaultUv(name, el.from, el.to);
      const corners: [number, number][] = [[u0, w0], [u0, w1], [u1, w1], [u1, w0]];
      const k = (((Math.round((face.rotation ?? 0) / 90) % 4) + 4) % 4);
      const c0 = corners[k]!, c1 = corners[(k + 1) % 4]!, c3 = corners[(k + 3) % 4]!;
      const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
      const i0 = Math.max(0, Math.floor(Math.min(...xs) / px - 0.5)), i1 = Math.min(size - 1, Math.ceil(Math.max(...xs) / px));
      const j0 = Math.max(0, Math.floor(Math.min(...ys) / px - 0.5)), j1 = Math.min(size - 1, Math.ceil(Math.max(...ys) / px));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = (i + 0.5) * px - v0[0], dy = (j + 0.5) * px - v0[1];
          const a = (dx * by - bx * dy) / det, b = (ax * dy - ay * dx) / det;
          if (a < 0 || a >= 1 || b < 0 || b >= 1) continue;
          const u = c0[0] + a * (c3[0] - c0[0]) + b * (c1[0] - c0[0]);
          const w = c0[1] + a * (c3[1] - c0[1]) + b * (c1[1] - c0[1]);
          const tx = Math.min(tex.w - 1, Math.max(0, Math.floor((u / 16) * tex.w)));
          const ty = Math.min(tex.w - 1, Math.max(0, Math.floor((w / 16) * tex.w)));
          const t = (ty * tex.w + tx) * 4;
          const alpha = tex.data[t + 3]!;
          if (alpha === 0) continue;
          let r = tex.data[t]!, g = tex.data[t + 1]!, bl = tex.data[t + 2]!;
          if (tintRgb !== undefined) {
            r = (r * ((tintRgb >> 16) & 255)) / 255;
            g = (g * ((tintRgb >> 8) & 255)) / 255;
            bl = (bl * (tintRgb & 255)) / 255;
          }
          layers[j * size + i]!.push({ z: v0[2] + a * az + b * bz, r: r * shade, g: g * shade, b: bl * shade, a: alpha / 255 });
          drawn = true;
        }
      }
    }
  }
  if (!drawn) return undefined;
  const data = new Uint8Array(size * size * 4);
  for (let p = 0; p < layers.length; p++) {
    const hits = layers[p]!;
    if (hits.length === 0) continue;
    hits.sort((x, y) => y.z - x.z);
    let r = 0, g = 0, b = 0, a = 0;
    for (const h of hits) {
      const w = (1 - a) * h.a;
      r += h.r * w;
      g += h.g * w;
      b += h.b * w;
      a += w;
      if (a >= 0.999) break;
    }
    data[p * 4] = Math.round(r / a);
    data[p * 4 + 1] = Math.round(g / a);
    data[p * 4 + 2] = Math.round(b / a);
    data[p * 4 + 3] = Math.round(a * 255);
  }
  return { w: size, h: size, data };
}
