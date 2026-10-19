// PLAN.md task 2.1: registry shim. Hash values below were read from the recorded capture
// fixtures/1.26.51/world-chunks.jsonl.gz (subchunk palettes and update_block runtime ids); the test
// also checks that they really occur there.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/log.ts';
import { BlockRegistry, blockHash } from '../../../src/world/registry.ts';
import { decodeSubChunk } from '../../../src/world/subchunk.ts';
import { shimFor } from '../../../src/world/version-shims/index.ts';
import { decodedInbound, readyRegistry, recordedLogin } from './helpers.ts';

/** Wire runtime ids (FNV-1a hashes) seen on BDS 1.26.51.1. */
const KNOWN: Record<string, { rid: number; states: Record<string, unknown> }> = {
  air: { rid: -604749536, states: {} },
  bedrock: { rid: -173245189, states: { infiniburn_bit: 0 } },
  dirt: { rid: -2108756090, states: {} },
  grass_block: { rid: -567203660, states: {} },
  oak_log: { rid: 825916963, states: { pillar_axis: 'y' } },
  stone: { rid: -2144268767, states: {} },
};

describe('world registry shim (1.26.51)', () => {
  it('has a version shim for 1.26.51 that reads item states from item_registry', () => {
    const shim = shimFor('1.26.51');
    expect(shim?.registryVersion).toBe('bedrock_1.26.51');
    expect(shim?.blockDataVersion).toBe('1.26.30');
    const { startGame, itemRegistry } = recordedLogin();
    expect(shim?.itemStates(startGame, undefined)).toBeUndefined();
    expect(shim?.itemStates(startGame, itemRegistry)).toHaveLength(2076);
  });

  it('the known hashes occur in the recorded capture', () => {
    const seen = new Set<number>();
    for (const p of decodedInbound('world-chunks.jsonl.gz')) {
      if (p.name === 'update_block') seen.add((p.params.block_runtime_id as number) | 0);
      if (p.name === 'subchunk') {
        for (const e of p.params.entries as { result: string; payload?: Buffer }[]) {
          if (e.result !== 'success' || !e.payload) continue;
          decodeSubChunk(e.payload, (rid) => {
            seen.add(rid);
            return 0;
          });
        }
      }
    }
    for (const [name, { rid }] of Object.entries(KNOWN)) expect(seen.has(rid), name).toBe(true);
  });

  it('resolves the known hashes to names and states', () => {
    const reg = readyRegistry();
    expect(reg.ready).toBe(true);
    expect(reg.hashed).toBe(true);
    expect(reg.stateCount).toBe(16913);
    for (const [name, { rid, states }] of Object.entries(KNOWN)) {
      const s = reg.stateIdFromRuntimeId(rid);
      expect(s, name).toBeGreaterThanOrEqual(0);
      const info = reg.blockInfo(s);
      expect(info.name).toBe(name);
      expect(info.states).toEqual(states);
    }
    expect(reg.unknownRuntimeIds.size).toBe(0);
  });

  it('computes the same hashes as prismarine-block (blockHash)', () => {
    const reg = readyRegistry();
    for (const [name, { rid }] of Object.entries(KNOWN)) {
      const s = reg.stateIdFromRuntimeId(rid);
      expect(blockHash(name, reg.typedStatesOf(s)!)).toBe(rid);
    }
  });

  it('round-trips oak_log name -> stateId -> runtime id -> stateId -> name for every axis', () => {
    const reg = readyRegistry();
    const def = reg.stateIdOf('minecraft:oak_log');
    expect(def).toBeDefined();
    expect(reg.nameOf(def!)).toBe('oak_log');
    for (const axis of ['x', 'y', 'z']) {
      const s = reg.stateIdOf('oak_log', { pillar_axis: axis });
      expect(s, axis).toBeDefined();
      const rid = reg.runtimeIdOf(s!);
      const back = reg.stateIdFromRuntimeId(rid);
      expect(back).toBe(s);
      const info = reg.blockInfo(back);
      expect(info.name).toBe('oak_log');
      expect(info.states).toEqual({ pillar_axis: axis });
      expect(info.hardness).toBe(2);
      expect(info.solid).toBe(true);
      expect(info.boxes).toEqual([[0, 0, 0, 1, 1, 1]]);
    }
    expect(reg.runtimeIdOf(reg.stateIdOf('oak_log', { pillar_axis: 'y' })!)).toBe(KNOWN.oak_log!.rid);
    expect(reg.stateIdOf('oak_log', { pillar_axis: 'w' })).toBeUndefined();
    expect(reg.stateIdOf('no_such_block')).toBeUndefined();
  });

  it('describes air and partial blocks', () => {
    const reg = readyRegistry();
    const air = reg.blockInfo(reg.airStateId);
    expect(air).toMatchObject({ name: 'air', solid: false, boxes: [] });
    const slab = reg.blockInfo(reg.stateIdOf('oak_slab', { 'minecraft:vertical_half': 'bottom' })!);
    expect(slab.solid).toBe(true);
    expect(slab.boxes[0]?.[4]).toBe(0.5);
    expect(reg.blockInfo(reg.stateIdOf('bedrock')!).hardness).toBe(-1);
  });

  it('builds in either order: item_registry before start_game, or finalize without it', () => {
    const { startGame, itemRegistry } = recordedLogin();
    const a = new BlockRegistry({ logger: silentLogger });
    let readyCalls = 0;
    a.onReady(() => readyCalls++);
    a.handleItemRegistry(itemRegistry);
    expect(a.ready).toBe(false);
    a.handleStartGame(startGame);
    expect(a.ready).toBe(true);
    expect(readyCalls).toBe(1);
    expect(a.itemName(a.itemId('oak_log')!)).toBe('oak_log');

    const b = new BlockRegistry({ logger: silentLogger });
    b.handleStartGame(startGame);
    expect(b.ready).toBe(false); // waits for item_registry
    b.finalize();
    expect(b.ready).toBe(true);
    expect(b.stateIdFromRuntimeId(KNOWN.grass_block!.rid)).toBeGreaterThanOrEqual(0);
  });

  it('counts unknown runtime ids and maps them to a solid "unknown" block', () => {
    const warnings: string[] = [];
    const reg = new BlockRegistry({ logger: { ...silentLogger, warn: (m: string) => warnings.push(m) } });
    const { startGame, itemRegistry } = recordedLogin();
    reg.handleStartGame(startGame);
    reg.handleItemRegistry(itemRegistry);
    expect(reg.stateIdFromRuntimeId(123456789)).toBe(-1);
    expect(reg.stateIdFromRuntimeId(123456789)).toBe(-1);
    expect(reg.stateIdFromRuntimeId(-42)).toBe(-1);
    expect(reg.unknownRuntimeIds.get(123456789)).toBe(2);
    expect(reg.unknownRuntimeIds.get(-42)).toBe(1);
    expect(warnings).toHaveLength(2); // logged once per id
    expect(warnings[0]).toContain('1.26.30');
    expect(reg.unknownSummary()).toBe('2 unknown block runtime id(s): 123456789 x2, -42 x1');
    const info = reg.blockInfo(-1, 123456789);
    expect(info).toMatchObject({ name: 'unknown', stateId: -1, solid: true, states: { runtime_id: 123456789 } });
  });

  it('falls back to the newest shim for an unknown version, with a warning', () => {
    const warnings: string[] = [];
    const reg = new BlockRegistry({ version: '9.9.9', logger: { ...silentLogger, warn: (m: string) => warnings.push(m) } });
    expect(reg.shim.gameVersions).toContain('1.26.51');
    expect(warnings[0]).toContain('no world version shim for 9.9.9');
  });
});
