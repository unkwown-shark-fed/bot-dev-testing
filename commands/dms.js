const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');
const db = require('../db');

function isAuthorized(interaction) {
  const ownerId = process.env.BOT_OWNER_ID || '';
  const requiredRole = interaction.client.config?.commandRoleId || process.env.COMMAND_ROLE_ID || '';
  const isOwner = ownerId && interaction.user.id === ownerId;
  const isAdmin = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) || false;
  const hasRole = requiredRole ? Boolean(interaction.member?.roles?.cache?.has(requiredRole)) : false;
  return isOwner || isAdmin || hasRole;
}

function truncate(str, max = 200) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

module.exports = {
  data: createCommandBuilder({
    name: 'dms',
    description: 'Fetch DMs that have been sent to the bot (admin only)',
    configure: builder => builder
      .addUserOption(opt =>
        opt.setName('user')
          .setDescription('Only show DMs from this user')
          .setRequired(false)
      )
      .addIntegerOption(opt =>
        opt.setName('limit')
          .setDescription('Max messages to show in the list (default 20, max 50)')
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(false)
      )
      .addBooleanOption(opt =>
        opt.setName('export')
          .setDescription('Export all matching DMs as a CSV file instead of listing them')
          .setRequired(false)
      ),
  }),

  cooldown: 5,

  async execute(interaction) {
    if (!isAuthorized(interaction)) {
      return interaction.reply({ content: '🔒 You are not authorized to view DMs sent to the bot.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const userOpt = interaction.options.getUser('user');
    const wantsExport = interaction.options.getBoolean('export') || false;
    const authorId = userOpt ? userOpt.id : null;

    if (wantsExport) {
      const rows = await db.getDmMessages({ authorId, limit: 10000 });

      if (rows.length === 0) {
        await interaction.editReply({ content: 'No logged DMs match that filter.' });
        return;
      }

      const columns = ['messageId', 'authorId', 'authorTag', 'createdAt', 'content', 'attachments'];
      const csv = stringify(
        rows.map(r => ({
          messageId: r.messageId,
          authorId: r.authorId,
          authorTag: r.authorTag,
          createdAt: new Date(r.createdAt).toISOString(),
          content: (r.content || '').replace(/\r?\n/g, ' '),
          attachments: (r.attachments || []).join(' '),
        })),
        { header: true, columns }
      );

      const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), {
        name: `bot-dms-${Date.now()}.csv`,
      });

      try {
        await interaction.user.send({
          content: `Exported ${rows.length} logged DM(s)${authorId ? ` from <@${authorId}>` : ''}.`,
          files: [attachment],
        });
        await interaction.editReply({ content: `✅ Exported ${rows.length} DM(s). Sent to your DMs!` });
      } catch (dmErr) {
        await interaction.editReply({
          content: `✅ Exported ${rows.length} DM(s). Couldn't DM you, file attached below:`,
          files: [attachment],
        });
      }
      return;
    }

    const limit = interaction.options.getInteger('limit') || 20;
    const [rows, total] = await Promise.all([
      db.getDmMessages({ authorId, limit }),
      db.countDmMessages(authorId),
    ]);

    if (rows.length === 0) {
      await interaction.editReply({ content: 'No logged DMs match that filter.' });
      return;
    }

    const lines = rows.map(r => {
      const ts = `<t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`;
      const body = truncate(r.content) || (r.attachments?.length ? '*[attachment only]*' : '*[empty]*');
      return `**${r.authorTag}** (\`${r.authorId}\`) — ${ts}\n${body}`;
    });

    // Discord embed descriptions cap at 4096 chars — trim if needed
    let description = lines.join('\n\n');
    if (description.length > 4000) {
      description = `${description.slice(0, 4000)}…`;
    }

    const embed = createEmbed({
      title: `📥 Logged DMs${userOpt ? ` from ${userOpt.tag}` : ''}`,
      description,
      color: EMBED_COLORS.info,
      footer: `Showing ${rows.length} of ${total} logged DM(s) — use export:true for the full CSV`,
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
