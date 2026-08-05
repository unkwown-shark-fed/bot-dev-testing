# 🤖 Discord Utility Bot

A Discord.js v14 utility bot for server administration, data exports, moderation helpers, event/community tools,
and dashboard-managed slash commands.

## ✨ Highlights

- **Slash-command utility suite** for server info, user info, latency checks, status metrics, and help.
- **CSV export workflows** for channel messages, selected messages, keyword posters, forum posts, and reaction counts.
- **Moderation and operations tools** for cleanup, reposting, role management, invites, member trends,
  and join-date counts.
- **Premium web dashboard** for starting/stopping the bot, viewing logs, editing settings, managing command
  records, and deploying commands.
- **MongoDB-backed command mode** that can run commands from dashboard records without requiring local
  `/commands` files.
- **Structured logging and metrics** with rotating log files, command usage counts, error counts, and dashboard
  log forwarding.

---

## 🚀 Quick Setup

```bash
# 1. Copy .env.example to .env
cp .env.example .env

# 2. Fill in required credentials
# Required: DISCORD_TOKEN, CLIENT_ID, GUILD_IDS, MONGODB_URI, DASHBOARD_PASSWORD

# 3. Install dependencies
npm install

# 4. Register slash commands to the configured guilds
npm run deploy

# 5. Start the bot
npm start
```

To run the dashboard instead of the bot process directly:

```bash
npm run dashboard
```

---

## 📋 Command List

### 📊 Utility Commands
| Command | Description |
|---------|-------------|
| `/ping` | Check bot latency and API ping |
| `/help` | Show available commands and descriptions |
| `/serverinfo` | Display detailed server information |
| `/userinfo [user]` | Display detailed user information |
| `/status` | Show detailed bot health, uptime, memory, and statistics (admin only) |

### 📤 Export Commands
| Command | Description |
|---------|-------------|
| `/export` | Export messages in a channel, or between two message IDs, to CSV |
| `/exportmessages` | Export multiple messages by link or ID to CSV |
| `/exportinvites` | Export unique users who posted a keyword to CSV |
| `/exportforumposts` | Export all messages from every post in a forum channel to CSV |
| `/fetchreactions` | Export messages with thumbs-up/thumbs-down reaction counts from a channel |

### ⚙️ Moderation & Admin Commands
| Command | Description |
|---------|-------------|
| `/cleanup` | Bulk delete messages in a channel (admin only) |
| `/repost` | Fetch messages by range or count and repost them to a target channel |
| `/rolemanage add/remove` | Bulk add or remove a role for listed users |
| `/createinvite` | Create an invite link for a specific channel |

### 🔍 Search & Member Commands
| Command | Description |
|---------|-------------|
| `/findids` | Find user IDs by username or username#discriminator |
| `/listusers` | Paginated list of server users in a role |
| `/joinedafter` | Count members who joined after a given date (`YYYY-MM-DD`) |
| `/membertrend` | Show daily server member-count snapshots for a date range |
| `/reactafter` | React to messages after a starting message link, one by one |
| `/quote` | Quote one or more Discord messages by link |

### 🎮 Community Commands
| Command | Description |
|---------|-------------|
| `/generate` | Post the Community Custom Matches schedule embed with optional event buttons |
| `/generate_v2` | Post the Community Custom Matches schedule configured in code |
| `/createpost` | Create a single post or open a bulk posting session |

---

## ⚙️ Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from the Discord Developer Portal |
| `CLIENT_ID` | Discord application client ID |
| `GUILD_IDS` | Comma-separated guild IDs where slash commands are registered |
| `MONGODB_URI` | MongoDB connection string for dashboard commands and member snapshots |
| `DASHBOARD_PASSWORD` | Bearer token/password required by the dashboard API |

### Optional - Authorization
| Variable | Description | Default |
|----------|-------------|---------|
| `COMMAND_ROLE_ID` | Role ID required to use bot commands | Empty (everyone) |
| `BOT_OWNER_ID` | User ID with owner-level access to owner-gated commands | Empty |

### Optional - Dashboard & Command Loading
| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_DASHBOARD_PORT` | Port used by `dashboard-premium.js` | `3000` |
| `DASHBOARD_URL` | Bot-to-dashboard URL used for log forwarding | `http://localhost:3000` |
| `DB_ONLY_COMMANDS` | If `true`, bot and deploy scripts load commands only from MongoDB dashboard records | `false` |
| `WRITE_COMMAND_FILES` | If `true`, dashboard mirrors uploaded/generated commands into `/commands` files | `false` |

### Optional - Features
| Variable | Description | Default |
|----------|-------------|---------|
| `ROLE_ID` | Role to ping in `/generate` | `1204073198837309491` |
| `OUTPUT_DIR` | Directory where generated CSV exports are saved | `./exports` |
| `DEFAULT_PER_CHANNEL_LIMIT` | Maximum messages per export channel (`0` = unlimited) | `0` |
| `REPOST_MAX_SEND` | Maximum messages `/repost` can send in one invocation | `200` |
| `NODE_ENV` | Runtime environment | `production` |

### Optional - Logging
| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_FILE` | Main log file path | `logs/bot.log` |
| `ERROR_LOG_FILE` | Error-only log file path | `logs/error.log` |
| `LOG_LEVEL` | Logging level (`error`, `warn`, `info`, `debug`) | `info` |
| `LOG_CHANNEL` | Dashboard settings fallback for command log channel | Empty |
| `ERROR_CHANNEL` | Dashboard settings fallback for error log channel | Empty |

---

## 🧠 Dashboard-only Command Mode

Use this mode when you want to manage command code from MongoDB/dashboard records instead of local files:

1. Set `DB_ONLY_COMMANDS=true` in `.env`.
2. Keep `WRITE_COMMAND_FILES=false` unless you intentionally want dashboard uploads mirrored into `/commands`.
3. Start the dashboard with `npm run dashboard` and upload or edit command records.
4. Run `npm run deploy` to register dashboard commands with Discord.
5. Start or restart the bot so it loads the latest MongoDB command records.

Notes:
- File commands and dashboard commands can coexist when `DB_ONLY_COMMANDS=false`.
- If a dashboard command has the same name as a file command, it overrides the file command at runtime.
- Dashboard command code is compiled and executed inside the bot process, so protect dashboard credentials carefully.

---

## 🔧 NPM Scripts

```bash
npm start                 # Start the bot
npm run deploy            # Register slash commands to configured guilds
npm run dev               # Start the bot with NODE_ENV=development
npm run dashboard         # Start the premium dashboard
npm run dashboard-premium # Alias for the premium dashboard
npm run logs              # Tail the main log file
npm run errors            # Tail the error log file
npm run quality:check     # Run repository code-quality checks
npm run quality:fix       # Run auto-fixes for supported quality checks
```

---

## 🛡️ Required Bot Permissions

When inviting your bot, ensure it has the permissions needed by the commands you plan to use.

**Essential Permissions**
- View Channels
- Read Message History
- Send Messages
- Attach Files
- Use External Emojis
- Embed Links

**Moderation / Admin Commands**
- Manage Messages (`/cleanup`)
- Manage Roles (`/rolemanage`)
- Create Instant Invite (`/createinvite`)
- Manage Events (optional, for event-button workflows)

**Privileged Intents**
- Server Members Intent (for member/user lookup and trend commands)
- Message Content Intent (for exports, reposting, keyword scans, and reaction workflows)

---

## 🐛 Troubleshooting

### Commands Not Appearing
```bash
npm run deploy
```

- Confirm `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_IDS` are set.
- Confirm the bot is invited to each guild in `GUILD_IDS`.
- In dashboard-only mode, confirm MongoDB command records exist before deploying.

### Dashboard Login or API Fails
- Confirm `DASHBOARD_PASSWORD` is set and matches the bearer token used by the browser/API client.
- Confirm `WEB_DASHBOARD_PORT` is open and not already in use.
- Confirm `MONGODB_URI` is reachable from the host running the dashboard.

### Permission Errors
- Check that the bot role is above roles it needs to manage.
- Verify channel-level permissions in the target channel.
- Ensure required privileged intents are enabled in the Discord Developer Portal.

### High Memory Usage
- Check `/status` for memory metrics.
- Restart the bot if heap usage is consistently high.
- Reduce `DEFAULT_PER_CHANNEL_LIMIT` for large export operations.
