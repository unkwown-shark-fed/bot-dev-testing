const {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const {
  log,
  ensureOwner,
  API_LIMIT,
  fetchApiPage,
  getQualifying,
  esc,
  fmt,
  avatarUrl,
} = require('../utils/mee6');

// Requires discord.js >= 14.19 (Components V2) and Node 18+.

// ---- Config -----------------------------------------------------------
const PER_PAGE = 10;
const COLLECTOR_TIME = 2 * 60 * 1000;
const ACCENT_COLOR = 0xf1c40f;
const MEDALS = ['🥇', '🥈', '🥉'];

// Set to e.g. 100 to ALWAYS filter to level 100+ when min_level isn't passed.
const DEFAULT_MIN_LEVEL = null;

// Component budget (Discord allows 40 per message):
// container 1 + header 1 + separator 1 + 10 players x 3 + separator 1 + footer 1
// + action row 1 + 2 buttons = 38 (+1 when the "stale data" notice is shown = 39).
// If you raise PER_PAGE above 10, drop the avatar thumbnails or you'll hit the limit.

// Loads one display page. Returns null if the page is empty.
async function loadPage(displayPage, minLevel) {
  const startIdx = displayPage * PER_PAGE;

  if (minLevel) {
    const { players: all, guild, stale } = await getQualifying(minLevel);
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
  const data = await fetchApiPage(apiPage);

  const offset = startIdx % API_LIMIT;
  const players = data.players.slice(offset, offset + PER_PAGE);
  if (!players.length) return null;

  const hasNext =
    players.length === PER_PAGE &&
    (offset + PER_PAGE < data.players.length || data.players.length === API_LIMIT);

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

function render(view, { disabled = false, viewerId = null } = {}) {
  const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

  let header = `# 🏆 ${esc(view.guild.name || 'Server')} — XP Leaderboard`;
  if (view.minLevel) {
    header += `\n-# Showing Level ${view.minLevel}+ only • ${fmt(view.total)} player${view.total === 1 ? '' : 's'}`;
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

  if (view.stale) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# ⚠️ MEE6 is unreachable right now — showing cached data that may be outdated.'),
    );
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );

  view.players.forEach((p, i) => {
    const rank = view.startIdx + i + 1;
    const prefix = rank <= 3 ? MEDALS[rank - 1] : `**${rank}.**`;
    const you = viewerId && p.id === viewerId ? ' ← you' : '';

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${prefix} **${esc(p.username)}**${you}\n` +
              `Level **${p.level}** • ${fmt(p.xp)} XP • ${fmt(p.message_count)} msgs`,
          ),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl(p))),
    );
  });

  container.addSeparatorComponents(
    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  );
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

  return container;
}

module.exports = {
  cooldown: 10,

  data: new SlashCommandBuilder()
    .setName('mee6leaderboard')
    .setDescription('Show the MEE6 XP leaderboard')
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
        .setDescription('Page number to start on (10 players per page)')
        .setMinValue(1)
        .setMaxValue(100),
    ),

  async execute(interaction) {
    if (!(await ensureOwner(interaction))) return;

    await interaction.deferReply();

    const minLevel = interaction.options.getInteger('min_level') ?? DEFAULT_MIN_LEVEL;
    const viewerId = interaction.user.id;

    let view;
    try {
      view = await loadPage((interaction.options.getInteger('page') || 1) - 1, minLevel);
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
      components: [render(view, { viewerId })],
    });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: COLLECTOR_TIME,
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== viewerId) {
        return i
          .reply({ content: 'Run `/mee6leaderboard` yourself to browse pages.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }

      try {
        const target = i.customId === 'lb_next' ? view.page + 1 : view.page - 1;
        const next = await loadPage(target, minLevel);
        if (!next) return i.deferUpdate();

        view = next;
        await i.update({
          flags: MessageFlags.IsComponentsV2,
          components: [render(view, { viewerId })],
        });
      } catch (err) {
        log.error(`[mee6leaderboard] page change failed: ${err.message}`);
        await i
          .reply({ content: '❌ Failed to load that page.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    });

    collector.on('end', () => {
      interaction
        .editReply({
          flags: MessageFlags.IsComponentsV2,
          components: [render(view, { disabled: true, viewerId })],
        })
        .catch(() => {});
    });
  },
};