// Track T2: `!test mobs <set> ... bare` (skills/test/bare.ts, skills/test/mobs.ts) on fakes: the word in any position, the
// blades out of the hotbar before the first run and back however the series ends (finished, stopped, a death, an error in a
// run), the refusal with no free slot, the hold that keeps the weapon pull from bringing a blade back, a blade the kit's
// restore gave into the hotbar moved out again, and a series without the word touching no slot.
import { describe, expect, it } from 'vitest';
import { bladeScore } from '../../../src/skills/combat/combat.ts';
import { HotbarPuller } from '../../../src/skills/container/hotbar-moves.ts';
import { BareHold, hotbarBlades, isBlade, planStow, stowedText, swapCandidates, type BarePorts } from '../../../src/skills/test/bare.ts';
import { MobSeries, mobRunLine, mobSummaryLine, parseMobsArgs, type MobRecord, type MobSeriesPorts, type MobSummary, type MobsSpec } from '../../../src/skills/test/mobs.ts';
import type { EntityInfo, ItemStack } from '../../../src/world/types.ts';
import { mob } from './pve-fakes.ts';

const item = (name: string, count = 1): ItemStack => ({ name, networkId: 1, count, metadata: 0, ...(name.endsWith('_sword') ? { enchants: [{ id: 9, lvl: 5 }] } : {}) });

/** A player inventory of 36 slots: the netherite sword in 0, rockets in 1, an axe in 3, the elytra in 9, the rest as given. */
function inventory(extra: Record<number, ItemStack> = {}, full = false): (ItemStack | null)[] {
  const s: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  s[0] = item('netherite_sword');
  s[1] = item('firework_rocket', 64);
  s[3] = item('diamond_axe');
  s[9] = item('elytra');
  if (full) for (let i = 10; i < 36; i++) s[i] = item('cobblestone', 64);
  for (const [k, v] of Object.entries(extra)) s[Number(k)] = v;
  return s;
}

/** The survival kit's moves on a fake inventory; `swap` adds its exchange (SurvivalKit.swapSlots), refused into an empty slot. */
function bareFake(slots: (ItemStack | null)[], swap = false) {
  const moves: string[] = [];
  const holds: boolean[] = [];
  let held = false;
  const ports: BarePorts = {
    slots: () => slots,
    move: (from, to) => {
      moves.push(`${from}->${to}`);
      if (!slots[from] || slots[to]) return Promise.resolve({ ok: false, reason: 'bad move' });
      slots[to] = slots[from]!;
      slots[from] = null;
      return Promise.resolve({ ok: true });
    },
    ...(swap
      ? {
          swap: (a: number, c: number) => {
            moves.push(`${a}<->${c}`);
            if (!slots[a] || !slots[c]) return Promise.resolve({ ok: false, reason: 'an empty slot' });
            const t = slots[a];
            slots[a] = slots[c]!;
            slots[c] = t;
            return Promise.resolve({ ok: true });
          },
        }
      : {}),
    hold: (on) => {
      held = on;
      holds.push(on);
    },
  };
  return { ports, moves, holds, held: () => held };
}

function seriesPorts(slots: (ItemStack | null)[], o: { die?: boolean; throwAt?: number; give?: { at: number; slot: number; item: ItemStack }; stopAt?: () => void; flying?: [number, number]; swap?: boolean } = {}) {
  const b = bareFake(slots, o.swap);
  const ents = new Map<bigint, EntityInfo>();
  const dead = new Set<bigint>();
  const sent: string[] = [];
  const lines: string[] = [];
  const recs: object[] = [];
  const order: string[] = [];
  let clock = 0;
  let deaths = 0;
  let rid = 100n;
  let restores = 0;
  /** What the guard would see at every poll: a blade in the hotbar, the hold. */
  const seen: { blade: boolean; held: boolean }[] = [];
  const ports: MobSeriesPorts = {
    run: (cmd) => {
      sent.push(cmd);
      const m = /^\/summon (\S+) /.exec(cmd);
      if (m) ents.set(rid, mob(rid++, `minecraft:${m[1]}`, { x: 3.5, y: -60, z: 0.5 }));
      if (cmd.startsWith('/kill @e[name=')) for (const k of [...ents.keys()]) if (k >= 100n) ents.delete(k);
      return Promise.resolve({ ok: true });
    },
    restore: () => {
      restores++;
      // the kit's /give lands in the first free slot: a hotbar one
      if (restores === o.give?.at) slots[o.give.slot] = o.give.item;
      return Promise.resolve({ ok: true, steps: [], commands: 0 });
    },
    position: () => ({ x: 0.5, y: -60, z: 0.5 }),
    home: () => undefined,
    health: () => 20,
    deaths: () => deaths,
    recovered: () => {
      order.push('recovered');
      return Promise.resolve();
    },
    entities: () => ents,
    dead: (r) => dead.has(r),
    counters: () => ({ reflex: 0, taken: {}, floors: {} }),
    onDamage: () => () => undefined,
    say: (m) => lines.push(m),
    write: (r) => recs.push(r),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      seen.push({ blade: hotbarBlades(slots).length > 0, held: b.held() });
      if (o.throwAt !== undefined && clock >= o.throwAt) throw new Error('a run broke');
      if (o.stopAt && clock === 2000) o.stopAt();
      if (clock >= 5000) for (const k of ents.keys()) if (k >= 100n) dead.add(k);
      if (o.die && clock >= 2000 && deaths === 0) deaths = 1;
      return Promise.resolve();
    },
    bare: {
      ...b.ports,
      move: (from, to) => {
        order.push(`move ${from}->${to} at ${clock}`);
        return b.ports.move(from, to);
      },
      ...(o.flying ? { idle: () => !(clock > o.flying![0] && clock < o.flying![1]) } : {}),
    },
  };
  return { moves: b.moves, holds: b.holds, held: b.held, ports, sent, lines, recs, seen, order };
}

const spec = (...words: string[]): MobsSpec => parseMobsArgs(words) as MobsSpec;
const hotbarNames = (s: readonly (ItemStack | null)[]): (string | null)[] => s.slice(0, 9).map((x) => x?.name ?? null);

describe('!test mobs ... bare: the word', () => {
  it('is a word in any position after the set, with n, seconds and force', () => {
    expect(parseMobsArgs(['zombie4', 'bare'])).toMatchObject({ set: 'zombie4', runs: 1, seconds: 60, bare: true });
    expect(parseMobsArgs(['skeleton4', 'bare', '3', '90s', 'force'])).toMatchObject({ set: 'skeleton4', runs: 3, seconds: 90, force: true, bare: true });
    expect(parseMobsArgs(['witch', '3', 'bare', '40s'])).toMatchObject({ runs: 3, seconds: 40, bare: true });
    expect(parseMobsArgs(['creeper', '2', '30s', 'force', 'BARE'])).toMatchObject({ runs: 2, seconds: 30, force: true, bare: true });
    expect(parseMobsArgs(['zombie4', '3', '90s', 'force'])).not.toHaveProperty('bare');
    expect(parseMobsArgs(['bare'])).toHaveProperty('error'); // the set comes first
    expect(parseMobsArgs(['zombie', 'barely'])).toHaveProperty('error');
    expect((parseMobsArgs([]) as { error: string }).error).toContain('[force] [bare]');
  });
});

describe('the stow plan (bare.ts)', () => {
  it('every sword and axe in the hotbar to a free main slot; a pickaxe or a trident is not a blade', () => {
    const s = inventory({ 5: item('iron_pickaxe'), 6: item('trident') });
    expect(hotbarBlades(s)).toEqual([0, 3]);
    expect(isBlade(item('iron_pickaxe'))).toBe(false);
    expect(planStow(s)).toEqual({ moves: [{ item: 'netherite_sword', from: 0, to: 10 }, { item: 'diamond_axe', from: 3, to: 11 }] });
    expect(stowedText([{ item: 'netherite_sword', from: 0, to: 10 }])).toBe('netherite_sword 0 -> 10');
  });

  it('too few free slots: refused, and says how many it needs', () => {
    const s = inventory({}, true);
    const r = planStow(s);
    expect(r).toEqual({ error: 'test mobs: bare needs 2 free inventory slots for netherite_sword in slot 0, diamond_axe in slot 3, 0 free; make room first' });
    s[20] = null;
    expect(planStow(s)).toHaveProperty('error'); // one free, two blades
  });
});

describe('MobSeries bare: the stow and the restore', () => {
  it('finished: no blade in the hotbar during every run, the hold on; each back in its slot after, enchantments and all', async () => {
    const slots = inventory();
    const sword = slots[0];
    const f = seriesPorts(slots);
    const s = new MobSeries(spec('zombie4', '2', 'bare'), f.ports, 'm1tb');
    const st = await s.stowBlades();
    expect(st).toEqual({ stowed: 'netherite_sword 0 -> 10, diamond_axe 3 -> 11' });
    expect(hotbarNames(slots)).toEqual([null, 'firework_rocket', null, null, null, null, null, null, null]);
    const sum = await s.run();
    expect(f.seen.length).toBeGreaterThan(10);
    expect(f.seen.every((x) => !x.blade && x.held)).toBe(true);
    expect(hotbarNames(slots)).toEqual(['netherite_sword', 'firework_rocket', null, 'diamond_axe', null, null, null, null, null]);
    expect(slots[0]).toBe(sword); // the same stack: nothing given, nothing lost
    expect(f.held()).toBe(false);
    expect(f.holds).toEqual([true, false]);
    expect(sum).toMatchObject({ bare: true, stowed: ['netherite_sword 0 -> 10', 'diamond_axe 3 -> 11'], restored: ['netherite_sword back in slot 0', 'diamond_axe back in slot 3'] });
    const rec = f.recs[0] as MobRecord;
    expect(rec).toMatchObject({ bare: true, stowed: ['netherite_sword 0 -> 10', 'diamond_axe 3 -> 11'] });
    expect(rec).not.toHaveProperty('bladeInHotbar');
    expect(mobRunLine(rec)).toMatch(/, floors none, bare$/);
    expect(mobSummaryLine(f.recs.at(-1) as MobSummary)).toMatch(/, bare: netherite_sword 0 -> 10, diamond_axe 3 -> 11; netherite_sword back in slot 0, diamond_axe back in slot 3$/);
    expect(s.status()).toMatch(/^test mobs zombie4 bare: /);
  });

  it('stopped by !test stop in a run: back at the end', async () => {
    const slots = inventory();
    const ref: { s?: MobSeries } = {};
    const f = seriesPorts(slots, { stopAt: () => ref.s!.stop() });
    const s = new MobSeries(spec('zombie4', '3', 'bare'), f.ports, 'm1tc');
    ref.s = s;
    await s.stowBlades();
    const sum = await s.run();
    expect(sum.stopped).toBe(true);
    expect(sum.runs).toBe(1);
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
    expect(hotbarNames(slots)[3]).toBe('diamond_axe');
    expect(f.held()).toBe(false);
  });

  it('a death (keepInventory: the slots kept): put back after the recovery', async () => {
    const slots = inventory();
    const f = seriesPorts(slots, { die: true });
    const s = new MobSeries(spec('skeleton', 'bare'), f.ports, 'm1td');
    await s.stowBlades();
    const sum = await s.run();
    expect(sum.deaths).toBe(1);
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
    // the restore's moves come after the last recovery
    const last = f.order.lastIndexOf('recovered');
    expect(f.order.slice(last + 1).map((m) => m.replace(/ at \d+$/, ''))).toEqual(['move 10->0', 'move 11->3']);
  });

  it('an elytra flee still in the air at the end: the blades go back once it is down', async () => {
    const slots = inventory();
    const f = seriesPorts(slots, { flying: [3000, 30_000] });
    const s = new MobSeries(spec('zombie', 'bare'), f.ports, 'm1tj');
    await s.stowBlades();
    await s.run();
    const back = f.order.filter((m) => m.startsWith('move 10->0'));
    expect(back).toHaveLength(1);
    expect(Number(/at (\d+)$/.exec(back[0]!)![1])).toBeGreaterThanOrEqual(30_000);
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
  });

  it('a death that moved the blade: found by its name anywhere in the main inventory', async () => {
    const slots = inventory();
    const h = new BareHold(bareFake(slots).ports);
    await h.stow();
    slots[25] = slots[10]!;
    slots[10] = null;
    expect((await h.restore()).notes).toEqual(['netherite_sword back in slot 0', 'diamond_axe back in slot 3']);
    expect(slots[25]).toBeNull();
  });

  it('an error thrown in a run: back, said on its own line, the error goes on', async () => {
    const slots = inventory();
    const f = seriesPorts(slots, { throwAt: 1500 });
    const s = new MobSeries(spec('zombie', 'bare'), f.ports, 'm1te');
    await s.stowBlades();
    await expect(s.run()).rejects.toThrow('a run broke');
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
    expect(hotbarNames(slots)[3]).toBe('diamond_axe');
    expect(f.held()).toBe(false);
    expect(f.lines.at(-1)).toBe('test mobs zombie: bare: netherite_sword back in slot 0, diamond_axe back in slot 3');
    expect(f.sent.at(-1)).toBe('/kill @e[name=m1te]');
  });

  it('no free slot: refused before anything moves, no hold', async () => {
    const slots = inventory({}, true);
    const f = seriesPorts(slots);
    const s = new MobSeries(spec('zombie', 'bare'), f.ports, 'm1tf');
    const r = await s.stowBlades();
    expect(r.refusal).toMatch(/^test mobs: bare needs 2 free inventory slots/);
    expect(f.moves).toEqual([]);
    expect(f.holds).toEqual([]);
  });

  it('a refused move: what moved goes back, the hold ends, the series is refused', async () => {
    const slots = inventory();
    const b = bareFake(slots);
    let n = 0;
    const h = new BareHold({ ...b.ports, move: (a, c) => (++n === 2 ? Promise.resolve({ ok: false, reason: 'error' }) : b.ports.move(a, c)) });
    const r = await h.stow();
    expect(r).toEqual({ ok: false, reason: 'test mobs: bare: moving the diamond_axe out of hotbar slot 3 failed (error)' });
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
    expect(b.held()).toBe(false);
  });

  it('a blade the kit restore gave into the hotbar goes out again before the run, and back to that slot at the end', async () => {
    const slots = inventory();
    const f = seriesPorts(slots, { give: { at: 2, slot: 2, item: item('iron_sword') } });
    const s = new MobSeries(spec('zombie', '2', 'bare'), f.ports, 'm1tg');
    await s.stowBlades();
    const sum = await s.run();
    expect(f.seen.every((x) => !x.blade)).toBe(true);
    expect((f.recs[1] as MobRecord).stowed).toEqual(['netherite_sword 0 -> 10', 'diamond_axe 3 -> 11', 'iron_sword 2 -> 12']);
    expect(hotbarNames(slots).slice(0, 4)).toEqual(['netherite_sword', 'firework_rocket', 'iron_sword', 'diamond_axe']);
    expect(sum.stowed).toHaveLength(3);
  });

  it('its slot taken meanwhile (rockets moved there): the other item parked first, the blade back in its slot', async () => {
    const slots = inventory();
    const h = new BareHold(bareFake(slots).ports);
    await h.stow();
    slots[0] = item('firework_rocket', 32);
    const r = await h.restore();
    expect(r).toEqual({ ok: true, notes: ['netherite_sword back in slot 0', 'diamond_axe back in slot 3'] });
    expect(slots[0]?.name).toBe('netherite_sword');
    expect(slots.slice(9).some((x) => x?.name === 'firework_rocket' && x.count === 32)).toBe(true);
  });

  it('its slot taken and no free slot to park it in: into another empty hotbar slot, said', async () => {
    const slots = inventory();
    const h = new BareHold(bareFake(slots).ports);
    await h.stow();
    slots[0] = item('stone', 64);
    for (let i = 12; i < 36; i++) slots[i] = item('cobblestone', 64);
    const r = await h.restore();
    expect(r.notes[0]).toBe('netherite_sword in slot 2 (slot 0 holds stone)');
    expect(slots[2]?.name).toBe('netherite_sword');
  });

  it('a series without the word touches no slot and never holds', async () => {
    const slots = inventory();
    const before = [...slots];
    const f = seriesPorts(slots);
    const s = new MobSeries(spec('zombie4', '2'), f.ports, 'm1th');
    expect(s.bare).toBeUndefined();
    expect(await s.stowBlades()).toEqual({ stowed: '' });
    const sum = await s.run();
    expect(f.moves).toEqual([]);
    expect(f.holds).toEqual([]);
    expect(slots).toEqual(before);
    expect(sum).not.toHaveProperty('bare');
    expect(f.recs[0]).not.toHaveProperty('bare');
    expect(mobRunLine(f.recs[0] as MobRecord)).not.toContain('bare');
  });

  it('bare with no inventory moves (no survival kit): refused', async () => {
    const f = seriesPorts(inventory());
    const { bare: _none, ...ports } = f.ports;
    const s = new MobSeries(spec('zombie', 'bare'), ports, 'm1ti');
    expect((await s.stowBlades()).refusal).toBe('test mobs: bare: no inventory moves here');
  });
});

describe('a full inventory: the exchange (SurvivalKit.swapSlots)', () => {
  /** The kit inventory with every main slot full: cobblestone, bread, a pickaxe, an iron sword (a blade) and arrows. */
  const full = (): (ItemStack | null)[] => {
    const s = inventory({}, true);
    s[10] = item('iron_pickaxe');
    s[11] = item('bread', 16);
    s[12] = item('iron_sword');
    return s;
  };

  it('the restore exchanges the blade with the stack of 64 a pickup put in its slot: nothing needs a free slot', async () => {
    const slots = inventory();
    const b = bareFake(slots, true);
    const h = new BareHold(b.ports);
    await h.stow(); // sword 0 -> 10, axe 3 -> 11
    const sword = slots[10];
    // the series' drops fill every free slot, a stack of 64 gunpowder into hotbar slot 0
    slots[0] = item('gunpowder', 64);
    for (let i = 12; i < 36; i++) slots[i] ??= item('bone', 64);
    slots[3] = item('arrow', 64);
    const r = await h.restore();
    expect(r).toEqual({ ok: true, notes: ['netherite_sword back in slot 0 (exchanged with gunpowder, now in slot 10)', 'diamond_axe back in slot 3 (exchanged with arrow, now in slot 11)'] });
    expect(slots[0]).toBe(sword); // the same stack (enchantments and all)
    expect(slots[10]).toMatchObject({ name: 'gunpowder', count: 64 }); // nothing dropped
    expect(slots[11]).toMatchObject({ name: 'arrow', count: 64 });
    expect(b.moves.slice(-2)).toEqual(['10<->0', '11<->3']);
    expect(b.held()).toBe(false);
  });

  it('the blade moved by a pull meanwhile (into another hotbar slot): exchanged back into its own', async () => {
    const slots = inventory();
    const b = bareFake(slots, true);
    const h = new BareHold(b.ports);
    await h.stow();
    // a weapon pull (the hold off by hand) took the sword into slot 5; slot 0 now holds gunpowder
    slots[5] = slots[10]!;
    slots[10] = null;
    slots[0] = item('gunpowder', 64);
    const r = await h.restore();
    expect(r.notes[0]).toBe('netherite_sword back in slot 0 (exchanged with gunpowder, now in slot 5)');
    expect(slots[0]?.name).toBe('netherite_sword');
    expect(slots[5]?.name).toBe('gunpowder');
    // and one already back in its own slot is left alone
    const s2 = inventory();
    const h2 = new BareHold(bareFake(s2, true).ports);
    await h2.stow();
    s2[0] = s2[10]!;
    s2[10] = null;
    expect((await h2.restore()).notes[0]).toBe('netherite_sword back in slot 0');
  });

  it('the stow with a full inventory exchanges with a stack the fight would not use (never a tool, never a blade)', async () => {
    const slots = full();
    expect(swapCandidates(slots)).not.toContain(10); // the pickaxe: a weapon the fight would select
    expect(swapCandidates(slots)).not.toContain(12); // a blade
    expect(swapCandidates(slots).slice(0, 2)).toEqual([13, 14]); // blocks first, then food
    expect(swapCandidates(slots)).toContain(11);
    const b = bareFake(slots, true);
    const h = new BareHold(b.ports);
    const r = await h.stow();
    expect(r).toEqual({ ok: true, stowed: [{ item: 'netherite_sword', from: 0, to: 13, swapped: 'cobblestone' }, { item: 'diamond_axe', from: 3, to: 14, swapped: 'cobblestone' }] });
    expect(hotbarBlades(slots)).toEqual([]);
    expect(stowedText(r.ok ? r.stowed : [])).toBe('netherite_sword 0 <-> 13 (cobblestone), diamond_axe 3 <-> 14 (cobblestone)');
    await h.restore();
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
    expect(hotbarNames(slots)[3]).toBe('diamond_axe');
    expect(slots[13]?.name).toBe('cobblestone');
  });

  it('the stow is still refused when every main stack is a weapon (or there is no exchange)', () => {
    const s = inventory({}, true);
    for (let i = 10; i < 36; i++) s[i] = item(i % 2 ? 'iron_pickaxe' : 'stone_sword');
    s[9] = item('trident');
    expect(planStow(s, true)).toEqual({ error: 'test mobs: bare needs 2 inventory slots free or holding something that is no weapon for netherite_sword in slot 0, diamond_axe in slot 3, 0 there; make room first' });
    expect(planStow(full(), false)).toHaveProperty('error');
  });

  it('a bare series on a full inventory: stowed by the exchange, back in its slot at the end', async () => {
    const slots = full();
    const f = seriesPorts(slots, { swap: true });
    const s = new MobSeries(spec('zombie', 'bare'), f.ports, 'm1tl');
    expect(await s.stowBlades()).toEqual({ stowed: 'netherite_sword 0 <-> 13 (cobblestone), diamond_axe 3 <-> 14 (cobblestone)' });
    const sum = await s.run();
    expect(f.seen.every((x) => !x.blade)).toBe(true);
    expect(sum.restored).toEqual(['netherite_sword back in slot 0 (exchanged with cobblestone, now in slot 13)', 'diamond_axe back in slot 3 (exchanged with cobblestone, now in slot 14)']);
    expect(hotbarNames(slots)[0]).toBe('netherite_sword');
  });
});

describe('the hold: nothing brings a blade back (HotbarPuller, the fight weapon pull and the Digger)', () => {
  it('a held blade in the main inventory is never pulled; after the hold it is again', () => {
    const slots = inventory();
    slots[10] = slots[0]!;
    slots[0] = null;
    slots[11] = slots[3]!;
    slots[3] = null;
    const puller = new HotbarPuller({
      containers: () => undefined,
      hotbar: () => undefined,
      inventory: () => ({ slots, selected: 0 }),
      toolOk: () => () => true,
      queue: () => undefined,
      runtimeId: () => 1n,
      waitTicks: () => Promise.resolve(),
    });
    expect(puller.wants('weapon', bladeScore)).toBe(true);
    puller.hold = isBlade;
    expect(puller.wants('weapon', bladeScore)).toBe(false);
    expect(puller.pull('weapon', bladeScore, { select: true })).toBeUndefined(); // CombatController.weaponPull
    expect(puller.digHook('oak_log')).toBeUndefined(); // the Digger's axe pull
    puller.hold = undefined;
    expect(puller.wants('weapon', bladeScore)).toBe(true);
  });
});
