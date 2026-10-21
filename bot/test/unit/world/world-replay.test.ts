// Replays fixtures/<FIXTURE_VERSION>/world-chunks.jsonl.gz (default 1.26.60; recorded by
// test/e2e/world-record.test.ts against bds-world or bds60) into the World and checks it against the
// truth-pack replies inside the capture, offline.
import { describe, expect, it } from 'vitest';
import { ReplyParser, rleDecode, textOf, type Reply } from '../../../../packs/truth/src/protocol.ts';
import { silentLogger } from '../../../src/log.ts';
import { typeIdOf } from '../../../src/world/checksum.ts';
import { World } from '../../../src/world/index.ts';
import type { Vec3 } from '../../../src/world/types.ts';
import { decodedInbound, FIXTURE_VERSION, loadFixture, ReplaySource } from './helpers.ts';

const FIXTURE = 'world-chunks.jsonl.gz';

interface BlocksData {
  from: Vec3;
  size: Vec3;
  palette: string[];
  runs: [number, number][];
}

describe(`fixture ${FIXTURE_VERSION}/world-chunks replayed into the world model`, () => {
  const src = new ReplaySource();
  const world = new World(src, { version: FIXTURE_VERSION, logger: silentLogger, defer: (fn) => fn() });
  const firstSeen = new Map<bigint, Vec3>();
  world.entityTracker.onAdd((e) => firstSeen.set(e.uniqueId, { ...e.pos }));
  const updates: string[] = [];
  world.onBlockUpdate((p, _b, after) => updates.push(`${p.x},${p.y},${p.z}=${after.name}`));
  const parser = new ReplyParser();
  const checks: { reply: Reply; result: string }[] = [];
  const replies: Reply[] = [];

  // Checks run at the moment each truth reply arrives in the stream.
  const onReply = (r: Reply): void => {
    replies.push(r);
    if (!r.ok) return;
    if (r.cmd === 'blocks') {
      const d = r.data as BlocksData;
      const ids = rleDecode(d.palette, d.runs);
      let agree = 0;
      ids.forEach((id, i) => {
        const p = { x: d.from.x + (i % d.size.x), y: d.from.y + Math.floor(i / (d.size.x * d.size.z)), z: d.from.z + (Math.floor(i / d.size.x) % d.size.z) };
        const b = world.blockAt(p);
        if (b && typeIdOf(b) === id) agree++;
      });
      checks.push({ reply: r, result: `${agree}/${ids.length}` });
    } else if (r.cmd === 'checksum') {
      const d = r.data as { from: Vec3; to: Vec3; hash: string };
      checks.push({ reply: r, result: world.checksum(d.from, d.to) === d.hash ? 'match' : `model ${world.checksum(d.from, d.to)} truth ${d.hash}` });
    } else if (r.cmd === 'block') {
      const d = r.data as Vec3 & { typeId: string };
      const b = world.blockAt(d);
      checks.push({ reply: r, result: b && typeIdOf(b) === d.typeId ? 'match' : `model ${b?.name} truth ${d.typeId}` });
    } else if (r.cmd === 'inv') {
      const d = r.data as { slots: unknown[]; selectedSlot: number };
      const model = world.inventory.slots.map((s, i) => (s ? { slot: i, typeId: `minecraft:${s.name}`, amount: s.count } : null));
      checks.push({ reply: r, result: JSON.stringify(model) === JSON.stringify(d.slots) && world.inventory.selected === d.selectedSlot ? 'match' : JSON.stringify(model) });
    }
  };

  const packets = decodedInbound(FIXTURE);
  const t0 = performance.now();
  for (const p of packets) {
    src.emit(p.name, p.params);
    if (p.name === 'text') {
      const reply = parser.feed(textOf(p.params));
      if (reply) onReply(reply);
    }
  }
  const replayMs = performance.now() - t0;

  it('the capture covers login, subchunks, the update burst, a drop and a give', () => {
    const names = new Set(loadFixture(FIXTURE).map((l) => `${l.dir}:${l.name}`));
    for (const n of [
      'in:start_game',
      'in:item_registry',
      'in:level_chunk',
      'out:subchunk_request',
      'in:subchunk',
      'in:update_block',
      'in:update_subchunk_blocks',
      'in:block_entity_data',
      'in:add_item_entity',
      'in:inventory_transaction',
      'in:text',
    ]) {
      expect(names, n).toContain(n);
    }
    expect(replies.filter((r) => r.ok).map((r) => r.cmd)).toEqual(
      expect.arrayContaining(['fill', 'set', 'blocks', 'checksum', 'block', 'spawnitem', 'give', 'inv']),
    );
    console.log(`[world-replay] ${packets.length} inbound packets replayed in ${replayMs.toFixed(0)} ms`);
  });

  it('loads every column the server sent, with no decode errors or unknown hashes', () => {
    expect(world.registry.ready).toBe(true);
    expect(world.chunks.stats.levelChunks).toBeGreaterThan(300);
    expect(world.chunks.loadedCount).toBe(world.chunks.size);
    expect(world.chunks.stats.decodeErrors).toBe(0);
    expect(world.registry.unknownRuntimeIds.size).toBe(0);
    // Flat-world layers far from the edited area.
    for (const [x, z] of [[40, 40], [-60, 20], [100, -100]] as const) {
      expect(world.blockAt({ x, y: -64, z })?.name).toBe('bedrock');
      expect(world.blockAt({ x, y: -63, z })?.name).toBe('dirt');
      expect(world.blockAt({ x, y: -62, z })?.name).toBe('dirt');
      expect(world.blockAt({ x, y: -61, z })?.name).toBe('grass_block');
      expect(world.blockAt({ x, y: -60, z })?.name).toBe('air');
    }
  });

  it('agrees with every truth snapshot in the capture (blocks, checksum, block, inv)', () => {
    const blocks = checks.filter((c) => c.reply.cmd === 'blocks');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.result).toBe('3969/3969');
    for (const c of checks.filter((c) => c.reply.cmd !== 'blocks')) expect(c.result, `${c.reply.cmd} ${JSON.stringify(c.reply.data).slice(0, 120)}`).toBe('match');
    expect(checks.filter((c) => c.reply.cmd === 'checksum')).toHaveLength(1);
    expect(checks.filter((c) => c.reply.cmd === 'block')).toHaveLength(5);
    expect(checks.filter((c) => c.reply.cmd === 'inv')).toHaveLength(1);
  });

  it('applied the 20 sets and the 5x5x5 fill as block updates', () => {
    const sets = replies.filter((r) => r.cmd === 'set' && r.ok).map((r) => r.data as Vec3 & { typeId: string });
    expect(sets).toHaveLength(20);
    for (let y = -60; y <= -56; y++) for (let z = -8; z <= -4; z++) for (let x = 3; x <= 7; x++) expect(world.blockAt({ x, y, z })?.name).toBe('stone');
    for (const s of sets) expect(updates).toContain(`${s.x},${s.y},${s.z}=${s.typeId.slice(10)}`);
    const chests = sets.filter((s) => s.typeId === 'minecraft:chest');
    expect(chests.length).toBeGreaterThan(0);
    for (const c of chests) {
      // Chests inside the later fill are gone; the others keep a block entity.
      if (world.blockAt(c)?.name === 'chest') expect(world.blockEntityAt(c)?.id).toBe('Chest');
    }
  });

  it('tracked the spawned item at the truth location and the given logs', () => {
    const spawn = replies.find((r) => r.cmd === 'spawnitem')!.data as { entities: { entityId: string; location: Vec3 }[] };
    const truthItem = spawn.entities[0]!;
    const uid = BigInt(truthItem.entityId);
    const e = [...world.entities.values()].find((x) => x.uniqueId === uid);
    expect(e?.type).toBe('minecraft:item');
    expect(e?.item).toMatchObject({ name: 'oak_log', count: 3 });
    const at = firstSeen.get(uid)!;
    expect(Math.hypot(at.x - truthItem.location.x, at.y - truthItem.location.y, at.z - truthItem.location.z)).toBeLessThanOrEqual(0.5);
    expect(world.inventory.count('oak_log')).toBe(5);
    expect(world.self.gameMode).toBe('survival');
    expect(world.self.pos.y).toBeCloseTo(-60, 3);
  });

  it('detaches from the source on dispose', () => {
    expect(src.listenerCount()).toBeGreaterThan(20);
    world.dispose();
    expect(src.listenerCount()).toBe(0);
  });
});
