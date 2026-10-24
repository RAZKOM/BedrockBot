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
| `bot/src/skills/combat/combat.ts` | `CombatController`: `fight(runtimeId, opts)`, `attack(runtimeId)`, `selectWeapon()`, the attack packet builders |
| `bot/src/skills/follow/follow.ts` | `FollowController`: `follow({ runtimeId } \| { playerName })`, `come(playerName)`, `stop()` |
| `bot/src/tasks/pve.ts` | `PveController`: guard, flee, follow, come, kill, a resumable goto, behaviour line, options |
| `bot/src/chat/commands-pve.ts` | `!follow` `!come` `!stop` `!guard` `!kill` |
| `bot/src/tasks/registry.ts` | the afk task builds a `PveController` with its movement stack (see "Shared files") |
| `packs/truth/src/pve.ts` | truth commands `summon`, `mobs`, `near`, `entity`, `killmobs`, `clearmobs`, `sethealth`, `movemob`, `effect`, `hurtlog` (packs/truth/README.md) |
| `docker/compose.pve.yml` | `bds-pve`, udp/19144, flat, difficulty normal |
| `bot/test/unit/skills/{combat,follow,pve}.test.ts`, `pve-fakes.ts` | unit tests on fakes |
| `bot/test/e2e/pve-{combat,follow,night}.test.ts`, `pve-truth.ts` | e2e on bds-pve |

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
| `!follow [name]` | follow the player (default: the sender) until `!stop` |
| `!come [name]` | one walk to within 2 blocks of the player's current position |
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
blocks of height. Priority: the mob that hit us, then mobs targeting us, then the nearest. A target
that ends `unreachable`, `timeout` or `out_of_range` is ignored for 30 s (10 s for out of range).

**Flee** (`fleeHealth`, default 8): health below it with a hostile alive within 16 blocks: sprint to
the shelter if one is set, else home; with neither, or already there, 12 blocks straight away from
the nearest hostile. After arriving, 10 s before another flight. While the health stays low, guard
only defends in place (hostiles within reach, no walking). The bot does not face the attacker while
running (the navigator owns the yaw).

**Night shelter cooperation.** While night safety wants the shelter (dusk to dawn, a shelter set):
inside it guard only defends in place; on the way there neither guard nor flee interrupts (that
would count as a failed retreat). While a PvE behaviour owns the movement (any episode or a
non-idle foreground) night safety pauses, so an explicit `!follow` keeps the bot out until `!stop`.
After a death, follow / come / kill / the episode are dropped (guard stays on); the after-respawn
home hook walks home as before.

**Fight** (`CombatController.fight`): picks the best hotbar weapon (sword > axe > anything); farther
than 3.5 blocks (or another level): navigator `near` goal radius 2.5, re-planned when the target moved
1.5 blocks, sprint beyond 8, pitch towards the target; within 3.5 blocks on the same level: the
navigator is cancelled and the controller steers (yaw at most 40 degrees per tick towards the target,
pitch at its upper body, forward while farther than 2.2, back while closer than 1.0). Strike when the
eye is within 3.0 of the target's box, the view within 35 degrees and 10 ticks after the last
strike. Creeper with a lit fuse within 7: run straight away, wait until the fuse has been out 10
ticks; after every strike on a creeper, back off 8 ticks. Ends `killed` (death animation or health 0),
`gone`, `exploded`, `out_of_range` (farther than 32 for 100 ticks), `timeout` (1200 ticks),
`unreachable` (3 failed approaches), `interrupted` or `refused_player`. `approach: false` = defend in
place.

**Follow**: `near` goal radius 3 around the target's feet, re-planned when it moved more than 2 blocks
since the last plan (not while the last walk reached it), sprint when more than 8 away, stop and face
it within 3. When the target leaves the tracked set: walk to its last known position (or, after a
teleport followed by leaving view within 2 s, to where it was before the jump) and wait there;
resume when it is tracked again. Players are found by the `add_player` username (case-insensitive,
`§` codes stripped).

## Packets (BDS 1.26.60.6, verified)

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
pnpm --filter bot exec vitest run --project unit combat follow pve      # 31 unit tests, fakes only
node scripts/bds.mjs --profile pve up && node scripts/bds.mjs --profile pve pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e pve           # combat + follow + night (~9 min)
BDS_E2E=1 BDS_PVE_NIGHT=1 pnpm --filter bot exec vitest run --project e2e pve   # with the night run (opt-in)
```

- `pve-combat`: 3 zombies one after another (each checked dead on the server, hits counted from
  `truth:hurtlog`), a skeleton, a creeper (0 explosion damage), guard (zombie 10 blocks from home,
  fight, back home), flee (health set to 5 with a zombie near, run to the shelter 14 blocks away),
  `!kill player` / `!kill <name>` refused with a second client next to the bot, and the combat skill
  refusing that player directly; the server's hurt log shows no damage to it.
- `pve-follow`: a pig with slowness 255 teleported 3 blocks every 2 s for 102 blocks; a second client
  (a real offline player, an owner) types `!come`, `!follow`, `!status`, `!stop`; leaving view (a
  400-block teleport) -> last known position -> waiting -> resumed.
- `pve-night`: natural spawning and the daylight cycle on, time 16000, guard radius 16 at home for
  6000 ticks; 0 deaths required. Opt-in with `BDS_PVE_NIGHT=1` (in the wave-5 full gate the bot died once in a crowd under machine load; armour and food come with 7.11); `BDS_PVE_NIGHT_TICKS` and
  `BDS_PVE_NIGHT_START` change it.

Every run uses its own random 256-block cell from x, z = 8192, random truth request ids and a per-run
summon tag; summoned mobs are removed at the end (`truth:killmobs`), the night run also clears every
non-player entity within 96 blocks of home.

Manual check left for the Realm (you): `!come` and `!follow` from your own client (the e2e uses a
second offline client, which is a real player entity to the bot), and a night with `--guard 16`.

## Known limits

- **No eating** (PLAN.md 7.7): health only regenerates while food is 18 or more; after a few fights
  in a long night the bot runs on what is left. Flee covers the worst case.
- **No armour, shield or bow**; no critical hits (no jump attacks); sprint-knockback is not used.
- Melee-range steering (the last 3.5 blocks) does not avoid holes or lava; the navigator handles
  everything farther. Flying mobs (phantoms) and mobs on another level are fought only if the
  navigator can reach a cell within reach; otherwise `unreachable` after 3 approaches, and the mob is
  ignored for 30 s.
- Endermen are neutral: guard ignores them until one hits or targets the bot.
- While running away the bot does not face the attacker.
- `!follow` overrides the night shelter until `!stop`.
