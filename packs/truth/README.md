# Truth pack

Behavior pack that gives tests and the RL bridge ground truth and world control on a local BDS.
It uses only the stable `@minecraft/server` **2.10.0** module (what BDS 1.26.51.1 loads): no Beta
APIs, no experiments, no `server-gametest`. It loads on any BDS world as is.

Requests are `/scriptevent truth:<cmd> [#<id>] args...` sent by an operator or the server console.
Replies are chat messages (`world.sendMessage`) that start with `@truth ` followed by compact JSON.

## Layout

| Path | What |
|---|---|
| `manifest.json` | pack manifest (header uuid `4b99f76a-7d3a-4a0c-a2bf-4e85ffb907bd`, depends on `@minecraft/server` 2.10.0) |
| `src/main.ts` | the pack: command handlers, events |
| `src/wood.ts`, `src/woodShapes.ts` | wood commands (`container`, `tree`, `find`) and the pure tree shape shared with the bot's tests |
| `src/act.ts` | interaction commands (`setblock`, `door`) and the `playerPlaceBlock` / `playerInteractWithBlock` events |
| `src/protocol.ts` | pure helpers: tokenizer, canonical order, RLE, FNV-1a, reply encoding, `ReplyParser`, `textOf` (reusable by the bot) |
| `structures/truth/probe.mcstructure` | 3 x 2 x 3 test structure, id `truth:probe` (made by `scripts/make-probe-structure.mjs`) |
| `scripts/build.mjs` | esbuild bundle to `dist/scripts/main.js`, copies manifest and structures to `dist/` |
| `scripts/deploy.mjs` | copies `dist/` into a BDS data dir and registers the pack with the world |
| `test/unit/` | vitest unit tests of `src/protocol.ts` |
| `test/e2e.test.mjs`, `test/truth-client.mjs` | node:test e2e suite against the `bds-truth` container, plus a reusable `connectBot` / `TruthClient` |
| `.bds/` | data volume of the local `bds-truth` test server (git-ignored) |

## Build, deploy, test

```sh
pnpm build                     # dist/ (bundled pack)
pnpm typecheck
pnpm test                      # unit tests (vitest)
node scripts/deploy.mjs --data <bds data dir> [--world <level-name>] [--restart <container>] [--no-build]
pnpm pack:deploy:truth-bds     # = deploy to .bds/ and `docker restart bds-truth`
pnpm test:e2e                  # node:test e2e against bds-truth on UDP 19136
```

`deploy.mjs` builds, replaces `<data>/behavior_packs/truth/`, adds `{pack_id, version}` to
`<data>/worlds/<level>/world_behavior_packs.json` (keeping other entries; level defaults to
`level-name` from `server.properties`) and sets `content-log-console-output-enabled=true` so script
errors appear in `docker logs`. The pack loads on server start, so restart after deploying. On
success the log shows `[Scripting] [truth] pack 0.1.0 loaded (@minecraft/server 2.10.0)`.

The e2e server was started with:

```sh
docker run -d --name bds-truth -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet -e ONLINE_MODE=false \
  -e ALLOW_LIST=false -e PLAYER_IDLE_TIMEOUT=0 -e ALLOW_CHEATS=true -e LEVEL_TYPE=FLAT -e LEVEL_NAME=truth \
  -e SERVER_PORT=19136 -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator -p 19136:19136/udp \
  -v "<abs path>/packs/truth/.bds:/data" itzg/minecraft-bedrock-server
```

## Request format

```
/scriptevent truth:<cmd> [#<id>] arg1 arg2 ...
```

- From the console: `docker exec bds-truth send-command scriptevent truth:block #42 0 -61 0`.
- From the bot (an operator): send the command text `/scriptevent truth:block #42 0 -61 0`.
- `#<id>` (optional, first token) is echoed back as `id` so callers can correlate replies. Without
  it `id` is `null`. Any token without spaces works (`#t17`, `#42`).
- Tokens are split on whitespace; `"double quotes"` group a token (player names with spaces).
- Block ids without a namespace get `minecraft:` (`oak_log` = `minecraft:oak_log`).
- Coordinates: block commands floor them; `tp` and `spawnitem` keep fractions. No `~` relative syntax.
- All world commands act on the overworld.

## Reply format

Every reply is one chat line:

```
@truth {"truth":{"cmd":"block","id":"42","ok":true,"tick":7037,"data":{...}}}
```

| Field | Meaning |
|---|---|
| `cmd` | the command name (`"event"` for unsolicited events) |
| `id` | the request id from `#<id>`, or `null` |
| `ok` | `true` on success |
| `tick` | `system.currentTick` when the reply was sent |
| `data` | command result (below); on failure an object with `message` and details |
| `reason` | only when `ok` is `false`: a reason code (below) |

How it reaches a bedrock-protocol client: a `text` packet with `type: "json"` whose `message` is
`{"rawtext":[{"text":"@truth {...}"}]}`. Join the `text` parts (`textOf()` in `src/protocol.ts`),
check the `@truth ` prefix, `JSON.parse` the rest, take `.truth`. Replies are broadcast to every
player on the server; ignore lines without the marker.

**Fragments.** A reply longer than 256 KiB (never seen in practice: the largest `blocks` reply is
far smaller) is split into lines `@truth+ <key> <i>/<n> <fragment>`; concatenating the fragments of
one key for i = 1..n gives the `{"truth":...}` JSON. `ReplyParser` handles both forms. BDS 1.26.51.1
delivered a 500 kB text packet to bedrock-protocol intact.

**Ordering.** Most commands answer in the same tick. `checksum` always, and `fill` above 32768
blocks, run as `system.runJob` and answer a few ticks later, so replies can arrive out of request
order: correlate by `id`.

### Reason codes

| reason | when |
|---|---|
| `bad_args` | missing or non-numeric argument, bad option |
| `unknown_command` | no such `truth:<cmd>`; `data.commands` lists the valid ones |
| `unloaded_chunk` | a position or any chunk column of a box is not loaded (`data.chunk`, `data.at`) |
| `out_of_bounds` | y outside the dimension height range (`data.minY`, `data.maxY`; overworld -64..319) |
| `volume_too_large` | box larger than the command's limit (`data.volume`, `data.max`) |
| `player_not_found` | no such player (`data.online` lists names) |
| `player_ambiguous` | no name given and several players online |
| `unknown_item` | `give` / `spawnitem` with an invalid item id |
| `inventory_full` | `give` could not fit everything (`data.given`, `data.leftover`) |
| `unknown_structure` | `place` with an unknown id (`data.pack`, `data.world` list what exists) |
| `error` | anything else (`data.message` has the engine's message) |

Only chunks near a player are loaded on BDS (no spawn chunks without a ticking area). With one
stationary player at the spawn, chunks -2..1 on both axes were loaded (about x, z in -32..31).

## Commands

`[name]` = optional player name. When omitted: the player that ran the command, else the only player
online, else `player_ambiguous`.

| Command | Args | `data` on success |
|---|---|---|
| `ping` | any | `{pong:true, pack:"0.1.0", api:"2.10.0", tick, players:[names], echo:[args]}` |
| `help` | | `{commands:[...]}` |
| `block` | `x y z` | `{x, y, z, typeId, states}` (`states` = block permutation states, e.g. `{pillar_axis:"y"}`) |
| `blocks` | `x1 y1 z1 x2 y2 z2` (max 4096 blocks) | `{from, to, size, order:"yzx", palette:[typeId...], runs:[[paletteIndex, count]...]}` |
| `set` | `x y z typeId` | `{x, y, z, typeId}` (typeId read back after setting) |
| `fill` | `x1 y1 z1 x2 y2 z2 typeId` (max 1 048 576) | `{from, to, volume, typeId}` |
| `checksum` | `x1 y1 z1 x2 y2 z2` (max 1 048 576) | `{from, to, size, count, order:"yzx", algo:"fnv1a32", hash:"8 hex digits", ticks}` |
| `pos` | `[name]` | `{name, entityId, dimension, location:{x,y,z}, isOnGround, velocity:{x,y,z}, rotation:{pitch,yaw}, health, gameMode, selectedSlot, tick}` |
| `inv` | `[name]` | `{name, selectedSlot, size:36, slots:[36 x ({slot, typeId, amount} or null)], counts:{typeId: total}, equipment:{Head|Chest|Legs|Feet|Offhand: {typeId, amount}}}` |
| `give` | `name typeId [amount=1]` (max 4096) | `{name, typeId, given}`; split into max-size stacks |
| `clear` | `name` | `{name, removed}` (inventory and armor/offhand) |
| `tp` | `name x y z [yaw [pitch]]` | `{name, to:{x,y,z}, rotation:{pitch,yaw} or null}` |
| `time` | `[day|noon|sunset|night|midnight|sunrise|<ticks>]` | `{timeOfDay, day, absoluteTime}` (no arg = query) |
| `kill` | `name` | `{name, killed}` |
| `spawnitem` | `x y z typeId [amount=1]` | `{typeId, amount, entities:[{entityId, amount, location}]}` |
| `place` | `structureName x y z [0|90|180|270] [none|x|z|xz]` | `{structure, from, to, size}` (entities not placed) |
| `save` | `structureName x1 y1 z1 x2 y2 z2 [world|memory]` | `{structure, from, to, size, saveMode}` |
| `structures` | | `{pack:[ids], world:[ids]}` |

### Wood commands (src/wood.ts, PLAN.md Phase 4)

| Command | Args | `data` on success |
|---|---|---|
| `container` | `x y z [clear]` | `{x, y, z, typeId, size, total, slots:[{slot, typeId, amount} or null], counts:{typeId: n}}`; with `clear` the inventory is emptied after reading (`cleared`). `no_container` if the block has no inventory |
| `tree` | `x y z height [kind=oak] [persistent=0]` | `{kind, base, height, logs:[[x,y,z]...], leaves, persistent}`: a log column from (x, y, z) up and a leaf canopy (`src/woodShapes.ts` `treeShape`: radius 2 without corners at top - 1 and top, a plus shape at top + 1 and top + 2). Leaves only replace air. Kinds: oak, birch, spruce, jungle, acacia, dark_oak, cherry, mangrove, pale_oak |
| `find` | `x1 y1 z1 x2 y2 z2 pattern [max=4096]` (max volume 1 048 576, a job) | `{from, to, pattern, count, byType, positions:[[x,y,z]...], truncated}`: blocks whose typeId contains `pattern` (e.g. `_log`) |

### Interaction commands (src/act.ts, PLAN.md task 7.3)

| Command | Args | `data` on success |
|---|---|---|
| `setblock` | `x y z typeId [state=value ...]` | `{x, y, z, typeId, states}`: one block with block states (`BlockPermutation.resolve`); values `true`/`false` are booleans, integers numbers, the rest strings, e.g. `setblock 5 -60 5 fence_gate minecraft:cardinal_direction=north`. `bad_states` if the states do not resolve |
| `door` | `x y z typeId direction [hinge 0/1] [open 0/1]` | `{lower:{x, y, z, typeId, states}, upper:{...}}`: both halves of a door (upper first); `direction` = `minecraft:cardinal_direction` |

### Canonical block order, RLE and checksum

`blocks` and `checksum` visit a box in **y, z, x order** (x varies fastest): the block at `(x,y,z)`
has index `((y - from.y) * size.z + (z - from.z)) * size.x + (x - from.x)`.

`blocks` encodes that sequence as a palette plus runs: expand each `[i, n]` to `n` copies of
`palette[i]` (`rleDecode()` in `src/protocol.ts`).

`checksum` is 32-bit FNV-1a (offset basis `0x811c9dc5`, prime `0x01000193`) over the typeIds in
canonical order, each hashed as its ASCII bytes followed by one `0x00` byte, printed as 8 lowercase
hex digits. It covers typeIds only, not block states. Two boxes with the same size and the same
blocks give the same hash wherever they are. Throughput is about 3 600 blocks per tick (a 64 x 45 x
64 box took 51 ticks).

### Events

Sent without a request, with `cmd:"event"`, `id:null`, `ok:true`, and `data.type`:

| `data.type` | fields |
|---|---|
| `loaded` | `pack, api` (script start; usually before any player is online) |
| `playerSpawn` | `player, initialSpawn, location` |
| `playerBreakBlock` | `player, x, y, z, typeId` (the broken block), `tool` (item typeId or null) |
| `playerDie` | `player, entityId, location, cause, damager` (typeId or null) |
| `playerPlaceBlock` | `player, x, y, z, typeId, states` (the placed block) |
| `playerInteractWithBlock` | `player, x, y, z, typeId, states` (after the interaction), `face`, `item` (held typeId or null), `first` |

## Structures

- Ids need a namespace. A name without one gets Bedrock's default `mystructure:` (so `save foo ...`
  and `place foo ...` both mean `mystructure:foo`, the same id `/structure save foo` uses).
- Pack structures: `structures/<ns>/<name>.mcstructure` in this pack has id `<ns>:<name>`
  (`structures/truth/probe.mcstructure` = `truth:probe`). Files at the root of `structures/` get
  `mystructure:<name>`. Pack structures are read-only; `save` refuses to overwrite them.
- `save` uses `world.structureManager.createFromWorld` with `includeEntities:false`, replacing an
  existing world structure of the same id. `world` mode (default) persists it in the world's
  LevelDB, which is what `/structure save <name> <from> <to> disk` does; `memory` lasts until the
  server stops.
- **Exporting to a file is not possible from the Script API** (no file system access). Options:
  1. In a game client with cheats, a Structure Block in Save mode with Export writes a
     `.mcstructure` on the client device.
  2. The world DB stores the structure under the LevelDB key `structuretemplate_<id>`, and the
     value is the same little-endian NBT as a `.mcstructure` file; a Bedrock LevelDB reader
     (Mojang's fork uses raw zlib blocks) can dump it from `.bds/worlds/<level>/db` while the
     server is stopped. Not implemented yet.
  3. Generate the file from code, as `scripts/make-probe-structure.mjs` does (format notes there).
  Put scenario files into `worlds/` and copy the ones the pack should serve into `structures/<ns>/`.

## Examples

```text
> scriptevent truth:ping #1
@truth {"truth":{"cmd":"ping","id":"1","ok":true,"tick":7030,"data":{"pong":true,"pack":"0.1.0","api":"2.10.0","tick":7030,"players":["TruthBot"],"echo":[]}}}

> scriptevent truth:block #2 0 -61 0
@truth {"truth":{"cmd":"block","id":"2","ok":true,"tick":7037,"data":{"x":0,"y":-61,"z":0,"typeId":"minecraft:grass_block","states":{}}}}

> scriptevent truth:blocks #3 -2 -64 -2 2 -60 2
@truth {"truth":{"cmd":"blocks","id":"3","ok":true,"tick":7041,"data":{"from":{"x":-2,"y":-64,"z":-2},"to":{"x":2,"y":-60,"z":2},"size":{"x":5,"y":5,"z":5},"order":"yzx","palette":["minecraft:bedrock","minecraft:dirt","minecraft:grass_block","minecraft:air"],"runs":[[0,25],[1,50],[2,25],[3,25]]}}}

> scriptevent truth:pos #4 TruthBot
@truth {"truth":{"cmd":"pos","id":"4","ok":true,"tick":7033,"data":{"name":"TruthBot","entityId":"-8589934591","dimension":"minecraft:overworld","location":{"x":0.5,"y":-60,"z":0.5},"isOnGround":false,"velocity":{"x":0,"y":0,"z":0},"rotation":{"pitch":0,"yaw":0},"health":20,"gameMode":"Survival","selectedSlot":0,"tick":7033}}}

> scriptevent truth:block #5 5000 -61 5000
@truth {"truth":{"cmd":"block","id":"5","ok":false,"tick":7053,"data":{"message":"unloaded_chunk at 5000 -61 5000","at":{"x":5000,"y":-61,"z":5000}},"reason":"unloaded_chunk"}}

> scriptevent truth:checksum #6 -32 -64 -32 31 -20 31
@truth {"truth":{"cmd":"checksum","id":"6","ok":true,"tick":11376,"data":{"from":{"x":-32,"y":-64,"z":-32},"to":{"x":31,"y":-20,"z":31},"size":{"x":64,"y":45,"z":64},"count":184320,"order":"yzx","algo":"fnv1a32","hash":"94f3fce0","ticks":51}}}
```

## Using it from Node

```js
import { connectBot, TruthClient } from './test/truth-client.mjs';
let truth;
const client = await connectBot({ port: 19136, username: 'TruthBot', onClient: (c) => { truth = new TruthClient({ client: c }); } });
const { typeId } = await truth.ok('block', [0, -61, 0]);   // throws unless ok
const reply = await truth.cmd('pos');                       // full envelope, ok or not
```

`TruthClient` sends through `docker exec <container> send-command scriptevent ...`; the bot's own
World layer should instead send `/scriptevent` as an operator command and reuse `ReplyParser`.

## Caveats

- Replies go to every player via `world.sendMessage`; fine on a local BDS, never install this pack
  on a shared world.
- `kill` leaves the player on the death screen until the client sends a respawn; the e2e suite
  runs it last.
- `pos.isOnGround` is `false` for a client that has not sent `player_auth_input` yet.
- `place` checks that the target box is loaded (otherwise the engine would queue the placement).
