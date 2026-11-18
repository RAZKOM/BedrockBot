# 0079: Never die to common mobs (Track M1)

Date: 2026-11-09. Status: accepted. Builds on [0018](0018-survival-policy.md) (flee v2, the duel rule) and the guard and fight
rules of [../pve.md](../pve.md) (waves 7 to 9). Details, measurements and the gauntlet tables: [../pve.md](../pve.md) "Never die
to common mobs (Track M1)".

## Context

The bot must not die to the common mobs: zombies and their kinds, skeletons and strays, creepers, spiders, phantoms, drowned,
witches, endermen that attacked, pillagers, slimes (not the warden), bare-handed as well as in its kit. Before this track the
guard fought only what it had chosen as a target, with the fight's own reach of 3.0 and its turning and walking; a mob it had not
chosen could hit the bot for free, and a task (a goto, a mining job, eating) had no defence at all unless guard broke it off.

The gauntlet (`test/e2e/gaunt-mobs.test.ts`, 31 cells a kit) measured it first: bare-handed on bds-gaunt the bot died in 10 of
31 cells (a single baby zombie, drowned, stray, witch, enderman or pillager; 4 zombies, 4 skeletons, 4 creepers, the mixed 8).
With the live kit (netherite, a sword, a shield, food) on bds-pve it died in none, but took 18 health from 4 zombies and 32 from
the mixed 8 in a minute.

The six `death.attack.player` deaths in the Realm log were attacks by a player (the damage sizes and the rhythm fit no mob, and
the bot's attacker guess skipped players); they are not a mob problem and this track does not touch them.

## Measured on the server (bds-pve, BDS 1.26.60)

- An attack lands up to 6.2 from the eye to the target's box (6.9 feet to feet), and misses at 6.7. The way the bot faces does
  not matter (hits at 0, 90 and 180 degrees, also walking away).
- A mob takes damage once in 10 ticks (hurt time): 4 of 40 every-tick attacks land. Three mobs can be hit in the same tick.
- Knockback goes along the line from the bot to the mob, not the way the bot looks: 1.65 blocks in 20 ticks with a fist, 1.62
  with an iron sword, 2.54 with Knockback I, 4.5 with Knockback II, 2.2 sprinting with a fist, 6.3 sprinting with Knockback II;
  by mob, 1.15 (spiders) to 1.69 (slime).
- A zombie hits from 1.2 to 1.7 feet to feet. A creeper's fuse lights at 3.0 to 3.15; fist hits from 3.9 do not keep it off.
- A shield (sneaking) blocks from the front and the side (0 to 90 degrees), not from behind.
- A falling hit does 1.5 times the damage. An attack while eating lands and does not stop the bite.
- One free zombie against a bot standing still with fist strikes from 3.0 to 3.9: 16 to 23 strikes and no hit taken in 20 s
  (the knockback keeps it out of its own reach).

## Decisions

1. **The reflex** (`skills/combat/reflex.ts`, setting `mobReflex`, on in round 1, off in round 2: decision 15, on again: decision 26): every tick, before the step, up to 3 hostiles in reach
   (3.9 eye to box, line of sight, their hurt time over, each not struck by us in the last 10 ticks) get a strike, without
   turning the body or touching the keys (the server does not need the bot to face them). Order: a lit creeper, a mob that hit
   the bot in the last 2 s, then the soonest to reach the bot ((distance - its reach) / its speed). It runs under every task
   (walking, mining, eating, building) and under guard's own fight, and not in flight.
2. **Never a friend**: never a player, a passive mob, an iron or snow golem, a villager, a wandering trader, an allay, the
   warden, the creaking, the dragon or the wither. A neutral mob (enderman, piglin, wolf, bee, llama, polar bear, ...) only
   when the server says it targets the bot and the hit guess blamed it for a hit within 10 s.
3. **The health rule, in order** (`pveFloor` in tasks/pve.ts): fight on (no danger, or a duel worth it); eat when every mob is 8
   or more away; back off (the flight on foot, the reflex striking behind it); when running failed (caught or cornered within
   20 s) or the health is 4 or less with a melee mob within 3, or 8 or less with a hit taken in the last 3 s: the elytra flee, then the seal-in,
   then defend in place. Each of the elytra flee and the seal-in is tried at most once in 30 s.
4. **Archers alone are closed in on** (up to 2 skeletons, strays, bogged or pillagers): the duel rule takes them (it gives up
   after 8 health lost in 6 s, against 4 for a melee mob, with health for 2 more arrows). Running from them in the open kept
   the bot in their range. With no blade in the hotbar: **no bite in a ranged mob's range** (the eat floor needs every mob 8
   away and no ranged mob within 16) and **a witch** within 16 starts a flight below 14 health (its harming potion is 6 at
   once, on top of its poison). With a blade both stay as before: in the kit a bite is worth an arrow, and the fight is
   better than a run through a crowd.
5. **The elytra flee** (setting `fleeFly`, off): `!fly home` as the first owner, through the chat command, only with an owner,
   a home and the flight kit ready (`skills/fly/kit.ts readKit`, `kitReady`). Nothing in the flight code changed.
6. **The seal-in** (`skills/survival/seal.ts`, setting `sealIn`, off): the four cells round the feet, the four round the head,
   the one over it, throwaway blocks only (never one that falls, burns, is worth keeping or does something), the side facing
   the nearest mob first; then eat and wait until 18 health (5 min at most), then open the side away from the mobs. Without
   the blocks, on dirt or grass, the dig-in: 3 cells straight down (dirt-like, solid walls and floor, no cave, no liquid), the
   first one roofed with the dirt it gave; it opens through the roof.
7. **Counts an owner can read**: the PvE status (`!status`, the panel) and the metrics: `pve.reflex.hits`, `pve.reflex.kills`,
   `pve.taken.<type>`, `pve.floor.<floor>`; one `[pve]` line per decision (`reflex: zombie #12 in reach (2.8): striking`,
   `floor: seal in (...)`).
8. **`!test mobs`** (skills/test/mobs.ts) runs the gauntlet's sets on the Realm under testMode: 150 blocks from home at least,
   its mobs under one name tag, removed at the end and on `!test stop` (only that tag).

## Round 2 (2026-11-10)

Measured on bds-gaunt (BDS 1.26.60, `pve-rules.test.ts` case `strike`, `gaunt-probe.test.ts`; the tables in
[../pve.md](../pve.md)): a strike with the shield up lowers it for 13 to 16 ticks; a witch throws from 8 (not 12) once every
61 ticks, harming 6 through any armour, poison down to 1 health; a skeleton aims where the bot is when it lets go, so running
across its line at sprint takes 2 hits in 13 arrows against 7 in 9 standing; a 2-high block or a 2-deep hole stops both. In
the died round-1 and round-2 runs 0 of 5 arrows landed within 16 ticks of a reflex strike: the reflex's deaths were the witch.

9. **The reflex keeps the shield**: with the shield up it strikes only a lit creeper within 4.5 or a melee mob 2 ticks from the
   bot outside the shield's 90 degrees; never an archer or a witch (`worthTheShield`).
10. **The idle shield**: with `mobReflex` on and nothing running, a shield in hand and an archer's shot due or an arrow coming,
    the body faces it sneaking (two live-kit `mixed-8` deaths stood at 1 health with the shield down under a skeleton).
11. **The witch first, with a blade**: within 12 and in sight, at 8 health or more, at any health within 8 (her throw range)
    or for 2 s after her throw (her next is 61 ticks off), the way to her clear of other melee mobs: guard's first target, and
    no flight from her; fought with the approach also when guard defends in place, and not ignored after an out-of-range fight.
    Running from her does not work: she follows and throws across the run.
12. **The dodge, without a blade** (`skills/combat/dodge.ts`, setting `mobDodge`, off): across the shooters' line at sprint,
    drifting out of their range, turning only with nothing in the air, every step on a known safe cell, else the ordinary
    flight. It ships off: it is steered by hand on the bot's own map and has run on flat test ground only.
13. **The seal closes**: the dig-in's centring walks rather than sneaks when the body is to fall into the hole, 3 tries, the
    next digs under the feet where they are. The surface shell centres the body first, puts a support beside the roof in the
    open (the roof has no face to go against otherwise: it was open in every round-2 run before), gives open cells a second
    pass and an open shell one more build. With `sealIn` on, 3 shooters in sight and the shell possible, the seal comes at 14
    health instead of 8. Out only at full health and with the mobs gone or at day.
14. **The potion side step** (with the reflex): a potion within 12 whose level motion points at the bot gets a 12-tick sprint
    at right angles to it on safe cells, with no walk and no process but guard (it overrides a guard fight's steering for those
    ticks). The reflex killing the melee mobs in place left the bot standing still under her throws.

15. **The reflex ships off.** The bar for it on: the live kit's deaths and damage in `mixed-8` and every other live-kit cell
    not worse than the base code at the same number of runs. Final code, `mixed-8`: on, live 0 deaths in 10, damage 23.8
    (base 3 in 10, 18.0); Knockback II 1 in 5, 17.7 (base 0 in 5, 15.6). Off: live 1 in 10, 25.4; Knockback II 0 in 5, 19.8.
    Not met, so off. The idle shield and the potion side step come with it (both need `mobReflex`). The damage is the witch's
    poison (down to 1 health in 9 of 10 runs either way); the deaths with it on were her harming at low health, the one with it
    off a zombie on a bot running at 1 health. The owner decides whether a bare-handed bot gets it on.
16. **Guard collects drops only with no other hostile within 16** (the collect walk stood 10 s by a witch and a spider).

## Addendum: Track M2 (2026-11-10)

The numbers are in [../pve.md](../pve.md) "Track M2". 30 runs a side of `mixed-8` for the live kit and for bare hands with
`mobDodge` on, the whole gauntlet 3 times each way, idle nights, the dodge on built ground (bds-pve and bds-gaunt).

17. **Eat before the sprint is lost**: the survival kit's bite while walking or fleeing comes at food 10 (6 before), and the
    flee eats from 10 (`EAT_BEFORE_SPRINT_LOST`, `FOOD_SPRINT_EAT`). Below 7 the body cannot sprint and 3 zombies keep up
    (round 2's `act-eat` death).
18. **With the reflex on the witch's way need not be clear**: the melee mobs on it are struck in passing. With the rule the
    reflex killed the ring at home while she threw at a still body (potions within 4 of the bot 54 of 62 against 26 of 72 with
    it off, her damage 20.5 against 14.9 a run); without it she throws 42 in 30 runs against 72.
19. **No potion side step while guard fights a witch**: the step turned the body away from her for 12 ticks; it does not get
    out of a splash's 4 blocks either way.
20. **A target the bot walks after is not stalled**: the combat watchdog's "no progress in 60 ticks" also resets when the body
    has moved 1.5 blocks (`STALL_MOVE`), out of reach only and for at most 300 ticks after the last real progress
    (`STALL_WALK_TICKS`; in reach the strikes without a hit stay the measure). On a slope or a ledge the reach measured from
    the eye kept its distance while the bot walked round to her and the witch was written off as unreachable while she could
    still throw. Without the bounds a fight on a zombie the blade could not finish walked on to its 600-tick timeout
    (`pve-combat` flank, 1 of 20 runs).
21. **A first target (the witch) is looked for 10 up or down** (`FIRST_MAX_DY`, other mobs 6), and an "unreachable" note on
    her is tried again after 3 s (`FIRST_RETRY_MS`), not held for the note's whole life.
22. **The elytra flee hands the body over**: for up to 6 s after `!fly home` is sent (`FLY_HANDOVER_MS`), while a `fly` process
    runs, the flee and guard do not want the body. Before it the takeoff was accepted and taken back the next tick (4 of 4
    deaths in a pen).
23. **Hold the ground with the reflex**: at low health with the reflex on, up to 3 melee mobs within 8 (`HOLD_MAX`), no creeper
    within the flee's range, no archer or witch in sight within 16 and fewer than 2 melee hits in 3 s, the bot stands and
    strikes instead of running (a run at low health was what the melee mobs killed).
24. **The dodge keeps off edges**: when the cell 1.3 behind the line out (`EDGE_MARGIN`) is not known safe it drifts back in,
    and when straight out is not clear it runs along the line across the shot before it gives up. Not enough on a cliff: an
    arrow's knockback still put the body over in 1 of 3 runs and the flight's run away (nav, its last level takes hurting
    falls) in the others. `mobDodge` stays off.
25. **`!test mobs` asks the server first**: `/gamerule keepinventory` and `/gamerule mobgriefing`, both said in the first line
    with the ground of the ring 7 out (16 points: level, standable within 8 levels, or not). It refuses with keepInventory off
    or unanswered, a creeper set while mobGriefing is on unless the command says `force`, and a ring mostly not standable or a
    slope.
26. **The reflex is on by default again.** The bar (deaths and damage over 30 runs a side of `mixed-8` not higher with it on,
    in the live kit and bare, and no friendly fire) is met on the final code: live 0 deaths in 30, damage 17.0 a run, against
    4 and 22.0 off; bare with `mobDodge` on 0 and 1.5 against 17 and 22.0. The whole gauntlet 3 times each way: live 0 of 99 both
    ways, damage 130 against 193; bare with `mobDodge` on 2 of 99 against 8, 371 against 832. No friendly hit in those 318
    runs, in the friendly-fire case (`pve-m1`) or in 3 live nights; one bare night counted 3 hits on something outside the
    harness's hostile list, its type not recorded (the night line names them now; 5 nights since have none). The idle shield
    and the potion side step come with it.
27. **`mobDodge`, `sealIn` and `fleeFly` stay off**: the dodge still falls off a cliff on real ground (decision 24), the bare
    nights still die (to a witch's poison and endermen), and the elytra flee lands itself at low health next to the mobs
    (decision 22; the flight code is not this track's).

## Consequences

- Measured (the tables in [../pve.md](../pve.md)): bare-handed deaths 10 of 31 cells before, 6 after, damage 459 to 282; the
  live kit 0 and 0 deaths, damage 87 to 35; Knockback II 0 and 1 (`mixed-8`), damage 104 to 46. Idle nights: live and
  Knockback II alive (0.4 and 1.9 damage), bare died twice to skeletons. The tasks under attack finish; no friendly hit.
- Round 1 not met: bare-handed against archers and a witch in the open, and the live kit's `mixed-8` (3 deaths in 5 repeats
  with the reflex). Round 2 (final code, defaults, one run a cell): live 0 of 33 cells, damage 55; Knockback II 1 of 33
  (`seal-5`), 71; bare 9 of 33, 422. Repeats: live `witch-1` and `witch-2` 0 deaths in 10 each, `mixed-8` 1 in 10 (reflex
  off) and 0 in 10 (on) against 3 in 10 for the base code; bare with `mobDodge` on 0 deaths in 5 each of `skeleton-1`,
  `skeleton-2`, `skeleton-4`, `pillager-1`, `drowned-1` and `witch-1`; the shell of blocks 3 of 3 under 4 skeletons and a witch.
- Bare with `mobDodge` on, the whole gauntlet twice: 2 deaths in 66 runs (an enderman, 3 zombies on a bot at food 6 that cannot
  sprint); at hard 0 of 7 crowds (the defaults 4 of 7). Its idle nights: 1 death in each of 2 (melee mobs on a fleeing bot;
  round 1 with the defaults 2 deaths in 1 night, to skeletons). Hard crowds with the kit: live 0 of 7, Knockback II 1 of 7
  (`skeleton-4`).
- Still not met: bare-handed with the defaults (the dodge is off), the bare dig-in under archers (pushed off the column), and the
  witch's poison in `mixed-8` (to 1 health in 9 of 10 runs; armour does not reduce it).
- The reflex costs a scan of the tracked entities a tick. It never moves the body, so a task's walk and its digs go on; the
  strike's swing is the only thing the server sees.
- The fight's own strikes still happen at 3.0 when guard fights; the reflex adds the mobs guard did not choose.
- The elytra flee and the seal-in ship off: either can strand or kill the bot on terrain they were not tried on (a takeoff
  under a roof, a seal in lava's reach). The owner turns them on after a try.
- Open: a falling hit (1.5 times) is not used; knockback by the line could push a mob off a ledge on purpose; a sprint strike
  (more knockback) needs the keys, which the reflex does not touch.

## Addendum: Track T2 (2026-11-15)

28. **`!test mobs ... bare` stows the blades, it does not destroy them.** The kit on a test world carries a sword, so the
    floors for a bot without one (the elytra flee first, the dodge) never run there. With the word `bare` the hotbar's swords
    and axes move into free main-inventory slots before the first run (the survival kit's inventory screen and the
    containers' predicted move: the item keeps its enchantments and wear), the hotbar puller passes blades over until the
    end (`HotbarPuller.hold`, the one road from the main inventory into the hotbar, so the fight's weapon pull cannot undo
    it), a blade the kit's restore gave into the hotbar moves out after each restore, and every blade goes back to its slot
    however the series ends, after a death's recovery and once a flight has come down. Too few free slots refuse the series
    before anything moves. `/clear` and `/give` were not used: a given item has no enchantments on Bedrock.
29. **A run's hits and floors are copies of the counters at its start.** The series read the PvE controller's live counter
    objects at the start and again at the end, so every run said `hits none, floors none`; records before this carry neither.
30. **`bare` exchanges when the inventory is full** (Track T2, from the Realm). A kit that fights mobs picks up their drops
    and the server puts a pickup into the first empty slot, the hotbar first, so at a series' end the blade's hotbar slot
    is usually taken and the inventory often full: the restore left the sword in the main inventory. The restore now
    exchanges the blade with whatever holds its slot, one `swap` stack request under the inventory screen
    (`SurvivalKit.swapSlots`, the request the survival kit already used for a box into a full hotbar), predicted with each
    stack's own wire item: nothing is dropped, nothing needs a free slot. The stow uses the same exchange with a main stack
    the fight would not select as a weapon (`weaponScore` 0), so `bare` no longer needs a free slot; it is refused only when
    every main stack is a weapon. The pickup's slot is not the bot's to choose, so it is not steered.
31. **The hotbar puller exchanges with a full inventory** (Track T2 follow-up, from the Realm). No ADR owned the puller (Track
    V's weapon pull is described in pve.md only), so this addendum records it. With a full hotbar and no free main slot the
    pull failed `no_space` without a word, and a bot whose inventory was full of drops fought every fight after with a tool
    or a fist. Now the wanted item and the hotbar item the pull would have parked exchange places in one `swap` request (the
    survival kit's `exchange`, the request `swapSlots` and the kit's `toHotbar` send), with the same choice of the item given
    up, for every job of the puller: the fight's weapon, the Digger's tool, a breeding item. A failed pull is said in the log
    once a minute a job and reason, so a fight with the wrong weapon is visible.

## Addendum: Track M4 (2026-11-16)

The numbers are in [../pve.md](../pve.md) "Track M4: early-game kits". The gauntlet gained three kits a bot has early in a
world (`none`: food only; `stone`: stone tools, no armour; `iron`: the iron set, an iron sword, a shield) and a day time
(`MOBS_TIME=day`). One run a cell of each kit by day and by night (198 runs), then A/B series of 10 runs a side on the rows
that killed, on bds-pve and bds-gaunt.

32. **Five rules, each on by default, kept as switches of the controller** (`PveController.rules`, `PVE_RULES_DEFAULT`), not
    settings: each changes a choice the guard or the flight on foot already makes (whom to fight, which leg to run, how far a
    leg runs), none places or digs a block or moves the body in a way it did not move before. They are switches so that the
    gauntlet can measure each (`MOBS_RULES`, `MOBS_AB_RULE`). The bar for a rule that only changes choices (no row worse
    with the live kit) is met: the live kit's `mixed-8` 0 deaths in 10 either way (damage 26.8 off, 21.7 on), every cell
    once with them on 0 of 33 (1.4 a run); no row of the early kits has more deaths with them on (pve.md's table).
33. **`archerDuel`: with a blade, archers alone near home are closed in on.** At low health with a blade, within 16 of home
    (`ARCHER_DUEL_HOME`), no shelter, only archers within the flee's scan (2 at most, no melee mob, creeper or witch) and one
    in sight: that archer is a duel and guard's first target, fought with the approach. Before, the bot stood at home in the
    archer's line: no flee (at home only for a threat within 6, Track W), no duel (twice the last arrow was more than the
    health), and guard in place does not walk. Not at 5 health or under (`ARCHER_DUEL_MIN`, after the poison): with the duel
    at any health the stone kit's `seal-5` fought two skeletons at 2 to 5 and died in 4 of 5.
34. **`poison`: the bot's own poison is the poison, not a hit.** `MobTracker` reads the bot's `mob_effect` (effect 19) and a
    drop of 1 while poisoned gets the cause `poison`: no attacker guess, no last hit for the duel, its own counter. The
    duel's margin and the archer duel's floor count the health the poison will leave (`healthAfterPoison`). Before, each
    tick was blamed on a ranged mob within 20 and became the duel's last hit of 1, so the bot dueled a skeleton at 3 health.
    Low health (the flee) stays the health itself: counted with the poison, the stone kit fled from the witch who poisoned it
    in 4 of 5 `mixed-8` runs, she walked after it, and her harming killed it at 1 health 100 blocks out in 2 of 5 (0 of 5
    before). The poison alone stops at 1.
35. **`shooterHome`: home is no refuge while an archer or a witch stands within 16 of it** (`SHOOTER_HOME`, seen or not),
    and at home an archer with a line on the bot is fled from at low health whatever its distance (not a witch: she walks
    after a bot that runs, and guard at home kills her, decision 18). Home's
    clearance is an angle rule (Track W), made for mobs that walk after the bot; archers 12 to 15 from home beside it made it
    "clear" and in range. In 17 of 26 stone-kit `seal-5` deaths the flight had a leg home in its last 10 s.
36. **`legHold`: a leg of the flight on foot holds 2 s** (`FLEE_LEG_HOLD_MS`) unless a threat comes within 6; `away` comes
    back only with the nearest threat inside 9 (`FLEE_LEG_BAND`); `home` again only once home has stayed clear 2 s. Each
    change of leg is a new walk and a new walk stops the body; the iron kit's `mixed-8` death changed leg every 0.5 to 1 s.
37. **`fleeLong`: the `away` and `far` legs run 8 farther** (`FLEE_LONG`, up to `FLEE_FAR`). The walk sprints only with more
    than 8 blocks of straight path left, and a leg of 16 is about that: over the screen's flee ticks the body sprinted in 13 %
    of the `away` ticks and none of the `far` ones.
38. **Not taken: the approach to an archer sprinting** (5 runs a side of the stone kit's `skeleton-4`: 1 death against 0,
    damage 20.6 against 14.6; a sprint's strike knocks the skeleton back out of reach). **`sealIn` stays off**; with the
    rules on it saved the stone kit's `seal-5` in the runs where it sealed, measured in pve.md. **`!test mobs` has no kit
    option**: a Realm without cheats cannot give stone or iron items or take the worn armour off, so the early kits are
    measured on test servers only; on the Realm `bare` is the nearest.

## Addendum: Track M5 (2026-11-16)

The numbers are in [../pve.md](../pve.md) "Track M5: witches and arrows under poison". The rows that still killed on
Track M4's code were measured again (10 runs a side), the deaths' last 10 s read tick by tick, and each fix A/B'd on its
rows and on the live kit's and the stone kit's `mixed-8`, on bds-pve and bds-gaunt.

39. **Test cells are cleaned before a case, and a death no mob caused is a harness failure.** Every pve suite and the
    gauntlet lay the ground under their spot, clear the air and the entities, and read the spot back (`cleanSpot`); a
    death whose message or killing hit is a block, the ground or the void (`skills/test/death.ts`) fails the case or is
    run again in the gauntlet, never counted as a row's death. Track M4's pve-combat deaths were all `death.attack.inWall`
    in other runs' blocks; with the cleaning, 10 dirty spots were found and laid again and no case met a block death.
40. **`shooterWay`: at low health the way home has to be clear of archers and witches too**, not only home: no `home` leg
    while one stands within 16 of the line from the bot to home (behind the bot excepted), seen or not, and the danger
    being over no longer makes home clear on its own then. A switch of the controller like decisions 32 to 37 (a choice of
    leg only). The case: a poisoned bot at 1 to 2 health far out with nothing within 16 walked home past the skeleton that
    had followed it out (every stone-kit `mixed-8` death, half the stone `seal-5` deaths on Track M4's code).
41. **Archers and witches out of the server's range are remembered**: one the server stops sending 48 blocks or more from
    the bot is kept at its last place for 60 s for `shooterWay`; one lost nearer is taken for killed. bds-pve sends entities
    to about 56 blocks and not from 72; a bot waiting 53 out had no entity for the skeleton at home.
42. **`poisonBite`: no bite in the flight on foot while poisoned with an archer or a witch within 24**, unless the food is
    down to the sprint's floor. A bite slows the body for 1.6 s and heals nothing while the poison holds the health at 1;
    the witch follows a fleeing bot at 13 to 16 and throws from about 10. `none` `witch-2`: damage 27.4 to 15.7 a run, the
    lowest health's median 1 to 3.5, 10 runs a side.
43. **`witchCrowd`: with a stone or iron sword, the witch is not the first target at 10 health or under while an archer
    shoots** (her harming 6 and one arrow 4). Track M1's witch-first rule stands for diamond and netherite swords, which
    kill her in 3 hits: an early form for every blade took the live kit's lowest-health median from 5.3 to 1.4 (5 a side).
    Iron `seal-5`: 1 death in 10 to 0, damage 22.6 to 15.0, lowest median 1.6 to 8.9; stone `seal-5` unchanged (1 in 10
    either way).
44. **All three ship on**: choice-only, and no row is worse in deaths. Off and on, 10 runs a side: stone `seal-5` by day
    2 to 0, iron `seal-5` 1 to 0, iron `mixed-8` 1 to 0, no kit `witch-1` 4 to 0, `skeleton-4` 4 to 0; stone `seal-5` by
    night 1 and 1; the live kit's `mixed-8` 0 and 0 (damage 22.4 to 26.0, the poison's luck: `witchCrowd` leaves its
    sword alone). No kit `pillager-1` dies in about 6 in 10 either way (19 of 32 off, 19 of 31 on, three series). Not done:
    anything that places or digs or moves the body in a new way (cover from archers, a longer or faster run from a
    following witch); see pve.md "Not met".

## Addendum: Track M6 (2026-11-16)

The numbers are in [../pve.md](../pve.md) "Track M6: archer groups, crossbows". The no-kit `pillager-1` cell was traced
tick by tick over whole runs, each rule A/B'd at 10 runs a side on its rows and on the live kit's and the stone kit's
`mixed-8`, on bds-pve and bds-gaunt.

45. **`bareArcher`: with no blade carried (the hotbar or the main slots), an archer with a line on the bot within 16 is
    run from at any health.** (As first merged it asked the hotbar only; on the Realm, 2026-11-17, the `bare` series ran
    from one skeleton at 20 health in netherite with the sword in a main slot and cleared 0 of 5: the fight fetches a
    stowed blade, so a stowed blade counts.)
    A fist chase stood 2 to 5 blocks in front of the pillager, a bolt (4) every 47 ticks, 20 to 9 health in about 7 s,
    and the flight on foot started at 5 to 7 with the fourth bolt; once running, the bolts that landed came from 8.3 to
    9.6 blocks about every 26 s. The run was right and late. No kit `pillager-1`: 8 deaths in 10 to 0, damage 23.9 to
    14.3 a run (Track M8: first given as 2.9, a harness fault that started 8 of the 10 `on` runs off their spot after
    the `off` run's death; run from rest, the pillager follows the whole minute and a bolt lands about every 18 s).
    A choice of when the flight starts, like decisions 32 to 44.
46. **It does not move the elytra flee up.** At 14 health or over (`FLY_SHOOTER_HEALTH`) the flight `bareArcher` starts
    stays on foot; Track M3's rule for shooters (the elytra flee below 14 with no blade) and every floor below 14 choose
    as before. A takeoff costs rockets, which a world without cheats has to craft.
47. **`volley`: at `fleeHealth` or over, the flight on foot also starts when the health is at most one round of the
    shooters in sight** (2 or more archers within 16 and witches within 10 with a line on the bot). Each counts what its
    own last hit on the bot did (else its kind's last hit; at most 6, since a hit is blamed on a guess), and before any
    hit an arrow at 4 less 4 % a point of the armour worn and her harming at 6. Counting what they did, not a fixed
    floor, keeps an armoured bot fighting: four skeletons that have not hit are 3.2 against the netherite set and 16
    against no armour. Stone `seal-5` by night: the flight started at a median of 9 health against 6, damage 29.0 to 25.2,
    no death either side in 10.
48. **Both ship on**: choice-only, no row is worse in deaths. Off and on, 10 runs a side: no kit `pillager-1` 8 to 0,
    `skeleton-4` 1 to 0, `mixed-8` 0 and 0 (damage 16.8 to 0.3); stone `seal-5`, `mixed-8`, `skeleton-4` and iron
    `seal-5` 0 and 0 (damage 29.0 to 25.2, 25.8 to 25.5, 14.9 to 8.8, 23.7 to 20.1); the live kit's `mixed-8` 0 and 0 in
    15 a side, where neither rule acts (a blade, and one skeleton and a witch through netherite are under `fleeHealth`;
    no line of either rule in its log): its damage, 18.6 and 24.0, is where the witch's poison landed. Not done: ground
    other than flat cells, activities with no blade, anything that places blocks; see pve.md "Not met".
49. **No block is placed for archers.** Cover, a pillar and the seal-in were not built: `bareArcher` alone took the
    pillager cell to no deaths, and closing in between bolts is not needed with a blade (the stone and iron kits'
    `pillager-1` never died in Track M4). `sealIn` stays off (decision 27).
50. **The pve-combat flank case keeps the bot out of the flight it does not measure.** Its flake (one zombie left after
    3 fights and 40 s, about once in 6 file runs) was the controller's own flight on foot: after 5 zombie hits the
    health is 5, under `fleeHealth`, and the flight took the body while the fight ran to its timeout; a zombie in armour
    made it likely, and a zombie in diamond armour made it happen in 2 of 2 runs. The case keeps the health at 12 or over
    while a pair runs and takes the zombies' own gear off; with the diamond zombie, 8 of 8 runs then killed both.

## Addendum: Track M7 (2026-11-16)

The numbers are in [../pve.md](../pve.md) "Track M7: the live kit's margin". The live kit's `mixed-8`, `witch-1`,
`witch-2` and `seal-5` by night were measured with whole-run traces, 15 runs a side for each A/B, on bds-pve and
bds-gaunt.

51. **A run is measured until its poison is over.** The gauntlet ended a run at its last kill, while the witch's poison
    often had 20 to 40 s to go; the lowest health read there was not the lowest. `MOBS_POISON_WAIT=1` keeps the run
    going while the bot is poisoned (up to `MOBS_SECONDS`), and the hits are split by cause from the server's hurt log.
52. **The poison is the live kit's margin.** With the code of Track M6 it was 80 to 100 % of the damage in every cell
    with a witch (`mixed-8` 16.7 of 21.0 a run, `seal-5` 26.5 of 28.7, `witch-2` all of it); the lowest health's median
    was 1 to 1.7, and the health went under 6 mostly after the last kill, at home with nothing running. One witch alone
    did no damage (`witch-1`: dead in 2 to 3 s).
53. **`witchRush`: a witch guard takes first is fought as a rush, with a diamond or netherite sword and the reflex on.**
    She threw at tick 62 to 92 and died at a median tick 225: the creeper interlude, re-picks to mobs in reach and the
    shield's sneak held the fight up. The rush leaves those to the reflex (a lit creeper or one within 3.5 still goes
    first), keeps the shield down, sprints the approach, and within 8 steers straight at her over ground the grid knows
    is safe; guard starts no fight on a mob in reach while her path probe runs. `mixed-8`: she died at a median tick 86,
    before her first potion in 9 of 15 runs against 2; damage 21.0 to 7.1 a run, lowest median 1.7 to 18.8, poisoned
    runs 13 to 4. `seal-5` (the skeletons are summoned first, so guard is already in a fight when she appears): damage
    28.7 to 17.9, poisoned runs 15 to 9, lowest median 1.2 to 1.3. `witch-2`: no gain (the second witch throws while
    the first is rushed; poisoned runs 13 of 16 to 15 of 15, damage 22.0 to 29.0, lowest 1 either way). `witch-1`: no
    damage either way. No death on either side in 121 runs.
54. **It ships on.** It changes when the fight's existing moves are used (the sprint it makes against an archer, the
    close steering it makes within 3.5), places and digs nothing, and steers straight only over cells checked safe one
    by one (a floor, room for the body, no liquid, nothing that hurts); elsewhere the navigator approaches as before. No
    row is worse in deaths and the lowest health's median is better or equal on every row; `witch-2` costs damage (its
    lowest stays at 1, as before). An iron sword or worse does not rush: she takes 5 hits or more (decision 43).
55. **`milkCure`: carried milk is drunk once the poison would take more than 3 more, with no witch within 16, no mob
    within 8, no fight and no flight.** Milk clears every effect in one drink. With two buckets carried and the rush on,
    off and on, 15 runs a side: `mixed-8` damage 15.1 to 4.1, lowest median 6.5 to 18.4, 10th percentile 1 to 11;
    `seal-5` 16.2 to 4.5, 1.2 to 17.9, 1 to 11.9; `witch-2` 23.2 to 3.0, 1 to 17, 1 to 17; no run under 6 with it, one
    bucket a run at most, no death either side. The drink waits for the witch because she is taken to throw poison at
    a target that is not poisoned (the game's rule as known; not measured here, nor the drink with her alive). It ships
    on: without milk it does nothing, and the live bot carries none. The bot does not get milk by itself; whether it
    carries some is the owner's choice (pve.md "What the bot should carry").
56. **Not taken.** Eating for regeneration (at food 20 about 1 health every 80 ticks against the poison's 1 every 25);
    the potion side step in her fight (decision 19 stands); a golden apple (kept for under 6 health; not measured
    against the poison); a guard that breaks off another fight for a witch.
57. **The early kits are unchanged.** The rush needs a diamond or netherite sword and the cure needs milk, so neither
    acts for the `none`, `stone` and `iron` kits. Track M6's seven rows were run again on the final code, 10 runs a side
    (2026-11-17): 0 deaths in 140 (Track M6's on side: 0 in 70).

## Addendum: Track M9 (2026-11-17)

The numbers are in [../pve.md](../pve.md) "Track M9: losing a following archer". The no-kit `pillager-1` and
`skeleton-4` cells were run for 4 minutes a run, and each rule A/B'd from rest by night, 120 s a run, on bds-pve and
bds-gaunt.

58. **The long case is the pillager's.** With no blade, 4 minutes a run, 10 runs a cell: `pillager-1` 9 deaths (66 to
    137 s), `skeleton-4` none. The pillager walks at about a sprint (0.35, 0.265 blocks a tick measured), follows a
    flight for its whole minute and about 250 blocks, and lands its bolts where the flight turns or re-plans; at the
    minute's end guard took the body for a fist chase (a bolt from 2 to 6 blocks), and the second flight died. Skeletons
    (0.25) drop back and are reported gone (not a despawn: by night they do not, Track M10); the bot stands 55 to 100 out and gets home in 2 of 10.
59. **`followRun`: with no blade, a `far` leg from an archer within 24 runs 32 past it, no `home` leg while it is
    within 24, and a flight that gives up with it within 24 (seen or not) has no cooldown.** A leg long and straight
    enough is sprinted whole (67 % of the far leg's ticks against 34 %; the bolts on it 91 to 46 in 16 runs). As first
    built the home leg was still taken (34 legs in 17 runs, the pillager a median 13 behind, each turned back after about
    15 ticks) and the restart looked for the archer in sight within 16 (often 16 to 18 behind at the minute's end, so
    guard took the body); both found from a `pve-m9` failure and fixed. The fixed rule, 10 a side: `pillager-1` 6
    deaths to 0, damage 28.2 to 9.7, lowest median 0 to 13.5; `skeleton-4` 0 and 0, 6.7 to 1.9, 16 to 20 (first built:
    7 of 16 to 0, 27.7 to 12.4; skeletons 5.4 to 4.4). **It ships on**: a choice of the leg, its length and the cooldown,
    nothing placed or dug, no new movement, and a bot with a blade (the live kit) is untouched. The bot stays out while
    the archer follows (home in 0 of 20 `on` runs).
60. **`sprintJump`: on such a leg, with the food over 10, the path follower jumps while it sprints on straight level
    runs.** `pillager-1` with `followRun` on, 15 a side: damage 13.7 to 2.7, lowest median 11 to 17, the bolts on the far
    leg 47 to 3; `skeleton-4`: 8.5 to 4.0; the food at the end 16 to 13. **It ships off**: a new way of moving the body,
    measured on flat cells only (decision 27's rule for anything that can kill the bot). A nav option
    (`GotoOptions.sprintJump`), so other callers can take it up once it has run on real ground.
61. **`craftBlade`: no blade, a lone archer in sight, health 14 or over and a sword's materials: craft the best sword
    where the body stands, then fight.** The sword was in hand 1.7 to 1.9 s after the start in 15 of 15 runs and the
    pillager dead at a median 5.4 s: damage 13.8 to 5.3, lowest median 10 to 13; a lone skeleton 5.8 to 3.5. With four
    skeletons it lost (the craft under four bows, then a fight with no armour), so it waits for a lone archer. The table
    it places is left standing (digging it by hand took about 4.5 s under fire) and is picked up by the next craft near
    it. **It ships off**: it places a block and stands still in an archer's line for 2 s.
62. **Not taken: cover, gates closed behind, the seal-in at the minute's end.** Cover behind walls killed 4 of 4 (the
    pillager walks round a wall within the 3 s it keeps a target out of sight); the walk's gate close never ran under the
    flight's re-plans (the gate open at every sample, 4 of 4); the dig-in at the minute's end took 4 to 6 s under fire and
    lost 4 of 10 against 0. All three were removed; the gauntlet keeps the terrains (`MOBS_TERRAIN=trees|walls|doors`).
63. **Tracks M4 and M5 measured again from rest.** Every A/B row of the two with a death on either side, 10 a side, the
    later rules off on both sides: Track M4's rules 59 of 80 deaths to 22 (first 63 to 18), Track M5's 15 of 70 to 4
    (first 20 to 11); Track M5's no-kit `pillager-1` row goes 7 to 3 where it first went 7 to 10. Decisions 32 to 44 stand
    as made; the tables in docs/pve.md are corrected in place, the first numbers kept under them.

## Addendum: Track M10 (2026-11-17)

The numbers are in [../pve.md](../pve.md) "Track M10: after the flight". The long case ran again with `followRun` on,
each new rule was A/B'd from rest by night, and Track M6's A/B rows with deaths ran again, on bds-pve and bds-gaunt.

64. **With `followRun` the long case lives; nothing ends the pillager's chase.** No kit, 4 minutes a run, 10 runs a
    cell: `pillager-1` 0 deaths (Track M9: 9), 21.8 damage a run, the bot about 1 100 blocks out at the end and never
    home; `skeleton-4` 0 deaths, 1.9. The pillager keeps 12 to 14 behind for the whole run in 8 of 10; it is made
    persistent when it takes its target, does not burn, and at noon (3 runs) still followed, one run dying at 170 s.
    With no food every run (5 of 5) died 11 to 57 s after the food reached 6 and the sprint ended. Skeletons are not
    despawned by night either (decision 58's "despawn" corrected): the server reports them gone, cause not found.
65. **The skeleton row's flips are `followRun`'s edge.** 117 of 120 `home -> far` flips came with a skeleton 22 to 24
    off: the home leg starts the tick none is within 24, walks back towards the skeleton that stands between, and is
    blocked again at 24 within a median 0.5 s. Nothing walked the bot home after a flight that gave up.
66. **`backHome`: with no blade, a flight that starts within 48 of home is followed by a walk home once nothing runs and
    the way is clear**: no melee mob within 24, no archer or witch within 16 of the bot, of home or of the way (the
    remembered ones too); in the flight no home leg past an archer or a witch on the way at any health. `skeleton-4`, 10
    a side, 240 s: home 1 of 10 to 8 of 10 (a median 125 s into the run, 10 s after the walk started, no damage on the
    walks), `home -> far` flips 160 to 8, damage 2.6 to 1.2, lowest median 16.5 to 20, deaths 0 and 0. `pillager-1`: 0
    and 0 deaths, damage 22.8 and 23.3; the walk comes only once the pillager drops back (1 of 10 runs: 275 blocks home
    in 52 s, no damage; the `off` side's such run stood 346 out). **It ships on**: the walk is the existing home return
    with the existing nav, it starts only with nothing near, any hostile pre-empts it, and a bot with a blade (the live
    kit) is untouched. As first built the walk never came after a flight from the home point (the at-home check disarmed
    it on the flight's first tick); fixed and guarded by a unit test. A variant that also ended the flight once no
    archer was within 24 made the skeletons follow the bot out (2 runs, 449 and 572 blocks out, 26 and 34 flights): not
    taken.
67. **`followHome`: while an archer follows, a home leg when home is ahead of every archer, closing the doors behind.**
    From 24 out, `pillager-1`, 120 s: in a room with a gate a side, 6 a side, home 0 to 6 of 6 (8 to 9 s), damage 11.3
    to 5.8, lowest median 11 to 18, the gate shut behind the bot within 5 s in 7 of 8 runs with the rule (in the eighth
    it stayed open and the pillager came in: 27 damage, out again); on flat ground 4 a side: home 1 to 4 of 4 but damage
    3.8 to 18.8, lowest median 16.5 to 8.5 (home is where the pillager catches up). **It ships off**: it helps only
    behind a door the walk does close, which the bot cannot know of a home, and the close is dropped by a re-plan
    (decision 62).
68. **Track M6 measured again from rest.** No kit, 10 a side, the later rules off on both sides: `pillager-1` 4 deaths
    to 0 (first 8 to 0), damage 25.7 to 12.7; `skeleton-4` 1 to 0 (first 1 to 0), 22.6 to 3.7. Decisions 45 to 49 stand;
    the rows in docs/pve.md are corrected in place, the first numbers kept under them.
69. **`followRun` shuts the home leg while an archer is within 24 of the way home**, not only of the bot
    (`archerNearWay`). An archer just past 24 towards home let the leg start and walk back within 24 of it (the long
    case's flips; on bds-pve 14 samples of a home leg with the pillager within 24 in a `pve-m9` run). `pve-m9` five runs
    one at a time: 5 of 5 on the code before this track, 5 of 5 with it; the pillager never dropped back in them, so the
    check acted in unit tests only, and the gauntlet rows were not run again with it.
