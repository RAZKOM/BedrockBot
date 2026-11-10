# PvE, guard, follow (PLAN.md tasks 7.4, 7.5 and the commands of 7.6)

> Since wave 6 (task 7.8) guard, flee, follow, come and kill run as processes on the process manager (docs/processes.md: priorities, pre-emption, `!pause` / `!resume` / `!stop`). Where this page describes the wave-5 cooperation (`ownsMovement`, night safety's `inactive`, follow keeping the bot outside at night), docs/processes.md is the current rule: night now outranks user commands once a shelter is set.

**PvE only. The bot never attacks a player, under any command**: the combat skill itself refuses any
entity of type `minecraft:player` or with a username, every target list skips players, and
`!kill player` / `!kill <a player's name>` is refused with a reply. Decision record:
[decisions/0011-pve-and-follow.md](decisions/0011-pve-and-follow.md).

The goal is that the owner's Realm can run on normal difficulty with the bot surviving nights. All
of it runs on the hardened AFK task when walking is on (`--walk`, `--home`, `--shelter` or a Realm
target); without walking every command answers `<cmd> needs a task that can walk (...)`.

## Files

| Path | What |
|---|---|
| `bot/src/skills/combat/hostiles.ts` | `classify(type)` (hostile / neutral / passive / player / item / other), type-name matching (`zombified_piglin` = `zombie_pigman`, `villager` = `villager_v2`), entity feet / box / reach, `MobTracker`: per-mob health, creeper fuse, `target_eid`, hurt and death animations, own health drops and the `lastHitBy` guess |
| `bot/src/skills/combat/combat.ts` | `CombatController`: `fight(runtimeId, opts)`, `attack(runtimeId)`, `selectWeapon()`, `pullWeapon()`, the attack packet builders, `coverCell` |
| `bot/src/skills/combat/reflex.ts` | Track M1: the reflex (strikes the hostile that reaches the bot soonest, under every task; never a friend) |
| `bot/src/skills/survival/seal.ts` | Track M1: the seal-in (a shell of throwaway blocks, or a hole dug under the feet) |
| `bot/src/skills/test/mobs.ts` | Track M1: `!test mobs` (the gauntlet's sets on the Realm under testMode) |
| `bot/src/skills/combat/targeting.ts` | Track V: `isThreat`, `nearestHostile`, `pickThreat` (reachability-aware, creepers first), `reachability`, `wantsFlee(threat)`, `afterFight` / `ignoreMsAfter`; Track AH: `inReach` / `pickInReach` (re-targeting), `crowdOf` / `crowded` / `crowdThreat` (crowd rule) |
| `bot/src/skills/combat/pathReach.ts` | Track AO: `PathReach` (bounded probe plans from the bot to a mob, verdicts cached per mob, `stats`), `mobGoal`, `pathVerdict`, `probeNavOf`; targeting.ts adds `lineOfSight`, `ignoreMob`, `userWalking`, `walkThreat`, `parseWalkRule` |
| `bot/test/unit/skills/targeting-walls.test.ts`, `bot/test/e2e/pve-walls.test.ts` | Track AO unit tests (fakes and a generated flat world) and e2e on bds-pve (a glass pen, a window, the open, all during a `!goto`) |
| `bot/src/skills/combat/shield.ts` | Track AH: `ShieldController`: shield into the offhand, archer shot prediction (`threat`, `shotDue`), the offhand item stack request |
| `packs/truth/src/shield.ts` | Track AH: truth commands `stance` (isSneaking, offhand item and durability) and `blocklog` (mob melee swings and projectiles reaching a player, with the stance and the shield's durability) |
| `bot/test/unit/skills/combat-v3.test.ts`, `bot/test/e2e/pve-crowd.test.ts` | Track AH unit tests on fakes; e2e (crowd rule, shield) on bds-pve; the re-targeting e2e is in `pve-combat.test.ts` |
| `bot/src/skills/container/hotbar-moves.ts` | Track V: `ensureInHotbar` (main inventory -> hotbar through the task's Containers), `HotbarPuller` (failure memory, the Digger's `pullTool` hook), `digToolScore` |
| `bot/src/skills/follow/follow.ts` | `FollowController`: `follow({ runtimeId } \| { playerName })`, `come(playerName)`, `stop()` |
| `bot/src/tasks/pve.ts` | `PveController`: guard, flee, follow, come, kill, a resumable goto, behaviour line, options |
| `bot/src/chat/commands-pve.ts` | `!follow` `!come` `!stop` `!guard` `!kill` (with `now`), `!sleep`; wires the survival kit, the sleep controller and the night yield (Track W) |
| `bot/src/tasks/process/readiness.ts` | trip readiness (Track W): `needsPrep`, `longTrip`, `hasChestplate`, `checkTrip`, `splitNow`, `prepareTrip` |
| `bot/src/tasks/process/locator.ts` | `PlayerLocator`: far players from `player_list` + `player_location` / `locator_bar` (Track W) |
| `packs/truth/src/gaunt.ts` | truth commands `bed`, `sleeping` (Track W) |
| `docker/compose.gaunt.yml` | `bds-gaunt`, udp/19188, flat, difficulty normal (Track W) |
| `bot/test/unit/flee-readiness.test.ts`, `night-bed.test.ts`, `skills/sleep.test.ts` | unit tests (Track W) |
| `bot/test/e2e/gaunt-{come,flee,trip,sleep}.test.ts`, `gaunt-truth.ts` | e2e on bds-gaunt (Track W) |
| `bot/src/tasks/registry.ts` | the afk task builds a `PveController` with its movement stack (see "Shared files") |
| `packs/truth/src/pve.ts` | truth commands `summon`, `mobs`, `near`, `entity`, `killmobs`, `clearmobs`, `sethealth`, `movemob`, `effect`, `hurtlog` (packs/truth/README.md) |
| `packs/truth/src/combat.ts` | Track V: truth commands `combatlog` (melee hits with the held item, creeper triggers, explosions, projectile hits on players) and `held` |
| `docker/compose.pve.yml` | `bds-pve`, udp/19144, flat, difficulty normal |
| `bot/test/unit/skills/{combat,follow,pve}.test.ts`, `pve-fakes.ts` | unit tests on fakes |
| `bot/test/unit/skills/{targeting,combat-survive,hotbar-moves}.test.ts`, `combat-fakes.ts` | Track V unit tests on fakes |
| `bot/test/e2e/pve-{combat,follow,night,creeper}.test.ts`, `pve-truth.ts` | e2e on bds-pve |

## Using it

```sh
pnpm --filter bot start -- --task afk --home 14,-60,-9 --guard 16                  # guard home from the start
pnpm --filter bot start -- --task afk --walk --owner YourName                       # then !guard on, !follow ...
pnpm bot:realm -- --home 100,64,-50 --shelter 90,64,-44 --guard 16 --flee-health 8  # the Realm (you run this)
```

Config file (`tasks.afk`): `"tasks": { "afk": { "guard": 16, "fleeHealth": 8 } }` (`guard` may also be
`true`, `false` or `{ "on": true, "radius": 24 }`). CLI flags win.

| Command (owner only) | Effect |
|---|---|
| `!follow [name] [now]` | follow the player (default: the sender) until `!stop` (trip readiness at the start) |
| `!come [name] [now]` | one walk to within 2 blocks of the player's current position (beyond the entity range: to the locator bar position first); trip readiness |
| `!stop` | cancel follow / come / kill / a fight / a goto; guard stays as set |
| `!guard [status]`, `on`, `off`, `<radius>` | guard mode (default radius 16) |
| `!kill <type> [n]` | kill up to n (1..64, default 1) mobs of that type within 32 blocks, nearest first, picking up drops after each; players refused |
| `!status` | adds `behaviour ...`: `idle`, `guarding r=16`, `following Steve`, `coming to Steve`, `fighting zombie`, `fighting zombie (in place)`, `collecting drops`, `fleeing`, `walking to x y z`, `returning home`, `fighting zombie (kill zombie 1/3)` |

Settings (`!set`, Track AO): `guardReach` (0..64 path blocks, default 24; 0 = no path check) and
`guardWhileWalking` (`reach` | `near` | `all`, default `near`); see "Path-reachable targets".

`task.status()` (metrics `taskStatus.pve`) has `behaviour`, `guard`, `fleeHealth`, `health`, `target`,
`follow` (state, distance, last known position), `lastHitBy`, counters, and (Track AO) `ignored` and
`probes`; metrics counters
`pve.guard`, `pve.fights`, `pve.kills`, `pve.flees`, `pve.fight.<outcome>`.

## Behaviour

**Foreground and episodes.** The owner's behaviour (idle, follow, come, a goto from `!goto` /
`!home go`, kill) is the foreground. A guard fight (fight, then pick up drops within 8 blocks) or a
flight is an episode that suspends it and, when no other threat is in range, resumes it: follow
starts again, the goto is re-issued (its chat reply comes when it really ends). An idle bot with a
home walks back home after a guard fight. Rules are evaluated every 5 ticks.

**Guard** (`!guard on`): targets are hostiles, plus neutral mobs that hit the bot in the last 10 s or
target it (`target_eid`), never players, passive mobs or items. Range: within the radius of home (of
the bot when no home is set, while following or a command runs, and while the bot is farther than the
radius from home; a mob that hit the bot in the last 10 s whatever the centre) and at most radius + 16
from the bot, within 6
blocks of height, and reachable ("Targeting" below, wave 7). Priority: a creeper within 6 blocks,
then the mob that hit us, then mobs targeting us, then the nearest. After a fight the mob is ignored
for 10 s (`out_of_range`, `unreachable`), 3 s (`took_cover`), not at all (`killed`,
`creeper_avoided`, `interrupted`) or 30 s (anything else).

**Flee** (v2 since wave 7, see "Flee v2" below): health below `fleeHealth` (default 8) with a hostile
within 16, or a creeper within 6 with health below 10: run away first, home only when the threat is
not between, eat when 8 clear, keep away until the health is back to fleeHealth + 6. While the health
stays low, guard only defends in place (hostiles within reach, no walking). The bot does not face the
attacker while running (the navigator owns the yaw).

**Night shelter cooperation.** While night safety wants the shelter (dusk to dawn, a shelter set):
inside it guard only defends in place; on the way there neither guard nor flee interrupts (that
would count as a failed retreat). While a PvE behaviour owns the movement (any episode or a
non-idle foreground) night safety pauses, so an explicit `!follow` keeps the bot out until `!stop`.
After a death, follow / come / kill / the episode are dropped (guard stays on); the after-respawn
home hook walks home as before.

**Fight** (`CombatController.fight`): picks the best hotbar weapon (sword > axe > anything; with no
sword or axe in the hotbar one is moved in from the main inventory first, "Weapon pull"); farther
than 3.5 blocks (or another level): navigator `near` goal radius 2.5, re-planned when the target moved
1.5 blocks, sprint beyond 8 (always against archers and creepers), pitch towards the target; within
3.5 blocks on the same level: the navigator is cancelled and the controller steers (yaw at most 40
degrees per tick towards the target, pitch at its upper body, forward while farther than 2.2, back
while closer than 1.0). Strike when the eye is within 3.0 of the target's box, the view within 35
degrees and 10 ticks after the last strike. Creepers: hit and run ("Creepers"); a creeper coming
within 6 blocks during any other fight is fought first, then the fight goes back to its target
(`FightResult.interludes`). Archers: sprint straight in; below health 10 take cover ("Ranged mobs").
Flying mobs: never chased (struck only within reach). Ends `killed` (death animation or health 0),
`gone`, `exploded`, `out_of_range` (farther than 32 for 100 ticks), `timeout` (1200 ticks),
`unreachable` (3 failed approaches; a flying target 20 ticks out of reach), `creeper_avoided`,
`took_cover`, `interrupted` or `refused_player`. `approach: false` = defend in place.

**Follow**: `near` goal radius 3 around the target's feet, re-planned when it moved more than 2 blocks
since the last plan (not while the last walk reached it), sprint when more than 8 away, stop and face
it within 3. When the target leaves the tracked set: walk to its last known position (or, after a
teleport followed by leaving view within 2 s, to where it was before the jump) and wait there;
resume when it is tracked again. Players are found by the `add_player` username (case-insensitive,
`§` codes stripped).

## Keeping the bot alive (wave 7, Track V)

Why: the Realm bot died 6 times on 2026-10-29 (2 arrows, 2 creeper explosions, 1 melee, 1 unknown);
a guard fight locked on an unreachable phantom while a creeper walked up, and a fight held cooked
beef because the sword was in the main inventory. Decision record:
[decisions/0017-combat-that-keeps-the-bot-alive.md](decisions/0017-combat-that-keeps-the-bot-alive.md).

### Targeting (`skills/combat/targeting.ts`)

`PveController.pickThreat` / `isThreat` / `nearestHostile` are one-line calls into this module.

- **Reachable or not a target.** A candidate is (a) within reach now: eye to box at most 3.2, or (b)
  standing on, or at most 1.5 blocks above, a cell the navigator's grid can stand in
  (`NavGrid.stand` on the cells under its box), within 6 blocks of height and the guard radius
  (`reachability(grid, me, e)` -> `'now' | 'cell' | false`). Unknown terrain counts as (b).
- **Flying mobs** (phantom, ghast, vex, blaze, breeze, bee, allay, parrot, bat, happy ghast) only
  under (a), never chased. One that hit the bot while out of reach is ignored for 10 s and the next
  reachable threat is picked in the same evaluation. A fight on a flying mob only faces it and
  strikes within reach; 20 ticks out of reach end it `unreachable`.
- **Rank**: a creeper within 6 blocks first, then the mob that hit us (10 s), then mobs targeting us,
  then the nearest.
- **Below health 10** creepers are not engaged: a creeper within 8 blocks is still picked first, and
  the fight on it only runs until it is 11 blocks away (`creeper_avoided`); in place (health below
  `fleeHealth`, inside the shelter) creepers are never picked. `PveController.wantsFlee(threat)` is
  true for a creeper within 8 blocks below health 10 (the hook for Track W's FleeProcess).
- **After a fight** (`afterFight`, also the guard process): `out_of_range` 10 s, `unreachable` 30 s
  (Track AO; was 10 s), `took_cover` 3 s, `killed` / `creeper_avoided` / `interrupted` / `crowded` (Track AH) not ignored,
  anything else 30 s. The ignore list never blocks another mob: the next one is picked on the next
  evaluation.

#### Re-targeting within reach (wave 9, Track AH, decision 0029)

The owner asked why the bot does not always target whatever is within its reach instead of risking being hit.
Track W saw a guard fight stay locked on one zombie while a second one landed 10 hits. Inside a fight
(`CombatController`, `targeting.inReach` / `pickInReach`):

- **On every strike cycle** (10 ticks after the last strike) the target is re-picked among the
  threats within reach (eye to box at most 3.2; players, the dead and, below health 10 or in place,
  creepers left out): **a mob that hit us in the last 10 s first, then a creeper, then the nearest**;
  the current target gets a 0.3-block bonus so two equidistant mobs do not flap.
- **A target out of reach while another threat is in reach is dropped at once** (no chase while
  anything is in reach), except right after our own strike knocked it there: then the decision waits
  for the next strike cycle (it usually walks back into reach by then).
- **The new target is faced at once** (one tick, not 40 degrees per tick). BDS does not check the view
  direction of an attack strictly (Packets); a 180-degree turn at 40 per tick cost 5 ticks per switch.
- **Kill, next**: when the target dies another threat within reach is fought next in the same fight;
  when nothing is in reach and the fight was switched away from the requested target, it goes back
  to it. `FightResult` keeps the requested target (`runtimeId`, `type`, `ok` = it died) and adds
  `retargets` (switches away from a live target), `kills`, `shieldTicks`; the log line ends with
  `, 2 retarget(s), 2 kill(s)`; switches log `combat: retarget zombie #433 -> zombie #434 (it hit us,
  strike cycle)` / `(zombie out of reach)`, the next mob after a kill `combat: next ...`.
- **Not** while the target is a creeper (hit and run moves the bot out of reach on purpose) or during
  a creeper interlude; `FightOptions.retarget: false` (or `combat.retarget = false`) is the old single
  target.
- **Who hit us**: `MobTracker` now takes the attacker from BDS's own signal. The attacker's
  `entity_event { event_id: 'arm_swing' }` arrives in the same batch as the bot's hurt
  (`set_entity_motion` knockback, `entity_event hurt_animation` data 2, `update_attributes` health) and
  matched truth:blocklog's attacker in every hit of the probe (two zombies taking turns). A mob within
  5 blocks that swung in the last 250 ms is the guess (`why: 'swing'`, the latest swing wins), before
  the old rules (targets us, faces us, ranged, nearest). Every mob that hit us within 10 s ranks the
  same (`MobTracker.hitUsWithin`), not only the very last one: with the last one only, two zombies
  taking turns made the bot switch on every hit.

Measured on bds-pve (iron sword, no armour, zombies with resistance II so a kill takes 5 hits; runs
alternating on / off, 5 each; `pve-combat` e2e):

| Layout | Re-targeting on | Single target (old) |
|---|---|---|
| Two zombies 2 blocks apart, the bot between them | 14 hits taken over 10 runs (two gate runs: 4 and 10), 2 to 4 switches per run, about 100 ticks per pair | 9 hits (3 and 6), about 100 ticks per pair |
| Sent at a zombie 8 blocks away (held in place), another 1.5 blocks behind the bot | 1 hit over 10 runs (1 and 0), 1 switch per run (to the zombie behind), about 145 ticks | 6 hits (4 and 2), about 140 ticks |

What the numbers say: next to the bot re-targeting is slightly worse (0 to 4 hits per run against 0 to
2; knockback keeps both zombies off either way and focusing on one kills it sooner); an earlier version that switched at once on every knockback and turned 40
degrees per tick took 13 hits against 5 (it alternated between the two, spreading its damage and
standing still while turning), hence the knockback grace and the instant turn. The gain is where
Track W saw it: a fight on a target that is not in reach while another mob is.

#### Crowd rule (wave 9, Track AH)

**3 or more melee threats within 4 blocks (3D, feet to feet) and health below 12**: the fight ends
`crowded` and the PvE controller turns it into a flight, like a creeper the bot does not engage
(`targeting.crowded` / `crowdThreat`, `wantsFlee(threat)` is true for the members; one line in
`PveController.fleeReason`). Melee = a threat that is not a creeper, not an archer and not another
ranged mob (a drowned without a trident is melee). While a fight runs the fight decides: the flee
trigger counts the crowd only when no fight runs, or within 5 ticks of a `crowded` end
(`combat.crowdedRecently`, so a kill job's next fight does not hide it). A fight started within 3 s of
a `crowded` end applies no crowd rule (no flight came: flee was on its cooldown or cornered), so the
bot defends instead of ending fights forever. `combat.crowdRule = false` turns the rule off on both
sides. Counters: `totals.crowded`, metrics `pve.fight.crowded`.

Measured on bds-pve (`pve-crowd` e2e): guard on, health 10, a zombie fought and 3 more summoned around
the bot: the fight ended `crowded` 572 to 594 ms after the summons and the flight started in the same
evaluation. Iron armour, iron sword, 3 zombies at health 11, 45 s per run:

| Crowd rule | Damage per run | Deaths | Zombies killed | Flights |
|---|---|---|---|---|
| on | 5.5, 2.8, 5.5, 8.6, 12.4, 2.8 (mean 6.3; lowest health 3.6) | 0 | 8 of 18 | 9 |
| off | 4.1, 1.4, 2.8, 9.7, 4.1, 4.1 (mean 4.4; lowest health 5.8) | 0 | 9 of 18 | 7 |

Two gate runs of 3 runs each in the table; over all 6 suite runs (18 runs each) the mean damage was
5.2 with the rule and 5.3 without, no death either way. The rule did not reduce the damage in this setting: in iron armour 3
zombies do little (a zombie hit is 1.4 through iron), the bot at 11 health also runs without the rule
(flee v2's low-health and recovery flights), and a flight with 3 zombies on its heels takes hits too
(the run with 12.4 damage). No death either way. The rule is kept as the brief's trigger for the
unarmoured case and larger crowds; its numbers (3, 4, 12) are constants in targeting.ts
(`CROWD_COUNT`, `CROWD_RANGE`, `CROWD_HEALTH`) and `combat.crowdRule = false` turns it off.

#### Path-reachable targets (wave 9, Track AO, decision 0036)

The owner reported from the Realm that the bot got stuck fighting mobs behind walls on its way
to places. The terrain rule above says nothing about a path: on a `!come`, `!goto`, `!get` or `!unload`
walk guard picked a hostile standing on a standable cell behind a wall, a fence or a window, the fight
pre-empted the walk, the approach failed `unreachable` up to 3 times (each a full plan), the mob was
ignored for 10 s and the next guard tick picked it again or its neighbour. Now
(`targeting.pickThreat`, `skills/combat/pathReach.ts`, `CombatController`):

- **Within reach means in sight.** "Within reach now" also needs a line of sight: no cell with a
  collision box up to its top (not leaves) between the eye and the mob's upper body, head or lower
  body (`lineOfSight`). Glass blocks it; a 1-block window, a fence below the line, a slab do not.
  (Measured: BDS accepts melee hits through a glass wall. With the old rule the bot walked into the
  glass and killed a penned zombie through it in 58 to 96 ticks; the zombie cannot hit back, so it
  is no threat and not worth the detour.)
- **A probe plan before committing.** A candidate not within reach (in sight) gets a bounded probe
  plan (Track AN's pattern, `skills/home/reach.ts`: 4 000 nodes, 300 ms, sliced on the main thread
  with a yield between 8 ms slices, never digging or placing, no mob-avoidance cost) from the bot's
  feet to a cell centre within 1.5 blocks (3D) of the mob's feet: its own cell or a neighbour, never
  the far side of a 1-thick wall (1.8 at the least). The path length in blocks must be at most
  **`guardReach`** (setting, default 24 path blocks; 0 = the terrain rule only, no probes).
- **No path or too long: ignored for 30 s** with the reason (`no path`, `no path within 4000 nodes`,
  `path 31 blocks > guardReach 24`), and the next candidate is looked at in the same evaluation.
  While the best-ranked candidate's probe runs, only mobs within reach are picked (no worse pick
  meanwhile). A candidate whose straight distance is beyond the limit + 2.5 is skipped without a probe.
- **Cache**: one probe at a time; a verdict is kept per mob for 5 s and probed again when the mob, or
  the bot, moved more than 3 blocks; a start that is not standable (in the air) gives no verdict and
  is tried again after 0.5 s. A crowd of 10 costs one probe per tick at most, usually far fewer.
- **Restraint while a user walk runs** (**`guardWhileWalking`**, `reach` | `near` | `all`, default
  `near`): while any user process other than a kill job runs and is not held by `!pause` (come,
  follow, goto, get, unload, build, explore, gather, farm, mine, food ...), guard engages only a mob
  within reach (in sight), or (`near`) a melee threat, a creeper or an archer that targets the bot
  within **6 path blocks** of the bot's cell (probed as above, a candidate farther than 8.5 blocks in
  a straight line is not probed). Everything else is left alone until the walk ends (the walk's own
  mob avoidance keeps the distance); a mob that is reachable but more than 6 path blocks off is not
  ignored, only left. `reach`: within reach only. `all`: as without a walk (the `guardReach` rule).
  Creepers count as melee threats here (a creeper walking up during a walk is worse than a zombie).
- **Fast failure in the fight**: an approach goto that ends `unreachable` ends the fight at once
  (`FightOptions.approachTries`, default 1; was 3 gotos, each with the navigator's own 3 failed
  plans), and a stall watchdog (`FightOptions.stallTicks`, default 60, 0 = off) ends the target
  `unreachable` when the bot neither got 0.5 blocks closer (eye to box) nor landed a hit for 60 ticks
  while out of reach, or struck 5 times in reach without a hit landing (a partial plan that walks into
  a wall, a near goal reached on the wrong side of a fence). Not for creepers (hit and run) or flying
  mobs (their own rule). `unreachable` now ignores the mob for 30 s (was 10 s).
- **A hit clears the ignore**: a mob that hit the bot after it was ignored is a target again at once
  (it is reachable after all, or the bot must flee); not a flying one (its own 10 s rule).
- **Status**: `PveController.status()` has `ignored` (`[{ runtimeId, type, reason, leftS }]`,
  also `PveController.ignored()`) and `probes` (`PathReach.stats`: probes, found, failed, cached
  answers, total and largest ms, nodes). Log lines: `guard: zombie #580 ignored for 30 s (no path
  within 4000 nodes)`, `guard: zombie #580 hit us: no longer ignored (was: no path)`, `combat: no
  progress on zombie #12 for 60 ticks (closest 2.9, now 3.4, 0 strike(s) without a hit): unreachable`.

Probe cost (measured): on bds-pve a probe to a zombie in a closed glass pen in the flat world runs to
its node budget: 4 000 nodes in 15 to 24 ms of search time (4 runs, spread over 8 ms slices); a probe that finds its
mob in the open takes 0.1 to 0.2 ms. Unit (generated flat world): a 45-block detour round a 41-long
glass wall is found in well under 300 ms. Per walk of 30 blocks past one penned zombie: 1 probe,
about 24 ms in all.

Measured on bds-pve (`pve-walls` e2e, iron armour, iron sword, guard radius 16, midnight; `!goto` 30
blocks along a straight route):

| Case | New rules | Old rule (`guardReach 0`, `guardWhileWalking all`; fast failure kept) |
|---|---|---|
| (a) zombie 4 blocks away in a closed 3-high glass pen, wall 2 blocks from the bot | arrived in 6.3 to 6.4 s (3 runs), 0 fights, zombie ignored (`no path within 4000 nodes`) | 1 fight: walked into the glass and killed the zombie through it, arrived in 8.1 s |
| (b) the pen beside the route with a 1-block window towards it | arrived in 6.3 to 6.4 s, 0 fights (the zombie never came within reach at the window), zombie ignored | 1 fight from 10 blocks away (killed through the glass), arrived in 10.7 s |
| (c) a zombie in the open 5 blocks off the route | 1 fight when it came within 6 path blocks (reach 3.8 to 3.9 at the start), killed, arrived in 8.2 to 8.8 s | 1 fight from 12 blocks, killed, arrived in 8.2 s |

Gauntlet with the new rules (`gaunt-come` on bds-gaunt, `!come` 80 blocks, 6 zombies and 2 skeletons,
iron armour, guard 16, one pass of 5 runs): **5 of 5 arrived alive** after 126.0, 62.9, 56.8, 77.7 and
79.3 s (mean 80.5 s; Track W's table: 85 to 155 s, mean 117 s), 5 to 7 fights (all kills), 2 to 6
flights, damage 14.3 to 23.5 (Track W: 23 to 41), lowest health 6.8 to 12.7. No mob was ignored for a
missing path (an open flat world): the gain is the walking rule (skeletons that do not aim at the bot
and zombies farther than 6 path blocks are left to the walk's avoidance).

### Shield (wave 9, Track AH, `skills/combat/shield.ts`)

A shield in the inventory goes to the **offhand** (only when no fight runs and no other window is
open; an offhand holding anything else, a totem, is left alone; a refused move is not retried for 30
s). In a fight the shield is **raised** (the bot sneaks) while an archer's shot is due and the bot is
not striking, and for **10 ticks after a creeper's fuse lights**, backing off facing the creeper
(forward -1), then the usual sprint away. It is never raised on a strike tick or within reach of a
melee target (`f.striking`), and never outside fights.

Verified on BDS 1.26.60.6 (truth:stance, truth:blocklog, docker bds-pve):

- **Offhand placement**, with the inventory screen open (`interact open_inventory` ->
  `container_open { window_id: 2, window_type: 'inventory' }`):
  `item_stack_request { requests: [{ request_id, actions: [{ type_id: 'place', legacy_type_id: 1,
  count: 1, source: { slot_type: { container_id: 'hotbar' }, slot: 1, stack_id: 2 }, destination: {
  slot_type: { container_id: 'offhand' }, slot: 1, stack_id: 0 } }], custom_names: [], cause:
  'chat_public' }] }` -> `item_stack_response { status: 'ok', containers: [{ hotbar, slot 1, count 0 },
  { offhand, slot 1, count 1, item_stack_id 2 }] }` and `inventory_content { window_id: 'offhand' (119),
  input: [shield] }`; truth:stance then shows `minecraft:shield` in the Offhand equipment slot. The
  same request **without the screen is refused (status 50)**, as for armour. (The offhand's
  `slot_type` slot is 1; the model keeps it in window 119 slot 0.) Request ids count down from -300001.
- **Raising it is only sneaking**: player_auth_input `sneak_down` / `sneaking` / `start_sneaking`
  (`MoveCommand.sneak`). The server answers with the actor flag `sneaking` in set_entity_data and
  stamps the offhand item's `blocking_tick` (inventory_content 119: `blocking_tick: [0, <tick>]`, back
  to 0 when the sneak ends); Script API `Player.isSneaking` is true. No item-use or interact packet is
  involved.
- **What it blocks**: standing still facing a zombie, shield up for 8 s: the zombie swung 5 times, 0 damage, 0 hurt events, 20 shield durability used (the same in every one of 4 suite runs); shield
  down: 7 swings, 7 hits, 21 damage. In the probe each blocked zombie hit cost the shield 4 durability, a
  blocked arrow 5; a zombie hitting from **behind** still did 3 (only the front is covered), and a
  blocked zombie came back after about 30 ticks instead of 20 (knockback).
- **The archer's draw is not visible to a client**: a skeleton sends no flag or metadata while it
  draws (only `target_eid` when it starts targeting). The shot shows as `level_sound_event { sound_id:
  'bow', entity_unique_id: <the skeleton, as [hi, lo]> }` with the arrow's `add_entity`. On normal it
  shot every 61 ticks, the first shot 62 ticks after `target_eid`. So the shot is **predicted**: from
  the last bow sound (else from when it started targeting us) every 61 ticks, the shield up from 14
  ticks before to 8 after (`shotDue`); plus any arrow first seen less than 20 ticks ago within 12
  blocks flying at the bot. Archers farther than 16 blocks are not watched.

Measured (`pve-crowd` e2e, skeleton duels at 10 blocks, skeletons with resistance III so the duel
lasts 8 hits, 5 duels with and 5 without the shield per suite run, alternating):

| Suite run | With shield: arrows reaching / hurting (damage) | Without: reaching / hurting (damage) | Shield up |
|---|---|---|---|
| no armour | 9 / 6 (25.0) | 11 / 11 (45.0) | 103 ticks |
| iron armour | 10 / 8 (16.0) | 9 / 9 (18.5) | 80 ticks |
| iron armour | 9 / 6 (10.4) | 9 / 9 (16.2) | 86 ticks |
| iron armour | 10 / 9 (19.0) | 11 / 11 (22.3) | 72 ticks |
| iron armour | 10 / 7 (14.1) | 8 / 8 (15.9) | 113 ticks |

So the prediction catches about a quarter of the arrows (12 of 48 blocked over 25 duels; arrows that
hurt 36 with the shield against 48 without; the arrows that got through
mostly arrived while the bot was in reach of the skeleton, striking, or outside the predicted window:
the skeleton's period shifts after it is hit). Without armour one duel without the shield killed the bot
(4 arrows of 6), hence the armour in the suite now. The duels with the shield are a little slower
(sneaking slows the approach). Creeper duels with the shield, 3 per suite run, 9 in all: all killed in
110 to 120 ticks with 3 strikes, the shield up 10 or 20 ticks (one or two fuses), **0 explosion
damage, 0 damage**: backing off with the shield for 10 ticks did not let a fuse run out.

### Creepers (measured on bds-pve, normal difficulty)

| What | Measured |
|---|---|
| Fuse lights (`minecraft:start_exploding`, truth:combatlog) | creeper 2.8 to 3.4 blocks from the player (feet to feet), so at every melee strike (reach ends at about 3.3) |
| Fuse goes out (`minecraft:stop_exploding`) | at 6.65 to 7.26 blocks |
| Explosion after the trigger | 31 ticks (every run) |
| Explosion damage, no armour | 8.6 at 4 blocks, 2.0 at 5.5 blocks (bot standing still, normal) |

Protocol (`CombatController`, hit and run): approach sprinting (sprint knockback), strike, then
sprint straight away until 8 blocks without waiting for the ignited flag, wait until the fuse has been
out 10 ticks, close in again. Never more than 10 ticks within 3 blocks (then the same retreat). A lit
fuse within 7 blocks at any other moment: run straight away. Against a wall for 6 ticks while running
(a crater): the navigator walks to a point 10 blocks away instead. A creeper coming within 6 blocks
during a fight on anything else is fought first, then the fight goes back to its target
(`FightResult.interludes`), so `!kill` jobs are covered as well as guard.

### Weapon pull (`skills/container/hotbar-moves.ts`)

`ensureInHotbar({ hotbar, containers, inventory, score, toolOk })` moves the best-scoring item from the
main inventory (9..35) into the hotbar when it beats everything there: an empty hotbar slot, else the
least useful hotbar item (no durability before food before tools, never a candidate itself, the
selected slot last) is parked in a free main-inventory slot first. The moves are `Containers.move`
`place` requests inside one inventory screen (`interact open_inventory` -> `container_open` ->
requests -> `container_close`; another open window is waited for up to 40 ticks), so they share the
task's request-id counter. Items failing the Track S `toolOk` predicate (`toolWearLimit`) are never
candidates. `HotbarPuller` adds a 10 s memory of failures per job.

- Combat: no sword or axe in the hotbar -> the best sword / axe of the main inventory is moved in and
  selected; the approach goes on meanwhile and strikes wait for it (at most 40 ticks).
  `FightResult.pulled`, `totals.pulls`.
- Digger: `Digger.pullTool` (installed by the combat controller every 20 ticks, like Track S's
  `toolOk`) moves a pickaxe / axe / shovel that breaks the block faster (or at all) than anything in
  the hotbar before the tool choice; the dig then picks it.

### Ranged mobs

Archers: skeleton, stray, bogged, parched, pillager, and a drowned that holds an item (the tracker
keeps the held item's network id from `mob_equipment`). Fighting one, the bot sprints straight in
(the approach goto and the melee steering both sprint). Below health 10 it breaks the line of sight
instead: `coverCell` looks for the nearest standable cell within 6 blocks (one level up or down) where
both lines from the mob's eye to the body (feet + 0.4 and + 1.5) cross a solid cell, the bot walks
there and the fight ends `took_cover`. Every own health drop while the nearest hostile (32 blocks) is
an archer counts as an arrow hit (`FightResult.arrowHits`, `totals.arrowHits`).

### Truth requests (`packs/truth/src/combat.ts`)

| Command | Reply |
|---|---|
| `stance player` (Track AH, `shield.ts`) | `{ name, isSneaking, offhand: { typeId, amount, damage, maxDurability } \| null, health, tick }` |
| `blocklog [sinceTick] [player\|*]` (Track AH) | `{ now, events: [{ tick, kind: melee\|projectile, player, sneaking, attackerId, attackerType, projectile, shieldDamage }] }`: every mob melee hit (entityHitEntity) and projectile reaching a player, blocked or not, with the stance and the offhand shield's durability damage one tick later |
| `combatlog [sinceTick] [player\|*]` | `{ now, events: [{ tick, kind: hit\|trigger\|explosion\|projectile, player, entityId, typeId, item, selectedSlot, eventId, distance, location, players }] }`: melee hits by players with the item in the selected slot at that moment; every creeper behaviour trigger with the nearest player's distance; explosions with the players within 16 blocks; projectiles hitting a player with the shooter and distance |
| `held player` | `{ name, selectedSlot, typeId, amount }` |

### Measured (e2e on bds-pve, 2026-10-29)

From the two final gate runs (pve-combat + pve-creeper, 12 of 12 green each, 181 s and 188 s) plus three
earlier runs of the same suites:

| What | Result |
|---|---|
| Creeper duels at full health, no armour, iron sword | 25 of 25 killed (95 to 142 ticks, 3 hits each), **0 explosions, 0 damage**; fuse lit 2 to 4 times per duel (one per strike), always out again |
| Creeper fuse (truth:combatlog) | lights at 2.80 to 3.34 blocks, goes out at 6.65 to 7.26, explosion 31 ticks after the trigger in every measured case |
| Explosion damage, bot standing, no armour, normal | 8.55 to 8.59 at 4 blocks, 1.97 to 2.00 at 5.5 blocks |
| Creeper at health 8 | `creeper_avoided` after 26 to 47 ticks, 0 strikes, 0 explosions; 10.3 to 10.4 blocks away by the server with the final 11-block rule (7.5 to 9.4 with 10 blocks: it keeps walking after the bot) |
| Skeleton duels, full iron armour (worn by the survival kit) | 15 of 15 killed in 55 to 99 ticks; 0 or 1 arrow hit per duel (1.38 to 2.5 health each; 4 to 5 per duel without armour in the older single duel); the bot's arrow count matched the server's projectile hits in every duel |
| Sword only in main-inventory slot 20, beef in slot 0 | moved to slot 1 and selected before the first strike; every server-side hit held `minecraft:iron_sword`; zombie killed in 36 to 49 ticks (2.6 to 3.2 s with the approach) |
| Guard with a phantom 12 blocks up, then a zombie 8 blocks away | 0.00 blocks moved in 8 s (one strike when it swooped, one `unreachable` fight); zombie dead 3.4 to 4.4 s after its summon; 0 to 3 damage (the zombie) |
| Regression (same runs) | 3 zombies 36 to 75 ticks, skeleton 88 to 107, creeper 128 to 141, guard home 8.2 to 9.7 s, flee shelter 3.4 to 3.7 s, refusals unchanged |
## Flee v2 (wave 7, Track W)

Decision record: [decisions/0018-survival-policy.md](decisions/0018-survival-policy.md). Why: on the
Realm the flight ran home through the mobs, and a bot at 8 health went straight back into the fight.

| Rule | Value |
|---|---|
| Triggers | health below `fleeHealth` (8) with a hostile (`isThreat`) within 16; or a creeper within 6 with health below 10, whatever `fleeHealth` says; not while night safety walks to the shelter; at the shelter / home only for a threat within 6 |
| Duel instead | one melee mob alone within 16 (no archer, no creeper) and health for 3 more of its hits (the last hit taken within a minute, else 3): no low-health or recovery flight; guard fights it (in place below `fleeHealth`). Not when guard is off, when guard ignores that mob (a failed fight), or when the bot lost 4 or more health in the last 6 s (losing: a run had a zombie hit it 10 times in 10 s while the duel rule waited). A zombie chases as fast as the bot runs: one gauntlet run fled 60 s over 260 blocks with a zombie on its heels the whole way and was hit 8 times on the way |
| Start | a threat within 4: 10 ticks of sprinting straight away by hand before the first plan (a zombie hits once a second; a zombie with a sword, 5.2 through iron armour, killed the bot in 2 hits while the first plan started) |
| Leg 1, `away` | `runAway` from every threat within 24 (`from` is a function: the navigator re-checks it at the path's end), goal radius 16, until the nearest threat is 12 away |
| Leg 2, `home` | the shelter, else home, when every threat within 24 is more than 60 degrees off the home bearing or farther than home (`homeClear`); also when there is no farther place (the last `far` leg was unreachable: an enclosed area; the planner's mob avoidance takes the way around), when 40 blocks were run, or when the danger is over and no command waits |
| Leg 2, `far` | home blocked or none: `runAway` to nearest + 6 (at least 16, at most 40) |
| Re-planning | checked every 2 s; a running leg is kept unless the nearest threat gained on the bot (every new goto stops the body briefly) |
| No plan | a leg that cannot start or finds no way (typically: knocked into the air, `no standable node`) with a threat within 8: 15 ticks of sprinting straight away by hand (yaw away from the threats, weighted by 1/d²), then plan again; without a threat near: 1 s standing |
| Eating | (health below 10, or recovering with food below 18: natural regeneration needs 18, and a run showed the bot stuck at 12 health for minutes because every kit bite after a flight was cut off by the next guard fight) and every hostile 8 or more away: the kit's `eat()` (one bite at a time); the kit's own automatic eating is held for the flight and restored after |
| Ends | arrived (10 s before another flight); 2 s out of danger when there is no home to go to or a command waits; cornered (the 4th no-plan in a row with a threat within 4: guard defends in place; 3 s); caught (a threat within 2.5 that keeps hitting the bot for 3 s of the flight: guard defends in place; 3 s); 60 s |
| Hysteresis | after a flight, for up to 1 min, a melee hostile within 12 starts a flight again (not a fight) until the health is back to `fleeHealth` + 6 (14); no cooldown after a safe end while recovering. Ranged mobs (skeleton, stray, bogged, pillager, blaze, witch, ghast, drowned, evoker) never start a recovery flight: running from an archer in a line only gives it targets (the first gauntlet runs lost 20 health to two skeletons that way) |

Status: `fleeing away (12)`, `fleeing away (up to 40)`, `fleeing to home 10 -60 3, 12 blocks left`;
log lines `flee: health 7.5 < 8 with zombie at 1.9; running away, then to home ... when clear`,
`flee: away -> far, nearest threat 12.2`, `flee: far -> home (home clear)`, `flee: recovering (health
11.8 < 14) with zombie at 6.5`, `flee: arrived after 13.9 s (12 blocks)`.

## Trip readiness (wave 7, Track W)

A user process that will walk more than 16 blocks (horizontal distance to the target: the player for
`!come` and the start of `!follow`, the goal of a walk through `pve.walk` (`!goto`, `!home go`), the
nearest target of `!kill`) first prepares when food or health is below 14: the best armour from the
inventory (`!equip`), then the best food until the food bar is full (at most 6 bites; the server
refuses at 20). Status `preparing: eating` (the stack line `preparing: eating (then coming to Steve)`),
the chat reply `coming to Steve (eating first)`, `following Steve (eating first)`, `killing 3 zombie
(eating first)`. The check runs at every (re)start of the process, so a come interrupted by a fight
eats again before going on. Goals without a place (`!top`) never prepare.

**Night rule**: at night (time of day 12542 to 23459, the sleep window) without a chestplate (worn, or
in the inventory to put on) `!come`, `!follow` and `!kill` beyond 16 blocks are refused:
`come: it is night and I have no chestplate; add "now" to go anyway (!come now)`. With `now` at the
end (`!come now`, `!follow Steve now`, `!kill zombie 3 now`) the command goes, and the night process
(shelter, bed) yields to it. Walks are never refused: going home at night is the safe move.

**Far players**: BDS sends a player as an entity only within about 75 blocks of the bot (measured: a
second client tracked at 70, not at 80, with chunk radius 10 or 16). Beyond that the locator bar
reports it (see Packets), so `!come` walks to the locator position and then to the tracked player.

## Never die to common mobs (Track M1)

Decision record: [decisions/0079-never-die-to-mobs.md](decisions/0079-never-die-to-mobs.md). The goal: no death to the common
mobs (zombies and their kinds, skeletons and strays, creepers, spiders, phantoms, drowned, witches, endermen that attacked,
pillagers, slimes; not the warden), bare-handed as well as in the kit.

### Server rules (measured on bds-pve, BDS 1.26.60, `test/e2e/pve-rules.test.ts`)

| Rule | Measured |
|---|---|
| Reach | an attack lands up to 6.2 from the eye to the target's box (6.9 feet to feet); 6.7 misses. The fight strikes at 3.0, the reflex at 3.9 (`REFLEX_REACH`) |
| Facing | does not matter: hits at 0, 90 and 180 degrees off the view, also walking away |
| Hurt time | 10 ticks: 4 of 40 every-tick attacks land, 10 ticks apart |
| Several mobs | 3 different mobs hit in the same tick (3 rounds) |
| Knockback, by weapon (20 ticks) | along the line from the bot to the mob (0 degrees off), not the view. Fist 1.65 blocks, iron sword 1.62, Knockback I 2.54, Knockback II 4.45 to 4.57; sprinting: fist 2.21, Knockback II 6.31 |
| Knockback, by mob (fist) | zombie 1.63, husk 1.67, skeleton 1.67, creeper 1.29, spider 1.15, cave spider 1.15, witch 1.67, pillager 1.67, slime 1.69, drowned 1.66, zombie villager 1.67 |
| A mob's reach | a zombie hits from 1.2 to 1.7 feet to feet |
| Critical | a falling hit does 1.5 times (iron sword: 2.76 standing, 4.13 falling, against resistance III) |
| Shield (sneaking) | blocks at 0 and 90 degrees (and 45: 1 of 3 through); not at 135 or 180 |
| Creeper | the fuse lights at 3.03 to 3.15 feet to feet; fist strikes from 3.9 do not keep it off (2 strikes, lit, 4.1 damage) |
| Eating | an attack 12 ticks into a bite lands and the bite goes on |
| Kite | one zombie, a fist, the bot standing still, 20 s: strikes at 3.0, 3.5 or 3.9 gave 16 to 23 strikes and no hit taken |

Round 2 (bds-gaunt, BDS 1.26.60; `pve-rules.test.ts` case `strike`, `test/e2e/gaunt-probe.test.ts`; the truth pack logs
throws and landings, `combatlog`, and sets effects, `effects`):

| Rule | Measured |
|---|---|
| A strike with the shield up | lowers it for about 13 to 16 ticks: a skeleton at 8, the bot sneaking with a shield, 45 s a row: no strikes 8 of 8 arrows blocked; a strike every 20 ticks: hurt 13, 2 and 5 ticks after a strike, blocked 17 to 19 after; every 10 or 4 ticks: every arrow hurt; no shield: 4 of 4 hurt (`SHIELD_DOWN_TICKS` 16) |
| Witch, throw | from 4 and 8 blocks, none from 12 or 16 (held in place), one every 61 ticks; the potion flies 4 ticks at 4 blocks, 10 to 12 at 8 |
| Witch, potions | harming 6, the same bare and in netherite (armour does nothing); poison 1 every about 25 ticks for 45 s (it stops at 1 health); slowness 90 s; 2 to 4 throws in 25 s |
| Witch, dodging | a side step at each throw lands the potion 3.7 blocks off: damage 22 to 11, poison 45 s to 12.6 s; a 2-high wall or a pillar between: 0 throws |
| Witch, the kill | a netherite sword: 3 hits of 9 in 1.7 s (sprinting 1.6 to 1.7 s, falling hits 2.1 to 2.2 s: 9, 9, 13.5); she drank nothing |
| Weakness | a fist's 0.9 becomes 0.3 |
| Skeleton, aim | at where the bot is when it lets go, no lead (off by under 1 block); the arrow flies 3 to 19 ticks |
| Skeleton, hits | standing: 3 of 5 at 6, 3 of 3 at 10, 1 of 1 at 14; running across at 0.21 a tick: 1 of 5, 1 of 5, 0 of 3, the hits at the turns only; turning when an arrow is let go: 1 of 5, 2 of 5, 1 of 3 |
| Cover | a 2-high pillar between, or the bot in a 2-deep hole: 0 shots from a held skeleton; a pillager held with slowness shot none (not a measurement of its rule) |
| Corner | a free skeleton follows round a wall: 3 shots after the bot was behind it, 1 hit |

### The reflex (`skills/combat/reflex.ts`, setting `mobReflex`, off since round 2)

**Why it ships off** (round 2, ADR 0079 decision 15): the bar for it on was the live kit's deaths and damage in `mixed-8` (and
every other live-kit cell) not worse than the base code at the same number of runs. On the final code, `mixed-8`, 10 runs live
and 5 with Knockback II (bds-gaunt and bds-pve):

| series | kit | runs | deaths | damage mean (median) | witch's potions | runs her poison landed (10 or more) | other damage | lowest health (median) |
|---|---|---|---|---|---|---|---|---|
| base code | live | 10 | 3 | 18.0 (18.1) | 8.4 | 4 | 9.6 | 7.9 |
| base code | kb2 | 5 | 0 | 15.6 (11.5) | 8.2 | 2 | 7.4 | 13.5 |
| final, reflex on | live | 10 | 0 | 23.8 (28.6) | 21.7 | 9 | 2.0 | 1.4 |
| final, reflex on | kb2 | 5 | 1 | 17.7 (15.6) | 14.6 | 4 | 3.1 | 6.4 |
| final, reflex off (the default) | live | 10 | 1 | 25.4 (27.7) | 18.7 | 9 | 6.8 | 1.5 |
| final, reflex off (the default) | kb2 | 5 | 0 | 19.8 (23.2) | 14.5 | 4 | 5.3 | 3.5 |

The reflex takes the damage from everything but the witch from about 7 to about 2 a run and had 1 death in 15 against the
base's 3, but the damage is worse and Knockback II died once: not met, so it ships off. What decides the damage is the witch's
poison: it takes the health down to 1 whatever else happened, so a run is about 2 or about 25 by whether it landed. Over all
the round-2 series it landed in about 7 runs of 10 with the reflex on and about 4 of 10 on the base code and with the
reflex off in round 1; the round-2 witch rule (closing on her) brings it on with the reflex off too (9 of 10 above).
Every round-2 death with the reflex on was the witch's harming at low health; the one death with it off was a zombie
catching a bot that ran at 1 health with nothing striking behind it. A strike's lowering of the shield killed nobody: 0 of the 5
arrows in the died runs came within 16 ticks of a reflex strike. Bare-handed the reflex is what round 1's gains came from (the
table below, `bare after`); an owner who plays bare-handed can turn it on (`!set mobReflex on`).

Every tick before the step: the hostiles within 3.9 (eye to box) with a line of sight, out of their hurt time and not struck by
the bot in the last 10 ticks, up to 3 a tick, in this order: a lit creeper, a mob that hit the bot in the last 2 s, then the one
that reaches the bot soonest (its distance less its reach, over its speed). The strike is the combat skill's `attack` (no turning,
the keys untouched), so a goto, a mining job, eating or guard's own fight go on. Never in flight.

With the shield up (sneaking, or a threat the shield would face) a strike lowers it for about 16 ticks (measured, above), so
only what is worth that (`worthTheShield`): a lit creeper within 4.5, or a melee mob 2 ticks or less from reaching the bot and
outside the shield's 90 degrees (it would hit round it anyway). Never an archer or a witch while the shield is up.

**The idle shield**: with `mobReflex` on, nothing running (no task, no walk, no fight) and a shield in hand, a threat the
shield can face (an archer drawing on the bot) gets the shield raised and the body turned to it (`shield: raised while idle`);
it is let down when the threat goes. Two round-2 deaths in `mixed-8` were a bot standing at home at 1 health (the witch's
poison stops there) with a skeleton shooting at it from 10 and the shield down.

Never struck: a player, a passive mob, iron, snow and copper golems, villagers, a wandering trader, an allay, the warden, the
creaking, the dragon, the wither. A neutral mob (an enderman, a piglin, a wolf, a bee, ...) only when the server says it targets
the bot and the hit guess blamed it within 10 s.

Log: `reflex: zombie #12 in reach (2.8 feet, eta 0.4 s): striking` once an engagement, `reflex: zombie #12 down (...)`.
Metrics: `pve.reflex.hits`, `pve.reflex.kills`; the PvE status (`!status`, the panel) has `reflex: { hits, landed, kills }`.

### The floors (the health rule, `pveFloor` in tasks/pve.ts)

| Floor | When |
|---|---|
| fight on | no danger (no flee trigger), or a duel worth it: one melee mob with health for 3 of its hits, or up to 2 archers alone (skeleton, stray, bogged, pillager) with health for 2 arrows, given up after 8 lost in 6 s |
| eat | every mob 8 or more away, food below 20, something to eat; with no blade in the hotbar also no ranged mob within 16 (an archer or a witch hits from 8 to 15) |
| back off | the flight on foot (Flee v2) with the reflex striking behind it; with no blade a witch within 16 starts one below 14 health |
| elytra flee | running failed (caught or cornered within 20 s) or critical (health 4 or less with a melee mob within 3, or 8 or less with a hit in the last 3 s, or with `sealIn` on and the shell possible 14 or less with a hit in the last 3 s and 3 shooters in sight); setting `fleeFly` (off); `!fly home` as the first owner through the chat command, only with an owner, a home and the flight kit ready (`skills/fly/kit.ts`); at most once in 30 s |
| seal in | as the elytra flee, when it cannot go; setting `sealIn` (off); at most once in 30 s |
| defend | none of the above: guard defends in place |

**The seal-in** (`skills/survival/seal.ts`): with 10 throwaway blocks, 9 under a ceiling (cobblestone, cobbled deepslate, dirt, netherrack, stone
and its kinds, planks; never a block that falls, burns, is worth keeping or does something) the four cells round the feet, the
four round the head, a support beside the roof in the open and the one over the head, the side facing the nearest mob first. Without them, on dirt or grass, the dig-in: the
3 cells under the feet straight down (each dirt-like, the walls and the floor under them solid: no cave, no liquid), then the
first cell dug roofed with the dirt it gave. Then it eats and waits until 18 health (5 min at most) and opens the side away from
the mobs (a dig-in: its roof; the walk out is the next goto's). Log lines `floor: seal in (...)`, `seal: dug in 3 deep, 1
block(s) placed`, `floor: sealed in (...)`, `floor: opening the shell (...)`.

The seal-in's dig-in in round 1 failed with the body beside the dug column: the first dig opened the cell under the feet but
the body, standing on its edge (the centring sneaks, and a sneaking body does not walk off an edge), never fell in. Now the
centring walks (no sneak) when it is to fall into the hole, it tries 3 times, and the next digs take the cell under the feet
where they are; a body that left the hole ends the dig-in (`the body left the hole`). Out of the cell: only at full health
(`SEAL_LEAVE_HEALTH` 20) and with no threat within 16 or at day, else at the 5-minute limit.

The surface shell in round 1 never closed: the roof cell over the head touches the head ring only at its edges, so there is no
face to place it against (8 placed and the roof open in every round-2 run before the fix, one of them 24 damage inside). Now
in the open a support block goes first on the head ring block of the side facing the nearest mob, then the roof (10 blocks on
open ground, 9 under a ceiling). The body is put on its cell's middle before the shell (a body 0.4 off the middle overlaps the
next cell, whose block then will not go in), the cells still open get a second pass after another centring, and a shell left
open is built again once from where the body is (`floor: the shell is open (...), building it again`). Under 3 shooters or
more (archers or a witch, in sight within 16) with the shell possible, critical (the seal) comes at 14 health with a hit in the
last 3 s instead of 8: 10 blocks take about 2 s and round 2's runs sealed at 7, 3 and 2 health. Only with `sealIn` on: with it
off nothing changes (the run as before).

**The witch, by kit** (round 2): with a blade (`firstTarget` in tasks/pve.ts, passed to targeting) a witch within 12 in the line
of sight is the first target (score -500, before an archer or a melee mob in place) while the bot has 8 health or more; at any
health when she is within 8 (her throw range: a run does not get out of it before her next throw, and three round-2 deaths
ran from her at 6 to 7 blocks with her one hit from dead) or within 2 s of her throw (a splash potion first seen within 2.5 of
her; her next throw is 61 ticks off); and only while no other melee mob stands within 2 of the line to her beyond 3 blocks from
the bot. The flight does not start for her then; guard fights her with the approach even when it defends in place (low
health: an in-place fight, reach 5 and no walk, stood 6 from her and never struck), and a fight with her that ended out of
range does not leave her ignored for 10 s (she stood at 6 for 5 s throwing; a path verdict still holds). She dies in 1.7 s to a netherite sword and throws once in 3 s, so the throw it
takes is cheaper than the run (her throws reach across the run, and the poison keeps on). With no blade: the dodge (below) when
it is on, else the flight below 14 health as in round 1.

**Drops after a fight** (round 2): guard walks to the drops only when no other live hostile is within 16 (the killed one left
out: it is listed through its death animation). The collect walk took up to 10 s next to a witch at 4.5 and a spider at 2 with
no fight (a live-kit `mixed-8` death with the reflex off; the base code did the same).

**The potion side step** (with `mobReflex`, `potionStep` in tasks/pve.ts, `potionSideStep` in dodge.ts): a splash or lingering
potion within 12 whose level motion (from its position the tick before: the client does not keep a projectile's velocity up)
points at the bot gets a sprint at right angles to it for 12 ticks at most, on safe cells only, the side away from a melee mob
within 6. It runs on the ground, with no walk and no process but guard (a guard fight's steering is overridden for the 12
ticks and takes over after). Log `reflex: side step from a potion (7.3 away)`; `reflex.potionSteps` in the PvE status, metric
`pve.reflex.potionSteps`. Why: with the reflex killing the melee mobs where they stand the bot stood still while she threw, and
her poison (it takes the health down to 1) landed in 9 of 13 live-kit `mixed-8` runs against 6 of 15 with the reflex off.

**The dodge** (`skills/combat/dodge.ts`, setting `mobDodge`, off): with no blade, no melee mob within 6 and an archer (skeleton,
stray, bogged, pillager) or a witch within 16 in the line of sight, the flight's first phase is the dodge: the body sprints
across the line of fire (the sum of the ways away from each shooter, the near ones weighing most, turned 90 degrees), drifting
out to 10 to 18 from an archer and 13 to 20 from a witch (mostly out inside 6 or with a witch inside 13), and turns round at
most every 60 ticks and only with nothing in the air towards it (a turn is when the arrows hit). Each tick the next 2.4 blocks
of the heading must be a floor with room for the body (no drop, no liquid, nothing that hurts): else the other way, else
straight out, else the ordinary flight. It bites food right after a shot when hungry. It ends when no shooter has a line
(`out of the line of fire`) or after 60 s.

Counts: `pve.taken.<type>` (hits taken by the attacker's type), `pve.floor.<floor>` (backoff, eat, fly, seal); the PvE
status has `taken: { zombie: 3, skeleton: 1 }`. One `[pve]` line per decision.

### `!test mobs` (the Realm harness, Track T1)

`!test mobs <set> [n] [<seconds>s]` (testMode on, cheats on, the bot op'd): at least 150 blocks from home, n runs (default 1)
of the set summoned round the bot (on a ring 7 blocks out, a flying one 10 up) under one name tag (`m1t<hex>`), each run
until the mobs are dead, the bot dies or the time is up (60 s), then `/kill @e[name=<tag>]` (its own mobs only, also on
`!test stop`). Sets: each mob alone (`zombie`, `husk`, `baby`, `drowned`, `zvillager`, `skeleton`, `stray`, `creeper`,
`spider`, `cavespider`, `phantom`, `witch`, `pillager`, `slime`, `enderman`), `zombie4`, `skeleton4`, `creeper4`, `spider4`,
`phantom4`, `mixed4`, `mixed8`. A good run prints (bds-pve, bare-handed, `test/e2e/pve-testmobs.test.ts`):

```
test mobs zombie4: 2 runs of 4 mobs (30 s each) from <x y z>, name tag m1tf745ad
test mobs zombie4 run 1/2: alive, damage 0 (lowest 20), hits none, cleared in 28.7 s, reflex 88, floors none
test mobs zombie4 run 2/2: alive, damage 0 (lowest 20), hits none, 1 left after 30.2 s, reflex 89, floors none
test mobs zombie4: 2/2 runs, 0 deaths, cleared 1/2, damage 0/0 (mean 0), clear median 28.7 s, reflex 177, floors none
```

A bad one says `DIED` in a run line and `1 death` in the summary; the JSONL file in `tests/` has one line per run (the hits by
type, the floors, the reflex strikes, the lowest health).

### The gauntlet (`test/e2e/gaunt-mobs.test.ts`)

33 cells a kit (31 in round 1), each a fresh spot of flat grass, the bot at full health and food with the kit, guard on
(radius 16, as on the Realm), the home point on the spot, the mobs summoned on a ring 7 out, 60 s: each mob alone, 2 and 4 of a
kind, `witch-2`, `mixed-4`, `mixed-8` (zombie, skeleton, creeper, spider, phantom, baby zombie, witch, husk; `mixed-4` and the
`act-` cells the first 4), `act-<activity>` (a mixed 4 during a goto, a mining job, eating, just after a landing) and `seal-5`
(4 skeletons and a witch, round 2). Kits: `bare` (no weapon, no armour, 8 bread) on bds-gaunt; `live` (the netherite set, a
netherite sword, a shield, 16 cooked beef, 32 cobblestone) and `kb2` (the same with Knockback II) on bds-pve; `blocks` (bare
with 32 cobblestone, the seal-in's cell). Columns: `r1 before` the code at the track's start (`bare`) and round 1's code with
the reflex off (`live`, `kb2`); `r1 after` round 1's defaults; `final` the defaults of round 2 (the reflex, the dodge, the
elytra flee and the seal-in off); `bare final, reflex on` the same with `mobReflex` on (one run of the code a few changes
before the last: the targeting and collect changes do not touch a bot with no blade). Each cell is deaths / damage taken in
its 60 s, one run a cell; the variance between runs of one cell is large (`mixed-8`: the reflex section above).

| cell | bare r1 before | bare r1 after | bare final (default) | bare final, reflex on | live r1 before | live final | kb2 r1 before | kb2 final |
|---|---|---|---|---|---|---|---|---|
| zombie-1 | 0 / 21 | 0 / 6 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0.7 | 0 / 0 | 0 / 0 |
| husk-1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 3 | 0 / 0 | 0 / 0.7 | 0 / 0 | 0 / 0 |
| baby-1 | **died** / 27 | 0 / 3 | 0 / 9 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| drowned-1 | **died** / 27 | **died** / 22 | 0 / 11 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| zvillager-1 | 0 / 15 | 0 / 3 | 0 / 3 | 0 / 3 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| skeleton-1 | 0 / 17 | **died** / 28 | 0 / 16 | **died** / 34 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| stray-1 | **died** / 31 | 0 / 16 | 0 / 19 | 0 / 23 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| creeper-1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| spider-1 | 0 / 14 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| cavespider-1 | 0 / 0 | 0 / 0 | 0 / 3 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| phantom-1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| witch-1 | **died** / 29 | **died** / 28 | **died** / 24 | **died** / 30 | 0 / 0 | 0 / 0 | 0 / 1 | 0 / 1 |
| enderman-1 | **died** / 21 | 0 / 0 | 0 / 0 | 0 / 7 | 0 / 0 | 0 / 0 | 0 / 8 | 0 / 0 |
| pillager-1 | **died** / 26 | **died** / 26 | **died** / 25 | **died** / 23 | 0 / 0 | 0 / 0 | 0 / 5 | 0 / 0.9 |
| slime-1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 1 | 0 / 0 |
| zombie-2 | 0 / 3 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| zombie-4 | **died** / 27 | 0 / 0 | 0 / 15 | 0 / 6 | 0 / 18.1 | 0 / 0.7 | 0 / 13.4 | 0 / 0.7 |
| skeleton-2 | 0 / 32 | **died** / 26 | **died** / 32 | **died** / 27 | 0 / 0.9 | 0 / 0.9 | 0 / 0 | 0 / 0 |
| skeleton-4 | **died** / 27 | **died** / 22 | **died** / 21 | **died** / 26 | 0 / 6.2 | 0 / 2.1 | 0 / 4.4 | 0 / 4.4 |
| creeper-2 | 0 / 10.3 | 0 / 0 | 0 / 9.7 | 0 / 0 | 0 / 0.6 | 0 / 0.9 | 0 / 0 | 0 / 0 |
| creeper-4 | **died** / 20 | 0 / 0 | **died** / 25.7 | 0 / 0 | 0 / 8.1 | 0 / 7.6 | 0 / 0 | 0 / 0 |
| spider-2 | 0 / 2 | 0 / 0 | 0 / 16 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| spider-4 | 0 / 18 | 0 / 6 | 0 / 16 | 0 / 10 | 0 / 0 | 0 / 0 | 0 / 19.9 | 0 / 0 |
| phantom-2 | 0 / 6 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 1.5 |
| phantom-4 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 1.5 | 0 / 0 | 0 / 0 | 0 / 0 |
| mixed-4 | 0 / 0 | 0 / 14 | 0 / 18 | 0 / 14 | 0 / 3.1 | 0 / 2.9 | 0 / 4.5 | 0 / 2.1 |
| mixed-8 | **died** / 24 | 0 / 7 | **died** / 25 | 0 / 10 | 0 / 32.2 | 0 / 15.2 | 0 / 27.8 | 0 / 6.1 |
| act-goto | 0 / 23 | 0 / 32 | 0 / 16 | 0 / 31 | 0 / 4.2 | 0 / 0 | 0 / 1.9 | 0 / 0.9 |
| act-mine | 0 / 13 | 0 / 0 | 0 / 23 | **died** / 30 | 0 / 1.4 | 0 / 0.9 | 0 / 5.4 | 0 / 0.9 |
| act-eat | 0 / 19 | 0 / 19 | **died** / 28.1 | 0 / 24 | 0 / 4.2 | 0 / 3.6 | 0 / 6.8 | 0 / 6.4 |
| act-landed | 0 / 7 | 0 / 24 | 0 / 15 | 0 / 13 | 0 / 6.8 | 0 / 0.9 | 0 / 4.7 | 0 / 1.1 |
| witch-2 | - | - | **died** / 26 | **died** / 25 | - | 0 / 2 | - | 0 / 20 |
| seal-5 | - | - | **died** / 26 | **died** / 28 | - | 0 / 15.9 | - | **died** / 24.9 |
| **all** | 10 of 31 / 459 | 6 of 31 / 282 | 9 of 33 / 422 | 8 of 33 / 367 | 0 of 31 / 87 | 0 of 33 / 55 | 0 of 31 / 104 | 1 of 33 / 71 |

Round 2 by kit (one run a cell, the final defaults): `live` 0 deaths in 33, damage 55 (round 1 87 in 31); `kb2` 1 death
(`seal-5`: 4 skeletons and a witch, a harming potion at 4 health; the other 32 cells 0) against 0 in round 1, damage 71
against 104; `bare` 9 of 33 against 10 of 31 before the track and 6 of 31 with round 1's defaults (the reflex on: with it on
again, 8 of 33). The repeats of the witch and the archers cells (below) are the numbers the bars are judged by, not this one
run a cell.

**Repeats on the final code** (10 runs a cell for the live kit, 5 for `kb2` and bare):

| cell, kit, settings | runs | deaths | damage mean |
|---|---|---|---|
| `mixed-8`, live, reflex off (the default) | 10 | 1 | 25.4 |
| `mixed-8`, live, reflex on | 10 | 0 | 23.8 |
| `mixed-8`, live, base code | 10 | 3 | 18.0 |
| `mixed-8`, kb2, reflex off / on / base | 5 / 5 / 5 | 0 / 1 / 0 | 19.8 / 17.7 / 15.6 |
| `witch-1`, live, reflex off | 10 | 0 | 0 |
| `witch-2`, live, reflex off | 10 | 0 | 0.8 |
| `witch-1`, bare, `mobDodge` on | 5 | 0 | |
| `skeleton-1`, `skeleton-2`, `skeleton-4`, `pillager-1`, `drowned-1`, bare, `mobDodge` on | 5 each | 0 each | |
| `seal-5`, blocks, `sealIn` on, the mobs removed at 100 s | 3 | 0 | 0 inside the shell |
| every cell, bare, `mobDodge` on (the rest default) | 2 each, 66 in all | 2 (`enderman-1`, `act-eat`) | 7.8 (516 in all) |

Bare with `mobDodge` on, the whole gauntlet twice: 2 deaths in 66 runs against 9 in 33 with the defaults. The two deaths are
melee mobs on a fleeing bot: an enderman that teleports next to it (7 a hit, 4 hits), and 3 zombies on a bot that started at
food 6 (`act-eat`: no sprint at 6 or less, so the zombies keep up with the flight at 2 to 3 blocks).

**Idle nights** (dusk to dawn in the open, natural spawning on, normal difficulty, about 550 s), bare with `mobDodge` on: 2 nights,
1 death in each (night 1: 73 damage, hits by spiders 9, zombies 7, skeletons 5, a creeper and a slime; night 2: 63 damage,
skeletons 5, spiders 6, zombies 2, creepers 2, a zombie villager 2); round 1, bare with the defaults: 2 deaths in 1 night, 21 of
22 hits by skeletons. The archers are no longer the cause; the melee mobs on a bot that runs at low health are.

**Hard difficulty** (`MOBS_HARD=1`, the crowds `zombie-4`, `skeleton-4`, `creeper-4`, `spider-4`, `phantom-4`, `mixed-4`,
`mixed-8`, one run each, bds-gaunt): bare with the defaults died in 4 of 7 (`zombie-4`, `skeleton-4`, `mixed-4`, `mixed-8`;
damage 106); bare with `mobDodge` on in 0 of 7 (damage 85); the live kit 0 of 7 (damage 63, lowest health 1.4 under 4
creepers); Knockback II 1 of 7 (`skeleton-4`, 26 from arrows through the netherite; damage 52). Run on bds-gaunt for every kit.

**Tasks under attack** (`test/e2e/pve-m1.test.ts`, bare, 3 zombies, bds-pve): a 40-block goto arrived in 8.1 s at 20 health;
`!mine sand 12` ended 12/12 done at 20 health; eating from food 6 reached 20 at 20 health. **Friendly fire**: a second player,
a villager, a wolf tamed to that player, a cow, an iron golem and an enderman that had not attacked, held within 2.2 of the bot
for 40 s with 3 zombies coming in: every hit by the bot on the zombies, with the reflex on (the case turns it on).

Where the bar is not met: bare-handed with the defaults (`mobDodge` off) the archers and the witch still kill (`skeleton-2`,
`skeleton-4`, `pillager-1`, `witch-1`, `witch-2` in the run above); with `mobDodge` on they lived in every repeat, so the
dodge is the floor that held, and it ships off only because it is steered by hand on flat test ground. A fist does 1 (a
skeleton has 20 health, a pillager 24, a witch 26 and drinks healing), the hurt time allows 2 strikes a second at best, and an
arrow is about 4 every 3 s from up to 15 blocks: a lone skeleton needs 10 s of contact at the very least while it backs off.
The bare dig-in does not save `seal-5` (4 skeletons and a witch): the dig times out or is cancelled when the arrows push the
body more than 1.5 off the column; the shell of blocks does (3 of 3). The live kit's `mixed-8` stays at about 1 death in 10:
the witch's poison takes the bot to 1 health in 9 of 10 runs whatever the reflex does.

## Packets (BDS 1.26.60.6, verified)

- **Locator bar** (Track W, `tasks/process/locator.ts`): for every other player the server sends
  `player_location { entity_unique_id, type: 'coordinates', position: <eye, feet + 1.62> }` and
  `locator_bar { waypoints: [{ group_handle, waypoint: { update_flags, visible, world_position: {
  position, dimension_id }, texture_path, icon_size, color, client_position_authority, actor_unique_id },
  action: add | update | remove }] }` at the join and when the player moves (seen at 20, 120 and 300
  blocks; the first one at a join has y 32769.6 and is ignored). `player_list` `add` records map the
  username to `entity_unique_id`. The updates are coarse: after a teleport the reported position was once 16 blocks short of the
  real one, small moves (1 block steps) sent nothing, and `type_hide` comes when the player enters the
  entity range (the last position is kept). `!come` therefore walks to the last known position and
  re-aims at the tracked player once it is in range (at most 4 legs); `I cannot see Steve` only when
  nothing was ever reported.

- **Attack**: `inventory_transaction` `{ transaction: { legacy: { legacy_request_id: 0 },
  transaction_type: 'item_use_on_entity', actions: [], transaction_data: { entity_runtime_id,
  action_type: 'attack', hotbar_slot, hand: 'main_hand', held_item (the wire item as the server sent
  it, air when empty), player_pos (eye), click_pos: {0,0,0} } } }`, preceded by `animate`
  `{ action_id: 'swing_arm', runtime_entity_id: self, data: 0, has_swing_source: true,
  swing_source: 'attack', hand: 'main_hand' }`. The server checks reach and the 10-tick hurt
  invulnerability; it does not check the view direction strictly (the bot faces the target anyway).
  An iron sword did 6.9 per hit on zombies and skeletons (they wear nothing), 7.0 on creepers; 3 hits
  kill a 20-health mob. Knockback pushes the mob 2 to 4 blocks per hit.
- **Mob health**: `add_entity.attributes` (`minecraft:health` value/max) and `update_attributes` for
  the mob's runtime id after every change (`current`).
- **Hurt / death**: `entity_event` `hurt_animation` with `data` 2 for a melee hit, 7 for fire;
  `death_animation` on death; the entity is removed about 1 s later.
- **Targeting**: `set_entity_data` `target_eid` = the target's **unique** id (start_game `entity_id`
  for the bot) when a mob starts chasing; 0 when it stops.
- **Creeper fuse**: actor flag `ignited` in `set_entity_data` `flags`.
- **Player positions**: `add_player.position` is the **feet**, `move_player.position` the eye
  (feet + 1.62). The entity tracker now stores the eye for both (bot/src/world/entities.ts).
- **Script API `Entity.id`** equals the entity's unique id, so e2e tests map truth entities to
  tracked runtime ids by `uniqueId`.
- Own damage arrives as `update_attributes` (self, `minecraft:health`) or `set_health`.

## Measured on bds-pve (2026-10-29, normal difficulty, iron sword only, no armour)

From the e2e runs (`truth:hurtlog` is the server's own record of every hit):

| What | Result |
|---|---|
| Zombie, summoned 6 blocks away, iron sword | killed in 38 to 64 ticks (1.9 to 3.2 s, approach included; 12 kills over 4 runs), always 3 hits of 6.9; 3 attack packets per kill in the last runs (3 or 4 in the first: a 4th fell into the 10-tick invulnerability or behind the knockback); health lost per zombie 0 to 3 (one zombie hit, 3 on normal) |
| Skeleton, 10 blocks away | killed in 69 to 107 ticks, 3 hits; 0 to 5 health lost (arrows while approaching) |
| Creeper, 6 blocks away | killed in 108 to 127 ticks with 3 hits, 0 explosion damage (it never got to light its fuse within 7 blocks; the run-away path is unit-tested) |
| Guard, zombie summoned 10 blocks from home | fight started 0.3 to 0.5 s after the summon, zombie dead after 3.8 to 4.1 s, bot back home after 6.5 to 8.2 s, 0 damage |
| Flee, health set to 5 with a husk 5 blocks away | `fleeing` 0.7 to 0.8 s later, inside the shelter 14 blocks away after 3.5 to 3.8 s |
| Follow a pig teleported 3 blocks every 2 s, 102 blocks | distance before each teleport max 3.04, mean 2.93 (limit 4), 1 correction |
| `!come` from a second client 21 blocks away | within 1.8 to 2.3 blocks after 3.9 to 4.4 s |
| `!follow` while the owner jumps 8 blocks every 3 s | 2.84 to 3.03 blocks 3 s after each jump; a 400-block teleport -> `lost` -> `waiting` 0.9 blocks from the last position, resumed when the owner came back |
| Night, guard r=16 at home, natural spawning, 6000 ticks from 16000 (4 runs) | 0 deaths in every run; 3 to 7 kills per run (zombies, skeletons, spiders, a creeper), min health 8 to 16, damage taken 4 to 16 (skeleton arrows, zombies when two came at once); every attack packet accepted (9/9, 12/12, 18/18, 24/24) |
| Attack packets accepted | 100 % in the night runs; 3 of 4 in duels (an early repeat inside the invulnerability window); no packet was ever rejected for reach or view |

## Tests

```sh
pnpm --filter bot exec vitest run --project unit combat follow pve targeting hotbar-moves   # fakes only (Track V: targeting, combat-survive, hotbar-moves)
node scripts/bds.mjs --profile pve up && node scripts/bds.mjs --profile pve pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e pve           # combat + creeper + follow + night (~6 min)
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e pve-combat pve-creeper --silent=false   # Track V gate (~3 min)
BDS_E2E=1 BDS_PVE_NIGHT=1 pnpm --filter bot exec vitest run --project e2e pve   # with the night run (opt-in)
```

- `pve-combat`: 3 zombies one after another (each checked dead on the server, hits counted from
  `truth:hurtlog`), a skeleton, a creeper (0 explosion damage), guard (zombie 10 blocks from home,
  fight, back home), flee (health set to 5 with a zombie near, run to the shelter 14 blocks away),
  `!kill player` / `!kill <name>` refused with a second client next to the bot, and the combat skill
  refusing that player directly; the server's hurt log shows no damage to it. Track V: a sword only in
  main-inventory slot 20 (beef in slot 0) moved into the hotbar before the first strike (every server-side
  hit shows `minecraft:iron_sword` in truth:combatlog, truth:held afterwards); guard with a phantom
  summoned 12 blocks up (the bot stays within 3 blocks of home for 8 s) and a zombie walking up
  meanwhile (killed); 5 skeleton duels in full iron armour (worn by the survival kit), each in its own
  spot, arrow hits counted by the bot and by the server (`PVE_SKELETON_RUNS`, default 5).
- `pve-creeper` (Track V): the fuse distance and explosion damage measured (bot standing still, put 4
  and 5.5 blocks from the lit creeper), 5 creeper duels at full health without armour (`PVE_CREEPER_RUNS`,
  default 5; survival required, damage, fuse triggers and explosions reported per run), and a creeper at
  health 8 (`creeper_avoided`, no strike, at least 8 blocks away by the server, `wantsFlee` true). Every
  creeper gets a fresh spot 24 blocks from the last; the ground is restored (dirt, grass, air) at the end.
- `pve-combat` (Track AH): re-targeting on / off alternating (`PVE_RETARGET_RUNS`, default 5 each;
  zombies with resistance `PVE_RETARGET_RESISTANCE`, default 1): two zombies 2 blocks apart with the
  bot between them (both die, the fight switches at least once, not worse than the single target
  beyond noise), and a zombie behind the bot while it is sent at one 8 blocks away (fewer hits than
  the single target). Hits from truth:hurtlog.
- `pve-crowd` (Track AH): crowd rule (health 10, 4 zombies: `crowded`, then a flight); 3 zombies at
  health 11 in iron armour with the rule on / off (`PVE_CROWD_RUNS`, default 3; damage, deaths, kills,
  flights in 45 s); shield into the offhand and blocking a zombie (truth:stance, truth:blocklog);
  skeleton duels with / without the shield (`PVE_SHIELD_RUNS`, default 5;
  `PVE_SHIELD_SKELETON_RESISTANCE`, default 2); creeper duels with the shield
  (`PVE_SHIELD_CREEPER_RUNS`, default 3; 0 explosion damage). About 12 min.
- `pve-walls` (Track AO): during a `!goto` 30 blocks along a route, guard on, iron armour: (a) a
  zombie 4 blocks away in a closed 3-high glass pen (arrives within 40 s, 0 fights, the zombie on the
  ignore list with a reason), (b) the pen beside the route with a 1-block window (arrives within 40 s,
  every fight starts with the zombie within reach), (c) a zombie in the open walking up (fought and
  killed, then arrives). Prints the probe costs. `PVE_WALLS_OLD=1` runs it with `guardReach 0` and
  `guardWhileWalking all` for comparison (measurements only). About 45 s.
- `pve-follow`: a pig with slowness 255 teleported 3 blocks every 2 s for 102 blocks; a second client
  (a real offline player, an owner) types `!come`, `!follow`, `!status`, `!stop`; leaving view (a
  400-block teleport) -> last known position -> waiting -> resumed.
- `pve-night`: natural spawning and the daylight cycle on, time 16000, guard radius 16 at home for
  6000 ticks; 0 deaths required. Opt-in with `BDS_PVE_NIGHT=1` (in the wave-5 full gate the bot died once in a crowd under machine load; armour and food come with 7.11); `BDS_PVE_NIGHT_TICKS` and
  `BDS_PVE_NIGHT_START` change it.

Every run uses its own random 256-block cell from x, z = 8192, random truth request ids and a per-run
summon tag; summoned mobs are removed at the end (`truth:killmobs`), the night run also clears every
non-player entity within 96 blocks of home.

### Survival policy (wave 7, Track W) on bds-gaunt

Measured 2026-10-29 (BDS 1.26.60.6, normal difficulty, bds-gaunt):

| What | Result |
|---|---|
| Gauntlet: `!come` 80 blocks, 6 zombies + 2 skeletons summoned along the route, iron armour + sword, 8 bread, guard 16, midnight (final rules, two gate passes of 5 runs) | 10/10 alive at the end of every run, 0 deaths; 9 arrived after 85 to 155 s (mean 117 s), 1 never started the last stretch because the test harness could not get BDS to report the player (see the locator row; the harness now reconnects the player then); 3 to 8 fights (all kills), 4 to 11 flights per run; damage taken 23 to 41 (zombies 9 to 22, skeletons 1 to 32); lowest health 6.0 to 8.1, health at arrival 11 to 18 |
| The same, earlier rule sets (for the record) | no hysteresis: died in 1 of 1 (fleeing at 7.9, fighting again at 8.1); hysteresis from every hostile within 16: 29 flights, stuck (running from archers); without the duel rule: 2 of 4 stuck for 240 s with a zombie on the heels of 60 s flights; duel rule without the losing / ignored checks: 3 deaths in 3 runs (a zombie the guard ignored hit the bot 10 times; an armed zombie, 5.2 per hit through iron, killed it during the first plan of a flight) |
| Flee ring (home behind a slowed zombie, health 7, no food), 2 rings per run | distance to the zombie 4.0 -> 9.1 to 9.8 after 2 s, to home 12.0 -> 18.9 to 19.5 (away first); home after 13.9 to 15.0 s around the ring; 0 damage |
| Trip readiness: food 6, `!come` from 30 blocks | reply `coming to ... (eating first)`, status `preparing: eating`; 3 bites (bread), food 6 -> 20 after 5.3 to 5.4 s, 0.00 blocks moved while preparing; next to the player after 11.2 s |
| Night without a chestplate | `!come` refused (`come: it is night and I have no chestplate; add "now" to go anyway (!come now)`), 0 blocks moved; `!come now` arrived after 5.3 to 5.5 s |
| Entity range of a second player | tracked at 70 blocks, not at 80 (chunk radius 10 and 16 alike); the locator bar reported it at 120 and 300. After teleports BDS sometimes sends no locator update at all (in 2 of 4 gauntlet passes it stopped after the first run; a fresh join is reported again) |

```sh
pnpm --filter bot exec vitest run --project unit flee-readiness night-bed sleep pve afk-processes
node scripts/bds.mjs --profile gaunt up && node scripts/bds.mjs --profile gaunt pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e gaunt- --silent=false     # ~12 min (the gauntlet: 5 runs)
```

Env: `GAUNT_BDS_HOST` (127.0.0.1), `GAUNT_BDS_PORT` (19188), `GAUNT_BDS_CONTAINER` (bds-gaunt),
`GAUNT_RUNS` (5), `GAUNT_VERBOSE=1`. Every run uses a random 256-block cell from x, z = 24576, random
truth ids, a per-run summon tag, `--no-config` values (waypoints and settings in memory), and removes
its mobs, drops and blocks at the end.

- `gaunt-come` (a): the gauntlet. A second client (owner) 80 blocks away; iron armour, iron sword, 8
  bread, guard 16, midnight; 6 zombies and 2 skeletons summoned 10 to 15 blocks ahead as the bot passes
  marks 5, 20, 30, 45, 55; `!come`; per run: arrival time, damage (truth hurt log), fights, kills,
  flees, lowest health. Required: 5 of 5 alive at arrival.
- `gaunt-flee` (b): a ring corridor, home behind a slowed zombie, health 7, no food: the distance to
  the zombie and to home grow first, home within 60 s (two rings).
- `gaunt-trip` (c): food 6, `!come` from 30 blocks: `(eating first)`, `preparing: eating`, food 20
  without moving, then the walk; at night without a chestplate `!come` refused, `!come now` goes.
- `gaunt-sleep` (d): docs/survival.md "Sleep".

Manual check left for the Realm (you): `!come` and `!follow` from your own client (the e2e uses a
second offline client, which is a real player entity to the bot), and a night with `--guard 16`.

## Known limits

- **No bow**; no critical hits (no jump attacks). Sprint knockback is used against creepers only.
- (Track AH) The shield is raised only inside fights (not while walking, fleeing or idle), the
  archer's shot is predicted (61 ticks, measured for skeletons on normal; other archers and other
  difficulties may differ), and it covers the front only. Sneaking slows the approach to an archer
  while the shield is up. Re-targeting does not reduce hits when both zombies are next to the bot
  (knockback keeps them off either way); see "Re-targeting within reach".
- Eating and armour come from the survival kit (docs/survival.md); flee v2 eats when 8 clear, trip
  readiness before long trips. Health regenerates slowly (food 18 or more); a recovering bot runs from
  melee hostiles within 12 for up to a minute, so a guard bot at 8 to 14 health does not defend home.
- (Track W, gauntlet e2e) A guard fight stays on its target while another zombie hits the bot (seen:
  10 hits in 13 s from a second zombie); since wave 9 (Track AH) the fight re-targets a mob within reach ("Re-targeting within reach"). A flight from a zombie at 1.6 blocks
  takes 1 or 2 more hits before the sprint pulls away.
- (Track W) `!follow` / `!come` beyond about 75 blocks use the locator bar; a player in another
  dimension (or with the locator bar off: gamerule `locatorbar` false) stays `I cannot see Steve`.
- Melee-range steering (the last 3.5 blocks) does not avoid holes or lava; the navigator handles
  everything farther. Flying mobs are fought only within reach (wave 7). (Track AO) A ground mob not
  within reach needs a probe path of at most `guardReach` blocks; the probe never digs or pillars, so a
  mob reachable only that way is left alone, and one in a cave below the probe's 4 000 nodes counts as
  unreachable. During walks guard leaves mobs farther than 6 path blocks alone (`guardWhileWalking`).
  The stall watchdog also ends a fight on a mob that keeps its distance for 3 s.
- Creeper hit and run walks the bot 8 blocks back and forth (about 100 ticks per creeper); in a crowd
  the retreat can meet other mobs. Cover from archers ignores leaves and glass panes as cover and
  walks the navigator's path to it (possibly through the line of fire).
- Endermen are neutral: guard ignores them until one hits or targets the bot.
- While running away the bot does not face the attacker.
- `!follow` overrides the night shelter until `!stop`.

### Realm death 2026-11-05 (idle far from home)

A `!mine sand` job 1400 blocks from home ended `inventory full`: the stash step's box-to-hotbar move and junk
drop answered `busy` because a keeper pass held the survival kit's lock. With no command left, guard measured
its radius from home, so no mob near the bot was a target: husks and a drowned hit it 105 times over 40
minutes without a blow back, and the flight at 7 health never got clear of the drowned. Fixes: the guard
centre is the bot while it is farther than the radius from home, and a mob that hit the bot is a target
whatever the centre (a fight far away does not walk home afterwards); the kit's `drop` and `hotbar` wait up
to 5 s for a running op (`queued`); a mine or quarry job that ends `inventory full` goes home (it unloads
there) when nothing else is queued; the flee `caught` rule above.

