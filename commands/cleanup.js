const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

const MAX_TOTAL = 1000; // safety cap per run

// Accepts a raw message ID or a Discord message link and returns the message ID (or null)
function parseMessageId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const link = trimmed.match(/channels\/(?:\d+|@me)\/(\d+)\/(\d+)/);
  if (link) return { channelId: link[1], messageId: link[2] };
  if (/^\d{17,20}$/.test(trimmed)) return { channelId: null, messageId: trimmed };
  return null;
}

module.exports = {
  category: 'Moderation',
  data: createCommandBuilder({
    name: 'cleanup',
    description: 'Bulk delete messages in a channel (admin only)',
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    configure: builder => builder
      .addIntegerOption(o => o.setName('amount').setDescription(`Number of messages to delete (1-${MAX_TOTAL}). Optional when using from_message`).setRequired(false).setMinValue(1).setMaxValue(MAX_TOTAL))
      .addStringOption(o => o.setName('from_message').setDescription('Message ID or link to start from (that message is included)').setRequired(false))
      .addStringOption(o => o.setName('direction').setDescription('With from_message: delete everything after it (default) or before it')
        .setRequired(false)
        .addChoices({ name: 'After (newer messages)', value: 'after' }, { name: 'Before (older messages)', value: 'before' }))
      .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false))
      .addBooleanOption(o => o.setName('bots_only').setDescription('Only delete bot messages').setRequired(false)),
  }),
  cooldown: 10,

  async execute(interaction, client, logger) {
    const log = logger || console;

    if (!interaction.inGuild()) {
      return interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
    }

    const amount      = interaction.options.getInteger('amount');
    const fromInput   = interaction.options.getString('from_message');
    const direction   = interaction.options.getString('direction') || 'after';
    const targetUser  = interaction.options.getUser('user');
    const botsOnly    = interaction.options.getBoolean('bots_only') || false;

    if (!amount && !fromInput) {
      return interaction.reply({ content: '❌ Provide either `amount` or `from_message`.', ephemeral: true });
    }

    let anchor = null;
    if (fromInput) {
      anchor = parseMessageId(fromInput);
      if (!anchor) {
        return interaction.reply({ content: '❌ `from_message` must be a message ID or a message link.', ephemeral: true });
      }
      if (anchor.channelId && anchor.channelId !== interaction.channelId) {
        return interaction.reply({ content: '❌ That message link is from a different channel. Run the command in the same channel as the message.', ephemeral: true });
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;

      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms.has([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('❌ I need "Manage Messages" and "Read Message History" permissions in this channel.');
      }

      const limit = Math.min(amount || MAX_TOTAL, MAX_TOTAL);
      let collected = [];

      if (!anchor) {
        // Original behaviour: latest N messages
        const messages = await channel.messages.fetch({ limit: 100 });
        collected = Array.from(messages.values()); // newest first
      } else {
        // Make sure the anchor message exists in this channel
        let anchorMsg;
        try {
          anchorMsg = await channel.messages.fetch(anchor.messageId);
        } catch {
          return interaction.editReply('❌ I couldn\'t find that message in this channel.');
        }

        if (direction === 'after') {
          // Collect anchor + everything newer, oldest -> newest
          collected.push(anchorMsg);
          let cursor = anchorMsg.id;
          while (collected.length < MAX_TOTAL) {
            const batch = await channel.messages.fetch({ limit: 100, after: cursor });
            if (batch.size === 0) break;
            const sorted = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
            collected.push(...sorted);
            cursor = sorted[sorted.length - 1].id;
            if (batch.size < 100) break;
          }
        } else {
          // Collect anchor + everything older, newest -> oldest
          collected.push(anchorMsg);
          let cursor = anchorMsg.id;
          while (collected.length < MAX_TOTAL) {
            const batch = await channel.messages.fetch({ limit: 100, before: cursor });
            if (batch.size === 0) break;
            const sorted = Array.from(batch.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
            collected.push(...sorted);
            cursor = sorted[sorted.length - 1].id;
            if (batch.size < 100) break;
          }
        }
      }

      // Filters
      let filtered = collected;
      if (targetUser) filtered = filtered.filter(m => m.author.id === targetUser.id);
      if (botsOnly)   filtered = filtered.filter(m => m.author.bot);

      // Don't delete pinned messages by accident
      filtered = filtered.filter(m => !m.pinned);

      filtered = filtered.slice(0, limit);

      if (filtered.length === 0) {
        return interaction.editReply('❌ No messages found matching your criteria.');
      }

      // Bulk delete only works for messages < 14 days old
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const bulkDeleteable = filtered.filter(m => m.createdTimestamp > twoWeeksAgo);
      const tooOld         = filtered.filter(m => m.createdTimestamp <= twoWeeksAgo);

      let deletedCount = 0;

      // bulkDelete accepts max 100 per call, so chunk it
      for (let i = 0; i < bulkDeleteable.length; i += 100) {
        const chunk = bulkDeleteable.slice(i, i + 100);
        try {
          const deleted = chunk.length === 1
            ? (await chunk[0].delete(), { size: 1 })
            : await channel.bulkDelete(chunk, true);
          deletedCount += deleted.size;
        } catch (err) {
          log.error(`Bulk delete failed: ${err.message}`);
        }
      }

      // Individually delete old messages (slow: ~1 per second)
      if (tooOld.length > 0) {
        await interaction.editReply(`🔄 Deleted ${deletedCount} so far. Deleting ${tooOld.length} old messages individually (this may take a while)...`);

        // discord.js queues requests and respects Discord's rate limits automatically,
        // so no manual delay is needed.
        let oldDone = 0;
        for (const msg of tooOld) {
          try {
            await msg.delete();
            deletedCount++;
          } catch {
            // Already deleted — safe to ignore
          }
          oldDone++;

          // Progress update every 25 messages
          if (oldDone % 25 === 0) {
            await interaction.editReply(`🔄 Deleting old messages: ${oldDone}/${tooOld.length}...`).catch(() => {});
          }
        }
      }

      let summary = `✅ Successfully deleted **${deletedCount}** message(s)`;
      if (anchor)     summary += ` ${direction === 'after' ? 'from' : 'back to'} message \`${anchor.messageId}\``;
      if (targetUser) summary += ` from ${targetUser.tag}`;
      if (botsOnly)   summary += ' (bots only)';
      summary += '.';

      try {
        await interaction.editReply(summary);
      } catch {
        // Interaction token expired (15 min limit) — fall back to a normal message
        const note = await channel.send(`${interaction.user}, ${summary}`).catch(() => null);
        if (note) setTimeout(() => note.delete().catch(() => {}), 10000);
      }
    } catch (err) {
      log.error(`Cleanup error: ${err.message || err}`);
      await interaction.editReply(`❌ Error during cleanup: ${err.message}`);
    }
  }
};
