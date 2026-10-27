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
| `bot/src/skills/combat/targeting.ts` | Track V: `isThreat`, `nearestHostile`, `pickThreat` (reachability-aware, creepers first), `reachability`, `wantsFlee(threat)`, `afterFight` / `ignoreMsAfter`; Track AH: `inReach` / `pickInReach` (re-targeting), `crowdOf` / `crowded` / `crowdThreat` (crowd rule) |
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

`task.status()` (metrics `taskStatus.pve`) has `behaviour`, `guard`, `fleeHealth`, `health`, `target`,
`follow` (state, distance, last known position), `lastHitBy` and counters; metrics counters
`pve.guard`, `pve.fights`, `pve.kills`, `pve.flees`, `pve.fight.<outcome>`.

## Behaviour

**Foreground and episodes.** The owner's behaviour (idle, follow, come, a goto from `!goto` /
`!home go`, kill) is the foreground. A guard fight (fight, then pick up drops within 8 blocks) or a
flight is an episode that suspends it and, when no other threat is in range, resumes it: follow
starts again, the goto is re-issued (its chat reply comes when it really ends). An idle bot with a
home walks back home after a guard fight. Rules are evaluated every 5 ticks.

**Guard** (`!guard on`): targets are hostiles, plus neutral mobs that hit the bot in the last 10 s or
target it (`target_eid`), never players, passive mobs or items. Range: within the radius of home (of
the bot when no home is set or while following) and at most radius + 16 from the bot, within 6
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
- **After a fight** (`afterFight`, also the guard process): `out_of_range` and `unreachable` 10 s,
  `took_cover` 3 s, `killed` / `creeper_avoided` / `interrupted` / `crowded` (Track AH) not ignored,
  anything else 30 s. The ignore list never blocks another mob: the next one is picked on the next
  evaluation.

#### Re-targeting within reach (wave 9, Track AH, decision 0029)

The owner: "why not just always target whatever it can within its reach? instead of risking a hit".
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
| Ends | arrived (10 s before another flight); 2 s out of danger when there is no home to go to or a command waits; cornered (the 4th no-plan in a row with a threat within 4: guard defends in place; 3 s); 60 s |
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
  everything farther. Flying mobs are fought only within reach (wave 7); a ground mob is a target only
  when it stands on or just above a standable cell (terrain query, not a path search): one behind a
  wall still costs up to 3 approaches before `unreachable` (then 10 s ignored).
- Creeper hit and run walks the bot 8 blocks back and forth (about 100 ticks per creeper); in a crowd
  the retreat can meet other mobs. Cover from archers ignores leaves and glass panes as cover and
  walks the navigator's path to it (possibly through the line of fire).
- Endermen are neutral: guard ignores them until one hits or targets the bot.
- While running away the bot does not face the attacker.
- `!follow` overrides the night shelter until `!stop`.
