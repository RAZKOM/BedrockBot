/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Track AW (wave 11, docs/crafting.md): the Crafter on fakes with a small BDS-like server for item
// stack requests: the exact request shapes (the fill, then craft_recipe with the wire type 12,
// one consume per cell, the output placed from creative_output slot 50 with the request id as its
// stack id), shaped patterns with holes (chest, furnace), batching, the model kept equal to the
// server, the grid emptied before every close (given back, else dropped, never destroyed), a retry
// after a refused craft (statuses 17, 3, 49, 35), a refused fill, a request timeout with a late or
// missing response, a refused give-back, a full inventory, the shortfall, the table placed / opened /
// picked up / left and retried, visibility, cancel.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Crafter, CRAFT_RECIPE_WIRE_TYPE, craftLine, destinationSlot, type CrafterDeps } from '../../../src/skills/craft/crafter.ts';
import { gridSlots, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);

const AIR: BlockInfo = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };
const GRASS: BlockInfo = { name: 'grass_block', stateId: 1, states: {}, hardness: 0.6, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
const STONE: BlockInfo = { name: 'stone', stateId: 3, states: {}, hardness: 1.5, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
const TABLE: BlockInfo = { name: 'crafting_table', stateId: 2, states: {}, hardness: 2.5, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
const FEET: Vec3 = { x: 0.5, y: -60, z: 0.5 };
const item = (name: string, count: number, stackId: number): ItemStack => ({ name, count, networkId: name.length, metadata: 0, stackId });
const stacks = (name: string, n: number, from = 1): ItemStack[] => Array.from({ length: n }, (_, i) => item(name, 64, from + i));

interface Action {
  type_id: string;
  legacy_type_id: number;
  count?: number;
  times_crafted?: number;
  recipe_network_id?: number;
  source?: { slot_type: { container_id: string }; slot: number; stack_id: number };
  destination?: { slot_type: { container_id: string }; slot: number; stack_id: number };
}
interface Request {
  request_id: number;
  actions: Action[];
}
interface Response {
  status: 'ok' | number;
  request_id: number;
  containers?: { slot_type: { container_id: string }; slots: { slot: number; hotbar_slot: number; count: number; item_stack_id?: number }[] }[];
}

/**
 * A tiny BDS: its own inventory (the truth), stack ids, the grid of the open screen, and the rules
 * measured on bds-craft: a craft needs the grid to match the recipe's pattern cells (35), consumes
 * need the right stack id (20), the output transfer needs the request id as the source stack id
 * (49), a `drop` from the grid makes an item entity, the grid is destroyed on close. Requests are
 * atomic. Fault knobs: failCrafts / failFills / failGivebacks (refuse the next n), silent (swallow
 * the next n responses; `late()` delivers them afterwards).
 */
class FakeServer {
  slots: (ItemStack | null)[];
  grid = new Map<number, ItemStack>();
  nextId = 100;
  destroyed: ItemStack[] = [];
  dropped: ItemStack[] = [];
  failCrafts = 0;
  failStatus = 35;
  failFills = 0;
  failGivebacks = 0;
  silent = 0;
  held: Response[] = [];
  requests: Request[] = [];
  constructor(slots: (ItemStack | null)[]) {
    this.slots = slots;
  }
  private player(a: { slot_type: { container_id: string }; slot: number }): boolean {
    return a.slot_type.container_id === 'hotbar' || a.slot_type.container_id === 'inventory';
  }
  private recipeOf(networkId: number) {
    const r = [...fixture.shaped_recipes!, ...fixture.shapeless_recipes!].find((x) => x.network_id === networkId);
    if (!r) return undefined;
    const name = fixture.items[String(r.output[0]!.network_id)]!;
    return { wire: r, rec: recipes.byOutput(name).find((x) => x.networkId === networkId)!, name };
  }
  handle(req: Request): Response | undefined {
    this.requests.push(req);
    const r = this.apply(req);
    if (this.silent > 0) {
      this.silent--;
      this.held.push(r);
      return undefined;
    }
    return r;
  }
  private apply(req: Request): Response {
    const slots = this.slots.map((s) => (s ? { ...s } : null));
    const grid = new Map([...this.grid].map(([k, v]) => [k, { ...v }]));
    const touchedPlayer = new Set<number>();
    const touchedGrid = new Set<number>();
    const dropped: ItemStack[] = [];
    let crafted: { recipe: number; times: number } | undefined;
    const fail = (status: number) => ({ status, request_id: req.request_id });
    const isFill = req.actions.every((a) => a.type_id === 'place' && a.destination?.slot_type.container_id === 'crafting_input');
    const isGiveBack = req.actions.every((a) => a.type_id === 'place' && a.source?.slot_type.container_id === 'crafting_input');
    if (isFill && this.failFills > 0) {
      this.failFills--;
      return fail(7);
    }
    if (isGiveBack && this.failGivebacks > 0) {
      this.failGivebacks--;
      return fail(7);
    }
    for (const a of req.actions) {
      if (a.type_id === 'place' && a.source && a.destination) {
        if (this.player(a.source) && a.destination.slot_type.container_id === 'crafting_input') {
          const s = slots[a.source.slot];
          if (s?.stackId !== a.source.stack_id || s.count < (a.count ?? 0)) return fail(7);
          const g = grid.get(a.destination.slot);
          if (g && (g.name !== s.name || g.stackId !== a.destination.stack_id)) return fail(7);
          s.count -= a.count!;
          if (s.count === 0) slots[a.source.slot] = null;
          grid.set(a.destination.slot, g ? { ...g, count: g.count + a.count! } : { ...s, count: a.count!, stackId: this.nextId++ });
          touchedPlayer.add(a.source.slot);
          touchedGrid.add(a.destination.slot);
        } else if (a.source.slot_type.container_id === 'crafting_input' && this.player(a.destination)) {
          const g = grid.get(a.source.slot);
          if (a.source.stack_id === 0) return fail(49);
          if (g?.stackId !== a.source.stack_id || g.count < (a.count ?? 0)) return fail(7);
          const d = slots[a.destination.slot];
          if (d && (d.name !== g.name || d.stackId !== a.destination.stack_id)) return fail(7);
          if (d && d.count + a.count! > 64) return fail(7);
          g.count -= a.count!;
          if (g.count === 0) grid.delete(a.source.slot);
          slots[a.destination.slot] = d ? { ...d, count: d.count + a.count! } : { ...g, count: a.count!, stackId: this.nextId++ };
          touchedPlayer.add(a.destination.slot);
          touchedGrid.add(a.source.slot);
        } else if (a.source.slot_type.container_id === 'creative_output') {
          if (!crafted) return fail(17);
          if (a.source.stack_id !== req.request_id || a.source.slot !== 50) return fail(49);
          const rr = this.recipeOf(crafted.recipe)!;
          const out = rr.wire.output[0]!;
          if (a.count !== out.count * crafted.times) return fail(11);
          const d = slots[a.destination.slot];
          if (d && (d.name !== rr.name || d.stackId !== a.destination.stack_id)) return fail(7);
          if (d && d.count + a.count > 64) return fail(7);
          slots[a.destination.slot] = d ? { ...d, count: d.count + a.count } : { name: rr.name, count: a.count, networkId: out.network_id, metadata: 0, stackId: this.nextId++ };
          touchedPlayer.add(a.destination.slot);
        } else return fail(2);
      } else if (a.type_id === 'craft_recipe') {
        if (a.legacy_type_id !== CRAFT_RECIPE_WIRE_TYPE) throw new Error('malformed: wrong const value for member "Action type" (the connection would be closed)');
        if (this.failCrafts > 0) {
          this.failCrafts--;
          return fail(this.failStatus);
        }
        const rr = this.recipeOf(a.recipe_network_id!);
        if (!rr) return fail(32);
        const table = [...grid.keys()].some((k) => k >= 32);
        // the pattern cells that hold an ingredient must be filled with a matching item, nothing else
        const all = gridSlots(rr.rec, table);
        const want = rr.rec.shaped ? all.filter((_, i) => rr.rec.input[i] !== null) : all;
        if (want.length !== grid.size || !want.every((slot) => grid.has(slot))) return fail(35);
        for (const g of grid.values()) if (g.count < a.times_crafted!) return fail(35);
        if (rr.rec.shaped) for (let i = 0; i < all.length; i++) {
          const ing = rr.rec.input[i];
          const g = grid.get(all[i]!);
          if (ing?.name !== undefined && g && ing.name !== g.name) return fail(35);
        }
        crafted = { recipe: a.recipe_network_id!, times: a.times_crafted! };
      } else if (a.type_id === 'consume' && a.source) {
        const g = grid.get(a.source.slot);
        if (g?.stackId !== a.source.stack_id) return fail(20);
        if (g.count < a.count!) return fail(21);
        g.count -= a.count!;
        if (g.count === 0) grid.delete(a.source.slot);
        touchedGrid.add(a.source.slot);
      } else if (a.type_id === 'drop' && a.source?.slot_type.container_id === 'crafting_input') {
        const g = grid.get(a.source.slot);
        if (a.source.stack_id === 0) return fail(49);
        if (g?.stackId !== a.source.stack_id || g.count < (a.count ?? 0)) return fail(7);
        dropped.push({ ...g, count: a.count! });
        g.count -= a.count!;
        if (g.count === 0) grid.delete(a.source.slot);
        touchedGrid.add(a.source.slot);
      } else return fail(2);
    }
    this.slots = slots;
    this.grid = grid;
    this.dropped.push(...dropped);
    const containers = [];
    const ps = [...touchedPlayer].map((slot) => ({ slot, hotbar_slot: slot, count: slots[slot]?.count ?? 0, ...(slots[slot] ? { item_stack_id: slots[slot].stackId } : {}) }));
    if (ps.length) containers.push({ slot_type: { container_id: 'hotbar' }, slots: ps });
    const gs = [...touchedGrid].map((slot) => ({ slot, hotbar_slot: slot, count: grid.get(slot)?.count ?? 0, ...(grid.has(slot) ? { item_stack_id: grid.get(slot)!.stackId } : {}) }));
    if (gs.length) containers.push({ slot_type: { container_id: 'crafting_input' }, slots: gs });
    return { status: 'ok', request_id: req.request_id, containers };
  }
  close(): void {
    this.destroyed.push(...this.grid.values());
    this.grid.clear();
  }
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.slots) if (s) out[s.name] = (out[s.name] ?? 0) + s.count;
    return out;
  }
}

interface Opts {
  tableAt?: Vec3;
  /** A wall of stone between the bot and `tableAt`. */
  wallAt?: Vec3;
  skills?: boolean;
  goto?: boolean;
  digFails?: boolean;
  cancelAfterBatches?: number;
  /** Deliver the server's held responses after this many waitTicks calls (a late response); default never. */
  lateAfter?: number;
}

function harness(initial: (ItemStack | null)[], o: Opts = {}) {
  const slots: (ItemStack | null)[] = [...initial, ...Array.from({ length: 36 - initial.length }, () => null)];
  const windows = new Map<number, (ItemStack | null)[]>();
  const server = new FakeServer(slots.map((s) => (s ? { ...s } : null)));
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: { name: string; params: Record<string, unknown> }[] = [];
  const later: (() => void)[] = [];
  const emit = (name: string, p: Record<string, unknown>) => {
    for (const fn of handlers.get(name) ?? []) fn(p);
  };
  let open: { id: number; type: string; pos: Vec3 } | undefined;
  const openFns = new Set<(c: { id: number; type: string; pos: Vec3 }) => void>();
  const closeFns = new Set<(id: number, byServer: boolean) => void>();
  const blocks = new Map<string, BlockInfo>();
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  if (o.tableAt) blocks.set(key(o.tableAt), TABLE);
  if (o.wallAt) for (let dy = 0; dy < 3; dy++) blocks.set(key({ ...o.wallAt, y: o.wallAt.y + dy }), STONE);
  const blockAt = (p: Vec3): BlockInfo => blocks.get(key(p)) ?? (p.y < -60 ? GRASS : AIR);
  let ticks = 0;
  const source = {
    on: (name: string, fn: (p: Record<string, unknown>) => void) => {
      let set = handlers.get(name);
      if (!set) handlers.set(name, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    queue: (name: string, params: Record<string, unknown>) => {
      sent.push({ name, params });
      if (name === 'item_stack_request') {
        const req = (params as { requests: Request[] }).requests[0]!;
        later.push(() => {
          const r = server.handle(req);
          if (r) emit('item_stack_response', { responses: [r] });
        });
      } else if (name === 'interact') {
        later.push(() => {
          open = { id: 2, type: 'inventory', pos: { x: 0, y: 0, z: 0 } };
          for (const fn of openFns) fn(open);
        });
      } else if (name === 'inventory_transaction') {
        const pos = (params as { transaction: { transaction_data: { block_position: Vec3 } } }).transaction.transaction_data.block_position;
        later.push(() => {
          if (blockAt(pos).name !== 'crafting_table') return;
          open = { id: 3, type: 'workbench', pos };
          for (const fn of openFns) fn(open);
        });
      } else if (name === 'container_close') {
        const id = (params as { window_id: number }).window_id;
        later.push(() => {
          server.close();
          if (open?.id === id) open = undefined;
          windows.delete(id);
          for (const fn of closeFns) fn(id, false);
        });
      }
    },
  };
  const inventory = {
    get slots() {
      return slots;
    },
    selected: 0,
    window: (id: number) => (id === 0 ? { slots } : windows.has(id) ? { slots: windows.get(id)! } : undefined),
    setItem: (window: number, slot: number, it: ItemStack | null) => {
      if (window === 0) {
        slots[slot] = it;
        return;
      }
      let w = windows.get(window);
      if (!w) windows.set(window, (w = []));
      while (w.length <= slot) w.push(null);
      w[slot] = it;
    },
  };
  const skillCalls: string[] = [];
  const skills = o.skills === false ? undefined : {
    place: async (p: Vec3, opts?: { item?: string | string[] }) => {
      skillCalls.push(`place ${p.x} ${p.y} ${p.z} ${String(opts?.item)}`);
      const i = slots.findIndex((s) => s?.name === 'crafting_table');
      if (i < 0) return { ok: false as const, reason: 'no_item' };
      slots[i] = slots[i]!.count > 1 ? { ...slots[i]!, count: slots[i]!.count - 1 } : null;
      server.slots[i] = slots[i] ? { ...slots[i] } : null;
      blocks.set(key(p), TABLE);
      return { ok: true as const, block: 'crafting_table' };
    },
    dig: async (p: Vec3) => {
      skillCalls.push(`dig ${p.x} ${p.y} ${p.z}`);
      if (o.digFails) return { ok: false as const, reason: 'interrupted' };
      if (blockAt(p).name !== 'crafting_table') return { ok: false as const, reason: 'air' };
      blocks.set(key(p), AIR);
      const free = slots.findIndex((s) => !s);
      const it = item('crafting_table', 1, server.nextId++);
      slots[free] = it;
      server.slots[free] = { ...it };
      return { ok: true as const };
    },
    collect: async () => {
      skillCalls.push('collect');
      return { ok: true as const, gained: {}, pickedUp: 0, skipped: 0, ticks: 0, corrections: 0 };
    },
    ...(o.goto
      ? {
          goto: async (g: { type: string; p?: Vec3 }) => {
            skillCalls.push(`goto ${g.type} ${g.p ? `${g.p.x} ${g.p.y} ${g.p.z}` : ''}`);
            if (g.p) loop.state.pos = { x: g.p.x + 1.5, y: -60, z: g.p.z + 0.5 }; // the far side of the wall
            return { ok: true as const };
          },
        }
      : {}),
  };
  const loop = {
    state: { pos: { ...FEET }, ready: true },
    setCommand: () => {},
    waitTicks: async () => {
      ticks++;
      for (const fn of later.splice(0)) fn();
      if (o.lateAfter !== undefined && ticks === o.lateAfter) for (const r of server.held.splice(0)) emit('item_stack_response', { responses: [r] });
    },
  };
  const noted: number[] = [];
  const deps: CrafterDeps = {
    source,
    loop,
    world: { blockAt, chunks: { runtimeIdAt: () => 1 }, inventory },
    containers: {
      get open() {
        return open;
      },
      onOpen: (fn) => {
        openFns.add(fn);
        return () => openFns.delete(fn);
      },
      onClose: (fn) => {
        closeFns.add(fn);
        return () => closeFns.delete(fn);
      },
      close: (id) => source.queue('container_close', { window_id: id, window_type: 'none', server: false }),
    },
    recipes,
    runtimeId: () => 7n,
    hotbar: { rawItem: () => undefined, noteRaw: (slot) => noted.push(slot) },
    ...(skills ? { skills } : {}),
    keep: (n) => n.endsWith('_pickaxe'),
  };
  const crafter = new Crafter(deps);
  const requests = () => sent.filter((s) => s.name === 'item_stack_request').map((s) => (s.params as { requests: Request[] }).requests[0]!);
  const modelCounts = () => {
    const out: Record<string, number> = {};
    for (const s of slots) if (s) out[s.name] = (out[s.name] ?? 0) + s.count;
    return out;
  };
  const cancelled = () => (o.cancelAfterBatches !== undefined ? requests().filter((r) => r.actions.some((a) => a.type_id === 'craft_recipe')).length >= o.cancelAfterBatches : false);
  const kinds = () => requests().map((q) => q.actions.map((a) => `${a.type_id}${a.source?.slot_type.container_id === 'crafting_input' && a.type_id === 'place' ? '<' : ''}`).join(','));
  return { crafter, server, sent, requests, modelCounts, skillCalls, noted, cancelled, blockAt, blocks, windows, kinds, loop };
}

/** The invariants every run must keep: nothing destroyed at close, the model equal to the server, no window left. */
function clean(h: ReturnType<typeof harness>): void {
  expect(h.server.destroyed).toEqual([]);
  expect(h.modelCounts()).toEqual(h.server.counts());
  expect(h.windows.size).toBe(0);
  expect(h.server.grid.size).toBe(0);
}

describe('Crafter on a fake server', () => {
  it('2 x 2: 8 oak logs -> 32 planks in one batch of two requests, with the measured request shapes', async () => {
    const h = harness([item('oak_log', 8, 1)]);
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: true, reason: 'done', item: 'oak_planks', wanted: 32, crafted: 32, used: { oak_log: 8 }, batches: 1, requests: 2 });
    expect(h.server.counts()).toEqual({ oak_planks: 32 });
    clean(h);
    const [fill, craft] = h.requests();
    expect(fill!.actions).toEqual([{ type_id: 'place', legacy_type_id: 1, count: 8, source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 1 }, destination: { slot_type: { container_id: 'crafting_input' }, slot: 28, stack_id: 0 } }]);
    expect(craft!.actions[0]).toEqual({ type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: 3587, times_crafted: 8 });
    expect(craft!.actions[1]).toEqual({ type_id: 'consume', legacy_type_id: 5, count: 8, source: { slot_type: { container_id: 'crafting_input' }, slot: 28, stack_id: 100 } });
    expect(craft!.actions[2]).toMatchObject({ type_id: 'place', legacy_type_id: 1, count: 32, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: craft!.request_id }, destination: { slot_type: { container_id: 'inventory' }, slot: 9, stack_id: 0 } });
    expect(craft!.request_id).toBeLessThan(-400000);
    expect(h.sent.map((s) => s.name)).toEqual(['interact', 'item_stack_request', 'item_stack_request', 'container_close']);
    expect(craftLine(r)).toMatch(/^crafted 32 oak_planks \(8 oak_log used\) in [\d.]+ s$/);
    expect(h.noted).toContain(0);
  });

  it('batches by the output stack (16 crafts of planks per request pair) and stops at the shortfall', async () => {
    const h = harness([item('oak_log', 20, 1), item('oak_log', 10, 2)]);
    const r = await h.crafter.craft('oak_planks', 200);
    expect(r.crafted).toBe(120);
    expect(r.batches).toBe(2);
    expect(r.shortfall).toEqual({ name: 'oak_log', have: 30, need: 50 });
    expect(h.server.counts()).toEqual({ oak_planks: 120 });
    clean(h);
    expect(craftLine(r)).toContain('oak_log short for 200');
  });

  it('a 1 x 2 shaped recipe (sticks) fills two grid cells; the table recipe of the same output is not chosen', async () => {
    const h = harness([item('oak_planks', 8, 1)]);
    const r = await h.crafter.craft('stick', 16);
    expect(r).toMatchObject({ ok: true, crafted: 16, used: { oak_planks: 8 } });
    expect(h.requests()[0]!.actions.map((a) => [a.destination!.slot, a.count])).toEqual([
      [28, 4],
      [30, 4],
    ]);
    expect(h.server.counts()).toEqual({ stick: 16 });
    clean(h);
  });

  it('shaped recipes with a hole: a chest (8 planks around an empty centre) and a furnace (8 cobblestone) fill exactly the pattern cells', async () => {
    const h = harness([item('crimson_planks', 16, 1)], { tableAt: { x: 2, y: -60, z: 0 } });
    const r = await h.crafter.craft('chest', 2);
    expect(r).toMatchObject({ ok: true, crafted: 2, used: { crimson_planks: 16 } });
    const fill = h.requests()[0]!;
    expect(fill.actions.map((a) => a.destination!.slot)).toEqual([32, 33, 34, 35, 37, 38, 39, 40]); // 36 (the centre) stays empty
    expect(fill.actions.every((a) => a.count === 2)).toBe(true);
    expect(h.server.counts()).toEqual({ chest: 2 });
    clean(h);
    const h2 = harness([item('cobblestone', 10, 1)], { tableAt: { x: 2, y: -60, z: 0 } });
    const r2 = await h2.crafter.craft('furnace', 1);
    expect(r2).toMatchObject({ ok: true, crafted: 1, used: { cobblestone: 8 } });
    expect(h2.requests()[0]!.actions.map((a) => a.destination!.slot)).toEqual([32, 33, 34, 35, 37, 38, 39, 40]);
    expect(h2.server.counts()).toEqual({ cobblestone: 2, furnace: 1 });
    clean(h2);
  });

  it('3 x 3: places the carried table, opens it as a workbench, crafts 4 iron blocks, picks the table up', async () => {
    const h = harness([item('iron_ingot', 36, 1), item('crafting_table', 1, 2)]);
    const r = await h.crafter.craft('iron_block', 4);
    expect(r).toMatchObject({ ok: true, crafted: 4, used: { iron_ingot: 36 }, batches: 1, requests: 2, table: { placed: true, pickedUp: true } });
    expect(h.skillCalls[0]).toMatch(/^place \d+ -60 \d+ crafting_table$/);
    expect(h.skillCalls[1]).toMatch(/^dig /);
    expect(h.server.counts()).toEqual({ iron_block: 4, crafting_table: 1 });
    clean(h);
    const fill = h.requests()[0]!;
    expect(fill.actions.map((a) => a.destination!.slot)).toEqual([32, 33, 34, 35, 36, 37, 38, 39, 40]);
    expect(fill.actions.every((a) => a.count === 4)).toBe(true);
    expect(h.requests()[1]!.actions.filter((a) => a.type_id === 'consume')).toHaveLength(9);
    expect(h.sent.map((s) => s.name)).toEqual(['inventory_transaction', 'item_stack_request', 'item_stack_request', 'container_close']);
    expect(h.crafter.pendingTables).toEqual([]);
    expect(craftLine(r)).toContain('crafting table placed and picked up');
  });

  it('a table in reach is used as it stands; behind a wall it is walked to (goto) or not used; none at all: no_table or a table crafted from planks', async () => {
    const h = harness([item('iron_ingot', 9, 1)], { tableAt: { x: 2, y: -60, z: 0 } });
    const r = await h.crafter.craft('iron_block', 1);
    expect(r).toMatchObject({ ok: true, crafted: 1, table: { placed: false, pos: { x: 2, y: -60, z: 0 } } });
    expect(h.skillCalls).toEqual([]);
    // a wall at x = 1 hides the table at x = 3: not visible, no goto -> no table carried -> no_table
    const walled = harness([item('iron_ingot', 9, 1)], { tableAt: { x: 3, y: -60, z: 0 }, wallAt: { x: 1, y: -60, z: 0 } });
    expect(walled.crafter.nearbyTable()).toBeUndefined();
    expect((await walled.crafter.craft('iron_block', 1)).reason).toBe('no_table');
    // with goto the bot walks around and uses it
    const walk = harness([item('iron_ingot', 9, 1)], { tableAt: { x: 3, y: -60, z: 0 }, wallAt: { x: 1, y: -60, z: 0 }, goto: true });
    const rw = await walk.crafter.craft('iron_block', 1);
    expect(rw).toMatchObject({ ok: true, crafted: 1, table: { placed: false } });
    expect(walk.skillCalls).toEqual(['goto getToBlock 3 -60 0']);
    const h2 = harness([item('iron_ingot', 9, 1)]);
    expect((await h2.crafter.craft('iron_block', 1)).reason).toBe('no_table');
    const h3 = harness([item('iron_ingot', 9, 1), item('oak_planks', 4, 2)]);
    const r3 = await h3.crafter.craft('iron_block', 1);
    expect(r3).toMatchObject({ ok: true, crafted: 1, table: { placed: true, pickedUp: true } });
    expect(h3.server.counts()).toEqual({ iron_block: 1, crafting_table: 1 });
    clean(h3);
  });

  it('a table the bot could not pick up is remembered (table_left) and picked up at the next craft', async () => {
    const h = harness([item('iron_ingot', 18, 1), item('crafting_table', 1, 2)], { digFails: true });
    const r = await h.crafter.craft('iron_block', 1);
    expect(r).toMatchObject({ ok: false, reason: 'table_left', crafted: 1, table: { placed: true, pickedUp: false } });
    expect(craftLine(r)).toMatch(/crafting table left at \d+ -60 \d+/);
    expect(h.crafter.pendingTables).toHaveLength(1);
    expect(h.server.counts()).toEqual({ iron_ingot: 9, iron_block: 1 });
    clean(h);
    // next run: the dig works; the standing table is ours (placed: true) and comes back
    const deps = (h.crafter as unknown as { d: { skills: { dig: (p: Vec3) => Promise<unknown> } } }).d;
    const pos = h.crafter.pendingTables[0]!;
    deps.skills.dig = async (p: Vec3) => {
      h.skillCalls.push(`dig ${p.x} ${p.y} ${p.z}`);
      const free = h.server.slots.findIndex((s) => !s);
      const it = item('crafting_table', 1, 900);
      (h.crafter as unknown as { d: { world: { inventory: { setItem: (w: number, s: number, i: ItemStack) => void } } } }).d.world.inventory.setItem(0, free, it);
      h.server.slots[free] = { ...it };
      h.blocks.set(`${p.x},${p.y},${p.z}`, AIR);
      return { ok: true };
    };
    const r2 = await h.crafter.craft('iron_block', 1);
    expect(r2.table).toMatchObject({ placed: true, pos });
    expect(h.skillCalls.filter((c) => c.startsWith('dig'))).toHaveLength(3); // the failed one, the retry at the start, and the pick-up after this craft
    expect(h.server.counts().iron_block).toBe(2);
  });

  it.each([17, 3, 49, 35])('a craft refused with status %i is retried once after the grid was given back; two refusals end the craft with the grid empty', async (status) => {
    const h = harness([item('oak_log', 8, 1)]);
    h.server.failCrafts = 1;
    h.server.failStatus = status;
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: true, crafted: 32 });
    expect(h.kinds()).toEqual(['place', 'craft_recipe,consume,place', 'place<', 'place', 'craft_recipe,consume,place']);
    clean(h);
    const h2 = harness([item('oak_log', 8, 1)]);
    h2.server.failCrafts = 2;
    h2.server.failStatus = status;
    const r2 = await h2.crafter.craft('oak_planks', 32);
    expect(r2).toMatchObject({ ok: false, reason: 'request_failed', crafted: 0, status });
    expect(h2.server.counts()).toEqual({ oak_log: 8 });
    clean(h2);
  });

  it('a refused fill rolls the model back and ends the craft with nothing moved', async () => {
    const h = harness([item('oak_log', 8, 1)]);
    h.server.failFills = 2;
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: false, reason: 'request_failed', crafted: 0, status: 7 });
    expect(h.server.counts()).toEqual({ oak_log: 8 });
    clean(h);
    expect(h.kinds()).toEqual(['place', 'place']); // the fill, the retry's fill, nothing else
  });

  it('a fill without an answer: the late response is applied (the grid stack ids known), the grid given back and the batch retried', async () => {
    const h = harness([item('oak_log', 8, 1)], { lateAfter: 70 });
    h.server.silent = 1;
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: true, crafted: 32, status: 'late' });
    expect(h.server.counts()).toEqual({ oak_planks: 32 });
    clean(h);
    expect(h.kinds()).toEqual(['place', 'place<', 'place', 'craft_recipe,consume,place']);
  });

  it('a fill with no answer at all (a dead connection): the give-back is tried with stack id 0 and refused (49, as BDS does); the grid is lost at close like a vanilla client\'s on a disconnect, and the model is told so', async () => {
    const h = harness([item('oak_log', 8, 1)]);
    h.server.silent = 1;
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: false, reason: 'request_failed', status: 'timeout', crafted: 0 });
    expect(h.kinds()).toEqual(['place', 'place<', 'place<', 'drop']);
    expect(h.server.destroyed.map((d) => `${d.count} ${d.name}`)).toEqual(['8 oak_log']);
    expect(h.modelCounts()).toEqual(h.server.counts());
    expect(h.windows.size).toBe(0);
  });

  it('a craft with no answer: the grid is given back, the model agrees with the server', async () => {
    const h = harness([item('oak_log', 8, 1)]);
    h.server.silent = 0;
    // the second request (the craft) is swallowed: arrange it by making the first request pass through
    const origHandle = h.server.handle.bind(h.server);
    let n = 0;
    h.server.handle = (req) => {
      n++;
      if (n === 2) {
        h.server.silent = 1;
      }
      return origHandle(req);
    };
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: false, reason: 'request_failed', status: 'timeout' });
    // the server did craft (the response was lost): the give-back finds the grid empty on the server and the model is told so
    expect(h.server.counts()).toEqual({ oak_planks: 32 });
    expect(h.server.destroyed).toEqual([]);
    expect(h.server.grid.size).toBe(0);
  });

  it('a refused give-back ends the retry; the final give-back retries cell by cell, then drops on the ground: never destroyed at close', async () => {
    const h = harness([item('oak_log', 8, 1)]);
    h.server.failCrafts = 1;
    h.server.failGivebacks = 3; // the mid-craft one-shot, the final one-shot, the final cell-by-cell
    const r = await h.crafter.craft('oak_planks', 32);
    expect(r).toMatchObject({ ok: false, reason: 'request_failed', crafted: 0, dropped: { oak_log: 8 } });
    expect(h.kinds()).toEqual(['place', 'craft_recipe,consume,place', 'place<', 'place<', 'place<', 'drop']);
    expect(h.server.destroyed).toEqual([]);
    expect(h.server.dropped.map((d) => `${d.count} ${d.name}`)).toEqual(['8 oak_log']);
    expect(h.server.counts()).toEqual({});
    expect(h.modelCounts()).toEqual(h.server.counts());
    expect(h.server.grid.size).toBe(0);
    expect(h.windows.size).toBe(0);
    expect(craftLine(r)).toContain('dropped 8 oak_log (no room)');
    // a give-back refused only once: the second attempt (cell by cell) succeeds, nothing dropped
    const h2 = harness([item('oak_log', 8, 1)]);
    h2.server.failCrafts = 2;
    h2.server.failGivebacks = 1;
    const r2 = await h2.crafter.craft('oak_planks', 32);
    expect(r2).toMatchObject({ ok: false, reason: 'request_failed', crafted: 0 });
    expect(h2.server.counts()).toEqual({ oak_log: 8 });
    expect(h2.server.dropped).toEqual([]);
    clean(h2);
  });

  it('a full inventory: the output slot is chosen before the fill (inventory_full, nothing moves); a stack the fill empties counts as room', async () => {
    // 35 stacks of cobblestone and one stack of 64 raw iron: 7 blocks would need a free slot that the fill does not make (1 raw iron stays)
    const h = harness([...stacks('cobblestone', 35, 1), item('raw_iron', 64, 50), item('crafting_table', 1, 51)].slice(0, 36), { tableAt: { x: 2, y: -60, z: 0 } });
    const before = h.server.counts();
    const r = await h.crafter.craft('raw_iron_block', 7);
    expect(r).toMatchObject({ ok: false, reason: 'inventory_full', crafted: 0 });
    expect(h.server.counts()).toEqual(before);
    clean(h);
    expect(h.kinds()).toEqual([]); // no request at all
    // 63 raw iron in one stack and a full inventory: the fill empties the stack, the output lands there
    const h2 = harness([...stacks('cobblestone', 35, 1), item('raw_iron', 63, 50)], { tableAt: { x: 2, y: -60, z: 0 } });
    const r2 = await h2.crafter.craft('raw_iron_block', 7);
    expect(r2).toMatchObject({ ok: true, crafted: 7 });
    expect(h2.server.counts()).toEqual({ cobblestone: 35 * 64, raw_iron_block: 7 });
    clean(h2);
    expect(destinationSlot(h2.loop.state.pos && [...stacks('x', 36)], 'y', 0, 1)).toBeUndefined();
  });

  it('the keep rule and the shortfall: a diamond pickaxe is no diamond; 9 ingots make 1 block of 100 asked', async () => {
    const h = harness([item('diamond_pickaxe', 1, 1), item('iron_ingot', 9, 2)]);
    const r = await h.crafter.craft('diamond_block', 1);
    expect(r).toMatchObject({ ok: false, reason: 'missing', crafted: 0, shortfall: { name: 'diamond', have: 0, need: 9 } });
    expect(h.sent).toEqual([]);
    const h2 = harness([item('iron_ingot', 9, 1), item('crafting_table', 1, 2)]);
    const r2 = await h2.crafter.craft('iron_block', 100);
    expect(r2).toMatchObject({ ok: true, crafted: 1, shortfall: { name: 'iron_ingot', have: 9, need: 900 } });
    expect(craftLine(r2)).toContain('891 iron_ingot short for 100');
    expect((await h2.crafter.craft('elytra', 1)).reason).toBe('no_recipe');
    clean(h2);
  });

  it('cancel between batches: the first batch stands, the grid is emptied, the screen closed', async () => {
    const h = harness([item('oak_log', 32, 1)], { cancelAfterBatches: 1 });
    const r = await h.crafter.craft('oak_planks', 128, h.cancelled);
    expect(r).toMatchObject({ reason: 'interrupted', crafted: 64, batches: 1 });
    expect(h.server.counts()).toEqual({ oak_log: 16, oak_planks: 64 });
    clean(h);
    expect(h.sent.at(-1)!.name).toBe('container_close');
  });
});
