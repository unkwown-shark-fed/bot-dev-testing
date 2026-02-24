const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('listusers')
    .setDescription('Show a paginated list of server users in a specific role (username and ID).')
    .addRoleOption(o => o.setName('role').setDescription('Role to list members of').setRequired(true)),
  /**
   * @param {import('discord.js').CommandInteraction} interaction
   */
  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    }

    const role = interaction.options.getRole('role');
    if (!role) return interaction.reply({ content: 'Role not found or not provided.', ephemeral: true });

    await interaction.deferReply();

    let membersWithRoleArray;
    let usedCache = false;

    try {
      // Attempt to fetch all guild members (requires Server Members intent)
      const allMembers = await guild.members.fetch();
      membersWithRoleArray = Array.from(allMembers.values()).filter(m => m.roles.cache.has(role.id));
    } catch (err) {
      // Fallback to cached members (may be partial)
      console.warn('guild.members.fetch() failed, falling back to role.members cache:', err);
      usedCache = true;
      const cached = role.members; // Collection of GuildMembers that have this role in cache
      if (!cached || cached.size === 0) {
        return interaction.editReply({
          content:
            'Failed to fetch members. Ensure the bot has the "Server Members Intent" enabled in the Developer Portal and the GuildMembers intent in your client.',
        });
      }
      membersWithRoleArray = Array.from(cached.values());
    }

    // Map to "username#discriminator (id)" and sort alphabetically
    const memberList = membersWithRoleArray
      .map((m) => `${m.user.tag} (\`${m.id}\`)`)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (memberList.length === 0) {
      return interaction.editReply({ content: `No members found with the role ${role.name}.` });
    }

    const pageSize = 10;
    const pages = [];
    for (let i = 0; i < memberList.length; i += pageSize) {
      pages.push(memberList.slice(i, i + pageSize));
    }
    let current = 0;

    const buildEmbed = (pageIndex) => {
      return new EmbedBuilder()
        .setTitle(`${guild.name} — Members with role: ${role.name}`)
        .setDescription(pages[pageIndex].join('\n'))
        .setFooter({
          text: `Page ${pageIndex + 1} / ${pages.length} • ${memberList.length} members${usedCache ? ' (partial - cache used)' : ''}`,
        });
    };

    const prevBtn = new ButtonBuilder().setCustomId('prev').setLabel('Prev').setStyle(ButtonStyle.Primary).setDisabled(true);
    const nextBtn = new ButtonBuilder()
      .setCustomId('next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(pages.length <= 1);
    const closeBtn = new ButtonBuilder().setCustomId('close').setLabel('Close').setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn, closeBtn);

    const reply = await interaction.editReply({ embeds: [buildEmbed(current)], components: [row] });

    const filter = (i) => ['prev', 'next', 'close'].includes(i.customId) && i.user.id === interaction.user.id;
    const collector = reply.createMessageComponentCollector({ filter, time: 120000 });

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'prev') current = Math.max(0, current - 1);
        if (i.customId === 'next') current = Math.min(pages.length - 1, current + 1);
        if (i.customId === 'close') {
          collector.stop('closed');
          await i.update({ content: 'Closed.', embeds: [], components: [] });
          return;
        }

        prevBtn.setDisabled(current === 0);
        nextBtn.setDisabled(current === pages.length - 1);

        await i.update({ embeds: [buildEmbed(current)], components: [row] });
      } catch (err) {
        console.error('Pagination update error:', err);
      }
    });

    collector.on('end', (_, reason) => {
      if (reason !== 'closed') {
        prevBtn.setDisabled(true);
        nextBtn.setDisabled(true);
        closeBtn.setDisabled(true);
        reply.edit({ components: [row] }).catch(() => {});
      }
    });
  },
};