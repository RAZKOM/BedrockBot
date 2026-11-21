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
| `bot/src/tasks/pve.ts` (`creeperBackOff`, `creeperStrikesEnough`), `bot/src/skills/combat/hostiles.ts` (`MobTracker.ticksLit`), `bot/src/skills/combat/combat.ts` (`strikeDamage`, `strikeItem`), `bot/test/e2e/early-creeper.test.ts` | Track E7: the creeper back-off (`PveRules.creeperReach`, off) and the tunnel replica ("A creeper in reach") |
| `bot/src/skills/test/mobs.ts` | Track M1: `!test mobs` (the gauntlet's sets on the Realm under testMode) |
| `bot/src/skills/test/bare.ts` | Track T2: `!test mobs ... bare` (the hotbar's blades stowed for the series and put back) |
| `bot/src/skills/fly/flee.ts`, `bot/src/chat/commands-fly.ts` (`flee`, `fleeReady`, `cancelFlee`) | Track M3: the elytra flee as a flight mode (the numbers and the pure choices; the flight itself) |
| `bot/src/skills/fly/landmobs.ts` | Track M3: a landing's look at hostile mobs (docs/flight.md) |
| `bot/src/skills/combat/targeting.ts` | Track V: `isThreat`, `nearestHostile`, `pickThreat` (reachability-aware, creepers first), `reachability`, `wantsFlee(threat)`, `afterFight` / `ignoreMsAfter`; Track AH: `inReach` / `pickInReach` (re-targeting), `crowdOf` / `crowded` / `crowdThreat` (crowd rule) |
| `bot/src/skills/combat/pathReach.ts` | Track AO: `PathReach` (bounded probe plans from the bot to a mob, verdicts cached per mob, `stats`), `mobGoal`, `pathVerdict`, `probeNavOf`; targeting.ts adds `lineOfSight`, `ignoreMob`, `userWalking`, `walkThreat`, `parseWalkRule` |
| `bot/test/unit/skills/targeting-walls.test.ts`, `bot/test/e2e/pve-walls.test.ts` | Track AO unit tests (fakes and a generated flat world) and e2e on bds-pve (a glass pen, a window, the open, all during a `!goto`) |
| `bot/src/skills/combat/shield.ts` | Track AH: `ShieldController`: shield into the offhand, archer shot prediction (`threat`, `shotDue`), the offhand item stack request |
| `packs/truth/src/shield.ts` | Track AH: truth commands `stance` (isSneaking, offhand item and durability) and `blocklog` (mob melee swings and projectiles reaching a player, with the stance and the shield's durability) |
| `bot/test/unit/skills/combat-v3.test.ts`, `bot/test/e2e/pve-crowd.test.ts` | Track AH unit tests on fakes; e2e (crowd rule, shield) on bds-pve; the re-targeting e2e is in `pve-combat.test.ts` |
| `bot/src/skills/container/hotbar-moves.ts` | Track V: `ensureInHotbar` (main inventory -> hotbar through the task's Containers), `HotbarPuller` (failure memory, the Digger's `pullTool` hook; with a full inventory the exchange `swap` and a failure line once a minute), `digToolScore` |
| `bot/src/skills/follow/follow.ts` | `FollowController`: `follow({ runtimeId } \| { playerName })`, `come(playerName)`, `stop()` |
| `bot/src/tasks/pve.ts` | `PveController`: guard, flee, follow, come, kill, a resumable goto, behaviour line, options |
| `bot/src/tasks/pve.ts` (`workThreat`, `workArchers`, the guard process's `tick`), `bot/src/tasks/creeper-rise.ts` (`riseFrom`, `RiseProcess`) | Track E12: `workGuard` (guard off: a witch and a lone archer fought for a job at work) and `creeperRise` (up 2 over a lit creeper under the feet), both off; unit `skills/work-guard.test.ts`, `creeper-rise.test.ts`, e2e `early-mine.test.ts` |
| `bot/src/tasks/process/blade.ts` | Track M9: the blade craft with a lone archer in sight (`PveRules.craftBlade`, off; the crafter's side is wired in `chat/commands-craft.ts`) |
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
| `bot/test/unit/skills/{targeting,combat-survive,hotbar-moves,hotbar-moves-full}.test.ts`, `combat-fakes.ts` | Track V unit tests on fakes (`-full`: the puller with a full inventory) |
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

**A full inventory** (Track T2 follow-up): with no free main-inventory slot to park the hotbar item in, the wanted item and
that hotbar item exchange places in one `swap` stack request (`HotbarPuller.swap`, the survival kit's `exchange`, set by the
kit when it starts; predicted with each stack's own wire item, rolled back when refused, under the screen the pull holds).
The hotbar item given up is chosen as for parking, so a weapon pull never gives up another blade, a dig pull never another
tool for that block, and `keep` items stay. A bot that fights mobs fills its inventory with their drops, so this is the usual
state, not a corner: with every slot taken the pull failed `no_space` without a word, and every fight after went on with
whatever the hotbar held (a tool or a fist) while the sword sat in the main inventory. Without the exchange (no survival kit) the pull still fails `no_space`.
A failed pull now says so, once a minute a job and reason: `hotbar: the pull for weapon failed: no_space (...); it goes on
with what the hotbar holds`. On bds-pve (`test/e2e/pve-combat.test.ts`, every slot full, the sword in slot 20, one zombie):
`iron_sword moved from slot 20 to 8 (cobblestone exchanged into 20)`, every hit with the sword, no item lost.

Other moves between slots with a full inventory: the survival kit's `toHotbar` (the food a meal needs, the stash's box)
swaps with a hotbar slot by itself and needs no free slot; the flight kit's `rocketsToHotbar` swaps when the inventory is
full; the keeper's stocking swaps with junk. PlaceSkill's `selectItem` (`hotbarRoom`) and the farm's
click (`farm/click.ts`, the same `hotbarRoom`) still need a free main slot for a full hotbar and fail `move_failed`; the
blocks they place are usually in the hotbar already (the keeper keeps them there), so they are left as they are. The
storage's `freeHotbarSlot` needs two free slots by design (one for a box).

- Combat: no sword or axe in the hotbar -> the best sword / axe of the main inventory is moved in and
  selected; the approach goes on meanwhile and strikes wait for it (at most 40 ticks).
  `FightResult.pulled`, `totals.pulls`.
- Digger: `Digger.pullTool` (installed by the combat controller every 20 ticks, like Track S's
  `toolOk`) moves a pickaxe / axe / shovel that breaks the block faster (or at all) than anything in
  the hotbar before the tool choice; the dig then picks it.
- Breeding (`skills/food/breed.ts`, docs/food.md): the food an animal takes is pulled the same way (`breed <kind>`).

All three get the exchange with a full inventory when the survival kit runs, and the failure line.

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

**Stock steps** (`PveController.addTripStock`, run in the order added after the armour and the eating): Track K1's
`milk` phase (below, "Milk on hand") and Track R9's `rockets` phase (docs/flight.md "Rockets on hand": before a trip
that may fly, rockets crafted from the paper and gunpowder carried, loose or in the carried boxes, when fewer than the
flight needs are carried; never the chests at home, never a walk). Each step is asked with the trip's goal; a step
with nothing to do is skipped.

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

### The reflex (`skills/combat/reflex.ts`, setting `mobReflex`, off in round 2, on again since Track M2)

On by default since Track M2 (ADR 0079 decision 26, the numbers in "Track M2" below). **Why it shipped off in round 2**
(ADR 0079 decision 15): the bar for it on was the live kit's deaths and damage in `mixed-8` (and
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
the keys untouched), so a goto, a mining job, eating or guard's own fight go on. Under a flight only while the body comes
down onto its landing, with `flyLandMobs` on or in an elytra flee (docs/flight.md "The landing looks at hostile mobs
(Track M3)": from 5.5 there, the blade in the hand).

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

#### The blade strike (Track E3, `PveRules.bladeStrike`, on; ADR 0100)

The reflex strikes with whatever the hand holds, and the hand holds what the running job needs: a pillar's block, a
pickaxe between digs, nothing. Measured on the server: a strike with cobblestone or the fist takes 0.9 from a zombie
(20 health), a stone pickaxe 3.9, a stone sword 5.9 (8.9 a critical). On a fresh world a mine step's walk pillared up a
one-wide shaft of its own digging, a zombie came down it, and the reflex struck it 14 times with the cobblestone; the
bot died 20 to 0 in 6 s (guard off, the flight at 6 health found no way out of the shaft).

With the rule on, a reflex strike made while the hand holds a block item, a digging tool (pickaxe, shovel, hoe,
shears) while no dig runs, or nothing, is made with the best sword or axe in the hotbar: `mob_equipment` to the blade,
the swing and the attack with that slot, `mob_equipment` back, all queued before the same tick's input (the hand is
back before the job's next action). Never while a blade is held (nothing to gain), during a dig (the dig's hand),
while eating (food in hand, the meal ends if the slot changes), during guard's or a flight's own fight (they choose
their weapon), or with an item used by holding it (a bow, a shield, a bucket, rockets, a totem). The worn blade is
taken too (the fight takes it too). `combat.totals.bladeStrikes` counts them.

The shaft replica (`test/e2e/early-shaft.test.ts`; the flat world, a 5 x 5 block 10 high with a one-wide shaft, the
early kit: a stone pickaxe, a stone sword in the hotbar, 32 cobblestone; `!goto` to the top with `allowPlace`; a
zombie summoned 6 over the feet once they are 2 up; difficulty normal, midnight, guard off), 5 runs a side:

| walls | rule | deaths | reached the top | damage a run | strikes to kill | seconds to the top |
|---|---|---|---|---|---|---|
| stone | off | 0 | 5 | 0, 6, 3, 0, 0 | 9 to 11 | 16.6 to 17.0 |
| stone | on | 0 | 5 | 0 in all | 3 to 4 | 16.7 to 18.1 |
| obsidian (no way out but up) | off | 0 | 0 (the case's 60 s ran out) | 9, 3, 0, 0, 0 | 21 to 40, 0.9 to 1.4 each | - |
| obsidian | on | 0 | 5 | 0 in all | 3 to 4 | 7.2 to 8.3 |

The replica did not kill the bot with the rule off: the fresh world's hits kept the body in the air (the walk waited
with `no start node while in the air` and the place at the top was refused), which the flat case does not do. The
obsidian walls stand in for that (the walk cannot dig round the zombie).

The live kit (a sword held) is not changed by it: the gauntlet's `live` rows with `MOBS_AB_RULE=bladeStrike`, 15 runs a
side, bds-dig and bds-reg (the test servers of this track, BDS 1.26.60.6), from rest:

| cell | rule | deaths | damage a run | lowest health (median) | reflex strikes a run |
|---|---|---|---|---|---|
| mixed-8 | off | 0 | 4.5 | 18.4 | 18.2 |
| mixed-8 | on | 0 | 5.7 | 18.4 | 18.1 |
| witch-1 | off | 0 | 0.0 | 20 | 3.3 |
| witch-1 | on | 0 | 0.0 | 20 | 3.0 |
| witch-2 | off | 0 | 1.9 | 19.0 | 6.1 |
| witch-2 | on | 0 | 1.9 | 19.0 | 6.1 |

`mixed-8`'s gap is one run (28.6 on, the highest off 12.7); the medians are 1.6 off and 1.9 on.

#### A creeper in reach (Track E7, `PveRules.creeperReach`, off; ADR 0079 decisions 70 and 71, ADR 0104)

On a fresh world a mine step's walk (pillaring up between two ore veins, no armour, guard off) had a creeper and a
spider come up by day. The reflex struck the creeper, the fuse burned out 2 s later and the blast took the bot from 18
to 0. The question was whether the strike is the fault (a strike that cannot kill in the fuse's time) and whether the
body should leave instead.

Measured in a replica (`test/e2e/early-creeper.test.ts`; the flat world, a stone block 21 x 5 x 4 with a tunnel one
wide and two high through it, 16 iron ore in its wall; the early kit: a stone pickaxe, a stone sword in the hotbar,
no armour, guard off, difficulty normal; `!mine iron_ore 16`, then a creeper summoned in the tunnel), the code as it
was, 5 runs a cell:

| cell | deaths | damage a run | blasts | creepers killed | strikes | the fuse: times lit, longest (ticks) |
|---|---|---|---|---|---|---|
| the creeper walks in from 8 | 0 | 2.8, 0, 0, 0, 0 | 1 | 4 of 5 | 5 (3 in the run with the blast) | 2 to 3; 19, 21, 22, 28, 31 |
| the creeper appears 2 off | 0 | 0 in all | 0 | 5 of 5 | 5 | 3; 21 to 24 |
| a wooden pickaxe, no sword (`!mine stone 16`, the bot stays in the tunnel) | 0 | 0 in all | 0 | 5 of 5 | 7 | never lit |

With 13 earlier runs of the first two cells (no fuse count): 28 runs, no death, one blast (2.8 damage, the creeper
knocked back to about 5 blocks when it went off), 27 creepers killed in 4.6 to 6.8 s. What the runs show, for any
world:

- **The strikes are what keep a creeper off.** Each strike knocks it back and the fuse goes out; it lights again when
  the creeper is back within about 3. A fuse runs 31 ticks; in these runs it burned 19 to 28 ticks before a strike cut
  it, and the full 31 once.
- **In sight from 3.9, a creeper never gets to light**: the bot in the straight tunnel struck it at reach every 10
  ticks (its hurt time), 7 strikes with a wooden pickaxe, the fuse never lit.
- **Round a corner the first strike comes at 1 block.** The mine digs a pocket into the wall and stands in it; the
  creeper comes into sight at the pocket's mouth, already inside its fuse distance. That is where the fuse burned 19
  to 31 ticks.
- **A dig keeps the pickaxe in the hand.** The blade strike does not swap during a dig, so the strikes were the
  pickaxe's (4 a strike, 5 to kill) with the stone sword (6, 4 to kill) in the hotbar.

The fresh world's death was not reproduced: there the creeper came with a spider while the walk pillared up, and how
many strikes landed in its 2 s is not in the log.

**The rule tried (`creeperReach`).** With guard off (guard's own hit and run takes a creeper on when it is on), the
body leaves a creeper the strikes do not deal with, by the flight on foot (`creeper`) at any health: one within 6
(`CREEPER_BLAST_REACH`) whose fuse has burned 12 ticks (`CREEPER_LIT_BACKOFF`), or one within 5 while the strike in
hand needs more than 5 strikes to kill it (`creeperStrikesEnough`: a fist, a block, a wooden tool); it holds until
that creeper is 8 away or gone, and never starts walled in (a shell, a seal). The reflex strikes on as before. The
same cells with the rule on, 5 runs each:

| cell | deaths | damage a run | blasts | creepers killed | flights a run | the fuse's longest (ticks) | the run |
|---|---|---|---|---|---|---|---|
| walks in from 8 | 0 | 15.4, 0, 0, 0, 0 | 1 | 4 of 5 | 1 | 14, 21, 23, 25, 31 | 5.7 to 11.7 s |
| appears 2 off | 0 | 0 in all | 0 | 2 of 5 | 1 | 22 to 28 | 3 of 5 ran the case's 45 s with the creeper alive (all 16 ore mined) |
| wooden pickaxe, no sword | 0 | 0 in all | 0 | 5 of 5 (struck as it followed) | 2 | never lit | 19.2 to 20.7 s against 5.7 to 6.2 |

It is better in no cell, and its one blast hit at 15.4 (health 20 to 4.6) against 2.8 without it: the flight starts in
the pocket the mine dug, whose only way out is past the creeper (`flee: no threat within 16 after 2.9 s (2 blocks)`),
and a body that runs stops striking. **It ships off** (a switch of `PveController.rules`, `PVE_RULES_DEFAULT`; the
replica flips it with `EARLY_CREEPER_RULE=on`). A first form of the rule also kept the reflex from striking a creeper
the strikes could not kill within one fuse (a stone sword needs 4 strikes, 30 ticks and more): one run, 8 flights in
45 s, 2 ore mined, the creeper alive and following; dropped for the numbers above (the strikes kill it over several
fuses, each one cut).

With the rule off nothing of the fight changes: `skills/combat/reflex.ts` is untouched, and the flight's new reason
is asked only with the rule on and guard off. `MobTracker.ticksLit` (the ticks a creeper's fuse has burned, from the
`ignited` flag) and `strikeDamage` / `CombatController.strikeItem` (what a reflex strike would be made with and what
it takes) stay for the rule and the replica.

#### A job at work and the shooters (Track E12, setting `workGuard`, on by default; ADR 0119 and its addendum)

With guard off (the default) nothing fought an archer or a witch while a job worked: the reflex strikes only what
comes within reach, and the flee starts below `fleeHealth`. For a witch it was worse than that: the flee leaves a
witch the bot "fights first" (`firstTarget`: a blade, her within 12, the health, a line on her) alone, a rule written
for guard on, so with guard off she was neither fought nor run from. Measured in built scenes
(`test/e2e/early-mine.test.ts`; the flat world, the early kit: stone sword, pickaxe and axe, no armour, guard off,
`!mine iron_ore 24` in an open patch, difficulty normal, n5 a side; a run ends when the bot died, every mob of the
scene is dead, or after 60 s; the door: 45 s after the job went on):

| scene | rule | deaths | damage a run | lowest health | flights | what happened |
|---|---|---|---|---|---|---|
| a witch 8 off | off | 0 | 29, 29, 29, 26, 28 | 1 in all 5 | 1 a run | no fight; she threw while the mine went on |
| a witch 8 off | on | 0 | 0, 0, 0, 2, 5 | 20, 20, 20, 20, 17 | 0 | one fight a run: she died to 5 strikes, 4.0 to 5.4 s after she came |
| one skeleton 12 off | off | 0 | 25, 24, 29, 26, 25 | 5, 4, 4, 4, 6 | 2 to 11 | no fight; the mine and the flee in turn |
| one skeleton 12 off | on | 0 | 4, 4, 4, 0, 4 | 16, 16, 16, 20, 16 | 0 | one fight a run: it died to 4 strikes, 4.9 to 6.1 s after it came |
| two skeletons 10 and 12 off | off | 0 | 30, 26, 20, 26, 25 | 3, 5, 4, 5, 5 | 5 to 11 | no fight; the mine ended `low_health` with 6 to 19 of 24 mined |
| two skeletons 10 and 12 off | on | 0 | 29, 26, 28, 24, 28 | 3, 4, 4, 4, 3 | 7 to 10 | no fight (two archers within 16) |
| two skeletons at the night shell, 2 and 7 off, at dawn | off | 0 | 0, 16, 23, 18, 19 | 20, 7, 4, 8, 4 | 0 to 3 | the reflex struck the near one; the job went on under the other's arrows |
| two skeletons at the night shell, 2 and 7 off, at dawn | on | 0 | 5, 0, 3, 0, 3 | 15, 20, 17, 20, 17 | 0 | one fight a run, at 3.4 to 15.8 blocks, when the bot counted one archer within 16 (the other killed by the reflex in 2 runs before the job went on) |

**The rule (`PveController.workThreat`, guard's own fight).** With `workGuard` on, guard off and a job at work (a
user process other than `kill`, `goto`, `come` or `follow`; not under `!pause`; a blade in the hotbar), guard's fight
(priority 60, with its approach, the reflex striking as before) takes:

- a witch the bot fights first by `firstTarget` (within 10 blocks of height), before anything else;
- else, at `WORK_ARCHER_HEALTH` 14 or more, the nearest archer (skeleton, stray, bogged, pillager) within
  `WORK_ARCHER_RANGE` 16 and 6 of height, with a line on the bot, that aims at it or hit it in the last 10 s, **while
  it is the only archer within that range** (`WORK_ARCHERS_MAX` 1; counted seen or not, aiming or not). A fight for
  the work on an archer ends when a second one comes within the range (`guard: 2 archers within 16: the fight for the
  work on skeleton #12 ends (workGuard)`).

Mobs guard ignores stay ignored; a fight for the work does not walk home after it (`guard: skeleton #12 12.0 off
shooting at the work (workGuard), fighting`). Nothing else changes: the flee's triggers, the duel rule (`canDuel`
still answers no with guard off, so below `fleeHealth` the flight on foot comes as before), the reflex, melee mobs and
creepers.

Why the lone archer, measured on the way: with every aiming archer fought, two skeletons gave 30, 29, 25, 25 and 19
damage (the lowest 3 to 8, nothing mined in 5 of 5): the first died in 5 of 5, and its 7 to 10 s of approach and
fight cost about 8 health while the second shot. Counting only the archers that aimed and were in sight changed
little (24 to 28, the lowest 0 to 5, and one death: the second fight began at 12 health against a skeleton 16 off and
ended at 3 in the flee), because the second was not yet aiming, or not in sight from the hole the mine had dug, when
the first fight began. Counting those in sight, aiming or not, with the health bar, still let a fight begin in 3 of
5 (27, 28, 28, 17, 12; the lowest 4 to 9): the scene summons the second a moment after the first, as a second archer
on real ground comes into range after the first. Hence the count of every archer in range, the health bar for an
archer fight, and the end of the fight when a second comes.

What the numbers say, for any world: against a witch or one archer the fight is the answer (a witch throws every 61
ticks; a stone sword kills her in 5 strikes and a skeleton in 4, for 0 to 5 damage, against about 25 a minute of work
under fire); against two archers a stone-sword fight with no armour is not better than the work and its flee, so the
rule leaves them to the flee.

#### A creeper under the feet (Track E12, setting `creeperRise`, off; ADR 0119)

A creeper cannot climb. A bot that has built up (a pillar to an ore in a cliff, the top of a shaft) and digs its way
back down comes down onto one that waits at the foot: the fuse lights at about 3 blocks (feet to feet), with the body
2 to 3 blocks over it. On a fresh world one such blast took the bot from 20 to 0 (the walk dug its pillar of 9 down
with the creeper and a zombie at its foot; the reflex struck the zombie first). Measured in a scene
(`early-mine.test.ts` `pillar`: a one-wide cobblestone pillar 8 high, 4 iron ore beside its foot, `!mine iron_ore 4`,
a creeper at the foot, a zombie too in 18 of the 21 runs off and in all 15 on):

| rule | runs | deaths | damage a run | over 14 | lowest health |
|---|---|---|---|---|---|
| off | 21 | 0 | median 1.6, mean 4.0, the highest 18.6 and 17.1 | 2 | 5.4 |
| on | 15 | 0 | median 6.0, mean 6.0, the highest 9.9 | 0 | 12.1 |

With the rule off the reflex strikes the creeper as it comes within reach under the descending body: 12 runs of 21
took 1.6 or less (it died to the strikes, or blew 5 or more off), 7 took 3 to 5.9, and 2 took 17.1 and 18.6. **The rule**
(`tasks/creeper-rise.ts`, a process at the flee's priority, added after it so a tie is its): while the fuse of a live
creeper at least 2 blocks under the feet (`RISE_BELOW`) and within 3 level (`RISE_SIDE`) burns, with 2 throwaway
blocks and the two cells over the head free, the body goes 2 blocks up by the navigator's own pillar move (place moves
only, about 26 ticks) and stands until that creeper is gone or 3 s (`RISE_HOLD_MS`); then the job's walk plans again.
The blast then comes 4 to 5 under the feet: 1.6 to 3.6 in 13 of 15 runs (7.9 once, none once), but its push throws
the body off a one-wide top in 14 of 15 (a fall that costs 2 to 4). It removes the near-fatal blast and costs about 6 a run where the strikes usually
cost less: it ships off. Not for a creeper beside the body on the same level (a body that goes up 2 next to it stays
in its blast: that is the flee's back-off, `creeperReach`).

### The floors (the health rule, `pveFloor` in tasks/pve.ts)

| Floor | When |
|---|---|
| fight on | no danger (no flee trigger), or a duel worth it: one melee mob with health for 3 of its hits, or up to 2 archers alone (skeleton, stray, bogged, pillager) with health for 2 arrows, given up after 8 lost in 6 s |
| eat | every mob 8 or more away, food below 20, something to eat; with no blade in the hotbar also no ranged mob within 16 (an archer or a witch hits from 8 to 15) |
| back off | the flight on foot (Flee v2) with the reflex striking behind it; with no blade a witch within 16 starts one below 14 health |
| elytra flee | setting `fleeFly` (off), where a takeoff can be made (the elytra and 3 loose rockets, the column over the body open 8 up, the overworld; "Track M3: the elytra flee as a flight mode" below). With no blade in the hotbar: at every flee trigger, before the flight on foot, and below 14 health with an archer or a witch in sight. With a blade: from 6 health down, and once running has failed (caught or cornered within 20 s) or the health is critical (4 or less with a melee mob within 3, or 8 or less with a hit in the last 3 s, or with `sealIn` on and the shell possible 14 or less with a hit in the last 3 s and 3 shooters in sight). A real flight: jump, wings, a rocket, 96 blocks away from the hostiles (home when that is 48 to 400 blocks off and clear), landing with the look at hostile mobs; at most once in 30 s |
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

`!test mobs <set> [n] [<seconds>s] [force] [bare]` (testMode on, cheats on, the bot op'd; the words after the set in any
order): at least 150 blocks from home, n runs (default 1)
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

The hits and floors of a run are the difference of the PvE counters at its start and its end. Until Track T2 the start was
read as the live counter objects themselves, so every run said `hits none` and `floors none` whatever happened (the
reflex's count, a number, was right). Records written before that carry no hits and no floors.

#### `bare` (Track T2)

With the word `bare` the series is fought with no blade (a sword or an axe) in the hotbar, so the floors meant for a bot
without one run on a world where the kit carries a sword: the elytra flee comes first at every flee trigger (with a blade
it comes only from 6 health down), and the dodge may step (with `mobDodge` on). `skills/test/bare.ts`:

- **Stow**: before the first run every blade in hotbar slots 0..8 moves into a free main-inventory slot, one whole-stack
  move each through the survival kit's inventory screen (`SurvivalKit.moveSlot`, the containers' predicted `place` move).
  Nothing is destroyed or given: the item keeps its enchantments and wear. With no free slot left the blade exchanges places
  with a main-inventory stack the fight would not take as a weapon (`weaponScore` 0: a block first, then food, then the rest;
  never a pickaxe, shovel, hoe, trident, mace or another blade), one `swap` stack request (`SurvivalKit.swapSlots`, the
  request the survival kit already used to bring a box into a full hotbar), so `bare` needs no free slot: the first line says
  `netherite_sword 0 <-> 13 (cobblestone)`. Only when every main-inventory stack is a weapon is the series refused
  (`test mobs: bare needs 1 inventory slot free or holding something that is no weapon ...; make room first`), and then
  nothing moves. The exchanged stack sits in the blade's hotbar slot for the series; the restore swaps it back.
- **Hold**: until the series ends the hotbar puller (`HotbarPuller.hold`) passes blades over. It is the one road from the
  main inventory into the hotbar for the fight's weapon pull, the Digger's axe pull and a breeding pull; without the hold the
  first fight would bring the sword straight back. Selecting a weapon only looks at the hotbar, so it finds none.
- **Keep**: after each run's restore a blade that came into the hotbar since (a `/give` of the kit lands in the first free
  slot, a pickup) moves out too.
- **Restore**: however the series ends (finished, `!test stop`, a death, an error) each blade goes back to the hotbar slot it
  came from, after a death's recovery and once a flight in the air has come down (the inventory screen is not opened in the
  air). A slot taken meanwhile exchanges with the blade (the same `swap` request): the occupant goes into the slot the blade
  comes from, whole, and nothing needs a free slot (`netherite_sword back in slot 8 (exchanged with gunpowder, now in slot
  10)`). A slot is taken that way as a rule, not by chance: a kit that fights mobs picks up their drops, and the server puts
  a pickup on the first stack it fits on, else in the first empty slot, the hotbar first; the bot does not choose that slot,
  and keeping the slot filled with a placeholder would cost a stack and still fail for a drop of the placeholder's kind, so
  the exchange at the end is the answer. On the Realm (2026-11-15) a full inventory left the sword in the main inventory
  (`stays in slot 10 (slot 8 holds gunpowder, no free slot)`) until a later fight's weapon pull, before the exchange. A
  blade a pull moved meanwhile is looked for by its name in the main inventory, then in the hotbar, and exchanged into its
  own slot from there. The hold ends in any case. keepInventory is required for every series, so a death keeps the slots.

What is not a blade still counts for the fight: a pickaxe, shovel, hoe, trident or mace in the hotbar is still the weapon the
fight selects (better than a fist), only not one for the guard's `hasBlade()`. The offhand is not looked at. The first line
says `bare (netherite_sword 0 -> 10)` (and `fleeFly is off` when it is), each run line ends `, bare`, the summary
`, bare: netherite_sword 0 -> 10; netherite_sword back in slot 0`; the records gain `bare`, `stowed` (and `bladeInHotbar`
when a blade could not be moved out before a run), the summary `bare`, `stowed`, `restored`. A series without the word
moves nothing.

On bds-pve (`test/e2e/pve-testmobs.test.ts`, the sword in slot 0, rockets and bread in the hotbar, the elytra in the main
inventory, `fleeFly` and the guard on, `skeleton4 1 bare 40s`): the sword was out of the hotbar at every one of 172 looks
while the run went, the elytra flee was asked once and flew (landed 96 blocks off after 7 s, one rocket), and the sword was
back in slot 0 with its enchantment after the summary. The run said `cleared in 7.6 s` although the bot had flown off: the
harness counted a mob it no longer saw as gone, and a flight of 96 blocks takes it out of view. Since Track M4 it asks the
server before it clears a run with a mob out of sight ("The harness: a mob out of sight is not cleared" below).

With every other slot full of cobblestone (the second case of the same file: no free slot at the stow or the restore) the
stow said `netherite_sword 0 <-> 10 (cobblestone)`, the flee was asked and flew as before, and the summary said
`netherite_sword back in slot 0 (exchanged with cobblestone, now in slot 10)`, the enchantment kept and every stack of
cobblestone still there.

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

## Track M2: the reflex judged, real ground, `!test mobs` for the Realm

ADR 0079 addendum (decisions 17 to 27). Everything here ran on bds-pve or bds-gaunt (BDS 1.26.60, normal difficulty) unless
it says offline. `gaunt-mobs.test.ts` gained `MOBS_REPEAT` (n runs a cell), `MOBS_AB=<setting>` (every run once with the
setting off and once on, alternating), `MOBS_SET=a=true,b=false`, `MOBS_ROW` (one JSON line a run) and `MOBS_TRACE_ALL`.

### The reflex, 30 runs a side

`mixed-8` (zombie, skeleton, creeper, spider, phantom, baby zombie, witch, husk), 60 s, `MOBS_AB=mobReflex`. Damage is the mean
a run; "witch" is her harming and poison; "potions near" the splash potions that broke within 4 of the bot of those she threw.

| series (code) | kit | side | runs | deaths | damage | witch | other | lowest health (median) | potions near | friendly |
|---|---|---|---|---|---|---|---|---|---|---|
| `final3` (before decision 18) | live | off | 30 | 1 | 20.7 | 14.9 | 5.9 | 3.2 | 26 / 72 | 0 |
| `final3` | live | on | 30 | 0 | 22.4 | 20.5 | 1.9 | 1.3 | 54 / 62 | 0 |
| `final4` (the final code) | live | off | 30 | 4 | 22.0 | 15.3 | 6.7 | 2.0 | 31 / 72 | 0 |
| `final4` | live | on | 30 | **0** | **17.0** | 15.5 | 1.5 | 5.1 | 32 / 42 | 0 |
| bare, `mobDodge` on | bare | off | 30 | 20 | 23.8 | 0 | 23.8 | 0 | - | 0 |
| bare, `mobDodge` on | bare | on | 30 | **0** | **0.3** | 0 | 0.3 | 20 | - | 0 |
| bare, `mobDodge` on (the final code) | bare | off | 30 | 17 | 22.0 | 0 | 22.0 | 0 | - | 0 |
| bare, `mobDodge` on (the final code) | bare | on | 30 | **0** | **1.5** | 0.7 | 0.8 | 20 | 4 / 5 | 0 |

What cost the reflex in `final3` was the witch: with the melee mobs dying in place the bot stood at home and her potions landed
(54 of 62 against 26 of 72). The potion side step fired 26 times in those 30 runs and did not change it (a 12-tick step is
3.4 blocks, inside a splash's 4). The way to her had to be clear of melee mobs before she went first, and in `mixed-8` it never
was. Decision 18: with the reflex on the way need not be clear (the mobs on it are struck in passing). In `final4` she throws 42
potions in 30 runs against 72, the potion step has nothing left to do (0 steps: it is skipped while guard fights her), and the
live kit's damage is below the reflex-off side. The bare series ran on the code before decision 18, which does not touch a bot with
no blade.

**The final gauntlet** (3 runs a cell, 99 runs a column; deaths / mean damage; live on bds-pve, bare on bds-gaunt). `old
defaults` is the reflex and the dodge off, `defaults` the reflex on (decision 26), `recommended` for a bare-handed bot both on.

| cell | bare, old defaults | bare, defaults | bare, `mobDodge` on, reflex off | bare, recommended | live, reflex off | live, defaults |
|---|---|---|---|---|---|---|
| zombie-1 | 1/3 7.3 | 0/3 4.0 | 0/3 4.0 | 0/3 2.0 | 0/3 0 | 0/3 0 |
| stray-1 | 1/3 21.3 | 1/3 21.7 | 0/3 0 | 0/3 0 | 0/3 0 | 0/3 0 |
| witch-1 | 3/3 30.3 | 3/3 29.3 | 0/3 17.3 | 0/3 0 | 0/3 0 | 0/3 0 |
| enderman-1 | 0/3 7.0 | 1/3 21.0 | 2/3 16.3 | 1/3 14.0 | 0/3 0 | 0/3 1.2 |
| pillager-1 | 3/3 25.3 | 3/3 26.0 | 0/3 3.7 | 0/3 9.0 | 0/3 0 | 0/3 0.2 |
| zombie-2 | 1/3 17.0 | 0/3 15.0 | 0/3 21.0 | 0/3 11.0 | 0/3 0.7 | 0/3 0 |
| zombie-4 | 0/3 18.0 | 0/3 6.0 | 1/3 17.0 | 0/3 3.0 | 0/3 1.8 | 0/3 0.5 |
| skeleton-2 | 2/3 26.7 | 3/3 28.0 | 0/3 2.7 | 0/3 1.7 | 0/3 0.8 | 0/3 0 |
| skeleton-4 | 3/3 25.7 | 3/3 26.7 | 0/3 5.3 | 0/3 7.0 | 0/3 2.4 | 0/3 1.7 |
| creeper-4 | 2/3 23.6 | 0/3 0 | 1/3 24.3 | 0/3 0 | 0/3 9.0 | 0/3 0 |
| witch-2 | 3/3 25.3 | 3/3 28.7 | 0/3 21.3 | 0/3 8.3 | 0/3 1.7 | 0/3 0.7 |
| seal-5 | 3/3 25.0 | 3/3 24.7 | 0/3 9.0 | 0/3 6.3 | 0/3 11.5 | 0/3 13.2 |
| mixed-4 | 0/3 10.3 | 1/3 18.3 | 0/3 9.0 | 1/3 12.3 | 0/3 3.3 | 0/3 0.8 |
| mixed-8 | 3/3 25.3 | 1/3 17.0 | 2/3 27.0 | 0/3 1.3 | 0/3 22.7 | 0/3 22.0 |
| act-mine | 1/3 20.7 | 0/3 18.7 | 0/3 10.8 | 0/3 9.3 | 0/3 1.2 | 0/3 0.7 |
| act-eat | 0/3 17.0 | 0/3 12.3 | 2/3 22.0 | 0/3 7.5 | 0/3 4.2 | 0/3 1.0 |
| act-landed | 0/3 20.0 | 1/3 16.7 | 0/3 4.3 | 0/3 2.7 | 0/3 1.6 | 0/3 0 |
| the other 16 cells | 0 deaths | 0 deaths | 0 deaths | 0 deaths | 0 deaths | 0 deaths |
| **all 99** | **26**, 1312 | **23**, 1128 | **8**, 832 | **2**, 371 | **0**, 193 | **0**, 130 |

Friendly hits in all 594 runs: 0. Bare at the defaults the archers and the witch still kill (`skeleton-2`, `skeleton-4`,
`pillager-1`, `witch-1`, `witch-2`, `seal-5`, 18 of the 23 deaths): the reflex does not reach them and the dodge that does is
off. The bare columns before `defaults` ran on the code before decision 18, which does not touch a bot with no blade.

### The idle nights

Dusk to dawn in the open, natural spawning, about 550 s.

| kit, settings | nights | deaths | damage | lowest |
|---|---|---|---|---|
| bare, defaults | 1 | 1 | 70 | 0 |
| bare, `mobDodge` and `mobReflex` on (bds-gaunt) | 3 | 0 | 24, 32, 54 | 10, 8, 6 |
| bare, `mobDodge` and `mobReflex` on (bds-pve) | 2 | 1 | 35, 66 | 3, 1 |
| bare, `mobDodge` and `mobReflex` on (bds-gaunt, later) | 2 | 3 (2 and 1) | 74, 40 | 3, 4 |
| bare, `mobReflex` on (the defaults) | 1 | 3 | 102 | 0 |
| live, `mobReflex` on | 3 | 0 | 1.9, 2.0, 1.6 | 18.1, 18.6, 18.4 |

The bare death at the defaults, tick by tick (the trace in the gauntlet's trace file): guard chased a skeleton 20 blocks across the
open (arrows 4 and 3), turned on a spider at 10 health, followed it another 20 blocks with the spider staying 2.3 to 3.1 away and
no strike landing, then fled at 6 health; the spider is faster than the flight and bit 2 a second to death. Bare at the defaults
nothing strikes the spider while guard walks after it; with the reflex it is struck as it comes in. The bare death with the
recommended settings (bds-pve, which spawns witches at night): a witch's poison took the bot to 1 health, the dodge kept it
running 13 from her for 20 s (she follows; a fist does not kill her), and an enderman hit it for 7. The later bds-gaunt nights:
endermen 3 of the deaths (7 a hit, on a bot fleeing at 5 to 6 health), a zombie with a zombie horse beside it at 8 health,
skeletons on a bot fleeing at 1 to 4 health, and the witch's poison to 1. Not met: 4 deaths in 7 recommended nights, 3 in the
one night at the new defaults. A bare-handed bot's floor at night is out of sight (the seal-in or a roof), not a run: every
night death was a bot running at low health.

### The dodge on real ground (`test/e2e/gaunt-dodge.test.ts`)

Bare, `mobDodge` on, two skeletons, 60 s a run, 3 runs a cell; each cell built round the bot (trees, a slope of 1 in 2, a cliff
8 high 4 from the bot, a water pool, a lava pool 3 out, a cave mouth, a ledge 5 high).

| cell | deaths | fall damage | burns | in water at the end | notes |
|---|---|---|---|---|---|
| trees | 0 | 0 | 0 | no | 0 to 3 damage |
| cliff | 0 | 6, 5, 6 | 0 | no | over the edge in every run: once while dodging (an arrow's knockback at the edge), twice on the flight's run away |
| water | 1 of 3 | 6 in 1 | 0 | no | a death to arrows; never stuck in the water |
| cave | 0 | 6, 6, 13 | 0 | no | once while dodging, twice on the flight (the 13 a drop of 17 on the way home) |
| lava, slope, ledge | not completed on bds-pve | | | | the spots far out did not load (a harness fault); on bds-gaunt before: lava no burns, slope 0 falls, ledge 0 falls |

Never a step onto a cell not known safe while dodging (`unsafeWhileDodging` 0 in every run). Not met: falls that cost health.
Two causes: the knockback of an arrow on a body near an edge (the dodge now drifts back in when the cell 1.3 behind is not safe,
and runs along the edge when straight out is not clear; it did not end them), and the flight's own run away,
which is nav's walk and takes a hurting fall at its last level. What it would still take: an edge margin of about 2 blocks for
the dodge (knockback is about 1), and a nav goal option that never takes a fall that costs health (nav is not this track's).

With the live kit, sloped and stepped ground and a ledge (`DODGE_KIT=live`, a witch, a spider or a skeleton below or above the
bot, 3 runs a cell, bds-pve and bds-gaunt): 18 of 18 cleared, no unreachable verdict, no fall. Before decision 20 the witch on
a ledge 5 below was written off as unreachable ("closest 6.0, now 8.5") and the spider once.

### `!test mobs` on the Realm

The first line now says the two game rules and the ground: `test mobs zombie4: 2 runs of 4 mobs (30 s each) from <x y z>,
keepInventory on, mobGriefing off, ground flat (16/16 level), name tag m1t...`. It refuses: keepInventory off or unanswered (`test mobs:
keepInventory is off: a death would drop the kit; not running`), a set with a creeper while mobGriefing is on unless the command ends in `force`, and a ring 7 out
that is mostly not standable or a slope (`test mobs: the ring 7 blocks round the bot is a slope (its mobs would go downhill):
a slope (5/16 level, 9 on other levels); find flat open ground`). Ground words: `flat` (16 of 16 points level), `mostly flat`
(8 or more), `a slope` (most points standable within 8 levels but fewer than 8 level), `rough`, `unknown`.

On the Realm (2026-11-11, this track's code, the live kit, at night with wild phantoms, skeletons, zombies and a creeper
joining in): the rules read `keepInventory on, mobGriefing on`, so every set with a creeper (`creeper4`, `mixed4`, `mixed8`)
was left out; two places were refused (`rough`, `a slope`) and a flat one found from the map was taken. `mobReflex` off and on,
the same sets, deaths / mean damage a run:

| set (runs) | reflex off | reflex on | reflex strikes |
|---|---|---|---|
| zombie4 (3) | 0 / 0.5 | 0 / 0.4 | 28 |
| skeleton4 (3) | 0 / 0.9 | 0 / 1.5 | 20 |
| spider4 (3) | 0 / 0 | 0 / 0 | 20 |
| witch (3) | 0 / 0, dead in 3 s | 0 / 0, dead in 3 s | 6 |
| phantom4 (2) | 0 / 0.6 | 0 / 0 | 0 |
| pillager (2) | 0 / 0 | 0 / 0 | 4 |
| **all 16** | **0**, 5.3 in all | **0**, 5.6 in all | 78 |

The reflex struck zombies, skeletons, spiders, phantoms, the witch, pillagers, zombie villagers and a wild creeper (twice), and
nothing else. "Cleared" is not comparable at night (in one run guard went after a wild skeleton for 36 s while the reflex
killed the set's zombies in place). What the Realm could not show is the reflex's gain, which is in the mixed crowds with a
creeper in them. The driver must put the bot back on the flat cell before every set: a set's fight and the drops take it a few
blocks off, and the next set is refused as a slope.

### The elytra flee (`fleeFly`, off) measured

(What Track M2 measured with the flee as `!fly home`. Track M3 made it a flight mode of its own: "Track M3: the elytra flee as
a flight mode" below.)

`test/e2e/gaunt-fleefly.test.ts`, bare with an elytra and rockets, home 200 out. Before the hand-over (decision 22): 4 of 4
deaths in a pen with 2 or 4 zombies; `!fly home` was accepted ("vertical takeoff clear") but the flee and guard took the body back
the next tick. With the hand-over: in a pen with 4 zombies 2 of 3 took off 0.7 s after the ask (health 7 to 4), then the flight
landed itself ("health low") 3 to 7 s later 18 to 31 blocks away; 1 died with the fly floor never reached. In the open the flee
outran 4 zombies on foot in 2 of 3 runs; the third flew 200 blocks and stood 0.6 from home. What the flee needs from the flight
code (not changed here): no low-health landing while the trip is the elytra flee (or land only far from every hostile), a
takeoff under 1 s from the ask, and a cancel the flee can call.

## Track M3: the elytra flee as a flight mode

Decision record: [decisions/0086-landing-looks-at-mobs.md](decisions/0086-landing-looks-at-mobs.md) (decisions 9 to
14; the landing's look at hostile mobs, decisions 1 to 8, is in [flight.md](flight.md) "The landing looks at hostile
mobs (Track M3)"). The setting is still `fleeFly`, still off by default.

What a player does when the mobs are too many: jump, open the wings, a rocket, and come down somewhere else. Until
this track the floor was `!fly home` typed for the owner once the flight on foot had failed. It needed a home, it
planned a trip like any other before it moved (the landing search first), the flight landed itself as soon as the
health was under `fleeHealth` (which is when it was asked), and the guard could not tell whether anything had come of
it (Track M2: 4 deaths in 4 before the hand-over, then 2 takeoffs of 3 that came down 18 to 31 blocks away among the
mobs). Now the flee is a flight of its own kind:

| | |
|---|---|
| The entry point | `flyControlOf(task).flee(why)` (`chat/commands-fly.ts`), asked by the flee process through `PveController.fleeFlight`. It resolves with what happened: `flew` (a takeoff was made), `ok` (the body stands again after a flight), where, how far, how many rockets, the nearest hostile known there. `fleeReady()` says whether a takeoff can be made where the body stands and why not; `cancelFlee()` drops it on the ground and lands it in the air (the owner's `!stop`, `!fly stop` and `!land` do the same) |
| What it needs | the elytra (in the inventory or on the back, not worn out), 3 loose rockets (a jump takeoff fires 1 to 3; a go-around at the landing 1 or 2; the fireworks box is not opened in a flee), the overworld, no water round the body, and the column over it open 8 blocks up. Under a roof there is no flee: `fleeReady` says `a roof 3 over the feet` and the other floors stay in charge |
| The takeoff | the jump, the wings on the jump's fall, a rocket once the server has the glide: along the first heading within 90 degrees of the way away from the hostiles (the sum of the ways away from each, the near ones weighing most) whose simulated climb is clear; else straight up the column over the body; else along any heading that is clear. It starts from the ground and from rest: a body in the middle of a walk's jump or a knockback is waited for, a second at the most (a flee asked in a sprint jump started its glide a fifth of a block over the ground along the walk's heading and ended 4 blocks on) |
| Where to | home, when it lies 48 to 400 blocks away, no hostile round the body stands on the way to it (every one more than 60 degrees off its bearing: a mob that followed the body away from home stands between the two, and a flight home over it only turns it round) and none is known within 24 of it; else a point 96 blocks away on the bearing away from the hostiles (30, 60 and 90 degrees either side when that column is water or lava). The ground there is found from the air by the landing search with the look at hostile mobs, whatever `flyLandMobs` says: never within 12 of a creeper, beside what else is hostile; the brain's look and the reflex in the elevator as in any flight with the look |
| What it never does | land because the health is low (a flight's rule: `fleeHealth` is passed as 0), place a block (no refill from the box before or after), or go on if the takeoff's simulation is not clear |
| The body | the flee's trip is a process above the flight on foot (`fleefly`, auto, `PRIORITY.flee + 0.5`): from the ask to the end of the flight the flight on foot and the guard do not ask for the body (`flyHandover`). A walk home that waits its turn is dropped when the flee is asked: it would walk the body straight back (a flee that landed 96 blocks off at 7 health was walked home within 13 s, to the witch, and died there) |
| After it | the recovery rule of the flight on foot holds from the landing on (no fight below `fleeHealth` + 6 for a minute); the flee is not asked again for 30 s |

### When the guard asks for it

The floors (the table in "Never die to common mobs (Track M1)") with `fleeFly` on and a takeoff possible:

- **No blade in the hotbar**: at every flee trigger, before the flight on foot. A fist does not end a fight, and every
  bare-handed death of Tracks M1 and M2 was a body running on foot at low health. And earlier against what a fist
  does not reach: an archer or a witch with a line on the bot starts it below 14 health (`FLY_SHOOTER_HEALTH`, the
  number the flight on foot already uses for a witch): the takeoff takes half a second to a second, and at 8 health
  with two skeletons shooting that is one arrow too late.
- **With a blade**: the flight on foot first (a blade wins most fights, and the takeoff costs the chestplate for the
  flight); the elytra flee from 6 health down (`FLY_FIRST_HEALTH`), and as before once running has failed (caught,
  cornered) or the health is critical.
- **Where it cannot go** (a roof, fewer than 3 rockets, a flight in the air, asked within the last 30 s): the floors
  as they were: the flight on foot, the seal-in, the stand.
- **Only at a flee trigger**: the floors are asked when the flight on foot would start. With the reflex on, Track M2's
  hold (`holdGround`: 1 to 3 melee mobs within 8, no creeper near, no archer or witch in sight, fewer than 2 melee hits
  in 3 s) takes the low-health trigger away, so against melee mobs alone neither the flight on foot nor the elytra flee
  starts, at any health, until the second melee hit within 3 s. Then both are asked as above (the e2e `core-process`
  hold case, the unit `afk-processes` twin).

A flee that made no takeoff answers at once (`no elytra flee: no clear climb from here on any heading, none straight
up`), and the flight on foot goes on in the same look.

### Measured (bds-pve and bds-gaunt, BDS 1.26.60.6, 2026-11-14; `test/e2e/gaunt-mobs.test.ts` with `MOBS_ELYTRA=1 MOBS_AB=fleeFly`)

The gauntlet's cells where a bare-handed bot died before (the table in "Track M2"), each kit carrying an elytra and
64 rockets, `fleeFly` off and on alternating, 60 s a run, the home on the spot; 10 runs a side for the five cells that
killed most, 5 a side for the rest and for the live kit.

| kit | cell | `fleeFly` | n | deaths | damage a run | lowest health (median) | runs the flee was asked in | its flights: landed / ended otherwise / refused | from the spot at the end (median, flee runs) |
|---|---|---|---|---|---|---|---|---|---|
| bare | act-landed | off | 5 | 1 | 19 | 7 | 0 | 0 / 0 / 0 | - |
| bare | act-landed | on | 5 | 0 | 10 | 13 | 5 | 5 / 0 / 0 | 105.1 |
| bare | enderman-1 | off | 5 | 1 | 12.6 | 13 | 0 | 0 / 0 / 0 | - |
| bare | enderman-1 | on | 5 | 0 | 8.4 | 13 | 1 | 0 / 0 / 0 | 101.5 |
| bare | mixed-4 | off | 5 | 1 | 18 | 5 | 0 | 0 / 0 / 0 | - |
| bare | mixed-4 | on | 5 | 0 | 11.4 | 11 | 5 | 5 / 0 / 0 | 91.8 |
| bare | mixed-8 | off | 10 | 0 | 12.8 | 12 | 0 | 0 / 0 / 0 | - |
| bare | mixed-8 | on | 10 | 0 | 12.8 | 12 | 9 | 9 / 0 / 0 | 109.4 |
| bare | pillager-1 | off | 10 | 10 | 25.3 | 0 | 0 | 0 / 0 / 0 | - |
| bare | pillager-1 | on | 10 | 0 | 19.6 | 7 | 10 | 19 / 0 / 0 | 210 |
| bare | seal-5 | off | 5 | 4 | 25.8 | 0 | 0 | 0 / 0 / 0 | - |
| bare | seal-5 | on | 5 | 0 | 18.2 | 9 | 5 | 6 / 0 / 0 | 108.2 |
| bare | skeleton-2 | off | 10 | 9 | 26.2 | 0 | 0 | 0 / 0 / 0 | - |
| bare | skeleton-2 | on | 10 | 0 | 9 | 12 | 10 | 10 / 0 / 0 | 78.5 |
| bare | skeleton-4 | off | 10 | 9 | 27.5 | 0 | 0 | 0 / 0 / 0 | - |
| bare | skeleton-4 | on | 10 | 0 | 9.1 | 12 | 10 | 10 / 0 / 0 | 92.9 |
| bare | stray-1 | off | 5 | 1 | 18.6 | 6 | 0 | 0 / 0 / 0 | - |
| bare | stray-1 | on | 5 | 0 | 8 | 12 | 5 | 4 / 0 / 0 | 77.5 |
| bare | witch-1 | off | 10 | 10 | 25.9 | 0 | 0 | 0 / 0 / 0 | - |
| bare | witch-1 | on | 10 | 0 | 29 | 1 | 10 | 10 / 0 / 0 | 71.9 |
| bare | witch-2 | off | 5 | 5 | 27.8 | 0 | 0 | 0 / 0 / 0 | - |
| bare | witch-2 | on | 5 | 0 | 28.8 | 1 | 5 | 6 / 0 / 0 | 71.4 |
| bare | zombie-1 | off | 5 | 0 | 6.2 | 17 | 0 | 0 / 0 / 0 | - |
| bare | zombie-1 | on | 5 | 0 | 3.6 | 17 | 0 | 0 / 0 / 0 | - |
| bare | zombie-2 | off | 5 | 0 | 13.2 | 12 | 0 | 0 / 0 / 0 | - |
| bare | zombie-2 | on | 5 | 1 | 15 | 7 | 1 | 1 / 0 / 0 | 97.6 |
| live | mixed-8 | off | 5 | 0 | 21.8 | 1.1 | 0 | 0 / 0 / 0 | - |
| live | mixed-8 | on | 5 | 0 | 27.5 | 1.3 | 1 | 1 / 0 / 0 | 98 |
| live | seal-5 | off | 5 | 0 | 13.4 | 12 | 0 | 0 / 0 / 0 | - |
| live | seal-5 | on | 5 | 0 | 12.6 | 11.1 | 0 | 0 / 0 / 0 | - |
| **bare, all** | | off | 90 | **51** | | | | | |
| **bare, all** | | on | 90 | **1** | | | | | |
| **live, all** | | off | 10 | **0** | | | | | |
| **live, all** | | on | 10 | **0** | | | | | |

What the rows say:

- **Bare-handed, the flee off: 51 deaths in 90 runs; on: 1 in 90.** The cells that killed a bare-handed bot are the
  ones a fist does not answer: a witch (10 of 10, and 5 of 5 with two), a pillager (10 of 10), two and four skeletons
  (9 of 10 each), four skeletons and a witch (4 of 5). With the flee on, none of those 50 runs died.
- **How a flee goes**: asked at the first flee trigger (a witch's potion at 11 health, an archer in sight below 14),
  the flight's first tick about half a second later (the elytra put on; then the jump and the first rocket once the
  server has the glide), 96 blocks away after 6 to 8 s on 1 rocket, landed by the brake with no hostile known near.
  87 flees were asked in the 90 runs with the flee on; 85 had landed when their run ended, 2 were still in the air,
  none was refused and none ended otherwise.
- **A pillager follows** (it sees 64 blocks): 19 flees in 10 runs, the second one from where the first had landed.
  The first series of this cell flew the second flee home, 68 to 116 blocks back the way the pillager had come, and
  one run of 10 died there with the pillager 23 blocks from the landing; since then home is a destination only when
  no hostile round the body stands on the way to it (0 deaths in 10, the body 210 blocks from the spot at the end).
- **A witch's poison lands anyway**: the damage with the flee on is as high as without (29 against 26 to 28) and the
  health goes to 1, because the poison of the potion that started the flee runs for 45 s. It stops at 1; what killed
  before was her next potion, which a body 96 blocks away does not get.
- **The one death with the flee on** (`zombie-2`, 1 run of 5; 0 of 5 with it off): two zombies, 27 damage in 5 hits
  (an armed one), the flight on foot and no flee asked in that run. Why the flee was not asked was not found (the
  run had no trace); the floors that ran are the ones that run with the setting off, and the other four runs of the
  cell asked for the flee once.
- **The other cells**: `mixed-8` and `zombie-1` no death either way; `mixed-4`, `enderman-1`, `stray-1` and
  `act-landed` 1 of 5 each with the flee off, 0 of 5 with it on.
- **The live kit** (the netherite set, a sword, a shield): 0 deaths in 10 either way. With a blade the flee comes
  from 6 health down: it was asked once in 10 runs (`mixed-8`, the witch's poison) and landed.

Still lost where the sky is not open: everything above happened on open ground. Under a roof `fleeReady` says no and
the floors are Track M2's.

### Without rockets, and under a roof

- **Fewer than 3 rockets**: no flee. A glide needs height to begin with: from flat ground a jump gives 1.25 blocks,
  which is a glide of about 12 blocks at walking pace and no gain over running. From a ledge 12 or more over the
  ground the flight code can glide down without a rocket (`glideDown`, docs/flight.md "Glide down"): about 10 blocks
  out for every block of height. That is not wired into the flee: it would need a ledge search under attack and has
  not been tried. A bare-handed bot with an elytra and no rockets has the flight on foot, the dodge and the seal-in.
- **Under a roof or in a cave**: no flee (the column over the body must be open 8 up, and the takeoff's simulation
  clear). What is still lost there is what was lost before this track: bare-handed against archers and a witch with
  `mobDodge` off, and a bot at low health with a melee mob as fast as it is.

### On the Realm (2026-11-15)

`fleeFly` on, the live kit (netherite, a sword, a shield), flat open ground at night, `!test mobs`: four skeletons
three times, a witch three times, four zombies twice, a pillager twice. No death in the 10 runs, damage 0 to 1.6 a
run, every set cleared (3 to 33 s), and the flee was not asked once (`floors none`): with a blade it comes only from
6 health down or once running has failed, and no run came near that. So the Realm shows that the setting does not
disturb a fight the kit wins; it does not show a flee. A flee there needs a run without a blade in the hotbar, which
`!test mobs ... bare` (Track T2) now arranges. (These runs'
`floors none` came from the counter bug that Track T2 fixed, see "`!test mobs`" above, so the records prove nothing.
The bot's own log of the 10 runs does: it has no `floor: elytra flee (...)` line and no flee process started, so the
flee was indeed not asked.)

The creeper and mixed sets, the same day and kit with `fleeFly` off (`force`, mobGriefing on): a creeper three times,
four creepers three times, the mixed four twice, the mixed eight twice. No death; no damage but in the mixed eight
(6.1 and 6.8, most of it a witch's poison); 15 creepers killed and none went off.

**The flee flown there** (the same day, `fleeFly` on, `bare`: the sword out of the hotbar; the netherite armour on, and
the fight took the pickaxe from the hotbar, so not bare hands). Four skeletons (3 runs) and a witch (3 runs) never came
to a flee trigger: 0.6 to 1.3 damage a run, the witch dead in 3 s. The mixed eight, 5 runs: 6.5 to 10.2 damage a run,
the lowest health 13.3 to 17.4, no death, and one flee, asked when a witch stood 5.9 off at 13.8 health (the rule for
a shooter in sight below 14 with no blade). Four more runs of the mixed eight with `fleeHealth` raised to 19, so that
any hit is a flee trigger, gave two more. The three flees:

| asked for | the takeoff began | flew | landed |
| --- | --- | --- | --- |
| a witch 5.9 off, health 13.8 (2 creepers, 5 melee, 8 shooting, 1 flying known within 32) | 59 ms after the ask | 96 blocks in 9 s, 1 rocket | no hostile known near |
| a creeper 3.5 off, health 18.9 (6 creepers, 10 melee, 4 shooting, 1 flying) | 60 ms | 96 blocks in 10 s, 1 rocket | no hostile known near |
| a zombie 2.7 off, health 18.9 (6 creepers, 8 melee, 5 shooting, 2 flying) | 1.2 s | 96 blocks in 8 s, 1 rocket | a wild hostile 12 off |

None was refused and none ended in a death; each landed by the brake and the elevator on ground the search chose from
the air. So the flee works on real ground; what the Realm has not shown is a flee that mattered (the armour kept every
run far from death). `fleeFly` is on on the Realm since. Seen in the same runs: with a full inventory the stowed sword
could not go back to its slot (a mob's drop had taken it) and stayed in the main inventory, and for the next hour no
fight could pull it back either (the hotbar puller needed a free slot: "Weapon pull" above). Both are fixed by Track
T2's follow-ups (the exchange). On the Realm the same evening, after them: a bare series of three runs ended
`netherite_sword back in slot 8 (exchanged with spider_eye, now in slot 34)`, and the next fight was fought with the
sword.

## Track M4: early-game kits

Decision record: [decisions/0079-never-die-to-mobs.md](decisions/0079-never-die-to-mobs.md) "Addendum: Track M4"
(decisions 32 to 38). Everything here ran on bds-pve and bds-gaunt (BDS 1.26.60, normal difficulty) on 2026-11-16 with
the gauntlet (`test/e2e/gaunt-mobs.test.ts`) unless it says otherwise.

Tracks M1 to M3 measured two kits: bare hands and the owner's netherite set. A bot early in a world has neither: it has
stone tools, then iron, and often nothing but food after a death. The gauntlet has three more kits for that, each with
16 bread and no elytra:

| kit | what it carries |
|---|---|
| `none` | nothing but the bread |
| `stone` | a stone sword, pickaxe, axe and shovel; no armour, no shield |
| `iron` | an iron sword, the iron set, a shield, a stone pickaxe and shovel |

`MOBS_TIME=day` runs a cell at noon instead of midnight (summoned undead have no helmet and burn).

### The screen (one run a cell, the code before this track)

Deaths / runs and the mean damage a run.

| cell | iron day | iron night | none day | none night | stone day | stone night |
|---|---|---|---|---|---|---|
| zombie-1 | 0/1 0 | 0/1 0 | 0/1 17 | 0/1 3 | 0/1 0 | 0/1 0 |
| husk-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 3 | 0/1 0 | 0/1 0 |
| baby-1 | 0/1 0 | 0/1 0 | 0/1 8 | 0/1 3 | 0/1 0 | 0/1 0 |
| drowned-1 | 0/1 0 | 0/1 0 | 0/1 18 | 0/1 0 | 0/1 0 | 0/1 0 |
| zvillager-1 | 0/1 0 | 0/1 0 | 0/1 16 | 0/1 3 | 0/1 0 | 0/1 0 |
| skeleton-1 | 0/1 0 | 0/1 0 | 0/1 15 | 0/1 17 | 0/1 0 | 0/1 0 |
| stray-1 | 0/1 0 | 0/1 0 | 0/1 16 | 0/1 17 | 0/1 0 | 0/1 0 |
| creeper-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| spider-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| cavespider-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| phantom-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| witch-1 | 0/1 0 | 0/1 0 | **1**/1 26 | **1**/1 23 | 0/1 0 | 0/1 0 |
| enderman-1 | 0/1 0 | 0/1 0 | 0/1 7 | 0/1 0 | 0/1 0 | 0/1 0 |
| pillager-1 | 0/1 1.9 | 0/1 1.4 | **1**/1 24 | **1**/1 24 | 0/1 4 | 0/1 7 |
| slime-1 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| zombie-2 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 4 | 0/1 0 |
| zombie-4 | 0/1 0 | 0/1 0 | 0/1 3 | 0/1 0 | 0/1 4 | 0/1 3 |
| skeleton-2 | 0/1 1.9 | 0/1 1.9 | 0/1 19 | **1**/1 33 | 0/1 8 | 0/1 3 |
| skeleton-4 | 0/1 3.3 | 0/1 3.8 | **1**/1 24 | **1**/1 25 | 0/1 8 | **1**/1 33 |
| creeper-2 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| creeper-4 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| spider-2 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 2 | 0/1 0 |
| spider-4 | 0/1 0 | 0/1 0.9 | 0/1 0 | 0/1 20 | 0/1 0 | 0/1 0 |
| phantom-2 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| phantom-4 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 | 0/1 0 |
| witch-2 | 0/1 2 | 0/1 1 | **1**/1 28 | 0/1 29 | 0/1 1 | 0/1 2 |
| seal-5 | 0/1 9.8 | 0/1 13.8 | 0/1 33 | 0/1 0 | **1**/1 23 | **1**/1 28 |
| mixed-4 | 0/1 1.9 | 0/1 0 | 0/1 10 | **1**/1 26 | 0/1 0 | 0/1 8 |
| mixed-8 | 0/1 15.9 | **1**/1 27.9 | 0/1 12 | **1**/1 29 | 0/1 3 | 0/1 13 |
| act-goto | 0/1 0 | 0/1 0 | 0/1 9 | 0/1 27 | 0/1 8 | 0/1 10 |
| act-mine | 0/1 1.9 | 0/1 1.9 | 0/1 11 | 0/1 11 | 0/1 7 | 0/1 0 |
| act-eat | 0/1 3.8 | 0/1 5.2 | 0/1 4 | 0/1 17 | 0/1 12 | 0/1 11 |
| act-landed | 0/1 2.4 | 0/1 0 | 0/1 15 | 0/1 14 | 0/1 5 | 0/1 0 |
| **all** | **0** of 33, 1.4 a run | **1** of 33, 1.8 a run | **4** of 33, 9.5 a run | **6** of 33, 9.8 a run | **1** of 33, 2.7 a run | **2** of 33, 3.6 a run |

The weapon kits kill one mob of any kind in 2 to 4 s. What kills them is a crowd of archers with a witch (`seal-5`: four
skeletons and a witch), four skeletons, and the witch's poison in `mixed-8`. The `none` kit dies where bare hands died before
(the archers, the pillager, the witch: a fist does not reach them, Track M2), and takes 15 to 18 from one zombie or drowned by
day.

### What killed (the traces)

Each death's last 10 s, tick by tick (`MOBS_TRACE`), on both sides of the first A/B series:

- **Standing at home in an archer's line.** The stone kit's `skeleton-4` killed three and stood at home at 6 to 7 health
  while the fourth shot it dead from 10 to 15. No flee: at home a flee starts only for a threat within 6 (Track W). No duel:
  the duel with an archer wants more than twice the last hit (an arrow of 3 or 4 without armour). Guard at low health
  defends in place and does not walk to an archer. So nothing ran.
- **The flight on foot went home, into the skeletons.** In 17 of 26 stone-kit `seal-5` deaths the flight on foot had a leg
  home in its last 10 s, at 1 to 6 health. Home counts as clear when no threat stands nearer than it in its direction (the
  angle rule, Track W); the skeletons stood 12 to 15 from home beside it or beyond it, so home was "clear" and in their range.
- **A tick of poison read as a hit of 1.** The witch's poison takes the health down by 1 every 25 ticks to 1. Each tick
  came to the guard as a hit, blamed on the nearest skeleton (the attacker guess takes a ranged mob within 20), and became
  the duel's "last hit": twice 1 is 2, so the duel went on at 3 health and the next arrow killed. Seen in the stone kit's
  `seal-5` and the iron kit's `mixed-8`.
- **The legs of the flight changed every second.** The iron kit's `mixed-8` death: the poison at 1 health, a husk 10 to 12
  behind and a skeleton coming in and out of view at 15; the flight switched between `far` and `home` every 10 to 20 ticks,
  each switch a new walk, each new walk stops the body for a moment, and it never sprinted.
- **The flight on foot walks.** Over every flee tick in the screen's traces the body had the sprint in 13 % of the `away`
  ticks, 32 % of `home` and 0 % of `far`, and covered 0.18 to 0.20 blocks a tick, under a walk's 0.216 (a sprint is
  0.281). The walk sprints only while more than 8 blocks of straight path are left (5, plus 3 it keeps to stop in), and a
  leg of the flight is about that long.

### The rules (`PveController.rules`)

Five rules, each a choice the guard or the flight on foot already makes, so each is a switch of the controller, not a
setting (`PveRules`, on by default; the gauntlet turns them off with `MOBS_RULES` or flips them with `MOBS_AB_RULE`):

| rule | what it does | why |
|---|---|---|
| `archerDuel` | With a blade, below `fleeHealth`, within 16 of home (no shelter), only archers within 16 (2 at most; no melee mob, creeper or witch) and one with a line on the bot: that archer is a duel (`canDuel`) and guard's first target, fought with the approach, not in place (`archerDuelTarget`). Not at 5 health or under (after the poison, below) | standing still in an archer's line is the one choice that is sure to lose; at 5 or under one arrow ends it and the flight on foot is the better bet |
| `poison` | The bot's own poison (`mob_effect`, effect 19) is tracked (`MobTracker.selfPoison`). A drop of 1 while poisoned is the poison: no attacker guess, not the duel's last hit, counted as `pve.taken.poison`. The duel's margin and the archer duel's floor count the health the poison will leave (`healthAfterPoison`: one every 25 ticks at level I, 12 at II, until it ends, never below 1); low health (the flee) stays the health itself | the poison stops at 1 whatever the armour; a duel judged on 9 health was a duel at 1. Counted in low health too, the bot ran from the witch who poisoned it and she followed (below) |
| `shooterHome` | Home is no place to flee to while an archer or a witch stands within 16 of it (`shooterNear`), seen or not: no `home` leg, not even after `FLEE_FAR` out. At home, an archer with a line on the bot is fled from at low health, whatever its distance (not a witch) | archers shoot at home too; the angle rule is for melee mobs that walk after the bot. A witch walks after a bot that runs, and guard at home kills her (Track M2) |
| `legHold` | A leg of the flight on foot holds 2 s (`FLEE_LEG_HOLD_MS`) unless a threat comes within `FLEE_URGENT` (6); `home` or `far` goes back to `away` only with the nearest threat inside `FLEE_AWAY` - 3; `home` again only once home has stayed clear for 2 s; never on towards a home no longer clear (`fleeLeg`) | each change of leg is a new walk, and a new walk stops the body |
| `fleeLong` | The `away` and `far` legs run 8 blocks farther than they need (`FLEE_LONG`, `fleeRadius`) | a longer leg is a walk long enough to sprint, and fewer new walks |

### Before and after (10 runs a side)

Every row below ran as an A/B series on one server: the five rules off, then on, alternating, 5 runs a side a chunk, two
chunks (`MOBS_AB_RULE=legHold,archerDuel,fleeLong,poison,shooterHome`). The `off` side is the code before this track.

| kit, time | cell | off: deaths, damage a run | on: deaths, damage a run |
|---|---|---|---|
| stone, night | `skeleton-4` | **6** of 10, 20.3 (M9) | **0** of 10, 18.5 (M9) |
| stone, night | `seal-5` | **10** of 10, 25.3 (M9) | **5** of 10, 28.9 (M9) |
| stone, night | `mixed-8` | **3** of 10, 28.6 (M9) | **2** of 10, 26.6 (M9) |
| stone, night | `act-goto` | 0 of 3, 6.0 | 0 of 3, 1.3 |
| stone, night | `act-eat` | 0 of 3, 10.3 | 0 of 3, 11.3 |
| stone, day | `seal-5` | **7** of 10, 23.9 (M9) | **0** of 10, 20.2 (M9) |
| iron, night | `mixed-8` | 0 of 10, 21.9 | 0 of 10, 27.1 |
| iron, night | `seal-5` | **4** of 10, 17.5 (M9) | **0** of 10, 17.4 (M9) |
| none, night | `witch-1` | **10** of 10, 26.9 (M9) | **5** of 10, 29.3 (M9) |
| none, night | `skeleton-4` | **9** of 10, 26.7 (M9) | **1** of 10, 22.8 (M9) |
| none, night | `pillager-1` | **10** of 10, 24.5 (M9) | **9** of 10, 27.5 (M9) |
| live, night | `mixed-8` | 0 of 10, 26.8 | 0 of 10, 21.7 |

The rows marked (M9) were measured again by Track M9 on the gauntlet as Track M8 left it (every run from rest; 0
harness reruns), 10 a side over both servers, with the rules that came after this track switched off on both sides
(`MOBS_RULES`), the code otherwise that of Track M8. First measured (off; on): stone `skeleton-4` 8, 22.2; 0, 18.8;
stone `seal-5` 10, 24.1; 2, 25.3; stone `mixed-8` 6, 26.5; 1, 16.1; stone day `seal-5` 6, 21.5; 1, 15.3; iron
`seal-5` 7, 22.4; 3, 19.4; no-kit `witch-1` 9, 25.1; 2, 28.1; no-kit `skeleton-4` 7, 24.6; 3, 22.9; no-kit
`pillager-1` 10, 26.6; 6, 27.2. Over the eight rows the rules still take the deaths from 59 of 80 to 22 of 80 (first
63 to 18); the stone `seal-5` and the no-kit `witch-1` and `pillager-1` rows keep more deaths on the `on` side than
first measured, the stone `mixed-8` row's `off` side fewer.

The live kit (the netherite set) with the rules on, every cell once by night: 0 deaths in 33, 1.4 damage a run (Track
M2's final code, its defaults: 0 of 99, 1.3 a run). The iron kit's `mixed-8` damage is the witch's poison landing or not
(29 to 30 in the runs it landed, 1.4 to 4.7 in the others; 7 of 10 off, 9 of 10 on), not a floor: no flee in 8 of 10 runs
either side. Its off side in the series before the last change (below) died 3 times in 10.

How the rules came in, each measured as it came (the same A/B, 5 or 10 runs a side, the stone kit by night unless it says
otherwise; the `off` side is the code before this track each time):

| step | rows | off | on |
|---|---|---|---|
| `legHold`, `archerDuel` | `skeleton-4`; `seal-5` (10 a side) | 5 of 10; 10 of 10 | 3 of 10; 7 of 10 |
| and `fleeLong` | `skeleton-4`; `seal-5` (5 a side) | 5 of 5; 5 of 5 | 2 of 5; 2 of 5 |
| `fleeLong` alone, the other two on | `skeleton-4` (5 a side) | 2 of 5 | 1 of 5 |
| the three | iron `mixed-8` (5 a side) | 0 of 5 | 1 of 5: poisoned to 1.2, then a duel with a skeleton at 2 to 4 (the poison tick read as a hit) |
| `poison`, `shooterHome` (first form), the three on | `seal-5` (10 a side) | 9 of 10 | 5 of 10 |
| all five, the duel's floor of 5, low health counting the poison, the at-home flee from witches too | `seal-5`; `skeleton-4`; iron `mixed-8`; stone `mixed-8` (10, 10, 10, 5 a side) | 10; 6; 3; 0 | 5; 1; 0; **2 of 5** |
| the last change: low health the health itself, the at-home flee from archers only | the table above | | |

The step before the last made the stone kit's `mixed-8` worse: poisoned, its low health counted 1, so it fled from the
witch who poisoned it in 4 of 5 runs (1 of 5 off); she walked after it at 12 to 15 blocks and her harming killed it at 1
health 100 and 150 blocks out. The flee is now judged on the health itself, and only an archer is fled from at home.

### Tried and not taken

- **The approach to an archer sprinting** (`archerSprint`, a nav option to sprint to the path's end). In the stone kit's
  traces guard walked after a skeleton at 4 to 8 for seconds: the approach is a path of 2 to 6 blocks, under the 8 a sprint
  needs. With the sprint the approach was quicker but a sprint's strike knocks the skeleton farther back: `skeleton-4`,
  5 runs a side, the fights cleared in 17.6 s against 15.1, damage 20.6 against 14.6, 1 death against 0. Removed.

**`sealIn` with the rules** (A/B of the seal alone, `legHold` and `archerDuel` on, the stone kit's `seal-5` by night, 5
a side): 4 deaths of 5 off, 2 of 5 on, and both runs in which it sealed lived. It places blocks, so it stays off by
default (decision 27); this is the measured case for turning it on with an early kit, n 5, on flat ground only.

### The harness: a mob out of sight is not cleared

`!test mobs` cleared a run when it saw none of its mobs for 3 s (`bare` series, Track T2: `cleared in 7.6 s` after a flee
of 96 blocks). Now, with a mob gone from view without its death seen, it asks the server: `/testfor @e[name=<tag>]`, at
most every 2 s (`COUNT_EVERY_MS`), answered by the command's success count (0 = none: cleared, `clearedBy: server`). A count
above 0 keeps the run going; at the end the run says `N left after T s (N out of sight)`. No answer clears it as before,
with `(none in sight, the server did not answer)` in the line (`clearedBy: unconfirmed`); a rate-limited ask is asked again.
The gauntlet never had the fault (it reads the server's entity list).

### Not met

- **The bar (no death under every activity) is not met for the early kits.** On the final code the stone kit still died
  2 in 10 in `seal-5` by night, 1 in 10 in `mixed-8` and in `seal-5` by day; the iron kit 3 in 10 in `seal-5`; the `none`
  kit 2 to 6 in 10 against one witch, four skeletons or one pillager. The remaining deaths: the witch's harming (6, which
  armour does not reduce) while guard fights her at 6 or 7 health with skeletons shooting (the iron kit, 2 of 3); arrows
  while the poison holds the bot at 1 to 4 (the archer duel's floor leaves it to the flight on foot, which archers
  outrange); a witch who walks after a far flight and throws harming at 1 health 150 blocks out; once a home leg that ran
  past a skeleton 5 to 10 off. A bot with no blade has no answer to archers in the open but distance; the seal-in is the
  measured one (above) and it ships off. Open: keeping out of a witch's throw at 6 health or under.
- **Not run on the Realm.** The early kits cannot be set up there (no cheats: no stone or iron items given, the worn armour
  cannot be taken off), so `!test mobs` has no kit option; its `bare` stows the blades only.
- The rows are flat grass, guard radius 16, home on the spot; cliffs, caves and water are not in them.

### On the Realm

The rules are on with the update; no setting changes. With the netherite set a run seldom reaches low health, so the
Realm shows the rules' log lines, not their effect on deaths. By night, near home, `fleeHealth` as it is:

- `!test mobs skeleton4 5 bare` and `!test mobs witch 5 bare`: look for `pve: took 1.0 damage (poison, N s left), health
  H, A once it ends` (a poison tick, not a hit: the run's `hits` no longer name a skeleton for it), `flee: an archer or a
  witch within 16 of home: not running there while it stays`, and, after the run, `N left after T s (N out of sight)` or
  `cleared` (the server was asked, not only the bot's view).
- `!test mobs mixed8 5`: the same lines, and `guard: skeleton #N within 16 blocks, fighting (the archer at home, health
  H: not standing in its line)` when only archers are left at low health. Deaths and the lowest health are the bar: no
  death, and the series' damage a run not above the last `mixed8` series.

## Track M5: witches and arrows under poison

Decision record: [decisions/0079-never-die-to-mobs.md](decisions/0079-never-die-to-mobs.md) "Addendum: Track M5"
(decisions 39 to 44). Everything here ran on bds-pve and bds-gaunt (BDS 1.26.60, normal difficulty) on 2026-11-16 with
the gauntlet (`test/e2e/gaunt-mobs.test.ts`, the kits of Track M4) unless it says otherwise.

### Clean cells first (the harness)

The 64 cells of a server's private area are shared by every pve suite and every run, and blocks a run leaves (a seal-in's
shell, a pen, a build of a crashed case) are where the next run stands. Track M4's pve-combat deaths were all
`death.attack.inWall`, counted as zombie hits. Now:

- **Every case starts on clean ground** (`cleanSpot` in `test/e2e/pve-truth.ts`): the flat world's layers are laid under a
  square round the spot (dirt 2, grass 1, the bedrock under them untouched), the air over it is cleared, the entities near it
  are removed, and the spot's cells are read back from the server (feet and head round the spot must be air and the floor
  grass, or the case fails as a harness error). Every pve suite (combat, creeper, crowd, events, follow, m1, m4, m5, night,
  rules, testmobs, walls) and the gauntlet's spots call it. A spot that was not clean is said in the log
  (`clean spot X Y Z: it was not clean (...)`, and to `PVE_CLEAN_LOG`): on 2026-11-16, 10 spots, one with oak planks at feet
  and head (a seal-in's wall), four filled with stone to head height.
- **A death no mob caused is a harness failure, never a row's death** (`skills/test/death.ts`): the death message's key
  says it (`death.attack.inWall`, `fall`, `outOfWorld`, ...), and with no message (`health_zero`) the killing hit's cause in
  the server's hurt log. The gauntlet runs such a run again (up to 2 times) and counts it apart (`harness: N`); a pve case
  fails with the cause (`expectAlive`). `!test mobs` names the cause of a death in its run line (`DIED (death.attack.arrow)`,
  `(<cause>: not a mob)`).
- **A case's leftover flight is stopped**: pve-combat's two-zombie runs went on with the flight on foot the previous run had
  started (its zombies took the bot under 14), which walked the bot 90 blocks home after the next teleport, and the next
  run's zombies were never in view (`timed out waiting for tracked`); each run now stops it first.

Proof: pve-combat four runs (13 cases each), pve-testmobs two runs (8 of 8 each), 21 gauntlet logs: no `inWall` or
suffocation anywhere, 0 harness reruns in the gauntlet. The pve-combat runs that failed failed on non-harness cases (the
leftover flight above, once; a kit bite in the weapon-pull case, fixed with full food).

### The rows that still killed (the code of Track M4)

10 runs a side; deaths, mean damage a run, the median of each run's lowest health.

| kit, time | cell | deaths | damage | lowest (median) |
|---|---|---|---|---|
| stone, night | `seal-5` | **4** of 10 | 25.4 | 1 |
| stone, night | `mixed-8` | **3** of 10 | 28.5 | 1 |
| stone, night | `witch-2` | 0 of 10 | 3.7 | 19 |
| iron, night | `seal-5` | 0 of 10 | 19.0 | 8.6 |
| none, night | `witch-1` | **2** of 10 | 23.2 | 1 |
| none, night | `witch-2` | **2** of 10 | 21.8 | 1 |
| none, night | `skeleton-4` | **2** of 10 | 21.4 | 5 |

The `off` sides of the A/B series below are the same code; with them the stone kit's `seal-5` died 8 times in 30 and its
`mixed-8` 4 times in 30.

### What killed (the traces)

- **The way home ran past the archer.** At 1 to 2 health (the poison stops at 1) the bot stood 30 to 50 blocks out with
  nothing within 16 for 2 s, so the flight counted the danger as over and home as clear, and walked home; the skeleton that
  had followed it out stood beside that way and shot it at 11 to 15. All three stone `mixed-8` deaths, two of four stone
  `seal-5` deaths, one of the two `none` `skeleton-4` deaths, one `none` `witch-1` death. M4's `shooterHome` looks at home only (within 16
  of it); these archers were 20 to 40 from home.
- **A bite in the witch's reach.** A bot with no blade fled the witch at 1 to 2 health, poisoned, with her walking after it
  at 13 to 16 (her throw reaches about 10); each bite slows the body for 1.6 s (an item in use), she came to 10 to 12 and her
  harming killed it (both `none` `witch-2` deaths). A bite heals nothing while the poison holds the health at 1.
- **The witch first with archers shooting.** With a stone sword at home at 7 to 10 health, guard fought the witch first
  (Track M1's rule: within 8 at any health) while two skeletons 8 to 12 off shot; her harming (6) took it to 1 to 4 and the
  next arrow killed it (two of four stone `seal-5` deaths). A stone or iron sword needs 5 or more hits on her, a netherite
  one 3 (1.7 s).
- **Out of the server's range is not gone.** bds-pve sends a skeleton 24, 40 and 56 blocks off and not one 72, 88 or 104
  off (pve-m5 `range`). A bot 53 out at 1 health had no entity for the skeleton standing at home, so even the rules above
  could not see it.

### The rules (`PveController.rules`, on by default)

| rule | what it does | why |
|---|---|---|
| `shooterWay` | Below `fleeHealth`, no `home` leg while a live archer or witch stands within 16 (`SHOOTER_WAY`) of the way from the bot to home, seen or not, behind the bot excepted (`shooterOnWay`); the bot stays out (`far`) until the health is back. Archers and witches the server stopped sending 48 or more off (`SHOOTER_LOST_FAR`) are kept at their last place for 60 s (`SHOOTER_MEMORY_MS`, `rememberedShooters`); one lost nearer is taken for dead | the angle rule (Track W) and `shooterHome` see only what stands nearer than home in its direction or at home; an archer that followed the bot out stands beside the way |
| `poisonBite` | In the flight on foot, no bite while the bot is poisoned and an archer or a witch is within 24 (`FLEE_SCAN` + 8), unless the food is down to `FOOD_SPRINT_EAT` (`biteHeld`) | a bite slows the body and heals nothing under the poison; she follows at 13 to 16 and throws from 10 |
| `witchCrowd` | At 10 health or under (`WITCH_CROWD_HEALTH`: her harming 6 and an arrow 4), with an archer with a line on the bot within 16 and no sword better than iron (`WITCH_CROWD_BLADE`, a diamond sword's score), the witch is not the first target (`firstTarget`); the floors decide as for any mob | one throw and one arrow are the health, and a stone or iron sword does not kill her before her next throw |

Lines in the log: `flee: an archer or a witch within 16 of the way to home: staying out at health H`, `flee: no bite while
poisoned with an archer or a witch within 24 (health H, food F)` (once a flight each), `guard: the witch is not first at
health H with an archer shooting (...)` (at most every 30 s). The poison tick's line now rounds the health to one decimal.

### Each rule on its rows (5 runs a side a chunk, the other rules as they were then)

Deaths, mean damage a run, the median of each run's lowest health.

| rule | kit, cell | off | on |
|---|---|---|---|
| `shooterWay` (no memory yet) | stone `mixed-8` | 1 of 10, 21.8, 1.5 | **0** of 10, 24.6, 1 |
| `shooterWay` (no memory yet) | stone `seal-5` | 3 of 10, 24.7, 1 | **0** of 10, 24.9, 1 |
| `shooterWay` | none `pillager-1` | 6 of 10, 27.9, 0 | 5 of 10, 27.8, 0.5 |
| `shooterWay` (again) | none `pillager-1` | 6 of 10, 25.9, 0 | 4 of 10, 25.0, 1 |
| `poisonBite` (`shooterWay` on) | none `witch-2` | 0 of 10, 27.4, 1; 24 bites | 0 of 10, **15.7**, 3.5; 3 bites |
| `witchCrowd` (the others on) | stone `seal-5` | 1 of 10, 29.1, 1 | 1 of 10, 28.8, 1 |
| `witchCrowd` (the others on) | iron `seal-5` | 1 of 10, 22.6, 1.6 | **0** of 10, **15.0**, 8.9 |

On the live kit's `mixed-8` an early form of `witchCrowd` (any blade) took the lowest health's median from 5.3 to 1.4 in 5
runs a side; it now leaves diamond and netherite swords alone.

### Before and after (all three rules, 10 runs a side)

`MOBS_AB_RULE=shooterWay,poisonBite,witchCrowd`: the three off (Track M4's code) then on, alternating, 5 a side a chunk,
one chunk on each server.

Deaths, mean damage a run, the median of each run's lowest health. Every row Track M4 changed is here.

| kit, time | cell | off (Track M4) | on (Track M5) |
|---|---|---|---|
| live, night | `mixed-8` | 0 of 10, 22.4, 1.6 | 0 of 10, 26.0, 1.3 |
| stone, night | `mixed-8` | 0 of 10, 24.5, 1 | 0 of 10, 24.8, 1 |
| stone, night | `seal-5` | **1** of 10, 24.6, 1 (M9) | 0 of 10, 27.6, 1 (M9) |
| stone, day | `seal-5` | 0 of 10, 20.3, 2 (M9) | **1** of 10, 22.5, 1.5 (M9) |
| iron, night | `seal-5` | **1** of 10, 23.5, 1.9 (M9) | 0 of 10, 21.1, 1.7 (M9) |
| iron, night | `mixed-8` | **1** of 10, 26.7, 1.6 (M9) | 0 of 10, 24.6, 1.7 (M9) |
| none, night | `witch-1` | **2** of 10, 28.6, 1 (M9) | 0 of 10, 24.8, 1 (M9) |
| none, night | `skeleton-4` | **3** of 10, 21.5, 2.5 (M9) | 0 of 10, 23.5, 4 (M9) |
| none, night | `pillager-1` | **7** of 10, 26.6, 0 (M9) | **3** of 10, 26.4, 2 (M9) |
| none, night | `mixed-8` | 0 of 10, 14.9, 11 | 0 of 10, 14.4, 9.5 |
| stone, night | `act-goto` | 0 of 4, 2.0, 18 | 0 of 4, 4.5, 16 |
| stone, night | `act-eat` | 0 of 4, 14.5, 7.5 | 0 of 4, 12.0, 10.5 |
| stone, night | `skeleton-4` | 0 of 10, 16.8, 7.5 | 0 of 10, 18.7, 4 |

The rows marked (M9) were measured again by Track M9 as Track M4's were (the gauntlet as Track M8 left it, 10 a side
over both servers, 0 harness reruns, the rules after this track switched off on both sides). First measured (off; on):
stone `seal-5` 1, 25.5, 1; 1, 24.0, 1; stone day `seal-5` 2, 19.9, 1.5; 0, 19.2, 4.5; iron `seal-5` 1, 20.4, 1.9;
0, 15.6, 12.9; iron `mixed-8` 1, 22.5, 1.5; 0, 17.9, 1.9; no-kit `witch-1` 4, 30.1, 1; 0, 16.4, 1; no-kit
`skeleton-4` 4, 21.0, 3.5; 0, 20.0, 5; no-kit `pillager-1` 7 of 12, 27.7, 0; 10 of 11, 27.5, 0. Over the seven rows
15 deaths in 70 off and 4 in 70 on (first 20 in 72 and 11 in 71). The witch rows' damage gap (30.1 to 16.4) and the
iron `seal-5` lowest median of 12.9 did not come back; the no-kit `pillager-1` row now goes the rules' way (7 to 3),
where it first went the other (7 to 10).

Every run of this table and the per-rule table: 0 harness reruns (no death by a block, the ground or the void).

- **The live kit** died in none of 20; its damage went up 22.4 to 26.0 and the lowest health's median down 1.6 to 1.3.
  The runs that took the most on either side are the ones the witch's poison landed in (its 1 point a second down to 1,
  then an arrow). `witchCrowd` leaves a netherite sword alone, and the other two act only in a flight below `fleeHealth`,
  which most of the live kit's runs never start; the difference is read as where the poison landed, not as a rule.
- **`pillager-1` with no kit** is the same either way: the 12 and 11 above with the two `shooterWay` series of the per-rule
  table make 19 deaths in 32 off and 19 in 31 on. No poison and no witch there, so `shooterWay` is the only rule that can
  act. Track M4 measured 6 in 10 with its rules on. (Track M9's re-measure from rest, above: 7 of 10 off, 3 of 10 on;
  the first series ran before Track M8's fix, where a run after a death started with the bot walking off its spot.)

### Not met

- **A crossbow with no blade and no armour.** `none` `pillager-1` dies in about 6 runs in 10. The pillager follows the
  flight on foot at 9 to 16 and hits 4 at a time; every death's last 10 s are the `far` leg with the pillager in line of
  sight. Running does not outpace it and the bot has nothing to fight it with; what would help (cover, a block between,
  a pillar) places blocks, so it is not a choice of leg and is not in this track.
- **The fight at home against 3 archers and a witch.** The stone kit's one night `seal-5` death on the `on` side was a
  fight at home at 8 to 13 health with three skeletons and a witch: one throw (6) and one arrow (4) are more than the
  margin over `fleeHealth` 8. A flight floor that counts the archers in sight would be a choice; it was not measured.
- **A fight among several archers above `fleeHealth`.** In one `none` `skeleton-4` death of the `before` rows guard
  fought a skeleton at 13 health with three more 4 to 15 off; two arrows took 9 to 0 in under a second. A floor that counts
  the archers in sight is the same open choice as above.
- **The lowest health stays at 1** in many rows on both sides: the poison holds the health at 1 and the rules keep the bot
  alive there, they do not keep it higher.
- **Activities.** Only `act-goto` and `act-eat` with the stone kit were run again (4 runs a side, no death on either
  side); the other activities of Track M4 were not.
- **The Realm.** No early kit can be given there, so the rules' effect on deaths is measured on the test servers only;
  the Realm recipe below checks that they act and that the live kit's series stay clean.

### On the Realm

The rules are on with the update; no setting changes. The Realm has no cheats, so no early kit can be given; with the
netherite set a run seldom reaches the health where the rules act, so `bare` (the blades stowed) is the nearest and the
Realm shows the rules' lines rather than their effect on deaths. By night, near home, `fleeHealth` as it is:

- `!test mobs witch 5 bare`: look for `flee: no bite while poisoned with an archer or a witch within 24 (...)` and, when
  the flight is far out, `flee: an archer or a witch within 16 of the way to home: staying out at health H`; the run's lowest
  health and damage against the last `witch 5 bare` series (Track M4 on the Realm: 5 of 5 alive, damage up to 9).
- `!test mobs skeleton4 5 bare`: the way line when a flight ends far out; every run alive.
- `!test mobs mixed8 5`: the live kit; no death, and no line of `witchCrowd` (the netherite sword is exempt).
- A death in any series now says its cause in the run line (`DIED (death.attack.arrow)`); one marked `not a mob` is the
  ground or a block, not the rules.

## Track M6: archer groups, crossbows

Decision record: [decisions/0079-never-die-to-mobs.md](decisions/0079-never-die-to-mobs.md) "Addendum: Track M6"
(decisions 45 to 50). Everything here ran on bds-pve and bds-gaunt (BDS 1.26.60, normal difficulty) on 2026-11-16 with
the gauntlet (`test/e2e/gaunt-mobs.test.ts`, the kits of Track M4) unless it says otherwise.

### What kills a bot with no blade and a pillager (the traces)

`none` `pillager-1` by night, the code of Track M5, 6 runs with the whole run traced (`MOBS_TRACE_ALL=1`, a row a tick):
4 of 6 died (`death.attack.arrow`), 25.8 damage a run. Every bolt that landed did 4. By the part of the run it landed in:

| part of the run | bolts | ticks there | a bolt every | median ticks between bolts | sprinting |
|---|---|---|---|---|---|
| guard, a fist chasing it | 17 | 1 245 | 73 ticks | 47 | 22 % |
| the flight's `away` leg | 11 | 723 | 66 ticks | 47 | 46 % |
| the flight's `far` leg | 7 | 3 675 | 525 ticks (26 s) | 276 | 38 % |

- **The fist chase is the killer.** Guard chased the pillager from 20 health; it backed off and shot every 47 ticks
  (its reload) from 2 to 5 blocks, 20 to 9 in about 7 s. The flight on foot started at 5 to 7 health with the fourth
  bolt.
- **The flight on foot keeps it at its reach.** On the `far` leg the pillager followed at 8 to 16 and in line of sight,
  but only bolts from 8.3 to 9.6 blocks landed (in these runs no bolt landed from farther than 9.6): one about every
  26 s. Those bolts killed at 1 to 6 health; from 20 the same leg is about 5 bolts of margin.
- So the run is not what fails; it starts 4 bolts too late. Breaking the line with the ground, closing in between bolts
  and cover were not needed for this cell (below).

The flank flake of `pve-combat` and the fight at home against three skeletons and a witch (Track M5 "Not met") are the
other two parts of this track.

### The rules (`PveController.rules`, on by default)

| rule | what it does | why |
|---|---|---|
| `bareArcher` | With no blade carried (`carriesBlade`: the hotbar or the main slots, since the fight fetches a blade from a main slot before its first strike; a pickaxe is no blade), an archer (skeleton, stray, bogged, pillager) within 16 (`FLEE_SCAN`) with a line on the bot starts the flight on foot at any health; at home too (`shooterHome` keeps a flight from an archer in sight at home). At 14 health (`FLY_SHOOTER_HEALTH`) or over the flight stays on foot (`foot`): Track M3's elytra flee for shooters starts below 14 and is not moved up | a fist does not reach an archer; the chase stands at 2 to 5 blocks in front of a bolt every 47 ticks, the flight keeps it at 8 to 10 with a bolt every 26 s |
| `volley` | At `fleeHealth` or over, the flight on foot also starts when the health is at most one round of the shooters in sight (`volleyLow`): 2 or more (`VOLLEY_MIN_SHOOTERS`) archers within 16 and witches within 10 (`VOLLEY_WITCH_RANGE`) with a line on the bot, each counted at its own last hit on the bot (else the last hit of its kind; at most 6, `VOLLEY_SHOT_MAX`), and before any hit an arrow at 4 (`VOLLEY_ARROW`) less 4 % a point of the armour worn and her harming at 6 (`VOLLEY_HARMING`). It changes only when the flight starts | Track M5's one stone `seal-5` death: a fight at home at 8 to 13 health with three skeletons and a witch, one throw and one arrow more than the margin over `fleeHealth` 8. Counting the last hits leaves an armoured bot fighting: the netherite set's four skeletons that have not hit are 3.2, not 16 |

Lines in the log (at the flight's start): `flee: health H at most one round of N shooters in sight (D) with <mob> at
<distance>; running away` and `flee: no blade with an archer in sight (health H) with <mob> at <distance>; running away`.

### Before and after (10 runs a side)

`MOBS_AB_RULE=volley,bareArcher` (the `pillager-1` row: `bareArcher` alone): the rules off (Track M5's code) then on,
alternating, 5 a side a chunk, one chunk on each server.

Deaths, mean damage a run, the median of each run's lowest health.

| kit, time | cell | off (Track M5) | on (Track M6) |
|---|---|---|---|
| none, night | `pillager-1` | **4** of 10, 25.7, 1 (M10) | 0 of 10, 12.7, 13.5 (M10) |
| none, night | `skeleton-4` | **1** of 10, 22.6, 4 (M10) | 0 of 10, 3.7, 16 (M10) |
| none, night | `mixed-8` | 0 of 10, 16.8, 7 | 0 of 10, 0.3, 20 |
| stone, night | `seal-5` | 0 of 10, 29.0, 1 | 0 of 10, 25.2, 1 |
| stone, night | `mixed-8` | 0 of 10, 25.8, 1 | 0 of 10, 25.5, 1 |
| stone, night | `skeleton-4` | 0 of 10, 14.9, 7 | 0 of 10, 8.8, 12 |
| iron, night | `seal-5` | 0 of 10, 23.7, 1.8 | 0 of 10, 20.1, 1.8 |
| live, night | `mixed-8` | 0 of 15, 18.6, 1.8 | 0 of 15, 24.0, 1.1 |

The rows marked (M10) were measured again by Track M10 on the gauntlet as Track M8 left it (every run from rest), 10 a
side, 5 a side a chunk (`pillager-1` one chunk on each server, `skeleton-4` both on bds-gaunt), the rules that came after
this track off on both sides (`MOBS_RULES=witchRush=false,milkCure=false,followRun=false`), 0 harness reruns. First
measured: `pillager-1` **8** of 10, 23.9, 0 against 0 of 10, 2.9, 20 (and Track M8's `on` side 0 of 10, 14.3, 11);
`skeleton-4` **1** of 10, 19.6, 4.5 against 0 of 10, 2.7, 16.5.

Every run of this table: 0 harness reruns. The no-kit rows, stone `seal-5` and half of stone `mixed-8` ran before two
later details of `volley` (the armour term, which is 0 with no armour, and the cap of 6 on a blamed hit); the other rows
ran on the final code. The `pillager-1` row's `on` side is Track M8's measurement on the gauntlet as it is now (every run
started at rest on its spot); this table first gave 2.9 and 20 there, measured while a run that came after an `off`
run's death started with the bot walking off its spot, out of the pillager's reach (8 of those 10 runs; Track M8). The
same applies to one `on` run of no-kit `skeleton-4` (0 damage after the one death off; the other 9 took 3.0 a run).

- **No kit.** With `bareArcher` the bot runs from the first archer in sight at full health and the pillager follows it
  the whole minute, a bolt from 8 to 9.9 blocks about every 18 s: `pillager-1` 4 deaths in 10 to none, damage 25.7 to
  12.7 a run (M10; first measured 8 to 0, 23.9 to 14.3 with Track M8's `on` side). The other mobs of `mixed-8` do not catch a bot that runs from 20 health. One more
  `pillager-1` chunk on the final code (both rules): 4 deaths in 5 off, 0 in 4 on (its `on` damage, 2.8 a run, has the
  same fault: 3 of the 4 came after a death; the last run stopped on a truth-pack timeout, a harness error).
- **The Realm's kit with the blades stowed** (`pve-testmobs`, the `bare` cases: a netherite sword moved out of the
  hotbar, the elytra, rockets, `fleeFly` on; `!test mobs skeleton4 1 bare 40s`): with `bareArcher` the bot ran on foot
  from the start, damage 0, lowest health 20, in both cases, and the elytra flee was not asked (it is below 14). Those
  cases now turn the rule off, since they test the stow, the restore and the elytra flee's ask.
- **On the Realm, the blades stowed** (2026-11-17, `!test mobs skeleton 5 bare` and `pillager 5 bare`, netherite worn):
  with the rule as first merged (a blade in the hotbar only) the bot ran from one archer at 20 health, every run alive
  (damage 0.3 and 0.5 a run) but cleared 0 of 5 each, where `skeleton4 5 bare` had cleared 5 of 5 before. A stowed
  sword is fetched by the fight, so the rule now asks for no blade anywhere in the inventory (`carriesBlade`); `bare`
  no longer shows it, and on the Realm it acts only for a bot that carries no blade at all.
- **Stone `seal-5` by night** (Track M5: 1 death in 10 either way) died in neither side of these 20 runs. With `volley`
  the flight started at a median of 9 health against 6 (on two runs at 20: four skeletons and a witch in sight before
  any hit are 22), and the damage fell 29.0 to 25.2; the lowest health stays at 1, where the witch's poison holds it.
- **Stone `skeleton-4`**: no death either side; with `volley` the damage fell 14.9 to 8.8 and the lowest health's median
  rose 7 to 12 (four skeletons in sight count 16 against no armour before they hit, so the flight can start at 16
  rather than under 8).
- **The live kit** died in none of 30. Neither rule can act for it: it has a blade, and through the netherite set one
  skeleton and a witch are under `fleeHealth` (0.8 and 6 before they hit, about 1.5 and 6 after); the bot's log of a
  third chunk (`GAUNT_VERBOSE=1`) has no line of either rule. The damage (18.6 off, 24.0 on) is where the witch's poison
  landed: 9 of 15 runs off and 13 of 15 on took more than 10 from it, the others 0.9 to 10 in all.
- **The witch and the poison on the live kit.** On the Realm after Track M5 the poison of one splash lasted longer than
  before (4 of 5 runs), so the witch's distance was read from whole-run traces of the live kit's `mixed-8` with Track M5's
  three rules off and on (5 runs a side): poisoned in 3 of 5 runs either way; 6, 27 and 28 poison hits off, 14, 28 and
  28 on; the witch at 1.8 to 6.8 blocks in the 30 ticks before the poison started off, 2.7 to 4.3 on; the median
  distance to her while the fight had her as its target 7.8 off, 7.3 on. No sign that the bot fights her from closer
  with those rules on; how long one splash poisons depends on how near it lands, in both sides.

### The flank flake (`pve-combat`)

"Two zombies 2 blocks apart, the bot between them" failed about once in 6 file runs with one zombie left after 3 fights
and 40 s, and about 15 damage taken. The cause is the bot's own flight on foot: the two zombies hit 3 at a time, and
after 5 hits the health is 5, under `fleeHealth` 8. The controller's flight then takes the body away while the fight
the case started keeps going to its 600-tick timeout; three fights pass the case's 40 s. A zombie in armour makes it
likely: summoned as the server gears them, one of 60 zombies took 8 hits at 2.8 where the rest took 4 or 5 at 4.1 to 4.6
(`PVE_FLANK_GEAR=keep`, 15 runs a side, no failure). With the first zombie in diamond armour (`PVE_FLANK_GEAR=diamond`,
1.1 to 1.3 a hit) the failure came every time: 0 and 1 of 2 zombies dead after 1 202 ticks in 2 of 2 runs, and the log
shows the flight starting at 6 health in the middle of the pair.

The case measures the choice of target, not the flight, so it now keeps the bot's health at 12 or over while a pair
runs (the hits are still counted from the server's hurt log), takes the zombies' own gear off (`strip`, the default),
and writes the bot's hits on each zombie and whether a flight started into its line. With the diamond zombie: 8 of 8
runs both dead (194 to 307 ticks), no flight.

### Tried and not taken

- **Cover, a pillar, the seal-in for the pillager.** Not built: `bareArcher` alone took the cell to 0 deaths in 10,
  and anything that places or digs blocks would ship off with its own measured case (`sealIn` stays off: ADR 0079
  decision 27, a shell on ground it was not tried on can strand the bot).
- **Closing in between bolts with a blade.** Not needed: the stone and iron kits' `pillager-1` did not die in Track M4's
  screen or its A/B series; the rule is for no blade only.

### Not met

- **Ground other than flat grass.** The pillager's rows ran on the gauntlet's flat cells; the flight on foot kept the
  pillager at the edge of its reach there. On a hillside, in a ravine or in a forest the run may be slower or the line
  may break sooner; not measured.
- **Activities with no blade.** `bareArcher` starts the flight from full health whatever the bot is doing, so a job done
  with no blade in the hotbar stops while an archer is in sight within 16. The stone kit's activity rows have a blade
  and were not run again; no activity was run with the `none` kit.
- **`volley` against deaths.** Track M5's one stone `seal-5` death by night did not come back on either side (0 of 20),
  so what `volley` is shown to do is start the flight earlier (median 9 against 6) and lower the damage (29.0 to 25.2,
  iron `seal-5` 23.7 to 20.1), not save a run that died.
- **The lowest health stays at 1** with the witch's poison, on both sides, for the stone and iron kits.
- **The flight during a fight called directly.** In the flank case the fight went on to its timeout while the flight
  had the body; the case now keeps the bot out of the flight, and how a fight started by a skill (not by guard) ends
  when the flight starts was not changed.
- **The Realm.** No early kit can be given there; the rules' effect on deaths is measured on the test servers only.

### On the Realm

The rules are on with the update; no setting changes. The Realm has no cheats, so no early kit can be given, and `bare`
(the blades stowed in main slots) does not show `bareArcher` since the rule counts a stowed blade as carried. By night, near home, `fleeHealth` as it is:

- `!test mobs skeleton 5 bare`: no `flee: no blade with an archer in sight` line (the stowed sword counts); as first
  merged the line came at the start of each run, the run alive, the damage a run a few points at most (the test servers: no kit `skeleton-4` 2.7 a
  run, the stowed Realm kit 0). With `fleeFly` on the flight stays on foot while the health is 14 or over; under 14 the
  elytra flee may take it, as before.
- `!test mobs pillager 5 bare`: the same line; every run alive.
- `!test mobs skeleton4 5`: the netherite set; no `at most one round` line is expected (four skeletons through it are
  3.2 before they hit and about 6 after, under `fleeHealth`); every run alive. A line there means a drop was blamed on
  a skeleton that was not its arrow.
- `!test mobs mixed8 5`: the live kit; every run alive.

## Track M7: the live kit's margin

Decision record: [decisions/0079-never-die-to-mobs.md](decisions/0079-never-die-to-mobs.md) "Addendum: Track M7"
(decisions 51 to 57). Everything here ran on bds-pve and bds-gaunt (BDS 1.26.60, normal difficulty) on 2026-11-16 with
the gauntlet (`test/e2e/gaunt-mobs.test.ts`) by night unless it says otherwise.

The live kit (the netherite set, a netherite sword, a shield, cooked beef) had not died in the gauntlet since Track M1,
but its lowest health was 1 to 2 in most `mixed-8` runs. This track measures where that health goes and raises it.

### Measuring the lowest health

A gauntlet run used to end once its mobs were dead. The witch's poison often still had 20 to 40 s to run then, so the
lowest health was read before the poison was done (one `seal-5` series read a median of 12 with the poison still on).
`MOBS_POISON_WAIT=1` keeps a cleared run going while the bot is poisoned, up to `MOBS_SECONDS` (60) from the start, and
the row gives the seconds of poison left at the end. Every row in this section ran with it and with whole-run traces
(`MOBS_TRACE_ALL=1`), so each hit on the bot has its cause from the server's hurt log: poison (magic with no damager),
harming (the witch's potion), arrow, melee, explosion.

### Where the health goes (the code of Track M6, 15 runs a cell)

| cell | deaths | damage a run | poison | harming | arrow | melee | lowest median (p10) | poisoned |
|---|---|---|---|---|---|---|---|---|
| `mixed-8` | 0 | 21.0 | 16.7 | 2.7 | 1.3 | 0.2 | 1.7 (1.1) | 13 of 15 |
| `witch-1` | 0 | 0 | 0 | 0 | 0 | 0 | 20 (20) | 0 of 15 |
| `witch-2` (13 runs) | 0 | 24.5 | 24.5 | 0 | 0 | 0 | 1 (1) | 11 of 13 |
| `seal-5` | 0 | 28.7 | 26.5 | 0.3 | 1.8 | 0 | 1.2 (1) | 15 of 15 |

- **The poison is the margin.** It is 80 to 100 % of the damage in every cell with a witch. It takes 1 health every 25
  ticks for up to 45 s through any armour and stops at 1, so one splash that lands close takes a bot at 20 to 1 or 2.
  Natural regeneration at food 20 gave about 1 health every 80 ticks in the traces: it does not keep up.
- **The health goes under 6 after the fight, not in it.** `mixed-8`: in 10 of 15 runs the health went under 6; 6 of them
  stood at home with nothing running, 2 were walking home, 1 was in the flight's `far` leg, 1 was in guard's fight with
  the witch. `witch-2`: all 11 runs under 6 stood at home; `seal-5`: 13 of 15 (1 in the `far` leg, 1 in guard). The
  mobs were dead; the poison was not.
- **She throws before guard reaches her.** Guard took the witch as its first target at tick 0 to 15 of `mixed-8`, her
  first potion came at tick 62 to 92 (142 once), and she died at a median tick 225 (126 to 323). In between the fight
  on her was held up three ways: the creeper interlude (`creeper within 6: fighting it first`, 60 to 135 ticks of hit
  and run), re-picks to a mob in reach (a spider, a zombie), and the shield raised for the skeleton's shot (a sneak: the
  body crept at 4 to 5 blocks from her). Only 2 of 15 runs saw no potion before she died.
- **One witch alone is no danger** to this kit (`witch-1`: killed in 2 to 3 s, no hit); two are, since the second throws
  while the first is fought.

### The rules (`PveController.rules`, on by default)

| rule | what it does | why |
|---|---|---|
| `witchRush` | When guard takes a witch as its first target (`firstTarget`) with a diamond or netherite sword in the hotbar (`WITCH_CROWD_BLADE`) and the reflex on, the fight is a rush (`FightOptions.rush`): no creeper interlude unless the creeper is lit or within 3.5 (`RUSH_CREEPER_NEAR`; below `lowHealth` the creeper is run from as before), no re-pick to a mob in reach (the reflex strikes those), the shield stays down, the approach sprints from any distance, and within 8 (`RUSH_STEER`) the fight steers straight at her when the line is known safe ground cell by cell (`safeCell`: a floor, room for the body, no liquid, nothing that hurts). While her path probe runs guard starts no fight on a mob in reach (`firstWaits`). Log: `guard: witch #N within 16 blocks, fighting (a rush: before her next throw)` and `combat: witch killed after N ticks, ..., rushed N ticks` | each of the three hold-ups above put her next throw before her death. The navigator sprints only with more than 8 blocks of straight path left, so the approach from 7 walked |
| `milkCure` | With a milk bucket in the inventory (slots 0 to 35): drink it once the poison would still take more than 3 (`CURE_MIN_LOSS`), with no live witch within 16 (`CURE_WITCH_CLEAR`), no mob within 8 (`FLEE_EAT_CLEAR`), no fight running and no elytra flight. Milk clears every effect in one drink (32 ticks; an empty bucket is left). Log: `pve: drinking milk against the poison (S s left, health H, A once it ends)` then `pve: milk drunk: the poison is gone` | the poison is the margin and it acts after the fight; a witch is taken to throw poison at a target that is not poisoned (the game's rule as known, not measured here), so the drink waits for her. Without milk the rule does nothing |

The rush uses moves the fight already makes (the approach's sprint against an archer, the close steering it has
within 3.5); what is new is when they are chosen, and the straight steer from 8 runs only over ground the planner's
grid knows to be safe; farther, or over unknown ground, the navigator approaches as before. The milk is drunk by the
eater (`EatController.drink`, the same use-item click as food, at any hunger).

Both are switches of `PveController.rules` like Track M4's (`PVE_RULES_DEFAULT`; the gauntlet's `MOBS_RULES=witchRush=false`
and `MOBS_AB_RULE` measure them). The gauntlet gained `MOBS_POISON_WAIT=1` (above) and `MOBS_MILK=<n>` (that many milk
buckets on top of any kit); a run's line counts its rushes and drinks (`rushes N`, `milk N`). `test/e2e/pve-m7.test.ts`
checks what each rule stands on, one run a side: the live kit against a witch 7 off with a zombie 2 off and a skeleton
10 off (on: rushed, she dies; off: no rush), and the bot poisoned for 30 s by the server with a milk bucket and no mob
near (on: the poison is gone within 6 s and the bucket is empty; off: still poisoned).

### Before and after (15 runs a side)

Deaths, mean damage a run, the median of each run's lowest health and its 10th percentile (the run's lowest as the
harness read it, poison included). `witchRush`: `MOBS_AB_RULE=witchRush`, off (the code of Track M6) then on,
alternating, 5 a side a chunk over both servers (`witch-1` and `witch-2` in larger chunks; `witch-2` has 16 off).
`milkCure`: `MOBS_MILK=2` (two milk buckets on top of the kit) and `MOBS_AB_RULE=milkCure`, with `witchRush` on both
sides.

| cell | before (Track M6) | `witchRush` | `witchRush`, 2 buckets, `milkCure` off | `witchRush` and `milkCure` |
|---|---|---|---|---|
| `mixed-8` | 0 of 15, 21.0, 1.7 (1.1) | 0 of 15, 7.1, 18.8 (1.1) | 0 of 15, 15.1, 6.5 (1) | 0 of 15, 4.1, 18.4 (11) |
| `witch-1` | 0 of 15, 0, 20 (20) | 0 of 15, 0, 20 (20) | - | - |
| `witch-2` | 0 of 16, 22.0, 1 (1) | 0 of 15, 29.0, 1 (1) | 0 of 15, 23.2, 1 (1) | 0 of 15, 3.0, 17 (17) |
| `seal-5` | 0 of 15, 28.7, 1.2 (1) | 0 of 15, 17.9, 1.3 (1) | 0 of 15, 16.2, 1.2 (1) | 0 of 15, 4.5, 17.9 (11.9) |

No run of these 211 died; no harness rerun. After the move to minecraft-data 3.119.0 (Track U2), one more `mixed-8`
chunk with both rules as one A/B (`MOBS_AB_RULE=witchRush,milkCure`, 2 buckets, 5 a side): off 0 of 5, 24.1, 1.9
(1.2); on 0 of 5, 4.5, 19.1 (11.1).

- **`mixed-8` with the rush.** She died at a median tick 86 (63 to 289) against 225, before her first potion in 9 of
  15 runs against 2; poisoned runs 13 to 4 of 15. The third column is the same code again (its milk is not drunk):
  poisoned 8 of 15, lowest median 6.5. Over the 30 rush runs, 12 were poisoned against 13 of 15 before; where a potion
  lands it still takes the bot to 1 or 2, so the 10th percentile does not move without milk.
- **`seal-5`.** The skeletons are summoned before the witch, so guard is already in a fight with one when she appears
  (see "Tried and not taken"); the rush cut the poisoned runs 15 to 9 of 15 and the damage 28.7 to 17.9, but more than
  half the runs are still poisoned, so the median of the lowest health stays about 1.
- **`witch-2`.** The rush kills the first witch in time and the second throws meanwhile: every run was poisoned (13 of
  16 before) and the damage rose 22.0 to 29.0 (a splash that lands nearer poisons longer); the lowest health was 1 on
  both sides and no run died. This is the row where the rush costs damage; milk takes it to 3.0.
- **Milk.** Drunk in 6 of 15 `mixed-8` runs, 5 of 15 `seal-5` runs and 15 of 15 `witch-2` runs, one bucket a run
  every time (in `witch-2` both witches are dead before the drink, so one bucket covers both poisonings). With it no
  run went under 6 in any cell; the 10th percentile of the lowest health rose from 1 to 11 or more.
- **The early kits.** Neither rule can act for them (the rush needs a diamond or netherite sword, the cure needs milk),
  and Track M6's rows were run again on the final code, `MOBS_AB_RULE=witchRush,milkCure`, 10 runs a side by night
  (2026-11-17): 0 deaths in all 140. Off and on, damage and lowest median: no kit `pillager-1` 13.0, 11 and 14.0, 12;
  `skeleton-4` 4.3, 16 and 4.8, 16; `mixed-8` 0 and 0; stone `seal-5` 17.3, 1 and 21.5, 1; `mixed-8` 27.8, 1 and 26.2,
  1; `skeleton-4` 8.5, 12 and 5.7, 12; iron `seal-5` 18.1, 8.6 and 19.7, 1.5. The two sides run the same code for these
  kits, so their differences are the spread of 10 runs. The no-kit `pillager-1` damage is higher than Track M6's table
  first gave (2.9 a run) on both sides, and also with the code before this track (8 runs: 14.1 a run, no death): the
  2.9 was the harness's (Track M8), and 13 to 14 is what the bot takes.

### What the bot should carry

The rush works with what the live kit has. The cure needs milk; since Track K1 the bot keeps `milkKeep` (2) milk buckets
on hand by itself (below, "Milk on hand"). With `milkCure` on, the milk it carries is used; one bucket clears one poisoning and leaves an empty bucket, which a cow fills again. Two buckets in the main
inventory cover two poisonings that come apart (in `witch-2` both witches were dead before the drink and one bucket did
for both). A milk bucket does not stack, so each takes a slot. The owner decides; the gauntlet's milk rows gave the kit
two (`MOBS_MILK=2`) and never used more than one a run.

A golden apple was not tried: the eater keeps it for under 6 health (`precious`), and its regeneration II for 5 s
(believed, not measured on Bedrock here) gives back about 4 against the poison's 18.

### Milk on hand (Track K1)

Decision record: [decisions/0096-milk-on-hand.md](decisions/0096-milk-on-hand.md). Code: `skills/food/milk.ts` (the
rules and the `Milker`), `tasks/process/milk.ts` (the job, `!milk`, the chore, the controller), `chat/commands-milk.ts`.

**The stock.** `milkKeep` (default 2, 0 to 9; 0 turns it all off) is the number of milk buckets the bot keeps. The
missing ones come from the cheapest source first:

1. milk out of the carried shulker boxes;
2. milk out of the home chests, only while they are in reach (below; the withdrawal of `!bring`, which walks to them);
3. empty buckets (loose, then out of the boxes, then out of the home chests in reach) filled at an adult cow, mooshroom
   or goat;
4. with no bucket anywhere (carried, boxed, in the home chests) and `milkCraft` on (the default): one bucket crafted
   from 3 iron ingots at a crafting table that is carried or near, then filled. One at most, while the bot has no
   bucket at all: the ingots have other uses. With no iron nothing is done, and the status says so.

**The home chests in reach** (Track K2, `homeChestReach`): within `homeChestRadius` + 8 blocks of the home point across
(the containers are found within `homeChestRadius` of it) and 16 up or down, or within the home logistics' own "at
home" (8 across, 4 up or down). A bot idle in a shelter, another room or another floor of the base counts; one out on a
trip does not, and the reason says how far it is and the limit: `2 more: 213 buckets in the chests at home, out of
reach: I am 40 blocks from home (they count within 24)`.

Who uses which source:

| who | sources | when |
|---|---|---|
| the readiness of a long trip (over 16 blocks: `!goto`, `!come`, `!follow`, `!kill`, `!explore`, `!bring`) | 1 and 2 only: no walk to a cow and no craft before a trip | the `milk` phase after the armour and the eating (`preparing: milk`); log `trip: milk: ...` |
| `!milk [n]` (a user process, priority 40) | all four, to `n` (default the larger of `milkKeep` and the buckets carried) | at any time; the reply says what it got and what was short |
| the milk chore (`autoMilk`, **off** by default; chore priority 30) | all four | by day, idle, within 16 blocks of home, no hostile within 16, under `milkKeep` and a step to take; again 30 s after a job that gained milk, 10 min after one that did not or when no mob is near home; walks home after |

**Milking.** Only adult mobs within 24 blocks (`MILK_RADIUS`) of the centre (home for the chore, the bot for `!milk`),
4 up or down, on dry ground (no water or lava at or under their feet), nearest first. The walk is the usual navigation
with its safety rules (doors and gates closed behind). Inside a pen the gates are closed behind the bot and it leaves
the pen at the end, also when it milked from the open gateway (Track K2: the pens of the mobs it went to are kept, so
the fence line counts; outside them their open gates within 4.5 blocks are closed). A hostile within 16 ends the job at once (`milk: ... (a zombie 7 blocks away)`); guard and flee
pre-empt it like any process. A mob that does not fill the bucket in 3 clicks is left alone for 30 s.

**The click** (BDS 1.26.60, verified by truth on bds-home): `interact` `{ action_id: 'mouse_over_entity',
target_entity_id }`, then `inventory_transaction` `item_use_on_entity` with `action_type: 'interact'`, the hotbar slot
of the empty bucket and the bucket as `held_item`: the breeder's `feedTransaction` with a bucket. The server turns a
single bucket into a milk bucket in that slot; from a stack, one bucket goes and the milk bucket lands in a free slot.
The milk was in the model 2 to 3 ticks after the click (12 clicks); one cow filled three buckets in a row.

**The unload.** `!unload` and the room chore keep `milkKeep` milk buckets and, with fewer carried, the empty buckets
that would refill the rest (keep reason `milk_reserve`). Further milk and empty buckets are stored like loot, so the
empty buckets the drinks leave do not pile up and the unload never undoes the stock.

**Shown** while milk buckets are carried or `autoMilk` is on (Track REL2; ADR 0096 decision 14). `!status` has `milk N/K (...)` (the empty buckets carried and, when nothing can be done, why: `milk 0/2 (no
bucket and no iron (3 iron ingots make one))`, `milk 1/2 (1 more need a bucket)`); `!milk status` gives the same with
the chore's state and the next pass (`next: 2 bucket from home, 2 at the cows`); the web panel's vitals have a `milk`
row (`1 of 2 milk buckets, 1 empty (refilling)`).

**What failed** (Track K2). A step that got less than it wanted is the reason the reply gives, before what the plan
expected: `milk: 0 milk buckets carried (nothing new); 2 short of 2: buckets out of the chests at home: the chests at
home gave none (fewer there than remembered)`. The log has the plan at the start of each pass (`milk: plan for 2: 2
bucket from the chests at home, 2 at the cows`, or `milk: plan for 2: nothing to do (...)` with the reason) and one line
per short step (`milk: buckets out of the chests at home: got 0 of 2 (...)`); a take from home also logs the
withdrawal's `bring: withdraw ...` line.

**Measured** (e2e `home-milk` on bds-home, BDS 1.26.60, flat, peaceful, 2026-11-17, 3 of 3 runs, 4 of 4 cases each;
a 7 x 7 pen 6 blocks from home with two adult cows, a chest 3 blocks from home):

| case | what | result (3 runs) |
|---|---|---|
| `!milk`, 3 empty buckets | the bot walks into the pen, fills all three, closes the gate behind it | 3 milk buckets and 0 empty (truth) in 7.6 to 10.0 s; the gate closed; both cows alive |
| the trip readiness | 2 milk buckets in the home chest, nothing carried, a 20-block `!goto` | `trip: milk: 2 milk buckets carried (2 from the chests at home)`, then the walk; at the goal 5.4 s after the command; the chest empty |
| the refill | 2 milk buckets carried, `autoMilk` on, the server poisons the bot for 30 s | `milkCure` drank 2.2 to 2.6 s after the poison; the chore filled the empty bucket at the cows: 2 milk buckets again 7.6 to 8.5 s after the poison |
| the early game | nothing carried | `!status` `milk 0/2 (no bucket and no iron (3 iron ingots make one))`; `!milk` did nothing and said so |
| | then 3 iron ingots, a crafting table next to home | `milk: 1 milk bucket carried (a bucket crafted from 3 iron ingots, 1 from a cow); 1 short of 2: 1 more need a bucket`; the iron gone; `!status` `milk 1/2 (1 more need a bucket)` |

Track K2 added three cases (bds-farm, the same setup, 2026-11-17, 3 of 3 runs, 7 of 7 cases each): 16 empty buckets in
the home chest, nothing carried, the bot by the pen 11.7 blocks from the home point (outside the home logistics' 8).

| case | what | result (3 runs) |
|---|---|---|
| `!bring bucket 2 home` | the withdrawal itself | `bring: withdraw done: took 2 bucket ...`; 2 buckets carried, 14 left in the chest |
| `!milk` | before Track K2 the plan had no step (`2 more: 16 buckets in the chests at home, taken there`, the bot did not move: the Realm's reply) | 2 buckets out of the chest, both filled: `milk: 2 milk buckets carried (2 from a cow)` 6.5 to 13.0 s after the command; 14 buckets left; the gate closed |
| the take fails | the chest emptied behind the memory | `... 2 short of 2: buckets out of the chests at home: the chests at home gave none (fewer there than remembered)` |
| out of reach | the same chest, the bot 40 blocks from home | `... out of reach: I am 40 blocks from home (they count within 24)`; the bot did not move |

**A full inventory** (Track K3, decision 12; docs/home.md "Room for a take"). A take from the home chests with no
free slot for it unloads the stacks it needs first, by the unloader's rules (loot only: the kit, the reserves,
`milk_reserve` and the carried boxes stay), then takes; for empty buckets it leaves room for the milk buckets they turn
into. The reply ends `made room: unloaded 2 stacks (64 andesite, 64 granite)`; out of reach of home nothing is unloaded
and the reason says so.

**Cows farther out** (Track K3, decision 13). `!milk far [n]` looks for an adult cow, mooshroom or goat within
`milkRange` (default 24, up to 96) of the bot, in view or seen in the last 30 minutes (the bot remembers where the
milkable adults were when they went out of view), walks there by the normal walk, milks and walks home. By day only:
at night it refuses, and night falling or a hostile within 16 stops the walk. The start reply names the target (`the
nearest within 64: a cow 50 blocks away`); with none known it names the nearest one it knows (`2 short of 2: no cow,
mooshroom or goat known within 30 blocks (the nearest I know: a cow 49 blocks away)`). The end reply says where it
went (`milk: 2 milk buckets carried (2 from a cow); went to a cow 50 blocks away; walked home`). Plain `!milk` keeps 24;
the chore looks within `milkRange` of home, so the default changes nothing.

Measured (e2e `home-milk` and `home-rockets`, bds-farm and bds-cache, the same setup, 2026-11-17, 3 of 3 runs each; the
full inventory is 36 stacks of six stone kinds):

| case | what | result (3 runs) |
|---|---|---|
| `!bring bucket 2 home`, full | 16 buckets in the home chest | `withdraw: no room for 1 stack: unloading 1 first`, 1 stack unloaded in 1.1 to 1.2 s, 2 buckets taken; `brought 2 buckets home (from 1 chest; made room: unloaded 1 stack (64 granite))` 2.0 to 2.2 s after the command |
| `!milk`, full | the same chest, cows in the pen | 2 stacks unloaded (one for the buckets, one for the milk), 2 buckets taken and filled: `milk: 2 milk buckets carried (2 from a cow); made room: unloaded 2 stacks (...)` in 10.7 to 11.5 s; the gate closed |
| `!rockets 6`, full | 2 paper and 2 gunpowder in the home chest | 2 stacks unloaded before the gunpowder, 1 before the paper, 6 crafted: `rockets: 6 carried (6 crafted, 2 gunpowder, 2 paper fetched); made room: ...` in 3.6 to 3.7 s |
| `!milk far`, `milkRange 64` | 2 empty buckets, a cow 50 blocks from home, the bot on the home point | the walk ended 2.8 to 2.9 blocks from the cow; both filled; on the home point again 19.6 to 20.4 s after the command |
| `!milk far`, `milkRange 30` | the same cow 49 blocks away | the reply names it as the nearest known; the bot did not move |

**Not proven.** Mooshrooms and goats (the same click; only cows ran); milking on broken ground, near water, or with a
hostile near (bds-home is peaceful: the hostile stop is covered by unit tests only); the chore on the Realm; a
crafting table placed from the inventory for the craft (one stood next to home); the home chests' reach on a base with
floors (the 16 up or down was not run: the e2e world is flat) or from a shelter. Track K3: a walk to a cow seen out of
view (the e2e cow 50 blocks out stayed in view); the far walk on broken ground, near water or with a hostile (the
hostile and night stops by unit tests only); the chore with `milkRange` raised.

### Tried and not taken

- **Eating to keep the regeneration.** At food 20 the traces show about 1 health every 80 ticks, the poison 1 every 25:
  eating does not hold the health up against it, and the bot already eats at once after a fight (`eat: cooked_beef ...
  food 17 -> 20` within seconds of the last kill).
- **Backing off from her throw.** The potion side step stays off while guard fights her (Track M2: it took the keys
  from the approach and she lived longer). With the rush she is dead before her first throw in most `mixed-8` runs; a
  throw that is still coming is cheaper to cure than to dodge.
- **A switch to the witch in the middle of another fight.** In `seal-5` the harness summons the four skeletons first,
  so guard is already on one when the witch appears, and her fight starts at a median tick 33 (20 to 36) against 6 to
  11 in `mixed-8`; with the rush she died at a median tick 91 against 125, and before her first potion in 5 of 15 runs
  against 0. A guard that breaks off a fight for her was not built; in a world the mobs do not come in the harness's
  order.

### Not met

- **`witch-2` with the rush alone.** Two witches throw at once; the rush kills the first in time and the second's
  poison lands. The lowest health stays at 1 there without milk (on and off).
- **The `seal-5` lowest health without milk.** The rush cut the poisoned runs 15 to 9 of 15, but the median of the
  lowest health is still about 1.
- **Holding the ground at 1 to 4 health.** With the reflex on, `holdGround` (decision 23) keeps the bot fighting 1 to 3
  melee mobs instead of the flight at low health. In this track's 229 whole-run traces of the live kit, 98 runs went to
  4 or under and none had a melee mob within 8 at any of those ticks: the low health came from the poison after the
  fights. Whether the hold should yield under some health is therefore not measured here.
- **The Realm.** None of the rows ran there; the recipe below says what to look for.
- **Ground.** All rows ran on the gauntlet's flat cells. The straight steer from 8 runs only over cells the grid knows
  are safe; on broken ground the navigator approaches as before, so the rush there is no faster than the code before.

### On the Realm

Both rules are on with the update; no setting changes. By night, near home, the live kit (sword in the hotbar):

- `!test mobs witch 5`: look for `guard: witch #N within 16 blocks, fighting (a rush: before her next throw)` and
  `combat: witch killed after N ticks, ..., rushed N ticks` (the test servers: 35 to 140 ticks); every run alive.
- `!test mobs mixed8 5 force`: the same two lines in most runs; `combat: creeper ... fighting it first` should not come
  while the witch's fight runs unless the creeper is lit or within 3.5. Every run alive. A run line's lowest health is
  read until its mobs are dead, so a poison still running after that is not in it: the `pve: took 1.0 damage (poison,
  S s left) ...` lines are the count of what one splash did (the test servers, whole runs: lowest median 18.8 with the
  rush against 1.7 before).
- With a milk bucket given by the owner (`milkCure`): after a poisoning, `pve: drinking milk against the poison (...)`
  then `pve: milk drunk: the poison is gone`, once the witch is dead and no mob is within 8. Without milk no such line.
- Milk on hand (Track K1): with empty buckets and a cow, mooshroom or goat within 24 blocks, `!milk` answers `milk: 0
  of 2 carried, 2 empty buckets; getting 2`, then `milk: 2 milk buckets carried (2 from a cow)`; the log has `milk: cow
  #N milked (T ticks)` per bucket. `!status` and `!milk status` show `milk N/2 (...)`. With milk in a carried box or a
  home chest, a `!goto` of more than 16 blocks logs `trip: milk: 2 milk buckets carried (...)` before the walk. With
  `!set autoMilk on`, after a drink by day near home: `milk chore: 1 of 2 milk buckets carried: 1 at the cows`, then
  `milk chore: done, milk: 2 milk buckets carried (1 from a cow)`.
- Empty buckets only in the home chests (Track K2): by day, nothing carried, the bot anywhere within `homeChestRadius` + 8
  of home. `!milk status` ends `next: 2 bucket from home, 2 at the cows`; `!milk` logs `milk: plan for 2: 2 bucket from
  the chests at home, 2 at the cows`, then `bring: withdraw done: took 2 bucket ...`, `milk: cow #N milked (T ticks)`
  twice, and answers `milk: 2 milk buckets carried (2 from a cow)`. A take that gets less answers `... short of 2:
  buckets out of the chests at home: <why>` and logs `milk: buckets out of the chests at home: got N of 2 (<why>)`;
  further from home the reply ends `out of reach: I am N blocks from home (they count within M)`.
- A full inventory at home (Track K3): with every slot full and buckets in a home chest, `!milk` (no `!unload` first)
  logs `withdraw: no room for 2 stacks: unloading 2 first`, `withdraw: made room: unloaded 2 stacks (...) into 1
  container in T s; 2 free`, then the take and the milking; the reply ends `made room: unloaded 2 stacks (...)`. The same
  for `!bring bucket 2 home` (1 stack) and `!rockets` with paper and gunpowder at home. The stacks unloaded are loot only:
  no sword, armour, food, rockets or shulker box leaves.
- Cows farther out (Track K3): by day, `!set milkRange 64`, then `!milk far` near home: the start reply names `the
  nearest within 64: a cow N blocks away` (or `none known within 64 (the nearest I know: ...)`), the log `milk: walking
  to a cow N blocks away (T ticks at most)`, `milk: the walk to the cow ended there, D blocks from it`, the milking, `milk:
  walked home`; the reply ends `went to a cow N blocks away; walked home`. At night `!milk far` answers `milk: !milk far
  walks by day only (it is night)`. `!set milkRange 24` puts it back.

## Track M8: a run starts at rest

Everything here ran on bds-pve and bds-gaunt (both BDS 1.26.60.6, normal difficulty; the containers date from
2026-10-30 and were not recreated, so the compose files' 1.26.65.1 had not taken effect for Tracks M6 and M7 either)
on 2026-11-17 with the gauntlet, no kit, `pillager-1`, by night, whole-run traces (`MOBS_TRACE_ALL=1`). No change to
the bot.

### What moved the no-kit `pillager-1` number

Track M6's table gave 2.9 damage a run with `bareArcher` on; Track M7 measured 13 to 14 on the same cell, also with the
code M6 merged. Run again, with every run following a run that lived (`bareArcher` on, no A/B):

| code | runs | deaths | damage a run | lowest median |
|---|---|---|---|---|
| Track M6's change on its own base (before the stack move of Track U1) | 5 | 0 | 11.2 | 14 |
| Track M6 as merged | 10 | 0 | 11.5 | 13 |
| the code after Track K2 | 10 | 0 | 13.8 | 10 |

The bot's code and the servers gave the same number; the order of the runs did not. In an A/B series the runs of the
two sides alternate on one bot, and after a death the respawn's return home (`afterRespawn` in `tasks/registry.ts`)
walks to the home point of the run that died, the spot before, 40 blocks along the row. It starts once the chunks are in
after the respawn, while the harness sets up the next run, and the harness stopped processes only at a run's end. The
next run's mobs were summoned with the bot 8.6 to 11.4 blocks off its spot (median 9.8), still walking away under the
`home` process, and the pillager first in sight at 16 (median 15.9 against 7.0 from rest). The flight on foot then
started at the edge of the scan and the pillager did not close in.

The same A/B on the code after Track K2 with the gauntlet as it was, 10 runs a side over both servers: off 8 deaths,
25.4, 0; on 0 deaths, 3.3, 20, with 7 of 10 `on` runs taking no damage. Track M6's table gave 8 deaths, 23.9, 0 and 0
deaths, 2.9, 20. By the run before:

| `on` runs | old gauntlet: runs | bolts a run | damage a run | Track M6's rows: runs | damage a run |
|---|---|---|---|---|---|
| after an `off` run that died | 8 | 0.3 | 0.9 (7 with none) | 8 | 1.8 (6 with none) |
| after an `off` run that lived | 2 | 3.5 | 13.0 | 2 | 7.5 |

Track M7's early-kit rows ran `MOBS_AB_RULE=witchRush,milkCure`, where both sides are the same code for a bot with no
kit; its no-kit runs never died, so no run there started off its spot. In the old gauntlet's series a few other runs
also started away from rest (the run before's flight still going, once 39 blocks off); the start rule below catches
those too.

### The flight with no blade, from rest (the traces)

The 25 runs above, `bareArcher` on, each after a run that lived: the flight starts at 20 health within a tick of the
summon with the pillager at 7.0. It runs `away` for about 24 ticks (sprinting 79 % of them) and then the `far` leg for
the rest of the minute: 184 to 263 blocks, then `flee: gave up (60 s)` in every run. The pillager follows the whole way
at a median 11.5; 82 bolts landed, all on the `far` leg, all from 8.0 to 9.9 blocks, one every 358 ticks (about 18 s),
3 or 4 each: 3.3 a run, 12.4 damage, no death. The body sprints on 33 % of the `far` leg's ticks.

### The gauntlet now (`test/e2e/gaunt-mobs.test.ts`)

- After a death (in a run, or after its end while the harness cleans up) the harness waits for the respawn's return
  home and stops it; before each run's setup and after it, every process is stopped until none runs.
- Before the mobs are summoned the bot must stand within 1 of its spot with no process running; else the run is a
  harness run (`not at rest at the start (D from the spot, P running)`), run again and kept apart like a block's death.
  Before the wait for a death in the cleanup it caught one run in 21 (12.6 off its spot, after a death that came just
  past a run's 60 s); the final series had none.
- Each row names the server it ran on (`server`: the container, the BDS build its image was created with, the version
  the server advertised), and the log has `gauntlet server: <container> <build> (pong <version>), image <image>`.

### The row again (10 runs a side)

`MOBS_AB_RULE=bareArcher`, off then on, 5 a side a chunk, one chunk on each server, the gauntlet as it is now:

| kit, time | cell | off | on |
|---|---|---|---|
| none, night | `pillager-1` | **6** of 10, 27.4, 0 | 0 of 10, 14.3, 11 |

Every run started on its spot with nothing running and the pillager at 7.0. The 6 `on` runs right after a death took
14.5 a run, the 4 after a run that lived 14.0. With the first version of the start rule (no wait for a death in the
cleanup; the run it caught was run again): off 6 of 10, 27.7, 0; on 0 of 10, 11.7, 12.5.

### Not met

- **The run does not shake the pillager.** It follows for the whole 60 s and about 250 blocks and lands a bolt every
  18 s; at the end of the flight (`gave up`) guard takes it up again with a fist. A run of more than a minute is not measured,
  nor any way to break its line (ground, cover, a door).
- **Other rows of Tracks M4 to M6.** Only the runs that came right after a death were started off their spot. Of
  Track M6's table only the two rows above had such runs; the A/B rows of Tracks M4 and M5 with deaths on both sides were
  not run again, so their sides may be off by the same fault in either direction (Track M9 ran them again, below).

## Track M9: losing a following archer

Everything here ran on bds-pve and bds-gaunt (both BDS 1.26.60.6, normal difficulty, not recreated) with the gauntlet as
Track M8 left it (every run from rest), by night, whole-run traces (`MOBS_TRACE_ALL=1`). Each row now also has where the
run ended (`endFromSpot`, `maxFromSpot`), when the bot was home again (`homeS`: within 3 of its spot after having been 20
or more out), the last hit's second, a track every 5 s (the distance out, the nearest mob, the process, the health) and
the flight's, guard's and floors' lines.

### The long case (no kit, 4 minutes a run, 10 runs a cell)

`MOBS_SECONDS=240`, the code after Track M8 (`bareArcher` on). A run ends early at a death or once the server reports
every mob gone (the server stops sending them). (M10: not a despawn by night. In the behaviour pack the servers run,
the skeleton and the pillager despawn only by day in light 8 or more, after 30 s inactive and more than 54 from every
player, and never once persistent; their `nearest_attackable_target` sets `set_persistent` when it takes the bot as its
target. What makes the server report them gone was not found; first written: despawned at random 32 or more out.)

| cell | deaths | damage a run | lowest median | flights given up (60 s) | end: blocks from the spot (median, range) | home again |
|---|---|---|---|---|---|---|
| `pillager-1` | **9** of 10, at 66 to 137 s (median 101) | 29.9 | 0 | 11 | 389 (281 to 557) | 0 of 10 |
| `skeleton-4` | 0 of 10 | 7.6 | 15.5 | 14 | 59 (2 to 100) | 2 of 10 |

- **The pillager follows every flight to its end.** The flight runs about 250 blocks a minute and the pillager keeps to
  8 to 15 behind it; a bolt lands about every 15 s. At `flee: gave up (60 s)` the 2 s cooldown hands the body to guard,
  which fist-chases the pillager in 7 of 11 cases: the bot turns back into it and takes a bolt from 2 to 6 blocks (44
  damage over the 11 give-ups in the 5 s after them), then `bareArcher` starts a new flight. 9 runs died in the second
  minute on the second flight; the one that lived had the pillager walk off at the start. No run got home: `shooterHome`
  and `shooterWay` keep it out while the pillager is near the way home or home, and the pillager stays near the bot.
- **The skeletons give up.** Skeletons move at 0.25 (the pillager at 0.35, about a sprint), shoot from 15 and are
  forgotten at 16 out of sight; they stay 15 to 40 off and are gone (reported gone by the server, see above) at 121 to 215 s in 8 of 10 runs. After the first
  flight's minute the bot stands 55 to 100 out (84 s idle a run), flips between the `far` and the `home` leg (43 flips
  `home -> far` over the 10 runs) whenever a skeleton comes back within 16, and gets home in 2 of 10.

The pillager's numbers come from the vanilla behaviour pack the servers run (`entities.brarchive`):
`nearest_attackable_target` with `must_see` and `within_radius` 16, `follow_range` 64, `ranged_attack` from 8,
movement 0.35; the skeleton: `must_see`, `attack_radius` 15, movement 0.25, `avoid_sun`. Neither has `can_open_doors`.
In the traces the pillager walks at 0.265 blocks a tick while the bot sprints at 0.27 to 0.29 (sticky sprint, BDS): the
gap holds while the bot sprints and closes on the `far` leg's turns and re-plans, where it sprints on only a third of the
ticks.

### The rules (`PveController.rules`)

Each acts only for a bot with no blade carried (no sword or axe in the hotbar or the main slots), so the live kit and
every kit with a blade flee and fight as before.

| rule | default | what it does |
|---|---|---|
| `followRun` | **on** | A `far` leg with an archer within `FLEE_SCAN` + 8 (seen or not) runs `FOLLOW_RUN` (32) past it (`followRunRadius`, no `FLEE_FAR` cap); a long leg the planner cannot find falls back to `fleeRadius` for the rest of the flight. No `home` leg while such an archer is within `FLEE_SCAN` + 8 (as the `shooterHome` rule's home that is shot at: the way home turns the body back towards it). A flight that gives up (60 s) with the archer still within `FLEE_SCAN` + 8 (seen or not) ends with no cooldown, so the next flight starts as soon as it is seen again and there are no 2 s for guard to fill. Log: `flee: a long leg from pillager at D (to R from it)` and `flee: pillager following at D: not to home while it is within 24`, each once a flight |
| `sprintJump` | off | On the `far` leg from such an archer, with the food over 10 (the sprint's eat floor), the path follower jumps while it sprints on a straight level run (`sprintJumpOk` in `skills/nav/follower.ts`: the aim 4.5 or more ahead on the same level, more than 8 blocks of walk left, facing within 8 degrees, no hazard beside the way, not the last leg). A nav option (`GotoOptions.sprintJump`) |
| `craftBlade` | off | A lone archer in sight (no other hostile within 24), health 14 or over, no melee mob within 8 and the materials for a sword: the bot crafts the best it can (iron, stone, wooden) where it stands through the crafter (`tasks/process/blade.ts`, a process at 90, over guard and under the flight) and leaves the table it placed standing (the next craft near it picks it up); the flight on foot waits for it, then guard fights with the sword. Below 10 health the craft is left to the flight; a failed craft waits 30 s. Log: `blade: no blade with pillager in sight (health H): crafting a stone_sword`, `blade: crafted stone_sword after T s (...)` |

### Each rule on its rows (from rest, by night, 120 s a run)

Each rule A/B'd on its own (`MOBS_AB_RULE=<rule>`, off then on alternating, 2 or 3 a side a chunk, the chunks split over
both servers), the other rules as they are at the step. Deaths, mean damage a run, the median of each run's lowest health.

| rule (the others) | kit, cell | off | on |
|---|---|---|---|
| `followRun` (the code after Track M8) | none `pillager-1`, 10 a side | **6** of 10, 28.2, 0 | 0 of 10, 9.7, 13.5 |
| `followRun` | none `skeleton-4`, 10 a side | 0 of 10, 6.7, 16 | 0 of 10, 1.9, 20 |
| `sprintJump` (`followRun` on) | none `pillager-1`, 15 a side | 0 of 15, 13.7, 11 | 0 of 15, **2.7**, 17 |
| `sprintJump` (`followRun` on) | none `skeleton-4`, 10 a side | 0 of 10, 8.5, 16 | 0 of 10, 4.0, 16.5 |
| `craftBlade` (`followRun` on) | `mats` `pillager-1`, 15 a side | 0 of 15, 13.8, 10 | 0 of 15, **5.3**, 13 |
| `craftBlade` (`followRun` on) | `mats` `skeleton-1`, 8 a side | 0 of 8, 5.8, 20 | 0 of 8, 3.5, 16 |

`mats` is the `none` kit with 4 cobblestone, 2 sticks and 4 oak planks. One harness run (not at rest) in the first
`followRun` series was run again; none in the others. The `followRun` rows are the rule after its fix (below), 2 or 3
a side a chunk over both servers; the `sprintJump` and `craftBlade` rows ran with `followRun` as first built.

- **`followRun`.** The bolts land on the `far` leg. With the legs to `FLEE_FAR` the body sprinted on 34 % of that leg's
  ticks (0.220 blocks a tick) and 91 bolts landed in 16 runs; with the long leg 67 % (0.247) and 46 in 17. At the
  minute's end guard took the body for a fist chase after 14 of the `off` side's 16 give-ups; with the rule after 3 of
  18 (the pillager out of sight at that tick, so the cooldown held). The pillager still follows (median 11.4 either
  side) and the flight still gives up after a minute; skeletons are the same either way.
- **`followRun` as first built had two gaps**, both found in the traces after a `pve-m9` failure. The flight took a
  `home` leg with the pillager still behind it: in 14 of 17 `on` runs, 34 legs, the pillager a median 13 off (`far ->
  home (home clear), nearest threat 16.6`, then `home -> far` at 10.9 within 0.75 s). The leg rule had home clear and
  far enough the moment the pillager was 12 or more off to the side, and each such leg turned the body back for about
  15 ticks before the hold sent it out again. And the restart at the minute's end looked for the pillager in sight
  within 16, while it was often 16 to 18 behind at that tick: then the 2 s cooldown held and guard took the body. Now
  neither: no home leg while the archer is within 24, and the restart's look is the follower's (within 24, seen or not).
  The table's `followRun` rows are the rule as it is; as first built: `pillager-1` 16 a side 7 of 16, 27.7, 1 against
  0 of 16, 12.4, 11; `skeleton-4` 10 a side 0, 5.4, 16 against 0, 4.4, 16. With the fix, after the `on` side's 10
  give-ups guard started a fight within 1 s 4 times (the pillager in guard's radius before the flight sees it), with 4
  damage in the 5 s after them (`off`: 9 times, 48); home legs came only in one run, with the pillager gone from the
  bot's view. No run on either side got home within the 2 minutes (`skeleton-4`: 1 of 10 off, 0 of 10 on; the bot
  ends a median 62 out with the rule against 100): the rule keeps the bot out while an archer is within 24.
- **`sprintJump`.** On the `far` leg the body moved at 0.271 blocks a tick against 0.254, the pillager's median distance
  was 14.2 against 11.2, and 3 bolts landed on that leg in 15 runs against 47. The food at the end: a median of 13
  (lowest 13, no run ate) against 16 (every run ate).
- **`craftBlade`.** The sword was in the hotbar 1.7 to 1.9 s after the start in 15 of 15 runs (the table crafted from
  the planks, placed, used, left standing); guard killed the pillager at a median 5.4 s, one or two bolts in. A lone
  skeleton died at a median 5.7 s. As first built it also crafted with more archers near: `skeleton-4`, 6 a side, 9.7
  to 10.2 damage, the lowest median 14.5 to 12.5 (the craft under four bows, then a fight with no armour); it now
  crafts only for a lone archer (`BLADE_LONE`).

### Tried and not taken

- **Cover (`coverLeg`).** The legs from an archer went to the nearest cell within 10 that no archer had a line to.
  `MOBS_TERRAIN=walls` (cobblestone walls 3 high and 4 to 7 long, laid at random round the spot, none within 10),
  `pillager-1`, 90 s: off 0 of 3, 10.3 a run; on **4 of 4** died, at 18 to 34 s. The bot stood behind a wall 15 blocks
  out and the pillager walked round it: a target out of sight is kept for 3 s (`must_see`), and it closes 8 blocks in
  that time. Removed.
- **Gates closed behind the flight (`fleeDoors`).** `MOBS_TERRAIN=doors`: a roofless room of cobblestone 4 high, 12 from
  the spot each way, a closed fence gate in each side (neither mob opens one). With `closeDoors` asked on every leg the
  gate the bot left by was open at every 5 s sample in 4 of 4 runs, as with it off, and the pillager left the room
  behind the bot by 11 s in every run (damage 6.5 and 4.8 a run in 40 s). The walk schedules the close for the node
  after the gate, and the flight's next walk (a new leg, or the 2 s re-plan) drops it. Removed; making the close outlive
  a re-plan is a navigator change not made here.
- **The seal-in at the minute's end (`sealFollowed`).** A flight that gave up with the archer still in sight sealed in
  (`sealIn` on; with no blocks carried every one was a dig-in), `pillager-1`, 10 a side: off 0 deaths, 16.7, 9.5; on
  **4** deaths (70 to 75 s), 17.3, 5.5. The dig-in took 4 to 6 s under fire (3 to 7 health); 5 of 10 closed and took no
  hit after it, with the pillager standing over the hole; 4 were left open (knocked off the cell, or the body did not
  drop into the hole). Removed.

### Tracks M4 and M5 measured again

Every A/B row of Tracks M4 and M5 with a death on either side ran again from rest, 10 a side over both servers (5 a
side a chunk, 60 s a run, by night unless the row says day), the rules that came after each track switched off on both
sides (`MOBS_RULES`); 0 harness reruns. The corrected rows are in place in the two tables, marked (M9), with the first
numbers under them. Track M4's rules still take the deaths of its eight rows from 59 of 80 to 22 of 80 (first 63 to 18),
Track M5's three from 15 of 70 to 4 of 70 (first 20 to 11). The no-kit `pillager-1` row of Track M5, which first went 7
to 10 against the rules, goes 7 to 3; Track M4's stone `seal-5` and no-kit `witch-1` and `pillager-1` rows keep more
deaths on the `on` side (5, 5 and 9 of 10) than first measured (2, 2 and 6). The A/B rows Track M6 corrected (Track M8)
were not run again here (Track M10 ran them).

### Not met

- **Losing the pillager.** No rule shook it: with `followRun` (and `sprintJump`) it still followed each flight for the
  whole minute at a median 11 to 14 blocks, and the flight still gave up after 60 s. What the rules change is where the
  bolts land and what the body does at the minute's end, not the follow itself. Breaking its line of sight did not help
  on flat ground (cover above); a flight that ends inside a closed room needs the gate close to outlive a re-plan.
- **Ground other than flat.** Every row ran on the gauntlet's flat cells. A long leg on a hillside, in a forest or along
  a cliff has more turns, and the sprint-jump's checks (`sprintJumpOk`) were exercised on flat ground only.
- **Getting home.** The long case's bot got home in 0 of 10 runs with the pillager and 2 of 10 with skeletons, and the
  rules do not change the way home: with the pillager near the way home (`shooterWay`, `shooterHome`) the bot stays out.
  (Track M10's `backHome` walks it home once nothing is near.)
- **`craftBlade` with a table to walk to, an axe, or iron.** Every run crafted a stone sword from the inventory grid's
  table; the wooden and iron recipes, a table already standing, and the craft with a melee mob coming were tested by
  unit tests only. A table left standing on the Realm is a block left in the world.
- **The Realm.** None of the rows ran there; `followRun` acts only with no blade carried, which the live kit never is.

### On the Realm

`followRun` is on with the update; `sprintJump` and `craftBlade` are off. The live kit carries a blade, so none of the
three changes what it does: by night, near home, `!test mobs mixed8 5` and `!test mobs pillager 5` should give no `flee:
a long leg` and no `blade:` line, every run alive, as before. `bare` stows the blades in main slots and still counts as
carried, so it does not show the rules either.

To see `followRun`, the blades (swords and axes) go into a chest first, nothing else changed:

- `!test mobs pillager 3`: a flight from the pillager at full health (`flee: no blade with an archer in sight`), then
  `flee: a long leg from pillager at D (to R from it)` and `flee: pillager following at D: not to home while it is
  within 24` once a flight, and no `flee: far -> home` while the pillager is in view; at the minute's end `flee: gave
  up (60 s)` is followed by a new flight as soon as the pillager is seen again, mostly not by `guard: pillager ...
  fighting`. Every run alive (the test servers: 0 deaths in 10, 9.7 damage a run). `test/e2e/pve-m9.test.ts` checks
  the same on bds-pve (`M9_TRACE=1` prints a line a second: the leg, the process, the health, the pillager's distance
  and sight).

The other two are switches of `PveController.rules` (`PVE_RULES_DEFAULT`, no chat setting), so trying them there takes
a build with the switch on:

- `sprintJump` on: the same, the body jumping on the straight parts of the long leg; the food falls about 3 points
  faster. Watch for a jump off an edge or into a hole.
- `craftBlade` on, a few planks, sticks and cobblestone carried and one pillager or skeleton:
  `blade: no blade with pillager in sight (health 20): crafting a stone_sword`, then `blade: crafted stone_sword after
  T s` (the test servers 1.7 to 1.9 s) and a guard fight. The crafting table is left where it was placed.

## Track M10: after the flight

Everything here ran on bds-pve and bds-gaunt (both BDS 1.26.60.6, normal difficulty, not recreated) with the gauntlet as
Track M8 left it (every run from rest), by night unless a row says day, whole-run traces. New in the gauntlet: the kit
`empty` (nothing, no food), `MOBS_HOME_WAIT=1` (a run whose mobs are all gone goes on while the bot is out and not home
yet), `MOBS_START_OUT=<d>` (the run starts d blocks east of the home point), and in each 5 s track point the nearest
mob's distance from the spot and the food.

### The long case with `followRun` (no kit, 4 minutes a run, 10 runs a cell)

`MOBS_SECONDS=240`, the code after Track M9 (`followRun` on). Deaths, mean damage a run, the median of each run's lowest
health; the flights given up (60 s) and what came within 2 s of each; the end; home again (within 3 of the spot after 20
or more out).

| cell | deaths | damage a run | lowest median | given up: then a flight, guard, nothing | end: blocks from the spot (median, range) | home again |
|---|---|---|---|---|---|---|
| `pillager-1` | 0 of 10 | 21.8 | 7.5 | 28: 23, 1, 4 | 1 094 (46 to 1 159) | 0 of 10 |
| `skeleton-4` | 0 of 10 | 1.9 | 18.5 | 13: 0, 0, 13 | 22 (1 to 57) | 4 of 10 (141 to 234 s) |

Track M9's long case, before `followRun`: `pillager-1` 9 of 10 deaths, 29.9, 0, 389 out, 0 home; `skeleton-4` 0, 7.6,
15.5, 59 out, 2 home.

- **The pillager.** Each flight gives up after its minute about 290 blocks on (median 291 of 28; 46 to 301), and the
  next starts at once: the bot runs the whole four minutes, about 1 100 blocks. The pillager keeps a median 12 to 14
  behind in every minute; the bolts land through the run (10, 15, 18 and 14 in minutes one to four over the ten runs,
  5.7 a run). In the 5 s after the 28 give-ups the bot took 29 damage. The food falls to a lowest median of 12 (lowest
  9); the bot eats its bread on the long leg. In 2 of 10 runs the pillager dropped back on its own (once from 30 s, once
  from 160 s) and was reported gone 44 to 119 s later; in the other 8 it followed the whole run.
- **The skeletons.** They stay 18 to 30 from the bot and 20 to 48 from the spot. After the first flight's minute nothing
  starts another (no skeleton within 16 with a line on the bot) and nothing takes the bot home: it stands where the
  flight left it (133 s idle a run) and gets home only on a later flight's own home leg (4 of 10).

### Why the skeleton row flips between the `far` and `home` legs

Traced tick by tick over the ten `skeleton-4` runs: 120 `home -> far` flips (Track M9: 43). 117 of them came with the
nearest skeleton 22 to 24 off and none within 24 when the home leg began: `followRun` blocks the home leg while an
archer is within 24, the home leg starts the tick none is, and the way home walks back towards the skeleton that stood
between the bot and home; at 24 the leg is blocked again. The home leg lasted a median 0.5 s and came about every 3 s
(the 2 s leg hold). The other 3 flips were `shooterHome` (a skeleton within 16 of home).

### What ends the pillager's chase

The pillager in the behaviour pack the servers run: `follow_range` 64, a target taken with `must_see` and kept 3 s out
of sight, movement 0.35 (0.265 blocks a tick measured), no `avoid_sun` (it does not burn), and it is made persistent
when it takes the bot as its target (`set_persistent`): no despawn by day or by night. 240 s a run, no kit:

| case | runs | deaths | damage a run | lowest median | the pillager's distance (median by minute) | runs it dropped back |
|---|---|---|---|---|---|---|
| night, 16 bread (the long case) | 10 | 0 | 21.8 | 7.5 | 12 to 14 | 2 |
| noon, 16 bread (`MOBS_TIME=day`) | 3 | 1 (170 s) | 25.7 | 1 | 9 to 13 | 0 |
| night, no food (kit `empty`) | 5 | **5** (167 to 224 s) | 23.4 | 0 | 12 to 13 | 0 |

- **Daylight does not end it.** At noon the pillager followed every run at 9 to 13; one run died at 170 s on its eighth
  bolt (`shooterWay` kept it out at 4 health).
- **Hunger makes it worse.** With no food the food fell to 6 at 156 to 201 s; from there the bot cannot sprint and its
  flight ticks moved 0.212 to 0.218 blocks a tick against 0.250 before. The bolts came closer together (8 to 30 s apart
  against about 30 before) and every run died 11 to 57 s later.
- **Distance does not end it.** No run lost the pillager by running: the flight averages 0.24 blocks a tick over its
  minute (290 blocks) and the pillager walks at 0.265 when it walks; it keeps 12 behind because it stops to shoot.

So nothing in the world ends the chase: the bot needs food and a way to break it (a closed door, a blade).

### The rules (`PveController.rules`)

Both act only for a bot with no blade carried, so the live kit and every kit with a blade flee, fight and go home as
before.

| rule | default | what it does |
|---|---|---|
| `backHome` | **on** | A flight on foot that starts within `BACK_HOME_ARM` (48) of home arms the way back (a later flight farther out keeps it armed). Once no process runs, the bot walks home as the home return (`returnHome`: the normal nav, 300 s at most) when the way is clear (`backHomeBlock`): no melee mob within `FLEE_SCAN` + 8 (24) of the bot, no archer or witch within `FLEE_SCAN` (16) of it, and none within `SHOOTER_HOME` (16) of home or `SHOOTER_WAY` (16) of the way there, the ones out of view counted 60 s where they were last seen (`SHOOTER_MEMORY_MS`). Home (within `BACK_HOME_AT`, 3), a death, a command, `stop()` or 10 min after the flight (`BACK_HOME_MS`) disarm it; a new flight pre-empts the walk and arms it again. In the flight, the home leg is not taken past an archer or a witch on the way at any health (`shooterWay` alone acts at low health only). Log: `flee: not home yet: <why>` once a reason, then `flee: nothing near: returning home to x y z` |
| `followHome` | off | While an archer follows (within 24), the flight may take its home leg when home is ahead: every archer and witch known is at least `FOLLOW_HOME_LEAD` (4) farther from home than the bot and none is on the way (`homeAhead`); that leg asks the walk to close the gates and doors it opens behind it (`closeDoors`). Guard does not start a fist chase of such an archer. Log: `flee: home ahead of every archer (health H): home, closing the doors behind` |

### Each rule on its rows (from rest, by night)

`MOBS_AB_RULE=<rule>`, off then on, one a side a chunk (`backHome`) or two (`followHome`), the chunks over both servers;
the other rules as shipped. Deaths, mean damage a run, the median of each run's lowest health; home again.

| rule | kit, cell | off | on |
|---|---|---|---|
| `backHome` | none `skeleton-4`, 240 s, 10 a side | 0 of 10, 2.6, 16.5; home 1 of 10 | 0 of 10, **1.2**, 20; home **8** of 10 |
| `backHome` | none `pillager-1`, 240 s, 10 a side | 0 of 10, 22.8, 7; home 0 of 10 | 0 of 10, 23.3, 8; home 1 of 10 |
| `followHome` | none `pillager-1`, the doors room, from 24 out, 120 s, 6 a side | 0 of 6, 11.3, 11; home 0 of 6 | 0 of 6, 5.8, 18; home **6** of 6 |
| `followHome` | none `pillager-1`, flat, from 24 out, 120 s, 4 a side | 0 of 4, 3.8, 16.5; home 1 of 4 | 0 of 4, **18.8**, 8.5; home 4 of 4 |

`MOBS_HOME_WAIT=1` on the `backHome` rows; `MOBS_TERRAIN=doors` is Track M9's roofless room (cobblestone 4 high, 12 from
the spot each way, a closed fence gate in each side), the run starting 24 east of the spot, outside the east gate, with
home ahead of the bot and the pillager summoned round it. 0 harness reruns; three `backHome` chunks ended on a truth
timeout (two at once, one on each server, and one later on bds-gaunt) and were run again, the run each had written set
aside.

- **`backHome` with skeletons.** The flight runs its minute as before, now with no home leg while a skeleton stands
  within 16 of the way (`home -> far` flips 160 to 8 over the ten runs). After it, `flee: not home yet: an archer or a
  witch within 16 of the way home` (or `of home`) holds the walk while a skeleton is there, 26 such lines over the ten
  runs; once none is, the walk starts (9 walks in 8 runs, a median 10 s to the home point, no damage taken on any). Home
  in 8 of 10 at 82 to 175 s (median 125); the two that stayed out were held by a skeleton near home or the way and then
  flown from again (one still in a flight at the end). The `off` side got home in 1 of 10, at 190 s, on a later flight's
  home leg (the long case: 4 of 10).
- **`backHome` with the pillager.** While the pillager follows nothing changes: 37 flights against 38 over the ten runs,
  28 give-ups against 29, the bot about 1 120 out at the end on both sides. The walk comes once the pillager drops back:
  in 1 of 10 `on` runs it had by the first give-up (60 s), and the bot walked the 275 blocks home in 52 s with no
  damage; in the one `off` run where it dropped back the bot stood 346 out to the end.
- **`followHome`.** In the room the home leg starts at once (`flee: home ahead of every archer`): the bot was on the
  home point 8 to 9 s after the start in every run, the gate it came in by shut behind it within 5 s in 5 of 6 (7 of 8
  with two runs of a first look), and the pillager stood outside the walls. In the sixth the gate stayed open: two bolts
  on the way in, the pillager inside by 11 s, two more took the bot to 6 and a new flight ran it out of the room (27
  damage). On flat ground the bot was home at 5 to 6 s with the pillager following and nothing between: 18.8 a run
  against 3.8 for the long leg away.

### `followRun` looks at the way home

Track M9's `followRun` shut the home leg while an archer stood within 24 of the bot. An archer just past 24 that stood
towards home let the leg start, and its first blocks walked back within 24 of it: the next look shut the leg again (the
long case's skeleton flips above). On bds-pve, in a `pve-m9` run with `backHome` set off on both sides, the pillager
dropped back past 24 and 14 samples (100 ms apart) of the home leg had it within 24. Now the leg stays shut while an
archer is within 24 of the bot or of the way home (`archerNearWay`: the level distance to the line from the bot to
home); one beyond the bot, away from home, does not hold it. The log line reads `flee: pillager following at D: not to
home while it is within 24 of the way`. `pve-m9`, five runs one at a time on bds-pve, `M9_TRACE=1` and the bot's log on:
5 of 5 on the code before this track, 5 of 5 with it. The earlier runs on this track's code before the change, with a
gauntlet chunk on the other server: 3 of 5, the 2 failures with no second flight (the pillager dropped back past 24 on a
short `far` leg and was not seen again within the 75 s the case waits). In none of the ten later runs did the pillager
drop back, so the new check acted in the unit tests only (m10-rules), and the gauntlet rows were not run again with it.

### Tried and not taken

- **Ending the flight once no archer follows within 24.** The first `backHome` also ended a flight on foot that was out
  of danger with no archer within 24, so that the home return (with its checks) and not the flight's home leg took the
  bot back. With skeletons it made things worse, 2 runs: each flight ran 17 blocks, ended, and a skeleton that had kept
  following came within 16 in sight 3 s later and started the next one (26 and 34 flights a run); the bot ended 449 and
  572 blocks out, home in neither (off: 1 of 2). Removed: the flight runs its minute as before.
- **The first build of `backHome`** never walked after the first flight: the flight starts on the home point and the
  check that disarms it at home ran before the check for a running process, so the flight's own first tick disarmed it
  (1 of 5 `on` runs walked, after a second flight that started farther out). Now nothing is looked at while a process
  runs.

### Track M6 measured again

Track M6's A/B rows with a death on either side (no kit, `pillager-1` and `skeleton-4`) ran again from rest, 10 a side,
the later rules off on both sides; the rows are corrected in place in Track M6's table, marked (M10), the first numbers
under it. `pillager-1`: **4** of 10 deaths, 25.7, 1 against 0 of 10, 12.7, 13.5 (first 8 of 10, 23.9, 0 against 0, 2.9,
20; Track M8's `on` side 14.3, 11). `skeleton-4`: **1** of 10, 22.6, 4 against 0 of 10, 3.7, 16 (first 1, 19.6, 4.5
against 0, 2.7, 16.5). Decisions 45 to 49 stand: `bareArcher` and `volley` still take every death of the two rows.

### Not met

- **Losing the pillager.** Nothing ended its chase: not distance, not daylight; hunger ended the bot. With 16 bread the
  bot lives the four minutes but runs about 1 100 blocks from home, and `backHome` cannot walk it back while the
  pillager follows (home in 1 of 10, the run where it dropped back).
- **A closed door behind the flight.** `followHome` reaches home with the pillager following, but the gate close is
  asked of the walk and a flight's re-plan drops it (Track M9's `fleeDoors`). On the home leg, which is not re-planned,
  the gate was shut within 5 s in 7 of 8 runs; in the eighth it stayed open (not traced) and the pillager came in. The
  rule cannot know whether a home has walls, and on open ground it is worse (above).
- **Ground other than flat.** Every row ran on the gauntlet's flat cells; the walk home is the normal nav, but its
  checks (a skeleton within 16 of the way) were measured on flat ground only.
- **Why the server reports a skeleton gone.** Not a despawn (above); not found.
- **The Realm.** None of the rows ran there; both rules act only with no blade carried, which the live kit never is.

### On the Realm

`backHome` is on with the update; `followHome` is off. The live kit carries a blade, so neither changes what it does: by
night, near home, `!test mobs mixed8 5` and `!test mobs pillager 5` should give no `flee: nothing near: returning home`
and no `flee: not home yet` line, every run alive, as before.

To see `backHome`, the blades (swords and axes) go into a chest first, nothing else changed, the bot at home by night:

- `!test mobs skeleton 3` (or a skeleton or two met in the open): a flight from home (`flee: no blade with an archer in
  sight`), `flee: an archer or a witch within 16 of the way to home: staying out at health H` while one stands between,
  and at the minute's end `flee: gave up (60 s)`. Then, while a skeleton stays near, `flee: not home yet: an archer or a
  witch within 16 of the way home` (or `of home`), and once none is, `flee: nothing near: returning home to x y z` and
  the bot walks back (the test servers: 8 of 10 home, 10 s a median after the walk started, no damage on the walks).
  `test/e2e/pve-m10.test.ts` checks the walk on bds-pve.

`followHome` is a switch of `PveController.rules` (`PVE_RULES_DEFAULT`, no chat setting): trying it there takes a build
with the switch on, a home with walls and a gate, and a pillager met outside with home ahead of the bot: `flee: home
ahead of every archer (health H): home, closing the doors behind`. Watch whether the gate is closed after it.

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
  the single target). Hits from truth:hurtlog. Track M6: the zombies' own gear is taken off (`PVE_FLANK_GEAR`: `strip`,
  the default; `keep`; `diamond` on the first zombie) and the bot's health is kept at 12 or over while a pair runs, so the
  flight on foot never takes the body out of the fight being measured; each line gives the bot's hits on each zombie.
- `pve-m6` (Track M6): no blade and a pillager 7 off with `bareArcher` off and on (on: the flight starts before a
  second bolt and no fist strikes it; off: guard chases it with a fist), and a stone sword at 11 health with three
  skeletons in sight with `volley` off and on (on: the flight starts; off: it does not).
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
- `pve-m5` (Track M5): how far the server sends a skeleton (24 to 104 along x; 24 must be sent); `shooterWay` off and on
  at 3 health 40 from home with a zombie 13 to the side and a skeleton beside the way (off: the bot comes within 20 of
  home; on: never within 28 of home nor 16 of the skeleton); `poisonBite` (`biteHeld` false, true once the server's
  poison is on the bot with a witch 20 off, false with the rule off, false once the poison is cleared). Each side ends with
  full health and no flight running. About 70 s. Unit: `m5-rules` (the way's geometry, the memory, `witchCrowd` with
  and without a netherite sword, `biteHeld`), `test-death` (which death is a mob's). Every pve suite starts each case on
  a clean spot (`cleanSpot`, pve-truth).
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

