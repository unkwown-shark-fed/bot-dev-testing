const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

module.exports = {
  category: 'Utility',
  data: createCommandBuilder({
    name: 'help',
    description: 'Show all available commands and their descriptions',
  }),
  cooldown: 5,
  async execute(interaction) {
    const commands = interaction.client.commands;

    // Category display order + emoji. Any command whose `category` isn't
    // listed here (or has no `category` at all) falls into "Other" below,
    // so /help can never silently drop a command the way a hardcoded
    // name list could.
    const CATEGORY_EMOJI = {
      Utility: '📊',
      Export: '📤',
      Moderation: '⚙️',
      Search: '🔍',
      Content: '📝',
      Gaming: '🎮',
      Other: '📦',
    };
    const CATEGORY_ORDER = ['Utility', 'Export', 'Moderation', 'Search', 'Content', 'Gaming', 'Other'];

    const grouped = new Map();
    for (const [name, cmd] of commands) {
      const category = cmd.category || 'Other';
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(`\`/${name}\` - ${cmd.data.description}`);
    }

    const embed = createEmbed({
      title: '📚 Bot Commands',
      color: EMBED_COLORS.primary,
      description: 'Here are all available commands:',
      footer: { text: `Total: ${commands.size} commands` },
    });

    const orderedCategories = [
      ...CATEGORY_ORDER.filter(c => grouped.has(c)),
      ...[...grouped.keys()].filter(c => !CATEGORY_ORDER.includes(c)),
    ];

    for (const category of orderedCategories) {
      const emoji = CATEGORY_EMOJI[category] || '📦';
      embed.addFields({
        name: `${emoji} ${category}`,
        value: grouped.get(category).sort().join('\n'),
        inline: false
      });
    }

    embed.addFields({
      name: '💡 Tips',
      value: '• Most commands have additional options - explore them!\n• Use `/status` to see bot statistics\n• Exports are sent to your DMs when possible',
      inline: false
    });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
