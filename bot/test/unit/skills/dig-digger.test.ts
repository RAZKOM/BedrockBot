// Digger state machine (PLAN.md 4.1 / 4.2) against a fake input loop and world: the per-tick
// block_action sequence, completion on update_block, timeout, cancel, reach and tool switching.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/connection/types.ts';
import { Digger, type DigLoop, type DigResult, type DigWorld } from '../../../src/skills/dig/index.ts';
import type { TickExtrasProvider } from '../../../src/skills/input/inputLoop.ts';
import type { BlockInfo, ItemStack } from '../../../src/world/types.ts';

const info = (name: string): BlockInfo => ({ name, stateId: 1, states: {}, hardness: 0, solid: name !== 'air', boxes: [] });

class FakeLoop implements DigLoop {
  state = { pos: { x: 0.5, y: -60, z: 0.5 }, tick: 0n, ready: true };
  cmd: { yaw?: number; pitch?: number } = {};
  extras: TickExtrasProvider | undefined;
  /** block_action names and input flags per sent tick. */
  sent: { tick: bigint; actions: string[]; flags: string[] }[] = [];
  setCommand(c: { yaw?: number; pitch?: number }): void {
    this.cmd = { ...this.cmd, ...c };
  }
  setTickExtras(fn: TickExtrasProvider | undefined): void {
    this.extras = fn;
  }
  tick(): void {
    const t = ++this.state.tick;
    const e = this.extras?.(t);
    const actions = ((e?.block_action as { action: string }[] | undefined) ?? []).map((a) => a.action);
    this.sent.push({ tick: t, actions, flags: e?.input_data ?? [] });
  }
  ticks(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
  }
  /** Ticks that carried block actions, as "tick:action+action". */
  trace(): string[] {
    return this.sent.filter((s) => s.actions.length).map((s) => `${s.tick}:${s.actions.join('+')}`);
  }
}

class FakeWorld implements DigWorld {
  blocks = new Map<string, string>();
  listeners = new Set<(p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void>();
  inventory: { slots: (ItemStack | null)[]; selected: number } = { slots: new Array<ItemStack | null>(36).fill(null), selected: 0 };
  blockAt(p: Vec3): BlockInfo | undefined {
    return info(this.blocks.get(`${p.x},${p.y},${p.z}`) ?? 'air');
  }
  onBlockUpdate(fn: (p: Vec3, before: BlockInfo | undefined, after: BlockInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  set(p: Vec3, name: string): void {
    const before = this.blockAt(p);
    this.blocks.set(`${p.x},${p.y},${p.z}`, name);
    for (const fn of [...this.listeners]) fn(p, before, info(name));
  }
  give(slot: number, name: string): void {
    this.inventory.slots[slot] = { name, networkId: 1, count: 1, metadata: 0 };
  }
}

const P = { x: 2, y: -60, z: 0 };

function setup() {
  const loop = new FakeLoop();
  const world = new FakeWorld();
  const selected: number[] = [];
  const hotbar = {
    select: (s: number) => {
      selected.push(s);
      world.inventory.selected = s;
      return true;
    },
  };
  const digger = new Digger({ loop, world, hotbar });
  return { loop, world, digger, selected };
}

describe('Digger', () => {
  it('aims, then start / continue / predict+stop at N, completes on update_block and releases with abort_break', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'dirt');
    const pending = digger.dig(P);
    // looking at the block centre from the eye: east (yaw -90) and slightly down
    expect(loop.cmd.yaw).toBeCloseTo(-90, 0);
    expect(loop.cmd.pitch).toBeGreaterThan(0);
    loop.ticks(17); // tick 1 = aim, 2 = start, 3..16 continue, 17 = predict (dirt by hand: 15)
    expect(loop.sent[0]!.actions).toEqual([]);
    expect(loop.sent[1]!.actions).toEqual(['start_break']);
    expect(loop.sent[1]!.flags).toEqual(['block_action']);
    expect(loop.sent.slice(2, 16).every((s) => s.actions.join() === 'continue_break')).toBe(true);
    expect(loop.sent[16]!.actions).toEqual(['predict_break', 'stop_break']);
    loop.tick();
    world.set(P, 'air');
    const r = await pending;
    expect(r).toMatchObject({ ok: true, block: 'dirt', slot: 0, item: null, expected: 15, ticks: 16, restores: 0 });
    loop.tick();
    expect(loop.sent.at(-1)!.actions).toEqual(['abort_break']);
    // then the provider removes itself
    loop.tick();
    expect(loop.sent.at(-1)!.actions).toEqual([]);
    expect(loop.extras).toBeUndefined();
    expect(digger.busy).toBe(false);
  });

  it('completes early when the server finishes first (no predict), and still releases', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    const pending = digger.dig(P);
    loop.ticks(60); // start at 2, continue up to 60
    world.set(P, 'air');
    expect(await pending).toMatchObject({ ok: true, ticks: 58 });
    loop.tick();
    expect(loop.trace().filter((t) => !t.endsWith('continue_break'))).toEqual(['2:start_break', '61:abort_break']);
  });

  it('counts restores (rejected predict) and times out at 1.5 x expected with abort_break', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    const pending = digger.dig(P, { tool: 0 });
    loop.ticks(62); // start at tick 2, predict at 62
    world.set(P, 'oak_log'); // the server answered the predict with the original block
    loop.ticks(30); // rel 90 = 1.5 * 60
    expect(digger.busy).toBe(true);
    loop.tick(); // rel 91 > 90
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout', restores: 1, expected: 60, timeoutTicks: 90 });
    expect(loop.sent.at(-1)!.actions).toEqual(['abort_break']);
  });

  it('cancel() resolves interrupted and sends abort_break on the next tick', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    const pending = digger.dig(P);
    loop.ticks(10);
    digger.cancel();
    expect(await pending).toMatchObject({ ok: false, reason: 'interrupted' });
    loop.tick();
    expect(loop.sent.at(-1)!.actions).toEqual(['abort_break']);
    loop.ticks(3);
    expect(loop.trace().at(-1)).toBe('11:abort_break');
  });

  it('cancel() before start_break sends nothing', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    const pending = digger.dig(P);
    digger.cancel();
    expect(await pending).toMatchObject({ ok: false, reason: 'interrupted' });
    loop.ticks(5);
    expect(loop.trace()).toEqual([]);
  });

  it('switches to the best hotbar slot before start_break', async () => {
    const { loop, world, digger, selected } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    world.give(0, 'dirt');
    world.give(3, 'stone_axe');
    world.give(4, 'wooden_pickaxe');
    const pending = digger.dig(P, { tool: 'best' });
    expect(selected).toEqual([3]);
    loop.ticks(17);
    world.set(P, 'air');
    expect(await pending).toMatchObject({ ok: true, slot: 3, item: 'stone_axe', expected: 15 });
    expect(loop.trace()[0]).toBe('2:start_break');
    expect(loop.trace()).toContain('17:predict_break+stop_break');
  });

  it('an explicit slot uses that item: a pickaxe on a log is hand speed', async () => {
    const { world, digger, selected } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    world.give(4, 'wooden_pickaxe');
    const pending = digger.dig(P, { tool: 4 });
    expect(selected).toEqual([4]);
    digger.cancel();
    expect(await pending).toMatchObject({ ok: false, reason: 'interrupted', expected: 60, item: 'wooden_pickaxe' });
  });

  it('waits out the 5-tick break cooldown between two digs', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'short_grass');
    world.blocks.set('2,-60,1', 'short_grass');
    const a = digger.dig(P);
    loop.ticks(2); // aim, start (+ predict: instant)
    expect(loop.trace()).toEqual(['2:start_break+predict_break+stop_break']);
    world.set(P, 'air');
    expect(await a).toMatchObject({ ok: true, expected: 0 });
    const b = digger.dig({ x: 2, y: -60, z: 1 });
    loop.ticks(6);
    // the first is released at 3; the second starts no earlier than its break tick (2) + 5
    expect(loop.trace()).toEqual(['2:start_break+predict_break+stop_break', '3:abort_break', '7:start_break+predict_break+stop_break']);
    world.set({ x: 2, y: -60, z: 1 }, 'air');
    expect(await b).toMatchObject({ ok: true });
  });

  it('refuses unreachable, missing, unbreakable, bad-slot and busy requests without sending anything', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('9,-60,0', 'dirt');
    world.blocks.set('1,-61,0', 'bedrock');
    expect(await digger.dig({ x: 9, y: -60, z: 0 })).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await digger.dig({ x: 1, y: -60, z: 0 })).toMatchObject({ ok: false, reason: 'no_block' });
    expect(await digger.dig({ x: 1, y: -61, z: 0 })).toMatchObject({ ok: false, reason: 'unbreakable' });
    world.blocks.set('2,-60,0', 'dirt');
    expect(await digger.dig(P, { tool: 9 })).toMatchObject({ ok: false, reason: 'bad_slot' });
    const first = digger.dig(P);
    expect(await digger.dig(P)).toMatchObject({ ok: false, reason: 'busy' });
    digger.cancel();
    await first;
    loop.ticks(3);
    expect(loop.trace()).toEqual([]);
  });

  it('gives up with unreachable (and abort_break) when the bot is moved away mid-break', async () => {
    const { loop, world, digger } = setup();
    world.blocks.set('2,-60,0', 'oak_log');
    const pending = digger.dig(P);
    loop.ticks(5);
    loop.state.pos = { x: 20.5, y: -60, z: 0.5 };
    loop.tick();
    const r: DigResult = await pending;
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(loop.sent.at(-1)!.actions).toEqual(['abort_break']);
  });

  it('requireHarvest: no_tool when nothing in the hotbar drops the block', async () => {
    const { world, digger } = setup();
    world.blocks.set('2,-60,0', 'stone');
    world.give(0, 'stone_axe');
    expect(await digger.dig(P, { requireHarvest: true })).toMatchObject({ ok: false, reason: 'no_tool' });
  });
});
