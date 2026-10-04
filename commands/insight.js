const { AttachmentBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');
const { ComponentType, textDisplay, separator, mediaGallery } = require('../utils/componentsV2');
const db = require('../db');

// Same QuickChart convention as commands/report.js (staff report chart) —
// GET request, chart config as JSON in `c`, fixed size + white background so
// it reads well in both Discord light/dark themes.
async function renderChart(config, filename, { w = 700, h = 420 } = {}) {
  const params = new URLSearchParams({
    w: String(w),
    h: String(h),
    bkg: 'white',
    c: JSON.stringify(config),
  });
  const res = await fetch(`https://quickchart.io/chart?${params.toString()}`);
  if (!res.ok) throw new Error(`QuickChart returned ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return new AttachmentBuilder(buffer, { name: filename });
}

function toDateKeyUTC(date) {
  return date.toISOString().slice(0, 10);
}

// Discord.js channel type IDs we care about grouping.
const CHANNEL_TYPE_LABELS = {
  0: 'Text',
  2: 'Voice',
  4: 'Category',
  5: 'Announcement',
  13: 'Stage',
  15: 'Forum',
};
const THREAD_TYPES = new Set([10, 11, 12]);

// ── Per-channel activity scan (opt-in via `channel_activity:true`) ─────────────
// Only counts messages (no content read, no AI) within a bounded recent window,
// so it stays fast even on busy servers. Modeled after the scanning approach in
// commands/report.js, but much lighter: no full-history pagination, no threads,
// just a capped recent-window count per channel.
const ACTIVITY_MAX_PAGES_PER_CHANNEL = 20; // 20 * 100 = 2,000 msgs/channel ceiling within the window
const ACTIVITY_CONCURRENCY = 5;
const ACTIVITY_MAX_CHANNELS = 40; // scan cap so a channel-heavy server can't stall the command
const TOP_CHANNELS_SHOWN = 15;

function isScannableTextChannel(channel, botMember) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return false;
  if (channel.type === 4) return false; // categories aren't scannable
  const perms = channel.permissionsFor(botMember);
  return !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

async function countChannelMessagesSince(channel, sinceTs) {
  let count = 0;
  let lastId;
  let pages = 0;
  let truncated = false;

  while (pages < ACTIVITY_MAX_PAGES_PER_CHANNEL) {
    let batch;
    try {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      batch = await channel.messages.fetch(options);
    } catch {
      break; // channel became unreadable mid-scan, or a transient API error — skip the rest of it
    }
    if (!batch?.size) break;

    const arr = Array.from(batch.values());
    let hitBoundary = false;
    for (const msg of arr) {
      if (msg.createdTimestamp < sinceTs) { hitBoundary = true; continue; }
      count++;
    }

    lastId = arr[arr.length - 1].id;
    pages++;
    if (hitBoundary) break;
    if (pages >= ACTIVITY_MAX_PAGES_PER_CHANNEL) truncated = true;
    await new Promise(r => setTimeout(r, 150)); // gentle on rate limits
  }

  return { count, truncated };
}

async function scanChannelActivity(guild, sinceTs) {
  const botMember = guild.members.me;
  const candidates = guild.channels.cache
    .filter(c => isScannableTextChannel(c, botMember))
    .map(c => c);

  const scanned = candidates.slice(0, ACTIVITY_MAX_CHANNELS);
  const skippedForCap = candidates.length - scanned.length;

  const results = [];
  let idx = 0;
  let anyTruncated = false;

  async function worker() {
    while (idx < scanned.length) {
      const i = idx++;
      const channel = scanned[i];
      const { count, truncated } = await countChannelMessagesSince(channel, sinceTs);
      if (truncated) anyTruncated = true;
      if (count > 0) results.push({ name: channel.name, count });
    }
  }

  const workers = Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, scanned.length) }, worker);
  await Promise.all(workers);

  results.sort((a, b) => b.count - a.count);
  return {
    results,
    channelsScanned: scanned.length,
    skippedForCap,
    anyTruncated,
    totalMessages: results.reduce((sum, r) => sum + r.count, 0),
  };
}

module.exports = {
  category: 'Utility',
  data: createCommandBuilder({
    name: 'insights',
    description: 'View server insights: growth, member composition, and channel breakdown (with charts)',
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    configure: builder => builder
      .addIntegerOption(option => option
        .setName('days')
        .setDescription('How many days of member-growth history to chart (default 30)')
        .setMinValue(2)
        .setMaxValue(90)
        .setRequired(false))
      .addBooleanOption(option => option
        .setName('channel_activity')
        .setDescription('Also scan recent message counts per channel and chart the most active ones (slower)')
        .setRequired(false))
      .addIntegerOption(option => option
        .setName('activity_days')
        .setDescription('Days of recent history to scan per channel for activity (default 7, max 14)')
        .setMinValue(1)
        .setMaxValue(14)
        .setRequired(false)),
  }),
  cooldown: 10,
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const days = interaction.options.getInteger('days', false) || 30;
    const wantChannelActivity = interaction.options.getBoolean('channel_activity', false) || false;
    const activityDays = interaction.options.getInteger('activity_days', false) || 7;

    // ── Static server stats (no message scanning — fast on any size server) ──
    const owner = await guild.fetchOwner().catch(() => null);
    const createdTimestamp = Math.floor(guild.createdTimestamp / 1000);

    const bots = guild.members.cache.filter(m => m.user.bot).size;
    const humans = Math.max(guild.memberCount - bots, 0);

    const channelCounts = {};
    let threadCount = 0;
    for (const channel of guild.channels.cache.values()) {
      if (THREAD_TYPES.has(channel.type)) {
        threadCount++;
        continue;
      }
      const label = CHANNEL_TYPE_LABELS[channel.type];
      if (!label) continue;
      channelCounts[label] = (channelCounts[label] || 0) + 1;
    }
    if (threadCount) channelCounts['Threads'] = threadCount;

    const roleCount = Math.max(guild.roles.cache.size - 1, 0); // exclude @everyone
    const emojiCount = guild.emojis.cache.size;
    const stickerCount = guild.stickers?.cache?.size ?? 0;

    // ── Member growth trend (reuses the same MemberSnapshot store as /membertrend) ──
    let growthFile = null;
    let growthSummary = '⚠️ Growth history unavailable (database not reachable).';
    try {
      const todayKey = toDateKeyUTC(new Date());
      await db.recordMemberSnapshot(guild.id, guild.memberCount, todayKey);

      const fromKey = toDateKeyUTC(new Date(Date.now() - (days - 1) * 86400000));
      const rows = await db.getMemberSnapshots(guild.id, fromKey, todayKey);

      if (rows.length >= 2) {
        const first = rows[0];
        const last = rows[rows.length - 1];
        const delta = last.memberCount - first.memberCount;
        const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`;
        growthSummary = `**${deltaStr}** members over the last **${rows.length}** tracked day(s) (${first.dateKey} → ${last.dateKey}).`;

        growthFile = await renderChart({
          type: 'line',
          data: {
            labels: rows.map(r => r.dateKey),
            datasets: [{
              label: 'Member Count',
              data: rows.map(r => r.memberCount),
              borderColor: '#5865F2',
              backgroundColor: 'rgba(88,101,242,0.15)',
              fill: true,
              tension: 0.3,
              pointRadius: rows.length > 20 ? 0 : 3,
            }],
          },
          options: {
            title: { display: true, text: `Member Growth (last ${rows.length} days)`, fontSize: 18, fontStyle: 'bold', padding: 16 },
            legend: { display: false },
            scales: {
              xAxes: [{ ticks: { autoSkip: true, maxTicksLimit: 10, fontSize: 11 }, gridLines: { display: false } }],
              yAxes: [{ ticks: { beginAtZero: false, precision: 0 }, gridLines: { color: '#e5e7eb' } }],
            },
          },
        }, 'insights_growth.png');
      } else {
        growthSummary = `📌 Only **${rows.length}** day(s) of history tracked so far — check back tomorrow for a trend line. (A snapshot is taken daily.)`;
      }
    } catch (err) {
      growthSummary = `⚠️ Couldn't load growth history: ${err.message}`;
    }

    // ── Member composition chart ──
    const compositionFile = await renderChart({
      type: 'doughnut',
      data: {
        labels: ['Humans', 'Bots'],
        datasets: [{ data: [humans, bots], backgroundColor: ['#57F287', '#ED4245'] }],
      },
      options: {
        title: { display: true, text: 'Member Composition', fontSize: 18, fontStyle: 'bold', padding: 16 },
        legend: { position: 'bottom', labels: { fontSize: 12, padding: 12 } },
      },
    }, 'insights_composition.png', { w: 500, h: 420 }).catch(() => null);

    // ── Channel breakdown chart ──
    const channelLabels = Object.keys(channelCounts);
    const channelFile = channelLabels.length
      ? await renderChart({
        type: 'bar',
        data: {
          labels: channelLabels,
          datasets: [{ label: 'Channels', data: channelLabels.map(l => channelCounts[l]), backgroundColor: '#5865F2' }],
        },
        options: {
          title: { display: true, text: 'Channel Breakdown', fontSize: 18, fontStyle: 'bold', padding: 16 },
          legend: { display: false },
          scales: {
            xAxes: [{ gridLines: { display: false }, ticks: { fontSize: 11 } }],
            yAxes: [{ ticks: { beginAtZero: true, precision: 0 }, gridLines: { color: '#e5e7eb' } }],
          },
        },
      }, 'insights_channels.png', { w: 700, h: 380 }).catch(() => null)
      : null;

    // ── Per-channel activity (opt-in, slower — only runs if requested) ──
    let activityFile = null;
    let activitySummary = null;
    if (wantChannelActivity) {
      try {
        const sinceTs = Date.now() - activityDays * 86400000;
        const scan = await scanChannelActivity(guild, sinceTs);

        if (!scan.results.length) {
          activitySummary = `No messages found in the last **${activityDays}** day(s) across ${scan.channelsScanned} scanned channel(s).`;
        } else {
          const top = scan.results.slice(0, TOP_CHANNELS_SHOWN);
          const notes = [];
          if (scan.skippedForCap > 0) notes.push(`${scan.skippedForCap} channel(s) skipped (scan cap)`);
          if (scan.anyTruncated) notes.push(`some channels hit the ${ACTIVITY_MAX_PAGES_PER_CHANNEL * 100}-message cap and may undercount`);

          activitySummary = [
            `**${scan.totalMessages.toLocaleString()}** messages across **${scan.results.length}** active channel(s)`,
            `in the last **${activityDays}** day(s) (${scan.channelsScanned} channels scanned).`,
            notes.length ? `-# ${notes.join(' · ')}` : null,
          ].filter(Boolean).join('\n');

          activityFile = await renderChart({
            type: 'horizontalBar',
            data: {
              labels: top.map(r => `#${r.name}`).reverse(),
              datasets: [{ label: 'Messages', data: top.map(r => r.count).reverse(), backgroundColor: '#00AE86' }],
            },
            options: {
              title: { display: true, text: `Most Active Channels (last ${activityDays}d)`, fontSize: 18, fontStyle: 'bold', padding: 16 },
              legend: { display: false },
              scales: {
                xAxes: [{ ticks: { beginAtZero: true, precision: 0 }, gridLines: { color: '#e5e7eb' } }],
                yAxes: [{ gridLines: { display: false }, ticks: { fontSize: 11 } }],
              },
            },
          }, 'insights_activity.png', { w: 700, h: Math.max(320, top.length * 32) }).catch(() => null);
        }
      } catch (err) {
        activitySummary = `⚠️ Couldn't scan channel activity: ${err.message}`;
      }
    }

    // ── Assemble ──
    const files = [growthFile, compositionFile, channelFile, activityFile].filter(Boolean);
    const mediaItems = [];
    if (growthFile) mediaItems.push({ url: 'attachment://insights_growth.png', description: 'Member growth over time' });
    if (compositionFile) mediaItems.push({ url: 'attachment://insights_composition.png', description: 'Human vs bot member composition' });
    if (channelFile) mediaItems.push({ url: 'attachment://insights_channels.png', description: 'Channel type breakdown' });
    if (activityFile) mediaItems.push({ url: 'attachment://insights_activity.png', description: 'Most active channels by message count' });

    const components = [
      textDisplay(`## 📊 Server Insights — ${guild.name}`),
      separator(),

      textDisplay([
        '### 👥 Members',
        `**Total:** ${guild.memberCount.toLocaleString()}`,
        `**Humans:** ${humans.toLocaleString()}`,
        `**Bots:** ${bots.toLocaleString()}`,
      ].join('\n')),
      separator(),

      textDisplay([
        '### 📈 Growth Trend',
        growthSummary,
      ].join('\n')),
      separator(),

      textDisplay([
        '### 🏛️ Server Overview',
        `**Owner:** ${owner ? owner.user.tag : 'Unknown'}`,
        `**Created:** <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)`,
        `**Roles:** ${roleCount.toLocaleString()}`,
        `**Emojis:** ${emojiCount.toLocaleString()}${stickerCount ? ` · **Stickers:** ${stickerCount.toLocaleString()}` : ''}`,
        `**Boost Tier:** Level ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} boosts)`,
        `**Verification:** ${guild.verificationLevel.toString()}`,
      ].join('\n')),
      separator(),

      textDisplay([
        '### 📺 Channels',
        channelLabels.length
          ? channelLabels.map(l => `**${l}:** ${channelCounts[l]}`).join('  ·  ')
          : 'No channels found.',
      ].join('\n')),
    ];

    if (activitySummary) {
      components.push(separator());
      components.push(textDisplay([
        '### 💬 Channel Activity',
        activitySummary,
      ].join('\n')));
    }

    if (mediaItems.length) {
      components.push(separator());
      components.push(textDisplay('### 🖼️ Charts'));
      components.push(mediaGallery(mediaItems));
    } else {
      components.push(separator());
      components.push(textDisplay('-# ⚠️ Charts could not be generated (QuickChart unreachable) — showing stats only.'));
    }

    components.push(separator());
    components.push(textDisplay(`-# Requested by ${interaction.user.tag} · <t:${Math.floor(Date.now() / 1000)}:R> · only visible to you`));

    await interaction.editReply({
      components: [{ type: ComponentType.Container, components }],
      files,
      flags: MessageFlags.IsComponentsV2,
    });
  },
};
