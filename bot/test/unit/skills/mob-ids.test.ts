// Track REL3: every list of mob ids in the code is held against the game's own entity ids (the server's
// available_entity_identifiers in the recorded login of the fixture version), as archer-lists.test.ts does for the
// archers. HOSTILE_TYPES had `evoker` and `illusioner` (Java names: Bedrock's evoker is `evocation_illager`, the
// illusioner is not in the game), so an evoker was classed `other` and never fought; NEUTRAL_TYPES had
// `zombified_piglin` (Bedrock's id is `zombie_pigman`; the typed name is an alias) and `spider_jockey` (not an entity:
// a skeleton riding a spider). A new game version with a new id fails the "every id is classed" case until the id is
// put in a class or in UNCLASSED with its reason.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARCHER_TYPES, classify, entitySize, FLYING_TYPES, HOSTILE_TYPES, ITEM_TYPES, NEUTRAL_TYPES, normalizeTypeName, PASSIVE_TYPES, SHOOTER_TYPES } from '../../../src/skills/combat/hostiles.ts';
import { REFLEX_NEVER } from '../../../src/skills/combat/reflex.ts';
import { BREED_FOOD } from '../../../src/skills/food/breed.ts';
import { FOOD_ANIMALS } from '../../../src/skills/food/finder.ts';
import { MILK_MOBS } from '../../../src/skills/food/milk.ts';
import { MOB_SETS } from '../../../src/skills/test/mobs.ts';
import { FIXTURE_VERSION, loadFixture } from '../world/helpers.ts';

/** The entity ids the server says it has (no namespace), from the recorded login of the fixture version. */
function gameIds(): Set<string> {
  const line = loadFixture('login-idle.jsonl.gz').find((l) => l.name === 'available_entity_identifiers');
  const list = (line?.params as { nbt?: { value?: { idlist?: { value?: { value?: { id: { value: string } }[] } } } } } | undefined)?.nbt?.value?.idlist?.value?.value ?? [];
  return new Set(list.map((x) => x.id.value.replace(/^minecraft:/, '')));
}

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
const source = (rel: string): string => readFileSync(join(srcDir, rel), 'utf8');

/** The `case '<id>':` labels of a function in a source file (the per-mob switches: sizes, reach, speed). */
function caseLabels(rel: string, fn: string): string[] {
  const text = source(rel);
  const at = text.indexOf(`export function ${fn}(`);
  expect(at, `${fn} in ${rel}`).toBeGreaterThan(-1);
  const body = text.slice(at, text.indexOf('\n}\n', at));
  return [...body.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]!);
}

/**
 * Game ids in no class (classify gives `other`), each on purpose. `player` has its own class.
 * - wither, ender_dragon: bosses; guard does not take one on (the reflex never strikes them: REFLEX_NEVER).
 * - camel_husk, zombie_nautilus: mounts of the newer drops (a husk's camel, a drowned's nautilus); not seen yet, the
 *   rider is the hostile one and is classed.
 * - sulfur_cube, cushion: newer entities whose behaviour the bot has not seen; left out until one is.
 * - elder_guardian_ghost (the curse's picture), ominous_item_spawner (a trial chamber's drop), balloon, ice_bomb,
 *   ice_ball (Education Edition): not mobs.
 */
const UNCLASSED: ReadonlySet<string> = new Set(['player', 'wither', 'ender_dragon', 'camel_husk', 'zombie_nautilus', 'sulfur_cube', 'cushion', 'elder_guardian_ghost', 'ominous_item_spawner', 'balloon', 'ice_bomb', 'ice_ball']);

const sorted = (s: Iterable<string>): string[] => [...s].sort();
const notGame = (list: Iterable<string>, ids: ReadonlySet<string>): string[] => sorted([...list].filter((t) => !ids.has(t)));

describe('mob ids against the game (Track REL3)', () => {
  const ids = gameIds();

  it(`the fixture's list is the game's (${FIXTURE_VERSION}'s recorded login)`, () => {
    expect(ids.size).toBeGreaterThan(100);
    for (const t of ['zombie', 'evocation_illager', 'zombie_pigman', 'player', 'item']) expect(ids.has(t), t).toBe(true);
    for (const t of ['evoker', 'illusioner', 'zombified_piglin', 'spider_jockey']) expect(ids.has(t), t).toBe(false);
  });

  it('every class list holds game ids only', () => {
    expect(notGame(HOSTILE_TYPES, ids), 'HOSTILE_TYPES').toEqual([]);
    expect(notGame(NEUTRAL_TYPES, ids), 'NEUTRAL_TYPES').toEqual([]);
    expect(notGame(PASSIVE_TYPES, ids), 'PASSIVE_TYPES').toEqual([]);
    expect(notGame(ITEM_TYPES, ids), 'ITEM_TYPES').toEqual([]);
    expect(notGame(FLYING_TYPES, ids), 'FLYING_TYPES').toEqual([]);
    expect(notGame(REFLEX_NEVER, ids), 'REFLEX_NEVER').toEqual([]);
    expect(notGame(UNCLASSED, ids), 'UNCLASSED').toEqual([]);
  });

  it('the evoker is hostile by its Bedrock id; the Java names are gone', () => {
    expect(classify('minecraft:evocation_illager')).toBe('hostile');
    for (const t of ['evoker', 'illusioner']) expect(HOSTILE_TYPES.has(t), t).toBe(false);
    expect(entitySize('evocation_illager')).toEqual({ w: 0.6, h: 1.95 });
  });

  it('the classes do not overlap, and every game id is in one or in UNCLASSED', () => {
    const lists = { HOSTILE_TYPES, NEUTRAL_TYPES, PASSIVE_TYPES, ITEM_TYPES, UNCLASSED };
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [name, list] of Object.entries(lists)) {
      for (const t of list) {
        if (seen.has(t)) twice.push(`${t}: ${seen.get(t)} and ${name}`);
        seen.set(t, name);
      }
    }
    expect(twice).toEqual([]);
    // the suffix rule of classify (`*_minecart`, `*_boat`) classes those as items too
    const unclassed = sorted([...ids].filter((t) => !seen.has(t) && classify(t) === 'other'));
    expect(unclassed, 'game ids in no class: put each in a class or in UNCLASSED with its reason').toEqual([]);
    for (const t of UNCLASSED) expect(classify(t), t).toBe(t === 'player' ? 'player' : 'other');
  });

  it('every archer and shooter is hostile; every flyer is a mob', () => {
    for (const t of [...ARCHER_TYPES, ...SHOOTER_TYPES]) expect(classify(t), t).toBe('hostile');
    for (const t of FLYING_TYPES) expect(['hostile', 'neutral', 'passive'], t).toContain(classify(t));
  });

  it('the food, milk and breed lists are passive or neutral mobs of the game, and the breed lists agree', () => {
    const food = Object.keys(FOOD_ANIMALS);
    const breed = Object.keys(BREED_FOOD);
    expect(notGame(food, ids), 'FOOD_ANIMALS').toEqual([]);
    expect(notGame(breed, ids), 'BREED_FOOD').toEqual([]);
    expect(notGame(MILK_MOBS, ids), 'MILK_MOBS').toEqual([]);
    for (const t of [...food, ...breed, ...MILK_MOBS]) expect(['passive', 'neutral'], t).toContain(classify(t));
    // nl/plan.ts's BREED_KINDS (the `breed` step's type) is not exported: read from the source
    const m = /const BREED_KINDS = \[([^\]]*)\]/.exec(source('nl/plan.ts'));
    expect(m, 'BREED_KINDS in nl/plan.ts').not.toBeNull();
    const kinds = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
    expect(sorted(kinds)).toEqual(sorted(breed));
  });

  it("the !test mobs catalogue summons game ids; the typed aliases name game ids", () => {
    const summoned = new Set(Object.values(MOB_SETS).flatMap((set) => set.map((m) => m.type)));
    expect(notGame(summoned, ids), 'MOB_SETS').toEqual([]);
    for (const typed of ['zombified_piglin', 'zombie_piglin', 'zombievillager']) expect(ids.has(normalizeTypeName(typed)), typed).toBe(true);
  });

  it('the per-mob switches (sizes, reach, speed) name game ids only', () => {
    const labels = [...caseLabels('skills/combat/hostiles.ts', 'entitySize'), ...caseLabels('skills/combat/reflex.ts', 'mobReach'), ...caseLabels('skills/combat/reflex.ts', 'mobSpeed')];
    expect(labels.length).toBeGreaterThan(20);
    expect(notGame(labels, ids)).toEqual([]);
  });
});
