const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');
const os = require('os');

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

module.exports = {
  data: createCommandBuilder({
    name: 'status',
    description: 'Show detailed bot health, uptime, and statistics (admin only)',
  }),
  cooldown: 3,
  async execute(interaction) {
    const ownerId = process.env.BOT_OWNER_ID || '';
    const requiredRole = interaction.client.config?.commandRoleId || process.env.COMMAND_ROLE_ID || '';
    const isOwner = ownerId && interaction.user.id === ownerId;
    const isAdmin = interaction.member.permissions?.has?.(PermissionFlagsBits.Administrator) || false;
    const hasRole = requiredRole ? (interaction.member?.roles?.cache?.has(requiredRole)) : false;

    if (!isOwner && !isAdmin && !hasRole) {
      return interaction.reply({ content: '🔒 You are not authorized to view bot status.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const client = interaction.client;
    const mem = process.memoryUsage();
    const stats = client.stats;

    // Calculate uptime
    const botUptime = Date.now() - stats.startTime;
    const processUptime = process.uptime() * 1000;

    // Top 5 most used commands
    const topCommands = Object.entries(stats.commandUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `\`/${name}\`: ${count}`)
      .join('\n') || 'No commands executed yet';

    const embed = createEmbed({
      title: '📊 Bot Status & Statistics',
      color: EMBED_COLORS.info,
    });

    // System info
    embed.addFields({
      name: '💻 System Information',
      value: [
        `**OS:** ${process.platform} ${os.release()}`,
        `**Node.js:** ${process.version}`,
        `**discord.js:** v${require('discord.js').version}`,
        `**CPU Cores:** ${os.cpus().length}`,
        `**Architecture:** ${os.arch()}`
      ].join('\n'),
      inline: false
    });

    // Memory usage
    const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
    const rss = Math.round(mem.rss / 1024 / 1024);
    const heapPercent = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1);

    embed.addFields({
      name: '🧠 Memory Usage',
      value: [
        `**Heap:** ${heapUsed}MB / ${heapTotal}MB (${heapPercent}%)`,
        `**RSS:** ${rss}MB`,
        `**External:** ${Math.round(mem.external / 1024 / 1024)}MB`
      ].join('\n'),
      inline: true
    });

    // Uptime
    embed.addFields({
      name: '⏱️ Uptime',
      value: [
        `**Bot:** ${formatUptime(botUptime)}`,
        `**Process:** ${formatUptime(processUptime)}`,
        `**Started:** <t:${Math.floor(stats.startTime / 1000)}:R>`
      ].join('\n'),
      inline: true
    });

    // Bot statistics
    const avgLatency = client.ws.ping > 0 ? Math.round(client.ws.ping) : 'N/A';
    const errorRate = stats.commandsExecuted > 0
      ? ((stats.errors / stats.commandsExecuted) * 100).toFixed(2)
      : '0.00';

    embed.addFields({
      name: '📈 Bot Statistics',
      value: [
        `**Guilds:** ${client.guilds.cache.size}`,
        `**Cached Users:** ${client.users.cache.size}`,
        `**Commands Loaded:** ${client.commands.size}`,
        `**Commands Executed:** ${stats.commandsExecuted}`,
        `**Errors:** ${stats.errors} (${errorRate}%)`,
        `**WebSocket Ping:** ${avgLatency}ms`
      ].join('\n'),
      inline: false
    });

    // Top commands
    embed.addFields({
      name: '🏆 Most Used Commands',
      value: topCommands,
      inline: false
    });

    // Health indicator
    let healthStatus = '🟢 Healthy';
    if (avgLatency > 200) healthStatus = '🟡 Moderate Latency';
    if (avgLatency > 500 || heapPercent > 90) healthStatus = '🔴 Performance Issues';

    embed.addFields({
      name: '💚 Health Status',
      value: healthStatus,
      inline: false
    });

    await interaction.editReply({ embeds: [embed] });
  }
};
