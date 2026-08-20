const { MessageFlags } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');
const { ComponentType, textDisplay, separator } = require('../utils/componentsV2');
const { isAuthorized } = require('../utils/auth');
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
  category: 'Utility',
  data: createCommandBuilder({
    name: 'status',
    description: 'Show detailed bot health, uptime, and statistics (admin only)',
  }),
  cooldown: 3,
  async execute(interaction) {
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: '🔒 You are not authorized to view bot status.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const client = interaction.client;
    const mem = process.memoryUsage();
    const stats = client.stats;

    // Calculate uptime
    const botUptime = Date.now() - stats.startTime;
    const processUptime = process.uptime() * 1000;

    // Memory usage
    const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotal = Math.round(mem.heapTotal / 1024 / 1024);
    const rss = Math.round(mem.rss / 1024 / 1024);
    const heapPercent = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1);

    // Bot statistics
    const avgLatency = client.ws.ping > 0 ? Math.round(client.ws.ping) : 'N/A';
    const errorRate = stats.commandsExecuted > 0
      ? ((stats.errors / stats.commandsExecuted) * 100).toFixed(2)
      : '0.00';

    // Health indicator
    let healthStatus = '🟢 Healthy';
    if (avgLatency > 200) healthStatus = '🟡 Moderate Latency';
    if (avgLatency > 500 || heapPercent > 90) healthStatus = '🔴 Performance Issues';

    const container = {
      type: ComponentType.Container,
      components: [
        textDisplay('## 📊 Bot Status & Statistics'),
        separator(),

        textDisplay([
          '### 💻 System Information',
          `**OS:** ${process.platform} ${os.release()}`,
          `**Node.js:** ${process.version}`,
          `**discord.js:** v${require('discord.js').version}`,
          `**CPU Cores:** ${os.cpus().length}`,
          `**Architecture:** ${os.arch()}`
        ].join('\n')),
        separator(),

        textDisplay([
          '### 🧠 Memory Usage',
          `**Heap:** ${heapUsed}MB / ${heapTotal}MB (${heapPercent}%)`,
          `**RSS:** ${rss}MB`,
          `**External:** ${Math.round(mem.external / 1024 / 1024)}MB`
        ].join('\n')),
        separator(),

        textDisplay([
          '### ⏱️ Uptime',
          `**Bot:** ${formatUptime(botUptime)}`,
          `**Process:** ${formatUptime(processUptime)}`,
          `**Started:** <t:${Math.floor(stats.startTime / 1000)}:R>`
        ].join('\n')),
        separator(),

        textDisplay([
          '### 📈 Bot Statistics',
          `**Guilds:** ${client.guilds.cache.size}`,
          `**Cached Users:** ${client.users.cache.size}`,
          `**Commands Loaded:** ${client.commands.size}`,
          `**Commands Executed:** ${stats.commandsExecuted}`,
          `**Errors:** ${stats.errors} (${errorRate}%)`,
          `**WebSocket Ping:** ${avgLatency}ms`
        ].join('\n')),
        separator(),

        textDisplay(`### 💚 Health Status\n${healthStatus}`),
        separator(),

        textDisplay(`-# Today at <t:${Math.floor(Date.now() / 1000)}:t>`),
      ],
    };

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  }
};
