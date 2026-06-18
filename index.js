const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();
const path = require('path');
const logger = require('./logger');
const config = require('./config.json');
const db = require('./db');
const { createDashboardLogger } = require('./bot/dashboard-log');
const { applyPresence, watchPresenceUpdates } = require('./bot/presence');
const { loadModuleFromString } = require('./dashboard/services/code-loader');
const { loadCommandModules } = require('./utils/command-loader');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  logger.error('DISCORD_TOKEN missing in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

client.config    = config;
client.commands  = new Collection();
client.cooldowns = new Collection();

client.stats = {
  commandsExecuted: 0,
  errors:           0,
  startTime:        Date.now(),
  commandUsage:     {}
};

// ── Dashboard log helper ──────────────────────────────────────────────────────
// Sends a log entry to the dashboard which forwards it to your configured
// log channel as a Discord embed. Non-fatal — never crashes the bot.
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const DASHBOARD_PASS = process.env.DASHBOARD_PASSWORD || '';
const PRESENCE_UPDATE_FILE = path.join(__dirname, '.presence_update.json');
const logCommandUse = createDashboardLogger({
  dashboardUrl: DASHBOARD_URL,
  dashboardPassword: DASHBOARD_PASS,
  logger,
});

// ── Command source mode ────────────────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
const dbOnlyMode = String(process.env.DB_ONLY_COMMANDS || '').toLowerCase() === 'true';

let fileCommands = [];
let fileSkipped = [];

if (!dbOnlyMode) {
  const fileResult = loadCommandModules({
    commandsPath,
    clearCache: false,
    requireExecute: true,
  });
  fileCommands = fileResult.loaded;
  fileSkipped = fileResult.skipped;

  for (const { command } of fileCommands) {
    client.commands.set(command.data.name, command);
    client.stats.commandUsage[command.data.name] = 0;
  }

  for (const skipped of fileSkipped) {
    logger.warn(`Command file ${skipped.file} skipped: ${skipped.reason}`);
  }

  logger.info(`📁 Loaded ${fileCommands.length} file-based commands`);
} else {
  logger.info('🧠 DB_ONLY_COMMANDS=true — skipping /commands folder and loading only MongoDB dashboard commands');
}

// ── Load dashboard commands from MongoDB ─────────────────────────────────────
let dbCommandsReady = false;

const dbLoadPromise = (async () => {
  try {
    await db.connect();
    const dbCmds = await db.getAllCommands();
    let dbCount = 0;

    for (const record of dbCmds) {
      if (record.source !== 'dashboard' || !record.code) continue;

      try {
        const cmd = loadModuleFromString(record.code, {
          commandDir: commandsPath,
          filename: `${record.name}.js`,
        });

        if (cmd?.data?.name && typeof cmd.execute === 'function') {
          if (client.commands.has(cmd.data.name)) {
            logger.warn(`DB command ${cmd.data.name} overrides existing file command with the same name`);
          }
          client.commands.set(cmd.data.name, cmd);
          client.stats.commandUsage[cmd.data.name] = 0;
          dbCount++;
        }
      } catch (e) {
        logger.warn(`Failed to load DB command ${record.name}: ${e.message}`);
      }
    }

    logger.info(`📦 Loaded ${dbCount} dashboard commands from MongoDB`);
    dbCommandsReady = true;
    return dbCount;
  } catch (e) {
    logger.error(`MongoDB load failed: ${e.message} — continuing with ${dbOnlyMode ? 'no' : 'file'} commands only`);
    dbCommandsReady = true;
    return 0;
  }
})();

// ── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  logger.info(`✅ Logged in as ${client.user.tag}`);
  logger.info(`🌐 Serving ${client.guilds.cache.size} guild(s)`);

  await dbLoadPromise;

  const totalLoaded = client.commands.size;
  logger.info(`📊 Total commands ready: ${totalLoaded} — ${Array.from(client.commands.keys()).join(', ')}`);

  // Apply saved presence from config.json on startup
  try {
    const status = config.status || 'online';
    const acttype = config.acttype || 'Listening';
    const acttext = config.acttext || '';
    applyPresence(client, { status, acttype, acttext });
    logger.info(`🟢 Presence set: ${status} / ${acttype} ${acttext}`);
  } catch (e) {
    logger.warn(`Failed to set initial presence: ${e.message}`);
  }

  // ── Presence watcher ────────────────────────────────────────────────────────
  // When you save Presence settings in the dashboard, it writes a
  // .presence_update.json file. This watcher picks it up and applies it live
  // without needing a bot restart.
  watchPresenceUpdates({
    client,
    filePath: PRESENCE_UPDATE_FILE,
    logger,
  }); // checks every 15 seconds
});

// ── Interaction handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!dbCommandsReady) {
    await dbLoadPromise;
  }

  // Guild restriction
  const hasGuildRestrictions = Array.isArray(config.allowedGuilds) && config.allowedGuilds.length > 0;
  if (hasGuildRestrictions && !config.allowedGuilds.includes(interaction.guildId)) {
    return interaction.reply({ content: '⛔ This bot is restricted to specific guilds.', ephemeral: true });
  }

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command attempted: ${interaction.commandName}`);
    return interaction.reply({ content: '❌ Command not found.', ephemeral: true });
  }

  // Cooldown system
  if (command.cooldown) {
    const { cooldowns } = client;
    if (!cooldowns.has(command.data.name)) {
      cooldowns.set(command.data.name, new Collection());
    }

    const now            = Date.now();
    const timestamps     = cooldowns.get(command.data.name);
    const cooldownAmount = (command.cooldown || 3) * 1000;

    if (timestamps.has(interaction.user.id)) {
      const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
      if (now < expirationTime) {
        const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
        return interaction.reply({
          content: `⏱️ Please wait ${timeLeft}s before using \`/${command.data.name}\` again.`,
          ephemeral: true
        });
      }
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
  }

  // Role-based authorization
  const requiredRoleId = config.commandRoleId || process.env.COMMAND_ROLE_ID || '';
  if (requiredRoleId) {
    try {
      const member = interaction.member;
      const isAdmin = member.permissions?.has?.(PermissionFlagsBits.Administrator);
      const hasRole = member.roles?.cache?.has?.(requiredRoleId);
      if (!isAdmin && !hasRole) {
        logger.warn(`Unauthorized access attempt by ${interaction.user.tag} for /${interaction.commandName}`);
        return interaction.reply({
          content: '🔒 You are not authorized to run this command (missing required role).',
          ephemeral: true
        });
      }
    } catch (err) {
      logger.warn(`Authorization check failed for ${interaction.user.tag}: ${err.message}`);
      return interaction.reply({ content: '⚠️ Unable to verify your roles. Try again later.', ephemeral: true });
    }
  }

  // Execute command
  try {
    await command.execute(interaction, client, logger);

    client.stats.commandsExecuted++;
    client.stats.commandUsage[command.data.name] = (client.stats.commandUsage[command.data.name] || 0) + 1;
    db.incrementUsage(interaction.commandName).catch(() => {});

    logger.info(`✅ ${interaction.user.tag} used /${interaction.commandName} in ${interaction.guild?.name || 'DM'}`);

    // ✅ Log successful command use to dashboard → log channel
    logCommandUse({
      command: interaction.commandName,
      user:    interaction.user.tag,
      guild:   interaction.guild?.name || 'DM',
      channel: interaction.channel?.name || '?',
    });

  } catch (err) {
    client.stats.errors++;
    db.incrementError(interaction.commandName).catch(() => {});
    logger.error(`❌ Error executing /${interaction.commandName} by ${interaction.user.tag}: ${err.stack || err}`);

    // ❌ Log failed command to dashboard → error channel
    logCommandUse({
      command: interaction.commandName,
      user:    interaction.user.tag,
      guild:   interaction.guild?.name || 'DM',
      channel: interaction.channel?.name || '?',
      error:   err.message,
    });

    const errorMsg = '⚠️ There was an error while executing this command.';
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: errorMsg });
      } else if (interaction.replied) {
        await interaction.followUp({ content: errorMsg, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMsg, ephemeral: true });
      }
    } catch (sendErr) {
      logger.warn(`Failed to send error response: ${sendErr?.message || sendErr}`);
    }
  }
});

// ── Button & Modal handler (createpost bulk sessions) ────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  const cmd = client.commands.get('createpost');
  if (cmd?.handleComponent) {
    try {
      await cmd.handleComponent(interaction, client, logger);
    } catch (err) {
      logger.error(`createpost handleComponent error: ${err.message}`);
    }
  }
});

// ── Guild join/leave logging ──────────────────────────────────────────────────
client.on('guildCreate', guild => {
  logger.info(`✨ Joined new guild: ${guild.name} (${guild.id}) - ${guild.memberCount} members`);
});

client.on('guildDelete', guild => {
  logger.info(`👋 Left guild: ${guild.name} (${guild.id})`);
});

// ── Process-level error handlers ─────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  logger.error(`UnhandledRejection: ${err}`);
});

process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(token).catch(err => {
  logger.error(`Failed to login: ${err}`);
  process.exit(1);
});
