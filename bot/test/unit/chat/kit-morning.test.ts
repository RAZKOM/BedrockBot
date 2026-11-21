// Track E9 (docs/early-game.md "The way home and the morning after", ADR 0111): the morning rule's pure part
// (chat/kit-morning.ts): when a job that waited out the night may go on, on the mornings Track E7's and this track's
// fresh-world runs measured.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { censusText, MORNING_BURN, MORNING_MAX, MORNING_NEAR, MORNING_SUN, MORNING_WAY_MS, MORNING_WAY_RADIUS, morningBlock, morningWayRadius, nearestHolding, ticksSinceDawn, type MorningMob } from '../../../src/chat/kit-morning.ts';
import { DAWN, DUSK } from '../../../src/tasks/night.ts';

const at = (tod: number, mobs: MorningMob[] = []) => morningBlock({ time: 5 * 24000 + tod, dawn: DAWN, dusk: DUSK, mobs });
const mob = (type: string, dist: number, burning = false): MorningMob => ({ type, dist, burning });
/** The first tick the rule lets a clear morning go (60 of the day). */
const GO = (MORNING_SUN + MORNING_BURN) % 24000;

describe('Track E9: the morning rule (kit-morning.ts)', () => {
  it('ticks since the night rule`s dawn wrap over the day`s start', () => {
    expect(ticksSinceDawn(23000, DAWN)).toBe(0);
    expect(ticksSinceDawn(23999, DAWN)).toBe(999);
    expect(ticksSinceDawn(24000 * 3 + 0, DAWN)).toBe(1000);
    expect(ticksSinceDawn(24000 * 3 + 2000, DAWN)).toBe(3000);
  });

  it('until the sun is up the job waits, whatever is near; then for as long as the undead take to burn', () => {
    // measured on a plain: the first fire damage at 23446 to 23640, the last of those that burned gone at 39
    expect(at(DAWN)).toBe('the sun is not up');
    expect(at(MORNING_SUN - 1)).toBe('the sun is not up');
    expect(at(MORNING_SUN)).toBe('the undead are burning');
    expect(at(23_900)).toBe('the undead are burning');
    expect(at(GO - 1)).toBe('the undead are burning');
    expect(at(GO)).toBeUndefined();
    expect(GO).toBe(60);
    expect(at(400)).toBeUndefined();
  });

  it('after that a live hostile within MORNING_NEAR holds it, named with its distance; farther off does not', () => {
    // the run that died 13 s after its shell opened: two creepers, three skeletons and a zombie round the shelter
    expect(at(GO + 40, [mob('creeper', 9.4), mob('skeleton', 21)])).toBe('a creeper 9 blocks off');
    expect(at(GO, [mob('witch', 4.2)])).toBe('a witch 4 blocks off');
    expect(at(GO, [mob('enderman', 6)])).toBe('an enderman 6 blocks off');
    expect(at(GO, [mob('creeper', MORNING_NEAR + 0.5)])).toBeUndefined();
    expect(at(GO, [])).toBeUndefined();
    // a zombie in the shade does not burn, and one that burns still bites: both hold while they live
    expect(at(GO, [mob('zombie', 10, false)])).toBe('a zombie 10 blocks off');
    expect(at(GO, [mob('zombie', 10, true)])).toBe('a zombie 10 blocks off');
    expect(nearestHolding([mob('zombie', 13), mob('creeper', 12), mob('witch', 20)])?.type).toBe('creeper');
  });

  it('never past MORNING_MAX ticks after dawn, by night, or with the time unknown', () => {
    const witch = [mob('witch', 4)];
    const cap = (DAWN + MORNING_MAX) % 24000;
    expect(at(cap - 1, witch)).toBe('a witch 4 blocks off');
    expect(at(cap, witch)).toBeUndefined(); // the one that stood 4 blocks off past the shell's 90 s: the wait ends, said in the dawn line
    expect(at(6000, witch)).toBeUndefined();
    expect(at(13000, witch)).toBeUndefined(); // the night is the dusk rule's
    expect(morningBlock({ time: undefined, dawn: DAWN, dusk: DUSK, mobs: witch })).toBeUndefined();
    expect(GO).toBeLessThan(cap);
  });

  it('the census names what is near, nearest first, burning said', () => {
    expect(censusText([])).toBe('none');
    expect(censusText([mob('skeleton', 21.2), mob('creeper', 9.4), mob('zombie', 14, true)])).toBe('creeper 9, zombie 14 (burning), skeleton 21');
    expect(censusText([mob('a', 1), mob('b', 2), mob('c', 3)], 2)).toBe('a 1, b 2, 1 more');
  });
});

describe('Track E11: the walk out after the night (`morningWay`, kit-morning.ts morningWayRadius)', () => {
  it('widens the avoidance only when on, and never narrows the owner`s own', () => {
    expect(morningWayRadius({ on: false, base: 4 })).toBeUndefined();
    expect(morningWayRadius({ on: true, base: 4 })).toBe(MORNING_WAY_RADIUS);
    expect(morningWayRadius({ on: true, base: 0 })).toBe(MORNING_WAY_RADIUS); // avoidance off by the owner: on for the walk out
    expect(morningWayRadius({ on: true, base: 16 })).toBeUndefined();
    expect(morningWayRadius({ on: true, base: 20 })).toBeUndefined();
    expect(MORNING_WAY_RADIUS).toBe(MORNING_NEAR);
    expect(MORNING_WAY_MS).toBe(120_000);
  });
});

describe('Track E11 guards (decision 0117)', () => {
  it('the setting is off, and the guide and the decision record name the rules and their numbers', () => {
    const SETTINGS = readFileSync(new URL('../../../src/config/settings.ts', import.meta.url), 'utf8');
    const DOC = readFileSync(new URL('../../../../docs/early-game.md', import.meta.url), 'utf8');
    const ADR = readFileSync(new URL('../../../../docs/decisions/0117-early-leftovers-round-two.md', import.meta.url), 'utf8');
    expect(SETTINGS).toMatch(/morningWay: \{ kind: 'boolean', default: false,/);
    const from = DOC.indexOf('\n## Early-game leftovers, round two (Track E11)\n');
    expect(from).toBeGreaterThan(0);
    const part = DOC.slice(from);
    for (const [k, v] of [['MORNING_WAY_RADIUS', MORNING_WAY_RADIUS], ['MORNING_WAY_MS', MORNING_WAY_MS]] as const) expect(part).toContain(`\`${k}\` ${v}`);
    for (const w of ['morningWay', 'OBTAIN_COOK_RETRIES']) {
      expect(part).toContain(w);
      expect(ADR).toContain(w);
    }
  });
});

describe('Track E9 guards (decision 0111)', () => {
  it('the setting, the guide and the decision record name the rule and its numbers', () => {
    const SETTINGS = readFileSync(new URL('../../../src/config/settings.ts', import.meta.url), 'utf8');
    const DOC = readFileSync(new URL('../../../../docs/early-game.md', import.meta.url), 'utf8');
    const ADR = readFileSync(new URL('../../../../docs/decisions/0111-way-home-and-morning.md', import.meta.url), 'utf8');
    expect(SETTINGS).toMatch(/jobMorning: \{ kind: 'boolean', default: (true|false),/);
    const from = DOC.indexOf('\n## The way home and the morning after (Track E9)\n');
    expect(from).toBeGreaterThan(0);
    const part = DOC.slice(from);
    for (const [k, v] of [['MORNING_SUN', MORNING_SUN], ['MORNING_BURN', MORNING_BURN], ['MORNING_NEAR', MORNING_NEAR], ['MORNING_MAX', MORNING_MAX]] as const) expect(part).toContain(`\`${k}\` ${v}`);
    expect(part).toContain('jobMorning');
    expect(ADR).toContain('jobMorning');
  });
});
