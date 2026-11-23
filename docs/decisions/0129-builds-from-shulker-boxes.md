# 0129: Large builds fed from shulker boxes (Track B4)

Date: 2026-11-22. Status: accepted. No new setting. Details: [../build.md](../build.md) "Shulker boxes (Track B4)"; the
builder at full size is [0128](0128-builder-at-full-size.md), the bill and the fetch [0125](0125-java-files-and-bill.md),
the shulker-aware jobs and the `Supply` [0052](0052-shulker-aware-jobs.md).

## Context

The owner (2026-11-22): "if i give it a bunch of shulkers with the necessary materials it should be able to build out
something huge (and craft from said materials if needed, like make slabs or whatever it needs)". After Track B3 a large
build came from the home chests in fetch rounds. Carried boxes counted only for the build's own blocks (the runner took
a block out when it ran out of it, decision 0052): the bill's crafting pool left out what the carried boxes held, so logs
in a box were never made into planks or slabs; no fetch step took a craft's inputs out of a box or put what it made into
one; a round's fit counted the free slots, not the boxes' room; boxes handed over were not picked up; and nothing kept
track of a box set down when a stop, a death or a restart came.

## Decision

1. **One pool.** The bill counts the usable inventory, everything the usable carried boxes hold (not the fireworks box)
   and the home chests (loose and in their boxes), in that order, as one pool for the crafting chain and the smelts.
   What the making takes out of the boxes is the bill's `unbox` list (`from my boxes: ...` first in its steps). A
   throwaway kind taken out of a box (the furnace's cobblestone) takes the reserve's shortfall with it. Only what the
   craft chain was given counts as used by it: an item the crafter keeps (a box, a tool) in a home chest is not
   brought (found by the e2e: the round's first step was `!bring orange_shulker_box 1 home`).
2. **Box steps in the fetch.** `nextFetchStep` can say `unbox` (the materials the next craft, smelt, furnace or fuel
   needs) or `stow` (below 8 free slots, the build items the fetch has finished: never a throwaway kind, an input or
   the fuel). A craft whose inputs come out of the boxes is cut to what the inventory holds, its inputs and every
   step's output in stacks, so the crafter never runs out of room mid-craft (where it drops the grid). Each box step
   runs as a user process of its own (`build-boxes`): it pre-empts the fetch's process instead of replacing it, and a
   pre-emption runs it again for what is left. The alternative, a chat command for the take (like `!bring`), was
   refused: the take needs the build's cells to stay off (point 4), which a chat command does not know.
3. **The runner loads the stretch ahead.** On the ground, at a section's start and after a fetch round, the runner takes
   out of the boxes (`Supply.takeMany`: each box holding any of it set down once) what the next steps place, as far as
   it fits in the free slots less 4; when the take needs room, the loose build items the stretch does not use go into
   a box first (`Supply.stowMany`). A fetch round's fit counts the free slots plus the boxes' room. The per-kind refill
   of decision 0052 stays for what runs out later.
4. **Where a box goes.** Never on a cell of the build (every section's, done or not; a clear's or replace's whole box),
   on a scaffold column or a planned stand of the running section, under any of them, over a drop or in a liquid. With
   no such cell beside the bot it walks to the nearest stand within 6 that has one and tries once more.
5. **Boxes handed over.** `!build ... fetch` first picks up the shulker boxes lying within 8 blocks and says how many; a
   box put in a home chest is home (after a scan): `!bring` brings the box itself (the home's own rule, unchanged), and
   it is a carried box from then on.
6. **No box left in the world.** Every box set down is in the progress file (`boxes`, standing or lying) before its place
   request goes, through a watcher on the `Supply`'s box state (`BoxState.onChange`). A stop (of the build or of its
   fetch) and a build's end pick the boxes up in a process of their own once the work has wound down; a resume (by
   hand or after a restart) adopts the boxes the file names and picks them up before it builds anything, and a
   recovery still waiting when the resume comes gives way to it. A box stays in the box state's list until it is
   picked up or given up (before, the list was emptied for the walk to it, so a watcher saw nothing out). Empty boxes
   are kept.

## Measured

A fort of 2 348 blocks fed only from 9 boxes (8 handed over, one in a home chest; logs, sand and cobblestone among
them), stopped at a quarter with a box standing and resumed, on a test server, twice: 1 647 s from the command both
(701 s per 1 000 blocks, about 420 s of it one furnace smelting 42 glass), one fetch round of 15 commands (7 takes out
of the boxes, 5 crafts, a furnace, a smelt), 4 runner loads; the box out recovered in 4.3 s after the stop, or picked
up by the resume 0.3 s after it; truth:blocksdiff 0 of 18 942 cells with states, no box or scaffold block left, the 9
boxes all back. Details: [../build.md](../build.md) "Measured (Track B4)".

## Consequences

- A build can be fed from boxes alone: the owner hands over boxes of blocks or of raw materials, and the bot crafts,
  smelts, stows and builds, the boxes all back in its inventory at the end.
- The shared box helpers grew: `Supply.contents`, `freeSlots`, `boxRoom`, `takeMany`, `stowMany`, `outstanding`,
  `watch`, `adopt`; `BoxState.onChange`; `BoxOps.takeBack` takes the cells to avoid. The home chore and the storage
  jobs are unchanged.
- Not done: a death's own pickup of what the boxes held (they drop with the body like any item); a box the owner hands
  over by other means than dropping it near the bot or putting it in a home chest; the bill does not plan which box to
  open first by the walk (the box holding most of what is wanted goes first).
