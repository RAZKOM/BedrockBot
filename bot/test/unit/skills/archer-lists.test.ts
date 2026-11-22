// Track E13 (docs/pve.md "One archer list (Track E13)", ADR 0120): the archer types are one list. The parched (the
// desert's skeleton) was in hostiles.ts ARCHER_TYPES and missing from pve.ts's own copy, so no pve rule (the duel, the
// work fight, the shooter memory, the volley, the dodge) treated it as an archer. These tests hold the list against the
// game's own mob list (the server's available_entity_identifiers in the recorded login) and against copies elsewhere.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARCHER_TYPES, classify, isArcher, RANGED_TYPES, SHOOTER_TYPES } from '../../../src/skills/combat/hostiles.ts';
import { SHOOTERS } from '../../../src/tasks/mend-threat.ts';
import { DUEL_ARCHERS, FLEE_RANGED } from '../../../src/tasks/pve.ts';
import { FIXTURE_VERSION, loadFixture } from '../world/helpers.ts';

/** The entity ids the server says it has (no namespace), from the recorded login of the fixture version. */
function gameIds(): Set<string> {
  const line = loadFixture('login-idle.jsonl.gz').find((l) => l.name === 'available_entity_identifiers');
  const list = (line?.params as { nbt?: { value?: { idlist?: { value?: { value?: { id: { value: string } }[] } } } } } | undefined)?.nbt?.value?.idlist?.value?.value ?? [];
  return new Set(list.map((x) => x.id.value.replace(/^minecraft:/, '')));
}

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

describe('the archer list (Track E13)', () => {
  it('is the five archer kinds of the game: skeleton, stray, bogged, parched, pillager', () => {
    expect(sorted(ARCHER_TYPES)).toEqual(['bogged', 'parched', 'pillager', 'skeleton', 'stray']);
    for (const t of ARCHER_TYPES) {
      expect(classify(t), t).toBe('hostile');
      expect(isArcher({ type: `minecraft:${t}`, runtimeId: 1n }), t).toBe(true);
    }
  });

  it(`every archer and every other shooter is an id of the game (${FIXTURE_VERSION}'s recorded login)`, () => {
    const ids = gameIds();
    expect(ids.size).toBeGreaterThan(100);
    for (const t of [...ARCHER_TYPES, ...SHOOTER_TYPES]) expect(ids.has(t), t).toBe(true);
    // the evoker's Bedrock id; `evoker` is the Java name and never arrives
    expect(ids.has('evocation_illager')).toBe(true);
    expect(ids.has('evoker')).toBe(false);
  });

  it("pve's rules use the one list: DUEL_ARCHERS is ARCHER_TYPES, FLEE_RANGED is RANGED_TYPES", () => {
    expect(DUEL_ARCHERS).toBe(ARCHER_TYPES);
    expect(FLEE_RANGED).toBe(RANGED_TYPES);
    expect(DUEL_ARCHERS.has('parched')).toBe(true);
  });

  it('the ranged mobs are the archers and the other shooters; the mend hold counts the shooters but the drowned (an archer only with a trident)', () => {
    expect(sorted(RANGED_TYPES)).toEqual(sorted(new Set([...ARCHER_TYPES, ...SHOOTER_TYPES])));
    for (const t of ARCHER_TYPES) expect(SHOOTER_TYPES.has(t), t).toBe(false);
    expect(sorted(SHOOTERS)).toEqual(sorted(SHOOTER_TYPES).filter((t) => t !== 'drowned'));
    expect(isArcher({ type: 'minecraft:drowned', runtimeId: 1n })).toBe(false);
    expect(isArcher({ type: 'minecraft:drowned', runtimeId: 1n }, { get: () => ({ heldNetworkId: 7 }) })).toBe(true);
  });

  it('no other source file keeps its own list of archer types (a copy is how the parched went missing)', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
    // hostiles.ts: the lists and the collision boxes; skills/test/mobs.ts: the !test mobs catalogue (the mobs it summons)
    const allowed = new Set(['skills/combat/hostiles.ts', 'skills/test/mobs.ts']);
    const found: string[] = [];
    for (const rel of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
      const path = rel.replace(/\\/g, '/');
      if (!path.endsWith('.ts') || allowed.has(path)) continue;
      const text = readFileSync(join(srcDir, rel), 'utf8');
      if (/['"](stray|bogged|parched|pillager)['"]/.test(text)) found.push(path);
    }
    expect(found).toEqual([]);
  });
});
