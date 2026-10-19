#!/usr/bin/env node
// Prove a generated patch applies to a fresh install of the pinned minecraft-data, with the two
// standard tools, in throwaway temp dirs:
//   pnpm:  patchedDependencies in pnpm-workspace.yaml (pnpm version = root packageManager, via corepack)
//   npm:   patch-package 8.0.1 (patches/minecraft-data+<v>.patch, paths re-rooted to node_modules/minecraft-data/)
// After each install it loads minecraft-data and checks every bumped version resolves.
//
//   node test-patch.mjs <gameVersion> [...] [--patch <file>] [--with pnpm|npm|both] [--keep]
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { HERE, pins } from './lib/sandbox.mjs'
import { checkVersion } from './lib/upstream.mjs'
import { rebasePatchPaths } from './lib/gitdiff.mjs'

const a = { _: [], with: 'both' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--patch') a.patch = argv[++i]
  else if (argv[i] === '--with') a.with = argv[++i]
  else if (argv[i] === '--keep') a.keep = true
  else a._.push(argv[i])
}
if (!a._.length) { console.log('usage: node test-patch.mjs <gameVersion> [...] [--patch file] [--with pnpm|npm|both] [--keep]'); process.exit(1) }
a._.forEach(checkVersion)
const md = pins()['minecraft-data']
const patch = resolve(a.patch ?? join(HERE, 'patches', `minecraft-data@${md}.patch`))
const pnpmVersion = (() => { try { return JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).packageManager?.replace(/^pnpm@/, '') } catch { return null } })() ?? '10'

function sh (cmd, cwd) {
  // fixed command strings only; shell needed for npm/npx/corepack .cmd shims on Windows
  const r = spawnSync(cmd, { cwd, encoding: 'utf8', shell: true, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' } })
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() }
}

function check (dir) {
  const code = `const m=require('minecraft-data');const out={};for(const v of ${JSON.stringify(a._)}){const d=m('bedrock_'+v);out[v]=d&&d.version&&d.version.minecraftVersion===v&&!!d.protocol.types.mcpe_packet?d.version.version:null};console.log(JSON.stringify(out))`
  const r = spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8' })
  const res = r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr.slice(-500) }
  return { ok: r.status === 0 && Object.values(res).every(Boolean), result: res }
}

const results = {}
const root = mkdtempSync(join(tmpdir(), 'mcdata-patchtest-'))
try {
  if (a.with === 'pnpm' || a.with === 'both') {
    const dir = join(root, 'pnpm'); mkdirSync(join(dir, 'patches'), { recursive: true })
    copyFileSync(patch, join(dir, 'patches', `minecraft-data@${md}.patch`))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'patchtest', private: true, packageManager: `pnpm@${pnpmVersion}`, dependencies: { 'minecraft-data': md } }, null, 2))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `patchedDependencies:\n  minecraft-data@${md}: patches/minecraft-data@${md}.patch\n`)
    const r = sh(`corepack pnpm@${pnpmVersion} install --config.confirmModulesPurge=false`, dir)
    results.pnpm = { pnpm: pnpmVersion, install: r.ok, ...check(dir), log: r.ok ? undefined : r.out.slice(-1500) }
  }
  if (a.with === 'npm' || a.with === 'both') {
    const dir = join(root, 'npm'); mkdirSync(join(dir, 'patches'), { recursive: true })
    // patch-package wants project-relative paths: derive them from the pnpm-format patch
    writeFileSync(join(dir, 'patches', `minecraft-data+${md}.patch`), rebasePatchPaths(readFileSync(patch, 'utf8'), 'node_modules/minecraft-data'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'patchtest', private: true, dependencies: { 'minecraft-data': md }, devDependencies: { 'patch-package': '8.0.1' } }, null, 2))
    const i = sh('npm install --no-audit --no-fund --ignore-scripts --loglevel=error', dir)
    const p = i.ok ? sh('npx --no-install patch-package --error-on-fail', dir) : { ok: false, out: i.out }
    results.npm = { tool: 'patch-package@8.0.1', install: i.ok, apply: p.ok, ...check(dir), log: p.ok ? p.out.split('\n').filter(l => /minecraft-data/.test(l)).join(' | ') : p.out.slice(-1500) }
  }
} finally {
  if (!a.keep) rmSync(root, { recursive: true, force: true })
}
const ok = Object.values(results).every(r => r.ok)
console.log(JSON.stringify({ ok, patch, bytes: readFileSync(patch).length, results }, null, 2))
process.exit(ok ? 0 : 1)
