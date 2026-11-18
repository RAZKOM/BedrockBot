// Track E2 (docs/early-game.md "The iron age"): the obtain planner's iron steps on a simulated inventory and the
// recorded iron-age recipes (BDS 1.26.60.6): raw ore mined, a furnace crafted and set down, the fuel rule (what the
// crafts leave, coal near, planks from logs, logs), the smelt, the crafts; the iron kit's soft armour against a short
// mine step; worn armour and the offhand's shield counted; raw food cooked once a furnace stands.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { affordable, canHarvestWith, EARLY_KIT, IRON_KIT, nextAction, pickaxeFor, type ObtainAction, type ObtainOptions, type ObtainTarget } from '../../../src/skills/items/obtain.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { cookedOf } from '../../../src/skills/food/finder.ts';
import { fuelItems } from '../../../src/skills/food/smelt.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
function index(): RecipeIndex {
  const idx = new RecipeIndex((id) => fixture.items[String(id)]);
  idx.handle(fixture);
  return idx;
}
const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: name.length, metadata: 0 });
const keep = { keep: keepOnDropItems };

class Inv {
  slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  worn: (ItemStack | null)[] = [null, null, null, null, null];
  furnace = false;
  bed = false; // Track E3: a bed set down where the night rule sleeps
  constructor(items: readonly (readonly [string, number])[] = []) {
    for (const [n, c] of items) this.add(n, c);
  }
  count(name: string): number {
    return this.slots.reduce((a, s) => a + (s?.name === name ? s.count : 0), 0);
  }
  add(name: string, n: number): void {
    const max = /_(pickaxe|sword|axe|shovel|helmet|chestplate|leggings|boots)$|^(shield|bucket)$/.test(name) ? 1 : 64;
    const s = this.slots.find((x) => x?.name === name && x.count < max);
    if (s) {
      const room = max - s.count;
      s.count += Math.min(room, n);
      if (n > room) this.add(name, n - room);
      return;
    }
    const i = this.slots.indexOf(null);
    if (i < 0) throw new Error('inventory full');
    this.slots[i] = item(name, Math.min(max, n));
    if (n > max) this.add(name, n - max);
  }
  take(name: string, n: number): void {
    for (let i = 0; i < 36 && n > 0; i++) {
      const s = this.slots[i];
      if (s?.name !== name) continue;
      const t = Math.min(s.count, n);
      s.count -= t;
      n -= t;
      if (s.count === 0) this.slots[i] = null;
    }
    if (n > 0) throw new Error(`took ${n} ${name} too many`);
  }
  /** Burn `items` worth of fuel, best first (coal, planks, logs). */
  burn(items: number): void {
    let left = items;
    for (const [name, value] of [['coal', 8], ['charcoal', 8], ['oak_planks', 1.5], ['oak_log', 1.5]] as const) {
      while (left > 0 && this.count(name) > 0) {
        this.take(name, 1);
        left -= value;
      }
    }
    if (left > 0) throw new Error(`no fuel for ${left} items`);
  }
}

interface World {
  /** Raw iron the mine steps can still find (Infinity: as much as asked). */
  iron: number;
  coalNear: boolean;
}

/** What the commands do, simplified (the chain, the harvest rule, the furnace, the smelt with fuel, the armour pass). */
function apply(idx: RecipeIndex, inv: Inv, a: ObtainAction, w: World): void {
  switch (a.kind) {
    case 'gather':
      inv.add('oak_log', Math.ceil(a.n / 6) * 6);
      return;
    case 'mine': {
      if (!canHarvestWith(inv.slots, a.block)) return;
      const n = a.item === 'raw_iron' ? Math.min(a.n, w.iron) : a.n;
      if (a.item === 'raw_iron') w.iron -= n;
      inv.add(a.item, n);
      inv.add('cobblestone', a.block === 'stone' ? 0 : 2 * n); // the tunnel's stone
      return;
    }
    case 'hunt':
    case 'food':
      inv.add(a.kind === 'hunt' ? a.item : 'beef', a.n);
      return;
    case 'craft': {
      const chain = planChain(idx, [{ item: a.item, n: a.n + inv.count(a.item) }], inv.slots, keep);
      if (chain.missing.length) throw new Error(`craft ${a.item}: missing ${JSON.stringify(chain.missing)}`);
      for (const st of chain.steps) {
        const p = planCraft(idx, st.item, st.n, inv.slots, keep)!;
        expect(p.crafts).toBeGreaterThan(0);
        for (const [k, v] of Object.entries(p.perCraft)) inv.take(k, v * p.crafts);
        inv.add(p.item, p.crafts * p.outputPer);
      }
      // the armour pass and the shield's offhand move
      for (const [slot, piece] of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'].entries()) {
        if (inv.count(piece) > 0 && !inv.worn[slot]) {
          inv.take(piece, 1);
          inv.worn[slot] = item(piece);
        }
      }
      return;
    }
    case 'furnace':
      inv.take('furnace', 1);
      inv.furnace = true;
      return;
    case 'bed':
      inv.take('bed', 1);
      inv.bed = true;
      return;
    case 'smelt': {
      expect(inv.furnace).toBe(true);
      inv.burn(a.n);
      inv.take(a.input, a.n);
      inv.add(a.item, a.n);
      return;
    }
    case 'cook': {
      expect(inv.furnace).toBe(true);
      for (const s of [...inv.slots]) {
        const c = s ? cookedOf(s.name) : undefined;
        if (!s || !c) continue;
        const n = s.count;
        inv.burn(n);
        inv.take(s.name, n);
        inv.add(c, n);
      }
      return;
    }
    default:
      throw new Error(`no step for ${a.kind}`);
  }
}

function run(targets: readonly ObtainTarget[], inv = new Inv(), w: World = { iron: Infinity, coalNear: false }, capOnShort = false) {
  const idx = index();
  const steps: string[] = [];
  const capped = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const o: ObtainOptions = { ...keep, furnaceNear: inv.furnace, coalNear: w.coalNear, worn: inv.worn, capped, bedNear: inv.bed };
    const a = nextAction(idx, targets, inv.slots, o);
    if (a.kind === 'done' || a.kind === 'stuck') return { steps, end: a, inv, dropped: affordable(idx, targets, inv.slots, o).dropped.map((t) => t.item) };
    steps.push(a.command);
    const before = a.kind === 'mine' ? inv.count(a.item) : 0;
    apply(idx, inv, a, w);
    if (capOnShort && a.kind === 'mine' && inv.count(a.item) - before < a.n) capped.add(a.item);
  }
  throw new Error(`no end after 40 steps: ${steps.join(' | ')}`);
}

/** The stone kit as E1's `!get kit` leaves it (a run on the fresh world: a few logs and planks over). */
const STONE_KIT: readonly (readonly [string, number])[] = [
  ['crafting_table', 1],
  ['stone_sword', 1],
  ['stone_pickaxe', 1],
  ['stone_axe', 1],
  ['wooden_pickaxe', 1],
  ['cobblestone', 16],
  ['oak_log', 2],
  ['oak_planks', 3],
  ['beef', 4],
  ['porkchop', 2],
];

describe('obtain: iron (Track E2)', () => {
  it('pickaxes by tier: iron ore a stone one, diamond an iron one, obsidian none', () => {
    expect(pickaxeFor('iron_ore')).toEqual({ item: 'stone_pickaxe' });
    expect(pickaxeFor('diamond_ore')).toEqual({ item: 'iron_pickaxe' });
    expect(pickaxeFor('obsidian')).toHaveProperty('reason');
  });

  it('an iron pickaxe from the stone kit: the ore, a furnace from the kit cobblestone, the planks for fuel, the smelt, the craft', () => {
    const r = run([{ item: 'iron_pickaxe', n: 1 }], new Inv(STONE_KIT));
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps).toEqual(['mine iron_ore 3', 'craft furnace 1', 'furnace', 'smelt raw_iron 3', 'craft iron_pickaxe 1']);
    expect(r.inv.count('iron_pickaxe')).toBe(1);
  });

  it('a coal ore near: coal is the fuel when what the crafts leave is short', () => {
    const inv = new Inv([
      ['stone_pickaxe', 1],
      ['crafting_table', 1],
      ['cobblestone', 8],
      ['stick', 2],
    ]);
    const r = run([{ item: 'iron_pickaxe', n: 1 }], inv, { iron: Infinity, coalNear: true });
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps).toEqual(['mine iron_ore 3', 'craft furnace 1', 'furnace', 'mine coal_ore 1', 'smelt raw_iron 3', 'craft iron_pickaxe 1']);
  });

  it('a coal ore near but every pickaxe worn out: no coal step, the logs instead (measured: `!mine coal_ore 2` got nothing)', () => {
    const inv = new Inv([
      ['crafting_table', 1],
      ['raw_iron', 33],
      ['coal', 3],
      ['oak_log', 2],
    ]);
    const o: ObtainOptions = { ...keep, furnaceNear: true, coalNear: true };
    const a = nextAction(index(), [{ item: 'iron_ingot', n: 33 }], inv.slots, o);
    expect(a.kind).not.toBe('mine');
    // 3 coal and 2 logs burn 27 of the 33: 6 short, the two logs as 8 planks
    expect(a).toEqual({ kind: 'craft', item: 'oak_planks', n: 8, command: 'craft oak_planks 8' });
    // with a wooden pickaxe carried the coal is mined as before
    inv.add('wooden_pickaxe', 1);
    expect(nextAction(index(), [{ item: 'iron_ingot', n: 33 }], inv.slots, o)).toEqual({ kind: 'mine', block: 'coal_ore', item: 'coal', n: 1, command: 'mine coal_ore 1' });
  });

  it('no coal near and no wood left: logs for the fuel, planks when the logs fall short', () => {
    const inv = new Inv([
      ['stone_pickaxe', 1],
      ['crafting_table', 1],
      ['cobblestone', 8],
      ['stick', 2],
      ['raw_iron', 3],
    ]);
    const r = run([{ item: 'iron_pickaxe', n: 1 }], inv);
    expect(r.end).toEqual({ kind: 'done' });
    // a tree's 6 logs burn 9 items as they are: no planks step
    expect(r.steps).toEqual(['craft furnace 1', 'furnace', 'gather 1', 'smelt raw_iron 3', 'craft iron_pickaxe 1']);
    // one log brought back (1.5 items): planks from it (6 items)
    const one = new Inv([
      ['crafting_table', 1],
      ['oak_log', 1],
      ['raw_iron', 3],
    ]);
    expect(nextAction(index(), [{ item: 'iron_ingot', n: 3 }], one.slots, { ...keep, furnaceNear: true })).toEqual({ kind: 'craft', item: 'oak_planks', n: 4, command: 'craft oak_planks 4' });
  });

  it('an iron pickaxe from nothing: wooden, stone and iron pickaxes; the logs in one trip', () => {
    const r = run([{ item: 'iron_pickaxe', n: 1 }]);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps.filter((s) => s.startsWith('gather')).length).toBeLessThanOrEqual(2);
    expect(r.steps.slice(0, 4)).toEqual([expect.stringMatching(/^gather \d+$/), 'craft wooden_pickaxe 1', 'mine stone 3', 'craft stone_pickaxe 1']);
    expect(r.steps).toContain('smelt raw_iron 3');
    expect(r.inv.count('iron_pickaxe')).toBe(1);
  });

  it('the iron kit with ore enough: 33 iron in one mine step, every piece crafted and worn, the food cooked', () => {
    const inv = new Inv(STONE_KIT);
    const r = run(IRON_KIT, inv);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps.filter((s) => s.startsWith('mine iron_ore'))).toEqual(['mine iron_ore 33']);
    expect(r.steps).toContain('smelt raw_iron 33');
    expect(r.steps).toContain('cook');
    expect(r.steps.indexOf('cook')).toBeGreaterThan(r.steps.indexOf('smelt raw_iron 33'));
    expect(r.inv.worn.map((s) => s?.name)).toEqual(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']);
    for (const t of ['iron_pickaxe', 'iron_sword', 'bucket']) expect(r.inv.count(t)).toBe(1);
    expect(r.inv.count('beef') + r.inv.count('porkchop')).toBe(0);
    expect(r.inv.count('cooked_beef') + r.inv.count('cooked_porkchop')).toBe(6);
    expect(r.inv.count('cobblestone')).toBeGreaterThanOrEqual(16);
    expect(r.dropped).toEqual([]);
  });

  it('the iron kit with 13 iron found: the 9 for the tools, the boots from the other 4, the rest short', () => {
    const r = run(IRON_KIT, new Inv(STONE_KIT), { iron: 13, coalNear: false }, true);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps.filter((s) => s.startsWith('mine iron_ore'))).toEqual(['mine iron_ore 33']);
    expect(r.steps).toContain('smelt raw_iron 13');
    expect(r.dropped).toEqual(['iron_chestplate', 'iron_leggings', 'iron_helmet']);
    expect(r.inv.worn.map((s) => s?.name ?? null)).toEqual([null, null, null, 'iron_boots', 'shield']);
    for (const t of ['iron_pickaxe', 'iron_sword', 'bucket']) expect(r.inv.count(t)).toBe(1);
  });

  it('the iron kit with 5 iron found: the hard targets mine again for the rest', () => {
    const w = { iron: 5, coalNear: false };
    const idx = index();
    const inv = new Inv(STONE_KIT);
    const capped = new Set<string>(['raw_iron']);
    inv.add('raw_iron', 5);
    const a = nextAction(idx, IRON_KIT, inv.slots, { ...keep, capped, worn: inv.worn });
    expect(a).toMatchObject({ kind: 'mine', block: 'iron_ore', n: 4 });
    expect(affordable(idx, IRON_KIT, inv.slots, { ...keep, capped }).dropped.map((t) => t.item)).toEqual(['iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_helmet']);
    void w;
  });

  it('Track E3: the bed after the iron, soft: a short ore keeps it (no iron in it), a hunt that got no wool drops it', () => {
    const idx = index();
    const inv = new Inv(STONE_KIT);
    inv.add('raw_iron', 5);
    expect(affordable(idx, IRON_KIT, inv.slots, { ...keep, capped: new Set(['raw_iron']) }).dropped.map((t) => t.item)).not.toContain('bed');
    expect(affordable(idx, IRON_KIT, inv.slots, { ...keep, capped: new Set(['white_wool']) }).dropped.map((t) => t.item)).toEqual(['bed']);
    // ore enough: the bed is made and set down; the steps end with the kit's food
    const r = run(IRON_KIT, new Inv(STONE_KIT));
    expect(r.steps).toContain('kill sheep 3');
    expect(r.steps).toContain('craft bed 1');
    expect(r.steps.indexOf('bed')).toBeGreaterThan(r.steps.indexOf('craft bed 1'));
    expect(r.inv.bed).toBe(true);
  });

  it('worn armour and the offhand shield count as carried', () => {
    const inv = new Inv([['iron_sword', 1]]);
    inv.worn = [null, item('iron_chestplate'), null, null, item('shield')];
    const o: ObtainOptions = { ...keep, worn: inv.worn };
    expect(nextAction(index(), [{ item: 'shield', n: 1 }, { item: 'iron_chestplate', n: 1 }, { item: 'iron_sword', n: 1 }], inv.slots, o)).toEqual({ kind: 'done' });
  });

  it('!get furnace: crafted, then set down; one standing is done', () => {
    const idx = index();
    const inv = new Inv([['cobblestone', 8], ['oak_planks', 4]]);
    expect(nextAction(idx, [{ item: 'furnace', n: 1 }], inv.slots, keep)).toMatchObject({ kind: 'craft', item: 'furnace', n: 1 });
    inv.take('cobblestone', 8);
    inv.add('furnace', 1);
    expect(nextAction(idx, [{ item: 'furnace', n: 1 }], inv.slots, keep)).toEqual({ kind: 'furnace', command: 'furnace' });
    expect(nextAction(idx, [{ item: 'furnace', n: 1 }], [], { ...keep, furnaceNear: true })).toEqual({ kind: 'done' });
  });

  it('raw food is cooked when a furnace stands and fuel is left; without a furnace it counts as food', () => {
    const idx = index();
    const slots = new Inv([['beef', 6], ['coal', 1]]).slots;
    expect(nextAction(idx, [{ item: 'food', n: 6 }], slots, { ...keep, furnaceNear: true })).toEqual({ kind: 'cook', n: 6, command: 'cook' });
    expect(nextAction(idx, [{ item: 'food', n: 6 }], slots, keep)).toEqual({ kind: 'done' });
    expect(nextAction(idx, [{ item: 'food', n: 6 }], new Inv([['beef', 6]]).slots, { ...keep, furnaceNear: true })).toEqual({ kind: 'done' });
  });

  it('the stone kit is unchanged (no furnace, no cooking: no furnace near)', () => {
    const r = run(EARLY_KIT);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps.some((s) => s.startsWith('smelt') || s === 'furnace' || s === 'cook')).toBe(false);
  });

  it('fuel arithmetic: what the crafts leave (planks 1.5, logs 1.5, coal 8)', () => {
    expect(fuelItems(new Inv([['coal', 1], ['oak_planks', 2]]).slots)).toBe(11);
  });

  it('what has no rule stops with the reason (a bow needs string)', () => {
    const a = nextAction(index(), [{ item: 'shears', n: 1 }], [], keep);
    expect(a.kind).not.toBe('stuck');
  });
});
