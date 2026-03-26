const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

module.exports = {
  data: createCommandBuilder({
    name: 'userinfo',
    description: 'Display detailed information about a user',
    configure: builder => builder.addUserOption(o => o.setName('user').setDescription('User to get info about (defaults to you)').setRequired(false)),
  }),
  cooldown: 5,
  async execute(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const member = interaction.guild ? await interaction.guild.members.fetch(user.id).catch(() => null) : null;

    const embed = createEmbed({
      title: `User Information: ${user.tag}`,
      thumbnail: user.displayAvatarURL({ size: 256 }),
      color: member?.displayHexColor || EMBED_COLORS.primary,
    });

    // Basic info
    embed.addFields(
      { name: '👤 Username', value: user.tag, inline: true },
      { name: '🆔 User ID', value: `\`${user.id}\``, inline: true },
      { name: '🤖 Bot', value: user.bot ? 'Yes' : 'No', inline: true }
    );

    // Account creation
    const createdTimestamp = Math.floor(user.createdTimestamp / 1000);
    embed.addFields({
      name: '📅 Account Created',
      value: `<t:${createdTimestamp}:F> (<t:${createdTimestamp}:R>)`,
      inline: false
    });

    // Server-specific info
    if (member) {
      const joinedTimestamp = Math.floor(member.joinedTimestamp / 1000);
      embed.addFields({
        name: '📥 Joined Server',
        value: `<t:${joinedTimestamp}:F> (<t:${joinedTimestamp}:R>)`,
        inline: false
      });

      // Roles
      const roles = member.roles.cache
        .filter(r => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => r.toString())
        .slice(0, 10);

      if (roles.length > 0) {
        embed.addFields({
          name: `🎭 Roles [${member.roles.cache.size - 1}]`,
          value: roles.join(', ') + (member.roles.cache.size > 11 ? '...' : ''),
          inline: false
        });
      }

      // Permissions
      if (member.permissions.has('Administrator')) {
        embed.addFields({ name: '⚡ Key Permissions', value: '`Administrator`', inline: false });
      } else {
        const keyPerms = [];
        if (member.permissions.has('ManageGuild')) keyPerms.push('Manage Server');
        if (member.permissions.has('ManageRoles')) keyPerms.push('Manage Roles');
        if (member.permissions.has('ManageChannels')) keyPerms.push('Manage Channels');
        if (member.permissions.has('KickMembers')) keyPerms.push('Kick Members');
        if (member.permissions.has('BanMembers')) keyPerms.push('Ban Members');
        if (member.permissions.has('ManageMessages')) keyPerms.push('Manage Messages');

        if (keyPerms.length > 0) {
          embed.addFields({ name: '⚡ Key Permissions', value: keyPerms.map(p => `\`${p}\``).join(', '), inline: false });
        }
      }

      // Boost status
      if (member.premiumSince) {
        const boostTimestamp = Math.floor(member.premiumSinceTimestamp / 1000);
        embed.addFields({
          name: '💎 Boosting Since',
          value: `<t:${boostTimestamp}:F> (<t:${boostTimestamp}:R>)`,
          inline: false
        });
      }
    }

    // Avatar
    embed.setImage(user.displayAvatarURL({ size: 512 }));

    await interaction.reply({ embeds: [embed] });
  }
};
