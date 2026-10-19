#!/usr/bin/env node
// Turn one or more version bumps into a persistent patch for the minecraft-data npm package.
//
//   node make-patch.mjs <gameVersion> [<gameVersion> ...] [--mcdata-ref master] [--out <file>]
//                       [--patch-package] [--replace-common] [--keep-temp]
//
// Installs a pristine minecraft-data (version pinned in package.json) into a temp dir with npm,
// copies it, applies bump(s) to the copy, and writes a git-format diff of exactly the files the
// bump touched. Default output: patches/minecraft-data@<pkgVersion>.patch (pnpm patch naming).
// Paths are package-relative (pnpm `patchedDependencies` format). --patch-package also writes
// patches/minecraft-data+<pkgVersion>.patch with node_modules/minecraft-data/ paths for patch-package.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { downloadBump, checkRef, checkVersion } from './lib/upstream.mjs'
import { applyBump, checkTarget, selfCheck } from './lib/apply.mjs'
import { HERE, npmInstallInto, pins } from './lib/sandbox.mjs'
import { gitFileDiff, rebasePatchPaths } from './lib/gitdiff.mjs'

const log = (...m) => console.error(...m)

function parseArgs (argv) {
  const a = { _: [], ref: 'master' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--mcdata-ref') a.ref = argv[++i]
    else if (k === '--from-dir') a.fromDir = resolve(argv[++i])
    else if (k === '--out') a.out = argv[++i]
    else if (k === '--keep-temp') a.keepTemp = true
    else if (k === '--replace-common') a.replaceCommon = true
    else if (k === '--patch-package') a.patchPackage = true
    else if (k === '-h' || k === '--help') a.help = true
    else a._.push(k)
  }
  return a
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || a._.length === 0) {
    console.log('usage: node make-patch.mjs <gameVersion> [...] [--mcdata-ref master] [--out patches/minecraft-data@<v>.patch] [--patch-package] [--replace-common] [--from-dir <mcdata checkout>]')
    process.exit(a.help ? 0 : 1)
  }
  checkRef(a.ref); a._.forEach(checkVersion)
  const mdVersion = pins()['minecraft-data']
  const work = mkdtempSync(join(tmpdir(), 'mcdata-patch-'))
  try {
    log(`installing pristine minecraft-data@${mdVersion} into ${work}`)
    npmInstallInto(join(work, 'pristine'), { 'minecraft-data': mdVersion })
    const before = join(work, 'pristine', 'node_modules', 'minecraft-data')
    const after = join(work, 'patched')
    cpSync(before, after, { recursive: true })
    checkTarget(after)

    const changed = new Set()
    for (const ver of a._) {
      log(`bumping ${ver} from minecraft-data@${a.ref}`)
      const dl = await downloadBump(ver, a.ref, work, a.fromDir)
      const r = await applyBump({ target: after, ver, ref: a.ref, dl, replaceCommon: a.replaceCommon, log })
      r.changed.forEach(c => changed.add(c))
      log(`  self-check ${JSON.stringify(selfCheck(after, ver))}`)
    }
    const files = [...changed].sort()
    let patch = ''
    for (const rel of files) {
      const o = existsSync(join(before, rel)) ? readFileSync(join(before, rel), 'utf8') : null
      const n = readFileSync(join(after, rel), 'utf8')
      patch += gitFileDiff(rel, o, n)
    }
    const out = resolve(a.out ?? join(HERE, 'patches', `minecraft-data@${mdVersion}.patch`))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, patch)
    let ppOut
    if (a.patchPackage) {
      ppOut = join(dirname(out), `minecraft-data+${mdVersion}.patch`)
      writeFileSync(ppOut, rebasePatchPaths(patch, 'node_modules/minecraft-data'))
    }
    console.log(JSON.stringify({ ok: true, out, patchPackageOut: ppOut, bytes: Buffer.byteLength(patch), package: `minecraft-data@${mdVersion}`, versions: a._, mcdataRef: a.ref, files }, null, 2))
  } finally {
    if (!a.keepTemp) rmSync(work, { recursive: true, force: true })
    else log(`kept ${work}`)
  }
}

main().catch(e => { console.error(`make-patch: ${e.message}`); process.exit(1) })
