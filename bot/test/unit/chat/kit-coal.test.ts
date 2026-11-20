// Track E5 (docs/early-game.md "Other ground"): the obtain job's coal rule counts only coal outside the base round home.
import { describe, expect, it } from 'vitest';
import { coalNearOutsideBase } from '../../../src/chat/commands-kit.ts';
import { COAL_NEAR } from '../../../src/skills/items/obtain.ts';

interface P { x: number; y: number; z: number }
function worldWith(blocks: { p: P; name: string }[]) {
  return {
    find(pred: (b: { name: string }, p: P) => boolean, o: { origin: P; radius: number; max: number }): P[] {
      return blocks
        .filter((b) => Math.hypot(b.p.x - o.origin.x, b.p.y - o.origin.y, b.p.z - o.origin.z) <= o.radius && pred({ name: b.name }, b.p))
        .slice(0, o.max)
        .map((b) => b.p);
    },
  };
}

describe('coalNearOutsideBase (Track E5)', () => {
  const me = { x: 10, y: 64, z: 10 };
  const home = { x: 10, y: 64, z: 10, r: 48 };

  it('measured on a fresh mountain world: the bot by its furnace at home, every coal within 24 is in the base: no coal', () => {
    const w = worldWith([
      { p: { x: 7, y: 59, z: 13 }, name: 'coal_ore' },
      { p: { x: 20, y: 60, z: 16 }, name: 'deepslate_coal_ore' },
    ]);
    expect(coalNearOutsideBase(w, me, home)).toBe(false);
    // no home set: as before
    expect(coalNearOutsideBase(w, me, undefined)).toBe(true);
  });

  it('coal within 24 of the bot and outside the base counts; coal past 24 does not', () => {
    const away = { x: 70, y: 64, z: 10 };
    expect(coalNearOutsideBase(worldWith([{ p: { x: 75, y: 60, z: 12 }, name: 'coal_ore' }]), away, home)).toBe(true);
    expect(coalNearOutsideBase(worldWith([{ p: { x: 70 + COAL_NEAR + 2, y: 64, z: 10 }, name: 'coal_ore' }]), away, home)).toBe(false);
    expect(coalNearOutsideBase(worldWith([{ p: { x: 75, y: 60, z: 12 }, name: 'stone' }]), away, home)).toBe(false);
  });
});
