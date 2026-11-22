# 0126: A fire escape that reaches its cell, a witch held for the work, a body dug out of a block (Track M11)

Date: 2026-11-22. Status: accepted. No new setting: three existing rules change for everyone. Details and numbers:
[../survival.md](../survival.md) "The fire escape (Track M11)", [../pve.md](../pve.md) "A witch fought for the work
and not dead (Track M11)", [../pathfinding.md](../pathfinding.md) "The body inside a block (Track M11)".

## Context

- **The fire escape.** Track N2 (survival.md "The Nether for experience (Track N2)") watched the iron-kit bot die
  twice standing in fire on a netherrack ledge: `FireProcess` walked to the nearest cell clear of fire (`fireEscape`)
  and did not look at the walk's result, so every burn picked the same cell, two blocks down, 3 and 5 times in a
  row. Rebuilt on a test server (test/e2e/pve-fire.test.ts) with the bot's own rules and the live kit, the ledge was a
  death in 10 of 10, and so were most overworld fires: a fire spread over a wooden floor 8 of 10, lava's fire beside
  a pool 9 of 10. The cause in all three: the fire stood in the bot's own cell and the cells round it, the navigator
  never enters a fire cell, so the walk had no node to start from (`no standable node`, three failures, about 2 s)
  and the next burn chose the same cell again while the body stood in the fire (about 2 health a second).
- **The witch at the work.** On the Realm (2026-11-22, the live kit, guard off, `workGuard` on) the fight on a witch 8
  off ended after 3 s with her alive, she was ignored 30 s, the job walked off exploring and she followed it,
  throwing; 13 damage. The scene had filled iron ore into the cell the bot stood in: no walk had a start node until
  the server pushed the body out (about 12 s), the fight's approach failed `unreachable` at once (`approachTries` 1),
  `targeting.afterFight` ignored her for `PATH_IGNORE_MS` 30 s, and with every ore of the patch unreachable the job
  explored. Rebuilt on a test server (early-mine.test.ts `witchlive`) the server never freed the body: a death in 10
  of 10 (24 damage each, the witch's potions).

## Decision

1. **The fire escape tries every way out, nearest first, and does the next best when none is walked to**
   (`FireProcess.escape`, skills/survival/fire.ts). Each step: a strike puts out the fire in the body's own cell
   (measured: start_break on a fire block leaves air at once, 1 tick; striking the floor's top face breaks the floor
   instead); fire resistance on ends it; a clear cell ends it. Else the ways out (`fireOuts`: cells clear of fire as
   before, and water and powder snow, ranked 2 nearer) are asked of the planner before a walk (a short search on the
   cached grid) and walked to nearest first; a walk that fails drops its cell and the next goes at once. In lava a
   block deep (no node there either): a swim and climb out by hand with the jump key held (`climbWalk`). With none
   planned: the fire on the straight line to the nearest way out the body can walk straight to (`straightWalk`: floor
   and room every quarter block) is put out, or without one the fire round the body; then a straight walk by hand
   through the fire; then a fire resistance potion if one is carried; then a pillar of one block. At most 16 steps
   and 20 s; when nothing worked, a second before the next try. Out of the fire, still burning at health 10 or less,
   it drinks a fire resistance potion when one is carried. Not chosen: a water bucket (the Nether, and the bot carries
   none on purpose); a new setting (the old rule killed the bot in every case built; the new one acts only where the
   old one did, and its strikes break only fire blocks).
2. **A witch fought for the work and not killed is held** (`PveController.workWitch`, `heldWorkWitch`, the guard
   process's hold). The fight's end without her death starts a hold: she is not ignored for the fight's 30 s, she is
   fought again `WORK_WITCH_REFIGHT_MS` (1 s) after a fight on her ended, and between fights guard holds the work
   still (the job does not walk off). The hold ends at her death, at `WORK_WITCH_HOLD_RANGE` 16 with her not aiming
   at the bot, after `WORK_WITCH_HOLD_MS` 60 s from the first fight, after `WORK_WITCH_UNREACHABLE_MAX` 2 fights in a
   row that ended `unreachable` (a witch no fight reaches: standing still in her throw range is worse than the work
   going on; the fight's 30 s ignore then applies), or with no job at work; `firstTarget`'s health rule and the flee
   decide as before.
3. **A body inside a block is dug out** (`Navigator.digInside`): no start node because a block's box is where the
   body is (its feet cell above the floor it stands on, or its head cell): with the dig way on (the default) or a goto
   that digs anyway, that block is dug under the dig way's rules (natural terrain unless the goto digs anyway, the
   break rules: no liquid beside, no gravity block over, not in the protected area), at most 2 a goto, no failure
   counted meanwhile. This frees the body for every walk: the job's, the fight's approach, the fire's.

## Consequences

- Fire, n10 a case, the live kit (before -> after): the ledge 10 deaths -> 0 (8 damage each: the 8 s the flames burn
  on after the fire is out), out of the fire at once; the wood floor 8 -> 0 (8 to 11 damage, the lowest 11); lava's
  fire 9 -> 0 (8 to 15, the lowest 7).
- The witch, n10 (the Realm's scene, the live kit): 10 deaths (24 damage each) -> 0 (no damage; the body dug out of
  the ore at once, she died to the reflex 2.9 to 3.9 s after she came). The hold did not act there (every fight
  killed her): it is proven by unit tests only.
- A fire on the way is struck out (fire blocks only); a hand walk may step through fire the planner would not; a body
  inside natural terrain digs it out (a block the server would have pushed it out of in time, or never).
- The last resorts in a closed 1 x 1 lava pit (n3 an arm): the potion saved the bot 3 of 3 (4 damage); the pillar
  never rose in lava, 3 deaths of 3. Digging out through a wall is not built.
- Not proven: the hand walk through fire and a climb out of lava 2 deep on a server (unit tests only); the hold on a
  server; the Realm; soul fire; a ghast's fire in a real Nether stay; a body inside a block with lava beside it.
