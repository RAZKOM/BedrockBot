# 0091: Windows beside the walk (Track F17)

Date: 2026-11-15 (addenda: Track F18 and Track F19, 2026-11-16). Status: accepted; behind the setting `flyCaveWindows`, default
off (decision 9). Builds on
[0067](0067-long-range-flight.md) (the corridor executor), [0069](0069-cave-flight.md) (the cave style's windows under
a roof), [0082](0082-drawn-entries-and-hops.md) (the hop and the walk's re-check) and
[0088](0088-a-walk-keeps-to-its-way.md) (the walk after a landing keeps the landing probe's way). It is a new record,
not an addendum to 0067 or 0069: the corridor executor and its windows do not change, and the windows here are laid
along a walk's own way, not along a coarse corridor. Details and numbers: [../flight.md](../flight.md) "Windows beside
the walk (Track F17)".

## Context

The owner's goal: a trip flies where it can and walks the rest, and is never slower for the flying.

On the Realm, `!goto` trips from the open to goals deep in a cave under a mountain fly to the cave's mouth, land and
walk the rest: 76 to 166 blocks of path on five goals, 31 to 62 s of walk (offline, closed loop). Found:

- **Nothing after the landing asks for a window.** The corridor executor's windows under a roof serve `!fly` alone. The
  walk's re-check (Track BL, F9e) asks only for a hop, only while the goal is more than 48 blocks off in a straight line
  and only on a walk that starts more than 72 off: three of the five landings were 38 to 66 blocks from their goals
  and were never watched; on the other two, the hop is whole only 82 and 107 blocks in, where the goal is 24 to 43
  off and it is no longer asked.
- **The passage.** 4 or 5 nodes under open sky, 24 to 33 nodes 2 or 3 high over the feet (no takeoff: every proof
  `every primitive from every reached state hits`), then a passage 5 or more high and wide.
- **The tall passage's windows do not fly.** Proven at the live budget (2 s), the windows there came within 0.20 to
  0.28 of the walls; the corridor's proof rule (0.15) takes them; flown (three goals, n 10 a kit), 47 of 50 bailed out
  and the worst run took 5.0 of damage. The runs were 0 to 20 % faster for all that (a bail-out ends farther along),
  which is no reason to fly them.
- **The bore's windows bail out on clean ground** (the corridor e2e's trip offline, 8 burns: the first window landed
  on 2). A plan is robust to the burn's two ends only; the tracker re-times its reference to the burn it reads, and for
  a burn between the ends that reference runs into the floor or the roof. The body, clear of it, is then off it by
  more than `bailError` and bails out; a re-plan asked from ahead starts inside the solid and finds no edge at all.
  A fast window into a bend bails out on its forecast (the controller steers towards a reference in the wall).
- **A way that winds back.** The corridor window takes the via point nearest the body by the plane as the first ahead
  (`firstAhead`). On a way that comes back past its start a wall away, a window from the way in took its first goal in
  the way back, across 8 blocks of stone, and every proof of it hit.
- **The walk keeps to no middle.** On the test server the landing probe's way through a 3 x 3 bore ran along its side
  row: the body standing in its cell is 0.2 from the wall, inside the margin of 0.3, and every proof from it came back
  `every primitive from every reached state hits` at its 13th node.
- **A burn left at the landing.** Offline on the made-up hook cave (the e2e's), plain rockets: 6 of 10 windows bailed
  out and 3 hit the wall (1.1 to 2.9): their plans entered the landing stage with a rocket still burning (1.52 to 1.56
  blocks a tick). Every corridor window that landed had its burn out there.
- **A window round a bend.** On the test server a proven window round the hook cave's bend ended on the floor at its
  corner, 3 of its 7 goals in; offline the bore's bend window bails out before and after the tracker's rule.

## Decisions

1. **The walk handed a way looks for windows beside it** (`chat/commands-fly.ts wayWalk`, `fly/cave/waywin.ts`), with
   `flyCaveWindows` on, `flyCave on` and the route planner on. Only a walk handed a whole way (decision 0088's) does;
   a walk with none, or the setting off, is what it was.
2. **The window is laid from the way.** The scout takes the first node at least `WAY_LEAD_S` 2.5 s of walk ahead of
   the body and `WAY_RETRY_BLOCKS` 6 past the last start tried, pulls the way from it tight into via points, and lays
   the cave style's corridor window over them (at most 96 blocks), landing on a standable node of the way.
   - No start with less than `WAY_HEAD_MIN` 3 of head room over the feet, and the stretch ends before such a node.
   - The stretch ends before its way winds back past its start (`wayWindsBack`: the via before the first that lies
     no farther from the start by the plane than the first via).
   - The stretch ends before its way turns more than `WAY_TURN_MAX` 60 degrees off its first heading (`wayTurns`): a
     window lands before a bend and the next one starts beyond it.
   - The takeoff, the via points and the stretch's end are in the middle of the passage by their nodes (`wayMiddle`:
     of the node's cell and its 8 neighbours that are dry floor with `WAY_HEAD_MIN` of head room, the one whose nearest
     wall at the body's height is farthest); the walk steps across to the takeoff cell when it stops.
   - The margin is the passage's (`boreMargin` of the least head room and the least width across the way, measured
     across it).
3. **A window is flown only on a proof that keeps its margin and lands unpowered** (`wayProven`): complete, robust to
   the burn, at least the window's margin from every solid all the way (not the corridor's 0.15), and its landing stage
   begins with every burn out (`wayLandsUnpowered`). Why: the tall passage's and the hook cave's numbers above; on the
   corridor world the proofs that landed kept 0.30 to 0.34 of a 0.3 margin and had their burn out at the landing.
4. **A window is flown only when it pays** (`wayGate`). The walk is priced as the landing search prices it (the probe's
   ticks at `PATH_PACE`; the closed-loop walk is 1.18 to 1.25 times that, so the gate leans to walking). The window
   costs the plan's ticks, `WAY_OVER_S` 2 s, a proof again from where the body stopped when it stopped more than 0.3
   off the start, and with `flyLandMobs` the landing's hostiles (`cellPrice`). It must save at least `WAY_SAVE_MIN_S`
   4 s and `WAY_SAVE_SHARE` 35 % of the walk's price, with `WAY_ROCKET_RESERVE` 2 rockets left after the plan's.
   Why the margins: a bail-out loses at most its own flight, and the share keeps the expected saving over zero for
   bail-outs up to about 3 in 10.
5. **The proof runs while the body walks**, in the route worker, at the cave style's budget (`WAY_PROVE_MS` 2 s, 80 000
   nodes), on the burn of the rockets at hand. At most `WAY_PROOFS_MAX` 24 proofs and `WAY_BAILS_MAX` 2 bail-outs a
   walk. A budget of 5 s took no more windows offline (the lead grows with it, and the starts it passes by are the
   windows that paid).
6. **The takeoff.** On the start node (within `WAY_ARM_NEAR` 0.8 by the plane, Track BL's safe stop) the walk is
   stopped, the body stands still and steps across to the takeoff cell. No window with a hostile within
   `WAY_MOB_REACH` 8 of the body, or with `flyLandMobs` a creeper within 12 of the landing. The window is flown as a corridor window (`flyWayWindow`: `UnderFlyProcess`, the
   proven plan to its first tracker, the health watched as on a corridor trip); a body moved more than `WAY_PLAN_OFF`
   0.5 off the proof's start by the takeoff plans from where it stands. Then the walk goes on along the same way from
   the node the body stands on (0088's rejoin). Under the health of 12 no window is armed again; a death, a `!stop`
   or a pre-emption ends the walk as before.
7. **The tracker's rule for these windows** (`TrackerRules.refClear`):
   - a reference within `PLAN_CLEAR_MIN` (0.05) of a solid does not count towards the `off the plan` bail-out;
   - a re-plan asked from ahead whose reference there lies so is asked from the body's own forecast there (the plan's
     controls flown from the body's state, each step clear), and as before when that forecast meets a solid too.
   The cave style itself does not take it (decision 8).
8. **`!fly`'s corridor is unchanged.** Over the generator's twelve caves the rule landed as many windows (44 of 249
   with, 43 of 242 without) and one wide cave took more damage with it in two runs of two, so it stays the windows'
   beside the walk alone. The bend's forecast bail-out is not changed.
9. **Behind a setting, default off** (`flyCaveWindows`): it changes what the bot does on the Realm, and it takes off
   under a roof. With it off the walk after a landing is tick for tick what it was (the one entry, `plain()`'s
   `wayWalk` call, is behind it; guard test).

## Consequences

- Offline (`way-window-bench.ts`, n 10 a case, each run's flights on their own burns, a start's proof made once a
  case; before = the walk alone; the test host under the live bot's CPU policy):
  - the corridor world: crafted rockets 51.3 s before, 36.9 s p50 after (30.1 to 40.4), 6 of 11 windows on their
    landing; plain rockets 36.6 s (28.2 to 36.7), 10 of 12; no damage;
  - the hook cave (the e2e's), its centre line: crafted 44.1 s before, 32.2 s after (23.4 to 35.2), 12 of 14; plain
    21.8 s (21.1 to 28.1), 18 of 20; its inner side rows (as the server's probe walked it): crafted 42.9 s before,
    32.7 s after, 5 of 6; plain 30.4 s, 8 of 10; no damage;
  - the owner's cave, five goals, either kit (the PC): no window is taken (decision 3), the walk is the walk; by the
    corridor's proof rule 50 windows were taken there, 47 bailed out and the worst run took 5.0 of damage.
- On the test server (`fly-cave-way.test.ts`, the hook cave, `!goto` from the open): 3 runs a side a kit, every
  trip arrived unhurt: plain rockets 45.8 s p50 with the setting off, 39.5 s on; crafted 45.8 and 39.6; every `on` trip
  flew one window of 64 blocks on its landing; plain again on the final tree, 3 a side: 47.8 and 40.1, 3 of 3 on their
  landing. Five more plain trips: 2 windows of 5 ended on the floor short of their landing (no damage, the trips still
  faster than the walk).
- The bore (`bore-bench.ts`, 8 burns, `!fly`'s executor with the rule as a variant): the first window landed on 7
  against 2 and 3 (two runs).
- A proof costs the route worker up to its 2 s while the body walks (4 to 10 a walk on the made-up caves); nothing is
  added before a takeoff from the open.
- Not done:
  - the owner's tall passage is still walked: its windows need a plan robust to the burns between (midBurns, too slow
    at the live budget with crafted rockets) and a controller that does not steer towards a reference in a wall;
  - a bend of more than 60 degrees is walked (the corridor world's plain kit loses about 10 s of 51 by it);
  - a straight window can still end on the floor short of its landing when a rocket burns past the plan (the proof is
    robust to the burn's two ends only); it does not hurt and the walk goes on;
  - the hop is not asked within 48 blocks of the goal (two of the owner's goals have a whole hop there);
  - hostiles on the way not run on a server with mobs (the rules are unit tests).
- **On the Realm** (2026-11-16, `flyCaveWindows` on, five goals deep in a cave from the open, 2 trips each, crafted
  rockets): 10 of 10 arrived, no death, damage 0.9 at the most, no window flown, as offline; the trips took what the walk
  took before (74 to 112 s). The 30 proofs refused there: 12 for a clearance of 0.20 under the margin of 0.30 (109 to
  562 ms each), 12 partial with the node budget run out (1.2 to 1.4 s), 4 with a rocket still burning where the landing
  begins, 2 with no route at all. A goal's second trip proved the same windows again with the same expansions. The
  setting stays on there; it stays off by default.

## Addendum (Track F18, 2026-11-16): the owner's tall passage

On the Realm with the setting on (five cave goals twice each from home, crafted rockets) every trip arrived, no
window flew, and 30 proofs were refused: 12 `clearance 0.20, under the window's margin 0.30`, 12 partial at the nodes
budget, 4 `a rocket still burns where its landing begins`, 2 `no route`. Track F18 asked what holds those windows.
Details and numbers: [../flight.md](../flight.md) "The owner's tall passage (Track F18)".

- The 0.20 is the standing takeoff's: a standing start's first edge is swept on the bare box (the body stands where it
  stands), and a body in its cell is 0.2 from a wall beside it and 0.28 from a corner. After the takeoff the same
  proofs keep 0.41 to 0.65.
- Every complete proof there also enters its landing's stage with its one rocket still burning (windows of 25 to 38
  blocks, the rocket fired in the takeoff, a crafted burn of 19 to 31 ticks or a plain one of 9 to 21), so decision 3's
  landing rule refuses them all.
- Flown at every crafted burn regardless (5 windows, 13 burns each), 3 of 65 landed and 3 hit a wall (up to 6.6).

10. **The reason names what refuses a window, the takeoff apart** (`wayProven`). The landing's rule is judged before
    the margin. The clearance after the takeoff (`RoutePlan.flightClearance`, the search's edges after a standing
    start's first, joined over pieces) is named where it differs. Which proofs fly is unchanged (guard test over every
    combination). A refusal said only one of two reasons, and the one said was the takeoff's, so the cave looked like
    a margin problem when it is a burn problem.
11. **The margin stays the whole plan's, takeoff included.** Judging the margin after the takeoff was measured:
    - the owner's cave unchanged (the landing's rule);
    - the corridor world unchanged;
    - the hook cave's centre line faster (crafted 31.1 to 26.6 s p50, with 6 of 18 windows bailed out);
    - its side rows slower with crafted rockets (30.5 to 32.6 s), no damage.

    The result was mixed for the kit the Realm flies, so it is not taken.
12. **No plan robust to every burn is asked for.** What was tried:
    - midBurns: no proof completes at the 2 s budget, 1 of 9 at 30 s, and that one landed at the nominal burn only; on
      the test host at the live budgets the hook cave lost every window;
    - plans from each burn's end: 3 or 4 of 13 ends have one, even at 5 s;
    - every burn open loop: it refuses the made-up caves' windows too, where the tracker lands 10 to 19 a case.

    The tall passage's windows are about as long as one crafted burn. What would fly them is a window that does not
    start under a full burn (open point), not a margin.
13. **The bench flies a copy of each proof.** The tracker re-times the plan it flies in place. The bench shared a
    start's proof between a case's runs, so each later run flew an earlier run's re-timed reference. Live, a proof is
    flown once (the chain's first tracker). A future proof cache must hand out copies.
14. **`flyBranch` sweeps a takeoff's jump tick without its floor**, as the search does (bench use only).

No setting is added; `flyCaveWindows` and its default are unchanged.

Consequences:

- Offline, the owner's cave (n 10 a kit, either kit), before and after the same: 30.8 to 62.4 s, no window, no damage.
- F17's made-up caves on this bench and main's (n 10 a kit) are within a window a case. The crafted hook cave flies
  fewer windows on the fixed bench (12 against 15) with fewer bail-outs (3 against 7).
- The 2 to 3 high passage: no window is possible under `WAY_HEAD_MIN`, so it stays 3. The way's stretches with 3 of
  head room outside the tall passage save at most 0.8 to 6.5 s, and those worth more than the 4 s gate have lines of 13
  to 23 blocks, under `UNDER_FLY_MIN` 24.
- Regressions on the final tree passed:
  - the e2e `fly-cave-way`, `fly-corridor`, `fly-cave-refill` and `fly-cave`;
  - the unit suite on the test host, three runs of three.
- Not done:
  - a window that lands in the tall passage;
  - a glide window under 24 blocks;
  - the tracker's end check at the nominal burn (2 of 5 land with it, 4 of 5 without, on one window; no change on the
    made-up caves);
  - a server replica of the owner's cave with windows (the live rule is unchanged but for its words; the Realm series
    is the live evidence).

## Addendum (Track F19, 2026-11-16): windows that do not start under a full burn

Track F18 named four ways a window in the owner's tall passage might land: a glide with no rocket, a rocket fired
later, a tracker that trusts the plan at the end of the burn, and a proof cache. Track F19 measured each on the fixture
at every burn, closed loop, and on F17's made-up caves. Details and numbers: [../flight.md](../flight.md) "Windows that
do not start under a full burn (Track F19)".

- One crafted rocket from a standing takeoff carries the body 30 to 50 blocks before its burn ends (plain: 13 to 33),
  and 6.4 more to a stop. The passage's windows are 25 to 44 blocks.
- A glide: 108 windows, none complete (no height to trade from a standing start on the level; the one drop is 1 wide).
- A rocket fired later (the search's edges refused once the landing's stage begins under a burn or fires in it): no
  crafted proof completes on the fixture (12 of 22 do without the rule, all burning into the landing); one plain one,
  flown at every burn, landed once and hit once (7.6). On the made-up caves the walk is the same run for run.
- The plan trusted through the end-of-burn check and the burn's re-plans (a scratch switch): crafted, 13 of 36 landed
  at the plan's own burns against 11, 0 of 120 between them against 2, 7 wall hits against 6; plain alike. From the
  burn's end an unpowered plan exists for 1 to 4 of 13 burns.
- A cache: live, each proof is flown once; nothing to copy.

15. **No window in the tall passage, and nothing new in the walk.** None of the four lands reliably, so `wayWalk` is
    unchanged and `flyCaveWindows` keeps its default. The bar for taking one was F17's gate with every burn of the
    crafted range landed or bailed out unhurt; nothing came near it.
16. **The landing searched unpowered is a bench switch** (`RouteRequest.landUnpowered`, default off; with
    `ChainOptions.rockets` for a glide window and `WayWindowOptions.minBlocks` / `passMin`). Nothing in the bot sets
    them (guard test). They are what `scripts/way-burn-probe.ts` and `way-window-bench.ts --late` measure with.
17. **The end-of-burn check stays as it is.** Trusting the plan through it gained 2 of 36 landings at the plan's burns
    (crafted) and lost 2 landings and gained a wall hit between them; the switch is not kept, since it turns a safety
    check off.
18. **No proof cache.** The bench's start cache replays a proof that stalled at its ms budget for every seed (one run
    of the crafted hook cave read 31.0 s p50 against 23.5 on two reruns): such a case is run twice.

Consequences:

- Offline on the fixture and on the made-up caves (the PC, n 10 a case, both kits): main and this tree the same run
  for run.
- What would fly the passage: about 50 blocks of straight line before the landing's stage (the passage gives at most
  44 of window), or a plan that holds every burn between the ends at the live budget (Track F18: none at 2 s, 1 of 9
  at 30 s).
