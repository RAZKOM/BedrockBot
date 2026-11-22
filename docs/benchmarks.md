# Benchmarks: the common jobs on generated ground (Track EF1)

One e2e suite runs the jobs the bot spends its days on, the same way every time, and writes one JSON row a run: how
long it took, what it got, where the time went, what failed and why. It answers "is the bot good at its work, and where
is it slow" with numbers instead of impressions, and it is how a change that should make a job faster is proven.
The rule changes that came out of it are ADR [0127](decisions/0127-benchmark-fixes.md).

- `bot/test/e2e/bench-jobs.test.ts`: the jobs, the protocol (its header), one row a run.
- `bot/test/e2e/bench-truth.ts`: the bot wired like the command line, the server set-up, the time sampler.
- `bot/test/e2e/bench-survey.test.ts`: the survey that chose the spots (run once on a fresh world).
- The counters the rows read live in the code they count: `Navigator.totals` (skills/nav/navigator.ts: gotos, failed
  gotos by reason, ticks walking / planning / acting / waiting, distance, plans and their ms, stuck, corrections) and
  `Digger.stats` (skills/dig/digger.ts: digs, done, failed by reason, ticks, the break table's ticks).

## The protocol

**The world.** A generated world, not a flat one: the jobs must meet real ground (hills, forests, caves, water). The
test servers are set up flat in their compose files, so the benchmark replaces the world's `level.dat` with one for
the default generator and seed 7 and deletes the world's `db`: the server generates the same terrain from the seed
every time. **Before every run** the world is reset that way (stop the container, delete `db`, put the `level.dat`
back, start, wait for the truth pack): every run meets the same untouched ground, whatever ran before it. The server is
made peaceful, the clock frozen at noon, the weather clear, mob spawning off, fall damage on, drops on.

**The bot.** A fresh bot each run, wired like the command line (`--task afk`): settings in memory, the planner worker,
the world cache in a new empty folder (it has seen nothing of this world), the coarse layer. It is teleported to the
run's spot, given the job's kit with the truth pack, the job's set-up is built (a field, a pen, chests), and the job's
command is typed as the console would.

**The end.** The run ends when the job's user process has been gone for 3 s (the home chore: every process), or at the
job's cap (then `!stop`; the row says `capped`). Its time is from the command to the last moment the job was busy.

**The spots.** Five spots on land under the sky with oak within 48 and coal and iron within 32 (the survey: 52 to 999
oak logs, 63 to 149 iron and 337 to 748 coal ore within those radii); two are on a mountain (feet 119 and 110), three
on rolling ground by a lake. Run i of every job is at spot i, so a job's five runs see five kinds of ground and the
same five in every arm. The walks and flights have their own pairs (from, to): 200 and 500 blocks on foot (down and up
the mountain, over the forest, round the lakes), about 1000 by elytra (949 to 1273, over forest, ocean and mountain).

| Job | Command | Kit | Set-up | Cap |
|---|---|---|---|---|
| mine-coal-stone, mine-coal-live | `!mine coal_ore 32` | stone tools / netherite tools and armour | none | 300 s |
| mine-iron-stone, mine-iron-live | `!mine iron_ore 16` | stone / netherite | none | 420 s |
| mine-diamond-live | `!mine diamond_ore 4` | netherite (a stone pickaxe cannot harvest it) | none | 600 s |
| wood | `!get oak_log 64` (any log kind counts) | stone | none | 600 s |
| get-cobble, get-dirt | `!get cobblestone 64`, `!get dirt 64` | stone | none | 420 s |
| farm | `!farm` | stone | a 9 x 9 field of ripe wheat round a water cell | 400 s |
| get-wheat | `!get wheat` | stone | the same field | 400 s |
| breed | `!breed cow 2` | stone, 16 wheat | a 7 x 7 fence pen, 4 cows | 120 s |
| unload | `!unload` | a full inventory of mined loot (34 stacks) | 4 chests round home | 180 s |
| home-chore | none (the chore, `autoUnload` on) | the same | the same | 180 s |
| bring | `!bring iron_ingot 192 home` | stone | 3 chests 13 to 14 off home (192 iron, torches), scanned first | 180 s |
| goto-200, goto-500 | `!goto x y z` (`autoFly` off) | stone | none | 300 s, 420 s |
| fly-1000 | `!fly x y z` | netherite, elytra, 192 rockets | none (bds-fly3) | 300 s |

## What a run measures

Each row (one JSON line):

- **Result**: the end line, the time, `capped`, the items gained of the job's kind (inventory counts; `breed`: the
  calves), the target, items an hour, the time to the first item, deaths, damage taken.
- **Where the time went**, every tick of the run in one bucket: `dig` (the Digger busy), `walk` / `plan` / `act` /
  `wait` (the navigator's phase: following a path or retreating; waiting for a plan or for the "why" searches; a door,
  a dig or a place of the path; holding still), `pickup` (a collect), `chest` (a container open), `job` (the job's
  process busy with none of these: planting, feeding, choosing), `idle`. The shares are of the ticks until the job
  went quiet.
- **The navigator**: gotos, failed gotos by reason, distance walked, plans and their ms, stuck, corrections,
  unloaded-world waits. **The Digger**: digs, done, failed by reason, ticks, the break table's ticks. **The miner**: its
  own stats when the job mined.
- **The pace**: what a good player needs for the same work, and the run's time over it (`slow`). The estimate is the
  break table's time for the blocks the run dug (the Digger's expected ticks / 20) plus the distance the run walked at
  a sprint (5.6 blocks a second); for a walk or a flight the straight line at 5.6. It is a floor, not a goal: a player
  walks round hills too, and a sprint is not always possible; a `slow` of 1.5 is near a player, 3 is clearly behind.
  For the farm the table's break time of ripe wheat is 0, so the floor is the walk alone; a player harvesting and
  replanting by hand does about 3 crops a second.
- **The cause** of a failed or short run: died, capped, inventory full, no tool, unreachable, timeout, stuck, short
  (fewer items than the target), not arrived.

The run's log (info and, with `BENCH_DEBUG=1`, debug lines) goes into `BENCH_LOG`, one file a run.

## How to run

The servers: any test BDS whose world can be replaced (the benchmark's own were bds-world for the ground jobs and
bds-fly3 for the flight). Keep the original world: copy `worlds/<name>` and `server.properties` aside first, and put
them back after (the reset deletes the world's `db`). The flat world's `level.dat` must be swapped for a default
generator's with seed 7: take the `level.dat` of any world BDS generated with `level-type=DEFAULT` and set its
`RandomSeed` to 7 (`Generator` is 1; the file is little-endian NBT after an 8-byte header of version and length, which
prismarine-nbt reads and writes). Keep that file outside the world folder: the reset copies it back before each run.

```sh
# one job, one run at a time (the world reset before each run outside the suite)
BDS_E2E=1 BENCH_JOB=wood BENCH_N=1 BENCH_FROM=0 BENCH_ARM=before \
  BENCH_OUT=rows.jsonl BENCH_LOG=logs BENCH_DEBUG=1 \
  pnpm --filter bot exec vitest run --project e2e test/e2e/bench-jobs.test.ts
BENCH_JOB=list ...        # prints the job ids
BENCH_BDS_PORT=19212 BENCH_BDS_CONTAINER=bds-fly3 BENCH_JOB=fly-1000 ...   # the flight
BENCH_SET=k=v,k=v ...     # settings for every run (an arm's switches)
BENCH_BUDGET=840 ...      # a run starts only when its cap fits (keeps one invocation under 15 minutes)
```

`BENCH_BDS_HOST`, `BENCH_BDS_PORT` (19142) and `BENCH_BDS_CONTAINER` (bds-world) pick the server; `BENCH_VERBOSE=1`
prints the bot's lines. A full arm is 17 jobs x 5 runs, about three and a half hours with a reset before each run.

## Reading the rows

Two corrections of the first rows of the "before" arm are made when they are read (the summary script does it, and
the harness counts the right thing since): `breed`'s yield is the calves (the first rows counted items carried, 0);
the first `wood` row counted oak logs only, while `!get oak_log` counts every log kind (its end line says how many).

The unload job's yield is not counted as items: its end line says how many stacks went into how many chests. In 1
of 10 runs the home chore began the unload before the command did (`unload started (was home-chore)`): the command
moved 22 stacks, the chore 11, in the same time.

## Results (Track EF1, BDS 1.26.60.6, 2026-11-22)

Two arms on the same five spots, every run on a freshly reset world: **before** (the base the track started from, with
the counters added and nothing else) and **after** (the tree with the track's fixes at their defaults: the near walk's
bound and the staircase's detours on). A third arm, **sprint**, ran a follower that sprinted through steps and turns
(dropped, below) on the jobs that walk most. Columns: runs done of runs (a run is done when it got its target and
ended by itself); the time from the command until the job went quiet; items each run; items an hour; `slow`, the
run's time over a player's pace (the break table plus a sprint over the distance walked; for a walk or a flight the
straight line at a sprint); the same with the 5 ticks a player waits between two blocks too (the game's break delay,
which every dig pays, the bot's and a player's); the walk's speed (blocks a second while a path is followed); the
causes of the runs not done. `n/a`: a job whose work is chest moves or feeding, where the pace is its walk alone.

| Job | Arm | Done | Time (median, s) | Each run (s) | Items each run | Items / h (median) | Slow (median) | Slow with the break delay | Walk speed (b/s) | Failed by cause |
|---|---|---|---|---|---|---|---|---|---|---|
| mine-coal-stone | before | 5 of 5 | 81.4 | 76, 94, 85, 81, 76 | 32, 33, 32, 33, 32 | 1 459 | 1.40 | 1.13 | 3.70 | - |
| mine-coal-stone | after | 5 of 5 | 82 | 76, 96, 82, 84, 74 | 32, 33, 32, 33, 32 | 1 411 | 1.38 | 1.12 | 3.64 | - |
| mine-coal-live | before | 5 of 5 | 57.1 | 50, 64, 58, 57, 52 | 32, 33, 32, 33, 33 | 2 081 | 1.66 | 1.19 | 3.69 | - |
| mine-coal-live | after | 5 of 5 | 58.3 | 50, 68, 58, 59, 52 | 32, 33, 33, 34, 34 | 2 071 | 1.68 | 1.21 | 3.60 | - |
| mine-iron-stone | before | 5 of 5 | 122.8 | 103, 123, 70, 162, 155 | 16, 16, 16, 16, 16 | 469 | 1.60 | 1.34 | 4.43 | - |
| mine-iron-stone | after | 5 of 5 | 116.1 | 66, 116, 67, 160, 154 | 16, 16, 16, 16, 16 | 496 | 1.53 | 1.27 | 4.34 | - |
| mine-iron-live | before | 5 of 5 | 97.5 | 59, 98, 54, 130, 106 | 17, 16, 16, 16, 16 | 591 | 1.73 | 1.37 | 4.37 | - |
| mine-iron-live | after | 5 of 5 | 99.3 | 56, 99, 57, 131, 107 | 16, 16, 16, 16, 16 | 580 | 1.80 | 1.37 | 4.26 | - |
| mine-diamond-live | before | 1 of 5 | 86.5 | 39, 46, 87, 93, 196 | 0, 0, 0, 0, 4 | 0 | 1.63 | 1.08 | 4.28 | short 4 |
| mine-diamond-live | after | 5 of 5 | 251 | 485, 248, 500, 251, 196 | 4, 4, 4, 4, 4 | 57 | 1.73 | 1.12 | 3.73 | - |
| wood | before | 5 of 5 | 251.7 | 449, 252, 300, 234, 144 | 68, 64, 65, 65, 64 | 915 | 2.79 | 2.37 | 3.53 | - |
| wood | after | 5 of 5 | 148.8 | 139, 149, 170, 149, 105 | 68, 66, 64, 64, 64 | 1 594 | 1.68 | 1.37 | 3.49 | - |
| get-cobble | before | 5 of 5 | 80.5 | 81, 83, 77, 80, 81 | 65, 66, 64, 65, 64 | 2 878 | 1.56 | 1.10 | 3.35 | - |
| get-cobble | after | 5 of 5 | 80.2 | 83, 87, 78, 80, 79 | 65, 65, 64, 65, 64 | 2 918 | 1.57 | 1.11 | 3.40 | - |
| get-dirt | before | 5 of 5 | 44.1 | 44, 44, 44, 49, 48 | 74, 67, 72, 76, 71 | 5 607 | 2.22 | 1.19 | 3.14 | - |
| get-dirt | after | 5 of 5 | 44.6 | 45, 43, 42, 50, 48 | 74, 68, 72, 76, 73 | 5 706 | 2.20 | 1.18 | 3.04 | - |
| farm | before | 5 of 5 | 78.9 | 74, 79, 79, 76, 79 | 81, 81, 81, 81, 81 | 3 696 | 5.99 | 2.34 | 2.90 | - |
| farm | after | 5 of 5 | 79.3 | 79, 78, 83, 78, 83 | 81, 81, 81, 81, 81 | 3 677 | 5.67 | 2.35 | 2.92 | - |
| get-wheat | before | 5 of 5 | 77.6 | 76, 79, 78, 78, 78 | 81, 81, 81, 81, 81 | 3 758 | 5.78 | 2.33 | 2.92 | - |
| get-wheat | after | 5 of 5 | 77.3 | 80, 75, 80, 76, 77 | 81, 81, 81, 81, 81 | 3 772 | 5.34 | 2.30 | 2.95 | - |
| breed | before | 4 of 5 | 7.1 | 10, 8, 7, 6, 5 | 2, 2, 2, 2, 1 | 935 | n/a | n/a | 2.78 | short 1 |
| breed | after | 4 of 5 | 5.1 | 5, 5, 5, 7, 5 | 1, 2, 2, 2, 2 | 1 412 | n/a | n/a | 2.73 | short 1 |
| unload | before | 5 of 5 | 6.9 | 6, 6, 7, 7, 7 | 0, 0, 0, 0, 0 | 0 | n/a | n/a | 2.96 | - |
| unload | after | 5 of 5 | 6.9 | 6, 6, 7, 7, 7 | 0, 0, 0, 0, 0 | 0 | n/a | n/a | 2.99 | - |
| home-chore | before | 5 of 5 | 8.3 | 9, 8, 6, 8, 6 | 0, 0, 0, 0, 0 | 0 | n/a | n/a | 3.02 | - |
| home-chore | after | 5 of 5 | 8.7 | 9, 9, 8, 6, 9 | 0, 0, 0, 0, 0 | 0 | n/a | n/a | 3.12 | - |
| bring | before | 5 of 5 | 9.4 | 9, 9, 10, 9, 9 | 192, 192, 192, 192, 192 | 73 532 | 1.50 | 1.49 | 4.44 | - |
| bring | after | 5 of 5 | 9.4 | 10, 9, 9, 9, 9 | 192, 192, 192, 192, 192 | 73 532 | 1.50 | 1.49 | 4.44 | - |
| goto-200 | before | 5 of 5 | 83 | 83, 68, 61, 113, 216 | 0, 0, 0, 0, 0 | 0 | 2.32 | 2.32 | 4.16 | - |
| goto-200 | after | 5 of 5 | 82.1 | 82, 72, 61, 113, 216 | 0, 0, 0, 0, 0 | 0 | 2.30 | 2.30 | 4.16 | - |
| goto-500 | before | 5 of 5 | 207.6 | 290, 154, 143, 215, 208 | 0, 0, 0, 0, 0 | 0 | 2.16 | 2.16 | 4.26 | - |
| goto-500 | after | 5 of 5 | 191 | 290, 151, 142, 202, 191 | 0, 0, 0, 0, 0 | 0 | 1.99 | 1.99 | 4.33 | - |
| fly-1000 | before | 5 of 5 | 61.3 | 61, 55, 97, 126, 51 | 0, 0, 0, 0, 0 | 0 | 0.33 | 0.33 | 3.59 | - |
| fly-1000 | after | 5 of 5 | 62.3 | 62, 57, 75, 133, 55 | 0, 0, 0, 0, 0 | 0 | 0.33 | 0.33 | 3.70 | - |

### The ranking and the causes (before)

By failure rate:

1. **`!mine diamond_ore 4`: 4 of 5 runs got nothing.** The branch staircase down to y -58 was blocked at its tip on all
   three sides (straight, right, left): gravel over the step at y 100, 70 and 22 (`gravity_above`), water beside it at
   y 52 (`next_to_liquid`). The run ended `blocked` 18 to 42 steps down and the miner said `none_left`. The one run that
   was done met nothing on the way.
2. `!breed cow 2` fed one pair of two in 1 of 5 runs (below, "Still open").

By distance from a player's pace (with the break delay; the jobs the pace does not describe left out):

| Job | slow | Where the time went |
|---|---|---|
| wood | 2.37 | 46 % of the ticks planning; 54 walks to an item or a stand cell by a tree timed out |
| goto-200, goto-500 | 2.32, 2.16 | the way 1.2 to 4.4 times the straight line; walking at 4.2 blocks a second, a sprint's 5.6 |
| farm, get-wheat | 2.34, 2.33 | harvesting at 6 to 7 ticks a crop, planting, short pickups (the pace counts no planting) |
| mine-iron-stone, mine-iron-live | 1.34, 1.37 | 10 % planning on one spot (3 pickup walks timed out) |
| mine-coal, get-cobble, get-dirt | 1.10 to 1.21 | near a player: the digs, at the break table's time |

The causes named, in that order (the first two fixed, the third tried and dropped):

1. **A staircase blocked at its tip ended the run** (docs/mining.md "A blocked staircase backs up and turns").
2. **A walk to something near searched the whole loaded world** (docs/pathfinding.md "A near walk has a bound"). A
   goal no short way reaches (a sapling on the leaves, a cell behind the trunk's last log, an item on a ledge) was
   searched for until the search touched an unloaded chunk (130 000 to 200 000 nodes, 0.7 to 1.3 s); with unknown
   world in the way the navigator waited and searched again every 10 ticks, up to the walk's own timeout (the
   collect's 300 ticks, the feller's 600). One wood spot lost 6 181 of its 8 989 ticks that way, three others 1 792 to
   3 139; one iron spot lost 426.
3. **The walk's speed on rolling ground** (docs/pathfinding.md "Sprinting through steps and turns: measured and
   dropped"). A sprint ends before every jump and drop and starts again only on a straight run of 6 walk nodes; a turn
   of more than 15 degrees ends it. The walks sprinted 15 to 37 % of their walking ticks.

### The fixes, before and after

1. **A blocked staircase backs up and turns** (mine/branch.ts). `!mine diamond_ore 4` with the netherite kit: before,
   1 of 5 runs done (0 diamonds on the other 4 spots); after, 5 of 5, 4 diamonds each. On each of the 4 spots that had
   been blocked the staircase took one detour (`back 3 step(s) ... turning off there (detour 1)`); the spot done before
   took the same 195.8 s. The first diamond came 98 to 216 s after the command; the runs took 196 to 500 s, up to about
   4 minutes of it the way back to the surface ("Still open").
2. **A walk to something near has a bound** (nav/nearway.ts). `!get oak_log 64`: the median 252 -> 149 s, 915 -> 1 594
   logs an hour (+74 %), the slowest spot 449 -> 139 s; walks that timed out 54 -> 2, the share of ticks planning 46 ->
   5 %; instead 86 walks ended `unreachable` within a few ticks and the job went on to the next item or cell. `!mine
   iron_ore 16` with stone tools: the spot that lost 426 ticks 103 -> 66 s, the others within a second or two (the
   median 123 -> 116 s). Every other job is within its run-to-run spread (the table).

### Tried and dropped

- **Sprinting through steps and turns** (the third cause; a setting `sprintMore`, off, while it was measured): a
  one-block step up or down the way goes straight on from counted in the run a sprint needs and was taken at a sprint,
  and a sprint under way was kept through a turn of up to 40 degrees. In the closed loop 4.42 -> 4.71 and 4.29 -> 4.59
  blocks a second on two hilly worlds (30 gotos each), 0 corrections. In the sprint arm on BDS, against the after arm
  on the same spots: goto-200 82 -> 79, 72 -> 66 and 61 -> 55 s; goto-500 290 -> 280 s; wood 139 -> 136 and 149 -> 132
  s; mine-iron-stone 66 -> 78 s (worse) and 116 -> 117 s. The server corrected the body 0 to 32 times a run (a median of 5) where the
  after arm had 0 to 3 (goto-500: 32 against 1; mine-iron-stone: 5 and 11 against 0). The inputs before each correction
  were mostly a sprint while the view turned 14 to 30 degrees a tick. Dropped: it made a job slower and every walk less
  certain; the arm stopped after 1 to 3 runs of each of those four jobs. The step part alone gained 2.3 and 3.5 % in the closed loop, and
  starting a sprint on a run of 3 or 1 nodes instead of 6 another 0.1 to 0.7 %: neither worth a rule.
- **The break delay**: a stone block takes 17 ticks a dig cycle against the break table's 12, the 5 ticks being the
  survival delay between two breaks (250 ms, `BREAK_COOLDOWN_TICKS`). Not a cause: a player waits it too, and the
  table above shows the pace with it.

### Still open

- **The way on foot** is 1.2 to 4.4 times the straight line on the walks of 200 and 500 blocks (down and up the
  mountain, round the lakes), with digging and placing off as they are by default. Two of five walks of 200 blocks and
  one of 500 also spent 6 to 12 s planning after corridor waypoints failed (searches of 130 000 to 195 000 nodes).
- **The way back from a branch mine**: after the diamonds, the way back to the surface (a `!goto` to where the run
  began) found no plain way up the tunnels and the staircase within the planner's budget and took the long dig search
  (digs of 338 and 251 blocks through rock): about 4 minutes of runs of 485 and 500 s.
- **Farming** harvests at 6 to 7 ticks a crop, then plants, then walks 1 block at a time to the drops: 81 crops in
  about 78 s.
- **Breeding**: a cow fed with no effect (`in love false`) is not fed again; 1 pair of 2 in 2 of 10 runs.
- **Unload**: the home chore can start the unload before the command (1 of 10 runs).
- **The flight** is not ranked: its pace is a sprint's over the straight line, which an elytra beats; 51 to 133 s for
  949 to 1273 blocks.
