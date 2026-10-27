// Sleeping (wave 7, Track W; docs/survival.md "Sleep") on fakes: the bed helpers (window, texts,
// head, search), the click, asleep / refused / awake from the measured BDS 1.26.60 packets, the held
// position while asleep, and leaving the bed.
import { describe, expect, it } from 'vitest';
import { bedHead, bedTextKey, findBeds, inSleepWindow, SleepController, SLEEP_EYE_ABOVE, type SleepEvent } from '../../../src/skills/survival/sleep.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';
import { FakeSource } from './pve-fakes.ts';

const bed = (head: boolean, direction = 3): BlockInfo => ({ name: 'bed', stateId: 1, states: { direction, head_piece_bit: head ? 1 : 0, occupied_bit: 0 }, hardness: 0.2, solid: true, boxes: [] });
const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;

class World {
  readonly blocks = new Map<string, BlockInfo>();
  readonly chunks = { runtimeIdAt: (x: number, y: number, z: number) => (this.blocks.has(key({ x, y, z })) ? 777 : 0) };
  readonly inventory = { slots: [] as (ItemStack | null)[], selected: 0, rawItem: () => undefined };
  blockAt(p: Vec3): BlockInfo | undefined {
    return this.blocks.get(key(p)) ?? { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };
  }
}

class Loop {
  state = { pos: { x: 0.5, y: -60, z: 0.5 }, ready: true };
  extras: ((t: bigint) => Record<string, unknown> | undefined) | undefined;
  cmds: { yaw?: number; pitch?: number }[] = [];
  private waiters: (() => void)[] = [];
  setCommand(c: { yaw?: number; pitch?: number }): void {
    this.cmds.push(c);
  }
  setTickExtras(fn: ((t: bigint) => Record<string, unknown> | undefined) | undefined): void {
    this.extras = fn;
  }
  waitTicks(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }
  /** Run one tick: every waiter resolves, then let the promise chains run. */
  async tick(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      const w = this.waiters.splice(0);
      for (const r of w) r();
      for (let k = 0; k < 5; k++) await Promise.resolve();
    }
  }
}

function setup() {
  const src = new FakeSource();
  const loop = new Loop();
  const world = new World();
  world.blocks.set('2,-60,0', bed(false));
  world.blocks.set('3,-60,0', bed(true));
  const sleeper = new SleepController({ source: src, loop, world, selfRuntimeId: () => 5n });
  const events: SleepEvent[] = [];
  sleeper.onEvent((e) => events.push(e));
  return { src, loop, world, sleeper, events };
}

const flags = (src: FakeSource, v: number, bedAt?: Vec3) =>
  src.emit('set_entity_data', { runtime_entity_id: 5n, metadata: [{ key: 'player_flags', value: v }, ...(bedAt ? [{ key: 'player_bed_position', value: bedAt }] : [])] });
const text = (src: FakeSource, k: string) => src.emit('text', { type: 'json', message: JSON.stringify({ rawtext: [{ text: '§7' }, { translate: `tile.bed.${k}` }] }) });

describe('bed helpers', () => {
  it('the sleep window is [12542, 23459) of the day', () => {
    expect(inSleepWindow(12400)).toBe(false);
    expect(inSleepWindow(12542)).toBe(true);
    expect(inSleepWindow(18000)).toBe(true);
    expect(inSleepWindow(23458)).toBe(true);
    expect(inSleepWindow(23500)).toBe(false);
    expect(inSleepWindow(24000 * 3 + 13000)).toBe(true);
    expect(inSleepWindow(undefined)).toBe(false);
  });

  it('reads tile.bed.* keys from json and plain texts; finds the head of a bed', () => {
    expect(bedTextKey('{"rawtext":[{"text":"§7"},{"translate":"tile.bed.notSafe"}]}')).toBe('notSafe');
    expect(bedTextKey('%tile.bed.noSleep')).toBe('noSleep');
    expect(bedTextKey('hello')).toBeUndefined();
    expect(bedHead({ x: 2, y: -60, z: 0 }, bed(false, 3))).toEqual({ x: 3, y: -60, z: 0 });
    expect(bedHead({ x: 2, y: -60, z: 0 }, bed(false, 0))).toEqual({ x: 2, y: -60, z: 1 });
    expect(bedHead({ x: 2, y: -60, z: 0 }, bed(false, 1))).toEqual({ x: 1, y: -60, z: 0 });
    expect(bedHead({ x: 2, y: -60, z: 0 }, bed(false, 2))).toEqual({ x: 2, y: -60, z: -1 });
    expect(bedHead({ x: 3, y: -60, z: 0 }, bed(true, 3))).toEqual({ x: 3, y: -60, z: 0 });
  });

  it('finds beds within the radius, one per bed, nearest first', () => {
    const w = new World();
    w.blocks.set('2,-60,0', bed(false));
    w.blocks.set('3,-60,0', bed(true));
    w.blocks.set('-6,-60,0', bed(false, 1));
    w.blocks.set('-7,-60,0', bed(true, 1));
    w.blocks.set('20,-60,0', bed(true));
    expect(findBeds(w, { x: 0.5, y: -60, z: 0.5 }, 8)).toEqual([
      { x: 3, y: -60, z: 0 },
      { x: -7, y: -60, z: 0 },
    ]);
    expect(findBeds(w, { x: 0.5, y: -60, z: 0.5 }, 1)).toEqual([]);
  });
});

describe('SleepController', () => {
  it('clicks the bed and is asleep on player_flags 2; holds the bed position; awake on player_flags 0', async () => {
    const s = setup();
    const p = s.sleeper.sleep({ x: 2, y: -60, z: 0 });
    await s.loop.tick(2);
    const click = s.src.sent.find((x) => x.name === 'inventory_transaction')!;
    const td = (click.params.transaction as { transaction_data: Record<string, unknown> }).transaction_data;
    expect(td).toMatchObject({ action_type: 'click_block', block_position: { x: 2, y: -60, z: 0 }, face: 4, block_runtime_id: 777, hotbar_slot: 0 });
    flags(s.src, 2, { x: 3, y: -60, z: 0 });
    await s.loop.tick(1);
    const r = await p;
    expect(r).toMatchObject({ ok: true, bed: { x: 3, y: -60, z: 0 } });
    expect(s.sleeper.sleeping).toBe(true);
    expect(s.events[0]).toEqual({ kind: 'asleep', bed: { x: 3, y: -60, z: 0 } });
    // the reported position is the server's sleeping position, no movement
    expect(s.loop.extras?.(1n)).toMatchObject({ position: { x: 3.5, y: -60 + SLEEP_EYE_ABOVE, z: 0.5 }, delta: { x: 0, y: 0, z: 0 } });
    s.src.emit('correct_player_move_prediction', { prediction_type: 'player', position: { x: 3.5, y: -59.1, z: 0.5 } });
    expect(s.loop.extras?.(2n)).toMatchObject({ position: { x: 3.5, y: -59.1, z: 0.5 } });
    flags(s.src, 0);
    expect(s.sleeper.sleeping).toBe(false);
    expect(s.loop.extras).toBeUndefined();
    expect(s.events.at(-1)?.kind).toBe('awake');
  });

  it('reports the refusal texts (respawnSet is not one)', async () => {
    for (const [k, reason] of [
      ['notSafe', 'monsters'],
      ['noSleep', 'not_night'],
      ['obstructed', 'obstructed'],
      ['tooFar', 'too_far'],
      ['occupied', 'occupied'],
    ] as const) {
      const s = setup();
      const p = s.sleeper.sleep({ x: 3, y: -60, z: 0 });
      await s.loop.tick(2);
      text(s.src, 'respawnSet');
      text(s.src, k);
      await s.loop.tick(1);
      expect(await p).toMatchObject({ ok: false, reason, text: k });
      expect(s.sleeper.sleeping).toBe(false);
    }
  });

  it('refuses what is not a bed, times out without an answer, and leaves the bed with stop_sleeping', async () => {
    const s = setup();
    expect(await s.sleeper.sleep({ x: 9, y: -60, z: 9 })).toEqual({ ok: false, reason: 'not_a_bed' });
    const p = s.sleeper.sleep({ x: 3, y: -60, z: 0 }, { timeoutTicks: 3 });
    await s.loop.tick(6);
    expect(await p).toMatchObject({ ok: false, reason: 'timeout' });
    flags(s.src, 2, { x: 3, y: -60, z: 0 });
    s.sleeper.wake();
    expect(s.src.sent.at(-1)).toEqual({ name: 'player_action', params: { runtime_entity_id: 5n, action: 'stop_sleeping', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 } });
    // other entities' flags are ignored
    s.src.emit('set_entity_data', { runtime_entity_id: 6n, metadata: [{ key: 'player_flags', value: 0 }] });
    expect(s.sleeper.sleeping).toBe(true);
    s.src.emit('start_game', {});
    expect(s.sleeper.sleeping).toBe(false);
  });
});
