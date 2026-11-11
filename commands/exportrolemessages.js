const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const TOKEN_SAFE_MS = 14 * 60 * 1000;   // Discord's interaction token dies at 15 min
const PROGRESS_EVERY_MS = 5000;         // progress update interval
const MAX_PART_BYTES = 20 * 1024 * 1024; // keep each CSV under Discord's upload limit
const MAX_FILES_PER_MESSAGE = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape a value for CSV and block spreadsheet formula injection.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Fetch one page of messages, retrying on temporary errors.
async function fetchBatch(channel, options) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await Promise.race([
        channel.messages.fetch({ ...options, cache: false }), // don't keep 100k+ messages in RAM
        new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timed out')), 60000)),
      ]);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * attempt);
    }
  }
}

// Split CSV lines into parts that fit under the upload limit.
function splitIntoParts(header, lines) {
  const headerBytes = Buffer.byteLength(header) + 1;
  const parts = [];
  let current = [header];
  let size = headerBytes;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > MAX_PART_BYTES && current.length > 1) {
      parts.push(current.join('\n'));
      current = [header];
      size = headerBytes;
    }
    current.push(line);
    size += bytes;
  }
  parts.push(current.join('\n'));
  return parts.map((p) => '\uFEFF' + p); // BOM so Excel reads UTF-8
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exportrolemessages')
    .setDescription('Export messages from users with a specific role to CSV (bot owner only)')
    .addRoleOption((o) =>
      o.setName('role').setDescription("Role whose members' messages to export").setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to scan (default: current channel)')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread
        )
    )
    .addIntegerOption((o) =>
      o.setName('limit').setDescription('Max messages to scan (0 = unlimited)').setMinValue(0)
    )
    .addStringOption((o) =>
      o
        .setName('from_date')
        .setDescription('Only export messages from this date onward (YYYY-MM-DD, UTC)')
    )
    .addStringOption((o) =>
      o
        .setName('before_id')
        .setDescription('Resume: only scan messages older than this message ID')
    ),

  async execute(interaction) {
    // Owner-only check
    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId || interaction.user.id !== ownerId) {
      return interaction.reply({
        content: '❌ Only the bot owner can use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const started = Date.now();
    let tokenAlive = true;

    // Edit the ephemeral reply only while Discord still allows it.
    const safeEdit = async (payload) => {
      if (!tokenAlive || Date.now() - started > TOKEN_SAFE_MS) {
        tokenAlive = false;
        return false;
      }
      try {
        await interaction.editReply(payload);
        return true;
      } catch {
        tokenAlive = false;
        return false;
      }
    };

    try {
      const role = interaction.options.getRole('role', true);
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const limit =
        interaction.options.getInteger('limit') ??
        (Number(process.env.DEFAULT_PER_CHANNEL_LIMIT) || 0);

      // Optional start date (YYYY-MM-DD, treated as 00:00 UTC)
      const fromDateStr = interaction.options.getString('from_date');
      let fromTs = 0;
      if (fromDateStr) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr) || isNaN(Date.parse(fromDateStr))) {
          return interaction.editReply('⚠️ Invalid date. Use `YYYY-MM-DD`, for example `2026-10-01`.');
        }
        fromTs = Date.parse(`${fromDateStr}T00:00:00Z`);
      }

      await safeEdit('⏳ Loading server members...');
      await interaction.guild.members.fetch({ time: 300000 }); // needs Server Members intent
      const roleMembers = interaction.guild.roles.cache.get(role.id)?.members;
      if (!roleMembers || roleMembers.size === 0) {
        return interaction.editReply('⚠️ No members have that role.');
      }

      const lines = [];
      const header = [
        'message_id', 'timestamp', 'author_id', 'author_tag',
        'channel', 'content', 'attachments', 'message_url',
      ]
        .map(csvCell)
        .join(',');
      const base = `${role.name.replace(/[^\w-]+/g, '_')}_messages_${Date.now()}`;
      const outDir = process.env.OUTPUT_DIR || './exports';
      let lastCheckpoint = 0;
      let segmentStart = 0; // index of first match not yet sent in a checkpoint
      let scanned = 0;
      let before = interaction.options.getString('before_id') || undefined;
      if (before && !/^\d{17,20}$/.test(before)) {
        return interaction.editReply('⚠️ Invalid `before_id`. It must be a Discord message ID (numbers only).');
      }
      let stoppedEarly = null;
      let lastUpdate = 0;

      // Page through history, 100 messages at a time, newest -> oldest
      while (true) {
        const batchSize = limit ? Math.min(100, limit - scanned) : 100;
        if (batchSize <= 0) break;

        let batch;
        try {
          batch = await fetchBatch(channel, { limit: batchSize, before });
        } catch (err) {
          stoppedEarly = err.message; // keep what we already have
          break;
        }
        if (batch.size === 0) break;

        let reachedStart = false;
        for (const m of batch.values()) {
          if (m.createdTimestamp < fromTs) {
            reachedStart = true;
            continue;
          }
          if (!roleMembers.has(m.author.id)) continue;
          lines.push(
            [
              m.id,
              m.createdAt.toISOString(),
              m.author.id,
              m.author.tag,
              `#${channel.name}`,
              m.content,
              [...m.attachments.values()].map((a) => a.url).join(' '),
              m.url,
            ]
              .map(csvCell)
              .join(',')
          );
        }

        scanned += batch.size;
        before = batch.last().id;
        channel.messages.cache.clear(); // belt and braces against memory growth

        if (Math.floor(scanned / 5000) > lastCheckpoint) {
          lastCheckpoint = Math.floor(scanned / 5000);
          console.log(
            `exportrolemessages: scanned ${scanned}, matched ${lines.length}, last message id ${before}`
          );

          // Every 25,000 scanned messages, DM the new matches so progress survives a crash/restart
          if (lastCheckpoint % 5 === 0) {
            const segment = lines.slice(segmentStart);
            segmentStart = lines.length;
            if (segment.length > 0) {
              try {
                await interaction.user.send({
                  content:
                    `📦 Checkpoint: scanned ${scanned}, ${segment.length} new matches in this file (newest first). ` +
                    `Last message ID: ${before} (use it as before_id to resume).`,
                  files: [
                    new AttachmentBuilder(
                      Buffer.from('\uFEFF' + [header, ...segment].join('\n'), 'utf8'),
                      { name: `${base}_checkpoint_${scanned}.csv` }
                    ),
                  ],
                });
              } catch {}
            }
          }
        }

        if (Date.now() - lastUpdate > PROGRESS_EVERY_MS) {
          lastUpdate = Date.now();
          await safeEdit(`⏳ Scanning ${channel}... scanned **${scanned}**, matched **${lines.length}**`);
        }

        if (reachedStart || batch.size < batchSize) break;
      }

      if (lines.length === 0) {
        const msg = `⚠️ Scanned ${scanned} messages in ${channel}, but none were from members of **${role.name}**.`;
        if (!(await safeEdit(msg))) await interaction.user.send(msg).catch(() => {});
        return;
      }

      lines.reverse(); // oldest first

      const parts = splitIntoParts(header, lines);

      // Always keep a copy on disk as a backup
      try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `${base}.csv`), '\uFEFF' + [header, ...lines].join('\n'));
      } catch (err) {
        console.error('exportrolemessages: could not save backup copy:', err.message);
      }

      const files = parts.map(
        (p, i) =>
          new AttachmentBuilder(Buffer.from(p, 'utf8'), {
            name: parts.length > 1 ? `${base}_part${i + 1}.csv` : `${base}.csv`,
          })
      );
      const groups = [];
      for (let i = 0; i < files.length; i += MAX_FILES_PER_MESSAGE) {
        groups.push(files.slice(i, i + MAX_FILES_PER_MESSAGE));
      }

      const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
      const summary =
        `✅ Exported **${lines.length}** messages from **${role.name}** members` +
        `${fromDateStr ? ` since ${fromDateStr}` : ''} (scanned ${scanned} in #${channel.name}, ~${mins} min).` +
        `${parts.length > 1 ? ` Split into ${parts.length} files.` : ''}` +
        `${stoppedEarly ? `\n⚠️ Stopped early (${stoppedEarly}). To continue, run again with before_id: ${before}` : ''}`;

      // 1) Try the ephemeral reply (works if finished within ~14 minutes)
      if (tokenAlive && Date.now() - started < TOKEN_SAFE_MS) {
        try {
          await interaction.editReply({ content: summary, files: groups[0] });
          for (const g of groups.slice(1)) {
            await interaction.followUp({ files: g, flags: MessageFlags.Ephemeral });
          }
          return;
        } catch {
          tokenAlive = false;
        }
      }

      // 2) Token expired: send privately to the owner's DMs instead
      try {
        await interaction.user.send({
          content: `${summary}\n_(Sent by DM because the 15-minute slash-command window had passed.)_`,
          files: groups[0],
        });
        for (const g of groups.slice(1)) await interaction.user.send({ files: g });
      } catch (err) {
        console.error(
          'exportrolemessages: could not DM the owner. CSV is saved in the OUTPUT_DIR folder.',
          err.message
        );
      }
    } catch (err) {
      console.error('exportrolemessages error:', err);
      const msg = '❌ Something went wrong while exporting. Check the error log.';
      if (!(await safeEdit(msg))) await interaction.user.send(msg).catch(() => {});
    }
  },
};
