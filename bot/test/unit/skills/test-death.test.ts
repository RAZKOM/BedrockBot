// Track M5: a death's cause, a mob's or the harness's (skills/test/death.ts).
import { describe, expect, it } from 'vitest';
import { mobDamage, mobDeath, notMobDeath } from '../../../src/skills/test/death.ts';

describe('death causes (Track M5)', () => {
  it('the death messages a mob causes', () => {
    for (const c of ['death.attack.mob', 'death.attack.arrow', 'death.attack.explosion.player', 'death.attack.magic', 'death.attack.indirectMagic', 'death.attack.thrown', 'death.attack.trident', 'death.attack.fireball', 'death.attack.sonicBoom']) {
      expect(mobDeath(c), c).toBe(true);
    }
  });

  it('the blocks, the ground, a player and unknowns are not a mob', () => {
    for (const c of ['death.attack.inWall', 'death.attack.fall', 'death.fell.accident.generic', 'death.attack.lava', 'death.attack.outOfWorld', 'death.attack.generic', 'death.attack.player', 'death.attack.drown', 'health_zero', 'unknown', undefined]) {
      expect(mobDeath(c), String(c)).toBe(false);
    }
  });

  it('the server damage causes a mob deals', () => {
    for (const c of ['entityAttack', 'projectile', 'magic', 'entityExplosion']) expect(mobDamage(c), c).toBe(true);
    for (const c of ['suffocation', 'fall', 'lava', 'override', 'fireworks', undefined]) expect(mobDamage(c), String(c)).toBe(false);
  });

  it('why a death is not a mob\'s: the message first, the killing hit when the message did not come', () => {
    expect(notMobDeath('death.attack.mob')).toBeUndefined();
    expect(notMobDeath('death.attack.inWall')).toBe('death.attack.inWall');
    expect(notMobDeath('death.attack.inWall', 'entityAttack')).toBe('death.attack.inWall'); // the message wins
    expect(notMobDeath('health_zero', 'projectile')).toBeUndefined();
    expect(notMobDeath('health_zero', 'suffocation')).toBe('suffocation');
    expect(notMobDeath('unknown')).toBe('unknown');
    expect(notMobDeath(undefined)).toBe('unknown');
  });
});
