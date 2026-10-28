// Track AW (wave 11, docs/crafting.md): the crafting commands (chat/commands-craft.ts) without
// walking, the argument parsing, the CraftProcess on the real ProcessManager with a fake runner
// (results, a resumed craft makes what is left, !stop), the compaction line, the settings and the
// natural-language step.
import { describe, expect, it } from 'vitest';
import { compactDone, compactRunnerFor, CRAFT_COMMANDS, CraftProcess, neverConsume, parseCraftArgs, registerCraftCommands, type CraftRunner } from '../../../src/chat/commands-craft.ts';
import { parseReserve, parseReserveText, RuntimeSettings } from '../../../src/config/settings.ts';
import { COMMAND_SPECS, parsePlan, PlanSchema, planLine, stepCommand } from '../../../src/nl/plan.ts';
import { EXAMPLES } from '../../../src/nl/prompt.ts';
import { compactLine } from '../../../src/skills/craft/compact.ts';
import type { CraftResult } from '../../../src/skills/craft/crafter.ts';
import type { CommandDeps } from '../../../src/tasks/process/deps.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));
const result = (o: Partial<CraftResult> = {}): CraftResult => ({ ok: true, reason: 'done', item: 'iron_block', wanted: 4, crafted: 4, used: { iron_ingot: 36 }, batches: 1, requests: 2, ms: 1200, ...o });

describe('craft commands', () => {
  it('without walking every command answers `needs a task that can walk`', () => {
    const cmds = new Map<string, (c: { reply: (m: string) => void; args: string[] }) => void>();
    const d = {
      chat: { register: (def: { name: string; run: (c: { reply: (m: string) => void; args: string[] }) => void }) => cmds.set(def.name, def.run) },
      processes: undefined,
      mobility: undefined,
      world: undefined,
      needsWalking: (c: string) => `${c} needs a task that can walk`,
    } as unknown as CommandDeps;
    expect(registerCraftCommands(d)).toBeUndefined();
    expect([...cmds.keys()]).toEqual([...CRAFT_COMMANDS]);
    const said: string[] = [];
    cmds.get('craft')!({ reply: (m) => said.push(m), args: ['iron_block'] });
    cmds.get('compact')!({ reply: (m) => said.push(m), args: [] });
    expect(said).toEqual(['craft needs a task that can walk', 'compact needs a task that can walk']);
  });

  it('parses `!craft <item> [n]` (either order), rejects bad counts and names', () => {
    expect(parseCraftArgs(['iron_block'])).toEqual({ item: 'iron_block', n: 1 });
    expect(parseCraftArgs(['iron_block', '4'])).toEqual({ item: 'iron_block', n: 4 });
    expect(parseCraftArgs(['32', 'oak_planks'])).toEqual({ item: 'oak_planks', n: 32 });
    expect(parseCraftArgs(['minecraft:Stick', '16'])).toEqual({ item: 'stick', n: 16 });
    expect(parseCraftArgs([])).toBeUndefined();
    expect(parseCraftArgs(['iron_block', '0'])).toBeUndefined();
    expect(parseCraftArgs(['iron_block', '2305'])).toBeUndefined();
    expect(parseCraftArgs(['iron block'])).toBeUndefined();
    expect(parseCraftArgs(['a', 'b', 'c'])).toBeUndefined();
  });

  it('never consumes tools, armour, food, totems, shulker boxes, the flight kit', () => {
    for (const n of ['diamond_pickaxe', 'iron_chestplate', 'bread', 'totem_of_undying', 'undyed_shulker_box', 'elytra', 'firework_rocket', 'ender_chest']) expect(neverConsume(n)).toBe(true);
    for (const n of ['iron_ingot', 'raw_iron', 'oak_planks', 'oak_log', 'diamond', 'crafting_table', 'cobblestone']) expect(neverConsume(n)).toBe(false);
  });

  it('CraftProcess: a craft job resolves its results; a pause and resume crafts only what is left; !stop ends it', async () => {
    const calls: string[] = [];
    const pending: ((r: CraftResult) => void)[] = [];
    const runner: CraftRunner = {
      craft: (_c, item, n) => {
        calls.push(`craft ${n} ${item}`);
        return new Promise((r) => pending.push(r));
      },
      cancel: () => calls.push('cancel'),
    };
    const m = new ProcessManager();
    const p = m.add(new CraftProcess(runner, { kind: 'craft', item: 'iron_block', n: 4 }));
    m.tick();
    expect(calls).toEqual(['craft 4 iron_block']);
    expect(p.status().line).toBe('craft 4 iron_block (running)');
    // a pre-emption: pause, then resume -> the remaining 3
    p.pause();
    pending[0]!(result({ crafted: 1, used: { iron_ingot: 9 }, reason: 'interrupted' }));
    await flush();
    expect(p.done).toBe(false);
    p.resume();
    expect(calls).toEqual(['craft 4 iron_block', 'cancel', 'craft 3 iron_block']);
    expect(p.status().line).toBe('craft 4 iron_block (1 done) (running)');
    pending[1]!(result({ crafted: 3, used: { iron_ingot: 27 } }));
    await flush();
    const rs = await p.result;
    expect(rs?.map((r) => r.crafted)).toEqual([1, 3]);
    expect(p.done).toBe(true);
    // stop
    const q = m.add(new CraftProcess(runner, { kind: 'compact' }, () => [{ kind: 'raw_iron', block: 'raw_iron_block', blocks: 5 }]));
    m.tick();
    expect(calls.at(-1)).toBe('craft 5 raw_iron_block');
    m.stopUser();
    expect(await q.result).toBeUndefined();
    expect(calls.at(-1)).toBe('cancel');
  });

  it('the compaction line from the craft results', () => {
    const done = compactDone([result({ item: 'raw_iron_block', crafted: 6, used: { raw_iron: 54 } }), result({ item: 'iron_block', crafted: 0, used: {}, reason: 'missing', ok: false })]);
    expect(done).toEqual([{ kind: 'raw_iron', block: 'raw_iron_block', blocks: 6, uses: 54 }]);
    expect(compactLine(done)).toBe('compacted 54 raw_iron into 6 raw_iron_block');
    expect(compactLine([])).toBe('compact: nothing compacted');
  });

  it('the compaction runner for the unload job: crafts each step, answers the reply fragment, stops when cancelled', async () => {
    const calls: string[] = [];
    const runner = compactRunnerFor(
      (block, blocks) => {
        calls.push(`${blocks} ${block}`);
        return Promise.resolve(result({ item: block, crafted: blocks, used: { [block === 'raw_iron_block' ? 'raw_iron' : 'coal']: blocks * 9 } }));
      },
      (kind) => (kind === 'raw_iron' ? 'raw_iron_block' : kind === 'coal' ? 'coal_block' : undefined),
    );
    expect(await runner([{ kind: 'raw_iron', count: 27 }, { kind: 'coal', count: 18 }, { kind: 'sand', count: 64 }, { kind: 'coal', count: 5 }], () => false)).toBe('compacted 27 raw_iron into 3 raw_iron_block; 18 coal into 2 coal_block');
    expect(calls).toEqual(['3 raw_iron_block', '2 coal_block']);
    expect(await runner([{ kind: 'raw_iron', count: 27 }], () => true)).toBeUndefined();
    const none = compactRunnerFor((block, blocks) => Promise.resolve(result({ item: block, crafted: 0, used: {}, ok: false, reason: 'no_table', wanted: blocks })), () => 'raw_iron_block');
    expect(await none([{ kind: 'raw_iron', count: 27 }], () => false)).toBeUndefined();
  });

  it('settings: craftReserve (item n[, item n] | none) and compactOnUnload (default on)', () => {
    const s = new RuntimeSettings();
    expect(s.get('craftReserve')).toBe('none');
    expect(s.get('compactOnUnload')).toBe(true);
    expect(s.set('craftReserve', 'iron_ingot 9, minecraft:diamond 4')).toBe('iron_ingot 9, diamond 4');
    expect(parseReserve(s.get('craftReserve'))).toEqual(new Map([['iron_ingot', 9], ['diamond', 4]]));
    expect(parseReserve('none')).toEqual(new Map());
    expect(parseReserveText('NONE', 'craftReserve')).toBe('none');
    expect(() => s.set('craftReserve', 'iron_ingot')).toThrow(/craftReserve must be/);
    expect(() => s.set('craftReserve', 'iron ingot 9')).toThrow();
    expect(() => parseReserveText('diamond x', 'craftReserve')).toThrow(/craftReserve must be "item n\[, item n\]" or none, got "diamond x"/);
    expect(parseReserveText(' Iron_Ingot 09 ,diamond 4 ', 'craftReserve')).toBe('iron_ingot 9, diamond 4');
    expect(s.set('compactOnUnload', 'off')).toBe(false);
  });

  it('natural language: the craft step, its command text and example', () => {
    const r = parsePlan('{"steps":[{"command":"craft","item":"iron_block","count":4},{"command":"craft","item":"stick"}]}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.steps.map(stepCommand)).toEqual(['craft iron_block 4', 'craft stick']);
    expect(planLine(r.plan)).toBe('plan: craft iron_block 4, then craft stick');
    expect(PlanSchema.safeParse({ steps: [{ command: 'craft', item: 'iron_block', count: 0 }] }).success).toBe(false);
    expect(COMMAND_SPECS.craft).toMatchObject({ chat: 'craft', wait: 'process' });
    expect(COMMAND_SPECS.craft.done!.test('crafted 4 iron_block (36 iron_ingot used) in 2.1 s')).toBe(true);
    expect(COMMAND_SPECS.craft.fail!.test('craft: no iron_ingot for iron_block (need 9, have 0)')).toBe(true);
    expect(EXAMPLES.some((e) => e.plan.steps[0]?.command === 'craft')).toBe(true);
  });
});
