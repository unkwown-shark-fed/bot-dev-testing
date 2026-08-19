const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const EMBED_COLORS = {
  primary: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  danger: 0xED4245,
  info: 0x00AE86,
};

function createCommandBuilder({
  name,
  description,
  defaultMemberPermissions,
  dmPermission,
  configure,
}) {
  if (!name || !description) {
    throw new Error('createCommandBuilder requires both name and description');
  }

  const builder = new SlashCommandBuilder().setName(name).setDescription(description);

  if (defaultMemberPermissions !== undefined) {
    builder.setDefaultMemberPermissions(defaultMemberPermissions);
  }

  if (typeof dmPermission === 'boolean') {
    builder.setDMPermission(dmPermission);
  }

  if (typeof configure === 'function') {
    configure(builder);
  }

  return builder;
}

function createEmbed({
  title,
  description,
  color = EMBED_COLORS.primary,
  timestamp = true,
  footer,
  thumbnail,
  image,
} = {}) {
  const embed = new EmbedBuilder().setColor(color);

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (timestamp) embed.setTimestamp();
  if (footer) embed.setFooter(typeof footer === 'string' ? { text: footer } : footer);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);

  return embed;
}

module.exports = {
  EMBED_COLORS,
  createCommandBuilder,
  createEmbed,
};
