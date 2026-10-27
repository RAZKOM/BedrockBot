# 0030: Exploring by information gain, and branch mining as the miner's fallback

Date: 2026-10-30. Status: accepted (Track AI, wave 9). Server: BDS 1.26.60.6 (`bds-explore`, generated
DEFAULT world, seed 7, peaceful, truth pack). Details and numbers: [../explore.md](../explore.md) and
[../mining.md](../mining.md) "Branch mining". Builds on [0015](0015-world-cache.md) (world cache),
[0021](0021-farm-mine-processes-ore-memory-forests.md) (mine process, ore memory) and
[0025](0025-get-front-door-and-stash.md) (stash step).

## Context

`!mine iron 20` ended `none_left` whenever the bot knew no iron, and the world cache only grew where
the bot happened to walk. The owner wants the bot to find ore and land by itself.

## Decisions

1. **A cell counts by what standing there would show, not by whether its own column is cached.**
   The server streams a disc of chunks around the player (10 chunks on BDS, 369 columns), so every
   cell within 128 blocks of the bot is cached the moment it logs in; "walk to the nearest cell whose
   column is not cached" would do nothing for any radius below the view distance. The frontier
   instead scores a 16-block cell (= chunk column) by its *gain*: the columns within the view radius
   of its centre that the cache does not know yet. The view radius is measured from the loaded columns
   (`floor(sqrt(loaded / pi))`), so a Realm with a smaller view works the same. A cell below 3 columns
   of gain is covered for good (the cache only learns more). Among the cells with gain the cheapest
   wins: distance from the bot minus 24 blocks for a cell next to a visited one, so the walk spirals
   outwards around the start and, for radii below the view distance, effectively walks the ring at the
   edge. Over water or lava (the cached surface class of the cell's sample columns): skipped, no walk.

2. **Explore is a user process with trip readiness, and stops when nothing new is in reach.** It
   uses the normal walk (`settingsMover`, so allowBreak / allowPlace / sprint apply), the process
   manager pre-empts and resumes it on the same cell, `!explore stop` / `!stop` end it. Six failed
   walks in a row end the run (unreachable land, e.g. an island).

3. **Branch mining hooks into the miner at its one dead end.** The only change to miner.ts is one
   line where the loop would return `none_left`: `branchMore(task, skills)` digs one step of a layout
   and returns true, so the loop scans again and the normal mine loop (ranking, approach, line of
   sight, pickup, the stash step of the mine process, pause / resume) mines whatever the new cells
   exposed or brought into the 32-block scan. The layout lives in absolute coordinates (staircase,
   main tunnel, branches), so it continues after the miner walked off to an ore or after a pre-emption.
   It is wired per bot through `attachBranch(skills, host)` from the explore registration (a WeakMap
   keyed by the skills object), so commands-farm.ts and wire.ts stay untouched.

4. **Dig rules are the navigator's.** Every layout cell passes `breakBlocker` (not next to water or
   lava, no gravity block above, not under the feet, not protected) and every new feet cell needs a
   solid dry floor; a blocked staircase or main-tunnel step turns right, then left; a blocked branch
   ends. The staircase clears 3 cells per step (the next column at the old head, the old feet and the
   new feet) so the body never moves straight down and the planner can climb back up the same way.

5. **The Y comes from the vanilla 1.18+ distribution** (`mineBranchY auto`: coal 40, iron 16, copper
   48, gold -16, redstone -58, lapis 0, diamond -58, emerald 232 only when the bot stands at or above
   232, i.e. in the mountains; a number overrides). The stop rules: n ore (the miner), `mineTunnelLen`
   tunnel blocks at that Y without a find, health below 10, no pickaxe, blocked on every side. At the
   end of a run that ended by itself the bot walks back to the staircase's top and then home
   (`!stop` leaves it where it is).

6. **An ore cell of the layout is left to the miner once.** Digging it as a tunnel block would drop
   the item uncounted and uncollected; the step returns to the loop instead, the scan finds the ore in
   the corridor wall and mines it. If it is still there the next time (unsafe for the miner), the
   layout digs it.

## Consequences

- With `mineSeenOnly` off (the default) the 32-block scan sees buried ore through the rock, so the
  staircase is mostly a way into the ground: the run mines the first ore that comes within 32 blocks,
  which can be above the best Y. Branch mining in the classic sense happens with `mineSeenOnly on`
  (only the faces the tunnels open count); the e2e runs that way.
- `mineTunnelLen` now also bounds a branch run (default 32 = about one branch pair without a find);
  the owner raises it for rare ores.
- The explorer needs the world cache (`BEDROCKBOT_CACHE=0`: `!explore` refuses).
- New settings: `mineBranchY` (text), `exploreRadius` (number). New container bds-explore (udp/19198).
