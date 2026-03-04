const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const { createCommandBuilder } = require('../utils/builders');

function parseMessageLinkOrId(input) {
  input = input.trim();
  try {
    const url = new URL(input);
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('channels');
    if (idx >= 0 && parts.length >= idx + 4) {
      const guildId = parts[idx + 1];
      const channelId = parts[idx + 2];
      const messageId = parts[idx + 3];
      return { guildId, channelId, messageId };
    }
  } catch (e) {}

  if (/^\d{17,19}$/.test(input)) {
    return { messageId: input };
  }

  return null;
}

async function tryFetchMessageInChannel(channel, messageId, interaction) {
  try {
    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return null;

    const perms = channel.permissionsFor(
      interaction.guild ? interaction.guild.members.me : interaction.client.user
    );

    if (!perms || !perms.has || !perms.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory
    ])) return null;

    const msg = await channel.messages.fetch(messageId).catch(() => null);
    return msg || null;
  } catch {
    return null;
  }
}

// 🔥 Helper to force Excel-safe IDs
function excelSafeId(id) {
  if (!id) return '';
  return `="${id}"`;
}

module.exports = {
  data: createCommandBuilder({
    name: 'exportmessages',
    description: 'Export multiple messages to CSV (provide message links or IDs)',
    configure: builder => builder
      .addStringOption(opt =>
        opt.setName('messages')
          .setDescription('Message links or IDs (space/newline separated)')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('(legacy) Message link or ID or multiple links/IDs')
          .setRequired(false)
      ),
  }),

  cooldown: 10,

  async execute(interaction) {
    await interaction.deferReply();

    let input = '';
    try {
      input =
        interaction.options.getString('messages') ??
        interaction.options.getString('message') ??
        '';
    } catch (e) {
      const opt = interaction.options?.data?.find(
        o => o.name === 'messages' || o.name === 'message'
      );
      input = opt?.value ?? '';
    }

    if (!input.trim()) {
      await interaction.editReply({
        content:
          'No message links or IDs provided. Please supply one or more links/IDs separated by spaces or newlines.'
      });
      return;
    }

    const parts = input.split(/\s+|,+/).map(s => s.trim()).filter(Boolean);

    if (!parts.length) {
      await interaction.editReply({
        content: 'No message links or IDs parsed from input.'
      });
      return;
    }

    const MAX_REQUESTS = 500;
    const requests = parts.slice(0, MAX_REQUESTS);

    const results = [];

    for (const item of requests) {
      const parsed = parseMessageLinkOrId(item);

      if (!parsed) {
        results.push({
          requested: item,
          messageId: '',
          channelId: '',
          channelName: '',
          guildId: '',
          guildName: '',
          authorTag: '',
          authorId: '',
          timestamp: '',
          content: '',
          attachments: '',
          error: 'invalid_input'
        });
        continue;
      }

      let foundMessage = null;
      let foundChannel = null;

      if (parsed.channelId && parsed.messageId) {
        const channel = await interaction.client.channels.fetch(parsed.channelId).catch(() => null);

        if (!channel) {
          results.push({
            requested: item,
            messageId: excelSafeId(parsed.messageId),
            channelId: excelSafeId(parsed.channelId),
            channelName: '',
            guildId: excelSafeId(parsed.guildId || ''),
            guildName: '',
            authorTag: '',
            authorId: '',
            timestamp: '',
            content: '',
            attachments: '',
            error: 'channel_not_found'
          });
          continue;
        }

        const msg = await tryFetchMessageInChannel(channel, parsed.messageId, interaction);

        if (!msg) {
          results.push({
            requested: item,
            messageId: excelSafeId(parsed.messageId),
            channelId: excelSafeId(parsed.channelId),
            channelName: channel.name || '',
            guildId: excelSafeId(parsed.guildId || ''),
            guildName: '',
            authorTag: '',
            authorId: '',
            timestamp: '',
            content: '',
            attachments: '',
            error: 'not_accessible_or_not_found'
          });
          continue;
        }

        foundMessage = msg;
        foundChannel = channel;
      } else if (parsed.messageId) {
        const msg = await tryFetchMessageInChannel(
          interaction.channel,
          parsed.messageId,
          interaction
        );

        if (msg) {
          foundMessage = msg;
          foundChannel = interaction.channel;
        } else {
          results.push({
            requested: item,
            messageId: excelSafeId(parsed.messageId),
            channelId: '',
            channelName: '',
            guildId: excelSafeId(interaction.guild?.id || ''),
            guildName: interaction.guild?.name || '',
            authorTag: '',
            authorId: '',
            timestamp: '',
            content: '',
            attachments: '',
            error: 'not_found_in_current_channel'
          });
          continue;
        }
      }

      if (foundMessage) {
        const attachments = Array.from(foundMessage.attachments.values())
          .map(a => a.url)
          .join(' ');

        results.push({
          requested: item,
          messageId: excelSafeId(foundMessage.id),
          channelId: excelSafeId(foundChannel?.id || ''),
          channelName: foundChannel?.name || '',
          guildId: excelSafeId(foundMessage.guildId || interaction.guild?.id || ''),
          guildName: foundMessage.guild?.name || interaction.guild?.name || '',
          authorTag: foundMessage.author?.tag || '',
          authorId: excelSafeId(foundMessage.author?.id || ''),
          timestamp: new Date(foundMessage.createdTimestamp).toISOString(),
          content: (foundMessage.content || '').replace(/\r?\n/g, ' '),
          attachments,
          error: ''
        });
      }
    }

    const columns = [
      'requested',
      'messageId',
      'channelId',
      'channelName',
      'guildId',
      'guildName',
      'authorTag',
      'authorId',
      'timestamp',
      'content',
      'attachments',
      'error'
    ];

    const csv = stringify(results, { header: true, columns });
    const buffer = Buffer.from(csv, 'utf8');
    const filename = `exported-messages-${Date.now()}.csv`;

    const attachment = new AttachmentBuilder(buffer, { name: filename });

    const foundCount = results.filter(r => !r.error).length;
    const notFoundCount = results.length - foundCount;
    const summary = `Processed ${results.length} entries — ${foundCount} found, ${notFoundCount} not found/errored.`;

    // Try to send via DM first
    try {
      await interaction.user.send({ 
        content: `${summary}\n\nExported messages CSV attached.`,
        files: [attachment] 
      });
      await interaction.editReply(`✅ ${summary}\n\nExport sent to your DMs!`);
    } catch (dmErr) {
      // DM failed, attach to reply in channel
      await interaction.editReply({
        content: `✅ ${summary}\n\n⚠️ Couldn't send DM (disabled?). File attached below:`,
        files: [attachment]
      });
    }
  }
};
