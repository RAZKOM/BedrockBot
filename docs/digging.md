# Digging: break times, `dig()`, tool selection (`bot/src/skills/dig`)

PLAN.md Phase 4 tasks 4.1 and 4.2. Everything below was measured on **BDS 1.26.51.1** (itzg image
2026.10.2, RakNet, offline, flat world, survival, `server-authoritative-block-breaking` on, as
`start_game.server_authoritative_block_breaking = true` reports) with bedrock-protocol 3.60.1 /
minecraft-data 3.117.0 on 2026-10-28. Test server: container `bds-dig`, udp/19148,
`docker/compose.dig.yml`, data in `docker/data/dig` (truth pack deployed with
`pnpm --filter @bedrockbot/truth-pack pack:deploy --data ../../docker/data/dig --restart bds-dig`).

```ts
import { InputLoop } from './skills/input/index.ts';
import { Digger } from './skills/dig/index.ts';
import { Hotbar, World } from './world/index.ts';

const world = new World(conn);
const loop = new InputLoop(conn, { world: { solidAt: (x, y, z) => world.blockAt({ x, y, z })?.solid } });
const hotbar = new Hotbar(conn, { inventory: world.inventory, runtimeId: () => world.self.runtimeId });
const digger = new Digger({ loop, world, hotbar });
const r = await digger.dig({ x: 2, y: -60, z: 0 });            // tool: 'best' by default
// r = { ok: true, block: 'oak_log', slot: 3, item: 'stone_axe', expected: 15, ticks: 15, ms: 738, restores: 0, ... }
digger.cancel();                                                // abort_break on the next tick
```

## Files

| File | What |
|---|---|
| `bot/src/data/mining.ts` | `blockMining(name)`: hardness, effective tool types, harvest requirement (minecraft-data); `toolOf(item)`; `TIER_SPEED`, `TIER_LEVEL` |
| `bot/src/skills/dig/breakTime.ts` | `estimateBreak`, `breakTicks`, `canHarvest`, `MODIFIERS` |
| `bot/src/skills/dig/tools.ts` | `chooseTool(block, slots, selected)`: the hotbar slot to break with |
| `bot/src/skills/dig/look.ts` | `lookAngles`, `faceToward`, `distanceToBlock`, `serverReachDistance`, `checkReach`, reach constants |
| `bot/src/skills/dig/digger.ts` | `Digger`: `dig(p, opts)`, `cancel()`, `lookAt(p)` |
| `bot/src/world/hotbar.ts` | `Hotbar.select(slot)`: `mob_equipment` with the raw slot item |
| `bot/src/skills/input/inputLoop.ts` | one hook: `setTickExtras(fn)` merges fields into each `player_auth_input` and appends flags |

## Break-time table

```
damage per tick = speed / hardness / (canHarvest ? 30 : 100)
ticks           = ceil(1 / damage)          (hardness 0: instant; hardness -1: unbreakable)
speed           = 1 by hand or with a tool that is not effective on the block,
                  else the tier multiplier: wooden 2, stone 4, copper 5, iron 6, diamond 8, netherite 9, golden 12
```

Sources: formula and multipliers from the Minecraft Wiki "Breaking" page (fetched 2026-10-28;
PLAN.md fact 7b). Hardness, effective tool (`material`, e.g. `mineable/axe`) and harvest
requirement (`harvestTools`) from minecraft-data 3.117.0, which serves bedrock 1.26.51 blocks from
its `bedrock/1.26.30` data. The `harvestTools` keys are stale Java-style item ids (groups of five
from 939: sword, shovel, pickaxe, axe, hoe; tiers wooden, stone, copper, golden, iron, diamond,
netherite; 1134 = shears); `mining.ts` decodes them and the unit tests pin the results on known
blocks (stone: any pickaxe, iron_ore: stone+, gold_ore and diamond_ore: iron+, obsidian: diamond+).

Hardness used: grass_block 0.6, dirt 0.5, oak_log 2, oak_planks 2, stone 1.5, oak_leaves 0.2. The
first three are confirmed by the BDS measurement below (a wrong hardness would change the tick
count); planks, stone and leaves rely on minecraft-data and the wiki values.

Modifiers (`MODIFIERS`, documented constants, not applied by `dig()` yet, TODO phase 5):
Efficiency adds level^2 + 1 to an effective tool; Haste x(1 + 0.2 N); Mining Fatigue
x0.3^min(N, 4); head under water /5; not on the ground /5. Haste and Fatigue are the Java forms:
on Bedrock the wiki adds a damage factor (1.2^N for Haste, 0.7^N for Fatigue) and Haste changes in
26.70; measure before relying on them.

### Measured on BDS 1.26.51 (e2e `bot/test/e2e/dig.test.ts`)

`ticks` = bot ticks from the input that carried `start_break` to the tick the `update_block` (air)
arrived; `ms` = wall clock for the same span. Each row is one dig at feet level, 1.5 blocks away.

| block | item | table | ticks | ms |
|---|---|---|---|---|
| grass_block | hand | 18 | 18 | 920 |
| dirt | hand | 15 | 15 | 751 |
| oak_log | hand | 60 | 60 | 3005 |
| grass_block | wooden_axe | 18 | 18 | 919 |
| dirt | wooden_axe | 15 | 15 | 751 |
| oak_log | wooden_axe | 30 | 29 | 1487 |
| grass_block | stone_axe | 18 | 18 | 903 |
| dirt | stone_axe | 15 | 15 | 750 |
| oak_log | stone_axe | 15 | 14 | 735 |
| grass_block | iron_axe | 18 | 18 | 887 |
| dirt | iron_axe | 15 | 15 | 752 |
| oak_log | iron_axe | 10 | 10 | 491 |
| grass_block | diamond_axe | 18 | 18 | 908 |
| dirt | diamond_axe | 15 | 15 | 752 |
| oak_log | diamond_axe | 8 | 8 | 404 |
| oak_log | stone_axe in slot 3, `tool: 'best'` | 15 | 15 | 738 |
| oak_log | wooden_pickaxe (wrong tool) | 60 | 60 | 3011 |
| dirt | `best` with only axe/pickaxe/stick: stick | 15 | 15 | 736 |
| oak_log | stone_axe, back to back #1 / #2 | 15 | 14 / 15 | 736 / 749 |

The server finishes the break on the table's tick count. A measured value one below the table is a
measuring artefact, not an early break: the bot counts on its own 20 Hz driver from the tick that
queued `start_break`, while the server counts from the server tick that processed it, which can
fall into the same 50 ms (the ms column is always N x 50 minus a few ms). The e2e assertion is
`table - 1 <= ticks <= table + 2`.

## Packet shapes (bedrock-protocol 3.60.1 / minecraft-data `bedrock/1.26.51/protocol.json`)

Block actions ride in `player_auth_input`; the input flag is **`block_action`** (InputData 35;
there is no `perform_block_actions` name in this protocol version). The field is
`block_action: [{ action, position: {x, y, z}, face }]` (optional array; `face` zigzag32:
0 down, 1 up, 2 north/-z, 3 south/+z, 4 west/-x, 5 east/+x). Action names (`Action` mapper):
`start_break` 0, `abort_break` 1, `stop_break` 2, `predict_break` 26, `continue_break` 27.

What `dig()` sends (the `InputLoop` adds its own flags, position, yaw/pitch):

| tick | `block_action` | extra flag |
|---|---|---|
| t0 - 1 | (none; the new yaw/pitch, and `mob_equipment` if the slot changes, go out first) | |
| t0 | `[{action:'start_break', position:p, face}]` | `block_action` |
| t0+1 .. t0+N-1 | `[{action:'continue_break', position:p, face}]` | `block_action` |
| t0+N | `[{action:'predict_break', ...}, {action:'stop_break', ...}]` | `block_action` |
| after `update_block` (not the original block) | `[{action:'abort_break', ...}]` | `block_action` |
| on timeout (t0 + max(ceil(1.5 N), N + 4)) or `cancel()` | `[{action:'abort_break', ...}]` | `block_action` |

Instant blocks (N = 0) send `start_break, predict_break, stop_break` in one input.

Server answers: `level_event` `block_start_break` (data = 65535 / N, e.g. 3640 for 18 ticks) plus a
`particle_punch_block_*` and `block_break_speed` per input; on the break `level_event`
`particle_destroy`, several `update_block` (the block and its neighbours, flags `neighbors|network`,
duplicates), `add_item_entity` for the drop, `update_attributes` (exhaustion), and later
`take_item_entity` + `inventory_transaction` when the bot picks the drop up. The truth pack's
`playerBreakBlock` event fires with the held item as `tool`.

Hotbar switch: `mob_equipment { runtime_entity_id: own, item: <the slot's ItemV4 exactly as the
server sent it, extra included>, slot: n, selected_slot: n, window_id: 'inventory' }`, queued
before the next tick's `player_auth_input`. Verified with `truth:pos` (`selectedSlot`) and the
`playerBreakBlock` tool. An empty slot is sent as `{ network_id: 0, count: 0, metadata: 0,
has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } }`.

## How BDS 1.26.51 runs server-authoritative breaking (measured)

- **The server runs its own break timer from `start_break`.** With only `start_break` and no
  further actions, the block still breaks after exactly N ticks (grass 17-18, dirt 14-16, log 60-61
  bot ticks). `continue_break` and `predict_break` are not needed for the break; `dig()` sends them
  anyway, as the vanilla client does.
- **An early `predict_break` is rejected, not punished**: at 5 of 18 ticks the server answered with
  an `update_block` restoring the block and then broke it on its own timer at 18. One tick early
  was accepted silently. No correction, no kick.
- **`abort_break` stops the timer** (block stays; `cancel()` relies on it).
- **The server keeps mining the position after the break until `abort_break`** (like a held mouse
  button): `stop_break` and `predict_break` + `stop_break` do not end it. Without the abort a block
  placed at the same position later is broken at once, and the next dig there finishes early (seen
  as 1 to 8 tick "breaks" before the fix). `dig()` therefore always sends `abort_break` after the
  block is gone. The state is per player and only advances while that player sends
  `player_auth_input`: a fresh player starts clean, and a player whose process was killed mid-dig
  (it stays online for about 10 s) breaks nothing more (tested: a log under a ghost's 60-tick dig
  and dirt placed there afterwards all stayed).
- **No view check**: a break while looking straight up and away from the block was accepted.
- The 5-tick survival delay between breaks (Mojang build-action guide: 250 ms; the wiki says 6
  ticks for Java) is honoured by `dig()` (`BREAK_COOLDOWN_TICKS`); back-to-back digs were on time.

## Reach

`server-authoritative-block-breaking-pick-range-scalar=1.5` (BDS default). Measured with the bot
standing at many positions (horizontal, above, diagonal, behind):

- The accepted distance is **eye (feet + 1.62) to the block's integer minimum corner** (not the
  centre, not the closest point): eye-to-centre and eye-to-closest-point both gave contradictory
  thresholds across geometries, the corner metric fits every sample.
- Limit at scalar 1.5: accepted at 10.048, rejected at 10.096 (all samples: accepted 9.81, 9.946,
  10.044, 10.048; rejected 10.096, 10.125, 10.14, 10.143).
- Limit at scalar 1.0 (temporarily set on bds-dig, then restored to 1.5): accepted at 6.698,
  rejected at 6.717.
- So limit = about 6.70 x scalar (consistent with sqrt(45) = 6.708 x scalar). `SERVER_PICK_BASE = 6.7`.
- **Out of range the server silently ignores the break**: no crack events, no break, the
  `predict_break` is answered with an `update_block` restoring the block; no correction, no kick,
  the connection stays up. `dig()` reports `{ ok: false, reason: 'timeout', restores: 1 }`.

`dig()` refuses anything farther than its own reach before sending a packet
(`{ ok: false, reason: 'unreachable' }`): `reach` (default 5, eye to the closest point of the block,
about vanilla survival reach) and the server limit `6.7 x pickRangeScalar` (default 1.5). It also
gives up with `unreachable` + `abort_break` if the bot is moved out of reach mid-break. A Realm may
use another scalar; 5 blocks stays inside the server limit down to a scalar of about 1.0.

## Tool selection (`chooseTool`)

Over hotbar slots 0..8: fewest ticks; then a slot that harvests the block; then a slot without a
tool (no durability spent where a tool does not help: dirt with only an axe in the hotbar is dug
from an empty or non-tool slot); then the selected slot (no switch); then the lowest slot. So: axe
for logs and planks, pickaxe for stone, shovel for dirt and grass, hoe/shears for leaves, hand
otherwise. `dig(p, { tool })`: `'best'` (default), a slot number, or `'current'`.
`requireHarvest: true` returns `no_tool` when the chosen item would not drop the block.

## `dig()` results

`{ ok: true, block, slot, item, expected, timeoutTicks, ticks, ms, restores, startTick }`, or
`{ ok: false, reason }` with reason `timeout` | `interrupted` (cancel) | `unreachable` |
`no_tool` | `busy` | `not_ready` | `unloaded` | `no_block` | `unknown_block` | `unbreakable` |
`bad_slot` | `no_hotbar`. Success means an `update_block` at `p` to anything other than the
original block.

## Constraints and open points

- One `setTickExtras` provider at a time: only the digger uses it. `dig()` turns the view with
  `InputLoop.setCommand({ yaw, pitch })`; do not dig while `goto` steers.
- Not tested: digging the block the bot stands on (the movement model would learn about the fall
  only from the `update_block` / a correction).
- Drops are picked up automatically when the bot is close (`take_item_entity` about 10 ticks after
  `add_item_entity` at 1.5 blocks); `collect()` is task 4.4.
- Not measured yet: shears and sword speeds, Efficiency/Haste/Fatigue, water and airborne
  penalties, durability use.

## Testing

- Unit (`bot/test/unit/skills/dig-*.test.ts`): table values and harvest decoding, tool choice,
  aiming and face selection against `viewDirection`, reach limits, the digger's per-tick action
  sequence with a fake loop, the `setTickExtras` hook with the real `InputLoop`, `Hotbar`.
- e2e isolation: every track's gate runs the whole e2e project, so several dig suites can run on
  `bds-dig` at the same time (the server log shows overlapping `Dig*` players exactly when the
  suite failed with 4-12 tick "breaks", blocks not broken and a cancel that "succeeded": two live
  bots digging and filling the same position). The suite therefore works in a random private area
  per run (`RunArea`: a cell of a 48-block grid from x, z = 512), digs every position only once,
  uses run-unique truth request ids (`DigTruth`: replies are broadcast to every player, so two
  runs with plain sequence ids answer each other's requests), kills drops only near its own home,
  and cancels any running dig in `afterEach`. Verified: a run killed mid-way followed at once by a
  full run (its ghost still online), a clean run, and two runs started 8 s apart all passed.
- e2e (`bot/test/e2e/dig.test.ts`, `BDS_E2E=1 pnpm --filter bot test:e2e`, needs `bds-dig`):
  4.1 matrix (grass_block, dirt, oak_log x hand and wooden/stone/iron/diamond axe) with the truth
  `playerBreakBlock` event, the drop entity and `truth:block` air; 4.2 stone axe in slot 3 (15
  ticks, server-side `selectedSlot` 3), wooden pickaxe on a log (60), `best` without a shovel,
  back-to-back digs; cancel; own-reach refusal; the server range boundary at scalar 1.5. Prints the
  table above. Env: `DIG_BDS_HOST`, `DIG_BDS_PORT`, `DIG_BDS_CONTAINER`, `DIG_VERBOSE=1`.
