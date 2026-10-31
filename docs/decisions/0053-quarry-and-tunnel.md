# 0053: `!quarry` and `!tunnel` on the builder's clear

Date: 2026-10-31. Status: accepted. Details: [../mining.md](../mining.md) "Quarry and tunnel".

## Context

The owner: "Also do we have like a straight up quarry command? or like a dig 3x3 tunnel or something?
Like mine out this area would be awesome way to collect stone", and, about the code base in general: "Is
this not building on top of itself and instead rehandrolling the same logic over and over?" The bot had
every piece but no command: `!build clear` (Track AL) digs a box with a stand planner and a runner that
walks, digs and collects; the navigator's break rules (nav/baritone/helper.ts `avoidBreaking`) refuse
built blocks, containers, liquids and gravity hazards; the miner climbs back up out of its tunnels;
branch mining places torches; the mine process runs the stash step when the inventory fills.

## Decision

1. **No new dig, tool, walk or break-safety code.** A quarry is a sequence of `!build clear` slices
   (skills/build `planBuildAsync` + `BuildRunner`, unchanged): horizontal layers top first for `!quarry`,
   cross-sections nearest first for `!tunnel`. Each slice is planned on the live world when it starts
   and again after every pause, so eating, a fight or an unload trip cost nothing but a re-plan.
2. **Refusals through the planner's own model.** Before a slice is planned every solid cell is asked
   the navigator's break rules (`breakBlocker` without the protected area: the owner gave the box, but
   built blocks and containers are refused everywhere). A refused cell is shown to the planner as
   unbreakable (hardness -1), so the builder's planner leaves it and stands around it. The rules are asked
   again right before each dig (the runner's `dig` is wrapped).
3. **Liquids stop the column.** A cell refused because of a liquid (in it or next to it) keeps every cell
   below it in later layers: water and lava stay walled in by the rock they came with. No sealing with
   placed blocks (no existing code does it safely; deferred).
4. **A staircase in the wall.** A quarry keeps one tread per layer along the box's perimeter, starting at
   the column nearest the bot, each one block lower (a spiral when deeper than the perimeter; at least 4
   blocks between treads of one column, so 3 cells over each stay open). The bot walks in and out without
   placing or digging, also inside `protectRadius` where the navigator never places or digs. The end of a
   quarry walks back up to the start with the miner's climb (extracted as tunnel.ts `climbTo`: walk,
   pillar with throwaway blocks, dug staircase).
5. **The tunnel keeps its lane.** After each cross-section the centre column (feet and head) must be
   open, else the tunnel ends with the reason; floor holes are filled with a throwaway block; a torch on
   the left wall every 8 blocks when torches are carried. Not gated by `allowPlace` (the walker's pillar
   setting): the owner asked for this tunnel.
6. **The mine process's stash step, shared.** `tasks/process/stashStep.ts` (extracted from MineProcess,
   which uses it now) runs the stash step when fewer than 2 slots are free; the dug blocks' items are the
   produce (kept, packed first) unless `quarryKeepStone` is off. Still full: the job ends `inventory full`.
7. **Limits.** At most 64 on every side of a quarry (a 64 x 64 layer is the builder's 4096-cell plan
   limit), tunnels 1..256 long, 1..9 wide, 2..9 high; a pickaxe is required.

## Reused / extracted

- Reused unchanged: build/plan.ts `planBuildAsync` (stands, order), build/runner.ts `BuildRunner` (walk,
  dig with the Digger's tool choice, verify, retry, collect, pause), nav/actions.ts `breakBlocker`,
  mine/branch.ts `dirFromYaw`, `turnRight`, `carriesPickaxe`, `TORCH_EVERY`, container/stash.ts (the stash
  step itself), keeper `THROWAWAY_BLOCKS`, items/catalog `minedItem`, `settingsMover`.
- Extracted: tunnel.ts `climbTo` (was MineTask.returnUp's body; the miner calls it), branch.ts
  `carriesTorch` / `placeTorch` (BranchRun.torch uses them), tasks/process/stashStep.ts `StashStep` (was
  MineProcess.tick / stashStep).

## Review fixes (2026-10-31)

- **The stairs stay a way out.** A 1-wide box deeper than its length + 1 and a 1x1 box deeper than 1
  are refused at parse time. Before each layer the treads above it are read on the live world (`wayOut`:
  solid, the 3 cells over each open or diggable and not refused); a cave in a tread, a liquid, or a refused
  cell over one (water behind the wall, a chest) ends the job `blocked: no way out below y N` before it
  goes deeper, and the bot climbs out (climbTo may dig a staircase inside the box under the job's own
  refusals). The treads are held as `Navigator.keptCells` while the job lives: the one nav hook, a set
  every goto's `noBreak` starts with (navigator.ts, two lines), so a fight's or an unload trip's walk does
  not dig them.
- **What hangs on a cell keeps it.** A built block by name is refused even without a collision box (a
  torch, a rail: the break rules call those air); a cell under a built block or a hard non-cube block is
  refused (`supports a block`), and one beside a built non-cube block (`holds a wall block`: a wall torch,
  a ladder, a sign). The tunnel's own torches stand on the floor and are left out of that rule.
- **Players.** A cell a player stands on is refused at the plan and at the dig; `!quarry` refuses to
  start while a player is in or over the box, and the start reply names the direction `here` resolved.
- **The stair head.** A quarry starts at the feet cell outside the box beside the first tread (the bot
  walks there first when farther than 6 blocks) and climbs back to it; a box farther than 64 blocks or
  not loaded is refused.
- The dig-time recheck has the live feet floor (`feetFloorOf`, as the miner's); with `quarryKeepStone` off
  the job's collects leave junk on the ground (throwaway blocks only while short of the reserve); the
  solid-cell count for the ETA yields every 4096 cells; narrow tunnels put the torch on a floor cell clear
  of the bot's body. Reused instead of copied: wire.ts `minerTunnelWorld` / `throwawayCount` /
  `feetFloorOf` (extracted from `createMinerFor`), build/types.ts `key` / `fmtCell`.

## Consequences

- A quarry next to water leaves pillars of rock under and around it; the owner can clear those by hand
  or with `!build clear` once the water is gone.
- The staircase costs depth - 1 blocks of the box; a 1-wide box can be only as deep as its length + 1.
- A liquid or a chest by the staircase ends a quarry early (`no way out`) rather than digging past a
  broken stair; supports of built blocks and of hard non-cube blocks stay as pillars.
- The planner's stands come from the builder's simple stand model (full-block tops, 1-block steps); a
  ledge it misjudges costs a failed walk and a retry, then the cell is skipped and reported.
