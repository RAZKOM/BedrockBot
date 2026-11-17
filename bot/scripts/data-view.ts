// The bot's view of the game data (decision 0094): what the world model makes of every block state a BDS palette
// holds and of every item a recorded login lists, with the block data installed now. Run it before and after a
// minecraft-data bump and diff the two; test/unit/world/data-pin.test.ts fails until the bump is looked at.
//
//   node scripts/data-view.ts dump <palette> <gameVersion> <out.json> [--items <fixtureVersion>]
//       <palette>       a bot/data/block-palette/<v>.json version (what BDS sends, dumped by dump-palette)
//       --items <v>     the item list of fixtures/<v>/login-idle.jsonl.gz (the server's item_registry)
//   node scripts/data-view.ts diff <a.json> <b.json> [out.json]
//
// Per block state: the name the registry resolves, whether the state is a block data state, a palette-only one or
// unknown, hardness, collision boxes, the terrain class (top, floor, liquid, danger, climbable, ...), mining data
// and break ticks with a dozen tools. Per item: the name the registry gives the runtime id, the stack size and the
// display name. The diff groups changes by field and block name and lists item stack and name changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createDeserializer } from '../src/connection/protocol.ts';
import { parseRecording } from '../src/connection/recorder.ts';
import { maxStackOf } from '../src/skills/container/chest.ts';
import { blockMining } from '../src/data/mining.ts';
import { breakTicks } from '../src/skills/dig/breakTime.ts';
import { itemRegistry } from '../src/skills/home/search.ts';
import { classify } from '../src/skills/terrain/classify.ts';
import { boxesOf } from '../src/skills/terrain/shapes.ts';
import { silentLogger } from '../src/log.ts';
import { BlockRegistry } from '../src/world/registry.ts';
import { fastBlockHash, loadPalette } from '../src/world/version-shims/palette.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TOOLS = [null, 'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'wooden_axe', 'iron_axe', 'wooden_shovel', 'iron_shovel', 'iron_hoe', 'iron_sword', 'shears'] as const;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

interface ItemState {
  name: string;
  runtime_id: number;
}

interface BlockRow {
  key: string;
  name: string;
  src: 'block data' | 'palette-only' | 'unknown';
  hardness: number;
  boxes: number[][];
  cls: Record<string, unknown>;
  mining: Record<string, unknown> | null;
  ticks: (number | string | null)[];
}

interface ItemRow {
  name: string;
  id: number;
  registryName: string | null;
  stack: number;
  display: string | null;
}

interface View {
  palette: string;
  gameVersion: string;
  blockData: string;
  stateCount: number;
  extra: number;
  unknownIds: number;
  blocks: BlockRow[];
  items: ItemRow[];
}

function fixtureItems(version: string): ItemState[] {
  const lines = parseRecording(gunzipSync(readFileSync(join(REPO, 'fixtures', version, 'login-idle.jsonl.gz'))).toString('utf8'));
  const des = createDeserializer(version);
  for (const line of lines) {
    if (line.dir !== 'in' || !line.raw || line.name !== 'item_registry') continue;
    const p = des.parsePacketBuffer(Buffer.from(line.raw, 'base64'));
    const itemstates = (p.data.params as { itemstates: ItemState[] }).itemstates;
    return itemstates.map((s) => ({ name: s.name, runtime_id: s.runtime_id }));
  }
  throw new Error(`fixtures/${version}/login-idle.jsonl.gz has no item_registry`);
}

function dump(palette: string, gameVersion: string, out: string, itemsFrom: string | undefined): void {
  const reg = new BlockRegistry({ version: gameVersion, logger: silentLogger });
  const items = itemsFrom ? fixtureItems(itemsFrom) : [];
  reg.handleStartGame({ block_network_ids_are_hashes: true, itemstates: [] } as never);
  reg.handleItemRegistry({ itemstates: items } as never);
  const pal = loadPalette(palette);
  if (!pal) throw new Error(`no palette ${palette} in bot/data/block-palette`);
  const blocks: BlockRow[] = [];
  for (const e of pal.entries) {
    const rid = fastBlockHash(e.name, e.states);
    const sid = reg.stateIdFromRuntimeId(rid);
    const info = reg.blockInfo(sid, rid);
    const c = classify(info);
    const m = blockMining(info.name);
    const plain = Object.fromEntries(Object.entries(e.states).map(([k, v]) => [k, (v as { value: unknown }).value]));
    blocks.push({
      key: `${e.name}|${JSON.stringify(plain)}`,
      name: info.name,
      src: sid < 0 ? 'unknown' : sid >= reg.blockDataStates ? 'palette-only' : 'block data',
      hardness: info.hardness,
      boxes: boxesOf(info).map((b) => b.map(r4)),
      cls: { top: r4(c.top), floor: c.floor, liquid: c.liquid ?? null, danger: c.danger, climbable: c.climbable, openable: c.openable ?? null, connect: c.connect ?? null, fullCube: c.fullCube, gravity: c.gravity, protect: c.protect, unknown: c.unknown },
      mining: m ? { hardness: m.hardness, effective: m.effective, harvest: m.harvest ?? null, material: m.material ?? null } : null,
      ticks: TOOLS.map((t) => breakTicks(info.name, t) ?? null).map((x) => (x === Infinity ? 'inf' : x)),
    });
  }
  const names = itemRegistry();
  const itemRows: ItemRow[] = items.map((i) => {
    const short = i.name.replace(/^minecraft:/, '');
    return { name: short, id: i.runtime_id, registryName: reg.itemName(i.runtime_id) ?? null, stack: maxStackOf(short), display: names.get(short) ?? null };
  });
  const view: View = { palette, gameVersion, blockData: reg.blockDataSource, stateCount: reg.stateCount, extra: reg.extraStateCount, unknownIds: reg.unknownRuntimeIds.size, blocks, items: itemRows };
  writeFileSync(out, JSON.stringify(view));
  const bySrc: Record<string, number> = {};
  for (const b of blocks) bySrc[b.src] = (bySrc[b.src] ?? 0) + 1;
  console.log(JSON.stringify({ out, palette, states: pal.entries.length, ...bySrc, stateCount: reg.stateCount, extra: reg.extraStateCount, items: itemRows.length, itemsMissing: itemRows.filter((i) => !i.display).length }));
}

function diff(aFile: string, bFile: string, out: string | undefined): void {
  const A = JSON.parse(readFileSync(aFile, 'utf8')) as View;
  const B = JSON.parse(readFileSync(bFile, 'utf8')) as View;
  const bBy = new Map(B.blocks.map((b) => [b.key, b]));
  const fields: Record<string, (x: BlockRow) => unknown> = {
    src: (x) => x.src,
    hardness: (x) => x.hardness,
    boxes: (x) => JSON.stringify(x.boxes),
    cls: (x) => JSON.stringify(x.cls),
    mining: (x) => JSON.stringify(x.mining && { ...x.mining, material: undefined }),
    material: (x) => x.mining?.material ?? null,
    ticks: (x) => JSON.stringify(x.ticks),
  };
  const byField: Record<string, Map<string, { states: number; a: unknown; b: unknown; key: string }>> = {};
  const missing: string[] = [];
  for (const a of A.blocks) {
    const b = bBy.get(a.key);
    if (!b) {
      missing.push(a.key);
      continue;
    }
    for (const [f, get] of Object.entries(fields)) {
      const va = get(a);
      const vb = get(b);
      if (va === vb) continue;
      const m = (byField[f] ??= new Map());
      const e = m.get(a.name);
      if (e) e.states++;
      else m.set(a.name, { states: 1, a: va, b: vb, key: a.key });
    }
  }
  const summary = Object.fromEntries(Object.entries(byField).map(([f, m]) => [f, { blocks: m.size, states: [...m.values()].reduce((s, e) => s + e.states, 0) }]));
  const iBy = new Map(B.items.map((i) => [i.name, i]));
  const stack: string[] = [];
  const display: string[] = [];
  const registryName: string[] = [];
  for (const i of A.items) {
    const j = iBy.get(i.name);
    if (!j) continue;
    if (i.stack !== j.stack) stack.push(`${i.name} ${i.stack} -> ${j.stack}`);
    if (i.display !== j.display) display.push(`${i.name}: ${i.display} -> ${j.display}`);
    if (i.registryName !== j.registryName) registryName.push(`${i.id}: ${i.registryName} -> ${j.registryName}`);
  }
  const res = {
    a: { file: aFile, blockData: A.blockData, stateCount: A.stateCount, extra: A.extra },
    b: { file: bFile, blockData: B.blockData, stateCount: B.stateCount, extra: B.extra },
    summary,
    missing: missing.length,
    items: { stack: stack.length, display: display.length, registryName: registryName.length },
    details: Object.fromEntries(Object.entries(byField).map(([f, m]) => [f, Object.fromEntries(m)])),
    stack,
    display,
    registryName,
  };
  if (out) writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ summary, missing: res.missing, items: res.items }, null, 1));
}

const args = process.argv.slice(2).filter((a, i) => !(a === '--' && i === 0));
const itemsAt = args.indexOf('--items');
const itemsFrom = itemsAt >= 0 ? args.splice(itemsAt, 2)[1] : undefined;
const [cmd, ...rest] = args;
if (cmd === 'dump' && rest.length === 3) dump(rest[0]!, rest[1]!, rest[2]!, itemsFrom);
else if (cmd === 'diff' && rest.length >= 2) diff(rest[0]!, rest[1]!, rest[2]);
else {
  console.error('usage: node scripts/data-view.ts dump <palette> <gameVersion> <out.json> [--items <fixtureVersion>]\n       node scripts/data-view.ts diff <a.json> <b.json> [out.json]');
  process.exit(2);
}
