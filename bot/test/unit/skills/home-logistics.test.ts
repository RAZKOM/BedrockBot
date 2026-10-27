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
import type { BlockInfo, ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';
import type { PathResult } from '../../../src/skills/nav/astar.ts';
import { ProcessManager } from '../../../src/tasks/process/manager.ts';
import { AUTO_UNLOAD_STACKS, HomeChore, HomeJobProcess, type HomeChoreDeps, type HomeRunner } from '../../../src/tasks/process/unload.ts';

const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const block = (name: string, solid = true): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 1, solid, boxes: solid ? [[0, 0, 0, 1, 1, 1]] : [] });
const max = (n: string) => (isShulkerBox(n) ? 1 : 64);
const nbt = (items: { name: string; count: number }[]) => (items.length ? { extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((i) => ({ Name: { value: `minecraft:${i.name}` }, Count: { value: i.count } })) } } } } } } } : undefined);
const fromNbt = (raw: unknown) => Object.entries(shulkerContents(raw)).map(([name, count]) => ({ name, count }));

interface Box {
  kind: string;
  slots: (ItemStack | null)[];
  raws: unknown[];
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
  let pos: Vec3 = { x: 0.5, y: 0, z: 0.5 };
  const calls: string[] = [];
  let drop: { name: string; raw: unknown } | undefined;
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
      const names = [po?.item].flat();
      const slot = inv.findIndex((s) => s && names.includes(s.name));
      if (slot < 0) return { ok: false, reason: 'no_item' };
      const raw = invRaws[slot];
      const items = fromNbt(raw);
      boxes.set(chestKey(p), { kind: inv[slot]!.name, slots: [...items.map((i) => item(i.name, i.count)), ...Array.from({ length: 27 - items.length }, () => null)], raws: [] });
      inv[slot] = null;
      invRaws[slot] = undefined;
      return { ok: true };
    },
    dig: async (p) => {
      calls.push(`dig ${chestKey(p)}`);
      const b = boxes.get(chestKey(p))!;
      boxes.delete(chestKey(p));
      const list = new Map<string, number>();
      for (const s of b.slots) if (s) list.set(s.name, (list.get(s.name) ?? 0) + s.count);
      drop = { name: b.kind, raw: nbt([...list].map(([name, count]) => ({ name, count }))) };
      return { ok: true };
    },
    collect: async () => {
      calls.push('collect');
      if (drop) {
        const i = inv.findIndex((s) => !s);
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
  const found = (blocks: number): PathResult => ({ status: 'found', path: Array.from({ length: blocks + 1 }, (_, i) => ({ x: i, y: 0, z: 0, feet: 0, move: 'walk' as const, cost: 1 })), cost: blocks, expanded: blocks, ms: 1, unknown: false, limited: false });
  const none: PathResult = { status: 'none', path: [{ x: 0, y: 0, z: 0, feet: 0, move: 'start', cost: 0 }], cost: 0, expanded: 50, ms: 1, unknown: false, limited: false };

  it('probes first, reads the reachable ones, remembers the unreachable ones for an hour; !chests scan (retry) probes them again; homeChestWalk 0 = radius only', async () => {
    let now = 1_000_000;
    const probed: string[] = [];
    const answers: Record<string, PathResult> = { '3,0,0': found(3), '-3,0,0': found(4), '0,0,6': none, '10,0,0': found(40) };
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
      answers[k] = found(i + 1);
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
