const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCommandBuilder } = require('../utils/builders');

const DEFAULT_PER_CHANNEL_LIMIT = parseInt(process.env.DEFAULT_PER_CHANNEL_LIMIT || '0', 10); // 0 = unlimited
const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'exports');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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

function extractFirstGameUid(msg) {
  const regex = /\b\d{9,13}\b/g;
  const pieces = [];

  if (msg.content) pieces.push(msg.content);

  if (msg.embeds && msg.embeds.length) {
    for (const e of msg.embeds) {
      try {
        if (e.title) pieces.push(e.title);
        if (e.description) pieces.push(e.description);
        if (e.footer && e.footer.text) pieces.push(e.footer.text);
        if (e.author && e.author.name) pieces.push(e.author.name);
        if (Array.isArray(e.fields)) {
          for (const f of e.fields) {
            if (f.name) pieces.push(f.name);
            if (f.value) pieces.push(f.value);
          }
        }
      } catch (err) {}
    }
  }

  if (msg.attachments && msg.attachments.size) {
    for (const a of msg.attachments.values()) {
      if (a.name) pieces.push(a.name);
      if (a.url) pieces.push(a.url);
    }
  }

  const joined = pieces.join('\n ');
  const matches = joined.match(regex) || [];
  return matches.length ? matches[0] : '';
}

function messageToCsvRowMinimal(msg) {
  const author = msg.author || { id: '', username: '', discriminator: '' };
  const discordUserIdText = `'${sanitizeForCsv(author.id)}`;
  const discordUsername = sanitizeForCsv(`${author.username || ''}#${author.discriminator || ''}`);
  const gameUid = sanitizeForCsv(extractFirstGameUid(msg));
  const content = sanitizeForCsv(msg.content || '');

  return [
    escapeCsv(discordUserIdText),
    escapeCsv(discordUsername),
    escapeCsv(gameUid),
    escapeCsv(content)
  ].join(',');
}

async function fetchAllMessagesFromChannel(channel, limit = 0) {
  if (!channel || !channel.isTextBased()) return [];

  const messages = [];
  let lastId;
  const perRequest = 100;
  let totalFetched = 0;
  const maxCap = limit > 0 ? limit : Infinity;

  const MAX_ATTEMPTS = 6;
  const BASE_DELAY_MS = 600;

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
        const msg = `Attempt ${attempt}/${MAX_ATTEMPTS} failed to fetch (before=${options.before || 'none'}): ${err.message || err}`;
        console.warn(`[${channel.id}] ${msg}`);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      }
    }

    if (!success) {
      console.error(`[${channel.id}] Failed to fetch batch after ${MAX_ATTEMPTS} attempts. Aborting channel fetch.`);
      break;
    }

    if (!batch || !batch.size) {
      break;
    }

    const batchArray = Array.from(batch.values());
    messages.push(...batchArray);
    totalFetched += batchArray.length;
    lastId = batchArray[batchArray.length - 1].id;

    if (totalFetched >= maxCap) break;
    await new Promise(r => setTimeout(r, 300));
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
  const perRequest = 100;

  while (true) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: perRequest, before: lastId });
    } catch (err) {
      console.warn(`[${channel.id}] Range fetch failed to fetch (before=${lastId}): ${err.message || err}`);
      break;
    }

    if (!batch || !batch.size) break;

    for (const m of batch.values()) collected.set(m.id, m);
    const arr = Array.from(batch.values());
    const oldestInBatch = arr[arr.length - 1];

    if (collected.has(olderMsg.id)) break;
    if (oldestInBatch.createdTimestamp <= olderMsg.createdTimestamp) break;

    lastId = oldestInBatch.id;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!collected.has(olderMsg.id)) {
    try {
      const fetchedStart = await channel.messages.fetch(olderMsg.id);
      if (fetchedStart) collected.set(fetchedStart.id, fetchedStart);
    } catch (_) {}
  }

  const minTs = olderMsg.createdTimestamp;
  const maxTs = newerMsg.createdTimestamp;
  const arr = Array.from(collected.values()).filter(m => m.createdTimestamp >= minTs && m.createdTimestamp <= maxTs);
  arr.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return arr;
}

async function buildCsvForMessages(messages) {
  const header = ['discord_user_id', 'discord_username', 'game_uid', 'message_content'];
  const rows = [ header.map(escapeCsv).join(',') ];

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  for (const msg of messages) rows.push(messageToCsvRowMinimal(msg));
  return rows.join('\n');
}

module.exports = {
  data: createCommandBuilder({
    name: 'export',
    description: 'Export messages in a channel or between two message IDs to a CSV',
    configure: builder => builder
      .addChannelOption(o => o.setName('channel').setDescription('Channel to export (optional, defaults to current channel)').setRequired(false))
      .addStringOption(o => o.setName('start_id').setDescription('Start message ID (optional, used with end_id)').setRequired(false))
      .addStringOption(o => o.setName('end_id').setDescription('End message ID (optional, used with start_id)').setRequired(false))
      .addIntegerOption(o => o.setName('limit').setDescription('Max messages to fetch (0 = unlimited)').setRequired(false)),
  }),
  cooldown: 30,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const optionChannel = interaction.options.getChannel('channel', false);
      const startId = interaction.options.getString('start_id', false);
      const endId = interaction.options.getString('end_id', false);
      const limitOption = interaction.options.getInteger('limit', false);
      const invokingChannel = interaction.channel;
      const targetChannel = optionChannel || invokingChannel;

      if (!targetChannel || !targetChannel.isTextBased?.()) {
        return interaction.editReply('Please run this in a text channel or provide a text channel.');
      }

      const perms = targetChannel.permissionsFor(interaction.client.user);
      if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('I need View Channel and Read Message History permissions in the target channel.');
      }

      await interaction.followUp({ ephemeral: true, content: 'Starting export — this may take a while. I will show a small preview when done.' });

      let messages = [];
      if (startId && endId) {
        messages = await fetchMessagesBetween(targetChannel, startId, endId);
      } else {
        const limit = (limitOption && limitOption > 0) ? limitOption : DEFAULT_PER_CHANNEL_LIMIT;
        messages = await fetchAllMessagesFromChannel(targetChannel, limit);
      }

      if (!messages.length) {
        const emptyCsv = (['discord_user_id', 'discord_username', 'game_uid', 'message_content'].map(escapeCsv).join(','));
        const emptyPath = path.join(outputDir, `export_empty_${targetChannel.id}_${Date.now()}.csv`);
        fs.writeFileSync(emptyPath, '\uFEFF' + emptyCsv, 'utf8');
        const emptyBuffer = fs.readFileSync(emptyPath);
        const emptyFile = new AttachmentBuilder(emptyBuffer, { name: path.basename(emptyPath) });
        await interaction.editReply({ content: 'No messages found in the specified range/channel. Attached empty CSV with header.', files: [emptyFile] });
        return;
      }

      const csv = await buildCsvForMessages(messages);
      const safeChannelName = (targetChannel.name || 'channel').replace(/[^\w-]/g, '_').slice(0, 40);
      const filename = `export_minimal_${safeChannelName}_${targetChannel.id}_${Date.now()}.csv`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, '\uFEFF' + csv, 'utf8');

      let stat;
      try { stat = fs.statSync(filepath); } catch (stErr) {
        console.error('Failed to stat CSV file:', stErr);
        return interaction.editReply(`Export complete but failed to access file on disk: ${stErr?.message || String(stErr)}`);
      }

      if (!stat || stat.size === 0) {
        const previewText = `Preview (first few data rows):\n\`\`\`csv\n${csv.split('\n').slice(0, 6).join('\n')}\n\`\`\``;
        return interaction.editReply({ content: `Export produced an empty file (${stat.size} bytes). Preview:\n${previewText}` });
      }

      const buffer = fs.readFileSync(filepath);
      const file = new AttachmentBuilder(buffer, { name: filename });

      const firstLines = csv.split('\n').slice(0, 6).join('\n');
      const previewText = `Preview (first ${Math.min(5, csv.split('\n').length - 1)} data rows):\n\`\`\`csv\n${firstLines}\n\`\`\``;

      try {
        await interaction.user.send({ content: `Here is the export for ${targetChannel} (${messages.length} messages)`, files: [file] });
        await interaction.editReply({ content: `Export complete. CSV sent to your DMs. (${messages.length} messages)` });
        await interaction.followUp({ content: previewText, ephemeral: true }).catch(() => null);
        return;
      } catch (err) {
        console.warn('Failed to DM user with CSV:', err && err.message ? err.message : err);
        try { fs.appendFileSync(path.join(outputDir, `progress_${targetChannel.id}.log`), `[${new Date().toISOString()}] DM failed for ${interaction.user.id}: ${err && err.message ? err.message : String(err)}\n`); } catch (_) {}
        try {
          await invokingChannel.send({ content: `Export for ${targetChannel} (${messages.length} messages) — you have DMs disabled, so I'm posting the CSV here.`, files: [file] });
          await interaction.editReply({ content: `Export complete. CSV attached in this channel because I couldn't DM you. (${messages.length} messages)` });
          await interaction.followUp({ content: previewText, ephemeral: true }).catch(() => null);
          return;
        } catch (sendErr) {
          console.error('Failed to send file in invoking channel as fallback:', sendErr);
          await interaction.editReply({ content: `Export complete but I couldn't send the file via DM or in this channel. The CSV is saved at ${filepath} on the machine running the bot. Preview:\n${previewText}` });
          return;
        }
      }
    } catch (err) {
      console.error('export command error:', err);
      try { await interaction.editReply({ content: `Error while exporting: ${err?.message || String(err)}` }); } catch {}
    }
  }
};
