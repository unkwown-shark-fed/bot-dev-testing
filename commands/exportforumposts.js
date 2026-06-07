const { AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const { createCommandBuilder } = require('../utils/builders');

function sanitizeText(value, maxLen = 12000) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}...`;
  return s;
}

function excelSafeId(id) {
  if (!id) return '';
  return `="${id}"`;
}

function extractNumericUids(text) {
  const matches = String(text || '').match(/\b\d{9,13}\b/g) || [];
  return [...new Set(matches)];
}

async function fetchAllMessages(thread) {
  const out = [];
  let before;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const batch = await thread.messages.fetch(options).catch(() => null);
    if (!batch || !batch.size) break;

    const arr = Array.from(batch.values());
    out.push(...arr);
    before = arr[arr.length - 1].id;

    if (arr.length < 100) break;
    await new Promise(r => setTimeout(r, 120));
  }

  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function fetchAllForumPosts(forumChannel) {
  const posts = new Map();

  const active = await forumChannel.threads.fetchActive().catch(() => null);
  if (active?.threads?.size) {
    for (const thread of active.threads.values()) posts.set(thread.id, thread);
  }

  let before = undefined;
  let hasMore = true;
  while (hasMore) {
    const archived = await forumChannel.threads.fetchArchived({
      type: 'public',
      fetchAll: false,
      limit: 100,
      before
    }).catch(() => null);

    if (!archived || !archived.threads?.size) break;

    const archivedThreads = Array.from(archived.threads.values());
    for (const thread of archivedThreads) posts.set(thread.id, thread);

    const oldest = archivedThreads[archivedThreads.length - 1];
    before = oldest?.id;
    hasMore = Boolean(archived.hasMore);

    await new Promise(r => setTimeout(r, 120));
  }

  return Array.from(posts.values()).sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0));
}

module.exports = {
  data: createCommandBuilder({
    name: 'exportforumposts',
    description: 'Export all messages from every post in a forum channel to CSV',
    configure: builder => builder
      .addChannelOption(opt =>
        opt
          .setName('forum')
          .setDescription('Forum channel to scan')
          .setRequired(true)
      )
      .addIntegerOption(opt =>
        opt
          .setName('max_posts')
          .setDescription('Optional safety cap for number of posts to scan (default: all)')
          .setMinValue(1)
          .setMaxValue(10000)
          .setRequired(false)
      )
      .addIntegerOption(opt =>
        opt
          .setName('max_messages_per_post')
          .setDescription('Optional cap per post (default: all)')
          .setMinValue(1)
          .setMaxValue(50000)
          .setRequired(false)
      )
  }).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  cooldown: 20,

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });

    const forumChannel = interaction.options.getChannel('forum', true);
    const maxPosts = interaction.options.getInteger('max_posts', false) ?? 0;
    const maxMessagesPerPost = interaction.options.getInteger('max_messages_per_post', false) ?? 0;

    if (forumChannel.type !== ChannelType.GuildForum) {
      return interaction.editReply('Please provide a **forum channel**.');
    }

    const perms = forumChannel.permissionsFor(interaction.client.user);
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      return interaction.editReply('I need **View Channel** and **Read Message History** permissions in that forum channel.');
    }

    await interaction.editReply(`Scanning forum **${forumChannel.name}**... this may take a while for large forums.`);

    const allPosts = await fetchAllForumPosts(forumChannel);
    const posts = maxPosts > 0 ? allPosts.slice(0, maxPosts) : allPosts;

    if (!posts.length) {
      return interaction.editReply('No posts found in that forum channel.');
    }

    const rows = [];
    let scannedPosts = 0;

    for (const post of posts) {
      scannedPosts += 1;
      const messages = await fetchAllMessages(post);
      const postMessages = maxMessagesPerPost > 0 ? messages.slice(0, maxMessagesPerPost) : messages;

      for (const msg of postMessages) {
        const safeContent = sanitizeText(msg.content || '');
        const uids = extractNumericUids(safeContent);

        rows.push({
          forumChannelName: forumChannel.name,
          forumChannelId: excelSafeId(forumChannel.id),
          postName: sanitizeText(post.name || post.id),
          postId: excelSafeId(post.id),
          messageId: excelSafeId(msg.id),
          userId: excelSafeId(msg.author?.id || ''),
          messageContent: safeContent,
          extractedNumericUids: uids.join('|'),
          messageLink: `https://discord.com/channels/${interaction.guildId}/${post.id}/${msg.id}`,
          timestampIso: new Date(msg.createdTimestamp).toISOString()
        });
      }

      if (scannedPosts % 10 === 0) {
        await interaction.editReply(`Scanning forum **${forumChannel.name}**... processed ${scannedPosts}/${posts.length} posts, collected ${rows.length} messages.`).catch(() => null);
      }
    }

    const columns = [
      'forumChannelName',
      'forumChannelId',
      'postName',
      'postId',
      'messageId',
      'userId',
      'messageContent',
      'extractedNumericUids',
      'messageLink',
      'timestampIso'
    ];

    const csv = stringify(rows, { header: true, columns });
    const filename = `forum-post-messages-${forumChannel.id}-${Date.now()}.csv`;
    const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: filename });

    const summary = `Finished. Posts scanned: ${posts.length}/${allPosts.length}. Messages exported: ${rows.length}.`;

    try {
      await interaction.user.send({
        content: `${summary}\nForum: ${forumChannel.name}`,
        files: [file]
      });
      return interaction.editReply(`✅ ${summary} Export sent to your DMs.`);
    } catch {
      return interaction.editReply({
        content: `✅ ${summary} Couldn't DM you, so attaching the CSV here.`,
        files: [file]
      });
    }
  }
};
