# UX: command tiers, help, modes, welcome, hints (wave 9, Track AM)

The bot has 35+ chat commands; an owner needs about nine. Everything still works as before, but the
help shows the **front door** first and keeps the rest one step away. Things the bot does on its own
(cooking after a hunt, eating, armour, sleeping, the food chore, the stash step) are said once in the
deep help instead of asking the owner to type them.
Decision record: [decisions/0034-ux-tiers-help-modes.md](decisions/0034-ux-tiers-help-modes.md).

## Files

| File | What |
|---|---|
| `bot/src/chat/chat.ts` | `CommandDef` gains `tier` (`front` / `more`, default `more`), `group`, `example`, `auto`; `Chat.commandInfo()`, `has()`, `helpReplies()`, `helpSettings`, `hinter` (applied in `say()`), `!commands`; `helpText()` adds the auto lines |
| `bot/src/chat/help.ts` | `FRONT_DOOR`, `GROUP_ORDER`, `splitHelp`, `frontHelp` / `allHelp` / `commandHelp` / `settingsHelp` / `helpReplies`, `SETTING_GROUPS`, `hintFor` (the three rules) |
| `bot/src/chat/modes.ts` | `!mode`, `MODE_CHANGES`, `modeValues` / `currentMode` / `modeLine` / `applyMode`; `registerUxCommands` (one entry in tasks/registry.ts: `!mode`, `!help settings`, the hints, the welcome) |
| `bot/src/chat/welcome.ts` | `attachWelcome`, `welcomeLines`, `welcomeVersion`, `WELCOME_NEWS` |
| `bot/src/chat/commands*.ts`, `health/panel/index.ts` | one line per command: `tier` / `group` / `example` / `auto` |
| `bot/src/config/settings.ts` | `lastWelcomed` (text, default `none`) |
| `bot/src/nl/plan.ts`, `prompt.ts`, `executor.ts` | the `answer` step (`isTalk`), its rules and two examples |
| `bot/src/health/panel/state.ts`, `routes.ts`, `page.ts` | `buildPanelHelp`, `GET /api/help`, the Help section |
| `bot/test/unit/chat/ux.test.ts` | unit tests (real afk registry, fakes) |
| `bot/test/e2e/ux-core.test.ts` | e2e on bds-core |

## Tiers

Every command has a tier and a group. `front` is what `!help` shows; `more` is in `!help all`. A
command registered without a tier is `more` (so `!unload`, `!stock`, `!chests`, `!explore` and
`!build` from the other wave-9 tracks land there until they are tagged at the merge; `build`,
`explore` and `unload` are meant for the front door: help.ts `FRONT_DOOR` has the comment).

| Command | Tier | Group | Example | Also on its own |
|---|---|---|---|---|
| `!come` | front | go | `!come` | |
| `!follow` | front | go | `!follow` | |
| `!get` | front | work | `!get wood 16` | the stash step: a full inventory during a job goes into `stashChest`, the job chest or a carried shulker box, then junk is dropped |
| `!guard` | front | fight | `!guard on` | |
| `!home` | front | home | `!home set` | it walks home after a respawn, at dawn and after a guard fight |
| `!stop` | front | control | `!stop` | |
| `!do` | front | control | `!do walk home then guard` | |
| `!status` | front | info | `!status` | |
| `!help` | front | info | `!help get` | |
| `!wp` | more | go | `!wp set base` | the death, home and spawn waypoints keep themselves up to date |
| `!goto` | more | go | `!goto base` | |
| `!top` | more | go | `!top` | |
| `!gather` | more | work | `!gather 16` | |
| `!mine` | more | work | `!mine coal_ore 8` | |
| `!farm` | more | work | `!farm 8` | |
| `!food` | more | work | `!food 8` | with `autoFood` on it hunts by day when the food carried is below `foodMin` (the food chore) |
| `!cook` | more | work | `!cook` | after every hunt (`!food`, `!get beef`, the food chore) when it carries raw food and fuel and a furnace or smoker is within 16 blocks of home |
| `!breed` | more | work | `!breed cow 2` | with `autoBreed` on and `chorePen` set it breeds that pen by day every 10 minutes while a kind has fewer than 8 adults |
| `!kill` | more | fight | `!kill zombie 3` | |
| `!sleep` | more | home | `!sleep` | at night when a bed is known within 8 blocks of the shelter or home, or at the `bed` waypoint (`!sleep off` stops that) |
| `!eat` | more | home | `!eat` | it eats when food drops below 18 or health is low |
| `!equip` | more | home | `!equip` | it puts on better armour as soon as it carries some |
| `!drop` | more | home | `!drop items` | junk (rotten flesh, string, ...) is dropped when the inventory is full |
| `!shelter` | more | home | `!shelter set` | with a shelter set it walks there at dusk and waits out the night inside |
| `!pause` / `!resume` | more | control | `!pause` | |
| `!set` | more | control | `!set fleeHealth 10` | |
| `!mode` | more | control | `!mode careful` | |
| `!yes` / `!no` | more | control | `!yes` | |
| `!quit` | more | control | `!quit` | |
| `!inv` | more | info | `!inv` | |
| `!pos` | more | info | `!pos` | |
| `!health` | more | info | `!health` | |
| `!panel` | more | info | `!panel` | |
| `!commands` | more | info | `!commands` | |

**`!goto` stays `more`.** `!come` brings the bot to the owner, `!home go` walks home, and a saved place
needs `!wp set` first (itself `more`); `!do go to the mine` reaches the same `!goto` in plain words.
Coordinates are rarely what an owner in the game wants to type.

**Deletion candidates** (rule: a `more` command without an automatic trigger): `!gather`, `!mine`
(both behind `!get wood` / `!get iron`), `!farm`, `!kill`, `!goto`, `!top`, `!pause`, `!resume`,
`!set`, `!pos`, `!quit`, `!health`, `!inv`, `!panel`, `!yes`, `!no`, `!mode`, `!commands`. Most are
still the plumbing of `!get` and `!do` (they dispatch `!gather` / `!mine` / `!farm` / `!kill`), the
panel or the tests, so "candidate" means: hide, do not remove, until nothing dispatches them.

## Help formats

At most 256 characters per message (the chat cuts there) and the chat's 8 replies per 10 s.

`!help` (front door, at most 3 messages; the last names `!help all` and `!help <command>`):

```
front door: go: !follow (follow a player; default you), !come (walk to you, or to the named player) | work: !get (makes wood, ores, stone, food, crops; never takes from chests) | fight: !guard (fight hostiles near home)
home: !home (home point; go walks there) | control: !stop (stop every command; guard and night keep running), !do (say it in plain words: a plan, !yes runs it; or ask me something)
info: !status (what it is doing: uptime, position, the process stack), !help (this list; all: every command) | more: !mode careful|normal|bold, !help settings, !help all, !help <command>
```

When the front door grows past 3 messages (more front commands after a merge) the phrases are
dropped and only the names stay.

`!help all` / `!commands` (every command by group, names only, front door first; at most 4 messages):

```
all commands (35): go: follow come wp goto top; work: get gather farm mine food cook breed; fight: guard kill; home: home sleep eat equip drop shelter; control: stop do pause resume set yes no mode quit; info: status help commands inv pos health
```

`!help <command>` (syntax and description, example, the auto line):

```
!cook: cook the raw food carried in the furnace or smoker within 16 blocks of home [work, more]
example: !cook
also on its own: after every hunt (!food, !get beef, the food chore) when it carries raw food and fuel and a furnace or smoker is within 16 blocks of home
```

The description is the last parenthesis of the command's `help` text, the syntax what comes before
it. `!help nosuch`: `no command !nosuch; !help all lists every command`.

`!help settings` (the mode first, then the settings by group with their values):

```
settings: mode normal (!mode careful|normal|bold); safety: fleeHealth 8, guardRadius 16, avoidMobRadius 4, avoidSpawnerRadius 8; walking: allowBreak off, allowPlace off, closeDoors off, sprint on, followDistance 3, plannerThreads 1
work: mineSeenOnly off, mineTunnelLen 32, useBoneMeal on, toolWearLimit 10, throwawayMin 16, stashChest none, stashShulker on; food: autoFood on, foodMin 10, foodLeave 2, autoBreed off, chorePen none
other: nudgeInterval 240, nlConfirm on, lastWelcomed none; !set <key> explains one
```

## Modes

`!mode careful | normal | bold | status` sets several settings at once through the same runtime
settings as `!set` (live, saved to settings.json; `!set <key>` still changes one key afterwards). A
key a mode leaves at the default is reset (removed from settings.json).

| Setting | careful | normal (defaults) | bold |
|---|---|---|---|
| `fleeHealth` | 12 | 8 | 6 |
| `guardRadius` | 8 | 16 | 24 |
| `avoidMobRadius` | 8 | 4 | 3 |
| `avoidSpawnerRadius` | 16 | 8 | 8 |
| `allowBreak` | off | off | on |
| `allowPlace` | off | off | on |

Replies: `mode careful: fleeHealth 12, guardRadius 8, avoidMobRadius 8, avoidSpawnerRadius 16,
allowBreak off, allowPlace off (was normal)`; `!mode status`: `mode careful (...)`, or after
`!set fleeHealth 9`: `mode custom (careful but fleeHealth 9 instead of 12) (...)` (the nearest mode
and the keys that differ).

## Welcome

The first time an owner (by name) is seen after a new bot version, chatting or joining (a
`player_list` add), the bot whispers them 4 lines through the update notifier's path
(`whisperOwners`: `/tell "<owner>" ...` as a command_request):

```
BedrockBot 0.0.0+w9 is here
new: !help is short now; !help all lists everything, !help <command> explains one
new: !mode careful|normal|bold switches the safety settings at once
try !get wood, !come, !do <sentence>; !help for more
```

Then `lastWelcomed = <version>` is stored, so it never repeats for that version (also not after a
reconnect; with a settings file also not after a restart). The version is `<bot/package.json
version>+<WELCOME_NEWS.tag>`: the package says `0.0.0`, so a release with news bumps the tag in
welcome.ts (and the two news lines). A player_list add before the spawn waits for the spawn (1 s
retries). On BDS the owner receives a `whisper` text packet from the bot (plus a json
`commands.message.display.outgoing` echo).

## Hints

Exactly three rules (help.ts `hintFor`, pure), appended to the end-of-job reply when it still fits in
one message:

1. a mine / gather / food job ends (`mine coal_ore: 8/8 done`, `gather done: 24/20 logs`,
   `food: 6/6 items ...`) with fewer than 4 free slots: `(!unload at home)`, or
   `(inventory nearly full)` while there is no `!unload` (checked at runtime, `chat.has('unload')`);
2. a food run ends with raw food carried and no furnace or smoker within 16 blocks of home (and the
   reply does not already say so): `(no furnace within 16 of home: raw)`;
3. `!get <unknown>`: no hint; the categories line already says what works and stays one message.

## Natural-language answers

`!do what can you do`, `Bot, can you cook?`: the model may answer with a plan of a single
`{"command":"answer","text":"..."}` step (up to 200 characters). The bot says the text verbatim and
runs nothing. The schema rejects an answer mixed with other steps. The prompt tells the model to
answer from the command reference (now every chat command with its "also on its own" line) and the
bot state it already receives, never to invent abilities, and to prefer a plan when the owner asked
for an action.

## `!get` and chests

`!get` makes new things; bringing stored things is a later command. Its catalog has four strategies
(gather, mine, hunt, farm), each a process that produces items; the stash step only deposits; the
chest skill has open / deposit / close and no way to take items out. A unit test pins this
(`ux.test.ts` "!get never takes from chests").

## Panel Help tab

The control panel (docs/panel.md) has a Help section: the registry as a table (tier, group, syntax,
help, example, also on its own), the modes table with the current mode, and the settings by group
with values, defaults and descriptions. It is fetched once, when the section is first opened, from
`GET /api/help` (same token check as the rest); `/api/state` is unchanged.

## Measured (bds-core, BDS 1.26.60.6, 2026-10-29, ux-core, 2 runs)

| Step | Result |
|---|---|
| `!help` | 3 messages (219, 180, 186 characters), the front door exactly, in 1.5 s (incl. the 1.2 s quiet wait) |
| `!help cook` / `!help all` | 3 messages (with the example and the auto line) / 1 message with all 35 commands |
| `!mode careful` | fleeHealth 12 (`!set fleeHealth` agrees), `!mode status` careful, `custom (careful but fleeHealth 9 instead of 12)` after `!set fleeHealth 9` |
| welcome | 4 whispers 0.26 s after the owner's first chat line; none after more chat and after the bot reconnected with the same settings |
| `!do what can you do` | one line (the answer), no process, `!status` `processes: idle` |

## Tests

```
pnpm --filter bot exec vitest run --project unit chat/ux chat.test nl            # unit
BDS_E2E=1 pnpm --filter bot exec vitest run --project e2e ux-core                 # bds-core (udp 19180)
```

## Open points

- `bot/package.json` is `0.0.0`; the welcome keys on `0.0.0+w9`. A real version number would make the
  tag unnecessary.
- The hint is appended inside `Chat.say`, after the wrappers of the panel (ChatTap) and the
  natural-language executor: the panel's bot-chat list shows the reply without the hint.
- `!help all` is one message today; tagging the wave-9 commands may push it to two.
