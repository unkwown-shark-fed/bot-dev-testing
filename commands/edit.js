const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

// Discord's slash command text option is a single-line field — you can't press
// Enter in it. This lets people type a literal \n (or paste text that already
// has real line breaks) and turns it into actual newlines before editing.
function parseNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('edit')
    .setDescription("Edit a message the bot previously sent")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((opt) =>
      opt
        .setName('message_id')
        .setDescription('The ID of the bot message to edit')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('new_message')
        .setDescription('The new content for the message (use \\n for a line break)')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel the message is in (defaults to this channel)')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread
        )
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('allow_mentions')
        .setDescription('Allow @everyone/@here/role/user pings in the new content (default: off)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const messageId = interaction.options.getString('message_id').trim();
    const newContent = parseNewlines(interaction.options.getString('new_message'));
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    const allowMentions = interaction.options.getBoolean('allow_mentions') || false;

    if (!/^\d{15,25}$/.test(messageId)) {
      return interaction.reply({
        content: '❌ That doesn\'t look like a valid message ID. Right-click the message → **Copy Message ID** (enable Developer Mode in Discord settings if you don\'t see that option).',
        ephemeral: true,
      });
    }

    if (!targetChannel.isTextBased()) {
      return interaction.reply({
        content: '❌ That channel isn\'t a text channel I can edit messages in.',
        ephemeral: true,
      });
    }

    let message;
    try {
      message = await targetChannel.messages.fetch(messageId);
    } catch (err) {
      return interaction.reply({
        content: `❌ Couldn't find a message with ID \`${messageId}\` in <#${targetChannel.id}>. Make sure the channel option is correct.`,
        ephemeral: true,
      });
    }

    if (message.author.id !== interaction.client.user.id) {
      return interaction.reply({
        content: '❌ I can only edit messages I sent myself — Discord doesn\'t allow bots to edit other users\' messages.',
        ephemeral: true,
      });
    }

    try {
      await message.edit({
        content: newContent,
        allowedMentions: allowMentions
          ? { parse: ['everyone', 'roles', 'users'] }
          : { parse: [] },
      });
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: '❌ Failed to edit that message. Check my permissions in that channel.',
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: `✅ Edited [that message](${message.url}) in <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  },
};
