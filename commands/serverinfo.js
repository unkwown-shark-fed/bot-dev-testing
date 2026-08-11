const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

module.exports = {
  data: createCommandBuilder({
    name: 'serverinfo',
    description: 'Display detailed information about this server',
  }),
  cooldown: 5,
  async execute(interaction) {
    const guild = interaction.guild;
    const owner = await guild.fetchOwner();

    const createdTimestamp = Math.floor(guild.createdTimestamp / 1000);

    // Count channels by type
    const textChannels = guild.channels.cache.filter(c => c.type === 0).size;
    const voiceChannels = guild.channels.cache.filter(c => c.type === 2).size;
    const categories = guild.channels.cache.filter(c => c.type === 4).size;

    // Count bots
    const bots = guild.members.cache.filter(m => m.user.bot).size;
    const humans = guild.memberCount - bots;

    const embed = createEmbed({
      title: `📊 ${guild.name}`,
      thumbnail: guild.iconURL({ size: 256 }),
      color: EMBED_COLORS.primary,
    })
      .addFields(
        { name: '🆔 Server ID', value: `\`${guild.id}\``, inline: true },
        { name: '👑 Owner', value: `${owner.user.tag}`, inline: true },
        { name: '📅 Created', value: `<t:${createdTimestamp}:F>\n<t:${createdTimestamp}:R>`, inline: false },
        { name: '👥 Members', value: `**Total:** ${guild.memberCount}\n**Humans:** ${humans}\n**Bots:** ${bots}`, inline: true },
        { name: '📺 Channels', value: `**Total:** ${guild.channels.cache.size}\n**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}`, inline: true },
        { name: '🎭 Roles', value: `${guild.roles.cache.size}`, inline: true },
        { name: '😊 Emojis', value: `${guild.emojis.cache.size}`, inline: true },
        { name: '💎 Boost Tier', value: `Level ${guild.premiumTier}\n${guild.premiumSubscriptionCount || 0} boosts`, inline: true },
        { name: '🔒 Verification', value: guild.verificationLevel.toString(), inline: true }
      )
      .setTimestamp();

    if (guild.description) {
      embed.setDescription(guild.description);
    }

    if (guild.banner) {
      embed.setImage(guild.bannerURL({ size: 1024 }));
    }

    await interaction.reply({ embeds: [embed] });
  }
};
