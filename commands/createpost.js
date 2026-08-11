const {
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

// ─── In-memory bulk sessions ───────────────────────────────────────────────
// Structure: Map<userId, { forumChannel, posts: [{title, message}], message }>
const bulkSessions = new Map();

// Auto-expire sessions after 30 minutes of inactivity
const SESSION_TTL_MS = 30 * 60 * 1000;

function clearSession(userId) {
  bulkSessions.delete(userId);
}

function touchSession(userId) {
  const session = bulkSessions.get(userId);
  if (session) {
    clearTimeout(session._timer);
    session._timer = setTimeout(() => clearSession(userId), SESSION_TTL_MS);
  }
}

// ─── Helper: build the "session status" message components ─────────────────
function buildSessionComponents(postCount) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bulkpost_add')
      .setLabel(`➕ Add Post (${postCount} queued)`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('bulkpost_submit')
      .setLabel('🚀 Post All')
      .setStyle(ButtonStyle.Success)
      .setDisabled(postCount === 0),
    new ButtonBuilder()
      .setCustomId('bulkpost_cancel')
      .setLabel('✖ Cancel')
      .setStyle(ButtonStyle.Danger),
  );
  return [row];
}

function buildSessionContent(session) {
  const lines = session.posts.map(
    (p, i) => `**${i + 1}.** ${p.title}`,
  );
  return (
    `📋 **Bulk Post Session** — <#${session.forumChannel.id}>\n` +
    (lines.length
      ? `\nQueued posts:\n${lines.join('\n')}`
      : '\nNo posts queued yet. Click **Add Post** to begin.') +
    `\n\n*Session expires after 30 minutes of inactivity.*`
  );
}

// ─── Command definition ─────────────────────────────────────────────────────
module.exports = {
  data: createCommandBuilder({
    name: 'createpost',
    description: 'Create one post, or open a bulk session to queue and post many at once',
    configure: builder =>
      builder
        .addChannelOption(o =>
          o
            .setName('forum')
            .setDescription('The forum channel to post in')
            .setRequired(true),
        )
        .addStringOption(o =>
          o
            .setName('title')
            .setDescription('Title of the forum post (single post only)')
            .setRequired(false)
            .setMaxLength(100),
        )
        .addStringOption(o =>
          o
            .setName('message')
            .setDescription('Content / body of the forum post (single post only)')
            .setRequired(false)
            .setMaxLength(2000),
        )
        .addAttachmentOption(o =>
          o
            .setName('image')
            .setDescription('Optional image to attach (single post only)')
            .setRequired(false),
        )
        .addBooleanOption(o =>
          o
            .setName('bulk')
            .setDescription('Open a bulk session to queue and create multiple posts')
            .setRequired(false),
        ),
  }),

  cooldown: 5,

  // ── Main slash command handler ──────────────────────────────────────────
  async execute(interaction, client, logger) {
    const log = logger || console;

    const forumChannel = interaction.options.getChannel('forum', true);
    const isBulk       = interaction.options.getBoolean('bulk') ?? false;
    const title        = interaction.options.getString('title');
    const message      = interaction.options.getString('message');
    const attachment   = interaction.options.getAttachment('image');

    // ── Validate forum channel ──────────────────────────────────────────
    if (forumChannel.type !== ChannelType.GuildForum) {
      return interaction.reply({
        content: '❌ The selected channel is not a forum channel. Please choose a forum channel.',
        ephemeral: true,
      });
    }

    const botPerms = forumChannel.permissionsFor(interaction.guild.members.me);
    if (
      !botPerms?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
      ])
    ) {
      return interaction.reply({
        content:
          '❌ I need **View Channel**, **Send Messages**, and **Create Public Threads** permissions in that forum channel.',
        ephemeral: true,
      });
    }

    // ── BULK MODE ───────────────────────────────────────────────────────
    if (isBulk) {
      // Create or reset session for this user
      const existing = bulkSessions.get(interaction.user.id);
      if (existing) clearTimeout(existing._timer);

      const session = {
        forumChannel,
        posts: [],
        _timer: setTimeout(() => clearSession(interaction.user.id), SESSION_TTL_MS),
      };
      bulkSessions.set(interaction.user.id, session);

      await interaction.reply({
        content: buildSessionContent(session),
        components: buildSessionComponents(0),
        ephemeral: true,
      });

      return;
    }

    // ── SINGLE POST MODE ────────────────────────────────────────────────
    if (!title || !message) {
      return interaction.reply({
        content:
          '❌ For a single post you must provide both **title** and **message**.\n' +
          'To queue multiple posts without filling options every time, use `/createpost forum:#channel bulk:True`.',
        ephemeral: true,
      });
    }

    if (attachment) {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowed.includes(attachment.contentType)) {
        return interaction.reply({
          content: '❌ Only image attachments are supported (JPEG, PNG, GIF, WEBP).',
          ephemeral: true,
        });
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const payload = { content: message };
      if (attachment) payload.files = [attachment.url];

      const thread = await forumChannel.threads.create({
        name: title,
        message: payload,
        reason: `Created by ${interaction.user.tag} via /createpost`,
      });

      log.info?.(
        `createpost: ${interaction.user.tag} → "${title}" in #${forumChannel.name} — ${thread.url}`,
      );

      return interaction.editReply(
        `✅ Forum post created!\n• **Title:** ${title}\n• **Forum:** ${forumChannel}\n• **Link:** ${thread.url}`,
      );
    } catch (err) {
      log.error?.(`createpost error: ${err.message || err}`);
      return interaction.editReply(`❌ Failed to create post: ${err.message}`);
    }
  },

  // ── Button & Modal interaction handler ──────────────────────────────────
  // Wire this up in your interactionCreate event:
  //
  //   if (interaction.isButton() || interaction.isModalSubmit()) {
  //     const cmd = client.commands.get('createpost');
  //     if (cmd?.handleComponent) await cmd.handleComponent(interaction, client, logger);
  //   }
  //
  async handleComponent(interaction, client, logger) {
    const log = logger || console;
    const userId = interaction.user.id;

    // ── "Add Post" button → show modal ─────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'bulkpost_add') {
      const session = bulkSessions.get(userId);
      if (!session) {
        return interaction.reply({
          content: '❌ Session expired. Please run `/createpost` again.',
          ephemeral: true,
        });
      }
      touchSession(userId);

      const modal = new ModalBuilder()
        .setCustomId('bulkpost_modal')
        .setTitle('Add a Forum Post');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('modal_title')
            .setLabel('Post Title')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('modal_message')
            .setLabel('Post Message')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(2000)
            .setRequired(true),
        ),
      );

      return interaction.showModal(modal);
    }

    // ── Modal submit → add post to queue ───────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'bulkpost_modal') {
      const session = bulkSessions.get(userId);
      if (!session) {
        return interaction.reply({
          content: '❌ Session expired. Please run `/createpost` again.',
          ephemeral: true,
        });
      }
      touchSession(userId);

      const title   = interaction.fields.getTextInputValue('modal_title').trim();
      const message = interaction.fields.getTextInputValue('modal_message').trim();

      session.posts.push({ title, message });

      await interaction.update({
        content: buildSessionContent(session),
        components: buildSessionComponents(session.posts.length),
      });

      return;
    }

    // ── "Post All" button → create all queued threads ──────────────────
    if (interaction.isButton() && interaction.customId === 'bulkpost_submit') {
      const session = bulkSessions.get(userId);
      if (!session || session.posts.length === 0) {
        return interaction.update({
          content: '❌ No posts to submit, or session expired.',
          components: [],
        });
      }

      await interaction.update({
        content: `⏳ Creating ${session.posts.length} post(s) — please wait…`,
        components: [],
      });

      const results  = [];
      const failures = [];

      for (const post of session.posts) {
        try {
          const thread = await session.forumChannel.threads.create({
            name: post.title,
            message: { content: post.message },
            reason: `Bulk post by ${interaction.user.tag} via /createpost`,
          });
          results.push(`✅ [${post.title}](${thread.url})`);
          log.info?.(
            `createpost bulk: ${interaction.user.tag} → "${post.title}" in #${session.forumChannel.name}`,
          );
        } catch (err) {
          failures.push(`❌ **${post.title}** — ${err.message}`);
          log.error?.(`createpost bulk error on "${post.title}": ${err.message}`);
        }
      }

      clearSession(userId);

      const summary =
        `📬 **Bulk post complete** — ${results.length} succeeded, ${failures.length} failed.\n\n` +
        [...results, ...failures].join('\n');

      return interaction.editReply({ content: summary, components: [] });
    }

    // ── "Cancel" button ─────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'bulkpost_cancel') {
      clearSession(userId);
      return interaction.update({
        content: '🗑️ Bulk session cancelled. All queued posts have been discarded.',
        components: [],
      });
    }
  },
};