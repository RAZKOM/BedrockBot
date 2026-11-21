# 0118: A Discord bot: commands from Discord, replies, notes and question buttons (Track D1)

Date: 2026-11-20. Status: accepted. New settings `discordBot` (off), `discordUsers` (none), `discordChannels` (none),
`discordNotes` (dm). New command `!discord [status|test]`. Guide: [../discord.md](../discord.md); the notes:
[../away.md](../away.md); the command path: [../panel.md](../panel.md) "Commands from the panel".

## Context

The bot is commanded from the game chat and from the LAN panel. Away mode's notes reach a closed phone through the
user's own Discord webhook (ADR 0116 addendum), but a webhook is one way: an answer to a question, or a new command,
still needs the game or the panel, and the panel needs the home network or a VPN. The owner asked for the bot to be
its own Discord bot, so a phone with Discord is enough, on any network, with nothing exposed. The project is for
anyone: each user makes their own Discord application and bot; nothing in it names a server, a channel or a person.

## Security model (written first)

Anyone who can command the bot from Discord can make it do anything an owner can: dig, fight, drop the inventory,
change its settings. Discord is one more door to the same command handler, so the door decides who comes in and
the handler does the rest unchanged.

1. **Closed by default.** `discordBot` is off; with it on and no token nothing connects; with a token and
   `discordUsers` empty nobody may command it. Each step is the user's own act.
2. **Who: Discord user ids, never names.** `discordUsers` holds at most 10 ids (17 to 20 digits). A display name or
   a username can be changed or copied by anyone; an id cannot. Empty (`none`) means nobody.
3. **Where: listed channels, or a direct message from an allowed user.** A command in a server channel runs only
   when the channel's id is in `discordChannels` (at most 10). A direct message from an allowed user runs anywhere.
   An allowed user in any other channel is ignored too: a server channel is read by its other members, and the user
   decides which channels may carry the bot's replies.
4. **Everything else is ignored without a reply**, so a stranger learns nothing (not even that the bot reads them):
   messages from users not listed, from channels not listed, from other bots, from webhooks, from the bot itself, and
   system messages. They are counted by reason and logged as one count line at most every 10 minutes.
5. **A command runs exactly as the panel's does**: one chat line through `Chat.handle` as the first owner, marked
   `typed` (the queue's pre-emption works as for a typed command) and with its source marked `discord` (the command
   event, the question's answer, a queued job's `via`). So no rule of the handler is bypassed, and the log names
   both sides: `discord: !goto home (as <owner>, from <discord user id>)`.
6. **Some commands never come from Discord**, refused with the reason: `!quit` (nothing on Discord could start the
   bot again), `!test` (the test bench sends slash commands as an operator), `!learn` (it records a flight the owner
   flies in the game), and `!set` with a value for `discordBot`, `discordUsers`, `discordChannels` or `discordNotes`
   (Discord may not widen or move its own door; the game, the panel and `settings.json` can). A queued job runs later
   as the queue's own line, not marked `discord`, so `!queue add <line>` from Discord passes the same check on the
   line it holds. A `!do` plan's steps also run as copies of the `!do` line, past this check, so the plan's `set`
   step leaves the four keys out (`NL_SETTING_KEYS`, nl/plan.ts): a plan, from any door, never changes who may command
   the bot.
7. **Rate limit per user**: 5 commands (button presses included) in 20 s. The first one over gets one line saying
   so; the rest of the window is ignored.
8. **Nothing the bot sends pings anyone**: every message carries `allowed_mentions: { parse: [] }`.
9. **A button press answers only when it is pressed by an allowed user** on a question of this run of the bot (the
   button's id carries a random run tag, so a button from before a restart cannot answer a new question with the same
   number). A press by anyone else gets a short private (ephemeral) refusal and changes nothing. The press runs
   `!answer <id> <choice>` through the same handler as rule 5.
10. **The token is a secret, supplied outside the game**: `BEDROCKBOT_DISCORD_TOKEN`, else the first line of
    `<config dir>/discord-bot.token`; never a setting, a command or chat. Outputs say only `set (<where>)`, `not set`
    or `refused (<where>: <reason>)`; every line the Discord code logs or returns passes a scrub of the token; the
    panel's log ring hides token-shaped strings; the file name is in `.gitignore`.
11. **The token goes only to Discord**: the REST origin is `https://discord.com/api/v10`, and the gateway URL Discord
    hands out is used only when it is `wss://` on a `discord.gg` host. Tests reach a fake Discord through
    `BEDROCKBOT_DISCORD_TEST_ORIGIN`, which accepts only `http://127.0.0.1:<port>` or `http://localhost:<port>`.
12. **Nothing listens.** The gateway is an outbound websocket and the REST calls are outbound https; no port is opened
    and no interactions endpoint URL is set, so no public https is needed. Button presses arrive over the gateway and
    are acknowledged within Discord's 3 s.

## Decision

1. **An own small client, no library.** The gateway is Node's built-in `WebSocket` (Node 22 and later; the bot runs
   on 24) with JSON frames; the REST calls are `fetch`. Of what discord.js or Eris would bring, the bot needs five
   gateway opcodes, four dispatches (READY, RESUMED, MESSAGE_CREATE, INTERACTION_CREATE) and five REST routes. A
   library is tens of packages with caches, shards and voice the bot never uses, updates on Discord's pace and owns
   its own reconnect and logging, where the token and the bot's own rules (never throw into the bot, scrub every
   line, stop on a refused token) have to fit around it. About 1 750 lines here (the rules 341, the gateway 462, REST 286, the wiring 657), every one under the bot's tests, and
   no new dependency. The cost: the protocol details are this project's to keep up (see "Not checked against
   Discord").
2. **The gateway** (`health/notify/discord-gateway.ts`): v10, JSON. HELLO starts the heartbeat, the first beat after
   `interval x random()` (Discord's jitter), then every interval with the last sequence; a beat not acknowledged before
   the next closes the link with 4000 and resumes. IDENTIFY with the intents GUILD_MESSAGES (1 << 9), DIRECT_MESSAGES
   (1 << 12) and MESSAGE_CONTENT (1 << 15, privileged: the user switches it on in the developer portal), 37 376.
   RESUME (session id and sequence) on Discord's `resume_gateway_url` after a drop, a RECONNECT (op 7) or a resumable
   INVALID_SESSION (op 9); a new IDENTIFY after 1 to 5 s when not resumable or after 4007 / 4009. Reconnects back off
   2 s x 2^n with jitter (x 0.5 to 1), at most 5 min. The fatal closes (4004 the token, 4010 to 4013 shards, intents,
   version, 4014 an intent not switched on) stop it with the reason, no loop. At most 20 new sessions in 24 h (Discord
   allows 1 000; a resume does not count), at most 100 frames a minute (Discord allows 120; heartbeats always go), no
   HELLO in 15 s closes and backs off.
3. **REST** (`health/notify/discord-rest.ts`): one queue per route (the first id kept: Discord's per-channel buckets),
   Discord's bucket headers honoured (`X-RateLimit-Remaining: 0` waits `Reset-After`), a 429's `retry_after` waits and
   tries again (3 tries; a wait over 60 s fails it), a global 429 holds every route, at most 10 requests a second in
   all, at most 20 waiting a route. A 401 stops every call until the token changes, and stops the gateway (a refused
   token must not loop). A 5xx or no answer in 10 s is tried once more after 2 s. An answer to a button press
   (`/interactions/<id>/<token>/callback`) carries no bot token, is never retried and gives up after 2.5 s.
4. **Replies**: the lines said while the command runs become one reply to the user's message (`message_reference`),
   in a code block, the chat's colour codes removed; more than fits goes into at most 3 messages split between lines
   and the rest counted (`... 12 more lines (the game chat and the panel have them)`). A command that said nothing yet
   gets `!x: no reply yet` after 1.5 s. Then what the bot says for 2 min follows into the same channel, batched every
   2 s, at most 8 messages (a `!goto` and its `arrived`). One follow at a time: a new command takes it over.
5. **Notes** (`NoteSink`, health/panel/away.ts): every note away mode's limiter lets through goes to each sink that is
   on, the webhook (Track N1) and this bot alike, both may be on. The bot's message is the webhook's (`payloadFor`),
   to the channel in `discordNotes` or as a direct message to each allowed user (`dm`, the default: nothing is posted
   where others read unless the user names a channel). At most 10 notes wait.
6. **Buttons**: a question's note carries its choices as buttons (5 a row; the default grey and marked), each with
   `bb:<run>:<question>:<choice>`. A press arrives as INTERACTION_CREATE and is answered at once: by an allowed user,
   `!answer` runs and the press's message is updated (type 7) to show the answer, the buttons gone; anyone else gets an
   ephemeral refusal. When a question ends any other way (answered in the game or the panel, its default taken,
   replaced) the bot edits every message it posted for it the same way.
7. **`!discord [status|test]`** says the switch, the token's state (never the token), the gateway's state with its
   sessions, resumes and last close, how many users and channels are listed (counts and the last 4 digits only), where
   notes go, and the counts in and out; `!notify` carries one line of it. `test` sends one test note to the notes
   target. Both read the token again, so a file put in place is picked up without a restart.
8. **Settings** `discordBot` (off), `discordUsers` (none), `discordChannels` (none), `discordNotes` (dm). The id lists
   take comma or space separated ids, `none` empties them; `!set` and the panel show `2 ids (...1111, ...2222)`.

## Consequences

- One phone app reaches the bot from anywhere, commands and answers included, with no port opened, no https front and
  no account but the user's own Discord application.
- Whoever holds an allowed Discord account can command the bot as an owner. The account's own security (two-factor
  login) is now part of the bot's; docs/discord.md says so.
- What the bot says in reply to Discord users goes to Discord's servers, like the webhook's notes.
- The protocol is the project's own to keep current. Discord versions its API (v10 here) and announces changes; the
  numbers in "Not checked against Discord" are the ones to recheck if something stops working.

## Measured

Against a local fake Discord (a websocket and REST server in the test, never Discord), with a real bot process on
bds-core, 3 of 3 (`bot/test/e2e/discord-bot.test.ts`): IDENTIFY with the intents 1.2 to 1.7 s after the start;
`!pos` from the allowed user answered under 0.01 s later as a reply, the command event's source `discord`; `!goto`'s
`arrived` followed into the channel 4.5 s after the message; a stranger, another channel and a bot got no reply in
4 s; `!quit` refused, the bot up; a question from a job queued from Discord posted with three buttons, a stranger's
press refused privately, the owner's press answered it (`how` `discord`) under 0.01 s after the press; the token in no
reply, panel route, event, stored event, bot output line or message sent. The unit tests drive the heartbeat, the
missed acknowledgement, resume, RECONNECT, INVALID_SESSION, the fatal closes, the backoff (2, 4, 8 ... 300 s), the
daily session cap and the REST limits with fake timers.

Budgets (health/panel/budgets.ts): the four setting rows took the page HTML from 160 487 to 162 940 (raised 161 000 to
163 500), the lite poll from 22 178 to 22 404 (22 300 to 22 500) and the full state from 48 020 to 48 886 (48 500 to
49 200).

## Not checked against Discord

No test contacts Discord. These come from Discord's developer documentation as known when written, not from the live
service: the opcodes and close codes, the intent bits, the permission bits of the invite link (84 992: View Channel,
Send Messages, Embed Links, Read Message History), the rate limits (50 requests a second, 120 gateway frames a minute,
1 000 identifies a day), the 3 s for an interaction's answer, the message and component limits (2 000 characters a
message, 5 buttons a row, 5 rows, an 80-character label, a 100-character custom id), the User-Agent form, and that a
bot can open a direct message only with a user who shares a server with it and allows it.

## Addendum (Track D2, 2026-11-21): messages for a phone, replies kept to their own command

**Context.** Track D1's messages were readable on a desktop but not on a phone: a reply was a code block, a status a
single line of 300 characters, a question three embed fields (choices, the default, how to answer) under a title
`the bot asks (#3)` and buttons labelled `next: go on with the next (default)`; the push line repeated the title, and
the footer showed event kinds (`ask.asked`). And the follow window took whatever the bot said for 2 minutes: a
`!status` sent from the panel during a Discord `!goto` went to the Discord channel.

**Decision.**

1. **Notes** (`payloadFor`, used by the bot and the webhook): the push line says the matter and its cause (`The bot
   died: zombie at 10 64 -4`, `Job #7 failed: retry, skip or pause the queue?`); the title is the matter, the
   description one cause line; the time is the embed's timestamp; the footer is the bot's name only. Red alerts, amber
   questions, blurple tests, grey for an ended question.
2. **Questions** carry what to show (`AskSpec.title`, `detail`, `push`, and per choice `short` and `done`; the game
   chat's text is unchanged). The default is said once as `Unanswered: Skip <t:unix:R>`, a Discord timestamp the
   reader sees in their own clock. With buttons there are no fields and no "how to answer"; the webhook keeps one
   line of it. Buttons: short labels, the default the one primary button, the rest secondary; no success or danger
   style, since no queue choice is safe or dangerous in itself. After the answer or the wait the message is edited:
   no buttons, no push line, grey, the outcome in words (`Retried by <@user> · 48 s`, `No answer: skipped`). The
   cause is cut to one line of at most 100 characters (`causeLine`).
3. **Replies** (`discord-reply.ts`): plain text, its markdown escaped; a code block only for lines in columns or 3 or
   more coordinate lines; a long `;` line a bulleted list under its head; a `head: key value, ...` line of 5 or more
   pairs the head with the pairs a few to a row. The rules go by the shape of a line, never by command, so a new
   command needs nothing.
4. **Attribution** (`chat/scope.ts`): every command line `Chat.handle` runs gets a scope (an id, where it came from,
   the line) carried by `AsyncLocalStorage`. Reply closures re-enter their scope; the process manager runs a user
   process's calls in the scope it was added in, an automatic process's in none; `sayKept` keeps the scope a line was
   said in; a step a command dispatches stays in its scope; the queue opens one per job. The Discord bot keeps, for
   each of its commands, only the lines in that command's scope, during the call and in the follow window, and
   follows up to 4 commands at once. Its gateway, REST and timers run outside every scope.

The security model above is unchanged: the same gate, refusals, rate limits, token handling, `allowed_mentions` empty
on every message, Discord's limits and the scrub. A mention of the presser (`<@id>`) pings nobody, because mentions
are not parsed.

**Why AsyncLocalStorage.** The alternative, passing a command id through every reply and process, would touch every
command and every skill. The scope follows timers and promises created inside a command by itself, and costs one
`run` per command and per process call. The cost: something long-lived that a command creates (a task rebuilt by
`!mode`) keeps that command's scope; the follow window (2 minutes) bounds what that can send to Discord.

**Evidence.** Unit: every message as JSON (discord-messages.test.ts); the scopes (chat/scope.test.ts, chat.test.ts
sayKept); the Discord bot posting only a Discord command's own lines with a panel `!discord` and `!slow`, a game
`!pos` and an unscoped line said in its window (discord-bot.test.ts). e2e on bds-core against the fake Discord
(discord-bot.test.ts, 3 of 3): `!pos` one plain line; the question's push line, title, one cause line, `Unanswered:
Skip <t:...:R>`, no fields, buttons Retry / Skip / Pause queue with Skip the one primary; the owner's press edited it
to `**Skipped** by <@id> · 0 s` with no buttons; a Discord `!goto` with the panel's `!discord status`, `!status` and
`!set notify off` sent in its window: 2 messages in the channel (`walking to`, `arrived at`), none of the panel's.

**Not checked against Discord.** How a phone shows these (the push line, the relative timestamp, the button colours,
the markdown) is from Discord's documentation as known, not seen on a device.
