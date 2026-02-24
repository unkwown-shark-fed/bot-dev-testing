const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency and API ping'),
  cooldown: 3,
  async execute(interaction) {
    const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiPing = Math.round(interaction.client.ws.ping);
    
    let latencyEmoji = '🟢';
    if (latency > 200) latencyEmoji = '🟡';
    if (latency > 500) latencyEmoji = '🔴';
    
    await interaction.editReply(`🏓 Pong!\n${latencyEmoji} **Latency:** ${latency}ms\n📡 **API Ping:** ${apiPing}ms`);
  }
};
