// Replays fixtures/<version>/{login-idle,world-chunks}.jsonl.gz through bedrock-protocol's deserializer (PLAN.md
// task 0.5), for every game version the bot supports. Doubles as the breaking-change detector when
// bedrock-protocol or minecraft-data are bumped. 1.26.60 needs patches/minecraft-data@3.117.0.patch
// (recorded against BDS 1.26.60.6 with scripts/record-fixture.ts --version 1.26.60).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer, supportedVersions } from '../../src/connection/protocol.ts';
import { parseRecording, toJsonSafe, type RecordLine } from '../../src/connection/recorder.ts';
import { checkVersion } from '../../src/connection/versionGate.ts';
import { shimFor } from '../../src/world/version-shims/index.ts';

/** Every packet with raw bytes deserializes to the recorded name and params. Returns how many were checked. */
function replay(version: string, lines: RecordLine[]): number {
  const des = createDeserializer(version);
  const ser = createSerializer(version);
  let replayed = 0;
  for (const line of lines) {
    if (!line.raw) continue;
    const parsed = des.parsePacketBuffer(Buffer.from(line.raw, 'base64'));
    expect(parsed.data.name, `line ${replayed}`).toBe(line.name);
    const decoded = toJsonSafe(parsed.data.params) as Record<string, unknown>;
    if (line.dir === 'in') {
      // Inbound params were recorded from exactly these bytes.
      expect(decoded, line.name).toEqual(line.params);
    } else {
      // Outbound params are what the code passed in (the serializer drops extras such as
      // resourcepackids and defaults missing fields), so check the wire bytes instead: the
      // decoded packet must re-encode to exactly what was sent.
      const reencoded = ser.createPacketBuffer({ name: parsed.data.name, params: parsed.data.params });
      expect(reencoded.toString('base64'), line.name).toBe(line.raw);
    }
    // Same bookkeeping bedrock-protocol's client does (shield items carry an extra field).
    if (line.name === 'start_game' || line.name === 'item_registry') {
      const states = (parsed.data.params.itemstates ?? []) as { name: string; runtime_id: number }[];
      const shield = states.find((s) => s.name === 'minecraft:shield');
      if (shield) {
        des.proto.setVariable('ShieldItemID', shield.runtime_id);
        ser.proto.setVariable('ShieldItemID', shield.runtime_id);
      }
    }
    replayed++;
  }
  return replayed;
}

function load(version: string, kind: string): RecordLine[] {
  const file = fileURLToPath(new URL(`../../../fixtures/${version}/${kind}.jsonl.gz`, import.meta.url));
  return parseRecording(gunzipSync(readFileSync(file)).toString('utf8'));
}

/** Game version -> protocol number the fixture's server advertised. */
const VERSIONS: Record<string, number> = { '1.26.51': 2193, '1.26.60': 2225 };

describe.each(Object.entries(VERSIONS))('fixture %s/login-idle', (version, protocol) => {
  const lines = load(version, 'login-idle');

  it('is a version the installed stack supports, with a world version shim', () => {
    expect(supportedVersions[version]).toBe(protocol);
    expect(checkVersion(version, protocol)).toEqual({ ok: true, version, protocol });
    expect(shimFor(version)?.registryVersion).toBe(`bedrock_${version}`);
    const meta = lines.find((l) => l.dir === 'meta' && l.name === 'fixture');
    expect(meta?.params).toMatchObject({ kind: 'login-idle', gameVersion: version });
  });

  it('covers login, spawn handshake and at least 10 s of idle', () => {
    const names = new Set(lines.map((l) => `${l.dir}:${l.name}`));
    for (const n of [
      'out:login',
      'in:start_game',
      'in:item_registry',
      'in:respawn',
      'out:respawn',
      'in:play_status',
      'out:serverbound_loading_screen',
      'out:set_local_player_as_initialized',
      'in:level_chunk',
      'out:disconnect',
    ]) {
      expect(names, n).toContain(n);
    }
    const login = lines.find((l) => l.name === 'login');
    expect(login?.params).toBe('[redacted]');
    expect(login).not.toHaveProperty('raw');
    const spawnTick = lines.find((l) => l.dir === 'out' && l.name === 'serverbound_loading_screen');
    const last = lines.at(-1);
    expect(last && spawnTick ? last.t - spawnTick.t : 0).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...lines.map((l) => l.tick))).toBeGreaterThanOrEqual(190);
  });

  it('every recorded packet deserializes to the recorded name and params', () => {
    expect(replay(version, lines)).toBeGreaterThan(300);
  });
});

// world-chunks: login, chunk load, block-update burst, item drop and give (test/e2e/world-record.test.ts).
describe.each(Object.keys(VERSIONS))('fixture %s/world-chunks', (version) => {
  const lines = load(version, 'world-chunks');
  it('every recorded packet deserializes to the recorded name and params', () => {
    const names = new Set(lines.map((l) => `${l.dir}:${l.name}`));
    for (const n of ['in:level_chunk', 'in:subchunk', 'out:subchunk_request', 'in:update_block', 'in:update_subchunk_blocks', 'in:add_item_entity', 'in:inventory_content']) expect(names, n).toContain(n);
    expect(replay(version, lines)).toBeGreaterThan(300);
  });
});
