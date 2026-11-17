// Derive a bedrock protocol.json from an older version's by explicit, named edits (playbook step 1.2b), for a game
// version minecraft-data does not have yet. The edits work on the compiled ProtoDef JSON minecraft-data ships (no
// YAML compiler, no script of a minecraft-data checkout is run). Every edit states what it expects to find and
// throws when the base reads otherwise, so a changed base fails loudly instead of being edited in the wrong place.
// Recipes: tools/bump-version/derive/<version>.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVersion, cmpVer } from './upstream.mjs'

export const DERIVE_DIR = new URL('../derive/', import.meta.url)

/** The recipe module for a game version, or null when there is none. */
export async function loadRecipe (ver) {
  checkVersion(ver)
  const file = new URL(`${ver}.mjs`, DERIVE_DIR)
  if (!existsSync(fileURLToPath(file))) return null
  const mod = await import(file.href)
  const r = mod.default
  if (r?.version !== ver || !Number.isInteger(r.protocol) || typeof r.base !== 'string' || !Array.isArray(r.edits)) throw new Error(`derive/${ver}.mjs: not a recipe (version, protocol, base, edits)`)
  return r
}

const isContainer = (node) => Array.isArray(node) && node[0] === 'container' && Array.isArray(node[1])

/** Edit helpers on one protocol's `types`. */
export class Derivation {
  constructor (protocol) {
    this.protocol = structuredClone(protocol)
    this.types = this.protocol.types
    this.done = []
  }

  type (name) {
    if (!(name in this.types)) throw new Error(`no type ${name}`)
    return this.types[name]
  }

  /** The fields of a container type or node. */
  fields (nodeOrName, what = String(nodeOrName)) {
    const node = typeof nodeOrName === 'string' ? this.type(nodeOrName) : nodeOrName
    if (!isContainer(node)) throw new Error(`${what} is not a container`)
    return node[1]
  }

  field (fields, name, what = '') {
    const f = fields.find((x) => x.name === name)
    if (!f) throw new Error(`no field ${name}${what ? ` in ${what}` : ''} (have ${fields.map((x) => x.name ?? '(anon)').join(', ')})`)
    return f
  }

  /** The `switch` options of a field (named, or the anonymous one when `name` is omitted). */
  switchOf (fields, name, what = '') {
    const f = name === undefined ? fields.find((x) => x.anon && Array.isArray(x.type) && x.type[0] === 'switch') : this.field(fields, name, what)
    if (!f || !Array.isArray(f.type) || f.type[0] !== 'switch') throw new Error(`no switch ${name ?? '(anon)'}${what ? ` in ${what}` : ''}`)
    return f.type[1]
  }

  /** The mappings of a mapper node, or of a mapper field. */
  mappings (node, what = '') {
    const m = Array.isArray(node) ? node : node?.type
    if (!Array.isArray(m) || m[0] !== 'mapper') throw new Error(`${what || 'node'} is not a mapper`)
    return m[1].mappings
  }

  /** Inserts `field` right after the field named `after` (which must exist; `field.name` must not). */
  insertAfter (fields, after, field, what = '') {
    if (fields.some((x) => x.name === field.name)) throw new Error(`${what}: ${field.name} is there already`)
    const i = fields.findIndex((x) => x.name === after)
    if (i < 0) throw new Error(`${what}: no field ${after} to insert ${field.name} after`)
    fields.splice(i + 1, 0, field)
  }

  /** Appends fields after the last one, which must be `last`. */
  appendAfterLast (fields, last, added, what = '') {
    const tail = fields.at(-1)?.name
    if (tail !== last) throw new Error(`${what}: last field is ${tail}, expected ${last}`)
    for (const f of added) {
      if (fields.some((x) => x.name === f.name)) throw new Error(`${what}: ${f.name} is there already`)
      fields.push(f)
    }
  }

  /** Replaces the field `old` (with the given current type) by `field`. */
  replaceField (fields, old, oldType, field, what = '') {
    const i = fields.findIndex((x) => x.name === old)
    if (i < 0) throw new Error(`${what}: no field ${old}`)
    if (JSON.stringify(fields[i].type) !== JSON.stringify(oldType)) throw new Error(`${what}: ${old} is ${JSON.stringify(fields[i].type)}, expected ${JSON.stringify(oldType)}`)
    fields[i] = field
  }

  addMapping (mappings, key, value, what = '') {
    if (key in mappings) throw new Error(`${what}: mapping ${key} is ${mappings[key]} already`)
    mappings[key] = value
  }

  renameMapping (mappings, key, from, to, what = '') {
    if (mappings[key] !== from) throw new Error(`${what}: mapping ${key} is ${mappings[key]}, expected ${from}`)
    mappings[key] = to
  }

  /** Defines a new type (must not exist). */
  defineType (name, def) {
    if (name in this.types) throw new Error(`type ${name} exists already`)
    this.types[name] = def
  }

  /** Replaces an existing type wholesale (its current JSON must equal `expect` when given). */
  redefineType (name, def, expect) {
    const cur = this.type(name)
    if (expect !== undefined && JSON.stringify(cur) !== JSON.stringify(expect)) throw new Error(`type ${name} differs from what the edit expects`)
    this.types[name] = def
  }

  deleteType (name) {
    this.type(name)
    const users = Object.keys(this.types).filter((k) => k !== name && JSON.stringify(this.types[k]).includes(`"${name}"`))
    if (users.length) throw new Error(`type ${name} is still used by ${users.join(', ')}`)
    delete this.types[name]
  }

  packetTable () {
    const top = this.fields('mcpe_packet')
    const ids = this.mappings(this.field(top, 'name', 'mcpe_packet'), 'mcpe_packet name')
    const sw = this.switchOf(top, 'params', 'mcpe_packet')
    return { ids, sw }
  }

  /** Adds packet `name` (without the `packet_` prefix) with id `id`. */
  addPacket (id, name, def) {
    const { ids, sw } = this.packetTable()
    if (String(id) in ids) throw new Error(`packet id ${id} is ${ids[String(id)]} already`)
    if (Object.values(ids).includes(name)) throw new Error(`packet ${name} exists already`)
    ids[String(id)] = name
    sw.fields[name] = `packet_${name}`
    this.defineType(`packet_${name}`, def)
  }

  /** Removes packet `name` with id `id` and its type. */
  removePacket (id, name) {
    const { ids, sw } = this.packetTable()
    if (ids[String(id)] !== name) throw new Error(`packet id ${id} is ${ids[String(id)]}, expected ${name}`)
    delete ids[String(id)]
    delete sw.fields[name]
    this.deleteType(`packet_${name}`)
  }

  run (edits) {
    for (const e of edits) {
      try {
        e.apply(this)
      } catch (err) {
        throw new Error(`edit "${e.name}": ${err.message}`)
      }
      this.done.push(e.name)
    }
    return this.protocol
  }
}

/** Applies a recipe's edits to the base protocol. Returns { protocol, edits }. */
export function deriveProtocol (baseProtocol, recipe) {
  const d = new Derivation(baseProtocol)
  const protocol = d.run(recipe.edits)
  return { protocol, edits: d.done }
}

/**
 * Writes a minecraft-data-shaped `data/` tree for make-patch's --from-dir into `outDir`: the derived
 * bedrock/<ver>/protocol.json and version.json, and the package's own dataPaths.json, common/protocolVersions.json
 * and common/versions.json with the version added (its dataPaths entry is the base's, protocol and version pointing
 * at the new folder, as minecraft-data's incrementVersion makes it). `pkgDir` is a pristine minecraft-data package.
 */
export function writeDerivedTree (pkgDir, recipe, outDir) {
  const data = join(pkgDir, 'minecraft-data', 'data')
  const read = (rel) => JSON.parse(readFileSync(join(data, rel), 'utf8'))
  const write = (rel, obj) => {
    const f = join(outDir, 'data', rel)
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(obj, null, 2) + '\n')
  }
  const { version: ver, protocol: number, base, releaseType } = recipe
  const paths = read('dataPaths.json')
  const baseEntry = paths.bedrock?.[base]
  if (!baseEntry) throw new Error(`dataPaths has no bedrock ${base}`)
  if (paths.bedrock[ver]) throw new Error(`dataPaths has bedrock ${ver} already: nothing to derive`)
  const baseProtocol = read(`${baseEntry.protocol}/protocol.json`)
  const { protocol, edits } = deriveProtocol(baseProtocol, recipe)
  write(`bedrock/${ver}/protocol.json`, protocol)
  const major = ver.split('.').slice(0, 2).join('.')
  write(`bedrock/${ver}/version.json`, { version: number, minecraftVersion: ver, majorVersion: major, releaseType })
  paths.bedrock[ver] = { ...baseEntry, protocol: `bedrock/${ver}`, version: `bedrock/${ver}` }
  write('dataPaths.json', paths)
  const pv = read('bedrock/common/protocolVersions.json')
  if (pv.some((e) => e.minecraftVersion === ver)) throw new Error(`protocolVersions lists ${ver} already`)
  pv.unshift({ version: number, minecraftVersion: ver, majorVersion: major, releaseType })
  write('bedrock/common/protocolVersions.json', pv)
  const vs = read('bedrock/common/versions.json')
  if (!vs.includes(ver)) {
    const i = vs.findIndex((v) => /^\d+(\.\d+)+$/.test(v) && cmpVer(v, ver) > 0)
    vs.splice(i < 0 ? vs.length : i, 0, ver)
  }
  write('bedrock/common/versions.json', vs)
  return { dir: outDir, edits, base, protocol: number }
}
