# 0050: Glide down when the walk has no way on; take off by stepping off a ledge

Date: 2026-10-31. Status: accepted (Phase 7, wave 11 Track BH; builds on [0042](0042-elytra-flight.md) and
[0047](0047-flight-landing-v3.md)). Server: BDS 1.26.60.6 (`bds-fly`, udp/19204, strict movement).
Details: [../flight.md](../flight.md) "Glide down and ledge takeoff".

## Context

Before this track, a walk to a goal far below could fail with nothing more tried. A pillar, a cliff top, or
the owner's farm platform 135 above home all ended `unreachable` or `no path (exhaustive search)`, even
though the bot carried an elytra. Short goals under `flyMin` never asked autoFly at all. A flight with no
rockets was refused outright, although a glide down needs none.

The takeoff always jumped. The Realm logs of 2026-10-31 showed what went wrong:

- 04:34Z, the farm platform under the spawning box. The sky check refused the jump (correctly: the box
  overhangs the platform). walkOut then picked an "open-sky cell" on top of the box (y 176) that no walk
  reaches, and the walk failed.
- 04:46Z, a `roof` end came down into a tree canopy and left the body in the crawl pose. Every goto
  failed with `no standable node`.

## Decisions

1. **Glide-down fallback.** A `pve.walk` / `pve.come` result of `unreachable`, `no progress` or `no path`
   triggers a look for a glide down, under these conditions:
   - the goal is `glideDownMinDrop` (10) or more below and `glideDownMinDistance` (16) or more away;
   - the elytra is ready (rockets optional);
   - the bot is in the Overworld, on the ground, and not fleeing, guarding, fighting a fire, surfacing or
     holding a combat target.

   The landing is findLanding's (a dry cell with a confirmed walking path). The **whole flight is simulated**
   from each candidate ledge with the brain on stepBody over the live world model. The first one that lands
   on the landing's cells, dry and with no collision, is flown, and the walk finishes the command. If none
   works, the owner is told why and the walk failure stands. The planner's own reason (`GotoReport.why`)
   goes into the log line. Goals above the bot never glide.
2. **Ledge takeoff.** An edge counts when:
   - the drop is 12 or more;
   - a corridor 3 wide and 3 high is free for 10 blocks along the heading (no wall, no overhang);
   - nothing under the first 4 blocks of the fall is closer than the drop.

   The FlyProcess walks to the edge cell. The brain sneaks to the rim, releases the sneak, requests the
   glide as the fall begins, dives at pitch 20 until 0.7 blocks a tick, then climbs or cruises. It is used
   for every glide down. It is also used for flights when the jump takeoff is refused or the start is a
   small platform (`flyLedgeTakeoff`), after a 300-tick simulation of the ledge.
3. **The jump takeoff is simulated** on candidate headings. A heading that needs no steering through its
   climb is preferred, so a canopy across the sky's heading picks another way. When every heading meets a
   solid, the bot walks outside first.
4. **walkOut legs are probed** (`probePath`) before they are walked, at most 6 per leg, so a roof top is
   never a leg.
5. **Prone recovery.** The InputLoop tracks the server's crawl pose (`crawling` / `swimming` flags,
   `boundingbox_height` under 1). An unreachable goto while prone works through these steps:
   - break the cells over the body, leaves first, under the navigator's break rules;
   - wait for the stand;
   - replan once;
   - if still boxed in, replan once more with `allowBreak`.

   FlyProcess runs the same recovery after a landing.
6. **No foliage under an emergency or `roof` landing.** `groundAt` skips leaf, azalea and vine tops.

## Rejected

- **Gliding without a full simulation (a glide-ratio estimate only).** The cliff case showed that the
  brain's own phases decide the reach. Before this track, climb() entered the approach 25 blocks high
  within 62 blocks and landed 13 short. A fixed ratio would have accepted that glide. The simulation
  caught the bug, which is now fixed: a body too high for the approach cruises into the descent geometry,
  and a hopeless approach with no rockets circles down again, at most twice.
- **A crawl move in the planner.** That would mean a whole new body height in astar / grid, which are out
  of bounds for this track. Breaking the head cells, under the same break rules as any dig, covers the
  observed cases.
- **A steep ledge dive** (pitch 40). It costs 17.7 blocks of drop to reach speed, against 8.7 at pitch 20.

## Consequences

- A small platform (3 x 3 pillar) start now always steps off an edge, also for `!fly`. fly-descent's pillar
  starts take the ledge takeoff.
- `GotoReport` has a `why` (the navigator's reason for a failed goto). This is the one additive navigator
  line of this track.
- `BotSkills.goto` has a third retry after the swim-up: `unproneAndRetry`.
- Four settings: `flyLedgeTakeoff`, `glideDown`, `glideDownMinDrop`, `glideDownMinDistance`.
