const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCommandBuilder } = require('../utils/builders');

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'exports');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const DEFAULT_SCAN_LIMIT = parseInt(process.env.DEFAULT_PER_CHANNEL_LIMIT || '0', 10); // 0 = unlimited
const SAFETY_MAX_SCAN = 50000; // hard cap to avoid runaway scans
const BATCH_SIZE = 100; // messages per fetch
const PROGRESS_UPDATE_EVERY = 500; // update interaction after this many messages processed

function sanitizeForCsv(input, maxLen = 10000) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  s = s.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + '...';
  return s;
}
function escapeCsv(value) {
  const s = sanitizeForCsv(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/** Parse a message link or plain message id. */
function parseMessageLinkOrId(input) {
  if (!input) return null;
  const str = input.trim();
  try {
    const url = new URL(str);
    const parts = url.pathname.split('/').filter(Boolean);
    // expect /channels/<guildId>/<channelId>/<messageId>
    const idx = parts.indexOf('channels');
    if (idx >= 0 && parts.length >= idx + 4) {
      return { guildId: parts[idx + 1], channelId: parts[idx + 2], messageId: parts[idx + 3] };
    }
  } catch (e) {
    // not a URL
  }
  if (/^\d{17,19}$/.test(str)) return { messageId: str };
  return null;
}

/**
 * Stream messages forward from a channel (newer messages),
 * calling onBatch(arr) for each batch (arr sorted oldest->newest).
 */
async function streamMessagesForward(channel, startAfterId = null, limit = 0, onBatch = null) {
  if (!channel || !channel.isTextBased?.()) return 0;

  let effectiveCap = SAFETY_MAX_SCAN;
  if (limit > 0) effectiveCap = Math.min(limit, SAFETY_MAX_SCAN);
  else if (DEFAULT_SCAN_LIMIT > 0) effectiveCap = Math.min(DEFAULT_SCAN_LIMIT, SAFETY_MAX_SCAN);

  let totalProcessed = 0;
  let afterId = startAfterId || null;
  const MAX_ATTEMPTS = 6;
  const BASE_DELAY_MS = 600;

  while (totalProcessed < effectiveCap) {
    const fetchLimit = Math.min(BATCH_SIZE, effectiveCap - totalProcessed);
    const options = { limit: fetchLimit };
    if (afterId) options.after = afterId;

    let batch = null;
    let success = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        batch = await channel.messages.fetch(options);
        success = true;
        break;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      }
    }

    if (!success || !batch || !batch.size) break;

    const arr = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (typeof onBatch === 'function') {
      try {
        await onBatch(arr);
      } catch (err) {
        console.warn('onBatch callback error:', err);
      }
    }

    totalProcessed += arr.length;
    afterId = arr[arr.length - 1].id;

    if (arr.length < fetchLimit) break;

    await new Promise(r => setTimeout(r, 120));
  }

  return totalProcessed;
}

module.exports = {
  data: createCommandBuilder({
    name: 'exportinvites',
    description: 'Export unique users who posted a keyword to CSV',
    configure: builder => builder
      .addChannelOption(o => o.setName('channel').setDescription('Channel to scan (defaults to current)').setRequired(false))
      .addStringOption(o => o.setName('keyword').setDescription('Keyword to search (default: !invites)').setRequired(false))
      .addStringOption(o => o.setName('after').setDescription('Start scanning AFTER this message link or ID').setRequired(false))
      .addIntegerOption(o => o.setName('limit').setDescription('Max messages to scan (0 = unlimited)').setRequired(false)),
  })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  cooldown: 15,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => null);

    try {
      const invokingChannel = interaction.channel; // where the command was run — CSV will be posted here
      const targetChannel = interaction.options.getChannel('channel') || invokingChannel; // where to scan
      if (!targetChannel || !targetChannel.isTextBased?.()) {
        return interaction.editReply('Please provide a text channel or run this command in a text channel.');
      }

      const rawKeyword = (interaction.options.getString('keyword') || '!invites').trim();
      if (!rawKeyword) return interaction.editReply('Keyword cannot be empty.');
      const keyword = rawKeyword.toLowerCase();

      const afterOpt = interaction.options.getString('after', false);
      let startAfterId = null;
      if (afterOpt && afterOpt.trim()) {
        const parsed = parseMessageLinkOrId(afterOpt.trim());
        if (!parsed || !parsed.messageId) {
          return interaction.editReply('Invalid "after" value. Provide a message link or ID.');
        }
        // If link includes channelId and it doesn't match target channel, reject to avoid confusion
        if (parsed.channelId && parsed.channelId !== targetChannel.id) {
          return interaction.editReply('The "after" message link must belong to the same channel you want to scan (or omit channel).');
        }
        startAfterId = parsed.messageId;
      }

      const limitOption = interaction.options.getInteger('limit', false) ?? 0;
      const requestedLimit = (limitOption && limitOption > 0) ? limitOption : 0;

      const startMsg = startAfterId ? `starting after message ${startAfterId}` : 'starting from channel beginning/recent messages';
      await interaction.followUp({
        content: `Scanning ${targetChannel} for "${rawKeyword}" (${startMsg}). Scanning up to ${requestedLimit > 0 ? requestedLimit : 'the safety cap'} messages. CSV will be posted in ${invokingChannel}.`,
        ephemeral: true
      }).catch(() => null);

      // Ensure bot has read access to targetChannel (best-effort)
      try {
        const perms = targetChannel.permissionsFor(interaction.client.user);
        if (!perms || !perms.has?.(PermissionFlagsBits.ViewChannel) || !perms.has?.(PermissionFlagsBits.ReadMessageHistory)) {
          await interaction.followUp({ content: `Warning: I may not have full access to ${targetChannel}. I will try to scan what I can.`, ephemeral: true }).catch(() => null);
        }
      } catch {}

      const users = new Map();
      let processedMessages = 0;

      const onBatch = async (messagesArr) => {
        for (const msg of messagesArr) {
          processedMessages++;
          try {
            const content = (msg.content || '').toLowerCase();
            if (!content.includes(keyword)) continue;

            const author = msg.author || null;
            const userId = author ? author.id : `unknown-${msg.id}`;

            const entry = users.get(userId) || {
              userId,
              username: author ? `${author.username}#${author.discriminator}` : '<unknown>',
              count: 0,
              firstMessageId: msg.id,
              lastMessageId: msg.id,
              firstMessageContent: msg.content || '',
              lastMessageContent: msg.content || '',
              firstTimestamp: msg.createdTimestamp,
              lastTimestamp: msg.createdTimestamp
            };

            entry.count += 1;

            if (msg.createdTimestamp < (entry.firstTimestamp || Infinity)) {
              entry.firstTimestamp = msg.createdTimestamp;
              entry.firstMessageId = msg.id;
              entry.firstMessageContent = msg.content || '';
            }
            if (msg.createdTimestamp > (entry.lastTimestamp || 0)) {
              entry.lastTimestamp = msg.createdTimestamp;
              entry.lastMessageId = msg.id;
              entry.lastMessageContent = msg.content || '';
            }

            users.set(userId, entry);
          } catch (err) {
            // ignore per-message errors
          }

          if ((processedMessages % PROGRESS_UPDATE_EVERY) === 0) {
            try {
              await interaction.editReply({ content: `Scanning ${targetChannel}: processed ${processedMessages} messages, found ${users.size} unique users so far...` });
            } catch {}
          }
        }
      };

      // perform the scanning (only messages after startAfterId if provided)
      const scanned = await streamMessagesForward(targetChannel, startAfterId, requestedLimit, onBatch);

      // If nothing matched, post a short summary in invokingChannel and finish
      if (!users.size) {
        try {
          await invokingChannel.send({ content: `${interaction.user} — Scan complete. Processed ${scanned} messages in ${targetChannel}. No messages containing "${rawKeyword}" were found.` });
        } catch {}
        return interaction.editReply(`Scan complete. Processed ${scanned} messages. No matches found. Summary posted in ${invokingChannel}.`);
      }

      // Build CSV rows (one row per unique user)
      const header = [
        'discord_user_id',
        'discord_username',
        'messages_count',
        'first_message_id',
        'first_message_ts',
        'first_message_content',
        'last_message_id',
        'last_message_ts',
        'last_message_content',
        'first_message_link',
        'last_message_link'
      ];
      const rows = [ header.map(escapeCsv).join(',') ];

      for (const u of users.values()) {
        const firstLink = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${u.firstMessageId}`;
        const lastLink = `https://discord.com/channels/${interaction.guildId}/${targetChannel.id}/${u.lastMessageId}`;
        const userIdCell = `="${u.userId}"`; // Excel-safe
        const row = [
          escapeCsv(userIdCell),
          escapeCsv(u.username),
          escapeCsv(String(u.count)),
          escapeCsv(u.firstMessageId),
          escapeCsv(new Date(u.firstTimestamp).toISOString()),
          escapeCsv(u.firstMessageContent),
          escapeCsv(u.lastMessageId),
          escapeCsv(new Date(u.lastTimestamp).toISOString()),
          escapeCsv(u.lastMessageContent),
          escapeCsv(firstLink),
          escapeCsv(lastLink)
        ].join(',');
        rows.push(row);
      }

      const csv = rows.join('\n');
      const filename = `invites_unique_${targetChannel.id}_${Date.now()}.csv`;
      const filepath = path.join(OUTPUT_DIR, filename);
      fs.writeFileSync(filepath, '\uFEFF' + csv, 'utf8');
      const buffer = fs.readFileSync(filepath);
      const attachment = new AttachmentBuilder(buffer, { name: filename });

      // Post CSV in the invoking channel (where the command was run)
      let postedInInvoking = false;
      try {
        const permsInv = invokingChannel.permissionsFor(interaction.client.user);
        if (permsInv && permsInv.has?.(PermissionFlagsBits.SendMessages) && permsInv.has?.(PermissionFlagsBits.AttachFiles)) {
          await invokingChannel.send({
            content: `${interaction.user} — Scan complete. Processed ${scanned} messages in ${targetChannel}, found ${users.size} unique users who posted "${rawKeyword}". CSV attached.`,
            files: [attachment]
          });
          postedInInvoking = true;
        } else if (permsInv && permsInv.has?.(PermissionFlagsBits.SendMessages)) {
          await invokingChannel.send({
            content: `${interaction.user} — Scan complete. Processed ${scanned} messages in ${targetChannel}, found ${users.size} unique users who posted "${rawKeyword}". File saved at: ${filepath}`
          });
          postedInInvoking = true;
        }
      } catch (err) {
        console.warn('Failed to post CSV in invoking channel:', err);
      }

      // If posting to invoking channel failed, try DM the invoker; if that fails, as a last resort try posting to targetChannel
      if (postedInInvoking) {
        await interaction.editReply({ content: `Scan complete. Processed ${scanned} messages, found ${users.size} unique users. CSV posted in ${invokingChannel}.` });
        return;
      }

      let dmSent = false;
      try {
        await interaction.user.send({ content: `Scan complete for ${targetChannel}. Processed ${scanned} messages, found ${users.size} unique users who posted "${rawKeyword}".`, files: [attachment] });
        dmSent = true;
      } catch (err) {
        // DM failed
      }

      if (dmSent) {
        await interaction.editReply({ content: `Scan complete. Processed ${scanned} messages, found ${users.size} unique users. CSV sent to your DMs (couldn't post in invoking channel).` });
        return;
      }

      // Final fallback: try posting to targetChannel if possible
      try {
        const permsTarget = targetChannel.permissionsFor(interaction.client.user);
        if (permsTarget && permsTarget.has?.(PermissionFlagsBits.SendMessages) && permsTarget.has?.(PermissionFlagsBits.AttachFiles)) {
          await targetChannel.send({
            content: `${interaction.user} — Scan complete. Processed ${scanned} messages, found ${users.size} unique users who posted "${rawKeyword}". CSV attached.`,
            files: [attachment]
          });
          await interaction.editReply({ content: `Scan complete. Processed ${scanned} messages, found ${users.size} unique users. CSV posted in ${targetChannel} as a fallback.` });
          return;
        }
      } catch (err) {
        // ignore
      }

      // All deliveries failed; tell the invoker where the file is on host
      await interaction.editReply({ content: `Scan complete. Processed ${scanned} messages, found ${users.size} unique users. I couldn't post the CSV (no permissions). File saved at: ${filepath}` });
    } catch (err) {
      console.error('exportinvites error:', err);
      try { await interaction.editReply({ content: `Error while running exportinvites: ${err?.message || String(err)}` }); } catch {}
    }
  }
};
