const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

module.exports = {
  data: createCommandBuilder({
    name: 'help',
    description: 'Show all available commands and their descriptions',
  }),
  cooldown: 5,
  async execute(interaction) {
    const commands = interaction.client.commands;

    const categories = {
      '📊 Utility': ['ping', 'help', 'serverinfo', 'userinfo', 'status', 'joinedafter'],
      '📤 Export': ['export', 'exportmessages', 'exportinvites', 'fetchreactions'],
      '⚙️ Moderation': ['cleanup', 'repost', 'rolemanage'],
      '🔍 Search': ['findids', 'listusers'],
      '🎮 Gaming': ['schedule', 'generate']
    };

    const embed = createEmbed({
      title: '📚 Bot Commands',
      color: EMBED_COLORS.primary,
      description: 'Here are all available commands:',
      footer: { text: `Total: ${commands.size} commands` },
    });

    for (const [category, cmdNames] of Object.entries(categories)) {
      const categoryCommands = cmdNames
        .map(name => {
          const cmd = commands.get(name);
          if (!cmd) return null;
          return `\`/${name}\` - ${cmd.data.description}`;
        })
        .filter(Boolean);

      if (categoryCommands.length > 0) {
        embed.addFields({
          name: category,
          value: categoryCommands.join('\n'),
          inline: false
        });
      }
    }

    embed.addFields({
      name: '💡 Tips',
      value: '• Most commands have additional options - explore them!\n• Use `/status` to see bot statistics\n• Exports are sent to your DMs when possible',
      inline: false
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
