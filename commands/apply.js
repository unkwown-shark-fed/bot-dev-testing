const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName("apply")
    .setDescription("Submit an application"),
  cooldown: 3,

  async execute(interaction, _client, _logger) {
    try {

    // ── Modal Form ──────────────────────────────────────────────────────────
    // Step 1: Reply with the button
    const formBtn = new ButtonBuilder()
      .setCustomId("modal_form_open")
      .setLabel("📋 Open Form")
      .setStyle(ButtonStyle.Primary);
    await interaction.reply({
      content: 'Click the button below to open the form.',
      components: [new ActionRowBuilder().addComponents(formBtn)]
    });

    // Step 2: Listen for button click via client interactionCreate
    // (showModal MUST be called as a direct response — collectors are too slow)
    const _formHandler = async i => {
      if (!i.isButton() || i.customId !== "modal_form_open") return;

      // Build and show the modal immediately as the direct response
      const modal = new ModalBuilder()
        .setCustomId("modal_form_submit")
        .setTitle("Fill Out Form");
    const field0 = new TextInputBuilder()
      .setCustomId("field_0")
      .setLabel("Full Name")
      .setPlaceholder("Enter your full name")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    const field1 = new TextInputBuilder()
      .setCustomId("field_1")
      .setLabel("ID Number")
      .setPlaceholder("Enter your ID number")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(field0));
    modal.addComponents(new ActionRowBuilder().addComponents(field1));
      await i.showModal(modal);
    };

    const _submitHandler = async i => {
      if (!i.isModalSubmit() || i.customId !== "modal_form_submit") return;
      try {
        await i.deferReply({ ephemeral: true });
        const targetCh = i.guild?.channels?.cache?.find(c => c.name === "1434206624544723147" || c.id === "1434206624544723147");
        if (!targetCh) {
          await i.editReply({ content: '⚠️ Response channel not found. Contact an admin.' });
          return;
        }
      const resEmbed = new EmbedBuilder()
        .setTitle('📋 New Form Submission')
        .addFields(
        { name: "Full Name", value: i.fields.getTextInputValue("field_0"), inline: true },
        { name: "ID Number", value: i.fields.getTextInputValue("field_1"), inline: true },
          { name: 'Submitted By', value: `${i.user.tag} (<@${i.user.id}>)`, inline: false },
          { name: 'Submitted At', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false }
        )
        .setColor('#2dd4a0')
        .setThumbnail(i.user.displayAvatarURL());
      await targetCh.send({ embeds: [resEmbed] });
        await i.editReply({ content: '✅ Form submitted successfully!' });
      } catch (err) {
        _logger?.error?.('Modal submit error: ' + err.message);
        await i.editReply({ content: '⚠️ Something went wrong submitting the form.' }).catch(() => {});
      }
    };

    _client.on('interactionCreate', _formHandler);
    _client.on('interactionCreate', _submitHandler);

    // Clean up listeners after 10 minutes
    setTimeout(() => {
      _client.off('interactionCreate', _formHandler);
      _client.off('interactionCreate', _submitHandler);
      interaction.editReply({
        content: '⏱️ This form has expired.',
        components: []
      }).catch(() => {});
    }, 10 * 60 * 1000);
    } catch (err) {
      _logger?.error?.(`/apply error: ${err.message}`);
      const m = '⚠️ Something went wrong.';
      if (interaction.deferred) await interaction.editReply(m).catch(() => {});
      else if (!interaction.replied) await interaction.reply({ content: m, ephemeral: true }).catch(() => {});
    }
  },
};
