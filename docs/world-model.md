# World model (`bot/src/world`)

PLAN.md section 4.2 and Phase 2 (tasks 2.1 to 2.6). The world model turns inbound packets into a
queryable view of blocks, entities, inventory and the bot's own state. It sits on top of the
Connection layer and only needs a small `PacketSource` (`on`, `queue`, optional `onTick`), so the
same code runs live and in offline fixture replays.

```ts
import { World } from './world/index.ts';
const world = new World(conn, { version: conn.version });   // subscribe before conn.connect()
await conn.connect(target);
await world.waitForChunks(3);                               // columns within 3 chunks of self
world.blockAt({ x: 0, y: -61, z: 0 });                      // { name: 'grass_block', ... } or undefined
world.find((b) => b.name === 'oak_log', { origin: world.self.pos, radius: 32, max: 10, class: 'log' });
world.onBlockUpdate((p, before, after) => { ... });
world.entities;  world.inventory.count('oak_log');  world.self.health;
world.checksum(a, b);                                       // same rule as truth:checksum
```

## Files

| File | What |
|---|---|
| `index.ts` | `World` facade (implements `WorldView` from `types.ts`), packet wiring, self state, `waitForChunks`, `checksum` |
| `types.ts` | `Vec3`, `BlockInfo`, `Box`, `EntityInfo`, `ItemStack`, `ContainerView`, `SelfState`, `FindOptions`, `PacketSource`, `WorldView` |
| `packets.ts` | shapes of the inbound packets the model reads (bedrock-protocol 3.60.1 / minecraft-data 1.26.51) |
| `registry.ts` | `BlockRegistry`: prismarine-registry from `start_game` + `item_registry`, runtime id to state id, unknown-hash counting, `BlockInfo` cache, `blockHash()` |
| `version-shims/` | one module per game version (`1.26.51.ts`) plus `index.ts` (`shimFor`, `SHIMS`) |
| `subchunk.ts` | own network subchunk decoder (`decodeSubChunk`) and the in-memory `Section` / `Layer` format |
| `chunks.ts` | `ChunkStore`: `level_chunk`, batched `subchunk_request`, `subchunk` decode, column cache, unload by distance |
| `updates.ts` | `BlockUpdates`: `update_block`, `update_subchunk_blocks`, `block_entity_data`, `onBlockUpdate` |
| `entities.ts` | `EntityTracker`: players, mobs, item drops |
| `inventory.ts` | `Inventory`: windows, hotbar selection |
| `find.ts` | `BlockFinder`: `find()` with a per-section index for `log`, `leaves`, `chest` |
| `checksum.ts` | FNV-1a box checksum over typeIds (truth-pack compatible) |
| `cache/` | persistent world cache (task 7.12): summaries, region files, stand-ins, cached marks ([world-cache.md](world-cache.md)) |

## Packet flow (BDS 1.26.51.1)

```
start_game ──────────────┐
item_registry ───────────┴─> BlockRegistry ready (either order; finalize() at player_spawn if item_registry never came)
network_chunk_publisher_update ─> view center + radius (blocks) -> unload distance
level_chunk (sub_chunk_count 0, highest_subchunk_count N)
        └─> Column (N sections pending, the rest air) -> request queue
             pump (deferred with setImmediate after a packet burst, and every tick):
             subchunk_request { dimension, origin: (cx0, minY >> 4, cz0), requests: [(dx, dy, dz)...] }
             up to 8 columns per packet, at most 48 columns in flight, closest first, retry after 5 s
subchunk { origin, entries[] } ─> per entry: success (decode) | success_all_air | y_index_out_of_bounds (air)
                                   | chunk_not_found (drop column); column loaded when nothing is pending
update_block / update_subchunk_blocks ─> Section.set + onBlockUpdate (layer 0)
block_entity_data ─> column.blockEntities
add_player / add_entity / add_item_entity / move_entity_delta / move_entity / move_player (others)
  / set_entity_motion / remove_entity (by unique id) / take_item_entity ─> entities
inventory_content / inventory_slot / inventory_transaction (clientbound, 'normal') / player_hotbar
  / mob_equipment (self) ─> inventory
respawn (state 1) / move_player (self) / correct_player_move_prediction / set_health
  / update_attributes (self) / set_player_game_type / set_entity_motion (self) ─> self, onCorrection
change_dimension ─> clear chunks and entities
```

Measured on bds-world (flat world, view distance 10): the server sends 369 columns; the store asks for
them in 55 `subchunk_request` packets and has radius 4 loaded about 150 ms after spawn and all 369
within about 3 s. Block updates reach the model 30 to 61 ms after the truth pack's reply line (both
are sent in the same server tick; the reply happens to arrive first).

## Decode path

1. **Registry.** `prismarine-registry('bedrock_1.26.51')`, then
   `handleStartGame({ ...start_game, itemstates })` with the item states from `item_registry`
   (PLAN fact 3c). With `block_network_ids_are_hashes` the runtime id of a block state is
   FNV-1a 32 over the little-endian NBT `{ name: "minecraft:<name>", states: { sorted } }`
   (`blockHash()` reproduces prismarine-block's `getHash`). `BlockRegistry` copies the result into a
   `Map<runtimeId, stateId>` and an `Int32Array` for the reverse direction (16 913 states, about
   70 to 150 ms).
2. **Subchunks.** `decodeSubChunk()` reads storage version 1, 8 or 9 (9 carries the absolute y
   index as a signed byte, which is checked against `origin.y + dy`), one or two layers (layer 1 is
   water in waterlogged blocks), each a paletted storage with network runtime ids: header byte
   `bits << 1 | 1`, `ceil(4096 / floor(32 / bits))` little-endian words, zigzag-varint palette size,
   zigzag-varint runtime ids; `bits == 0` means one zigzag runtime id and no words. Blocks are in
   XZY order (`x << 8 | z << 4 | y`). Trailing little-endian varint NBT compounds are block
   entities.
3. **Storage.** Per section and layer: `palette: Int32Array` of state ids (-1 = unknown runtime id),
   `runtimeIds: Int32Array` (wire ids, kept for unknown blocks), and an index array
   (`Uint8Array`, or `Uint16Array` above 256 palette entries, or `null` for a uniform section).
   All-air sections are `null` and cost nothing. `BlockInfo` objects are frozen and cached per
   state id.

**Why not prismarine-chunk's decoder.** 1.41.0 has no 1.26 entry (PLAN fact 3b) and the documented
bypass (`prismarine-chunk/src/bedrock/1.18/chunk`) works for the flat test world, but it (a) throws a
`TypeError` on any runtime id the registry does not know, which is exactly what blocks newer than the
1.26.30 block data produce; and (b) decodes the 0-bit single-value layer with
`readVarInt() >> 1` and then treats the result as a state id, which is wrong for hashed (often
negative) ids, so any uniform non-air section or uniform second layer breaks. The own decoder is
about 150 lines; `test/unit/world/subchunk.test.ts` cross-checks it against prismarine-chunk 1.18
on every recorded subchunk of `fixtures/1.26.51/world-chunks.jsonl.gz` (all agree), and the
registry still comes from prismarine.

## Known gaps

- **Block data is 1.26.30's** (PLAN fact 3a). Blocks added in 26.40 to 26.51 have hashes the registry
  cannot resolve. They decode as `{ name: 'unknown', stateId: -1, solid: true, boxes: [full cube],
  states: { runtime_id } }` (safe for pathfinding), are logged once per id at warn level, and are
  counted in `world.registry.unknownRuntimeIds` (`unknownSummary()` for a log line). None were seen
  on the flat test world. When minecraft-data ships newer block data, bump the shim's
  `registryVersion` / `blockDataVersion`.
- **Truth area.** The truth pack can only read chunks the server keeps loaded for scripts: about 4
  chunks around the player (chunk (-3,-3) is already unloaded when standing at the spawn). The e2e
  tests pick boxes inside that area and retry on `unloaded_chunk`.
- **Layer 1** (waterlogging) is decoded, stored and updated, but `blockAt` and `onBlockUpdate` only
  look at layer 0. Use `world.chunks.stateIdAt(x, y, z, 1)` for the second layer.
- **Legacy `level_chunk` payloads** (sections inside the packet, `sub_chunk_count > 0` without
  `highest_subchunk_count`) decode their sections; their trailing block entities and biomes are
  ignored. BDS 1.26 never uses that mode. The blob cache (`cache_enabled`) is not supported (the
  client sends `client_cache_status` disabled).
- **Biomes, light and heightmaps** are not decoded.
- **Entities.** Positions are as the server sends them: players are at eye height (feet + 1.62);
  item actors are 0.125 above the spawn position. No metadata (`set_entity_data`), attributes or
  links are kept. `move_entity_delta` is handled in both the 1.26.40+ shape (independent optional
  absolute floats, rotations as bytes x 360 / 256) and the older `flags` bitfield shape.
- **Inventory.** BDS announces server-side changes such as `/give` as a clientbound
  `inventory_transaction` (type `normal`, `container` actions with `window_id` 0 and the new item),
  not as `inventory_slot`; both are handled. `container_open` / `container_close`,
  `item_stack_response` and the per-window contents are handled by `bot/src/world/containers.ts`
  (Phase 4.5, constructed separately like `Hotbar` and attached to the skills; see docs/wood.md).
- **Self state** is what the server reports (start_game, respawn, own move_player, corrections,
  set_entity_motion, health and hunger attributes). The input loop (Track C) owns prediction; it can
  overwrite `world.self.pos` / `vel` directly.
- **Shared minecraft-data.** prismarine-registry mutates the minecraft-data object it was built
  from, so several `World`s in one process share item tables. That is harmless while they speak the
  same version; mixing versions in one process is not supported.

## Connection API gaps (for Track A)

The world model uses only `Connection.on(name: string, ...)` (the untyped overload),
`Connection.queue(name, params)` and `Connection.onTick`. It did not need any change to
`bot/src/connection`. Gaps noticed:

- `InboundPackets` has no entries for `item_registry`, `network_chunk_publisher_update`,
  `update_subchunk_blocks`, `block_entity_data`, `add_entity`, `add_item_entity`, `move_entity`,
  `move_entity_delta`, `set_entity_motion`, `remove_entity`, `take_item_entity`, `inventory_content`,
  `inventory_slot`, `inventory_transaction`, `player_hotbar`, `mob_equipment`, `set_health`,
  `update_attributes`, `set_player_game_type`, `change_dimension`, `chunk_radius_update`, so the
  world module keeps its own shapes in `world/packets.ts`.
- `ConnectionOptions.viewDistance` has no effect: bedrock-protocol 3.60.1 sends
  `request_chunk_radius { chunk_radius: client.viewDistance || 10 }` and never copies
  `options.viewDistance` onto the client, so the server always streams radius 10 (369 columns).
  Setting `client.viewDistance = n` right after `createClient` would fix it.
- There is no tick or event before spawn, so requests issued while chunks stream in during login
  are scheduled with `setImmediate` instead of on a tick.
- Offline sessions: a process that exits right after `disconnect()` can leave the session open on
  the server, and the next login with the same name is kicked with `server_id_conflict`. The e2e
  helpers wait 300 ms after `disconnect()` and use per-run names; a `disconnect()` that returns a
  promise resolved once RakNet has flushed would be cleaner.
- Inventory sync and item pickup only run while the server ticks the player, which needs a
  `player_auth_input` every tick (the e2e helper `standStill()` in `test/e2e/world-truth.ts` is a
  stand-in until the input loop exists).

## Tests

| Test | What |
|---|---|
| `test/unit/world/registry.test.ts` | known hashes (air, bedrock, dirt, grass_block, oak_log, stone, read from the capture) resolve; `blockHash` equals prismarine; oak_log round trip; either packet order; unknown-id counting |
| `test/unit/world/subchunk.test.ts` | every bits-per-block width, 0-bit negative ids, two layers, v8/v9, block entity NBT, malformed input, and agreement with prismarine-chunk on every recorded subchunk |
| `test/unit/world/chunks.test.ts` | request batching and cap, results, retry, unload, registry deferral, dimension change, legacy payloads, updates, block entities, checksum |
| `test/unit/world/entities-inventory.test.ts` | entity add/move/remove (both move_entity_delta shapes), self state, corrections, inventory packets |
| `test/unit/world/find.test.ts` | class index vs full scan, index maintenance, perf (102 400-block scan median about 1 ms, budget 5 ms) |
| `test/unit/world/world-replay.test.ts` | replays `fixtures/<FIXTURE_VERSION>/world-chunks.jsonl.gz` (default 1.26.60; `FIXTURE_VERSION=1.26.51` for the old one) offline and compares the model with every truth reply recorded inside it |
| `test/e2e/world-chunks.test.ts` | flat layers in every column within 48 blocks; 200 random positions (and all 20 000 blocks of 5 random 20 x 10 x 20 boxes) vs `truth:blocks`, 100 % |
| `test/e2e/world-updates.test.ts` | 20 `truth:set` blocks seen within 2 ticks, chest block entities, 5 x 5 x 5 `truth:fill`, model checksum = `truth:checksum` |
| `test/e2e/world-entities.test.ts` | `truth:spawnitem` drop within 0.5 blocks of truth, then resting and removal; `truth:give` matches `truth:inv` slot for slot |
| `test/e2e/world-record.test.ts` | opt-in (`WORLD_RECORD=1`): re-records the fixture |

The e2e tests target the `bds-world` container on udp/19142 (override with `BDS_WORLD_CONTAINER`,
`BDS_WORLD_HOST`, `BDS_WORLD_PORT`; `WORLD_SEED` changes the random positions). Since 2026-10-28 it is
`docker/compose.world.yml` (BDS 1.26.60.6; same settings as the earlier `docker run` at 1.26.51.1):

```sh
node scripts/bds.mjs --profile world up     # = docker compose -f docker/compose.world.yml up -d, then wait
node scripts/bds.mjs --profile world pack   # deploy the truth pack into docker/data/world and restart
BDS_E2E=1 pnpm --filter bot test:e2e
BDS_E2E=1 WORLD_RECORD=1 pnpm --filter bot test:e2e -- world-record     # re-record the fixture
```

## Persistent world cache (`world/cache`, task 7.12)

`openWorldCache(world, { server })` (the CLI does it for walking tasks) attaches a `WorldCache`:
`World.cache` is set and the model gains memory beyond the loaded area. Hooks, all on existing
`ChunkStore` events (no change to the packet path): `onColumnLoaded` summarizes the column (2-bit class
per cell, column tops and roofs, marks such as logs, chests, ores), `onBlockSet` keeps the summary
current, `onSection` re-summarizes a re-sent section, `onColumnUnloaded` encodes it into its region
file. Readers:

- `World.find(pred, opts)` also returns marks of unloaded columns in range, flagged `cached: true`
  (`opts.cached: false` skips them); `findCachedTrees(world, cache, origin, radius)` groups cached logs.
- `worldSource(world)` (skills/terrain/query.ts) answers `blockAt` / `columnTop` for unloaded columns
  with stand-ins (air, stone, water, lava, leaves) so the planner plans through remembered terrain;
  `liveBlockAt` (what the physics uses) never does.
- When a column the planner read from the cache loads, the read cells whose stand-in differs from the
  real block are announced through `onBlockUpdate` (`BlockUpdates.emit`) with the stand-in as `before`.

`World.blockAt` is unchanged: `undefined` still means "not loaded". Format, sizes, bounds and
measurements: [world-cache.md](world-cache.md).

## Adding a version shim

1. Make sure bedrock-protocol and minecraft-data know the version (see `tools/bump-version`).
2. Copy `version-shims/1.26.51.ts` to `version-shims/<ver>.ts`, set `gameVersions`,
   `registryVersion` (`bedrock_<ver>`) and `blockDataVersion` (what `dataPaths.json` points
   `blocks` at for that version). Adjust `itemStates()` if the item table moves again,
   `dimensions` if the world height changes, and `maxSubChunkVersion` if a new storage version
   appears (then teach `subchunk.ts` to read it).
3. Add it to `SHIMS` in `version-shims/index.ts` (newest first). An unknown version falls back to
   the newest shim with a warning.
4. Record `fixtures/<ver>/world-chunks.jsonl.gz` against a BDS of that version
   (`WORLD_RECORD=1`, after pointing the recorder's output path and version at it), make
   `world-replay.test.ts` and `registry.test.ts` run for it, and run the world e2e suite. A
   non-empty `unknownRuntimeIds` after the chunk test is the signal that the block data lags.
