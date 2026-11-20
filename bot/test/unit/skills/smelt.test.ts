// Smelting (Track E2, docs/early-game.md "The iron age"): the furnace recipes and fuel arithmetic, the cooker smelting
// raw iron on a fake furnace (the request sequence, the limit, a smoker refused), the `!smelt` argument words, and the
// smelt job (a furnace placed or crafted first, resumed after a pause).
import { describe, expect, it } from 'vitest';
import { Cooker } from '../../../src/skills/food/cook.ts';
import { fuelValue } from '../../../src/skills/food/finder.ts';
import { cookerTakes, countOf, fuelItems, isOreInput, smeltableCounts, smeltedOf, smeltInputsOf, smeltTicksOf } from '../../../src/skills/food/smelt.ts';
import type { FurnaceResult } from '../../../src/skills/food/furnace.ts';
import { parseSmeltArgs, smeltLine, furnaceLine } from '../../../src/chat/commands-smelt.ts';
import { SmeltJob, type SmeltDeps } from '../../../src/tasks/process/smelt.ts';
import type { CookResult } from '../../../src/skills/food/cook.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count: number, stackId?: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(stackId !== undefined ? { stackId } : {}) });
const pad = (xs: (ItemStack | null)[]): (ItemStack | null)[] => [...xs, ...Array.from({ length: 36 - xs.length }, () => null)];

describe('smelting knowledge', () => {
  it('knows what a furnace makes and which cooker takes it', () => {
    expect(smeltedOf('raw_iron')).toBe('iron_ingot');
    expect(smeltedOf('minecraft:deepslate_iron_ore')).toBe('iron_ingot');
    expect(smeltedOf('raw_gold')).toBe('gold_ingot');
    expect(smeltedOf('sand')).toBe('glass');
    expect(smeltedOf('beef')).toBe('cooked_beef');
    expect(smeltedOf('oak_log')).toBe('charcoal');
    expect(smeltedOf('crimson_stem')).toBeUndefined();
    expect(smeltedOf('iron_ingot')).toBeUndefined();
    expect(smeltInputsOf('iron_ingot')).toEqual(['raw_iron', 'iron_ore', 'deepslate_iron_ore']);
    expect(smeltInputsOf('iron_pickaxe')).toBeUndefined();
    expect(cookerTakes('furnace', 'raw_iron')).toBe(true);
    expect(cookerTakes('lit_furnace', 'beef')).toBe(true);
    expect(cookerTakes('smoker', 'raw_iron')).toBe(false);
    expect(cookerTakes('smoker', 'beef')).toBe(true);
    expect(cookerTakes('blast_furnace', 'raw_iron')).toBe(true);
    expect(cookerTakes('blast_furnace', 'beef')).toBe(false);
    expect(cookerTakes('furnace', 'stick')).toBe(false);
    expect(isOreInput('raw_copper')).toBe(true);
    expect(isOreInput('sand')).toBe(false);
    expect(smeltTicksOf('furnace')).toBe(200);
    expect(smeltTicksOf('lit_smoker')).toBe(100);
  });

  it('counts the fuel in items smelted (coal 8, a plank or a log 1.5), the kept items and the reserve left out', () => {
    const slots = pad([item('coal', 2), item('oak_planks', 4), item('oak_log', 2), item('stick', 3)]);
    expect(fuelItems(slots)).toBe(16 + 6 + 3);
    expect(fuelItems(slots, (n) => n === 'coal')).toBe(9);
    expect(fuelItems(slots, undefined, (n) => (n === 'oak_planks' ? 4 : 0))).toBe(19);
    expect(countOf(slots, ['coal', 'oak_log'])).toBe(4);
  });

  it('lists the smeltable inputs carried (raw metal and sand; food and logs are not smelted by !smelt)', () => {
    const slots = pad([item('raw_iron', 5), item('beef', 2), item('raw_iron', 3), item('sand', 4), item('oak_log', 6), item('cobblestone', 9)]);
    expect([...smeltableCounts(slots)]).toEqual([
      ['raw_iron', 8],
      ['sand', 4],
    ]);
    expect([...smeltableCounts(slots, ['iron_ingot'])]).toEqual([['raw_iron', 8]]);
  });
});

describe('!smelt words', () => {
  it('reads the metal, the raw item, the ingot, sand and glass, and the count either side', () => {
    expect(parseSmeltArgs([])).toEqual({ names: undefined, label: 'everything smeltable', n: undefined });
    expect(parseSmeltArgs(['iron', '9'])).toEqual({ names: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'], label: 'iron_ingot', n: 9 });
    expect(parseSmeltArgs(['9', 'raw_iron'])).toMatchObject({ label: 'iron_ingot', n: 9 });
    expect(parseSmeltArgs(['iron_ingot'])).toMatchObject({ label: 'iron_ingot' });
    expect(parseSmeltArgs(['deepslate_gold_ore', '2'])).toMatchObject({ label: 'gold_ingot', n: 2 });
    expect(parseSmeltArgs(['sand'])).toMatchObject({ label: 'glass', names: ['sand', 'red_sand'] });
    expect(parseSmeltArgs(['cobblestone', '4'])).toEqual({ names: ['cobblestone'], label: 'stone', n: 4 });
    expect(parseSmeltArgs(['beef'])).toHaveProperty('error');
    expect(parseSmeltArgs(['iron', '0'])).toHaveProperty('error');
    expect(parseSmeltArgs(['iron', '65'])).toHaveProperty('error');
  });
});

// ---- the cooker smelting on a fake furnace -----------------------------------------------------------

function fakeFurnace(opts: { block?: string; inv: (ItemStack | null)[] }) {
  const block = opts.block ?? 'furnace';
  const fpos = { x: 3, y: -60, z: 0 };
  const windows = new Map<number, (ItemStack | null)[]>([[0, opts.inv]]);
  const sent: { name: string; p: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const openFns = new Set<(c: { id: number; type: string; pos: Vec3 }) => void>();
  const closeFns = new Set<(id: number, s: boolean) => void>();
  let progress = 0;
  let fuelLeft = 0;
  // the furnace's own slots: they outlive a closed window (it smelts on while nobody looks)
  const fslots: (ItemStack | null)[] = [null, null, null];
  let nextStack = 100;
  const containers = {
    open: undefined as { id: number; type: string; pos: Vec3 } | undefined,
    onOpen: (fn: (c: { id: number; type: string; pos: Vec3 }) => void) => (openFns.add(fn), () => openFns.delete(fn)),
    onClose: (fn: (id: number, s: boolean) => void) => (closeFns.add(fn), () => closeFns.delete(fn)),
    close: (id: number) => {
      containers.open = undefined;
      windows.delete(id);
      for (const f of [...closeFns]) f(id, false);
    },
  };
  const slotOf = (si: { slot_type: { container_id: string }; slot: number }): [number, number] => (['hotbar', 'inventory'].includes(si.slot_type.container_id) ? [0, si.slot] : [2, si.slot]);
  const respond = (id: number, ok: boolean) => {
    for (const fn of listeners.get('item_stack_response') ?? []) fn({ responses: [{ status: ok ? 'ok' : 'error', request_id: id, containers: [] }] });
  };
  const source = {
    on: (n: string, fn: (p: Record<string, unknown>) => void) => {
      const l = listeners.get(n) ?? [];
      l.push(fn);
      listeners.set(n, l);
      return () => undefined;
    },
    queue: (name: string, p: Record<string, unknown>) => {
      sent.push({ name, p });
      if (name === 'inventory_transaction') {
        windows.set(2, fslots);
        containers.open = { id: 2, type: block, pos: fpos };
        for (const f of [...openFns]) f(containers.open);
      } else if (name === 'item_stack_request') {
        const r = (p.requests as { request_id: number; actions: Record<string, unknown>[] }[])[0]!;
        const a = r.actions[0]! as { count: number; source: { slot_type: { container_id: string }; slot: number }; destination: { slot_type: { container_id: string }; slot: number } };
        const [sw, ss] = slotOf(a.source);
        const [dw, ds] = slotOf(a.destination);
        const src = windows.get(sw)![ss];
        const dst = windows.get(dw)![ds];
        if (!src || src.count < a.count) return respond(r.request_id, false);
        windows.get(sw)![ss] = src.count === a.count ? null : { ...src, count: src.count - a.count };
        const prevDst = dst?.name === src.name ? Math.max(0, dst.count - a.count) : 0;
        windows.get(dw)![ds] = { ...src, count: prevDst + a.count, stackId: nextStack++ };
        respond(r.request_id, true);
      }
    },
  };
  const world = {
    blockAt: (p: Vec3) => (p.x === fpos.x && p.y === fpos.y && p.z === fpos.z ? ({ name: fuelLeft > 0 ? `lit_${block}` : block, stateId: 0, states: {}, hardness: 3.5, solid: true, boxes: [] } as BlockInfo) : undefined),
    find: (_pred: unknown, o: { origin: Vec3; radius: number }) => (Math.hypot(fpos.x - o.origin.x, fpos.z - o.origin.z) <= o.radius ? [fpos] : []),
    chunks: { runtimeIdAt: () => 42 },
    inventory: {
      get slots() {
        return windows.get(0)!;
      },
      selected: 0,
      window: (id: number): ContainerView | undefined => (windows.has(id) ? { id, slots: windows.get(id)! } : undefined),
      setItem: (w: number, slot: number, it: ItemStack | null) => {
        const s = windows.get(w);
        if (s) s[slot] = it;
      },
    },
  };
  const per = smeltTicksOf(block);
  const loop = {
    state: { pos: { x: 0.5, y: -60, z: 0.5 }, ready: true },
    setCommand: () => undefined,
    waitTicks: (n: number) => {
      const f = fslots;
      {
        for (let i = 0; i < n; i++) {
          const input = f[0];
          if (!input) break;
          if (fuelLeft <= 0 && f[1]) {
            fuelLeft = fuelValue(f[1].name) * per;
            f[1] = f[1].count > 1 ? { ...f[1], count: f[1].count - 1 } : null;
          }
          if (fuelLeft <= 0) break;
          fuelLeft--;
          if (++progress >= per) {
            progress = 0;
            f[0] = input.count > 1 ? { ...input, count: input.count - 1 } : null;
            const out = f[2];
            f[2] = { name: smeltedOf(input.name)!, networkId: 2, metadata: 0, count: (out?.count ?? 0) + 1, stackId: out?.stackId ?? nextStack++ };
          }
        }
      }
      return Promise.resolve();
    },
  };
  const cooker = new Cooker({ source, loop, world, containers, mover: { goto: () => Promise.resolve({ ok: true }) }, home: () => undefined });
  const actions = () =>
    sent
      .filter((s) => s.name === 'item_stack_request')
      .map((s) => (s.p.requests as { actions: { type_id: string; count: number; source: { slot_type: { container_id: string }; slot: number }; destination: { slot_type: { container_id: string }; slot: number } }[] }[])[0]!.actions[0]!)
      .map((a) => `${a.type_id} ${a.count} ${a.source.slot_type.container_id}:${a.source.slot} -> ${a.destination.slot_type.container_id}:${a.destination.slot}`);
  return { cooker, windows, actions, furnace: () => fslots };
}

const ironInputs = (slots: readonly (ItemStack | null)[]) => smeltableCounts(slots, ['iron_ingot']);

describe('Cooker smelting (Track E2)', () => {
  it('smelts the raw iron with coal, takes the ingots out, leaves the food alone', async () => {
    const inv = pad([item('raw_iron', 9, 1), item('beef', 3, 2), item('coal', 3, 3)]);
    const f = fakeFurnace({ inv });
    const r = await f.cooker.cook({ inputs: ironInputs }, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', cooked: { iron_ingot: 9 }, fuel: { coal: 2 } });
    expect(f.actions()).toEqual(['place 2 hotbar:2 -> furnace_fuel:1', 'place 9 hotbar:0 -> furnace_ingredient:0', 'take 9 furnace_output:2 -> hotbar:0']); // Track C2: the fuel first
    expect(inv.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['iron_ingot 9', 'beef 3', 'coal 1']);
    expect(r.ticks).toBeGreaterThanOrEqual(9 * 200);
  });

  it('a limit smelts that many and keeps the rest; planks burn when no coal is carried', async () => {
    const inv = pad([item('raw_iron', 10, 1), item('oak_planks', 8, 2)]);
    const f = fakeFurnace({ inv });
    const r = await f.cooker.cook({ inputs: ironInputs, limit: 4 }, () => false);
    expect(r).toMatchObject({ ok: true, cooked: { iron_ingot: 4 }, fuel: { oak_planks: 3 } });
    expect(inv.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['raw_iron 6', 'oak_planks 5', 'iron_ingot 4']);
  });

  it('a smoker is never used for ore; no fuel gives the raw iron back', async () => {
    const smoker = fakeFurnace({ block: 'smoker', inv: pad([item('raw_iron', 2, 1), item('coal', 1, 2)]) });
    expect((await smoker.cooker.cook({ inputs: ironInputs }, () => false)).reason).toBe('no_furnace');
    const inv = pad([item('raw_iron', 2, 1)]);
    const nofuel = fakeFurnace({ inv });
    expect((await nofuel.cooker.cook({ inputs: ironInputs }, () => false)).reason).toBe('no_fuel');
    expect(inv.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['raw_iron 2']);
  });
});

// ---- the smelt job ----------------------------------------------------------------------------------

function jobDeps(o: { place: FurnaceResult[]; make?: boolean; cook?: CookResult }) {
  const calls: string[] = [];
  let carried = 0;
  const d: SmeltDeps = {
    cooker: {
      cook: (opts) => {
        calls.push(`cook limit ${opts.limit ?? 'all'}`);
        return Promise.resolve(o.cook ?? { ok: true, reason: 'done', cooked: { iron_ingot: 3 }, fuel: { coal: 1 }, ticks: 600, furnace: { x: 1, y: 2, z: 3 }, block: 'furnace' });
      },
      phase: 'idle',
    },
    placeFurnace: () => {
      calls.push('place');
      return Promise.resolve(o.place.shift() ?? { ok: false, reason: 'place_failed' });
    },
    makeFurnace: () => {
      calls.push('make');
      if (o.make) carried = 1;
      return Promise.resolve(o.make ?? false);
    },
    furnacesCarried: () => carried,
    slots: () => [],
    cancel: () => undefined,
  };
  return { d, calls };
}

describe('smelt job', () => {
  it('no furnace carried: crafts one, places it, smelts', async () => {
    const { d, calls } = jobDeps({ place: [{ ok: false, reason: 'no_furnace_item' }, { ok: true, pos: { x: 1, y: 2, z: 3 }, walked: false, already: false }], make: true });
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs, limit: 3 });
    expect(await job.run(d, () => false)).toBe(true);
    expect(calls).toEqual(['place', 'make', 'place', 'cook limit 3']);
    const r = job.result();
    expect(r).toMatchObject({ ok: true, crafted: true });
    expect(smeltLine(r)).toBe('smelted 3 iron_ingot in the furnace at 1 2 3 (30 s, fuel 1 coal); furnace placed at 1 2 3 (crafted)');
  });

  it('a furnace that stands there already: no place, no craft; !furnace says so', async () => {
    const { d, calls } = jobDeps({ place: [{ ok: true, pos: { x: 5, y: 6, z: 7 }, walked: false, already: true }] });
    const job = new SmeltJob({ kind: 'furnace' });
    await job.run(d, () => false);
    expect(calls).toEqual(['place']);
    expect(furnaceLine(job.result())).toBe('furnace: one stands at 5 6 7 already');
  });

  it('nothing to craft one from: the reason, nothing smelted', async () => {
    const { d, calls } = jobDeps({ place: [{ ok: false, reason: 'no_furnace_item' }], make: false });
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs });
    await job.run(d, () => false);
    expect(calls).toEqual(['place', 'make']);
    expect(smeltLine(job.result())).toBe('smelt: no furnace carried (8 cobblestone make one: !get furnace)');
  });

  it('a pause in the smelt: the resume smelts what the limit leaves', async () => {
    let stop = false;
    const cooks: CookResult[] = [
      { ok: false, reason: 'interrupted', cooked: { iron_ingot: 2 }, fuel: { coal: 1 }, ticks: 400, put: 2 },
      { ok: true, reason: 'done', cooked: { iron_ingot: 3 }, fuel: {}, ticks: 600, put: 3 },
    ];
    const { d, calls } = jobDeps({ place: [{ ok: true, pos: { x: 1, y: 2, z: 3 }, walked: true, already: false }] });
    d.cooker = {
      cook: (opts) => {
        calls.push(`cook limit ${opts.limit ?? 'all'}`);
        stop = cooks.length === 2;
        return Promise.resolve(cooks.shift()!);
      },
      phase: 'idle',
    };
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs, limit: 5 });
    expect(await job.run(d, () => stop)).toBe(false);
    stop = false;
    expect(await job.run(d, () => false)).toBe(true);
    expect(calls).toEqual(['place', 'cook limit 5', 'cook limit 3']);
    expect(job.result()).toMatchObject({ ok: true, cook: { cooked: { iron_ingot: 5 }, ticks: 1000 } });
  });

  it('Track E2: a flee closes the window with the input still in the furnace: the resume goes back there, puts nothing more in, waits it out', async () => {
    let stop = false;
    const at = { x: 7, y: 64, z: 9 };
    const seen: string[] = [];
    const cooks: CookResult[] = [
      { ok: false, reason: 'interrupted', cooked: { iron_ingot: 4 }, fuel: { coal: 5 }, ticks: 1560, put: 33, furnace: at, block: 'furnace' },
      { ok: true, reason: 'done', cooked: { iron_ingot: 29 }, fuel: {}, ticks: 5800, put: 0, furnace: at, block: 'furnace' },
    ];
    const { d } = jobDeps({ place: [{ ok: true, pos: at, walked: false, already: false }] });
    d.cooker = {
      cook: (opts) => {
        seen.push(`limit ${opts.limit ?? 'all'} at ${opts.at ? `${opts.at.x} ${opts.at.y} ${opts.at.z}` : '-'}`);
        stop = cooks.length === 2;
        return Promise.resolve(cooks.shift()!);
      },
      phase: 'idle',
    };
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs, limit: 33 });
    expect(await job.run(d, () => stop)).toBe(false);
    stop = false;
    expect(await job.run(d, () => false)).toBe(true);
    expect(seen).toEqual(['limit 33 at -', 'limit 0 at 7 64 9']);
    expect(smeltLine(job.result())).toBe('smelted 33 iron_ingot in the furnace at 7 64 9 (368 s, fuel 5 coal); furnace placed at 7 64 9');
  });

  it('Track E2: the cooker goes back to that furnace with nothing carried and waits out the raw iron in it', async () => {
    const inv = pad([item('raw_iron', 4, 1), item('coal', 1, 2)]);
    const f = fakeFurnace({ inv });
    let n = 0;
    // the window is shut after 2 items' time (a flee), with 2 raw iron still in
    const r1 = await f.cooker.cook({ inputs: ironInputs }, () => ++n > 41);
    expect(r1).toMatchObject({ ok: false, reason: 'interrupted', put: 4 });
    expect(f.furnace()[0]).toMatchObject({ name: 'raw_iron' });
    const r2 = await f.cooker.cook({ inputs: ironInputs, limit: 0, at: { x: 3, y: -60, z: 0 } }, () => false);
    expect(r2).toMatchObject({ ok: true, reason: 'done', put: 0 });
    expect((r1.cooked.iron_ingot ?? 0) + (r2.cooked.iron_ingot ?? 0)).toBe(4);
    expect(inv.filter(Boolean).map((s) => `${s!.name} ${s!.count}`)).toEqual(['iron_ingot 4']);
    // without `at` and nothing carried: nothing to do, as before
    expect((await f.cooker.cook({ inputs: ironInputs }, () => false)).reason).toBe('nothing_to_cook');
  });

  it('Track E4: the furnace the job set down or found is the one the cooker tries first (prefer); a stopped smelt tells where its input is', async () => {
    let stop = false;
    const at = { x: 40, y: 64, z: 9 };
    const seen: string[] = [];
    const { d } = jobDeps({ place: [{ ok: true, pos: at, walked: false, already: true }] });
    d.cooker = {
      cook: (opts) => {
        seen.push(`prefer ${opts.prefer ? `${opts.prefer.x} ${opts.prefer.y} ${opts.prefer.z}` : '-'} at ${opts.at ? 'set' : '-'}`);
        stop = true;
        return Promise.resolve({ ok: false, reason: 'interrupted', cooked: { iron_ingot: 2 }, fuel: { coal: 1 }, ticks: 400, put: 10, furnace: at, block: 'furnace' });
      },
      phase: 'idle',
    };
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs, limit: 10 });
    expect(job.heldAt).toBeUndefined();
    expect(await job.run(d, () => stop)).toBe(false);
    expect(seen).toEqual(['prefer 40 64 9 at -']);
    expect(job.over).toBe(false);
    expect(job.heldAt).toEqual(at);
  });

  it('Track E4: a smelt sent back to a furnace (after a death) places nothing and opens that furnace first', async () => {
    const at = { x: 7, y: 64, z: 9 };
    const seen: string[] = [];
    const { d, calls } = jobDeps({ place: [] });
    d.cooker = {
      cook: (opts) => {
        seen.push(`at ${opts.at ? `${opts.at.x} ${opts.at.y} ${opts.at.z}` : '-'} limit ${opts.limit ?? 'all'}`);
        return Promise.resolve({ ok: true, reason: 'done', cooked: { iron_ingot: 33 }, fuel: {}, ticks: 3000, put: 0, furnace: at, block: 'furnace' });
      },
      phase: 'idle',
    };
    const job = new SmeltJob({ kind: 'smelt', inputs: ironInputs, at });
    expect(job.heldAt).toEqual(at);
    expect(await job.run(d, () => false)).toBe(true);
    expect(calls).toEqual([]);
    expect(seen).toEqual(['at 7 64 9 limit all']);
    expect(job.over).toBe(true);
    expect(job.heldAt).toBeUndefined();
    expect(smeltLine(job.result())).toBe('smelted 33 iron_ingot in the furnace at 7 64 9 (150 s)');
  });
});
