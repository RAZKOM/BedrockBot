# 0017: Combat that keeps the bot alive: reachable targets, creepers first, hit and run, weapon pull

Date: 2026-10-29. Status: accepted (PLAN.md 7.4 follow-up, wave 7, Track V). Server: BDS 1.26.60.6
(`bds-pve`, flat world, difficulty normal, truth pack). Details and numbers: [../pve.md](../pve.md)
("Keeping the bot alive").

## Context

The Realm bot died 6 times on 2026-10-29: 2 arrows, 2 creeper explosions, 1 melee, 1 unknown. The
log showed a guard fight locked on an unreachable phantom while a creeper walked up, a fight held
cooked beef because the sword sat in the main inventory, and (fixed elsewhere) no eating, flee
running home through the mobs and phantoms every night. The wave-5 combat skill chased any target
the navigator might reach, gave up only after 3 failed approaches, ignored a failed target for 30 s,
fought creepers like zombies with an 8-tick back-off, and used the hotbar only. Survival of the bot
outranks finishing any command.

## Decisions

1. **Targets must be reachable, decided before the fight.** `pickThreat` (moved to
   `skills/combat/targeting.ts`; `tasks/pve.ts` keeps one-line calls) accepts a mob that is within
   reach now (eye to box at most 3.2) or that stands on, or at most 1.5 blocks above, a cell the
   navigator's own grid can stand in (`NavGrid.stand`), within 6 blocks of height and the guard
   radius. We chose the terrain query over a bounded A* per candidate: it costs a handful of cached
   cell lookups per mob every 5 ticks, and the approach still has the planner's word (3 failed
   approaches -> `unreachable`). Unknown terrain counts as reachable (benefit of the doubt).
2. **Flying mobs are fought only within reach and never chased.** Phantom, ghast, vex, blaze,
   breeze, bee, allay, parrot, bat: a fight on one only faces it and strikes within reach; 20 ticks out
   of reach ends it `unreachable` (ignored 10 s). One that hit us while out of reach is ignored for
   10 s at pick time, so the next reachable threat is picked in the same tick.
3. **Creepers outrank everything and are fought hit-and-run, inside the combat skill.** Measured on
   BDS: the fuse lights when the creeper is 2.8 to 3.4 blocks from the player (so at every
   melee strike, whose reach ends at about 3.3), the explosion follows 31 ticks later, the fuse goes
   out at 6.65 to 7.26 blocks, and the blast does 8.6 at 4 blocks and 2 at 5.5 on normal. Keeping
   a spacing band outside the fuse range is impossible, so the protocol is: sprint in (sprint
   knockback), strike, sprint away to 8 blocks at once (not waiting for the ignited flag), wait until
   the fuse has been out 10 ticks, repeat; never more than 10 ticks inside 3 blocks. A creeper that
   comes within 6 blocks during any other fight is fought first and the fight then goes back to its
   target (an interlude in the controller, so `!kill` jobs are protected too, not only guard).
   Result: 25 of 25 duels without armour killed in 95 to 142 ticks with 0 explosions and 0 damage.
4. **Below health 10 creepers are not engaged.** The combat skill runs until 11 blocks away (it keeps walking after the bot: 7.5 by the server at 10) and
   reports `creeper_avoided`; targeting still picks a creeper within 8 blocks first (so the guard
   process keeps away from it) and `PveController.wantsFlee(threat)` is true for it, for Track W's
   FleeProcess.
5. **The weapon comes from the main inventory when the hotbar has no sword or axe.** One function,
   `ensureInHotbar`, moves the best-scoring item into the hotbar (an empty slot, else the least useful
   item is parked in a free main-inventory slot) inside one inventory screen, through the task's
   `Containers.move` (the same request-id counter as every other item stack request; the Containers
   are read from what the task attached to BotSkills, never a second instance). Worn items fail the
   Track S `toolOk` predicate and are never candidates. The combat skill keeps approaching while the
   move runs and strikes only after it (at most 40 ticks). The Digger gets the same through a
   `pullTool` hook (pickaxes, axes, shovels that beat the hotbar for the block), installed by the
   combat controller like Track S installs `toolOk`.
6. **Archers: charge, or break line of sight when hurt.** Against skeletons, strays, bogged,
   parched, pillagers and a drowned holding an item the approach always sprints. Below health 10
   the bot walks to the nearest standable cell within 6 blocks with a solid cell on both lines from
   the mob's eye to the body (feet + 0.4, + 1.5) and ends the fight `took_cover` (ignored 3 s), which
   also lets the survival kit eat (it does not eat during a fight). Every own health drop while the
   nearest hostile is an archer counts as an arrow hit (`FightResult.arrowHits`, `totals.arrowHits`);
   on bds-pve the count matched the server's projectile hits exactly in every skeleton duel.
7. **Ground truth for all of it**: `truth:combatlog` (melee hits with the held item, creeper
   triggers with the nearest player's distance, explosions, projectile hits on players) and
   `truth:held`, in `packs/truth/src/combat.ts`.

## Consequences

- A guard bot no longer locks onto phantoms or mobs on roofs; it picks the zombie walking up instead
  (e2e: 0.00 blocks moved in 8 s with a phantom overhead, zombie dead 3.4 to 4.4 s after its summon).
- Creeper fights take longer (about 100 ticks instead of 60) and walk the bot 8 blocks back and forth;
  in a crowd the retreat may run into other mobs. The run-away steering falls back to the navigator
  after 6 ticks against a wall (a crater). Track W's flee owns the low-health case from here.
- The combat skill reads the containers through BotSkills' attached parts (duck-typed); a public
  `BotSkills.containers` getter would make this explicit (open issue, not in this track's files).
- A drowned is an archer whenever it holds anything (the tracker keeps the network id of the held
  item, not its name). Cover is chosen from the terrain query only; a cell behind leaves or glass
  panes does not count, and the path to it is the navigator's (it may cross the line of fire).
- `took_cover` returns control to the guard process, which may walk home after it (in the archer's
  sight). Track W's flee and the home-return rules decide what follows.
