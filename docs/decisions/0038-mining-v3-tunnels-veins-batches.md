# 0038: Mining v3: direct tunnels and shafts, veins as groups, produce on the floor, several kinds in one trip

Date: 2026-10-30. Status: accepted (Phase 7, wave 10 Track AQ; extends [0016](0016-farming-and-mining.md),
[0021](0021-farm-mine-processes-ore-memory-forests.md), [0030](0030-explore-and-branch-mining.md)).
Servers: BDS 1.26.60.6 (`bds-dig` flat, `bds-explore` seed 7). Details and numbers: [../mining.md](../mining.md)
"Mining v3", [../get.md](../get.md) "Several ores in one trip".

## Context

The owner on the Realm (2026-10-30) asked why the bot struggled so much to mine through to ores instead
of mining straight to them, breaking the group, picking it up and moving on to the next nearest group;
asked that wood dropped on the floor during a wood job be picked up; noted that it can certainly dig
straight down (avoiding lava, drops onto lava and hazards such as dripstone); and asked for `!get ores`,
or several ores batched into one trip, instead of separate `!get iron`, `!get coal` that may retrace a
lot of steps. The logs: an approach was a walk with dig-through,
which digs sideways through 1 or 2 blocks and never down, so an ore 2 blocks under the floor or 6 into
rock was "unreachable" after 3 plans of 100 000 nodes (1.4 s each); a vein was mined one block at a time
with a re-scan between; drops in holes were left. The dig rules of 2026-10-30 (`protectRadius`, built
blocks never dug, `digPenalty` on walks) protect the owner's base and stay.

## Decisions

1. **A cheap walk probe decides walk or tunnel.** Before every approach: a bounded plan without digging
   (home logistics' probe: 4 000 nodes, 300 ms, sliced with yields). Found and at most 3 x the straight
   line + 8 blocks: walk (the approach as before, dig-through allowed). Otherwise, or with no path: the
   direct tunnel. No more "unreachable after 3 full plans": the verdict costs one probe and one tunnel plan.
2. **The tunnel is planned whole on the world model before the first dig** (`skills/mine/tunnel.ts`):
   greedy steps straight at the ore (flat, 1 up, 1 down as a diagonal staircase; a 2 x 2 spiral when
   there is more height than ground to cover; never back the way it came), every cell under the
   navigator's break rules (`nav.breakRules()` + `breakBlocker` without the under-feet rule), a cell the
   way back stands on is never dug, every new feet cell needs a solid dry floor. The first blocked cell
   ends the plan and the ore is skipped with the reason (`tunnel blocked: protected at x y z`), with
   nothing dug. Each cell is checked again on the live world right before its dig. The plan's blocks count
   against `mineTunnelLen`. A blocked straight line because of a liquid next to it falls back to the
   dig-through walk (same rules, it may go around); a protected block does not (the owner's base).
3. **Shafts (owner, 2026-10-30)**: the plan may dig straight down (1 x 1, standing on the block it digs)
   under extra rules checked before each block: the block below known and solid, no liquid in it or its 4
   side neighbours 1 to 2 below, no pointed dripstone in the 3 x 3 below within 3, no gravity block over
   the shaft's top, never within 2 blocks of the world's floor. The staircase is preferred unless the
   shaft digs at least 8 blocks fewer. The way back must exist before the descent: throwaway blocks for a
   pillar (depth + 4) or a staircase up from the bottom (planned too). A shaft that is the short way and
   finds a hazard under the ore skips the ore with that reason instead of a long staircase down beside
   the hazard. Horizontal tunnels into walls are the default.
4. **One step primitive.** `clearStep` (dig a step's cells, rules re-checked) digs the direct tunnels and
   branch mining's staircase and tunnels (`BranchRun.doStep`); `stairStep` / `flatStep` moved to
   tunnel.ts (branch.ts re-exports them).
5. **Veins are groups** (`skills/mine/vein.ts`): after the first block, the flood fill of the same kind
   through face and edge neighbours (deepslate twins and lit redstone are one kind, at most 64) is mined
   from where the bot stands (reach 4.6, line-of-sight digs under the rules, a step into the mined cells
   when needed, no re-plan between blocks), while the kind's quota is open; then one collect over the
   group and a walk to each hole whose drop is still there. `!status`: `vein 3/5`.
6. **Produce on the floor** (`skills/collect/sweep.ts`): before choosing its next target a work job picks
   up its own kind within 8 blocks (mine: ore drops; gather wood: logs, saplings, sticks, apples; food:
   food items, leather, feathers, wool), so the owner's dropped wood is taken before a tree. One entity
   scan when nothing is near (no collect call, no grace wait; the miner used to pay 10 ticks per target).
   Wired for mine, gather wood and the food hunt; farm and build are not this track's files.
7. **Several kinds in one trip.** `!mine iron_ore 8 coal_ore 16 diamond_ore 4`, `!get iron 8 coal 16`,
   `!get ores 32` (every ore kind, one quota for all): one MineTask with quotas; the candidates are the
   kinds still below their quota, nearest first across kinds from wherever the bot stands; a kind drops
   out when its quota is met; the job ends when every quota is met or nothing is left. Status
   `mine: iron 5/8, coal 16/16, diamond 0/4`, end line `mine iron+coal+diamond: ... done`. The NL steps
   `mine` and `get` take `more: [...]` (one example each). Single-kind commands are unchanged.
8. **A run that tunnelled down comes back up at its end** (done or nothing left): the walk (the
   staircases are climbable), a pillar with throwaway blocks, or a staircase dug up.
9. **Setting `mineDirect`** (boolean, default on): off = the approach of wave 9 (dig-through walk only).

## Consequences

- Ores under floors, inside hills and deep under the bot are reached; unreachable ones cost
  milliseconds; the e2e numbers are in mining.md.
- The tunnel is straight by design: it does not route around a protected block (the owner wants the
  stop) and goes around a liquid only through the old dig-through walk.
- A shaft without throwaway blocks needs a staircase back, which is dug only at the end of the run.
- Open: farm and build do not sweep their produce yet; the vein flood fill trusts the world model (BDS
  sends every block, so it is exact on BDS; a Realm behaves the same).
