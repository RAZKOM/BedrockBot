# The Nether, the End and dimension changes (wave 10, Track AT)

The first half of the owner's wish for elytra flight, the Nether and the End: dimension changes done right, portal
travel, and the Nether survivable. The End is read-only (never off the void edge). Elytra flight is a
later physics track: its plan is the last section. Decision: [0041](decisions/0041-dimensions-portals-nether-safety.md).

| Command | What |
|---|---|
| `!nether` | through the overworld's `portal` waypoint (else the nearest portal block within `portalRadius`, default 64) into the Nether; a user process (`!stop`, `!pause`, guard / flee pre-empt it) |
| `!overworld` | back through the `nether_portal` waypoint (else the nearest portal block) |
| `!portal [status]` | `in the nether; portal 9235 151 15856, nether_portal 1154 118 1982; changes 2, last overworld -> nether, ack after 1050 ms, 369 columns dropped; fire escapes 0` |

Replies: `going to the nether (portal 9235 151 15856)`, then `in the nether at the portal 1154 118 1982
(left through 9235 151 15856), 3.8 s in the portal`, or `nether: no nether portal known in the
overworld: no portal waypoint and no portal block within 64 blocks (build and light one, or stand in
front of one and say !wp set portal; this bot does not build portals)`. `already in the nether`;
`in the End: the way out is the exit portal on the main island (not handled by this bot yet)`.

## Files

| File | What |
|---|---|
| `bot/src/world/dimension.ts` | names and ids, the per-dimension rules (`hasDayCycle`, `bedsWork`, `hasSurface`, `waterWorks`, `voidBelow`, `surfaceRefusal`), per-dimension waypoint names (`dimWaypointName`, `waypointDimension`), `DimensionWatcher` (answers the server's ack, reports `start` / `arrived`) |
| `bot/src/world/index.ts` | `World.dimensions` (the watcher, created before the World's own handlers), `change_dimension` takes the position as feet |
| `bot/src/tasks/process/portal.ts` | `PortalProcess` (one trip), `FireProcess` (the fire / lava escape), `findPortal`, `portalBase`, `portalSides` |
| `bot/src/chat/commands-portal.ts` | `!nether`, `!overworld`, `!portal` and every per-dimension rule of the afk task (one registration line in tasks/registry.ts) |
| `bot/src/skills/survival/fire.ts` | `fireEscape` (the target cell), `BurnWatch` (the `onfire` flag, hurts while burning) |
| `bot/src/skills/nav/avoidance.ts` | lava sources and `LavaIndex`; spawners and lava forgotten on a dimension change |
| small named edits | `skills/index.ts` (the surface goal refuses in the Nether), `skills/nav/navigator.ts` (`costsOverride`), `chat/commands-nav.ts` (`!top`, `!goto` / `!wp set` per dimension, `waypointStoreOf`), `skills/combat/targeting.ts` (piglins and gold), `skills/survival/index.ts` (one line: `lavaWorld`), `config/settings.ts` (`portalRadius`), `nl/*` (`nether`, `overworld` steps) |
| `packs/truth/src/nether.ts` | truth `dimension`, `dimtp`, `dblock`, `dset`, `dfill`, `dfind`, `portal` |
| `bot/test/unit/world/dimension.test.ts`, `bot/test/unit/nether.test.ts` | unit tests |
| `bot/test/e2e/nether-*.test.ts`, `nether-truth.ts` | e2e on bds-nether (udp/19202) |

## Packets (BDS 1.26.60.6, recorded on bds-nether)

Recorded with a `PacketRecorder` on the afk stack (probe runs, not committed), for a truth teleport
across dimensions (`Player.teleport(loc, { dimension })`) and for walking into a lit portal. Both
look the same on the wire:

| Order | Direction | Packet | Shape and notes |
|---|---|---|---|
| 0 | in | `remove_entity` | every entity of the old dimension, just before the change |
| 1 | in | `change_dimension` | `{ dimension: 1, position: { x: 1102.5, y: 100, z: 500.5 }, respawn: false, loading_screen_id: 2 }`. `position` is the arrival **feet** for a teleport (y 100 for a teleport to y 100); after a portal it is approximate: the scaled source position (`{ x: 1102, y: 201.62, z: 500 }` once, the old eye height, when the Nether side had no portal yet) or the portal (`{ x: 1116.5, y: 58.5, z: 495.5 }`). `loading_screen_id` counts up per change (0, 1, 2, ...) |
| 1 | in | `level_event_generic` | event 19602 (sleeping players), same batch |
| 2 | in | `network_chunk_publisher_update` | the first one still at the old position, then at the new one, every tick (radius 160) |
| 3 | in | `level_chunk` / `subchunk` | `dimension: 1`; the client keeps requesting with `subchunk_request { dimension: 1, ... }` |
| 4 | in | `player_action` | `{ runtime_entity_id, action: 'dimension_change_ack', position: 0 0 0, result_position: 0 0 0, face: 0 }`, 0.4 to 3.3 s after `change_dimension` |
| 5 | out | `player_action` | the same: `{ runtime_entity_id, action: 'dimension_change_ack', position: 0 0 0, result_position: 0 0 0, face: 0 }` (DimensionWatcher sends it on the server's) |
| 6 | in | `move_player` | `mode: 'teleport'` (a script teleport) or `mode: 'reset'` (a portal, it can come just before the server's ack), the exact eye position (feet + 1.62) |
| 7 | in | `correct_player_move_prediction` | one or two right after the client ack (the server takes over from the old prediction) |

Not sent: `respawn`, `play_status`, `start_game`, `set_time` (the time comes with `sync_world_clocks`
as before). The client also does not need `serverbound_loading_screen` with the id (tried: no
difference).

**The client ack is required.** Without answering the server's `dimension_change_ack`, BDS ignores
every `player_auth_input` in the new dimension: no movement, no correction, for as long as we
watched (10 s of walking in place, truth position unchanged). With the answer the server moves the
player at once (a `correct_player_move_prediction` follows). Sending `handled_teleport` again or the
loading-screen packets does not replace it.

The bot's own state: `set_entity_data` for the bot carries the `flags` with `onfire` (the fire
escape reads it) and `air` (counts down when the body is inside netherrack after a teleport).

Truth `hurtlog` causes seen: `fire` (standing in fire), `fireTick` (burning after leaving it),
`lava`, `magma`.

## What changes on a dimension change

- **World model** (`World`): `self.dimension`, `self.pos` (the feet of `change_dimension`, exact again
  with the `move_player` after the ack), `chunks.clear(dimension)` (every column dropped: 369 to 393
  columns at view distance 10 to 11, each with an unload event, so the world cache stores them under
  the old dimension first), the entity list cleared. `level_chunk` of another dimension is ignored.
- **World cache**: keys every summary, herd mark and chest record by dimension already (Track T):
  the overworld in `<dir>`, the Nether in `<dir>/dim1`, the End in `<dir>/dim2` (checked in the
  e2e: region files in `dim1` after the trip).
- **Planner**: the planner worker drops its mirror on the new dimension (Track AB). The main
  thread's `NavGrid` caches classified cells by coordinates only, so `!nether`'s wiring clears it on
  every change (`skills.nav.grid.clear()`), and the lava index and the spawner index forget their
  positions when `world.self.dimension` changes.
- **Processes**: every user process but the portal trip itself and the home return are stopped
  (`dropped`), the walk in progress is cancelled; the log says `dimension change overworld -> nether:
  stopped goto`. The input loop needs nothing: until the ack the server ignores its inputs, the
  `move_player` after it resets the body.
- **Per dimension** (`chat/commands-portal.ts`):
  - night shelter and sleeping only in the overworld (`NightProcess.wants` is false elsewhere;
    `!sleep` replies `beds explode in the nether`);
  - home and the shelter are overworld points: flee, guard (centred on the bot instead) and the home
    return do not use them elsewhere; `!home go` replies `home is in the overworld, ...`;
  - waypoints: overworld names stay plain, the Nether's carry `nether_`, the End's `end_` (one flat
    store per server, waypoints/store.ts). `!wp set base` in the Nether stores `nether_base`, `!goto
    base` there finds it; `!goto home` in the Nether replies `waypoint home is in the overworld, not
    in the nether (!overworld first)`;
  - `!top` and the `surface` goal refuse in the Nether: `top: there is no surface in the Nether (a
    bedrock ceiling at y 127); use !overworld to leave` (the search would only exhaust its budget
    under the ceiling);
  - the End: `skills.nav.costsOverride` sets `maxDrop` 1, so the planner takes no drop it cannot
    climb back (the irreversible-drop penalty is infinite there). The planner never walks off an
    edge without a floor within `maxDrop` anyway: over the void `!goto` replies `goto: unreachable`
    and the bot stays on the edge.
- **The panel** shows the dimension already (`v-dimension`, Track AK's state).

## Portals

- The block is `portal` with `portal_axis` `x` (the portal spans x, a body enters along z) or `z`.
  It has no collision box. terrain/classify.ts lists it as a hazard (`danger`), so the planner never
  paths into or through a portal: no walk travels by accident. `PortalProcess` walks to the cell in
  front of or behind the portal's lowest block with the planner, then steps in by hand (forward until
  the body centre is within 0.3 of the portal cell's centre) and stands still.
- BDS moves the player after about 4 s in the portal (measured: 3.8 s from the end of the step in,
  every trip; 4.7 s from starting to walk 3 blocks to it in the probe). The process waits up to 15 s,
  then steps out and in once more, then gives up with the reason.
- On arrival it waits for the ack (movement is ignored before it), 10 ticks, the chunks within 1,
  then records the portal it arrived in (the lowest portal block of the nearest column) as the new
  dimension's `portal` waypoint and the one it left through as the old one's, and steps out of the
  portal (by hand: its own cell is a hazard to the planner).
- The Nether side: BDS links to a portal within range of (x / 8, z / 8) or builds one with an
  obsidian platform; back through it, the player arrives in the original portal (e2e: within 1 block
  of it). Building portals is not in this track: `!nether` with nothing known says what is missing.
- Truth `portal dim x y z axis [lit]` builds the frame; setting `portal` blocks directly does not
  work on BDS 1.26.60 (they vanish again in the same tick), placing `fire` inside a complete frame
  lights it like flint and steel.

## Nether safety

- **Lava** (nav/avoidance.ts): lava cells with no lava right above (a pool's surface, a flow) within
  20 blocks of the bot are avoidance sources. A feet cell with such lava at the floor, feet or head
  level in its column or a neighbour column costs 60 ticks (Chebyshev distance 0 or 1), 8 at
  distance 2. The planner keeps a free block between the path and a lava lake whenever there is
  room: e2e, a lake between the bot and the goal: every planned cell 2 blocks off the lava, the body
  centre at least 1.35 blocks from it (a diagonal step around the lake's corner), 0 damage. Lava was
  already never stood in, swum or dropped into, and the planner never digs a block with lava (or
  water) beside it (`breakBlocker`: `next_to_liquid`, nav/actions.ts).
- **Fire, soul fire, magma, campfires** are hazards (classify.ts): never a floor, never a cell to
  stand in. Magma: e2e, a strip across the way with a gap: 0 cells on magma, 0 damage. Sneaking over
  magma is not planned (it would need a "sneak" move).
- **Fire escape** (`FireProcess`, priority 101, above flee): when the bot burns (`onfire`, or the body
  in lava) and lost health within 3 s, and its own cell is not clear, it walks to the nearest cell
  within 6 blocks where it can stand with nothing burning in the 3 x 3 x 3 around (`fireEscape`) and
  eats with the survival kit (at most once per 10 s; the server refuses at full food). Standing on a
  clear cell it waits for the flames to go out (about 8 s of `fireTick`). e2e: fire set in and around
  the bot: out in 1.4 s, one escape.
- **No water bucket**: water evaporates in the Nether; the bot carries none on purpose.
- **Netherrack** is diggable (a natural block, not protected), **soul sand** slows (a +4 path penalty, classify.ts),
  soul soil is a normal floor.
- **Ghasts and blazes** stay archers and flyers (combat rules unchanged: fought only in reach).
- **Piglins** are neutral (Track V): a threat only once they target the bot (`target_eid`) or hit it.
  New: a piglin (not a brute) is never a threat while the bot wears any golden armour piece, since
  hitting one turns the group. Piglin brutes are always hostile.

## The End (read-only)

Dimension 2, the void below. `maxDrop` 1 (above); endermen rules unchanged (neutral, Track V); no
dragon logic (the e2e removes the dragon with `/kill`). `!nether` / `!overworld` from the End reply
that the exit portal is not handled.

## Measurements

| What | Value |
|---|---|
| `change_dimension` -> the server's ack | 445 ms (teleport into the Nether), 2 668 ms (teleport back), 739 ms (portal), e2e 750 to 1 202 ms out, 1 202 to 3 267 ms back |
| ack -> first correction | 60 to 120 ms |
| in the portal until `change_dimension` | 3.8 s (e2e, both ways) |
| `!nether` end to end (walk 3 blocks, wait, arrive, step out) | 6.8 to 7.0 s; `!overworld` 6.3 to 8.8 s |
| columns dropped per change | 369 to 393 |
| columns loaded after the change | 20 in 0.3 to 0.5 s, 80 in 0.75 s, the full view (381) within 5 s |

## Truth commands (packs/truth/src/nether.ts)

`dimension name`, `dimtp name dim x y z [yaw]`, `dblock dim x y z`, `dset dim x y z typeId`,
`dfill dim x1 y1 z1 x2 y2 z2 typeId` (32 768 blocks max), `dfind dim box pattern [max]`,
`portal dim x y z x|z [lit]`. `dim` is overworld | nether | the_end (or 0 | 1 | 2). The core
commands keep working in the overworld only.

## Tests

- unit: `test/unit/world/dimension.test.ts` (rules, names, the watcher with the recorded shapes, the
  World's reset), `test/unit/nether.test.ts` (lava costs and a planned detour, LavaIndex, fire escape,
  BurnWatch, FireProcess, portal helpers and a whole trip on a fake world, piglins and gold, the afk
  registry in the Nether and the End).
- e2e on bds-nether (`BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e nether-
  --silent=false`, about 1.5 min): `nether-portal` (`!nether`, world model, cache, waypoints, `!top`,
  night, `!overworld`), `nether-lava` (lava lake, magma, fire), `nether-end` (the void edge, a 2-block
  ledge).

## What does not work yet

- No portal building, no flint and steel; the exit portal of the End is not used.
- A trip by other means (the owner pushes the bot through a portal) records no waypoints.
- Magma is never walked even when sneaking would be safe; soul sand's slowness is a cost only.
- Fortress and bastion awareness (wither skeletons, blazes in spawners), gold bartering, ghast
  fireball dodging and deflection: none.
- The lava cost uses lava within 20 blocks of where the plan starts; a long walk across a Nether
  plain re-plans in segments, so lava farther out is seen when the bot gets there.

## Later: Elytra and mending

Elytra flight was built in wave 11 (Track AU): [flight.md](flight.md) has the packets, the glide
model, the landing method and the measurements; mending by XP is still open. The notes below are
the plan as it stood after wave 10, kept for what they got right and wrong (the boost comes with no
`set_entity_motion`; the glide needs the jump press with `start_gliding`; a voluntary stop in the
air is ignored).

What it will need, with what to verify on bds-nether first:

- **Glide start**: on BDS 1.26.60 movement is server-authoritative, so the client sets the input flag
  `start_gliding` (and `stop_gliding`) in `player_auth_input.input_data` (both exist in minecraft-data
  1.26.60's `InputFlag`); `player_action` `start_glide` / `stop_glide` (actions 15 and 16) are the
  older path. Verify which one BDS accepts by recording a real client jumping off a ledge with an
  elytra, and the `gliding` entity flag in the bot's own `set_entity_data` that confirms it.
- **Physics**: the glide model (pitch-driven lift and drag, about 0.99 drag per tick horizontally,
  speed from diving) for the input loop's prediction, measured like Track AJ's water physics against
  `correct_player_move_prediction` on a flat test area.
- **Fireworks boost**: `inventory_transaction` item use of a firework rocket while gliding; the boost
  arrives as `set_entity_motion` (the loop's `applyMotion` handles those already) or as server
  position corrections: to verify.
- **Landing**: the server stops the glide on ground contact or water; the planner needs a "glide to"
  move class with its own cost and a landing check (no lava, no void: the End rule above).
- **Durability and mending**: elytra damage is the item's NBT `Damage` (Track S reads it); 432 uses,
  one per second of flight; the bot should land at about 10 left (`toolWearLimit`). Mending repairs
  from experience orbs (`add_entity` of `xp_orb`, picked up by walking over them like items): an XP
  source and a "repair at" chore would be a separate track.
