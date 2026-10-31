# 0051: Temporary scaffold: pillar-up felling and pickups that may dig and place

Date: 2026-10-30. Status: accepted. Details: [../wood.md](../wood.md) "Pillar-up".

## Context

The owner: "When gathering items, why is it not building like temporary pillars it then destroys? For
example with wood it kind of gets stuck on tall trees. It does end up leaving floating tree parts, but I
feel like this also applies for when it gets stuck on other ores or item pickups. Either breaking blocks
to reach the target or placing permanent or temporary ones." The feller only re-pathed to ground cells
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

## Consequences

- Tall trees (spruce, jungle, dark oak, 2 x 2 trunks up to about 30 high) are felled completely when
  the bot carries throwaway blocks; tree detection allows 160 logs (was 96) and at most 8 logs in the
  lowest layer (a log wall stays refused).
- A pillar costs about 1.5 s per block up and down on BDS; the drops of the dug scaffold fall with the bot
  and are picked up on the way.
- Open: a cancelled fell (death, a newer command) leaves its pillar standing (reported in
  `scaffoldLeft`); a log whose every column within 2 blocks is blocked (by anything but air, leaves and the tree's logs) stays; the `hard` pickup walk's
  scaffold cleanup assumes the navigator's placed blocks are pillar or bridge cells it can stand on.
