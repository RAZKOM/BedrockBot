# 0087: A takeoff from a floor the walk reaches (Track F15)

Date: 2026-11-14. Status: accepted; no setting (see decision 8). Builds on [0054](0054-glide-down-and-ledge-takeoff.md)
(the ledge takeoff, the glide down), [0055](0055-terrain-safe-cruise.md) (the takeoff-site search, the re-check on long
walks) and [0072](0072-reachability.md) (the walk's reach, `unreachable` and its cause). A new record rather than an
addendum to 0055: 0055's sites are cells under the open sky found by geometry; these are floors found by the walk, and
the reply when nothing is found is new. Details and numbers: [../flight.md](../flight.md) "Takeoff from a floor the walk
reaches (Track F15)".

## Context

The owner's goal: `!goto` finds a flight wherever one exists, and `unreachable` only when the place is closed.

On the Realm (2026-11-14) a waypoint lies in a small room (11 standable cells, 3 high) of a building high in the air,
about 2 260 blocks from home and 74 over it. The room is left by a ladder in a wall column up to a hatch in its ceiling.
The ceiling is a platform of about 71 cells with edges over deep air, under a wider roof 19 over it. `!goto home` from
the room ended `unreachable (world: no walk, swim or dig gets there)` after 4 s. The next day a `!goto` from the room to
a cell of the platform took 41 ticks (the walk planner climbs the ladder and opens the hatch), and `!goto home` from the
platform took off from its ledge (`28 ledges on 71 cells ... clear`) and flew home in 122 s with no damage.

Why it failed, by the log and the code:

- the ledge takeoff looks for an edge only on the floor the body stands on (`no edge on the 11-cell platform`);
- the route takeoff's flood is the air a body flies through: it climbs no ladder and passes no hatch (25 cells, none to
  the open sky);
- the takeoff-site search takes only columns' tops under the open sky within 12 levels of the feet (`0 open-sky cells
  within 48`);
- so the trip walked out towards home (the walk-out legs and the nearest open sky by walking found nothing), the walk
  found no way, the glide down from where the body stood met the same refusals, and the reply was the walk's failure.

Reproduced offline and on a test server with a made-up building of the same shape (decision 9's numbers).

## Decisions

1. **A floor the walk reaches is a takeoff site, as the trip's last try.** When the takeoff from here is refused, the
   open-sky sites give nothing, the walk-out legs end with no way on (`unreachable`, no progress, no path) and the glide
   down finds nothing either, `commands-fly.ts floorFallback` looks for floors with a ledge that the walk reaches from
   where the body stands then (`floors.ts searchFloors`), simulates the takeoff from them, and the trip walks to the
   first that clears and takes off there (the same `site` path as an open-sky site: the takeoff is decided again on
   arrival; refused there, the walk goes on, watched). Why last: any trip that flies today flies the same way, the walk
   out that finds open sky on its way included. A first version ran the search before the walk out, right after the
   open-sky sites; it took a roof under the open sky that the walk out also finds, and that trip took off 1.7 s later
   by a step off the edge in place of the jump and arrived at a median of 45.8 s against 21.0 s (its higher cruise came
   down by the spiral 7 times in 10 against 3). Last, the search costs the failed walk out first, about 1 s in the
   made-up building, as on the Realm. A search that led to a floor from which the trip did not arrive is not asked
   again within 16 blocks for 5 minutes (`FLOOR_ONCE_R`, `FLOOR_ONCE_MS`, the refused takeoffs' own radius and time),
   so no trip goes round between a floor and a failing walk; a trip that arrived leaves no mark, so the next trip from
   the same room takes the floor again.

2. **Candidates come from geometry, reach from the planner.** The standable cells within 24 blocks and from 16 levels
   under to 32 over the feet are scanned once (each column read once from the top down). A cell counts when one of its
   sides or corners opens onto 12 blocks of fall or more: `findLedges`' own test of an edge (`LEDGE_MIN_DROP`), so a
   floor that passes is one the ledge takeoff can use. The cells are joined into floors (one height, side by side); the
   start's own floor is left out (its ledges were tried already). Each floor is given to the planner as one cell, its
   edge cell nearest the feet. Why not the planner's reach itself: the search's nodes are not something the planner
   gives out (and `nav/` is not this track's to change); its `any` goal over the floors' cells gives the same answer,
   the floor the walk reaches most cheaply, in one search.

3. **One probe for all floors, then the next.** The walk is probed to all the floors' cells at once (`any` of `block`
   goals; no digging, no placing, no long falls, the planner's own moves: ladders, hatches, doors, stairs). The floor
   it reaches is tried, dropped from the goal, and the probe runs again. Ranked by the walk's own cost: within 24 blocks
   the flight from any of them differs by at most 48 blocks of a trip that is worth flying at all, so the walk decides.
   Each floor's walk must still pass the site search's rule (`preferSite`: the walk plus the flight beats walking all
   the way by `flyPreferRatio`).

4. **The takeoff there is the flight's own chain, without the route takeoff.** The simulation from the floor's cell is
   `takeoffFor` (a ledge when the sky check refuses or the floor is small, else the jump on every heading, else straight
   up), with the rockets the flight will have. The route takeoff (a powered flight out under a roof, its plans in the
   worker and its proofs) is left out of the search to keep it within its budget; on arrival the whole chain is asked
   again, so a floor the search took is never flown on less than it was proven with.

5. **Bounded.** At most 4 probes (20 000 nodes, 1 s each), 4 takeoffs, 3 s in all, the scan included, the scan
   yielding to the event loop every 256 columns and the probes in 8 ms slices. Measured on the test host under the live
   bot's CPU policy (decision 9).

6. **The route takeoff's flood is not taught to climb.** It is the air a flying body passes through. A ladder and a hatch
   are walked; the walk and the takeoff after it are what the floor search composes. One probe and one takeoff found the
   building's platform.

7. **When nothing is found the reply says so.** The walk out has run as before (the real walk may dig through natural
   ground where the probe does not, so no walk is refused on the probe's word) and found no way; the reply's note says
   the three in order: `no takeoff here (a roof 3 up) or from any floor the walk reaches (...);
   the walk: <the walk's own words>`. The floors' part is short (a reply is 256 characters): no floor with an edge
   within 24, or none of them reached (with all the walk reaches, in cells, when the probe searched it all), or how many
   were reached and why the first one's takeoff failed. The log has the whole search.

8. **No setting.** Nothing that works today is changed: the search runs only where the trip today ends with the walk's
   failure, the takeoff it takes is simulated with the same rules as any other, the walk to it is one the probe found
   without a hurting fall, and no block is broken or placed. Measured, decision 9: the roof under the open sky flies as
   before the track.

9. **Numbers** (the made-up building, the goal 300 blocks out on the ground; bds-fly, 2026-11-14, 10 trips a case):
   under the wider roof 0 of 10 flown before (`unreachable` in 1 s) against 10 of 10 after (the search from 0.9 to
   1.0 s, once the walk out has failed; takeoff 8.8 to 9.1 s, arrived 29 to 64 s); under the open sky 10 of 10 both and
   the same flight (the walk out to the roof and the jump; takeoff 4.3 to 4.4 s against 4.2 to 4.4 s, arrival medians
   21.0 s against 21.4 s, no floor search); no ladder and a roof with 11 of fall 0 of 10 both, the reply now with the
   takeoffs' note, in the same 1.0 and 1.1 s; no damage; the search 2 to 29 ms on the test host. The table is in
   [../flight.md](../flight.md). Offline (`fly-floors.test.ts`): every flight from the platform found
   lands on the goal at 10 burns from 9 to 21 ticks, no hit, dry, both under the wider roof and under the open sky.

10. **A landing where the body stands is not flown.** On the Realm (2026-11-15, 2 trips of 12) a trip that had landed at
    a cave's mouth walked on, its re-check fired out from under the roof, and the landing search gave the cell the body
    had just landed on: a flight `(1 blocks)`, no landing plan 1 out (`brake wall`), a go-around on 2 rockets, the same
    cell 15 to 22 s later, once shot by a skeleton. `autoFly` now starts no flight whose landing is within 8 blocks of the
    body by the plane and less than 12 levels above or below its feet (`landingHere`), on the first decision and on the
    re-check, and remembers the spot as a refused takeoff so the re-check does not plan again there. 8 blocks are about
    1.4 s of walking against 15 to 22 s and 2 rockets; 12 levels is `LEDGE_MIN_DROP`, so a glide down a cliff stays a
    flight. No setting: a flight that ends where it began brings nothing a working flight brings.

## Consequences

- A room in a building in the air whose roof has a ledge is left by the ladder and flown from, once the walk out has
  found no way (about 1 s there).
- Every trip that flies or walks today does so as before: the search runs only where the trip today ends with the
  walk's failure.
- A trip with no way out says so: no takeoff here, none from a floor the walk reaches, and why, before the walk's words.
- A trip that lands near its goal walks the rest; no flight goes round onto the cell it left.
- The search costs a scan and one probe on most trips that reach it; at most 4 probes and 4 takeoffs, 3 s, after the
  failed walk out.
- Not covered: a floor whose only takeoff is the route takeoff (left out of the search); a floor beyond 24 blocks or
  more than 16 under / 32 over the feet; a floor reached only by a hurting fall or by digging; a ledge shorter than 12
  blocks of fall.
