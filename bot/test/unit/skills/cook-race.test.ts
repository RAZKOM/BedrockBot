// Track C2 (docs/food.md "Cook"): the cooker against a furnace whose server state runs ahead of the bot's model. The
// server validates each item stack request against its own slots (stack ids and counts; a wrong destination answers
// 50, a wrong source 49, as BDS does) and its slot changes (inventory_slot) reach the model late: after the next request
// has gone out, before its response (the order seen in iron-get's kit case on BDS 1.26.60.6:
//   inventory_content  furnace [-, oak_planks x1 (stack 2271), -], burn time left 0
//   -> place 6 beef -> furnace_ingredient            ok
//   -> place 3 oak_planks -> furnace_fuel (stack 2271)
//   <- inventory_slot  slot 1 empty                  (the input lit the furnace: it took the leftover plank)
//   <- item_stack_response 50).
import { describe, expect, it } from 'vitest';
import { Cooker } from '../../../src/skills/food/cook.ts';
import { cookedOf, fuelValue } from '../../../src/skills/food/finder.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count: number, stackId?: number): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(stackId !== undefined ? { stackId } : {}) });
const empty = (n: number) => Array.from({ length: n }, () => null);

interface SlotRef {
  slot_type: { container_id: string };
  slot: number;
  stack_id: number;
}

/**
 * A furnace whose server holds the truth. `furnace`: its three slots at the start; `burn`: ticks of fuel left burning;
 * `takeAtFuelRequest`: the furnace takes its next fuel item at the moment a fuel request arrives (its burn ran out),
 * with nothing burning and an input in.
 */
function racingFurnace(opts: { inv: (ItemStack | null)[]; furnace: (ItemStack | null)[]; burn?: number; takeAtFuelRequest?: boolean }) {
  const fpos = { x: 3, y: -60, z: 0 };
  const per = 200;
  let nextStack = 500;
  // server state
  const srv = new Map<number, (ItemStack | null)[]>([
    [0, opts.inv.map((s) => (s ? { ...s } : null))],
    [2, opts.furnace.map((s) => (s ? { ...s } : null))],
  ]);
  let burn = opts.burn ?? 0;
  let progress = 0;
  let takeAtFuel = opts.takeAtFuelRequest ?? false;
  // the bot's model, and the server's slot changes not delivered yet
  const model = new Map<number, (ItemStack | null)[]>([[0, opts.inv]]);
  const late: { w: number; slot: number; item: ItemStack | null }[] = [];
  const statuses: (string | number)[] = [];
  const sent: { name: string; p: Record<string, unknown> }[] = [];
  const listeners = new Map<string, ((p: Record<string, unknown>) => void)[]>();
  const openFns = new Set<(c: { id: number; type: string; pos: Vec3 }) => void>();
  const closeFns = new Set<(id: number, s: boolean) => void>();
  const copy = (s: ItemStack | null): ItemStack | null => (s ? { ...s } : null);
  const serverSet = (w: number, slot: number, it: ItemStack | null) => {
    srv.get(w)![slot] = it;
    if (model.has(w)) late.push({ w, slot, item: copy(it) });
  };
  const deliver = () => {
    for (const u of late.splice(0)) {
      const m = model.get(u.w);
      if (m) m[u.slot] = u.item;
    }
  };
  /** The furnace's own step: take a fuel item when nothing burns and an input waits. */
  const light = () => {
    const f = srv.get(2)!;
    if (burn <= 0 && f[0] && f[1]) {
      burn = fuelValue(f[1].name) * per;
      serverSet(2, 1, f[1].count > 1 ? { ...f[1], count: f[1].count - 1 } : null);
    }
  };
  const containers = {
    open: undefined as { id: number; type: string; pos: Vec3 } | undefined,
    onOpen: (fn: (c: { id: number; type: string; pos: Vec3 }) => void) => (openFns.add(fn), () => openFns.delete(fn)),
    onClose: (fn: (id: number, s: boolean) => void) => (closeFns.add(fn), () => closeFns.delete(fn)),
    close: (id: number) => {
      containers.open = undefined;
      model.delete(id);
      for (const f of [...closeFns]) f(id, false);
    },
  };
  const where = (r: SlotRef): [number, number] => (['hotbar', 'inventory'].includes(r.slot_type.container_id) ? [0, r.slot] : [2, r.slot]);
  const respond = (id: number, status: string | number) => {
    statuses.push(status);
    for (const fn of listeners.get('item_stack_response') ?? []) fn({ responses: [{ status, request_id: id, containers: [] }] });
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
        model.set(2, srv.get(2)!.map(copy));
        containers.open = { id: 2, type: 'furnace', pos: fpos };
        for (const f of [...openFns]) f(containers.open);
        return;
      }
      if (name !== 'item_stack_request') return;
      const r = (p.requests as { request_id: number; actions: Record<string, unknown>[] }[])[0]!;
      const a = r.actions[0]! as { type_id: string; count: number; source: SlotRef; destination: SlotRef };
      if (takeAtFuel && a.destination.slot_type.container_id === 'furnace_fuel') {
        takeAtFuel = false;
        burn = 0;
        light();
      }
      const [sw, ss] = where(a.source);
      const [dw, ds] = where(a.destination);
      const src = srv.get(sw)![ss] ?? null;
      const dst = srv.get(dw)![ds] ?? null;
      let status: string | number = 'ok';
      if (!src || src.count < a.count || (src.stackId ?? 0) !== a.source.stack_id) status = 49;
      else if ((dst?.stackId ?? 0) !== a.destination.stack_id || (dst && dst.name !== src.name)) status = 50;
      if (status === 'ok' && src) {
        const whole = src.count === a.count;
        srv.get(sw)![ss] = whole ? null : { ...src, count: src.count - a.count };
        srv.get(dw)![ds] = dst ? { ...dst, count: dst.count + a.count } : { ...src, count: a.count, stackId: whole ? src.stackId! : nextStack++ };
      }
      // the server's slot changes go out before the response; an ok response's counts then land on the model
      if (status === 'ok') late.splice(0, late.length, ...late.filter((u) => !(u.w === sw && u.slot === ss) && !(u.w === dw && u.slot === ds)));
      deliver();
      if (status === 'ok') {
        model.get(sw)![ss] = copy(srv.get(sw)![ss] ?? null);
        model.get(dw)![ds] = copy(srv.get(dw)![ds] ?? null);
      }
      respond(r.request_id, status);
      // the furnace's next step (an input just put in lights it): its slot change reaches the model only after the
      // bot's next request has gone out (or at the next tick)
      if (status === 'ok' && (sw === 2 || dw === 2)) light();
    },
  };
  const world = {
    blockAt: (p: Vec3) => (p.x === fpos.x && p.y === fpos.y && p.z === fpos.z ? ({ name: burn > 0 ? 'lit_furnace' : 'furnace', stateId: 0, states: {}, hardness: 3.5, solid: true, boxes: [] } as BlockInfo) : undefined),
    find: (_pred: unknown, o: { origin: Vec3; radius: number }) => (Math.hypot(fpos.x - o.origin.x, fpos.z - o.origin.z) <= o.radius ? [fpos] : []),
    chunks: { runtimeIdAt: () => 42 },
    inventory: {
      get slots() {
        return model.get(0)!;
      },
      selected: 0,
      window: (id: number): ContainerView | undefined => (model.has(id) ? { id, slots: model.get(id)! } : undefined),
      setItem: (w: number, slot: number, it: ItemStack | null) => {
        const s = model.get(w);
        if (s) s[slot] = it;
      },
    },
  };
  const loop = {
    state: { pos: { x: 0.5, y: -60, z: 0.5 }, ready: true },
    setCommand: () => undefined,
    waitTicks: (n: number) => {
      for (let i = 0; i < n; i++) {
        deliver();
        const f = srv.get(2)!;
        light();
        if (burn <= 0) continue;
        burn--;
        if (!f[0]) continue;
        if (++progress >= per) {
          progress = 0;
          const input = f[0];
          serverSet(2, 0, input.count > 1 ? { ...input, count: input.count - 1 } : null);
          const out = f[2];
          serverSet(2, 2, { name: cookedOf(input.name)!, networkId: 2, metadata: 0, count: (out?.count ?? 0) + 1, stackId: out?.stackId ?? nextStack++ });
        }
      }
      return Promise.resolve();
    },
  };
  const cooker = new Cooker({ source, loop, world, containers, mover: { goto: () => Promise.resolve({ ok: true }) }, home: () => ({ x: 0, y: -60, z: 0 }) });
  const moves = () =>
    sent
      .filter((s) => s.name === 'item_stack_request')
      .map((s) => (s.p.requests as { actions: { type_id: string; count: number; destination: SlotRef }[] }[])[0]!.actions[0]!)
      .map((a) => `${a.type_id} ${a.count} -> ${a.destination.slot_type.container_id} (${a.destination.stack_id})`);
  return { cooker, srv, statuses, moves };
}

describe('Cooker against a furnace ahead of the model (Track C2)', () => {
  it('a leftover fuel item and an empty input: the fuel goes in first, so the input lighting the furnace changes no slot a request names', async () => {
    const f = racingFurnace({
      inv: [item('stone_sword', 1, 1), item('beef', 6, 50), ...empty(7), item('oak_planks', 3, 68), ...empty(26)],
      furnace: [null, item('oak_planks', 1, 71), null],
    });
    const r = await f.cooker.cook({}, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', cooked: { cooked_beef: 6 }, fuel: { oak_planks: 3 } });
    expect(f.statuses.every((s) => s === 'ok')).toBe(true);
    expect(f.moves()).toEqual(['place 3 -> furnace_fuel (71)', 'place 6 -> furnace_ingredient (0)', 'take 6 -> hotbar (0)']);
  });

  it('a fuel item taken while the request is on its way (refused, 50): planned again from what the slot holds after, not from the rolled-back guess', async () => {
    // the input is in and cooking on its last fuel; the furnace takes the leftover plank as the fuel request arrives
    const f = racingFurnace({
      inv: [item('beef', 2, 50), ...empty(8), item('oak_planks', 5, 68), ...empty(26)],
      furnace: [item('beef', 4, 60), item('oak_planks', 1, 71), null],
      burn: 5,
      takeAtFuelRequest: true,
    });
    const r = await f.cooker.cook({}, () => false);
    expect(r).toMatchObject({ ok: true, reason: 'done', cooked: { cooked_beef: 6 } });
    expect(f.statuses.filter((s) => s !== 'ok')).toEqual([50]);
    const fuel = f.moves().filter((m) => m.includes('furnace_fuel'));
    expect(fuel).toHaveLength(2);
    expect(fuel[0]).toMatch(/\(71\)$/);
    expect(fuel[1]).toMatch(/\(0\)$/); // the slot the server emptied, not the plank the rollback put back
  });
});
