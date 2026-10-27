# 0041: Dimension changes, portal travel and Nether safety

Date: 2026-10-30. Status: accepted (Phase 7, wave 10 Track AT; the first half of "Elytra, Nether and End").
Server: BDS 1.26.60.6 (`bds-nether`, udp/19202). Details: [../nether.md](../nether.md).

## Context

The world model already switched dimensions on `change_dimension` (chunks and entities cleared,
the cache keyed by dimension), but nothing had been verified on a real dimension change, the bot
had no way to travel through a portal, and the behaviours assumed the overworld: night shelter and
beds, home, the surface goal, the waypoints. The Nether adds lava lakes, fire and magma; the End adds
the void. Elytra flight is a later physics track.

## Decisions

1. **The client answers the server's `dimension_change_ack`.** Recorded on bds-nether: after
   `change_dimension` the server sends `player_action dimension_change_ack` (0.4 to 3.3 s later) and
   ignores every `player_auth_input` until the client sends the same action back; nothing else is
   needed (no `respawn`, no loading-screen packets). `DimensionWatcher` (world/dimension.ts) is
   created by the World before its own handlers, answers the ack and reports `start` (old dimension
   still readable) and `arrived`. `change_dimension.position` is taken as feet (it is for teleports;
   approximate after portals until the `move_player`).
2. **The planner's grid is cleared on every change.** `NavGrid` caches classified cells by
   coordinates only; the overworld's would answer for the Nether at the same x y z. The lava and
   spawner indexes forget their positions when the dimension changes. Every user process except the
   portal trip is stopped (a walk to overworld coordinates means nothing in the Nether).
3. **The planner never walks into a portal; the portal trip steps in by hand.** `portal` stays a
   hazard in classify.ts, so no ordinary walk travels by accident; `PortalProcess` walks to the cell
   in front of the portal, steps in, stands still (the server moves the player after about 4 s,
   measured 3.8 s), waits for the ack, records both ends as waypoints and steps out. No portal
   building in this track: `!nether` with nothing known says what is missing.
4. **Waypoints are per dimension by name prefix.** One flat store per server (waypoints/store.ts)
   stays; overworld names are plain, the Nether's carry `nether_`, the End's `end_`. `portal` /
   `nether_portal` pair the two ends. `!goto` and `!wp set` resolve and prefix by the current
   dimension; an overworld waypoint is refused in the Nether. Home is an overworld point.
5. **Overworld-only behaviours are switched off by dimension, in one registration.** Night shelter
   and sleeping (no day cycle, beds explode), home and the shelter for flee, guard and the home
   return; the surface goal and `!top` refuse in the Nether. The wiring wraps the existing instances
   (`NightProcess.wants`, `requestSleep`, `PveDeps.home / shelter`, `task.home.go`) from
   `chat/commands-portal.ts`, so the other tracks' files only got small named edits.
6. **Lava is a planner cost, not a wall.** Lava cells near the bot are avoidance sources (the
   snapshot the planner worker already rebuilds): 60 ticks next to lava, 8 at 2 blocks. A path keeps
   a free block between the body and a lava lake when there is room and still goes through when it
   is the only way (a wall would make goals beside lava unreachable).
7. **Fire is escaped by a process above flee.** `FireProcess` (priority 101) walks to the nearest
   cell clear of fire and lava when burning hurts and eats afterwards; on a clear cell it lets the
   flames go out. No water bucket.
8. **The End: no irreversible drop.** `Navigator.costsOverride` sets `maxDrop` 1 there; together
   with the planner's rule of a floor within `maxDrop` this keeps the bot off the void edge.
9. **Piglins are never fought while the bot wears gold.** They stay neutral (a threat only after
   they target or hit the bot); with any golden armour piece worn, never. Brutes are hostile.

## Consequences

- Any code that caches by block coordinates must listen to `world.dimensions` (or compare
  `self.dimension`); the planner grid, lava and spawner indexes do.
- A trip not made with `!nether` / `!overworld` records no portal waypoints.
- The truth pack can now teleport across dimensions and edit blocks in any dimension
  (packs/truth/src/nether.ts), so later tracks (Elytra, fortresses) can build their test areas there.
