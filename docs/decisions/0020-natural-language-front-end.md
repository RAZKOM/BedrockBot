# 0020: Natural-language front end: a local model picks commands, the chat runs them

Date: 2026-10-29. Status: accepted (PLAN.md task 7.18, Track Y). Server: BDS 1.26.60 (`bds-core`,
flat world, truth pack) with a fake provider; no model was run (Ollama goes on the user's Mac later).
Details: [../natural-language.md](../natural-language.md).

## Context

Owners want to say "walk home then guard" instead of remembering `!goto home` and `!guard on`. A
language model can translate, but it must not become a second control path: it has no view of the
world beyond a text summary, it can hallucinate names and coordinates, and the bot runs unattended on
a Realm with other players. The machine that runs the bot has no GPU and no model service; the user
will install Ollama on a Mac. Every wave-6 command (goto, guard, kill, gather, mine, farm, eat, ...)
already validates its arguments, refuses players and runs as a process the owner can `!pause` / `!stop`.

## Decision

1. **The model only chooses existing chat commands.** Its answer is a plan, `{ steps: [...] }`, of
   1..8 steps, each one of a closed list (goto by waypoint, goto_xyz, come, follow, stop, guard,
   kill, gather, mine, farm, food, eat, equip, wp_set, wp_del, set, sleep, pause, resume) with typed,
   bounded arguments, or a `question`. One zod 4 schema (`bot/src/nl/plan.ts`) is both the JSON schema
   the model's sampling is constrained to (`z.toJSONSchema`, Ollama's `format`) and the validator of the
   answer; strict objects, so a made-up command or field fails. `set` cannot touch `nlConfirm`;
   `kill player` is refused by the schema as well as by `!kill`.
2. **Checks against what the owner said, after validation** (`nl/executor.ts` `checkPlan`): a waypoint
   must exist, coordinates and radii must be numbers the owner typed, a named player must appear in the
   text, every command must be registered on this bot. Failing any of them turns the plan into a
   question (or `not available: <command>`), never into a guess.
3. **Execution goes through the chat's own handlers.** Each step is a copy of the owner's chat line with
   the command text (`chat.handle`), so owner checks, argument parsing, replies and the process manager
   are exactly those of a typed command. The next step starts when the previous one finished: its done
   reply (`arrived at`, `kill zombie: 3/3 done`, `mine x: ...`, `ate ...`), or no user process left on
   the manager, or right away for instant commands. A failure reply (usage, needs walking, refused,
   `goto: unreachable`) ends the plan. Endless commands (follow, farm) and questions are last steps only.
4. **Confirmation on by default** (`nlConfirm` runtime setting): `!do` replies with one plan line and
   waits 60 s for `!yes` from the same owner; `!no` drops it, or the rest of a running plan. An owner's
   own movement command (`!stop`, `!goto`, ...) also ends a running plan.
5. **Provider behind an interface, off by default.** `NlProvider.complete({ system, user, schema })`
   returns the answer text. `OllamaProvider` is one non-streaming POST to `/api/chat` with
   `format` = the schema and temperature 0; `FakeProvider` (a table or a function) serves the tests and
   `nl-try.ts --fake`. The `nl` config block selects it (`provider: 'ollama' | 'none'`, default `none`),
   so a bot without a model answers `natural language is off` and ignores chat addressed to it.
6. **The prompt carries the state, not the world**: status line, process stack, waypoint names,
   inventory summary, settings, the command reference built from the chat's registered help texts, and
   six worked examples. No block data, no coordinates beyond the bot's own position.

## Consequences

- The model cannot do anything an owner could not type; a bad model at worst asks needless questions
  or proposes a wrong plan that the owner sees before `!yes`.
- Adding a command to the front end is four small edits in `nl/plan.ts` (and a prompt line); commands
  that do not exist yet in a tree (`food`, `sleep` here) are in the schema and answer `not available`.
- Step completion relies on reply texts and the process stack; a command that changes its done reply
  needs its `COMMAND_SPECS` entry updated (unit tests and `nl-core` catch it for the covered commands).
- Replies are observed by wrapping the chat instance's `say` (commands-nl.ts) rather than changing
  chat.ts; another wrapper later must call through.
- The Ollama request / response shapes are from the API documentation and unverified live; the first
  manual run on the Mac (`node scripts/nl-try.ts`) checks them, then `!do` on the server.
- Quality depends on the model; qwen2.5:7b is the default because it follows JSON schemas well at a
  size a Mac runs comfortably. The 20 phrasings in the unit tests are the yardstick for a manual check.
