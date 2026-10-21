# 0007: config file outside the repository

Date: 2026-10-29. Status: accepted (PLAN.md task 5.5).

## Question

Where do the bot's settings, including the Realm details (Realm name, token-cache label, token
folder, owners' gamertags), live so that nobody types them on a command line and nothing private ends
up in the repository? And how does a config file interact with the "agents never join the Realm" rule?

## Decision

- **One JSON file outside the repository**: `--config <file>`, else env `BEDROCKBOT_CONFIG`, else
  `%LOCALAPPDATA%\bedrockbot\config.json` (Windows) or `~/.bedrockbot/config.json`. It sits next to
  the default token cache (`%LOCALAPPDATA%\bedrockbot\profiles`). A missing default file means "all
  defaults", so tests and fresh clones need nothing.
- **JSON with comments**, validated by a strict zod schema (bot/src/config/config.ts): unknown keys
  and wrong types are errors that name the field, before anything connects. `pnpm config:init`
  writes a commented example and refuses paths inside the repository.
- **Precedence: CLI flag > config file > default**, merged by one pure function
  (bot/src/config/resolve.ts, unit-tested), so every flag keeps working as before.
- **`target: "realm"` is not allowed in the file.** Going online always takes `--target realm` on the
  command line (`pnpm bot:realm`). The file may hold the Realm block, which is used only then. This
  keeps the existing guard: a test, an agent or a plain `pnpm bot:afk` can never join the Realm because
  of a config file, however it is set up.
- **No secrets in the file.** Microsoft tokens stay in prismarine-auth's cache in `profilesFolder`,
  which `validateRealmTarget` refuses inside the repository whether it comes from the flag or the file.
- Paths in the file are relative to the file; paths on the command line are relative to where the
  command was started (`INIT_CWD` under pnpm).
- `--no-config` ignores the file; the soak and the in-process e2e tests use it or build their settings
  directly.

## Alternatives considered

- `.env` files: flat strings, no validation, and the habit of keeping them in the project folder.
- A config file in the repository (git-ignored): one `git add -f` away from leaking a Realm name and
  gamertags; also tied to one clone.
- YAML/TOML: one more dependency for no gain over JSON with comments.

## Consequences

- The Realm quick path is `pnpm config:init`, edit the `realm` block and `owners`, then
  `pnpm bot:realm`.
- e2e suites that spawn the CLI without `--no-config` read a user's default config if one exists
  (e.g. its `port`); keep the default file pointed at bds-dev or pass `BEDROCKBOT_CONFIG` to a test
  config when running them.
