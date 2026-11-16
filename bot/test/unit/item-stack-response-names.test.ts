// Track P1 follow-up: item_stack_response's filtered_custom_name is an optional string (a bool before it).
// A Realm sends the filtered name of a named item after a 01 byte; BDS sends a single 00 (absent), which an empty
// string read the same way, so only a Realm's swap of named boxes failed to parse (docs/versions.md
// "Packets the bot cannot read", ADR 0092).
import { describe, expect, it } from 'vitest';
import { createDeserializer, createSerializer } from '../../src/connection/protocol.ts';

const VERSION = '1.26.60';

/** A Realm's answer to the swap of two named shulker boxes (2026-11-16, 79 bytes: id, then the body). */
const REALM_SWAP_RESPONSE =
  '940101008d9b0c01021d000112120101' +
  '90db010d626f745f66697265776f726b' +
  '73010d626f745f66697265776f726b73' +
  '001c000102020101aadb0108626f745f' +
  '6c6f6f740108626f745f6c6f6f7400';

/** What BDS 1.26.60.6 sends for the same swap shape: no filtered name, a single 00 where the option is. */
const BDS_SWAP_RESPONSE = '940101008d9b0c01021d000112120101' + '90db010d626f745f66697265776f726b' + '7300001c000102020101aadb0108626f745f' + '6c6f6f740000';

interface Slot {
  slot: number;
  hotbar_slot: number;
  count: number;
  item_stack_id?: number;
  custom_name: string;
  filtered_custom_name?: string;
  durability_correction: number;
}
interface Response {
  status: string;
  request_id: number;
  containers?: { slot_type: { container_id: string }; slots: Slot[] }[];
}

function parse(hex: string): { name: string; responses: Response[]; size: number; length: number } {
  const buf = Buffer.from(hex, 'hex');
  const p = createDeserializer(VERSION).parsePacketBuffer(buf);
  return { name: p.data.name, responses: (p.data.params as { responses: Response[] }).responses, size: p.metadata.size, length: buf.length };
}

describe('item_stack_response slot names (Track P1 follow-up)', () => {
  it("parses the Realm's swap of two named boxes, every byte read", () => {
    const r = parse(REALM_SWAP_RESPONSE);
    expect(r.name).toBe('item_stack_response');
    expect(r.size).toBe(r.length);
    const [res] = r.responses;
    expect(res?.status).toBe('ok');
    const containers = res?.containers ?? [];
    expect(containers.map((c) => c.slot_type.container_id)).toEqual(['inventory', 'hotbar']);
    const [a, b] = containers.map((c) => c.slots[0]);
    expect(a).toMatchObject({ slot: 18, hotbar_slot: 18, count: 1, custom_name: 'bot_fireworks', filtered_custom_name: 'bot_fireworks', durability_correction: 0 });
    expect(b).toMatchObject({ slot: 2, hotbar_slot: 2, count: 1, custom_name: 'bot_loot', filtered_custom_name: 'bot_loot', durability_correction: 0 });
  });

  it('parses the BDS shape with no filtered name', () => {
    const r = parse(BDS_SWAP_RESPONSE);
    expect(r.size).toBe(r.length);
    const slots = (r.responses[0]?.containers ?? []).map((c) => c.slots[0]);
    expect(slots.map((s) => s?.custom_name)).toEqual(['bot_fireworks', 'bot_loot']);
    expect(slots.every((s) => s?.filtered_custom_name === undefined)).toBe(true);
  });

  it('writes and reads back both shapes', () => {
    const ser = createSerializer(VERSION);
    for (const hex of [REALM_SWAP_RESPONSE, BDS_SWAP_RESPONSE]) {
      const p = createDeserializer(VERSION).parsePacketBuffer(Buffer.from(hex, 'hex'));
      expect(ser.createPacketBuffer({ name: p.data.name, params: p.data.params }).toString('hex')).toBe(hex);
    }
  });
});
