const { AttachmentBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

// Pull every 15-20 digit snowflake out of the raw input (handles plain IDs
// as well as <@123>/<@!123> mentions).
function parseUserIds(input) {
  const idRegex = /\d{15,20}/g;
  const ids = new Set();
  let m;
  while ((m = idRegex.exec(input)) !== null) ids.add(m[0]);
  return Array.from(ids);
}

// Audit log event types that correspond to moderation actions.
// MemberUpdate covers timeouts (communication_disabled_until), plus
// nickname/role-flag changes made by a moderator on someone else.
const MOD_ACTION_TYPES = [
  AuditLogEvent.MemberKick,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberBanRemove,
  AuditLogEvent.MemberUpdate,
  AuditLogEvent.MemberRoleUpdate,
];

const ACTION_LABELS = {
  [AuditLogEvent.MemberKick]: 'Kick',
  [AuditLogEvent.MemberBanAdd]: 'Ban',
  [AuditLogEvent.MemberBanRemove]: 'Unban',
  [AuditLogEvent.MemberUpdate]: 'Member Update (timeout/nickname/etc.)',
  [AuditLogEvent.MemberRoleUpdate]: 'Role Change',
};

module.exports = {
  data: createCommandBuilder({
    name: 'modlogs',
    description: 'Fetch audit-log moderation actions (ban/kick/timeout/role) for one or more users',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
    configure: builder => builder
      .addStringOption(o =>
        o.setName('users')
          .setDescription('User IDs or mentions, space/comma/newline separated (skip if using "file")')
          .setRequired(false))
      .addAttachmentOption(o =>
        o.setName('file')
          .setDescription('.txt/.csv file with one user ID per line (use for large lists)')
          .setRequired(false))
      .addIntegerOption(o =>
        o.setName('pages')
          .setDescription('Audit log pages to scan, 100 entries each (default 3, max 10)')
          .setMinValue(1)
          .setMaxValue(10)
          .setRequired(false))
      .addStringOption(o =>
        o.setName('server')
          .setDescription('Target server ID to pull logs from (defaults to the server you ran this in)')
          .setRequired(false)),
  }),
  cooldown: 15,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // --- Resolve which guild to actually pull audit logs from ---
    const serverIdInput = interaction.options.getString('server')?.trim();
    let targetGuild;

    if (serverIdInput) {
      targetGuild = interaction.client.guilds.cache.get(serverIdInput);
      if (!targetGuild) {
        return interaction.editReply({
          content: `I'm not in a server with ID \`${serverIdInput}\` (or it's invalid). I can only pull logs from servers I'm already a member of.`,
        });
      }
    } else if (interaction.guild) {
      targetGuild = interaction.guild;
    } else {
      return interaction.editReply({ content: 'Run this in a server, or pass a `server` ID to target one.' });
    }

    // --- Re-check permissions against the TARGET guild, not the one the command was run in ---
    // Discord's own permission gate on the slash command only covers the server you ran it in,
    // so if we're crossing into a different server we have to verify manually that the caller
    // (and the bot) actually have rights there too.
    let targetMember;
    try {
      targetMember = await targetGuild.members.fetch(interaction.user.id);
    } catch {
      return interaction.editReply({
        content: `You're not a member of **${targetGuild.name}**, so I can't verify you have permission to view its audit log.`,
      });
    }

    if (!targetMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.editReply({
        content: `You need the **Moderate Members** permission in **${targetGuild.name}** to pull logs from it.`,
      });
    }

    const botMember = targetGuild.members.me;
    if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      return interaction.editReply({
        content: `I don't have **View Audit Log** permission in **${targetGuild.name}**, so I can't fetch its logs.`,
      });
    }

    const rawInput = interaction.options.getString('users') || '';
    const fileAttachment = interaction.options.getAttachment('file');

    let fileText = '';
    if (fileAttachment) {
      const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB, plenty for a list of IDs
      if (fileAttachment.size > MAX_FILE_SIZE) {
        return interaction.editReply({ content: `That file is too large (${fileAttachment.size} bytes). Keep it under 2 MB.` });
      }
      try {
        const res = await fetch(fileAttachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fileText = await res.text();
      } catch (err) {
        return interaction.editReply({ content: `Couldn't download the attached file: ${err.message}` });
      }
    }

    const userIds = parseUserIds(`${rawInput}\n${fileText}`);

    if (userIds.length === 0) {
      return interaction.editReply({ content: 'No valid user IDs or mentions found in the `users` text or the attached file.' });
    }

    const MAX_USERS = 500;
    if (userIds.length > MAX_USERS) {
      return interaction.editReply({ content: `Too many users (${userIds.length}). Provide up to ${MAX_USERS} at a time.` });
    }

    const targetSet = new Set(userIds);
    const pages = interaction.options.getInteger('pages') ?? 3;

    const foundEntries = [];
    let before;

    try {
      for (let i = 0; i < pages; i++) {
        const fetchOptions = { limit: 100 };
        if (before) fetchOptions.before = before;

        const auditLogs = await targetGuild.fetchAuditLogs(fetchOptions);
        if (!auditLogs || auditLogs.entries.size === 0) break;

        for (const entry of auditLogs.entries.values()) {
          if (!MOD_ACTION_TYPES.includes(entry.action)) continue;

          const targetId = entry.targetId ?? entry.target?.id;
          if (!targetId || !targetSet.has(String(targetId))) continue;

          foundEntries.push({
            server: `${targetGuild.name} (${targetGuild.id})`,
            userId: String(targetId),
            action: ACTION_LABELS[entry.action] || `Type ${entry.action}`,
            moderator: entry.executor ? `${entry.executor.tag} (${entry.executor.id})` : 'Unknown',
            reason: entry.reason || '',
            timestamp: entry.createdAt ? entry.createdAt.toISOString() : '',
          });
        }

        const last = auditLogs.entries.last();
        if (!last) break;
        before = last.id;

        // Small delay between pages so we don't hammer the audit-log endpoint.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (err) {
      return interaction.editReply({
        content: `Failed to fetch audit logs: ${err.message}. Make sure the bot has the "View Audit Log" permission.`,
      });
    }

    if (foundEntries.length === 0) {
      return interaction.editReply({
        content: `No matching moderation actions found in **${targetGuild.name}** for the given user(s) in the last ${pages * 100} audit log entries.\n` +
          `Note: Discord only retains audit log entries for 45 days, and this only scans entries logged there — warnings issued by a separate mod bot won't show up here.`,
      });
    }

    // Per-user counts for a quick embed summary.
    const counts = new Map();
    for (const e of foundEntries) counts.set(e.userId, (counts.get(e.userId) || 0) + 1);

    const embed = createEmbed({
      title: 'Moderation Log Summary',
      description: `Server: **${targetGuild.name}** (\`${targetGuild.id}\`)\nScanned up to ${pages * 100} audit log entries for ${userIds.length} user(s). Full details in the attached CSV.`,
      color: EMBED_COLORS.info,
    });

    const summaryLines = Array.from(counts.entries())
      .map(([id, count]) => `<@${id}> (\`${id}\`): ${count} action(s)`)
      .slice(0, 25);
    embed.addFields({ name: 'Results', value: summaryLines.join('\n') || 'None' });

    const csv = stringify(foundEntries, {
      header: true,
      columns: ['server', 'userId', 'action', 'moderator', 'reason', 'timestamp'],
    });
    const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), {
      name: `modlogs-${Date.now()}.csv`,
    });

    await interaction.editReply({ embeds: [embed], files: [attachment] });
  },
};