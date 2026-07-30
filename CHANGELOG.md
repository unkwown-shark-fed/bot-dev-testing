# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Refreshed Markdown documentation to match the current command set, dashboard scripts, and quality-check workflow.
- Updated code-analysis notes to reflect the resolved `fs` import issue and current command-loading architecture.

## [2.0.0] - 2026-02-18

### Added
- **NEW COMMANDS**
  - `/help` - Comprehensive help system with categorized commands
  - `/userinfo` - Detailed user information with roles, permissions, and timestamps
  - `/cleanup` - Bulk message deletion with user/bot filters

- **ENHANCED FEATURES**
  - Cooldown system to prevent command spam
  - Command usage statistics tracking
  - Enhanced `/status` with detailed metrics and top command usage
  - Dynamic bot status showing command count
  - Log rotation (5MB max per file, 5 backup files)
  - Colored console output for better readability
  - Separate error log file
  - Graceful shutdown handling (SIGINT)
  - Guild join/leave logging

- **IMPROVED ERROR HANDLING**
  - Better error messages with emojis
  - Fallback mechanisms for file delivery
  - Rate limit protection in cleanup
  - Enhanced permission checking

- **DOCUMENTATION**
  - Comprehensive README with all features
  - Detailed .env.example with comments
  - NPM scripts for common tasks
  - Troubleshooting guide

### Changed
- Enhanced `/ping` with visual latency indicators
- Improved `/serverinfo` with more details (boost status, channel types, member breakdown)
- Better `/status` output with uptime formatting and health indicators
- Updated deploy-commands.js with better error messages
- Enhanced logger with file rotation and separate error logs

### Fixed
- Proper cooldown enforcement
- Memory leak prevention in long-running operations
- Better handling of missing permissions

## [1.0.0] - 2026-02-17

### Added
- Initial release
- Basic commands: ping, serverinfo, export, exportmessages, exportinvites
- Moderation: rolemanage, repost
- Search: findids, listusers
- Gaming: schedule, generate
- Basic logging with Winston
- Environment-based configuration
