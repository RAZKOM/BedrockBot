# Natural language (PLAN.md 7.18)

Owners can talk to the bot in plain words. A local model (Ollama) turns the request into a **plan of
existing chat commands**; the bot shows the plan, waits for `!yes`, then runs the commands one by one
exactly as if the owner had typed them. The model never moves the bot, never picks coordinates or
names the owner did not say, and can only choose from the commands below. Decision record:
[decisions/0020-natural-language-front-end.md](decisions/0020-natural-language-front-end.md).

```
Steve: !do walk home then guard
Bot:   plan: goto home, then guard on (!yes to run, !no to drop)
Steve: !yes
Bot:   walking to home (10 -60 3)
Bot:   arrived at home (10 -60 3)
Bot:   guard on, radius 16
Bot:   plan done (2 steps)

Steve: Bot, go to the castle
Bot:   I know no waypoint "castle" (known: home, spawn, mine). Which one, or which x y z?
```

## Setup on the Mac

1. Install Ollama (https://ollama.com, the macOS app or `brew install ollama`) and start it (the app
   runs the server on `http://127.0.0.1:11434`).
2. Pull the model: `ollama pull qwen2.5:7b` (about 4.7 GB; any model with structured-output support
   works, e.g. `llama3.1:8b`, set with `model`).
3. Add the `nl` block to the bot's config file (`%LOCALAPPDATA%\bedrockbot\config.json` on Windows,
   `~/.bedrockbot/config.json` on the Mac; runbook "Configuration"):

   ```jsonc
   "nl": {
     "provider": "ollama",              // "none" (default) = off
     "url": "http://127.0.0.1:11434",   // default; another machine: http://<mac-ip>:11434 (OLLAMA_HOST=0.0.0.0 on the Mac)
     "model": "qwen2.5:7b",             // default
     "timeoutMs": 60000                 // default; the first call loads the model (several seconds)
   }
   ```

4. Try it without a bot: `cd bot && node scripts/nl-try.ts "walk home then guard"` prints the model's
   raw answer, the validated plan, the checks and the commands it would run. Options:
   `--waypoints home,base,mine`, `--model`, `--url`, `--prompt` (print the system prompt), `--schema`
   (print the JSON schema), `--fake` (no model: the six worked examples), `--no-config`.
5. Start the bot as usual; the log says `natural language: ollama qwen2.5:7b (!do, or "Bot, ...")`.
   Then on the `chat` server: `!do come here`, `!yes`.

## Commands

| Typed by an owner | What happens |
|---|---|
| `!do <text>` | the plan line, or a question, or `not available: <command>` |
| `<botname>, <text>` / `<botname>: <text>` / `@<botname> <text>` | the same as `!do` (only when `nl.provider` is not `none`) |
| `!yes` | runs the waiting plan (only the owner who asked; within 60 s, else `plan dropped (no !yes within 60 s)`) |
| `!no` | `plan dropped`; during a run: drops the rest (`plan dropped after step 1/2 (...)`; the running command goes on, `!stop` ends it) |
| `!set nlConfirm off` | plans run without `!yes` (the plan line is still shown). Only an owner's `!set` changes it, never a plan |

Only owners: non-owner chat is ignored like every command. While a plan runs, another `!do` gets
`busy with a plan (!no drops the rest)`; an owner's own `!stop`, `!goto`, `!come`, `!follow`, `!kill`,
`!gather`, `!mine`, `!farm`, `!home`, `!top` ends the plan (the command itself runs as usual).

## Safety rules

- **Closed command list.** The answer must validate against the plan schema; anything else (prose, a
  made-up command, an extra field, an argument out of bounds) is rejected with
  `I could not make a plan of that (...)`. Nothing runs.
- **No invented targets.** Waypoints must exist on this server; coordinates (goto, wp set) and radii
  (guard, farm) must be numbers the owner typed; a named player must be in the text (`come` / `follow`
  without a name mean the owner). Otherwise the bot asks.
- **Same path as typed commands.** Each step is fed to the chat's own handler as the owner, so every
  existing guard applies: owners only, `!kill` never attacks players, movement is the navigator's,
  guard / flee / night keep priority, `!pause` / `!stop` work.
- **Confirmation by default** (`nlConfirm` on), one plan at a time, at most 8 steps; `follow` and `farm`
  (endless) and a `question` can only be the last step.
- **Local only.** The provider talks to the configured URL (default 127.0.0.1); no accounts, no keys.

## The plan schema

`bot/src/nl/plan.ts` (zod 4). `{ "steps": [ step, ... ] }`, 1..8 steps, strict objects:

| `command` | Arguments | Chat command |
|---|---|---|
| `goto` | `waypoint`: name (`[a-z0-9_][a-z0-9_-]{0,31}`) | `!goto <name>` |
| `goto_xyz` | `x`, `z`: integers within 30 000 000; `y`: -64..320 | `!goto x y z` |
| `come` / `follow` | `player?`: one word, 1..16 | `!come [player]` / `!follow [player]` |
| `stop` | | `!stop` |
| `guard` | `mode`: on / off; `radius?`: 2..64 (on only) | `!guard on/off` / `!guard <radius>` |
| `kill` | `type`: mob id (not `player`); `count`: 1..64 | `!kill <type> <n>` |
| `gather` | `count`: 1..2304 logs | `!gather <n>` |
| `mine` | `block`: block id; `count`: 1..256 | `!mine <block> <n>` |
| `farm` | `radius?`: 1..32 | `!farm [radius]` |
| `food` / `eat` / `equip` | | `!food` / `!eat` / `!equip` |
| `wp_set` | `name`; `x y z?` (all or none) | `!wp set <name> [x y z]` |
| `wp_del` | `name` | `!wp del <name>` |
| `set` | `key`: a runtime setting except `nlConfirm`; `value`: within its bounds | `!set <key> <value>` |
| `sleep` / `pause` / `resume` | | `!sleep` / `!pause` / `!resume` |
| `question` | `text`: 1..200 characters | replied verbatim; ends the plan |

`food` and `sleep` are in the schema although this tree has no such chat command yet: the bot answers
`not available: food` until a track registers it. The JSON schema the model sees is
`node scripts/nl-try.ts --schema`.

### How a step finishes

`COMMAND_SPECS` in plan.ts: `goto`, `come`, `kill`, `gather`, `food`, `sleep` wait until the process
manager has no user process left (or their done reply: `arrived at`, `here (`, `kill <type>: `);
`mine`, `eat`, `equip` wait for their end reply (`mine <block>: `, `ate ` / `eat: `, `equip: `);
`stop`, `guard`, `wp`, `set`, `pause`, `resume` are done once they answered; `follow` and `farm` are
done once started. A reply starting with `usage:`, `unknown command`, `refused`, containing
`needs a task that can walk`, or the command's own failure (`goto: unreachable`, `come: I cannot see
Steve`, `no waypoint`, `<key> must be ...`) ends the plan: `plan stopped at step 1/2 (goto home):
goto: unreachable`. A step may take at most 10 minutes.

## The prompt

`bot/src/nl/prompt.ts`. System prompt: the rules (commands only, no invented targets, ask when
unclear), the command reference (each step kind's JSON form and the bot's own help text, e.g.
`[chat: !goto <waypoint> | x y z (walk to a waypoint or a feet block)]`, or `(not available on this
bot)`), the bot state (status line with position and behaviour, process stack, waypoint names,
inventory summary from `!inv`, settings with values) and six worked examples. User message:
`request from <sender>: <text>`. `node scripts/nl-try.ts --prompt "..."` prints it.

## Ollama request and response

From the Ollama API documentation (`POST /api/chat`, "Structured outputs"); **unverified live** (no
Ollama on the development machine; the unit tests check the parsing against these recorded shapes).

```jsonc
// POST http://127.0.0.1:11434/api/chat
{
  "model": "qwen2.5:7b",
  "messages": [
    { "role": "system", "content": "<system prompt>" },
    { "role": "user", "content": "request from Steve: walk home then guard" }
  ],
  "stream": false,
  "format": { "type": "object", "properties": { "steps": { ... } }, "required": ["steps"], "additionalProperties": false },
  "options": { "temperature": 0 },
  "keep_alive": "30m"
}
// 200
{
  "model": "qwen2.5:7b",
  "created_at": "2026-10-29T12:00:00.000000Z",
  "message": { "role": "assistant", "content": "{\"steps\":[{\"command\":\"goto\",\"waypoint\":\"home\"},{\"command\":\"guard\",\"mode\":\"on\"}]}" },
  "done": true,
  "done_reason": "stop",
  "total_duration": 2812000000, "load_duration": 21000000,
  "prompt_eval_count": 1450, "prompt_eval_duration": 1900000000,
  "eval_count": 31, "eval_duration": 880000000
}
// errors: 4xx / 5xx with { "error": "model \"qwen2.5:7b\" not found, try pulling it first" }
```

The bot reads `message.content` and rejects `done: false` (a streamed answer) and `done_reason:
"length"` (cut off). Transport errors become one chat line: `nl: ollama: cannot reach
http://127.0.0.1:11434: connect ECONNREFUSED ...`, `nl: ollama: no answer within 60000 ms`.

## Adding a command

1. `bot/src/nl/plan.ts`: a strict object in `STEP_SCHEMAS` (bounded arguments), the same object in
   the `StepSchema` union, a `COMMAND_SPECS` entry (chat command, how it finishes, its failure reply),
   and its text in `stepCommand` if it has arguments.
2. `bot/src/nl/prompt.ts`: a line in `STEP_DOCS` (JSON form and meaning); an example only if the
   mapping is not obvious.
3. If the owner's words must back an argument (coordinates, names), add the check to `checkPlan` in
   `bot/src/nl/executor.ts`. If it moves the bot, add its chat name to `ABORT_ON` there.
4. Tests: a phrasing in `bot/test/unit/nl/phrasings.test.ts`, bounds in `plan.test.ts`.

## Files and tests

`bot/src/nl/` (provider.ts, ollama.ts, fake.ts, plan.ts, prompt.ts, executor.ts),
`bot/src/chat/commands-nl.ts` (`!do`, `!yes`, `!no`, addressed chat; registered by the afk task),
`bot/scripts/nl-try.ts`. The `nl` config block is resolved in config/resolve.ts and handed to the task
in its values (`$nl`); tests inject a provider as `$nlProvider`.

- Unit (`pnpm -r test`, `bot/test/unit/nl/`): 20 phrasings to plans and chat commands and 3 ambiguous
  ones to questions (FakeProvider), schema bounds and made-up commands, the Ollama shapes, the
  executor (waiting for processes, failures, `!no`, timeouts, `not available`), the real Chat wiring.
- e2e `nl-core` on bds-core (`BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e nl-core
  --silent=false`, ~25 s): `!do walk home then guard` + `!yes` walks home then turns guard on;
  `!no` drops a plan (from `!do` and from `say <bot>, walk home`); an unknown waypoint yields a
  question. Measured: plan line ~250 ms after `!do`, 15 blocks home in ~3.7 s, guard on ~0.5 s later.
- Manual with Ollama on the Mac: the 20 phrasings of phrasings.test.ts through `nl-try.ts`, then
  `!do` on the `chat` server.
