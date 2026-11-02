# 0034: Command tiers, short and deep help, modes, welcome, hints (Track AM)

Date: 2026-10-29. Status: accepted (Track AM, wave 9). Server: BDS 1.26.60.6 (bds-core).

## Context

The owner pointed out that commands existing does not mean a user will ever use them, and suggested a
simple help and a deep-dive help: they would never call `!cook` themselves, but the bot should still know
how to cook when it gathers its food. They also said that if `!get wood` and `!get iron` just work, hiding
`!gather` and `!mine` is fine, as long as `!get` does not take the items from their chests.
`!help` printed all 35 command names in one line; settings had to be learnt key by key; nothing told
an owner what changed after an update.

## Decisions

1. **Tiers on the command itself.** `CommandDef` gains optional `tier` (`front` / `more`), `group`
   (go / work / fight / home / control / info), `example` and `auto`. Default `more`, so commands added
   by other tracks need no change to keep working and land in the deep help until tagged. The
   "needs walking" stubs register only name and help: a name in `FRONT_DOOR` (help.ts) counts as
   front. Front door: come, follow, stop, home, get, guard, status, do, help (build, explore, unload
   after the merge). `!goto` stays `more`: `!come`, `!home go` and `!do` cover the in-game cases.
2. **The help text stays `syntax (description)`.** `!help <command>` splits at the last parenthesis;
   `Chat.helpText()` (the natural-language reference) keeps its `!name help` form and appends
   `(also on its own: ...)`, so the prompt learns what the bot does by itself without a new field.
3. **Help formats bounded by the chat**: `!help` at most 3 messages (phrases dropped before a 4th),
   `!help all` at most 4, 256 characters each. `!commands` = `!help all`. `!help settings` lists the
   mode first.
4. **Modes are bundles over existing settings**, applied through `RuntimeSettings.set` / `reset`, so
   persistence, `!set` and the panel see them as ordinary values; no "mode" setting is stored. A mode
   key at its default is reset (not written). `!mode status` derives the mode from the values.
5. **Welcome once per version**, keyed `<package version>+<tag>` and stored as the text setting
   `lastWelcomed`; sent with the update notifier's `whisperOwners` (`/tell`), not a new channel; on
   the first sighting of an owner by name in chat or a `player_list` add.
6. **Hints are a pure function** (`hintFor`) of the reply and live facts, applied in `Chat.say` only
   when the result fits in one message. Exactly three rules; `!unload` is detected at runtime.
7. **Answers are a plan step**: `answer` (text, 200 characters, the only step) goes through the same
   schema, check and executor as `question` and is said verbatim; nothing runs.
8. **The panel Help tab** reads `GET /api/help` once instead of growing `/api/state`.
9. **`!get` never takes from containers**: the catalog strategies all produce items; pinned by a unit
   test, stated in docs/get.md and docs/ux.md.

## Consequences

- The NL settings list excludes `lastWelcomed` (the model cannot change it).
- `!help`'s old one-line reply (`commands: !status !pos !quit !help`) is gone; chat.test (unit and
  e2e) were updated.
- Deletion candidates are listed in docs/ux.md; none were removed (they are the plumbing of `!get`
  and `!do`).
