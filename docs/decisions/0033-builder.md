# 0033: The builder: planned steps on a simulated world, scaffolds, a user process

Date: 2026-10-30. Status: accepted (PLAN.md Phase 7 wave 9, Track AL, task 7.17 "builder").
Server: BDS 1.26.60.6 (`bds-build`, flat, peaceful). Details and numbers: [../build.md](../build.md).

## Context

The owner wants to describe simple structures (a wall, a floor, a box, a hut from a file) and have
the bot build them legitimately from its own inventory, with the clicks a player makes. The pieces
exist: the PlaceSkill (one block per click, verified, pillar-up by jumping; docs/interaction.md),
the Digger (docs/digging.md), the navigator with `getToBlock` / `any` goals, the process manager
(docs/processes.md) and `!get` (docs/get.md). Missing: an order that never walls the bot in, a way
to reach cells that are too high or have nothing to click, materials against the inventory, file
formats, and the command.

## Decisions

1. **Plan first, on a simulated copy of the world.** A build (`!build fill / clear / replace / wall /
   floor / pillar / file`) becomes a list of steps (`place`, `scaffold`, `pillar`, `descend`,
   `unscaffold`, `dig`, `replace`) computed on `SimWorld`, the world model with the build's own
   changes laid over it. The planner checks every step the way the runner will execute it (a stand
   in reach, a clickable support), so materials, scaffold counts and skipped cells are known before
   the bot moves, `!build materials` needs no bot movement, and the unit tests can run whole builds on
   a fake world. Placement order: bottom layer first, inside a layer from the cell farthest from the
   bot towards it (the bot never walls itself in), a cell with no clickable neighbour waiting for one
   that has. Clear and replace: dig lists, top layer first, nearest first.

2. **Stands are never cells the build fills later.** The planner and the runner use the same rules
   (sim.ts): feet and head free, a full block under the feet, no hazards next to the body, the target
   within 4.5 blocks of the eye (to its centre) and a support within the PlaceSkill's own click reach
   (5). Reachability in the planner is a flood fill of stands joined by one-block steps up or down
   (both ways walkable, so the bot never ends in a hole it cannot leave), seeded from the bot and the
   work area's edge. The runner keeps the current spot when it qualifies and otherwise walks to any
   of the 12 nearest stands with `allowBreak` / `allowPlace` off (a walk must never dig through or
   pillar onto the structure).

3. **Two kinds of scaffold, both removed again** (`buildScaffold`, default on). A cell with nothing
   to click gets the shortest chain (up to 3) of support blocks, dug at the end of its layer. A cell
   out of reach from every stand gets a scaffold column next to it: the bot pillars up with the
   PlaceSkill's jump-and-place, places from the top what it can reach, and digs the column away under
   its feet on the way down (landing on each block), so the bot ends on the ground and gets the
   blocks back. A pillar of 7 is therefore built 6 from the ground and 1 from a one-block column,
   not by standing on the pillar itself (which would leave the bot 7 blocks up with no legitimate way
   down). Clear and replace do not scaffold (cells out of reach are skipped).

4. **The build takes its own blocks; the throwaway reserve is never built with.** A throwaway kind
   (cobblestone, dirt, cobbled deepslate, netherrack) is usable for the build only beyond the
   survival keeper's `throwawayMin` reserve after the other throwaway kinds are counted; scaffold
   blocks may be lent from the reserve because they come back. A build without enough blocks is
   refused with the materials line; `fetch` runs `!get` for the missing blocks first through the chat
   handler (as `!get` runs its own commands), then plans again. Out of a block mid-build: the runner
   takes its scaffolds down, then stops and says why.

5. **A user process, and the runner keeps its place.** `BuildProcess` (priority 40): flee, guard,
   night and newer commands pre-empt it, `!pause` holds it, `!stop` / `!build stop` end it. A
   pre-emption cancels the running skill; resuming continues at the same step (a column the bot was
   pushed off is dug from the ground and pillared again). Each step is verified in the world model and
   retried twice, then skipped and reported.

6. **Formats: `.mcstructure` and a JSON layer format.** The reader takes Bedrock's structure files
   (uncompressed little-endian NBT, `block_indices[0]` in x-y-z order with z innermost, the default
   palette); the order was checked against BDS by placing the truth pack's probe structure with
   `truth:place` and comparing every cell with the reader. The Script API (2.10.0) cannot export a
   structure to bytes, so the unit fixture is hand-built NBT (written tag by tag). The JSON format
   (`layers` bottom-up, rows z, characters x, a `legend`) is for structures written by hand. Files
   live in `builds/` next to the config file (or `BEDROCKBOT_BUILDS`, or `worlds/` in the working
   directory). Rotation by 90 / 180 / 270 turns the cells; block states are not turned and not placed
   on purpose (orientation comes from the click), and only block names are verified.

7. **Truth: `blocksdiff`.** The e2e tests compare a box with the expected block list in one request
   (palette + runs in the canonical order), so "0 differences" is one assertion.

## Consequences

- Measured on bds-build: placing about 80 blocks per minute (the 5 x 3 x 5 box in 56 s including the
  walks), digging cobblestone with a stone pickaxe about 40 blocks per minute including the pickup
  (docs/build.md "Measured").
- Liquids, redstone parts, two-cell blocks, entities and block entity data are refused or ignored;
  oriented blocks get whatever orientation the click gives.
- Planning is synchronous code run in chunks on the main thread (yielding every 64 cells); builds are
  capped at 4096 cells. The planner's reachability is a conservative approximation; the navigator has
  the last word (a stand it cannot reach costs a retry, then a skip).
- The NL front end got one `build` step (`shape`, coordinates, height, block, file name) and one
  example; fields the request does not give become `?` and the chat command refuses them.
- Open: placing oriented blocks on purpose (choosing the clicked face and the yaw from the states),
  scaffolds for clear / replace, digging deep holes with a way back out, `!build save` (exporting a
  box to a structure file), materials from chests (`fetch` only knows `!get`).
