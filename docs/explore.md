# Exploring: `!explore [radius]` (`bot/src/skills/explore`)

Wave 9, Track AI. Decision record: [decisions/0030-explore-and-branch-mining.md](decisions/0030-explore-and-branch-mining.md).
Branch mining (the other half of the track: `!mine` when no ore is known) is in [mining.md](mining.md)
"Branch mining". The world cache the walk fills is in [world-cache.md](world-cache.md).
Measured on **BDS 1.26.60.6** (container `bds-explore`, udp/19198, RakNet, offline, generated DEFAULT
world, `LEVEL_SEED` 7, peaceful, TICK_DISTANCE 10) on 2026-10-30.

## Why

`!mine iron_ore 20` ended `none_left` whenever the bot knew no iron, and the world cache (ores, forests,
herds, chests) only grew where the bot happened to walk. `!explore` walks the land around home on
purpose until the cache knows everything a walk inside the radius can show.

## Chat

| Command | Reply |
|---|---|
| `!explore [radius] [now]` | `exploring r=128 around home (10 64 3)` (around `here` without a home point), `, eating first` when trip readiness eats first; at the end `explore r=64: 44 cells visited, 300 new chunks cached; remembered there: 105120 ores, 28 forests, 0 herds, 30 containers; 4 min 46 s` (skipped cells in brackets: `(5 over water, 2 unreachable)`); a failed run adds `; stopped: 10 walks in a row failed` |
| `!explore stop` | `stopped; explore r=128: ...` or `not exploring` |
| `!explore status` | `explore r=128 12 cells visited, 140 new chunks (walk, 30 cells open); explore r=128: ...` |

Radius 16..1024 blocks, default the runtime setting **`exploreRadius`** (128). Night without a
chestplate: refused unless the command ends with `now` (trip readiness, docs/pve.md). Needs walking and
the world cache (`BEDROCKBOT_CACHE=0`: `explore: needs the world cache`).

## The walk

| Step | Rule |
|---|---|
| area | the 16-block cells (= chunk columns) whose centre lies within the radius of home, else of where the bot stood at the start |
| gain | of a cell: the columns within the view radius of its centre the cache does not know yet. The view radius is measured, `floor(sqrt(loaded columns / pi))` (10 on BDS with 369 columns loaded); a cell with gain below 3 is covered for good |
| pick | among the cells with gain, the cheapest: distance from the bot minus 24 blocks when the cell touches a visited one (8 neighbours). The walk spirals around the start and jumps only when the neighbourhood is done |
| stand spot | a sample column of the cell (centre, then a 4 x 4 grid nearest the centre) whose cached surface is solid and open to the sky (top = roof: no canopy); water / lava surface on half the samples or more: the cell is skipped (`over water` / `over lava`) without a walk; only canopies: the ground under the centre; an uncached cell: an `xz` goal on its centre |
| walk | `near` goal r 4 on the spot's feet cell with the normal walk (settings `allowBreak`, `allowPlace`, `sprint` apply), timeout 1 200 ticks + 20 per block; failed: the cell is skipped as unreachable; 10 failed walks in a row end the run |
| look | 20 ticks, then until the columns within 4 chunks are loaded (at most 5 s); the cell is visited; the columns the cache learnt are counted |
| end | no cell with gain left: `done` |

Why gain and not "the cell's own column is not cached": the server streams a disc of 10 chunks around
the player, so every column within 160 blocks is cached at login; a walk to cells whose own column is
unknown would do nothing for any radius below 160 (decision 0030). With gain, a radius below the view
distance still makes the bot walk the cells whose view reaches past what it has seen.

Summary numbers are counted on the columns the cache learnt during the run (within the area plus its
view): `ores` = ore marks (every `*_ore` and ancient debris of those chunks, buried ones included: about
350 per chunk on seed 7), `forests` = clusters of 3+ log marks (single link 6 blocks, world/find.ts
`logClusters`), `containers` = chest / trapped chest / barrel / ender chest marks, `herds` = herd marks
gained meanwhile (Track AF, recorded by the food controller's herd memory while the bot walks).

## As a process

`ExploreProcess` (tasks/process/explore.ts), user priority 40: trip readiness first (eat to full and put
on armour when food or health is below 14, `preparing: eating` in `!status`), then the explorer.
Pre-empted (guard, flee, night, a newer command, `!pause`) = the walk is cancelled and the cell kept;
resumed = the same cell again. `!explore stop` and `!stop` end it; a death drops it.

## Files

| File | What |
|---|---|
| `bot/src/skills/explore/frontier.ts` | cells, `gainOf`, `pickCell`, `standSpot`, `countMarks` (pure) |
| `bot/src/skills/explore/explorer.ts` | `Explorer`: the loop, pause / resume / stop, `tally`, `summary` |
| `bot/src/tasks/process/explore.ts` | `ExploreProcess` |
| `bot/src/chat/commands-explore.ts` | `!explore`, `registerExploreCommands` (tasks/registry.ts, one line); also wires branch mining (`attachBranch`) |
| `bot/test/unit/skills/explore.test.ts`, `bot/test/unit/explore-settings.test.ts` | unit tests on fakes |
| `bot/test/e2e/explore-walk.test.ts`, `explore-truth.ts` | e2e on bds-explore |
| `docker/compose.explore.yml` | bds-explore, udp/19198, DEFAULT world, seed 7 |

## Measured (`explore-walk`, bds-explore)

Each run starts on dry land above sea level in a random far area (spawn y 64 to 102) with an empty
cache directory; the server sends 10 chunks around the player (369 columns at the start). Ranges over
the 7 development and gate runs (the two gate runs: 44 cells / 288 columns / 4 min 25 s and 42 cells / 319 columns / 7 min 11 s) (`!explore 64`, 52 cells in the radius):

| What | Result |
|---|---|
| cells visited | 25 to 47 of 52 (covered without a walk 2 to 18, over water 0 to 8, unreachable 0 to 11) |
| new chunk columns in the cache | 239 to 328 (counted on the cache: 369 to 396 -> 608 to 707 columns) |
| marks in them | 73 827 to 218 086 ore marks (every ore of those chunks, about 350 per column), 2 655 to 11 566 log marks in 16 to 102 forests, 0 to 31 containers; herds 0 (peaceful test world without passive mobs near the paths) |
| time | 4 min 16 s to 7 min 11 s; 634 to 908 blocks walked, 34 to 48 walks |
| per cell | 4 to 6 s per walk of 14 to 25 blocks (look-around included); jumps of 78 to 107 blocks when the neighbourhood is done |
| `!pause` after the first cell | 0.000 blocks moved in 2 s in every run; the walk went on after `!resume` |
| `!explore stop` during a walk | `stopped; ...` at once, no process left; 0.000 to 0.467 blocks moved in the 2 s after it (the body settling on a slope; the navigator idle) |
| failure seen | a mountain start (y 102): 11 cells unreachable, the run ended after 10 failed walks in a row with 25 cells and 239 columns done (the test still passes: the cache learnt the columns) |

## Tests

```sh
node scripts/bds.mjs --profile explore up      # bds-explore, udp/19198 (first start generates the world)
node scripts/bds.mjs --profile explore pack    # truth pack
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e explore- --silent=false    # explore-walk + explore-mine
```

Env: `EXPLORE_BDS_HOST` (127.0.0.1), `EXPLORE_BDS_PORT` (19198), `EXPLORE_BDS_CONTAINER` (bds-explore),
`EXPLORE_AREA=x,z` (pin the area), `EXPLORE_VERBOSE=1`. The suites set peaceful, noon, no mob spawning,
`falldamage false` (the hops drop the bot from y 320), work in random areas 2 000 to 9 000 blocks out,
use a world cache in a temp directory (deleted afterwards) and in-memory settings, remove drops at
the end, and the mine suite fills the cells it dug with stone again.

- `explore-walk`: a fresh spawn on dry land above sea level; `!explore 64`; `!pause` after the first
  visited cell (the bot holds still for 2 s), `!resume`; the run ends by itself; the cache (counted on
  the cache, not from the explorer) knows at least 12 more columns, which hold ore or log marks;
  `!explore 128` then `!explore stop` during the first walk: `stopped; ...`, no process left, still.

## Known limits

- A small radius still walks most of its cells: each cell's view edge is new ground (r = 64: 44 of 52
  cells, about 5 minutes). The default 128 is about 200 cells, 20 minutes or more.
- The walk does not dig (unless `allowBreak` is on) or swim across: land behind water is skipped as
  unreachable after one failed walk, and an island start ends after 10 failed walks.
- Herd marks need the food controller's herd memory (registered by the afk task): the count is 0 when
  no passive mob came within its range.
- Gain counts columns, not content: a cell whose view is all ocean is walked like any other.
