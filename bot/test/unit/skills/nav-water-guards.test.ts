// Decision 0070 guards (docs/pathfinding.md "Water (Track W1)"): the air budget keeps the SurfaceProcess out of
// a planned dive, the coarse layer's swim price stays within the fine planner's water prices, and the guide names
// every station of the water course and every water cost with its shipped value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WATER_STATIONS } from '../../../../packs/truth/src/water-layout.ts';
import { SWIM_CLEARANCE, SWIM_TICKS } from '../../../src/skills/coarse/costs.ts';
import { DEFAULT_COSTS } from '../../../src/skills/nav/costs.ts';
import { AIR_FLOOR, AIR_KEEP, AIR_MARGIN, AIR_MAX, AIR_MIN_BUDGET, airBudget, diveGoalBudget } from '../../../src/skills/nav/water.ts';
import { SURFACE_AIR } from '../../../src/tasks/process/surface.ts';

const DOC = readFileSync(new URL('../../../../docs/pathfinding.md', import.meta.url), 'utf8');
const ADR = new URL('../../../../docs/decisions/0070-water-travel.md', import.meta.url);

/** The text of `## <heading>` up to the next `## `. */
function section(heading: string): string {
  const at = DOC.indexOf(`\n## ${heading}\n`);
  expect(at, `docs/pathfinding.md has "## ${heading}"`).toBeGreaterThan(0);
  const next = DOC.indexOf('\n## ', at + 4);
  return DOC.slice(at, next < 0 ? undefined : next);
}

describe('water travel guards (decision 0070)', () => {
  it('a planned stretch under water ends above the SurfaceProcess threshold (the escape never cuts a planned dive)', () => {
    expect(AIR_KEEP).toBeGreaterThan(SURFACE_AIR);
    expect(AIR_MAX - airBudget(undefined, false) * AIR_MARGIN).toBeCloseTo(AIR_KEEP, 6);
    // a start under water: down to AIR_FLOOR at the margin; the goal budget never above the way-up budget
    for (const air of [-20, 0, 30, 60, 110, 200, 300]) {
      expect(airBudget(air, true)).toBeGreaterThanOrEqual(AIR_MIN_BUDGET);
      expect(diveGoalBudget(air, true)).toBeLessThanOrEqual(airBudget(air, true));
      expect(AIR_FLOOR + diveGoalBudget(air, true) * AIR_MARGIN).toBeCloseTo(air, 6);
    }
  });

  it('the coarse swim price lies within the fine planner\'s water prices, its opening fits the body', () => {
    expect(SWIM_TICKS).toBeGreaterThanOrEqual(Math.min(DEFAULT_COSTS.swim, DEFAULT_COSTS.diveUp));
    expect(SWIM_TICKS).toBeLessThanOrEqual(DEFAULT_COSTS.dive);
    expect(SWIM_CLEARANCE).toEqual({ height: 2, width: 1 });
  });

  it('the guide names every station and every water cost with its shipped value, and links the decision', () => {
    const s = section('Water (Track W1)');
    expect(s).toContain('decisions/0070-water-travel.md');
    expect(() => readFileSync(ADR, 'utf8')).not.toThrow();
    for (const name of WATER_STATIONS) expect(s, `station ${name}`).toContain(`\`${name}\``);
    const named = (id: string, v: number) => expect(s, `${id} ${v}`).toMatch(new RegExp(`\`${id}\`\\s+${String(v).replace('.', '\\.')}\\b`));
    for (const k of ['dive', 'diveUp', 'diveDown', 'diveEnter', 'underwater'] as const) named(k, DEFAULT_COSTS[k]);
    named('SWIM_TICKS', SWIM_TICKS);
    named('AIR_KEEP', AIR_KEEP);
    named('AIR_MIN_BUDGET', AIR_MIN_BUDGET);
    named('AIR_MARGIN', AIR_MARGIN);
  });
});
