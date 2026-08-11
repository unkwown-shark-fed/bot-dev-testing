const { PermissionFlagsBits } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

const DEFAULT_MAX_SEND = parseInt(process.env.REPOST_MAX_SEND || '200', 10); // safety cap
const DEFAULT_PER_REQUEST = 100;
const BASE_DELAY_MS = 600;

function sanitizeContentForRepost(text, sanitize = true, maxLen = 1900) {
  if (!text) return '';
  let s = String(text);
  if (sanitize) {
    s = s.replace(/<@!?/g, '<@\u200b').replace(/<@&/g, '<@&\u200b').replace(/@everyone/g, '@\u200beveryone').replace(/@here/g, '@\u200bhere');
  }
  s = s.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
  return s;
}

function buildMessageLink(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return '';
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

async function fetchAllMessagesFromChannel(channel, limit = 0) {
  if (!channel || !channel.isTextBased()) return [];

  const messages = [];
  let lastId;
  const perRequest = DEFAULT_PER_REQUEST;
  let totalFetched = 0;
  const maxCap = limit > 0 ? limit : Infinity;

  const MAX_ATTEMPTS = 6;

  while (true) {
    const options = { limit: perRequest };
    if (lastId) options.before = lastId;

    let batch;
    let success = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        batch = await channel.messages.fetch(options);
        success = true;
        break;
      } catch (err) {
        console.warn(`[${channel.id}] fetch attempt ${attempt} failed: ${err?.message || err}`);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      }
    }

    if (!success) {
      console.error(`[${channel.id}] Failed to fetch after ${MAX_ATTEMPTS} attempts, aborting.`);
      break;
    }

    if (!batch || !batch.size) break;

    const arr = Array.from(batch.values());
    messages.push(...arr);
    totalFetched += arr.length;
    lastId = arr[arr.length - 1].id;

    if (totalFetched >= maxCap) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (limit > 0 && messages.length > limit) return messages.slice(0, limit);
  return messages;
}

async function fetchMessagesBetween(channel, startId, endId) {
  let startMsg = null;
  let endMsg = null;
  try { startMsg = await channel.messages.fetch(startId); } catch (_) {}
  try { endMsg = await channel.messages.fetch(endId); } catch (_) {}

  if (!startMsg) throw new Error(`Start message (${startId}) could not be fetched (deleted or inaccessible).`);
  if (!endMsg) throw new Error(`End message (${endId}) could not be fetched (deleted or inaccessible).`);

  let olderMsg = startMsg;
  let newerMsg = endMsg;
  if (startMsg.createdTimestamp > endMsg.createdTimestamp) {
    olderMsg = endMsg;
    newerMsg = startMsg;
  }

  const collected = new Map();
  collected.set(newerMsg.id, newerMsg);
  let lastId = newerMsg.id;
  const perRequest = DEFAULT_PER_REQUEST;

  while (true) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: perRequest, before: lastId });
    } catch (err) {
      console.warn(`[${channel.id}] range fetch failed: ${err?.message || err}`);
      break;
    }

    if (!batch || !batch.size) break;

    for (const m of batch.values()) collected.set(m.id, m);
    const arr = Array.from(batch.values());
    const oldestInBatch = arr[arr.length - 1];

    if (collected.has(olderMsg.id)) break;
    if (oldestInBatch.createdTimestamp <= olderMsg.createdTimestamp) break;

    lastId = oldestInBatch.id;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!collected.has(olderMsg.id)) {
    try {
      const f = await channel.messages.fetch(olderMsg.id);
      if (f) collected.set(f.id, f);
    } catch (_) {}
  }

  const minTs = olderMsg.createdTimestamp;
  const maxTs = newerMsg.createdTimestamp;
  const arr = Array.from(collected.values()).filter(m => m.createdTimestamp >= minTs && m.createdTimestamp <= maxTs);
  arr.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return arr;
}

function buildRepostText(msg, options) {
  const { sanitizeMentions = true, includeOriginalLink = false } = options || {};
  const author = msg.author ? `${msg.author.username}#${msg.author.discriminator}` : 'Unknown';
  const when = new Date(msg.createdTimestamp).toLocaleString();
  const content = sanitizeContentForRepost(msg.content || '', sanitizeMentions);
  const attachments = msg.attachments && msg.attachments.size ? Array.from(msg.attachments.values()).map(a => a.url).join(' ') : '';
  const link = includeOriginalLink ? `\nOriginal: ${buildMessageLink(msg.guildId, msg.channelId, msg.id)}` : '';

  let body = `**${author}** — ${when}\n${content}`;
  if (attachments) body += `\n\nAttachments: ${attachments}`;
  if (link) body += `\n${link}`;
  if (body.length > 1900) body = body.slice(0, 1900) + '...';
  return body;
}

module.exports = {
  data: createCommandBuilder({
    name: 'repost',
    description: 'Fetch messages (range or last N) and repost them as messages in a target channel (no CSV).',
    configure: builder => builder
      .addChannelOption(o => o.setName('source').setDescription('Source channel to fetch from (defaults to current channel)').setRequired(false))
      .addStringOption(o => o.setName('start_id').setDescription('Start message ID (used with end_id)').setRequired(false))
      .addStringOption(o => o.setName('end_id').setDescription('End message ID (used with start_id)').setRequired(false))
      .addIntegerOption(o => o.setName('limit').setDescription('Max messages to fetch and repost (default 50, max controlled)').setRequired(false))
      .addChannelOption(o => o.setName('target').setDescription('Where to post the reposted messages (defaults to current channel)').setRequired(false))
      .addBooleanOption(o => o.setName('sanitize').setDescription('Sanitize mentions to avoid pings (default true)').setRequired(false))
      .addBooleanOption(o => o.setName('include_link').setDescription('Include original message link beneath each repost (default false)').setRequired(false)),
  })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  cooldown: 10,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const source = interaction.options.getChannel('source') || interaction.channel;
      const startId = interaction.options.getString('start_id', false);
      const endId = interaction.options.getString('end_id', false);
      const limitOption = interaction.options.getInteger('limit', false);
      const target = interaction.options.getChannel('target') || interaction.channel;
      const sanitize = interaction.options.getBoolean('sanitize') ?? true;
      const includeLink = interaction.options.getBoolean('include_link') ?? false;

      if (!source || !source.isTextBased?.()) return interaction.editReply('Please provide a valid source text channel.');
      if (!target || !target.isTextBased?.()) return interaction.editReply('Please provide a valid target text channel.');

      const srcPerms = source.permissionsFor(interaction.client.user);
      const tgtPerms = target.permissionsFor(interaction.client.user);
      if (!srcPerms || !srcPerms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('I need View Channel and Read Message History permissions in the source channel.');
      }
      if (!tgtPerms || !tgtPerms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return interaction.editReply('I need Send Messages permission in the target channel.');
      }

      const userLimit = (limitOption && limitOption > 0) ? limitOption : 50;
      const maxAllowed = Math.max(50, DEFAULT_MAX_SEND);
      if (userLimit > maxAllowed) return interaction.editReply(`Limit too large; max allowed is ${maxAllowed} per invocation.`);

      await interaction.followUp({ ephemeral: true, content: `Fetching messages from ${source} (this may take a while)...` });

      let messages = [];
      if (startId && endId) {
        messages = await fetchMessagesBetween(source, startId, endId);
      } else {
        // fetchAllMessagesFromChannel returns messages newest-first (Discord's
        // default fetch order). Reverse so they get reposted oldest-first,
        // preserving the original conversation order in the target channel.
        messages = await fetchAllMessagesFromChannel(source, userLimit);
        messages.reverse();
      }

      if (!messages || messages.length === 0) {
        return interaction.editReply('No messages found in the specified range or channel.');
      }

      if (userLimit > 0 && messages.length > userLimit) messages = messages.slice(messages.length - userLimit);

      const repostOptions = { sanitizeMentions: sanitize, includeOriginalLink: includeLink };
      let sentCount = 0;
      for (const m of messages) {
        const repostText = buildRepostText(m, repostOptions);
        try {
          await target.send({ content: repostText });
          sentCount++;
        } catch (sendErr) {
          console.warn(`Failed to send repost for message ${m.id} in ${target.id}:`, sendErr?.message || sendErr);
        }
        await new Promise(r => setTimeout(r, 700));
      }

      await interaction.editReply(`Reposted ${sentCount}/${messages.length} messages from ${source} into ${target}.`);
    } catch (err) {
      console.error('repost command error:', err);
      try { await interaction.editReply({ content: `Error while reposting: ${err?.message || String(err)}` }); } catch {}
    }
  }
};