// Track E1 (docs/early-game.md "From nothing", ADR 0098): the obtain job's controller with a fake host: it runs the
// planner's commands as the owner one after the other, waits for each process, ends on done, on a step that got
// nothing, on `!get stop` and on an owner command that moves the bot.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { ironKitWords, kitWords, OBTAIN_ABORT_ON, ObtainController, targetsText } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const baseRecipes = new RecipeIndex((id) => fixture.items[String(id)]);
baseRecipes.handle(fixture);
// Track E2: the iron-age recipes (the armour, the bucket)
const ironFixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const ironRecipes = new RecipeIndex((id) => ironFixture.items[String(id)]);
ironRecipes.handle(ironFixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get kit', body: '!get kit', xuid: '', truth: false } as unknown as ChatLine;

function host(o: { sheep?: boolean; stone?: boolean; iron?: number; wear?: readonly string[]; recipes?: RecipeIndex; animals?: boolean } = {}) {
  const recipes = o.recipes ?? baseRecipes;
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  // Track E2: worn items (the armour pass and the offhand move right after a craft), a furnace set down, iron in the ground
  const worn: (ItemStack | null)[] = [];
  let furnace = false;
  let iron = o.iron ?? Infinity;
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
    worn,
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
        else if (verb === 'mine' && rest[0] === 'iron_ore')
          mk('mine', () => {
            const k = Math.min(n, iron);
            iron -= k;
            if (k > 0) add('raw_iron', k);
          });
        else if (verb === 'mine') mk('mine', () => (o.stone === false ? undefined : add('cobblestone', n)));
        else if (verb === 'furnace')
          mk('furnace', () => {
            take('furnace', 1);
            furnace = true;
          });
        else if (verb === 'smelt')
          mk('smelt', () => {
            take(rest[0]!, n);
            add('iron_ingot', n);
          });
        else if (verb === 'kill') mk('kill', () => (o.sheep === false ? undefined : add('white_wool', n)));
        else if (verb === 'food') mk('food', () => (o.animals === false ? undefined : add('beef', n)));
        else if (verb === 'craft') {
          const item = rest[0]!;
          mk('craft', () => {
            const c = planChain(recipes, [{ item, n: n + slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0) }], slots, keep);
            for (const st of c.steps) {
              const p = planCraft(recipes, st.item, st.n, slots, keep)!;
              for (const [k, v] of Object.entries(p.perCraft)) take(k, v * p.crafts);
              add(p.item, p.crafts * p.outputPer);
            }
            for (const w of o.wear ?? []) {
              const s = slots.find((x) => x?.name === w);
              if (!s) continue;
              take(w, 1);
              worn.push({ ...s, count: 1 });
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
      options: () => ({ ...keep, worn, furnaceNear: furnace }),
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
    expect(c.start(LINE, 'diamond_pickaxe', [{ item: 'diamond_pickaxe', n: 1 }], (m) => replies.push(m))).toBeUndefined();
    expect(replies).toEqual(['get stone_sword: already carried (stone_sword)', 'get diamond_pickaxe: no recipe for diamond_pickaxe']);
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

  it("Track E2: a shield moved to the offhand right after its craft counts as the step's gain; the job ends done", async () => {
    const h = host({ wear: ['shield'], recipes: ironRecipes });
    h.slots[0] = { name: 'oak_planks', count: 6, networkId: 1, metadata: 0 };
    h.slots[1] = { name: 'iron_ingot', count: 1, networkId: 1, metadata: 0 };
    h.slots[2] = { name: 'crafting_table', count: 1, networkId: 1, metadata: 0 };
    const c = new ObtainController({ ...h.host, recipes: ironRecipes });
    const job = c.start(LINE, 'shield', [{ item: 'shield', n: 1 }], () => undefined)!;
    expect(await job.result).toMatch(/^get shield: done in \d+ s, 1 step \(craft shield 1\)$/);
    expect(h.worn.map((s) => s?.name)).toEqual(['shield']);
  });

  it('Track E2: the iron kit with 13 iron in the ground: the furnace step counts, the soft armour is dropped after the short mine step, the reply says so', async () => {
    const h = host({ iron: 13, wear: ['shield', 'iron_boots'], recipes: ironRecipes });
    const kit: [string, number][] = [
      ['crafting_table', 1],
      ['stone_pickaxe', 1],
      ['stone_sword', 1],
      ['cobblestone', 24],
      ['oak_log', 8],
      ['bread', 6],
      ['coal', 4],
    ];
    kit.forEach(([name, count], i) => (h.slots[i] = { name, count, networkId: 1, metadata: 0 }));
    const c = new ObtainController({ ...h.host, recipes: ironRecipes });
    const replies: string[] = [];
    const { label, targets } = ObtainController.targetsFor('kit_iron', undefined);
    const job = c.start(LINE, label, targets, (m) => replies.push(m))!;
    expect(replies[0]).toMatch(/^getting the kit iron \(iron_pickaxe, iron_sword, shield, bucket, iron_chestplate, iron_leggings, iron_boots, iron_helmet, 6 food\): first !mine iron_ore 33$/);
    const end = await job.result;
    expect(h.dispatched.filter((d) => d.startsWith('mine iron_ore'))).toEqual(['mine iron_ore 33']);
    expect(h.dispatched).toContain('furnace');
    expect(h.dispatched).toContain('smelt raw_iron 13');
    expect(end).toMatch(/^get kit iron: done in \d+ s, \d+ steps; short: iron_chestplate, iron_leggings, iron_helmet \(!mine iron_ore 33 got 13\); steps: mine iron_ore 33, .*smelt raw_iron 13/);
    for (const t of ['iron_pickaxe', 'iron_sword', 'bucket']) expect(h.slots.some((s) => s?.name === t)).toBe(true);
    expect(h.worn.map((s) => s?.name).sort()).toEqual(['iron_boots', 'shield']);
  });

  it('Track E2: iron kit words', () => {
    expect(ironKitWords(['kit', 'iron'])).toBe(true);
    expect(ironKitWords(['iron', 'kit'])).toBe(true);
    expect(ironKitWords(['kit'])).toBe(false);
    expect(ObtainController.targetsFor('kit_iron', undefined).label).toBe('kit iron');
  });

  it('Track E2: the iron kit whose food was eaten and no animal is left: done, the food short, not stopped', async () => {
    const h = host({ iron: 33, wear: ['shield', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], recipes: ironRecipes, animals: false });
    const kit: [string, number][] = [
      ['crafting_table', 1],
      ['stone_pickaxe', 1],
      ['stone_sword', 1],
      ['cobblestone', 24],
      ['oak_log', 8],
      ['coal', 5],
    ];
    kit.forEach(([name, count], i) => (h.slots[i] = { name, count, networkId: 1, metadata: 0 }));
    const c = new ObtainController({ ...h.host, recipes: ironRecipes });
    const { label, targets } = ObtainController.targetsFor('kit_iron', undefined);
    const end = await c.start(LINE, label, targets, () => undefined)!.result;
    expect(end).toMatch(/^get kit iron: done in \d+ s, \d+ steps; food 0 of 6: !food 6 got nothing; steps: mine iron_ore 33, .*food 6$/);
    // the stone kit keeps E1's rule: no food at all is a stop
    const h2 = host({ animals: false });
    (['crafting_table', 'stone_pickaxe', 'stone_sword', 'stone_axe'] as const).forEach((name, i) => (h2.slots[i] = { name, count: 1, networkId: 1, metadata: 0 }));
    h2.slots[4] = { name: 'cobblestone', count: 16, networkId: 1, metadata: 0 };
    const c2 = new ObtainController(h2.host);
    const k = ObtainController.targetsFor('kit', undefined);
    expect(await c2.start(LINE, k.label, k.targets, () => undefined)!.result).toMatch(/^get kit: stopped after \d+ s, 1 step: !food 6 got nothing/);
  });
});
