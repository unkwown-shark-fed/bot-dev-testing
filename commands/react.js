const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('react')
    .setDescription('Add a reaction to a message using its message ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.AddReactions)
    .addStringOption((opt) =>
      opt
        .setName('message_id')
        .setDescription('The ID of the message to react to')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('emoji')
        .setDescription('The emoji to react with (standard emoji or a server custom emoji)')
        .setRequired(true)
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
    ),

  async execute(interaction) {
    const messageId = interaction.options.getString('message_id').trim();
    const emojiInput = interaction.options.getString('emoji').trim();
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

    if (!/^\d{15,25}$/.test(messageId)) {
      return interaction.reply({
        content: '❌ That doesn\'t look like a valid message ID. Right-click a message → **Copy Message ID** (enable Developer Mode in Discord settings if you don\'t see that option).',
        ephemeral: true,
      });
    }

    const emoji = resolveEmoji(emojiInput);
    if (!emoji) {
      return interaction.reply({
        content: '❌ Could not read that emoji. Paste a standard emoji (😀) or a server custom emoji (<:name:id>).',
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

    try {
      await message.react(emoji);
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: '❌ Failed to add that reaction. Check the bot has **Add Reactions** permission in that channel, and that the emoji is valid (custom emojis must be from a server the bot is in).',
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: `✅ Reacted to [that message](${message.url}) with ${emojiInput}.`,
      ephemeral: true,
    });
  },
};

// Accepts:
//  - a plain unicode emoji, e.g. 😀
//  - a custom emoji mention, e.g. <:name:123456789012345678> or <a:name:123...> (animated)
//  - a raw custom emoji ID, e.g. 123456789012345678
// Returns the string discord.js needs for message.react().
function resolveEmoji(input) {
  const customMatch = input.match(/^<a?:\w+:(\d{15,25})>$/);
  if (customMatch) return customMatch[1];

  if (/^\d{15,25}$/.test(input)) return input;

  if (input.length > 0) return input; // treat as unicode emoji

  return null;
}
