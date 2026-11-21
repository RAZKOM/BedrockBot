# 0119: The mine's dangers: a lone archer and a witch fought for the work, a creeper under the feet (Track E12)

Date: 2026-11-21. Status: accepted. Two new settings, `workGuard` and `creeperRise`, both off by default (`workGuard` on by default since the addendum below). No fight,
flee or reflex rule changes while they are off. Details and numbers: [../early-game.md](../early-game.md) "The mine's
dangers (Track E12)" and [../pve.md](../pve.md) "A job at work and the shooters" and "A creeper under the feet".

## Context

Track E11's fresh-world bots died after the night at their mine, not on the way there: an arrow while mining, a
witch's potion while mining, a creeper's blast while the bot dug its own pillar down onto it (a zombie at its foot
too), and a fall in a flight after two skeletons at the shelter's door had shot the job as it went on. Each was built
as a scene on the flat test server (`test/e2e/early-mine.test.ts`: the early kit, a stone sword and no armour, guard
off as it ships, difficulty normal) and measured with the rules as they were, n5 or more a scene:

- **The bot knew.** In every scene the mobs were in the bot's entity list from the first tick after they were
  summoned, 6 to 17 blocks off. Nothing was missed; the rules chose not to act.
- **A witch at 8.** 26 to 29 damage a minute, the lowest health 1 in 5 of 5, no fight. With guard off the flee leaves
  a witch the bot "fights first" (`firstTarget`: a blade, her range, the health, a line on her) alone, a rule written
  for guard on, and with guard off nobody fights her: she was neither fought nor run from.
- **Archers at 10 to 12.** One skeleton: 24 to 29 damage a minute, the lowest 4 to 6; two: 20 to 30, the lowest 3
  to 5. The reflex strikes only what comes in reach and the flee starts below 8, so the work went on under fire
  until the flee, then came back to the ore and was shot again (2 to 11 flights a minute).
- **The door at dawn.** Two skeletons at 2 and 7 blocks from the night shell (`jobMorning` on): the reflex struck the
  near one in reach, and the job went on with the other still shooting: 0 to 23 damage in its first 45 s, the lowest
  4 to 20.
- **The pillar.** A creeper cannot climb; it waits at the pillar's foot and lights as the body comes down to about 3
  blocks over it. The reflex strikes it as it comes in reach: most runs took 1.6 or less, 2 of 21 took 17 and 18.6.

## Decision

1. **`workGuard` (off): guard's own fight takes the shooters at the work (`PveController.workThreat`).** With guard off,
   a job at work (a user process other than `kill`, `goto`, `come`, `follow`; not under `!pause`; a blade in the
   hotbar), guard's process (priority 60, its approach and the reflex as they are) fights:
   - a witch the bot fights first by `firstTarget` (within 10 of height), before anything else;
   - else, at 14 health or more (`WORK_ARCHER_HEALTH`), the nearest archer (skeleton, stray, bogged, pillager)
     within 16 and 6 of height with a line on the bot that aims at it or hit it in the last 10 s, **only while it is
     the only archer within that range**, seen or not, aiming or not (`WORK_ARCHERS_MAX` 1); a fight for the work on
     an archer ends when a second comes within the range.

   A fight for the work does not walk home after it; mobs guard ignores stay ignored. Not chosen: a second combat
   loop, or changing `canDuel` or the flee's triggers (below `fleeHealth` the flight on foot comes as before).
   - Why a lone archer, measured on the way: with every aiming archer fought, two skeletons gave the damage and the
     lowest health of no fight (30, 29, 25, 25, 19 against 30, 26, 20, 26, 25; the lowest 3 to 8 against 3 to 5) and
     nothing mined: the first died in 5 of 5, and its 7 to 10 s of approach and fight cost about 8 health while the
     second shot. Counting only the archers that aimed and were in sight changed little, and one run of 5 died (a
     second fight begun at 12 health against a skeleton 16 off ended at 3 in the flee); counting those in sight still
     let a fight begin in 3 of 5, because a second archer comes into range after the first. Hence every archer in
     range counts, the health bar, and the end of the fight when a second comes.
2. **`creeperRise` (off): up 2 when a creeper's fuse burns under the feet (`tasks/creeper-rise.ts`).** A process at the
   flee's priority (added after it, so a tie is its): while a live creeper at least 2 blocks below the feet and within
   3 level has its fuse lit, with 2 throwaway blocks and the two cells over the head free, the body goes 2 blocks up
   by the navigator's own pillar move (place only, no digging) and stands until that creeper is gone or 3 s pass;
   then the job plans again. Not for a creeper on the bot's level (going up next to it stays in its blast: that is
   the flee's back-off, `creeperReach`).

## Consequences

- With `workGuard` on, in the scenes (n5 a side): a witch 0 to 5 damage a minute against 26 to 29, the lowest 17 to
  20 against 1; one archer 0 to 4 against 24 to 29, the lowest 16 to 20 against 4 to 6; the door 0 to 5 against 0 to
  23, the lowest 15 to 20 against 4 to 20; two archers 24 to 29 against 20 to 30, the lowest 3 to 4 against 3 to 5
  (the rule does not act). No death in any arm of the final rule.
- With `creeperRise` on (15 runs against 21): the blast comes 4 to 5 under the feet and the worst runs are gone (the
  highest 9.9 against 18.6, the lowest health 12.1 against 5.4), but its push throws the body off a one-wide top in 14
  of 15, so a run costs about 6 (mean 6.0 against 4.0; median 6.0 against 1.6). It ships off: it trades a rare
  near-fatal blast for a sure small one.
- Fresh worlds (river, plains, desert, n6 a side, Track E11's protocol with `morningWay` off): 0 deaths in either
  arm (Track E11: 2 of 6 in each, at the mine on the river world); hurt 4 of 6 off and 2 of 6 on; damage 17 and 15
  in all; the nearest hostile on the walk out a median 3.3 and 4.6. With both on, one fight for the work in 6
  mornings (a skeleton at 1.8, killed) and no rise; three earlier mornings with a looser archer count had 4 fights and
  2 rises, no death.
- Both ship off. `workGuard` is not worse in any scene and better in three, and the fresh worlds show nothing worse,
  but it changes how the bot fights and walks up to 16 blocks to an archer over ground the scenes do not have; on real
  ground it fought once in 6 mornings, too few to call it not worse there. It is the first candidate to turn on after
  a series on rough ground or the Realm. `creeperRise` costs more on average than it saves.
- No pve rule counts the parched (the desert's archer) as an archer: it is in `ARCHER_TYPES` (skills/combat/hostiles.ts)
  but not in pve's `DUEL_ARCHERS`, which the duel, the flee's shooter scan and `workGuard` use (one desert morning
  took 7 from one). Not changed here: it touches every archer rule.
- Not proven: anything on the Realm; armour (every scene was bare); more than one witch, or a witch with archers; a
  fight for the work over rough ground (one on the fresh worlds); the rise on a ledge wider than one block, where the
  push may leave the body standing; two creepers under the feet; a death in any scene (none of them killed the bot,
  so their measure is the damage and the lowest health).

## Addendum: `workGuard` on by default

`workGuard` is on by default. It acts only while guard is off, and then uses guard's own fight, the one a bot with
guard on already runs over real ground, held to a narrower case than guard (a witch firstTarget accepts, or a lone
archer that aims at the bot or hit it in the last 10 s, in sight, within 16, at 14 health or more; a second archer
stops it). It was not worse in any scene, better in three (the witch, one archer, the door at dawn), and on the fresh
worlds hurt 2 of 6 mornings against 4 of 6 with no death either way. A bot with guard on is unchanged. `creeperRise`
stays off: it cost more than it saved.
