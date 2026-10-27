#!/usr/bin/env node
// Dumps a BDS's block palette into bot/data/block-palette/<version>.json (wave 8, Track AC; docs/versions.md
// "Block states"). The world registry builds its runtime-id table from that file for that game version.
//
//   node tools/bump-version/dump-palette.mjs --profile reg              bds-reg (udp/19192, truth pack deployed)
//   node tools/bump-version/dump-palette.mjs --container bds-x --port 19999 [--version 1.26.61] [--out file]
//
// How (about 1 minute): joins the local BDS as an offline player (the truth pack answers in chat), then
// 1. pages through `truth:palette <from> <count>`: every block type, every combination of its states'
//    valid values that BlockPermutation.resolve accepts (Script API view);
// 2. probes the network view: places the default permutation of every type (`truth:palettestrip`, 256
//    per batch, 2 apart, at x and z -16..15, y -60 of the flat world), reads the runtime ids the server sends
//    for them, and per type drops the legacy states the network hash leaves out (lib/palette-format.mjs
//    legacyStates); types whose ids no state subset explains are listed as `unverified`;
// 3. writes the compact file (lib/palette-format.mjs).
// The game version defaults to the BDS build without its 4th part (1.26.60.6 -> 1.26.60), read from the
// container's VERSION. Local containers only: host 127.0.0.1, offline mode, nothing else is contacted.
import { execFile, execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Connection } from '../../bot/src/connection/connection.ts';
import { silentLogger } from '../../bot/src/log.ts';
import { World } from '../../bot/src/world/index.ts';
import { blockHash } from '../../bot/src/world/registry.ts';
import { ReplyParser, textOf } from '../../packs/truth/src/protocol.ts';
import { compactPalette, legacyStates, stringifyPalette, withoutStates } from './lib/palette-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILES = { reg: { container: 'bds-reg', port: 19192 } };

const { values: opts } = parseArgs({
  options: {
    profile: { type: 'string' },
    container: { type: 'string' },
    port: { type: 'string' },
    version: { type: 'string' },
    out: { type: 'string' },
    page: { type: 'string', default: '40' },
  },
});
const prof = opts.profile ? PROFILES[opts.profile] : undefined;
if (opts.profile && !prof) throw new Error(`unknown profile ${opts.profile} (${Object.keys(PROFILES).join(', ')})`);
const container = opts.container ?? prof?.container ?? 'bds-reg';
const port = Number(opts.port ?? prof?.port ?? 19192);
const bds = execFileSync('docker', ['exec', container, 'printenv', 'VERSION'], { encoding: 'utf8' }).trim();
if (!/^\d+\.\d+\.\d+\.\d+$/.test(bds)) throw new Error(`container ${container} has VERSION "${bds}"; pass --version`);
const version = opts.version ?? bds.split('.').slice(0, 3).join('.');
const out = opts.out ?? join(ROOT, 'bot', 'data', 'block-palette', `${version}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendCommand(...words) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', container, 'send-command', ...words], (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve()));
  });
}

const conn = new Connection({ version, username: `Palette${randomInt(36 ** 5).toString(36)}`, logger: silentLogger, reconnect: false });
// The world model decodes the probe strip; its registry may still be the fallback data (unknown ids are fine here).
const world = new World(conn, { version, logger: silentLogger });
const parser = new ReplyParser();
const pending = new Map();
conn.on('text', (p) => {
  let r;
  try {
    r = parser.feed(textOf(p));
  } catch {
    return;
  }
  const fn = r?.id != null ? pending.get(r.id) : undefined;
  if (fn) {
    pending.delete(r.id);
    fn(r);
  }
});
const tag = `p${randomInt(36 ** 5).toString(36)}`;
let seq = 0;
function truth(cmd, args, timeoutMs = 30_000) {
  const id = `${tag}x${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for truth:${cmd} #${id}`));
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      if (!r.ok) reject(new Error(`truth:${cmd} ${args.join(' ')} failed: ${r.reason} ${JSON.stringify(r.data)}`));
      else resolve(r.data);
    });
    sendCommand('scriptevent', `truth:${cmd}`, `#${id}`, ...args.map(String)).catch((e) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    });
  });
}

const t0 = performance.now();
console.error(`[dump-palette] ${container} (BDS ${bds}) udp/${port}, game version ${version}`);
await conn.connect({ kind: 'bds', host: '127.0.0.1', port, transport: 'raknet', offline: true });
await world.waitForChunks(3, { timeoutMs: 30_000 });
const byType = new Map();
let skipped = 0;
let pages = 0;
let total = 0;
let placed = 0;
const seen = new Map();
try {
  // 1. Script API permutations
  for (let from = 0; from !== null; ) {
    const d = await truth('palette', [from, Number(opts.page)]);
    pages++;
    total = d.total;
    skipped += d.skipped;
    for (const p of d.permutations) {
      let list = byType.get(p.name);
      if (!list) byType.set(p.name, (list = []));
      list.push(p);
    }
    process.stderr.write(`\r[dump-palette] palette: ${d.next ?? d.total}/${d.total} types`);
    from = d.next;
  }
  process.stderr.write('\n');
  // 2. network probe: default permutations in batches of 256, 2 blocks apart (no neighbour pops each
  // other off). Every layer-0 runtime id the server sends for a probe position during its batch counts
  // (a door half or a crop on grass may be placed and then pop off a tick later).
  const X = -16, Y = -60, Z = -16, COLS = 16, N = 256, STRIDE = 2;
  const span = STRIDE * COLS;
  const clear = () => truth('fill', [X - 8, Y - 1, Z - 8, X + span + 7, Y + 8, Z + span + 7, 'air']).then(() => truth('fill', [X - 8, Y - 1, Z - 8, X + span + 7, Y - 1, Z + span + 7, 'grass_block']));
  let batch = new Map();
  const note = (pos, rid, layer) => {
    if (layer !== 0) return;
    const set = batch.get(`${pos.x},${pos.y},${pos.z}`);
    if (set) set.add(rid | 0);
  };
  conn.on('update_block', (p) => note(p.position, p.block_runtime_id, p.layer));
  conn.on('update_subchunk_blocks', (p) => {
    for (const b of p.blocks ?? []) note(b.position, b.runtime_id, 0);
  });
  const airRid = blockHash('air', {});
  for (let from = 0; from < total; from += N) {
    await clear();
    await sleep(300);
    batch = new Map();
    for (let i = 0; i < Math.min(N, total - from); i++) batch.set(`${X + STRIDE * (i % COLS)},${Y},${Z + STRIDE * Math.floor(i / COLS)}`, new Set());
    const strip = await truth('palettestrip', [X, Y, Z, from, N, COLS, STRIDE]);
    await sleep(1500);
    for (const b of strip.placed) {
      const set = batch.get(`${b.x},${b.y},${b.z}`);
      const now = world.chunks.runtimeIdAt(b.x, b.y, b.z);
      if (now !== undefined) set.add(now | 0);
      set.delete(airRid);
      if (set.size > 0) placed++;
      let all = seen.get(b.typeId);
      if (!all) seen.set(b.typeId, (all = new Set()));
      for (const rid of set) all.add(rid);
    }
    process.stderr.write(`\r[dump-palette] probe: ${Math.min(total, from + N)}/${total} types`);
  }
  await clear();
  process.stderr.write('\n');
} finally {
  world.dispose();
  await conn.disconnectAndFlush('palette dumped');
}
// 3. drop legacy states, compact, write
const perms = [];
const dropped = {};
const kept = {};
const unverified = [];
const drops = new Map();
let verified = 0;
for (const [name, list] of byType) {
  const ids = seen.get(name);
  const d = ids ? legacyStates(name, list, ids, blockHash) : undefined;
  if (d === undefined) {
    unverified.push(name);
    continue;
  }
  verified++;
  drops.set(name, d);
  for (const s of list[0].states) {
    if (d.includes(s.name)) dropped[s.name] = (dropped[s.name] ?? 0) + 1;
    else kept[s.name] = (kept[s.name] ?? 0) + 1;
  }
}
// Types the probe could not place (liquids, bubble columns, soul fire ...): drop the states that the
// verified types mostly drop (e.g. `color` on concrete powder); the result is listed as `inferred`.
const inferred = {};
for (const name of unverified) {
  const d = byType.get(name)[0].states.map((s) => s.name).filter((k) => (dropped[k] ?? 0) > (kept[k] ?? 0));
  drops.set(name, d);
  if (d.length) inferred[name] = d;
}
for (const [name, list] of byType) for (const p of withoutStates(list, drops.get(name))) perms.push(p);
unverified.sort();
const file = compactPalette(perms, { version, bds, probe: { placed, verified, dropped, unverified, inferred } });
if (file.types !== total) throw new Error(`expected ${total} types, got ${file.types}`);
const text = stringifyPalette(file);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
const result = { out, version, bds, types: file.types, permutations: file.permutations, scriptApiPermutations: [...byType.values()].reduce((n, l) => n + l.length, 0), skippedCombinations: skipped, pages, placed, verified, unverified, bytes: Buffer.byteLength(text), ms: Math.round(performance.now() - t0) };
console.log(JSON.stringify(result));
setTimeout(() => process.exit(0), 300);
