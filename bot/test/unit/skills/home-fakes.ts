/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// The fake home of the home logistics tests (wave 9 Track AG, Track AV), shared since Track BJ with the supply
// layer's tests (supply.test.ts): containers by position, an inventory, skills that act on them (place, dig,
// collect keep a placed box's items and name like the server).
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { isShulkerBox, snapshotOf } from '../../../src/skills/container/chest.ts';
import { HomeLogistics, type HomeDeps, type HomeSkills } from '../../../src/skills/home/logistics.ts';
import { ChestMemory, chestKey } from '../../../src/world/cache/chests.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';

export const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
export const block = (name: string, solid = true): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
export const max = (n: string) => (isShulkerBox(n) ? 1 : 64);
export const nbt = (items: { name: string; count: number }[], display?: unknown) =>
  items.length || display ? { extra: { nbt: { nbt: { value: { ...(items.length ? { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } : {}), ...(display ? { display } : {}) } } } } } : { extra: { has_nbt: 0 } }; // Track AV: the server always sends the wire item (an unknown one is no spare)
/** Track AV: the custom name compound of a wire item (kept by the fake's place / dig like the server keeps a box's name). */
export const displayOf = (raw: unknown): unknown => (raw as { extra?: { nbt?: { nbt?: { value?: { display?: unknown } } } } } | undefined)?.extra?.nbt?.nbt?.value?.display;
export const namedBox = (name: string, items: { name: string; count: number }[] = []) => nbt(items, { type: 'compound', value: { Name: { type: 'string', value: name } } });
export const fromNbt = (raw: unknown) =>
  ((raw as { extra?: { nbt?: { nbt?: { value?: { Items?: { value?: { value?: { Name: { value: string }; Count: { value: number } }[] } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.Items?.value?.value ?? []).map((i) => ({ name: i.Name.value.replace(/^minecraft:/, ''), count: i.Count.value }));

export interface Box {
  kind: string;
  slots: (ItemStack | null)[];
  raws: unknown[];
  /** Track AV: a placed box's custom name. */
  display?: unknown;
}

/** A fake home: containers by position, an inventory, skills that act on them. */
export function fakeHome(o: { containers: Record<string, { kind: string; items?: (ItemStack | null)[]; raws?: unknown[]; size?: number }>; inv: (ItemStack | null)[]; invRaws?: unknown[]; home?: Vec3; probe?: HomeDeps['probe']; now?: () => number; gotoFail?: Set<string> }) {
  const boxes = new Map<string, Box>();
  for (const [k, c] of Object.entries(o.containers)) {
    const size = c.size ?? 27;
    boxes.set(k, { kind: c.kind, slots: [...(c.items ?? []), ...Array.from({ length: size - (c.items?.length ?? 0) }, () => null)], raws: [...(c.raws ?? [])] });
  }
  const inv: (ItemStack | null)[] = [...o.inv, ...Array.from({ length: 36 - o.inv.length }, () => null)];
  const invRaws: unknown[] = [...(o.invRaws ?? [])];
  // Track AV: a box without a given raw has the server's empty wire item (no raw at all: unknown, never a spare)
  inv.forEach((x, i) => {
    if (x && isShulkerBox(x.name) && invRaws[i] === undefined) invRaws[i] = nbt([]);
  });
  for (const b of boxes.values()) b.slots.forEach((x, i) => {
    if (x && isShulkerBox(x.name) && b.raws[i] === undefined) b.raws[i] = nbt([]);
  });
  let pos: Vec3 = { x: 0.5, y: 0, z: 0.5 };
  const calls: string[] = [];
  let drop: { name: string; raw: unknown } | undefined;
  let selected = 0;
  /** Track AV: failure knobs for the box step tests. */
  const fail = { place: false, pickup: false, pickupUntilNear: false, onPlaced: undefined as ((key: string) => void) | undefined, onDig: undefined as ((key: string) => void) | undefined, breakOnClose: false, digInterrupt: false };
  const breakAt = (key: string): void => {
    const b = boxes.get(key)!;
    boxes.delete(key);
    // one NBT entry per slot, like the server (Track AV: the slots used count)
    drop = { name: b.kind, raw: nbt(b.slots.filter((x): x is ItemStack => !!x).map((x) => ({ name: x.name, count: x.count })), b.display) };
  };
  let windowOf: Box | undefined;
  let cancelAt: string | undefined;
  let cancelled = false;
  const parse = (k: string): Vec3 => {
    const [x, y, z] = k.split(',').map(Number);
    return { x: x!, y: y!, z: z! };
  };
  const blockAt = (p: Vec3): BlockInfo => {
    const b = boxes.get(chestKey(p));
    if (b) return block(b.kind);
    return p.y < 0 ? block('stone') : block('air', false);
  };
  const skills: HomeSkills = {
    goto: async (g) => {
      calls.push(`goto ${chestKey((g as { p: Vec3 }).p)}`);
      if (g.type === 'near' && fail.pickupUntilNear) fail.pickup = false; // walked back to the box: it is found now
      if (cancelAt === 'goto') {
        cancelled = true;
        return { ok: false, reason: 'interrupted' };
      }
      const p = (g as { p: Vec3 }).p;
      if (o.gotoFail?.has(chestKey(p))) return { ok: false, reason: 'unreachable' };
      pos = { x: p.x + 1, y: 0, z: p.z };
      return { ok: true };
    },
    open: async (p) => {
      const b = boxes.get(chestKey(p));
      calls.push(`open ${chestKey(p)}`);
      if (!b) return { ok: false, reason: 'not_a_container' };
      windowOf = b;
      return { ok: true, view: { id: 5, slots: b.slots }, open: { id: 5, type: 'container', pos: p, openedAt: 0 }, block: b.kind };
    },
    closeContainer: async () => {
      calls.push('close');
      // Track AV: a player breaks the placed box while the bot closes it
      const key = [...boxes].find(([, b]) => b === windowOf)?.[0];
      if (fail.breakOnClose && key && isShulkerBox(windowOf!.kind) && !(key in o.containers)) breakAt(key);
      windowOf = undefined;
      return true;
    },
    snapshot: (v) => snapshotOf(v.slots, (i) => windowOf?.raws[i]),
    depositSlots: async (v: ContainerView, moves) => {
      const b = windowOf!;
      const moved: Record<string, number> = {};
      let total = 0;
      let requests = 0;
      for (const m of moves) {
        let left = m.count;
        while (left > 0) {
          const it = inv[m.slot];
          if (!it || (m.name && it.name !== m.name)) break;
          let dst = b.slots.findIndex((s) => s?.name === it.name && s.count < max(it.name));
          if (dst < 0) dst = b.slots.findIndex((s) => !s);
          if (dst < 0) return { ok: false, reason: 'container_full', moved, total, requests, errors: 0 };
          const n = Math.min(left, it.count, max(it.name) - (b.slots[dst]?.count ?? 0));
          b.slots[dst] = { ...it, count: (b.slots[dst]?.count ?? 0) + n };
          b.raws[dst] = invRaws[m.slot];
          inv[m.slot] = it.count - n > 0 ? { ...it, count: it.count - n } : null;
          if (!inv[m.slot]) invRaws[m.slot] = undefined;
          requests++;
          moved[it.name] = (moved[it.name] ?? 0) + n;
          total += n;
          left -= n;
        }
      }
      void v;
      return { ok: true, moved, total, requests, errors: 0 };
    },
    take: async (v, slot, count, prefer = []) => {
      const b = windowOf!;
      const it = b.slots[slot];
      if (!it) return { ok: false, reason: 'empty_source', moved: 0 };
      const to = prefer.find((i) => !inv[i]) ?? inv.findIndex((s) => !s);
      if (to < 0) return { ok: false, reason: 'inventory_full', moved: 0 };
      const n = Math.min(count ?? it.count, it.count);
      inv[to] = { ...it, count: n };
      invRaws[to] = b.raws[slot];
      b.slots[slot] = it.count - n > 0 ? { ...it, count: it.count - n } : null;
      if (!b.slots[slot]) b.raws[slot] = undefined;
      void v;
      return { ok: true, moved: n, to };
    },
    place: async (p, po) => {
      calls.push(`place ${chestKey(p)}`);
      if (fail.place) return { ok: false, reason: 'rejected' };
      const names = [po?.item].flat();
      // like the place skill: the held item, else the lowest slot (hotbar first)
      const slot = inv[selected] && names.includes(inv[selected]!.name) ? selected : inv.findIndex((s) => s && names.includes(s.name));
      if (slot < 0) return { ok: false, reason: 'no_item' };
      const raw = invRaws[slot];
      const items = fromNbt(raw);
      boxes.set(chestKey(p), { kind: inv[slot]!.name, slots: [...items.map((i) => item(i.name, i.count)), ...Array.from({ length: 27 - items.length }, () => null)], raws: [], display: displayOf(raw) });
      inv[slot] = null;
      invRaws[slot] = undefined;
      fail.onPlaced?.(chestKey(p));
      return { ok: true };
    },
    dig: async (p) => {
      calls.push(`dig ${chestKey(p)}`);
      if (!boxes.has(chestKey(p))) return { ok: false, reason: 'no_block' };
      // Track BJ: a pre-emption cancels the dig once (the box stays standing)
      if (fail.digInterrupt) {
        fail.digInterrupt = false;
        return { ok: false, reason: 'interrupted' };
      }
      fail.onDig?.(chestKey(p));
      breakAt(chestKey(p));
      return { ok: true };
    },
    collect: async () => {
      calls.push('collect');
      const i = inv.findIndex((s) => !s);
      if (drop && !fail.pickup && i >= 0) { // a full inventory leaves the box on the ground
        inv[i] = item(drop.name, 1);
        invRaws[i] = drop.raw;
        drop = undefined;
      }
      return { ok: true, gained: {}, pickedUp: 1, skipped: 0, ticks: 1, corrections: 0 };
    },
    cancel: () => calls.push('cancel'),
  };
  const memory = new ChestMemory();
  const settings = new RuntimeSettings();
  const home = o.home ?? { x: 0, y: 0, z: 0 };
  const logistics = new HomeLogistics({
    skills,
    inventory: { slots: inv, rawItem: (w, s) => (w === 0 ? invRaws[s] : windowOf?.raws[s]) },
    world: {
      find: (pred, opts) =>
        [...boxes.keys()]
          .map(parse)
          .filter((p) => Math.hypot(p.x + 0.5 - opts.origin.x, p.y + 0.5 - opts.origin.y, p.z + 0.5 - opts.origin.z) <= opts.radius && pred(blockAt(p), p))
          .sort((a, b) => Math.hypot(a.x - opts.origin.x, a.z - opts.origin.z) - Math.hypot(b.x - opts.origin.x, b.z - opts.origin.z)),
      blockAt,
    },
    position: () => pos,
    home: () => home,
    memory: () => memory,
    settings,
    selectHotbar: (slot: number) => {
      selected = slot;
    },
    // Track AV: inventory-to-inventory moves (while a window is open)
    containers: {
      stats: { requests: 0 },
      move: async (src, dst, count) => {
        if (src.window !== 0 || dst.window !== 0 || !inv[src.slot] || inv[dst.slot]) return { ok: false };
        void count;
        inv[dst.slot] = inv[src.slot]!;
        invRaws[dst.slot] = invRaws[src.slot];
        inv[src.slot] = null;
        invRaws[src.slot] = undefined;
        calls.push(`move ${src.slot} -> ${dst.slot}`);
        return { ok: true };
      },
    },
    now: o.now ?? (() => 1_000_000),
    ...(o.probe ? { probe: o.probe } : {}),
  });
  return {
    logistics,
    /** Track BJ: the inventory as the logistics see it (the open window's raw items too), and the world, for a BoxOps of the test's own. */
    inventory: { slots: inv, rawItem: (w: number, s: number): unknown => (w === 0 ? invRaws[s] : windowOf?.raws[s]) },
    blockAt,
    position: () => pos,
    select: (slot: number) => {
      selected = slot;
    },
    boxes,
    inv,
    invRaws,
    calls,
    memory,
    settings,
    setCancel: (at: string | undefined) => {
      cancelAt = at;
    },
    cancelled: () => cancelled,
    setPos: (p: Vec3) => {
      pos = p;
    },
    fail,
    breakAt,
  };
}

