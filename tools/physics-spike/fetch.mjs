// Downloads LiteLDev/bedboo (LGPL-3.0) at a pinned commit into .work/bedboo as plain files: a tarball
// from codeload.github.com, extracted with `tar`. No git, no install, no scripts from the tarball run.
// Only packages/mineflayer-bedrock/lib/physics/*.js and lib/bedrock/constants.js are ever loaded
// (by bedboo-engine.ts), and they were read before use: pure math, requiring only `vec3`.
//
//   node fetch.mjs [--commit <sha>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const BEDBOO_COMMIT = '116859f05a4578d73646e113f15b8653697971f6'; // main, 2026-10-20

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { commit: { type: 'string', default: BEDBOO_COMMIT } } });
const work = join(here, '.work');
const dest = join(work, 'bedboo');
mkdirSync(work, { recursive: true });
const tgz = join(work, `bedboo-${values.commit.slice(0, 7)}.tar.gz`);
if (!existsSync(tgz)) {
  const res = await fetch(`https://codeload.github.com/LiteLDev/bedboo/tar.gz/${values.commit}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// relative paths: GNU tar (Git Bash) reads 'C:' as a remote host
execFileSync('tar', ['-xzf', basename(tgz), '-C', 'bedboo', '--strip-components=1'], { cwd: work, stdio: 'inherit' });
writeFileSync(join(dest, '.commit'), values.commit + '\n');
console.log(`bedboo ${values.commit} -> ${dest}`);
