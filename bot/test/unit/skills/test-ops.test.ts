// Track T1 (ADR 0075): op detection from the server's packets and the probe (skills/test/ops.ts), on the values BDS
// 1.26.60.6 sent on bds-fly3 (2026-11-08).
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../../src/skills/test/command.ts';
import { judgeOp, NEEDS_OP, OpDetector, PROBE_COMMAND, PROBE_TTL_MS, signalsSayOp, type OpSource } from '../../../src/skills/test/ops.ts';

class Src implements OpSource {
  private fns = new Map<string, Set<(p: unknown) => void>>();
  on(name: string, fn: (p: unknown) => void): () => void {
    const s = this.fns.get(name) ?? new Set();
    s.add(fn);
    this.fns.set(name, s);
    return () => s.delete(fn);
  }
  emit(name: string, p: unknown): void {
    for (const fn of [...(this.fns.get(name) ?? [])]) fn(p);
  }
}

const ok = (messageId = 'commands.testfor.success'): CommandResult => ({ command: PROBE_COMMAND, ok: true, successCount: 1, messageId, params: ['Bot'], ms: 80 });
const denied = (messageId = 'commands.generic.permission.selector'): CommandResult => ({ command: PROBE_COMMAND, ok: false, successCount: 0, messageId, params: [], ms: 70 });

describe('signals', () => {
  it('the command level decides, then the permission level; cheats off is never op', () => {
    expect(signalsSayOp({})).toBeUndefined();
    expect(signalsSayOp({ permissionLevel: 'operator' })).toBe(true);
    expect(signalsSayOp({ permissionLevel: 'member' })).toBe(false);
    expect(signalsSayOp({ permissionLevel: 'operator', commandPermission: 'normal' })).toBe(false);
    expect(signalsSayOp({ permissionLevel: 'member', commandPermission: 'operator' })).toBe(true);
    expect(signalsSayOp({ commandPermission: 'host' })).toBe(true);
    expect(signalsSayOp({ permissionLevel: 'operator', commandPermission: 'operator', commandsEnabled: false })).toBe(false);
  });

  it('judgeOp: op only after a successful probe that nothing later contradicts', () => {
    const s = { permissionLevel: 'operator', commandPermission: 'operator', commandsEnabled: true, at: 100 };
    expect(judgeOp(s, undefined, 200).state).toBe('unknown');
    expect(judgeOp(s, { ok: true, at: 150 }, 200).state).toBe('op');
    expect(judgeOp(s, { ok: true, at: 150 }, 150 + PROBE_TTL_MS + 1).state).toBe('unknown'); // old: probe again
    const refused = judgeOp(s, { ok: false, at: 150, messageId: 'commands.generic.permission.selector' }, 200);
    expect(refused.state).toBe('not_op');
    expect(refused.line).toContain(NEEDS_OP);
    expect(judgeOp(s, { ok: false, at: 150, error: 'timeout' }, 200).state).toBe('unknown'); // no answer is no verdict
    // a /deop after the probe
    expect(judgeOp({ ...s, permissionLevel: 'member', commandPermission: 'normal', at: 300 }, { ok: true, at: 150 }, 400).state).toBe('not_op');
    expect(judgeOp({ ...s, commandsEnabled: false }, { ok: true, at: 150 }, 200).line).toContain('cheats off');
  });
});

describe('OpDetector', () => {
  it('BDS operator: start_game + update_abilities, the probe answers: op', async () => {
    const src = new Src();
    let t = 1000;
    let calls = 0;
    const d = new OpDetector(src, { run: () => (calls++, Promise.resolve(ok())), now: () => t });
    d.start();
    src.emit('start_game', { permission_level: 'operator', enable_commands: true, achievements_disabled: true });
    src.emit('set_commands_enabled', { enabled: true });
    src.emit('update_abilities', { permission_level: 'operator', command_permission: 'operator' });
    src.emit('update_abilities', { permission_level: 'operator', command_permission: 'operator' });
    expect(d.status().state).toBe('unknown');
    expect((await d.ensure()).state).toBe('op');
    expect((await d.ensure()).state).toBe('op');
    expect(calls).toBe(1); // a fresh verdict is not probed again
    expect(d.status().signals).toMatchObject({ permissionLevel: 'operator', commandPermission: 'operator', commandsEnabled: true, achievementsDisabled: true });
    // console `deop` while online: update_abilities member / normal at once
    t += 10;
    src.emit('update_abilities', { permission_level: 'member', command_permission: 'normal' });
    expect(d.status().state).toBe('not_op');
    expect(d.status().line).toContain('member');
    expect((await d.ensure()).state).toBe('not_op');
    expect(calls).toBe(1); // the server's word is enough: no command sent
    // `op` again: the next ensure probes
    t += 10;
    src.emit('update_abilities', { permission_level: 'operator', command_permission: 'operator' });
    expect((await d.ensure()).state).toBe('op');
  });

  it('a refused probe: not_op until the server promotes the bot; a new session forgets the probe', async () => {
    const src = new Src();
    let t = 1000;
    let answer = denied();
    const d = new OpDetector(src, { run: () => Promise.resolve(answer), now: () => t });
    d.start();
    src.emit('start_game', { permission_level: 'member', enable_commands: true });
    src.emit('update_abilities', { permission_level: 'member', command_permission: 'normal' });
    expect((await d.ensure()).state).toBe('not_op'); // from the signals alone
    t += 10;
    expect((await d.probe())).toMatchObject({ state: 'not_op' });
    t += 10;
    src.emit('update_abilities', { permission_level: 'operator', command_permission: 'operator' });
    answer = ok();
    expect((await d.ensure()).state).toBe('op');
    t += 10;
    src.emit('start_game', { permission_level: 'operator', enable_commands: false });
    expect(d.status().state).toBe('not_op');
    expect(d.status().line).toContain('cheats off');
  });

  it('probes are shared while one is out', async () => {
    const src = new Src();
    let calls = 0;
    let release!: (r: CommandResult) => void;
    const d = new OpDetector(src, { run: () => (calls++, new Promise<CommandResult>((r) => (release = r))) });
    d.start();
    const a = d.probe();
    const b = d.ensure();
    release(ok());
    expect((await a).state).toBe('op');
    expect((await b).state).toBe('op');
    expect(calls).toBe(1);
  });
});
