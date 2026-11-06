# 0068: The real-cave benchmark and no flight from water (flight v2, Track F5a)

Date: 2026-11-06. Status: accepted (flight v2, Track F5a; builds on [0067](0067-long-range-flight.md) (corridor
flight, Track F4b), [0066](0066-coarse-layer.md) (the coarse layer) and the world cache, [../world-cache.md](../world-cache.md)).
Details and numbers: [../flight.md](../flight.md) "Real-cave benchmark (Track F5a)".

## Context

The corridor flight of Track F4b was measured on made-up worlds: a straight 3 x 3 bore, one bend, a chamber. Its
first real cave (the owner's, on the Realm, 2026-11-06) went wrong in ways none of them showed: the underground
legs are short (6 to 43 blocks between the owner's waypoints), bend every few blocks, have water floors, and part of
the way (a shortcut) can only be flown. And one takeoff was planned and flown from a body standing in the cave's
water: the local model glided where the server would not, the climb fired 20 rockets into a glide the server never
confirmed and the flight ended `no_glide`.

A made-up world cannot stand in for that cave, and a server test cannot be run on the Realm. The bot's world cache
holds what the bot saw there. The cave is private: its coordinates and names must never be in the repository (it is
public).

## Decisions

1. **A real place comes from the world cache as a private fixture.** `world/cache/export.ts` writes a box of a cache
   as one compact file (the 2-bit classes packed and deflated, the chunks the cache never saw listed, optionally the
   highest solid block of every column of a wider rectangle). It is generic (any cache, any box, any dimension) and
   read-only (the cache opened `readOnly`, the file to stdout), so it runs on the deploy host through ssh from stdin
   without writing anything there. The file and the bot's waypoint file go to `bot/fixtures-private/cave/`
   (git-ignored; `CAVE_FIXTURE_DIR` points elsewhere). Everything that reads them skips without them. Nothing
   committed names the place or a coordinate of it.
2. **One reading of the extract for every consumer** (`corridor/cave.ts caveWorld`): the route planner's grid, the
   step model's block query, the coarse layer's chunk source and the walk navigator's terrain are the same cells.
   An unknown chunk is solid, outside the box is solid sideways and below and open sky above, an avoid cell is
   solid, water is water (a source block's height). The cache rounds a partial block (a slab, stairs, a path) up to a
   full cube, so a step of half a block reads as a whole one; that is the fixture's limit, not the code's.
3. **The offline bench flies the live code** (`corridor/cave-bench.ts`, `scripts/cave-bench.ts`): the corridor
   executor with `underFly` on (the coarse layer over the extract, the stretches and windows, the TrackerChain on
   stepBody, the walks through the navigator in a closed loop), each leg as one window, the whole route as one
   window, and the walk-only baseline. Every flight runs over every burn of F0's range (9 to 21 ticks, the end told 3
   ticks late) and two planner budgets: the live 600 ms / 40 000 nodes and a generous 3 000 ms / 200 000. Scored per
   leg: done, hits, damage (F0's wall damage), rockets, ticks, the least clearance, partial plans. The script forks
   worker processes and prints markdown tables, so F5b measures a change on the cave in one command.
4. **The cave is rebuilt on a test server** (`truth:cave`, `packs/truth/src/cave.ts`): stone over the box, then
   the air and the water as greedy boxes (`cave-layout.ts`), sent from the test in parts of at most 1 800 characters
   and built under ticking areas (course.ts `build`). The cells come with the messages, never from the pack. The
   replica keeps the real heights and moves in x and z by a multiple of 16, so its cells sit on the same chunk grid.
   `fly-cave.test.ts` (bds-fly2) builds it, flies the trip in from home with today's behaviour, walks route A and
   flies routes A and B with `underFly` on; measured, gated only on every run completing.
5. **No flight from water.** Every takeoff family asks `takeoffWet` first (`skills/fly/takeoff-water.ts`, from
   `commands-fly.ts takeoffFor`): a body with water anywhere from its feet to its head (no inset), or the input
   loop's own water flag, is refused with "swim up and stand on dry ground first". The flight controller refuses to
   start a flight from water (`in_water`), and stops firing once `UNANSWERED_ROCKETS` (2) rockets have gone without
   the server ever confirming the glide (the takeoff then ends `no_glide` on its own timeout).
6. **Measurement switches stay per task and default off.** `setCorridorUnderFly(task, on)` (registry.ts) lets a test
   fly the underground stretches of its corridor trips; the executor's `UNDER_FLY` default is unchanged.
   `FlyControl.corridor(goal, label)` runs a corridor trip to a cell at any distance (the cave's legs are short; `!fly`
   takes the corridor only past 96 blocks).

## Consequences

- A flight change can be measured on the cave that broke it, offline in minutes and on a server in about an hour,
  without the Realm and without the cave leaving the owner's machine.
- The fixture is only as good as the cache: partial blocks are cubes, the cells of a chunk are as the bot last saw
  them, and a chunk the bot never saw is stone. The replica's ground outside the box is the flat world's.
- The water guard refuses takeoffs the old code tried; the walk out and the takeoff-site search take over. Getting
  out of the water is the walk navigator's job, and it has problems there (flight.md lists them for its owner).
