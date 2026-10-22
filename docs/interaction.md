# Interaction: placing blocks and using doors, gates, trapdoors, buttons, levers (`bot/src/skills/{place,interact}`)

PLAN.md Phase 7 task 7.3 (Track O). Everything below was measured on **BDS 1.26.60.6** (container
`bds-act`, udp/19158, RakNet, offline, flat world, peaceful, survival, operator,
`server-authoritative-block-breaking` on, TICK_DISTANCE 10) with bedrock-protocol `c9e1fbf2` /
minecraft-data 3.117.0 + the 1.26.60 patch on 2026-10-29. Digging is in [digging.md](digging.md),
the chest click this builds on in [wood.md](wood.md) ("Chest").

```ts
const skills = new BotSkills({ loop, world, hotbar, containers, source: conn });
await skills.place({ x: 10, y: -60, z: 4 });                                  // best face in reach, held block item
await skills.place({ x: 10, y: -59, z: 4 }, { face: 'west', item: 'cobblestone' }); // click the west face of (11, -59, 4)
await skills.place(feetCell, { item: ['cobblestone', 'dirt'] });             // feet cell: pillar-up (jump, place below, land)
await skills.useBlock(doorPos, { want: 'open' });                              // doors, gates, trapdoors: open | closed | toggle
await skills.useBlock(leverPos);                                               // buttons and levers: toggle only
skills.isOpen(doorPos);                                                        // from the block state (door: lower half)
// for a navigator that must not be cancelled by the call: skills.placer!.place(...), skills.user!.useBlock(...)
```

## Files

| File | What |
|---|---|
| `bot/src/skills/place/face.ts` | `BlockFace` ('down' \| 'up' \| 'north' \| 'south' \| 'west' \| 'east'), packet index 0..5, `faceOffset`, `neighbour`, `supportOf`, `oppositeFace`, `faceCenter` / `facePoint`, `faceVisibleFrom` |
| `bot/src/skills/place/place.ts` | `PlaceSkill.place(p, opts)`, `SERVER_CLICK_REACH` (7.19), `DEFAULT_CLICK_REACH` (5), `REPLACEABLE`, `isInteractive`, `cellInBody`, `wireItemOf`, `predictBlock` |
| `bot/src/skills/interact/use.ts` | `UseSkill.useBlock(p, opts)`, `isOpen(p)`, `usableKind`, `stateHolder`, `openState` |
| `bot/src/skills/interact/shapes.ts` | measured door collision boxes: `doorEdge`, `doorBoxes(upper, lower)`, `doorPassable` (not wired into nav/physics, see "Door shapes") |
| `bot/src/skills/index.ts` | `BotSkills.place`, `useBlock`, `isOpen`; getters `placer`, `user` |
| `bot/src/world/hotbar.ts` | `Hotbar.noteRaw(slot, item)` (new): the wire item of a slot an item stack request filled |
| `packs/truth/src/act.ts` | `truth:setblock` (states), `truth:door` (both halves), events `playerPlaceBlock`, `playerInteractWithBlock` |
| `docker/compose.act.yml` | `bds-act` |

## Placing: the packet sequence that works

`place(p)` = put a block into cell `p`. The client clicks a face F of a neighbouring block S (the
"support"); the block goes to S + offset(F). What `place()` sends:

| when | packet |
|---|---|
| slot change | `mob_equipment { runtime_entity_id: own, item: <slot's wire item>, slot: n, selected_slot: n, window_id: 'inventory' }` (Hotbar.select) |
| item in the main inventory | `interact { action_id: 'open_inventory', target_entity_id: own, has_position: false }` -> server `container_open { window_id: 2, window_type: 'inventory' }`; `item_stack_request` place 9..35 -> empty hotbar slot; `container_close { window_id: 2, window_type: 'inventory', server: false }` |
| tick 0 | look at the face centre (yaw/pitch in `player_auth_input`; 2 ticks, `look: false` skips it) |
| tick 2 | `inventory_transaction` (below) |
| until the answer | the block is predicted in the movement model (`loop.world`), restored after |

```js
{ transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'item_use', actions: [],
  transaction_data: { action_type: 'click_block', trigger_type: 'player_input',
    block_position: S, face: F,                         // 0 down, 1 up, 2 north, 3 south, 4 west, 5 east
    hotbar_slot: selected, hand: 'main_hand',
    held_item: <the slot's ItemV4 exactly as the server last sent it (or rebuilt from the model after a move)>,
    player_pos: <eye, feet + 1.62>,
    click_pos: <centre of face F, block-relative, e.g. {x:0.5, y:1, z:0.5} for up>,
    block_runtime_id: <S's network runtime id from the chunk store>,
    client_prediction: 'success', client_cooldown_state: 'off' } } }
```

This is the chest-open click of docs/wood.md with a block item in the hand. No `player_action`
`start_item_use_on` / `stop_item_use_on` is needed (sent around the click in one probe: no change),
and nothing rides in `player_auth_input` (its `item_interact` transaction is for breaking).

**Server answer, accepted** (1 to 2 bot ticks after the click on a local server): `inventory_content`
for the inventory (the held stack one smaller, a new `stack_id`) and armor/offhand/ui windows, a burst
of `update_block` around S (S, the new block at S + F, the cells above and below; flags
`neighbors|network`), `inventory_content` again, the new block once more, a `level_sound_event`
`place`; the truth pack sees `playerPlaceBlock` and `playerInteractWithBlock` (face, held item).
`place()` resolves on the first `update_block` at `p` with a block other than the one that was
there.

**Server answer, refused**: the same `update_block` burst around S, but with the OLD block at `p`
(the server resyncs the client's prediction); no inventory change, no events. `place()` reports
`rejected` on that update, `timeout` if nothing about `p` arrives within `timeoutTicks` (20).
No kick, no correction in any refused case.

### What BDS 1.26.60 checks (probed with raw clicks)

| change to the click | result |
|---|---|
| no look at the block (view elsewhere) | accepted: the view is not checked |
| `player_pos` 30 blocks away | accepted: the server uses its own position |
| `click_pos` block centre instead of the face centre | accepted |
| `trigger_type: 'unknown'` | accepted (the interact event then has `isFirstEvent` false) |
| `client_prediction: 'failure'` | accepted |
| `block_runtime_id: 0` (not S's) | **refused** |
| the target cell overlaps the own body (feet or head cell) | **refused** |
| 3 clicks in one tick with the same `held_item` | **only the first** placed: the held item must be current, so placements are sequential and each waits for its answer (and the new stack id) |
| a face the eye is behind (east face of the block under the feet, eye at x + 0.5) | accepted: a bridge step needs no sneak-to-the-edge |
| support farther than the click range | **refused** (see Reach) |

### Reach (place and use are the same)

The accepted distance is **eye (feet + 1.62) to the clicked block's integer min corner**, as for
breaking (digging.md), with a fixed limit: three geometries (click on the floor, on a block 4 above
the feet, on a side face at head height) at 0.25 and then 0.05 steps:

| geometry | last accepted (corner) | first refused (corner) |
|---|---|---|
| floor, top face | 7.165 | 7.212 |
| support 3 above the floor, top face | 7.152 | 7.397 |
| side face at head height | 7.045 | 7.294 |
| lever on the floor (use) | 7.150 | 7.250 |

So the limit is between 7.165 and 7.212 (about sqrt(52) = 7.21); `SERVER_CLICK_REACH = 7.19`. The
other metrics (eye to the closest point, to the centre, to the click point) give contradictory
thresholds across the geometries. `act-reach.test.ts` pins it (accepted at 7.10 and 7.15, refused at
7.25 and 7.35, for placing and for a lever). The skills refuse before sending when the support is
farther than their own reach (`reach`, default 5, eye to the closest point, about vanilla survival)
or than `SERVER_CLICK_REACH`: `out_of_reach`, no packet.

### Face choice

`opts.face` is the face of the SUPPORT that is clicked (`face: 'up'` = on top of the block below
`p`). Without it every neighbour of `p` that is clickable (has a collision box, not replaceable, not
interactive: a click on a door, gate, chest, button ... uses it instead of placing) is a candidate;
faces visible from the eye first, then the nearest click point; the first one within reach wins.

### Timing (bds-act, local)

| what | ticks |
|---|---|
| click -> block in the world model | 1 to 2 (median 2, n = 46) |
| call -> block (2 look ticks + mob_equipment + answer) | 3 to 4 typically (median 4), 11 to 12 with a fetch from the main inventory |
| pillar step (jump, click, land on the new block) | 6 every time (click at jump tick 4, feet 1.17 above the cell; landed 2 ticks later) |
| use (door, gate, trapdoor, button, lever): call -> new state | 4 to 5 (click +2 to +3) |

### Pillar-up and the body

`p` overlapping the body is refused (`in_body`) except for the pillar case: `p` is the cell the feet
stand in, the body stands on the ground, the block below `p` is clickable and the two cells above the
head are free (else `no_headroom`). Then `place()` presses jump, waits until an input with the feet at
least 0.05 above `p` has been SENT (the server must already have the body out of the cell when the
click arrives: the click goes out after that input), clicks the top face of the block below, releases
jump and waits for the landing (`landed`). A call while the body is already rising over `p` (a
navigator's own jump) waits for the same clearance without touching the jump key. Jump heights per
tick: 0.42, 0.75, 1.00, 1.17, 1.25, 1.25, 1.18, 1.03; the click goes at 1.17 (tick 4) and the block is
there 2 ticks later, long before the body comes back below 1.0 (tick 9). The prediction (the block is
solid in the movement model from the click on) lands the body on it even with a slower server; on a
refusal the prediction is removed and the body falls back. 3 pillars of 3 in the e2e runs: 0
corrections, truth feet exactly 3.000 higher, on ground.

### Items

`opts.item` (a name or a preference list) else the held item if it is a block item (the item registry
gives it a block runtime id), else the first block item in the hotbar, else in the main inventory.
A stack in slots 9..35 is moved to an empty hotbar slot first. **BDS refuses item stack requests
between player inventory slots unless the inventory screen is open** (`item_stack_response` status 49
for main -> main and 50 for the next request, measured), so the move is wrapped in
`interact open_inventory` -> `container_open` (window 2, type `inventory`) ... `container_close`.
With a chest already open the request goes out as is. No empty hotbar slot: `move_failed`.

### Results

`{ ok: true, block, face, support, slot, item, ticks, clickTicks, ms, jumped, landed, distance,
serverDistance }`, or `{ ok: false, reason }` with `not_ready` | `unloaded` | `occupied` (not air,
water, grass ...) | `no_item` | `no_face` | `out_of_reach` | `in_body` | `no_headroom` | `timeout` |
`rejected` | `interrupted` | `busy` | `no_hotbar` | `move_failed`.

## Using blocks

Same click, on the block itself, with whatever the hand holds: a held block is NOT placed when the
clicked block is a door, gate, trapdoor, button or lever (verified with cobblestone and dirt in the
hand; the truth pack's interact event carries the held item). Face = the face seen from the eye
(`faceToward`), `click_pos` its centre. `useBlock(p)` resolves on the `update_block` that changes the
state, 2 to 3 ticks after the click.

| block | state | measured |
|---|---|---|
| door (`wooden_door`, `*_door`) | `open_bit` of the **lower** half | a click on either half toggles; the upper half keeps `open_bit` 0 while open, so `isOpen` reads the half below an upper half |
| fence gate | `open_bit` | opening also turns `minecraft:cardinal_direction` away from the player (north -> south from the north side) |
| trapdoor | `open_bit` | |
| button | `button_pressed_bit` | the server releases it about 1.3 s later (wooden); a second press while pressed: `already_pressed` |
| lever | `open_bit` (on) | |
| iron door / iron trapdoor | | `not_usable` (redstone only), no click |

`want`: `'toggle'` (default), `'open'`, `'closed'`; when the state already matches, no click
(`{ ok: true, changed: false }`). Buttons and levers take `toggle` only (`toggle_only`).
Results: `{ ok: true, kind, block, open, changed, face, ticks, clickTicks, ms }` or
`{ ok: false, reason }` with `not_usable` | `toggle_only` | `already_pressed` | `out_of_reach` |
`rejected` (the server resent the unchanged state) | `timeout` | `interrupted` | `busy` |
`not_ready` | `unloaded`.

## Door shapes (and why goto does not pass doors yet)

minecraft-data's bedrock `blockCollisionShapes` give **every** `wooden_door` state the same box,
x 0..0.1825 (a closed 'south' door). The nav grid (`NavGrid.free`: no boxes) therefore never lets a
path through a door cell, open or not: `goto` through an open door answers `unreachable` after 1 tick
(`act-use.test.ts`, kept as `it.fails`), and the movement model puts the panel where it is not: the
e2e room door (cardinal 'west', closed panel on the north edge) does not stop the modelled body, so
walking into it closed costs about 5 corrections (the open door is then passed straight through). Open fence gates are fine (no box when open):
goto walks through them with 0 corrections.

Measured door geometry (the bot walked along +z into doors of every direction, closed and open, both
hinges, at x offsets 0.25 / 0.5 / 0.75; the server stopped the body at z = -0.300 (panel on the north
edge) or 0.518 (= 0.8175 - 0.3, south edge), or let it through):

| state (lower half) | panel on the edge |
|---|---|
| closed | clockwise of `minecraft:cardinal_direction`: north -> east, east -> south, south -> west, west -> north |
| open, `door_hinge_bit` 0 | opposite the direction: north -> south, east -> west, south -> north, west -> east |
| open, `door_hinge_bit` 1 | the direction itself: north -> north, east -> east |

Thickness 0.1825. `skills/interact/shapes.ts` encodes it: `doorBoxes(info, below)` (the upper half
takes the lower half's state), `doorPassable(states, axis)`. **For the navigation track**: use
`doorBoxes` in `terrain/shapes.ts` `boxesOf` for door states (with the block below for upper
halves), and treat a cell whose door is closed as passable with a `useBlock(p, { want: 'open' })`
action (and `want: 'closed'` behind it when `closeDoors` is set).

## Navigator wiring (Track N)

Track N's Navigator takes `actions: { place?: (p, face) => Promise<SkillResult>; useBlock?: (p) => Promise<SkillResult>; throwawayItems?: string[] }`.
Use the skill objects, not the `BotSkills` methods (those cancel the running skill, i.e. the goto):

```ts
actions: {
  place: (p, face) => skills.placer!.place(p, { face, item: throwaway, look: false }),
  useBlock: (p) => skills.user!.useBlock(p, { want: 'open' }),
  throwawayItems: throwaway,               // e.g. ['cobblestone', 'dirt', 'netherrack']
}
```

`look: false` keeps the navigator's yaw (the server does not check the view); for pillar-up call
`place(feetCell)` while standing (the skill jumps) or while already rising over the cell.

## Tests

| Test | What |
|---|---|
| `bot/test/unit/skills/place-skill.test.ts` | face helpers, body overlap, interactive list; PlaceSkill against a fake world/loop/server: face choice (visible first, never an interactive support), refusals without a click, the exact transaction and its 1.26.60 serialisation round trip, rejected / timeout, prediction installed and removed, pillar-up x3 (clicks only with the feet 0.05 above the cell), no head room, item choice and slot selection, fetch with the inventory screen open, cancel |
| `bot/test/unit/skills/interact-use.test.ts` | kinds and states, door via lower and upper half, want open/closed/toggle, button / lever rules, refusals, rejected / timeout, the measured door edges |
| `bot/test/e2e/act-place.test.ts` | 16 blocks (6 x up, 2 x each side, 2 x down; 3 items) truth-verified with events; fetch from slot 9; 3-high pillar; 2-wide trench bridged (step 1 against the block under the feet) and crossed with goto; refusals with 0 clicks |
| `bot/test/e2e/act-use.test.ts` | door open / close (`want`, upper half), gate opened + goto through + closed behind, trapdoor x2, button, lever x2, closed door blocks / open door walked through (straight walk) / closed behind, goto through the door (`it.fails`, see above), refusals |
| `bot/test/e2e/act-reach.test.ts` | the click range with raw clicks, place and use |

```sh
docker compose -f docker/compose.act.yml up -d
pnpm --filter @bedrockbot/truth-pack pack:deploy --data ../../docker/data/act --world act --restart bds-act
cd bot
BDS_E2E=1 pnpm exec vitest run --project e2e act        # act-place, act-use, act-reach (about 80 s)
```

Env: `ACT_BDS_HOST` (127.0.0.1), `ACT_BDS_PORT` (19158), `ACT_BDS_CONTAINER` (`bds-act`),
`ACT_VERBOSE=1` (skill logs); version and transport from `bot/test/e2e/env.ts`;
`node scripts/e2e-profile.ts <profile>` points ACT_BDS_* at its container too. Every run works in its
own random 64-block cell from x, z = 4096 (`ActArea`), uses run-unique truth ids (`DigTruth`) and
filters the truth events by its own player name.

## Open points

- Door shapes are not in the nav grid or the physics (Track N; see above). Trapdoor shapes from
  minecraft-data are not verified (open trapdoors, top-half trapdoors).
- Prediction is a full cube at `p` whatever the block (slabs, fences ...); only matters until the
  server's answer (2 ticks locally).
- Placement of blocks with orientation (stairs, logs, doors from an item) uses the face-centre click
  point and the current yaw; not checked beyond doors/levers set by the truth pack.
- Not tested on a Realm: the pillar margin (click at feet + 1.17, body back at + 1.0 four ticks later)
  is covered by the prediction, but a refused click there costs a fall of one block.
- Sneaking (to place against an interactive block) is not implemented: such supports are skipped.
- The rest of PLAN.md 7.3 (the planner opening closed doors and gates, `closeDoors`, neighbour-aware
  fence and wall shapes) belongs to the navigation track.
