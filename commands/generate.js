const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

/* ================= EDITABLE CONFIG ================= */

const EMBED_MESSAGE = `
### :date: Match schedule

Rewards & rules: Tap to [read](https://discord.com/channels/410479299347480576/926499735248973874/1456345177164742656)
`;

const MATCH_DATES = [
  '13 March 2026',
  '14 March 2026',
  '20 March 2026',
  '21 March 2026'
];

const ALL_MAPS = ['Erangel', 'Sanhok', 'Miramar', 'Vikendi', 'Rondo'];
const MODES = ['Solo', 'Duo', 'Squad'];

const MATCH_TIMES = {
  1: '6:00 PM',
  2: '7:00 PM',
  3: '8:00 PM'
};

/* =================================================== */

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

function buildTable() {
  let table =
    'Match   | Time     | Date           | Map        | Mode\n' +
    '------------------------------------------------------------\n';

  for (const date of MATCH_DATES) {
    const rows = buildDay(date);

    for (const r of rows) {
      table +=
        r.match.padEnd(7) + ' | ' +
        r.time.padEnd(8) + ' | ' +
        r.date.padEnd(14) + ' | ' +
        r.map.padEnd(10) + ' | ' +
        r.mode + '\n';
    }

    table += '------------------------------------------------------------\n';
  }

  return table;
}

function buildEmbed() {
  return new EmbedBuilder()
    .setTitle('BATTLEGROUNDS MOBILE INDIA Community Custom Matches')
    .setColor(0x00c2ff)
    .setDescription(EMBED_MESSAGE.trim() + '\n\n```' + buildTable() + '```')
    .setFooter({ text: 'Tap the buttons below, then tap on "Interested" to get notifications.' })
    .setTimestamp();
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

const cmdBuilder = new SlashCommandBuilder()
  .setName('generate')
  .setDescription('Post the Community Custom Matches schedule embed with optional event buttons');

for (let i = 1; i <= 12; i++) {
  cmdBuilder
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

module.exports = {
  data: cmdBuilder,
  cooldown: 10,

  async execute(interaction, client, logger) {
    const ROLE_ID = String(process.env.ROLE_ID || '1204073198837309491');

    const buttonRows = buildButtonsFromCommand(interaction);

    await interaction.reply({
      content: `## 📢 **Community Custom Matches: February schedule** <@&${ROLE_ID}>`,
      embeds: [buildEmbed()],
      components: buttonRows,
      allowedMentions: {
        roles: [ROLE_ID]
      }
    });

    logger?.info?.(`/generate used by ${interaction.user.tag} in guild ${interaction.guildId}`);
  }
};
