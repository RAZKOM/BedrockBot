// The debug map's copy of the shared map painting (decision 0062, docs/map.md "Painting"). The painting
// is ONE module, health/panel/client/paint.ts: the panel's map screen imports it as a browser module and
// the server / tests import it directly. The /map page is a classic inline script on the plain health
// server (no panel, no /ui/ route), so it embeds the same module as text: PAINT_JS is that file with its
// types stripped (Node's stripTypeScriptTypes, as the panel serves its modules) and the `export`
// keywords dropped, made once per process. What the tests check is what both pages run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripModule } from '../panel/assets.ts';

export {
  mapB64,
  mapClassColour,
  mapColumnRgb,
  mapColumnShade,
  mapDecodeSlice,
  mapDecodeTile,
  mapDescribe,
  mapDescribeSlice,
  mapFade,
  mapHeight,
  mapHexRgb,
  mapLayerFor,
  mapPixels,
  mapRelief,
  mapSlicePixels,
  mapSurfaceAt,
  mapWaterShade,
  MAP_PALE,
  type DecodedSlice,
  type DecodedTile,
  type LayerPref,
  type PaintLayer,
  type PaintMode,
  type PaintPaletteEntry,
} from '../panel/client/paint.ts';

/** The shared painting module's source path. */
export const PAINT_MODULE = fileURLToPath(new URL('../panel/client/paint.ts', import.meta.url));

/** paint.ts as a classic script: types stripped, `export` dropped, the type-only import gone. */
export function paintScript(src = readFileSync(PAINT_MODULE, 'utf8')): string {
  return stripModule(src)
    .replace(/^\s*import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}

/** The debug page embeds this (page.ts). */
export const PAINT_JS = paintScript();
