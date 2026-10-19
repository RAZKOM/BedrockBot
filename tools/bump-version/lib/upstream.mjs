// Download minecraft-data files from GitHub. Everything fetched here is treated as data: it is
// written to a fresh temp dir, parsed with JSON.parse and validated, never required or executed.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const REPO = 'PrismarineJS/minecraft-data'
const MAX_BYTES = 64 * 1024 * 1024

export function checkVersion (ver) {
  if (!/^\d+\.\d+\.\d+$/.test(ver ?? '')) throw new Error(`game version must look like 1.26.60 (got ${ver})`)
  return ver
}

export function checkRef (ref) {
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.includes('..')) throw new Error(`bad --mcdata-ref ${ref}`)
  return ref
}

// A data path in dataPaths.json, e.g. "bedrock/1.26.30" or "pc/1.17". Guards against traversal.
export function checkDataFolder (folder) {
  if (!/^(bedrock|pc)\/[A-Za-z0-9._-]+$/.test(folder) || folder.includes('..')) throw new Error(`suspicious data path ${JSON.stringify(folder)}`)
  return folder
}

export const rawUrl = (ref, rel) => `https://raw.githubusercontent.com/${REPO}/${ref}/data/${rel}`

export async function fetchText (url) {
  const res = await fetch(url, { headers: { 'user-agent': 'bedrockbot-bump-version' } })
  if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e }
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) throw new Error(`${url} too large (${len} bytes)`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error(`${url} too large`)
  return text
}

export function parseJson (text, what) {
  try { return JSON.parse(text) } catch (e) { throw new Error(`${what} is not valid JSON: ${e.message}`) }
}

// A file source: GitHub raw at <ref>, or a local minecraft-data checkout (--from-dir) for when you
// generated the protocol yourself. get(rel) returns the text of data/<rel>.
export function makeSource (ref = 'master', fromDir = null) {
  if (fromDir) {
    const root = join(fromDir, 'data')
    if (!existsSync(join(root, 'dataPaths.json'))) throw new Error(`${fromDir} is not a minecraft-data checkout (no data/dataPaths.json)`)
    return {
      label: `dir ${fromDir}`,
      async get (rel) {
        const f = join(root, rel)
        if (!existsSync(f)) { const e = new Error(`missing ${f}`); e.status = 404; throw e }
        return readFileSync(f, 'utf8')
      }
    }
  }
  checkRef(ref)
  return { label: `minecraft-data@${ref}`, get: (rel) => fetchText(rawUrl(ref, rel)) }
}

// Fetch the four files a bump needs into a fresh temp dir and validate them.
// Returns { tmp, files: { [relPath]: text }, parsed: { protocol, version, protocolVersions, dataPaths } }.
export async function downloadBump (ver, ref = 'master', tmpRoot = tmpdir(), fromDir = null) {
  checkVersion(ver)
  const source = makeSource(ref, fromDir)
  const tmp = mkdtempSync(join(tmpRoot, `mcdata-${ver}-`))
  const rels = {
    protocol: `bedrock/${ver}/protocol.json`,
    version: `bedrock/${ver}/version.json`,
    protocolVersions: 'bedrock/common/protocolVersions.json',
    versions: 'bedrock/common/versions.json', // minecraft-data's supportedVersions list
    dataPaths: 'dataPaths.json'
  }
  const files = {}; const parsed = {}
  try {
    for (const [k, rel] of Object.entries(rels)) {
      let text
      try { text = await source.get(rel) } catch (e) {
        if (e.status === 404 && k === 'protocol') throw new Error(`${source.label} has no data/${rel} yet: upstream has not added ${ver} (see playbook.md, "protocol folder missing")`)
        throw e
      }
      const out = join(tmp, rel); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text)
      files[rel] = text; parsed[k] = parseJson(text, rel)
    }
    validate(ver, parsed)
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e }
  return { tmp, rels, files, parsed, source }
}

export function validate (ver, { protocol, version, protocolVersions, versions, dataPaths }) {
  if (version?.minecraftVersion !== ver) throw new Error(`version.json minecraftVersion=${version?.minecraftVersion}, expected ${ver}`)
  if (!Number.isInteger(version.version)) throw new Error('version.json has no integer protocol version')
  if (typeof protocol?.types !== 'object' || !protocol.types.mcpe_packet) throw new Error('protocol.json has no types.mcpe_packet (not a bedrock protocol schema?)')
  if (!Array.isArray(protocolVersions)) throw new Error('protocolVersions.json is not an array')
  if (!Array.isArray(versions) || !versions.every(v => typeof v === 'string')) throw new Error('common/versions.json is not an array of strings')
  if (!versions.includes(ver)) throw new Error(`common/versions.json does not list ${ver}`)
  const pv = protocolVersions.find(e => e.minecraftVersion === ver)
  if (!pv) throw new Error(`protocolVersions.json has no entry for ${ver}`)
  if (pv.version !== version.version) throw new Error(`protocol mismatch: protocolVersions says ${pv.version}, version.json says ${version.version}`)
  const paths = dataPaths?.bedrock?.[ver]
  if (!paths) throw new Error(`dataPaths.json has no bedrock["${ver}"] entry`)
  for (const folder of Object.values(paths)) checkDataFolder(folder)
  if (paths.protocol !== `bedrock/${ver}`) throw new Error(`dataPaths bedrock[${ver}].protocol is ${paths.protocol}, expected bedrock/${ver}`)
  if (paths.version !== `bedrock/${ver}`) throw new Error(`dataPaths bedrock[${ver}].version is ${paths.version}, expected bedrock/${ver}`)
  return pv
}

// Which bedrock versions exist upstream: folder listing via the GitHub contents API (60 req/h
// unauthenticated), falling back to protocolVersions.json when the API is unavailable.
export async function listUpstream (ref = 'master', protocolVersions = null) {
  const out = { ref, folders: null, protocolVersions: null, source: null }
  try {
    const api = `https://api.github.com/repos/${REPO}/contents/data/bedrock?ref=${encodeURIComponent(ref)}`
    const list = parseJson(await fetchText(api), 'contents API')
    out.folders = list.filter(e => e.type === 'dir' && /^\d/.test(e.name)).map(e => e.name).sort(cmpVer)
    out.source = 'github contents API'
  } catch (e) { out.apiError = e.message }
  try {
    const pv = protocolVersions ?? parseJson(await fetchText(rawUrl(ref, 'bedrock/common/protocolVersions.json')), 'protocolVersions.json')
    out.protocolVersions = pv.slice(0, 8).map(e => ({ minecraftVersion: e.minecraftVersion, protocol: e.version, releaseType: e.releaseType }))
    out.source ??= 'protocolVersions.json'
  } catch (e) { out.pvError = e.message }
  return out
}

export function cmpVer (a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
  return 0
}
