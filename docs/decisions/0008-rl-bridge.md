# 0008: RL reset and bridge

Date: 2026-10-29. Status: accepted (PLAN.md tasks 6.1 to 6.3). Server: BDS 1.26.60.6 (`bds-rl`, flat
world, truth pack). Details and numbers: [../rl.md](../rl.md).

## Decisions

1. **Reset builds the arena with fillBlocks / setType from a seeded plan, not a `.mcstructure`.**
   PLAN.md 6.1 says "place a .mcstructure". The Script API cannot write structure files, and a world
   structure (`structureManager.createFromWorld`) would only cache what the generator builds anyway.
   The plan is pure code (`packs/truth/src/rl-layout.ts`): about 10 fills (ground, air, barrier ring)
   plus a few fills and sets per tree; building takes 3 to 6 ms on BDS, so the whole reset (command
   to parsed reply) is 77 to 184 ms, far under the 2 s target. Benefits: any seed is a new forest
   without pre-made files, the checksum of a plan is known without touching the world (`planChecksum`
   = truth:checksum of the built box, unit-tested), and the arena can be placed at any origin (each
   e2e run uses its own). `truth:place` / `structures` stay available for hand-made scenarios.

2. **The bot sends the reset itself (`command_request` as an operator)**, not `docker exec`: the env
   needs no Docker access and works for any number of servers; the reply comes back as the usual
   `@truth` text line (`ReplyParser`), correlated by a random per-client id tag.

3. **The arena is deterministic in typeIds**: persistent leaves (no decay), dirt under each trunk
   (grass under an opaque block turns into dirt on a random tick, which changed the checksum a few
   seconds after a reset in the first e2e runs), a barrier ring so the agent cannot leave.

4. **Own minimal WebSocket server (`bot/src/bridge/ws.ts`, RFC 6455 without extensions)** instead of
   adding the `ws` package: the bridge carries one small JSON message per frame on loopback; a
   ~250-line server avoids a new runtime dependency and lockfile churn while other tracks edit the
   workspace. Unit-tested against Node's built-in WebSocket client, used live by Python's
   websocket-client.

5. **Observations from the bot's world model only** (PLAN.md section 9): the bridge's reset waits until
   `World.checksum(box)` equals the reset's checksum, so the first observation of an episode already
   shows the new arena.

6. **High-level actions are skills; movement actions are raw inputs.** goto_nearest_log, dig and
   collect use the Skills facade (serialised; the executor also awaits each action fully).
   step_forward / jump_forward / turn hold keys on the input loop directly (no pathfinder), stop on
   distance, landing or a wall, and settle; 0 corrections in every run so far.

7. **`terminated` / `truncated` added to the 4.5 schema** (additively, `done` kept): Gymnasium needs
   the distinction, and the bot owns the episode limits (200 steps, 2400 ticks, 16 logs, death).
