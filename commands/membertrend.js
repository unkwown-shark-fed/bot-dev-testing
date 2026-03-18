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

function buildDateRangeKeys(fromDateKey, toDateKey) {
  const keys = [];
  const cursor = new Date(`${fromDateKey}T00:00:00.000Z`);
  const end = new Date(`${toDateKey}T00:00:00.000Z`);

  while (cursor.getTime() <= end.getTime()) {
    keys.push(toDateKeyUTC(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return keys;
}

async function buildEstimatedRowsFromCurrentMembers(guild, fromDateKey, toDateKey) {
  await guild.members.fetch();

  const joinCountByDate = new Map();
  let joinedBeforeStart = 0;

  for (const member of guild.members.cache.values()) {
    if (!member.joinedTimestamp) continue;
    const joinedDateKey = toDateKeyUTC(new Date(member.joinedTimestamp));

    if (joinedDateKey < fromDateKey) {
      joinedBeforeStart++;
      continue;
    }

    if (joinedDateKey > toDateKey) continue;
    joinCountByDate.set(joinedDateKey, (joinCountByDate.get(joinedDateKey) || 0) + 1);
  }

  let running = joinedBeforeStart;
  return buildDateRangeKeys(fromDateKey, toDateKey).map(dateKey => {
    running += joinCountByDate.get(dateKey) || 0;
    return { dateKey, memberCount: running };
  });
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
        .setRequired(false))
      .addBooleanOption(option => option
        .setName('estimate_if_missing')
        .setDescription('If true, estimate from current member join dates when snapshots are missing')
        .setRequired(false)),
  }).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  cooldown: 5,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const fromInput = interaction.options.getString('from', true);
    const toInput = interaction.options.getString('to', false);
    const estimateIfMissing = interaction.options.getBoolean('estimate_if_missing') ?? true;

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
      let rows = await db.getMemberSnapshots(interaction.guildId, fromDateKey, toDateKey);
      let estimated = false;

      if (!rows.length) {
        if (!estimateIfMissing) {
          return interaction.editReply([
            `📉 No daily member snapshots found for **${fromDateKey} → ${toDateKey}**.`,
            'Tip: enable `estimate_if_missing` to build an estimate from current member join dates.',
          ].join('\n'));
        }

        rows = await buildEstimatedRowsFromCurrentMembers(interaction.guild, fromDateKey, toDateKey);
        estimated = true;
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
          estimated ? '⚠️ **Estimated Mode:** built from current members only (users who left are not included).' : '',
          `🧾 **Snapshots found:** ${rows.length.toLocaleString()}`,
          `🔁 **Change in period:** ${deltaStr}`,
          `📌 **First:** ${first.dateKey} (${first.memberCount.toLocaleString()})`,
          `🏁 **Last:** ${last.dateKey} (${last.memberCount.toLocaleString()})`,
          '',
          `**Recent ${Math.min(previewMax, rows.length)} entries:**`,
          preview,
          '',
          'Full CSV attached.',
        ].filter(Boolean).join('\n'),
        files: [csvFile],
      });
    } catch (error) {
      return interaction.editReply(`❌ Failed to load member trend: ${error.message}`);
    }
  },
};
