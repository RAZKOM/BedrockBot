# 0120: Two archers at the work: wall in until they are gone; one archer list (Track E13)

Date: 2026-11-21. Status: accepted. One new setting, `workArchers`, off by default. The archer lists made one. Details and
numbers: [../early-game.md](../early-game.md) "Two archers at the work (Track E13)" and [../pve.md](../pve.md) "One
archer list (Track E13)" and "Two archers at the work (Track E13)".

## Context

Track E12 (ADR 0119) left three archer gaps:

- **The parched.** The desert's skeleton was in `ARCHER_TYPES` (skills/combat/hostiles.ts) but not in pve's
  `DUEL_ARCHERS`, so the duel, the flee's shooter scan, the dodge and `workGuard` treated it as a melee mob. The lists
  did not agree elsewhere either: pve's `FLEE_RANGED` had no parched, breeze or shulker, and it and the hold's
  `SHOOTERS` had an `evoker`, an id Bedrock does not have (its evoker is `evocation_illager`; the game's own list of
  entity ids, sent at login, has 138 ids on BDS 1.26.60).
- **Two archers or more.** `workGuard` fights a lone archer for a job at work; with two it does not act (a fight on one
  left the other shooting). Then the job worked on under fire until the health was under 8, and the flee's runs ended
  16 from the archers, at their range, where the next arrow started the next run.
- **The door at dawn with two skeletons**: the same case after the night (`jobMorning`).

Measured in the early-mine scenes (`test/e2e/early-mine.test.ts`: the flat world, the stone kit, no armour, guard
off, `workGuard` on as it ships, difficulty normal; two skeletons 10 and 12 off a bot that mines 24 iron ore in the
open, the run over when the job ended and both are dead, or after 120 s): 41 to 44 damage, the lowest health 2 or 3,
16 to 23 flights, the job stopped at health 8 after 12 to 24 s with 4 to 10 of 24 mined, in 5 of 5.

## Decision

1. **One archer list.** `ARCHER_TYPES` (skeleton, stray, bogged, parched, pillager) is the list of archers;
   `SHOOTER_TYPES` (witch, blaze, ghast, breeze, shulker, evocation_illager, drowned) the other mobs that hurt from
   afar; `RANGED_TYPES` both. pve's `DUEL_ARCHERS` is `ARCHER_TYPES` and `FLEE_RANGED` is `RANGED_TYPES`; the hold's
   `SHOOTERS` is `SHOOTER_TYPES` without the drowned (an archer there only with a trident, by `isArcher`). Narrower on
   purpose: these rules go by type, so a drowned with a trident is an archer for the fight's sprint in (`isArcher`
   reads the held item) and a melee mob for the duel, the work fight and the shooter memory, as before (they were
   measured on skeletons and pillagers). A guard test holds the lists against each other, against the game's ids in
   the login fixture, and the source against a copy of an archer id elsewhere.
2. **`workArchers`: wall in until they are gone (`tasks/work-archers.ts`).** A process at the flee's priority (added
   after the flee and the rise, so a tie is its): with guard off, a job at work (`workGuard`'s test: a user job other
   than `kill`, `goto`, `come`, `follow`, not under `!pause`), two archers or more within 16 (seen or not) and one of
   them shooting (it aims at the bot with a line on it, or hit it in the last 10 s), none within 4 level (the reflex
   strikes it), no melee mob within 6 and no creeper within 8, on the ground where a shell can go up: the night
   shell's own wall (skills/survival/seal.ts: the 9 cells round the feet and the head and over it with throwaway
   blocks, or a hole dug in dirt), a bite whenever the food is under 20, and a wait until fewer than two archers are
   within 16 and the health is full for 3 s; then the side away from them is dug open and the job goes on (one archer
   left is `workGuard`'s fight, from full health). A job that has waited 60 s walled in, in all, is stopped with a
   reply that says why, and the shell stays shut. At most one shell every 5 s. Hit in the
   shell (the health 2 under the best it had there: an open cell, a blast) it ends at once, and the flee and the job
   have the body for 30 s: the flee cannot take it from a process of its own priority. No measured run was hit in a
   shell; every hit came in `workGuard`'s fight on the last archer.
   - Why it works: a skeleton that loses its line on the bot walks up to it, and at the wall it is in the reflex's
     reach. In the scene the shell opened after 16 to 41 s in 9 of 10 runs: the reflex had killed one skeleton at the
     wall (both, once), and `workGuard` fought the other from full health.

## Tried and not taken (the same scene, n5 each)

| Way | Damage a run | Lowest health | The job |
|---|---|---|---|
| none (`workGuard` on, as it ships) | 41, 42, 44, 42, 42 | 3, 3, 2, 3, 3 | stopped at health 8 in 5 of 5 (12 to 24 s, 4 to 10 of 24) |
| **wall in (chosen; 10 runs)** | 0, 0, 4, 0, 0; 5, 8, 0, 0, 9 | 20, 20, 16, 20, 20; 15, 12, 20, 20, 11 | done in 9 of 10 (57 to 87 s); stopped after 60 s walled in once (no damage) |
| walk out to 24 from them, eat, back once the work is clear | 8, 33, 8, 11, 8.5 | 16, 2, 16, 13, 15 | done in 4 of 5 (92 to 111 s); once they followed, nothing mined, the flee's runs at their range |
| wall in, then out at the nearest from full health, one at a time | 4, 8, 4, 8, 4 | 16, 12, 16, 12, 16 | done in 5 of 5 (54 to 66 s), one sortie a run, its archer killed |

Leaving gives the archers a target on the way out and back, and they follow; the sortie finishes a few seconds
sooner and costs about 5 more a run. The three ways were measured as values of one setting; the wall's last 5 runs on
the rule as it ships, before its exit for a hit in the shell was added (no run was hit in a shell, so none would have
taken it). Stopping the job and going home was not tried as a way of its own: it is the
60 s bound.

## Consequences

- The door at dawn (two skeletons 2 and 7 off the shell, the job watched 45 s after it went on, n5): none 16, 24, 0,
  4, 0 (the lowest 11, 4, 20, 16, 20); wall in 4, 0, 3, 0, 4 (16, 20, 17, 20, 16). The rule walled in once in 5 (no
  damage that run); in the others the reflex killed the near one at the shell and `workGuard` fought the other.
- The parched (one 12 off, the same mine, n5): before 12 to 20 damage, the lowest 5 to 11, no fight, the
  job stopped at health 8 in 2 of 5; after 0 damage in 5 of 5, one `workGuard` fight a run, the job done in 46 to 47 s.
- Fresh worlds (river, plains, desert, Track E11's and E12's protocol, `workGuard` on in both arms as it ships, n6
  a side): no death in either arm; before hurt 1 of 6, 4 damage in all; with the rule hurt 4 of 6, 30 in all (Track
  E12's arms on the same protocol: 17 and 15). The rule acted once: two skeletons at a mine on the plains, walled in
  with 7 blocks at health 15, the reflex killed one at the wall, the shell opened 23.5 s later at 20 and
  `workGuard` killed the other. It was not hit in its shell. The rest of the difference came in mornings where it
  never acted: lone skeletons fought by `workGuard` (7, 8; and 5 and 4 before and after the one shell) and zombies
  (3, 3); the arm with the rule met more lone archers (5 work fights against 4).
- Off by default. Better in the scene it was made for (0 to 9 damage a run against 41 to 44, the job done in 9 of 10
  against none) and not worse at the door (the highest 4 against 24), and on real ground it acted once and was not
  hurt doing it; but the fresh worlds' totals were worse with it (30 against 4, hurt 4 of 6 against 1 of 6), most
  of it in fights it took no part in, and one shell on real ground is too little to call that chance. It also leaves
  blocks in the world. It is the candidate to turn on after a series on rough ground or the Realm. It acts only with guard off (a bot with
  guard on is unchanged), only while two archers shoot at a job at work, and with the night shell's wall, the
  reflex and `workGuard` as they are; a hit in the shell gives the body back to the flee. It leaves up to 8 blocks
  of its shell where the job was.
- Not proven: anything on the Realm; armour or a better blade; three archers or more; archers with melee mobs; a
  shell on a slope, a ledge or in water; skeletons that keep away from the wall (once in 10 the reflex's strikes at
  the wall did not kill, and the job was stopped after 60 s); a pillager's crossbow against the shell.
