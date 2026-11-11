const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const PER_PAGE = 20;
const CHUNK_LIMIT = 1900; // leave room for code block fences (2000 max)
const MAX_CHUNK_MESSAGES = 5; // the .txt file always has everything

// Split a list of strings into code-block-sized chunks
function chunkLines(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_LIMIT) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listusers')
    .setDescription('List members with a role, with copyable user IDs')
    .addRoleOption((o) =>
      o.setName('role').setDescription('Role to list').setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName('include_bots').setDescription('Include bots (default: false)')
    )
    .addBooleanOption((o) =>
      o
        .setName('public')
        .setDescription('Show the result to everyone (default: only you)')
    )
    .setDMPermission(false),

  async execute(interaction) {
    const role = interaction.options.getRole('role');
    const includeBots = interaction.options.getBoolean('include_bots') ?? false;
    const isPublic = interaction.options.getBoolean('public') ?? false;

    await interaction.deferReply({
      flags: isPublic ? undefined : MessageFlags.Ephemeral,
    });

    // Only hit the API if the member cache is incomplete (Server Members Intent required)
    try {
      const { guild } = interaction;
      if (guild.members.cache.size < guild.memberCount) {
        await guild.members.fetch();
      }
    } catch (err) {
      return interaction.editReply(
        'Could not fetch members. Make sure the Server Members Intent is enabled.'
      );
    }

    const fresh = interaction.guild.roles.cache.get(role.id);
    const members = [...(fresh?.members.values() ?? [])]
      .filter((m) => includeBots || !m.user.bot)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    if (members.length === 0) {
      return interaction.editReply(`No members have ${role}.`);
    }

    const ids = members.map((m) => m.id);
    const totalPages = Math.ceil(members.length / PER_PAGE);
    let page = 0;

    const buildEmbed = () => {
      const start = page * PER_PAGE;
      const lines = members
        .slice(start, start + PER_PAGE)
        .map((m, i) => `${start + i + 1}. ${m} - \`${m.id}\``);
      return new EmbedBuilder()
        .setTitle(`Members with ${role.name}`)
        .setColor(role.color || 0x5865f2)
        .setDescription(lines.join('\n'))
        .setFooter({
          text: `Page ${page + 1}/${totalPages} • ${members.length} member(s)`,
        });
    };

    const buildRows = (disabled = false) => {
      const nav = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('lu_prev')
          .setLabel('Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page === 0),
        new ButtonBuilder()
          .setCustomId('lu_next')
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page >= totalPages - 1)
      );
      const copy = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('lu_copy_page')
          .setLabel('Copy IDs (this page)')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
        new ButtonBuilder()
          .setCustomId('lu_copy_all')
          .setLabel(`Copy all IDs (${ids.length})`)
          .setStyle(ButtonStyle.Success)
          .setDisabled(disabled)
      );
      return totalPages > 1 ? [nav, copy] : [copy];
    };

    const message = await interaction.editReply({
      embeds: [buildEmbed()],
      components: buildRows(),
      allowedMentions: { parse: [] }, // never ping when listing
    });

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: 300_000,
    });

    collector.on('collect', async (i) => {
      if (i.customId === 'lu_prev' || i.customId === 'lu_next') {
        page += i.customId === 'lu_next' ? 1 : -1;
        return i.update({ embeds: [buildEmbed()], components: buildRows() });
      }

      // Copy buttons: reply privately with ID(s) in code blocks (tap/click to copy)
      const list =
        i.customId === 'lu_copy_page'
          ? ids.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
          : ids;

      const chunks = chunkLines(list);
      const shown = chunks.slice(0, MAX_CHUNK_MESSAGES);
      const file = new AttachmentBuilder(Buffer.from(list.join('\n'), 'utf8'), {
        name: `${role.name.replace(/[^\w-]+/g, '_')}_ids.txt`,
      });

      await i.reply({
        content:
          `**${list.length} ID(s)**, one per line` +
          (chunks.length > shown.length
            ? ` (showing first ${shown.length} message(s); the file has all of them)`
            : '') +
          `\n\`\`\`\n${shown[0]}\n\`\`\``,
        files: [file],
        flags: MessageFlags.Ephemeral,
      });

      for (const chunk of shown.slice(1)) {
        await i.followUp({
          content: `\`\`\`\n${chunk}\n\`\`\``,
          flags: MessageFlags.Ephemeral,
        });
      }
    });

    collector.on('end', () => {
      interaction.editReply({ components: buildRows(true) }).catch(() => {});
    });
  },
};
