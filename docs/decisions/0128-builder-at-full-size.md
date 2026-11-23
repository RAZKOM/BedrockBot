# 0128: The builder at full size: sections, tall builds, resume, speed (Track B3)

Date: 2026-11-22. Status: accepted. New settings: `buildColumnMax` (6), `buildBurst` (4), `buildResume` (on). Details:
[../build.md](../build.md) "Large builds (Track B3)"; the builder itself is [0033](0033-builder.md), its block states
[0124](0124-block-states.md), its files and bill [0125](0125-java-files-and-bill.md).

## Context

The builder planned a whole build at once on the main thread, up to 4096 cells, from what the bot carried. A build
people want (a castle, a large house, a wall round a base) is 5 000 to 50 000 blocks, far more than an inventory holds,
often over 20 high, and takes longer than a session lasts. The scaffold column was at most 6 high and dug after every
layer, the place step waited for each block's answer, and a stop or a restart lost everything: a second `!build`
planned from scratch and would dig a block someone had changed meanwhile if it stood in the way. Measured before the
track on a 75-block fill: 55 s, 35 of it walking between stands, 17 placing one block at a time; the server takes far
more clicks than that (e2e build-rate).

## Decision

1. **A build over 4096 cells, or one whose blocks do not fit, is a job of sections** (`skills/build/job.ts`). Place
   builds in bands of whole layers from the bottom up (a layer over 4096 in even strips across its longer side, the
   farthest first; the blocks every build places last in sections of their own at the end), clear and replace in
   slabs from the top. A section is planned when the one before it is done, on the world as it is then, in the
   planner worker (`skills/build/worker.ts`, through `startWorker`) on a snapshot of the section's area; only that
   plan is kept. Memory is bounded by a section, not by the build; the limit is 262 144 cells. A skipped cell gets one
   more try in a sweep at the end. The alternative, one plan for the whole build in the worker, was refused: its plan
   and its simulated world grow with the build, and every section after the first would be planned on a world that no
   longer exists by the time it runs (a player's change, a section's own scaffold).
2. **The whole bill first, then fetch rounds.** With `fetch` the bill of the whole build is checked before anything,
   so a build that cannot be finished is refused before the first block. Then the blocks come in rounds: out of a
   block on the ground, or short of one at a section's start, the runner ends `restock` with its place kept, the
   controller fetches what fits for the next stretch (B2's bill and fetch), and the bot walks back and goes on at the
   same step. On a column top a missing block is left for the sweep: the bot never walks off a column to fetch.
3. **Tall builds: columns kept, grown and chosen by cover, with the old safety rules.** A column stays while its top
   reaches cells of the layers above and grows by up to 3; a new column's height is the one whose top reaches the
   most cells still to place (less 0.75 a block). The highest column is a setting, `buildColumnMax`, default 6 as
   before: a fall from a column costs its height less 3 in health, so the owner raises it for a tall build (decision:
   risky features ship cautious). While the bot stands on its own column `Skills.onScaffold()` is true, so the
   reflexes of decision 0051 hold (combat strikes without stepping and sneaks, the flee comes down first); no stand is
   beside a drop deeper than 3; a column top is never walked; `!build stop` takes the scaffold down. Clear and
   replace dig from column tops too. The scaffold kind is one a carried tool harvests first (dirt by hand,
   cobblestone with a pickaxe): a tall build's columns are hundreds of blocks, and cobblestone by hand is 10 s a block
   with nothing dropped. The digs wear the pickaxe out (an iron one lasted about 250 of the castle's 1 100), so in a
   job with `fetch` a column's foot with no tool for the kind asks a round for stone pickaxes (cobblestone and
   sticks), once until one digs it again; the tool's wear is not in the whole bill (the scaffold count is known a
   section at a time). Out of scaffold blocks on a column, the cell or the column is skipped for the sweep instead
   of stopping the build (the bot does not walk off a column to fetch). Standing on a roof's slopes or climbing the build's own walls was refused: a stair
   is not a full block to stand on, and a fall from a wall top has no column under it to come down.
4. **Progress on disk and resume** (`skills/build/progress.ts`): the command and its feet, the file's hash, a bitset of
   the cells done, the scaffold blocks out, the owner and the state, written atomically. `!build resume` checks every
   done cell against the world first: air is placed again, another block is left and reported, never dug (it is
   someone's change, not the build's). A build `running` when the bot went away resumes by itself once the bot is
   back and idle (`buildResume`), the scaffold it left dug first, the column under its feet first, but only within
   128 blocks of the build: a bot back at the world spawn does not walk across the world unattended (`!build resume`
   does).
5. **Speed: one stand places all it reaches, in bursts.** The planner weighs a stand by the cells of the layer it
   reaches and places every ready one from it, with the cells of the 4 layers above it that stand on a block, before
   moving; the next cell is then the one nearest the bot (the order by distance from the start took a ring round
   the start from opposite sides in turn: on the planner the e2e castle walked 6 437 blocks between stands, 2 458
   after), and a cell with no stand yet waits for the rest of its layer instead of being skipped; the plain blocks one stand reaches go to the server
   `buildBurst` clicks a tick without waiting for each answer (`PlaceSkill.placeMany`), each verified when its step
   comes (one tick of wait for a burst, not one a block). Blocks whose states the click chooses keep their own look,
   click and verification. The runner logs its time by kind so the next change starts from a measurement.

## Measured

See [../build.md](../build.md) "Measured (Track B3)". In short (a flat test server): a castle of 5 801 blocks, 25 high,
from the home chests with a stop, a resume and a restart in the middle, in 3 536 and 3 544 s from the command (two
runs, 609 to 611 s per 1000 blocks; the low section about 340 s per 1000, the tall one about 1 180, most of it columns and walking), 11 fetch
rounds, 889 scaffold blocks placed and removed, every cell matching with its states; a 734-block hall 1 103 s before
the track (21 cells out of reach) and 221 s after; a 75-block fill 55 s before and 10 s after.

## Consequences

- A large build survives a stop, a death (the progress says `stopped`; `!build resume`), a restart (`running`: it goes
  on by itself) and a player's change (reported, left).
- The default column of 6 means a build over about 11 high needs `!set buildColumnMax` first; the planner skips what
  it cannot reach and says so (`out of reach`), as before.
- The progress file is per server; a new build replaces the last one's record.
- Not done: a fill wider than about 9 in both directions leaves its middle out of reach on the ground (the stands are
  the build's own cells only once placed, and a solid fill has none inside); scaffold bridges across a roof; a
  section's plan made again when the world changed under it while it runs.
- Not done: a large build fed from shulker boxes the bot carries (the owner's goal of 2026-11-22). What works is the
  older path: the build's own blocks in carried boxes count in the bill and the runner takes them out on the ground
  (decision 0052), and boxes in the home chests count as home (`!bring` takes from them, raw materials too, so the
  bill crafts from them). Missing: the bill's crafting pool leaves out what carried boxes hold (logs in a carried box
  are not made into planks or slabs); no fetch step takes a craft's inputs out of a carried box, or stows what a round
  made into one when the inventory is full; a round's fit counts free slots, not box room; and no e2e builds a large
  structure from boxes alone with the box count kept.
