const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Bulk delete messages in a channel (admin only)')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false))
    .addBooleanOption(o => o.setName('bots_only').setDescription('Only delete bot messages').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  cooldown: 10,
  async execute(interaction) {
    // Permission check
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: '❌ You need the "Manage Messages" permission to use this command.', ephemeral: true });
    }

    const amount = interaction.options.getInteger('amount');
    const targetUser = interaction.options.getUser('user');
    const botsOnly = interaction.options.getBoolean('bots_only') || false;

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;

      // Check bot permissions
      const botPerms = channel.permissionsFor(interaction.guild.members.me);
      if (!botPerms.has([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('❌ I need "Manage Messages" and "Read Message History" permissions in this channel.');
      }

      // Fetch messages
      const messages = await channel.messages.fetch({ limit: 100 });

      // Filter messages
      let filtered = Array.from(messages.values());

      if (targetUser) {
        filtered = filtered.filter(m => m.author.id === targetUser.id);
      }

      if (botsOnly) {
        filtered = filtered.filter(m => m.author.bot);
      }

      // Limit to requested amount
      filtered = filtered.slice(0, amount);

      if (filtered.length === 0) {
        return interaction.editReply('❌ No messages found matching your criteria.');
      }

      // Separate messages by age (Discord only allows bulk delete for messages < 14 days old)
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const bulkDeleteable = filtered.filter(m => m.createdTimestamp > twoWeeksAgo);
      const tooOld = filtered.filter(m => m.createdTimestamp <= twoWeeksAgo);

      let deletedCount = 0;

      // Bulk delete recent messages
      if (bulkDeleteable.length > 0) {
        try {
          const deleted = await channel.bulkDelete(bulkDeleteable, true);
          deletedCount += deleted.size;
        } catch (err) {
          logger?.error?.(`Bulk delete failed: ${err.message}`);
        }
      }

      // Individually delete old messages
      if (tooOld.length > 0) {
        await interaction.editReply(`🔄 Deleting ${tooOld.length} old messages individually (this may take a while)...`);
        
        for (const msg of tooOld) {
          try {
            await msg.delete();
            deletedCount++;
            await new Promise(r => setTimeout(r, 1000)); // Rate limit protection
          } catch (err) {
            // Message might have been deleted already
          }
        }
      }

      let summary = `✅ Successfully deleted **${deletedCount}** message(s)`;
      if (targetUser) summary += ` from ${targetUser.tag}`;
      if (botsOnly) summary += ' (bots only)';
      summary += '.';

      await interaction.editReply(summary);
    } catch (err) {
      console.error('Cleanup error:', err);
      await interaction.editReply(`❌ Error during cleanup: ${err.message}`);
    }
  }
};
