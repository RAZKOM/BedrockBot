// Structure files for `!build file <name>` (wave 9, Track AL; docs/build.md "Formats"): where they
// are looked up, how they are read and how they are rotated and placed in the world.
//
// Folders, first hit wins: `values.builds` (tests, programmatic use), env BEDROCKBOT_BUILDS, `builds/`
// next to the config file (`%LOCALAPPDATA%\bedrockbot\builds` on Windows, `~/.bedrockbot/builds`
// elsewhere; not with --no-config), then `worlds/` in the working directory. Names: `<name>`,
// `<name>.mcstructure` or `<name>.json`; only letters, digits, `_`, `-` and `.` (no paths).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { locateConfig } from '../../../config/config.ts';
import type { BuildBlock, Cell } from '../types.ts';
import { readLayers } from './layers.ts';
import { readMcstructure, StructureError, type Structure } from './mcstructure.ts';

export { readLayers } from './layers.ts';
export { readMcstructure, writeMcstructure, StructureError, type Structure } from './mcstructure.ts';

export type Rotation = 0 | 90 | 180 | 270;

/** Build folders in lookup order (see the header). */
export function buildDirs(values: Readonly<Record<string, unknown>> = {}, env: NodeJS.ProcessEnv = process.env, cwd: string = env.INIT_CWD ?? process.cwd()): string[] {
  const out: string[] = [];
  if (typeof values.builds === 'string' && values.builds) out.push(values.builds);
  if (env.BEDROCKBOT_BUILDS) out.push(env.BEDROCKBOT_BUILDS);
  if (values['no-config'] !== true) {
    const flag = typeof values.config === 'string' ? values.config : undefined;
    out.push(join(dirname(locateConfig(flag, env, cwd).path), 'builds'));
  }
  out.push(join(cwd, 'worlds'));
  return out;
}

/** Find and read `name` in `dirs`. Throws StructureError with the folders searched. */
export function loadStructure(name: string, dirs: readonly string[]): Structure & { file: string } {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) || name.includes('..')) throw new StructureError(`bad structure name "${name}" (letters, digits, _ - . only)`);
  const files = /\.(mcstructure|json)$/i.test(name) ? [name] : [`${name}.mcstructure`, `${name}.json`];
  for (const d of dirs) {
    for (const f of files) {
      const file = join(d, f);
      if (!existsSync(file)) continue;
      const base = f.replace(/\.(mcstructure|json)$/i, '');
      const s = /\.json$/i.test(f) ? readLayers(readFileSync(file, 'utf8'), base) : readMcstructure(readFileSync(file), base);
      return { ...s, file };
    }
  }
  throw new StructureError(`no structure "${name}" (.mcstructure or .json) in ${dirs.join(', ')}`);
}

/**
 * Rotate the structure's cells around the vertical axis by `rot` degrees clockwise seen from above
 * (+x east to +z south), keep the min corner at (0, 0, 0), then move it to `at`.
 */
export function placeStructure(s: Pick<Structure, 'size' | 'blocks'>, at: Cell, rot: Rotation = 0): BuildBlock[] {
  const { x: sx, z: sz } = s.size;
  const turn = (x: number, z: number): [number, number] => {
    switch (rot) {
      case 90:
        return [sz - 1 - z, x];
      case 180:
        return [sx - 1 - x, sz - 1 - z];
      case 270:
        return [z, sx - 1 - x];
      default:
        return [x, z];
    }
  };
  return s.blocks.map((b) => {
    const [x, z] = turn(b.pos.x, b.pos.z);
    return { ...b, pos: { x: at.x + x, y: at.y + b.pos.y, z: at.z + z } };
  });
}

export function parseRotation(s: string): Rotation | undefined {
  const n = Number(s);
  return n === 0 || n === 90 || n === 180 || n === 270 ? n : undefined;
}
