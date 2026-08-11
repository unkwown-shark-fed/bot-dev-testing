const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const { createCommandBuilder } = require('../utils/builders');

/* ===================== EDITABLE CONFIG ===================== */

const RULES_URL = 'https://discord.com/channels/410479299347480576/926499735248973874/1456345177164742656';

// Title shown at the top of the post
const TITLE = '📢 **Community Custom Matches: July schedule**';

// Optional text shown between the title and the schedule (leave as '' to hide)
const EXTRA_TEXT = '';

// Your full schedule — use \n for new lines, use backticks for code blocks
const SCHEDULE = `**11 July 2026**
\`\`\`
Match 1 | 6:00 PM | 11 July 2026 | Erangel: Theme Mode | Squad
Match 2 | 7:00 PM | 11 July 2026 | Sanhok   | Duo
Match 3 | 8:00 PM | 11 July 2026 | Vikendi  | Solo
\`\`\`

**12 July 2026**
\`\`\`
Match 1 | 6:00 PM | 12 July 2026 | Miramar  | Squad
Match 2 | 7:00 PM | 12 July 2026 | Vikendi  | Duo
Match 3 | 8:00 PM | 12 July 2026 | Sanhok   | Solo
\`\`\`

**25 July 2026**
\`\`\`
Match 1 | 6:00 PM | 25 July 2026 | Miramar  | Squad
Match 2 | 7:00 PM | 25 July 2026 | Erangel: Theme Mode | Duo
Match 3 | 8:00 PM | 25 July 2026 | Vikendi   | Solo
\`\`\`

**26 July 2026**
\`\`\`
Match 1 | 6:00 PM | 26 July 2026 | Miramar  | Squad
Match 2 | 7:00 PM | 26 July 2026 | Vikendi  | Duo
Match 3 | 8:00 PM | 26 July 2026 | Sanhok   | Solo
\`\`\``;

// Buttons — add as many as you need (max 12), set label and URL
// To disable a button, set it to null
const BUTTONS = [
  { label: 'July 11',  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'July 12',  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'July 25',  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'July 26',  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}
];

const GENERATE_V2_COMMAND_REVISION = 'components-v2-r1';

/* ========================================================== */

// Components V2 type IDs
const C = {
  Container: 17,
  TextDisplay: 10,
  Separator: 14,
};

function textDisplay(content) {
  return { type: C.TextDisplay, content };
}

function separator(spacing = 1) {
  return { type: C.Separator, divider: true, spacing };
}

function buildButtonRows() {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (const btn of BUTTONS) {
    if (!btn || !btn.label || !btn.url) continue;

    if (currentRow.components.length === 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    currentRow.addComponents(
      new ButtonBuilder()
        .setLabel(btn.label)
        .setStyle(ButtonStyle.Link)
        .setURL(btn.url)
    );
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function buildComponents(roleId) {
  const buttonRows = buildButtonRows();
  const trimmedExtra = EXTRA_TEXT?.trim();

  const containerChildren = [
    textDisplay(`## ${TITLE}`),
    textDisplay(`<@&${roleId}>`),
    ...(trimmedExtra ? [separator(), textDisplay(trimmedExtra)] : []),
    separator(),
    textDisplay(`### :date: Match schedule\n\nPrizes (Per Match):\n- Winning player and teams:\n  - Mythic Emblem Fragment ×5 & Classic Crate Coupon ×5\n- MVP(Each Match):\n  - 15 x Lucky Coins\n- ⚔️ <@&722406601595813900> role for 14 days to winning player, teams, and MVPs.\nRules: Tap to [read](${RULES_URL})`),
    separator(),
    textDisplay(SCHEDULE),
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

const cmdBuilder = createCommandBuilder({
  name: 'generate_v2',
  description: 'Post the Community Custom Matches schedule (configured in code)',
});

module.exports = {
  data: cmdBuilder,
  cooldown: 10,

  async execute(interaction, client, logger) {
    const ROLE_ID = String(process.env.ROLE_ID || '1204073198837309491');

    await interaction.reply({
      components: buildComponents(ROLE_ID),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: {
        roles: [ROLE_ID]
      }
    });

    logger?.info?.(`/generate_v2 used by ${interaction.user.tag} in guild ${interaction.guildId} (${GENERATE_V2_COMMAND_REVISION})`);
  }
};