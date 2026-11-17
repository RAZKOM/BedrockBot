# 0095: One build, two protocols (Track U2)

Date: 2026-11-16. Status: accepted. Details and numbers: [../versions.md](../versions.md) "One build, two
protocols" and "1.26.70 preview".

## Context

The Realm runs 1.26.60 or 1.26.65 (protocol 2225). The 1.26.70 previews speak 2259, and the Realm will move on the
day 1.26.70 is released. Up to now the bot spoke the one version it was given. A server on another protocol
refuses it (`outdated_client` / `outdated_server`), so a release-day move meant a redeploy or a config change on the
day itself. A BDS advertises its protocol in its ping; a Realm has no ping, so the bot cannot know its protocol
before it logs in. No minecraft-data release has 1.26.70 yet.

## Decision

1. **The version is picked per session.** With no pinned version (or `auto`), the bot's candidates are the
   preferred version (1.26.60), then every version with a world shim that bedrock-protocol speaks, newest first.
   A server with a ping gets the candidate of its advertised protocol. A Realm gets the version that last spawned,
   else the preferred one. After a terminal version refusal it gets the next candidate not refused yet, once, 1 s
   later. A pinned version is the only candidate and behaves as before.
2. **The world model follows the session's version** (`conn.sessionVersion`): the registry reads it at every
   start_game and loads that version's palette. Decision 0094 keeps state ids stable across sessions.
3. **1.26.70's protocol data is derived, not downloaded.** A recipe of named edits to 1.26.60's `protocol.json`
   (`tools/bump-version/derive/1.26.70.mjs`) is written from Mojang's docs and two independent implementations.
   It is marked `releaseType: 'beta'` until upstream ships the version, and bedrock-protocol is patched to speak
   beta entries. Each edit checks the form of what it changes, and a unit test ties the recipe to the patch.
4. **NetherNet LAN discovery accepts the preview's type-3 packets** (`patches/nethernet@1.1.2.patch`): the
   preview has no RakNet, and its discovery answer comes wrapped.
5. **Blocks newer than the block data** keep the safe defaults of decision 0094:
   - walls, stairs and slabs take a donor's shape;
   - other new blocks are full cubes the digger refuses;
   - measured stack sizes come from `NEWER_ITEM_STACKS`.

## Consequences

- One deploy before release day covers both protocols. On the day, a Realm that moved refuses 1.26.60 and the bot
  joins on 1.26.70 about 2.3 s later (measured against the preview with the ping removed). Every reconnect
  afterwards starts with 1.26.70, the version that last spawned.
- The 2225 path does not change: against BDS 1.26.65.1, `auto` and `--version 1.26.60` send the same packets.
- A deployed config, env or service definition that pins a version keeps the old behaviour. `auto` needs the pin
  removed.
- If the release's protocol number differs from the preview's, the 1.26.70 attempt is refused as well, and the bot
  stays refused until the data is derived again (or taken from minecraft-data) and deployed. The rest of the
  behaviour is unchanged.
- When a minecraft-data release ships 1.26.70: drop the recipe, its patch entry and the beta hunk in one change
  (tools/bump-version playbook, "A preview's protocol").
- Rollback: pin `--version 1.26.60` (no code change), or revert the change and `pnpm install`.
