// Apply downloaded minecraft-data files to an installed `minecraft-data` npm package.
// Idempotent: rerunning with the same inputs changes nothing.
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkDataFolder, cmpVer, parseJson } from './upstream.mjs'

export function checkTarget (target, { allowPnpmStore = false } = {}) {
  const pkgFile = join(target, 'package.json')
  if (!existsSync(pkgFile)) throw new Error(`${target} has no package.json (want a minecraft-data package dir)`)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (pkg.name !== 'minecraft-data') throw new Error(`${target} is ${pkg.name}, not minecraft-data`)
  for (const f of ['data.js', 'minecraft-data/data/dataPaths.json', 'minecraft-data/data/bedrock/common/protocolVersions.json']) {
    if (!existsSync(join(target, f))) throw new Error(`${target} lacks ${f}`)
  }
  const real = realpathSync(target)
  if (!allowPnpmStore && real.includes(`${sep}.pnpm${sep}`)) {
    throw new Error(`${real} is inside a pnpm virtual store; its files are hard links into the global pnpm store, ` +
      'so editing them corrupts every project on this machine. Use make-patch.mjs + pnpm patchedDependencies instead ' +
      '(or bump an npm-installed copy, e.g. the default sandbox).')
  }
  return { pkg, real }
}

function writeIfChanged (file, text, changed, rel) {
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return false
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.bump-tmp'
  writeFileSync(tmp, text); renameSync(tmp, file)
  changed.push(rel)
  return true
}

// One data.js entry, generated the same way as minecraft-data's bin/generate_data.js.
export function generateEntry (target, ver, paths) {
  const lines = []
  for (const [key, folder] of Object.entries(paths)) {
    checkDataFolder(folder)
    const loc = `minecraft-data/data/${folder}/`
    if (existsSync(join(target, loc, key + '.json'))) {
      lines.push(`      get ${key} () { return require("./${loc}${key}.json") }`)
    } else {
      const dir = join(target, loc)
      const file = existsSync(dir) ? readdirSync(dir).find(f => f.startsWith(key + '.')) : null
      if (!file) return { missing: `${folder}/${key}` }
      lines.push(`      ${key}: __dirname + '/${loc}${file}'`)
    }
  }
  return { text: `    '${ver}': {\n${lines.join(',\n')}\n    }` }
}

// Locate the bedrock block and its version entries in data.js.
export function parseDataJs (src) {
  const start = src.indexOf("\n  'bedrock': {\n")
  if (start < 0) throw new Error("data.js: no 'bedrock' block")
  const bodyStart = start + "\n  'bedrock': {\n".length
  const endRe = /\n {2}\}(,\n|\n)/g; endRe.lastIndex = bodyStart
  const endM = endRe.exec(src); if (!endM) throw new Error('data.js: bedrock block not closed')
  const bodyEnd = endM.index // position of "\n  }"
  const entries = []
  const re = /^ {4}'([^']+)': \{\n[\s\S]*?\n {4}\}/gm; re.lastIndex = bodyStart
  let m
  while ((m = re.exec(src)) && m.index < bodyEnd) entries.push({ ver: m[1], start: m.index, end: m.index + m[0].length, text: m[0] })
  return { bodyStart, bodyEnd, entries }
}

const entryPaths = (text) => Object.fromEntries([...text.matchAll(/^ {6}(?:get )?(\w+)[ :(][^\n]*?minecraft-data\/data\/((?:bedrock|pc)\/[^/]+)\//gm)].map(m => [m[1], m[2]]))

// Apply a downloaded bump to `target` (a minecraft-data package dir).
// files: { 'bedrock/<ver>/protocol.json': text, ... } as returned by downloadBump.
// Merge mode (default): keep the package's own dataPaths.json / protocolVersions.json and only add or
// replace the entry for `ver`, so the package stays self-consistent (upstream master also carries
// unrelated edits for other versions that reference files this npm release does not ship).
// Replace mode (--replace-common): take upstream's files verbatim, as spike E did.
export function mergeDataPaths (localText, upstream, ver) {
  const local = JSON.parse(localText)
  const nl = localText.endsWith('\n') ? '\n' : ''
  const bed = local.bedrock ?? {}
  if (ver in bed) bed[ver] = upstream.bedrock[ver]
  else {
    const upKeys = Object.keys(upstream.bedrock)
    const prev = upKeys.slice(0, upKeys.indexOf(ver)).reverse().find(k => k in bed)
    const out = {}
    for (const k of Object.keys(bed)) { out[k] = bed[k]; if (k === prev) out[ver] = upstream.bedrock[ver] }
    if (!(ver in out)) out[ver] = upstream.bedrock[ver]
    local.bedrock = out
  }
  return JSON.stringify(local, null, 2) + nl
}

export function mergeProtocolVersions (localText, upstream, ver) {
  const local = JSON.parse(localText)
  const nl = localText.endsWith('\n') ? '\n' : ''
  const entry = upstream.find(e => e.minecraftVersion === ver)
  const i = local.findIndex(e => e.minecraftVersion === ver)
  if (i >= 0) local[i] = entry
  else {
    const older = new Set(upstream.slice(upstream.indexOf(entry) + 1).map(e => e.minecraftVersion))
    let pos = local.findIndex(e => older.has(e.minecraftVersion)); if (pos < 0) pos = local.length
    local.splice(pos, 0, entry)
  }
  return JSON.stringify(local, null, 2) + nl
}

export function mergeVersionsList (localText, ver) {
  const local = JSON.parse(localText)
  const nl = localText.endsWith('\n') ? '\n' : ''
  if (!local.includes(ver)) {
    let pos = local.findIndex(v => /^\d+(\.\d+)+$/.test(v) && cmpVer(v, ver) > 0)
    if (pos < 0) pos = local.length
    local.splice(pos, 0, ver)
  }
  return JSON.stringify(local, null, 2) + nl
}

// How much upstream's common files differ from the merged result (informational).
function commonDrift (mergedText, upstreamObj) {
  const merged = JSON.parse(mergedText)
  if (Array.isArray(upstreamObj)) {
    const key = e => JSON.stringify(e)
    const m = new Set(merged.map(key)); const u = new Set(upstreamObj.map(key))
    return { onlyUpstream: upstreamObj.filter(e => !m.has(key(e))).map(e => e.minecraftVersion), onlyLocal: merged.filter(e => !u.has(key(e))).map(e => e.minecraftVersion) }
  }
  const diffs = []
  for (const ed of ['pc', 'bedrock']) {
    for (const v of new Set([...Object.keys(merged[ed] ?? {}), ...Object.keys(upstreamObj[ed] ?? {})])) {
      if (JSON.stringify(merged[ed]?.[v]) !== JSON.stringify(upstreamObj[ed]?.[v])) diffs.push(`${ed}/${v}`)
    }
  }
  return { entriesDifferentUpstream: diffs }
}

export async function applyBump ({ target, ver, ref, dl, replaceCommon = false, log = () => {} }) {
  const data = join(target, 'minecraft-data', 'data')
  const changed = []
  const rel = (r) => `minecraft-data/data/${r}`
  const drift = {}
  for (const [r, text] of Object.entries(dl.files)) {
    let out = text
    if (!replaceCommon && r === dl.rels.dataPaths) {
      out = mergeDataPaths(readFileSync(join(data, r), 'utf8'), dl.parsed.dataPaths, ver)
      drift.dataPaths = commonDrift(out, dl.parsed.dataPaths)
    } else if (!replaceCommon && r === dl.rels.protocolVersions) {
      out = mergeProtocolVersions(readFileSync(join(data, r), 'utf8'), dl.parsed.protocolVersions, ver)
      drift.protocolVersions = commonDrift(out, dl.parsed.protocolVersions)
    } else if (!replaceCommon && r === dl.rels.versions) {
      out = mergeVersionsList(readFileSync(join(data, r), 'utf8'), ver)
    }
    if (writeIfChanged(join(data, r), out, changed, rel(r))) log(`  wrote ${rel(r)}${out === text ? '' : ' (merged)'}`)
  }

  // Fill in any data file the new entry references that this package does not ship
  // (e.g. upstream added bedrock/<ver>/blocks.json). Only JSON is fetched.
  const paths = dl.parsed.dataPaths.bedrock[ver]
  let gen = generateEntry(target, ver, paths)
  for (let guard = 0; gen.missing && guard < 32; guard++) {
    const r = gen.missing + '.json'
    log(`  fetching missing ${r}`)
    const text = await dl.source.get(r)
    parseJson(text, r)
    writeIfChanged(join(data, r), text, changed, rel(r))
    gen = generateEntry(target, ver, paths)
  }
  if (gen.missing) throw new Error(`cannot resolve ${gen.missing}`)

  // data.js
  const dataJsFile = join(target, 'data.js')
  const src = readFileSync(dataJsFile, 'utf8')
  const { bodyEnd, entries } = parseDataJs(src)
  const existing = entries.find(e => e.ver === ver)
  const others = entries.filter(e => e.ver !== ver && /^\d+(\.\d+)+$/.test(e.ver)).sort((a, b) => cmpVer(a.ver, b.ver))
  const base = others.filter(e => cmpVer(e.ver, ver) < 0).at(-1) ?? others.at(-1)
  const report = { base: base?.ver ?? null, sameAsBase: [], differsFromBase: {}, action: null }
  if (base) {
    const bp = entryPaths(base.text)
    for (const [k, folder] of Object.entries(paths)) {
      let expect = bp[k]
      if ((k === 'protocol' || k === 'version') && expect === `bedrock/${base.ver}`) expect = `bedrock/${ver}`
      if (expect === folder) report.sameAsBase.push(k)
      else report.differsFromBase[k] = { base: bp[k] ?? null, new: folder }
    }
    for (const k of Object.keys(bp)) if (!(k in paths)) report.differsFromBase[k] = { base: bp[k], new: null }
  }
  let out
  if (existing) {
    if (existing.text === gen.text) { report.action = 'unchanged' } else { report.action = 'replaced' }
    out = src.slice(0, existing.start) + gen.text + src.slice(existing.end)
  } else {
    // Insert after the newest existing entry older than ver (keeps dataPaths' chronological order).
    const after = others.filter(e => cmpVer(e.ver, ver) < 0).at(-1)
    const at = after?.end ?? (entries.length ? Math.max(...entries.map(e => e.end)) : null)
    out = at != null
      ? src.slice(0, at) + ',\n' + gen.text + src.slice(at)
      : src.slice(0, bodyEnd) + '\n' + gen.text + src.slice(bodyEnd)
    report.action = 'inserted'
  }
  if (writeIfChanged(dataJsFile, out, changed, 'data.js')) log(`  data.js: ${report.action} '${ver}' entry`)

  // Consistency warnings: versions the new protocolVersions/dataPaths know but data.js does not.
  const finalEntries = new Set(parseDataJs(out).entries.map(e => e.ver))
  report.releasesWithoutDataJsEntry = dl.parsed.protocolVersions
    .filter(e => e.releaseType === 'release' && !finalEntries.has(e.minecraftVersion) && cmpVer(e.minecraftVersion, '1.16.201') >= 0)
    .map(e => e.minecraftVersion)
  report.commonFiles = replaceCommon ? 'replaced with upstream' : 'merged (entry for this version only)'
  report.upstreamDrift = drift
  return { changed, report, entry: gen.text }
}

// Load the patched package in a fresh process and check the new version resolves.
export function selfCheck (target, ver) {
  const code = `const md=require(${JSON.stringify(target)});const d=md('bedrock_'+${JSON.stringify(ver)});
if(!d) throw new Error('minecraft-data returned null');
const p=d.protocol; if(!p||!p.types||!p.types.mcpe_packet) throw new Error('no protocol');
if(d.version.minecraftVersion!==${JSON.stringify(ver)}) throw new Error('version mismatch '+d.version.minecraftVersion);
const v=md.versions.bedrock.find(e=>e.minecraftVersion===${JSON.stringify(ver)});
console.log(JSON.stringify({protocol:d.version.version,listed:!!v,blockStates:(d.blockStates||[]).length,items:(d.itemsArray||[]).length}))`
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`self-check failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`)
  return JSON.parse(r.stdout.trim())
}
