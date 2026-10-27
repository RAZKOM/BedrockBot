# `!build`: the builder (wave 9, Track AL)

The bot builds simple structures legitimately, from its own inventory, with the same clicks a player
makes: fill / clear / replace a box, walls, floors, pillars and structure files (`.mcstructure` or a
hand-written JSON layer format). PLAN.md 7.17 "builder". Decision record:
[decisions/0033-builder.md](decisions/0033-builder.md). Placing and digging themselves are the
PlaceSkill and the Digger ([interaction.md](interaction.md), [digging.md](digging.md)).

## Files

| Path | What |
|---|---|
| `bot/src/skills/build/types.ts` | `BuildBlock`, `BuildSpec`, block name helpers, `unsupportedBlock` (the limits), `itemFor`, `MAX_BUILD_CELLS` (4096) |
| `bot/src/skills/build/spec.ts` | `!build` arguments -> `BuildSpec` (`~` coordinates, Bresenham walls), `buildStepText` (the NL step) |
| `bot/src/skills/build/sim.ts` | the world plus the build's changes (`SimWorld`), stand / reach / support rules, reachability (`reachableStands`) |
| `bot/src/skills/build/plan.ts` | the planner: order, stands, support scaffolds, scaffold columns, dig lists (`planBuild`, `planBuildAsync`) |
| `bot/src/skills/build/materials.ts` | materials against the inventory, the throwaway reserve (`usable`, `materialsOf`, `materialsLine`) |
| `bot/src/skills/build/runner.ts` | `BuildRunner`: executes the steps on the bot (walk, place, dig, pillar, descend, verify, retry, skip) |
| `bot/src/skills/build/formats/mcstructure.ts` | `.mcstructure` reader and writer (little-endian NBT) |
| `bot/src/skills/build/formats/layers.ts` | the JSON layer format |
| `bot/src/skills/build/formats/index.ts` | structure folders, `loadStructure`, rotation (`placeStructure`) |
| `bot/src/tasks/process/build.ts` | `BuildProcess` (a user process) |
| `bot/src/chat/commands-build.ts` | `!build`, `BuildController` (plan, materials, fetch, status, stop), registration |
| `bot/src/config/settings.ts` | `buildScaffold` (on) |
| `packs/truth/src/build.ts` | `truth:blocksdiff` |
| `bot/test/unit/skills/build-plan.test.ts`, `build-formats.test.ts`, `build-fakes.ts`, `bot/test/unit/build-commands.test.ts`, `bot/test/unit/fixtures/build/gate.mcstructure` | unit tests on fakes, the hand-built fixture |
| `bot/test/e2e/build-box.test.ts`, `build-shapes.test.ts`, `build-truth.ts` | e2e on bds-build |
| `docker/compose.build.yml` | `bds-build`, udp/19200, flat, peaceful |

## Commands (owner only, afk task with walking)

Coordinates are block coordinates; `~` is the bot's own feet coordinate and `~N` an offset from it
(`!build pillar ~2 ~ ~ 5 cobblestone`).

| Command | Reply |
|---|---|
| `!build fill x1 y1 z1 x2 y2 z2 <block> [fetch]` | `building fill 5x3x5 cobblestone: 75 to place`, at the end `build fill 5x3x5 cobblestone: done, 75 / 75 placed, 0 skipped in 56 s (80 blocks/min)`. Every free cell (air, grass, water is refused) of the box; cells holding the block already count as done, other blocks are left (`3 occupied (left)`) |
| `!build clear x1 y1 z1 x2 y2 z2` | `building clear 5x3x5: 75 to dig` ... `build clear 5x3x5: done, 75 / 75 dug, 0 skipped in 113 s (40 blocks/min)`; the drops are picked up |
| `!build replace x1 y1 z1 x2 y2 z2 <from> <to> [fetch]` | every `<from>` in the box is dug and `<to>` placed in its cell (`replaced`) |
| `!build wall x1 y z1 x2 z2 <height> <block> [fetch]` | a wall along the line (x1, z1) -> (x2, z2) (straight or diagonal, 8-connected), from y up |
| `!build floor x1 y z1 x2 z2 <block> [fetch]` | a one-block-high rectangle at y |
| `!build pillar x y z <height> <block> [fetch]` | a column from y up (height 1..64) |
| `!build file <name> [x y z] [0\|90\|180\|270] [fetch]` | a structure file with its min corner at the bot's feet or at x y z, turned clockwise (seen from above) by the angle |
| `!build materials [<build>]` | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)`, or `...; have everything`; without arguments: the running or the last build |
| `!build status` | `build: 212 / 640 placed, 3 skipped, eta 4 min` (`(paused)` while pre-empted), `build: idle (last: ...)` |
| `!build stop` | `stopped build fill 5x3x5 cobblestone: 40 / 75 placed, 0 skipped`; `build: nothing to stop` |

A build that needs more blocks than the inventory holds is refused with the materials line and `(add
fetch to get them with !get first)`. With `fetch` the bot first runs `!get <item> <n>` for every
missing block, one after the other, through the chat's own handler as the owner (the way `!get` runs
its commands; replies and `!stop` as usual), waits for those jobs to end, plans again and starts
the build (`build: still short after fetching: ...` otherwise). Blocks `!get` does not know (bricks,
planks, glass, ...) are refused up front (`build: cannot fetch ...`).

The build is a **user process** (priority 40, docs/processes.md): flee, guard, night and newer
commands pre-empt it, `!pause` holds it, `!resume` / the end of the pre-emption continue at the same
step, `!stop` and `!build stop` end it, a death drops it. `!status` shows it in the stack (`[active]
build fill 5x3x5 cobblestone: 12 / 75 placed, 0 skipped, eta 46 s`). One build at a time (a new one
replaces the old).

## Order rules

- **Place builds**: bottom layer first. Inside a layer the cell farthest from where the bot stood
  when the build started comes first and the order works towards the bot, so the bot never walls
  itself in; a cell without any clickable neighbour yet waits for one that has (the farthest cell
  with a support goes first, else the farthest).
- **Stands**: the bot works from a stand: feet and head cells free (no collision box, no liquid),
  neither of them a cell the build fills later, a full block top under the feet, no lava, fire,
  cactus, magma ... next to the body. The cell must be within 4.5 blocks of the eye (eye = feet +
  1.62, to the cell's centre), not in the body, and for placing a clickable neighbour (solid, not a
  door / chest / ... ) within the PlaceSkill's click reach (5 to its closest point; the server allows
  7.19 to its corner). The current spot is kept when it qualifies, else the bot walks to the nearest
  stand (a goto to any of the 12 nearest, `allowBreak` and `allowPlace` off so the walk never digs
  through or pillars onto the structure).
- **Reachability** (planner): stands joined by 4-neighbour steps of at most one block up or down,
  both ways walkable (no drop the bot cannot climb back), seeded from the bot and from every stand on
  the edge of the work area (the build's box plus 6 blocks; the edge is assumed reachable from
  outside). Placed blocks become stands as the build grows (a floor's middle is reached by walking
  on its edge).
- **Clear / replace**: dig lists, top layer first, nearest cell first inside a layer. Never the block
  under the feet (a stand on the target is not used), never a block next to water or lava, never an
  unbreakable one; liquids are skipped. A replace digs the cell and places the new block from the
  same stand (it needs another clickable neighbour of the cell).
- **Verify**: every placement is checked in the world model after the server's `update_block` (the
  block name at the cell), every dig too (no collision box left). A failed step is retried twice
  (walking again), then skipped and reported (`skipped: x y z (place: place: rejected)`).

## Scaffolding (`buildScaffold`, default on)

Scaffold blocks are throwaway blocks (cobblestone, dirt, cobbled deepslate, netherrack; kinds the rest
of the build does not use first), placed to reach or to click, and removed afterwards; their drops
are picked up.

- **Support scaffold**: a target cell with no clickable neighbour at its turn gets the shortest chain
  (up to 3) of scaffold blocks from a cell that has one, through free cells that the build does not
  fill later. They are dug at the end of their layer (highest first). The e2e overhang (a block one
  cell beside the top of a 3-high post, nothing under it) needs exactly one.
- **Scaffold column**: a target out of reach from every reachable stand (e.g. the 7th block of a
  pillar: from the ground the eye reaches cell centres up to 5 blocks above the feet) gets a column
  within 2 blocks of it: the bot walks to the column's base, pillars up (the PlaceSkill's
  jump-and-place, docs/interaction.md "Pillar-up") until the target is in reach (the fewest blocks,
  then the top closest to the target), places from the top everything of that layer it reaches, then
  digs the column under its feet top-down, landing on each block, and picks up the drops. A column
  is at most 6 high. When the bot is pushed off a column (a pre-emption, a flight), the resumed
  build digs the column from the ground and pillars again.
- `!set buildScaffold off`: such cells are skipped (`no support (buildScaffold off)`, `out of reach
  (buildScaffold off)`).

## Materials

`materials` counts the blocks the plan places per item (cells already right are not counted) and
compares them with the inventory. The survival keeper's throwaway reserve (`throwawayMin` throwaway
blocks, default 16) is **never** built with: a throwaway kind is usable for the build only beyond what
the reserve still needs after the other throwaway kinds are counted (75 cobblestone + 16 dirt builds
75 cobblestone; 91 cobblestone alone too; 75 cobblestone alone stops at 59: `build ...: stopped at 59
/ 75 placed: out of cobblestone (16 kept as the throwaway reserve)`). Scaffold blocks may be lent
from the reserve, because they come back. The scaffold note (`1 scaffold block, picked up again`)
and a reserve shortfall are added in brackets.

## Formats

Folders, first hit wins: `values.builds` (tests), env `BEDROCKBOT_BUILDS`, **`builds/` next to the
config file** (`%LOCALAPPDATA%\bedrockbot\builds` on Windows, `~/.bedrockbot/builds` on the Mac; not
with `--no-config`), then `worlds/` in the working directory. `!build file hut` looks for
`hut.mcstructure`, then `hut.json`; names are letters, digits, `_ - .` (no paths). The log line
`build: !build ready (structure folders: ...)` lists them.

**`.mcstructure`** (Bedrock structure blocks, `/structure save`, export from the game): uncompressed
little-endian NBT `{ format_version, size: [x, y, z], structure: { block_indices: [[...], [...]],
palette: { default: { block_palette: [{ name, states, version }] } } } }`. Cell (x, y, z) is index
`(x * sy + y) * sz + z` (x outermost, z innermost) of `block_indices[0]`; `-1` is structure void.
Air and structure void are not placed. The waterlogging layer, entities and block entity data (chest
contents, signs) are ignored. Verified against BDS: the truth pack's `probe.mcstructure` placed by
the server (`truth:place`) and the reader agree on every cell (build-shapes e2e).

**JSON layers** (written by hand):

```json
{ "name": "hut",
  "layers": [ ["#####", "#...#", "#####"],
              ["#####", "#...#", "#####"],
              ["ppppp", "ppppp", "ppppp"] ],
  "legend": { "#": "cobblestone", "p": "oak_planks" } }
```

`layers[0]` is the bottom; each layer is a list of rows (z = 0, 1, ...), each row one character per
column (x = 0, 1, ...). `.` and space are "no block" (nothing placed, nothing required). A legend
value is a block name or `{ "name": "oak_log", "states": { ... } }`.

**Rotation**: 90 / 180 / 270 turn the structure clockwise seen from above (east -> south); the min
corner of the turned structure is the anchor. Block states (stairs facing, log axis) are not turned:
placement uses the item and the clicked face (see Limits).

## Truth commands (packs/truth/src/build.ts)

`truth:blocksdiff x1 y1 z1 x2 y2 z2 <palette> <runs>`: the box against an expected block list in the
canonical order of `truth:blocks` (y, then z, then x innermost); `<palette>` a comma list of ids
(`air,cobblestone`; `*` = any block), `<runs>` a comma list of `index*count`. Answer `{ count, diffs,
first: [{ x, y, z, expected, actual }] (20 at most), actual: { typeId: n } }`.

## Measured (e2e on bds-build, 2026-10-30, BDS 1.26.60.6)

Two gate runs of `build-box` + `build-shapes` (6/6 green each, 218 to 219 s per run), plus the
earlier runs:

| What | Result |
|---|---|
| fill 5 x 3 x 5 cobblestone (75 blocks), box 3 blocks from the bot | done in 56 s, **80 blocks/min** (walks included), 0 skipped, blocksdiff 0 of 75, 0 cobblestone and 16 dirt left, 1 correction; `!build status` 6 s in: `build: 9 / 75 placed, 0 skipped, eta 46 s` |
| clear of the same box (stone pickaxe) | done in 111 to 113 s, **40 to 41 blocks/min** with the pickup, blocksdiff 0 against air, all 75 cobblestone picked up |
| `!build materials` wall 10 x 4, empty inventory | `materials for wall 10x4 cobblestone: 40 cobblestone; need 40 more cobblestone (throwaway reserve 16 short, never built with)` |
| JSON overhang (4 blocks, 1 support scaffold) | done in 5 s, the scaffold placed and dug, blocksdiff 0 of 9, the 16 dirt back |
| pillar of 7 | done in 7 s; 6 from the ground, one pillar-up (highest feet -58.75 in the jump), the 7th from the column top, the column dug: the bot at -60.00 on the ground (truth:pos), blocksdiff 0 of 7, 2 corrections (the pillar jump and the landing) |
| probe.mcstructure placed by BDS vs the reader | 0 of 18 cells differ |
| gate.mcstructure (11 blocks: cobblestone posts, an oak log beam, a stair) built rotated 90 | done in 5 s (136 to 143 blocks/min: one stand for all), blocksdiff 0 of 18 |

Regression on bds-build with the shared-file changes (afk task registration, settings, NL schema,
truth pack): get-front, get-stash, nl-core (GET_BDS_* / CORE_BDS_* pointed at bds-build): 8/8 green,
152 s.

## Limits

- No liquids, no redstone parts (dust, repeaters, pistons, observers, buttons, levers, plates,
  rails, TNT), no two-cell blocks (doors, beds, tall flowers), no entities (paintings, armour stands,
  item frames), no block entity data. Such blocks are refused (`water: no liquids`).
- Block states are not placed on purpose: stairs, logs, slabs and other oriented blocks get the
  orientation that the clicked face and the bot's yaw give (the planner does not choose faces for
  orientation). Verification compares the block name only.
- Up to 4096 cells per build. Planning runs on the main thread in chunks of 64 cells (it yields
  between chunks).
- Clear and replace do not use scaffolds: cells out of reach from the ground (more than about 5
  blocks above the feet, or below a drop the bot could not climb back) are skipped. Deep holes are
  not dug (one-block steps only).
- A structure must be reachable on foot around it; the work area's edge is assumed reachable from
  outside, and the navigator decides the real path (a stand it cannot reach costs one goto failure,
  retried twice).
- A support chain longer than 3 blocks or a column higher than 6 is not planned (the cell is
  skipped).

## Tests

```sh
pnpm --filter bot exec vitest run --project unit build-                  # unit, fakes only (planner, runner, formats, commands)
node scripts/bds.mjs --profile build up && node scripts/bds.mjs --profile build pack
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e build- --silent=false   # build-box + build-shapes (~6 min)
```

Env: `BUILD_BDS_HOST` (127.0.0.1), `BUILD_BDS_PORT` (19200), `BUILD_BDS_CONTAINER` (bds-build),
`BUILD_VERBOSE=1` (the bot's log). Every run uses its own random 256-block cell from x, z = 36864,
random truth request ids, waypoints and settings in memory (`no-config`) and its own temporary
structure folder; the area is cleared and drops removed at the end.

- `build-box`: `!build materials wall ...` (10 x 4) with an empty inventory (the exact line); a
  5 x 3 x 5 cobblestone box 3 blocks from the bot with exactly 75 cobblestone and 16 dirt (`!build
  materials` says `have everything`, `!build status` while it runs, the done line, truth:blocksdiff 0
  of 75, 0 cobblestone and 16 dirt left); `!build clear` of the same box (blocksdiff 0 against air,
  the cobblestone picked up).
- `build-shapes`: the JSON overhang (one support scaffold, blocksdiff 0 with the scaffold cell air,
  the dirt back); a 7-block pillar (one pillar-up, blocksdiff 0, the bot's highest feet y >= -59,
  at the end on the ground at -60 per truth:pos); the probe structure placed by BDS against the
  reader (0 differences), then the hand-built `gate.mcstructure` built with `!build file gate x y z
  90` (blocksdiff 0 against the rotated reader output).
