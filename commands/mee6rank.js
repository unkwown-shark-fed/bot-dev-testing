const {
  SlashCommandBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');
const {
  log,
  ensureOwner,
  MAX_API_PAGES,
  API_LIMIT,
  findPlayer,
  esc,
  fmt,
  avatarUrl,
  levelProgress,
  progressBar,
  rewardInfo,
} = require('../utils/mee6');

// Requires discord.js >= 14.19 (Components V2) and Node 18+.

// Image card renderer. If @napi-rs/canvas isn't installed (or fails to load),
// the command falls back to the text layout below instead of breaking.
let rankCard = null;
try {
  rankCard = require('../utils/rankCard');
} catch (err) {
  log.warn(`[mee6rank] image card unavailable, using text layout: ${err.message}`);
}

const DEFAULT_COLOR = 0xf1c40f;
const SEP = '  ·  ';

// Thin rule between major blocks
const rule = () =>
  new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

// Pure breathing room (no line)
const gap = () =>
  new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Large);

const text = (content) => new TextDisplayBuilder().setContent(content);

function buildView({ player, rank, guild, roleRewards, stale }) {
  const { current, next } = rewardInfo(player.level, roleRewards);
  const { into, needed, pct } = levelProgress(player);

  // The container's accent edge follows the player's current reward tier colour
  const container = new ContainerBuilder().setAccentColor(current?.role?.color || DEFAULT_COLOR);

  // ---- Header -------------------------------------------------------------
  const identity = [
    current ? `**${esc(current.role.name)}**` : null,
    `Rank **#${fmt(rank)}**`,
    `Level **${player.level}**`,
  ]
    .filter(Boolean)
    .join(SEP);

  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        text(`-# ${esc(String(guild.name || 'Server').toUpperCase())}\n# ${esc(player.username)}`),
        text(identity),
      )
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl(player))),
  );

  container.addSeparatorComponents(rule());

  // ---- Progress -----------------------------------------------------------
  const toGo = Math.max(0, needed - into);
  container.addTextDisplayComponents(
    text(
      `-# PROGRESS\n` +
        `${progressBar(pct, 16, '▰', '▱')}  **${Math.round(pct * 100)}%**\n` +
        `-# ${fmt(into)} / ${fmt(needed)} XP${SEP}${fmt(toGo)} to Level ${player.level + 1}`,
    ),
  );

  container.addSeparatorComponents(gap());

  // ---- Activity -----------------------------------------------------------
  container.addTextDisplayComponents(
    text(
      `-# ACTIVITY\n` +
        `**${fmt(player.xp)}** XP${SEP}**${fmt(player.message_count)}** messages`,
    ),
  );

  // ---- Tiers --------------------------------------------------------------
  if (roleRewards.length) {
    container.addSeparatorComponents(gap());

    const total = roleRewards.length;
    const unlocked = roleRewards.filter((r) => r.rank <= player.level).length;
    const meter = '●'.repeat(unlocked) + '○'.repeat(total - unlocked);

    const status = next
      ? `Next: **${esc(next.role.name)}** at level ${next.rank}${SEP}` +
        `${next.rank - player.level} level${next.rank - player.level === 1 ? '' : 's'} away`
      : 'Maximum tier reached';

    container.addTextDisplayComponents(
      text(`-# TIERS\n${meter}  **${unlocked} / ${total}**\n-# ${status}`),
    );
  }

  // ---- Footer -------------------------------------------------------------
  container.addSeparatorComponents(rule());
  let footer = `-# MEE6${SEP}updated <t:${Math.floor(Date.now() / 1000)}:R>`;
  if (stale) footer += `\n-# ⚠ MEE6 is unreachable — showing cached data that may be outdated`;
  container.addTextDisplayComponents(text(footer));

  return container;
}

module.exports = {
  cooldown: 10,

  data: new SlashCommandBuilder()
    .setName('mee6rank')
    .setDescription("Show a member's MEE6 rank, level progress and role rewards")
    .addUserOption((opt) =>
      opt.setName('user').setDescription('Member to look up (defaults to you)'),
    ),

  async execute(interaction) {
    if (!(await ensureOwner(interaction))) return;

    await interaction.deferReply();

    const target = interaction.options.getUser('user') || interaction.user;

    let result;
    try {
      result = await findPlayer(target.id);
    } catch (err) {
      log.error(`[mee6rank] ${err.message}`);
      return interaction.editReply('❌ Could not reach the MEE6 API right now. Please try again in a moment.');
    }

    if (!result) {
      return interaction.editReply(
        `❌ **${esc(target.username)}** wasn't found in the top ${fmt(MAX_API_PAGES * API_LIMIT)} of the MEE6 leaderboard.`,
      );
    }

    // Preferred: image card
    if (rankCard) {
      try {
        const buffer = await rankCard.renderRankCard(result);
        return interaction.editReply({
          content: result.stale ? '-# ⚠ MEE6 is unreachable — showing cached data that may be outdated' : undefined,
          files: [new AttachmentBuilder(buffer, { name: `rank-${target.id}.png` })],
        });
      } catch (err) {
        log.error(`[mee6rank] card render failed, using text layout: ${err.message}`);
      }
    }

    // Fallback: text layout
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [buildView(result)],
    });
  },
};
