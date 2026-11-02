# 0042: Elytra flight: a model-predictive landing on a vanilla glide model

Date: 2026-10-30. Status: accepted (Phase 7, wave 11 Track AU; the second half of "Elytra, Nether and End").
Server: BDS 1.26.60.6 (`bds-fly`, udp/19204, strict server-authoritative movement). Details: [../flight.md](../flight.md).

## Context

The owner named elytra flight the most important part: the bot has to land precisely on blocks high
up, such as a creeper farm platform, ideally with little to no damage, use fireworks efficiently, keep
the shulker box of fireworks the owner gives it, and ask for more when low. The bot plays on the owner's Realm with other players, so the flight may only do
what a vanilla client does: yaw, pitch, the jump key, the glide request and a firework in the hand.
Track AT had left the packet questions open (which flag starts a glide, how the boost arrives).

## Decisions

1. **The glide is a mode of the own physics engine, measured to the server's float32.** `stepBody`
   grows a third branch (`state.gliding`, physics.ts `GLIDE`, `glideVelocity`): the vanilla
   fall-flying formula, the firework boost applied inside the step before the drag (measured: this
   order matches the server within 0.001 per boosted tick, the Java order is off by 0.01). Level
   flight runs 220 ticks on the strict server with 0 corrections; the only systematic mismatch is
   the rocket's life (12 to 18 ticks against a nominal 15), which `endBoost` repairs when the
   rocket's `remove_entity` arrives. The glide starts with `start_gliding` sent together with a jump
   press on an airborne tick (the flag alone and `player_action start_glide` are ignored), is
   confirmed by the own `gliding` actor flag, and ends only on ground or water contact: BDS ignores
   a voluntary `stop_gliding` in the air, so the model does too and a landing is always a touchdown.
2. **The landing is planned every tick by simulation, not by a fixed glide path.** The zoom climb
   of a pull-up grows with the square of the speed (from 0.9 blocks a tick a -60 flare climbs 0.4
   blocks, from 1.2 about 7, from 1.6 about 20), so no constant-pitch approach lands softly. The
   `ApproachPlanner` keeps a four-segment profile (an approach pitch for some ticks, a second one to
   the flare point, the flare pitch until the top of the climb, a settling pitch) and re-optimises
   it every tick from the real body with seeded random samples and a hill climb over the glide
   formula (about 180 simulations on a cold start, 60 afterwards, 4 to 12 ms). It flies the first
   tick of the best plan. The cost rewards a touchdown near the centre under 0.3 blocks a tick both
   ways and penalises the slide, the time and anything that misses; blocks of the world model along
   the simulated path count as wall hits (the body's 0.6 box, checked twice a tick). A plan that
   does not land for six ticks within 45 blocks, or a hard one near the platform, means a go-around.
3. **Energy before geometry.** The cruise height comes from the columns under the straight line
   (`flyClearance` above the highest known; unknown columns count as the highest known) and from
   what the glide down to the approach entry needs, with the distance the climb itself covers taken
   off; the climb stops firing when the body's momentum (vy²/0.08) will reach the cruise height and
   the climb pitch adapts to the climb; the last 40 blocks before the approach bleed the speed to
   about 1.05; far too high near the target the body spirals down (a level circle sinks 0.15 blocks
   a tick without going anywhere). The same spiral is the emergency landing's descent (`!fly stop`,
   `!land`, low health, a worn elytra): from a platform flight's cruise it takes 11 to 14 s, from a
   ground flight's about 7.
4. **A predicted landing is confirmed by the server.** The flight ends when the body has stood ten
   ticks without a correction lifting it; a touchdown the local model saw but the server did not (a
   wall's edge, a prediction a block off) is a "bounce" and the brain flies on (the approach again
   near the target, the nearest safe ground otherwise). Without this one early flight ended in the
   model on the platform while the server's body flew on and fell 40 blocks.
5. **The flight owns the body in the air.** A `flight` auto process at priority 101 (above flee)
   wants control from the takeoff to the body standing; flee, defend and the night retreat wait for
   the landing, which the controller itself forces when the health drops under `fleeHealth`, the
   elytra reaches `toolWearLimit` + 20 uses (it breaks in the air at 0) or the owner says stop. The
   ground work (the refill from the fireworks box, the elytra on in place of the chestplate, the
   chestplate back) is the user process `fly` at 40, cancelled and resumed like any command.
6. **The flight kit is sacred, and the owner is asked for more.** The elytra, the firework rockets
   and the fireworks box (any shulker box holding rockets only, or the one named with `!fly box`)
   are never dropped by the keeper, never stashed, never unloaded, never the stash box, and kept by
   `!drop all` and `!drop items` (the reply says so; `!drop flightkit` drops them). With fewer than
   `fireworksMin` rockets in the hotbar the box is placed, emptied into the hotbar up to a stack and
   picked up again (the stash primitive), before a flight and after a landing, never in the air.
   When the box is empty too the owner hears `fireworks low: 9 rockets left and the box is empty;
   give me more (drop them or !bring fireworks_rocket 64)` once per count; a worn elytra gives
   `elytra worn: 25 uses left; I will not fly until it is mended or replaced` and `!fly` refuses.
7. **`!come` and `!goto` fly over `flyMin` blocks** (default 200) when `autoFly` is on and the kit is
   ready, and walk the last metres after the landing; in the Nether only under a clear ceiling along
   the line (the loaded columns), else they walk.

## Consequences

- Measured on bds-fly (docs/flight.md "Measurements"): 10 of 10 landings on a 3x3 platform 40 blocks
  up and 150 blocks away stood on the platform, 0 damage in every run, the server's body 0.7 to 1.0
  blocks from the centre (the local model's touchdown 0.05 to 0.3: the server's body slides about
  0.7 blocks further after the glide ends), 3 to 5 rockets and 8 to 22 s per flight; a 300-block
  flight to a 5x5 platform took 2 to 4 rockets; the descending approach from 60 above 1 rocket.
- The precision gate is met by the planner alone; the remaining variance is the slide after the
  touchdown (the server keeps the glide one or two ticks longer than the model) and the rocket's
  random life. Both are measured, not modelled.
- Open: mending by XP (a repair chore), the End (the void: a glide there is never started), riding
  the wind (no weather model), the Nether ceiling check only sees loaded columns, a glide started
  from a ledge without a jump is not used (the takeoff always jumps), the damage of a wall hit is
  avoided by the planner but not by a lateral dodge (a go-around is the only evasion).

## Addendum (Track AU2, 2026-10-30): roofs, the rocket economy, the descent geometry, fly then walk

The first day on the Realm (docs/flight.md, the note at the top): an indoor takeoff flew into the roof
three times and ended by health; a 1490-block flight landed on the spot but spent 17 rockets. The
owner reported that it took off indoors and nearly killed itself flying into the roof, that it was very
wasteful with fireworks, and suggested a spiral to slow the landing where the geometry allows. Measured before modelled (the glide polar and what a
rocket buys, docs/flight.md "Physics"), then four decisions on top of the seven above:

8. **No takeoff under a roof, and the path ahead is checked in the air.** Before the jump the 3 x 3
   columns over the start and the first `flyTakeoffRun` (12) blocks along the heading must be free up
   to the cruise height in the world model, an unknown cell counting as a roof (the opposite of the
   cruise's `skyQuery`: a ceiling the model has not loaded is still a ceiling). A roof refuses `!fly`
   with `fly: no open sky here (roof at y 72, 3 blocks up); walk outside first`; `!goto` / `!come` walk
   towards the goal in legs of `flyRetryBlocks` (32) and try again after each. A blocked run (a tree)
   turns the takeoff heading instead. In the air the brain simulates the next 20 ticks of the glide
   against the model's solid cells every tick and levels off or turns when a solid is ahead; when
   nothing clears, the flight ends on the ground under the roof as `roof` (a stall landing looking
   down from the body for the ground), never by health.
9. **Height is the currency: climb once, glide, top up only when the glide falls short.** The glide
   polar is nearly flat (level 10.1 blocks per block of height on the formula, 8.7 at pitch 20): a
   dive sheds no height, speed decays, but height is kept. A rocket pitched up at −38 buys 31 blocks
   (310 of glide), level 25 blocks of distance, and a rocket levelled off while it burns loses the
   climb (the boost steers the velocity onto the look). So the cruise height is what the glide down to
   the approach entry needs plus a margin (`flyMargin`, 15 from 600 blocks on, less for shorter
   glides, none under 150), capped `flyMaxClimb` (120) above the start, and Track AU's `flyCruise` cap
   is dropped (it made every long flight cruise 25 up and boost level every 100 blocks). The cruise
   fires only when the projected height is under the glide line plus the margin, pitched for the
   height the rocket should buy, and never for a cap. The model takes the Realm's flight from 17
   rockets to 9; bds-fly: 300 blocks 2 (before 1), 600 4 (5), 1200 8 (13). The rockets are quantised,
   so arriving a rocket's worth high is normal and costs time, not rockets.
10. **The descent is chosen by the columns.** Arriving more than 12 above the approach entry, the
    brain comes down to 6 above the glide line first: the largest circle of radius 6 to 24 around the
    target whose columns out to the radius + 4 are lower than the exit height − 3, else a circle
    tangent to the approach line 30 to 80 blocks out (its centre a radius beside the line), else
    S-turns (70 degrees off the bearing, 12 blocks either side). The circle around the target is left
    heading at it and at least 28 blocks out; the tangent circle at its tangent point heading in, so
    the approach comes in along the line, from the open side of a walled platform (a circle centred
    on the line and left wherever the heading pointed in missed 3 of 10 walled landings on bds-fly
    after 4 go-arounds each). The go-around's height follows the same columns (7 above the highest
    within 30 blocks of the target). Track AU's drifting 12-degree spiral from 22 above is gone; the
    planner went around from 12 above in the offline trips, a circle from there costs 40 ticks and no
    rocket.
11. **Fly, then walk.** `!goto` / `!come` land on the goal only when it is landable (its column's top
    is the block under the goal, a plain solid with level neighbours, open sky above); else on the
    landable cell within `flyLandSearch` (48) with the shortest walk (the straight distance plus three
    per block of height, a bounded probe plan when the goal's chunk is loaded), saying `flying 980
    blocks to 23 blocks from <goal>, then walking`; when the goal's ground is unknown at the takeoff
    (too far to be loaded) the flight looks again within 160 blocks and retargets (`fly: landing 23
    blocks from <goal> (no landing spot on it), then walking`). The original goto / come continues on
    foot in the same command. With 8 this is the owner's case: underground to a point 1000 blocks away
    underground = walk out, fly, land near, walk in. `!fly` and `!land` move to the `more` tier:
    `!come` and `!goto` decide to fly on their own.

Consequences: docs/flight.md "Measurements (Track AU2)" (bds-fly): the rocket economy before / after,
the room and the tree, the 10 + 10 descents, the pit and the house. Open: the sky check sees only
loaded cells (a far cruise height above the loaded subchunks refuses a takeoff in the open: the
message says where); the S-turns are the offline fallback only; a landing cell is ranked by a probe
plan only when the goal's chunk is loaded.
