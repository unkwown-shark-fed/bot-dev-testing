const crypto = require('crypto');
const { AttachmentBuilder, PermissionFlagsBits, MessageFlags, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');
const { ComponentType, textDisplay, separator, mediaGallery } = require('../utils/componentsV2');
const { sanitizeText } = require('../utils/csv');
const { isAuthorized } = require('../utils/auth');

// ── Config ───────────────────────────────────────────────────────────────────
// Tried in order. If a model is overloaded or out of quota, we fall through to the next.
// NOTE: gemini-2.5-flash / 2.5-flash-lite return 404 "no longer available to new users",
// so they're replaced with the models Google's own error message points to.
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const MAX_SAMPLE_MSGS_PER_USER = 40;   // how many messages per staff member we send to the AI for review
const MAX_MSG_CHARS = 250;             // truncate each sampled message before sending
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
const AI_BATCH_SIZE = 8;               // bigger batches = fewer requests per run. The free tier is limited mainly by requests/day, so 10 staff = 2 requests instead of 4
const AI_BATCH_DELAY_MS = 1500;        // spacing between batches to stay under the free-tier requests/minute cap
const AI_BATCH_MAX_RETRIES = 5;        // extra attempts per model before moving on to the next fallback model
const AI_BATCH_RETRY_DELAY_MS = 3000;  // base backoff (doubles each attempt, with jitter)
const AI_OVERLOAD_MAX_DELAY_MS = 30000; // cap on a single backoff wait
// Patient mode: after the main pass, keep re-trying ONLY the still-unscored users until
// everyone has a score or the deadline below is reached. Cooldown grows each round.
const AI_MAX_TOTAL_MS = 60 * 60 * 1000;  // give up entirely after 60 min of trying (raise if you want even more patience)
const AI_SWEEP_COOLDOWN_START_MS = 45000; // first wait between rounds
const AI_SWEEP_COOLDOWN_MAX_MS = 180000;  // cooldown grows by 1.5x per round, capped at 3 min

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

async function scoreBatchWithAI(batch, apiKey, model) {
  const payloadUsers = batch.map(u => ({ userId: u.userId, tag: u.tag, messages: u.samples }));

        const prompt =
    `You are writing an internal review of volunteer staff for a Discord server, based on each ` +
    `volunteer's actual messages during the report period. These are unpaid volunteers giving their ` +
    `free time, not employees, and they have no direct contact with the server owner, who cannot ` +
    `watch them day to day. The owner reads this review to get an accurate picture of how each ` +
    `volunteer actually represents the server to members, so describe what you saw them do. ` +
    `Be direct and honest, but fair and respectful of the fact that they are volunteers. State ` +
    `strengths and weaknesses plainly and specifically ("gave thorough, correct answers" not "did a ` +
    `great job overall"; "many replies were very short and left follow-up questions unanswered" not ` +
    `"there is room for improvement"). Criticize the work and the pattern of behavior, never the ` +
    `person, and avoid harsh or sarcastic wording. Don't inflate mediocre performance to be nice, ` +
    `and don't exaggerate flaws to sound tough. Don't assume they were given assigned tasks or ` +
    `deadlines, and don't judge them for how much they posted, because message volume is scored ` +
    `separately. Judge only the quality and conduct of what they actually wrote. ` +
    `The one exception to the respectful tone is the final "Verdict:" sentence, which must be ` +
    `BLUNT, with no diplomacy and no cushioning. For each volunteer below:\n\n` +
    `1. "qualityScore" (1-10): response quality/effort. 10 = consistently helpful, thorough, ` +
    `proactive, professional. 1 = low-effort, unhelpful, or absent.\n` +
    `2. "behaviorScore" (1-10): conduct and tone of response toward server members and other staff, ` +
    `independent of quality. Judge both how they treat people (courtesy, patience, respect) and the ` +
    `tone of their replies (friendly, calm, professional vs curt, sarcastic, condescending, ` +
    `dismissive, or hostile). Since they represent the server to the public without supervision, ` +
    `weigh their conduct carefully. 10 = consistently courteous, calm, and well-toned even under ` +
    `pressure. 1 = rude, hostile, dismissive, or abusive. A short but polite answer should NOT be ` +
    `marked down on behavior just for brevity.\n` +
    `3. "review": a complete review of exactly 3 sentences, roughly 300-450 characters total, ` +
    `written so someone with no direct contact with this volunteer understands how they come across. ` +
    `Sentence 1: their overall performance, stated plainly. ` +
    `Sentence 2: the specific pattern you actually saw in their messages (concrete evidence, e.g. ` +
    `canned replies, thorough step-by-step help, a curt tone with members). ` +
    `Sentence 3 MUST start with "Verdict:" and be blunt and unsoftened: one line that says plainly ` +
    `whether quality was good, mixed, or poor AND whether behavior/tone was good, mixed, or poor, ` +
    `with the main reason. Example style: "Verdict: Quality was weak and behavior was fine." ` +
    `Base this ONLY on the message content given. Never invent specifics you weren't shown.\n\n` +
    `Staff data:\n${JSON.stringify(payloadUsers)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
    const fullBody = await response.text();
    const err = new Error(`Gemini API returned ${response.status} (${model}): ${fullBody.slice(0, 300).replace(/\s+/g, ' ')}`);
    err.status = response.status;
    // A 429 is either a per-minute rate limit (worth waiting out) or a PER-DAY quota
    // (waiting minutes/hours is pointless until it resets) — tell them apart.
    err.dailyQuota = response.status === 429 && /PerDay/i.test(fullBody);
    const retryMatch = fullBody.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
    if (retryMatch) err.retryAfterMs = Math.ceil(Number(retryMatch[1]) * 1000) + 1000; // Google tells us how long to wait
    // 429 = rate limited, 500/503 = server error / overloaded — none of these are the
    // user's data's fault, so splitting the batch would just multiply requests.
    err.overloaded = response.status === 429 || response.status === 503 || response.status === 500;
    throw err;
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
      summary: sanitizeText(entry.review || entry.summary || '', 900),
      fullSummary: sanitizeText(entry.review || entry.summary || '', 4000), // untruncated version, only used in the CSV export
    });
  }

  // Gemini can drop a user from the response array even when the JSON as a
  // whole parses fine. Treat that as a batch failure so scoreBatchWithRetry's
  // retry/split logic actually catches and logs it.
  const missing = batch.filter(u => !map.has(u.userId));
  if (missing.length) {
    const who = missing.map(u => u.tag || u.userId).join(', ');
    throw new Error(`Gemini response omitted ${missing.length} user(s): ${who}`);
  }

  return map;
}

// Scores one batch. Strategy:
//   1. For each model in GEMINI_MODELS (in order), retry with exponential backoff + jitter.
//   2. Non-retryable 4xx errors (bad key / bad request / unknown model) skip straight to the next model.
//   3. Only if EVERY model failed AND the failure looks content-related (bad JSON, omitted user,
//      safety block — i.e. no HTTP status) do we split the batch in half to isolate the culprit.
//      Splitting on 429/500/503 is deliberately avoided: the model is just overloaded, and
//      splitting would only fire more requests into it.
// Returns { map, errors }.
async function scoreBatchWithRetry(batch, apiKey, label, state) {
  let lastErr;
  const who = batch.map(u => u.tag || u.userId).join(', ');

  // Every model already known to be unusable this run (404, bad key, or daily quota
  // exhausted) — don't waste time; fail fast with the real reason.
  if (GEMINI_MODELS.every(m => state.deadModels.has(m))) {
    return { map: new Map(), errors: [`${who} (batch ${label}): ${state.lastDeadMsg}`] };
  }

  for (const model of GEMINI_MODELS) {
    if (state.deadModels.has(model)) continue;

    for (let attempt = 0; attempt <= AI_BATCH_MAX_RETRIES; attempt++) {
      try {
        const batchMap = await scoreBatchWithAI(batch, apiKey, model);
        return { map: batchMap, errors: [] };
      } catch (err) {
        lastErr = err;
        console.warn(`[report] AI batch ${label} [${model}] attempt ${attempt + 1}/${AI_BATCH_MAX_RETRIES + 1} failed: ${err.message}`);

        // Model can't be used at all right now: unknown/retired (404), bad key (401/403),
        // or its DAILY quota is gone. Retrying is pointless — mark it dead for this run.
        if ([401, 403, 404].includes(err.status) || err.dailyQuota) {
          state.deadModels.add(model);
          state.lastDeadMsg = err.dailyQuota
            ? `Daily Gemini quota exhausted for ${model} (resets daily — add billing or use another API key/provider). ${err.message.slice(0, 120)}`
            : err.message;
          break;
        }

        // Other non-retryable client errors (e.g. 400 bad request).
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;

        // Content-related failures (no HTTP status: malformed JSON, omitted user) rarely fix
        // themselves with many identical retries — allow one more try, then move on.
        if (!err.status && attempt >= 1) break;

        if (attempt < AI_BATCH_MAX_RETRIES) {
          // If Google said how long to wait (per-minute 429), honor it; otherwise exponential backoff + jitter.
          const backoff = Math.min(AI_BATCH_RETRY_DELAY_MS * Math.pow(2, attempt), AI_OVERLOAD_MAX_DELAY_MS);
          const delay = (err.retryAfterMs ? Math.min(err.retryAfterMs, 90000) : backoff) + Math.random() * 1000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    console.warn(`[report] AI batch ${label}: model ${model} exhausted, trying next fallback…`);
  }

  // Every model failed. Only split if the failure looks content-related.
  const contentRelated = lastErr && !lastErr.overloaded && !lastErr.status;
  if (contentRelated && batch.length > 1) {
    const mid = Math.ceil(batch.length / 2);
    const [left, right] = [batch.slice(0, mid), batch.slice(mid)];
    const map = new Map();
    const errors = [];

    const leftResult = await scoreBatchWithRetry(left, apiKey, `${label}a`, state);
    for (const [k, v] of leftResult.map) map.set(k, v);
    errors.push(...leftResult.errors);

    await new Promise(r => setTimeout(r, AI_BATCH_RETRY_DELAY_MS));

    const rightResult = await scoreBatchWithRetry(right, apiKey, `${label}b`, state);
    for (const [k, v] of rightResult.map) map.set(k, v);
    errors.push(...rightResult.errors);

    return { map, errors };
  }

  return { map: new Map(), errors: [`${who} (batch ${label}): ${lastErr?.message || state.lastDeadMsg || 'unknown error'}`] };
}

// Successful scores are remembered in memory (per user, keyed by a hash of the exact
// messages that were reviewed). If a run only partly succeeds — or you re-run /report —
// already-scored users cost ZERO API requests; only the missing ones are sent again.
// Cleared when the bot restarts/redeploys.
const aiScoreCache = new Map(); // userId -> { hash, value, ts }
const AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function samplesHash(samples) {
  return crypto.createHash('sha1').update(JSON.stringify(samples)).digest('hex');
}

async function scoreQualityWithAI(userSamples, onStatus) {
  const apiKey = process.env.GEMINI_API_KEY;
  const scorable = userSamples.filter(u => u.samples && u.samples.length > 0);
  if (!apiKey || !scorable.length) return { map: null, errors: [] };

  const map = new Map();
  let errors = [];

  // Reuse cached scores where the user's messages haven't changed.
  const hashes = new Map(scorable.map(u => [u.userId, samplesHash(u.samples)]));
  let cachedHits = 0;
  for (const u of scorable) {
    const c = aiScoreCache.get(u.userId);
    if (c && c.hash === hashes.get(u.userId) && Date.now() - c.ts < AI_CACHE_TTL_MS) {
      map.set(u.userId, c.value);
      cachedHits++;
    }
  }
  if (cachedHits) console.warn(`[report] Reusing ${cachedHits} cached AI score(s); only ${scorable.length - cachedHits} need API calls.`);

  const state = { deadModels: new Set(), lastDeadMsg: '' }; // models unusable for the rest of this run

  const runPass = async (users) => {
    const batches = [];
    for (let i = 0; i < users.length; i += AI_BATCH_SIZE) batches.push(users.slice(i, i + AI_BATCH_SIZE));
    const passErrors = [];
    for (let i = 0; i < batches.length; i++) {
      const { map: batchMap, errors: batchErrors } = await scoreBatchWithRetry(batches[i], apiKey, `${i + 1}/${batches.length}`, state);
      for (const [k, v] of batchMap) {
        map.set(k, v);
        aiScoreCache.set(k, { hash: hashes.get(k), value: v, ts: Date.now() });
      }
      passErrors.push(...batchErrors);
      if (i < batches.length - 1) await new Promise(r => setTimeout(r, AI_BATCH_DELAY_MS));
    }
    return passErrors;
  };

  errors = await runPass(scorable.filter(u => !map.has(u.userId)));

  // Patient mode: keep going until every user is scored (or the deadline hits).
  const deadline = Date.now() + AI_MAX_TOTAL_MS;
  let cooldown = AI_SWEEP_COOLDOWN_START_MS;
  let round = 0;
  while (true) {
    const missing = scorable.filter(u => !map.has(u.userId));
    if (!missing.length) break;
    // Waiting can't fix a retired model, a bad key, or an exhausted DAILY quota — stop and say why.
    if (GEMINI_MODELS.every(m => state.deadModels.has(m))) {
      console.warn(`[report] All Gemini models unusable this run (${state.lastDeadMsg}) — not waiting.`);
      break;
    }
    if (Date.now() + cooldown >= deadline) {
      console.warn(`[report] Deadline reached with ${missing.length} user(s) still unscored — giving up on them.`);
      break;
    }
    round++;
    console.warn(`[report] ${missing.length} user(s) unscored — waiting ${Math.round(cooldown / 1000)}s then retrying (round ${round})…`);
    onStatus?.(`🤖 Gemini is busy — ${scorable.length - missing.length}/${scorable.length} staff scored so far. Waiting ${Math.round(cooldown / 1000)}s then retrying the remaining ${missing.length} (round ${round})…`);
    await new Promise(r => setTimeout(r, cooldown));
    cooldown = Math.min(Math.round(cooldown * 1.5), AI_SWEEP_COOLDOWN_MAX_MS);
    errors = await runPass(missing);
  }

  // If everyone ended up scored, earlier transient errors are irrelevant — don't show them.
  if (scorable.every(u => map.has(u.userId))) errors = [];

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
      .addStringOption(o => o.setName('channels').setDescription('Channels/threads to scan: mentions or IDs, space/comma-separated').setRequired(false))
      .addChannelOption(o => o.setName('channel').setDescription('Single channel/thread to scan (ignored if "channels" is set; default: all)')
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

      // Let the person know AI scoring is running — with retries/fallbacks it can take a while.
      interaction.editReply(
        `🤖 Scan complete (${totalScanned} staff messages). Running AI scoring — if Gemini is busy this may take a few minutes (auto-retrying with fallback models)…`
      ).catch(() => {});

      let qualityMap = null;
      let aiError = null;
      try {
        const aiResult = await scoreQualityWithAI(
          Array.from(stats.entries()).map(([userId, s]) => ({ userId, tag: s.tag, samples: s.samples })),
          (msg) => { interaction.editReply(msg).catch(() => {}); } // best-effort progress; silently stops if the token expired
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

        // Every row gets a non-empty, *accurate* summary. A staff member can end up
        // without an AI score in three distinct ways:
        //   1. No messages at all in range.
        //   2. Messages, but none carried text content (attachments/embeds/stickers
        //      only) — they were filtered out before any API call was made.
        //   3. Their scoring batch genuinely failed (overloaded model, malformed
        //      reply, etc.) — logged and reflected in aiError above.
        let summary;
        let fullSummary;
        if (quality) {
          summary = quality.summary;
          fullSummary = quality.fullSummary;
        } else if (s.count === 0) {
          summary = 'No messages found in the scanned period — nothing to evaluate.';
          fullSummary = summary;
        } else if (s.samples.length === 0) {
          summary = '_No reviewable text — this user\'s messages in range were attachments/embeds/stickers with no text content._';
          fullSummary = 'No reviewable text — this user\'s messages in range were attachments/embeds/stickers with no text content.';
        } else {
          summary = '_AI review unavailable — Gemini was overloaded or returned an unusable reply for this user even after retries and fallback models (see status line above). Re-run the report to try again._';
          fullSummary = 'AI review unavailable — Gemini was overloaded or returned an unusable reply for this user even after retries and fallback models.';
        }

        return {
          userId,
          tag: s.tag,
          count: s.count,
          activityScore,
          qualityScore,
          behaviorScore,
          summary,
          fullSummary,
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
        // Every row always has a non-empty, accurate summary (see rows.map above),
        // so we don't filter here — everyone shown in Rankings also gets a review entry.
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
            const fallbackPayload = {
              components: [{ type: ComponentType.Container, components: builtContainers[i] }],
              files,
              flags: MessageFlags.IsComponentsV2,
            };
            // Staff reviews are sensitive — DM the requester first. Only fall back to a
            // public channel message if their DMs are closed.
            try {
              await interaction.user.send(fallbackPayload);
            } catch {
              await interaction.channel.send(fallbackPayload);
            }
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
