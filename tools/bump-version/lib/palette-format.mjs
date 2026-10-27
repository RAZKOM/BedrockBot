// Compact block palette file (wave 8, Track AC; read by bot/src/world/version-shims/palette.ts).
//
// {
//   format: 1, version: "1.26.60", bds: "1.26.60.6", dumped: ISO time, source: "...",
//   types: <block types>, permutations: <permutations>,
//   probe: { placed, verified, dropped: { stateName: <types> }, unverified: [names], inferred: { name: [dropped] } }
//   strings: [...],                 interned: block names (no `minecraft:` prefix), state names, string values
//   blocks: [[name, states, def, perms], ...]   sorted by name
//     name    string index
//     states  [[stateName, tag, values], ...] sorted by state name; tag 0 = byte, 1 = int, 2 = string;
//             values = the values that occur in this block's permutations (byte 0/1, ints, string indices)
//     def     index of the default permutation in the cartesian product of `values`
//             (mixed radix, the last state fastest)
//     perms   null when every combination is a permutation, else the sorted product indices that are
// }
const TAG = { byte: 0, int: 1, string: 2 };

/** Strip the vanilla namespace (minecraft-data's naming); other namespaces stay. */
export function shortName(name) {
  return name.startsWith('minecraft:') ? name.slice(10) : name;
}

/**
 * Builds the compact file from truth:palette permutations ({ name, states: [{ name, type, value }], default? }).
 * @param {{ name: string, states: { name: string, type: 'byte'|'int'|'string', value: boolean|number|string }[], default?: boolean }[]} perms
 * @param {{ version: string, bds: string, dumped?: string, source?: string }} meta
 */
export function compactPalette(perms, meta) {
  const strings = [];
  const ids = new Map();
  const intern = (s) => {
    let i = ids.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      ids.set(s, i);
    }
    return i;
  };
  const byBlock = new Map();
  for (const p of perms) {
    const name = shortName(p.name);
    let list = byBlock.get(name);
    if (!list) byBlock.set(name, (list = []));
    list.push(p);
  }
  const blocks = [];
  let count = 0;
  for (const name of [...byBlock.keys()].sort()) {
    const list = byBlock.get(name);
    const keys = list[0].states.map((s) => s.name).sort();
    const tags = keys.map((k) => list[0].states.find((s) => s.name === k).type);
    const enc = (tag, v) => (tag === 'byte' ? (v === true || v === 1 ? 1 : 0) : tag === 'int' ? Number(v) : v);
    const valueSets = keys.map(() => []);
    for (const p of list) {
      if (p.states.length !== keys.length) throw new Error(`${name}: permutations with different state sets`);
      for (let i = 0; i < keys.length; i++) {
        const s = p.states.find((x) => x.name === keys[i]);
        if (!s) throw new Error(`${name}: permutation without ${keys[i]}`);
        const v = enc(tags[i], s.value);
        if (!valueSets[i].includes(v)) valueSets[i].push(v);
      }
    }
    for (let i = 0; i < keys.length; i++) {
      if (tags[i] === 'string') valueSets[i].sort();
      else valueSets[i].sort((a, b) => a - b);
    }
    const index = (p) => {
      let n = 0;
      for (let i = 0; i < keys.length; i++) {
        const s = p.states.find((x) => x.name === keys[i]);
        n = n * valueSets[i].length + valueSets[i].indexOf(enc(tags[i], s.value));
      }
      return n;
    };
    let product = 1;
    for (const v of valueSets) product *= v.length;
    const idx = [...new Set(list.map(index))].sort((a, b) => a - b);
    const def = list.find((p) => p.default) ?? list[0];
    blocks.push([
      intern(name),
      keys.map((k, i) => [intern(k), TAG[tags[i]], tags[i] === 'string' ? valueSets[i].map(intern) : valueSets[i]]),
      index(def),
      idx.length === product ? null : idx,
    ]);
    count += idx.length;
  }
  return {
    format: 1,
    version: meta.version,
    bds: meta.bds,
    dumped: meta.dumped ?? new Date().toISOString(),
    source: meta.source ?? 'truth:palette (BlockTypes.getAll, BlockStates validValues, BlockPermutation.resolve)',
    types: blocks.length,
    permutations: count,
    ...(meta.probe ? { probe: meta.probe } : {}),
    strings,
    blocks,
  };
}

/**
 * The Script API reports flattened-away legacy states next to the real ones (`color` on every
 * `*_stained_glass_pane`, `wall_block_type` on every wall, `top_slot_bit` next to
 * `minecraft:vertical_half` on slabs, ...); the network hash leaves them out. Given the wire runtime ids
 * seen for a block type (blocks placed with truth:palettestrip and read back by a client), finds the
 * smallest set of state names to drop so that a seen id is the hash of some permutation without them.
 * @param {string} name block name
 * @param {{ states: { name: string, type: string, value: unknown }[] }[]} perms Script API permutations of the type
 * @param {Set<number>} seen wire runtime ids seen for the type
 * @param {(name: string, states: Record<string, { type: string, value: unknown }>) => number} hash blockHash
 * @returns {string[] | undefined} state names to drop ([] = none), undefined when no subset explains the ids
 */
export function legacyStates(name, perms, seen, hash) {
  const keys = perms[0]?.states.map((s) => s.name).sort() ?? [];
  const sets = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) sets.push(keys.filter((_, i) => mask & (1 << i)));
  sets.sort((a, b) => a.length - b.length);
  for (const drop of sets) {
    const hashes = new Set();
    for (const p of perms) {
      const typed = {};
      for (const s of p.states) {
        if (drop.includes(s.name)) continue;
        typed[s.name] = { type: s.type, value: s.type === 'byte' ? (s.value === true || s.value === 1 ? 1 : 0) : s.value };
      }
      hashes.add(hash(name, typed));
    }
    // Some, not every: a probe position can also report what the block turned into (concrete powder
    // next to water, a sapling that grew); a 32-bit hash match of the wrong key set does not happen in practice.
    if ([...seen].some((rid) => hashes.has(rid))) return drop;
  }
  return undefined;
}

/** The permutations without the dropped states. */
export function withoutStates(perms, drop) {
  if (drop.length === 0) return perms;
  return perms.map((p) => ({ ...p, states: p.states.filter((s) => !drop.includes(s.name)) }));
}

/** Serialises the file: one block per line, so a re-dump diffs per block. */
export function stringifyPalette(file) {
  const { strings, blocks, ...head } = file;
  const lines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push(`  "strings": ${JSON.stringify(strings)},`);
  lines.push('  "blocks": [');
  blocks.forEach((b, i) => lines.push(`    ${JSON.stringify(b)}${i === blocks.length - 1 ? '' : ','}`));
  lines.push('  ]');
  return `{\n${lines.join('\n')}\n}\n`;
}
