# Third-party notices

Code translated from other projects lives in its own folder with the upstream licence next to it. Baritone
(https://github.com/cabaletta/baritone, LGPL-3.0; cloned read-only at `.work/baritone`, branch `1.21.11`,
commit `23723891da460ef15797b02fe5b385b0c5b163cc`) is ported file by file under `bot/src/skills/nav/baritone/`
(licence text: `bot/src/skills/nav/baritone/LICENSE`); every ported file starts with Baritone's LGPL header
adapted as `Ported from Baritone (<upstream path>@23723891), LGPL-3.0`. Our own files import these modules
and never paste translated code. Decision record: docs/decisions/0043 (supersedes 0005's "no code copied").

| Upstream path | Commit | Our file | Track |
|---|---|---|---|
| `src/main/java/baritone/pathing/movement/MovementHelper.java` (the rule functions), `src/main/java/baritone/pathing/precompute/Ternary.java` (YES / NO / MAYBE), `src/main/java/baritone/utils/ToolSet.java` (`getBestDestructionTime` / `getBestSlot` as `breakTicksWith` / `bestTool`) | `23723891` | `bot/src/skills/nav/baritone/helper.ts` | BB |
| `src/main/java/baritone/pathing/calc/AbstractNodeCostSearch.java`, `src/main/java/baritone/pathing/calc/AStarPathFinder.java` (the best-so-far bookkeeping, `failing`) | `23723891da460ef15797b02fe5b385b0c5b163cc` | `bot/src/skills/nav/baritone/bestSoFar.ts` | BA |
| `src/main/java/baritone/pathing/movement/movements/MovementTraverse.java`, `MovementAscend.java`, `MovementDescend.java`, `MovementDownward.java`, `MovementPillar.java` (the `cost` functions: break sets, costs, refusals; the execution is ours) | `23723891` | `bot/src/skills/nav/baritone/moves.ts` | BC |
