# 0131: Fetch builds that run by themselves (Track B6)

Date: 2026-11-23. Status: accepted. No new setting. Details: [../build.md](../build.md) "Trips, chores and a full
inventory (Track B6)"; the fetch is [0125](0125-java-files-and-bill.md), large builds [0128](0128-builder-at-full-size.md),
the boxes [0129](0129-builds-from-shulker-boxes.md), the room for a take [0096](0096-milk-on-hand.md) point 12.

## Context

A `!build ... fetch` at a site far from home, with a full inventory and boxes, did not get far by itself:

- every trip home and back was walked, however far, and the walk back aimed at the build's own cells;
- the home chores (the unload above all) took the body in the gaps between the build's processes. The unload put a
  carried full box and what the step before had brought back into the chests;
- a take's room-making unloaded what the step before had brought (`!bring clay_ball 64 home`, then `!bring iron_ingot
  95 home` unloaded the clay, then `!bring clay_ball 64 home: changed nothing`);
- with a full inventory a take changed nothing and the fetch went home to try it again, or said `cannot craft ...
  yet; my inventory is full` with three empty boxes carried;
- a chest changed after it was read (a console command, a player) stayed unseen until `!chests clear` and `!chests
  scan`, so the bill said `cannot get 3 red_shulker_box` with the boxes in the chest;
- a box step that changed nothing sent the bot home, where the boxes are the same;
- there was no way to build a file with a few blocks nobody can get.

## Decision

1. **Trips the way `!goto` goes.** A build trip farther than `flyMin` goes through the walk `!goto` uses (flown when
   `autoFly` and the flight kit allow). The fetch steps done at home travel home first, and the trip back aims at a
   point `LAND_MARGIN` (4) outside the build's box on the side the bot comes from, then walks the rest. One log line a
   trip says whether it flew, and why not when it walked.
2. **A hold process.** From the command (or a resume) to the end of the build, its fetch and the box pickup after it, a
   do-nothing user process `build-hold` is ranked just over the chores (PRIORITY.chore + 1). The chores start only with
   no user process, so none starts in a gap. A reference count covers the nested parts (run, fetch, job, resume).
3. **The fetch's items are pinned.** The controller registers what the current fetch needs (the bill's items, brings,
   crafts, inputs, smelts and fuel, made again with each bill; `setBuildKeeps` / `buildKeepsOf` in
   `tasks/process/build.ts`), and the withdrawal's room choice protects them (`HomeDeps.keep`). Not the whole plan:
   pinning every material stopped build-large's second round of planks (no room for the last stack beside the glass
   and stairs left from the round before, which the room-making had unloaded until then).
4. **Room before a take.** `nextFetchStep` stows the finished build items into the carried boxes before a take that does
   not fit, then the inputs that wait for their craft (the crafts take them out a chunk at a time). When nothing could
   be stowed, the take is cut to what fits with a slot kept free. A box the build places is never stow room
   (`notInto`). A take that changed nothing on a full inventory stops the fetch with `my inventory is full ...` and no
   trip home. A box step that changed nothing never sends the bot home.
5. **One re-read before `cannot get`.** In reach of home, the bill that would say `cannot get` reads the home chests
   again (forced) once and is made again. `!chests scan` is forced too.
6. **`fetch skip missing`.** The cells of what the bill cannot get, the highest first, as many as the shortfall, are
   refused like the builder's own refusals (`cannot get it (skip missing)`): in the plan line and skipped in the status.

## Consequences

- e2e build-far: a hut 100 blocks from home flew home and back (8 s each way, about 100 blocks), with no chore, the
  chest's box of stone bricks brought, `done` and blocksdiff 0. A yard with a 33-of-36 inventory of boxes ended `done`
  with blocksdiff 0, the fetch stowing into the empty boxes between its crafts and no step undoing another.
- The unit guard (`build-commands.test.ts` "Track B6") runs the fetch with timed processes and a ticking manager: with
  the hold removed a chore started 4 times during the build.
- Not done: the build's own shulker boxes stay carried for the whole build (they could wait in a home chest until
  their section); away from home the chests are not read again before `cannot get`; `skip missing` takes the highest
  cells, not the least visible ones.
