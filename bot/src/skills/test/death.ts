// Track M5: what a death was, by its cause. The PvE measurements count deaths to mobs; a death the cells' own blocks caused
// (an earlier run's seal-in walls round the spot: `death.attack.inWall`) or the ground (a fall, lava, the void) is not a mob's,
// and a row that counted it measured the harness, not the bot. On 2026-11-16 every pve-combat death looked at was
// `death.attack.inWall`, counted as zombie hits.
//
// Two vocabularies say the same thing: the client's `death_info.cause` (a translation key, `death.attack.mob`,
// `death.attack.arrow`, `death.attack.inWall`, `death.fell.accident.generic`, ...; tasks/respawn.ts) and the server's damage
// cause (Script API `EntityDamageCause`: `entityAttack`, `projectile`, `magic`, `suffocation`, `fall`, ...; truth:hurtlog).

/** `death_info.cause` keys of a death a mob dealt: its melee, its arrow or trident, its explosion, its potion, its fireball. */
const MOB_DEATH = /^death\.attack\.(mob|arrow|explosion|magic|indirectMagic|thrown|trident|fireball|sonicBoom|thorns|wither|spit|sting|bullet|mace)\b/;

/** Server damage causes (truth:hurtlog `cause`) a mob deals. */
const MOB_DAMAGE = new Set(['entityAttack', 'projectile', 'magic', 'entityExplosion', 'thorns', 'sonicBoom', 'wither', 'ramAttack', 'maceSmash']);

/** A death message a mob caused (`death.attack.mob`, `death.attack.arrow`, ...); false for the blocks, the ground and unknowns. */
export function mobDeath(cause: string | undefined): boolean {
  return cause !== undefined && MOB_DEATH.test(cause);
}

/** A server damage cause a mob deals (`entityAttack`, `projectile`, `magic`, `entityExplosion`, ...). */
export function mobDamage(cause: string | undefined): boolean {
  return cause !== undefined && MOB_DAMAGE.has(cause);
}

/** Damage causes that mean the spot itself was not clean (a block in the body's cells). */
export const BLOCK_DAMAGE = new Set(['suffocation', 'inWall', 'fallingBlock', 'anvil', 'stalactite', 'stalagmite']);

/**
 * Why a death is not a mob's, or undefined when it is. `cause` is the death message's key; `killing` the server's cause of the
 * last hurt when the key is not known (`health_zero`, `unknown`: the message did not come).
 */
export function notMobDeath(cause: string | undefined, killing?: string): string | undefined {
  if (mobDeath(cause)) return undefined;
  const known = cause !== undefined && cause !== 'health_zero' && cause !== 'unknown';
  if (!known && killing !== undefined) return mobDamage(killing) ? undefined : killing;
  return cause ?? 'unknown';
}
