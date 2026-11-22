// Java block ids and states to Bedrock (Track B2, docs/build.md "Java blocks", ADR 0125). One data file
// (java-blocks.json) holds every rule: renames, regex renames, states that pick another block, the state rules
// by family, and MCEdit's numeric ids. This module applies them and checks each result against the game's own
// block list (bot/data/block-palette/<version>.json): a name the game does not know is never produced, and a
// state is kept only when the Bedrock block has that state and that value. A block that maps to nothing comes
// back as unknown with its reason (a mod's namespace, a Java-only block, no Bedrock block of that name).
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_VERSION } from '../../../config/defaults.ts';
import { palettePath } from '../../../world/version-shims/palette.ts';

export type BedrockStates = Record<string, string | number>;

/** A Java block state: `minecraft:oak_stairs[facing=east,half=bottom]` parsed. */
export interface JavaBlock {
  /** Namespace (`minecraft`, or a mod's). */
  ns: string;
  /** Id without namespace (`oak_stairs`). */
  id: string;
  props: Record<string, string>;
}

export type Mapped = { ok: true; name: string; states: BedrockStates } | { ok: false; java: string; reason: string };

type Conv = 'same' | 'bool' | 'not' | 'int' | 'int-1' | Record<string, string | number>;
interface StateRule {
  match: string;
  map?: Record<string, [string, Conv]>;
  set?: BedrockStates;
  bits?: [string, Record<string, number>];
}
type LegacyEntry = string | string[] | ({ kind: string } & Record<string, unknown>);
interface JavaData {
  format: number;
  air: string[];
  rename: Record<string, string>;
  patterns: [string, string][];
  byState: { java: string; prop: string; value: string; bedrock: string }[];
  states: StateRule[];
  colors: string[];
  legacy: Record<string, LegacyEntry>;
  javaIds: string[];
  javaOnly: Record<string, string>;
}

/** The mapping's data file, as read. */
export const JAVA_DATA: JavaData = JSON.parse(readFileSync(new URL('./java-blocks.json', import.meta.url), 'utf8')) as JavaData;
if (JAVA_DATA.format !== 1) throw new Error(`java-blocks.json: unknown format ${JAVA_DATA.format}`);

const PATTERNS = JAVA_DATA.patterns.map(([re, to]) => [new RegExp(re), to] as const);
const RULES = JAVA_DATA.states.map((r) => ({ ...r, re: new RegExp(r.match) }));
const AIR = new Set(JAVA_DATA.air);

// ---- the game's block list --------------------------------------------------------------------------------

export interface StateDef {
  type: 'byte' | 'int' | 'string';
  values: readonly (string | number)[];
}
/** Bedrock block name -> its states and their values. */
export type BlockSchema = ReadonlyMap<string, ReadonlyMap<string, StateDef>>;

const schemas = new Map<string, BlockSchema | null>();
const TAGS = ['byte', 'int', 'string'] as const;

/** Block names and their states for a game version, from the dumped palette (no permutations expanded). */
export function blockSchema(version: string = DEFAULT_VERSION): BlockSchema | undefined {
  const hit = schemas.get(version);
  if (hit !== undefined) return hit ?? undefined;
  const path = palettePath(version);
  if (!existsSync(path)) {
    schemas.set(version, null);
    return undefined;
  }
  const f = JSON.parse(readFileSync(path, 'utf8')) as { format: number; strings: string[]; blocks: [number, [number, number, (number | string)[]][], number, unknown][] };
  if (f.format !== 1) throw new Error(`${path}: unknown palette format ${f.format}`);
  const S = f.strings;
  const out = new Map<string, Map<string, StateDef>>();
  for (const [nameIdx, states] of f.blocks) {
    const m = new Map<string, StateDef>();
    for (const [k, tag, vals] of states) {
      const type = TAGS[tag]!;
      m.set(S[k]!, { type, values: type === 'string' ? vals.map((v) => S[v as number]!) : vals });
    }
    out.set(S[nameIdx]!, m);
  }
  schemas.set(version, out);
  return out;
}

// ---- parsing ------------------------------------------------------------------------------------------------

/** Parse `minecraft:oak_log[axis=x]` (namespace optional, as in Sponge and Litematica palettes). */
export function parseJavaState(s: string): JavaBlock {
  const t = s.trim();
  const open = t.indexOf('[');
  const head = (open < 0 ? t : t.slice(0, open)).toLowerCase();
  const colon = head.indexOf(':');
  const ns = colon < 0 ? 'minecraft' : head.slice(0, colon);
  const id = colon < 0 ? head : head.slice(colon + 1);
  const props: Record<string, string> = {};
  if (open >= 0) {
    const body = t.slice(open + 1, t.endsWith(']') ? -1 : undefined);
    for (const part of body.split(',')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      props[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase();
    }
  }
  return { ns, id, props };
}

/** `minecraft:oak_log[axis=x]` back from a JavaBlock (props in key order). */
export function formatJavaState(b: JavaBlock): string {
  const keys = Object.keys(b.props).sort();
  return `${b.ns}:${b.id}${keys.length ? `[${keys.map((k) => `${k}=${b.props[k]}`).join(',')}]` : ''}`;
}

/** A Litematica or vanilla-structure palette entry `{ Name, Properties }` as a JavaBlock. */
export function javaBlockOf(entry: { Name?: unknown; Properties?: unknown }): JavaBlock {
  const b = parseJavaState(typeof entry.Name === 'string' ? entry.Name : 'minecraft:air');
  const p = entry.Properties;
  if (p && typeof p === 'object') for (const [k, v] of Object.entries(p as Record<string, unknown>)) b.props[k.toLowerCase()] = String(v).toLowerCase();
  return b;
}

// ---- names --------------------------------------------------------------------------------------------------

/** The Bedrock name rules give for a Java id (renames, then the regex renames), before any check. */
export function bedrockNameOf(id: string): string {
  const r = JAVA_DATA.rename[id];
  if (r) return r;
  for (const [re, to] of PATTERNS) if (re.test(id)) return id.replace(re, to);
  return id;
}

function doubleSlab(name: string, schema: BlockSchema): string | undefined {
  for (const n of [name.replace(/_slab$/, '_double_slab'), name.replace(/cut_copper_slab$/, 'double_cut_copper_slab')]) if (n !== name && schema.has(n)) return n;
  return undefined;
}

function convert(c: Conv, v: string): string | number | undefined {
  if (c === 'same') return v;
  if (c === 'bool') return v === 'true' ? 1 : v === 'false' ? 0 : undefined;
  if (c === 'not') return v === 'true' ? 0 : v === 'false' ? 1 : undefined;
  if (c === 'int' || c === 'int-1') {
    const n = Number(v);
    if (!Number.isInteger(n)) return undefined;
    return c === 'int' ? n : n - 1;
  }
  return c[v];
}

function allowed(def: StateDef | undefined, v: string | number | undefined): v is string | number {
  if (!def || v === undefined) return false;
  if (def.type === 'string' ? typeof v !== 'string' : typeof v !== 'number') return false;
  return def.values.includes(v);
}

/** A Java block state to a Bedrock block name and states (checked against the game's block list). */
export function javaToBedrock(b: JavaBlock, version: string = DEFAULT_VERSION): Mapped {
  const java = formatJavaState(b);
  if (b.ns !== 'minecraft') return { ok: false, java, reason: 'not a Bedrock block' };
  if (AIR.has(b.id)) return { ok: true, name: 'air', states: {} };
  const only = JAVA_DATA.javaOnly[b.id];
  if (only) return { ok: false, java, reason: only };
  const schema = blockSchema(version);
  if (!schema) return { ok: false, java, reason: `no block list for ${version}` };
  const used = new Set<string>();
  let name: string | undefined;
  for (const r of JAVA_DATA.byState) {
    if (r.java !== b.id) continue;
    const v = b.props[r.prop];
    if (v === undefined || (r.value !== '*' && v !== r.value)) continue;
    name = r.bedrock.replace('$', v);
    used.add(r.prop);
    break;
  }
  name ??= bedrockNameOf(b.id);
  if (b.id.endsWith('_slab') && b.props.type === 'double') {
    const d = doubleSlab(name, schema);
    if (d) {
      name = d;
      used.add('type');
    }
  }
  const def = schema.get(name);
  if (!def) return { ok: false, java, reason: 'not a Bedrock block' };
  const states: BedrockStates = {};
  for (const [prop, value] of Object.entries(b.props)) {
    if (used.has(prop)) continue;
    for (const r of RULES) {
      const m = r.map?.[prop];
      if (!m || !r.re.test(b.id)) continue;
      const [key, conv] = m;
      if (!def.has(key) || key in states) continue;
      const v = convert(conv, value);
      if (allowed(def.get(key), v)) states[key] = v;
      break;
    }
  }
  for (const r of RULES) {
    if (!r.re.test(b.id)) continue;
    if (r.bits) {
      const [key, bits] = r.bits;
      if (def.has(key) && !(key in states)) {
        let n = 0;
        for (const [side, bit] of Object.entries(bits)) if (b.props[side] === 'true') n |= bit;
        if (allowed(def.get(key), n)) states[key] = n;
      }
    }
    for (const [key, v] of Object.entries(r.set ?? {})) if (def.has(key) && !(key in states) && allowed(def.get(key), v)) states[key] = v;
  }
  return { ok: true, name, states };
}

/** Map a Java state string (`minecraft:oak_log[axis=x]`). */
export const mapJavaState = (s: string, version?: string): Mapped => javaToBedrock(parseJavaState(s), version);

// ---- MCEdit numeric ids -------------------------------------------------------------------------------------

const H4: Record<string, string[]> = {
  // the 2-bit horizontal orders the pre-1.13 blocks use
  sw: ['south', 'west', 'north', 'east'],
  ew: ['east', 'west', 'south', 'north'],
  door: ['east', 'south', 'west', 'north'],
  trap: ['north', 'south', 'west', 'east'],
};
const F6 = ['down', 'up', 'north', 'south', 'west', 'east'];

/**
 * The Java block state an MCEdit `.schematic` numeric id and data value stand for (Java 1.12 and before), or
 * undefined when the table does not know the id (a mod's block, or an id vanilla never used).
 */
export function legacyToJava(id: number, data: number): string | undefined {
  const e = JAVA_DATA.legacy[String(id)];
  if (e === undefined) return undefined;
  const d = data & 15;
  const pick = (names: readonly string[], i: number): string => names[i] ?? names[0]!;
  const withProps = (base: string, props: Record<string, string | number | boolean>): string => {
    const b = parseJavaState(base);
    for (const [k, v] of Object.entries(props)) b.props[k] = String(v);
    return formatJavaState(b);
  };
  if (typeof e === 'string') return withProps(e, {});
  if (Array.isArray(e)) return withProps(pick(e, d), {});
  const s = (k: string): string => String(e[k]);
  const names = (e.names as string[] | undefined) ?? [];
  switch (e.kind) {
    case 'mask':
      return withProps(pick(names, d & Number(e.mask)), {});
    case 'log': {
      const wood = pick(e.woods as string[], d & 3);
      const axis = (d >> 2) & 3;
      return axis === 3 ? withProps(`${wood}_wood`, { axis: 'y' }) : withProps(`${wood}_log`, { axis: ['y', 'x', 'z'][axis]! });
    }
    case 'leaves':
      return withProps(`${pick(e.woods as string[], d & 3)}_leaves`, { persistent: (d & 4) !== 0 });
    case 'bed':
      return withProps('red_bed', { facing: H4.sw![d & 3]!, part: d & 8 ? 'head' : 'foot' });
    case 'colors':
      return withProps(`${JAVA_DATA.colors[d]!}${s('suffix')}`, {});
    case 'slab':
      return withProps(pick(names, d & 7), { type: e.double ? 'double' : d & 8 ? 'top' : 'bottom' });
    case 'torch':
      return d >= 1 && d <= 4 ? withProps(s('wall'), { facing: ['east', 'west', 'south', 'north'][d - 1]! }) : withProps(s('name'), {});
    case 'stairs':
      return withProps(s('name'), { facing: H4.ew![d & 3]!, half: d & 4 ? 'top' : 'bottom' });
    case 'facing6': {
      const order = (e.order as string[] | undefined) ?? F6;
      const f = order[d] ?? 'north';
      return withProps(s('name'), { facing: e.order ? f : f === 'down' || f === 'up' ? 'north' : f });
    }
    case 'facing4':
      return withProps(s('name'), { facing: H4.sw![d & 3]! });
    case 'age':
      return withProps(s('name'), { age: d });
    case 'farmland':
      return withProps('farmland', { moisture: d & 7 });
    case 'sign':
      return withProps(s('name'), { rotation: d });
    case 'door':
      return d & 8 ? withProps(s('name'), { half: 'upper', hinge: d & 1 ? 'right' : 'left' }) : withProps(s('name'), { half: 'lower', facing: H4.door![d & 3]!, open: (d & 4) !== 0 });
    case 'trapdoor':
      return withProps(s('name'), { facing: H4.trap![d & 3]!, open: (d & 4) !== 0, half: d & 8 ? 'top' : 'bottom' });
    case 'gate':
      return withProps(s('name'), { facing: H4.sw![d & 3]!, open: (d & 4) !== 0 });
    case 'layers':
      return withProps('snow', { layers: (d & 7) + 1 });
    case 'cake':
      return withProps('cake', { bites: Math.min(6, d) });
    case 'vine':
      return withProps('vine', { south: (d & 1) !== 0, west: (d & 2) !== 0, north: (d & 4) !== 0, east: (d & 8) !== 0 });
    case 'anvil':
      return withProps(['anvil', 'chipped_anvil', 'damaged_anvil'][(d >> 2) & 3] ?? 'anvil', { facing: H4.sw![d & 3]! });
    case 'axis':
      return withProps(s('name'), { axis: ['y', 'x', 'z'][(d >> 2) & 3] ?? 'y' });
    case 'glazed':
      return withProps(`${s('color')}_glazed_terracotta`, { facing: H4.sw![d & 3]! });
    default:
      return undefined;
  }
}
