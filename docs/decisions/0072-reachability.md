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

## R5: a walk starts from wherever the body stands

Track R5 (2026-11-13, docs/pathfinding.md "A walk starts from wherever the body stands (Track R5)"). On the Realm a
flight set the body down on the top of a fence; the goto found `no standable node` at the feet three times and ended
`unreachable` with no plan and no cause. Walks that began on other fence tops started only because the body's
footprint overlapped a column with a node 0.5 lower.

36. **A start where the stand rule has no node: the perch.** A fence, wall or closed gate (top 1.5) is not a floor, and
    that stays so: no path goes onto one. When `locateNode` finds no node, `locatePerch` takes the top the body rests
    on: `NavGrid.perch` gives the feet height on a top the stand rule does not take (a box in the cell below with its top
    from 1 to 1.5; a box in the cell itself with its top under 1 that is not a floor; the highest box under 1 in a
    bowl). The head room must be free, and liquids, scaffolding and climbers are never a perch. The body must be on it:
    the feet no lower than the top and at most `PERCH_ABOVE` 0.05 above it, and a box with its top there under the
    footprint, counting a fence's arms (`boxesAtCell`).
37. **Only the planner's own moves leave a perch.** The search starts there with `PathOptions.startFeet` (`F_PERCH`;
    the worker gets it too): walks, diagonals, a doorway at its level, jumps, drops and long drops, each under the rules
    it has from any node. A perch is never "flat", so no dig, pillar, parkour, sneak, hatch or climb starts there, and
    no move goes into one. The fall policy, the R4 hold and the step-off check apply to the drop off a fence as to any
    drop. A perch is tried only when `locateNode` finds nothing, so every start that worked before is unchanged. It is
    on by default: it only lets a walk begin and adds no step the planner did not have.
38. **A body in the air settles first.** When there is no start and the body is not on the ground and not in water or
    lava, the goto waits without counting a failure: it looks again every 2 ticks, up to `SETTLE_TICKS` 40 (2 s) a
    goto. 40 ticks is a fall from rest of about 48 blocks in the physics model (1.5 blocks in 7 ticks, 5.5 in 13, 16
    in 23). After that, or for a body on the ground, the goto fails as before.
39. **The same start everywhere a goto looks for one.** `Navigator.startOf` (the main search, the "why" search, the line
    drawn when no segment is found, `Navigator.plan`) and `withFallNote` use `locateStart`: `locateNode`, else the perch.
    A plan that came back `none` with an empty path is a start the planner refused (the world changed between the
    lookup and the search). It used to end the goto at once, or fail a corridor waypoint; it now counts a failure and
    plans again in 10 ticks. `safeHere` and the last safe spot stay on `locateNode`: a perch is not a place to stand
    and wait.
40. **Measured.** The shapes table (`nav-r5.test.ts`, about 50 blocks at 5 spots each): fences, walls, gates,
    cauldron and composter rims, magma, cactus, dripstone and the hopper had no start before and have a perch now. The
    blocks that had a node keep the same node. The real navigator in the bench's closed loop, a fence line and a goal
    20 blocks off, 10 runs a case: the post, the rail, the Realm's spot, the edge, the end and a landing 1 over a post
    each arrived 10 of 10 with no damage in 92 to 101 ticks (from the grass: 84); before R5, unreachable with no
    plan in 41 ticks. The fence on a wall 4 high: by a stair, 10 of 10 with no damage; with no stair, a 5.5-block drop,
    10 of 10 with the fall's 2 HP; with a zombie near, 10 of 10 after R4's hold; at 8 health, `rule falls` as before.
    On bds-pve (`nav-perch.test.ts`, a spruce fence line the server joined, 10 runs a case): before R5, 10 of 10
    unreachable with no plan in 2.0 s; the post, the rail, the Realm's spot, the edge, the end and the landing each
    arrived 10 of 10 with no damage in 4.5 to 4.8 s; the stair, 10 of 10 in 7.0 to 7.2 s with no damage; the drop,
    10 of 10 in 5.2 to 5.4 s with the fall's 2 HP. The bench at the live settings on the Mac: 2541 pairs (the long class
    included), 6 false unreachable, 0 deaths; on R4's 2194 pairs the same 5 as R4, and the sixth (a long pair
    interrupted at its tick budget) the same on the base before R4. No pair changed its answer.
41. **Left as they are** (reported, not the same case): a goal on a fence top is still `not standable` (the goal side
    has no perch); `home/reach.ts` (the flight's landing probe), the mine's probe and the panic run plan from
    `locateNode`; inside a cauldron or composter `locateNode` takes a neighbour node 0.31 lower, and the rim then needs a
    jump; the unprone and leaves path keep their own start. Where the flight sets the body down is the flight
    track's.

## R6: a goal on a top the stand rule has no node for

Track R6 (2026-11-13, docs/pathfinding.md "A goal on a top the stand rule has no node for (Track R6)"). The owner's
rule: `!goto` answers `unreachable` only when the goal is closed off. After R5 a goal on a fence, wall or closed gate
top was still `not standable`: `unreachable (rule place)` in 1 tick, or with `allowBreak` on `unreachable (world)`
after 28 plans. A column goal over a fence took 27 plans to the same answer.

42. **A goal on a perch.** A goal cell that is no node and is a perch (decision 36's `NavGrid.perch`) is a perch goal
    (`astar.ts perchGoal`). It may be stood on (`enter`) when its top is a box in the cell below standing over 1 (a
    fence, a wall, a closed gate), no hazard, covering a centred body's footprint. A rim round a hollow (a cauldron, a
    composter), a top in the goal's own cell (a hopper), magma, a cactus and dripstone are perch goals that are never
    stood on.
43. **Onto it by a step or a jump up, never a drop.** `PathOptions.perchGoal` adds the path's last move: from a
    cardinal neighbour node onto the goal's top, a rise of 0 to `MAX_JUMP_RISE` (a walk up to a step, else a jump with
    the head room free). A move down onto a perch is a drop, and the fall rules, R4's hold and the step-off check
    have no answer for a perch, so none is planned. The move ends the path: nothing leaves the goal's top and no other
    perch becomes a node. Every other step is the planner's own under the same rules.
44. **Else next to it, arrived, with a note.** When no neighbour node is 0 to 1.25 under the top (looked at before
    the first plan), or the way onto it fails (no plan, no progress, a loop, a move that does not take: once, with no
    failure counted), the walk ends next to it: a `getToBlock` goal, as a dig is walked to, on the goal's own cell
    with no face for a fence, a wall or a gate (a side cell at the post's level or a level higher: a post in a deck),
    on the block for a top inside its own block (a cauldron). On the post's block a side cell over it is never done,
    and a post in a deck had no end. A radius round the top was tried and rejected: one wide enough for a fence's
    corner took a column two blocks from a cauldron. The switch happens on any failure of the goto, also a move
    timeout far from the goal: the cost is that such a walk ends next to the top where a retry might have reached
    it; it never ends unreachable for it, since every way onto the top passes a cell next to it. The result is `ok` with a `note` (a new optional field of `SkillResult`'s ok branch) that
    says the goal's cell cannot be stood on, why, and how far the body ended from the top; `!goto` puts it in the reply,
    and `GotoReport.perchGoal` records `on` or `beside` with the distance.
45. **A column goal** (`xz`) is looked at the same way only when no cell of the column is a node (one pass down the
    column, once a goto, not decided while part of it is unloaded): on the cell over the column's highest box (a
    fence) or its own cell (a cauldron's inside). A column goal is done at any node of the column, so a column with a
    node under a fence top (a room under a roof, a path under a bridge's rail) keeps the plain goal and the node it
    arrived at before.
46. **On by default, no setting.** It only changes how a walk ends: onto the goal by a step or a jump up, or next to
    it. `Navigator.perchGoals = false` gives the behaviour before, for the tests.
47. **Starting inside a bowl.** In an empty cauldron or composter the start is a neighbour node 0.31 lower (decision
    41) and the first move needs a jump over the rim; the follower walked into the rim and the goto ended unreachable
    after three move timeouts. The follower now jumps when, on the ground, pushing forward and blocked sideways, its
    feet are on a bowl's inside (`follower.ts inBowl`). It is a jump the path's move already asks for at the rim.
48. **The callers' starts.** A caller asking with the body's own position takes `locateStart`; one asking about a cell
    it considers keeps `locateNode`. Changed: `probePath` takes `{ body: true }` (the mine's walk probe and the guard's
    reach probe pass it), the mine's straight probe uses `locateStart`, and the miner no longer marks an ore unreachable
    when its probe had no start (the probe says nothing then). Kept, with a comment: `Navigator.plan` with an explicit
    `from` (a named cell, no caller passes one), `safeHere` and the last safe spot (retreat targets). Not the same
    case: the landing probe and the flight's site probes (landing cells; the flight's files, not changed here), the
    panic run (it walks through `mover.goto`, which has the perch since R5), the unprone path (a floor with no head
    room: it digs and plans again through the navigator).
49. **Measured** (`nav-r6.test.ts`, the real navigator in the bench's closed loop, the goal 15 blocks off, both the
    default and the live settings, 10 runs a changed case): a fence, a wall and a closed gate goal arrived next to them
    10 of 10 in 66 to 67 ticks (before: unreachable in 1 tick, or after 333 with `allowBreak` on); with a block beside
    them, on the top 10 of 10 in 74 to 78 ticks, 0.01 to 0.17 from its centre; a fence with a slab beside it by a jump
    in 78 to 80; a cauldron next to it in 66 to 67; a column goal over a fence next to it in 66 to 67 (before: 328
    ticks and unreachable); no damage, no death. The kinds that are not perches (inside a solid, in the air, no head
    room, a slab's upper half) answer as before. A fence in a deck with fences on its four sides arrived next to it
    on the deck 10 of 10 in 74 to 77 ticks (on the post's block as the goal: unreachable after 316 ticks). A column
    goal with a fence on a roof over a floor arrived on the floor with the same end and plans as before, 10 of 10 in
    both configurations (the first column rule: unreachable after 321 ticks). R5's 249 shape rows are byte for byte the same on the base and on
    this tree. On bds-pve (`nav-perch.test.ts` goal cases, one post on the grass, the goal 20 blocks off, 10 runs a
    case): before, 10 of 10 unreachable (`rule place`) in 1 tick; a spruce fence, a cobblestone wall and a closed gate
    each arrived next to the post 10 of 10 in 4.1 to 4.2 s with the note; with a block of planks beside it, on the top
    10 of 10 in 4.5 to 4.7 s, 0.00 to 0.17 from its centre; no damage. R5's own cases on the same tree gave R5's
    numbers. The bench at the live settings on the Mac: 2541 pairs, 0 deaths, R5's six pairs the same with the same
    causes; one more, caves:5:10, `unloaded` under load (three unit suites on the host), arrived 3 of 3 run alone
    there and on the PC on this tree and the base; no other pair changed its answer. The mob gates no worse: pve-m1,
    pve-combat, pve-creeper 20 of 20, nav-hostile-fall 4 of 4, the gauntlet's live kit 33 cells with no death. On
    the final tree (decisions 44 and 45 as written) the bench gave 0 deaths again. caves:5:10 is `unloaded` on the base too
    when its whole world runs. Three long pairs moved with the load (500 ms corridor searches); long:7:16 arrived
    when run alone. pve-combat was flaky that evening on this tree and on the base alike, and the gauntlet's one
    suffocation (creeper-4, no goto running) did not come back in 5 runs on either tree.
50. **Left as they are.** A perch goal with nothing in reach of it (a fence on a tower 3 high) stays unreachable
    (`rule place`; with `allowBreak` on it said `world` before). A goal given as the fence block's own cell is a goal
    inside a block, as before. The flight's probes are the flight track's. Found on the Realm (2026-11-14) and open:
    a top with less than 1.8 of head room over it (a fence under a roof's eave, where the server holds the body in
    its 1.49-high pose) is no perch, neither as a start (decision 36) nor as a goal: the model has no body lower than
    1.8 at a start.

## R7: a body held low, and a goal nobody stands in

Context (docs/pathfinding.md "A walk that starts or ends where the body is held low (Track R7)"). The fence of decision
50: on the Realm a walk from its top found no standable node three times and ended unreachable after 41 ticks with no
plan. As a goal, the cell over it took 17 plans in 1248 ticks to the same answer. Apart from perches, a `block` goal
inside a block, under a block where the head goes, or in the air answered `unreachable`, in 1 tick or after about 330
ticks with `allowBreak` on. A player walks up to such a goal.

51. **What failed on the Realm.** `NavGrid.perch` asks 1.8 of head room, and the eave leaves 1.5. The log's "in air"
    is the feet cell's block name. The body was on the ground: no line says `airborne`. The first failure came 0.5
    over the top, where the teleport's answer said the body was on the ground, so R5's settle wait (which needs
    `!onGround`) did not run.
52. **The held-low pose, as the server does it.** On bds-pve, under such an eave, the server holds the body at 1.49
    with the `sneaking` flag and no sneak key. The body moves at the sneak speed with no edge back-off, and stands
    again once the standing box is clear. `physics.ts heldLow` models it: the 1.49 box, the sneak speed, no sprint and
    no back-off when the 1.8 box meets a block and the 1.49 box does not. `BodyState.low` marks it, and `sneaking`
    stays false, so nothing is sent. The 1.8 model drew 1 or 2 corrections a run there; this one drew none in the
    four eaves probed, with or without the key.
53. **A low perch is a start only.** `NavGrid.lowPerch` is a top that is no perch only for the head room, with
    1.49 to 1.8 over it. `locateStart` gives it (`F_PERCH | F_LOW`). From it the planner plans cardinal walks off and
    drops, with the crouched head clear in the neighbour column. It plans no step up, diagonal, doorway, climb,
    parkour or pillar, since each would need the full height before the body stands. The settle wait also waits for
    a body whose crouched box rests on nothing (`physics.ts restsOn`), the case of the teleport's answer.
    `Navigator.lowPerch` is on, with no setting: it only lets a walk begin where it could not. `false` gives the
    behaviour before, for the tests.
54. **The same top as a goal ends next to it.** A low top is a perch goal never entered (`low: true`): a body gets
    onto it only crouching, and the planner has no such move. R6's `perchRing` ends the walk next to it, and the
    note says why. A sneak node under a low ceiling (Track BC) was a start and a goal already, and the crawl pose
    (0.6) is the unprone path's. Neither changed.
55. **A goal nobody stands in ends next to it, for `!goto` only.** `GotoOptions.beside` (default false) makes
    `Navigator.lookBeside` decide before the first plan, once:
    - a built block, a fence or a wall block's own cell, or a natural block with no dig to open it: next to it
      (`getToBlock`, a face asked for a full cube only);
    - a floor with a block where the head goes: next to it, unless that block is natural and `allowBreak` is on;
    - open air with its own column's node 1 to 5 under it: under it, on that node, within reach. With `allowPlace` on,
      the pillar's search as before.
    The answer is `ok` with a note: the cell, what is in it, why, and how far the body stopped. `GotoReport.beside`
    records it. A natural block the goto may dig is dug into, as before, because the body then stands in the cell
    itself. Water was a goal already (W3). Lava, open air with no floor within 5, and R6's perch with nothing in reach
    stay `unreachable`: nothing in reach can be stood on, or ending at lava's edge is the hazard rules' call, not the
    goal's.
56. **Why an option.** Of the callers that give a `block` goal, seven act on being in the cell and would be misled by
    `ok` next to it: the branch miner's pickups (in `branch.ts` and `commands-explore.ts`), the miner's `intoHole`, the
    branch layout's `standOn`, the tunnel's steps, the quarry's stair climb (each digs after a failed walk), and the
    portal's step in (steered by hand from the walk's end). Only `!goto` sets it, for coordinates and waypoints alike,
    and through it the `!test goto` series. The series counts an end within 2.5 of the goal cell's floor centre:
    beside a block that is arrived, and under a cell 3 to 5 up it is not. The flight's glide down follows only a
    failed walk, so it takes no glide after an `ok` beside the cell. R6's perch answer stays for every caller: none of
    the strict callers gives a cell over a fence.
57. **Measured** (2026-11-14). On bds-pve, from the fence's top under a planks eave, a bottom stair eave and a top
    stair eave, at the centre and two offsets: 90 of 90 walks arrived, in 77 to 81 ticks (3.8 to 4.0 s), 1 plan, 0
    corrections, 0 damage. Before, 10 of 10 were unreachable in 41 ticks with no plan. Set 0.5 over the top with the
    walk started at once, 10 of 10 arrived. A goal over that fence ended next to it with the note 20 of 20 (before:
    `rule place` in 1 tick). With `beside`, a block of planks, planks where the head goes and a cell 2 over the grass
    ended next to it or under it 30 of 30 in 66 to 69 ticks; without it, 30 of 30 were unreachable in 1 tick.
    Offline, in both configurations, 240 of 240 starts and 80 of 80 goals came out the same.
    R5's 249 shape rows are byte for byte the same. R6's 396 rows differ only by 1 tick in 29 rows. The reach bench
    at the live settings gave 2541 pairs, 0 deaths and 8 false unreachable (R6's count); two long pairs swapped,
    traced to the 500 ms corridor limit. The mob gates passed: pve-m1, pve-creeper, nav-hostile-fall and pve-combat,
    and the gauntlet's live kit (33 cells, 0 deaths).
58. **Left as they are.** `!home go` and the older `!goto` handler of `chat/commands.ts` (`commands-nav.ts` takes the
    name back from it) pass no `beside`; their files are not this track's. `!test goto`'s 2.5 radius counts an end
    under a high air cell as not arrived. A low top with a block beside it at its own height has no crouched step
    onto it, and ends next to it.
59. **On the Realm** (2026-11-14, deployed). The fence of decision 50: a walk from its top, the body set 0.5 over
    it, arrived 3 of 3 (55 blocks, 237 to 239 ticks, the settle wait 4 ticks, one plan from the low perch, 0
    damage); the cell over it as a goal answered `arrived` next to it with the note after 2 ticks and 1 plan, 3 of 3;
    the fence block's own cell as a goal ended next to it 2 of 2 after a walk of 51 blocks. R6's gate goal and an
    ordinary walk home as before. A goal in the air and one with no head room were not run there.

## R8: a `!goto` that stands as near as it gets

Context (docs/pathfinding.md "A `!goto` that stands as near as it gets (Track R8)"). The owner's rule: `!goto` says
`unreachable` only when the goal is completely closed off; a player sent somewhere goes as near as they can and says
where they are. In a Realm sweep of 45 `!test goto` trips (2026-11-14), two walks came within 1.1 and 6 blocks of
their goal, then stood for 65 s and 44 s while the ladder ran, and answered `unreachable`. One goal cell held a nether
portal; the other was open air over a lone block left in a dug-out pit.

60. **Why they stood.** Both goals were R7 `beside` goals. The portal cell fitted no R7 kind: it has no box (not
    `solid`), and it is its column's own cell over the frame (not `in the air`). The planner never enters it
    (`avoidWalkingInto`), so every search failed. For the pit, R7's `in the air` end was the node on the lone block,
    which no walk reaches. From then on every search started at the same node with the goal under 8 off, and none
    found a partial end 5 or more blocks away (`MIN_DIST_PATH`): "no progress". The ladder (4 x the budget, the long
    dig search, two more levels with three searches each, a failure, the "why" searches with their own bigger
    retries) cannot tell anything new from there except what a search at the last level's options tells at once.
61. **A cell no move enters is a goal ended next to it** (`BesideKind` `no entry`, with `beside` only). A hazard with
    no box at the feet, or at the head over an open cell: portal, end portal, end gateway, fire, soul fire, cobweb,
    berry bush, powder snow, wither rose. Decided before the first plan, `getToBlock` with no face, as a block is
    walked to. Liquids are not in it: water is a goal (W3) and lava stays unreachable (R7).
62. **R7's node under an air cell falls back.** When the searches find no way onto it (`besideRing`), the goal becomes
    next to the cell (one of the 8 columns round it with the cell at the feet or the head), once a goto and only if
    one of those columns has a node; no failure is counted. An air cell whose own column's node has its feet less
    than 0.5 under the cell's floor (a path block, farmland) is that node, with no note: the body stands where it was
    asked.
63. **A near end** (`nearNoWay`, with `beside` only). A main search from the body's node that finds no progress, the
    feet within 8 (`NEAR_END`) of the goal cell's floor centre, the body safe (`safeHere`), the cell not lava, not a
    corridor waypoint's search, and the chunks round the goal loaded. What runs then depends on that search. Not cut
    by its budget (exhaustive under its options): a bigger budget or the long dig search finds nothing new, only a
    level with more options can, so one search at the last level, then the answer. Cut by its budget: nothing is
    proven, so each higher level's own search at the main budget, then the last level's bigger search and long dig
    search once each, and R3's weighted open walk once, as before. (A first version that jumped to the last level, or
    to the long dig search, stopped short at the bench's pits:13:11, a goal on a 2 x 2 tower 6 high that the dig
    way's level climbs by a dug stair within its budget and the falls' level does not.) Dropped: the bigger and long
    dig searches of the levels below the last, the failures' three rounds and the "why" searches' bigger retries.
    Each of these searches may end at any node at least 0.25 nearer the cell's centre by the eye (`PathOptions.nearEnd`:
    out of water, no irreversible drop, no pillar, swim or climb; a partial path cut before its first dig, place or
    pillar). Then the answer: the "why" searches with no bigger retry and only the rules the open way broke, each at a
    quarter of the main budget. 8 is about the farthest a body stands from a goal it can see and still be "at" it;
    farther, a bigger search from the same node can find a way round a wall that the first did not reach the end of.
    So the far case keeps its ladder.
64. **What the answer says** (`finishShort`). The eye within 3.9 of the cell's centre (`NEAR_REACH`, R7's reach): `ok`,
    `arrived at X (the goal's cell ... cannot be reached (why): stopped D blocks from it)`. Farther: a failure,
    `stopped short (D blocks from the goal's cell ...: why)`. It is not `unreachable`, because the place was not
    reached but the goal was not closed off either; a caller (and `!test goto`) must still see it as not arrived. The
    why is what the rest of the way needs (a block placed, a fall over the budget, a built block broken), or that
    nothing gets nearer, the world is not loaded, or the budget ran out. `GotoReport.short` and `nearTicks` record it.
65. **On by default, no setting.** It changes only when a `!goto` answers and what it says. The moves, the hazards, the
    fall budget and the edge rule are the same; the body ends where a search under the same rules walked it, and
    `safeHere` holds there. `Navigator.nearEnds = false` gives the behaviour before, for the tests.
66. **`!test goto` counts the reply.** A goto run is arrived only with an `arrived at` reply and the feet within 2.5,
    or a note that says how far it stopped. A failure reply within 2.5, or `stopped short` at any distance, is the end
    `short`, shown in the summary line. The record adds `reply` and `replyDistance`; no field is renamed.
67. **Measured** (2026-11-14). Offline on the Mac at the live budgets, 10 runs a row, both configurations: the portal's
    cell next to it with the note in 69 to 70 ticks, 1 plan (before: `rule place` in 1 tick, or `world` after 355 to
    362 with 29 plans); the pit `stopped short` 6.1 from the cell, the answer 12 to 17 ticks after the last move
    (before: unreachable, 284 to 390 ticks still). On bds-pve, 10 a case: the portal 66 to 67 ticks (before 1 tick, or
    38.6 s with `allowBreak`); the pit `stopped short` 5.1 to 5.8 s after the last move, and 16.7 s with `allowBreak`
    on, where every search is cut (before 15 to 17 s and 29 to 31 s). 0 damage, no death. The reach bench at the live
    settings with `beside` against without (2541 pairs): 2465 at the goal against 2464, 26 more within reach with the
    note, 21 stopped short, 0 deaths, 0 stranded, max damage 8, 3 false answers against 6. One pair lost (pits:3:9,
    which the oracle calls `rule place`) had no near end in its log. R5's and R6's rows the same but for ticks off by
    1 (the base against itself the same); R7's the same but four rows that R8 moved on purpose.
68. **Left as they are.** A near end whose searches are all cut by their budget answers in about 15 s on this PC's
    test server, not in a few seconds. A far goal truly cut off keeps its whole ladder. `!home go`, the older `!goto`
    handler and the flight's walks pass no `beside`. `commands-portal.ts` still says `in the the_end` in its own lines.
69. **On the Realm** (2026-11-14, deployed; six `!test goto` trips, no damage). The portal's cell: decided before the
    first plan, 1 plan, the answer 2.8 s after the walk began with the note (1.42 blocks off); the trip 31 s against
    95 s. The cell over the lone block in the pit: every search was cut, so the slow rule of decision 63 ran, and the
    answer came 15 s after the last move (44 s before): an arrival with the note 3.35 blocks off (`the rest needs a
    block placed`), the eye within 3.9, where the walk had stood 6 off and said `unreachable`. R7's air cell, two
    ordinary waypoints, a trip home and a waypoint in the End (`in the End`) as expected. The series scored by the
    replies; the 207 runs recorded before score the same but the two at the portal (arrived to `short`). Seen there
    the same day and not R8's: a waypoint in a room of a building high in the air, entered and left by a ladder
    with a hatch at its top, was reached, and the trip home from inside it answered `unreachable (world)` in 4 s.
    First read as a room with no way out; that was wrong (corrected 2026-11-15 by probes there). The walk planner
    leaves the room (a goto from inside to the roof: 41 ticks up the ladder and through the hatch), and a trip
    home that starts on the roof flies (a ledge takeoff from the roof's edge under a wider roof 19 over it, 122 s,
    no damage). What found nothing was the flight's takeoff search: a ledge is looked for only on the floor the
    body stands on (the room's 11 cells: no edge), its flood under the roof does not climb a ladder (25 cells,
    none to the open sky), and its takeoff sites are columns' tops under the open sky (none within 48: the
    building stands under the wider roof). It then walked for home, which no walk reaches from a building in the
    air, and the reply was that walk's. Open, and the flight's: a ledge on a floor the walk reaches is a takeoff
    site.
