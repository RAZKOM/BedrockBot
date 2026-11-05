/* eslint-disable @typescript-eslint/require-await -- the fakes answer like the async skills they stand for */
// Wave 11 Track AV: packing priority of the stash step (skills/container/stash.ts): junk that is no building
// block is dropped before a box is filled, the job's produce goes into the box first, filler last, and a box
// already holding junk is re-packed (the owner asked that other items come back out so the sand goes first).
import { describe, expect, it } from 'vitest';
import { RuntimeSettings } from '../../../src/config/settings.ts';
import { dropFirst, packClass, sameKinds, packOrder, repackJunk, repackLine, Stash, stepLine, type StashSkills } from '../../../src/skills/container/stash.ts';
import type { BlockInfo, ItemStack, Vec3 } from '../../../src/world/types.ts';

const item = (name: string, count = 64): ItemStack => ({ name, count, networkId: 1, metadata: 0 });
const AIR: BlockInfo = { name: 'air', stateId: 0, states: {}, hardness: 0, solid: false, boxes: [] };
const STONE: BlockInfo = { name: 'stone', stateId: 1, states: {}, hardness: 1.5, solid: true, boxes: [[0, 0, 0, 1, 1, 1]] };
const sand = (n: string) => n === 'sand';

describe('stash packing (Track AV)', () => {
  it('the box choice ranks a box by the waiting kinds it already holds (one kind per box, part stacks topped up)', () => {
    expect(sameKinds(['sand', 'cobblestone'], new Set(['sand']))).toBe(1);
    expect(sameKinds(['minecraft:sand'], new Set(['sand', 'gravel']))).toBe(1);
    expect(sameKinds(['raw_iron'], new Set(['sand']))).toBe(0);
    expect(sameKinds([], new Set(['sand']))).toBe(0);
  });

  it('classes: produce, value, filler; junk that is no block is dropped first, never boxed', () => {
    expect(packClass('sand', sand)).toBe(0);
    expect(packClass('raw_iron', sand)).toBe(1);
    expect(packClass('cobblestone', sand)).toBe(2);
    expect(packClass('rotten_flesh', sand)).toBeUndefined();
    expect(packClass('iron_pickaxe', sand)).toBeUndefined();
    expect(packClass('rotten_flesh', (n) => n === 'rotten_flesh')).toBe(0); // the job is getting it
    expect(dropFirst('string')).toBe(true);
    expect(dropFirst('cobblestone')).toBe(false);
    for (const n of ['bone', 'wheat_seeds', 'flint']) {
      expect(dropFirst(n), n).toBe(false);
      expect(repackJunk(n, sand), n).toBe(false);
      expect(packClass(n, sand), n).toBe(2);
    }
    // mob drops the bot has no use for: dropped first like rotten flesh (they ended up as a few in every box)
    for (const n of ['feather', 'arrow', 'egg']) {
      expect(dropFirst(n), n).toBe(true);
      expect(packClass(n, sand), n).toBeUndefined();
    }
    expect(packClass('arrow', (x) => x === 'arrow')).toBe(0); // unless the job is getting them
    expect(repackJunk('rotten_flesh', sand)).toBe(true);
    expect(repackJunk('gravel', sand)).toBe(true);
    expect(repackJunk('sand', sand)).toBe(false);
    expect(repackJunk('diamond', sand)).toBe(false);
    expect(packOrder([item('cobblestone'), item('string'), item('raw_iron'), item('sand'), null, item('bread')], sand)).toEqual([3, 2, 0]);
    expect(repackLine({ dropped: 1280, boxed: { sand: 1280 } })).toBe('re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand');
  });

  /** A bot whose box holds `box` (20 rotten flesh + 7 sand), the inventory full of sand. */
  function harness(box: (ItemStack | null)[], inv: (ItemStack | null)[]) {
    const slots = [...inv, ...Array.from({ length: 36 - inv.length }, () => null)];
    const boxSlots = [...box, ...Array.from({ length: 27 - box.length }, () => null)];
    const calls: string[] = [];
    const dropped: Record<string, number> = {};
    let placed = -1;
    const said: string[] = [];
    const settings = new RuntimeSettings();
    const skills: StashSkills = {
      goto: async () => ({ ok: true }),
      open: async (p) => ({ ok: true, view: { id: 9, slots: boxSlots }, open: { id: 9, type: 'container', pos: p, openedAt: 0 } }),
      deposit: async (_v, filter) => {
        calls.push('deposit');
        const moved: Record<string, number> = {};
        let total = 0;
        let requests = 0;
        for (let i = 0; i < 36; i++) {
          const s = slots[i];
          if (!s || !filter(s)) continue;
          const dst = boxSlots.findIndex((x) => !x);
          if (dst < 0) return { ok: false, reason: 'container_full', moved, total, requests, errors: 0 };
          boxSlots[dst] = s;
          slots[i] = null;
          requests++;
          moved[s.name] = (moved[s.name] ?? 0) + s.count;
          total += s.count;
        }
        return { ok: true, moved, total, requests, errors: 0 };
      },
      closeContainer: async () => true,
      place: async () => {
        placed = slots.findIndex((s) => s?.name === 'undyed_shulker_box');
        slots[placed] = null;
        return { ok: true };
      },
      dig: async () => ({ ok: true }),
      collect: async () => {
        slots[slots.findIndex((s) => !s)] = item('undyed_shulker_box', 1);
        return { ok: true, gained: {}, pickedUp: 1, skipped: 0, ticks: 1, corrections: 0 };
      },
      cancel: () => undefined,
    };
    const raws: unknown[] = [];
    const stash = new Stash({
      skills,
      inventory: { slots, freeSlots: () => slots.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0), rawItem: (_w, i) => raws[i] },
      blockAt: (p: Vec3) => (p.y < 0 ? STONE : AIR),
      position: () => ({ x: 0.5, y: 0, z: 0.5 }),
      settings,
      containers: {
        stats: { requests: 0 },
        move: async (src, dst) => {
          calls.push(`take ${src.slot} -> ${dst.slot}`);
          slots[dst.slot] = boxSlots[src.slot]!;
          boxSlots[src.slot] = null;
          return { ok: true };
        },
      },
      drop: async (name, n) => {
        let left = n ?? Infinity;
        let d = 0;
        for (let i = 0; i < 36 && left > 0; i++) {
          if (slots[i]?.name !== name) continue;
          const c = Math.min(left, slots[i]!.count);
          d += c;
          left -= c;
          slots[i] = slots[i]!.count - c > 0 ? { ...slots[i]!, count: slots[i]!.count - c } : null;
        }
        dropped[name] = (dropped[name] ?? 0) + d;
        return { ok: d > 0, dropped: d };
      },
      say: (m) => said.push(m),
    });
    return { stash, slots, boxSlots, calls, dropped, said, raws };
  }

  it("the owner's case: a box holding 20 stacks of junk and 7 of sand, the inventory full of sand: re-packed, the box holds 27 stacks of sand, the junk is dropped", async () => {
    const box = [...Array.from({ length: 20 }, () => item('rotten_flesh')), ...Array.from({ length: 7 }, () => item('sand'))];
    const h = harness(box, [item('iron_shovel', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 33 }, () => item('sand'))]); // one slot free
    // the box's NBT says it holds junk (full: chosen only because it can be re-packed)
    h.raws[1] = { extra: { nbt: { nbt: { value: { Items: { value: { value: box.map((b) => ({ Name: { value: `minecraft:${b.name}` }, Count: { value: b.count } })) } } } } } } };
    expect(await h.stash.ifFull({ label: 'get', wanted: sand })).toBe(true);
    expect(h.boxSlots.every((s) => s?.name === 'sand')).toBe(true);
    expect(h.dropped).toEqual({ rotten_flesh: 1280 });
    expect(h.slots.some((s) => s?.name === 'rotten_flesh')).toBe(false);
    const step = h.stash.attempts[0]!.steps.find((s) => s.kind === 'shulker')!;
    expect(step.repacked).toEqual({ dropped: 1280, boxed: { sand: 1280 } });
    expect(stepLine(step)).toContain('re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand');
    expect(h.said).toContain('re-packed 1 box: dropped 1280 junk, boxed 20 stacks of sand');
    expect(h.calls.filter((c) => c.startsWith('take'))).toHaveLength(20);
    // no slot free at all: no re-pack (the keeper's own drops would race it); the box stays as it was
    const z = harness([...box], [item('iron_shovel', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 34 }, () => item('sand'))]);
    z.raws[1] = h.raws[1];
    await z.stash.ifFull({ label: 'get', wanted: sand });
    expect(z.calls.filter((c) => c.startsWith('take'))).toHaveLength(0);
    expect(z.boxSlots.filter((x) => x?.name === 'rotten_flesh')).toHaveLength(20);
  });

  it('with an empty box and one already holding sand, the sand goes into the sand box (was: the emptiest box, so every box got some of everything)', () => {
    const nbt = (items: { name: string; count: number }[]) => ({ extra: { nbt: { nbt: { value: { Items: { value: { value: items.map((b) => ({ Name: { value: `minecraft:${b.name}` }, Count: { value: b.count } })) } } } } } } });
    const h = harness([], [item('iron_shovel', 1), item('undyed_shulker_box', 1), item('undyed_shulker_box', 1), item('raw_iron', 3), ...Array.from({ length: 32 }, () => item('sand'))]);
    h.raws[1] = nbt([]);
    h.raws[2] = nbt([{ name: 'sand', count: 64 }, { name: 'sand', count: 20 }, { name: 'gravel', count: 64 }]);
    const choice = (h.stash as unknown as { boxChoice(job: { wanted?: (n: string) => boolean }): { best?: { i: number } } }).boxChoice({ wanted: sand });
    expect(choice.best?.i).toBe(2);
    // nothing of the job's waiting: the box that holds the raw iron's kind wins over the empty one too
    h.raws[2] = nbt([{ name: 'raw_iron', count: 10 }]);
    expect((h.stash as unknown as { boxChoice(job: object): { best?: { i: number } } }).boxChoice({}).best?.i).toBe(2);
  });

  it('drops junk that is no block before boxing, boxes the produce before filler, never junk while produce waits', async () => {
    const inv = [item('iron_shovel', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 4 }, () => item('string')), ...Array.from({ length: 15 }, () => item('cobblestone')), ...Array.from({ length: 15 }, () => item('sand'))];
    const h = harness([], inv);
    // 4 stacks of string first: dropped, which frees 4 slots: no box needed
    expect(await h.stash.ifFull({ label: 'get', wanted: sand })).toBe(true);
    expect(h.dropped).toEqual({ string: 256 });
    expect(h.boxSlots.every((s) => !s)).toBe(true);
    // a full inventory without junk: sand (produce) first, then cobblestone (filler) into the rest of the box
    const h2 = harness([], [item('iron_shovel', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 20 }, () => item('cobblestone')), ...Array.from({ length: 14 }, () => item('sand'))]);
    expect(await h2.stash.ifFull({ label: 'get', wanted: sand })).toBe(true);
    expect(h2.boxSlots.slice(0, 14).every((s) => s?.name === 'sand')).toBe(true);
    expect(h2.boxSlots.slice(14).every((s) => s?.name === 'cobblestone')).toBe(true);
    // more sand than the box takes: no filler goes in
    const h3 = harness([], [item('iron_shovel', 1), item('undyed_shulker_box', 1), ...Array.from({ length: 4 }, () => item('cobblestone')), ...Array.from({ length: 30 }, () => item('sand'))]);
    expect(await h3.stash.ifFull({ label: 'get', wanted: sand })).toBe(true);
    expect(h3.boxSlots.every((s) => s?.name === 'sand')).toBe(true);
  });
});
