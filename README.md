# Discord Utility Bot

A Discord.js v14 utility bot for community operations, moderation, exports, event scheduling,
forum workflows, and dashboard-managed slash commands.

_Last documentation refresh: 2026-06-09._

## What this repository includes

- **Slash commands from files or MongoDB**: run the bundled commands in `commands/`, upload
  dashboard commands to MongoDB, or enable DB-only mode.
- **Premium web dashboard**: start, stop, restart, view logs, edit settings, build flows, deploy
  dashboard commands, sync file commands, and send rich embeds.
- **CSV export tooling**: export channel messages, selected messages, forum post content, invite
  keyword posters, and reaction counts.
- **Moderation and utility commands**: cleanup, repost, role management, user/server info, status,
  member trends, invites, quotes, schedules, and BGMI match announcements.
- **Operational logging**: Winston logs, dashboard log forwarding, command usage/error counters,
  cooldowns, and owner/admin status checks.

## Requirements

- Node.js **18 or newer**
- A Discord application and bot token
- Guild IDs where slash commands should be registered
- MongoDB URI when using the dashboard command database or dashboard sync features

## Quick start

```bash
cp .env.example .env
npm install
npm run deploy
npm start
```

Before running `npm run deploy`, fill in at least:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id
GUILD_IDS=123456789012345678
```

## Environment variables

### Required for the bot and deploy script

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token from the Discord Developer Portal. |
| `CLIENT_ID` | Discord application/client ID. |
| `GUILD_IDS` | Comma-separated guild IDs where guild slash commands are registered. |

### Authorization and access control

| Variable | Description | Default |
| --- | --- | --- |
| `COMMAND_ROLE_ID` | Role required to use commands that check the configured command role. | Empty |
| `BOT_OWNER_ID` | Owner user ID for owner-only access to `/status`. | Empty |

### Exports, reposting, and generated posts

| Variable | Description | Default |
| --- | --- | --- |
| `ROLE_ID` | Role mentioned by `/generate` for Community Custom Matches. | `1204073198837309491` |
| `OUTPUT_DIR` | Directory where CSV export files are written. | `./exports` |
| `DEFAULT_PER_CHANNEL_LIMIT` | Default max messages for exports; `0` means unlimited. | `0` |
| `REPOST_MAX_SEND` | Safety cap for `/repost` sends per invocation. | `200` |

### Dashboard and MongoDB

| Variable | Description | Default |
| --- | --- | --- |
| `WEB_DASHBOARD_PORT` | Express dashboard port. | `3000` |
| `DASHBOARD_PASSWORD` | Bearer token/password for dashboard APIs and login. | Empty |
| `DASHBOARD_URL` | URL used by the bot to post command logs back to the dashboard. | `http://localhost:3000` |
| `MONGODB_URI` | MongoDB connection string for command records and dashboard-managed commands. | Empty |
| `DB_ONLY_COMMANDS` | If `true`, the bot and deploy script load only dashboard commands from MongoDB. | `false` |
| `WRITE_COMMAND_FILES` | If `true`, dashboard-deployed commands are also written into `commands/`. | `false` |

### Logging

| Variable | Description | Default |
| --- | --- | --- |
| `LOG_FILE` | Main log file path. | `logs/bot.log` |
| `ERROR_LOG_FILE` | Error-only log file path. | `logs/error.log` |
| `LOG_LEVEL` | Winston log level. | `info` |
| `LOG_CHANNEL` | Fallback dashboard log channel ID if not set in `config.json`. | Empty |
| `ERROR_CHANNEL` | Fallback dashboard error log channel ID if not set in `config.json`. | Empty |

## NPM scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the Discord bot. |
| `npm run deploy` | Register slash commands to all configured guilds. |
| `npm run dev` | Start the bot with `NODE_ENV=development`. |
| `npm run dashboard` | Start the web dashboard. |
| `npm run dashboard-premium` | Alias for the web dashboard. |
| `npm run logs` | Tail the main bot log. |
| `npm run errors` | Tail the error log. |
| `npm run quality:check` | Check JS/JSON/Markdown formatting basics. |
| `npm run quality:fix` | Auto-fix supported formatting issues. |

## Command inventory

### Utility and information

| Command | Description |
| --- | --- |
| `/ping` | Check bot latency and Discord API ping. |
| `/help` | Show available commands and descriptions. |
| `/serverinfo` | Show detailed server information. |
| `/userinfo [user]` | Show user account, guild, role, and permission details. |
| `/status` | Show bot health, uptime, memory, and usage statistics. Admin/owner gated. |
| `/createinvite` | Create an invite for a selected channel. |
| `/quote` | Quote up to 10 Discord messages from links. |

### Exports and analysis

| Command | Description |
| --- | --- |
| `/export` | Export channel messages, or a range between two message IDs, to CSV. |
| `/exportmessages` | Export specific message links/IDs to CSV. |
| `/exportinvites` | Export unique users who posted a keyword to CSV. |
| `/exportforumposts` | Export all messages from every post in a forum channel to CSV. |
| `/fetchreactions` | Export messages with thumbs-up/thumbs-down reaction counts. |
| `/membertrend` | Show daily server member-count snapshots for a date range. |
| `/joinedafter` | Count members who joined after a UTC date. |

### Moderation and member operations

| Command | Description |
| --- | --- |
| `/cleanup` | Bulk-delete 1-100 messages, optionally filtered by user or bot authors. |
| `/repost` | Fetch messages and repost them into a target channel with optional sanitization. |
| `/rolemanage add/remove` | Bulk-add or bulk-remove a role for listed users. |
| `/findids` | Find Discord user IDs from username input. |
| `/listusers` | Paginated member list for a selected role. |
| `/reactafter` | React to messages after a starting message link, one by one. |

### Forum, schedule, and BGMI workflows

| Command | Description |
| --- | --- |
| `/createpost` | Create a single forum post or open a bulk post session. |
| `/schedule` | Generate randomized match schedules from map and mode pools. |
| `/generate` | Post the Community Custom Matches schedule embed with optional link buttons. |

## Command source modes

### File-based mode (default)

- `index.js` loads JavaScript command modules from `commands/`.
- `deploy-commands.js` registers those commands to every guild in `GUILD_IDS`.
- Dashboard commands stored in MongoDB can override file commands with the same slash command name
  when the bot loads DB commands.

### DB-only dashboard mode

Use this when you want commands to live entirely in MongoDB and do not want to depend on the local `commands/` folder.

```env
DB_ONLY_COMMANDS=true
WRITE_COMMAND_FILES=false
MONGODB_URI=mongodb+srv://...
```

Then use the dashboard flow builder or command upload API, deploy from the dashboard or run
`npm run deploy`, and start the bot with `npm start`.

## Dashboard overview

Start the dashboard with:

```bash
npm run dashboard
```

The dashboard serves `public/premium.html` and exposes authenticated APIs for:

- bot process controls: start, stop, restart, status, logs, and log files;
- settings: bot nickname, presence, log channels, DM toggle, dev mode, and command role;
- command management: list, inspect, upload, delete, generate, deploy, and sync commands;
- schedules and rich embed sending;
- command log forwarding from the running bot.

Set `DASHBOARD_PASSWORD` and send it as a bearer token for dashboard API calls.

## Required Discord bot permissions

Invite the bot with permissions that match the commands you plan to use:

- View Channels
- Send Messages
- Read Message History
- Use Slash Commands
- Embed Links
- Attach Files
- Add Reactions
- Manage Messages for `/cleanup`
- Manage Roles for `/rolemanage`
- Create Instant Invite for `/createinvite`
- Manage Guild if you use server-level administrative workflows

Also enable these privileged intents in the Discord Developer Portal when needed:

- Server Members Intent
- Message Content Intent

## Project layout

```text
commands/                 Slash command modules
utils/command-loader.js   Shared command loader for bot and deploy script
utils/builders.js         Small helpers for slash commands and embeds
dashboard-premium.js      Express dashboard, command DB APIs, flow generation, embed sending
db.js                     MongoDB connection and command model helpers
index.js                  Discord bot runtime
deploy-commands.js        Guild slash command registration script
public/                   Dashboard HTML, CSS, and client JS
docs/                     Maintainer notes and builder playbook
```

## Documentation

- `docs/BUILDER_PLAYBOOK.md` explains the current command/embed helper APIs and how to build richer
  Discord.js components directly.
- `docs/CODE_ANALYSIS.md` summarizes the current architecture, command-loading behavior, and maintenance notes.
- `CHANGELOG.md` records documentation and project changes.
