// Track T1 (ADR 0075): command_request out, command_output back (skills/test/command.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner, isPermissionRefusal, parseCommandOutput, resultText, type CommandSource } from '../../../src/skills/test/command.ts';

/** command_output as BDS 1.26.60.6 sent it (bds-fly3, 2026-11-08). */
const OUT_TP = { origin: { type: 'player', uuid: 'u1', request_id: '', player_entity_id: 0n }, output_type: 'alloutput', success_count: 1, output: [{ message_id: 'commands.tp.success.coordinates', success: true, parameters: ['T1Probe', '0.50', '-60.00', '0.50'] }], has_data: false };
const OUT_DENIED = { origin: { type: 'player', uuid: 'u2' }, output_type: 'alloutput', success_count: 0, output: [{ message_id: 'commands.generic.permission.selector', success: false, parameters: [] }] };

class FakeConn implements CommandSource {
  state = 'spawned';
  sent: Record<string, unknown>[] = [];
  private fns = new Set<(p: unknown) => void>();
  on(_name: 'command_output', fn: (p: unknown) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  queue(_name: 'command_request', params: Record<string, unknown>): void {
    this.sent.push(params);
  }
  answer(p: unknown): void {
    for (const fn of [...this.fns]) fn(p);
  }
  last(): { command: string; uuid: string } {
    const p = this.sent[this.sent.length - 1] as { command: string; origin: { uuid: string } };
    return { command: p.command, uuid: p.origin.uuid };
  }
}

describe('parseCommandOutput', () => {
  it('reads the uuid, the success count and the messages', () => {
    expect(parseCommandOutput(OUT_TP)).toEqual({ uuid: 'u1', successCount: 1, messages: [{ id: 'commands.tp.success.coordinates', success: true, params: ['T1Probe', '0.50', '-60.00', '0.50'] }] });
    expect(parseCommandOutput(OUT_DENIED).messages[0]?.id).toBe('commands.generic.permission.selector');
  });
  it('survives missing and odd fields', () => {
    expect(parseCommandOutput(undefined)).toEqual({ uuid: undefined, successCount: 0, messages: [] });
    expect(parseCommandOutput({ origin: { uuid: 5 }, success_count: 'x', output: [null, { parameters: [1, 2] }] })).toEqual({ uuid: undefined, successCount: 0, messages: [{ id: '', success: false, params: ['1', '2'] }] });
  });
  it('tells a lack of rights from other refusals', () => {
    expect(isPermissionRefusal({ ok: false, messageId: 'commands.generic.permission.selector' })).toBe(true);
    expect(isPermissionRefusal({ ok: false, messageId: 'commands.generic.syntax' })).toBe(false);
    expect(isPermissionRefusal({ ok: true, messageId: 'commands.generic.permission.selector' })).toBe(false);
  });
});

describe('CommandRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a command_request and resolves with the answer of the same uuid', async () => {
    const c = new FakeConn();
    let n = 0;
    const r = new CommandRunner(c, { uuid: () => `u${++n}` });
    const p = r.run('tp @s 0 -60 0');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.sent[0]).toMatchObject({ command: '/tp @s 0 -60 0', origin: { type: 'player', uuid: 'u1', player_entity_id: 0n }, internal: false, version: 'latest' });
    c.answer({ ...OUT_DENIED, origin: { uuid: 'other' } }); // not ours (a /me of the chat route): ignored
    c.answer(OUT_TP);
    const res = await p;
    expect(res).toMatchObject({ command: '/tp @s 0 -60 0', ok: true, successCount: 1, messageId: 'commands.tp.success.coordinates' });
    expect(resultText(res)).toMatch(/^ok commands\.tp\.success\.coordinates \[T1Probe, 0\.50, -60\.00, 0\.50\]/);
    expect(r.counts).toMatchObject({ sent: 1, ok: 1, refused: 0, errors: 0 });
  });

  it('a refusal is ok=false with the message id; no answer is a timeout', async () => {
    const c = new FakeConn();
    let n = 1;
    const r = new CommandRunner(c, { uuid: () => `u${++n}`, timeoutMs: 1000 });
    const p = r.run('/testfor @s');
    await vi.advanceTimersByTimeAsync(0);
    c.answer(OUT_DENIED);
    expect(await p).toMatchObject({ ok: false, messageId: 'commands.generic.permission.selector' });
    const q = r.run('/tellraw @a {"rawtext":[]}'); // success is silent on BDS
    await vi.advanceTimersByTimeAsync(1200);
    expect(await q).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('one command at a time, a gap between them', async () => {
    const c = new FakeConn();
    let n = 0;
    const r = new CommandRunner(c, { uuid: () => `u${++n}`, gapMs: 150 });
    const a = r.run('/give @s elytra 1');
    const b = r.run('/give @s firework_rocket 64');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.sent).toHaveLength(1);
    c.answer({ ...OUT_TP, origin: { uuid: 'u1' } });
    await a;
    await vi.advanceTimersByTimeAsync(100);
    expect(c.sent).toHaveLength(1); // the gap
    await vi.advanceTimersByTimeAsync(60);
    expect(c.sent).toHaveLength(2);
    c.answer({ ...OUT_TP, origin: { uuid: 'u2' } });
    expect((await b).ok).toBe(true);
  });

  it('refuses a command over the byte limit, before the spawn, and over the per-minute cap', async () => {
    const c = new FakeConn();
    let n = 0;
    const r = new CommandRunner(c, { uuid: () => `u${++n}`, maxPerMinute: 2, gapMs: 0, timeoutMs: 100 });
    expect(await r.run(`/say ${'§a'.repeat(240)}`)).toMatchObject({ ok: false, error: 'too_long' }); // 2 bytes a section sign
    expect(c.sent).toHaveLength(0);
    const first = r.run('/testfor @s');
    await vi.advanceTimersByTimeAsync(150);
    await first;
    const second = r.run('/testfor @s');
    await vi.advanceTimersByTimeAsync(150);
    await second;
    expect(await r.run('/testfor @s')).toMatchObject({ error: 'rate_limited' });
    c.state = 'connecting';
    expect(await r.run('/testfor @s')).toMatchObject({ error: 'not_spawned' });
    expect(c.sent).toHaveLength(2);
  });
});
