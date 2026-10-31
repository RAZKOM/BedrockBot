# Chat style: colours, multi-line blocks and the /tellraw route

**Read this before you print more than one line, want a colour, or add a command or a setting.** The
style lives in one place (`bot/src/chat/style.ts`); everything else asks it. If you find yourself typing a
section sign (`§`), counting characters for a chat limit, or writing `if (chatLines)`, stop: one of the
recipes below does it for you.

Decision record: [decisions/0050-chat-style.md](decisions/0050-chat-style.md). What it looks like in your
own client: type `!colors` in game.

## The three switches (settings, all off or `chat` by default)

| Setting | Does | Default |
|---|---|---|
| `chatColor` | Every reply is coloured: commands aqua, numbers gold, one verdict word (done / failed / no path), a trailing `(note)` gray | off |
| `chatLines` | Long structured answers (`!help`, `!help all`, `!help settings`, `!set`) are a few multi-line messages with headings, instead of one packed line each | off |
| `chatVia` | `chat`: replies are player chat. `tellraw`: replies are sent as `/tellraw @a` (needs the bot to be an operator); a refused one falls back to chat | `chat` |

Defaults stay off in code so every test and every other task is unchanged. The owner turns them on after
`!colors` shows the client draws them: `!set chatColor on`, `!set chatLines on`, `!set chatVia tellraw`.
Settings are live: the next reply uses them.

## Layers

```
command code            reply('text')  |  chat.layout(plain, build)  |  chat.paint(tone, text)
        |
Chat.say()  (chat/chat.ts)   rate limit 8 / 10 s, hint, then finish():
        |                      cut to the reply limit, colorize() if chatColor, fitWire() <= 480
        |
Chat.send()                  chat packet   |   /tellraw @a {"rawtext":[{"text":...}]}  (chat/route.ts)
```

| File | What |
|---|---|
| `bot/src/chat/style.ts` | **The only file that builds `§` codes.** `Tone`, `paint`, `colorize`, `strip`, `fitWire`, `Doc`, the limits `MAX_WIRE` (480) and `DOC_MESSAGE` (440) |
| `bot/src/chat/help-rich.ts` | `!help` / `!help all` / `!help <cmd>` / `!help settings` / `!set` as Docs, built from the registered metadata |
| `bot/src/chat/commands-style.ts` | `!colors` (the demo and the route line) |
| `bot/src/chat/route.ts` | `tellrawCommand`, `commandRequestPacket`, `TellrawRoute` (the pause after a refusal), `SLASH_MAX` (480) |
| `bot/src/chat/chat.ts` | `styleSource`, `styleMode()`, `paint()`, `layout()`, `routeStatus()`, `finish()`, `send()` |
| `bot/src/chat/help.ts` | `SETTING_GROUPS`: every setting in exactly one group (a unit test fails otherwise) |
| `bot/test/unit/chat/style.test.ts` | the unit tests and the two guards |
| `bot/test/e2e/chat-style.test.ts` | what the server relays and drops (re-measure after every BDS bump), and the tellraw route against bds-dev |

## Recipes

### A one-line reply (almost always)

```ts
reply('goto: no path to 100 64 -50 (blacklisted, try !come)');
```

Nothing else. With `chatColor` on, `colorize()` makes the command aqua, the numbers gold, `no path` red and
the trailing note gray. Write replies as you did before; keep the verdict word near the start; put side notes
in a trailing `(parenthesis)`.

### You know what a word means and the guess would be wrong

```ts
reply(`${chat.paint('bad', 'refused')}: ${name} is not yours`);
```

`chat.paint(tone, text)` is the text itself when `chatColor` is off. A reply with a painted part is sent as it
is (no second automatic pass), so paint every part that matters.

### A list, a table, several parts (help, stock, chests, waypoints)

```ts
for (const m of chat.layout(oldLines, (d) => {
  d.title('stock', `${rows.length} items`);
  d.section('tools');
  d.pairs(rows.map((r) => ({ key: r.name, value: String(r.n) })));
  d.note('!bring <item> fetches one');
})) reply(m);
```

`chat.layout(plain, build)` returns `plain` untouched when `chatLines` is off (keep the lines you had: tests
and the panel compare them) and the Doc's messages when it is on. Write both once; never branch on the modes
yourself. `Doc` packs sections into messages of at most 440 characters (420 on the tellraw route), never splits
a line, and repeats a heading as `(cont.)` when a section runs on. `Doc` strips `§` from everything you pass in.

Doc building blocks: `title(name, detail?)`, `section(name, detail?)`, `item(cmd, text)`, `line(text)`,
`dim(text)`, `tone(tone, text)`, `tokens(list)`, `pairs([{key, value}])`, `note(text)`.

### A new command

Register it with `tier`, `group`, `help`, `example` (and `auto` when it also happens by itself). `!help`,
`!help all` and `!help <cmd>` are generated from that; nothing in help-rich.ts changes. The `ux.test.ts`
guards fail when a command is missing from `!help all`.

### A new setting

Add it to `SETTING_DEFS` **and to a group in `SETTING_GROUPS`** (`bot/src/chat/help.ts`). `!set` and
`!help settings` list from the groups; a unit test fails when a setting is in none (or in two). Give it a
`description` that works as the one-line explanation `!set <key>` prints.

## Rules

1. **No `§` literal outside style.ts.** A guard test scans `bot/src` and fails on any other file with a
   section sign, except an allow-list of files that only strip codes from names. Do not add to the list for a
   colour; use `paint` / `Doc`.
2. **No mode branching.** Do not read `chatColor`, `chatLines` or `chatVia` in a command. `chat.layout`,
   `chat.paint` and `Chat.say` read them.
3. **The text is complete without colour.** Tests compare `strip(message)`. Never put information only in a
   colour (a red word that is not also a word).
4. **Messages are at most 480 characters with their codes** (see Limits). `Chat.say` guarantees it (`fitWire`
   falls back to the plain text); Doc packs to it. Do not send long text around `say`.
5. **8 replies per 10 seconds** (`maxReplies`). A Doc of 4 messages uses half. Do not turn a one-line reply into
   a Doc without need; `!help settings` is 4 messages, a table of 30 rows should not be 12.
6. **Dark colours are not used** (the chat background is dark): the tones in `style.ts` are the palette.
7. **Reuse the tones.** `cmd` aqua, `ok` green, `bad` red, `warn` yellow, `num` gold, `dim` gray, `head` gold
   bold, `sub` yellow bold, `name` purple. A new tone is a change to `CODE` in style.ts, not a literal elsewhere.

## Limits (measured, not assumed)

On BDS 1.26.60.6 (`bot/test/e2e/chat-style.test.ts` pins every line; re-run it after a BDS bump and when a
Realm update lands: `BDS_E2E=1 pnpm exec vitest run --project e2e chat-style`):

| Fact | Result |
|---|---|
| `§` codes in a player chat message | relayed unchanged (also a trailing sign and an unknown code) |
| Newlines in a chat message | relayed unchanged (how a client draws them is what `!colors` shows) |
| Chat message length | 503 characters relayed, 523 DROPPED SILENTLY (no error, no kick). We cap at 480 |
| `command_request` length | 480 works, **512 or more makes the server drop the connection**. We cap at 480 (`SLASH_MAX`) |
| `/tellraw @a` as an operator | delivered to every player as `json_whisper` (the message is the rawtext JSON); success gives no `command_output` |
| `/tellraw @a` as a non-operator | refused at once: `command_output` with `success_count` 0 and `commands.generic.permission.selector` (other refusals: `commands.generic.error.permissions`, `.syntax`, `.unknown`) |
| `/tell <name>` as a non-operator | works, arrives as a `whisper` (this is how the update notice reaches the owners) |

**Not verified on the Realm** (only on local BDS): whether the Realm bot account is an operator, whether the
Realm relays `§` and newlines the same way, and how the owner's client draws them. `!colors` is how to check
the last one; `!set chatVia tellraw` followed by any reply is how to check the first (the bot logs
`/tellraw refused (<message id>)` once and `!colors` says so).

The owner's client masks digits in player chat as `####` (observed 2026-10-29). A tellraw message is a system
message, not player chat, so it may avoid that filter; not confirmed.

## The tellraw route

`chatVia tellraw` sends every finished reply as `/tellraw @a {"rawtext":[{"text":<JSON string>}]}`.
Benefits: no `<BotName>` in front of each line, and no player-chat filtering. Costs: the bot needs operator
rights, the command carries about 37 characters of wrapping (hence the 420-character Doc size), and the server
drops the connection for a command of 512 or more.

The safety net is built in, do not duplicate it:

- A command longer than `SLASH_MAX` (480) is never sent; that reply goes out as chat.
- A refused `/tellraw` (its `command_output` has `success_count` 0 and the uuid we sent) is resent as chat at
  once, the route pauses for 10 minutes (`RETRY_MS`), and the bot logs the server's message id once. `!colors`
  shows the route (`replies go out as ...`, or the refusal and the minutes left).
- **Only `/tellraw @a` is ever sent by this route** (a unit test checks that even a reply that says `/op Bot`
  or `/stop` goes out as text inside the JSON). Do not add other commands to `Chat.send`.
- Making the bot an operator on a Realm is the owner's decision. Do not assume it, and do not ask the bot to
  op itself.

Limits of /tellraw on Bedrock: no `clickEvent` or `hoverEvent` (so no clickable commands), the raw text is one
JSON string (line breaks are `\n` inside it; `JSON.stringify` does this), special fonts are limited. A tellraw
message does not reach `Chat.handle` as a command (it has no sender), so there is no feedback loop.

## `colorize()`: what it guesses, and where it is blind

It runs only on replies that carry no codes yet. It colours: `!command` words (aqua), numbers and
coordinates (gold, but not versions like `1.26.60`, sizes like `5x3x5` or ids like `oak_log2`), one verdict
word in the first 60 characters, and a trailing `(note)` gray. One verdict per reply, the worst news first:

| Tone | Words (`OK_WORDS`, `BAD_WORDS`, `WARN_WORDS` in style.ts) |
|---|---|
| red | failed, cannot, refused, unreachable, no path, not available, unknown, error, stuck, died, not safe |
| green | done, ok, saved, started, arrived, resumed, success, completed, ready, finished |
| yellow | stopped, paused, cancelled, nothing to, no command, missing, low |

It is blind to meaning: a number that is a name, a player called "done". For those use `chat.paint` or accept
the plain word. Add to the word lists in style.ts when a common reply is missed, and add that reply to
`CORPUS` in style.test.ts.

## Reviewer checklist

- [ ] No `§` outside style.ts (the guard passes without a new allow-list entry).
- [ ] Multi-line output goes through `chat.layout`, with the old lines as `plain`.
- [ ] The new setting is in `SETTING_GROUPS`; the new command has tier, group, help and example.
- [ ] A test compares `strip(...)` or the plain form, not a coloured string (except style.test.ts).
- [ ] Nothing builds a `command_request` for chat output outside route.ts / `Chat.send`.
- [ ] No message can pass 480 characters with codes.

## Brief for an agent that touches chat output

> Read docs/chat-style.md first. One-line replies need nothing special. Several lines: `chat.layout(plain,
> build)` with a `Doc`. Never type `§`, never read chatColor / chatLines / chatVia. New setting: add it to
> `SETTING_GROUPS` in chat/help.ts. New command: set tier, group, help, example. Keep every message under 480
> characters with codes and remember the 8 replies / 10 s limit. Run `pnpm exec vitest run --project unit
> test/unit/chat` before you finish.

## Not converted yet

These still print as packed one-line lists and would gain from `chat.layout`: `!inv`, `!stock`, `!chests`,
`!wp` (waypoint list), `!status` (long form), `!build list`. Each is a few lines: keep the current lines as
`plain`, build the Doc, add a test next to the command's own.
