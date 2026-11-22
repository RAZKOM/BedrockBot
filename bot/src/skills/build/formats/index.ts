// Structure files for `!build file <name>` (wave 9, Track AL; docs/build.md "Formats"): where they
// are looked up, how they are read and how they are rotated and placed in the world.
//
// Folders, first hit wins: `values.builds` (tests, programmatic use), env BEDROCKBOT_BUILDS, `builds/`
// next to the config file (`%LOCALAPPDATA%\bedrockbot\builds` on Windows, `~/.bedrockbot/builds`
// elsewhere; not with --no-config), then `worlds/` in the working directory. Names: `<name>` or
// `<name>.<extension>`; only letters, digits, `_`, `-` and `.` (no paths). Track B2: the extensions, in lookup
// order: `.mcstructure`, `.json` (Bedrock names), `.schem`, `.schematic`, `.litematic`, `.nbt` (Java files,
// mapped to Bedrock blocks by java.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { locateConfig } from '../../../config/config.ts';
import type { BuildBlock, Cell } from '../types.ts';
import { readLayers } from './layers.ts';
import { readLitematic } from './litematic.ts';
import { readMcstructure, StructureError, type Structure, type StructureFormat } from './mcstructure.ts';
import { rotateStates } from './rotate.ts';
import { readSchem } from './schem.ts';
import { readSchematic } from './schematic.ts';
import { readVanilla } from './vanilla.ts';

export { readLayers } from './layers.ts';
export { readMcstructure, writeMcstructure, StructureError, type Structure, type UnknownBlock } from './mcstructure.ts';

export type Rotation = 0 | 90 | 180 | 270;

/** Track B2: the extensions `!build file` reads, in lookup order, and their format. */
export const STRUCTURE_EXTENSIONS: readonly (readonly [string, StructureFormat])[] = [
  ['.mcstructure', 'mcstructure'],
  ['.json', 'json'],
  ['.schem', 'schem'],
  ['.schematic', 'schematic'],
  ['.litematic', 'litematic'],
  ['.nbt', 'nbt'],
];
const EXT_RE = /\.(mcstructure|json|schem|schematic|litematic|nbt)$/i;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

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

const formatOf = (file: string): StructureFormat | undefined => STRUCTURE_EXTENSIONS.find(([e]) => file.toLowerCase().endsWith(e))?.[1];

/** Read a structure file by its format. */
export function readStructure(buf: Buffer, format: StructureFormat, name: string, version?: string): Structure {
  switch (format) {
    case 'mcstructure':
      return { ...readMcstructure(buf, name), format };
    case 'json':
      return { ...readLayers(buf.toString('utf8'), name), format };
    case 'schem':
      return readSchem(buf, name, version);
    case 'schematic':
      return readSchematic(buf, name, version);
    case 'litematic':
      return readLitematic(buf, name, version);
    case 'nbt':
      return readVanilla(buf, name, version);
  }
}

/** Find and read `name` in `dirs`. Throws StructureError with the folders searched. */
export function loadStructure(name: string, dirs: readonly string[], version?: string): Structure & { file: string } {
  if (!NAME_RE.test(name) || name.includes('..')) throw new StructureError(`bad structure name "${name}" (letters, digits, _ - . only)`);
  const files = EXT_RE.test(name) ? [name] : STRUCTURE_EXTENSIONS.map(([e]) => `${name}${e}`);
  for (const d of dirs) {
    for (const f of files) {
      const file = join(d, f);
      if (!existsSync(file)) continue;
      const format = formatOf(f)!;
      const s = readStructure(readFileSync(file), format, f.replace(EXT_RE, ''), version);
      return { ...s, file };
    }
  }
  throw new StructureError(`no structure "${name}" (${STRUCTURE_EXTENSIONS.map(([e]) => e).join(', ')}) in ${dirs.join(', ')}`);
}

/** Track B2: a structure file of the folders (`!build files`). */
export interface StructureFile {
  /** The name `!build file` takes (with the extension when another file of that name comes first). */
  name: string;
  file: string;
  format: StructureFormat;
  bytes: number;
  /** Read: its size and block counts; or why it could not be read. */
  size?: Structure['size'];
  blocks?: number;
  unknown?: number;
  error?: string;
}

/** Most files `!build files` reads. */
export const MAX_LIST_FILES = 40;

/**
 * The structure files of `dirs` (each read for its size and block count), first folder first, by name within a
 * folder; a name an earlier file already answers is listed with its extension. At most `max` files are read.
 */
export function listStructures(dirs: readonly string[], max = MAX_LIST_FILES, version?: string): { files: StructureFile[]; more: number } {
  const out: StructureFile[] = [];
  const taken = new Set<string>();
  let more = 0;
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d).filter((f) => EXT_RE.test(f) && NAME_RE.test(f)).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    // within one folder the lookup order of the extensions decides which file a bare name reads
    names.sort((a, b) => a.replace(EXT_RE, '').localeCompare(b.replace(EXT_RE, '')) || STRUCTURE_EXTENSIONS.findIndex(([e]) => a.toLowerCase().endsWith(e)) - STRUCTURE_EXTENSIONS.findIndex(([e]) => b.toLowerCase().endsWith(e)));
    for (const f of names) {
      const file = join(d, f);
      let bytes: number;
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch {
        continue;
      }
      if (out.length >= max) {
        more++;
        continue;
      }
      const base = f.replace(EXT_RE, '');
      const name = taken.has(base.toLowerCase()) ? f : base;
      taken.add(base.toLowerCase());
      const format = formatOf(f)!;
      const e: StructureFile = { name, file, format, bytes };
      try {
        const s = readStructure(readFileSync(file), format, base, version);
        e.size = s.size;
        e.blocks = s.blocks.length;
        const u = (s.unknown ?? []).reduce((n, x) => n + x.count, 0);
        if (u) e.unknown = u;
      } catch (err) {
        e.error = err instanceof Error ? err.message.replace(`${base}: `, '') : String(err);
      }
      out.push(e);
    }
  }
  return { files: out, more };
}

/** `1.2 KB`, `830 B`. */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Rotate the structure's cells around the vertical axis by `rot` degrees clockwise seen from above
 * (+x east to +z south), keep the min corner at (0, 0, 0), then move it to `at`. Track B2: the blocks'
 * direction and axis states turn with them (rotate.ts).
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
    const out: BuildBlock = { ...b, pos: { x: at.x + x, y: at.y + b.pos.y, z: at.z + z } };
    if (rot && b.states) out.states = rotateStates(b.name, b.states, rot);
    return out;
  });
}

export function parseRotation(s: string): Rotation | undefined {
  const n = Number(s);
  return n === 0 || n === 90 || n === 180 || n === 270 ? n : undefined;
}
