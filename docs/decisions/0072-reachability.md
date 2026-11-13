# 0072: Reachability (`!goto` says unreachable only when it is, and why)

Date: 2026-11-07. Status: accepted (Track R1; builds on [0070](0070-water-travel.md) (water, the dig-out, W3's dig
way and levels) and [0066](0066-coarse-layer.md) (the coarse corridor a long goto follows)). Guide:
[../pathfinding.md](../pathfinding.md) "Reachability (Track R1)".

## Context

The owner's requirement: a `!goto` must never say "unreachable" unless it truly is. Walking, swimming and digging are
the guarantee (flight is the flight track's). Before this track nobody knew how often the navigator gave up on a goal
it could reach: the tests were hand-built stations, each passing, and the Realm reports were single cases. The reply
said `goto: unreachable` with no reason, so the owner could not tell a closed world from a rule from a bug.

## Decisions

1. **An oracle, apart from the planner** (`nav/bench/oracle.ts`). An exhaustive search over the navigator's move set
   at the cell level, written on the bench's own voxel palette (not the terrain classes, nav/grid.ts or
   baritone/*), so a planner bug cannot hide itself. It knows the owner's rules and lifts them one at a time, which
   tells a closed world (a) from a closing rule (b) and names the rule. Checked against the planner given 3 M nodes on
   hand cases and random pairs (unit test nav-reach-oracle).
2. **A bench of the REAL navigator, closed loop, offline** (`scripts/reach-bench.ts`, `test/unit/skills/reach-sim.ts`):
   seeded worlds of nine classes, chunks fed round the body, the worker with the live budgets scaled to the owner's M4
   (1.25 x this PC), the coarse layer, the session's dig way, protection, avoidance and falls. The headline number is
   the false unreachables. Alternatives rejected: e2e only (a few stations a run, minutes each: never thousands of
   pairs); the planner alone without the loop (the failures were in the loop: budgets, levels, waypoints, the
   follower).
3. **Four cause classes in the reply** (`nav/reach.ts`, `GotoOptions.explain`, `SkillResult.cause`): `world`,
   `rule:<rule>`, `unloaded`, `budget`. Found by "why" searches when a goto is about to give up: the goal sealed in
   bedrock (a flood, no search), one search with every rule lifted, then the rules its path broke, each alone. They
   ask whether a way exists (weighted heuristic, digs priced by their time only), never for a plan to walk. At most 5
   a goto. Only `!goto` asks (`explain`); every other caller ends as before. Alternatives rejected: one search per
   rule always (7 searches of 2 s before every reply), a penalty search with every relaxation priced (one search, but
   its path mixes rules where one would do, and the planner's moves would all need rule tags).
4. **A search cut by its budget is no answer.** A no-progress result from a limited search is asked again once per
   node, level and waypoint with 4 x the budget; it never escalates on the stand-in's cut search, records the no-retry
   only after the bigger search (a retry of the same budget is a repeat), and never says "trapped". (The levels' fall searches ran at 25-35 nodes/ms under load: ravines and pits
   gave up at level 2.)
5. **The planner never plans on a cell its own path digs** (`dugOnTheWay`), and **the goal's floor is never dug**.
   Both were real plans: a 1-wide stair whose next step stood on the block the step before had dug, a tower climbed
   by digging its own top.
6. **The dig way's budget counts the digs still ahead** on the walked path when a plan-ahead is searched from its end
   (14 of 12 were dug that way). W3's other protections stay: natural terrain only, 200 ticks a block, no fall that
   hurts while a harmless way exists.
7. **A corridor waypoint with no progress is the corridor's failure at once**, whatever unloaded world the search
   touched (unless the waypoint's own cell is unloaded): the raw goal is planned next, with its levels. **Partial
   plans that lead back are no progress either**: a plan-ahead segment ending on a cell the path already went through
   is refused, and a partial main plan ending where an earlier partial plan of the goto began (the same level, any
   waypoint) escalates as a no-progress search does; when the plan touched unloaded world it first waits for the
   chunks, at most `unloadedWaitTicks` a goto, never reset (a wait reset by the plans in between kept a far goal
   waiting until the goto's cap; not waiting at all failed a strip whose chunks came late). The escalation is what
   brings the dig way to goals far in unloaded world that the walk alone does not reach (counting new sections as new
   ground instead left them walking between the two ends until the cap). Two partial ends that
   are each other's best end of a closed search held the body between them until the goto's cap. **`OFF_PATH_LOOP` 6
   partial off-path re-plans from one cell** (one level) are no progress the same way: a dead end whose plan-ahead
   led back along the path, the skip-ahead onto the copy coming back, the off-path check sending the body back to the
   same cell, and the same plans again (240 plans until the cap). Rejected: splicing such a segment in at the cell it
   comes back over (the dead end dropped). It fixed that pair, but goals far in unloaded world that had arrived by way
   of the loop check's escalation to the dig way no longer did (the splice kept handing them new partial ends).
8. **The follower centres on a node beside a hazard** (0.15, not 0.35) and aims no farther than it: a corner cut over
   a lava cell killed the bot in the bench. At a turn beside lava it brakes into the node, leaves it only below
   0.05 blocks a tick, and takes no step while facing more than 10 degrees off its aim. The momentum out of a
   diagonal, and the arc of a turn, carried the body 0.3 into the lava cell beside it. No forward press when the
   body's coast from its velocity would put its box in lava; a drop into a cell beside lava creeps off the edge at
   0.05 blocks a tick (the fall's coast carried the body past the landing's centre), and a leg's end brake waits
   until the body is off the ledge (the slow creep stopped within `arrive` of the landing, on the ledge). When the straight line from
   the body to its aim would sweep the body's box through lava (a leg begun at a node the body is not centred on,
   the corner cut across a lava cell diagonal to the turn), it first goes back to that node's centre. A dive under a
   block two over the target's feet cell (a flooded tunnel two high) is sunk to within 0.19 of the node first and
   never bobbed up into the roof. (The bench's
   lava and water now flow as the server's do: lava cells next to open air and water over air pockets were
   artefacts of the generator.)
9. **The frontier end for a goal in unloaded world**, at a goto's last level only: with no partial end worth walking,
   the node touching unloaded world with the lowest g + h ends the partial path (at most 6 such legs a goto). Not
   for a goal in the loaded world: there it would walk off into the unknown for a goal sealed nearby.
10. **The "why" searches follow the same rules as the plans** (the bench's first full run: 5 of 80 causes wrong).
    A search with every rule lifted that runs out of budget is asked once more with 4 x the budget before the answer
    is `budget`. When the goal is in unloaded world but the goto's last search was exhaustive (the owner's rules
    close the loaded world round the body) or its partial plans looped, the answer is not (c): the searches ask for a way to the unloaded world,
    taking the frontier ahead of the bests. A goal cell that is open but has nothing under it is `rule:place`, unless
    it is sealed. A natural block in the goal cell does not count as "nobody stands there": the dig way's level digs
    it out. A goal under water with no air straight over it (a flooded cave's roof) is `world` at once: no plan ends
    at a dive goal without its way up, whatever rule is lifted (the oracle has the same rule). A way found with every rule lifted whose path breaks none of the owner's rules is `budget`, never the
    nearest rule: the goto's own walk or searches stopped short of a way that is open (a rule was named for a goto
    that had got stuck).
11. **The corridor executor's hand-off lands where a body stands** (minimal edits, the flight track owns the rest):
    a partial corridor's last leg lands towards the trip's goal, never a walk to a cell in the air; under a wide y
    opening the change cell is the dry floor nearest the way on, not the centre column's (the rim over a pit); a
    walk leg ends on the standable cell nearest its portal's cell (flyC handed over a stone cell). When a landed
    window's next proof is partial with no shorter window, the unproven walk goes to the window's landing first,
    not to the stretch's end (a walk of the whole stretch from the takeoff).
12. **Limits kept, not fixed here**: a goal in the loaded world whose only way runs through unloaded world gets no
    frontier end (decision 9), so it is answered with the rule or `unloaded` the loaded world shows; the dig budget
    is per goto, so a walk that spent digs on a way the rest of the world later closes can end `rule:dig_budget`
    where an all-knowing walk would have kept them (the bench's 'long' class); a long walk past a maze of cliffs can
    still time out.

## Consequences

- The bench numbers (docs/pathfinding.md "Reachability (Track R1)", "Measured") are the gate for later navigator work:
  a change that adds false unreachables shows there before the Realm does.
- An unreachable `!goto` takes a few seconds longer: the "why" searches run before the reply.
- The 'unknown' class has no coarse layer: a goal past a maze of cliffs can still time out (no memory of where the
  body has been). The live session has the world cache and the coarse layer, which the bench's 'long' class runs.

## R2: the owner's live settings

Track R2 ran the navigator with the Realm's settings (`allowBreak` and `allowPlace` on, `digPenalty` 500, sprint; from
2026-11-09 `allowPlace` off) and two live incidents as private fixtures, a third from its log (docs/pathfinding.md
"R2: the owner's live settings").

13. **Water over a passable cell is water.** The world model reads no water layer, so a waterlogged block is a free
    cell in a lake; `submerged` counts the head in it under water when water stands over it. A plan whose start has
    the head under water ends with the head out: the start is no best, and any such node counts however near
    (Baritone's 5-block minimum is for dry starts, where a near end is no progress; under water a near end is air).
    No partial plan ends with the head under water on a walking node or on its own pillar's top.
14. **A pillar has to lead somewhere.** A pillar move is tried only when something other than air stands within 8
    levels (`PILLAR_REACH`) over the feet in the 3 x 3 columns round it, or the goal is over it. Pillars over open
    ground spent two thirds of a search's expansions and starved the rest of the plan; a ledge higher than 8 over
    open ground is not pillared to (a goal there is). The column tops it reads count every held section: a block
    update that builds into a section over the ones the chunk was sent with is part of the column.
15. **The corridor never aims into the air.** A vertical opening the coarse layer gives no floor (mine mode: "dug or
    pillared") is passed over to the first waypoint on a floor, and no corridor re-request or re-plan onto a new
    corridor starts while the body is between its path's pillar moves: the incident's pillar was the fine planner
    climbing to a waypoint in the air, then the corridor changing under it.
16. **A refused fall is named.** `rule falls` says the fall it refused and why (`a 20-block fall (16 HP) over the fall
    budget of 12 HP`, or that no fall that hurts is taken now, and the reason). With `allowBreak` the "why" answer does
    not count the dig way's budget.
17. **A high dig price is a preference, not a wall.** A goto that digs anyway (`allowBreak`) at a price above
    DIG_WAY_PRICE (60, the setting's default) gets a level 1: the same moves at 60 a block, no block budget. At 500 a
    block the searches never reach a dug way of a few blocks (the cost of a thousand blocks of walking) and the live
    settings answered `budget` on 5 % of the reachable bench pairs (caves and pits). The dig way of a goto that does
    not dig anyway prices its blocks at DIG_WAY_PRICE at most too (then its own DIG_WAY_PENALTY on top): at 500 + 100
    a block it went nowhere either (`dig_budget` on 22 of 553 pairs with `allowBreak` off and `digPenalty` 500).
18. **An open way is walked.** When the "why" search with every rule lifted finds a way that breaks none of the
    owner's rules, the goto does not answer `budget`: it plans on with the heuristic weighted (3 x) and the dig way's
    price, and walks the found way itself when that goes nowhere; twice a goto at most (the failures one short of the
    limit each time), then the answer as before. A stuck walk (three move timeouts) and a cut search both end here.
    The found way is walked only from where the body stands (from the node nearest it, within a step): the weighted
    plans move the body, and a way from where it stood was "off the path" at once. A goto that digs anyway, whose
    searches were cut, also plans on weighted once when the "why" way breaks a rule, before that rule is the answer:
    with `allowPlace` off the way out of a ravine is a stair dug up its wall, which the plain searches did not reach
    and the "why" search (every rule lifted) answered with a pillar, `rule place` (ravine:11:11 and 11:12, both
    arrived weighted, 69 and 70 blocks dug).
19. **The bench measures the live settings too** (`reach-bench --config live`, `allowPlace` off as on the Realm since
    2026-11-09, and `--place`, `--break`, `--dig-penalty` alone), with a stranded check on every end, and fixtures cut from the bot's world cache
    (`nav/bench/fixture.ts`) kept out of the repository. The bench's `--speed` default stays 1.25 (Track R1's M4
    calibration for a PC); R2's numbers are measured on the owner's Mac at `--speed 1`, the live wall-clock budgets on
    the live machine (through `scripts/mac-run.mjs`). During the incidents the live bot ran on the Mac's efficiency
    cores (launchd `ProcessType Background`) and its searches expanded about 0.35 of the bench's; the fixtures were
    gated at that speed on a PC too.
20. **No more blocks placed than carried.** A path places at most the throwaway blocks the goto carries
    (`PathOptions.throwaway`, counted per node like the dug blocks); before, any count above 0 allowed every pillar,
    and a `!goto home` from a cave on the Realm (2026-11-09) pillared on one block of diorite: `place failed: no_item`.
21. **A waypoint the fine planner cannot reach is failed in every mode.** Its portal is marked failed for each mode the
    goto's corridors plan in (`walk`, and `mine` with `allowBreak`), not the leg's alone: the same goto saw the same
    waypoint unreachable three times, the corridor crossing the portal again in the other mode.
22. **A jump up beside lava lands without sliding.** Forward is released in the air once the feet are over the step
    when the coast would carry the body past the node's centre (lava:1:6 with `allowPlace` off: a dug tunnel under a
    lava pool climbs out by a lava cell; the landing slid 0.26 past the centre into it, dead). Track R1's rules for
    lava covered walks, turns and drops, not jumps.
23. **Settings recommended, not set here**: keep the live settings of 2026-11-09, `allowBreak` on, `allowPlace` off,
    `digPenalty` 500 (measured on the owner's Mac at the live wall-clock budgets, docs/pathfinding.md "Which settings
    to run live"). On the 2194 bench pairs they give 6 false unreachable (0.27 %), no death, no stranded end, damage
    8 HP at most (where the only way is that fall), and the incident fixtures arrive 6 of 6 each. `allowPlace` on is
    safe again after decisions 14, 15 and 20 (the pillar incidents) and measures a little better on worlds 1 to 5 (1
    false against 2, no fall damage, a quarter of the digging), at the price of the blocks it leaves in the world (5 a
    goto at p90, 28 at most): the owner's choice of what the bot leaves behind, not a safety question any more.
    `allowBreak` off is not recommended (fewer goals reachable, 441 or 509 of 553 against 533, the falls take up to
    12 HP, the walks are slower), nor a `digPenalty` of 60 (4 false of 553: the level 1 already digs at 60 a goto that
    needs it, and 500 keeps the plain plans walking where a walk exists). Long walks (200 to 330 blocks) are the weak
    part with `allowBreak` on: 60 of 95 arrive (35 false, against 3 of 35 reachable in R1's configuration), no death,
    no stranded end; the 35 are ways that dig 36 to 57 blocks and take a fall at the budget's edge. They fail safe (an
    answer, the body where a walk can go on), so they do not argue against `allowBreak`, but they are the next work.

Deferred: a stranded fallback (ways down when every way off a raised end hurts: dig the own pillar, dig a stair); no
stranded end was measured with the fixes, so it is left until one is.

## R3: long dig ways

Track R3 took on R2's weak part: at the live settings (`allowBreak` on, `allowPlace` off, `digPenalty` 500) 35 of
the bench's 95 long trips (200 to 330 blocks along the coarse corridor) answered unreachable where the oracle's way
digs 36 to 57 blocks (docs/pathfinding.md "Long dig ways (Track R3)").

24. **A dug way of tens of blocks gets its own search.** When a goto that digs anyway (`allowBreak`) has a main plan
    and its BIG_SEARCH retry both cut by the budget with no progress, it runs the long dig search once for that
    node, level and corridor waypoint, before the corridor fails, the level goes up or a failure counts: the same
    moves, rules and falls as the level, the heuristic weighted (LONG_DIG_WEIGHT 8) and every dug block priced at
    its physical time (LONG_DIG_PRICE 12, the planner's own default dig cost: stopping, aiming, the break cooldown;
    never above the goto's own price). The cause was the search, not a rule: the heuristic prices a block at a
    walk's 3.6 ticks, so a way that digs pays its dig price in full before the search looks past it, and a ravine's
    two walls (a stair down and up, 77 blocks) cost the search 648 000 nodes at the dig way's 60 a block where the
    live 2 s buy about 130 000 on the Mac. Weighted and at 12 a block the same crossing is found in 31 000 nodes
    (240 ms), 7 blocks more dug (84 against 77). The alternatives measured on that crossing: the weight alone (60 a
    block, 16 x: 103 000 nodes; 32 x: 22 000 nodes but 89 blocks), the price alone (12 a block, unweighted: 503 000),
    the price at 0 (16 000 nodes, 96 blocks: every free dig is taken); 12 and 8 together are the knee. Only the plan
    that went nowhere is searched this way; the plans ahead of it and every plan after it are the level's, so a walk
    that exists is still walked at the owner's price, and the dug way is the one the goto could not do without.
    With it 94 of the 95 long pairs arrive (R2: 60); without it the 12 long pairs tried again answered unreachable
    12 of 12. Three bounds, each from a bench pair it
    hurt: its interim answer (the best partial path after 40 ms) is not walked, and a partial answer only towards a
    corridor waypoint, whose next window re-aims it (towards the goal itself, weighted and digging cheaply, its
    partial ends dig into the way: on pits:12:10 into a 2 x 2 tower whose only way up is a stair cut inside it, and
    from the holes no stair was left; the planner's nodes do not remember what the way there dug, so a greedy search
    closes a node it reached the wrong way; with no partial answer at all, on a loaded Mac whose 2 s bought 58 000
    nodes, 5 long pairs failed their waypoints); and it is not run towards a goal in unloaded world (that search went nowhere for the unknown, not
    for a dug way; it tunnelled 54 and 132 blocks on two unknown pairs a walk reaches, and caves:10:6 ran to the cap
    after digging 278).
25. **A goto's own digs are not news to its corridor.** A block the goto's own action changed no longer marks its
    corridor dirty (the coarse layer's change report is dropped for a chunk column the goto changed in the last 2
    ticks), and the walk is not re-planned onto a new corridor while the path ahead still has blocks to dig (as for
    a pillar, decision 15). On the long walks that dug, every dug block re-planned the corridor, and the new plan
    from the half-dug stair aimed elsewhere: the 37 long pairs that dug and arrived in R2 too dug 195 blocks at p90
    then, 105 now, in 26 s at p50 against 61.
26. **A re-plan after answers that do not meet their interim waits for its own final answer.** From the second found
    final answer in a row that does not meet the interim path the body walks (a final that meets one, spliced in,
    starts the count again), the re-plan from where the body stands walks no interim answer (the best partial path
    after 40 ms) and waits for its final; the bench paces its ticks while it waits. lava:20:5 timed out this way in
    R2: the interim plans led west round a hill, the final plans east, and the two took turns 30 times until the cap;
    it arrives now. The first miss re-plans as before (interim walked, the final spliced in), so a goto whose first
    guess was wrong loses nothing.
27. **A walk that stuck is no rule's answer yet.** A goto that digs anyway whose last failure was the walk itself (a
    move timeout, stuck) plans on weighted once before a rule the "why" way breaks is the answer, as one whose
    searches were cut does (decision 18): its plans were ways under the owner's rules, so the rule the "why" search
    (every rule lifted) happens to break blocks nothing. lava:1:10 failed this way 1 run in 3 (three drops on a dug
    way timed out, the "why" way digs beside lava, `rule liquid`; the oracle's way breaks no rule).
28. **Limits kept.** A stair dug down from open ground is planned only towards a goal below the node (the planner's
    `digDescend` rule, Track BC): a ravine crossed towards a waypoint at or above the rim is found only when the
    corridor puts a waypoint lower, as it did on every long pair (19 of the 35 with the goal above the start). A long
    dig way digs more than the oracle's (p90 2.25 x; the oracle digs at no extra cost): the owner sees it in the dug
    counts, and it never digs where the level's plan walks. The bench of 2194 pairs at the
    live settings: 5 false unreachable (0.23 %; R2 6), no death, no stranded end, causes 70 of 71; the long dig
    search costs an honest unreachable answer about 6 s (47 s at p50 against 41). A death older than R3 is open:
    lava:7:10 dies at `--speed 0.4` with R2's navigator as with R3's, a turn by lava at the joint of two plan-aheads.

## R4: a fall closed for a moment

Track R4 (2026-11-12, docs/pathfinding.md "A fall closed for a moment (Track R4)"). On the Realm a goto set off over a
5.2-block drop (0.4 HP with the bot's armour), a hostile came within 16 blocks 1.2 s later, the step-off check refused
the drop, and the goto ended `unreachable (rule falls ...)` at 19.7 health, a few blocks from its goal. The owner's rule:
"unreachable" only when the way is completely blocked, and the bot never dies to mobs.

29. **Why "no fall that hurts while a hostile is near" exists.** It came with the long falls (decision 0049, Track BI,
    2026-10-30) with no measurement of its own: no e2e, the unit test checks its words. It keeps the falls that matter
    away from a fight: a planned fall may leave just `fallMargin` (8), which is `fleeHealth` (8), and one hit from an
    enderman (7) or an armed zombie (5.2 through iron) then puts the bot under the flee line beside the mob; in a fight
    the FallGuard clutches only a fall that would kill, so a fall planned as a clutch lands at full damage; Track M2's
    dodge on real ground took falls of 5 to 13 HP in 7 of 12 runs beside skeletons. The rule stays as it is by default.
30. **A goto holds for a fall closed by something that passes.** The fall policy says when its block passes by itself
    within seconds (a hostile within 16, burning, the health not sent yet) and what the budget is then
    (`FallPolicy.afterBlock`). A goto with `explain` whose answer is `rule falls` alone, its fall closed only by such a
    block and within the budget after it, holds where it stands, reads the policy every 5 ticks and plans again once
    the block has been gone 20 ticks (a hostile on the 16-block line does not flap it), at the level that takes the
    fall; at most `FALL_HOLD_TICKS` 600 (30 s) a goto in all, then the answer it would have given with what it waited
    for (`; held 30 s for a hostile 13 blocks away`). A block that turns into one that does not pass (the health under
    what the fall needs) ends the hold at once. It is on by default: it puts a wait before the same rules and takes no
    fall they did not allow before. The reflex (on live) strikes what comes within reach meanwhile.
31. **A landing refused lately is a moment's too.** The step-off check keeps a refused landing out of the plans for 200
    ticks (decision 0049, review L1). The "why" search with the fall rule lifted kept that refusal and could answer
    `world`; it lifts it now, and `rulesOnPath` / `fallOnPath` name such a fall (`its landing refused at the step-off
    lately`), which holds until it ages out. A landing refused only because of a block that passes comes back into the
    plans when the block passes, not 200 ticks on.
32. **The fall rule is asked first while such a block is on.** The "why" search with every rule lifted digs for nothing
    and pays a fall in HP, so off a tower of planks it digs through the planks and answered `rule built`; with a
    passing block on the fall policy and the fall rule not on its path, the fall rule alone is searched first.
33. **`hostileFallHp` (setting, 0: off).** With a hostile within 16 the budget is min(`hostileFallHp`, health + absorption
    - `fallMargin` - `HOSTILE_FALL_RESERVE` 7) instead of 0, never a clutch: one more hit of the hardest measured melee
    (an enderman, 7) after the landing still leaves the flee line, so at 15 health or less (the defaults) it is closed
    as before. 2 is the value to try (a heart: a 5-block fall unarmoured, about 13 blocks at the armour cap). It changes
    a rule that keeps the bot alive, so it ships off until it has run on the Realm.
34. **Measured.** The real navigator in the bench's closed loop (`nav-r4.test.ts`), a tower of planks 5 high, the goal 10
    blocks from its edge, a zombie 12 blocks off for 40 to 300 ticks from tick 0 to 25: 10 of 10 arrived with the fall
    (2 HP) their only damage, 9 held (the tenth stepped off first), 6 of them refused at the edge as on the Realm;
    before R4 the same pairs ended unreachable at full health in 8 and 23 ticks; a zombie that stays: held 30 s, then
    the old answer with the wait in it. On bds-pve with a real zombie (`nav-hostile-fall.test.ts`, 10 runs a case): before
    R4 10 of 10 unreachable at once; the zombie gone 2 to 10 s into the walk, 10 of 10 arrived in 7.1 to 15.1 s with
    the fall (2 HP) their only damage; the zombie staying, 10 of 10 unreachable after 30.4 s saying what they held
    for; `hostileFallHp` 2, 10 of 10 arrived in 4.2 s with no hold, 0 damage from the zombie. The bench at the live
    settings on the Mac: 2194 pairs, 5 false unreachable as in R3, 0 deaths.
35. **Left as they are** (the same shape, not fixed here): gotos without `explain` (the chores' and the PvE layer's own
    walks) answer `unreachable` with no cause and do not hold; the health under `fallMargin` closes the falls until
    food brings it back (minutes, not seconds); a mob standing in a one-wide way fails the walk as stuck (`budget`);
    a door or pillar cell whose action failed once is not planned again in that goto; an unreachable answer still
    counts towards the goal's blacklist. Where the flight lands (the spot with only a hurting way off) is the flight
    track's.
