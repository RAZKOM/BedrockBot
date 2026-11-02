# 0051: Temporary scaffold: pillar-up felling and pickups that may dig and place

Date: 2026-10-30. Status: accepted. Details: [../wood.md](../wood.md) "Pillar-up".

## Context

The owner asked why the bot does not build temporary pillars while gathering and break them afterwards:
with wood it got stuck on tall trees and left floating tree parts, and the same applies when it gets stuck
on ores or item pickups. It should either break blocks to reach the target or place permanent or temporary
ones. The feller only re-pathed to ground cells
(trees above 7 logs kept their tops), collect and the miner's pickup walks were walk-only, although the
navigator has had a pillar move (`allowPlace`) and moves that dig (`allowBreak`) since decision 0043.

## Decision

1. **The feller pillars itself** (skills/tree/feller.ts), with the PlaceSkill directly, not through the
   navigator: the pillar must stand next to the trunk at a known height, and the cells it placed must be
   known exactly. A column within 2 blocks of the log, its ground, the lowest top from which the log is in
   reach; it climbs, digging leaves and the tree's own logs out of the jump's head room, fells from the
   top, grows the pillar while the next log is above, and digs it down block by block (1-block drops)
   when it must move or is done. It never walks off the pillar.
2. **A scaffold record** (skills/place/scaffold.ts): every cell placed only to reach something, with the
   block it got. Only those cells are dug again, and only while they still hold that block. A dig-down
   that would drop the bot more than 3 blocks, or a cell it cannot reach without relying on the scaffold
   to get down, is left and logged.
3. **Pickups get one bounded walk that may dig and place** (`collect` option `hard`): after the plain walk
   says unreachable; the navigator's own rules (protected area, built blocks, digPenalty); at most 8
   blocks dug + placed and 300 ticks; once per item. The navigator's place action reports each placed
   block to the running walk (BotSkills.scaffoldGoto), which records it as scaffold; it is dug again after
   the pickup. Gather wood (logs only), the floor sweeps and the miner use it.
4. **The owner's rules hold**: nothing is placed and no leaves are dug inside `protectRadius` of home (a
   log only a pillar reaches there is skipped with that reason); without throwaway blocks everything
   behaves as before. Scaffold blocks may come from the keeper's throwaway reserve: they come back.
5. **No planner change.** The navigator's API (allowPlace, allowBreak, its actions) is used as it is.
6. **Review fixes (2026-10-30, before merge).**
   - B1: the pending scaffold lives on BotSkills (`skills.scaffold`), not in the job. A cancel or any new
     skill but the feller starts the dig-down at once (`descendFirst`); goto and collect wait for it; a newer
     call does not stop it. The next fell digs pending scaffold first, climbing beside a column the bot is
     no longer on and stripping it top down.
   - B2: a placement is recorded whenever the cell was free before the click and holds a scaffold kind
     after it, also when the placer timed out or was interrupted (re-checked for 40 ticks); a scaffold walk
     waits for those re-checks before it ends.
   - H1: only kinds the tools at hand harvest are scaffold (none: no pillar); the keeper's reserve is lent
     only until a scaffold block was left behind.
   - H2: sneak on the scaffold; no pillar with a hostile within 12 blocks; a hostile showing up brings the
     bot down (`hostile_near`).
   - M1-M5: hard walks only for the job's main items (never saplings, sticks, apples, seeds), at most 2 per
     collect within the caller's timeout scale, natural terrain only (the dig action refuses anything else on
     such walks); tree detection refuses log walls (footprint of the lowest 3 layers) and logs touching built
     blocks; the fell is capped at 1200 + 60 per log ticks once a pillar was needed.
   - L1-L3: the 3-block fall limit counts the fall (air below + 1); a side dig only from natural ground; late
     placements re-checked (B2).
7. **Second review (2026-10-31).** The cell under the feet is never given up: failed digs back off and retry,
   and after 6 the column stays pending for the next dig-down (a hostile near, checked every pass, stops it 1
   block above the ground). The dig-down waits for a placement still settling (a pillar jump, a late
   confirmation, a compound skill that places). A goto waiting for the dig-down counts as `nav.busy` (a small
   `Navigator.queue` slot, dropped by `cancel()`), and `status().busy` covers the dig-down. Combat on scaffold
   strikes but never steps; flee's panic run comes down first. Worn tools are not counted for harvesting scaffold
   kinds; the navigator's place hook records a cell only if it was free before the click; dispose stops the
   dig-down; obsidian, ice, sandstone, paths, amethyst and glazed terracotta are not natural terrain.

## Consequences

- Tall trees (spruce, jungle, dark oak, 2 x 2 trunks up to about 30 high) are felled completely when
  the bot carries throwaway blocks; tree detection allows 160 logs (was 96) and at most 8 logs in the
  lowest layer (a log wall stays refused).
- A pillar costs about 1.5 s per block up and down on BDS; the drops of the dug scaffold fall with the bot
  and are picked up on the way.
- The guard fights from the ground: a goto pre-empting a fell on its pillar first digs it down (about
  1.3 s a block with dirt by hand).
- Open: a log whose every column within 2 blocks is blocked (by anything but air, leaves and the tree's logs) stays; the `hard` pickup walk's
  scaffold cleanup assumes the navigator's placed blocks are pillar or bridge cells it can stand on.
