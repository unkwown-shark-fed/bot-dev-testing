const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

/* ================= EDITABLE CONFIG ================= */

const RULES_URL = 'https://discord.com/channels/410479299347480576/926499735248973874/1456345177164742656';

const MATCH_DATES = [
  '11 July 2026',
  '12 July 2026',
  '25 July 2026',
  '26 July 2026'
];

const ALL_MAPS = ['Erangel: Theme Mode', 'Sanhok', 'Miramar', 'Vikendi', 'Rondo', 'Karakin'];
const MODES = ['Solo', 'Duo', 'Squad'];

const MATCH_TIMES = {
  1: '6:00 PM',
  2: '7:00 PM',
  3: '8:00 PM'
};
const GENERATE_COMMAND_REVISION = 'components-v2-r5';

/* =================================================== */

// Components V2 type IDs
const C = {
  Container: 17,
  TextDisplay: 10,
  Separator: 14,
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDay(date) {
  const noSoloMaps = ['Miramar', 'Rondo'];
  let maps = shuffle(ALL_MAPS).slice(0, 3);
  let modes = shuffle(MODES);

  for (let i = 0; i < 3; i++) {
    if (noSoloMaps.includes(maps[i]) && modes[i] === 'Solo') {
      for (let j = 0; j < 3; j++) {
        if (modes[j] !== 'Solo' && !noSoloMaps.includes(maps[j])) {
          [modes[i], modes[j]] = [modes[j], modes[i]];
          break;
        }
      }
    }
  }

  return maps.map((map, i) => ({
    match: `Match ${i + 1}`,
    time: MATCH_TIMES[i + 1],
    date,
    map,
    mode: modes[i]
  }));
}

function buildDayBlock(date) {
  const rows = buildDay(date);
  const lines = rows.map(r =>
    r.match.padEnd(7) + ' | ' +
    r.time.padEnd(8) + ' | ' +
    r.date.padEnd(14) + ' | ' +
    r.map.padEnd(8) + ' | ' +
    r.mode
  );
  return `**${date}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

function textDisplay(content) {
  return { type: C.TextDisplay, content };
}

function separator(spacing = 1) {
  return { type: C.Separator, divider: true, spacing };
}

function buildComponents(buttonRows, roleId, extraText) {
  const dayBlocks = MATCH_DATES.map(date => buildDayBlock(date)).join('\n');
  const trimmedExtraText = extraText?.trim();

  // Everything lives inside one top-level Container
  const containerChildren = [
    textDisplay('## 📢 **Community Custom Matches: July schedule**'),
    textDisplay(`<@&${roleId}>`),
    ...(trimmedExtraText ? [separator(), textDisplay(trimmedExtraText)] : []),
    separator(),
    textDisplay(`### :date: Match schedule\n\nPrizes (Per Match):
- Winning player and teams:
  - Mythic Emblem Fragment ×5 & Classic Crate Coupon ×5
- MVP(Each Match):
  - 15 x Lucky Coins
- ⚔️ <@&722406601595813900> role for 14 days to winning player, teams, and MVPs.\nRules: Tap to [read](${RULES_URL})`),
    separator(),
    textDisplay(dayBlocks),
    separator(),
    textDisplay('-# Tap the buttons below, then tap on "Interested" to get notifications.'),
    ...buttonRows.map(row => row.toJSON()),
  ];

  return [
    {
      type: C.Container,
      components: containerChildren,
    }
  ];
}

function buildButtonsFromCommand(interaction) {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 1; i <= 12; i++) {
    const label = interaction.options.getString(`button${i}_label`);
    const url = interaction.options.getString(`button${i}_url`);

    if (!label || !url) continue;

    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    currentRow.addComponents(
      new ButtonBuilder()
        .setLabel(label)
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

const cmdBuilder = createCommandBuilder({
  name: 'generate',
  description: 'Post the Community Custom Matches schedule embed with optional event buttons',
  configure: builder => {
    builder.addStringOption(o =>
      o.setName('extra_text')
        .setDescription('Optional text shown above the schedule')
        .setRequired(false)
    );

    for (let i = 1; i <= 12; i++) {
      builder
        .addStringOption(o =>
          o.setName(`button${i}_label`)
            .setDescription(`Button ${i} label`)
            .setRequired(false)
        )
        .addStringOption(o =>
          o.setName(`button${i}_url`)
            .setDescription(`Button ${i} URL`)
            .setRequired(false)
        );
    }
    return builder;
  },
});

module.exports = {
  data: cmdBuilder,
  cooldown: 10,

  async execute(interaction, client, logger) {
    const ROLE_ID = String(process.env.ROLE_ID || '1204073198837309491');
    const extraText = interaction.options.getString('extra_text');
    const buttonRows = buildButtonsFromCommand(interaction);

    await interaction.reply({
      components: buildComponents(buttonRows, ROLE_ID, extraText),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: {
        roles: [ROLE_ID]
      }
    });

    logger?.info?.(`/generate used by ${interaction.user.tag} in guild ${interaction.guildId} (${GENERATE_COMMAND_REVISION})`);
  }
};
