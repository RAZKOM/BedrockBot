// Track T1 (ADR 0075): the recovery state machine, the death path and the restore between runs (skills/test/recovery.ts).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import type { CommandResult } from '../../../src/skills/test/command.ts';
import { parseKitText, type KitView } from '../../../src/skills/test/kit.ts';
import { NEEDS_OP, type OpStatus } from '../../../src/skills/test/ops.ts';
import { claimRespawn, Harness, Recovery, recoveryStep, respawnClaimed, type HarnessPorts, type RecoveryPhase } from '../../../src/skills/test/recovery.ts';
import { silentLogger } from '../../../src/log.ts';

const OP: OpStatus = { state: 'op', line: 'op: commands work', signals: {} };
const NOT_OP: OpStatus = { state: 'not_op', line: `${NEEDS_OP}: the server gives me member rights`, signals: {} };
const emptyView = (): KitView => ({ slots: new Array(36).fill(null), worn: { head: null, chest: null, legs: null, feet: null, offhand: null } });

describe('recoveryStep', () => {
  it('death -> respawn -> op -> done', () => {
    let s: RecoveryPhase = 'idle';
    s = recoveryStep(s, { kind: 'death' });
    expect(s).toBe('dead');
    s = recoveryStep(s, { kind: 'respawn', enabled: true });
    expect(s).toBe('dead');
    s = recoveryStep(s, { kind: 'op', state: 'op' });
    expect(s).toBe('recovering');
    expect(recoveryStep(s, { kind: 'done', ok: true })).toBe('idle');
    expect(recoveryStep(s, { kind: 'done', ok: false })).toBe('failed');
    expect(recoveryStep(s, { kind: 'death' })).toBe('dead'); // dying again while recovering
  });
  it('testMode off: the respawn ends it; no rights: refused', () => {
    expect(recoveryStep('dead', { kind: 'respawn', enabled: false })).toBe('idle');
    expect(recoveryStep('dead', { kind: 'op', state: 'not_op' })).toBe('refused');
    expect(recoveryStep('dead', { kind: 'op', state: 'unknown' })).toBe('refused');
    expect(recoveryStep('idle', { kind: 'op', state: 'op' })).toBe('idle'); // stray events change nothing
    expect(recoveryStep('refused', { kind: 'done', ok: true })).toBe('refused');
  });
});

describe('Recovery', () => {
  const make = (o: { enabled?: boolean; op?: OpStatus; ok?: boolean }) => {
    const said: string[] = [];
    let restores = 0;
    let ops = 0;
    const r = new Recovery({
      enabled: () => o.enabled ?? true,
      ensureOp: () => (ops++, Promise.resolve(o.op ?? OP)),
      restore: () => (restores++, Promise.resolve(o.ok === false ? { ok: false, steps: ['healed'], why: 'tp: refused', commands: 3 } : { ok: true, steps: ['kit: elytra +1', 'tp 1 -60 2 (0.4 s)'], commands: 3 })),
      say: (m) => said.push(m),
    });
    return { r, said, n: () => ({ restores, ops }) };
  };

  it('a death in testMode: settled() waits for the restore', async () => {
    const { r, n } = make({});
    r.onDeath();
    expect(r.busy).toBe(true);
    let settled = false;
    void r.settled().then(() => (settled = true));
    await r.onRespawn();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(r.phase).toBe('idle');
    expect(n()).toEqual({ restores: 1, ops: 1 });
    expect(r.history[0]).toMatchObject({ phase: 'idle', steps: ['kit: elytra +1', 'tp 1 -60 2 (0.4 s)'] });
  });

  it('testMode off: nothing is asked, nothing is sent, nothing is said', async () => {
    const { r, said, n } = make({ enabled: false });
    await r.onRespawn(); // a respawn without a recorded death (the harness only records deaths in testMode)
    expect(n()).toEqual({ restores: 0, ops: 0 });
    expect(said).toEqual([]);
    expect(r.phase).toBe('idle');
  });

  it('no rights: says so once and does not try', async () => {
    const { r, said, n } = make({ op: NOT_OP });
    r.onDeath();
    await r.onRespawn();
    expect(n()).toEqual({ restores: 0, ops: 1 });
    expect(said).toEqual([`test: no recovery after the death: ${NOT_OP.line}`]);
    expect(r.phase).toBe('refused');
    expect(r.busy).toBe(false);
  });

  it('a failed restore is reported', async () => {
    const { r, said } = make({ ok: false });
    r.onDeath();
    await r.onRespawn();
    expect(r.phase).toBe('failed');
    expect(said[0]).toContain('tp: refused');
  });

  it('the respawn claim is per task and read live', () => {
    const task = {};
    let on = false;
    expect(respawnClaimed(task)).toBe(false);
    claimRespawn(task, () => on);
    expect(respawnClaimed(task)).toBe(false);
    on = true;
    expect(respawnClaimed(task)).toBe(true);
    claimRespawn(task, () => {
      throw new Error('x');
    });
    expect(respawnClaimed(task)).toBe(false);
  });
});

describe('Harness.restore', () => {
  const ports = (o: { health?: number; food?: number; refuse?: RegExp; follow?: boolean } = {}) => {
    const sent: string[] = [];
    let pos: Vec3 = { x: 100.5, y: 64, z: 100.5 };
    let t = 0;
    const p: HarnessPorts = {
      run: (c): Promise<CommandResult> => {
        sent.push(c);
        const m = /^\/tp @s (\S+) (\S+) (\S+)$/.exec(c);
        if (m && o.follow !== false) pos = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
        const refused = o.refuse?.test(c) ?? false;
        return Promise.resolve({ command: c, ok: !refused, successCount: refused ? 0 : 1, ...(refused ? { messageId: 'commands.generic.permission.selector' } : {}), params: [], ms: 50 });
      },
      position: () => pos,
      health: () => o.health ?? 20,
      food: () => o.food ?? 20,
      onGround: () => true,
      gliding: () => false,
      view: emptyView,
      waitChunks: () => Promise.resolve(),
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
      now: () => t,
      log: silentLogger,
    };
    return { h: new Harness(p), sent };
  };

  it('heals, gives the kit, teleports to the centre of the start cell and waits there', async () => {
    const { h, sent } = ports({ health: 9, food: 20 });
    const r = await h.restore({ x: 10, y: -60, z: -3 }, parseKitText('elytra, firework_rocket 16'), 100);
    expect(sent).toEqual(['/effect @s instant_health 1 4 true', '/effect @s saturation 1 4 true', '/give @s elytra 1', '/give @s firework_rocket 16', '/tp @s 10.5 -60 -2.5']);
    expect(r).toMatchObject({ ok: true, commands: 5 });
    expect(r.steps[0]).toBe('healed');
    expect(r.steps[1]).toBe('kit: elytra +1, firework_rocket +16');
    expect(r.steps[2]).toMatch(/^tp 10 -60 -3 /);
  });

  it('full health and an empty kit: only the /tp; no start: nothing at all', async () => {
    const a = ports();
    expect((await a.h.restore({ x: 0, y: 64, z: 0 }, [], 100)).ok).toBe(true);
    expect(a.sent).toEqual(['/tp @s 0.5 64 0.5']);
    const b = ports();
    expect(await b.h.restore(undefined, undefined, 100)).toEqual({ ok: true, steps: [], commands: 0 });
    expect(b.sent).toEqual([]);
  });

  it('a refused command or a body that never arrives fails the restore', async () => {
    const a = ports({ refuse: /^\/give/ });
    const r = await a.h.restore({ x: 0, y: 64, z: 0 }, parseKitText('elytra'), 100);
    expect(r.ok).toBe(false);
    expect(r.why).toContain('/give @s elytra 1: refused commands.generic.permission.selector');
    expect(a.sent).toEqual(['/give @s elytra 1']); // stops at the first refusal: no /tp
    const b = ports({ follow: false });
    const stuck = await b.h.restore({ x: 0, y: 64, z: 0 }, [], 100);
    expect(stuck.ok).toBe(false);
    expect(stuck.why).toContain('still at 100 64 100');
  });

  it('heal() is rate limited', async () => {
    const { h, sent } = ports();
    expect(await h.heal()).toBe(true);
    expect(await h.heal()).toBe(false);
    expect(sent).toEqual(['/effect @s instant_health 1 4 true']);
  });
});
