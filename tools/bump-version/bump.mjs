#!/usr/bin/env node
// Patch an installed minecraft-data package with a Bedrock version from minecraft-data's GitHub repo,
// ahead of an npm release.
//
//   node bump.mjs <gameVersion> [--mcdata-ref master] [--target <minecraft-data package dir>]
//                [--from-dir <mcdata checkout>] [--fresh-sandbox] [--keep-temp] [--replace-common]
//   node bump.mjs <gameVersion> --from-dir <minecraft-data checkout>  use locally generated data
//   node bump.mjs --list [--mcdata-ref master]         only list upstream bedrock versions
//
// Default target: the npm sandbox at .work/sandbox/node_modules/minecraft-data (created on demand).
// Refuses targets inside a pnpm store (use make-patch.mjs + patchedDependencies for pnpm projects).
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { downloadBump, listUpstream, checkRef, checkVersion, cmpVer } from './lib/upstream.mjs'
import { applyBump, checkTarget, parseDataJs, selfCheck } from './lib/apply.mjs'
import { DEFAULT_SANDBOX, ensureSandbox } from './lib/sandbox.mjs'
import { readFileSync } from 'node:fs'

function parseArgs (argv) {
  const a = { _: [], ref: 'master' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--mcdata-ref') a.ref = argv[++i]
    else if (k === '--from-dir') a.fromDir = resolve(argv[++i])
    else if (k === '--target') a.target = argv[++i]
    else if (k === '--list') a.list = true
    else if (k === '--fresh-sandbox') a.fresh = true
    else if (k === '--keep-temp') a.keepTemp = true
    else if (k === '--replace-common') a.replaceCommon = true
    else if (k === '-h' || k === '--help') a.help = true
    else a._.push(k)
  }
  return a
}

const log = (...m) => console.error(...m)

function printUpstream (up, target) {
  log(`upstream minecraft-data@${up.ref} (${up.source ?? 'unavailable'}):`)
  if (up.folders) log(`  bedrock folders (newest 8): ${up.folders.slice(-8).join(', ')}`)
  else log(`  folder listing unavailable: ${up.apiError}`)
  if (up.protocolVersions) log(`  protocolVersions.json top: ${up.protocolVersions.map(e => `${e.minecraftVersion}=${e.protocol}${e.releaseType === 'release' ? '' : '(' + e.releaseType + ')'}`).join(', ')}`)
  if (target) {
    try {
      const vers = parseDataJs(readFileSync(join(target, 'data.js'), 'utf8')).entries.map(e => e.ver).filter(v => /^\d+(\.\d+)+$/.test(v)).sort(cmpVer)
      log(`  target data.js bedrock entries (newest 5): ${vers.slice(-5).join(', ')}`)
    } catch {}
  }
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  if (a.help || (!a.list && a._.length !== 1)) {
    console.log('usage: node bump.mjs <gameVersion> [--mcdata-ref master] [--target <minecraft-data dir>] [--fresh-sandbox] [--keep-temp]\n       node bump.mjs --list [--mcdata-ref <ref>]')
    process.exit(a.help ? 0 : 1)
  }
  checkRef(a.ref)
  if (a.list) {
    const up = await listUpstream(a.ref)
    printUpstream(up)
    console.log(JSON.stringify(up, null, 2))
    return
  }
  const ver = checkVersion(a._[0])
  let target
  if (a.fresh) ensureSandbox(DEFAULT_SANDBOX, { fresh: true, log })
  if (a.target) target = resolve(a.target)
  else { ensureSandbox(DEFAULT_SANDBOX, { log }); target = join(DEFAULT_SANDBOX, 'node_modules', 'minecraft-data') }
  const { pkg } = checkTarget(target)
  log(`target ${target} (minecraft-data ${pkg.version})`)

  log(`fetching bedrock/${ver} from ${a.fromDir ? a.fromDir : 'minecraft-data@' + a.ref} ...`)
  const dl = await downloadBump(ver, a.ref, undefined, a.fromDir)
  log(`  -> ${dl.tmp} (protocol ${dl.parsed.version.version}, ${Object.keys(dl.parsed.protocol.types).length} types)`)
  const up = await listUpstream(a.ref, dl.parsed.protocolVersions)
  printUpstream(up, target)

  const { changed, report, entry } = await applyBump({ target, ver, ref: a.ref, dl, replaceCommon: a.replaceCommon, log })
  const check = selfCheck(target, ver)
  if (!a.keepTemp) rmSync(dl.tmp, { recursive: true, force: true })
  const result = {
    ok: true,
    version: ver,
    protocol: dl.parsed.version.version,
    mcdataRef: a.fromDir ? null : a.ref,
    fromDir: a.fromDir,
    target,
    targetPackageVersion: pkg.version,
    changed,
    idempotentNoop: changed.length === 0,
    dataJs: report,
    selfCheck: check,
    tempDir: a.keepTemp ? dl.tmp : undefined
  }
  if (report.releasesWithoutDataJsEntry.length) log(`  note: protocolVersions lists releases with no data.js entry: ${report.releasesWithoutDataJsEntry.join(', ')}`)
  log(`data.js entry (base ${report.base}; same as base: ${report.sameAsBase.join(', ')}; differs: ${JSON.stringify(report.differsFromBase)}):\n${entry}`)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(e => { console.error(`bump: ${e.message}`); process.exit(1) })
