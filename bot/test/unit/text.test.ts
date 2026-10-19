import { describe, expect, it } from 'vitest';
import { formatChatLine, parseText, rawTextToPlain } from '../../src/chat/text.ts';
import type { TextPacket } from '../../src/connection/types.ts';

const pkt = (p: Partial<TextPacket>): TextPacket => ({ needs_translation: false, type: 'raw', message: '', ...p });

describe('parseText', () => {
  it('player chat', () => {
    const line = parseText(pkt({ type: 'chat', source_name: 'Steve', message: 'hello' }));
    expect(line).toEqual({ type: 'chat', source: 'Steve', message: 'hello' });
    expect(formatChatLine(line)).toBe('<Steve> hello');
  });

  it('console say (announcement, recorded from BDS 1.26.51)', () => {
    const line = parseText(pkt({ type: 'announcement', source_name: 'Server', message: '[Server] hello-from-console' }));
    expect(line.message).toBe('[Server] hello-from-console');
    expect(formatChatLine(line)).toBe('[Server] hello-from-console');
  });

  it('world.sendMessage (json rawtext)', () => {
    const line = parseText(pkt({ type: 'json', message: '{"rawtext":[{"text":"[truth] "},{"text":"pos 0.5 -60 0.5"}]}' }));
    expect(line).toEqual({ type: 'json', source: '', message: '[truth] pos 0.5 -60 0.5' });
    expect(formatChatLine(line)).toBe('[truth] pos 0.5 -60 0.5');
  });

  it('nested rawtext and translate parts', () => {
    expect(rawTextToPlain('{"rawtext":[{"rawtext":[{"text":"a"},{"text":"b"}]},{"translate":"commands.tp","with":["x","y"]}]}')).toBe('abcommands.tp(x, y)');
    expect(rawTextToPlain('{"rawtext":[{"translate":"k","with":{"rawtext":[{"text":"z"}]}}]}')).toBe('k(z)');
  });

  it('non-JSON json messages fall back to the raw string', () => {
    expect(parseText(pkt({ type: 'json', message: 'not json' })).message).toBe('not json');
  });

  it('translation keeps its parameters', () => {
    const line = parseText(pkt({ type: 'translation', message: '%multiplayer.player.joined', parameters: ['Alex'] }));
    expect(line.message).toBe('%multiplayer.player.joined [Alex]');
  });
});
