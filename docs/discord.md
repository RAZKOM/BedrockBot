# Discord: command the bot and answer it from Discord (Track D1)

ADR [0118](decisions/0118-discord-bot.md). The bot can be its own Discord bot: an allowed Discord user sends `!pos`
or `!goto home` in a channel or a direct message and gets the reply there, notes arrive as messages, and a question's
choices are buttons. A phone with Discord is enough, on any network. Nothing listens on the bot's machine: the bot
connects out to Discord, as a browser would. Since Track D3 the same commands are also slash commands (`/status`,
`/goto place:home`, `/run line:get wood 16`) with suggestions as you type, and `!discord setup` checks a set-up step by
step and says how to fix what is missing.

Every user makes their own Discord application and bot. Nothing in the project names a server, a channel or a person.
The webhook of [away.md](away.md) "Discord" stays: it is one way (notes only) and needs no bot. Both may be on.

| File | What |
|---|---|
| `bot/src/health/notify/discord-access.ts` | the rules, pure: who and where (`gate`), the refused commands (`refusal`), the per-user limit, the token (`loadToken`, `parseToken`, `tokenText`, `scrubToken`), the id lists, the button ids |
| `bot/src/health/notify/discord-reply.ts` | a reply laid out for a phone (`replyMessages`: plain lines, lists, code only for columns; Track D2) |
| `bot/src/health/notify/discord.ts` | the messages: notes, questions and their outcome (`payloadFor`, `outcomePayload`), `escapeMarkdown`; the webhook sink |
| `bot/src/chat/scope.ts` | which command a line belongs to (Track D2) |
| `bot/src/health/notify/discord-gateway.ts` | `DiscordGateway`: the websocket (identify, heartbeat, resume, reconnect, backoff, the fatal closes) |
| `bot/src/health/notify/discord-rest.ts` | `DiscordRest`: the HTTP calls (rate-limit buckets, 429, 401, timeouts) |
| `bot/src/health/notify/discord-bot.ts` | `DiscordBot`: the wiring (messages and slash commands to commands, replies, notes, buttons, `!discord`) |
| `bot/src/health/notify/discord-slash.ts` | Track D3: the slash commands, pure (`SLASH_DEFS`, `slashPayload`, `slashLine`, `autocomplete`) and their registration (`SlashRegistry`, the hash file) |
| `bot/src/health/notify/discord-setup.ts` | Track D3: `!discord setup` (`setupCheck`, `setupLines`, `channelPermissions`) |
| `bot/src/health/panel/away.ts` | `NoteSink`: away mode's notes to each sink that is on |
| `bot/src/events/actor.ts` | `viaDiscord`, `sourceOf`: a command's source `discord` |
| `bot/test/unit/health/discord-access.test.ts`, `discord-bot.test.ts`, `discord-messages.test.ts`, `discord-slash.test.ts`, `discord-setup.test.ts`, `fake-discord.ts` | the rules; the gateway and REST against fakes; the whole bot against a local fake Discord; every message as JSON; the slash commands' bodies, lines, suggestions and hash; the set-up check's verdicts |
| `bot/test/e2e/discord-bot.test.ts` | on bds-core: a real bot process against the local fake Discord |

## Set-up from nothing

You need a Discord account and a Discord server where you may add bots (your own: Discord's "+" button, Create My
Own, makes one in a minute). The steps name the Discord pages as they were known when this was written; Discord moves
things from time to time.

1. **Make the application.** Open the Discord Developer Portal (`https://discord.com/developers/applications`),
   sign in, New Application, give it a name (the bot shows with that name), accept the terms.
2. **Set up its bot user.** In the application, open **Bot**.
   - **Reset Token**, confirm, **Copy**. This is the bot's password: whoever has it can act as the bot. Do not paste
     it into Discord, the game or a chat; step 5 says where it goes. Discord shows it once; if it is lost or seen by
     anyone, Reset Token again (the old one stops working).
   - Under **Privileged Gateway Intents**, switch on **Message Content Intent** and Save. Without it Discord sends
     the bot messages with empty text and the gateway closes with 4014; `!discord` then says so. It is needed only for
     commands typed as messages (`!pos`). With `discordText` off the bot takes slash commands only, asks for no intent
     at all, and this switch can stay off.
   - Switch off **Public Bot** (Save), so only you can add the bot to a server.
3. **Invite it to your server.** In **OAuth2**, copy the **Client ID** (the application id; it is not a secret).
   Open this link with your id in place of `<application id>`:

   ```
   https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=84992
   ```

   Choose your server and Authorise. The scope `bot` adds the bot user; `applications.commands` lets it put its slash
   commands in that server (without it Discord refuses them with 403, and `!discord setup` says so). `84992` is the sum
   of the four permissions it uses: View Channels (1 024), Send Messages (2 048), Embed Links (16 384: the notes are
   embeds) and Read Message History (65 536: a reply points at your message). The same link can be made in **OAuth2**,
   **URL Generator**: tick `bot` and `applications.commands`, then those four permissions. Once the bot runs,
   `!discord setup` prints this link with the id filled in. A bot invited before Track D3 with `scope=bot` only is
   invited again with the new link (nothing else changes; Discord keeps its role).
4. **Find the ids.** In Discord, User Settings, Advanced, switch on **Developer Mode**. Then right-click (on a phone:
   long-press) your own name and **Copy User ID**, and the channel the bot should answer in and **Copy Channel ID**.
   Ids are 17 to 20 digits. They are not secrets, but the bot shows only their last 4 digits in chat.
   A private channel only you (and the people you list) can read is best: everyone who reads the channel sees the
   bot's replies.
5. **Give the bot the token**, in one of two places (the environment wins):
   - the environment where the bot starts: `BEDROCKBOT_DISCORD_TOKEN=<the token>`;
   - a file named `discord-bot.token` in the config directory (next to `config.json`; by default
     `%LOCALAPPDATA%\bedrockbot\` on Windows), the token on its first line (blank lines and `#` comments are skipped;
     a leading `Bot ` is accepted). `--no-config` leaves the file unread.

   The file name is in `.gitignore`, and the bot warns when the file sits inside a repository.
6. **The settings**, in the game, the panel or `settings.json` (ids separated by commas or spaces):

   ```
   !set discordUsers 111111111111111111
   !set discordChannels 333333333333333333
   !set discordNotes dm
   !set discordBot on
   ```

   `discordNotes` is `dm` (the default: notes as direct messages to the listed users), a channel id, or `none`.
7. **Test it.** `!discord` says whether it is connected (`discord bot: on, token set (discord-bot.token); gateway ready
   for 5 s (1 session, ...)`). `!discord test` sends one test note to where notes go. Then, in the listed channel, send
   `!pos`: the reply comes back as a reply to your message. In a direct message to the bot the `!` may be left out.
   Type `/` in the channel: the bot's six slash commands are listed (they can take a minute to show the first time).
   `!discord setup` checks every step above and says what is missing ("The set-up check" below).

**What to keep safe.** Anyone who can log in as a listed Discord user can command the bot as its owner. Use
two-factor login on that account. If the token leaks, Reset Token in the portal and put the new one in place
(`!discord` reads it again).

## Settings and command

| Setting | Default | What |
|---|---|---|
| `discordBot` | off | connect to Discord with the token and take commands, send notes and buttons |
| `discordUsers` | none | up to 10 Discord user ids that may command the bot; `none`: nobody |
| `discordChannels` | none | up to 10 server channel ids where commands are taken; direct messages from listed users always are |
| `discordNotes` | dm | where notes go: `dm` (each listed user), a channel id, or `none` |
| `discordText` | on | Track D3: commands typed as messages too; off: slash commands only, and the Message Content intent is not asked for |

`!set` shows the lists as `2 ids (...1111, ...2222)`. The panel's settings editor holds the whole value it edits (the
panel needs its own token).

`!discord` (or `!discord status`), three lines:

```
discord bot: on, token set (BEDROCKBOT_DISCORD_TOKEN); gateway ready for 3 min 2 s (1 session, 1 resumed, 1 reconnects, heartbeat 48 ms)
discord bot: 1 user, 1 channel, notes dm; in: 4 run, 1 presses, 1 refused, 0 rate-limited, 3 ignored; out: 9 sent, 0 failed, 0 waiting
discord bot: text commands on; slash commands 6 for DMs and 1 server; 2 run, 5 autocompletes
```

`!discord setup` (or `check`) runs the set-up check. `!discord commands` shows the slash commands' registration;
`!discord commands sync` registers them again in every scope; `!discord commands remove` takes them out of every scope
the bot registered.

When it is not ready the first line says why (`gateway stopped: the token was refused (401): make a new one in the
developer portal`, `gateway waiting (..., last: 4000 ...)`). `!discord test` sends one test note to the notes target
and says what happened (`discord bot: test sent to 1 of 1 channel (channel ...3333)`). Both read the token again.
`!notify` carries a short line too (`discord bot: on, gateway ready, notes dm; 2 notes, 9 sent, 0 failed, 0
dropped`), and `!notify test` tries every path that is on.

## The security model

The rules are ADR 0118's "Security model", each with its reason; in short:

- **Closed by default**: the switch off, no token, no users: each step is the user's own act.
- **Who**: Discord user ids, never names (a name can be copied; an id cannot).
- **Where**: a listed channel, or a direct message from a listed user. A listed user in another channel is ignored
  too: the user decides which channels carry the replies.
- **Everything else is ignored without a reply**: strangers, other channels, other bots, webhooks, the bot itself,
  system messages. They are counted (`!discord`) and logged as one count line at most every 10 minutes.
- **The same handler**: a command runs as the panel's does, as the first owner, marked `discord` in the command
  event, an answer's `how` and a queued job's `via`. The log names both sides:
  `discord: !goto home (as <owner>, from <discord user id>)`. A command from Discord pauses the queue as a typed one
  does ([queue.md](queue.md)).
- **Refused, with the reason**: `!quit` (nothing on Discord could start the bot again), `!test` (it sends slash
  commands as an operator), `!learn` (it records a flight flown in the game), and `!set` with a value for any of the
  five `discord*` settings (Discord may not widen or move its own door, nor change how it is taken). `!queue add` from Discord checks the line it
  queues by the same rule, and a `!do` plan cannot set the four keys from anywhere (its steps run past this check).
- **Per user**: 5 commands (button presses and slash commands too) in 20 s; the first one over is told, the rest of
  the window ignored (a slash command over it is told each time, privately: Discord shows an error otherwise).
- **Slash commands go through the same door** ("Slash commands" below): the same lists, refusals, limit and handler;
  what differs is only that a refusal or a stranger gets an answer only they see.
- **No pings**: every message carries `allowed_mentions: { parse: [] }`, so nothing the bot repeats (a player's chat,
  `@everyone`) pings anyone.
- **The token** is never a setting, a command or chat. Every output says only `set (<where>)`, `not set` or
  `refused (<where>: <reason>)`; every line the Discord code logs or returns is scrubbed of it; the panel's log ring
  hides token-shaped strings; it goes only to `https://discord.com/api/v10` and to a gateway URL that is `wss://` on a
  `discord.gg` host.
- **Nothing listens**: an outbound websocket and outbound https only; no port, no public URL, no https front.

## Replies, notes and buttons

**Replies.** What the command says while it runs becomes one reply to the user's message, laid out for a phone
("What the messages look like" below), the game's colour codes removed. A long answer is split between lines into at
most 3 messages of 2 000 characters; the rest is counted (`... 12 more lines (the game chat and the panel have
them)`). A command that has said nothing after 1.5 s gets `!x: no reply yet (what it says in the next 2 min follows
here)`. For 2 min after a command, what that command says follows into the same channel, batched every 2 s, at most 8
messages: a `!goto`'s `walking to ...` comes as the reply, its `arrived at ...` a few seconds later. Only the
command's own lines follow ("Which lines are a command's own"); up to 4 commands are followed at once.

**Notes.** Every note away mode's limiter lets through ([away.md](away.md) "Notifications": alerts and questions, at
most 5 in 10 minutes, a question at most every 10 s) goes to the notes target, built as the webhook's message (the
push line in the text, one embed). With `dm` each listed user gets it as a direct message. Discord lets a bot open a
direct message only with a user who shares a server with it and accepts direct messages from that server's members;
`!discord test` shows whether it reached them. At most 10 notes wait.

**Buttons.** A question's note carries its choices as buttons (5 a row, short labels, the default the one blue
button). A press by a listed user runs `!answer <id> <choice>` (logged `discord: !answer 3 next (a button, as
<owner>, from <id>)`) and the message is updated at once to the outcome (`Skipped by @owner · 14 s`), the buttons
gone. A press by anyone else gets a private refusal only they see, and changes nothing. A button from before a restart
says it is closed. When a question ends any other way (answered in the game or the panel, its default taken), the
bot edits its messages the same way (`No answer: skipped`).

## Slash commands (Track D3)

Six commands, registered by the bot itself:

| Command | Runs | Why it is its own command |
|---|---|---|
| `/status` | `!status` | the first thing asked from a phone |
| `/stop` | `!stop` | the one that must be fast to reach |
| `/come` | `!come` | the usual "come back" |
| `/goto place:` | `!goto <place>` | the place is offered as you type, from the bot's waypoints |
| `/queue do:` | `!queue [<do>]` | empty shows the queue; `add <command>`, `pause`, `resume`, `clear`, `retry <id>` offered |
| `/run line:` | `!<line>` | every other command; the command names, then their words and waypoints, offered as you type |

Why six and not one per command: Discord shows every command in its `/` list, a long list is hard to read on a phone,
and a command added to the bot would need a new registration. The five that stand alone are the ones used most from
away; `/run` reaches every command the bot has (the same line as typed after `!`), and its suggestions come from the
bot's own command list and help, so it never goes stale. A refused command (`!quit`, `!test`, `!learn`) is never
offered.

**The door.** A slash command arrives as an interaction on the gateway (no interactions URL, nothing listens). It is
taken from a listed user in a listed channel or in a direct message with the bot, exactly as a typed command, and
turned into the same line (`/goto place:home` is `!goto home`): the same refusals (`/run line:quit`, `/run line:set
discordUsers ...`, `/queue do:add !quit`), the same 5 in 20 s, `Chat.handle` as the first owner with the source
`discord` in its own scope, logged `discord: !goto home (a slash command, as <owner>, from <id>)`.

**Answers.** Discord wants an answer within 3 s. When the command says something at once (`/status`), that is the
answer, seen by the channel; what the command says later follows as follow-up messages of the same interaction for 2
minutes, as a typed command's lines follow. When it says nothing at once, the bot answers "thinking" (deferred) and
edits the first line in when it comes. Replies are laid out by the rules of "What the messages look like". Follow-ups
go to the interaction's own address with its own short-lived token; the bot token is not sent with them.

**Refusals and strangers** get an answer only that user sees (`Only the users this bot was told to take commands from
may use it.`, `Not taken in this channel: ...`, `!quit is not taken from Discord: it ends the bot ...`, `Slow down:
...`). Why not silence, as for typed messages: Discord shows the user "The application did not respond", which reads as
a broken bot; the command list already shows anyone in the server that the bot exists, and the answer says nothing
about who is listed. Suggestions as you type are an empty list for a stranger or a channel not listed, so they learn
no waypoint or command name; for a listed user they spend no command of the 5 in 20 s.

**Registration.** After each READY the bot registers its commands with one bulk call per scope:

- **global**, for direct messages with the bot only (Discord's context "bot DM"), so a direct message works whatever
  server the user shares with the bot;
- **each server of a listed channel** (the bot reads each channel to learn its server), where they show at once.

Why both: server commands are Discord's documented way to show at once, while global ones were documented for years
as taking up to an hour to reach every client (newer documentation says they update at once, but a client keeps its
own cached list until it refreshes). With no channel listed only the global ones exist, for direct messages.

A server's list shows only in that server; no command shows twice. A scope is registered again only when its set
changed: the bot keeps a hash of each scope's body (with the application id) in `discord-commands.json` in the config
directory (memory only with `--no-config`), so a restart sends nothing. A server no longer listed has its commands
emptied. A refused registration (403: the bot was invited without `applications.commands`) is not remembered and is
tried at the next READY; `!discord setup` says how to fix it.

**When `discordBot` goes off the commands stay registered.** Why: without the gateway they do nothing (Discord shows
the user that the application did not respond), off is often a pause of minutes, and taking them out and putting them
back costs two calls per scope and a wait before Discord shows them again. `!discord commands remove` takes them out
for good (in every scope the bot registered), for example before deleting the application.

**`discordText`** (on): commands typed as messages are taken too. Off, the bot takes slash commands only and connects
with no intent at all: Discord sends it no messages, so the privileged Message Content intent is not needed and the
switch in the portal can stay off. Changing it starts a new gateway session. A gateway stopped with 4014 (the intent
not switched on) starts again by itself when `discordText` is set off.

## The set-up check (Track D3)

`!discord setup` (or `!discord check`) walks the set-up steps and gives each `ok`, `missing`, `unknown` (not known
yet, for example before the gateway is ready) or `off`, with a one-line fix for each that is not ok:

| Step | What is checked | How |
|---|---|---|
| switch | `discordBot` on | the setting |
| token | set, of the right shape, not refused (401 / 4004) | the token's state, the gateway's last close, the REST stop |
| gateway | ready; 4014 named with the intent switch | the gateway's state |
| application | its id | READY |
| servers | the bot is in at least one server | READY's server list |
| users | listed; each shares a server with the bot (else no direct message either way) | GET the member in up to 5 of the bot's servers |
| channel ...NNNN | each listed channel seen, in a server, and the bot's permissions there | GET the channel, its server's roles and the bot's member; the permissions worked out with the overwrites |
| notes | the notes channel writable with embeds, or each user reachable by DM, or `none` | as above |
| text | `discordText` and the intent agree | the gateway's intents and close |
| slash | registered in each scope, and Discord has them | the registration's state; GET each scope's commands |

With text commands on a channel needs View Channel, Send Messages, Embed Links and Read Message History; with slash
commands only it needs none of its own (an interaction's answer is not a channel message). The check only reads
(GET), never sends a message, and stops at a refused token without calling. It ends with the invite link, the
application id filled in. A good set-up:

```
discord setup: checking (the switch, the token, the gateway, the servers, the users, the channels, the notes, the slash commands) ...
discord setup: 10 ok
ok: switch, token, gateway, application, servers, users, channel ...3333, notes, text, slash
invite: https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=84992
```

A broken one (the channel's server never had the bot, a listed user shares no server with it, the notes channel
denies embeds):

```
discord setup: 7 ok, 3 missing
missing users: ...1212 shares no server with the bot: no direct message either way; fix: join a server the bot is in, or invite the bot to yours
missing channel ...3333: the bot cannot see it (403); fix: invite the bot to that server with the link below, or give its role View Channel there
missing notes: channel ...3636: seen, but the bot may not Embed Links there; fix: channel settings > Permissions: allow the bot's role Embed Links
ok: switch, token, gateway, application, servers, text, slash
invite: https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot+applications.commands&permissions=84992
```

`pnpm bot:check` (which never contacts Discord and never reads the token file) adds what it can know from the
settings: whether text commands and so the intent are wanted, that no channel means direct messages only, and that
the rest is for `!discord setup`.

## What the messages look like (Track D2)

Everything the bot sends to Discord is written to be read on a phone: in a push notification, which shows one line,
and in the app, where a line of about 35 to 60 characters fits. The game chat's wording is not changed; only the
layout is Discord's. The builders: `health/notify/discord.ts` (`payloadFor`, `outcomePayload`, `escapeMarkdown`),
`health/notify/discord-reply.ts` (`replyMessages`), `health/notify/discord-bot.ts` (`askButtons`). The unit tests in
`bot/test/unit/health/discord-messages.test.ts` hold every message below as JSON.

**A question** (the queue's, when a job fails and `askOwner` is on) is one message. As a phone shows it:

```
push:    Job #7 failed: retry, skip or pause the queue?
message: Job #7 failed: !goto zzqxtest                    (the embed's title, amber)
         No waypoint zzqxtest
         Unanswered: Skip in 5 minutes
         [ Retry ]  [ Skip ]  [ Pause queue ]             (Skip blue, the others grey)
         Bot · today at 14:02
```

- The push line asks the question in words, because it is all a locked phone shows. The title is the matter, the
  line under it the cause, so the reason to answer is read before the buttons. The cause is at most 100 characters;
  a longer one keeps what comes before its first bracket or `;` (`Craft: no oak_log for diamond_sword`, not the
  four lines of what is missing), because the game chat and the panel keep the whole line.
- The default is said once: `Unanswered: Skip <t:...:R>`, a Discord timestamp that each reader sees in their own
  clock and that counts down by itself ("in 5 minutes", "in 30 seconds"). There is no list of choices and no "how to
  answer" with buttons present: the buttons are the choices.
- The buttons have short labels the question gives (`short`; without one the choice's id, capitalised). The default
  is the one primary (blue) button and the rest are secondary (grey). No green or red: none of the queue's choices is
  good or bad, none loses work, and colour that says "safe" or "danger" would be a guess about the owner's game.
- The question's id is not in the text (it is in each button's id and in the panel); `!answer` with no id answers
  the one open question.

After the answer, or when the wait runs out, the bot edits the message: the buttons go, the push line goes (an edit
pushes nothing anyway), the colour turns grey and the last line says what happened:

```
Job #7 failed: !goto zzqxtest
No waypoint zzqxtest
Retried by @owner · 48 s                    (a press: the presser as a mention, which pings nobody)
Queue paused by <name> in the game · 2 min 5 s       (a typed answer: where it came from)
No answer: skipped                          (the default taken)
Closed by a newer question: skipped         (another question took its place)
```

The words (`Retried`, `Skipped`, `Queue paused`) are the question's own (`done`), so each outcome reads as the thing
that happened, not as a choice's id.

**Through the webhook** ([away.md](away.md) "Discord") the same message has no buttons, so it carries one line of how
to answer: ``Answer: `!answer 7 retry`, `next` or `stop` in the game or the panel``.

**An alert** (died, kicked, the connection lost for good) is the push line with the matter and the cause, the title
with the matter, one line of cause, the time as the embed's timestamp and the bot's name as the footer:

```
push:    The bot died: zombie at 10 64 -4
message: The bot died                                     (red)
         Zombie at 10 64 -4
         Bot · today at 14:02
```

A death names the killer the server reported, else the cause in words (`fell`, `drowned`, `killed` for `/kill`; an id
not listed shows as the server sent it). A kick says whether the owner has to do anything (`Server closed: it reconnects by itself`); several deaths folded
into one note say `The bot died (3 times in 1 min 12 s)` and `The last: ...`. No event kind (`life.died`) is shown:
it means nothing to the reader. Colours: red for alerts, amber for questions, blurple for `!discord test` and `!notify
test`, grey for a question that has ended.

**A reply** is plain text by default, laid out by a few rules on the shape of a line, never per command:

1. **Code** only where alignment is the content: a run of 2 or more lines in columns (two spaces between words), or
   3 or more lines that each hold a coordinate triple (a waypoint list). Why: elsewhere a code block costs a phone
   its line wrapping and makes every line look like an error.
2. **A list** where a line would not fit a phone: a line over 60 characters made of `;` parts (`processes: [active]
   walking ...; [paused] gather ...`) becomes the head in bold and a bullet per part; a `head: key value, key value,
   ...` line of 5 or more one-word keys (`!status`) becomes the head and the pairs a few to a row, each key in bold.
   Two such lines under the same head (`!discord`) are one list.
3. **Anything else** is the line as the game chat has it, its markdown escaped, so `diamond_sword` and `*` read as
   typed and nothing turns into a heading, a quote or a list by accident. A URL is left as it is.

The colour codes are always taken out. `!pos` is `pos 10.50 64.00 -3.50`; `!status`:

```
**status**
**up** 1h02m · **session** 12m03s
**reconnects** 1 · **kicks** 0
**pos** 10.50 64.00 -3.50
...
**processes**
- [active] walking to 10 -60 3, 24 blocks left, eta 6 s
- [paused] gather 3/10 logs
```

### Which lines are a command's own

A Discord command's reply, and what follows it for 2 minutes, is only what that command and the processes it started
say. A command typed in the panel or the game, a chore, the queue's own lines and another Discord command never show
in it. Why: Track D1 followed "whatever the bot says" for 2 minutes, so a `!status` from the panel during a Discord
`!goto` went to the Discord channel, and a reply could carry text the Discord user never asked for.

How a line is tied to its command (`bot/src/chat/scope.ts`, ADR 0118 addendum):

- Every command line `Chat.handle` runs as a command (typed in the game, sent from the panel or Discord, a console
  line) gets a **scope** of its own: an id, where it came from and the line. It is carried by Node's
  `AsyncLocalStorage`, so the command's timers and promises keep it without any command knowing.
- A reply closure (`reply(...)` kept by a command for later, such as `!goto`'s `arrived`) says its line in the scope of
  its command, wherever it is called from.
- A user process (`!goto`, `!get`, `!mine`) runs every call the process manager makes on it (`start`, `tick`, `pause`,
  `resume`, `stop`) in the scope it was added in; an automatic process (flee, eat) runs in none, so its lines belong
  to no command.
- A line kept past the game chat's rate limit (`sayKept`) is sent later in the scope it was said in.
- A step a command dispatches (an obtain job's next step, a `!do` plan's steps) stays in that command's scope; the
  queue opens a scope of its own for each job it runs.
- The Discord bot gives each command its own scope and keeps only lines said in it: the reply during the call, then
  the follow window. Up to 4 commands are followed at once, each in its own window (the fifth ends the oldest).
- A line said in no scope (a chore, a reconnect, an automatic process) goes to the game chat and the panel only.

What it cannot see: something long-lived that a command builds keeps that command's scope (a task rebuilt by `!mode`,
a socket opened inside a command). The follow window (2 minutes) and the queue's watch (the job's end) bound how long
that can matter.

## The limits

- **The gateway**: Discord's v10, JSON. The first heartbeat after `interval x random`, then every interval; a beat
  not acknowledged closes the link and resumes the session. Reconnects back off 2 s doubling to 5 min, with jitter.
  The closes that cannot get better by trying again (4004 a refused token, 4010 to 4013, 4014 an intent not switched
  on) stop it with the reason and no loop. At most 20 new sessions in 24 h (Discord allows 1 000). At most 100 frames
  a minute (Discord allows 120; heartbeats always go).
- **REST**: one queue per route with Discord's bucket headers honoured, a 429 waited out (3 tries; a wait over 60 s
  fails it), a global 429 holding every route, at most 10 requests a second in all (Discord allows 50), 10 s a call,
  a 5xx or no answer tried once more. A 401 stops every call and the gateway until the token changes.
- **A press, a slash command and a suggestion are answered within 2.5 s** (Discord allows 3 s), never retried. A
  slash command's follow-ups use the interaction's token, which Discord keeps for 15 minutes; the 2-minute follow
  window ends well inside it.
- **Registration**: one bulk call per scope, only when a scope's set changed; Discord allows 200 new commands a day
  per scope.
- **Nothing is thrown into the bot**: every handler is caught; a failure is counted and logged at most once a minute.
  A Discord outage costs the bot nothing but the messages.

**Not checked against Discord.** No test contacts Discord. The opcodes, close codes, intent bits, permission bits,
rate limits, the 3 s, the message and button limits, the User-Agent form and the direct-message rule are from Discord's
developer documentation as known when this was written. If something stops working, these are the numbers to recheck.

## Testing without Discord

`bot/test/unit/health/fake-discord.ts` is a small Discord in the test: an HTTP server for the REST routes the bot
uses and a websocket (HELLO, IDENTIFY, RESUME, heartbeats, dispatches) on the same loopback port. The bot reaches it
through `BEDROCKBOT_DISCORD_TEST_ORIGIN=http://127.0.0.1:<port>`, which takes only `http://127.0.0.1` or `localhost`
with a port (anything else: the bot logs it and connects nowhere), and the gateway URL the fake hands out must be on
the same host and port. The unit tests take a free port from the system (`ports: [0, 0]`, so two runs on one host
never collide); the e2e has the panel on 10140 to 10144 and the fake on 10145 to 10149. Since Track D3 the fake also
keeps application commands (`registered`, `puts`), sends slash commands and suggestions (`slash()`, `autocomplete()`),
takes follow-ups without the bot token (`followups`) and answers the set-up check's reads from tables (`channels`,
`guildData`, `members`; a status 403 or 404 for a channel the bot cannot see):

```
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e discord-bot --silent=false
```

Measured with it on bds-core (n3, 3 of 3): IDENTIFY 1.2 to 1.7 s after the bot starts; `!pos`'s reply under 0.01 s
after the message, as a reply to it, with its source `discord` in the command event; a `!goto` 10 blocks off, `walking
to` as the reply and `arrived` followed 4.5 s after the message; four messages from a stranger (in the channel and in
a direct message), the allowed user in another channel and a bot: no reply in 4 s; `!quit` refused with its reason,
the bot still up; a job queued from Discord failing, its question's note under 0.01 s after the question with its
three buttons, a stranger's press answered privately and changing nothing, the owner's press answered (type 7,
`next by <owner> (discord)`) under 0.01 s after it and the answer's event `how` `discord`; the token in none of the
replies, `/api/state`, `/api/state?lite=1`, `/api/away`, `/api/events`, the event store, the bot's output or the
messages sent to the fake Discord.

Track D2, the same e2e (n3, 3 of 3): `!pos` one plain line (`pos 18048.50 -60.00 17536.50`); the question's push line
`Job #1 failed: retry, skip or pause the queue?`, title `Job #1 failed: !craft diamond\_sword`, description
`Craft: no oak\_log for diamond\_sword` and `Unanswered: Skip <t:...:R>`, no fields, buttons Retry, Skip and Pause
queue with Skip the one primary; the owner's press edited it to `**Skipped** by <@id> · 0 s`, grey, no buttons, no
push line. A Discord `!goto` with the panel's `!discord status`, `!status` and `!set notify off` sent in its window
(5 reply lines in the panel): 2 messages in the channel, `walking to ...` and `arrived at ...` 4.8 s after the
message, none of the panel's. A `!goto zzqxtest` queued from the panel, the panel's `!discord status` sent as it
started: the job `failed` after 5.4 s with its own `no waypoint "zzqxtest" (!wp list)`.

Track D3, the same e2e (n3, 3 of 3): after READY 2 registrations (global and the listed channel's server), the six
commands in the server's list; `/status` from the owner answered with its reply (type 4, not private) 0.00 to 0.01 s
after the interaction, the log line `discord: !status (a slash command, as <owner>, from <id>)`; a stranger's
`/status` and the owner's `/run line:quit` answered privately (flags 64) with their reasons, nothing run, the bot up;
a suggestion for `/run line:qu` offered `quarry`, `queue`, `equip` (never `quit`), a stranger's suggestion an empty
list; `/run line:discord setup` answered `checking ...` and then, in 1 follow-up without the bot token, `discord
setup: 10 ok`, the ok list and the invite link with the application id; no message posted in the channel by any of
them; `!discord`'s third line `text commands on; slash commands 6 for DMs and 1 server; 2 run, 2 autocompletes`.
