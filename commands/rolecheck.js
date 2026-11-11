const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const {
  log,
  ensureOwner,
  API_LIMIT,
  MAX_API_PAGES,
  fetchApiPage,
  esc,
  fmt,
} = require('../utils/mee6');

// Requires discord.js >= 14.19 (Components V2) and Node 18+.
// Uses only helpers already exported by utils/mee6.js (no changes needed there).

// ---- Config -----------------------------------------------------------
const PER_PAGE = 15;
const COLLECTOR_TIME = 5 * 60 * 1000;
const FALLBACK_COLOR = 0xf1c40f;
const MEDALS = ['🥇', '🥈', '🥉'];
const CHUNK_LIMIT = 1900;
const MAX_CHUNK_MESSAGES = 5;
const TOP_DEPTH = MAX_API_PAGES * API_LIMIT;

// ---- Data ---------------------------------------------------------------
// Fetch the whole reachable leaderboard (cached + deduped by utils/mee6) and
// keep only players who are in the role. Pages are requested in parallel.
async function buildRows(guild, role, includeUnranked) {
  // Only hit the members API if the cache is incomplete (Server Members Intent required)
  if (guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch();
  }

  const fresh = guild.roles.cache.get(role.id);
  const members = new Map();
  for (const m of fresh?.members.values() ?? []) {
    if (!m.user.bot) members.set(m.id, m);
  }
  if (!members.size) return { rows: [], stale: false, total: 0 };

  const pages = await Promise.all(
    Array.from({ length: MAX_API_PAGES }, (_, p) => fetchApiPage(p)),
  );

  const rows = [];
  const seen = new Set();
  let stale = false;

  pages.forEach((data, apiPage) => {
    stale = stale || !!data.__stale;
    data.players.forEach((p, idx) => {
      if (!members.has(p.id)) return;
      seen.add(p.id);
      rows.push({
        id: p.id,
        name: p.username,
        level: p.level,
        xp: p.xp,
        msgs: p.message_count,
        globalRank: apiPage * API_LIMIT + idx + 1,
      });
    });
  });

  // Leaderboard order is already by XP; make the order explicit anyway
  rows.sort((a, b) => a.globalRank - b.globalRank);
  rows.forEach((r, i) => (r.roleRank = i + 1));

  if (includeUnranked) {
    const missing = [...members.values()]
      .filter((m) => !seen.has(m.id))
      .sort((a, b) => a.user.username.localeCompare(b.user.username));
    for (const m of missing) {
      rows.push({ id: m.id, name: m.user.username, level: null, globalRank: null, roleRank: null });
    }
  }

  return { rows, stale, total: members.size, ranked: seen.size };
}

// ---- Rendering ----------------------------------------------------------
const rule = () =>
  new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

function render(state, { disabled = false } = {}) {
  const { rows, page, totalPages, role, ranked, total, stale, includeUnranked } = state;
  const container = new ContainerBuilder().setAccentColor(role.color || FALLBACK_COLOR);

  let header = `# 🎖️ ${esc(role.name)} — MEE6 Ranks\n-# ${fmt(ranked)} of ${fmt(total)} member${total === 1 ? '' : 's'} ranked in the top ${fmt(TOP_DEPTH)}`;
  if (stale) header += '\n-# ⚠️ MEE6 is unreachable — showing cached data that may be outdated';
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
  container.addSeparatorComponents(rule());

  const start = page * PER_PAGE;
  const slice = rows.slice(start, start + PER_PAGE);

  const lines = slice.map((r) => {
    if (r.globalRank === null) {
      return `**—** **${esc(r.name)}** — not in the top ${fmt(TOP_DEPTH)}\n-# ID: \`${r.id}\``;
    }
    const prefix = r.roleRank <= 3 ? MEDALS[r.roleRank - 1] : `**${r.roleRank}.**`;
    return (
      `${prefix} **${esc(r.name)}** — Server rank **#${fmt(r.globalRank)}** • Level **${r.level}** • ${fmt(r.xp)} XP\n` +
      `-# ${fmt(r.msgs)} msgs • ID: \`${r.id}\``
    );
  });
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

  container.addSeparatorComponents(rule());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Page ${page + 1}/${totalPages} • Numbers on the left are ranks within this role${
        includeUnranked ? '' : ' • unranked members hidden'
      } • Data from MEE6`,
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rr_prev')
        .setLabel('Previous')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
      new ButtonBuilder()
        .setCustomId('rr_next')
        .setLabel('Next')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= totalPages - 1),
    ),
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rr_copy_page')
        .setLabel('Copy IDs (this page)')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('rr_copy_all')
        .setLabel(`Copy all IDs (${fmt(rows.length)})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    ),
  );

  return container;
}

function chunkLines(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > CHUNK_LIMIT) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendIds(i, ids, fileName) {
  const chunks = chunkLines(ids);
  const shown = chunks.slice(0, MAX_CHUNK_MESSAGES);

  await i.reply({
    content:
      `**${fmt(ids.length)} ID(s)**, one per line` +
      (chunks.length > shown.length ? ` (first ${shown.length} message(s) shown; the file has all)` : '') +
      `\n\`\`\`\n${shown[0]}\n\`\`\``,
    files: [new AttachmentBuilder(Buffer.from(ids.join('\n'), 'utf8'), { name: fileName })],
    flags: MessageFlags.Ephemeral,
  });

  for (const chunk of shown.slice(1)) {
    await i.followUp({ content: `\`\`\`\n${chunk}\n\`\`\``, flags: MessageFlags.Ephemeral });
  }
}

// ---- Command ------------------------------------------------------------
module.exports = {
  cooldown: 15,

  data: new SlashCommandBuilder()
    .setName('mee6roleranks')
    .setDescription('Show the MEE6 rank and level of every member in a role')
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('Role to look up').setRequired(true),
    )
    .addBooleanOption((opt) =>
      opt
        .setName('include_unranked')
        .setDescription('Also list members not found in the MEE6 top 1000 (default: false)'),
    )
    .setDMPermission(false),

  async execute(interaction) {
    if (!(await ensureOwner(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const role = interaction.options.getRole('role');
    const includeUnranked = interaction.options.getBoolean('include_unranked') ?? false;

    let built;
    try {
      built = await buildRows(interaction.guild, role, includeUnranked);
    } catch (err) {
      log.error(`[mee6roleranks] ${err.message}`);
      return interaction.editReply(
        '❌ Could not load data. Check that the Server Members Intent is enabled and that MEE6 is reachable, then try again.',
      );
    }

    if (!built.total) {
      return interaction.editReply(`No (non-bot) members have ${role}.`);
    }
    if (!built.rows.length) {
      return interaction.editReply(
        `❌ None of the ${fmt(built.total)} member(s) with **${esc(role.name)}** are in the top ${fmt(TOP_DEPTH)} of the MEE6 leaderboard. Use \`include_unranked:true\` to list them anyway.`,
      );
    }

    const state = {
      ...built,
      role,
      includeUnranked,
      page: 0,
      totalPages: Math.ceil(built.rows.length / PER_PAGE),
    };
    const send = (extra) => ({
      flags: MessageFlags.IsComponentsV2,
      components: [render(state, extra)],
      allowedMentions: { parse: [] }, // never ping when listing
    });

    const message = await interaction.editReply(send());

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === interaction.user.id,
      time: COLLECTOR_TIME,
    });

    collector.on('collect', async (i) => {
      try {
        if (i.customId === 'rr_copy_page') {
          const ids = state.rows.slice(state.page * PER_PAGE, (state.page + 1) * PER_PAGE).map((r) => r.id);
          return await sendIds(i, ids, `role_page_${state.page + 1}_ids.txt`);
        }
        if (i.customId === 'rr_copy_all') {
          const safe = role.name.replace(/[^\w-]+/g, '_');
          return await sendIds(i, state.rows.map((r) => r.id), `${safe}_ids.txt`);
        }

        state.page += i.customId === 'rr_next' ? 1 : -1;
        await i.update(send());
      } catch (err) {
        log.error(`[mee6roleranks] button failed: ${err.message}`);
        const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
        (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => {});
      }
    });

    collector.on('end', () => {
      interaction.editReply(send({ disabled: true })).catch(() => {});
    });
  },
};
