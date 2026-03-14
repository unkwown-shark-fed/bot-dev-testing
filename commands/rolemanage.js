const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');
const { stringify } = require('csv-stringify/sync');

function parseUsersList(input) {
  const parts = input.split(/\s+/).map(s => s.trim()).filter(Boolean);
  const ids = parts.map(p => {
    const m = p.match(/^<@!?(\d{17,19})>$/);
    if (m) return m[1];
    if (/^\d{17,19}$/.test(p)) return p;
    return null;
  }).filter(Boolean);
  return ids;
}

module.exports = {
  data: createCommandBuilder({
    name: 'rolemanage',
    description: 'Add or remove a role for a list of users',
    configure: builder => builder
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a role to users')
        .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true))
        .addStringOption(o => o.setName('users').setDescription('User IDs or mentions separated by spaces/newlines').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Process only first N users (optional)')))
    .addSubcommand(sc =>
      sc.setName('remove')
        .setDescription('Remove a role from users')
        .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true))
        .addStringOption(o => o.setName('users').setDescription('User IDs or mentions separated by spaces/newlines').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Process only first N users (optional)'))),
  }),
  cooldown: 15,
  async execute(interaction, client, logger) {
    const sub = interaction.options.getSubcommand();
    const role = interaction.options.getRole('role', true);
    const usersRaw = interaction.options.getString('users', true);
    let limit = interaction.options.getInteger('limit') || null;

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: 'You need Manage Roles permission to run this command.', ephemeral: true });
    }
    if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ content: 'I need Manage Roles permission to modify roles.', ephemeral: true });
    }

    const botMember = await interaction.guild.members.fetchMe();
    if (role.position >= botMember.roles.highest.position) {
      return interaction.reply({ content: 'I cannot modify that role because it is higher or equal to my highest role.', ephemeral: true });
    }

    await interaction.deferReply();

    const ids = parseUsersList(usersRaw);
    if (ids.length === 0) {
      return interaction.editReply({ content: 'No valid user IDs or mentions found in input.' });
    }

    const toProcess = limit ? ids.slice(0, limit) : ids;

    const results = [];
    for (const id of toProcess) {
      try {
        const member = await interaction.guild.members.fetch(id).catch(() => null);
        if (!member) {
          results.push({ userId: id, status: 'not_found', message: 'Member not found' });
          continue;
        }
        if (member.roles.highest.position >= botMember.roles.highest.position && member.id !== interaction.guild.ownerId) {
          results.push({ userId: id, status: 'skipped', message: 'Member role higher than bot or is the owner' });
          continue;
        }
        if (sub === 'add') {
          await member.roles.add(role, `RoleManage by ${interaction.user.tag}`);
          results.push({ userId: id, status: 'added', message: `Added role ${role.name}` });
        } else {
          await member.roles.remove(role, `RoleManage by ${interaction.user.tag}`);
          results.push({ userId: id, status: 'removed', message: `Removed role ${role.name}` });
        }
      } catch (err) {
        logger?.warn?.(`Failed to process ${id}: ${err.message || err}`);
        results.push({ userId: id, status: 'error', message: err?.message || 'Unknown error' });
      }
      await new Promise(res => setTimeout(res, 350));
    }

    const successCount = results.filter(r => r.status === (sub === 'add' ? 'added' : 'removed')).length;
    const failed = results.length - successCount;

    const embed = createEmbed({
      title: `Role ${sub === 'add' ? 'Add' : 'Remove'} — ${role.name}`,
      description: `Processed ${results.length} users — ${successCount} successful, ${failed} failed`,
      color: successCount > 0 ? EMBED_COLORS.success : EMBED_COLORS.danger,
    });

    const csv = stringify(results, { header: true, columns: ['userId', 'status', 'message'] });
    const attachment = new AttachmentBuilder(Buffer.from(csv), { name: `rolemanage-${Date.now()}.csv` });

    // Try to send via DM first
    try {
      await interaction.user.send({
        content: 'Role management results:',
        embeds: [embed],
        files: [attachment]
      });
      await interaction.editReply(`✅ Operation complete! Results sent to your DMs.\n\n${successCount} successful, ${failed} failed.`);
    } catch (dmErr) {
      // DM failed, attach to reply in channel
      await interaction.editReply({
        content: '✅ Operation complete! ⚠️ Couldn\'t send DM (disabled?). Results below:',
        embeds: [embed],
        files: [attachment]
      });
    }
  }
};
