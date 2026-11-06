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
- **Open**: a way out over a 1-block lip (dig or place a step); an explicit `plan(goal, from)` with `from` in
  water finds no start node (`locateNode` without the body's state); the coarse layer cannot tell surface from
  submerged water, so a corridor may lead into a sump the fine planner refuses for air.
