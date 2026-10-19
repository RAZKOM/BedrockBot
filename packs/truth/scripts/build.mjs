// Builds the behavior pack into dist/: bundled scripts/main.js + manifest.json + structures/.
// Usage: node scripts/build.mjs
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

export async function buildPack() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const version = manifest.header.version.join('.');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'scripts'), { recursive: true });
  await build({
    entryPoints: [join(root, 'src', 'main.ts')],
    outfile: join(dist, 'scripts', 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['@minecraft/server'],
    define: { __PACK_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    logLevel: 'warning',
  });
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (existsSync(join(root, 'structures'))) cpSync(join(root, 'structures'), join(dist, 'structures'), { recursive: true });
  return { dist, uuid: manifest.header.uuid, version: manifest.header.version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await buildPack();
  console.log(`built ${r.dist} (pack ${r.uuid} v${r.version.join('.')})`);
}
