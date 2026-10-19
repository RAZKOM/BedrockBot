// Replays fixtures/<version>/*.jsonl.gz through bedrock-protocol's deserializer (PLAN.md task 0.5).
// Doubles as the breaking-change detector when bedrock-protocol or minecraft-data are bumped.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer } from '../../src/connection/protocol.ts';
import { parseRecording, toJsonSafe } from '../../src/connection/recorder.ts';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/1.26.51/login-idle.jsonl.gz', import.meta.url));

describe('fixture 1.26.51/login-idle', () => {
  const lines = parseRecording(gunzipSync(readFileSync(FIXTURE)).toString('utf8'));

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
    const des = createDeserializer('1.26.51');
    const ser = createSerializer('1.26.51');
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
    expect(replayed).toBeGreaterThan(300);
  });
});
