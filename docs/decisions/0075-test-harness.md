# 0075: The server as a test bench (op detection, commands from the bot, recovery, repeated runs)

Date: 2026-11-08. Status: accepted (Track T1; builds on [0050](0050-chat-style.md) (the bot's own slash commands and
their byte limit) and the death and respawn handling of task 5.1; the trips it runs are Track F5b's cave flight,
[0069](0069-cave-flight.md), and the walks of the navigator). Guide: [../runbook.md](../runbook.md) "The Realm as a test
server (Track T1)".

## Context

The owner (2026-11-08): "I can even turn on cheats on the server so the bot can teleport itself and give itself elytra if
it dies and whatnot. That way the realm can be a final test server." Cave flight (`flyCave`) is to be turned on live and
tested on the Realm by repeated runs. Until now every repeated run was an e2e on local BDS, where the truth pack
teleports, kits and kills; on the Realm the only lever is the bot's own `command_request` once it is an operator. A cave
death on the Realm (2026-11-06) also showed what a test run must survive: the bot respawned 600 blocks away without its
kit and walked home.

## Decisions

1. **The rights are measured, not assumed** (`skills/test/ops.ts`). Two sources: what the server sends (start_game
   `permission_level`, `enable_commands`, `achievements_disabled`; every `update_abilities` with `permission_level` and
   `command_permission`, which BDS resends at once on `op` / `deop`) and a probe, `/testfor @s`, which needs the same
   operator level as `/tp`, `/give`, `/effect` and `/replaceitem` and answers with a success message. The verdict is `op`
   only after a successful probe that no later `update_abilities` contradicts; a demotion (`command_permission normal`)
   or commands off (`enable_commands false`) is `not_op` without sending anything. Rejected: the packets alone (a Realm
   may say operator while cheats are off; only the probe shows that the commands run), the probe alone (a de-op while
   online would go unnoticed for the probe's lifetime). The values are logged at every spawn (`ops: start_game ...`), so
   the first Realm session with the code says what the Realm sends.
2. **One runner sends the bot's commands and reads the answers** (`skills/test/command.ts`). `command_request` under a
   fresh origin uuid (chat/route.ts `commandRequestPacket`, now also used by the RL bridge), the `command_output` with
   that uuid is the answer (`success_count`, the first message id and its parameters). One command at a time with a
   150 ms gap, at most 60 a minute, never one over route.ts SLASH_MAX bytes (511 drops the connection), every command
   and its result in the log. A command without an answer times out after 5 s: `/tellraw` succeeds silently, so no
   answer is not a refusal.
3. **Everything that acts is behind `testMode` (default off)** and the rights. Off: `!test` only answers, no command is
   sent, a death goes exactly as before (the afk task walks home). On without the rights: the bot says "the test harness
   needs cheats on and the bot op'd" once and sends nothing. The detector's listeners and its log line run either way
   (they send nothing).
4. **A run is the owner's own command** (`skills/test/series.ts`). `!test cave` dispatches `!fly cave_end` to the chat
   handler as the owner's line (the natural-language executor's way), `!test route r1` `!fly route r1`, `!test goto`
   `!goto`. The harness adds nothing to the trip: what is tested is what the owner would type. The end of a run is the
   trip's own end line and then the bot idle (no user process, not gliding, no corridor trip open between its steps)
   for 2 s; arrival is measured by the harness (the feet within 2.5 blocks of the goal cell), the flown share from the
   gliding flag over the path, the damage from the health, the bail-outs and rockets from the corridor end line. No
   hook in the flight code was needed; a structured trip report from Track F8 would replace the end-line parsing.
5. **Recovery puts the bot back** (`skills/test/recovery.ts`). Before every run: `/effect instant_health` and
   `saturation` when health or food is short, the kit (`testKit`: what the bot carried at the series start, a kit file,
   or a list) by `/replaceitem` into an empty worn slot and `/give` for the rest (a worn slot holding something else,
   the elytra in place of the chestplate, is never overwritten), a fresh elytra by `/replaceitem` in the slot of one
   with fewer than 100 uses, then `/tp` to the run's start and a wait for the body, the chunks and the
   ground. After a death the same restore runs at the series' start once the respawn is through, and the afk task's
   walk home is skipped while a series runs (`respawnClaimed`, read by tasks/registry.ts), so a walk and a teleport
   never race. In a run: `/effect instant_health` below 14 health; no progress for 60 s ends the run (stuck) and
   teleports back; 600 s is the run's time limit. These four limits are constants (`TEST_LIMITS` in
   skills/test/series.ts), not settings: only `testMode` and `testKit` are settings, because the panel state budgets
   had about 100 bytes left (the full state went from 36 901 to 37 347 bytes with the two rows and its cap from
   37 000 to 38 000; `!help settings` from 7 to 8 messages).
6. **Records on the bot's machine**: one JSON line per run and a summary line per series in
   `<config dir>/tests/<time>-<series>.jsonl` (`~/.bedrockbot/tests/` on the Mac), a short chat line per run and the
   summary in chat (the byte limits of docs/chat-style.md hold: the lines stay under 250 characters).

## Consequences

- Cheats disable achievements in that world for good (start_game `achievements_disabled` stays true); that is the
  owner's choice and the runbook says so.
- The kit cannot carry enchantments (Bedrock's `/give` has no enchantment component) or the contents of a shulker box;
  loose rockets are given instead of the fireworks box.
- An operator bot can be ordered to run commands only through `!test` and its own restore; no chat command takes a
  free-form slash command.
- Open: what the Realm sends for an op'd bot with cheats on (logged at the next spawn); whether `/tp` into unloaded
  Realm chunks settles within 15 s; a structured trip report (flown share, bail-outs) from the flight code.
