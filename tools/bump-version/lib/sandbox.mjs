// An npm-installed copy of the protocol stack that bump.mjs may edit in place and verify.mjs loads.
// Why not tools/bump-version/node_modules: this folder is a pnpm workspace member, so its
// node_modules are symlinks into node_modules/.pnpm, whose files are hard links into the global
// pnpm store. Editing those would patch every project on the machine.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_SANDBOX = join(HERE, '.work', 'sandbox')

export function pins () {
  return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies
}

export function npm (args, cwd) {
  // npm is npm.cmd on Windows and Node only spawns .cmd through a shell. Callers pass fixed,
  // validated tokens only (no spaces or shell metacharacters), checked here.
  for (const t of args) if (!/^[A-Za-z0-9@._=/:\\-]+$/.test(t)) throw new Error(`refusing npm arg ${JSON.stringify(t)}`)
  const r = process.platform === 'win32'
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, encoding: 'utf8', shell: true })
    : spawnSync('npm', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed in ${cwd}:\n${(r.stderr || '').slice(-2000)}`)
  return r.stdout
}

// Install `deps` ({name: exactVersion}) with npm into dir. Install scripts are skipped:
// raknet-native ships prebuilt binaries for win32-x64, linux-x64 and darwin-x64.
export function npmInstallInto (dir, deps, { fresh = false, log = () => {} } = {}) {
  if (fresh) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const pkg = { name: 'bump-sandbox', private: true, dependencies: deps, overrides: deps['minecraft-data'] ? { 'minecraft-data': deps['minecraft-data'] } : {} }
  const pkgFile = join(dir, 'package.json')
  const want = JSON.stringify(pkg, null, 2) + '\n'
  const have = existsSync(pkgFile) ? readFileSync(pkgFile, 'utf8') : ''
  const installed = Object.keys(deps).every(n => existsSync(join(dir, 'node_modules', n, 'package.json')))
  if (have === want && installed) return dir
  writeFileSync(pkgFile, want)
  log(`npm install in ${dir} (${Object.entries(deps).map(([n, v]) => `${n}@${v}`).join(', ')})`)
  npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], dir)
  return dir
}

export function ensureSandbox (dir = DEFAULT_SANDBOX, opts = {}) {
  return npmInstallInto(dir, pins(), opts)
}
