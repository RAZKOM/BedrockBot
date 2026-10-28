// Item icons of the panel (decision 0046): where the textures are. The npm package `minecraft-assets`
// (PrismarineJS, MIT; the art is Mojang's and stays out of git) has the Java edition's item and block
// textures with name indexes and block models per version; one version directory is all that is read.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The Java version whose art is used: the newest in the package, the one closest to the Bedrock release the bot plays. */
export const ASSET_VERSION = '26.1';

export interface AssetSource {
  /** A parsed JSON file of the asset directory (`items_textures.json`). */
  json(file: string): Promise<unknown>;
  /** A texture by path without extension (`blocks/oak_planks`, `items/iron_sword`), undefined when there is none. */
  png(path: string): Promise<Uint8Array | undefined>;
}

/** The directory of one version in the package, undefined when the package or the version is not installed. */
export function assetDir(version = ASSET_VERSION): string | undefined {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('minecraft-assets/package.json'));
    const dir = join(root, 'minecraft-assets', 'data', version);
    return existsSync(join(dir, 'items_textures.json')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_PATH = /^[a-z0-9_]+(\/[a-z0-9_]+)*$/;

export class FsAssets implements AssetSource {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async json(file: string): Promise<unknown> {
    return JSON.parse(await readFile(join(this.dir, file), 'utf8'));
  }

  async png(path: string): Promise<Uint8Array | undefined> {
    if (!SAFE_PATH.test(path)) return undefined;
    try {
      return await readFile(join(this.dir, `${path}.png`));
    } catch {
      return undefined;
    }
  }
}
