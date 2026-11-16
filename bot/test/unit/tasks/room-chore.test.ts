// Track V1 (ADR 0090, docs/inventory.md): the room chore (tasks/process/room.ts RoomChore) against fakes. When it runs (idle,
// nothing else in control for 3 s, not at home with an unload due, below the floor), what it does (one step at a time,
// planned again after each, every action one `inventory: ...` log line, a chat line only for loot boxed or stone dropped
// and at most every 10 minutes), how it yields (a user process pre-empts it at once and the skill is cancelled) and how it
// backs off (a failed step kind for 5 minutes, a pass that freed nothing for 2 minutes, the ask line once an hour).
import { describe, expect, it } from 'vitest';
import type { RoomSlot } from '../../../src/skills/inventory/room.ts';
import { PRIORITY, ProcessManager, BaseProcess, type ProcessKind } from '../../../src/tasks/process/manager.ts';
import { ROOM_ASK_MS, ROOM_RETRY_MS, ROOM_SAY_MS, ROOM_SETTLE_MS, ROOM_STEP_BACKOFF_MS, RoomChore, type RoomChoreDeps } from '../../../src/tasks/process/room.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A fake inventory: `slots` mutated by the fake merge, drop and box. */
function world(list: [string, number, Partial<RoomSlot>?][]) {
  const slots: RoomSlot[] = list.map(([name, count, extra], slot) => ({ slot, name, count, key: `${name}|0|-`, ...(extra ?? {}) }));
  const state = { idle: true, busy: false, homeFirst: false, mergeOk: true, dropOk: true, boxReason: undefined as string | undefined, hold: undefined as Promise<void> | undefined, t: 0 };
  const log: string[] = [];
  const said: string[] = [];
  const calls: string[] = [];
  const at = (i: number) => slots.find((s) => s.slot === i);
  const deps: RoomChoreDeps = {
    slots: () => slots.map((s) => ({ ...s })),
    options: () => ({ stoneKeep: 64, ...(slots.some((s) => s.flightKit) ? { kitBox: slots.find((s) => s.flightKit)!.slot } : {}) }),
    idle: () => state.idle,
    busy: () => state.busy,
    homeFirst: () => state.homeFirst,
    merge: async (from, to, count) => {
      calls.push(`merge ${from}->${to} ${count}`);
      if (state.hold) await state.hold;
      if (!state.mergeOk) return { ok: false, reason: 'refused' };
      at(to)!.count += count;
      const f = at(from)!;
      f.count -= count;
      if (f.count <= 0) slots.splice(slots.indexOf(f), 1);
      return { ok: true };
    },
    drop: async (name, count) => {
      await Promise.resolve();
      calls.push(`drop ${count} ${name}`);
      if (!state.dropOk) return { ok: false, dropped: 0, reason: 'refused' };
      let left = count;
      for (const s of [...slots].filter((x) => x.name === name).sort((a, b) => Number(a.slot < 9) - Number(b.slot < 9) || a.count - b.count)) {
        const c = Math.min(left, s.count);
        s.count -= c;
        left -= c;
        if (s.count <= 0) slots.splice(slots.indexOf(s), 1);
      }
      return { ok: true, dropped: count - left };
    },
    putIn: async (box, moves) => {
      await Promise.resolve();
      const m = moves();
      calls.push(`box ${box}: ${m.map((x) => `${x.count} ${x.name} from ${x.slot}`).join(', ')}`);
      if (state.boxReason) return { moved: 0, reason: state.boxReason };
      const b = at(box)!;
      const items: Record<string, number> = { ...(b.boxItems ?? {}) };
      let moved = 0;
      for (const x of m) {
        const s = at(x.slot)!;
        s.count -= x.count;
        moved += x.count;
        items[s.name] = (items[s.name] ?? 0) + x.count;
        if (s.count <= 0) slots.splice(slots.indexOf(s), 1);
      }
      b.boxItems = items;
      b.boxUsed = (b.boxUsed ?? 0) + m.length;
      return { moved };
    },
    cancel: () => calls.push('cancel'),
    say: (l) => said.push(l),
    ask: (p) => (p.steps.length === 0 && p.after < 4 ? `inventory: ${p.after} slots free and nothing I may drop or box` : undefined),
    now: () => state.t,
    log: { info: (m) => log.push(m), warn: (m) => log.push(`WARN ${m}`) },
  };
  return { slots, state, log, said, calls, deps, advance: (ms: number) => (state.t += ms) };
}

/** Slots no plan touches: boxes the bot cannot read (kept, never a box target, never merged). */
const dummies = (n: number): [string, number, Partial<RoomSlot>][] => Array.from({ length: n }, (): [string, number, Partial<RoomSlot>] => ['black_shulker_box', 1, { unknown: true }]);
const free = (slots: readonly RoomSlot[]) => 36 - slots.length;
const count = (slots: readonly RoomSlot[], name: string) => slots.reduce((a, s) => a + (s.name === name ? s.count : 0), 0);

class UserJob extends BaseProcess {
  readonly name = 'job';
  readonly kind: ProcessKind = 'user';
  get priority() {
    return PRIORITY.user;
  }
  protected run(): void {}
  protected halt(): void {}
  status() {
    return { line: 'job' };
  }
}

/** Drive the manager until the chore yields (or `n` rounds). */
async function drive(pm: ProcessManager, w: ReturnType<typeof world>, n = 40): Promise<void> {
  for (let i = 0; i < n; i++) {
    w.advance(500);
    pm.tick();
    await tick();
  }
}

describe('RoomChore', () => {
  it('waits for the quiet, then merges and drops the junk one step at a time: 0 -> 6 free, every item counted, one log line each', async () => {
    const w = world([['bone', 12], ['bone', 7], ['torch', 3], ['torch', 4], ['rotten_flesh', 9], ['rotten_flesh', 3], ['string', 2], ['diamond', 4], ...dummies(28)]);
    const before = { bone: count(w.slots, 'bone'), torch: count(w.slots, 'torch'), diamond: count(w.slots, 'diamond') };
    expect(free(w.slots)).toBe(0);
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    pm.tick();
    expect(w.calls).toEqual([]); // the 3 s of quiet first
    w.advance(ROOM_SETTLE_MS);
    await drive(pm, w);
    expect(w.calls).toEqual(['merge 1->0 7', 'merge 2->3 3', 'drop 12 rotten_flesh', 'drop 2 string']);
    expect(free(w.slots)).toBe(5); // merges free 2, the junk 3: the target (6) is not reached, nothing else to do
    expect({ bone: count(w.slots, 'bone'), torch: count(w.slots, 'torch'), diamond: count(w.slots, 'diamond') }).toEqual(before);
    expect(w.log.filter((l) => l.startsWith('inventory: ')).length).toBe(5); // four steps and the pass line
    expect(w.log.at(-1)).toMatch(/^inventory: 0 -> 5 slots free in \d+\.\d s: merged 7 bone \(slot 1 -> 0\); merged 3 torch \(slot 2 -> 3\); dropped 12 rotten_flesh \(junk\); dropped 2 string \(junk\)$/);
    expect(w.said).toEqual([]); // merges and junk: no chat line
    expect(c.stats).toMatchObject({ passes: 1, steps: 4, failed: 0 });
  });

  it('waits until the inventory has not changed for 3 s (a pile of drops, items given)', async () => {
    const w = world([['bone', 12], ['bone', 7], ...dummies(34)]);
    let changed = 0;
    const c = new RoomChore({ ...w.deps, changedAt: () => changed });
    const pm = new ProcessManager();
    pm.add(c);
    for (let i = 0; i < 20; i++) {
      changed = w.state.t; // a pickup every half second
      w.advance(500);
      pm.tick();
      await tick();
    }
    expect(w.calls).toEqual([]);
    await drive(pm, w, 12);
    expect(w.calls).toEqual(['merge 1->0 7']);
  });

  it('never with a user process, with something else busy, nor at home with an unload due; above the floor nothing', async () => {
    const w = world([['bone', 12], ['bone', 7], ...dummies(34)]);
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    w.state.idle = false;
    await drive(pm, w, 20);
    w.state.idle = true;
    w.state.busy = true;
    await drive(pm, w, 20);
    w.state.busy = false;
    w.state.homeFirst = true;
    await drive(pm, w, 20);
    expect(w.calls).toEqual([]);
    w.state.homeFirst = false;
    await drive(pm, w, 20);
    expect(w.calls).toEqual(['merge 1->0 7']);
    // 1 free -> the merge made 1: still under the floor, nothing else: the pass freed something, so no retry wait,
    // but the next plan has no step: nothing more is asked of the kit
    await drive(pm, w, 20);
    expect(w.calls).toEqual(['merge 1->0 7']);
    const v = world([['bone', 12], ...dummies(31)]);
    const pm2 = new ProcessManager();
    pm2.add(new RoomChore(v.deps));
    await drive(pm2, v, 20);
    expect(v.calls).toEqual([]); // 4 free: the floor
  });

  it('a user command pre-empts a pass at once: the skill is cancelled, the pass ends, the rest waits for the next quiet', async () => {
    let release!: () => void;
    const w = world([['bone', 12], ['bone', 7], ['torch', 3], ['torch', 4], ...dummies(32)]);
    w.state.hold = new Promise<void>((r) => (release = r));
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    w.advance(ROOM_SETTLE_MS);
    await drive(pm, w, 10);
    expect(w.calls).toEqual(['merge 1->0 7']);
    const job = new UserJob();
    pm.add(job);
    w.state.idle = false;
    pm.tick();
    expect(w.calls).toEqual(['merge 1->0 7', 'cancel']);
    release();
    w.state.hold = undefined;
    await c.settled();
    expect(w.log.at(-1)).toContain('(interrupted)');
    await drive(pm, w, 10);
    expect(w.calls).toEqual(['merge 1->0 7', 'cancel']); // the job still runs
    pm.stop(job);
    w.state.idle = true;
    await drive(pm, w, 20);
    expect(w.calls).toEqual(['merge 1->0 7', 'cancel', 'merge 2->3 3']);
  });

  it('loot into a carried box: one chat line, at most every 10 minutes; the box it filled takes the next loot', async () => {
    const w = world([['diamond', 5], ['white_shulker_box', 1, { boxUsed: 0 }], ['white_shulker_box', 1, { boxUsed: 0 }], ['raw_gold', 9], ...dummies(32)]);
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    w.advance(ROOM_SETTLE_MS);
    await drive(pm, w);
    expect(w.calls).toEqual(['box 1: 9 raw_gold from 3, 5 diamond from 0']);
    expect(w.said).toEqual(['inventory: 0 -> 2 slots free: boxed 9 raw_gold, 5 diamond into the shulker box in slot 1']);
    expect(count(w.slots, 'diamond')).toBe(0);
    expect(w.slots.find((s) => s.slot === 1)?.boxItems).toEqual({ diamond: 5, raw_gold: 9 });
    // more loot a minute later: into the same box (this chore's), and no second chat line within 10 minutes
    w.slots.push({ slot: 0, name: 'emerald', count: 3, key: 'emerald|0|-' }, { slot: 3, name: 'raw_iron', count: 7, key: 'raw_iron|0|-' });
    expect(free(w.slots)).toBe(0);
    w.advance(60_000);
    await drive(pm, w);
    expect(w.calls.at(-1)).toBe('box 1: 7 raw_iron from 3, 3 emerald from 0');
    expect(w.slots.find((s) => s.slot === 1)?.boxItems).toEqual({ diamond: 5, raw_gold: 9, raw_iron: 7, emerald: 3 });
    expect(w.slots.find((s) => s.slot === 2)?.boxUsed).toBe(0); // the other empty box stays empty
    expect(w.said.length).toBe(1);
    expect(ROOM_SAY_MS).toBe(600_000);
  });

  it('a failed step kind waits 5 minutes; a pass that freed nothing waits 2; the ask line once an hour', async () => {
    const w = world([['white_shulker_box', 1, { boxUsed: 0 }], ['diamond', 5], ...dummies(34)]);
    w.state.boxReason = 'no cell for the box';
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    w.advance(ROOM_SETTLE_MS);
    await drive(pm, w, 20);
    expect(w.calls).toEqual(['box 0: 5 diamond from 1']);
    expect(w.log.some((l) => l.startsWith('WARN inventory: boxed nothing into the shulker box in slot 0 (no cell for the box)'))).toBe(true);
    // no step left (the box kind waits): the owner is asked, once
    expect(w.said).toEqual(['inventory: 0 slots free and nothing I may drop or box']);
    await drive(pm, w, 200);
    expect(w.said.length).toBe(1);
    expect(w.calls.length).toBe(1);
    w.state.boxReason = undefined;
    w.advance(Math.max(ROOM_STEP_BACKOFF_MS, ROOM_RETRY_MS));
    await drive(pm, w, 20);
    expect(w.calls).toEqual(['box 0: 5 diamond from 1', 'box 0: 5 diamond from 1']);
    expect(ROOM_ASK_MS).toBe(3_600_000);
  });

  it('stone beyond dropStone: dropped and said in chat; the rockets beyond two stacks go into the fireworks box first', async () => {
    const w = world([
      ['firework_rocket', 64],
      ['firework_rocket', 64],
      ['firework_rocket', 64],
      ['firework_rocket', 20],
      ['red_shulker_box', 1, { boxUsed: 1, boxItems: { firework_rocket: 64 }, flightKit: true }],
      ['cobblestone', 64],
      ['cobblestone', 64],
      ['cobblestone', 64],
      ['cobblestone', 64],
      ...dummies(27),
    ]);
    const c = new RoomChore(w.deps);
    const pm = new ProcessManager();
    pm.add(c);
    w.advance(ROOM_SETTLE_MS);
    await drive(pm, w);
    expect(w.calls).toEqual(['box 4: 20 firework_rocket from 3, 64 firework_rocket from 2', 'drop 192 cobblestone']);
    expect(count(w.slots, 'firework_rocket')).toBe(128);
    expect(w.slots.find((s) => s.slot === 4)?.boxItems).toEqual({ firework_rocket: 148 });
    expect(count(w.slots, 'cobblestone')).toBe(64);
    expect(w.said).toEqual(['inventory: 0 -> 5 slots free: dropped 192 cobblestone (dropStone 64)']);
  });
});
