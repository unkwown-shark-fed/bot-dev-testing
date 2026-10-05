// Shared MEE6 helpers used by commands/mee6leaderboard.js and commands/mee6rank.js
// Requires Node 18+ (global fetch).

// ---- Logger (uses your logger.js if it exports a usable logger, else console) ----
let log = console;
try {
  const mod = require('../logger');
  const candidate = mod.logger || mod;
  if (candidate && typeof candidate.error === 'function' && typeof candidate.warn === 'function') {
    log = candidate;
  }
} catch {
  /* fall back to console */
}

// ---- Owner-only access ---------------------------------------------------
// Uses BOT_OWNER_ID from .env (comma-separated IDs also work). Read at call time
// so it works however/whenever dotenv is loaded. If it isn't set, nobody is allowed.
function getOwnerIds() {
  return (process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Call at the top of execute(). Returns true if the user is the bot owner.
 * Otherwise replies privately (only they see it) and returns false.
 *   if (!(await ensureOwner(interaction))) return;
 */
async function ensureOwner(interaction) {
  const owners = getOwnerIds();

  if (owners.includes(interaction.user.id)) return true;

  log.warn(`[mee6] blocked non-owner ${interaction.user.id} from /${interaction.commandName}`);
  await interaction
    .reply({
      content: owners.length
        ? '🔒 This command can only be used by the bot owner.'
        : '🔒 This command is owner-only, but `BOT_OWNER_ID` is not set in the bot\'s `.env`.',
      flags: 64, // MessageFlags.Ephemeral
    })
    .catch(() => {});
  return false;
}

// ---- Config -----------------------------------------------------------
// Override with MEE6_GUILD_ID in .env if you ever want a different server.
const GUILD_ID = process.env.MEE6_GUILD_ID || '410479299347480576';
const API_LIMIT = 100;       // players per API request
const MAX_API_PAGES = 10;    // how deep we ever look (10 x 100 = top 1000)
const CACHE_TTL = 60 * 1000; // data younger than this is served without a request
const CACHE_MAX = 50;        // max cached API pages
const RETRY_ATTEMPTS = 3;

// ---- Cache + request dedupe --------------------------------------------
const cache = new Map();    // apiPage -> { at, data }
const inflight = new Map(); // apiPage -> Promise

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetry(url) {
  let lastErr;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'DiscordBot (mee6 commands)' },
        signal: AbortSignal.timeout(10000),
      });

      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`MEE6 API responded with HTTP ${res.status}`);
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`MEE6 API responded with HTTP ${res.status}`);
        err.fatal = true; // 4xx other than 429: retrying won't help
        throw err;
      }

      const data = await res.json();
      if (!data || !Array.isArray(data.players)) {
        const err = new Error('MEE6 API returned an unexpected response shape');
        err.fatal = true;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === RETRY_ATTEMPTS - 1) break;

      const delay = err.retryAfter ? Math.min(err.retryAfter * 1000, 5000) : 500 * 2 ** attempt;
      log.warn(`[mee6] request failed (${err.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function pruneCache() {
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value); // oldest inserted
  }
}

/**
 * Fetch one API page (100 players). Returns the data object.
 * If MEE6 is unreachable but we have an older cached copy, returns that copy
 * with `__stale: true` instead of throwing.
 */
async function fetchApiPage(apiPage) {
  const cached = cache.get(apiPage);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  if (inflight.has(apiPage)) return inflight.get(apiPage);

  const url = `https://mee6.xyz/api/plugins/levels/leaderboard/${GUILD_ID}?limit=${API_LIMIT}&page=${apiPage}`;

  const promise = (async () => {
    try {
      const data = await fetchJsonWithRetry(url);
      cache.delete(apiPage);
      cache.set(apiPage, { at: Date.now(), data });
      pruneCache();
      return data;
    } catch (err) {
      log.error(`[mee6] fetch failed for page ${apiPage}: ${err.message}`);
      if (cached) return { ...cached.data, __stale: true, __cachedAt: cached.at };
      throw err;
    } finally {
      inflight.delete(apiPage);
    }
  })();

  inflight.set(apiPage, promise);
  return promise;
}

// ---- Lookups -----------------------------------------------------------

// Leaderboard is sorted by XP (highest first) and level rises with XP, so everyone
// at/above a level sits at the top. Fetch until the first player below the cutoff.
async function getQualifying(minLevel) {
  const players = [];
  let guild = {};
  let stale = false;

  for (let apiPage = 0; apiPage < MAX_API_PAGES; apiPage++) {
    const data = await fetchApiPage(apiPage);
    guild = data.guild || guild;
    stale = stale || !!data.__stale;

    let reachedBelow = false;
    for (const p of data.players) {
      if (p.level >= minLevel) players.push(p);
      else {
        reachedBelow = true;
        break;
      }
    }
    if (reachedBelow || data.players.length < API_LIMIT) break;
  }

  return { players, guild, stale };
}

// Find one player by Discord user ID. Returns null if not in the top MAX_API_PAGES * 100.
async function findPlayer(userId) {
  let stale = false;

  for (let apiPage = 0; apiPage < MAX_API_PAGES; apiPage++) {
    const data = await fetchApiPage(apiPage);
    stale = stale || !!data.__stale;

    const idx = data.players.findIndex((p) => p.id === String(userId));
    if (idx !== -1) {
      return {
        player: data.players[idx],
        rank: apiPage * API_LIMIT + idx + 1,
        guild: data.guild || {},
        roleRewards: data.role_rewards || [],
        stale,
      };
    }
    if (data.players.length < API_LIMIT) break;
  }
  return null;
}

// ---- Formatting helpers ------------------------------------------------
const esc = (s) => String(s).replace(/([\\*_`~|>#-])/g, '\\$1');
const fmt = (n) => Number(n).toLocaleString('en-US');

function avatarUrl(p) {
  if (p.avatar) return `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png?size=128`;
  const idx = Number((BigInt(p.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

// detailed_xp from MEE6 = [xp earned into current level, xp needed for this level, total xp]
function levelProgress(p) {
  const [into = 0, needed = 0] = p.detailed_xp || [];
  const pct = needed > 0 ? Math.min(1, into / needed) : 0;
  return { into, needed, pct };
}

function progressBar(pct, size = 10, filledChar = '🟨', emptyChar = '⬛') {
  const filled = Math.round(pct * size);
  return filledChar.repeat(filled) + emptyChar.repeat(size - filled);
}

// Which reward role the player has now, and which one is next
function rewardInfo(level, roleRewards) {
  const sorted = [...roleRewards].sort((a, b) => a.rank - b.rank);
  const current = [...sorted].reverse().find((r) => r.rank <= level) || null;
  const next = sorted.find((r) => r.rank > level) || null;
  return { current, next };
}

module.exports = {
  log,
  ensureOwner,
  GUILD_ID,
  API_LIMIT,
  MAX_API_PAGES,
  fetchApiPage,
  getQualifying,
  findPlayer,
  esc,
  fmt,
  avatarUrl,
  levelProgress,
  progressBar,
  rewardInfo,
};