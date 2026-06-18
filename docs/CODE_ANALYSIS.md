# Code Analysis and Maintenance Notes

_Last documentation refresh: 2026-06-09._

## Runtime architecture

This project is a Node.js Discord bot built on Discord.js v14. The bot runtime starts in `index.js`,
creates a Discord client with guild, message, content, and member intents, loads slash commands, connects to
MongoDB for dashboard commands, and handles interactions with cooldowns, logging, and usage statistics.

The dashboard runtime starts in `dashboard-premium.js`. It is an Express application with WebSocket log
streaming, process controls for the bot, settings APIs, command upload/flow deployment, schedule endpoints,
sync tooling, and rich embed sending.

## Main modules

| File or directory | Responsibility |
| --- | --- |
| `index.js` | Discord client setup, command loading, auth, execution, presence, and dashboard logs. |
| `deploy-commands.js` | Registers guild slash commands from file modules or MongoDB records. |
| `dashboard-premium.js` | Web dashboard, API auth, process controls, commands, flows, schedules, embeds. |
| `db.js` | MongoDB connection, command schema, CRUD helpers, counters, and file-command sync helper. |
| `utils/command-loader.js` | Shared safe-ish command module loader used by the bot and deploy script. |
| `utils/builders.js` | Small helper layer for `SlashCommandBuilder`, `EmbedBuilder`, and shared embed colors. |
| `commands/` | File-based slash command modules. |
| `public/` | Dashboard HTML, CSS, and browser JavaScript. |

## Command loading behavior

The repository supports two command sources:

1. **File commands** in `commands/*.js`.
2. **Dashboard commands** stored in MongoDB command records with `source: "dashboard"` and executable `code`.

Default behavior:

- `index.js` loads file commands first.
- The bot then connects to MongoDB and loads dashboard commands.
- Dashboard commands with duplicate names override file commands in the in-memory `client.commands` collection.
- If MongoDB is unavailable, the bot continues with file commands unless `DB_ONLY_COMMANDS=true` was selected.

DB-only behavior:

- `DB_ONLY_COMMANDS=true` skips the `commands/` folder in both the bot and deploy script.
- MongoDB must be reachable and contain valid dashboard command records for commands to be available.

Deploy behavior:

- `deploy-commands.js` registers guild commands to every guild in `GUILD_IDS`.
- In default mode, file commands are used when any valid file commands exist.
- If no file commands are found, deploy falls back to MongoDB dashboard commands.
- In DB-only mode, deploy reads MongoDB dashboard commands directly.

## Current file command inventory

| Command | Category | Primary purpose |
| --- | --- | --- |
| `/cleanup` | Moderation | Bulk-delete messages with optional user/bot filters. |
| `/createinvite` | Utility | Create channel invite links with use/expiry options. |
| `/createpost` | Forum | Create one forum post or open a bulk post session. |
| `/export` | Export | Export channel messages or message ID ranges to CSV. |
| `/exportforumposts` | Export | Export messages from every post in a forum channel. |
| `/exportinvites` | Export | Export unique users who posted a keyword. |
| `/exportmessages` | Export | Export selected message links/IDs. |
| `/fetchreactions` | Export | Export messages and reaction counts. |
| `/findids` | Utility | Resolve user IDs from username input. |
| `/generate` | BGMI/event | Post Community Custom Matches schedule embeds with optional buttons. |
| `/help` | Utility | Show available commands and descriptions. |
| `/joinedafter` | Analytics | Count members who joined after a date. |
| `/listusers` | Utility | Paginate members with a selected role. |
| `/membertrend` | Analytics | Show member-count snapshots over a date range. |
| `/ping` | Utility | Show bot/API latency. |
| `/quote` | Utility | Quote one or more Discord messages from links. |
| `/reactafter` | Moderation/utility | React to messages after a given message link. |
| `/repost` | Moderation/utility | Repost fetched messages into a target channel. |
| `/rolemanage` | Moderation | Bulk add or remove roles. |
| `/schedule` | BGMI/event | Generate randomized match schedules. |
| `/serverinfo` | Utility | Show server details. |
| `/status` | Admin | Show bot health and runtime statistics. |
| `/userinfo` | Utility | Show user details. |

## Dashboard API surface

The dashboard uses bearer-token authentication based on `DASHBOARD_PASSWORD` for most API routes.
Key route groups include:

- `/api/login`, `/api/status`, `/api/start`, `/api/stop`, `/api/restart`
- `/api/logs`, `/api/log-files`, `/api/stats`
- `/api/settings`, `/api/settings/apply`, `/api/danger/:op`
- `/api/schedules`
- `/api/commands`, `/api/commands/:name`, `/api/commands/upload`
- `/api/flow/generate`, `/api/flow/deploy`
- `/api/sync`
- `/api/embed/send`
- `/api/log`

## Configuration sources

Runtime configuration comes from both `.env` and `config.json`:

- `.env` stores secrets and deployment-specific values such as tokens, guild IDs, MongoDB URI, ports,
  and feature limits.
- `config.json` stores dashboard-editable settings such as allowed guilds, command role ID, presence,
  log channels, dev mode, and DM behavior.
- `deploy-commands.js` updates `config.json.allowedGuilds` from `GUILD_IDS` and stores `COMMAND_ROLE_ID` when provided.

## Important maintenance notes

- Keep command files shaped as `{ data, execute }`; the loader skips invalid files and reports a reason.
- Do not document helper APIs that do not exist in `utils/builders.js`. Buttons, action rows, modals,
  and select menus should currently be imported from `discord.js` directly.
- Treat dashboard command code as trusted admin input. It is compiled and executed as JavaScript.
- Keep `DB_ONLY_COMMANDS` and `WRITE_COMMAND_FILES` documented together because they control whether
  dashboard commands stay only in MongoDB or are mirrored to disk.
- Run `npm run quality:check` before committing documentation or code changes.

## Suggested future improvements

- Add automated tests for `utils/command-loader.js` and `utils/builders.js`.
- Add a dry-run mode to `deploy-commands.js` that validates command JSON without hitting Discord.
- Split `dashboard-premium.js` into smaller route modules as the dashboard grows.
- Consider adding TypeScript or JSDoc typedefs for command modules and dashboard flow objects.
- Review dashboard command execution security before allowing untrusted users to upload code.
