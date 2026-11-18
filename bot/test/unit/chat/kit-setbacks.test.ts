// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the obtain job's controller with a fake host through
// wear and setbacks: a pickaxe that wears out in a mine step is replaced and the rest mined (the material is not
// capped); the job's crafting table stands between its crafts, counts as carried (no second one) and is picked up
// before a step that walks off and at the end; a death ends the job with `deathReturn` off, and with it on the job
// walks back, takes what the furnace holds and goes on, or says why it does not.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { ObtainController, type ObtainDeaths, type ObtainTables } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ObtainOptions, ObtainTarget } from '../../../src/skills/items/obtain.ts';
import { makeToolOk } from '../../../src/skills/survival/tools.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { RecoverRequest } from '../../../src/tasks/process/recover.ts';
import type { DeathRecord } from '../../../src/tasks/respawn.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const toolOk = makeToolOk(() => 10);
const LINE = { type: 'chat', source: 'Owner', message: '!get kit', body: '!get kit', xuid: '', truth: false } as unknown as ChatLine;
const FURNACE_AT: Vec3 = { x: 3, y: 64, z: 1 };

interface HostOpts {
  /** The stone pickaxe wears out after this many iron ore in one mine step (the step ends there). */
  wearAt?: number;
  /** The stone pickaxe reaches the limit mid-step after 2 iron ore and the step runs on until stopped (the miner digs on with a worn pickaxe in hand). */
  wearMid?: boolean;
  /** The crafter holds its table standing between crafts (Track E4's ObtainTables). */
  tables?: boolean;
  /** A death in the first step whose command starts with this. */
  dieIn?: string;
  deathReturn?: boolean;
  time?: number;
}

function host(start: readonly (readonly [string, number, number?])[], o: HostOpts = {}) {
  const slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  const add = (name: string, n: number, damage?: number) => {
    const s = damage === undefined ? slots.find((x) => x?.name === name && x.damage === undefined && !/_(pickaxe|sword|axe)$/.test(name)) : undefined;
    if (s) s.count += n;
    else slots[slots.indexOf(null)] = { name, count: n, networkId: 1, metadata: 0, ...(damage !== undefined ? { damage } : {}) };
  };
  for (const [n, c, dmg] of start) add(n, c, dmg);
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
  let standing = 0;
  const log: string[] = [];
  const replies: string[] = [];
  const procs: (Process & { finish(): void })[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  const dispatched: string[] = [];
  const ref: { c?: ObtainController } = {};
  let died = false;
  let woreMid = false;
  let dropped: (ItemStack | null)[] = [];
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
  const die = () => {
    died = true;
    dropped = slots.map((s) => (s ? { ...s } : null));
    const rec: DeathRecord = { n: 1, ts: '', cause: 'death.attack.mob', messages: [], at: { x: 30, y: 64, z: 40 } };
    ref.c!.onDeath(rec);
    for (let i = 0; i < 36; i++) slots[i] = null;
    furnaceHeld = FURNACE_AT;
    setTimeout(() => void ref.c!.afterRespawn({ x: 0, y: 64, z: 0 }, rec, new AbortController().signal), 20);
  };
  let furnaceHeld: Vec3 | undefined;
  const goHome: string[] = [];
  const recovered: RecoverRequest[] = [];
  const tables: ObtainTables = {
    hold: (on) => log.push(`hold ${on}`),
    standing: () => standing,
    sweep: () => {
      log.push(`sweep ${standing}`);
      const picked = standing;
      if (standing > 0) add('crafting_table', standing);
      standing = 0;
      return { result: Promise.resolve({ picked, kept: 0, left: [] }) };
    },
  };
  const deaths: ObtainDeaths = {
    enabled: () => o.deathReturn === true,
    time: () => o.time,
    allSlots: () => slots,
    recover: (req) => {
      recovered.push(req);
      // the drops come back, all but one stack
      const back = dropped.filter((s): s is ItemStack => !!s);
      for (const s of back.slice(0, back.length - 1)) add(s.name, s.count, s.damage);
      return { result: Promise.resolve({ arrived: true, reason: 'done', gained: {} }) };
    },
    heldFurnace: () => furnaceHeld,
    collectFurnace: () => {
      add('iron_ingot', 5);
      furnaceHeld = undefined;
      return { result: Promise.resolve({ line: 'smelted 5 iron_ingot in the furnace at 3 64 1 (50 s)', taken: 5 }) };
    },
    goHome: () => goHome.push('home'),
  };
  const h = {
    slots,
    log,
    replies,
    dispatched,
    goHome,
    recovered,
    ref,
    died: () => died,
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb, ...rest] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        const n = Number(rest.at(-1));
        if (o.dieIn && !died && command.startsWith(o.dieIn)) {
          mk(verb!, () => die());
          return;
        }
        if (verb === 'gather') mk('gather', () => add('oak_log', n));
        else if (verb === 'mine' && rest[0] === 'iron_ore' && o.wearMid && !woreMid && slots.some((s) => s?.name === 'stone_pickaxe' && toolOk(s))) {
          woreMid = true;
          const pick = slots.find((s) => s?.name === 'stone_pickaxe' && toolOk(s))!;
          mk('mine', () => undefined, false);
          setTimeout(() => {
            add('raw_iron', 2);
            pick.damage = 125;
          }, 10);
        } else if (verb === 'mine' && rest[0] === 'iron_ore')
          mk('mine', () => {
            const pick = slots.find((s) => s?.name === 'stone_pickaxe' && toolOk(s));
            if (!pick) return;
            const k = o.wearAt !== undefined ? Math.min(n, o.wearAt) : n;
            add('raw_iron', k);
            if (o.wearAt !== undefined && k < n) pick.damage = 125; // worn out: 6 uses left
          });
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
            // a held table standing counts for the 3 x 3 crafts
            const c = planChain(recipes, [{ item, n: n + have }], slots, { ...keep, tableNear: standing > 0 });
            for (const st of c.steps) {
              const p = planCraft(recipes, st.item, st.n, slots, keep)!;
              for (const [k, v] of Object.entries(p.perCraft)) take(k, v * p.crafts);
              add(p.item, p.crafts * p.outputPer);
              // the crafter sets its table down and holds it standing (Track E4)
              if (o.tables && p.table && slots.some((s) => s?.name === 'crafting_table')) {
                take('crafting_table', 1);
                standing++;
              }
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
      options: (): ObtainOptions => ({ ...keep, worn: [], furnaceNear: furnace, toolOk }),
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
      furnace: () => (furnace ? FURNACE_AT : undefined),
      ...(o.tables ? { tables } : {}),
      deaths,
    },
  };
  return h;
}

async function run(h: ReturnType<typeof host>, targets: readonly ObtainTarget[]): Promise<string> {
  const c = new ObtainController(h.host);
  h.ref.c = c;
  const job = c.start(LINE, 'test', targets, (m) => h.replies.push(m));
  expect(job).toBeDefined();
  return job!.result;
}

describe('Track E4: the obtain job through wear and setbacks', () => {
  it('a stone pickaxe worn out at 3 of 5 iron ore: replaced from the cobblestone, the rest mined, the soft helmet still made', async () => {
    const start = [
      ['stone_pickaxe', 1, 40],
      ['crafting_table', 1],
      ['cobblestone', 16],
      ['oak_planks', 8],
      ['coal', 2],
    ] as const;
    const targets: ObtainTarget[] = [{ item: 'iron_helmet', n: 1, soft: true }];
    // before (no worn-tool rule in the plan: toolOk left out): the short step caps the iron and the helmet is dropped
    const b = host(start, { wearAt: 3 });
    const before = await run({ ...b, host: { ...b.host, options: () => ({ ...keep, worn: [], furnaceNear: b.host.furnace() !== undefined }) } }, targets);
    expect(before).toMatch(/done in \d+ s, \d+ steps?; short: iron_helmet \(!mine iron_ore 5 got 3\)/);
    // after
    const h = host(start, { wearAt: 3 });
    const end = await run(h, targets);
    expect(h.dispatched.slice(0, 3)).toEqual(['mine iron_ore 5', 'craft stone_pickaxe 1', 'mine iron_ore 2']);
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; replaced the stone_pickaxe \(worn\); steps: mine iron_ore 5, craft stone_pickaxe 1, mine iron_ore 2, .*craft iron_helmet 1$/);
    expect(h.slots.some((s) => s?.name === 'iron_helmet')).toBe(true);
  });

  it('mid-step: the pickaxe reaches the limit while the mine step digs on; the job ends the step, replaces the pickaxe, mines the rest', async () => {
    const h = host(
      [
        ['stone_pickaxe', 1, 100],
        ['crafting_table', 1],
        ['cobblestone', 16],
        ['oak_planks', 8],
        ['coal', 2],
      ],
      { wearMid: true },
    );
    const end = await run(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.dispatched.slice(0, 3)).toEqual(['mine iron_ore 5', 'craft stone_pickaxe 1', 'mine iron_ore 3']);
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; replaced the stone_pickaxe \(worn\); steps: mine iron_ore 5, craft stone_pickaxe 1, mine iron_ore 3, .*craft iron_helmet 1$/);
    // the worn one (6 uses left) is still carried, set aside
    expect(h.slots.filter((s) => s?.name === 'stone_pickaxe').map((s) => s!.damage)).toEqual([125, undefined]);
  });

  it('the held table: counted as carried (no second table crafted), picked up before a mine step and at the end', async () => {
    const h = host(
      [
        ['crafting_table', 1],
        ['wooden_pickaxe', 1],
        ['oak_planks', 12],
        ['cobblestone', 3],
      ],
      { tables: true },
    );
    const end = await run(h, [
      { item: 'crafting_table', n: 1 },
      { item: 'stone_pickaxe', n: 1 },
      { item: 'stone_sword', n: 1 },
      { item: 'cobblestone', n: 4 },
    ]);
    // the pickaxe at the held table, its sweep before the mine step (the table back in the inventory), the sword, the end sweep
    expect(h.dispatched).toEqual(['craft stone_pickaxe 1', 'mine stone 6', 'craft stone_sword 1']);
    expect(h.dispatched.some((c) => c.startsWith('craft crafting_table'))).toBe(false);
    expect(h.log).toEqual(['hold true', 'sweep 1', 'sweep 1', 'hold false']);
    expect(end).toMatch(/^get test: done in \d+ s, 3 steps; picked up the crafting table; steps: craft stone_pickaxe 1, mine stone 6, craft stone_sword 1$/);
    expect(h.slots.filter((s) => s?.name === 'crafting_table')).toHaveLength(1);
  });

  const smeltStart = [
    ['stone_pickaxe', 1],
    ['crafting_table', 1],
    ['furnace', 1],
    ['raw_iron', 5],
    ['coal', 2],
    ['oak_planks', 4],
    ['cobblestone', 4],
  ] as const;

  it('a death with deathReturn off ends the job and says what is left where', async () => {
    const h = host(smeltStart, { dieIn: 'smelt' });
    const end = await run(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(h.died()).toBe(true);
    expect(end).toMatch(/^get test: stopped by a death \(mob\) after \d+ s, \d+ steps? \(at !smelt raw_iron 5\); the furnace at 3 64 1 holds the smelt; !set deathReturn on walks back for the drops$/);
    expect(h.recovered).toEqual([]);
  });

  it('deathReturn on, by day: back to the spot, the drops and the furnace output taken, the job goes on and says what it recovered', async () => {
    const h = host(smeltStart, { dieIn: 'smelt', deathReturn: true, time: 2000 });
    const c = new ObtainController(h.host);
    h.ref.c = c;
    expect(c.claimsRespawn()).toBe(false);
    const job = c.start(LINE, 'test', [{ item: 'iron_helmet', n: 1 }], (m) => h.replies.push(m))!;
    let claimed = false;
    const t = setInterval(() => {
      claimed ||= c.claimsRespawn();
    }, 1);
    const end = await job.result;
    clearInterval(t);
    expect(claimed).toBe(true);
    expect(c.claimsRespawn()).toBe(false);
    expect(h.recovered).toHaveLength(1);
    expect(h.recovered[0]).toMatchObject({ spot: { x: 30, y: 64, z: 40 }, radius: 8 });
    expect(h.replies.some((r) => /^get test: died \(at !smelt raw_iron 5\) \(mob\); walking back 50 blocks to 30 64 40 for the drops$/.test(r))).toBe(true);
    expect(h.replies.some((r) => /^get test: recovered \d+ of \d+ stacks in \d+ s \(lost .+\); smelted 5 iron_ingot in the furnace at 3 64 1 \(50 s\); going on with the job$/.test(r))).toBe(true);
    expect(end).toMatch(/^get test: done in \d+ s, \d+ steps; recovered \d+ of \d+ stacks; steps: .*recover \d+\/\d+.*craft iron_helmet 1$/);
    expect(h.slots.some((s) => s?.name === 'iron_helmet')).toBe(true);
    expect(h.goHome).toEqual([]);
  });

  it('deathReturn on, by night: not going back; the walk home the respawn would make is made', async () => {
    const h = host(smeltStart, { dieIn: 'smelt', deathReturn: true, time: 15000 });
    const end = await run(h, [{ item: 'iron_helmet', n: 1 }]);
    expect(end).toMatch(/^get test: stopped by a death \(mob\) after \d+ s, \d+ steps? \(at !smelt raw_iron 5\): not going back: it is night or near dusk \(deathReturn walks back by day only\); the furnace at 3 64 1 holds the smelt$/);
    expect(h.recovered).toEqual([]);
    expect(h.goHome).toEqual(['home']);
  });
});
