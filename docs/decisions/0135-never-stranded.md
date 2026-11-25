# 0135: A build never strands itself (Track B10)

Date: 2026-11-24. Status: accepted. No new setting. Details: [../build.md](../build.md) "Never stranded (Track B10)";
the way-out rule for stands is [0134](0134-fetch-rounds-that-fit.md) item 7, the boxes [0129](0129-builds-from-shulker-boxes.md).

## Context

A fetch build of a 46 x 51 house fed from shulker boxes placed 1 475 blocks on a mountain and stopped `out of stone`
while its boxes held hundreds. The bot stood on the ground floor among walls it had built; every walk planned 1 node
(`no progress possible`), then `unreachable`; each refill said `no free cell for the box next to the bot`; the fetch
round found the stone in the boxes and did nothing (`done in 0 commands`); the next ask for the stone was the stop.
A teleport out and `!build resume` went on at once.

- **Why the B9 guard did not stop it.** `wayOut` was checked only for the stand a block is placed from, with that
  block. Every other walk of the runner went unchecked: the walk to a box stand (any stand within 6, then 32 sideways
  and 12 down, with a free cell beside it), the walk to a column's foot, and the foot a column top comes down on, whose
  last way out a block placed from the top could close. A walk can drop into a pocket the build closed earlier from
  outside (drops of up to 3), and a box stand 4 below the feet, as there, is such a drop. Once in, nothing got out:
  the walks never dig or place, and the goto's own dig-out may not dig the build.
- **The false `out of`.** A refill that found no cell for its box left the item boxed; the runner asked for a round;
  the round's bill counts what the boxes hold as had, so it did nothing, and the second ask is the stop, worded as if
  the item were gone.

## Decision

1. **Dig out of a pocket.** A walk of the runner (to a stand, a box stand, a column's foot) that fails where the bot
   cannot walk out (`wayOut` with the build's footprint), or fails twice from one cell the way a shut-in walk does,
   digs the cheapest way out (`sim.ts digWayOut`: wayOut's walk where a cell in the way may be dug; a scaffold block
   costs 1, a block of the world 4 (never put back), a block of the build 6, one that would not drop itself 30; never bedrock-like,
   interactive or container blocks, nothing under a falling block or beside a liquid; at most 8 cells, `DIG_MAX`), digs
   along it and walks again. At most 6 times a run (`OUT_TRIES`).
2. **What was dug is placed again.** A cell of the plan dug this way is unmarked and placed again before the runner
   ends; another section's (or one found there already) is unmarked in the progress and planned again in an `[again]`
   section right after the running one (at most 4 such rounds a job, `UNDONE_ROUNDS`). A runner on its own places
   back a plain block it found there already; one with states is reported skipped.
3. **Box stands with a way out.** The nearest 12 box stands are checked with `wayOut`; one the walk could reach but
   not leave is passed over.
4. **A column top never shuts its own foot in.** A block placed from a column top (and each block of a burst there)
   must leave the column's foot a way out once the column is dug (`baseOut`).
5. **The box on the build as the last resort.** When no cell off the build is found near the bot, after the walks to
   box stands, the box may go on a cell of the build not placed yet (never a planned stand, scaffold cell or column of
   the plan, never a cell holding its block); it is picked up again at once, and a stop finds it in the progress file.
6. **No false `out of`.** A round that had nothing to do for items the carried boxes hold takes them out itself (a
   take, off the build's box when there is no cell where the bot stands) and counts as a step; when nothing came out
   it stops with what the boxes hold and why. The runner's own stop for an item the boxes hold, after a box job found
   no cell, says `no cell to set a shulker box down near x y z (my shulker boxes hold N item)`.
7. **The boxes handed over are all picked up.** The pickup goes on in passes (at most 3, `HANDED_PASSES`) while a pass
   brings one in: one of 9 boxes dropped by the server landed after the first pass and its blocks were `cannot get`.
8. **A round fits what the kit leaves free.** With a kit of 27 slots two rounds stopped: one brought the section's
   finished blocks before the logs for its planks and could not craft them (`my inventory is full`), one ran a bring of
   2 stacks with 3 free slots that the withdrawal (a box out of a home chest needs its slot and 2 more) could not do
   (`changed nothing`, twice). `nextFetchStep` now brings the crafts' inputs first, crafts what it can before bringing
   a finished block, leaves `FETCH_FREE_MIN` (3) free and, for a finished block, the slots the crafts still make; short
   of room it stows the bill's loose items, else parks, else brings a part; a job's round (`FetchNow.round`) with
   nothing more fitting and some of the bill carried ends with what came. With read home chests all full
   (`FetchNow.homeFull`: the site's two chests were full, so nothing could be parked) the stop says `my inventory is
   full (...) and the home chests are full: !bring ... needs N`, never `changed nothing` or `cannot craft yet` alone.
   Arrows are the kit (`kitItem`).
9. **A round is cut to its room.** A round sized to the whole running section (about 25 kinds, thousands of blocks)
   stuck on a bring at 13 of 36 slots: the build's items carried counted as free slots and as had at once.
   `roundNeed` gets the empty slots (the build's items carried counted as taken, less `SLOT_MARGIN`), the parkable
   slots and the boxes' free slots, and takes the running section's cells in build order (`remainingNeed().seq`)
   until the room runs out, one slot more for each kind not had. No stack is filled up from later cells (the leftovers
   filled the boxes and a test round stuck); a round with no room asks one stack of the next kind.
10. **The table is fetched.** A crafting table the furnace or a craft needs, in a box or at home and not carried, is
   taken out or brought (`billOf`): the chain counted it as had without using it up, and `!furnace` failed on the
   test server after a round had parked the table.
11. **Dirt that turned to grass is the dirt.** `sameBlock('dirt', 'grass_block')`: placed dirt beside grass in the light
   turns to grass by the game's spread; a resume left 180 such cells of the house as `another block`.

## Consequences

See docs/build.md "Measured (Track B10)". Unit guards: `build-b10.test.ts` (digWayOut, the runner and the job digging
out of a ring and placing it back, a pocket with no way out, a pit passed over as a box stand, the box on the build,
the stop's words, the round that fits the kit, dirt and grass, the table for the furnace) and `build-commands.test.ts` "Track B10" (the round's own take, its
stop, the round cut to the Realm kit's room, the pickup passes); e2e `build-stuck` (a bot inside a ring of the build's blocks).
