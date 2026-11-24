# 0134: Fetch rounds that fit (Track B9)

Date: 2026-11-23. Status: accepted. No new setting. Details: [../build.md](../build.md) "What a fetch round gathers
(Track B9)" and "Scaffolding"; large builds and their rounds are [0128](0128-builder-at-full-size.md), the boxes
[0129](0129-builds-from-shulker-boxes.md), a full inventory [0131](0131-fetch-builds-that-run-by-themselves.md).

## Context

A Java house of 46x18x51 (9 573 blocks, 125 kinds, 9 406 to place after the refusals) came in 9 shulker boxes holding
its blocks and the logs for its planks, slabs, stairs and trapdoors. The bot was given them, 3 empty boxes, the 6 boxes
the house places, its tools, rockets, food and a dozen raw materials to craft and smelt the rest: 36 of 36 slots, two
empty chests beside the site as home. `!build file <name> x y z fetch` placed nothing: four tries on the Realm ended
`fetch round 1: nothing to do from what I carry (cannot craft 108 jungle_slab, 6 iron_trapdoor, 313 jungle_planks
yet); my inventory is full`. Reproduced on a test server with the same file and boxes, it stopped 4 s after the
command, after one stow of 2 stacks:

- **No working room.** A craft needs its inputs out of a box and room for its output (the fetch keeps 3 slots free);
  with 0 to 2 free slots nothing fits. The stow that makes room moves only the bill's own items, and none of the
  bill's were loose: the slots were the kit, the carried boxes, the boxes the house places in a later section, and raw
  materials the round did not use. Nothing ever moved them, and the home chests beside the site stayed empty.
- **A round sized past its section.** The round's need was the running section's, then the next sections' while they
  fitted in the free slots and the boxes' room (98 stacks here), counting the stacks already in the boxes as if they
  had to come in. The first round asked for the planks, slabs and stairs of the second section too: crafted ahead,
  planks take four slots for each slot of logs, so the boxes' room went to blocks placed hours later.

## Decision

1. **Park what the round does not use.** Below STOW_FREE (8) free slots, with free slots in the read home chests,
   `nextFetchStep` first returns `park` with the loose kinds the bill does not use (`parkKinds`): not its items,
   inputs, brings, crafts, smelts, fuel or gets, not the kit (`kitItem`: anything that does not stack but a box,
   food, rockets), not the throwaway reserve (the scaffold), and of the shulker boxes only an empty one of a kind the
   build places. The controller travels home first when it is farther than `flyMin`, and runs the park as a box-work
   process; the home logistics' `park` puts those slots, whole, into the nearest read chests with room (never a box
   block), reading each again. The bill counts the home chests (loose and in boxes), so a later round that needs
   them brings them back with `!bring ... home`. A park that moved nothing is not asked again on that free-slot count.
2. **A round is the running section.** `BuildJob.roundNeed` takes what the running section has left to place, as far
   as it fits; the sections after it come in rounds of their own. What is had of an item (carried or boxed) costs no
   slot. The budget counts the slots a park would free (other items, at most the home chests' free slots).
3. **A box finds a cell off a wide build.** On the lower layers of a 46 x 51 build every cell round the bot is a cell
   of a later layer, so a refill found no cell for its box within 6 and the build stopped `out of ...` at 678. The
   runner now looks within 32 sideways and 12 below (`BOX_STAND_FAR`) when 6 has none; a fetch round's take or stow
   that finds none walks out of the build's box to the `LAND_MARGIN` point, or on out from it (`BOX_OFF_MORE`, 8) to
   the first stand with a free cell beside it that is no planned stand of the running section (those of a wall lie up
   to 4 outside it: the walk to the margin alone ended among them and the take stopped at 2 126), to within 1.
4. **A step up onto a raised floor.** The planner's walks step one block up or down; a floor two blocks thick has its
   top two over the ground, and while its second layer goes down no cell over its first is a stand. Placed from round
   it, the second layer's middle was out of reach: 2 875 of the second section's 4 055 cells skipped, none placed by
   the sweep. A cell with no stand and no column now gets a step (`Planner.step`): one scaffold block on the ground
   beside a reachable stand, from whose top an unreached stand is one up, found by walking back from the stands that
   would place the cell, at most 4 checked by a fresh walk search, not searched again until the plan's world
   changes; a support of its layer (dug at its end). Offline on full blocks the house's sections skip 25 of 9 406 (21
   after the sweep: blocks hanging on nothing the planner can click) instead of 3 279.
5. **A walk crosses a half top.** With the server's block shapes a line of bottom slabs on the floor (placed early
   from the ground) walled its middle off: 626 cells still skipped live. `reachableStands` now walks across a half
   top (`canCross`, `halfTop`); it is never a stand. Offline with the shapes: 22 skipped in the second section.
6. **Room for the block the build is out of.** A stretch's take, box by box and in part stacks, filled the inventory
   before the box holding the block needed now (`my inventory is full (my shulker boxes still hold 99
   dead_fire_coral_block)`). Once a step the runner puts the build's other loose kinds back into the boxes
   (`makeRoomFor`) and takes the block.
7. **A way out of the stand.** The runner may place from any stand that reaches the block, not only the plan's. On
   the house it stood in a cell the build left open, among blocks topped with bottom slabs (a rise of 1.5), and its
   block on the last open side shut it in: 20 minutes of `walk: unreachable`, a box set down beside it never picked
   up, the build stopped `cannot get` at 5 778 of 9 384. A placement (and each block of a burst) now never uses a
   stand the block would shut in (`sim.ts wayOut`: a walk from it, with the block there, still leaves the build's
   footprint grown by 3, or finds more than 4 096 cells; a map art or a build wider than 64 only has to get 3 blocks
   sideways). The local rule alone let the runner shut itself in a room of 13 cells by its last pane. A floor is a
   top that covers the cell's centre, as the goto's (`floorShape`): an open trapdoor's panel, 1 high at one side of
   its cell, gave that room a way out the goto did not have, and the runner shut itself in it again. The planner's
   walk search no longer climbs from a half top onto a full top (a rise of 1.5).
8. **The boxes the build places stay empty.** The room chore never fills a carried box of a kind the build places,
   while the build runs or is stopped with a resume (`buildBoxesOf`, marked like a box owed to a chest). After a stop it
   had boxed 24 green_wool and more into a red box the house places later.
9. **The pickaxe's last uses go to the scaffold.** A shulker box drops whatever breaks it, so it is dug with the fastest
   tool only while that tool has more than `BOX_DIG_KEEP` (64) uses left, then by hand (60 ticks against 10). The
   house's refills had dug 239 boxes and worn a new iron pickaxe to the wear limit at 3 685 placed.
10. **A tool round that stops does not stop the build.** A fetch round asked for the scaffold tool that stops
    (`cannot craft 1 stone_pickaxe yet`) lets the build go on digging the scaffold by hand, as the runner already does
    when the tool cannot be got; no later round of the job asks for it.
11. **A resume finds what a stop interrupted.** A stop that lands while a block is clicked leaves the block placed and
    the cell unmarked; the resume's bill counted it again and, the boxes holding exactly the house's blocks, refused
    (`cannot get 1 cactus`, the dye for one green_wool). `BuildJob.survey` now marks done every unmarked cell that holds
    its block with its states.
12. **A get brings the item itself.** `getHow` takes a gather only when the catalog's item is the one asked for: the
    catalog reads `stripped_<wood>_log` as that wood's logs, and the bill's `!get stripped_pale_oak_log 6` chopped none
    and stopped the build at its third section. A stripped log is now `cannot get` up front.
13. **A section's run skips are tried again before the next section.** A later section stands on the cells an earlier
    one placed: four ceiling cells skipped at run time (the landing at the top of the stairs) made the next section
    plan 413 cells skipped instead of 122. `BuildJob.tryAgain` plans them once more (`[again]`) right after their
    section; the plan's own skips still go to the sweep.

## Consequences

- e2e build-house (the house's file and boxes, from env vars, never committed; docs/build.md "Measured (Track B9)"):
  from 0 placed to 9 186 of 9 270 placed and 140 skipped in 8 037 s through a stop, a resume and a restart, 26 rounds,
  blocksdiff 181 of 42 228, no box left out, no death; it still ends one round short (`cannot get 12 smooth_quartz, 1
  pale_oak_shelf` in the sweep). Unit guards: `build-b9.test.ts` (the park step, the round, the logistics' park, the
  step up, slabs crossed, the way out with the footprint and the open trapdoor, the box dug by hand, the tool round,
  the interrupted placement, the get, the section's skips tried again), `inventory-room.test.ts` (the build's boxes),
  and `build-commands.test.ts` "Track B9" (a kit filling 36 slots: stuck before, parked and built now).
- More rounds than before for a build whose sections are small, each costing what its steps cost (no trip when the
  materials are boxed); a far site pays a trip home a round for what comes from home.
- Not done: a full set of carried boxes parks finished items nowhere (the round's size keeps them in what is carried);
  a park never takes a full carried box home; 12 smooth_quartz and 1 shelf of the house went missing before its sweep
  (not found); the goto's dig-out can dig the build's natural blocks; a bot shut in by built blocks is not dug out.
