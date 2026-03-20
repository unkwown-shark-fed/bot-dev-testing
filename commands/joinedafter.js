const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

function parseDateInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let year;
  let month;
  let day;
  let normalized;

  // Support both YYYY-MM-DD and DD-MM-YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    [year, month, day] = raw.split('-').map(Number);
    normalized = raw;
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    [day, month, year] = raw.split('-').map(Number);
    normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  // Validate calendar correctness (e.g. reject 2026-02-31)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { raw, normalized, date };
}

module.exports = {
  data: createCommandBuilder({
    name: 'joinedafter',
    description: 'Count members who joined after a date (supports YYYY-MM-DD or DD-MM-YYYY)',
    configure: builder => builder
      .addStringOption(option => option
        .setName('date')
        .setDescription('Date (UTC): YYYY-MM-DD or DD-MM-YYYY, e.g. 2025-01-01')
        .setRequired(true)),
  }).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  cooldown: 5,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const dateInput = interaction.options.getString('date', true);
    const parsed = parseDateInput(dateInput);
    if (!parsed) {
      return interaction.editReply('❌ Invalid date format. Use **YYYY-MM-DD** or **DD-MM-YYYY** (example: `2025-01-01` or `01-01-2025`).');
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
        `📅 **Date (UTC):** ${parsed.normalized}`,
        `👥 **Members joined after this date:** ${joinedCount.toLocaleString()}`,
        `📊 **Total server members:** ${totalMembers.toLocaleString()}`,
      ].join('\n'));
    } catch (error) {
      return interaction.editReply(`❌ Failed to count joined members: ${error.message}`);
    }
  },
};
