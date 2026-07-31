# 🤖 Discord Utility Bot v2.0 - Enhanced Edition

> Documentation refresh: command, dashboard, and quality-check details are current as of 2026-07-30.

A powerful, feature-rich Discord bot with export capabilities, moderation tools, and user management.

## ✨ What's New in v2.0

### 🎯 Core Improvements
- **Enhanced Error Handling** - Better error messages and graceful failure recovery
- **Cooldown System** - Prevents command spam with per-user cooldowns
- **Command Statistics** - Track usage, errors, and performance metrics
- **Dynamic Bot Status** - Shows command count and responds to activity
- **Log Rotation** - Automatic log file rotation to prevent disk space issues
- **Colored Console Output** - Easy-to-read console logs with color coding

### 🆕 New Commands
- **`/help`** - Comprehensive command help with categories
- **`/userinfo`** - Detailed user information with roles, permissions, and join dates
- **`/cleanup`** - Bulk delete messages with user and bot filters

### 📊 Enhanced Commands
- **`/status`** - Now shows detailed statistics:
  - Command usage statistics
  - Memory usage and health indicators
  - Uptime tracking
  - Top 5 most-used commands
  - Error rates and performance metrics
- **`/ping`** - Visual latency indicators with emojis
- **`/serverinfo`** - More detailed server information including boost status

---

## 🚀 Quick Setup

```bash
# 1. Copy .env.example to .env
cp .env.example .env

# 2. Edit .env and fill in your credentials
# Required: DISCORD_TOKEN, CLIENT_ID, GUILD_IDS

# 3. Install dependencies
npm install

# 4. Register slash commands
npm run deploy

# 5. Start the bot
npm start
```

---

## 📋 Complete Command List

### 📊 Utility Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `/ping` | Check bot latency and API ping | 3s |
| `/help` | Show all available commands and descriptions | 5s |
| `/serverinfo` | Display detailed server information | 5s |
| `/userinfo [user]` | Display detailed user information | 5s |
| `/status` | Bot health, uptime, and statistics (admin only) | 3s |
| `/createinvite` | Create an invite link for a specific channel | 10s |

### 📤 Export Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `/export` | Export channel messages or a message range to CSV | 30s |
| `/exportmessages` | Export specific messages by link/ID to CSV | 10s |
| `/exportinvites` | Export users who posted a keyword to CSV | 15s |
| `/exportforumposts` | Export messages from every post in a forum channel to CSV | 30s |
| `/fetchreactions` | Export messages with thumbs-up/thumbs-down reaction counts | 15s |

### ⚙️ Moderation and Posting Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `/cleanup` | Bulk delete messages (1-100) with filters | 10s |
| `/repost` | Repost messages from one channel to another | 10s |
| `/rolemanage add/remove` | Bulk add/remove roles from users | 15s |
| `/createpost` | Create one post or open a bulk posting session | 10s |
| `/quote` | Quote one or more Discord messages by link | 10s |

### 🔍 Search and Member Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `/findids` | Find user IDs by searching usernames | 10s |
| `/listusers` | Paginated list of members with a role | N/A |
| `/reactafter` | React to messages after a starting message link | 10s |
| `/joinedafter` | Count members who joined after a date | 10s |
| `/membertrend` | Show daily member-count snapshots for a date range | 10s |

### 🎮 Gaming Commands
| Command | Description | Cooldown |
|---------|-------------|----------|
| `/generate` | Post Community Custom Matches schedule with optional buttons | 10s |
| `/generate_v2` | Post code-configured Community Custom Matches schedule | 10s |

---

## ⚙️ Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Application client ID |
| `GUILD_IDS` | Comma-separated guild IDs for command registration |

### Optional - Authorization
| Variable | Description | Default |
|----------|-------------|---------|
| `COMMAND_ROLE_ID` | Role ID required to use commands | None (everyone) |
| `BOT_OWNER_ID` | Your user ID for special access | None |

### Optional - Features
| Variable | Description | Default |
|----------|-------------|---------|
| `ROLE_ID` | Role to ping in /generate | 1204073198837309491 |
| `OUTPUT_DIR` | Export files directory | ./exports |
| `DEFAULT_PER_CHANNEL_LIMIT` | Max messages per export | 0 (unlimited) |
| `REPOST_MAX_SEND` | Max messages /repost can send | 200 |
| `DB_ONLY_COMMANDS` | If `true`, bot and deploy scripts load commands only from MongoDB dashboard records | false |
| `WRITE_COMMAND_FILES` | If `true`, dashboard writes uploaded/generated commands into `/commands` files | false |

### ✅ Dashboard-only command mode (no `/commands` folder required)
If you want to eliminate local command files and manage everything from the dashboard:

1. Set `DB_ONLY_COMMANDS=true` in `.env`.
2. Keep `WRITE_COMMAND_FILES=false` (or unset it) so dashboard uploads are stored only in MongoDB.
3. Upload commands from the dashboard (`/api/commands/upload`).
4. Run `npm run deploy` to register all DB commands to Discord.

Notes:
- The bot can now run fully from MongoDB command records.
- `npm run deploy` will also fall back to MongoDB commands automatically if no file-based commands are found.

### Optional - Logging
| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_FILE` | Main log file path | logs/bot.log |
| `ERROR_LOG_FILE` | Error log file path | logs/error.log |
| `LOG_LEVEL` | Logging level (error/warn/info/debug) | info |
| `DASHBOARD_PASSWORD` | Auth token/password required by premium dashboard API | Required for dashboard |

---


## 🔧 NPM Scripts

```bash
npm start          # Start the bot
npm run deploy     # Deploy slash commands
npm run dev        # Start in development mode
npm run logs       # Tail main log file
npm run errors     # Tail error log file
npm run dashboard  # Start the premium dashboard
npm run quality:check # Run repository code-quality checks
npm run quality:fix   # Auto-fix supported code-quality issues
```

---

## 🛡️ Required Bot Permissions

When inviting your bot, ensure it has these permissions:

**Essential Permissions:**
- View Channels
- Read Message History
- Send Messages
- Attach Files
- Use External Emojis
- Embed Links

**For Moderation Commands:**
- Manage Messages (`/cleanup`)
- Manage Roles (`/rolemanage`)
- Manage Events (optional)

**Privileged Intents Required:**
- Server Members Intent (for `/findids`, `/listusers`)
- Message Content Intent (for exports, reposting, quoting, and reaction utilities)

---

## 📊 Feature Highlights

### 🎯 Smart Cooldown System
Prevents command spam with per-user cooldowns. Administrators bypass cooldowns automatically.

### 📈 Usage Statistics
Track command usage, error rates, and bot performance in real-time with `/status`.

### 🗂️ Advanced Exports
- Export to Excel-safe CSV format
- Support for message ranges
- Keyword-based user extraction
- Automatic DM delivery with fallbacks

### 🧹 Intelligent Cleanup
- Filter by user or bot messages
- Handles messages older than 14 days
- Bulk delete with rate limit protection

### 📝 Comprehensive Logging
- Colored console output
- Separate error logs
- Automatic log rotation (5MB max per file)
- Configurable log levels

---

## 🐛 Troubleshooting

### Commands Not Appearing
```bash
# Re-deploy commands
npm run deploy
```

If you're using MongoDB-only mode (`DB_ONLY_COMMANDS=true`), upload or modify commands from the dashboard.
Then run `npm run deploy` to push DB commands to Discord.

### Permission Errors
- Check bot role position (must be above managed roles)
- Verify bot has required permissions in the channel
- Ensure Privileged Intents are enabled in Developer Portal

### High Memory Usage
- Check `/status` for memory metrics
- Restart bot if heap usage >90%
- Reduce `DEFAULT_PER_CHANNEL_LIMIT` for large exports

### Export Failures
- Verify bot has Read Message History permission
- Check if target channel is accessible
- Ensure OUTPUT_DIR exists and is writable

---

## 📦 File Structure

```
discord-utility-bot/
├── index.js                  # Main bot file with enhanced features
├── deploy-commands.js        # Command registration script
├── logger.js                 # Winston logging configuration
├── config.json              # Runtime configuration
├── package.json             # Dependencies and scripts
├── .env.example             # Environment template
├── commands/                # All command files
│   ├── help.js
│   ├── ping.js
│   ├── status.js
│   ├── userinfo.js
│   ├── cleanup.js
│   └── ... (15 total commands)
├── logs/                    # Log files (auto-created)
│   ├── bot.log
│   └── error.log
└── exports/                 # CSV exports (auto-created)
```

---

## 🔄 Changelog

### v2.0.0 (Current)
- ✨ Added `/help`, `/userinfo`, `/cleanup` commands
- 📊 Enhanced `/status` with detailed statistics
- 🎨 Improved console output with colors
- ⏱️ Added cooldown system
- 📈 Command usage tracking
- 🔄 Log rotation
- 🐛 Better error handling
- 📝 Comprehensive documentation

### v1.0.0
- Initial release with basic commands

---

## 📄 License

MIT License - Feel free to modify and distribute

## 🤝 Support

For issues or feature requests, please check the logs first:
```bash
npm run errors  # Check error logs
npm run logs    # Check main logs
```

---

**Made with ❤️ for Discord community management**

---

## 🖥️ Desktop GUI Control Center

A PC-friendly Electron launcher is included so you can run the bot without typing every command in a terminal.

```bash
# Install app dependencies, including the desktop GUI runtime
npm install

# Open the desktop control center
npm run gui
```

### Windows desktop install

For a PC-style install, use the included Windows launcher scripts:

```bat
install-windows.bat
```

That installs dependencies and creates a **Discord Utility Bot GUI** shortcut on your Desktop.
After that, open the bot with the Desktop shortcut or by double-clicking `run-bot-gui.bat`.
See `DESKTOP_INSTALL.md` for the full step-by-step installation guide.

### If you cannot download the repository

See `DOWNLOAD_HELP.md` for alternate download options, including GitHub ZIP download,
`git clone`, and the GitHub Actions artifact named **discord-utility-bot-desktop-gui**.

From the desktop window you can:

1. Enter and save your Discord token, client ID, guild IDs, MongoDB URI, dashboard password,
   and dashboard port into `.env`.
2. Run `npm install` from inside the GUI if dependencies are missing.
3. Deploy slash commands to Discord.
4. Start or stop the bot process.
5. Start, stop, and open the web dashboard.
6. Watch live install, deploy, bot, and dashboard logs in one place.

To make it feel like a normal installed PC app, create a shortcut that runs `npm run gui`
from this project folder after Node.js is installed.
