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
// A version the package already ships (its dataPaths entry and protocol.json exist) is not bumped: only
// the local fixes below are applied to it, so a patch for a newer minecraft-data release holds the fixes
// alone. --package-version <v> builds the patch for another minecraft-data release than the pin in
// package.json (to prepare a dependency bump; the output name follows it). --derive: a version minecraft-data does not
// have yet is derived from an older one by the named JSON edits of tools/bump-version/derive/<version>.mjs (lib/derive.mjs;
// playbook step 1.2b) instead of being fetched; nothing is downloaded for it.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { downloadBump, checkRef, checkVersion } from './lib/upstream.mjs'
import { applyBump, checkTarget, selfCheck } from './lib/apply.mjs'
import { HERE, npmInstallInto, pins } from './lib/sandbox.mjs'
import { gitFileDiff, rebasePatchPaths } from './lib/gitdiff.mjs'
import { loadRecipe, writeDerivedTree } from './lib/derive.mjs'

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
    else if (k === '--package-version') a.packageVersion = argv[++i]
    else if (k === '--derive') a.derive = true
    else if (k === '-h' || k === '--help') a.help = true
    else a._.push(k)
  }
  return a
}

// Fixes of the protocol data that upstream does not have yet (playbook section 3, "(live)" row). Each one is kept in
// every regenerated patch until upstream ships it; drop an entry when the bump's own data already reads that way.
// - item_stack_response's slot `filtered_custom_name` is an optional string (a bool before it): a Realm sends
//   01 + the filtered name for a named item, BDS a single 00 (ADR 0092, the Realm capture of 2026-11-16).
function localFixes (target, ver, log) {
  const rel = `minecraft-data/data/bedrock/${ver}/protocol.json`
  const file = join(target, rel)
  if (!existsSync(file)) return []
  const proto = JSON.parse(readFileSync(file, 'utf8'))
  let fixed = 0
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    if (node.name === 'filtered_custom_name' && node.type === 'string') { node.type = ['option', 'string']; fixed++ }
    Object.values(node).forEach(walk)
  }
  walk(proto.types?.ItemStackResponses)
  if (fixed === 0) return []
  writeFileSync(file, JSON.stringify(proto, null, 2))
  log(`  local fix: item_stack_response filtered_custom_name -> option string (${fixed})`)
  return [rel]
}

// True when the minecraft-data package dir already has protocol data for this bedrock version.
function ships (pkgDir, ver) {
  const paths = JSON.parse(readFileSync(join(pkgDir, 'minecraft-data', 'data', 'dataPaths.json'), 'utf8'))
  const proto = paths.bedrock?.[ver]?.protocol
  return typeof proto === 'string' && existsSync(join(pkgDir, 'minecraft-data', 'data', proto, 'protocol.json'))
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || a._.length === 0) {
    console.log('usage: node make-patch.mjs <gameVersion> [...] [--mcdata-ref master] [--out patches/minecraft-data@<v>.patch] [--patch-package] [--replace-common] [--from-dir <mcdata checkout>] [--derive] [--package-version <v>]')
    process.exit(a.help ? 0 : 1)
  }
  checkRef(a.ref); a._.forEach(checkVersion)
  if (a.packageVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(a.packageVersion)) throw new Error(`--package-version must look like 3.119.0 (got ${a.packageVersion})`)
  const mdVersion = a.packageVersion ?? pins()['minecraft-data']
  const work = mkdtempSync(join(tmpdir(), 'mcdata-patch-'))
  try {
    log(`installing pristine minecraft-data@${mdVersion} into ${work}`)
    npmInstallInto(join(work, 'pristine'), { 'minecraft-data': mdVersion })
    const before = join(work, 'pristine', 'node_modules', 'minecraft-data')
    const after = join(work, 'patched')
    cpSync(before, after, { recursive: true })
    checkTarget(after)

    const changed = new Set()
    const shipped = []
    const derived = {}
    for (const ver of a._) {
      if (ships(before, ver)) {
        log(`minecraft-data@${mdVersion} already ships ${ver}: local fixes only`)
        shipped.push(ver)
      } else if (a.derive) {
        const recipe = await loadRecipe(ver)
        if (!recipe) throw new Error(`--derive: no recipe tools/bump-version/derive/${ver}.mjs`)
        const tree = writeDerivedTree(before, recipe, join(work, 'derived', ver))
        log(`deriving ${ver} (protocol ${tree.protocol}) from ${tree.base}: ${tree.edits.length} edits`)
        for (const e of tree.edits) log(`  edit: ${e}`)
        derived[ver] = { base: tree.base, protocol: tree.protocol, releaseType: recipe.releaseType, edits: tree.edits.length }
        const dl = await downloadBump(ver, a.ref, work, tree.dir)
        const r = await applyBump({ target: after, ver, ref: `derive/${ver}`, dl, replaceCommon: a.replaceCommon, log })
        r.changed.forEach(c => changed.add(c))
      } else {
        log(`bumping ${ver} from minecraft-data@${a.ref}`)
        const dl = await downloadBump(ver, a.ref, work, a.fromDir)
        const r = await applyBump({ target: after, ver, ref: a.ref, dl, replaceCommon: a.replaceCommon, log })
        r.changed.forEach(c => changed.add(c))
      }
      localFixes(after, ver, log).forEach(c => changed.add(c))
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
    console.log(JSON.stringify({ ok: true, out, patchPackageOut: ppOut, bytes: Buffer.byteLength(patch), package: `minecraft-data@${mdVersion}`, versions: a._, shipped, derived, mcdataRef: a.ref, files }, null, 2))
  } finally {
    if (!a.keepTemp) rmSync(work, { recursive: true, force: true })
    else log(`kept ${work}`)
  }
}

main().catch(e => { console.error(`make-patch: ${e.message}`); process.exit(1) })
