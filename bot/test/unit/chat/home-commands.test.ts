// Wave 9 Track AG: the home commands (chat/commands-home.ts) without walking, the scan reply, the two
// settings, and the natural-language steps for !unload / !stock / !chests (nl/plan.ts).
import { describe, expect, it } from 'vitest';
import { HOME_COMMANDS, registerHomeCommands, scanLine } from '../../../src/chat/commands-home.ts';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { PlanSchema, stepCommand, type Step } from '../../../src/nl/plan.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';

describe('home commands', () => {
  it('without walking every command answers `needs a task that can walk`', () => {
    const cmds = new Map<string, (c: { reply: (m: string) => void; args: string[] }) => void>();
    const d = {
      chat: { register: (def: { name: string; run: (c: { reply: (m: string) => void; args: string[] }) => void }) => cmds.set(def.name, def.run) },
      processes: undefined,
      mobility: undefined,
      world: undefined,
      needsWalking: (c: string) => `${c} needs a task that can walk`,
    } as unknown as CommandDeps;
    expect(registerHomeCommands(d)).toBeUndefined();
    expect([...cmds.keys()]).toEqual([...HOME_COMMANDS]);
    const said: string[] = [];
    cmds.get('unload')!({ reply: (m) => said.push(m), args: [] });
    expect(said).toEqual(['unload needs a task that can walk']);
  });

  it('scanLine', () => {
    expect(scanLine({ ok: true, found: 6, read: [{} as never, {} as never], fresh: 3, forgotten: 1, failed: [{ p: { x: 1, y: 2, z: 3 }, reason: 'open: timeout' }], requests: 0, ms: 5900, radius: 16 })).toBe(
      'chests: 6 within 16 blocks, read 2, 3 read less than 10 min ago, 1 forgotten, could not open 1 2 3 (open: timeout), in 5.9 s',
    );
    // Track AN: the owner's Realm case
    const p = { x: 0, y: 0, z: 0 };
    expect(
      scanLine({
        ok: true,
        found: 181,
        read: Array.from({ length: 64 }, () => ({}) as never),
        fresh: 0,
        forgotten: 0,
        failed: [],
        requests: 0,
        ms: 95_200,
        radius: 16,
        walk: 32,
        reachable: 140,
        unreachable: Array.from({ length: 41 }, () => ({ p, kind: 'chest', reason: 'no path' })),
        pending: Array.from({ length: 76 }, () => p),
      }),
    ).toBe('chests: 181 within 16 blocks, 140 reachable within 32 path blocks, read 64 (76 pending), 41 unreachable, in 95 s');
    expect(scanLine({ ok: false, reason: 'no_home', found: 0, read: [], fresh: 0, forgotten: 0, failed: [], requests: 0, ms: 0 })).toBe('chests: no home set (!home set)');
  });

  it('settings homeChestRadius (2..48, default 16) and autoUnload (default on)', () => {
    const s = new RuntimeSettings();
    expect(s.get('homeChestRadius')).toBe(16);
    expect(s.get('autoUnload')).toBe(true);
    expect(s.set('homeChestRadius', '24')).toBe(24);
    expect(() => s.set('homeChestRadius', '100')).toThrow();
    expect(s.set('autoUnload', 'off')).toBe(false);
    // Track AN: homeChestWalk (0..256 path blocks, default 32; 0 = radius only)
    expect(s.get('homeChestWalk')).toBe(32);
    expect(s.set('homeChestWalk', '0')).toBe(0);
    expect(() => s.set('homeChestWalk', '-1')).toThrow();
  });

  it('natural language: unload / stock / chests steps', () => {
    const steps: Step[] = [{ command: 'unload' }, { command: 'unload', all: true }, { command: 'stock' }, { command: 'stock', item: 'coal' }, { command: 'chests' }, { command: 'chests', scan: true }];
    expect(PlanSchema.safeParse({ steps }).success).toBe(true);
    expect(steps.map(stepCommand)).toEqual(['unload', 'unload all', 'stock', 'stock coal', 'chests', 'chests scan']);
    expect(PlanSchema.safeParse({ steps: [{ command: 'stock', item: 'Coal!' }] }).success).toBe(false);
  });
});
