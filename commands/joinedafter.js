const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

function parseIsoDateInput(input) {
  const raw = String(input || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  // Validate calendar correctness (e.g. reject 2026-02-31)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { raw, date };
}

module.exports = {
  data: createCommandBuilder({
    name: 'joinedafter',
    description: 'Count members who joined the server after a given date (YYYY-MM-DD)',
    configure: builder => builder
      .addStringOption(option => option
        .setName('date')
        .setDescription('Date in YYYY-MM-DD format (UTC), e.g. 2026-01-01')
        .setRequired(true)),
  }).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  cooldown: 5,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const dateInput = interaction.options.getString('date', true);
    const parsed = parseIsoDateInput(dateInput);
    if (!parsed) {
      return interaction.editReply('❌ Invalid date format. Use **YYYY-MM-DD** (example: `2026-01-01`).');
    }

    const threshold = parsed.date;
    const thresholdTs = threshold.getTime();

    try {
      // Ensure cache is up to date for counting
      await interaction.guild.members.fetch();

      const joinedAfterMembers = interaction.guild.members.cache.filter(member => {
        if (!member.joinedTimestamp) return false;
        return member.joinedTimestamp > thresholdTs;
      });

      const totalMembers = interaction.guild.memberCount || interaction.guild.members.cache.size;
      const joinedCount = joinedAfterMembers.size;

      return interaction.editReply([
        `📅 **Date (UTC):** ${parsed.raw}`,
        `👥 **Members joined after this date:** ${joinedCount}`,
        `📊 **Total server members:** ${totalMembers}`,
      ].join('\n'));
    } catch (error) {
      return interaction.editReply(`❌ Failed to count joined members: ${error.message}`);
    }
  },
};
