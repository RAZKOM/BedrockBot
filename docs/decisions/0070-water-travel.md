# 0070: Water travel (planning under water, within the air)

Date: 2026-11-06. Status: accepted (Track W1; builds on [0032](0032-movement-variety.md) (the swim moves on the
surface, the measured water physics) and [0066](0066-coarse-layer.md) (the coarse layer's walk prices); the real
cave it was checked against is Track F5a's private fixture, [0068](0068-real-cave-benchmark.md)). Guide:
[../pathfinding.md](../pathfinding.md) "Water (Track W1)".

## Context

On the Realm (2026-11-06) the owner led the bot through a cave with water by `!follow`. It struggled to climb
up water, did not seem to know it was in water, and often sank to the bottom while following. The log showed why:
a body in water had no start node (`start node none`, over and over), so follow and come stalled while it sank;
its head was under water for 764 ticks before the SurfaceProcess swam it up at air 99; and the planner never
planned under the surface (Track AJ left that out: no air model). Water columns, waterfalls, flooded passages and
pool floors were all unreachable, and the coarse layer priced water at 3 x a walk with the same openings as dry
ground.

## Decisions

1. **One module says what water means** (`nav/water.ts`): in water (the physics test, or water at or just under
   the feet: a bobbing body leaves the physics test for a tick), head under water (the eye under its cell's water
   surface), the air (the server's `air` when wired, else a local clock), which water a body moves through (any
   water without a box or hazard, flowing and falling water included; no bubble column), and the air budgets. The
   navigator's start node, its idle keys, the planner's dive nodes and the follower read it; the SurfaceProcess,
   the fall code and the flight code keep their own liquid tests (other owners, listed in the module).
2. **Dive nodes under the surface, with measured moves** (`NavGrid.dive`, `astar.ts` `expandDive`, `moves.dive`,
   on by default): down (sneak, 6 ticks), up (jump, 8), across (10.5), in from a floor at the feet level, out onto
   a floor beside at the feet level or 1 higher. Costs come from the bds-fly probe (BDS 1.26.60): 0.135 a tick up
   in still water, 0.098 across, about 0.2 down with sneak. The sneak key's -0.04 a tick in water joins the
   physics model (it was missing: 2 corrections of 0.81 per sneak).
3. **An air budget per stretch under water.** Planned ticks with the head under water since the last breath stay
   within (300 - 110) / 1.5 from a breathing start, (air - 20) / 1.5 (at least 60) from a start under water. 110
   stays above the SurfaceProcess threshold (100), so the escape never cuts a planned dive; the 1.5 margin covers
   the follower being slower than the costs. A partial path never ends under water. Alternatives rejected: no
   budget (the planner would route through a 20-block sump), or a fixed depth limit (a 1 x 1 column 8 high is fine,
   a 12-block flat sump is not: the time under water is what drowns).
4. **No 1-block lip.** The Track AJ bank exit allowed a bank 1 above the water cell; a bank 2 above the top water
   cell (a pool with a 1-block rim) was considered and measured: forward + jump against it only bobs the body
   (feet from 0.98 under to 1.55 over the top cell's floor for 300 ticks, the model agrees with 0 corrections).
   It is not planned. Getting out over a lip needs a dig or a placed step (not done).
5. **A body in water never idles.** While a plan or a corridor is awaited the navigator holds the body's depth
   (jump while sinking); the follow controller holds the jump key in water whenever the navigator is idle
   (treading water at the surface), keeps `close` 1 block wider and for 10 ticks after the body bobs out of the
   physics test, and counts a reached plan as settled within the stop distance + 1. Measured on bds-fly behind a
   second client moved across a pool: before, the bot sat on the pool floor (air 255 to 175 in 4 s); after, it
   stayed at the surface 3.0 behind the target, air 300.
6. **`near` goals in and under water.** A `near` goal around a point in water is reached at a surface node
   within its radius (a swimming player); around a point under the surface (its cell and the one above water: a
   pool-floor waypoint, a player diving) at a dive node too, when the stretch there plus the way straight up to air
   fits the budget without its 60-tick minimum (never under a roof).
7. **Coarse prices for water** (`coarse/costs.ts`): `SWIM_TICKS` 10 a block (was 3 x 4 = 12; the fine planner
   swims at 8.6 on the surface and 10.5 under water), `SWIM_CLEARANCE` 2 x 1 for openings into, out of or between
   water volumes without a floor. The layer's types are unchanged.
8. **A water course in the truth pack** (`truth:water`, `packs/truth/src/water-layout.ts`, shared with the unit
   tests): pool2, pool6 (with a floor start), a 1 x 1 column 8 high, a waterfall to a shelf, a lip with a step,
   a 3-long sump. Built so the server's flow cannot change them (a water face towards air beside other water
   flows out at once: measured), with the waterfall's flow listed cell by cell (`setblock flowing_water` falls
   2 wide: measured). The e2e compares the bot's world with the layout.

## Consequences

- **bds-fly e2e, every station done, health 20, air never under 236**: pool2 and pool6 120 ticks, column 101,
  waterfall 136 (1 correction of 0.20: the waterfall lifts faster than the model), lip 100 (out at the step),
  tunnel 118, pool6 from its floor 101, from the bank to a point on its floor 88; follow through a pool on the far
  bank after 13.1 s. The model's closed loops match within a few ticks.
- **The owner's cave offline** (F5a's fixture and walk harness, route A, 22 legs): 15 walked before, 19 after;
  every leg that starts or ends in the cave's water now walks. The 3 left fail dry (a step the cache reads as 2
  high, a 21-high climb, a 14-block drop).
- **Not modelled, so not planned or only approximately**: the flow push (swimming against a current on the
  surface, the waterfall's extra lift), sprint-swimming and the swim pose (1-high gaps), bubble columns.
- **Open**: a way out over a 1-block lip (dig or place a step: done by digging, W2 below); an explicit `plan(goal, from)` with `from` in
  water finds no start node (`locateNode` without the body's state); the coarse layer cannot tell surface from
  submerged water, so a corridor may lead into a sump the fine planner refuses for air.

## W2: digging out

Date: 2026-11-06. Status: accepted (Track W2). Guide: [../pathfinding.md](../pathfinding.md) "Digging out of
water (Track W2)". Module: `nav/digout.ts`.

**Context.** W1 left a pool whose only rim is a lip (a bank 2 above the top water cell), or a taller bank, with no
way out: a swimming body does not climb it on BDS. The owner's decision: break out, not place.

**Decisions.**

1. **The step is a planner move, in the same search** (`PathOptions.digOut`, on for every goto when the dig action
   is wired: `Navigator.digOut`, default true). From a surface swim node: the lip beside it and the head room over it
   are broken, the body climbs out onto the block at the water's level (the W1 `swimOut`). Priced as the server
   breaks from the water (`WATER_DIG_FACTOR` 5: measured, the off-ground modifier) + the dig penalty per block +
   `DIG_OUT_PENALTY` 200, so a swim exit wins unless it is far longer (about 40 blocks of swimming for a grass lip by
   hand). Rejected: a fallback goto with `allowBreak` after a failed plan (it would dig anywhere on the route, and
   could not weigh a far swim exit against a near dig); digging only when `allowBreak` is on (off by default: the
   bot would stay in the pool).
2. **A taller bank is cut as a staircase, and nothing else is dug.** The step's node (and a node a plain `swimOut`
   reaches) starts a stair: from its nodes only, jumps with breaks (`ascend`) are planned without `allowBreak`, up
   to `DIG_OUT_MAX_STEPS` 8. The stair's step count rides on the path (`PathNode.cut`) so a re-plan on the stair goes
   on up it.
3. **The break rules hold, plus a tool limit.** Every cell passes `breakBlocker` (protected and built blocks,
   containers, beds, the protected area, a liquid beside it, a gravity block above it, the blacklist); a cell the
   best tool takes longer than `DIG_OUT_MAX_TICKS` 200 to break from the water is refused ("no tool": stone by hand
   is 750; dirt, grass and sand by hand 75 to 90 are allowed; stone with a wooden pickaxe 115).
4. **From the surface only, with the air kept.** The step is planned from a surface node (the eye out of the water;
   from under water the server breaks 5 x slower again and the air runs). The navigator treads water while it
   digs, starts no dig while the head is under (waits 40 ticks, then gives the step up) and plans again after every
   break (water that flowed into the cut, a changed rim).
5. **The Digger is told the conditions.** `NavActions.dig(p, { conditions })`: a dig from water passes the
   off-ground (and in-water) modifiers so the Digger's expected ticks match the server (without them its timeout,
   1.5 x the dry ticks, ends a dig the server is still running: grass 27 against 90).
6. **Trapped is reported.** A search from water that finds no way carries the refused steps by reason
   (`PathResult.digOut`); the goto's reason says it: `trapped in water: no swim exit and no step to dig (stone: no
   tool breaks it in time x 20; ...)`.

**Consequences.**

- bds-fly e2e: a grass lip by hand out in 147 ticks (1 block), a stone lip with a wooden pickaxe 168 (1), a 3-high
  bank by hand 318 (6 blocks, the stair); a stone lip by hand and a stone-brick rim with an iron pickaxe refused at
  once with the reason; air never under 300, health 20, 0 corrections, no water in any cut.
- The probe matched the break-time table x 5 exactly for a body treading water (grass 90, stone 113 / 38 with a
  wooden / iron pickaxe) and the in-water modifier with the head under (dirt 75).
- **Not done**: a dig from under water (every candidate cell is next to water, which the rules refuse); a step at
  the water's own level; a 2-high sand or gravel bank (the gravity rule); placing a step; a setting for `digOut`
  (a navigator field only).
