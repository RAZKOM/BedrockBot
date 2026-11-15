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
