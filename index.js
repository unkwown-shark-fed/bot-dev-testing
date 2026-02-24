const { Client, GatewayIntentBits, Partials, Collection, PermissionFlagsBits, ActivityType } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const config = require('./config.json');

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

client.config = config;
client.commands = new Collection();
client.cooldowns = new Collection(); // NEW: Track command cooldowns per user

// NEW: Command usage statistics
client.stats = {
  commandsExecuted: 0,
  errors: 0,
  startTime: Date.now(),
  commandUsage: {}
};

// Load all commands from /commands folder
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) fs.mkdirSync(commandsPath, { recursive: true });

let loadedCount = 0;
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  try {
    const cmd = require(path.join(commandsPath, file));
    if (cmd?.data?.name && typeof cmd.execute === 'function') {
      client.commands.set(cmd.data.name, cmd);
      client.stats.commandUsage[cmd.data.name] = 0; // Initialize usage counter
      loadedCount++;
    } else {
      logger.warn(`Command file ${file} is missing data.name or execute`);
    }
  } catch (err) {
    logger.error(`Failed to load command ${file}: ${err.stack || err}`);
  }
}

// NEW: Set bot status with command count
client.once('ready', async () => {
  logger.info(`✅ Logged in as ${client.user.tag}`);
  logger.info(`📊 Loaded ${loadedCount} commands: ${Array.from(client.commands.keys()).join(', ')}`);
  logger.info(`🌐 Serving ${client.guilds.cache.size} guild(s)`);
  
  // Set dynamic status
  client.user.setActivity(`${loadedCount} commands | /help`, { type: ActivityType.Watching });
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Guild restriction
  if (Array.isArray(config.allowedGuilds) && config.allowedGuilds.length > 0 && !config.allowedGuilds.includes(interaction.guildId)) {
    return interaction.reply({ content: '⛔ This bot is restricted to specific guilds.', ephemeral: true });
  }

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command attempted: ${interaction.commandName}`);
    return interaction.reply({ content: '❌ Command not found.', ephemeral: true });
  }

  // NEW: Cooldown system
  if (command.cooldown) {
    const { cooldowns } = client;
    if (!cooldowns.has(command.data.name)) {
      cooldowns.set(command.data.name, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(command.data.name);
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

  // Execute command with enhanced error handling
  try {
    await command.execute(interaction, client, logger);
    
    // NEW: Track successful execution
    client.stats.commandsExecuted++;
    client.stats.commandUsage[command.data.name]++;
    
    logger.info(`✅ ${interaction.user.tag} used /${interaction.commandName} in ${interaction.guild?.name || 'DM'}`);
  } catch (err) {
    client.stats.errors++;
    logger.error(`❌ Error executing /${interaction.commandName} by ${interaction.user.tag}: ${err.stack || err}`);
    
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

// NEW: Log when bot joins/leaves guilds
client.on('guildCreate', guild => {
  logger.info(`✨ Joined new guild: ${guild.name} (${guild.id}) - ${guild.memberCount} members`);
});

client.on('guildDelete', guild => {
  logger.info(`👋 Left guild: ${guild.name} (${guild.id})`);
});

process.on('unhandledRejection', (err) => {
  logger.error(`UnhandledRejection: ${err}`);
});

process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

client.login(token).catch(err => {
  logger.error(`Failed to login: ${err}`);
  process.exit(1);
});
