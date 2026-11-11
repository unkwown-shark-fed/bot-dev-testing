const {
  SlashCommandBuilder,
  MessageFlags,
  ComponentType,
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

// Requires discord.js >= 14.19 (Components V2)

const PER_PAGE = 5; // invites per page (keeps us well under the 40-component limit)
const CHART_TOP = 10; // invites shown in the chart
const COLLECTOR_TIME = 5 * 60_000; // buttons stay active for 5 minutes
const ACCENT = 0x5865f2;

const fmt = (n) => (n ?? 0).toLocaleString('en-US');

/* ----------------------------- helpers ----------------------------- */

function perDay(inv) {
  if (!inv.createdTimestamp) return 0;
  const days = Math.max((Date.now() - inv.createdTimestamp) / 86_400_000, 1 / 24);
  return (inv.uses ?? 0) / days;
}

/** ▰▰▰▰▱▱▱▱ style bar */
function bar(value, max, size = 10) {
  if (!max) return '▱'.repeat(size);
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * size));
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

const SORTS = {
  uses_desc: { label: 'Most used', emoji: '🔥', fn: (a, b) => (b.uses ?? 0) - (a.uses ?? 0) },
  uses_asc: { label: 'Least used', emoji: '🧊', fn: (a, b) => (a.uses ?? 0) - (b.uses ?? 0) },
  rate_desc: { label: 'Fastest growing (uses/day)', emoji: '🚀', fn: (a, b) => perDay(b) - perDay(a) },
  newest: { label: 'Newest first', emoji: '🆕', fn: (a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0) },
  oldest: { label: 'Oldest first', emoji: '📜', fn: (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0) },
};

/** Bar chart image (top N by uses) hosted by QuickChart. Returns URL or null. */
async function buildChartUrl(invites) {
  try {
    const top = [...invites].sort(SORTS.uses_desc.fn).slice(0, CHART_TOP);
    const res = await fetch('https://quickchart.io/chart/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '4',
        backgroundColor: '#2b2d31',
        width: 800,
        height: 80 + top.length * 42,
        format: 'png',
        chart: {
          type: 'bar',
          data: {
            labels: top.map((i) => i.code),
            datasets: [
              {
                label: 'Uses',
                data: top.map((i) => i.uses ?? 0),
                backgroundColor: '#5865F2',
                borderRadius: 6,
              },
            ],
          },
          options: {
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              title: {
                display: true,
                text: `Top ${top.length} Invites by Uses`,
                color: '#ffffff',
                font: { size: 18 },
              },
              datalabels: { color: '#ffffff', anchor: 'end', align: 'start', font: { weight: 'bold' } },
            },
            scales: {
              x: { beginAtZero: true, ticks: { color: '#b5bac1', precision: 0 }, grid: { color: '#3f4147' } },
              y: { ticks: { color: '#dbdee1' }, grid: { display: false } },
            },
          },
        },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.success ? json.url : null;
  } catch {
    return null;
  }
}

/* ------------------------------ view ------------------------------- */

function buildView(ctx, state, disabled = false) {
  const { guild, invites, totalUses, chartUrl, names } = ctx;

  const sorted = [...invites].sort(SORTS[state.sort].fn);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  state.page = Math.min(Math.max(state.page, 0), totalPages - 1);

  const start = state.page * PER_PAGE;
  const pageInvites = sorted.slice(start, start + PER_PAGE);
  const maxUses = Math.max(...invites.map((i) => i.uses ?? 0), 0);
  const top = [...invites].sort(SORTS.uses_desc.fn)[0];

  const container = new ContainerBuilder().setAccentColor(ACCENT);

  // Header
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🔗 Invite Links\n-# ${guild.name}`)
  );

  // Summary
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        `📨 **${fmt(invites.length)}** invites   •   👥 **${fmt(totalUses)}** total uses`,
        top && top.uses ? `🏆 Top invite: [\`${top.code}\`](https://discord.gg/${top.code}) — **${fmt(top.uses)}** uses` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  );

  // Chart (first page only, keeps other pages compact)
  if (chartUrl && state.page === 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(chartUrl))
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large));

  // Invites
  pageInvites.forEach((inv, idx) => {
    const uses = inv.uses ?? 0;
    const share = totalUses ? ((uses / totalUses) * 100).toFixed(1) : '0.0';
    const limit = inv.maxUses ? ` / ${fmt(inv.maxUses)}` : '';
    const expires = inv.expiresTimestamp ? `<t:${Math.floor(inv.expiresTimestamp / 1000)}:R>` : 'Never';
    const created = inv.createdTimestamp ? `<t:${Math.floor(inv.createdTimestamp / 1000)}:R>` : 'Unknown';
    const inviter = inv.inviter ? names.get(inv.inviter.id) ?? inv.inviter.username ?? 'Unknown' : 'Unknown';
    const channel = inv.channel ? `<#${inv.channel.id}>` : 'Unknown channel';
    const flags = [inv.temporary ? '⏱️ Temporary' : null].filter(Boolean);

    const text = [
      `### ${start + idx + 1}. \`${inv.code}\`  ➜  ${channel}`,
      `\`${bar(uses, maxUses)}\`  **${fmt(uses)}**${limit} uses  •  ${share}% of total`,
      `📈 ~${perDay(inv).toFixed(1)}/day   👤 ${inviter}`,
      `🗓️ Created ${created}   ⏳ Expires: ${expires}${flags.length ? `   ${flags.join(' ')}` : ''}`,
    ].join('\n');

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .setButtonAccessory(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Open')
            .setURL(`https://discord.gg/${inv.code}`)
        )
    );

    if (idx < pageInvites.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    }
  });

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large));

  // Sort menu
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('inv_sort')
        .setPlaceholder('Sort invites…')
        .setDisabled(disabled)
        .addOptions(
          Object.entries(SORTS).map(([value, s]) => ({
            label: s.label,
            value,
            emoji: s.emoji,
            default: value === state.sort,
          }))
        )
    )
  );

  // Pagination
  const atStart = state.page === 0;
  const atEnd = state.page >= totalPages - 1;
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inv_first').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || atStart),
      new ButtonBuilder().setCustomId('inv_prev').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(disabled || atStart),
      new ButtonBuilder()
        .setCustomId('inv_page')
        .setLabel(`Page ${state.page + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder().setCustomId('inv_next').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(disabled || atEnd),
      new ButtonBuilder().setCustomId('inv_last').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(disabled || atEnd)
    )
  );

  return { components: [container], totalPages };
}

/* ----------------------------- command ----------------------------- */

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invitestats')
    .setDescription('View all server invite links and their usage (bot owner only)')
    .setDMPermission(false),

  async execute(interaction) {
    // ---- Owner-only check ----
    let ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId) {
      try {
        const app = await interaction.client.application.fetch();
        ownerId = app.owner?.ownerId ?? app.owner?.id; // team -> ownerId, user -> id
      } catch {
        ownerId = null;
      }
    }

    if (!ownerId || interaction.user.id !== ownerId) {
      return interaction.reply({
        content: '❌ This command can only be used by the bot owner.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // ---- Fetch invites ----
    let fetched;
    try {
      fetched = await interaction.guild.invites.fetch();
    } catch {
      return interaction.editReply(
        '❌ I couldn\'t fetch invites. Make sure I have the **Manage Server** permission.'
      );
    }

    if (!fetched.size) {
      return interaction.editReply('ℹ️ This server has no active invite links.');
    }

    const invites = [...fetched.values()];
    const totalUses = invites.reduce((sum, i) => sum + (i.uses ?? 0), 0);

    // Resolve inviter names (avoids raw <@id> showing for uncached users)
    const names = new Map();
    const inviterIds = [...new Set(invites.map((i) => i.inviter?.id).filter(Boolean))];
    await Promise.all(
      inviterIds.map(async (id) => {
        try {
          const user = await interaction.client.users.fetch(id);
          names.set(id, `@${user.username}`);
        } catch {
          names.set(id, `Unknown (${id})`);
        }
      })
    );

    const chartUrl = await buildChartUrl(invites);

    const ctx = { guild: interaction.guild, invites, totalUses, chartUrl, names };
    const state = { page: 0, sort: 'uses_desc' };

    const message = await interaction.editReply({
      components: buildView(ctx, state).components,
      flags: MessageFlags.IsComponentsV2,
    });

    // ---- Pagination / sorting ----
    const collector = message.createMessageComponentCollector({
      time: COLLECTOR_TIME,
      filter: (i) => i.user.id === ownerId,
    });

    collector.on('collect', async (i) => {
      const { totalPages } = buildView(ctx, state);

      switch (i.customId) {
        case 'inv_first': state.page = 0; break;
        case 'inv_prev': state.page -= 1; break;
        case 'inv_next': state.page += 1; break;
        case 'inv_last': state.page = totalPages - 1; break;
        case 'inv_sort':
          if (i.componentType === ComponentType.StringSelect) {
            state.sort = i.values[0];
            state.page = 0;
          }
          break;
        default: break;
      }

      await i.update({ components: buildView(ctx, state).components });
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({ components: buildView(ctx, state, true).components });
      } catch {
        /* message may be gone */
      }
    });
  },
};
