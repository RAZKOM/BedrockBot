import { describe, expect, it } from 'vitest';
import { formatChatLine, isTruthLine, parseText, parseTruthReply, rawTextToPlain, stripFormatting } from '../../src/chat/text.ts';
import type { TextPacket } from '../../src/connection/types.ts';

const pkt = (p: Partial<TextPacket>): TextPacket => ({ needs_translation: false, type: 'raw', message: '', ...p });

// Packet shapes below were recorded from BDS 1.26.51.1 (bds-dev) on 2026-10-28.
describe('parseText', () => {
  it('player chat (BDS appends §r to the relayed name)', () => {
    const line = parseText(pkt({ type: 'chat', category: 'authored', source_name: 'Steve§r', message: 'hello', xuid: '' }));
    expect(line).toEqual({ type: 'chat', source: 'Steve', message: 'hello', body: 'hello', xuid: '', truth: false });
    expect(formatChatLine(line)).toBe('<Steve> hello');
  });

  it('console say (announcement)', () => {
    const line = parseText(pkt({ type: 'announcement', source_name: 'Server', message: '[Server] hello-from-console' }));
    expect(line.message).toBe('[Server] hello-from-console');
    expect(line.body).toBe('hello-from-console');
    expect(formatChatLine(line)).toBe('[Server] hello-from-console');
  });

  it('console tell (whisper) has no prefix', () => {
    const line = parseText(pkt({ type: 'whisper', source_name: 'Server', message: '!pos', xuid: '' }));
    expect(line).toMatchObject({ type: 'whisper', source: 'Server', message: '!pos', body: '!pos' });
    expect(formatChatLine(line)).toBe('Server whispers: !pos');
  });

  it('console me is chat without a source', () => {
    const line = parseText(pkt({ type: 'chat', source_name: '', message: '* Server waves' }));
    expect(line).toMatchObject({ source: '', body: '* Server waves' });
    expect(formatChatLine(line)).toBe('* Server waves');
  });

  it('world.sendMessage (json rawtext)', () => {
    const line = parseText(pkt({ type: 'json', message: '{"rawtext":[{"text":"[truth] "},{"text":"pos 0.5 -60 0.5"}]}' }));
    expect(line).toEqual({ type: 'json', source: '', message: '[truth] pos 0.5 -60 0.5', body: '[truth] pos 0.5 -60 0.5', xuid: '', truth: false });
    expect(formatChatLine(line)).toBe('[truth] pos 0.5 -60 0.5');
  });

  it('tellraw (json_whisper with a trailing newline)', () => {
    const line = parseText(pkt({ type: 'json_whisper', message: '{"rawtext":[{"text":"raw hi"}]}\n' }));
    expect(line.message).toBe('raw hi');
  });

  it('truth pack replies are flagged', () => {
    const msg = '{"rawtext":[{"text":"@truth {\\"truth\\":{\\"cmd\\":\\"pos\\",\\"id\\":\\"p1\\",\\"ok\\":true,\\"tick\\":29986,\\"data\\":{\\"name\\":\\"ProbeA\\",\\"location\\":{\\"x\\":0.5,\\"y\\":-60,\\"z\\":0.5}}}}"}]}\n';
    const line = parseText(pkt({ type: 'json', needs_translation: true, message: msg }));
    expect(line.truth).toBe(true);
    expect(parseTruthReply(line.message)).toEqual({
      cmd: 'pos',
      id: 'p1',
      ok: true,
      tick: 29986,
      data: { name: 'ProbeA', location: { x: 0.5, y: -60, z: 0.5 } },
    });
  });

  it('truth markers', () => {
    expect(isTruthLine('@truth {}')).toBe(true);
    expect(isTruthLine('@truth+ k 1/2 abc')).toBe(true);
    expect(isTruthLine('@truthy')).toBe(false);
    expect(isTruthLine('say @truth {}')).toBe(false);
    expect(parseTruthReply('@truth not json')).toBeUndefined();
    expect(parseTruthReply('@truth+ k 1/2 {}')).toBeUndefined();
  });

  it('nested rawtext and translate parts', () => {
    expect(rawTextToPlain('{"rawtext":[{"rawtext":[{"text":"a"},{"text":"b"}]},{"translate":"commands.tp","with":["x","y"]}]}')).toBe('abcommands.tp(x, y)');
    expect(rawTextToPlain('{"rawtext":[{"translate":"k","with":{"rawtext":[{"text":"z"}]}}]}')).toBe('k(z)');
  });

  it('non-JSON json messages fall back to the raw string', () => {
    expect(parseText(pkt({ type: 'json', message: 'not json' })).message).toBe('not json');
  });

  it('translation keeps its parameters', () => {
    const line = parseText(pkt({ type: 'translation', message: '§e%multiplayer.player.joined', parameters: ['Alex'] }));
    expect(line.message).toBe('§e%multiplayer.player.joined [Alex]');
  });

  it('stripFormatting', () => {
    expect(stripFormatting('§aGreen§r')).toBe('Green');
  });
});
