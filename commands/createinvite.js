const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

const INVITABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
]);

function collectRequestedRoleIds(interaction) {
  const roleIds = new Set();
  const rolesOption = interaction.options.get('roles');
  if (rolesOption) {
    if (typeof rolesOption.value === 'string') {
      const parsedRoleIds = rolesOption.value
        .split(/[\s,]+/)
        .map(token => token.trim())
        .filter(Boolean)
        .map(token => {
          const mentionMatch = token.match(/^<@&(\d{16,20})>$/);
          if (mentionMatch) return mentionMatch[1];
          return /^\d{16,20}$/.test(token) ? token : null;
        })
        .filter(Boolean);

      for (const roleId of parsedRoleIds) roleIds.add(roleId);
    } else {
      if (rolesOption.role?.id) roleIds.add(rolesOption.role.id);
      else if (typeof rolesOption.value === 'string' && /^\d{16,20}$/.test(rolesOption.value)) {
        roleIds.add(rolesOption.value);
      }
    }
  }

  for (let i = 2; i <= 5; i++) {
    const role = interaction.options.getRole(`role_${i}`);
    if (role) roleIds.add(role.id);
  }
  return Array.from(roleIds);
}

module.exports = {
  data: createCommandBuilder({
    name: 'createinvite',
    description: 'Create an invite link for a specific channel',
    configure: builder => {
      builder
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
          .setRequired(false));

      builder.addRoleOption(option => option
        .setName('roles')
        .setDescription('Optional auto-role #1')
        .setRequired(false));

      for (let i = 2; i <= 5; i++) {
        builder.addRoleOption(option => option
          .setName(`role_${i}`)
          .setDescription(`Optional auto-role #${i}`)
          .setRequired(false));
      }

      return builder;
    },
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
    const requestedRoleIds = collectRequestedRoleIds(interaction);

    const guild = interaction.guild;
    const me = guild.members.me || await guild.members.fetchMe();

    if (requestedRoleIds.length > 0 && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: '❌ I need the **Manage Roles** permission to auto-assign roles from invite links.',
        ephemeral: false,
      });
    }

    for (const roleId of requestedRoleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        return interaction.reply({
          content: `❌ Could not find role with ID \`${roleId}\` in this server.`,
          ephemeral: false,
        });
      }

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

      if (requestedRoleIds.length > 0 && interaction.client.inviteRoleStore) {
        interaction.client.inviteRoleStore.set(invite.code, {
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
