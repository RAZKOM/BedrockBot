# 0056: The flight envelope measured, and the model fixed to it

Date: 2026-11-05. Status: accepted (Phase 7, flight v2 Track F0; builds on [0042](0042-elytra-flight.md),
[0047](0047-flight-landing-v3.md), [0054](0054-glide-down-and-ledge-takeoff.md) and
[0055](0055-terrain-safe-cruise.md)). Server: BDS 1.26.60.6 (`bds-fly`, udp/19204, strict movement).
Details: [../flight-envelope.md](../flight-envelope.md).

## Context

Flight v2 plans manoeuvres the bot never flew: yaw snaps and the 180 brake, a hover, stacked rockets,
short bursts, vertical starts, wall slides, touch-and-go, soft landings, threading a hole. The glide
formula was measured on steady glides and boosts only. A manoeuvre the server does differently costs a
correction (the server's position overrides the model's) or a hit, and the planners would plan on the
wrong body.

Three things were already known to be loose: the rocket's burn (the model boosted 15 ticks, the real burn
varies), a second rocket while one burns (never flown), and the glide request on a jump (the model starts
the glide on any airborne tick).

## Decisions

1. **A measurement harness, not one-off probes** (`bot/test/e2e/fly-envelope-*.ts`). A script gives the
   control per tick; the truth pack samples the server's state every tick (`truth:glidelog`, with the
   rotation, the health and the rockets near the body); the model is stepped from the server's state and
   compared tick by tick; corrections, glide flags, rockets and hurts are recorded; every run's JSON is kept.
   The suite flies near the origin (float32 positions 60 000 out step by 0.0078). Its default case is a
   quick smoke check; `FLY_ENV=all` measures the whole envelope (about 90 minutes). New manoeuvres get a
   case here before a planner relies on them.
2. **The boost lasts until the rocket's removal.** The burn is 9 to 21 ticks (n 175, mean 15.7) and
   nothing on the wire tells it in advance. `InputLoop.boost()` now boosts up to `GLIDE.boostMaxTicks`
   (22) and `endBoost()` (on the remove_entity) cuts it `GLIDE.boostEndLag` (2) inputs back, the measured
   latency, also when the model's own counter already ran out after the real end. The correction 30 ticks
   after a rocket fell from up to 0.6 blocks to at most 0.041. `GLIDE.boostTicks` (15) stays the planning
   nominal.
3. **`state.boostTicks` is the expected ticks left** (`boostTicksExpected`: the nominal minus the ticks
   burnt, then the measured tail), at least 1 for as long as the model boosts. The planners read it
   unchanged; "burning" (`> 0`) now means "until the removal".
4. **A second rocket extends, never restarts or doubles.** Measured: the union of the two lifetimes, the
   push of one. The loop keeps the longer of the two counters; the boost ends with the last removal.
5. **A refused glide request is taken back, and the known refusal is never sent.** BDS refuses
   `start_gliding` on the first airborne tick of a jump (vy 0.42, 4 of 4) and takes it from the second
   (vy 0.33) on (24 of 24). The loop sent the request once, so a refusal left the model gliding and the
   server falling. Now a request on the input right after a jump waits one input, and a request with no
   `gliding` flag after `GLIDE.confirmTicks` (10) inputs is replayed as a fall (`GlideEvent.refused`), the
   next airborne input asking again.
6. **No boost for a rocket used before the glide.** BDS makes no rocket entity for a use on an input the
   body enters without gliding, also on the input that starts the glide (4 of 4; from the next input on
   it works, 6 of 6). The loop boosted the model there and drew corrections of up to 8.9; now it drops
   the boost unless the body glided entering the input.
7. **Damage helpers, measured** (physics.ts): `wallImpactDamage` (10 x the horizontal speed lost minus 3,
   17 of 17 walls) and `glideFallStep` (the fall distance resets on a gliding tick that starts above -0.5;
   with fall/damage.ts `damageForCounted` 15 of 15 touchdowns exact). The movement model is unchanged for
   walls, ceilings and holes: it was already exact there.
8. **Soft blocks stay out of the glide model.** Slime (an 11-block bounce), powder snow and cobweb (the
   glide flag stays while the body stops), honey (a shorter slide), scaffolding, ladders and vines (they
   end the glide and catch the body) cost corrections. The
   flight lands on ordinary blocks and water, which the model does exactly; the manoeuvre code avoids the
   others.

## Consequences

- The unit tests (`bot/test/unit/skills/flight-envelope.test.ts`) pin each change and the two damage rules.
- The controller's `loop.boost()` and `loop.endBoost()` calls keep working unchanged; they now carry the
  measured defaults. A controller that stacks rockets has to end the boost on the last rocket's removal.
- A glide request the server never answers costs at most 10 ticks of a wrong model, then a new request.
- Offhand rockets are no option (no rocket through `item_use`), and a boost cannot be cut short (a slot
  switch does not).

## Not done

- The removal's lag and `confirmTicks` are measured or guessed on a local BDS; a Realm's latency is longer.
- No model for the soft blocks.
- No change to the brain's manoeuvres (Track F1) or the planner (Track F2): [../flight-envelope.md](../flight-envelope.md)
  "What this means for manoeuvres" is their input.
