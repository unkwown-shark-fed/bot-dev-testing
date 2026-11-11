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
  getQualifying,
  esc,
  fmt,
} = require('../utils/mee6');

// Requires discord.js >= 14.19 (Components V2) and Node 18+.

// ---- Config -----------------------------------------------------------
const PER_PAGE = 20; // must divide API_LIMIT (100) evenly
const MAX_DISPLAY_PAGES = Math.floor((MAX_API_PAGES * API_LIMIT) / PER_PAGE);
const COLLECTOR_TIME = 5 * 60 * 1000;
const ACCENT_COLOR = 0xf1c40f;
const MEDALS = ['🥇', '🥈', '🥉'];
const CHUNK_LIMIT = 1900; // code-block messages must stay under 2000 chars
const MAX_CHUNK_MESSAGES = 5; // the .txt file always contains every ID

// false = the leaderboard is posted publicly in the channel; true = only you see it.
// (The "Copy IDs" replies are always private to whoever clicks the button.)
const EPHEMERAL = false;

// Set to e.g. 100 to ALWAYS filter to level 100+ when min_level isn't passed.
const DEFAULT_MIN_LEVEL = null;

// Players are rendered inside ONE text display (no per-player thumbnails), so the
// component count stays tiny (~12 of Discord's 40) and 20 players fit on a page.

// ---- Data loading -------------------------------------------------------
// `qual` caches the min_level result for the lifetime of the command so paging
// never refetches the leaderboard.
async function loadPage(displayPage, minLevel, qual) {
  const startIdx = displayPage * PER_PAGE;

  if (minLevel) {
    if (!qual.data) qual.data = await getQualifying(minLevel);
    const { players: all, guild, stale } = qual.data;
    const players = all.slice(startIdx, startIdx + PER_PAGE);
    if (!players.length) return null;

    return {
      page: displayPage,
      startIdx,
      players,
      guild,
      stale,
      minLevel,
      total: all.length,
      hasNext: startIdx + PER_PAGE < all.length,
    };
  }

  const apiPage = Math.floor(startIdx / API_LIMIT);
  if (apiPage >= MAX_API_PAGES) return null;

  const data = await fetchApiPage(apiPage);
  const offset = startIdx % API_LIMIT;
  const players = data.players.slice(offset, offset + PER_PAGE);
  if (!players.length) return null;

  const hasNext =
    offset + PER_PAGE < data.players.length ||
    (data.players.length === API_LIMIT && apiPage + 1 < MAX_API_PAGES);

  // Warm the cache for the next click so paging feels instant
  if (hasNext && offset + PER_PAGE >= API_LIMIT && apiPage + 1 < MAX_API_PAGES) {
    fetchApiPage(apiPage + 1).catch(() => {});
  }

  return {
    page: displayPage,
    startIdx,
    players,
    guild: data.guild || {},
    stale: !!data.__stale,
    minLevel: null,
    total: null,
    hasNext,
  };
}

// ---- Rendering ----------------------------------------------------------
const rule = () =>
  new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

function render(view, { disabled = false, viewerId = null, canCopyAll = false } = {}) {
  const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

  let header = `# 🏆 ${esc(view.guild.name || 'Server')} — XP Leaderboard`;
  if (view.minLevel) {
    header += `\n-# Level ${view.minLevel}+ only • ${fmt(view.total)} player${view.total === 1 ? '' : 's'}`;
  }
  if (view.stale) {
    header += '\n-# ⚠️ MEE6 is unreachable — showing cached data that may be outdated';
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
  container.addSeparatorComponents(rule());

  const lines = view.players.map((p, i) => {
    const rank = view.startIdx + i + 1;
    const prefix = rank <= 3 ? MEDALS[rank - 1] : `**${rank}.**`;
    const you = viewerId && p.id === viewerId ? ' ← you' : '';
    return (
      `${prefix} **${esc(p.username)}**${you} — Level **${p.level}** • ${fmt(p.xp)} XP • ${fmt(p.message_count)} msgs\n` +
      `-# ID: \`${p.id}\``
    );
  });
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

  container.addSeparatorComponents(rule());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# Page ${view.page + 1} • Ranks ${view.startIdx + 1}-${view.startIdx + view.players.length} • Data from MEE6`,
    ),
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lb_prev')
        .setLabel('Previous')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || view.page === 0),
      new ButtonBuilder()
        .setCustomId('lb_next')
        .setLabel('Next')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || !view.hasNext),
    ),
  );

  const copyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lb_copy_page')
      .setLabel('Copy IDs (this page)')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
  if (canCopyAll) {
    copyRow.addComponents(
      new ButtonBuilder()
        .setCustomId('lb_copy_all')
        .setLabel(`Copy all IDs (${fmt(view.total)})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
    );
  }
  container.addActionRowComponents(copyRow);

  return container;
}

// Split IDs into code-block-sized chunks
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
  cooldown: 10,

  data: new SlashCommandBuilder()
    .setName('mee6leaderboard')
    .setDescription('Show the MEE6 XP leaderboard with Discord user IDs')
    .addIntegerOption((opt) =>
      opt
        .setName('min_level')
        .setDescription('Only show players at this level or above (e.g. 100)')
        .setMinValue(1)
        .setMaxValue(1000),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription(`Page number to start on (${PER_PAGE} players per page)`)
        .setMinValue(1)
        .setMaxValue(MAX_DISPLAY_PAGES),
    ),

  async execute(interaction) {
    if (!(await ensureOwner(interaction))) return;

    await interaction.deferReply({ flags: EPHEMERAL ? MessageFlags.Ephemeral : undefined });

    const minLevel = interaction.options.getInteger('min_level') ?? DEFAULT_MIN_LEVEL;
    const viewerId = interaction.user.id;
    const qual = { data: null };
    const opts = (extra = {}) => ({ viewerId, canCopyAll: !!minLevel, ...extra });

    let view;
    try {
      view = await loadPage((interaction.options.getInteger('page') || 1) - 1, minLevel, qual);
    } catch (err) {
      log.error(`[mee6leaderboard] ${err.message}`);
      return interaction.editReply('❌ Could not reach the MEE6 API right now. Please try again in a moment.');
    }

    if (!view) {
      return interaction.editReply(
        minLevel ? `❌ No players found at level ${minLevel}+ on that page.` : '❌ No players found on that page.',
      );
    }

    const message = await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [render(view, opts())],
      allowedMentions: { parse: [] },
    });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: COLLECTOR_TIME,
    });

    collector.on('collect', async (i) => {
      // The message is public, so only the person who ran the command may use the buttons
      if (i.user.id !== viewerId) {
        return i
          .reply({ content: 'Only the person who ran this command can use these buttons.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }

      try {
        if (i.customId === 'lb_copy_page') {
          return await sendIds(i, view.players.map((p) => p.id), `leaderboard_page_${view.page + 1}_ids.txt`);
        }

        if (i.customId === 'lb_copy_all') {
          const all = qual.data?.players ?? [];
          return await sendIds(i, all.map((p) => p.id), `leaderboard_level_${minLevel}_plus_ids.txt`);
        }

        // Paging: acknowledge immediately so slow API calls never hit Discord's 3s limit
        await i.deferUpdate();
        const target = i.customId === 'lb_next' ? view.page + 1 : view.page - 1;
        const next = await loadPage(target, minLevel, qual);
        if (!next) return;

        view = next;
        await i.editReply({
          flags: MessageFlags.IsComponentsV2,
          components: [render(view, opts())],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        log.error(`[mee6leaderboard] button failed: ${err.message}`);
        const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
        (i.deferred || i.replied ? i.followUp(payload) : i.reply(payload)).catch(() => {});
      }
    });

    collector.on('end', () => {
      interaction
        .editReply({
          flags: MessageFlags.IsComponentsV2,
          components: [render(view, opts({ disabled: true }))],
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    });
  },
};
