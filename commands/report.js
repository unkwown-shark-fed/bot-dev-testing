const { AttachmentBuilder, PermissionFlagsBits, MessageFlags, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');
const { ComponentType, textDisplay, separator, mediaGallery } = require('../utils/componentsV2');
const { sanitizeText } = require('../utils/csv');
const { isAuthorized } = require('../utils/auth');

// ── Config ───────────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-3.6-flash'; // free tier on Google AI Studio — no credit card needed
const MAX_SAMPLE_MSGS_PER_USER = 60;   // how many messages per staff member we send to the AI for review
const MAX_MSG_CHARS = 300;             // truncate each sampled message before sending
// No functional history cap: pagination below runs until it reaches `since` or the
// channel runs out of messages, not until some page count. SAFETY_MAX_PAGES exists
// only to stop a runaway loop if Discord's API ever misbehaves — at 50,000
// messages/channel it should never realistically trigger.
const SAFETY_MAX_PAGES = 500;
const MAX_USERS_IN_TABLE = 200;        // effectively "show everyone" — raise further if you ever have more staff than this
const RANK_LINES_PER_CHUNK = 5;        // smaller groups pack more efficiently across multiple messages
const NOTES_PER_CHUNK = 1;             // one full review per text block — reviews are long, so no batching here
const MESSAGE_TEXT_BUDGET = 3800;      // Discord caps TOTAL text across a message's components at 4000 — stay under with a buffer
const QUALITY_WEIGHT = 0.5;            // overall score = this * quality + (1 - this) * activity
const CHANNEL_FETCH_CONCURRENCY = 8;   // parallel channels/threads scanned at once

// ── Full-history scanning across all viewable text channels (and their threads) ─
// Paginates until it reaches `sinceTs` or the channel has no more messages —
// no artificial stopping point. `truncated` should basically never fire; it's
// only a signal that SAFETY_MAX_PAGES (the runaway-loop guard) was hit.
async function fetchChannelMessagesSince(channel, sinceTs) {
  if (!channel?.messages?.fetch) return { messages: [], truncated: false }; // e.g. a forum parent with no message history of its own

  const collected = [];
  let lastId;
  let pages = 0;
  let hitBoundary = false;

  while (pages < SAFETY_MAX_PAGES) {
    let batch;
    try {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      batch = await channel.messages.fetch(options);
    } catch (err) {
      console.warn(`[report] Failed to fetch from #${channel.name}: ${err.message}`);
      break;
    }
    if (!batch || !batch.size) break;

    const arr = Array.from(batch.values());
    for (const msg of arr) {
      if (msg.createdTimestamp < sinceTs) { hitBoundary = true; continue; }
      collected.push(msg);
    }

    lastId = arr[arr.length - 1].id;
    pages++;
    if (hitBoundary) break; // we've gone past the start date, stop paginating this channel
    await new Promise(r => setTimeout(r, 200)); // be gentle with rate limits
  }

  const truncated = pages >= SAFETY_MAX_PAGES && !hitBoundary;

  return { messages: collected, truncated };
}

async function fetchAllChannelsSince(channels, sinceTs, onProgress, concurrency = CHANNEL_FETCH_CONCURRENCY) {
  const results = new Map();
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < channels.length) {
      const i = idx++;
      const channel = channels[i];
      const result = await fetchChannelMessagesSince(channel, sinceTs);
      results.set(channel.id, result);
      done++;
      onProgress?.(done, channels.length);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, channels.length) }, worker);
  await Promise.all(workers);

  return { results };
}

function isValidScannableChannel(channel, botMember) {
  if (!channel || !channel.isTextBased?.() || channel.isThread?.()) return false;
  const perms = channel.permissionsFor(botMember);
  return !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

function isScannableThread(thread, botMember, sinceTs) {
  if (!thread?.isThread?.()) return false;
  if (typeof thread.archiveTimestamp === 'number' && thread.archiveTimestamp < sinceTs) return false;
  const perms = thread.permissionsFor(botMember);
  return !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

async function fetchThreadsForChannel(channel) {
  const threads = [];
  if (!channel?.threads?.fetchActive) return threads;

  try {
    const active = await channel.threads.fetchActive();
    threads.push(...active.threads.values());
  } catch (err) {
    console.warn(`[report] Failed to fetch active threads in #${channel.name}: ${err.message}`);
  }

  for (const type of ['public', 'private']) {
    let before;
    let pages = 0;
    while (pages < SAFETY_MAX_PAGES) {
      let archived;
      try {
        archived = await channel.threads.fetchArchived({ type, before, limit: 100 });
      } catch (err) {
        if (type === 'public') console.warn(`[report] Failed to fetch archived threads in #${channel.name}: ${err.message}`);
        break;
      }
      if (!archived?.threads?.size) break;
      threads.push(...archived.threads.values());
      if (!archived.hasMore) break;
      const oldest = Array.from(archived.threads.values()).pop();
      if (!oldest) break;
      before = new Date(oldest.archiveTimestamp);
      pages++;
    }
  }

  return threads;
}

function resolveChannelsOption(interaction, guild, botMember, sinceTs) {
  for (const name of ['channels', 'channel']) {
    const opt = interaction.options.get(name);
    if (!opt) continue;

    if (opt.type === ApplicationCommandOptionType.Channel) {
      const channel = opt.channel;
      if (channel?.isThread?.()) {
        if (isScannableThread(channel, botMember, sinceTs)) {
          return { channels: [channel], invalidTokens: [] };
        }
        return { channels: [], invalidTokens: [`#${channel.name}`] };
      }
      if (isValidScannableChannel(channel, botMember)) {
        return { channels: [channel], invalidTokens: [] };
      }
      return { channels: [], invalidTokens: [channel ? `#${channel.name}` : name] };
    }

    if (opt.type === ApplicationCommandOptionType.String) {
      return parseChannelsOption(opt.value, guild, botMember, sinceTs);
    }
  }
  return { channels: null, invalidTokens: [] };
}

function parseChannelsOption(raw, guild, botMember, sinceTs) {
  const tokens = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const channels = [];
  const invalidTokens = [];
  const seen = new Set();

  for (const token of tokens) {
    const idMatch = token.match(/^(?:<#(\d+)>|(\d{15,25}))$/);
    const id = idMatch ? (idMatch[1] || idMatch[2]) : null;
    const channel = id ? guild.channels.cache.get(id) : null;

    if (!channel || !channel.isTextBased?.()) {
      invalidTokens.push(token);
      continue;
    }

    // Threads are validated on their own scannable-thread rule (which also checks
    // they haven't been archived since before `sinceTs`); regular channels use the
    // normal permission check.
    const isValid = channel.isThread?.()
      ? isScannableThread(channel, botMember, sinceTs)
      : isValidScannableChannel(channel, botMember);

    if (!isValid) {
      invalidTokens.push(token);
      continue;
    }
    if (!seen.has(channel.id)) {
      seen.add(channel.id);
      channels.push(channel);
    }
  }

  return { channels, invalidTokens };
}

function getAllScannableTextChannels(guild, botMember) {
  return guild.channels.cache.filter(c => {
    if (!c.isTextBased || !c.isTextBased() || c.isThread?.()) return false;
    const perms = c.permissionsFor(botMember);
    return perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  }).map(c => c);
}

// ── AI quality scoring (batched calls to stay under Gemini's per-response token limit) ──
const AI_BATCH_SIZE = 6;         // smaller batches since each review is now several sentences, not one
const AI_BATCH_DELAY_MS = 1500;  // spacing between batches to stay under the free-tier requests/minute cap

function repairTruncatedJsonArray(text) {
  const lastCloseBrace = text.lastIndexOf('}');
  if (lastCloseBrace === -1) return null;
  const candidate = text.slice(0, lastCloseBrace + 1).trim();
  if (!candidate.startsWith('[')) return null;
  try {
    return JSON.parse(candidate + ']');
  } catch {
    return null;
  }
}

async function scoreBatchWithAI(batch, apiKey) {
  const payloadUsers = batch.map(u => ({ userId: u.userId, tag: u.tag, messages: u.samples }));

  const prompt =
    `You are writing an internal staff performance review for a Discord server, based on each ` +
    `staff member's actual messages during the report period. Be BLUNT — write like a direct manager ` +
    `giving unfiltered feedback, not HR-speak. This applies equally in both directions: if someone did ` +
    `well, say so plainly and specifically ("consistently gave thorough, correct answers" not "did a ` +
    `great job overall"); if someone did poorly, say that plainly too ("gave lazy one-word replies and ` +
    `ignored follow-up questions" not "there is room for improvement"). Do not soften bad performance ` +
    `with diplomatic hedging, and do not inflate mediocre performance into something positive just to ` +
    `be nice. Be specific and evidence-based — reference concrete patterns you saw — not generic filler ` +
    `in either direction. For each user below:\n\n` +
    `1. "qualityScore" (1-10): response quality/effort. 10 = consistently helpful, thorough, ` +
    `proactive, professional. 1 = low-effort, unhelpful, or absent.\n` +
    `2. "behaviorScore" (1-10): conduct/tone toward others, independent of quality. 10 = consistently ` +
    `courteous and calm even under pressure. 1 = rude, hostile, dismissive, or abusive. A short but ` +
    `polite answer should NOT be marked down on behavior just for brevity.\n` +
    `3. "review": a complete 2-3 sentence review, written bluntly, covering (a) what they did well or ` +
    `poorly — stated as a direct fact, not cushioned — and (b) a one-line verdict on both quality and ` +
    `behavior (call out plainly if behavior was good, bad, or mixed, and why). Base this ONLY on the ` +
    `message content given — never invent specifics you weren't shown.\n\n` +
    `Respond with ONLY a JSON array, no prose, no markdown fences, in this exact shape:\n` +
    `[{"userId":"...","qualityScore":7,"behaviorScore":8,"review":"2-3 sentence review here"}]\n\n` +
    `Staff data:\n${JSON.stringify(payloadUsers)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,          // headroom for longer, multi-sentence reviews across a batch
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI response contained no text');

  const cleaned = text.replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    const repaired = repairTruncatedJsonArray(cleaned);
    if (repaired && repaired.length) {
      parsed = repaired;
    } else {
      throw new Error(
        `Malformed AI JSON (${parseErr.message}, finishReason=${candidate?.finishReason || 'unknown'})`
      );
    }
  }

  const map = new Map();
  for (const entry of parsed) {
    if (!entry?.userId) continue;
    map.set(entry.userId, {
      qualityScore: Math.max(1, Math.min(10, Number(entry.qualityScore) || 5)),
      behaviorScore: Math.max(1, Math.min(10, Number(entry.behaviorScore) || 5)),
      summary: sanitizeText(entry.review || entry.summary || '', 500),
      fullSummary: sanitizeText(entry.review || entry.summary || '', 4000), // untruncated version, only used in the CSV export
    });
  }
  return map;
}

async function scoreQualityWithAI(userSamples) {
  const apiKey = process.env.GEMINI_API_KEY;
  const scorable = userSamples.filter(u => u.samples && u.samples.length > 0);
  if (!apiKey || !scorable.length) return { map: null, errors: [] };

  const batches = [];
  for (let i = 0; i < scorable.length; i += AI_BATCH_SIZE) {
    batches.push(scorable.slice(i, i + AI_BATCH_SIZE));
  }

  const map = new Map();
  const errors = [];

  for (let i = 0; i < batches.length; i++) {
    try {
      const batchMap = await scoreBatchWithAI(batches[i], apiKey);
      for (const [k, v] of batchMap) map.set(k, v);
    } catch (err) {
      errors.push(`batch ${i + 1}/${batches.length}: ${err.message}`);
      console.warn(`[report] AI batch ${i + 1}/${batches.length} failed: ${err.message}`);
    }
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, AI_BATCH_DELAY_MS));
  }

  return { map: map.size ? map : null, errors };
}

// ── Chart via QuickChart (no native deps required) ───────────────────────────
// Dual-axis combo chart: message counts are real numbers on their own axis (left),
// AI scores stay on their natural 0-10 scale on a separate axis (right) — nothing
// gets artificially rescaled to fit a shared range.
async function buildChartAttachment(rows) {
  const labels = rows.map(r => r.tag.length > 16 ? r.tag.slice(0, 15) + '…' : r.tag);
  const maxMessages = Math.max(1, ...rows.map(r => r.count));

  const datasets = [
    {
      type: 'bar',
      label: 'Messages',
      data: rows.map(r => r.count),
      backgroundColor: 'rgba(88, 101, 242, 0.75)', // Discord blurple
      borderColor: '#5865F2',
      borderWidth: 1,
      borderRadius: 4,
      yAxisID: 'yMessages',
      order: 2,
    },
    {
      type: 'line',
      label: 'AI Quality (/10)',
      data: rows.map(r => r.qualityScore),
      borderColor: '#57F287',
      backgroundColor: '#57F287',
      pointBackgroundColor: '#57F287',
      pointRadius: 4,
      borderWidth: 2,
      fill: false,
      tension: 0.3,
      spanGaps: true,
      yAxisID: 'yScore',
      order: 1,
    },
    {
      type: 'line',
      label: 'AI Behavior (/10)',
      data: rows.map(r => r.behaviorScore),
      borderColor: '#FEE75C',
      backgroundColor: '#FEE75C',
      pointBackgroundColor: '#FEE75C',
      pointRadius: 4,
      borderWidth: 2,
      fill: false,
      tension: 0.3,
      spanGaps: true,
      yAxisID: 'yScore',
      order: 1,
    },
  ];

  const config = {
    type: 'bar',
    data: { labels, datasets },
    options: {
      title: {
        display: true,
        text: 'Staff Contribution Report',
        fontSize: 18,
        fontStyle: 'bold',
        padding: 16,
      },
      legend: { position: 'bottom', labels: { fontSize: 12, padding: 16 } },
      scales: {
        xAxes: [{
          ticks: { autoSkip: false, maxRotation: 60, minRotation: 40, fontSize: 11 },
          gridLines: { display: false },
        }],
        yAxes: [
          {
            id: 'yMessages',
            position: 'left',
            ticks: { beginAtZero: true, suggestedMax: Math.ceil(maxMessages * 1.15), precision: 0 },
            scaleLabel: { display: true, labelString: 'Messages (actual count)' },
            gridLines: { color: '#e5e7eb' },
          },
          {
            id: 'yScore',
            position: 'right',
            ticks: { beginAtZero: true, max: 10, stepSize: 2 },
            scaleLabel: { display: true, labelString: 'AI Score (0-10)' },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
    },
  };

  const params = new URLSearchParams({
    w: '900',
    h: '500',
    bkg: 'white', // solid background so it reads well in both Discord light/dark themes
    c: JSON.stringify(config),
  });
  const chartUrl = `https://quickchart.io/chart?${params.toString()}`;
  const res = await fetch(chartUrl);
  if (!res.ok) throw new Error(`QuickChart returned ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return new AttachmentBuilder(buffer, { name: 'staff_report_chart.png' });
}

// ── Full-data CSV export ──────────────────────────────────────────────────────
// The in-chat report is windowed (MAX_USERS_IN_TABLE) and each review is trimmed
// to fit Discord's per-message text budget. This CSV always has every scanned
// staff member with their untruncated AI review, so nothing is ever left out.
function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const FILE_COMPONENT_TYPE = 13; // Discord Components V2 "File" component — required to display non-image attachments

// A Components V2 message only renders attachments that a component explicitly
// points at (Media Gallery for images, File for everything else). Just putting
// the CSV in the `files` array with nothing referencing it uploads it silently
// but shows nothing in the message — this component is what makes it visible.
function fileComponent(filename) {
  return { type: FILE_COMPONENT_TYPE, file: { url: `attachment://${filename}` } };
}

function buildReportCsv(rows) {
  const header = [
    'Rank', 'Discord Tag', 'User ID', 'Messages',
    'Activity Score (/10)', 'Quality Score (/10)', 'Behavior Score (/10)', 'Overall Score (/10)',
    'AI Review',
  ];
  const lines = [header.map(csvEscape).join(',')];

  rows.forEach((r, i) => {
    lines.push([
      i + 1,
      r.tag,
      `="${r.userId}"`, // forces Excel/Sheets to treat this as text, not a number — otherwise 18-digit
                         // Discord IDs get silently converted to scientific notation (e.g. 5.31E+17)
                         // and the precision is lost.
      r.count,
      r.activityScore,
      r.qualityScore ?? '',
      r.behaviorScore ?? '',
      r.overall,
      r.fullSummary,
    ].map(csvEscape).join(','));
  });

  const csvBody = lines.join('\r\n');
  const BOM = '\uFEFF'; // so Excel opens UTF-8 (emoji, accented names) correctly
  return new AttachmentBuilder(Buffer.from(BOM + csvBody, 'utf8'), { name: 'staff_report_full.csv' });
}

function medalOrRank(i) {
  if (i === 0) return '🥇';
  if (i === 1) return '🥈';
  if (i === 2) return '🥉';
  return `**#${i + 1}**`;
}

function scoreBar(score) {
  if (score === null || score === undefined) return '░░░░░░░░░░';
  const filled = Math.max(0, Math.min(10, Math.round(score)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

// Discord enforces a 4000-character TOTAL text budget across all components in a
// single message (not per-component) — a full report with many staff and long AI
// reviews blows past that easily. This bin-packs the flat component list into
// multiple groups, each safely under budget, to be sent as separate messages.
// Doesn't split any single component (each one is already kept well under budget
// individually), and avoids starting a new group with a bare separator.
function packComponents(components, budget) {
  const groups = [];
  let current = [];
  let currentLen = 0;

  for (const comp of components) {
    const len = comp.type === ComponentType.TextDisplay ? comp.content.length : 0;

    if (currentLen + len > budget && current.length) {
      groups.push(current);
      current = [];
      currentLen = 0;
      if (comp.type === ComponentType.Separator) continue; // don't open a new message with just a divider
    }

    current.push(comp);
    currentLen += len;
  }
  if (current.length) groups.push(current);
  return groups;
}

module.exports = {
  category: 'Moderation',
  data: createCommandBuilder({
    name: 'report',
    description: 'Evaluate a staff role\'s contribution (message count + AI quality score) since a date',
    configure: builder => builder
      .addRoleOption(o => o.setName('role').setDescription('Staff role to evaluate').setRequired(true))
      .addStringOption(o => o.setName('since').setDescription('Start date, format YYYY-MM-DD').setRequired(true))
      .addStringOption(o => o.setName('channels').setDescription('Multiple channels/threads to scan: mentions or IDs, space/comma-separated (e.g. #general, #support)').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('Single channel or thread to scan — ignored if "channels" is also given (optional, defaults to all viewable channels + their threads)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)
        .setRequired(false)),
  }),
  restricted: false,
  cooldown: 60,
  async execute(interaction, client, logger) {
    if (!isAuthorized(interaction, { ownerOnly: true })) {
      return interaction.reply({ content: '🔒 This command is restricted to the bot owner.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Interaction tokens still expire 15min after creation — that's a Discord-side
    // hard limit we can't remove. We no longer pre-emptively cut the scan short for
    // it though; the scan takes however long it needs, and if the token has died by
    // the time we're done, the catch block below delivers the finished report as a
    // normal channel message instead of losing the work.
    let builtContainers = null; // set once components are packed, so the catch block can still deliver undelivered chunks
    let chartFile = null;
    let mediaGroupIndex = -1;
    let reportFile = null;
    let reportFileGroupIndex = -1;
    let deliveredCount = 0;

    try {
      const role = interaction.options.getRole('role', true);
      const sinceStr = interaction.options.getString('since', true);

      const sinceDate = new Date(`${sinceStr}T00:00:00Z`);
      if (isNaN(sinceDate.getTime())) {
        return interaction.editReply(`❌ "${sinceStr}" isn't a valid date. Use format YYYY-MM-DD, e.g. 2026-08-01.`);
      }
      const sinceTs = sinceDate.getTime();

      const guild = interaction.guild;
      await guild.members.fetch();
      const staffMembers = role.members;
      if (!staffMembers.size) {
        return interaction.editReply(`No members currently have the ${role} role.`);
      }
      const staffIds = new Set(staffMembers.keys());

      const botMember = await guild.members.fetchMe();

      const { channels: filteredChannels, invalidTokens } = resolveChannelsOption(interaction, guild, botMember, sinceTs);

      let channels;
      if (filteredChannels !== null) {
        channels = filteredChannels;
        if (!channels.length) {
          return interaction.editReply(
            `❌ None of the channel(s)/thread(s) you gave could be resolved (or I lack access to them)${invalidTokens.length ? `: ${invalidTokens.join(', ')}` : '.'}`
          );
        }
      } else {
        channels = getAllScannableTextChannels(guild, botMember);
      }

      if (!channels.length) {
        return interaction.editReply('I don\'t have permission to read message history in any channel here.');
      }

      await interaction.editReply(
        `🔍 Scanning ${channels.length} channel(s) (+ their threads) for ${staffMembers.size} staff member(s) since **${sinceStr}**… this can take a bit.` +
        (invalidTokens.length ? `\n⚠️ Skipped unresolvable/inaccessible: ${invalidTokens.join(', ')}` : '')
      );

      const threadParent = new Map();
      const threadTargets = [];
      for (const channel of channels) {
        const threads = await fetchThreadsForChannel(channel);
        for (const thread of threads) {
          if (!isScannableThread(thread, botMember, sinceTs)) continue;
          threadTargets.push(thread);
          threadParent.set(thread.id, channel.id);
        }
      }

      const scanTargets = [...channels, ...threadTargets];

      const stats = new Map();
      for (const m of staffMembers.values()) {
        stats.set(m.id, { tag: m.user.tag, count: 0, samples: [] });
      }
      const channelCounts = new Map();
      let totalScanned = 0;

      const { results: scanResults } = await fetchAllChannelsSince(
        scanTargets, sinceTs,
        (() => {
          let lastEdit = 0;
          return (done, total) => {
            const now = Date.now();
            if (now - lastEdit < 4000 && done < total) return; // throttle edits, don't spam Discord
            lastEdit = now;
            interaction.editReply(
              `🔍 Scanning… ${done}/${total} channels/threads done for ${staffMembers.size} staff member(s) since **${sinceStr}**.`
            ).catch(() => {}); // best-effort — if the token's already dead this just silently stops updating
          };
        })()
      );

      const truncatedTargets = [];
      for (const target of scanTargets) {
        const result = scanResults.get(target.id);
        if (!result) continue;
        const { messages, truncated } = result;
        if (truncated) truncatedTargets.push(target);

        let targetStaffCount = 0;
        for (const msg of messages) {
          if (msg.author.bot || !staffIds.has(msg.author.id)) continue;
          const entry = stats.get(msg.author.id);
          entry.count++;
          targetStaffCount++;
          totalScanned++;
          if (entry.samples.length < MAX_SAMPLE_MSGS_PER_USER && msg.content) {
            entry.samples.push(sanitizeText(msg.content, MAX_MSG_CHARS));
          }
        }

        if (targetStaffCount > 0) {
          const isThread = threadParent.has(target.id);
          const baseId = isThread ? threadParent.get(target.id) : target.id;
          const baseChannel = isThread ? channels.find(c => c.id === baseId) : target;
          const existing = channelCounts.get(baseId) || { name: baseChannel?.name || target.name, count: 0, threadCount: 0 };
          existing.count += targetStaffCount;
          if (isThread) existing.threadCount++;
          channelCounts.set(baseId, existing);
        }
      }

      const maxCount = Math.max(1, ...Array.from(stats.values()).map(s => s.count));

      let qualityMap = null;
      let aiError = null;
      try {
        const aiResult = await scoreQualityWithAI(
          Array.from(stats.entries()).map(([userId, s]) => ({ userId, tag: s.tag, samples: s.samples }))
        );
        qualityMap = aiResult.map;
        if (aiResult.errors.length) aiError = aiResult.errors.join(' | ');
      } catch (err) {
        aiError = err.message;
        logger?.warn?.(`[report] AI scoring failed: ${aiError}`);
      }

      const rows = Array.from(stats.entries()).map(([userId, s]) => {
        const activityScore = Math.round((s.count / maxCount) * 10 * 10) / 10;
        const quality = qualityMap?.get(userId);
        const qualityScore = quality ? quality.qualityScore : null;
        const behaviorScore = quality ? quality.behaviorScore : null;
        const overall = qualityScore !== null
          ? Math.round((QUALITY_WEIGHT * qualityScore + (1 - QUALITY_WEIGHT) * activityScore) * 10) / 10
          : activityScore;

        return {
          userId,
          tag: s.tag,
          count: s.count,
          activityScore,
          qualityScore,
          behaviorScore,
          // FIX: every row now gets a non-empty summary. Previously, a staff member
          // with messages but a failed/missing AI score got an empty string here,
          // which caused them to be silently filtered out of the AI Reviews section
          // below (see `withNotes` filter) even though they appeared in Rankings —
          // making it look like users were "missing" from the report.
          summary: quality?.summary || (s.count === 0
            ? 'No messages found in the scanned period — nothing to evaluate.'
            : '_AI review unavailable — this user\'s scoring batch failed or was skipped._'),
          fullSummary: quality?.fullSummary || (s.count === 0
            ? 'No messages found in the scanned period — nothing to evaluate.'
            : 'AI review unavailable — this user\'s scoring batch failed or was skipped.'),
          overall,
        };
      }).sort((a, b) => b.overall - a.overall);

      reportFile = null;
      let reportFileError = null;
      try {
        reportFile = buildReportCsv(rows); // full rows, not windowed — everyone scanned is in here
      } catch (err) {
        reportFileError = err.message;
        logger?.warn?.(`[report] CSV export generation failed: ${err.message}`);
      }

      const shown = rows.slice(0, MAX_USERS_IN_TABLE);

      const rankChunks = [];
      for (let i = 0; i < shown.length; i += RANK_LINES_PER_CHUNK) {
        const group = shown.slice(i, i + RANK_LINES_PER_CHUNK).map((r, gi) => {
          const idx = i + gi;
          const badge = medalOrRank(idx);
          const scoreLine = qualityMap
            ? `Quality **${r.qualityScore ?? '—'}**/10 · Behavior **${r.behaviorScore ?? '—'}**/10 · Overall **${r.overall}**/10`
            : `Activity **${r.activityScore}**/10`;
          return `${badge} **${r.tag}** — ${r.count} msg${r.count === 1 ? '' : 's'}\n${scoreBar(r.overall)}  ${scoreLine}`;
        }).join('\n\n');
        rankChunks.push(group);
      }

      const scoredShown = shown.filter(r => r.qualityScore !== null);
      const avgQuality = qualityMap && scoredShown.length
        ? (scoredShown.reduce((sum, r) => sum + r.qualityScore, 0) / scoredShown.length).toFixed(1)
        : null;
      const avgBehavior = qualityMap && scoredShown.length
        ? (scoredShown.reduce((sum, r) => sum + r.behaviorScore, 0) / scoredShown.length).toFixed(1)
        : null;
      const topChannelEntry = Array.from(channelCounts.entries()).sort((a, b) => b[1].count - a[1].count)[0];
      const topPerformer = shown[0];
      const scoredCount = qualityMap ? qualityMap.size : 0;
      const statusLine = qualityMap && !aiError
        ? `🤖 AI scoring: **on** (Gemini) — ${scoredCount}/${staffMembers.size} staff scored`
        : qualityMap && aiError
          ? `🤖 AI scoring: **partial** — ${scoredCount}/${staffMembers.size} staff scored\n-# Some batches failed: \`${aiError.slice(0, 200)}\``
          : aiError
            ? `⚠️ AI scoring failed entirely: \`${aiError.slice(0, 200)}\` — showing activity only`
            : `⚠️ AI scoring: **off** (no \`GEMINI_API_KEY\` configured) — showing activity only`;

      const channelScopeLine = filteredChannels !== null
        ? (channels.length <= 6
          ? `**Channels scanned:** ${channels.map(c => `#${c.name}`).join(', ')}${threadTargets.length ? ` (+ ${threadTargets.length} thread${threadTargets.length === 1 ? '' : 's'})` : ''}`
          : `**Channels scanned:** ${channels.length} selected channels${threadTargets.length ? ` (+ ${threadTargets.length} threads)` : ''}`)
        : `**Channels scanned:** ${channels.length} (all viewable)${threadTargets.length ? ` + ${threadTargets.length} thread${threadTargets.length === 1 ? '' : 's'}` : ''}`;

      const summaryLines = [
        '### 📈 Summary',
        `**Total staff messages:** ${totalScanned}`,
        `**Staff evaluated:** ${staffMembers.size}`,
        channelScopeLine,
        truncatedTargets.length
          ? `**⚠️ Hit the safety scan limit:** ${truncatedTargets.length} channel(s)/thread(s) had more than ${SAFETY_MAX_PAGES * 100} messages in range — those counts may be undercounted (this is a runaway-loop guard, not a deliberate cap; raise SAFETY_MAX_PAGES if you're hitting it legitimately).`
          : null,
        topChannelEntry ? `**Most active channel:** #${topChannelEntry[1].name} (${topChannelEntry[1].count} msgs${topChannelEntry[1].threadCount ? `, across ${topChannelEntry[1].threadCount} thread${topChannelEntry[1].threadCount === 1 ? '' : 's'}` : ''})` : null,
        topPerformer ? `**Top performer:** ${topPerformer.tag} (overall ${topPerformer.overall}/10)` : null,
        avgQuality ? `**Avg. AI quality score:** ${avgQuality}/10` : null,
        avgBehavior ? `**Avg. AI behavior score:** ${avgBehavior}/10` : null,
        statusLine,
        reportFile ? `📎 Full data for all **${rows.length}** staff (untruncated reviews included) is attached as **staff_report_full.csv**.` : null,
        reportFileError ? `⚠️ CSV export failed: \`${reportFileError.slice(0, 200)}\`` : null,
      ].filter(Boolean);

      const noteChunks = [];
      if (qualityMap) {
        // FIX: previously `shown.filter(r => r.summary)` dropped any row whose
        // summary was an empty string (i.e. users with messages but a failed AI
        // batch). Every row now always has a non-empty summary string, so we no
        // longer filter here — everyone shown in Rankings also gets a review entry.
        const withNotes = shown;
        for (let i = 0; i < withNotes.length; i += NOTES_PER_CHUNK) {
          const group = withNotes.slice(i, i + NOTES_PER_CHUNK)
            .map(r => {
              const q = r.qualityScore !== null ? `${r.qualityScore}/10` : 'no data';
              const b = r.behaviorScore !== null ? `${r.behaviorScore}/10` : 'no data';
              return `**${r.tag}** _(Quality: ${q} · Behavior: ${b})_\n${r.summary}`;
            })
            .join('\n\n');
          noteChunks.push(group);
        }
      }

      try {
        chartFile = await buildChartAttachment(rows.slice(0, MAX_USERS_IN_TABLE));
      } catch (err) {
        logger?.warn?.(`[report] Chart generation failed: ${err.message}`);
      }

      const bodyComponents = [
        textDisplay(`## 🛡️ Staff Report — ${role.name}`),
        textDisplay(`Since **${sinceStr}** · <t:${Math.floor(sinceTs / 1000)}:D> → now`),
        separator(),

        textDisplay(summaryLines.join('\n')),
        separator(),

        textDisplay(
          '### 🏆 Rankings' +
          (rows.length > MAX_USERS_IN_TABLE ? `\n-# Showing top ${MAX_USERS_IN_TABLE} of ${rows.length}` : '')
        ),
      ];

      for (const chunk of rankChunks) bodyComponents.push(textDisplay(chunk));
      if (qualityMap) {
        bodyComponents.push(textDisplay(`-# Overall = ${QUALITY_WEIGHT * 100}% AI quality + ${(1 - QUALITY_WEIGHT) * 100}% message-volume (scaled 0-10).`));
      }

      if (noteChunks.length) {
        bodyComponents.push(separator());
        bodyComponents.push(textDisplay('### 🤖 AI Reviews'));
        for (const chunk of noteChunks) bodyComponents.push(textDisplay(chunk));
      }

      if (reportFile) {
        bodyComponents.push(separator());
        bodyComponents.push(textDisplay('### 📎 Full Data Export'));
        bodyComponents.push(fileComponent('staff_report_full.csv'));
      }

      if (chartFile) {
        bodyComponents.push(separator());
        bodyComponents.push(textDisplay('### 📊 Chart'));
        bodyComponents.push(mediaGallery([{ url: 'attachment://staff_report_chart.png', description: 'Staff contribution chart' }]));
      }

      bodyComponents.push(separator());
      bodyComponents.push(textDisplay(`-# Generated <t:${Math.floor(Date.now() / 1000)}:R> · requested by ${interaction.user.tag}`));

      // Pack into multiple under-budget messages instead of one giant one.
      builtContainers = packComponents(bodyComponents, MESSAGE_TEXT_BUDGET);
      mediaGroupIndex = builtContainers.findIndex(group => group.some(c => c.type === ComponentType.MediaGallery));
      reportFileGroupIndex = builtContainers.findIndex(group => group.some(c => c.type === FILE_COMPONENT_TYPE));

      for (let i = 0; i < builtContainers.length; i++) {
        const files = [];
        if (i === reportFileGroupIndex && reportFile) files.push(reportFile);
        if (i === mediaGroupIndex && chartFile) files.push(chartFile);

        const payload = {
          content: null,
          components: [{ type: ComponentType.Container, components: builtContainers[i] }],
          files,
          flags: i === 0
            ? MessageFlags.IsComponentsV2
            : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, // followUp isn't ephemeral by default — say so explicitly
        };
        if (i === 0) {
          await interaction.editReply(payload);
        } else {
          await interaction.followUp(payload);
        }
        deliveredCount = i + 1;
      }
    } catch (err) {
      console.error('report command error:', err);

      // 50027 = "Invalid Webhook Token": the interaction token expired (>15min since
      // creation) before we finished sending every chunk. Deliver whatever's left as
      // regular channel messages instead of losing the work.
      if (err?.code === 50027 && builtContainers) {
        try {
          for (let i = deliveredCount; i < builtContainers.length; i++) {
            const files = [];
            if (i === reportFileGroupIndex && reportFile) files.push(reportFile);
            if (i === mediaGroupIndex && chartFile) files.push(chartFile);
            await interaction.channel.send({
              components: [{ type: ComponentType.Container, components: builtContainers[i] }],
              files,
              flags: MessageFlags.IsComponentsV2,
            });
          }
          return;
        } catch (fallbackErr) {
          console.error('report fallback channel send also failed:', fallbackErr);
        }
      }

      try {
        await interaction.editReply(`⚠️ Error building staff report: ${err?.message || String(err)}`);
      } catch {
        try {
          await interaction.channel.send(`⚠️ Error building staff report: ${err?.message || String(err)}`);
        } catch {}
      }
    }
  },
};
