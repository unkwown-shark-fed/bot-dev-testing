// ═════════════════════════════════════════════════════════════════════════════
// PASTE THIS OVER EVERYTHING FROM the line "// ── Chart via QuickChart ..." TO THE END OF report.js
// (i.e. buildChartAttachment, the CSV helpers, packComponents and module.exports are all replaced).
// Everything above that line (scanning helpers, prompts, Gemini pipeline) stays untouched.
// ═════════════════════════════════════════════════════════════════════════════

// ── Scan ONE member's messages ───────────────────────────────────────────────
// Reads every channel/thread, but keeps only this member's messages from each one and drops the
// rest immediately — so memory stays small even on huge servers (the old code held every
// channel's raw messages for everybody until the scan finished).
async function scanForUser(targets, sinceTs, userId, onProgress) {
  const results = new Array(targets.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < targets.length) {
      const i = next++;
      const target = targets[i];
      const { messages, truncated } = await fetchChannelMessagesSince(target, sinceTs);

      // Lets us attach "what they were replying to" without any extra API calls.
      const byId = new Map(messages.map(m => [m.id, m]));
      const mine = [];
      for (const msg of messages) {
        if (msg.author.id !== userId || msg.system) continue;
        const parent = msg.reference?.messageId ? byId.get(msg.reference.messageId) : null;
        mine.push({
          ts: msg.createdTimestamp,
          d: new Date(msg.createdTimestamp).toISOString().slice(0, 10),
          ch: target.name,
          isReply: !!msg.reference?.messageId,
          replyTo: parent?.content ? prepText(parent.content, MAX_REPLY_CONTEXT_CHARS) : undefined,
          text: msg.content ? prepText(msg.content, MAX_MSG_CHARS) : '', // '' = attachment/embed/sticker only
        });
      }

      results[i] = { target, truncated, mine };
      done++;
      onProgress?.(done, targets.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHANNEL_FETCH_CONCURRENCY, targets.length) }, worker));
  return results;
}

// ── CSV exports ──────────────────────────────────────────────────────────────
function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const FILE_COMPONENT_TYPE = 13; // Discord Components V2 "File" component — required to display non-image attachments

// A Components V2 message only renders attachments that a component explicitly points at.
function fileComponent(filename) {
  return { type: FILE_COMPONENT_TYPE, file: { url: `attachment://${filename}` } };
}

function flagText(flags) {
  return (flags || []).map(f => FLAG_LABELS[f] || f).join(', ');
}

// Every text message that was read, exactly as it was sent to the AI (same index numbers the AI cites).
function buildRawMessagesCsv(tag, userId, messages) {
  const header = ['Discord Tag', 'User ID', 'Date', 'Channel', 'Message Index', 'Replying To', 'Message Text'];
  const lines = [header.map(csvEscape).join(',')];
  for (const m of messages) {
    lines.push([
      tag,
      `="${userId}"`, // keep as text so 18-digit Discord IDs don't turn into scientific notation
      m.d,
      m.ch,
      m.i,
      m.replyTo || '',
      m.text,
    ].map(csvEscape).join(','));
  }
  return new AttachmentBuilder(Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8'), { name: 'member_raw_messages.csv' });
}

// One-row summary with the untruncated AI review.
function buildReviewCsv(row) {
  const header = [
    'Discord Tag', 'User ID', 'Messages', 'Text Messages Reviewed',
    'Quality Score (/10)', 'Behavior Score (/10)', 'Overall Score (/10)',
    'Confidence', 'Flags', 'Evidence (message indexes)', 'AI Review',
  ];
  const line = [
    row.tag,
    `="${row.userId}"`,
    row.count,
    row.reviewed,
    row.qualityScore ?? '',
    row.behaviorScore ?? '',
    row.overall ?? '',
    row.confidence,
    flagText(row.flags),
    (row.evidence || []).join(' '),
    row.fullSummary,
  ].map(csvEscape).join(',');
  return new AttachmentBuilder(Buffer.from('\uFEFF' + [header.map(csvEscape).join(','), line].join('\r\n'), 'utf8'), { name: 'member_review.csv' });
}

// ── Display helpers ──────────────────────────────────────────────────────────
function scoreBar(score) {
  if (score === null || score === undefined) return '░░░░░░░░░░';
  const filled = Math.max(0, Math.min(10, Math.round(score)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

// One member only, so there is nothing to compare message volume against — overall is just
// the weighted mix of the AI's quality and behavior scores.
function computeOverall(qualityScore, behaviorScore) {
  const weightSum = QUALITY_WEIGHT + BEHAVIOR_WEIGHT;
  let overall = (QUALITY_WEIGHT * qualityScore + BEHAVIOR_WEIGHT * behaviorScore) / weightSum;
  if (behaviorScore <= LOW_BEHAVIOR_THRESHOLD) overall = Math.min(overall, LOW_BEHAVIOR_OVERALL_CAP);
  return Math.round(overall * 10) / 10;
}

const oneLine = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
};

// Discord enforces a 4000-character TOTAL text budget across all components in a single
// message, so the flat component list is packed into several messages, each under budget.
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

// ── The command ──────────────────────────────────────────────────────────────
module.exports = {
  category: 'Moderation',
  data: createCommandBuilder({
    name: 'report',
    // Discord caps command descriptions at 100 characters (the old one was 112, which is what
    // caused "Invalid string length" and the command being skipped at startup).
    description: 'AI review of one member\'s messages since a date',
    // Required options MUST come before optional ones.
    configure: builder => builder
      .addUserOption(o => o.setName('user').setDescription('Member to review').setRequired(true))
      .addStringOption(o => o.setName('since').setDescription('Start date, format YYYY-MM-DD').setRequired(true))
      .addStringOption(o => o.setName('channels').setDescription('Channels/threads to scan: mentions or IDs, space/comma-separated').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('Single channel/thread to scan (ignored if "channels" is set; default: all)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)
        .setRequired(false)),
  }),
  restricted: false,
  cooldown: 60,
  async execute(interaction, client, logger) {
    if (!isAuthorized(interaction, { ownerOnly: true })) {
      return interaction.reply({ content: '🔒 This command is restricted to the bot owner.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Interaction tokens expire 15 min after creation (Discord-side limit). The scan is never cut
    // short for that; if the token has died by the time we finish, the catch block delivers the
    // remaining report parts by DM instead of losing the work.
    let builtContainers = null;
    let reportFile = null;
    let reportFileGroupIndex = -1;
    let deliveredCount = 0;

    try {
      const targetUser = interaction.options.getUser('user', true);
      const sinceStr = interaction.options.getString('since', true);

      if (targetUser.bot) {
        return interaction.editReply('❌ That\'s a bot account — pick a human member.');
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceStr)) {
        return interaction.editReply(`❌ "${sinceStr}" isn't a valid date. Use format YYYY-MM-DD, e.g. 2026-08-01.`);
      }
      const sinceDate = new Date(`${sinceStr}T00:00:00Z`);
      if (isNaN(sinceDate.getTime())) {
        return interaction.editReply(`❌ "${sinceStr}" isn't a valid date. Use format YYYY-MM-DD, e.g. 2026-08-01.`);
      }
      const sinceTs = sinceDate.getTime();

      const guild = interaction.guild;
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) {
        return interaction.editReply(`❌ ${targetUser.tag} isn't a member of this server.`);
      }
      const userId = member.id;
      const userTag = member.user.tag;

      // Gives the AI context on what this person's role is, so the Helper-vs-Moderator guidance applies.
      const highest = member.roles.highest;
      const roleName = highest && highest.id !== guild.id ? highest.name : 'Staff member';

      const botMember = await guild.members.fetchMe();

      // ── Which channels to scan ──
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
        `🔍 Scanning ${channels.length} channel(s) (+ their threads) for **${userTag}** since **${sinceStr}**… this can take a bit.` +
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

      // ── Scan ──
      let lastEdit = 0;
      const scanned = await scanForUser(scanTargets, sinceTs, userId, (done, total) => {
        const now = Date.now();
        if (now - lastEdit < 4000 && done < total) return; // throttle edits
        lastEdit = now;
        interaction.editReply(`🔍 Scanning… ${done}/${total} channels/threads done for **${userTag}** since **${sinceStr}**.`).catch(() => {});
      });

      // ── Aggregate this member's data ──
      const entry = { tag: userTag, count: 0, messages: [] }; // messages = every message WITH text
      const activeDays = new Set();
      const channelCounts = new Map();
      const truncatedTargets = [];
      let firstTs = null;
      let lastTs = null;
      let replyCount = 0;

      for (const r of scanned) {
        if (!r) continue;
        if (r.truncated) truncatedTargets.push(r.target);

        for (const m of r.mine) {
          entry.count++;
          activeDays.add(m.d);
          firstTs = firstTs === null ? m.ts : Math.min(firstTs, m.ts);
          lastTs = lastTs === null ? m.ts : Math.max(lastTs, m.ts);
          if (m.isReply) replyCount++;
          if (m.text) entry.messages.push({ ts: m.ts, d: m.d, ch: m.ch, replyTo: m.replyTo, text: m.text });
        }

        if (r.mine.length) {
          const isThread = threadParent.has(r.target.id);
          const baseId = isThread ? threadParent.get(r.target.id) : r.target.id;
          const baseChannel = isThread ? channels.find(c => c.id === baseId) : r.target;
          const existing = channelCounts.get(baseId) || { name: baseChannel?.name || r.target.name, count: 0, threadCount: 0 };
          existing.count += r.mine.length;
          if (isThread) existing.threadCount++;
          channelCounts.set(baseId, existing);
        }
      }

      // Chronological order + a stable index, so every AI citation can be looked up here.
      entry.messages.sort((a, b) => a.ts - b.ts);
      entry.messages.forEach((m, i) => { m.i = i; });
      const reviewed = entry.messages.length;

      if (entry.count === 0) {
        return interaction.editReply(`No messages from **${userTag}** found in the scanned channels since **${sinceStr}**.`);
      }

      // Raw data first, so it's in your hands even if the AI is slow or fails.
      if (reviewed > 0) {
        try {
          await interaction.followUp({
            content: `📎 Raw export — all ${reviewed} text message(s) from **${userTag}**, exactly as the AI will read them. Starting the AI review now…`,
            files: [buildRawMessagesCsv(userTag, userId, entry.messages)],
            flags: MessageFlags.Ephemeral,
          });
        } catch (err) {
          logger?.warn?.(`[report] Raw message CSV export failed: ${err.message}`);
        }
      }

      // ── AI review ──
      let review = null;
      let aiError = null;
      if (reviewed > 0) {
        interaction.editReply(
          `🤖 Scan complete — ${entry.count} message(s), ${reviewed} with text. Running the AI review on ALL of them` +
          ` (long histories are read in slices, so this can take several minutes; it auto-retries and falls back to other models)…`
        ).catch(() => {});

        try {
          const aiResult = await scoreQualityWithAI(
            [{ userId, tag: userTag, count: entry.count, messages: entry.messages }],
            roleName,
            (msg) => { interaction.editReply(msg).catch(() => {}); }
          );
          review = aiResult.map?.get(userId) || null;
          if (!review && aiResult.errors.length) aiError = aiResult.errors.join(' | ');
        } catch (err) {
          aiError = err.message;
          logger?.warn?.(`[report] AI scoring failed: ${aiError}`);
        }
      }

      const overall = review ? computeOverall(review.qualityScore, review.behaviorScore) : null;

      let fullSummary;
      if (review) fullSummary = review.fullSummary;
      else if (reviewed === 0) fullSummary = 'No reviewable text — every message in range was an attachment/embed/sticker with no text.';
      else fullSummary = 'AI review unavailable.';

      const row = {
        userId,
        tag: userTag,
        count: entry.count,
        reviewed,
        qualityScore: review?.qualityScore ?? null,
        behaviorScore: review?.behaviorScore ?? null,
        overall,
        confidence: review?.confidence || '',
        flags: review?.flags || [],
        evidence: review?.evidence || [],
        fullSummary,
      };

      let reportFileError = null;
      try {
        reportFile = buildReviewCsv(row);
      } catch (err) {
        reportFile = null;
        reportFileError = err.message;
        logger?.warn?.(`[report] CSV export generation failed: ${err.message}`);
      }

      // ── Build the report ──
      const fmtDate = ts => `<t:${Math.floor(ts / 1000)}:D>`;
      const topChannels = Array.from(channelCounts.values()).sort((a, b) => b.count - a.count).slice(0, 8);
      const attachmentOnly = entry.count - reviewed;

      const dataLines = [
        '### 📈 Activity',
        `**Total messages:** ${entry.count} (${reviewed} with text — all read by the AI, no sampling${attachmentOnly ? `; ${attachmentOnly} attachment/embed/sticker-only` : ''})`,
        `**First → last message:** ${fmtDate(firstTs)} → ${fmtDate(lastTs)}`,
        `**Active days:** ${activeDays.size}`,
        `**Replies to other messages:** ${replyCount}`,
        `**Channels scanned:** ${channels.length}${filteredChannels === null ? ' (all viewable)' : ''}${threadTargets.length ? ` + ${threadTargets.length} thread${threadTargets.length === 1 ? '' : 's'}` : ''}`,
        topChannels.length
          ? '**Top channels:**\n' + topChannels.map(c => `• #${c.name} — ${c.count} msg${c.count === 1 ? '' : 's'}${c.threadCount ? ` (incl. ${c.threadCount} thread${c.threadCount === 1 ? '' : 's'})` : ''}`).join('\n')
          : null,
        truncatedTargets.length
          ? `⚠️ Hit the safety scan limit in ${truncatedTargets.length} channel(s)/thread(s) (more than ${SAFETY_MAX_PAGES * 100} messages in range) — counts there may be undercounted.`
          : null,
      ].filter(Boolean);

      const body = [
        textDisplay(`## 🔎 Member Review — ${userTag}`),
        textDisplay(`Role context: **${roleName}** · Since **${sinceStr}** (${fmtDate(sinceTs)} → now)`),
        separator(),
        textDisplay(dataLines.join('\n')),
        separator(),
      ];

      if (review) {
        const wSum = QUALITY_WEIGHT + BEHAVIOR_WEIGHT;
        body.push(textDisplay([
          '### 🤖 AI Review',
          `**Quality:** ${review.qualityScore}/10  ${scoreBar(review.qualityScore)}`,
          `**Behavior:** ${review.behaviorScore}/10  ${scoreBar(review.behaviorScore)}`,
          `**Overall:** ${overall}/10  ${scoreBar(overall)}`,
          `**Confidence:** ${review.confidence}`,
          review.flags.length ? `🚩 **Flags:** ${flagText(review.flags)}` : '✅ No flags raised',
          '',
          review.summary,
          '',
          `-# Overall = ${Math.round((QUALITY_WEIGHT / wSum) * 100)}% quality + ${Math.round((BEHAVIOR_WEIGHT / wSum) * 100)}% behavior (message volume isn't scored for a single member). Behavior of ${LOW_BEHAVIOR_THRESHOLD} or lower caps overall at ${LOW_BEHAVIOR_OVERALL_CAP}. Messages over ${MAX_MSG_CHARS} characters were shortened before review.`,
        ].join('\n')));

        // The exact messages the AI pointed to as evidence, so you can check its claims yourself.
        const evidenceMsgs = [...new Set(review.evidence)]
          .sort((a, b) => a - b)
          .map(i => entry.messages[i])
          .filter(Boolean);
        if (evidenceMsgs.length) {
          body.push(separator());
          body.push(textDisplay(`### 🧾 Messages the AI cited (${evidenceMsgs.length})`));
          for (let i = 0; i < evidenceMsgs.length; i += 4) {
            body.push(textDisplay(evidenceMsgs.slice(i, i + 4).map(m =>
              `**#${m.i}** · ${m.d} · #${m.ch}\n> ${oneLine(m.text, 220)}` +
              (m.replyTo ? `\n-# ↪ replying to: ${oneLine(m.replyTo, 100)}` : '')
            ).join('\n\n')));
          }
        }
      } else {
        let status;
        if (reviewed === 0) status = '⚠️ No AI review: none of this member\'s messages in range contained text.';
        else if (aiError) status = `⚠️ AI review failed: \`${aiError.slice(0, 300)}\`\n-# Re-run the command to retry — slices already analysed are cached, so only the missing work is redone.`;
        else status = '⚠️ AI review is off — no `GEMINI_API_KEY` configured. Only the activity data above is available.';
        body.push(textDisplay(status));
      }

      if (reportFile) {
        body.push(separator());
        body.push(textDisplay('### 📎 Full Data Export\n-# Untruncated AI review + the exact message indexes it cited.'));
        body.push(fileComponent('member_review.csv'));
      } else if (reportFileError) {
        body.push(textDisplay(`⚠️ CSV export failed: \`${reportFileError.slice(0, 200)}\``));
      }

      body.push(separator());
      body.push(textDisplay(`-# Generated <t:${Math.floor(Date.now() / 1000)}:R> · requested by ${interaction.user.tag}`));

      // ── Send (packed into multiple under-budget messages) ──
      builtContainers = packComponents(body, MESSAGE_TEXT_BUDGET);
      reportFileGroupIndex = builtContainers.findIndex(group => group.some(c => c.type === FILE_COMPONENT_TYPE));

      for (let i = 0; i < builtContainers.length; i++) {
        const files = (i === reportFileGroupIndex && reportFile) ? [reportFile] : [];
        const payload = {
          components: [{ type: ComponentType.Container, components: builtContainers[i] }],
          files,
          allowedMentions: { parse: [] },
          flags: i === 0
            ? MessageFlags.IsComponentsV2
            : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, // followUp isn't ephemeral by default
        };
        if (i === 0) {
          await interaction.editReply({ ...payload, content: null }); // clears the "Scanning…" status text
        } else {
          await interaction.followUp(payload);
        }
        deliveredCount = i + 1;
      }
    } catch (err) {
      console.error('report command error:', err);

      // 50027 = "Invalid Webhook Token": the interaction token expired before every part was sent.
      // Deliver what's left by DM (reviews are sensitive), and only to a channel if DMs are closed.
      if (err?.code === 50027 && builtContainers) {
        try {
          for (let i = deliveredCount; i < builtContainers.length; i++) {
            const files = (i === reportFileGroupIndex && reportFile) ? [reportFile] : [];
            const fallbackPayload = {
              components: [{ type: ComponentType.Container, components: builtContainers[i] }],
              files,
              allowedMentions: { parse: [] },
              flags: MessageFlags.IsComponentsV2,
            };
            try {
              await interaction.user.send(fallbackPayload);
            } catch {
              await interaction.channel.send(fallbackPayload);
            }
          }
          return;
        } catch (fallbackErr) {
          console.error('report fallback send also failed:', fallbackErr);
        }
      }

      try {
        await interaction.editReply(`⚠️ Error building report: ${err?.message || String(err)}`);
      } catch {
        try {
          await interaction.channel.send(`⚠️ Error building report: ${err?.message || String(err)}`);
        } catch {}
      }
    }
  },
};
