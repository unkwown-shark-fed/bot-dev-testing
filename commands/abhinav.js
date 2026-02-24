const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName("abhinav")
    .setDescription("test"),
  cooldown: 3,

  async execute(interaction, _client, _logger) {
    try {
      const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_1771947447236")
      .setLabel("share your id")
      .setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({ content: "send message", components: [row] });

      const filter = i => i.user.id === interaction.user.id;
      const col = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });
      col.on('collect', async i => {
        await i.deferUpdate();
      if (i.customId === "btn_1771947447236") {

      }
      });
      col.on('end', (_, reason) => {
        if (reason === 'time') interaction.editReply({ content: '⏱️ Timed out.', components: [] }).catch(() => {});
      });
    } catch (err) {
      _logger?.error?.(`/abhinav error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  },
};
