const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

// Discord's slash command text option is a single-line field — you can't press
// Enter in it. This lets people type a literal \n (or paste text that already
// has real line breaks) and turns it into actual newlines before sending.
function parseNewlines(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message through the bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('The message to send (use \\n for a line break)')
        .setRequired(true)
        .setMaxLength(2000)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to send it in (defaults to this channel)')
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
        .setDescription('Allow @everyone/@here/role/user pings in the message (default: off)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const message = parseNewlines(interaction.options.getString('message'));
    const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
    const allowMentions = interaction.options.getBoolean('allow_mentions') || false;

    if (!targetChannel.isTextBased()) {
      return interaction.reply({
        content: '❌ That channel isn\'t a text channel I can send messages in.',
        ephemeral: true,
      });
    }

    const permissions = targetChannel.permissionsFor(interaction.client.user);
    if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ I don't have permission to send messages in <#${targetChannel.id}>.`,
        ephemeral: true,
      });
    }

    try {
      await targetChannel.send({
        content: message,
        allowedMentions: allowMentions
          ? { parse: ['everyone', 'roles', 'users'] }
          : { parse: [] }, // safe default: no pings triggered
      });
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: '❌ Failed to send that message. Check my permissions in that channel.',
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: `✅ Sent to <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  },
};
