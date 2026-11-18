// Track E4 (docs/early-game.md "Wear and setbacks", ADR 0101): the worn-tool rule in the obtain planner (a worn tool
// counts as not carried, so a step that needs a tool makes a fresh one first, from what is carried or cheap), the
// placed-block memory, and the death-return rules, on the recorded iron-age recipes (BDS 1.26.60.6).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keepOnDropItems } from '../../../src/chat/commands-survival.ts';
import { RecipeIndex, type CraftingDataPacket } from '../../../src/skills/craft/recipes.ts';
import { DEATH_RETURN_MAX, DEATH_RETURN_RANGE, DROP_DESPAWN_MS, deathReturnPlan, stacksRecovered } from '../../../src/skills/items/death-return.ts';
import { EARLY_KIT, IRON_KIT, nextAction } from '../../../src/skills/items/obtain.ts';
import { FURNACE_RECALL, PLACED_MAX, PlacedBlocks, placedOf } from '../../../src/skills/items/placed.ts';
import { isWorn, replacedBy, toolKind, usableSlots, wornTools } from '../../../src/skills/items/wear.ts';
import { makeToolOk } from '../../../src/skills/survival/tools.ts';
import type { BlockInfo, ItemStack } from '../../../src/world/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/crafting-data-iron-1.26.60.json', import.meta.url), 'utf8')) as CraftingDataPacket & { items: Record<string, string> };
const recipes = new RecipeIndex((id) => fixture.items[String(id)]);
recipes.handle(fixture);
const keep = { keep: keepOnDropItems };
const toolOk = makeToolOk(() => 10);
const item = (name: string, count = 1, damage?: number): ItemStack => ({ name, count, networkId: name.length, metadata: 0, ...(damage !== undefined ? { damage } : {}) });
const inv = (...items: ItemStack[]): (ItemStack | null)[] => [...items, ...Array.from({ length: 36 - items.length }, () => null)];
/** A stone pickaxe with 6 uses left (131 - 125): under the default toolWearLimit of 10. */
const wornStone = () => item('stone_pickaxe', 1, 125);

describe('wear.ts: worn tools', () => {
  it('names the tool kinds, finds the worn ones, leaves them out of the plan inventory', () => {
    expect([toolKind('stone_pickaxe'), toolKind('iron_axe'), toolKind('wooden_sword'), toolKind('shield'), toolKind('stick'), toolKind('iron_helmet')]).toEqual(['pickaxe', 'axe', 'sword', undefined, undefined, undefined]);
    const s = inv(wornStone(), item('wooden_pickaxe', 1, 10), item('cobblestone', 16), item('stone_sword', 1, 128));
    expect(isWorn(s[0], toolOk)).toBe(true);
    expect(isWorn(s[1], toolOk)).toBe(false); // 49 left
    expect(isWorn(s[2], toolOk)).toBe(false); // no durability
    expect(wornTools(s, toolOk)).toEqual(['stone_pickaxe', 'stone_sword']);
    expect(usableSlots(s, toolOk).filter(Boolean).map((x) => x!.name)).toEqual(['wooden_pickaxe', 'cobblestone']);
    // a craft of the same kind replaced it (any tier); another kind did not
    expect(replacedBy(s, 'stone_pickaxe', toolOk)).toBe('stone_pickaxe');
    expect(replacedBy(s, 'iron_pickaxe', toolOk)).toBe('stone_pickaxe');
    expect(replacedBy(s, 'stone_axe', toolOk)).toBeUndefined();
    expect(replacedBy(s, 'furnace', toolOk)).toBeUndefined();
  });
});

describe('the planner with the worn-tool rule (toolOk)', () => {
  it('measured case: the stone pickaxe worn out at 30 of 33 iron ore: a fresh one from the kit cobblestone, then the rest is mined', () => {
    const s = inv(wornStone(), item('iron_sword'), item('crafting_table'), item('cobblestone', 16), item('oak_planks', 4), item('raw_iron', 30));
    // before (no rule): the worn pickaxe counts, the job asks to mine (and the miner ends with no pickaxe)
    expect(nextAction(recipes, [{ item: 'raw_iron', n: 33 }], s, keep)).toMatchObject({ kind: 'mine', command: 'mine iron_ore 3' });
    // after: a stone pickaxe first, from 3 of the carried cobblestone
    expect(nextAction(recipes, [{ item: 'raw_iron', n: 33 }], s, { ...keep, toolOk })).toMatchObject({ kind: 'craft', item: 'stone_pickaxe', n: 1, command: 'craft stone_pickaxe 1' });
  });

  it('every pickaxe worn, no cobblestone, logs carried: a wooden pickaxe first (stone for the stone one), never a worn one counted', () => {
    const s = inv(wornStone(), item('wooden_pickaxe', 1, 55), item('oak_log', 4));
    const a = nextAction(recipes, [{ item: 'raw_iron', n: 3 }], s, { ...keep, toolOk });
    expect(a).toMatchObject({ kind: 'craft', item: 'wooden_pickaxe', command: 'craft wooden_pickaxe 1' });
  });

  it('the stone kit with a worn stone pickaxe carried: the kit is not done; it crafts a new one', () => {
    const s = inv(item('crafting_table'), item('stone_sword'), wornStone(), item('stone_axe'), item('cobblestone', 20), item('oak_planks', 4), item('cooked_beef', 6));
    expect(nextAction(recipes, EARLY_KIT, s, keep).kind).toBe('done');
    expect(nextAction(recipes, EARLY_KIT, s, { ...keep, toolOk })).toMatchObject({ kind: 'craft', item: 'stone_pickaxe', command: 'craft stone_pickaxe 1' });
  });

  it('the iron kit: a worn stone pickaxe before the iron mine step is replaced first; a usable one is not', () => {
    const base = [item('crafting_table'), item('stone_sword'), item('stone_axe'), item('cobblestone', 24), item('oak_log', 16), item('cooked_beef', 6)];
    expect(nextAction(recipes, IRON_KIT, inv(wornStone(), ...base), { ...keep, toolOk })).toMatchObject({ kind: 'craft', item: 'stone_pickaxe' });
    expect(nextAction(recipes, IRON_KIT, inv(item('stone_pickaxe', 1, 100), ...base), { ...keep, toolOk })).toMatchObject({ kind: 'mine', block: 'iron_ore', n: 33 });
  });
});

describe('placed.ts: the blocks the bot set down', () => {
  const blocks = new Map<string, BlockInfo>();
  const at = (x: number, y: number, z: number) => ({ x, y, z });
  const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
  const blockAt = (p: { x: number; y: number; z: number }) => blocks.get(key(p));
  const put = (p: { x: number; y: number; z: number }, name: string) => blocks.set(key(p), { name } as BlockInfo);

  it('offers a remembered furnace within FURNACE_RECALL that still stands, nearest first; forgets one replaced; keeps one unloaded', () => {
    const m = new PlacedBlocks(() => 5);
    const a = at(10, 64, 0);
    const b = at(40, 64, 0);
    const far = at(FURNACE_RECALL + 20, 64, 0);
    const gone = at(0, 64, 12);
    const unloaded = at(5, 64, 5);
    for (const p of [a, b, far, gone, unloaded]) m.record('furnace', p);
    put(a, 'furnace');
    put(b, 'lit_furnace');
    put(far, 'furnace');
    put(gone, 'cobblestone');
    expect(m.near('furnace', at(0.5, 64, 0.5), FURNACE_RECALL, blockAt)).toEqual([a, b]);
    expect(m.all().some((x) => key(x.p) === key(gone))).toBe(false);
    expect(m.all().some((x) => key(x.p) === key(unloaded))).toBe(true);
    expect(m.all()[0]).toMatchObject({ name: 'furnace', at: 5 });
    expect(m.near('crafting_table', at(0, 64, 0), 100, blockAt)).toEqual([]);
  });

  it('keeps at most PLACED_MAX (the oldest go) and one per cell; one memory per task', () => {
    const m = new PlacedBlocks();
    for (let i = 0; i < PLACED_MAX + 5; i++) m.record('furnace', at(i, 0, 0));
    m.record('furnace', at(PLACED_MAX + 4, 0, 0));
    expect(m.all()).toHaveLength(PLACED_MAX);
    expect(m.all()[0]!.p.x).toBe(5);
    const task = {};
    expect(placedOf(task)).toBe(placedOf(task));
    expect(placedOf({})).not.toBe(placedOf(task));
  });
});

describe('death-return.ts: back to the death spot (deathReturn)', () => {
  const feet = { x: 0, y: 64, z: 0 };
  const base = { at: { x: 40, y: 60, z: 30 }, cause: 'death.attack.mob', feet, sinceMs: 10_000, time: 3000, returns: 0 };

  it('goes by day within reach while the drops last, with the walk budget of what is left', () => {
    const p = deathReturnPlan(base);
    expect(p).toMatchObject({ go: true, distance: 50 });
    if (p.go) {
      expect(p.walkTicks).toBe(Math.floor((DROP_DESPAWN_MS - 10_000 - 20_000) / 50));
      expect(p.collectTicks).toBe(400);
    }
  });

  it.each([
    ['no spot', { at: undefined }, 'the death spot is not known'],
    ['the void', { at: { x: 0, y: -70, z: 0 } }, 'void'],
    ['lava', { cause: 'death.attack.lava' }, 'the drops are gone (lava)'],
    ['fire', { cause: 'death.attack.onFire' }, 'the drops are gone'],
    ['night', { time: 14000 }, 'night'],
    ['near dusk', { time: 11500 }, 'near dusk'],
    ['too far', { at: { x: DEATH_RETURN_RANGE + 10, y: 64, z: 0 } }, `walks back within ${DEATH_RETURN_RANGE}`],
    ['despawned', { sinceMs: DROP_DESPAWN_MS - 15_000 }, 'the drops despawn before I get there'],
    ['too many', { returns: DEATH_RETURN_MAX }, 'returns in this job already'],
  ])('does not go: %s', (_name, over, why) => {
    const p = deathReturnPlan({ ...base, ...over });
    expect(p.go).toBe(false);
    if (!p.go) expect(p.why).toContain(why);
  });

  it('an unknown clock counts as day', () => {
    expect(deathReturnPlan({ ...base, time: undefined }).go).toBe(true);
  });

  it('counts the stacks recovered against the stacks dropped (greedy by item), and what is lost', () => {
    const then = [item('iron_ingot', 30), item('iron_ingot', 3), item('cobblestone', 64), item('cobblestone', 10), item('stone_pickaxe'), null, item('iron_helmet')];
    const now = [item('iron_ingot', 33), item('cobblestone', 64), item('stone_pickaxe'), item('iron_helmet'), item('dirt', 3)];
    expect(stacksRecovered(then, now)).toEqual({ got: 5, of: 6, lost: { cobblestone: 10 } });
    expect(stacksRecovered(then, [])).toMatchObject({ got: 0, of: 6 });
  });
});
