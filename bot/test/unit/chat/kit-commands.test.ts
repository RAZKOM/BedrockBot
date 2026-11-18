// Track E1 (docs/early-game.md "From nothing", ADR 0098): the obtain job's controller with a fake host: it runs the
// planner's commands as the owner one after the other, waits for each process, ends on done, on a step that got
// nothing, on `!get stop` and on an owner command that moves the bot.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { kitWords, OBTAIN_ABORT_ON, ObtainController, targetsText } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get kit', body: '!get kit', xuid: '', truth: false } as unknown as ChatLine;

function host(o: { sheep?: boolean; stone?: boolean } = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const add = (name: string, n: number) => {
    const s = slots.find((x) => x?.name === name);
    if (s) s.count += n;
    else slots[slots.indexOf(null)] = { name, count: n, networkId: 1, metadata: 0 };
  };
  const take = (name: string, n: number) => {
    for (let i = 0; i < 36 && n > 0; i++) {
      const s = slots[i];
      if (s?.name !== name) continue;
      const t = Math.min(n, s.count);
      s.count -= t;
      n -= t;
      if (s.count === 0) slots[i] = null;
    }
  };
  const procs: (Process & { finish(): void })[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  const dispatched: string[] = [];
  const stopped: string[] = [];
  const mk = (name: string, effect: () => void): void => {
    let done = false;
    const p = {
      name,
      kind: 'user',
      priority: 40,
      get done() {
        return done;
      },
      status: () => ({ line: `${name} running` }),
      finish: () => {
        if (done) return;
        effect();
        done = true;
      },
    } as unknown as Process & { finish(): void };
    procs.push(p);
    setTimeout(() => p.finish(), 5);
  };
  const h = {
    dispatched,
    stopped,
    slots,
    emit: (e: CommandEvent) => {
      for (const fn of listeners) fn(e);
    },
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb, ...rest] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        const n = Number(rest.at(-1));
        if (verb === 'gather') mk('gather', () => add('oak_log', Math.ceil(n / 6) * 6));
        else if (verb === 'mine') mk('mine', () => (o.stone === false ? undefined : add('cobblestone', n)));
        else if (verb === 'kill') mk('kill', () => (o.sheep === false ? undefined : add('white_wool', n)));
        else if (verb === 'food') mk('food', () => add('beef', n));
        else if (verb === 'craft') {
          const item = rest[0]!;
          mk('craft', () => {
            const c = planChain(recipes, [{ item, n: n + slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0) }], slots, keep);
            for (const st of c.steps) {
              const p = planCraft(recipes, st.item, st.n, slots, keep)!;
              for (const [k, v] of Object.entries(p.perCraft)) take(k, v * p.crafts);
              add(p.item, p.crafts * p.outputPer);
            }
          });
        }
      },
      processes: {
        userProcesses: () => procs.filter((p) => !p.done),
        stop: (p: Process) => {
          stopped.push(p.name);
          (p as Process & { finish(): void }).finish();
          return true;
        },
      },
      slots: () => slots,
      recipes,
      options: () => keep,
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
    },
  };
  return h;
}

describe('the obtain job (Track E1)', () => {
  it('the kit from nothing: one log trip, then crafts, mining and food, and a done line listing the steps', async () => {
    const h = host();
    const c = new ObtainController(h.host);
    const replies: string[] = [];
    const job = c.start(LINE, 'kit', ObtainController.targetsFor('kit', undefined).targets, (m) => replies.push(m))!;
    expect(replies[0]).toMatch(/^getting the kit \(crafting_table, stone_sword, stone_pickaxe, stone_axe, \d+ cobblestone, 6 food\): first !gather \d+$/);
    const end = await job.result;
    expect(end).toMatch(/^get kit: done in \d+ s, \d+ steps \(gather \d+, .*mine stone \d+.*food 6\)$/);
    expect(h.dispatched.filter((d) => d.startsWith('gather'))).toHaveLength(1);
    for (const t of ['crafting_table', 'stone_sword', 'stone_pickaxe', 'stone_axe']) expect(h.slots.some((s) => s?.name === t)).toBe(true);
    expect(c.busy).toBe(false);
  });

  it('a step that gets nothing ends the job with that command and its reply', async () => {
    const h = host({ sheep: false });
    const c = new ObtainController(h.host);
    const replies: string[] = [];
    const job = c.start(LINE, 'bed', [{ item: 'bed', n: 1 }], (m) => replies.push(m))!;
    setTimeout(() => c.observeReply('kill sheep: 0/3, no more within 32 blocks'), 30);
    const end = await job.result;
    expect(end).toMatch(/^get bed: stopped after \d+ s, 2 steps: !kill sheep 3 got nothing/);
  });

  it('carried already, and what has no rule: one reply, no job', () => {
    const h = host();
    h.slots[0] = { name: 'stone_sword', count: 1, networkId: 1, metadata: 0 };
    const c = new ObtainController(h.host);
    const replies: string[] = [];
    expect(c.start(LINE, 'stone_sword', [{ item: 'stone_sword', n: 1 }], (m) => replies.push(m))).toBeUndefined();
    expect(c.start(LINE, 'iron_pickaxe', [{ item: 'iron_pickaxe', n: 1 }], (m) => replies.push(m))).toBeUndefined();
    expect(replies).toEqual(['get stone_sword: already carried (stone_sword)', expect.stringMatching(/^get iron_pickaxe: no way to get iron_pickaxe yet: it needs iron_ingot/)]);
    expect(h.dispatched).toEqual([]);
  });

  it('`!get stop` ends the job and its step; an owner command that moves the bot drops it; its own commands do not', async () => {
    const h = host();
    const c = new ObtainController(h.host);
    const replies: string[] = [];
    const job = c.start(LINE, 'kit', ObtainController.targetsFor('kit', undefined).targets, (m) => replies.push(m))!;
    expect(c.stop()).toMatch(/^stopped get kit after 0 steps/);
    await job.result;
    expect(replies).toHaveLength(1); // the start line only: `!get stop` answers for the stop
    const job2 = c.start(LINE, 'kit', ObtainController.targetsFor('kit', undefined).targets, (m) => replies.push(m))!;
    await new Promise((r) => setTimeout(r, 1));
    h.emit({ kind: 'run', name: 'goto', sender: { name: 'Owner' } } as never);
    expect(await job2.result).toMatch(/^get kit: stopped by !goto/);
    expect(OBTAIN_ABORT_ON.has('status')).toBe(false);
  });

  it('words', () => {
    expect(kitWords(['kit'])).toBe(true);
    expect(kitWords(['kit', 'early'])).toBe(true);
    expect(kitWords(['kit', 'iron'])).toBe(false);
    expect(targetsText([{ item: 'stone_sword', n: 1 }, { item: 'food', n: 6 }])).toBe('stone_sword, 6 food');
  });
});
