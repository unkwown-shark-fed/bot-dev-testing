const { PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');
const db = require('../db');

function parseDateInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let year;
  let month;
  let day;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    [year, month, day] = raw.split('-').map(Number);
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(raw)) {
    [day, month, year] = raw.split('-').map(Number);
  } else {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, normalized };
}

function toDateKeyUTC(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

module.exports = {
  data: createCommandBuilder({
    name: 'membertrend',
    description: 'Show daily server member-count snapshots for a date range',
    configure: builder => builder
      .addStringOption(option => option
        .setName('from')
        .setDescription('Start date (YYYY-MM-DD or DD-MM-YYYY), e.g. 2025-01-01')
        .setRequired(true))
      .addStringOption(option => option
        .setName('to')
        .setDescription('End date (YYYY-MM-DD or DD-MM-YYYY). Defaults to today (UTC)')
        .setRequired(false)),
  }).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  cooldown: 5,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const fromInput = interaction.options.getString('from', true);
    const toInput = interaction.options.getString('to', false);

    const parsedFrom = parseDateInput(fromInput);
    if (!parsedFrom) {
      return interaction.editReply('❌ Invalid **from** date. Use `YYYY-MM-DD` or `DD-MM-YYYY`.');
    }

    const parsedTo = toInput ? parseDateInput(toInput) : { date: new Date(), normalized: toDateKeyUTC(new Date()) };
    if (!parsedTo) {
      return interaction.editReply('❌ Invalid **to** date. Use `YYYY-MM-DD` or `DD-MM-YYYY`.');
    }

    const fromDateKey = parsedFrom.normalized;
    const toDateKey = parsedTo.normalized;
    if (fromDateKey > toDateKey) {
      return interaction.editReply('❌ `from` must be before or equal to `to`.');
    }

    try {
      const rows = await db.getMemberSnapshots(interaction.guildId, fromDateKey, toDateKey);
      if (!rows.length) {
        return interaction.editReply([
          `📉 No daily member snapshots found for **${fromDateKey} → ${toDateKey}**.`,
          'This command only reports dates that were already tracked by the bot.',
        ].join('\n'));
      }

      const first = rows[0];
      const last = rows[rows.length - 1];
      const delta = last.memberCount - first.memberCount;
      const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`;

      const lines = rows.map(row => `${row.dateKey},${row.memberCount}`);
      const csv = ['date_utc,member_count', ...lines].join('\n');
      const csvFile = new AttachmentBuilder(Buffer.from(csv, 'utf8'), {
        name: `member-trend-${interaction.guildId}-${fromDateKey}-to-${toDateKey}.csv`,
      });

      const previewMax = 15;
      const preview = rows
        .slice(-previewMax)
        .map(row => `• ${row.dateKey}: **${row.memberCount.toLocaleString()}**`)
        .join('\n');

      return interaction.editReply({
        content: [
          `📊 **Daily member trend (${fromDateKey} → ${toDateKey})**`,
          `🧾 **Snapshots found:** ${rows.length.toLocaleString()}`,
          `🔁 **Change in period:** ${deltaStr}`,
          `📌 **First:** ${first.dateKey} (${first.memberCount.toLocaleString()})`,
          `🏁 **Last:** ${last.dateKey} (${last.memberCount.toLocaleString()})`,
          '',
          `**Recent ${Math.min(previewMax, rows.length)} entries:**`,
          preview,
          '',
          'Full CSV attached.',
        ].join('\n'),
        files: [csvFile],
      });
    } catch (error) {
      return interaction.editReply(`❌ Failed to load member trend: ${error.message}`);
    }
  },
};
