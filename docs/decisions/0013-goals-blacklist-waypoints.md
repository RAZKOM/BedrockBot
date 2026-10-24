# 0013: Goal types, a failure blacklist and per-server waypoints

Date: 2026-10-29. Status: accepted (PLAN.md task 7.10). Server: BDS 1.26.60.6 (`bds-move`, flat
world, truth pack). Details and numbers: [../pathfinding.md](../pathfinding.md) ("Goals",
"Blacklist") and [../waypoints.md](../waypoints.md).

## Decisions

1. **`Goal` stays, `NavGoal` is the wider union.** PLAN.md 4.3's `Goal` (block, near, xz) is what
   existing code switches over exhaustively (tasks/pve.ts `goalText`, typecheck with
   `noImplicitReturns`); widening it would have forced edits there. `NavGoal` adds any, getToBlock,
   yLevel, runAway and surface; `Navigator.goto`, `plan` and `BotSkills.goto` take it. Goals stay
   plain data except `runAway.from`, which may be a function (an entity's position): it is read at
   every plan and once more when the path ends, so a chasing threat makes the navigator plan on.

2. **getToBlock = Baritone's GetToBlock plus diagonals, plus reach and a visible face.** The feet cell
   is in one of the 8 columns around the block (block at the feet or the head), on top of it or 2
   below; the block is within `reach` by the digger's own measure (`checkReach`: eye to the closest
   point, and the server's corner limit); and if the block has an exposed face at all, one is turned
   to the eye. With only the 4 sides the face rule is always true (the face borders the cell the bot
   stands in); diagonals give more places to stand in crowded spots, and there the rule matters (a
   chest in a corner). A buried block (no exposed face) needs adjacency only.

3. **surface = sky above the head and not below the local ground.** "Nearest cell with sky access"
   alone is satisfied at the bottom of an open pit, so `!top` would do nothing there. The goal also
   asks for the feet to be at most a step (0.5625) below the 25th percentile of the column tops in
   the 7 x 7 columns around (from the v2 sky-column cache). The low percentile keeps the foot of a
   cliff, an inside corner and a tree trunk on the surface while 1 x 1 to 3 x 3 pits and narrow
   ravines are not. The heuristic is the rise to that level, so a limited search still climbs.

4. **The blacklist counts per key and is consulted by default only for work targets.** Keys are the
   target block of block / near / getToBlock goals (`b:x,y,z`, so the tree finder can ask about a
   log whatever goal type reached for it), `xz:`, `y:`, and action cells `dig:` / `place:` / `use:`.
   3 failures (unreachable or timeout; for action cells a failed or timed-out action) skip the key
   for 6000 navigator ticks; failures farther apart than that never add up; a success clears it.
   Goals are counted and consulted only for `any` and `getToBlock` (or `{ blacklist: true }`): a home,
   a shelter or a `!goto` that failed three times must still be tried at night, so plain gotos never
   are. Action cells are always counted and always applied (the planner simply plans around them).

5. **An `any` failure blames one member, unless the search proved all unreachable.** When the last
   main search was exhaustive (`none`) every member is counted; otherwise only the member with the
   lowest estimate from where the body gave up (the one it was heading for). Blaming all members
   for one stuck goto would blacklist reachable logs.

6. **The feller counts logs, not stand cells.** Its re-path gotos go to stand cells (block goals,
   not blacklisted); when no stand cell could be reached for a log, or its dig failed 3 times, the
   log gets one failure. Three failed fells blacklist it; the feller and the tree finder then skip
   it (`TreeOptions.skip`, `FellDeps.blacklist`), so the gather stops walking back. The gather's own
   per-tree attempt count (2) stays.

7. **Waypoints live next to the config file, one JSON file per server.** The config dir is where
   the user already keeps bot settings (outside the repository); `--no-config` keeps them in memory
   so test runs never write there. The server id comes from the target (host_port, or the Realm
   name), so the Realm and the local servers never mix. Every change is written at once (temp file
   + rename); there is no batching because changes are rare (chat, deaths, spawn).

8. **spawn falls back to start_game.** BDS 1.26.60.6 sends `set_spawn_position` at the join with no
   position (all -2^31), so the world spawn from `start_game` (y 32767 = no height, stored as null)
   is used until a usable packet (bed, `/spawnpoint`) arrives, and only when there is no spawn
   waypoint yet, so a bed spawn survives a restart.

9. **Shared files take minimal hooks.** registry.ts: one import and one `registerNavCommands(...)`
   call; the waypoint-aware `!goto` re-registers itself before each `!goto` line so index.ts's later
   coordinate-only registration does not win; the afk task's home access, `statusLine`, `status`
   and `stop` are wrapped from commands-nav.ts. astar.ts: the goal test gets the grid, and one
   `noAction` set (pillar cells and doors not to use). skills/index.ts: `goto` takes `NavGoal`, the
   tree finder and the feller get the blacklist.

## Consequences

- The afk task's skills get the packet source and the PvE hotbar attached (for `!top`'s pillaring),
  which also enables the door moves and pillar-up for every afk walk with `allowPlace`.
- A missing place action (no source attached) makes pillar attempts fail and, after 3, blacklists
  the cell for 5 minutes; with the attach above that only happens for real failures.
- PvE flee (tasks/pve.ts) still runs to a fixed point 12 blocks away; switching it to
  `{ type: 'runAway', from: () => threat feet, r: 16 }` is a one-line change left to its owner.
