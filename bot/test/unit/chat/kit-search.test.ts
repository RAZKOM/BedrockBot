// Track E10 (docs/early-game.md "Sheep for the bed", ADR 0112): a hunt for the bed's wool that found none within 32 and had
// no herd to walk to searches along the axes, walks to the first sheep seen and hunts again; none seen: the end line says
// how far it looked; dusk cuts the search and it goes again by day.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CommandEvent } from '../../../src/chat/chat.ts';
import { ObtainController } from '../../../src/chat/commands-kit.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { HUNT_SEARCH_OUT, HUNT_SEARCH_STEP, huntLegs, searchNote, searchPorts, standAt } from '../../../src/chat/kit-search.ts';
import type { ChatLine } from '../../../src/chat/text.ts';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { ObtainOptions } from '../../../src/skills/items/obtain.ts';
import type { Process } from '../../../src/tasks/process/manager.ts';
import type { ItemStack, Vec3 } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const LINE = { type: 'chat', source: 'Owner', message: '!get bed', body: '!get bed', xuid: '', truth: false } as unknown as ChatLine;

describe('Track E10: the search legs and the standing cell', () => {
  it('four legs of 3 steps, 32 apart, out to 96 along +x, +z, -x, -z', () => {
    const legs = huntLegs({ x: 10.5, y: 64, z: -4.5 });
    expect(legs).toHaveLength(4);
    expect(legs.map((l) => l.length)).toEqual([3, 3, 3, 3]);
    expect(legs[0]!.map((p) => p.x - 10)).toEqual([HUNT_SEARCH_STEP, 2 * HUNT_SEARCH_STEP, HUNT_SEARCH_OUT]);
    expect(legs[1]![2]).toMatchObject({ x: 10, z: -5 + 96 });
  });
  it('searchPorts: the nearest live mob of the kind by x and z; the standing cell from the solid test', () => {
    const ents = [
      { runtimeId: 1n, type: 'minecraft:sheep', pos: { x: 50, y: 65.62, z: 0 } },
      { runtimeId: 2n, type: 'minecraft:sheep', pos: { x: 20, y: 90.62, z: 0 } },
      { runtimeId: 3n, type: 'minecraft:cow', pos: { x: 5, y: 65.62, z: 0 } },
      { runtimeId: 4n, type: 'minecraft:sheep', pos: { x: 4, y: 65.62, z: 0 } },
    ] as never[];
    const p = searchPorts({ position: () => ({ x: 0, y: 64, z: 0 }), entities: () => ents, dead: (id) => id === (4n as never), solid: (_x, y) => y <= 63 });
    expect(p.seen('sheep')).toMatchObject({ x: 20 });
    expect(p.seen('pig')).toBeUndefined();
    expect(p.standY(7, 7, 64)).toBe(64);
  });

  it('the standing cell: the highest open pair over a solid near the height; unknown columns give undefined', () => {
    const ground = (x: number, y: number, _z: number): boolean | undefined => (x > 100 ? undefined : y <= (x > 50 ? 70 : 63));
    expect(standAt(ground, 10, 0, 64)).toBe(64);
    expect(standAt(ground, 60, 0, 64)).toBe(71);
    expect(standAt(ground, 200, 0, 64)).toBeUndefined();
    expect(searchNote('sheep', 412.4, 240_400, undefined)).toBe('looked for sheep: walked 412 along the axes in 240 s, none seen');
    expect(searchNote('sheep', 64, 30_000, 71.2)).toBe('looked for sheep: walked 64 along the axes in 30 s, one seen 71 off');
  });
});

/** A host: the bot at `pos`, sheep at `sheep` (seen within 64 of the bot), `kill sheep n` gets wool when one is within 32. */
function host(sheep: Vec3[], o: { duskAfterGotos?: number } = {}) {
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
  add('oak_planks', 3);
  add('crafting_table', 1);
  const pos = { x: 0.5, y: 64, z: 0.5 };
  const dispatched: string[] = [];
  const procs: Process[] = [];
  const listeners = new Set<(e: CommandEvent) => void>();
  const clock = { t: 0 };
  let gotos = 0;
  const near = (r: number) => sheep.filter((s) => Math.hypot(s.x - pos.x, s.z - pos.z) <= r);
  return {
    pos,
    dispatched,
    clock,
    host: {
      dispatch: (_line: ChatLine, command: string) => {
        dispatched.push(command);
        const [verb, ...rest] = command.split(' ');
        for (const fn of listeners) fn({ kind: 'run', name: verb!, sender: { name: 'Owner' } } as never);
        let done = false;
        procs.push({ name: verb, kind: 'user', priority: 40, get done() { return done; }, status: () => ({ line: verb }) } as unknown as Process);
        setTimeout(() => {
          if (verb === 'goto') {
            gotos++;
            pos.x = Number(rest[0]) + 0.5;
            pos.z = Number(rest[2]) + 0.5;
          } else if (verb === 'kill') {
            const n = Math.min(Number(rest[1]), near(32).length);
            for (const s of near(32).slice(0, n)) sheep.splice(sheep.indexOf(s), 1);
            if (n) add('white_wool', n);
          } else if (verb === 'craft') {
            const item = rest[0]!;
            const want = Number(rest[1]);
            const have = slots.reduce((a, s) => a + (s?.name === item ? s.count : 0), 0);
            const c = planChain(recipes, [{ item, n: want + have }], slots, keep);
            for (const st of c.steps) {
              const p = planCraft(recipes, st.item, st.n, slots, keep)!;
              for (const [k, v] of Object.entries(p.perCraft)) take(k, v * p.crafts);
              add(p.item, p.crafts * p.outputPer);
            }
          }
          done = true;
        }, 1);
      },
      processes: { userProcesses: () => procs.filter((p) => !p.done), stop: () => true },
      slots: () => slots,
      recipes,
      options: (): ObtainOptions => ({ ...keep, worn: [], tableNear: true }),
      onCommand: (fn: (e: CommandEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (ms: number) => {
        clock.t += ms;
        return new Promise<void>((r) => setTimeout(r, 0));
      },
      now: () => clock.t,
      sayEnd: () => undefined,
      seen: (kind: string) => (kind === 'sheep' ? near(64).sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z))[0] : undefined),
      position: () => ({ ...pos }),
      standY: () => 64,
      ...(o.duskAfterGotos !== undefined
        ? {
            night: {
              enabled: () => true,
              time: () => (gotos >= o.duskAfterGotos! ? 12500 : 6000),
              dusk: 12000,
              dawn: 23500,
              plan: () => ({ kind: 'none' as const, set: undefined, text: 'nowhere to shelter' }),
              enter: () => undefined,
              gaveUp: () => false,
              fallback: () => ({ kind: 'none' as const, set: undefined, text: 'nowhere to shelter' }),
              release: () => undefined,
              busy: () => false,
            },
          }
        : {}),
    },
  };
}

const wool = (h: ReturnType<typeof host>): number => h.host.slots().reduce((a, s) => a + (s?.name === 'white_wool' ? s.count : 0), 0);

describe('Track E10: the hunt searches along the axes', () => {
  it('three sheep 80 off along +z: the search walks +x, then +z, sees them, walks there and hunts again', async () => {
    const h = host([
      { x: 2, y: 64, z: 80 },
      { x: 4, y: 64, z: 82 },
      { x: -2, y: 64, z: 81 },
    ]);
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'bed', ObtainController.targetsFor('bed', undefined).targets, () => undefined);
    const end = await job!.result;
    expect(h.dispatched.filter((x) => x.startsWith('kill'))).toEqual(['kill sheep 3', 'kill sheep 3']);
    const gotos = h.dispatched.filter((x) => x.startsWith('goto'));
    // +x: 32, 64, 96 (none within 64 of them), then +z 32: the sheep 48 off are seen; walked to them
    expect(gotos.slice(0, 4)).toEqual(['goto 32 64 0', 'goto 64 64 0', 'goto 96 64 0', 'goto 0 64 32']);
    expect(gotos).toHaveLength(5);
    expect(wool(h)).toBe(0); // the 3 wool went into the bed
    expect(h.dispatched.slice(-2)).toEqual([expect.stringMatching(/^craft (white_)?bed 1$/), 'bed']); // crafted, set down
    expect(end).toMatch(/looked for sheep: walked \d+ along the axes in \d+ s, one seen \d+ off/);
    expect(end).toMatch(/one seen 80 off/); // (the fake `!bed` sets nothing down: the job's end is not this test's)
  });

  it('no sheep anywhere: twelve steps out and the end line says how far it looked; once a job', async () => {
    const h = host([]);
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'bed', ObtainController.targetsFor('bed', undefined).targets, () => undefined);
    const end = await job!.result;
    expect(h.dispatched.filter((x) => x.startsWith('goto'))).toHaveLength(12);
    expect(h.dispatched.filter((x) => x.startsWith('kill'))).toEqual(['kill sheep 3']);
    expect(end).toMatch(/^get bed: stopped after \d+ s, \d+ steps?: !kill sheep 3 got nothing.*looked for sheep: walked \d+ along the axes in \d+ s, none seen/);
  });

  it('dusk in the search: the walk ends there (the job plans again after the night)', async () => {
    const h = host([], { duskAfterGotos: 2 });
    const c = new ObtainController(h.host);
    const job = c.start(LINE, 'bed', ObtainController.targetsFor('bed', undefined).targets, () => undefined);
    const end = await job!.result;
    // the second goto is cut by dusk; nowhere to shelter: the job works on and searches again
    expect(h.dispatched.filter((x) => x.startsWith('goto')).length).toBeGreaterThanOrEqual(2);
    expect(end).toMatch(/^get bed: /);
  });
});
