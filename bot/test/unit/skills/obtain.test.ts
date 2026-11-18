// Track E1 (docs/early-game.md "From nothing"): the obtain planner's next command, and a whole day-one kit from an
// empty inventory on a simulated inventory (gathering adds logs, mining adds its drop when a carried tool harvests
// the block, crafting runs the chain on the recorded early-game recipes).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planChain } from '../../../src/skills/craft/chain.ts';
import { planCraft, RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { canHarvestWith, EARLY_KIT, foodCarried, minedBlockFor, nextAction, pickaxeFor, type ObtainAction, type ObtainTarget } from '../../../src/skills/items/obtain.ts';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import type { ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-early-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
function index(): RecipeIndex {
  const idx = new RecipeIndex((id) => fixture.items[String(id)]);
  idx.handle(fixture);
  return idx;
}
const item = (name: string, count = 1): ItemStack => ({ name, count, networkId: name.length, metadata: 0 });
const keep = { keep: keepOnDropItems };

/** A 36-slot inventory with add / take. */
class Inv {
  slots: (ItemStack | null)[] = Array.from({ length: 36 }, () => null);
  add(name: string, n: number): void {
    const s = this.slots.find((x) => x?.name === name && x.count < 64);
    if (s) {
      const room = 64 - s.count;
      s.count += Math.min(room, n);
      if (n > room) this.add(name, n - room);
      return;
    }
    const i = this.slots.indexOf(null);
    if (i < 0) throw new Error('inventory full');
    this.slots[i] = item(name, Math.min(64, n));
    if (n > 64) this.add(name, n - 64);
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
}

/** What the commands do, simplified: gather logs, mine with the harvest rule, hunt, craft the chain then the item. */
function apply(idx: RecipeIndex, inv: Inv, a: ObtainAction): void {
  switch (a.kind) {
    case 'gather':
      inv.add('oak_log', Math.ceil(a.n / 6) * 6); // whole trees of 6
      return;
    case 'mine':
      if (!canHarvestWith(inv.slots, a.block)) return; // dug for nothing
      inv.add(a.item, a.n);
      return;
    case 'hunt':
      inv.add(a.item, a.n);
      return;
    case 'food':
      inv.add('beef', a.n);
      return;
    case 'craft': {
      const chain = planChain(idx, [{ item: a.item, n: a.n + inv.slots.reduce((x, s) => x + (s?.name === a.item ? s.count : 0), 0) }], inv.slots, keep);
      if (chain.missing.length) throw new Error(`craft ${a.item}: missing ${JSON.stringify(chain.missing)}`);
      for (const st of chain.steps) {
        const p = planCraft(idx, st.item, st.n, inv.slots, keep)!;
        expect(p.crafts).toBeGreaterThan(0);
        for (const [k, v] of Object.entries(p.perCraft)) inv.take(k, v * p.crafts);
        inv.add(p.item, p.crafts * p.outputPer);
      }
      return;
    }
    default:
      throw new Error(`no step for ${a.kind}`);
  }
}

function run(targets: readonly ObtainTarget[], inv = new Inv()): { steps: string[]; end: ObtainAction; inv: Inv } {
  const idx = index();
  const steps: string[] = [];
  for (let i = 0; i < 30; i++) {
    const a = nextAction(idx, targets, inv.slots, keep);
    if (a.kind === 'done' || a.kind === 'stuck') return { steps, end: a, inv };
    steps.push(a.command);
    apply(idx, inv, a);
  }
  throw new Error(`no end after 30 steps: ${steps.join(' | ')}`);
}

describe('obtain: the next command (Track E1)', () => {
  it('raw materials: cobblestone is mined from stone, coal from coal ore, nothing for iron ingots', () => {
    expect(minedBlockFor('cobblestone')).toBe('stone');
    expect(minedBlockFor('coal')).toBe('coal_ore');
    expect(minedBlockFor('iron_ingot')).toBeUndefined();
    expect(pickaxeFor('stone')).toEqual({ item: 'wooden_pickaxe' });
    expect(pickaxeFor('iron_ore')).toEqual({ item: 'stone_pickaxe' });
    expect(pickaxeFor('diamond_ore')).toHaveProperty('reason');
    expect(canHarvestWith([], 'stone')).toBe(false);
    expect(canHarvestWith([item('wooden_pickaxe')], 'stone')).toBe(true);
    expect(canHarvestWith([], 'dirt')).toBe(true);
  });

  it('a stone pickaxe from nothing: the logs for both pickaxes in one trip, the wooden one, the stone, the stone one', () => {
    const r = run([{ item: 'stone_pickaxe', n: 1 }]);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps[0]).toMatch(/^gather \d+$/);
    expect(r.steps.filter((s) => s.startsWith('gather'))).toHaveLength(1);
    expect(r.steps).toEqual([r.steps[0], 'craft wooden_pickaxe 1', 'mine stone 3', 'craft stone_pickaxe 1']);
  });

  it('the early kit from nothing: one log trip, the table, the wooden pickaxe, 24 cobblestone (16 kept), the stone tools, food', () => {
    const r = run(EARLY_KIT);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps.filter((s) => s.startsWith('gather'))).toHaveLength(1);
    expect(r.steps).toContain('mine stone 24'); // 8 for the tools, 16 kept
    expect(r.steps.at(-1)).toBe('food 6');
    for (const t of ['crafting_table', 'stone_sword', 'stone_pickaxe', 'stone_axe', 'wooden_pickaxe']) expect(r.inv.slots.some((s) => s?.name === t)).toBe(true);
    expect(foodCarried(r.inv.slots)).toBeGreaterThanOrEqual(6);
  });

  it('a bed: wool from three sheep, planks from a log', () => {
    const r = run([{ item: 'bed', n: 1 }]);
    expect(r.end).toEqual({ kind: 'done' });
    expect(r.steps).toEqual([expect.stringMatching(/^gather \d+$/), 'kill sheep 3', 'craft bed 1']);
    expect(r.inv.slots.some((s) => s?.name === 'bed')).toBe(true);
  });

  it('what has no rule stops with the reason', () => {
    const a = nextAction(index(), [{ item: 'iron_pickaxe', n: 1 }], [], keep);
    expect(a.kind).toBe('stuck');
    expect(a.kind === 'stuck' && a.reason).toMatch(/iron_ingot/);
  });

  it('carried targets are done at once', () => {
    expect(nextAction(index(), [{ item: 'stone_sword', n: 1 }, { item: 'food', n: 2 }], [item('stone_sword'), item('bread', 3)], keep)).toEqual({ kind: 'done' });
  });
});
