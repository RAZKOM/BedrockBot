// GatherWood state machine (PLAN.md task 4.6) against fake skills, plus the !gather chat command.
import { describe, expect, it } from 'vitest';
import type { Chat, CommandDef } from '../../../src/chat/chat.ts';
import { registerGatherCommands } from '../../../src/chat/commands.ts';
import type { FellResult, Tree } from '../../../src/skills/index.ts';
import { GatherWoodTask, logsIn, parseBlockPos, type GatherDeps } from '../../../src/tasks/gatherWood.ts';
import { Inventory } from '../../../src/world/inventory.ts';
import type { ItemV4 } from '../../../src/world/packets.ts';
import type { ContainerView, ItemStack, Vec3 } from '../../../src/world/types.ts';

const NAMES: Record<number, string> = { 17: 'oak_log', 18: 'birch_log', 6: 'oak_sapling', 300: 'stone_axe' };
const toItem = (i: ItemV4): ItemStack | null => (i.network_id === 0 ? null : { name: NAMES[i.network_id]!, networkId: i.network_id, count: i.count, metadata: 0 });
const v4 = (id: number, count: number): ItemV4 => ({ network_id: id, count, metadata: 0, has_stack_id: false, block_runtime_id: 0 });

function tree(x: number, h: number): Tree {
  const logs = Array.from({ length: h }, (_, i) => ({ x, y: -60 + i, z: 0 }));
  return { kind: 'oak', logs, base: logs[0]!, top: -60 + h - 1, leaves: 30, partial: false, grounded: true };
}

interface World {
  trees: Tree[];
  chest: number;
  inv: Inventory;
  calls: string[];
  /** fellTree fails for these bases. */
  stubborn: Set<number>;
  /** Hook to inject events (death) during a call. */
  onCall?: (name: string) => void;
}

function addLogs(inv: Inventory, n: number, id = 17): void {
  for (let left = n; left > 0; ) {
    const slot = inv.slots.findIndex((s) => s?.networkId === id && s.count < 64);
    const free = slot >= 0 ? slot : inv.slots.findIndex((s) => !s);
    if (free < 0) return;
    const have = inv.slots[free]?.count ?? 0;
    const put = Math.min(64 - have, left);
    inv.handleInventorySlot({ window_id: 0, slot: free, item: v4(id, have + put) });
    left -= put;
  }
}

function fakeDeps(w: World, opts: { ready?: () => boolean } = {}): GatherDeps {
  let cancelled = 0;
  const skills = {
    findTrees: () => {
      w.calls.push('find');
      return [...w.trees];
    },
    fellTree: (t: Tree): Promise<FellResult> => {
      w.calls.push(`fell ${t.base.x}`);
      const c = cancelled;
      w.onCall?.('fell');
      if (cancelled !== c) return Promise.resolve({ ok: false, reason: 'interrupted', broken: [], left: t.logs, repaths: 0, digFailures: 0, corrections: 0, ticksDigging: 0 });
      if (w.stubborn.has(t.base.x)) return Promise.resolve({ ok: false, reason: 'logs_left', broken: [], left: t.logs, repaths: 1, digFailures: 0, corrections: 0, ticksDigging: 0 });
      w.trees = w.trees.filter((x) => x !== t);
      addLogs(w.inv, t.logs.length);
      return Promise.resolve({ ok: true, broken: t.logs, left: [], repaths: 1, digFailures: 0, corrections: 1, ticksDigging: 10 });
    },
    collect: () => {
      w.calls.push('collect');
      addLogs(w.inv, 1, 6); // a sapling
      return Promise.resolve({ ok: true as const, gained: {}, pickedUp: 0, skipped: 0, ticks: 5, corrections: 0 });
    },
    goto: () => {
      w.calls.push('goto');
      return Promise.resolve({ ok: true as const });
    },
    open: () => {
      w.calls.push('open');
      return Promise.resolve({ ok: true as const, view: { id: 2, slots: [] }, open: { id: 2, type: 'container', pos: { x: 0, y: -60, z: 0 }, openedAt: 0 } });
    },
    deposit: (_v: ContainerView, filter: (i: ItemStack) => boolean) => {
      w.calls.push('deposit');
      const moved: Record<string, number> = {};
      let total = 0;
      w.inv.slots.forEach((s, i) => {
        if (s && filter(s)) {
          moved[s.name] = (moved[s.name] ?? 0) + s.count;
          total += s.count;
          w.inv.handleInventorySlot({ window_id: 0, slot: i, item: v4(0, 0) });
        }
      });
      w.chest += total;
      return Promise.resolve({ ok: true, moved, total, requests: 1, errors: 0 });
    },
    closeContainer: () => Promise.resolve(true),
    cancel: () => {
      cancelled++;
    },
    status: () => ({ running: undefined }),
  } as unknown as GatherDeps['skills'];
  return {
    skills,
    inventory: w.inv,
    position: () => ({ x: 0.5, y: -60, z: 0.5 }),
    ready: opts.ready ?? (() => true),
    waitTicks: () => new Promise((r) => setTimeout(r, 0)),
    corrections: () => 0,
  };
}

function world(trees: Tree[]): World {
  return { trees, chest: 0, inv: new Inventory(toItem, () => 1n), calls: [], stubborn: new Set() };
}

const CHEST: Vec3 = { x: 0, y: -60, z: 0 };

describe('GatherWoodTask', () => {
  it('find -> fell -> collect until the target is carried, then one trip to the chest; saplings stay', async () => {
    const w = world([tree(3, 5), tree(8, 6), tree(12, 4), tree(20, 5)]);
    const g = new GatherWoodTask(fakeDeps(w));
    const end = await g.start({ target: 10, chest: CHEST });
    expect(end).toBe('done');
    expect(w.chest).toBe(11); // 5 + 6 logs carried when the target was passed
    expect(g.stats).toMatchObject({ deposited: 11, treesFelled: 2, trips: 1, logsBroken: 11 });
    expect(w.calls).toEqual(['find', 'fell 3', 'collect', 'find', 'fell 8', 'collect', 'goto', 'open', 'deposit']);
    expect(w.inv.count('oak_sapling')).toBe(2);
    expect(g.status()).toMatchObject({ state: 'done', target: 10, carried: 0 });
    expect(g.statusLine()).toMatchObject({ task: 'gather', state: 'done', logs: '11/10' });
  });

  it('deposits when the inventory is full, then goes on', async () => {
    const w = world([tree(3, 6), tree(5, 6)]);
    // 34 slots of axes: two slots left
    for (let s = 0; s < 34; s++) w.inv.handleInventorySlot({ window_id: 0, slot: s, item: v4(300, 1) });
    const g = new GatherWoodTask(fakeDeps(w));
    const end = await g.start({ target: 12, chest: CHEST, minFreeSlots: 2 });
    expect(end).toBe('done');
    expect(w.chest).toBe(12);
    expect(g.stats.trips).toBe(2);
    expect(g.stats.inventoryFull).toBeGreaterThan(0);
  });

  it('gives up on a tree it cannot finish and fails when no trees are left', async () => {
    const w = world([tree(3, 5)]);
    w.stubborn.add(3);
    const g = new GatherWoodTask(fakeDeps(w));
    const end = await g.start({ target: 5, chest: CHEST, treeAttempts: 2, noTreeRounds: 2 });
    expect(end).toBe('failed');
    expect(g.stats.treesFailed).toBe(2);
    expect(g.lastError).toMatch(/no trees/);
  });

  it('without a chest it stops once it carries the target', async () => {
    const w = world([tree(3, 5), tree(6, 5)]);
    const g = new GatherWoodTask(fakeDeps(w));
    expect(await g.start({ target: 7 })).toBe('done');
    expect(logsIn(w.inv.slots)).toBe(10);
    expect(w.calls).not.toContain('open');
  });

  it('pause (death) interrupts the running skill; resume continues from find-tree', async () => {
    const w = world([tree(3, 5), tree(6, 5)]);
    const deps = fakeDeps(w);
    const g = new GatherWoodTask(deps);
    let died = false;
    w.onCall = (name) => {
      if (name === 'fell' && !died) {
        died = true;
        g.pause('dead');
        setTimeout(() => g.resume(), 5);
      }
    };
    const end = await g.start({ target: 10, chest: CHEST });
    expect(end).toBe('done');
    expect(g.stats.deaths).toBe(1);
    expect(w.chest).toBe(10);
    expect(w.calls.filter((c) => c === 'fell 3').length).toBe(2);
  });

  it('stop() ends the run and waits while the bot cannot act', async () => {
    const w = world([tree(3, 5)]);
    let ready = false;
    const g = new GatherWoodTask(fakeDeps(w, { ready: () => ready }));
    const p = g.start({ target: 50, chest: CHEST });
    await new Promise((r) => setTimeout(r, 5));
    expect(g.state).toBe('waiting');
    ready = true;
    g.stop();
    expect(await p).toBe('stopped');
    expect(g.running).toBe(false);
    expect(() => g.start({ target: 0 })).toThrow();
  });
});

describe('parseBlockPos and !gather', () => {
  it('parses x,y,z', () => {
    expect(parseBlockPos('10,-60,-3')).toEqual({ x: 10, y: -60, z: -3 });
    expect(parseBlockPos('1 2 3')).toEqual({ x: 1, y: 2, z: 3 });
    expect(parseBlockPos('1,2')).toBeUndefined();
    expect(parseBlockPos(undefined)).toBeUndefined();
  });

  it('!gather N [x y z] | stop | status', () => {
    const defs: CommandDef[] = [];
    const chat = { register: (d: CommandDef) => defs.push(d) } as unknown as Chat;
    const calls: unknown[] = [];
    registerGatherCommands(chat, {
      start: (n, c) => {
        calls.push(['start', n, c]);
        return `start ${n}`;
      },
      stop: () => 'stopped',
      status: () => 'status line',
    });
    const run = (args: string[]) => {
      let out = '';
      defs[0]!.run({ args, reply: (m) => (out = m), sender: { kind: 'console' }, line: {} as never });
      return out;
    };
    expect(defs[0]!.name).toBe('gather');
    expect(run(['64'])).toBe('start 64');
    expect(run(['16', '1', '-60', '2'])).toBe('start 16');
    expect(calls).toEqual([
      ['start', 64, undefined],
      ['start', 16, { x: 1, y: -60, z: 2 }],
    ]);
    expect(run(['stop'])).toBe('stopped');
    expect(run([])).toBe('status line');
    expect(run(['abc'])).toMatch(/usage/);
    expect(run(['5', '1', '2'])).toMatch(/usage/);
  });
});

