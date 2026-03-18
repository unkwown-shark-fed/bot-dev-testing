const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits } = require('discord.js');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const config = require('./config.json');
const db = require('./db');
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
const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
const PRESENCE_UPDATE_FILE = path.join(__dirname, '.presence_update.json');

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function buildPresence({ status, acttype, acttext }) {
  return {
    status: status || 'online',
    activities: acttext ? [{ name: acttext, type: ACTIVITY_TYPES[acttype] ?? 2 }] : [],
  };
}

function applyPresence(clientInstance, settings) {
  clientInstance.user.setPresence(buildPresence(settings));
}

async function logCommandUse({ command, user, guild, channel, args = '', error = null }) {
  if (!DASHBOARD_PASS) return;

  try {
    const response = await fetch(`${DASHBOARD_URL}/api/log`, {
      method:  'POST',
      signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${DASHBOARD_PASS}`,
      },
      body: JSON.stringify({ command, user, guild, channel, args, error }),
    });

    if (!response.ok) {
      logger.warn(`Dashboard log request failed with status ${response.status}`);
    }
  } catch (err) {
    logger.warn(`Dashboard log request failed: ${err.message}`);
  }
}

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
        const Module = require('module');
        const m = new Module('');
        m.filename = path.join(commandsPath, `${record.name}.js`);
        m.paths = Module._nodeModulePaths(commandsPath);
        m._compile(record.code, `${record.name}.js`);
        const cmd = m.exports;

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
  setInterval(() => {
    try {
      if (!fs.existsSync(PRESENCE_UPDATE_FILE)) return;

      const { status, acttype, acttext, ts } = JSON.parse(fs.readFileSync(PRESENCE_UPDATE_FILE, 'utf8'));
      // Only apply if written within the last 60 seconds
      if (typeof ts !== 'number' || Date.now() - ts > 60_000) return;

      applyPresence(client, { status, acttype, acttext });
      logger.info(`[presence] Updated: ${status} / ${acttype} ${acttext}`);
      fs.unlinkSync(PRESENCE_UPDATE_FILE); // delete after applying so it doesn't re-trigger
    } catch (e) {
      logger.warn(`[presence] Failed to apply update: ${e.message}`);
    }
  }, 15_000); // checks every 15 seconds

  // ── Daily member snapshot tracker (UTC) ───────────────────────────────────
  // Stores one memberCount snapshot per guild per day so /membertrend can
  // report historical daily totals.
  async function captureDailyMemberSnapshots() {
    const dateKey = getUtcDateKey(new Date());
    for (const guild of client.guilds.cache.values()) {
      try {
        const memberCount = guild.memberCount || 0;
        await db.upsertMemberSnapshot(guild.id, dateKey, memberCount);
      } catch (e) {
        logger.warn(`[membertrend] Snapshot failed for guild ${guild.id}: ${e.message}`);
      }
    }
    logger.info(`[membertrend] Daily snapshots upserted for ${client.guilds.cache.size} guild(s) on ${dateKey}`);
  }

  // Run once on startup, then hourly. Upsert prevents duplicates for same day.
  await captureDailyMemberSnapshots();
  setInterval(captureDailyMemberSnapshots, 60 * 60 * 1000);
});

// ── Interaction handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!dbCommandsReady) {
    await dbLoadPromise;
  }

  // Guild restriction
  if (Array.isArray(config.allowedGuilds) && config.allowedGuilds.length > 0 && !config.allowedGuilds.includes(interaction.guildId)) {
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
