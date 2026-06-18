# Changelog

All notable project changes should be recorded here.

## Unreleased

### Documentation

- Refreshed all Markdown documentation for the current Discord.js v14 bot, dashboard, MongoDB command
  mode, command inventory, and NPM scripts.
- Corrected the builder playbook so it only lists helper APIs that currently exist in `utils/builders.js`.
- Added direct guidance for using native Discord.js builders for buttons, action rows, select menus, and modals.
- Updated the architecture notes with the current command-loading behavior, DB-only mode, dashboard API
  groups, and maintenance risks.

## 2.0.0

### Added

- Discord.js v14 slash-command utility bot with file-based command modules.
- Dashboard command storage backed by MongoDB.
- Optional DB-only command mode using `DB_ONLY_COMMANDS=true`.
- Optional dashboard command file mirroring with `WRITE_COMMAND_FILES=true`.
- Premium dashboard server with bot process controls, logs, settings, command upload, flow generation,
  sync, and embed sending.
- Export commands for channel messages, selected messages, invite keyword posters, forum posts, and reaction counts.
- Moderation and operations commands including cleanup, repost, role management, member/user/server info,
  quotes, schedules, and BGMI match generation.
- Shared command loader and small builder helper module.
- Basic quality check/fix scripts for JavaScript, JSON, and Markdown files.
