const { AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { stringify } = require('csv-stringify/sync');
const fs = require('fs');
const path = require('path');
const { createCommandBuilder } = require('../utils/builders');
const { excelSafeId } = require('../utils/csv');

const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'exports');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 600;

/**
 * Renders a text progress bar, e.g. "[██████████░░░░░░░░░░] 50%".
 * @param {number} percent 0-100
 * @param {number} size number of segments in the bar
 */
function renderProgressBar(percent, size = 20) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * size);
  return `[${'█'.repeat(filled)}${'░'.repeat(size - filled)}] ${clamped.toFixed(0)}%`;
}

/**
 * Pages backward through `channel` from the newest message, collecting every
 * message authored by `targetUser` on/after `sinceDate`, until it passes the
 * since-date, hits `limit`, or runs out of history. Mirrors export.js's
 * fetchAllMessagesFromChannel retry/backoff behavior.
 *
 * @param {(info: { scanned: number, matched: number, oldest: Date|null }) => void} [onProgress]
 *   Called after each batch is processed so the caller can report progress.
 */
async function fetchUserMessagesSince(channel, targetUser, sinceDate, limit = 0, onProgress) {
  const collected = [];
  let lastId;
  let totalScanned = 0;
  const maxCap = limit > 0 ? limit : Infinity;
  const sinceTs = sinceDate.getTime();
  const startTs = Date.now(); // fixed reference point, so the bar reflects "now" back to `since`
  const totalSpanMs = Math.max(startTs - sinceTs, 1); // avoid divide-by-zero for since=today

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    let batch;
    let success = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        batch = await channel.messages.fetch(options);
        success = true;
        break;
      } catch (err) {
        console.warn(`[${channel.id}] Attempt ${attempt}/${MAX_ATTEMPTS} failed to fetch (before=${options.before || 'none'}): ${err.message || err}`);
        if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      }
    }

    if (!success) {
      console.error(`[${channel.id}] Failed to fetch batch after ${MAX_ATTEMPTS} attempts. Stopping.`);
      break;
    }
    if (!batch || !batch.size) break;

    const batchArray = Array.from(batch.values());
    let hitFloor = false;

    for (const msg of batchArray) {
      totalScanned++;
      if (msg.createdTimestamp < sinceTs) {
        hitFloor = true; // newest-first order, so nothing older matters
        break;
      }
      if (msg.author.id === targetUser.id) {
        collected.push(msg);
        if (collected.length >= maxCap) break;
      }
    }

    lastId = batchArray[batchArray.length - 1].id;
    const oldestSoFar = batchArray[batchArray.length - 1]?.createdTimestamp;

    if (typeof onProgress === 'function') {
      // Time-based estimate: how far back (toward `since`) we've scanned,
      // as a fraction of the full [since, now] span. There's no reliable way
      // to know the true message count up front, so this approximates
      // progress by date coverage rather than message count.
      const percent = oldestSoFar
        ? ((startTs - oldestSoFar) / totalSpanMs) * 100
        : 0;

      onProgress({
        scanned: totalScanned,
        matched: collected.length,
        oldest: oldestSoFar ? new Date(oldestSoFar) : null,
        percent,
      });
    }

    if (hitFloor || collected.length >= maxCap || batchArray.length < 100) break;
    await new Promise(r => setTimeout(r, 300));
  }

  return limit > 0 ? collected.slice(0, limit) : collected;
}

module.exports = {
  category: 'Export',
  data: createCommandBuilder({
    name: 'exportuserhistory',
    description: "Export a specific user's message history from a given date to CSV",
    configure: builder => builder
      .addUserOption(o => o.setName('user').setDescription('The user whose messages to export').setRequired(true))
      .addStringOption(o => o.setName('since').setDescription('Start date, YYYY-MM-DD (messages from this date onward)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to search (defaults to current channel)').setRequired(false))
      .addIntegerOption(o => o.setName('limit').setDescription('Max messages to export (0 = unlimited)').setRequired(false)),
  }),

  restricted: true, // gated by COMMAND_ROLE_ID / admin, same as findids, listusers, etc.
  cooldown: 30,      // same as /export, since this also does a full history walk

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUser = interaction.options.getUser('user', true);
      const sinceRaw = interaction.options.getString('since', true);
      const targetChannel = interaction.options.getChannel('channel', false) || interaction.channel;
      const limitOption = interaction.options.getInteger('limit', false) || 0;

      const sinceDate = new Date(`${sinceRaw}T00:00:00Z`);
      if (Number.isNaN(sinceDate.getTime())) {
        return interaction.editReply('❌ Invalid `since` date. Use the format `YYYY-MM-DD` (e.g. `2026-01-15`).');
      }
      if (sinceDate.getTime() > Date.now()) {
        return interaction.editReply('❌ `since` date cannot be in the future.');
      }

      if (!targetChannel || !targetChannel.isTextBased?.()) {
        return interaction.editReply('Please run this in a text channel or provide a text channel.');
      }

      const perms = targetChannel.permissionsFor(interaction.client.user);
      if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        return interaction.editReply('I need View Channel and Read Message History permissions in the target channel.');
      }

      await interaction.followUp({ ephemeral: true, content: 'Starting export — this may take a while for a long history.' });

      // Throttled progress updates: editReply is rate-limited, so we only push
      // an update at most once every PROGRESS_INTERVAL_MS regardless of how
      // often onProgress fires.
      const PROGRESS_INTERVAL_MS = 2500;
      let lastProgressEdit = 0;
      let progressChain = Promise.resolve();
      const totalScannedRef = { value: 0 };

      const reportProgress = ({ scanned, matched, oldest, percent }) => {
        totalScannedRef.value = scanned;
        const now = Date.now();
        if (now - lastProgressEdit < PROGRESS_INTERVAL_MS) return;
        lastProgressEdit = now;

        const oldestText = oldest ? oldest.toISOString().slice(0, 10) : 'unknown';
        const bar = renderProgressBar(percent);
        // Chain edits so a slow network response can't reorder progress updates.
        progressChain = progressChain
          .then(() => interaction.editReply(
            `⏳ ${bar}\n${scanned.toLocaleString()} messages checked, ${matched.toLocaleString()} match found so far (currently around ${oldestText}).`
          ))
          .catch(err => console.warn('Progress update failed:', err?.message || err));
      };

      const messages = await fetchUserMessagesSince(targetChannel, targetUser, sinceDate, limitOption, reportProgress);
      await progressChain; // make sure the last queued progress edit lands before we overwrite it below

      // Final 100% bar so the bar doesn't visibly stall at whatever % the last
      // throttled update happened to land on.
      if (totalScannedRef.value) {
        await interaction.editReply(
          `⏳ ${renderProgressBar(100)}\nScan complete — ${totalScannedRef.value.toLocaleString()} messages checked, ${messages.length.toLocaleString()} matched. Building CSV…`
        ).catch(() => {});
      }

      messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      const rows = messages.map(msg => ({
        timestamp: new Date(msg.createdTimestamp).toISOString(),
        message_id: excelSafeId(msg.id),
        channel: targetChannel.name || targetChannel.id,
        author_tag: msg.author.tag,
        author_id: excelSafeId(msg.author.id),
        content: (msg.content || '').replace(/\r?\n/g, ' '),
        attachments: Array.from(msg.attachments.values()).map(a => a.url).join(' '),
      }));

      const columns = ['timestamp', 'message_id', 'channel', 'author_tag', 'author_id', 'content', 'attachments'];
      const csv = stringify(rows, { header: true, columns });

      const safeChannelName = (targetChannel.name || 'channel').replace(/[^\w-]/g, '_').slice(0, 40);
      const safeUserName = (targetUser.username || 'user').replace(/[^\w-]/g, '_').slice(0, 40);
      const filename = `userhistory_${safeUserName}_${safeChannelName}_${sinceRaw}_${Date.now()}.csv`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, '\uFEFF' + csv, 'utf8');

      if (!rows.length) {
        const buffer = fs.readFileSync(filepath);
        const emptyFile = new AttachmentBuilder(buffer, { name: filename });
        return interaction.editReply({
          content: `No messages from ${targetUser.tag} found in ${targetChannel} since ${sinceRaw}. Attached empty CSV with header.`,
          files: [emptyFile],
        });
      }

      const buffer = fs.readFileSync(filepath);
      const file = new AttachmentBuilder(buffer, { name: filename });
      const scannedText = totalScannedRef.value ? ` (${totalScannedRef.value.toLocaleString()} messages scanned)` : '';
      const summary = `${rows.length} messages from ${targetUser.tag} in ${targetChannel} since ${sinceRaw}${scannedText}`;

      try {
        await interaction.user.send({ content: `Here is the export: ${summary}`, files: [file] });
        await interaction.editReply(`✅ Export complete (${summary}). CSV sent to your DMs.`);
      } catch (dmErr) {
        console.warn('Failed to DM user with CSV:', dmErr?.message || dmErr);
        await interaction.editReply({
          content: `✅ Export complete (${summary}). Couldn't DM you, so it's attached here — only you can see this.`,
          files: [file],
        });
      }
    } catch (err) {
      console.error('exportuserhistory command error:', err);
      try {
        await interaction.editReply({ content: `Error while exporting: ${err?.message || String(err)}` });
      } catch {}
    }
  },
};
