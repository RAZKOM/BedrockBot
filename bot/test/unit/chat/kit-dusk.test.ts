// Track E7 (docs/early-game.md "Dusk", "The shell's blocks", "The end line", ADR 0104): the obtain job's controller with
// a fake host at dusk: a mine step running when dusk comes is ended, the job says where it spends the night and waits,
// at dawn it says so and mines the rest; a job started by night runs on; the shell's blocks are dug before dusk and at
// the end; the end line goes through sayEnd (past the chat rate limit).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { ObtainController } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ObtainBlocks, ObtainNight, ShelterPlan } from '../../../src/chat/kit-night.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ObtainOptions, ObtainTarget } from '../../../src/skills/items/obtain.ts';
import { DAWN, DUSK } from '../../../src/tasks/night.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get kit', body: '!get kit', xuid: '', truth: false } as unknown as ChatLine;
const FURNACE_AT: Vec3 = { x: 3, y: 64, z: 1 };
const START = [
  ['stone_pickaxe', 1],
  ['crafting_table', 1],
  ['cobblestone', 16],
  ['oak_planks', 8],
  ['coal', 2],
] as const;

interface Opts {
  /** The first mine step runs until stopped (raw iron 2 in it). */
  longMine?: boolean;
  time: { t: number };
  blocks?: { short: number; enabled?: boolean };
  jobDusk?: boolean;
  /** The night's plan (default the shelter). */
  plan?: ShelterPlan;
  /** The plan from where the bot stands (after the night rule gave up). */
  fallback?: ShelterPlan;
}

function host(o: Opts) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const add = (name: string, n: number) => {
    const s = slots.find((x) => x?.name === name && !/_(pickaxe|sword|axe)$/.test(name));
    if (s) s.count += n;
    else slots[slots.indexOf(null)] = { name, count: n, networkId: 1, metadata: 0 };
  };
  for (const [n, c] of START) add(n, c);
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
  let furnace = false;
  let longDone = false;
  const replies: string[] = [];
  const ends: string[] = [];
  const dispatched: string[] = [];
  const events: string[] = [];
  const procs: (Process & { finish(): void })[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  const mk = (name: string, effect: () => void, auto = true): Process & { finish(): void } => {
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
    if (auto) setTimeout(() => p.finish(), 5);
    return p;
  };
  let busy = false;
  let gaveUp = false;
  const night: ObtainNight = {
    enabled: () => o.jobDusk !== false,
    time: () => o.time.t,
    dusk: DUSK,
    dawn: DAWN,
    plan: () => o.plan ?? { kind: 'shelter', set: undefined, text: 'at the shelter 1 64 1' },
    enter: (p) => {
      events.push(`enter ${p.kind}`);
      busy = true;
      gaveUp = false;
    },
    gaveUp: () => gaveUp,
    fallback: () => {
      events.push('fallback');
      return o.fallback ?? { kind: 'none', set: undefined, text: 'nowhere to shelter' };
    },
    release: () => events.push('release'),
    busy: () => busy,
  };
  const bl = o.blocks;
  const blocks: ObtainBlocks | undefined = bl
    ? {
        enabled: () => bl.enabled !== false,
        short: () => bl.short,
        refill: () => {
          events.push(`refill at ${o.time.t % 24000}`);
          const before = 10 - bl.short;
          bl.short = 0;
          return { result: Promise.resolve({ before, after: 10, dug: 10 - before }) };
        },
      }
    : undefined;
  const h = {
    slots,
    replies,
    ends,
    dispatched,
    events,
    setBusy: (b: boolean) => (busy = b),
    giveUp: () => {
      gaveUp = true;
      busy = false;
    },
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb, ...rest] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        const n = Number(rest.at(-1));
        if (verb === 'mine' && rest[0] === 'iron_ore' && o.longMine && !longDone) {
          longDone = true;
          mk('mine', () => undefined, false);
          setTimeout(() => add('raw_iron', 2), 5);
        } else if (verb === 'mine' && rest[0] === 'iron_ore') mk('mine', () => add('raw_iron', n));
        else if (verb === 'mine') mk('mine', () => add('cobblestone', n));
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
        else if (verb === 'craft') {
          const item = rest[0]!;
          mk('craft', () => {
            const have = slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0);
            const c = planChain(recipes, [{ item, n: n + have }], slots, keep);
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
          (p as Process & { finish(): void }).finish();
          return true;
        },
      },
      slots: () => slots,
      recipes,
      options: (): ObtainOptions => ({ ...keep, worn: [], furnaceNear: furnace }),
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
      furnace: () => (furnace ? FURNACE_AT : undefined),
      night,
      ...(blocks ? { blocks } : {}),
      sayEnd: (m: string) => ends.push(m),
    },
  };
  return h;
}

const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

function start(h: ReturnType<typeof host>, targets: readonly ObtainTarget[]): Promise<string> {
  const c = new ObtainController(h.host);
  const job = c.start(LINE, 'test', targets, (m) => h.replies.push(m));
  expect(job).toBeDefined();
  return job!.result;
}

describe('Track E7: the obtain job at dusk (jobDusk)', () => {
  it('a mine step at dusk is ended; the job waits out the night where the bot shelters and mines the rest at dawn', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    expect(h.replies.find((r) => r.includes('paused'))).toBe('get test: paused for the night at step 1 (mine iron_ore 5: 2 of 5), at the shelter 1 64 1; resuming at dawn');
    expect(h.events).toEqual(['enter shelter']);
    // the night: nothing is dispatched
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    // dawn, but the night process still holds the bot (its shell shut): still waiting
    time.t = 24000 + 100;
    await new Promise((r) => setTimeout(r, 20));
    expect(h.dispatched).toEqual(['mine iron_ore 5']);
    h.setBusy(false);
    const end = await result;
    expect(h.replies.find((r) => r.includes('dawn: going on'))).toBe('get test: dawn: going on (paused at !mine iron_ore 5)');
    expect(h.events).toEqual(['enter shelter', 'release']);
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; paused for 1 night; steps: mine iron_ore 5, mine iron_ore 3, /);
    expect(h.ends).toEqual([end]); // the end line through sayEnd
    expect(h.replies).not.toContain(end);
  });

  it('a job started by night runs on (it pauses at the next dusk only); jobDusk off: no pause', async () => {
    const time = { t: DUSK + 500 };
    const h = host({ time });
    const end = await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(end).toMatch(/^get test: done in/);
    expect(h.replies.some((r) => r.includes('paused'))).toBe(false);
    const t2 = { t: 6000 };
    const off = host({ longMine: true, time: t2, jobDusk: false });
    const r2 = start(off, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => off.dispatched.length === 1);
    t2.t = DUSK + 100;
    await new Promise((r) => setTimeout(r, 30));
    expect(off.replies.some((r) => r.includes('paused'))).toBe(false);
    off.host.processes.userProcesses().forEach((p) => off.host.processes.stop(p));
    await r2;
  });

  it('nowhere to spend the night: the step is not ended and the job works on (said in the end line)', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time, plan: { kind: 'none', set: undefined, text: 'nowhere to shelter' } });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.replies.some((r) => r.includes('paused'))).toBe(false);
    expect(h.events).toEqual([]); // no shelter entered
    expect(h.host.processes.userProcesses()).toHaveLength(1); // the mine step still runs
    h.host.processes.userProcesses().forEach((p) => h.host.processes.stop(p));
    const end = await result;
    expect(end).toContain('worked through a night (nowhere to shelter)');
  });

  it('the shelter out of reach: the plan from where the bot stands once; nowhere there: the pause ends and the job goes on', async () => {
    const time = { t: 6000 };
    const h = host({ longMine: true, time, fallback: { kind: 'enclosed', set: { x: 4, y: 40, z: 4 }, text: 'in the roofed spot at 4 40 4' } });
    const result = start(h, [{ item: 'iron_helmet', n: 1 }]);
    await until(() => h.dispatched.length === 1 && h.slots.some((s) => s?.name === 'raw_iron'));
    time.t = DUSK + 100;
    await until(() => h.replies.some((r) => r.includes('paused for the night')));
    h.giveUp();
    await until(() => h.events.includes('enter enclosed'));
    expect(h.events).toEqual(['enter shelter', 'fallback', 'enter enclosed']);
    // the roofed spot is out of reach too: no second fallback, the job goes on tonight
    h.giveUp();
    const end = await result;
    expect(h.events).toEqual(['enter shelter', 'fallback', 'enter enclosed', 'release']);
    expect(h.replies.some((r) => r.includes('going on tonight'))).toBe(true);
    expect(h.dispatched[1]).toBe('mine iron_ore 3');
    expect(end).toContain('worked through a night (the shelter out of reach)');
    expect(end).not.toContain('paused for');
  });
});

describe('Track E7: the shell blocks in the job (shellBlocks)', () => {
  it('short before dusk: dug first (once that day); the reserve there: nothing', async () => {
    const time = { t: DUSK - 600 };
    const h = host({ time, blocks: { short: 6 } });
    await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.events).toEqual([`refill at ${DUSK - 600}`]);
    expect(h.dispatched[0]).toBe('mine iron_ore 5');
    const full = host({ time: { t: DUSK - 600 }, blocks: { short: 0 } });
    await start(full, [{ item: 'iron_helmet', n: 1 }]);
    expect(full.events).toEqual([]);
  });

  it('by day far from dusk: dug at the end, before the end line; the setting off: never', async () => {
    const h = host({ time: { t: 2000 }, blocks: { short: 4 } });
    const end = await start(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.events).toEqual(['refill at 2000']);
    expect(end).toMatch(/dug the night shell's blocks/);
    const off = host({ time: { t: 2000 }, blocks: { short: 4, enabled: false } });
    await start(off, [{ item: 'iron_helmet', n: 1 }]);
    expect(off.events).toEqual([]);
  });
});
