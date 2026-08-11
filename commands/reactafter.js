const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

module.exports = {
  data: createCommandBuilder({
    name: 'reactafter',
    description: 'React on messages after a starting message link, one by one',
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    configure: builder => builder
      .addStringOption(o =>
        o.setName('message_link')
          .setDescription('Discord message link to start after')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('emoji')
          .setDescription('Emoji to react with (e.g. 👍 or ✅)')
          .setRequired(true))
      .addIntegerOption(o =>
        o.setName('count')
          .setDescription('How many messages to react to (0 = all after the link)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(5000))
      .addIntegerOption(o =>
        o.setName('delay_ms')
          .setDescription('Delay between reactions in milliseconds (default 350)')
          .setRequired(false)
          .setMinValue(100)
          .setMaxValue(5000)),
  }),

  cooldown: 10,

  async execute(interaction, _client, logger) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const link = interaction.options.getString('message_link', true).trim();
      const emoji = interaction.options.getString('emoji', true).trim();
      const count = interaction.options.getInteger('count') ?? 0;
      const delayMs = interaction.options.getInteger('delay_ms') ?? 350;

      const parsed = parseDiscordMessageLink(link);
      if (!parsed) {
        return interaction.editReply('❌ Invalid message link. Use a full Discord message link.');
      }

      if (interaction.guildId !== parsed.guildId) {
        return interaction.editReply('❌ The provided message link belongs to a different server.');
      }

      const channel = await interaction.guild.channels.fetch(parsed.channelId).catch(() => null);
      if (!channel?.isTextBased?.()) {
        return interaction.editReply('❌ Could not access a valid text channel from that message link.');
      }

      const botPerms = channel.permissionsFor(interaction.client.user);
      if (!botPerms?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ])) {
        return interaction.editReply('❌ I need View Channel, Read Message History, and Add Reactions in that channel.');
      }

      const startMessage = await channel.messages.fetch(parsed.messageId).catch(() => null);
      if (!startMessage) {
        return interaction.editReply('❌ Could not fetch the starting message from that link.');
      }

      await interaction.editReply(`🔄 Collecting messages after [this message](${startMessage.url}) in <#${channel.id}>...`);

      const allAfter = await fetchMessagesAfter(channel, startMessage.id, count);
      if (!allAfter.length) {
        return interaction.editReply('ℹ️ No messages found after the provided link.');
      }

      let reacted = 0;
      let failed = 0;

      for (const [index, msg] of allAfter.entries()) {
        try {
          if (!msg.reactions.cache.has(emoji)) {
            await msg.react(emoji);
            reacted++;
          }
        } catch (_) {
          failed++;
        }

        if ((index + 1) % 20 === 0) {
          await interaction.editReply(`⏳ Reacting... ${index + 1}/${allAfter.length} processed | ✅ ${reacted} | ⚠️ ${failed}`).catch(() => {});
        }

        await sleep(delayMs);
      }

      await interaction.editReply([
        '✅ Reaction run complete.',
        `• Channel: <#${channel.id}>`,
        `• Start message: ${startMessage.url}`,
        `• Emoji: ${emoji}`,
        `• Messages processed: ${allAfter.length}`,
        `• Reactions added: ${reacted}`,
        `• Failed/skipped: ${failed}`,
      ].join('\n'));

      logger?.info?.(`reactafter: ${interaction.user.tag} reacted ${reacted}/${allAfter.length} messages in #${channel.name}`);
    } catch (err) {
      logger?.error?.(`reactafter error: ${err.message}`);
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }
};

function parseDiscordMessageLink(link) {
  const match = link.match(/^https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
  };
}

async function fetchMessagesAfter(channel, startMessageId, limit = 0) {
  const all = [];
  let after = startMessageId;
  const cap = limit > 0 ? limit : Infinity;

  while (all.length < cap) {
    const batchLimit = Math.min(100, cap - all.length);
    const batch = await channel.messages.fetch({ limit: Number.isFinite(batchLimit) ? batchLimit : 100, after });
    if (!batch?.size) break;

    const chunk = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    all.push(...chunk);
    after = chunk[chunk.length - 1].id;

    if (chunk.length < 100) break;
    await sleep(250);
  }

  return all;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
