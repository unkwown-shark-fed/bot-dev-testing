const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  MentionableSelectMenuBuilder,
} = require('discord.js');

const EMBED_COLORS = {
  primary: 0x5865F2,
  success: 0x57F287,
  warning: 0xFEE75C,
  danger: 0xED4245,
  info: 0x00AE86,
  white: 0xFFFFFF,
  black: 0x000000,
};

const BUTTON_STYLES = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
  Link: ButtonStyle.Link,
};

const TEXT_INPUT_STYLES = {
  Short: TextInputStyle.Short,
  Paragraph: TextInputStyle.Paragraph,
};

function createCommandBuilder({
  name,
  description,
  defaultMemberPermissions,
  dmPermission,
  nsfw,
  contexts,
  integrationTypes,
  nameLocalizations,
  descriptionLocalizations,
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

  if (typeof nsfw === 'boolean') {
    builder.setNSFW(nsfw);
  }

  if (Array.isArray(contexts) && contexts.length > 0 && typeof builder.setContexts === 'function') {
    builder.setContexts(...contexts);
  }

  if (Array.isArray(integrationTypes) && integrationTypes.length > 0 && typeof builder.setIntegrationTypes === 'function') {
    builder.setIntegrationTypes(...integrationTypes);
  }

  if (nameLocalizations && typeof builder.setNameLocalizations === 'function') {
    builder.setNameLocalizations(nameLocalizations);
  }

  if (descriptionLocalizations && typeof builder.setDescriptionLocalizations === 'function') {
    builder.setDescriptionLocalizations(descriptionLocalizations);
  }

  if (typeof configure === 'function') {
    configure(builder);
  }

  return builder;
}

function buildLines(lines = [], { bullet = false } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return lines
    .filter(v => v !== null && v !== undefined && String(v).trim().length > 0)
    .map(v => (bullet ? `• ${String(v)}` : String(v)))
    .join('\n');
}

function createEmbed({
  title,
  description,
  lines,
  bulletLines = false,
  prependDescription,
  appendDescription,
  color = EMBED_COLORS.primary,
  timestamp = true,
  footer,
  author,
  thumbnail,
  image,
  url,
  fields,
} = {}) {
  const embed = new EmbedBuilder().setColor(color);

  if (title) embed.setTitle(title);
  if (url) embed.setURL(url);
  if (author) embed.setAuthor(typeof author === 'string' ? { name: author } : author);

  const lineBlock = buildLines(lines, { bullet: bulletLines });
  const descParts = [prependDescription, description, lineBlock, appendDescription]
    .filter(v => typeof v === 'string' && v.length > 0);

  if (descParts.length > 0) embed.setDescription(descParts.join('\n'));

  if (timestamp) embed.setTimestamp();
  if (footer) embed.setFooter(typeof footer === 'string' ? { text: footer } : footer);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);

  if (Array.isArray(fields) && fields.length > 0) {
    embed.addFields(...fields);
  }

  return embed;
}

function createButton({
  customId,
  label,
  style = BUTTON_STYLES.Primary,
  url,
  emoji,
  disabled = false,
}) {
  const button = new ButtonBuilder();

  const styleValue = typeof style === 'string' ? (BUTTON_STYLES[style] || BUTTON_STYLES.Primary) : style;
  button.setStyle(styleValue);

  if (styleValue === ButtonStyle.Link) {
    if (!url) throw new Error('Link button requires a url');
    button.setURL(url);
  } else {
    if (!customId) throw new Error('Non-link button requires customId');
    button.setCustomId(customId);
  }

  if (label) button.setLabel(label);
  if (emoji) button.setEmoji(emoji);
  if (disabled) button.setDisabled(true);

  return button;
}

function createActionRow(components = []) {
  const row = new ActionRowBuilder();
  if (Array.isArray(components) && components.length > 0) {
    row.addComponents(...components);
  }
  return row;
}

function createTextInput({
  customId,
  label,
  style = TEXT_INPUT_STYLES.Short,
  placeholder,
  required = true,
  minLength,
  maxLength,
  value,
}) {
  if (!customId || !label) {
    throw new Error('createTextInput requires customId and label');
  }

  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setRequired(Boolean(required));

  const styleValue = typeof style === 'string' ? (TEXT_INPUT_STYLES[style] || TEXT_INPUT_STYLES.Short) : style;
  input.setStyle(styleValue);

  if (typeof placeholder === 'string') input.setPlaceholder(placeholder);
  if (typeof minLength === 'number') input.setMinLength(minLength);
  if (typeof maxLength === 'number') input.setMaxLength(maxLength);
  if (typeof value === 'string') input.setValue(value);

  return input;
}

function createModal({ customId, title, components = [] }) {
  if (!customId || !title) {
    throw new Error('createModal requires customId and title');
  }

  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  if (components.length > 0) modal.addComponents(...components);
  return modal;
}

function createSelectMenu({
  type = 'string',
  customId,
  placeholder,
  minValues,
  maxValues,
  disabled,
  options = [],
  channelTypes,
}) {
  if (!customId) {
    throw new Error('createSelectMenu requires customId');
  }

  let menu;
  switch (type) {
    case 'channel':
      menu = new ChannelSelectMenuBuilder().setCustomId(customId);
      if (Array.isArray(channelTypes) && channelTypes.length > 0) menu.setChannelTypes(channelTypes);
      break;
    case 'role':
      menu = new RoleSelectMenuBuilder().setCustomId(customId);
      break;
    case 'user':
      menu = new UserSelectMenuBuilder().setCustomId(customId);
      break;
    case 'mentionable':
      menu = new MentionableSelectMenuBuilder().setCustomId(customId);
      break;
    case 'string':
    default:
      menu = new StringSelectMenuBuilder().setCustomId(customId);
      if (Array.isArray(options) && options.length > 0) menu.addOptions(...options);
      break;
  }

  if (typeof placeholder === 'string') menu.setPlaceholder(placeholder);
  if (typeof minValues === 'number') menu.setMinValues(minValues);
  if (typeof maxValues === 'number') menu.setMaxValues(maxValues);
  if (typeof disabled === 'boolean') menu.setDisabled(disabled);

  return menu;
}

function buildResponsePayload({
  content,
  embeds,
  components,
  files,
  ephemeral,
  allowedMentions,
  fetchReply,
} = {}) {
  const payload = {};
  if (content !== undefined) payload.content = content;
  if (Array.isArray(embeds)) payload.embeds = embeds;
  if (Array.isArray(components)) payload.components = components;
  if (Array.isArray(files)) payload.files = files;
  if (typeof ephemeral === 'boolean') payload.ephemeral = ephemeral;
  if (allowedMentions) payload.allowedMentions = allowedMentions;
  if (typeof fetchReply === 'boolean') payload.fetchReply = fetchReply;
  return payload;
}

module.exports = {
  EMBED_COLORS,
  BUTTON_STYLES,
  TEXT_INPUT_STYLES,
  createCommandBuilder,
  createEmbed,
  createButton,
  createActionRow,
  createTextInput,
  createModal,
  createSelectMenu,
  buildLines,
  buildResponsePayload,
};
