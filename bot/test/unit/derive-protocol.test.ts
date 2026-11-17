// tools/bump-version/lib/derive.mjs and derive/1.26.70.mjs: bedrock 1.26.70 (protocol 2259) as named edits of
// 1.26.60's protocol.json, carried by patches/minecraft-data@3.119.0.patch (playbook step 1, 2b).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { chatPacket } from '../../src/chat/chat.ts';
import { createDeserializer, createSerializer, supportedVersions } from '../../src/connection/protocol.ts';

const require = createRequire(import.meta.url);

type Types = Record<string, unknown>;
interface Protocol {
  types: Types;
}
interface Edit {
  name: string;
  apply: (d: unknown) => void;
}
interface Recipe {
  version: string;
  protocol: number;
  base: string;
  releaseType: string;
  edits: Edit[];
}
interface DeriveModule {
  deriveProtocol: (base: Protocol, recipe: Recipe) => { protocol: Protocol; edits: string[] };
  Derivation: new (p: Protocol) => {
    run: (edits: Edit[]) => Protocol;
    addPacket: (id: number, name: string, def: unknown) => void;
    removePacket: (id: number, name: string) => void;
    replaceField: (fields: unknown[], old: string, oldType: unknown, field: unknown, what?: string) => void;
    fields: (name: string) => unknown[];
  };
  loadRecipe: (ver: string) => Promise<Recipe | null>;
}

const tools = new URL('../../../tools/bump-version/', import.meta.url);
const derive = (await import(new URL('lib/derive.mjs', tools).href)) as DeriveModule;
const recipe = (await derive.loadRecipe('1.26.70'))!;
// the minecraft-data bedrock-protocol loads (the patched 3.119.0)
const mcData = createRequire(require.resolve('bedrock-protocol'))('minecraft-data') as (v: string) => { protocol: Protocol; version: { version: number; releaseType?: string } };

describe('derived bedrock 1.26.70', () => {
  it('the recipe is 1.26.70, protocol 2259, from 1.26.60, a beta', () => {
    expect(recipe).toMatchObject({ version: '1.26.70', protocol: 2259, base: '1.26.60', releaseType: 'beta' });
    expect(recipe.edits.length).toBe(22);
    expect(new Set(recipe.edits.map((e) => e.name)).size).toBe(recipe.edits.length);
  });

  it('the installed patch holds exactly what the recipe makes of 1.26.60', () => {
    // a recipe edited without regenerating the patch (or the reverse) fails here
    const { protocol, edits } = derive.deriveProtocol(mcData('bedrock_1.26.60').protocol, recipe);
    expect(edits).toEqual(recipe.edits.map((e) => e.name));
    expect(JSON.stringify(protocol)).toBe(JSON.stringify(mcData('bedrock_1.26.70').protocol));
    expect(mcData('bedrock_1.26.70').version).toMatchObject({ version: 2259, releaseType: 'beta' });
    expect(supportedVersions['1.26.70']).toBe(2259);
  });

  it('every edit checks what it changes: running the recipe twice fails on the first edit, by name', () => {
    const once = derive.deriveProtocol(mcData('bedrock_1.26.60').protocol, recipe).protocol;
    expect(() => derive.deriveProtocol(once, recipe)).toThrow(/^edit "text: translation, popup and jukebox_popup end with a queue bool": .*last field is queue, expected parameters/);
    const d = new derive.Derivation(mcData('bedrock_1.26.60').protocol);
    expect(() => d.addPacket(0x01, 'x', ['container', []])).toThrow(/packet id 1 is login already/);
    expect(() => d.removePacket(0x02, 'login')).toThrow(/packet id 2 is play_status, expected login/);
    expect(() => d.replaceField(d.fields('packet_resource_pack_stack'), 'has_editor_packs', 'u8', { name: 'x', type: 'u8' })).toThrow(/has_editor_packs is "bool", expected "u8"/);
  });

  it('the base is not modified', () => {
    const base = mcData('bedrock_1.26.60').protocol;
    const before = JSON.stringify(base);
    derive.deriveProtocol(base, recipe);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('compiles, and the changed login and chat packets round-trip', () => {
    const ser = createSerializer('1.26.70');
    const des = createDeserializer('1.26.70');
    const rt = (name: string, params: Record<string, unknown>) => des.parsePacketBuffer(ser.createPacketBuffer({ name, params })).data;
    const ns = { compression_threshold: 1, compression_algorithm: 'deflate', client_throttle: false, client_throttle_threshold: 0, client_throttle_scalar: 0, sctp_recovery_profile: 'balanced' };
    expect(rt('network_settings', ns)).toEqual({ name: 'network_settings', params: ns });
    const text = { needs_translation: true, category: 'message_only', type: 'translation', message: 'death.attack.zombie', parameters: ['Bot'], queue: true, xuid: '', platform_chat_id: '', has_filtered_message: false };
    expect(rt('text', text).params).toEqual(text);
    // what the bot sends (chat.ts chatPacket): the chat arm is unchanged in 1.26.70
    const chat = chatPacket('Bot', 'hi') as unknown as Record<string, unknown>;
    expect(rt('text', chat).params).toMatchObject({ type: 'chat', source_name: 'Bot', message: 'hi' });
    const store = { updates: [{ change_type: 'update', variable_name: 'a', value: { type: 'string', value: 'x' }, update_count: 2 }, { change_type: 'removal', variable_name: 'b' }] };
    expect(rt('clientbound_data_store', store).params).toEqual(store);
    // 1.26.60's network_settings has no sctp_recovery_profile: one byte shorter
    const { sctp_recovery_profile: _profile, ...ns60 } = ns;
    expect(ser.createPacketBuffer({ name: 'network_settings', params: ns }).length).toBe(createSerializer('1.26.60').createPacketBuffer({ name: 'network_settings', params: ns60 }).length + 1);
  });
});
