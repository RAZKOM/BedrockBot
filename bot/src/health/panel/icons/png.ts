// Item icons of the panel (docs/panel.md "Item icons", decision 0046): PNG in and out. pngjs does
// the colour types and bit depths the textures use (gray, 4-bit palette, RGBA).
import { PNG } from 'pngjs';

/** 8-bit RGBA, row by row. */
export interface Raster {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): Raster {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
}

export function encodePng(r: Raster): Buffer {
  const png = new PNG({ width: r.w, height: r.h });
  png.data = Buffer.from(r.data);
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
}

/** Animated textures (compass, clock, prismarine, fire ...) are a column of square frames: the first. */
export function firstFrame(r: Raster): Raster {
  return r.h <= r.w ? r : { w: r.w, h: r.w, data: r.data.subarray(0, r.w * r.w * 4) };
}

/** `0xRRGGBB` multiplied into every pixel (the colour of tinted textures: grass, leaves, leather). */
export function tinted(r: Raster, rgb: number): Raster {
  const out = new Uint8Array(r.data);
  const m = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.round((out[i + c]! * m[c]!) / 255);
  return { w: r.w, h: r.h, data: out };
}

/** `top` laid over `base` (same size, straight alpha). */
export function overlay(base: Raster, top: Raster): Raster {
  if (base.w !== top.w || base.h !== top.h) return base;
  const out = new Uint8Array(base.data);
  for (let i = 0; i < out.length; i += 4) {
    const ta = top.data[i + 3]! / 255;
    if (ta === 0) continue;
    const ba = out[i + 3]! / 255;
    const a = ta + ba * (1 - ta);
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((top.data[i + c]! * ta + out[i + c]! * ba * (1 - ta)) / a);
    out[i + 3] = Math.round(a * 255);
  }
  return { w: base.w, h: base.h, data: out };
}
