# 0057: The manoeuvre library and the brake / elevator landing

Date: 2026-11-05. Status: accepted (flight v2, Track F1; builds on [0042](0042-elytra-flight.md),
[0047](0047-flight-landing-v3.md) and [0055](0055-terrain-safe-cruise.md)). Server: BDS 1.26.60.6 (`bds-fly2`,
a flat fly server, strict movement). Details: [../flight.md](../flight.md) "Manoeuvres (flight v2, Track F1)".

## Context

Until now the bot could land in one way only: the flare of Track AU. The body comes in low, zoom-climbs to
the platform top with the speed bled off and settles onto it. The touchdown speed is 0.27 to 0.35 blocks a
tick, and the server slides the body 0.6 to 0.8 blocks further after the glide ends. On a 3 x 3 platform or
open ground that is fine. These cells cannot be landed on:

- a 1 x 1 pillar top (the slide runs off the edge);
- the floor of a shaft (no zoom climb fits under the rim);
- a cell under a roof 3 above (no room for the climb);
- a cell just before a wall (the slide).

Each one ended in go-arounds or in the Track BF walk landing beside the goal. The planners also had grown
three copies of the same tick loop (the path ahead, the flare profiles, the dive), and flight v2 needs a
set of manoeuvres that a kinodynamic planner (Track F2) can chain and check against the world.

The glide formula (physics.ts `glideVelocity`, which the server matches within 0.002 a tick) allows more
than the flare uses:

- **The look turns the velocity.** The heading follows the look by a tenth a tick. Looking straight back
  takes a fifth of the speed a tick: 1.05 to 0.2 in 8 ticks over 3.5 blocks. At pitch -30 the pull term
  holds the height through the brake.
- **The look pushes a slow body.** The dive term pushes along the look by a tenth of the sink: 0.015 a
  tick in a 0.149 a tick sink. Near a standstill the look is a thruster that can steer a drift onto a
  point. A look flipped by 180 degrees every tick cancels out and leaves a hover that sinks 0.149 a tick
  straight down.

## Decisions

1. **One rollout, one profile search.** plan.ts `glideRollout(body, yaw, pitch, ticks, law, check)` is the
   only formula-level tick loop of the planners. Each tick the law gives the look (and a rocket, or done),
   glideVelocity moves the body, and the checker sees the tick's move. `pathAhead`, `simulateProfile` and
   `simulateDive` now run on it. The flare's checker is `touchdownCheck`. A deterministic fingerprint of the
   flights, dives and profiles is the same before and after the refactor.
   - `ProfilePlanner<P, S>` is the profile search: it samples, hill-climbs and keeps the phase for a
     `ProfileFamily`. That family defines the parameters, ranges, free set, simulation and control law.
   - `ApproachPlanner` is the flare family on that search.
2. **The manoeuvre library** (fly/maneuvers.ts).
   - **The interface.** A `Maneuver<P>` is a pure control law with entry and exit conditions:
     `entry(s, p)` gives why it cannot start, `law(s, p)` gives the look each tick and `done` at the exit,
     and `maxTicks` caps a run.
   - **The simulator hook.** `runManeuver(m, p, state, { obstacle, target, rockets })` rolls the manoeuvre
     out on the shared rollout. It returns the state handed over, the ticks, the rockets and the cells the
     box swept. It also says how the run ended: done, landed, hit, missed, timeout or refused. `runChain`
     chains manoeuvres. This is the edge interface for Track F2.
   - **The manoeuvres.**
     - New: `brake180`, `partialBrake`, `hover` (station keeping), `creep`, `elevator`, `snapTurn`,
       `glideTurn` and `zoomClimb`.
     - Wrappers on the same interface: `flare`, `spiral`, `dive` and `verticalClimb`.
     - Interface stubs that refuse every entry until Track F0 measures what BDS allows: `shortBoost` (the
       hotbar switch), `stackedBoost`, `wallKiss` and `rocketBrake`.
   - **The station-keeping law** (`keepYaw`) is a PD law on the horizontal position. Its gains are kp 0.15,
     kd 1, vmax 0.3 a tick and band 0.04. While fast it is the brake; near the point it is the hover. From 3
     blocks off it settles in about 33 ticks, then stays within 0.05.
3. **The brake / elevator landing** (fly/brake.ts) is a second landing family on the same search.
   - **The profile.** Segments A1 and A2 are the flare's approach. Then comes K: the station keeping over
     the cell, braking at pitch `pitchK` while faster than 0.35 a tick, then sinking at pitch `pitchE` (0
     to 30: 0.149 to 0.34 a tick) until the feet touch the cell.
   - **The checks.** The checker is `touchdownCheck` without the overshoot, because the brake comes back
     to the cell.
   - **The cost.** It is the flare's `touchdownCost`, with one change for a precision cell (`precise`, or a
     target a block wide): the server's slide counts in proportion to the touchdown speed. A flared
     touchdown on a 1 x 1 top therefore costs about 6 more, and a nearly still one costs nothing.
4. **The family choice** (brain.ts, the setting `flyLandStyle`).
   - `flare` and `brake` plan only their own family.
   - `auto` (the default) plans the flare. It plans the brake as well in two cases:
     - on a precision cell;
     - when the flare's plans keep missing (3 ticks without a landing, or a cost over 35 within 30 blocks).
   - The brake is flown when its plan costs `BRAKE_BIAS` (4) less than the flare's. Changing the family
     being flown takes a further 2.
   - The choice is committed at the flare's pull-up or the brake's K, but only to a plan that lands.
   - The go-around decision uses the better of the two families.
   - On a plain platform `auto` therefore flies the flare tick for tick as before. The regression test
     checks this on four trips.
5. **Go-arounds shortened.** When the flare's plans miss and the brake's land, the brake takes over: it
   stops over the cell and comes back to it, with no rocket and no circuit. The stats count these as
   `brakeRescues`. On the fly-walk house case (retargeted while circling beyond it), the flare goes around
   once in 475 ticks with 3 rockets. The brake lands at once in 360 ticks with 2 rockets.
6. **The edges for Track F2's route planner** (fly/maneuvers-route.ts). The planner flies an edge's law
   on its own tick-exact step and sweeps it through its grid, so the library hands it the law only. Its
   interface is route/types.ts `Maneuver`: applies, control(start, now, i), at most 40 ticks, done.
   - `asRoute` wraps any library manoeuvre: the law's memory kept per start, `done` looking one tick
     ahead.
   - The brake landing comes as two manoeuvres in brake.ts: `settleOnto` (K alone) and `brakeApproach`
     (the whole landing with fixed parameters).
   - `routeLibrary(goals)` is the edge set. It replaces F2's minimal brake180, hover and settle, and adds
     the turns, snaps, partial brakes and zooms.

   On F2's landing cases (a flat cell, a 1 x 1 pillar, a 3 x 3 platform, from 24 out), the search with
   these edges lands 0.01 from the centre at 0.006 a tick in about 110 nodes. With its own library it
   lands 0.29 off at 0.22 a tick in 8 000 to 10 000 nodes.
7. **Precision goals** (landing.ts `preciseGoal`). An exact goal (`!fly <x y z>`) that is no plain floor
   becomes the target itself, provided it is dry and safe, has 3 or more of room, and a brake simulation
   lands on it:
   - from above along four bearings;
   - or, under a roof, along a corridor (`corridorsOf` with the room the roof leaves, `corridorLands` with
     the brake).

   The target carries its floor's cells and, for a shaft, its rim. A shaft is a cell walled on every side
   2 or more high. The approach entry, the glide line, the cruise height, the go-around height and the
   dive are flown over the rim (`entryTop`). `stillLandable` checks a precision cell for dryness and room
   only. Track BF's walk-landing search also counts the overhang cells that only the brake lands on, and
   marks them precise. `flyLandStyle flare` keeps the Track BF search unchanged.

## Consequences

- **Offline (stepBody, two seeds each).** The brake lands within 0.06 of the centre with a touchdown under
  0.02 a tick on these cells:
  - a 1 x 1 pillar;
  - the floor of a 2 x 2 and of a 1 x 1 shaft 10 deep;
  - a cell before a wall 6 behind.

  Under a roof 3 or 4 above, it lands within the floor's cells at 0.3 or less. The farm replica (brake)
  lands on the platform under the box. With the flare, the shafts end in four go-arounds and a landing off
  the cell. The pillar flare touches down at 0.35, which the server would slide off.
- **On bds-fly2** (`fly-maneuver.test.ts`, every case twice; the table is in flight.md). All 14 landings
  were on their cell with 0 damage:
  - the pillar, the two shafts, the roofs 3 and 4 above, the wall case and the farm replica;
  - 13 of them stood within 0.10 of the centre. The roof-3 run that came in along the corridor at 0.30 a
    tick slid to 0.59 off, still in the floor's cells;
  - 2 of the 14 went around once (the roof-3 corridor entry too high and fast; a brake stopped 11 out
    before the wall) and landed on the second approach.

  The server accepts the flip of the look every tick and the one-tick 180-degree snaps, with 1 to 7
  corrections a flight.
- **CPU.** The brake planner runs about 33 simulations a tick, under 1 ms a tick on average and 11 ms at
  most. In `auto` it runs only on precision cells and while the flare is missing.
- **For Track F2.** The manoeuvres are the edge set; `runManeuver` is the edge's rollout and its world
  check. The stubs have the shapes F2 will need once F0 reports.
- **The panel caps.** The setting `flyLandStyle` takes the unit test's worst-case page from 159 715 to
  160 349 bytes and the `/api/state` payload from 34 816 to 35 066. The caps go from 160 000 to 164 000 and
  from 35 000 to 36 000 bytes.
- **Model.** No change to physics.ts was needed. The open questions for Track F0 are listed in flight.md:
  - the hotbar-switch boost cut;
  - whether rockets stack;
  - the wall-kiss threshold;
  - whether the hover's flip every tick holds over long sinks.
