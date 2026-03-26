const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

const INVITABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
]);

function parseRoleIds(raw) {
  if (!raw) return [];

  const ids = new Set();
  const chunks = raw.split(/[\s,]+/).filter(Boolean);

  for (const chunk of chunks) {
    const match = chunk.match(/^(?:<@&)?(\d{17,20})>?$/);
    if (match) ids.add(match[1]);
  }

  return Array.from(ids);
}

module.exports = {
  data: createCommandBuilder({
    name: 'createinvite',
    description: 'Create an invite link for a specific channel',
    configure: builder => builder
      .addChannelOption(option => option
        .setName('channel')
        .setDescription('Channel to create the invite for')
        .setRequired(true))
      .addIntegerOption(option => option
        .setName('max_uses')
        .setDescription('How many times this invite can be used (0 = unlimited)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false))
      .addIntegerOption(option => option
        .setName('expire_hours')
        .setDescription('Expire after N hours (0 = never)')
        .setMinValue(0)
        .setMaxValue(168)
        .setRequired(false))
      .addBooleanOption(option => option
        .setName('temporary')
        .setDescription('Grant temporary membership')
        .setRequired(false))
      .addBooleanOption(option => option
        .setName('unique')
        .setDescription('Always create a new unique invite')
        .setRequired(false))
      .addStringOption(option => option
        .setName('roles')
        .setDescription('Optional roles to auto-assign on join (mentions/IDs, comma or space separated)')
        .setRequired(false)),
  }).setDefaultMemberPermissions(PermissionFlagsBits.CreateInstantInvite),
  cooldown: 5,
  async execute(interaction) {
    const channel = interaction.options.getChannel('channel', true);

    if (!INVITABLE_CHANNEL_TYPES.has(channel.type)) {
      return interaction.reply({
        content: '❌ This channel type does not support invite links. Please choose a text, voice, stage, announcement, or forum channel.',
        ephemeral: false,
      });
    }

    const botPerms = channel.permissionsFor(interaction.client.user);
    if (!botPerms?.has(PermissionFlagsBits.CreateInstantInvite)) {
      return interaction.reply({
        content: `❌ I do not have permission to create invites in ${channel}.`,
        ephemeral: false,
      });
    }

    const maxUses = interaction.options.getInteger('max_uses') ?? 0;
    const expireHours = interaction.options.getInteger('expire_hours') ?? 24;
    const temporary = interaction.options.getBoolean('temporary') ?? false;
    const unique = interaction.options.getBoolean('unique') ?? true;
    const roleInput = interaction.options.getString('roles') || '';

    const requestedRoleIds = parseRoleIds(roleInput);
    if (roleInput && requestedRoleIds.length === 0) {
      return interaction.reply({
        content: '❌ Could not parse any role IDs from `roles`. Use role mentions (e.g. <@&123>) or raw role IDs.',
        ephemeral: false,
      });
    }

    if (requestedRoleIds.length > 5) {
      return interaction.reply({
        content: '❌ Please select up to 5 roles per invite.',
        ephemeral: false,
      });
    }

    const guild = interaction.guild;
    const me = guild.members.me || await guild.members.fetchMe();

    const missingRoleIds = requestedRoleIds.filter(roleId => !guild.roles.cache.has(roleId));
    if (missingRoleIds.length > 0) {
      return interaction.reply({
        content: `❌ Some roles were not found in this server: ${missingRoleIds.map(id => `\`${id}\``).join(', ')}`,
        ephemeral: false,
      });
    }

    if (requestedRoleIds.length > 0 && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: '❌ I need the **Manage Roles** permission to auto-assign roles from invite links.',
        ephemeral: false,
      });
    }

    for (const roleId of requestedRoleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role.editable) {
        return interaction.reply({
          content: `❌ I cannot assign ${role} because it is above my highest role (or managed).`,
          ephemeral: false,
        });
      }
    }

    const maxAge = expireHours <= 0 ? 0 : expireHours * 3600;

    try {
      const invite = await channel.createInvite({
        maxAge,
        maxUses,
        temporary,
        unique,
        reason: `Invite created by ${interaction.user.tag} (${interaction.user.id}) via /createinvite`,
      });

      if (requestedRoleIds.length > 0 && interaction.client.inviteRoleLinks) {
        interaction.client.inviteRoleLinks.set(invite.code, {
          guildId: guild.id,
          roleIds: requestedRoleIds,
          createdBy: interaction.user.id,
          createdAt: Date.now(),
        });
      }

      const expiresText = maxAge === 0
        ? 'Never'
        : `<t:${Math.floor((Date.now() + maxAge * 1000) / 1000)}:R>`;

      return interaction.reply({
        content: [
          `✅ Invite created for ${channel}: ${invite.url}`,
          `• Max uses: **${maxUses === 0 ? 'Unlimited' : maxUses}**`,
          `• Expires: **${expiresText}**`,
          `• Temporary membership: **${temporary ? 'Yes' : 'No'}**`,
          `• Auto roles: **${requestedRoleIds.length ? requestedRoleIds.map(id => `<@&${id}>`).join(', ') : 'None'}**`,
        ].join('\n'),
        ephemeral: false,
      });
    } catch (error) {
      return interaction.reply({
        content: `❌ Failed to create invite for ${channel}: ${error.message}`,
        ephemeral: false,
      });
    }
  },
};
