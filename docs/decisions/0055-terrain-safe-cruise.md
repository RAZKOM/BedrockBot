# 0055: Terrain-safe cruise, dive descent, takeoff sites and the walk re-check

Date: 2026-10-31. Status: accepted (Phase 7, wave 11 Track BL; builds on [0042](0042-elytra-flight.md),
[0047](0047-flight-landing-v3.md) and [0054](0054-glide-down-and-ledge-takeoff.md)). Server: BDS 1.26.60.6
(`bds-fly`, udp/19204, strict movement) and the Realm. Details: [../flight.md](../flight.md) "Terrain-safe
cruise", "High cruise", "Dive descent", "Takeoff sites", "Flight re-check on long walks".

## Context

The Realm flights out of home (123 54 -49) kept ending 250 to 340 blocks out at y 98 to 140. They ended as
`roof`, `landed_off` or `lost`, with the body against a mountainside. The logs of 2026-10-30/31 show two
causes:

- **The economy sank into known mountains.** The cruise rule lets the body sink along the glide line to
  the approach entry. The line ignored the terrain between, so the body slid down into a ridge the cache
  knew (`0 unknown` columns on the line). `steerClear` saw the wall 20 ticks ahead, too late to climb.
- **Unknown was air.** The cruise height counted unknown columns as the highest known one. The brain's
  obstacle check made unloaded cells air. At chunk edges the server holds the body (z 656.30 and 832.30,
  both chunk borders). It had not loaded the next chunk, and the local model ran about 9 blocks ahead for
  about 9 s.

The Realm flights that went above y 320 (00:04Z, max y 389, 4 corrections) show BDS accepts flight over
the build limit.

The owner also asked for three more changes:

- a faster descent than the 0.15 to 0.2 b/t circle;
- walks that keep looking for a takeoff while they walk;
- a real search for a takeoff site, in place of walking towards the goal until the sky opens.

## Decisions

1. **The terrain floor** (`fly/terrain.ts`). Every column under the next 200 blocks of the heading is
   classed as live (the model), cache (the world cache) or unknown.
   - A known column needs `top + 1 + clearance + distance / 10` at the body.
   - An unknown column is assumed to stand at `knownMax + 24`, rising a quarter block per block beyond the
     last known column.
   The cruise and the climb never fly under this floor. A floor rising faster than a rocket climb can
   follow makes the brain choose a detour heading. A floor that is lifting the cruise logs one line; its
   end logs another, with the height gained and the rockets spent. The floor is recomputed every 4 ticks
   from a memo that forgets a chunk's columns when the chunk arrives.
2. **Unknown is not air in the cruise height.** `cruiseHeight` adds 24 when any column on the line is
   unknown. `strictObstacle` treats cache-only columns as solid up to their top and unknown columns as
   solid up to the assumed top. The dive and the takeoff simulation use it. The path-ahead check keeps the
   live model, so it does not steer at phantoms.
3. **The high cruise** (`flyHighCruise auto|always|off`). The cruise flies at y 328 or higher, above
   everything.
   - `always`: on every flight.
   - `auto`: only on trips of 1500 blocks or more over unknown terrain whose glide needs within 40 blocks
     of that height anyway.
   The economy with the terrain floor stays the default because the high cruise costs more rockets.
   Offline: 2300 blocks from y 70 took 19 rockets high against 6 on the economy, and 1200 flat took 24
   against 7.
4. **The dive descent** (`flyDescent auto|dive|spiral`, `fly/dive.ts`).
   - The brain dives at 55 to 85 degrees, pulls out at -15 to -45, and bleeds speed at pitch -6. It hands
     over to the existing approach 48 to 72 blocks out, 3 below to 5 above the approach entry, at 1.05 b/t
     or slower.
   - The whole profile is simulated before it commits, and it pulls out at least 6 blocks over known or
     assumed terrain.
   - It aborts to the circle if the re-simulation fails or the path ahead meets a solid before the pull.
   - Corridor and overhang landings keep their approach.
   Offline, the time to touchdown fell by 3.7 to 5.5 times (100 above: 213 against 801 ticks, 300 above:
   372 against 2056).
5. **Crash notes.** When the server holds the body, the log names the cell ahead and what the model
   believed about it: live, unknown with the cache's view, or a chunk edge. A glide ended by contact
   mid-route is logged the same way.
6. **Takeoff sites** (`fly/sites.ts`, `flySiteSearch` 48, `flyPreferRatio` 1.5). When the takeoff here is
   refused, the search ranks open-sky cells within the radius in any direction by walk plus flight time.
   - Cells on a thin roof or a canopy are left out.
   - The takeoff from each candidate is simulated, up to 12. The walk to the ones that clear is probed, up
     to 6, all within 3 s. A cell next to one with no path is skipped.
   - The first candidate whose walk plus flight beats the whole walk by the ratio wins. The owner hears
     `walking N blocks to take off from X Y Z, then flying`.
   - The Track AU2 legs remain the fallback.
   - Every takeoff simulation of a flight with rockets carries the terrain columns. The climbing turn back
     towards the goal counts a hit when it enters cache-only terrain or an unknown column's assumed top.
     The jump tries every heading, 30 degrees apart.
7. **The re-check on long walks** (`flyRecheckBlocks` 24). A walk that did not fly looks again in three
   cases: every 24 blocks walked, when the kit becomes ready, and when it comes out from under a roof.
   - The cheap gates come first: the kit, the rockets, the walk process in control, no combat target,
     still over `flyMin`.
   - There is at most one search per 20 s, and none within 16 blocks of a refused takeoff for 5 min.
   - When a takeoff is found, the walk is stopped at a safe spot (on the ground, dry, not on a ladder, vine
     or scaffolding). The takeoff is checked again from there and the flight goes. If the check fails, the
     walk resumes.

## Consequences

- Flights over known ridges spend one to three more rockets and lose no flights to a mountainside.
  Offline: a ridge 100 high halfway along 1200 blocks took 9 rockets with a landing, where the old code
  ended `roof`.
- On trips over unknown terrain the cruise flies 24 blocks higher.
- The fly-descent e2e accepts a dive where it asked for the circle.
- The panel payload cap goes from 33 000 to 35 000 bytes (five settings with their descriptions).

## Not done

- No lateral dodge round a single tower. The detour picks a heading only when no climb clears in time.
- Unknown columns that stay unknown up to the body (a server that never sends the chunk) are not covered by
  the 24-block slack against a mountain over 24 high. The held-by-the-server note shows them.
- The walk re-check does not run during `follow`, only `walk` (`!goto`) and `come`.
