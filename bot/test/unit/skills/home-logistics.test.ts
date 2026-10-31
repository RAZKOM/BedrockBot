/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Wave 9 Track AG: home logistics (skills/home/logistics.ts) on a fake world: scan (read, fresh,
// forget, double chest), unload (chest trips, memory refreshed), spare shulker boxes when every chest
// is full, `all` (full boxes emptied first), cancellation; and the processes (tasks/process/unload.ts):
// the user job process and the chore's triggers.
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { isShulkerBox, shulkerContents, snapshotOf } from '../../../src/skills/container/chest.ts';
import { HomeLogistics, MAX_READS_PER_SCAN, UNREACHABLE_RETRY_MS, unloadLine, type HomeDeps, type HomeSkills, type ScanReport, type UnloadReport } from '../../../src/skills/home/logistics.ts';
import { ChestMemory, chestKey } from '../../../src/world/cache/chests.ts';
import { setCompactPlanner, setCompactRunner } from '../../../src/skills/home/unloader.ts';
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';
import type { PathResult } from '../../../src/skills/nav/astar.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { AUTO_UNLOAD_STACKS, HomeChore, HomeJobProcess, type HomeChoreDeps, type HomeRunner } from '../../../src/tasks/process/unload.ts';

const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const block = (name: string, solid = true): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const max = (n: string) => (isShulkerBox(n) ? 1 : 64);
const nbt = (items: { name: string; count: number }[], display?: unknown) =>
  items.length || display ? { extra: { nbt: { nbt: { value: { ...(items.length ? { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } : {}), ...(display ? { display } : {}) } } } } } : { extra: { has_nbt: 0 } }; // Track AV: the server always sends the wire item (an unknown one is no spare)
/** Track AV: the custom name compound of a wire item (kept by the fake's place / dig like the server keeps a box's name). */
const displayOf = (raw: unknown): unknown => (raw as { extra?: { nbt?: { nbt?: { value?: { display?: unknown } } } } } | undefined)?.extra?.nbt?.nbt?.value?.display;
const namedBox = (name: string, items: { name: string; count: number }[] = []) => nbt(items, { type: 'compound', value: { Name: { type: 'string', value: name } } });
const fromNbt = (raw: unknown) =>
  ((raw as { extra?: { nbt?: { nbt?: { value?: { Items?: { value?: { value?: { Name: { value: string }; Count: { value: number } }[] } } } } } } } | undefined)?.extra?.nbt?.nbt?.value?.Items?.value?.value ?? []).map((i) => ({ name: i.Name.value.replace(/^minecraft:/, ''), count: i.Count.value }));

interface Box {
  kind: string;
  slots: (ItemStack | null)[];
  raws: unknown[];
  /** Track AV: a placed box's custom name. */
  display?: unknown;
}

/** A fake home: containers by position, an inventory, skills that act on them. */
function fakeHome(o: { containers: Record<string, { kind: string; items?: (ItemStack | null)[]; raws?: unknown[]; size?: number }>; inv: (ItemStack | null)[]; invRaws?: unknown[]; home?: Vec3; probe?: HomeDeps['probe']; now?: () => number; gotoFail?: Set<string> }) {
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
  const fail = { place: false, pickup: false, onPlaced: undefined as ((key: string) => void) | undefined, onDig: undefined as ((key: string) => void) | undefined, breakOnClose: false };
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

const never = () => false;

describe('home logistics: scan', () => {
  it('reads every container within the radius (a double chest once), skips fresh ones, forgets gone ones', async () => {
    const h = fakeHome({
      containers: {
        '3,0,0': { kind: 'chest', items: [item('coal', 20)] },
        '-3,0,0': { kind: 'chest', size: 54 },
        '-3,0,1': { kind: 'chest', size: 54 },
        '0,0,-4': { kind: 'barrel', items: [item('dirt', 5)] },
        '0,0,40': { kind: 'chest' }, // outside homeChestRadius 16
      },
      inv: [],
    });
    const r: ScanReport = await h.logistics.scan(never);
    expect(r).toMatchObject({ ok: true, found: 4, fresh: 0, forgotten: 0, failed: [] });
    expect(r.read.map((x) => chestKey(x)).sort()).toEqual(['-3,0,0', '0,0,-4', '3,0,0'].sort());
    expect(h.memory.get({ x: 3, y: 0, z: 0 })).toMatchObject({ kind: 'chest', contents: { coal: 20 }, free: 26, size: 27, readAt: 1_000_000 });
    expect(h.memory.get({ x: 0, y: 0, z: -4 })).toMatchObject({ kind: 'barrel', contents: { dirt: 5 } });
    const dbl = r.read.find((x) => x.double)!;
    expect(dbl.size).toBe(54);
    expect(h.memory.get(dbl.partner!)).toBeUndefined();
    expect(h.calls.filter((c) => c.startsWith('open'))).toHaveLength(3);
    // again: everything was read less than 10 minutes ago
    h.boxes.delete('3,0,0');
    const again = await h.logistics.scan(never);
    expect(again).toMatchObject({ found: 3, fresh: 2, forgotten: 1 }); // 3 blocks: the double chest's partner is neither read nor fresh
    expect(again.read).toHaveLength(0);
    expect(h.memory.get({ x: 3, y: 0, z: 0 })).toBeUndefined();
  });
});

describe('home logistics: walking distance (Track AN)', () => {
  /** A probe answer: a straight path of `blocks` blocks, or no path. */
  const found = (blocks: number, at: Vec3 = { x: blocks, y: 0, z: 0 }): PathResult => ({ status: 'found', path: Array.from({ length: blocks + 1 }, (_, i) => ({ x: at.x - (blocks - i), y: at.y, z: at.z, feet: at.y, move: 'walk' as const, cost: 1 })), cost: blocks, expanded: blocks, ms: 1, unknown: false, limited: false });
  const none: PathResult = { status: 'none', path: [{ x: 0, y: 0, z: 0, feet: 0, move: 'start', cost: 0 }], cost: 0, expanded: 50, ms: 1, unknown: false, limited: false };

  it('probes first, reads the reachable ones, remembers the unreachable ones for an hour; !chests scan (retry) probes them again; homeChestWalk 0 = radius only', async () => {
    let now = 1_000_000;
    const probed: string[] = [];
    const answers: Record<string, PathResult> = { '3,0,0': found(3, { x: 3, y: 0, z: 0 }), '-3,0,0': found(4, { x: -3, y: 0, z: 0 }), '0,0,6': none, '10,0,0': found(40, { x: 10, y: 0, z: 0 }) };
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest' }, '-3,0,0': { kind: 'barrel' }, '0,0,6': { kind: 'chest' }, '10,0,0': { kind: 'chest' } },
      inv: [],
      now: () => now,
      probe: async (g) => {
        const k = chestKey((g as { p: Vec3 }).p);
        probed.push(k);
        expect(g).toMatchObject({ type: 'getToBlock', reach: 4, face: false, low: 3 });
        return answers[k];
      },
    });
    h.settings.set('homeChestWalk', '32'); // the default is 64 (multi-floor houses); this fixture's far chest is 40 path blocks away
    const r = await h.logistics.scan(never);
    expect(r).toMatchObject({ ok: true, found: 4, radius: 16, walk: 32, reachable: 2, probes: 4, pending: [] });
    expect(r.read.map((x) => chestKey(x)).sort()).toEqual(['-3,0,0', '3,0,0']);
    expect(r.unreachable!.map((u) => `${chestKey(u.p)} ${u.reason}`).sort()).toEqual(['0,0,6 no path', '10,0,0 path 40 blocks']);
    expect(h.calls.filter((c) => c.startsWith('goto'))).toEqual(['goto 3,0,0', 'goto -3,0,0']); // nearest-neighbour from the bot (0.5, 0, 0.5)
    expect(h.memory.get({ x: 10, y: 0, z: 0 })).toMatchObject({ unreachable: 'path 40 blocks', unreachableAt: 1_000_000, readAt: 0 });
    // the unload never targets an unreachable container
    expect(h.logistics.plan().moves).toEqual([]);
    // 30 min later: the read ones are fresh... no: older than 10 min, read again; the unreachable ones are not probed
    now += 30 * 60_000;
    probed.length = 0;
    const again = await h.logistics.scan(never);
    expect([...new Set(probed)].sort()).toEqual(['-3,0,0', '3,0,0']);
    expect(again.unreachable).toHaveLength(2);
    expect(again.read).toHaveLength(2);
    // !chests scan: retry probes them again (the far one now has a shorter way)
    answers['10,0,0'] = found(20);
    probed.length = 0;
    const retry = await h.logistics.scan(never, { retry: true });
    expect([...new Set(probed)].sort()).toEqual(['0,0,6', '10,0,0']); // the other two are fresh
    expect(retry).toMatchObject({ fresh: 2, reachable: 1 });
    expect(retry.read.map((x) => chestKey(x))).toEqual(['10,0,0']);
    expect(h.memory.get({ x: 10, y: 0, z: 0 })!.unreachable).toBeUndefined();
    expect(h.memory.get({ x: 0, y: 0, z: 6 })!.unreachable).toBe('no path');
    // after an hour the scan probes it again by itself
    now += UNREACHABLE_RETRY_MS + 1;
    probed.length = 0;
    await h.logistics.scan(never);
    expect(probed).toContain('0,0,6');
    // homeChestWalk 0: no probes, every container within the radius is visited (the fake walks anywhere)
    h.settings.set('homeChestWalk', '0');
    probed.length = 0;
    const flat = await h.logistics.scan(never, { force: true, retry: true });
    expect(probed).toEqual([]);
    expect(flat.walk).toBeUndefined();
    expect(flat.read).toHaveLength(4);
    expect(h.memory.get({ x: 0, y: 0, z: 6 })!.unreachable).toBeUndefined(); // read: reachable after all
  });

  it(`reads at most ${MAX_READS_PER_SCAN} per scan, nearest path first, the rest pending; a walk that fails marks the container unreachable`, async () => {
    const containers: Record<string, { kind: string }> = {};
    const answers: Record<string, PathResult> = {};
    for (let i = 0; i < 70; i++) {
      const k = `${(i % 10) - 5},${Math.floor(i / 10)},${(i % 7) - 3}`;
      containers[k] = { kind: 'chest' };
      answers[k] = found(i + 1, { x: (i % 10) - 5, y: Math.floor(i / 10), z: (i % 7) - 3 }); // the fake stands in the chest cell itself
    }
    const first = Object.keys(containers)[0]!;
    const h = fakeHome({ containers, inv: [], probe: async (g) => answers[chestKey((g as { p: Vec3 }).p)], gotoFail: new Set([first]) });
    h.settings.set('homeChestWalk', '100');
    const r = await h.logistics.scan(never);
    expect(r).toMatchObject({ found: 70, reachable: 70 });
    expect(r.read).toHaveLength(MAX_READS_PER_SCAN - 1); // the first one's walk failed
    expect(r.pending).toHaveLength(70 - MAX_READS_PER_SCAN);
    // the pending ones are the longest paths
    const longest = Object.keys(answers).slice(MAX_READS_PER_SCAN);
    expect(r.pending!.map(chestKey).sort()).toEqual(longest.sort());
    const [fx, fy, fz] = first.split(',').map(Number);
    expect(r.unreachable).toEqual([{ p: { x: fx, y: fy, z: fz }, kind: 'chest', reason: 'goto: unreachable' }]);
    expect(h.memory.get(r.unreachable![0]!.p)!.unreachable).toBe('goto: unreachable');
    // the next scan of the pending ones reads them
    const next = await h.logistics.scan(never, { force: true, only: r.pending! });
    expect(next.read).toHaveLength(70 - MAX_READS_PER_SCAN);
    expect(next.pending).toEqual([]);
  });

  it('no standable start for the probes: radius only', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest' } }, inv: [], probe: async () => undefined });
    const r = await h.logistics.scan(never);
    expect(r.walk).toBeUndefined();
    expect(r.read).toHaveLength(1);
  });
});

describe('home logistics: unload', () => {
  it('deposits per the plan, chest by chest, and refreshes the memory on every trip', async () => {
    const h = fakeHome({
      containers: {
        '3,0,0': { kind: 'chest', items: [item('coal', 20)] },
        '-3,0,0': { kind: 'chest' },
        '0,0,-4': { kind: 'barrel', items: [item('dirt', 5)] },
      },
      inv: [item('iron_pickaxe', 1), item('coal'), item('cobblestone'), item('cobblestone', 30), item('dirt', 32), item('bread', 5)],
    });
    await h.logistics.scan(never);
    const r: UnloadReport = await h.logistics.unload(never);
    expect(r.ok).toBe(true);
    expect(r.left).toEqual([]);
    expect(r.boxes).toBe(0);
    expect(h.boxes.get('3,0,0')!.slots.filter(Boolean).map((s) => `${s!.count} ${s!.name}`)).toEqual(['64 coal', '20 coal']);
    expect(h.boxes.get('0,0,-4')!.slots.filter(Boolean).map((s) => `${s!.count} ${s!.name}`)).toEqual(['37 dirt']);
    expect(h.inv.filter(Boolean).map((s) => `${s!.count} ${s!.name}`)).toEqual(['1 iron_pickaxe', '16 cobblestone', '5 bread']);
    expect(h.memory.get({ x: 0, y: 0, z: -4 })!.contents).toEqual({ dirt: 37 });
    const line = unloadLine(r);
    expect(line).toContain('64 coal -> chest 3 0 0');
    expect(line).toContain('32 dirt -> barrel 0 0 -4');
    expect(line).toContain('78 cobblestone -> chest -3 0 0');
    expect(line).toContain('kept 16 cobblestone, 1 iron_pickaxe, 5 bread');
    expect(r.requests).toBe(5); // coal: top up 20 -> 64, then a new slot; cobblestone 64 + 14; dirt 32
  });

  it('all chests full: an empty box from the box chest takes the rest and goes back full', async () => {
    const stone = Array.from({ length: 27 }, () => item('stone'));
    const boxChest = [item('undyed_shulker_box', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 25 }, () => item('stone'))];
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', items: stone }, '-3,0,0': { kind: 'chest', items: boxChest } },
      inv: [item('iron_pickaxe', 1), ...Array.from({ length: 5 }, () => item('cobblestone'))],
    });
    await h.logistics.scan(never);
    expect(h.memory.get({ x: -3, y: 0, z: 0 })!.boxes).toEqual({ empty: 2, full: 0 });
    const r = await h.logistics.unload(never);
    expect(r).toMatchObject({ ok: true, boxes: 1, left: [] });
    expect(unloadLine(r)).toBe('unloaded: 304 cobblestone -> shulker box (into chest -3 0 0); 1 shulker box filled and stored; kept 16 cobblestone, 1 iron_pickaxe');
    const chest = h.boxes.get('-3,0,0')!;
    const boxes = chest.slots.map((s, i) => (s && isShulkerBox(s.name) ? shulkerContents(chest.raws[i]) : undefined)).filter((x) => x !== undefined);
    expect(boxes).toEqual([{ cobblestone: 304 }, {}]);
    expect(h.memory.get({ x: -3, y: 0, z: 0 })!.boxes).toEqual({ empty: 1, full: 1 });
    expect(h.calls.filter((c) => c.startsWith('place') || c.startsWith('dig') || c === 'collect')).toHaveLength(3);
    expect([...h.boxes.keys()].sort()).toEqual(['-3,0,0', '3,0,0']); // no box left standing
  });

  it('`all` empties a carried full box first and unloads its items', async () => {
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', items: [item('coal', 1)] } },
      inv: [item('iron_pickaxe', 1), item('red_shulker_box', 1)],
      invRaws: [undefined, nbt([{ name: 'coal', count: 100 }])],
    });
    await h.logistics.scan(never);
    const r = await h.logistics.unload(never, { all: true });
    expect(r).toMatchObject({ ok: true, emptied: 1 });
    expect(h.boxes.get('3,0,0')!.slots.filter(Boolean).reduce((a, s) => a + s!.count, 0)).toBe(101);
    // the box came back empty and is kept (the stash step's box)
    const box = h.inv.findIndex((s) => s?.name === 'red_shulker_box');
    expect(box).toBeGreaterThanOrEqual(0);
    expect(shulkerContents(h.invRaws[box])).toEqual({});
  });

  it('`all` with a nearly full inventory: the emptied box keeps its slot (the contents never fill it), so it is picked up again and emptied for good once the rest is unloaded', async () => {
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', size: 100 } },
      inv: [item('red_shulker_box', 1), ...Array.from({ length: 33 }, () => item('gravel'))], // 2 free slots, 3 once the box is placed
      invRaws: [nbt(Array.from({ length: 27 }, () => ({ name: 'sand', count: 64 })))],
    });
    await h.logistics.scan(never);
    const r = await h.logistics.unload(never, { all: true });
    expect(r).toMatchObject({ ok: true, emptied: 1 });
    expect([...h.boxes.keys()]).toEqual(['3,0,0']); // no box left standing
    const box = h.inv.findIndex((s) => s?.name === 'red_shulker_box');
    expect(box).toBeGreaterThanOrEqual(0); // carried again, not left on the ground
    expect(shulkerContents(h.invRaws[box])).toEqual({}); // two stacks out (one slot held back for the box), unloaded, then the rest
    const c = h.boxes.get('3,0,0')!;
    expect(c.slots.reduce((a, s, i) => a + (s?.name === 'sand' ? s.count : 0) + (s && isShulkerBox(s.name) ? (shulkerContents(c.raws[i]).sand ?? 0) : 0), 0)).toBe(27 * 64);
  });

  it('`all` empties every full box it carries and unloads each one before the next (not the fireworks box)', async () => {
    const stacks = (name: string) => Array.from({ length: 27 }, () => ({ name, count: 64 }));
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', size: 54 }, '-3,0,0': { kind: 'chest', size: 54 } },
      inv: [item('red_shulker_box', 1), item('blue_shulker_box', 1), item('lime_shulker_box', 1), item('yellow_shulker_box', 1), ...Array.from({ length: 20 }, () => item('gravel'))], // 12 free slots: no box fits at once
      invRaws: [nbt(stacks('sand')), nbt(stacks('clay_ball')), nbt(stacks('flint')), nbt([{ name: 'firework_rocket', count: 64 }])],
    });
    await h.logistics.scan(never);
    const r = await h.logistics.unload(never, { all: true });
    expect(r).toMatchObject({ ok: true, emptied: 3, left: [] });
    expect([...h.boxes.keys()].sort()).toEqual(['-3,0,0', '3,0,0']); // no box left standing
    // nothing but boxes (the fireworks box and the spare kept for the stash step) stays in the inventory
    expect(h.inv.filter((s) => s && !isShulkerBox(s.name))).toEqual([]);
    const rocket = h.inv.findIndex((s) => s?.name === 'yellow_shulker_box');
    expect(shulkerContents(h.invRaws[rocket])).toEqual({ firework_rocket: 64 });
    // the boxes still carried are empty; the stacks of all three are in the chests, loose or boxed again by the unloader
    for (const [i, s] of h.inv.entries()) if (s && isShulkerBox(s.name) && i !== rocket) expect(shulkerContents(h.invRaws[i])).toEqual({});
    const inChests = [...h.boxes.values()].flatMap((c) => c.slots.map((s, i) => ({ s, raw: c.raws[i] }))).filter((x) => x.s);
    const total = (name: string) => inChests.reduce((a, x) => a + (x.s!.name === name ? x.s!.count : 0) + (isShulkerBox(x.s!.name) ? (shulkerContents(x.raw)[name] ?? 0) : 0), 0);
    expect([total('sand'), total('clay_ball'), total('flint'), total('gravel')]).toEqual([27 * 64, 27 * 64, 27 * 64, 20 * 64]);
  });

  it('a cancelled job ends `interrupted`; no home or no chest answer at once', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest' } }, inv: [item('coal')] });
    await h.logistics.scan(never);
    h.setCancel('goto');
    const r = await h.logistics.unload(() => h.cancelled());
    expect(r.reason).toBe('interrupted');
    const empty = fakeHome({ containers: {}, inv: [item('coal')] });
    expect((await empty.logistics.unload(never)).reason).toBe('no_chests');
    expect(unloadLine(await empty.logistics.unload(never))).toBe('unload: I know no chest near home yet (!chests scan)');
  });
});

// ---- processes ---------------------------------------------------------------------------------

function fakeRunner() {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const scanRep = (): ScanReport => ({ ok: true, found: 1, read: [], fresh: 0, forgotten: 0, failed: [], requests: 0, ms: 1, pending: runner.nextPending.splice(0) });
  const unloadRep = (moved = 1): UnloadReport => ({ ok: true, moved: moved ? [{ name: 'coal', count: 64, to: 'chest 1 2 3' }] : [], kept: [], left: [], boxes: 0, emptied: 0, chests: 1, requests: 1, shared: 1, ms: 1 });
  const runner: HomeRunner & { calls: string[]; finish(): void; nextPending: Vec3[] } = {
    calls,
    nextPending: [],
    unload: (c, o) => {
      calls.push(`unload${o?.all ? ' all' : ''}`);
      return new Promise((r) => {
        release = () => r(c() ? { ...unloadRep(0), ok: false, reason: 'interrupted' } : unloadRep());
      });
    },
    scan: (c, o) => {
      calls.push(`scan${o?.only ? ` only ${o.only.length}` : ''}`);
      return new Promise((r) => {
        release = () => r(c() ? { ...scanRep(), ok: false, reason: 'interrupted' } : scanRep());
      });
    },
    cancel: () => calls.push('cancel'),
    finish: () => release?.(),
  };
  return runner;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('home logistics: boxing at the chests and named boxes (Track AV)', () => {
  const cobble27 = () => Array.from({ length: 27 }, () => item('cobblestone'));
  const box = () => item('undyed_shulker_box', 1);

  it("the owner's cobblestone: the full chest's stacks into a spare from the box chest, the box back into that chest, then the bot's 10 stacks", async () => {
    const h = fakeHome({
      containers: { '3,0,0': { kind: 'chest', items: cobble27() }, '-3,0,0': { kind: 'chest', items: [box(), box(), box()] } },
      inv: Array.from({ length: 10 }, () => item('cobblestone')),
    });
    h.settings.set('throwawayMin', '0');
    await h.logistics.scan(never);
    expect(h.logistics.plan().steps).toEqual([{ kind: 'box', item: 'cobblestone', chest: '3,0,0', stacks: 27, produce: 0, spare: '-3,0,0' }]);
    const r = await h.logistics.unload(never);
    expect(r.ok).toBe(true);
    expect(r.boxed).toEqual([expect.objectContaining({ item: 'cobblestone', stacks: 27, chest: 'chest 3 0 0', from: 'chest -3 0 0', took: 25 })]);
    expect(r.left).toEqual([]);
    expect(h.inv.filter((s) => s?.name === 'cobblestone')).toEqual([]);
    const c = h.boxes.get('3,0,0')!;
    expect(c.slots.filter((s) => s?.name === 'cobblestone').length).toBe(10);
    const boxIdx = c.slots.findIndex((s) => s?.name === 'undyed_shulker_box');
    expect(shulkerContents(c.raws[boxIdx])).toEqual({ cobblestone: 27 * 64 });
    expect(h.boxes.get('-3,0,0')!.slots.filter(Boolean)).toHaveLength(2);
    // the memory: the box with its contents, the loose stacks
    expect(h.memory.get({ x: 3, y: 0, z: 0 })).toMatchObject({ contents: { cobblestone: 640, undyed_shulker_box: 1 }, boxes: { empty: 0, full: 1 }, inBoxes: { cobblestone: 1728 }, free: 16 });
    expect(h.memory.get({ x: -3, y: 0, z: 0 })!.boxes).toEqual({ empty: 2, full: 0 });
    expect(unloadLine(r)).toBe('unloaded: 512 cobblestone -> chest 3 0 0; boxed 27 stacks of cobblestone from chest 3 0 0 into a shulker (box from chest -3 0 0)');
  });

  it('bot_loot boxes: the full one is emptied and its sand unloaded (boxing as needed), both stay carried and empty; a named box in a chest is no spare', async () => {
    const sand17 = Array.from({ length: 17 }, () => item('sand'));
    const h = fakeHome({
      containers: {
        '3,0,0': { kind: 'chest', items: sand17 },
        // a chest with a named empty box first, then 3 spares
        '-3,0,0': { kind: 'chest', items: [box(), box(), box(), box()], raws: [namedBox('bot_loot')] },
      },
      inv: [box(), box(), ...Array.from({ length: 20 }, () => item('sand'))],
      invRaws: [namedBox('§6Bot_Loot', Array.from({ length: 27 }, () => ({ name: 'sand', count: 64 }))), namedBox('bot_loot')],
    });
    await h.logistics.scan(never);
    expect(h.memory.get({ x: -3, y: 0, z: 0 })!.boxes).toEqual({ empty: 3, full: 0 }); // the named one is not counted
    const r = await h.logistics.unload(never);
    expect(r.ok).toBe(true);
    expect(r.left).toEqual([]);
    expect(r.emptiedNamed).toBe(1);
    expect(r.namedKept).toBe(2);
    expect(unloadLine(r)).toContain('kept 2 bot_loot boxes');
    // both named boxes carried, empty, still named
    const named = h.inv.map((s, i) => ({ s, raw: h.invRaws[i] })).filter((x) => x.s && isShulkerBox(x.s.name));
    expect(named).toHaveLength(2);
    for (const x of named) {
      expect(shulkerContents(x.raw)).toEqual({});
      expect(JSON.stringify(displayOf(x.raw))).toMatch(/bot_loot/i);
    }
    expect(h.inv.some((s) => s?.name === 'sand')).toBe(false);
    // all 64 stacks of sand in the sand chest, loose or boxed (2 boxes), the named box of the spare chest untouched
    const c = h.boxes.get('3,0,0')!;
    const boxedSand = c.slots.reduce((a, s, i) => a + (s && isShulkerBox(s.name) ? (shulkerContents(c.raws[i]).sand ?? 0) : 0), 0);
    const loose = c.slots.reduce((a, s) => a + (s?.name === 'sand' ? s.count : 0), 0);
    expect(boxedSand + loose).toBe(64 * 64);
    expect(r.boxed!.length).toBe(2);
    const spareChest = h.boxes.get('-3,0,0')!;
    expect(JSON.stringify(displayOf(spareChest.raws[0]))).toContain('bot_loot');
  });

  it('the compact runner (Track AV/AW): called once with plan.compact before the chest trips, its fragment in the reply; none installed: unchanged', async () => {
    const build = () => {
      const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: [...Array.from({ length: 26 }, () => item('iron_ingot')), item('iron_ingot', 10)] } }, inv: [item('iron_ingot'), item('iron_ingot')] });
      h.settings.set('throwawayMin', '0');
      return h;
    };
    const calls: unknown[] = [];
    setCompactPlanner((sl) => [{ kind: 'iron_ingot', count: sl.filter((x) => x.name === 'iron_ingot').reduce((a, x) => a + x.count, 0) - 2 }]);
    setCompactRunner(async (list) => {
      calls.push(list);
      return 'compacted 126 iron_ingot into 14 iron_block';
    });
    try {
      const h = build();
      await h.logistics.scan(never);
      expect(h.logistics.plan().compact).toEqual([{ kind: 'iron_ingot', count: 126 }]);
      const r = await h.logistics.unload(never);
      expect(calls).toEqual([[{ kind: 'iron_ingot', count: 126 }]]);
      expect(r.compacted).toBe('compacted 126 iron_ingot into 14 iron_block');
      expect(unloadLine(r)).toContain('; compacted 126 iron_ingot into 14 iron_block');
    } finally {
      setCompactRunner(undefined);
    }
    // a runner that throws: the reply says so, the unload goes on
    setCompactRunner(async () => {
      throw new Error('no crafting table');
    });
    try {
      const h3 = build();
      await h3.logistics.scan(never);
      const r3 = await h3.logistics.unload(never);
      expect(r3.compacted).toBe('compact failed: no crafting table');
      expect(r3.moved).toEqual([{ name: 'iron_ingot', count: 54, to: 'chest 3 0 0' }]);
    } finally {
      setCompactRunner(undefined);
      setCompactPlanner(undefined);
    }
    const h2 = build();
    await h2.logistics.scan(never);
    const r2 = await h2.logistics.unload(never);
    expect(r2.compacted).toBeUndefined();
    expect(r2.moved).toEqual([{ name: 'iron_ingot', count: 54, to: 'chest 3 0 0' }]);
    expect(calls).toHaveLength(1);
  });

  describe('box step failures (Track AV)', () => {
    const owner = () => {
      const h = fakeHome({
        containers: { '3,0,0': { kind: 'chest', items: cobble27() }, '-3,0,0': { kind: 'chest', items: [box(), box(), box()] } },
        inv: Array.from({ length: 10 }, () => item('cobblestone')),
      });
      h.settings.set('throwawayMin', '0');
      return h;
    };
    const boxesCarried = (h: ReturnType<typeof owner>) => h.inv.filter((s) => s && isShulkerBox(s.name)).length;
    const boxesOnGround = (h: ReturnType<typeof owner>) => [...h.boxes.keys()].filter((k) => k !== '3,0,0' && k !== '-3,0,0');

    it('the place fails: no box step, the cobblestone goes by the other rules, nothing left in the world', async () => {
      const h = owner();
      await h.logistics.scan(never);
      h.fail.place = true;
      const r = await h.logistics.unload(never);
      expect(r.ok).toBe(true);
      expect(r.boxed ?? []).toEqual([]);
      // the stacks taken out for the box went back; every cobblestone is stored, none carried
      expect(h.inv.some((x) => x?.name === 'cobblestone')).toBe(false);
      const stored = [...h.boxes.values()].reduce((n, b) => n + b.slots.reduce((m, x) => m + (x?.name === 'cobblestone' ? x.count : 0), 0), 0);
      expect(stored).toBe(27 * 64 + 640);
      expect(boxesOnGround(h)).toEqual([]);
    });

    it('the pickup fails: the step ends with the reason, the job goes on', async () => {
      const h = owner();
      await h.logistics.scan(never);
      h.fail.pickup = true;
      const r = await h.logistics.unload(never);
      expect(r.ok).toBe(true);
      expect(r.boxed ?? []).toEqual([]);
    });

    it('the target chest filled up meanwhile: storing the full box fails, the box stays carried', async () => {
      const h = owner();
      await h.logistics.scan(never);
      h.fail.onDig = () => {
        const c = h.boxes.get('3,0,0')!;
        c.slots.forEach((x, i) => {
          if (!x) c.slots[i] = item('stone');
        });
      };
      const r = await h.logistics.unload(never);
      expect(r.boxed ?? []).toEqual([]);
      expect(h.inv.some((s, i) => s && isShulkerBox(s.name) && shulkerContents(h.invRaws[i]).cobblestone === 1728) || h.boxes.get('-3,0,0')!.slots.some((s, i) => s && isShulkerBox(s.name) && shulkerContents(h.boxes.get('-3,0,0')!.raws[i]).cobblestone === 1728)).toBe(true);
      expect(boxesOnGround(h)).toEqual([]);
    });

    it('the spare chest was emptied meanwhile: no box step, the memory follows', async () => {
      const h = owner();
      await h.logistics.scan(never);
      h.boxes.get('-3,0,0')!.slots.fill(null);
      const r = await h.logistics.unload(never);
      expect(r.boxed ?? []).toEqual([]);
      expect(h.memory.get({ x: -3, y: 0, z: 0 })!.boxes.empty).toBe(0);
      expect(boxesCarried(h)).toBe(0);
    });

    it('a box broken by someone else before the bot breaks it: no dig, picked up all the same', async () => {
      const h = owner();
      await h.logistics.scan(never);
      h.fail.breakOnClose = true;
      const r = await h.logistics.unload(never);
      expect(r.boxed?.length).toBe(1);
      expect(h.calls.filter((c) => c.startsWith('dig'))).toEqual([]);
      expect(boxesOnGround(h)).toEqual([]);
    });

    it('a box without its wire item is unknown: kept, never a spare, never stored', () => {
      const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: cobble27() } }, inv: [box(), ...Array.from({ length: 3 }, () => item('cobblestone'))] });
      h.invRaws[0] = undefined;
      h.settings.set('throwawayMin', '0');
      const p = h.logistics.plan();
      expect(p.kept).toContainEqual({ name: 'undyed_shulker_box', count: 1, why: 'unknown_box' });
      expect(p.moves.some((m) => m.slot === 0)).toBe(false);
    });
  });

  it('a full chest and no spare box anywhere: the reply says what is left and why', async () => {
    const h = fakeHome({ containers: { '3,0,0': { kind: 'chest', items: cobble27() } }, inv: Array.from({ length: 3 }, () => item('cobblestone')) });
    h.settings.set('throwawayMin', '0');
    await h.logistics.scan(never);
    const r = await h.logistics.unload(never);
    expect(r.left).toEqual([{ name: 'cobblestone', count: 192 }]);
    expect(unloadLine(r)).toBe('unload: nothing moved; left 192 cobblestone (no room; chest 3 0 0 is full and no spare shulker box is known)');
  });
});

describe('home processes', () => {
  it('HomeJobProcess: runs as a user process; a pre-emption cancels, the resume runs the job again', async () => {
    const pm = new ProcessManager();
    const runner = fakeRunner();
    const p = pm.add(new HomeJobProcess(runner, { kind: 'unload' }));
    expect(p.name).toBe('unload');
    expect(runner.calls).toEqual(['unload']);
    const other = new HomeJobProcess(fakeRunner(), { kind: 'scan' });
    pm.add(other); // a newer user command pre-empts it
    expect(runner.calls).toEqual(['unload', 'cancel']);
    runner.finish(); // the cancelled run ends: ignored
    await tick();
    pm.stop(other);
    expect(runner.calls).toEqual(['unload', 'cancel', 'unload']);
    runner.finish();
    const r = await p.result;
    expect(r?.kind).toBe('unload');
    expect(p.done).toBe(true);
  });

  function chore(over: Partial<HomeChoreDeps> = {}) {
    const runner = fakeRunner();
    let t = 0;
    const state = { atHome: true, idle: true, auto: true, stacks: 0, full: 0, known: 2, getEnded: false };
    const said: UnloadReport[] = [];
    const c = new HomeChore({
      runner,
      atHome: () => state.atHome,
      idle: () => state.idle,
      autoUnload: () => state.auto,
      load: () => ({ stacks: state.stacks, fullBoxes: state.full }),
      known: () => state.known,
      getEnded: () => {
        const e = state.getEnded;
        state.getEnded = false;
        return e;
      },
      onGetUnload: (r) => said.push(r),
      now: () => t,
      ...over,
    });
    return { c, runner, state, said, advance: (ms: number) => (t += ms) };
  }

  it('HomeChore: the session scan at home first, then unloads above the threshold; never away from home or with a user process', async () => {
    const h = chore();
    const pm = new ProcessManager();
    h.state.atHome = false;
    pm.add(h.c);
    expect(h.runner.calls).toEqual([]);
    h.state.atHome = true;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan']);
    h.runner.finish();
    await tick();
    expect(h.c.sessionScan).toBe(false);
    h.state.stacks = AUTO_UNLOAD_STACKS;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan']); // 8 stacks: not more than 8
    h.state.stacks = AUTO_UNLOAD_STACKS + 1;
    h.state.idle = false;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan']); // a user process exists
    h.state.idle = true;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan', 'unload']);
    h.runner.finish();
    await tick();
    expect(h.c.stats).toMatchObject({ scans: 1, unloads: 1 });
    // autoUnload off: no unload
    h.state.auto = false;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan', 'unload']);
  });

  it('HomeChore: an appeared container is read; a !get job that ended at home is unloaded even below the threshold and reported', async () => {
    const h = chore();
    const pm = new ProcessManager();
    h.c.sessionScan = false;
    pm.add(h.c);
    h.c.appeared({ x: 1, y: 2, z: 3 });
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan only 1']);
    h.runner.finish();
    await tick();
    expect(h.c.pending.size).toBe(0);
    h.state.stacks = 2;
    h.state.getEnded = true;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan only 1', 'unload']);
    h.runner.finish();
    await tick();
    expect(h.said).toHaveLength(1);
    expect(h.c.stats.getUnloads).toBe(1);
    // a !get job that ended away from home: nothing
    h.state.atHome = false;
    h.state.getEnded = true;
    h.advance(2000);
    pm.tick();
    h.state.atHome = true;
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan only 1', 'unload']);
  });

  it('HomeChore (Track AN): the containers a scan left pending (read cap) are read at the next idle moment', async () => {
    const h = chore();
    const pm = new ProcessManager();
    pm.add(h.c);
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan']);
    h.runner.nextPending.push({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
    h.runner.finish();
    await tick();
    expect(h.c.sessionScan).toBe(false);
    expect(h.c.pending.size).toBe(2);
    h.advance(2000);
    pm.tick();
    expect(h.runner.calls).toEqual(['scan', 'scan only 2']);
    h.runner.finish();
    await tick();
    expect(h.c.pending.size).toBe(0);
  });
});
