const { PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCommandBuilder } = require('../utils/builders');

const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'exports');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

module.exports = {
  data: createCommandBuilder({
    name: 'fetchreactions',
    description: 'Fetch all messages with thumbsup/thumbsdown reaction counts from a channel',
    defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    configure: builder => builder
      .addChannelOption(o => 
        o.setName('channel')
          .setDescription('Channel to fetch reactions from (defaults to current channel)')
          .setRequired(false))
      .addIntegerOption(o =>
        o.setName('limit')
          .setDescription('Maximum messages to fetch (0 = unlimited, default: 1000)')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(10000)),
  }),
  
  cooldown: 30,
  
  async execute(interaction, client, logger) {
    await interaction.deferReply(); // Not ephemeral - file needs to be visible

    try {
      const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
      const limit = interaction.options.getInteger('limit') ?? 1000;

      // Validate channel type
      if (!targetChannel.isTextBased?.()) {
        return interaction.editReply('❌ Please provide a text channel.');
      }

      // Check permissions
      const perms = targetChannel.permissionsFor(interaction.client.user);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('❌ I need View Channel and Read Message History permissions in that channel.');
      }

      await interaction.editReply(`🔄 Fetching messages from ${targetChannel}... This may take a while.`);

      // Fetch all messages
      const messages = await fetchAllMessages(targetChannel, limit);

      if (!messages || messages.length === 0) {
        return interaction.editReply('❌ No messages found in that channel.');
      }

      await interaction.editReply(`✅ Fetched ${messages.length} messages. Processing reactions...`);

      // Process messages and reactions
      const results = [];
      let processed = 0;

      for (const msg of messages) {
        processed++;

        // Update progress every 50 messages
        if (processed % 50 === 0) {
          await interaction.editReply(`⏳ Processing reactions... ${processed}/${messages.length}`).catch(() => {});
        }

        // Get reaction counts
        const thumbsUp = msg.reactions.cache.get('👍')?.count || 0;
        const thumbsDown = msg.reactions.cache.get('👎')?.count || 0;

        // Only include messages that have at least one reaction
        if (thumbsUp > 0 || thumbsDown > 0) {
          const messageData = {
            messageId: msg.id,
            messageLink: `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`,
            author: {
              id: msg.author.id,
              username: msg.author.username,
              tag: msg.author.tag
            },
            content: msg.content || '[No text content]',
            timestamp: msg.createdAt.toISOString(),
            reactions: {
              thumbsup: thumbsUp,
              thumbsdown: thumbsDown,
              total: thumbsUp + thumbsDown
            },
            attachments: msg.attachments.size > 0 ? Array.from(msg.attachments.values()).map(a => a.url) : [],
            embeds: msg.embeds.length > 0
          };

          results.push(messageData);
        }
      }

      if (results.length === 0) {
        return interaction.editReply('❌ No messages with 👍 or 👎 reactions found.');
      }

      // Sort by total reactions (highest first)
      results.sort((a, b) => b.reactions.total - a.reactions.total);

      // Create JSON output
      const jsonOutput = {
        channel: {
          id: targetChannel.id,
          name: targetChannel.name,
          type: targetChannel.type
        },
        fetchedAt: new Date().toISOString(),
        totalMessages: messages.length,
        messagesWithReactions: results.length,
        statistics: {
          totalThumbsUp: results.reduce((sum, m) => sum + m.reactions.thumbsup, 0),
          totalThumbsDown: results.reduce((sum, m) => sum + m.reactions.thumbsdown, 0),
          averageThumbsUp: (results.reduce((sum, m) => sum + m.reactions.thumbsup, 0) / results.length).toFixed(2),
          averageThumbsDown: (results.reduce((sum, m) => sum + m.reactions.thumbsdown, 0) / results.length).toFixed(2)
        },
        messages: results
      };

      // Save to file
      const filename = `reactions_${targetChannel.name}_${Date.now()}.json`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(jsonOutput, null, 2), 'utf8');

      // Create attachment
      const buffer = fs.readFileSync(filepath);
      const attachment = new AttachmentBuilder(buffer, { name: filename });

      // Create summary (using text instead of emojis for better compatibility)
      const summary = [
        `✅ **Reaction Export Complete**`,
        ``,
        `📊 **Statistics:**`,
        `• Total Messages Scanned: ${messages.length}`,
        `• Messages with Reactions: ${results.length}`,
        `• Total Thumbs Up: ${jsonOutput.statistics.totalThumbsUp}`,
        `• Total Thumbs Down: ${jsonOutput.statistics.totalThumbsDown}`,
        `• Average Thumbs Up per message: ${jsonOutput.statistics.averageThumbsUp}`,
        `• Average Thumbs Down per message: ${jsonOutput.statistics.averageThumbsDown}`,
        ``,
        `📁 File saved and attached as JSON.`
      ].join('\n');

      // Try to send via DM first
      try {
        await interaction.user.send({ content: summary, files: [attachment] });
        await interaction.editReply('✅ Reaction data sent to your DMs!');
      } catch (dmErr) {
        // DM failed, send in channel (make sure it's NOT ephemeral)
        try {
          await interaction.followUp({ 
            content: `${interaction.user}\n\n${summary}`, 
            files: [attachment],
            ephemeral: false  // Make sure file is visible to everyone
          });
          await interaction.editReply('✅ Reaction data posted in this channel (DMs disabled).');
        } catch (channelErr) {
          // Both failed, just edit reply
          await interaction.editReply(`✅ Export complete!\n${summary}\n\nFile saved at: ${filepath}`);
        }
      }

      logger?.info?.(`fetchreactions: ${interaction.user.tag} exported ${results.length} messages from #${targetChannel.name}`);

    } catch (err) {
      console.error('fetchreactions error:', err);
      logger?.error?.(`fetchreactions error: ${err.message}`);
      
      try {
        await interaction.editReply(`❌ Error: ${err.message}`);
      } catch (editErr) {
        // Interaction might have expired
        console.error('Failed to send error message:', editErr);
      }
    }
  }
};

// Helper function to fetch all messages from a channel
async function fetchAllMessages(channel, limit = 0) {
  const messages = [];
  let lastId;
  const maxCap = limit > 0 ? limit : Infinity;
  const perRequest = 100;

  const MAX_ATTEMPTS = 6;
  const BASE_DELAY = 600;

  while (messages.length < maxCap) {
    const options = { limit: Math.min(perRequest, maxCap - messages.length) };
    if (lastId) options.before = lastId;

    let batch;
    let success = false;

    // Retry logic
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        batch = await channel.messages.fetch(options);
        success = true;
        break;
      } catch (err) {
        console.warn(`Fetch attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, BASE_DELAY * attempt));
        }
      }
    }

    if (!success || !batch?.size) break;

    const batchArray = Array.from(batch.values());
    messages.push(...batchArray);
    lastId = batchArray[batchArray.length - 1].id;

    // Small delay between batches
    await new Promise(r => setTimeout(r, 300));
  }

  // Sort chronologically (oldest first)
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  return messages;
}
