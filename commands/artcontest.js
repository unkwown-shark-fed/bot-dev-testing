const {
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const path = require('path');
const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');
const { ArtContest, ArtEntry, ready } = require('../utils/artvotes');
const { isAuthorized } = require('../utils/auth');
const { sanitizeText } = require('../utils/csv');

// Requires discord.js >= 14.19 (Components V2), Node 18+ (global fetch) and MongoDB.

const MAX_ENTRIES = parseInt(process.env.ARTCONTEST_MAX || '500', 10);
const DEFAULT_LIMIT = 50;
const SCAN_CAP = parseInt(process.env.ARTCONTEST_SCAN_CAP || '10000', 10); // max channel messages scanned when matching by text
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const POST_DELAY_MS = 600;        // courtesy pacing between posts (discord.js also queues on rate limits)
const MAX_MEDIA_PER_ENTRY = 10;   // Media Gallery limit
const MAX_TEXT = 1500;
const ACCENT = 0x5865f2;
const VOTE_PREFIX = 'artvote';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const newContestId = () => Math.random().toString(36).slice(2, 8);

// ── Media detection (images, GIFs, videos) ───────────────────────────────────
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i;
const isMediaAttachment = a =>
  /^(image|video)\//.test(a.contentType || '') || MEDIA_EXT.test(a.name || '');

// Returns [{ url, name, size, contentType, description, external }] for a message.
// Attachments are re-uploaded later; link embeds (e.g. a pasted Tenor GIF) are
// referenced by URL because there is no file to re-upload.
function getMedia(msg) {
  const out = [];
  for (const a of msg.attachments.values()) {
    if (isMediaAttachment(a)) {
      out.push({ url: a.url, name: a.name, size: a.size, contentType: a.contentType, description: a.description || undefined });
    }
  }
  for (const e of msg.embeds || []) {
    const type = e.data?.type;
    let url = null;
    if (type === 'gifv') url = e.video?.url || e.thumbnail?.url;
    else if (type === 'image') url = e.thumbnail?.url || e.image?.url || e.url;
    if (url) out.push({ url, external: true });
  }
  return out.slice(0, MAX_MEDIA_PER_ENTRY);
}

// ── Component builder ────────────────────────────────────────────────────────
function buildEntryContainer(entry, closed = false) {
  const c = new ContainerBuilder().setAccentColor(closed ? 0x747f8d : ACCENT);

  let header = `### 🎨 Entry #${entry.entryNo}\n**Artist:** <@${entry.authorId}>`;
  if (entry.sourceLink) header += `\n-# [Original post](${entry.sourceLink})`;
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

  if (entry.content) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(entry.content.slice(0, MAX_TEXT)));
  }

  if (entry.files?.length) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        entry.files.slice(0, MAX_MEDIA_PER_ENTRY).map(f => {
          const item = new MediaGalleryItemBuilder().setURL(f.ref);
          if (f.description) item.setDescription(f.description.slice(0, 1024));
          return item;
        }),
      ),
    );
  }

  c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  const id = action => `${VOTE_PREFIX}:${entry._id}:${action}`;
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(id('up')).setStyle(ButtonStyle.Success).setLabel(String(entry.upvotes.length)).setEmoji('👍').setDisabled(closed),
      new ButtonBuilder().setCustomId(id('down')).setStyle(ButtonStyle.Danger).setLabel(String(entry.downvotes.length)).setEmoji('👎').setDisabled(closed),
      new ButtonBuilder().setCustomId(id('ai')).setStyle(ButtonStyle.Secondary).setLabel(`AI ${entry.ai.length}`).setEmoji('🤖').setDisabled(closed),
      new ButtonBuilder().setCustomId(id('copy')).setStyle(ButtonStyle.Secondary).setLabel(`Copyrighted ${entry.copyright.length}`).setEmoji('🚩').setDisabled(closed),
    ),
  );

  return c;
}

// ── CSV import ───────────────────────────────────────────────────────────────
// Minimal RFC-4180 parser (quoted fields, escaped quotes, CRLF/LF, BOM).
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Snowflake out of "'123…", ="123…" or plain 123… (Excel-safe forms from /export).
const snowflake = v => (String(v || '').match(/\d{15,21}/) || [''])[0];

// /export columns (by position, because header text is unreliable):
//   0 discord_user_id · 1 discord_username · 2 game_uid · 3 message_content · 4 message_id (optional)
function parseSubmissions(rows) {
  if (!rows.length) return [];
  let body = rows;
  let header = null;
  if (!snowflake(rows[0][0])) { header = rows[0]; body = rows.slice(1); }

  let msgIdx = header ? header.findIndex(h => /^message_?id$/i.test(String(h).trim())) : -1;
  if (msgIdx < 0 && body.some(r => r.length >= 5 && snowflake(r[4]))) msgIdx = 4;

  return body
    .map(r => ({
      authorId: snowflake(r[0]),
      tag: r[1] || '',
      uid: r[2] || '',
      content: r[3] || '',
      messageId: msgIdx >= 0 ? snowflake(r[msgIdx]) : '',
    }))
    .filter(r => r.authorId);
}

const hasMedia = m => getMedia(m).length > 0;

// All messages in a channel, oldest → newest (bounded by SCAN_CAP).
async function fetchHistory(channel, onProgress) {
  const all = [];
  let before;
  while (all.length < SCAN_CAP) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    const arr = [...batch.values()];
    all.push(...arr);
    before = arr[arr.length - 1].id;
    if (onProgress) await onProgress(all.length);
    if (batch.size < 100) break;
    await sleep(250);
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Turn CSV rows into real Discord messages (which carry the images).
//  • Row has message_id → fetch that exact message.
//  • Otherwise → match on (author, message text). The CSV and the channel are
//    both chronological, so when a group of identical (author, text) rows has the
//    SAME count in the CSV and the channel, the Nth row is the Nth message.
//    If the counts differ (rows removed from the CSV, messages deleted or added
//    since the export) we can't know which image belongs to which row, so that
//    group is skipped instead of risking the wrong art on a card.
async function resolveMessages(channel, subs, onProgress) {
  const stats = { rows: subs.length, noMedia: 0, missing: 0, mismatch: 0, ambiguous: 0, ambiguousUsers: new Set() };
  const resolved = new Array(subs.length).fill(null);

  const direct = subs.map((s, i) => [s, i]).filter(([s]) => s.messageId);
  for (const [k, [sub, i]] of direct.entries()) {
    let msg = null;
    try { msg = await channel.messages.fetch(sub.messageId); } catch (_) { /* deleted / not in channel */ }
    if (!msg) stats.missing++;
    else if (msg.author.id !== sub.authorId) stats.mismatch++;
    else resolved[i] = msg;
    if (onProgress && k % 10 === 0) await onProgress(`Looking up messages... ${k + 1}/${direct.length}`);
  }

  const legacy = subs.map((s, i) => [s, i]).filter(([s]) => !s.messageId);
  if (legacy.length) {
    const history = await fetchHistory(channel, n => onProgress?.(`Reading channel history... ${n} messages`));
    const key = (authorId, text) => `${authorId}\u0000${sanitizeText(text)}`;

    const chan = new Map();
    for (const m of history) {
      const k = key(m.author.id, m.content);
      if (!chan.has(k)) chan.set(k, []);
      chan.get(k).push(m);
    }
    const csvGroups = new Map();
    for (const [sub, i] of legacy) {
      const k = key(sub.authorId, sub.content);
      if (!csvGroups.has(k)) csvGroups.set(k, []);
      csvGroups.get(k).push(i);
    }

    for (const [k, idxs] of csvGroups) {
      const msgs = chan.get(k) || [];
      if (!msgs.length) { stats.missing += idxs.length; continue; }
      if (msgs.length === idxs.length) { idxs.forEach((rowIdx, n) => { resolved[rowIdx] = msgs[n]; }); continue; }
      if (!msgs.some(hasMedia)) { stats.noMedia += idxs.length; continue; } // plain chat, nothing to post
      stats.ambiguous += idxs.length;
      idxs.forEach(rowIdx => stats.ambiguousUsers.add(subs[rowIdx].tag || subs[rowIdx].authorId));
    }
  }

  const matched = [];
  resolved.forEach((msg, i) => {
    if (!msg) return;
    if (!hasMedia(msg)) { stats.noMedia++; return; }
    matched.push({ sub: subs[i], msg });
  });
  return { matched, stats };
}

// Re-upload attachments so they never expire. Falls back to the original URL
// when a download fails or the upload budget is exhausted (`fallbacks` counts
// those, since Discord CDN links eventually expire).
async function prepareFiles(msg, entryNo, budgetBytes) {
  const files = [];
  const uploads = [];
  let fallbacks = 0;
  let remaining = budgetBytes;

  for (const [i, m] of getMedia(msg).entries()) {
    if (m.external) { files.push({ ref: m.url }); continue; }

    let done = false;
    if (m.size <= remaining) {
      try {
        const res = await fetch(m.url, { signal: AbortSignal.timeout(60_000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length <= remaining) {
            const fromName = path.extname(m.name || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
            const ext = fromName || ((m.contentType || '').startsWith('video/') ? '.mp4' : '.png');
            const name = `art${entryNo}_${i + 1}${ext}`;
            uploads.push(new AttachmentBuilder(buf, { name, description: m.description }));
            files.push({ ref: `attachment://${name}`, description: m.description });
            remaining -= buf.length;
            done = true;
          }
        }
      } catch (_) { /* fall through to URL fallback */ }
    }
    if (!done) { files.push({ ref: m.url, description: m.description }); fallbacks++; }
  }
  return { files, uploads, fallbacks };
}

// ── Voting (single atomic DB operation per step) ─────────────────────────────
const VOTE_FIELDS = { up: 'upvotes', down: 'downvotes', ai: 'ai', copy: 'copyright' };
const OPPOSITE = { up: 'downvotes', down: 'upvotes' };

// Each findOneAndUpdate below is atomic on the single entry document, so two
// simultaneous clicks can't overwrite each other (no read-then-write):
//   1. "remove" only matches if the user IS in the list → toggle off.
//   2. "add" only matches if the user is NOT in the list → toggle on
//      (and, for 👍/👎, pull them from the opposite list in the same update).
// If neither matches, another click changed the list in between, so retry.
async function applyVote(entryId, uid, action) {
  const field = VOTE_FIELDS[action];
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc = await ArtEntry.findOneAndUpdate(
      { _id: entryId, [field]: uid },
      { $pull: { [field]: uid } },
      { new: true },
    );
    if (doc) return { doc, result: 'removed' };

    const update = { $addToSet: { [field]: uid } };
    if (OPPOSITE[action]) update.$pull = { [OPPOSITE[action]]: uid };
    doc = await ArtEntry.findOneAndUpdate(
      { _id: entryId, [field]: { $ne: uid } },
      update,
      { new: true },
    );
    if (doc) return { doc, result: 'added' };
  }
  return null; // entry deleted, or heavy contention
}

const VOTE_LABELS = {
  up: ['👍 Upvote', 'upvote'],
  down: ['👎 Downvote', 'downvote'],
  ai: ['🤖 AI flag', 'AI flag'],
  copy: ['🚩 Copyright flag', 'copyright flag'],
};

function memberRoleIds(member) {
  const roles = member?.roles;
  if (Array.isArray(roles)) return roles;                 // raw API member
  return [...(roles?.cache?.keys?.() ?? [])];             // GuildMember
}

// Interaction replies can only be edited for 15 minutes. Big imports can outlive
// that, so progress edits stop after 14 min and the final summary falls back to a
// DM (or, if DMs are closed, a message in the channel the command was run in).
const REPLY_WINDOW_MS = 14 * 60 * 1000;
function makeResponder(interaction) {
  const started = Date.now();
  const live = () => Date.now() - started < REPLY_WINDOW_MS;
  return {
    live,
    async update(payload) {
      if (!live()) return;
      try { await interaction.editReply(payload); } catch (_) { /* progress is best-effort */ }
    },
    async final(payload) {
      const p = typeof payload === 'string' ? { content: payload } : { ...payload };
      if (live()) {
        try { return await interaction.editReply(p); } catch (_) { /* fall through */ }
      }
      p.content = `📬 *Sent separately because the command's reply window expired.*\n${p.content || ''}`;
      try { return await interaction.user.send(p); } catch (_) { /* DMs closed */ }
      try { return await interaction.channel?.send(p); } catch (_) { return null; }
    },
  };
}

// ── Subcommand: import ───────────────────────────────────────────────────────
async function handleImport(interaction) {
  const csvFile = interaction.options.getAttachment('csv', true);
  const target = interaction.options.getChannel('target', true);
  const sourceOpt = interaction.options.getChannel('source');
  const dryRun = interaction.options.getBoolean('dry_run') ?? false;
  const reply = makeResponder(interaction);
  const limit = Math.min(interaction.options.getInteger('limit') ?? MAX_ENTRIES, MAX_ENTRIES);
  const voterRoleIds = ['voter_role', 'voter_role_2', 'voter_role_3']
    .map(n => interaction.options.getRole(n))
    .filter(Boolean)
    .map(r => r.id);

  if (!/\.csv$/i.test(csvFile.name || '')) return interaction.editReply('Please attach a `.csv` file (from `/export`).');
  if (csvFile.size > MAX_CSV_BYTES) return interaction.editReply('That CSV is larger than 5 MB.');
  if (!target?.isTextBased?.()) return interaction.editReply('Please provide a valid target text channel.');

  // Source channel: explicit option, else the channel id embedded in the /export filename.
  let source = sourceOpt;
  if (!source) {
    const m = (csvFile.name || '').match(/_(\d{17,21})_\d+\.csv$/i);
    if (m) source = await interaction.guild.channels.fetch(m[1]).catch(() => null);
  }
  if (!source?.isTextBased?.()) {
    return interaction.editReply('I could not tell which channel this CSV came from. Pass the `source` channel option.');
  }

  const me = interaction.client.user;
  if (!source.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    return interaction.editReply(`I need View Channel and Read Message History in ${source}.`);
  }
  if (!dryRun && !target.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
    return interaction.editReply('I need View Channel, Send Messages and Attach Files in the target channel.');
  }

  await interaction.editReply('📄 Reading CSV...');
  const res = await fetch(csvFile.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return interaction.editReply('Could not download the CSV attachment.');
  const subs = parseSubmissions(parseCsv(await res.text()));
  if (!subs.length) return interaction.editReply('No rows found in that CSV.');

  let lastEdit = 0;
  const progress = async text => {
    if (Date.now() - lastEdit < 3000) return;
    lastEdit = Date.now();
    await reply.update(`🔎 ${text}`);
  };
  const { matched: all, stats } = await resolveMessages(source, subs, progress);
  const matched = all.slice(0, limit);

  const summary =
    `CSV rows: **${stats.rows}** · with art: **${all.length}**` +
    (stats.noMedia ? `\n• ${stats.noMedia} without an image/GIF/video (chat or announcements)` : '') +
    (stats.missing ? `\n• ${stats.missing} original message(s) not found (deleted?)` : '') +
    (stats.mismatch ? `\n• ${stats.mismatch} message(s) whose author didn't match the CSV` : '') +
    (stats.ambiguous
      ? `\n• ⚠️ ${stats.ambiguous} row(s) skipped as ambiguous (identical text from the same user, but the CSV and channel counts differ, so the right image can't be told apart): ` +
        `${[...stats.ambiguousUsers].slice(0, 8).join(', ')}${stats.ambiguousUsers.size > 8 ? '…' : ''}. ` +
        'Re-export with the updated `/export` (adds `message_id`) to include them.'
      : '') +
    (all.length > matched.length ? `\n• Limited to the first ${matched.length} entries.` : '');

  if (!matched.length) return interaction.editReply(`Nothing to post.\n${summary}`);
  if (dryRun) {
    const preview = matched.slice(0, 10).map((m, i) => `${i + 1}. <@${m.sub.authorId}> — ${getMedia(m.msg).length} file(s)`).join('\n');
    return interaction.editReply({ content: `🧪 **Dry run** — nothing posted.\n${summary}\n\n${preview}`, allowedMentions: { parse: [] } });
  }

  if (matched.length > 300) {
    await reply.update(`⏳ Posting ${matched.length} entries — this takes roughly ${Math.ceil(matched.length * 2 / 60)} minutes. The summary will be DMed to you if it runs past Discord's 15-minute reply window.`);
  }
  await ready();
  const contestId = newContestId();
  await ArtContest.create({
    contestId,
    guildId: interaction.guildId,
    sourceChannelId: source.id,
    targetChannelId: target.id,
    createdBy: interaction.user.id,
    voterRoleIds,
  });

  const uploadBudget = Math.max(1, (interaction.guild?.maximumUploadLimit || 10 * 1024 * 1024) - 256 * 1024);
  let posted = 0;
  let failed = 0;
  let fallbackTotal = 0;

  for (const [idx, { sub, msg }] of matched.entries()) {
    const entryNo = idx + 1;
    let doc;
    try {
      const { files, uploads, fallbacks } = await prepareFiles(msg, entryNo, uploadBudget);
      doc = await ArtEntry.create({
        contestId,
        guildId: interaction.guildId,
        entryNo,
        targetChannelId: target.id,
        sourceMessageId: msg.id,
        sourceLink: `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`,
        authorId: sub.authorId,
        content: msg.content || '',
        files,
      });

      const sent = await target.send({
        components: [buildEntryContainer(doc)],
        files: uploads,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
      });
      doc.targetMessageId = sent.id;
      await doc.save();
      posted++;
      fallbackTotal += fallbacks;
    } catch (err) {
      failed++;
      console.warn(`[artcontest] entry from message ${msg.id} failed: ${err?.message || err}`);
      if (doc) await ArtEntry.deleteOne({ _id: doc._id }).catch(() => {});
    }

    if (entryNo % 5 === 0) {
      await reply.update(`📤 Posting entries... ${entryNo}/${matched.length}`);
    }
    await sleep(POST_DELAY_MS);
  }

  return reply.final({
    content:
      `✅ Posted **${posted}/${matched.length}** entries to ${target}.\n` +
      `🗳️ Voting limited to: ${voterRoleIds.map(id => `<@&${id}>`).join(', ')}\n` +
      `${summary}\n` +
      (failed ? `⚠️ ${failed} failed to post (see logs).\n` : '') +
      (fallbackTotal ? `⚠️ ${fallbackTotal} file(s) were too large to re-upload and use the original Discord links, which may expire.\n` : '') +
      `Contest ID: \`${contestId}\` — use it with \`/artcontest results\`, \`voters\` or \`close\`.`,
    allowedMentions: { parse: [] },
  });
}

// ── Subcommand helpers: results / close / voters ─────────────────────────────
async function resolveContest(interaction) {
  await ready();
  const id = interaction.options.getString('contest');
  if (id) return ArtContest.findOne({ contestId: id.trim(), guildId: interaction.guildId });
  return ArtContest.findOne({ guildId: interaction.guildId }).sort({ createdAt: -1 });
}

async function handleResults(interaction) {
  const contest = await resolveContest(interaction);
  if (!contest) return interaction.editReply('No contest found.');

  const entries = await ArtEntry.find({ contestId: contest.contestId }).lean();
  if (!entries.length) return interaction.editReply('That contest has no entries.');

  const scored = entries
    .map(e => ({ ...e, score: e.upvotes.length - e.downvotes.length }))
    .sort((a, b) => b.score - a.score || b.upvotes.length - a.upvotes.length)
    .slice(0, 15);

  const lines = scored.map((e, i) => {
    const link = e.targetMessageId
      ? `https://discord.com/channels/${e.guildId}/${e.targetChannelId}/${e.targetMessageId}`
      : null;
    const flags = [];
    if (e.ai.length) flags.push(`🤖 ${e.ai.length}`);
    if (e.copyright.length) flags.push(`🚩 ${e.copyright.length}`);
    return `**${i + 1}.** ${link ? `[Entry #${e.entryNo}](${link})` : `Entry #${e.entryNo}`} — <@${e.authorId}>\n` +
           `　score **${e.score}** (👍 ${e.upvotes.length} / 👎 ${e.downvotes.length})${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
  });

  const embed = createEmbed({
    title: `🏆 Art Contest Results — \`${contest.contestId}\`${contest.closed ? ' (closed)' : ''}`,
    description: lines.join('\n').slice(0, 4000),
    color: EMBED_COLORS.warning,
    footer: `Top ${scored.length} of ${entries.length} entries · score = 👍 − 👎`,
  });
  return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleClose(interaction) {
  const contest = await resolveContest(interaction);
  if (!contest) return interaction.editReply('No contest found.');
  if (contest.closed) return interaction.editReply(`Contest \`${contest.contestId}\` is already closed.`);
  contest.closed = true;
  await contest.save();
  return interaction.editReply(
    `🔒 Voting closed for contest \`${contest.contestId}\`. Buttons will reject new votes. ` +
    `Run \`/artcontest results\` to see the standings.`,
  );
}

// Replace the allowed voter roles on an existing contest.
async function handleVoters(interaction) {
  const contest = await resolveContest(interaction);
  if (!contest) return interaction.editReply('No contest found.');

  const ids = ['role', 'role_2', 'role_3']
    .map(n => interaction.options.getRole(n))
    .filter(Boolean)
    .map(r => r.id);

  contest.voterRoleIds = ids;
  await contest.save();
  return interaction.editReply({
    content: `✅ Contest \`${contest.contestId}\`: voting is now limited to ${ids.map(id => `<@&${id}>`).join(', ')}.`,
    allowedMentions: { parse: [] },
  });
}

// ── Command definition ───────────────────────────────────────────────────────
module.exports = {
  category: 'Community',
  restricted: true,
  cooldown: 10,
  data: createCommandBuilder({
    name: 'artcontest',
    description: 'Post art contest submissions (from an /export CSV) as voting cards.',
    configure: builder => builder
      .addSubcommand(s => s.setName('import')
        .setDescription('Post voting cards for the art submissions listed in an /export CSV')
        .addAttachmentOption(o => o.setName('csv').setDescription('CSV exported with /export from the contest channel').setRequired(true))
        .addChannelOption(o => o.setName('target').setDescription('Channel where voting cards are posted').setRequired(true))
        .addRoleOption(o => o.setName('voter_role').setDescription('Role allowed to vote').setRequired(true))
        .addRoleOption(o => o.setName('voter_role_2').setDescription('Another role allowed to vote').setRequired(false))
        .addRoleOption(o => o.setName('voter_role_3').setDescription('Another role allowed to vote').setRequired(false))
        .addChannelOption(o => o.setName('source').setDescription('Contest channel (auto-detected from the CSV filename)').setRequired(false))
        .addBooleanOption(o => o.setName('dry_run').setDescription('Only show what would be posted').setRequired(false))
        .addIntegerOption(o => o.setName('limit').setDescription(`Max entries to post (max ${MAX_ENTRIES})`).setMinValue(1).setMaxValue(MAX_ENTRIES).setRequired(false)))
      .addSubcommand(s => s.setName('voters')
        .setDescription('Change which roles can vote in a contest')
        .addRoleOption(o => o.setName('role').setDescription('Role allowed to vote').setRequired(true))
        .addRoleOption(o => o.setName('role_2').setDescription('Another role allowed to vote').setRequired(false))
        .addRoleOption(o => o.setName('role_3').setDescription('Another role allowed to vote').setRequired(false))
        .addStringOption(o => o.setName('contest').setDescription('Contest ID (defaults to the latest)').setRequired(false)))
      .addSubcommand(s => s.setName('results')
        .setDescription('Show the current standings')
        .addStringOption(o => o.setName('contest').setDescription('Contest ID (defaults to the latest)').setRequired(false)))
      .addSubcommand(s => s.setName('close')
        .setDescription('Stop accepting votes')
        .addStringOption(o => o.setName('contest').setDescription('Contest ID (defaults to the latest)').setRequired(false))),
  }),

  async execute(interaction) {
    // Owner-only for now (BOT_OWNER_ID). Voting buttons are NOT gated by this — see handleComponent.
    if (!isAuthorized(interaction, { ownerOnly: true })) {
      return interaction.reply({
        content: '🔒 This command is currently restricted to the bot owner.',
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === 'import') return await handleImport(interaction);
      if (sub === 'voters') return await handleVoters(interaction);
      if (sub === 'results') return await handleResults(interaction);
      if (sub === 'close') return await handleClose(interaction);
    } catch (err) {
      console.error('artcontest error:', err);
      try { await interaction.editReply(`Error: ${err?.message || err}`); } catch (_) {}
    }
  },

  // Routed from index.js for every button whose customId starts with "artvote:".
  async handleComponent(interaction, client, logger) {
    const log = logger || console;
    if (!interaction.isButton()) return;
    const [prefix, entryId, action] = interaction.customId.split(':');
    if (prefix !== VOTE_PREFIX) return;

    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

    try {
      if (!VOTE_FIELDS[action]) return reply('❌ Unknown action.');

      await ready();
      const entry = await ArtEntry.findById(entryId).lean();
      if (!entry) return reply('❌ This entry no longer exists.');

      const contest = await ArtContest.findOne({ contestId: entry.contestId }).lean();
      if (!contest) return reply('❌ This contest no longer exists.');
      if (contest.closed) return reply('🔒 Voting for this contest is closed.');

      const uid = interaction.user.id;

      // Role gate (empty list = open to everyone, for contests created before roles existed).
      if (contest.voterRoleIds?.length) {
        const mine = memberRoleIds(interaction.member);
        if (!contest.voterRoleIds.some(r => mine.includes(r))) {
          return reply(`🔒 Only members with ${contest.voterRoleIds.map(r => `<@&${r}>`).join(' or ')} can vote.`);
        }
      }

      if (uid === entry.authorId) return reply("🙅 You can't vote on your own entry.");

      const outcome = await applyVote(entry._id, uid, action);
      if (!outcome) return reply('⚠️ Could not register your vote. Please try again.');

      // No `files` here: the original attachments stay on the message.
      await interaction.update({
        components: [buildEntryContainer(outcome.doc)],
        flags: MessageFlags.IsComponentsV2,
      });

      // Private confirmation so the voter knows exactly what was recorded.
      const [label, plain] = VOTE_LABELS[action];
      await interaction.followUp({
        content: outcome.result === 'added'
          ? `✅ ${label} recorded for entry #${entry.entryNo}. Click again to undo.`
          : `↩️ Your ${plain} on entry #${entry.entryNo} was removed.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (err) {
      log.error?.(`artcontest vote error: ${err.message}`);
      if (!interaction.replied && !interaction.deferred) {
        await reply('⚠️ Could not register your vote. Please try again.').catch(() => {});
      }
    }
  },
};