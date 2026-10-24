# 0021: Farming and mining as processes, persisted ore memory, remembered forests, plantings that do not race pickups

Date: 2026-10-29. Status: accepted (PLAN.md Phase 7 wave 7, Track Z: integration debt from wave 6).
Servers: BDS 1.26.60.6 (`bds-core` normal difficulty, `bds-farm`, `bds-dig`, `bds-cache` seed 7).
Details and numbers: [../farming.md](../farming.md), [../mining.md](../mining.md),
[../world-cache.md](../world-cache.md).

## Context

Wave 6 left five open items: `!farm` and `!mine` ran beside the process manager (guard, flee and
night could not pre-empt them, `!pause` / `!stop` / `!status` did not know them) and created their
own Hotbar and Containers (two Containers on one connection: each logged `item_stack_response ...
unknown slot` for the other's requests, seen on the Realm); the ore memory lived in RAM only; the
gather task did not walk to forests it had seen before; PlaceSkill got `rejected` right after a
harvest (the farmer retried). During the wave the owner added two requests: skip unreachable ores
after one plan (the Realm spent minutes on a dozen ores behind water, 3 x about 3 s each) and make
the seen-face rule an option (`mineSeenOnly`, default off).

## Decisions

1. **`!farm` and `!mine` are user processes** (`tasks/process/farm.ts`, `mine.ts`), built like
   `GatherProcess`: pre-emption = `FarmTask.pause()` / `MineTask.pause()` (the running skill is
   cancelled, the loop holds, counters stay, an interrupted dig is not a failure), resumption =
   `resume()` (a fresh scan). The farm runs until stopped, survives a death and reports `idle()` while
   it waits for crops (the keepalive nudge may run); mining ends by itself and does not survive a
   death. The two exclude each other (each stops the other's process); other commands stack as
   usual. `!status`, `!pause`, `!resume`, `!stop` need nothing new.

2. **One Hotbar and one Containers per bot.** The afk task's registration line passes the PvE Hotbar
   and the task's Containers (already attached to the skills) into `registerFarmCommands`; it only
   creates its own when none are given (tests). The settings getters (`useBoneMeal`,
   `mineTunnelLen`, `mineSeenOnly`) come from the same line.

3. **The cause of the `rejected` plantings is a pickup race, and the farmer avoids it.** Packet
   traces (10 of 10 rejections in a 9 x 9 cycle): the click carries the held seed stack (count and
   stack id); the server merges a picked-up seed drop into that stack in the tick before it reads the
   click, finds a different stack, and refuses: `update_block` with the old block, then a full
   inventory resync. The client's model was up to date when the click was built (the pickup is
   decided on the server, 1 to 2 ticks later). So the fix is in the farmer: harvest everything in
   reach first, then plant (the drops near the body are picked up meanwhile), and wait at most 16
   ticks before a planting while a fresh drop of that seed lies within 2 blocks. PlaceSkill also
   re-checks the slot and the selection right before the click (re-selecting when the stack moved),
   which removes the other, model-side stale-item cases. Measured: 0 rejected over 2 cycles (162
   plantings) in each of 3 runs, cycle times about unchanged (72 to 76 s against 66 to 75 s before).

4. **Ore memory persists as a flag on the world cache's marks.** Bit 1 of a mark's flags byte
   (`seen`) in the region record; old readers ignore it (they read bit 0), so the record version
   stays 1. Every record the OreMemory makes flags the mark (`WorldCache.markSeen`); a column that
   loads again takes the flags of its remembered record (`decodeSeenMarks`: inflate and read only the
   marks, no summary built); `seenMarks(origin, r)` brings them back (`OreMemory.recall`, every scan,
   96 blocks). A mark disappears with its block, so a mined or changed ore forgets itself. A cheap
   passive scan over the marks of the loaded columns (every 100 ticks, 24 blocks, only with a cache)
   records ores the bot merely walks past.

5. **`mineSeenOnly` (default off) decides the candidate set, nothing else.** Off: every known
   matching block (buried ones in loaded chunks, marks of the cache), nearest first, tunnelling to it
   under the same rules (tunnel cap, `next_to_liquid`, never the block under the feet). On: wave 6's
   legit rule. Seen ores are persisted either way.

6. **An unreachable ore costs one plan.** A plan that does not leave the start node (`none`, or the
   navigator's "no progress possible": a partial plan of one node) or a goto that never got a segment
   going marks the ore unreachable for the session and puts it on Track R's blacklist (all its
   failures at once). The nearest 3 candidates are ranked by a bounded probe plan (6 000 nodes /
   40 ms); a candidate whose probe was cut short without progress is only taken when none of the
   others leads anywhere (the full plan then decides).

7. **Gather walks to remembered forests through the finder, not the navigator.** `find.ts` groups
   logs (loaded and cached, Track R's blacklisted ones left out) into clusters (`findLogClusters`);
   when find-tree finds nothing within its radius, `GatherWoodTask` walks to the nearest cluster with
   an `any` goal (near its 8 nearest logs, r = 4) and searches from there. A cluster that yields no
   tree, or cannot be reached, has its logs blacklisted (the blacklist's failure count at once).

## Consequences

- `registerFarmCommands` takes `processes`, `hotbar`, `containers`, `gather` and the settings
  getters; the registry line (Track U's, now Track Z's) passes them. Without `processes` it behaves as
  in wave 6 (the mine-cave stop test uses that path).
- `WorldCacheStats` has `seenCarried` / `seenCarryMs`; loading a known column decodes its record's
  marks once (measured 0.021 ms per chunk over 2 013 natural-terrain records).
- The gather forest walk only knows trees `findTrees` can verify on arrival (soil under the trunk);
  logs outside a vertical window (24 below, 48 above the bot) are not forests.
- The legit rule is no longer the default: on the Realm `!mine` tunnels to buried ore unless
  `!set mineSeenOnly on`.
- Open: the farm's waiting state still holds the user-process slot (a later `!goto` stacks on top);
  a crop dug at the moment of a pre-emption may still break server-side (counted as planted, not
  harvested, once); the passive ore scan needs the world cache (no cache: only `!mine`'s own scan).
