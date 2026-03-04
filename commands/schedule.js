const { createCommandBuilder, createEmbed, EMBED_COLORS } = require('../utils/builders');

function shuffle(array) {
  const a = Array.from(array);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function chooseRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function chunkLines(lines, maxLen = 1000) {
  const blocks = [];
  let current = [];
  let curLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (curLen + lineLen > maxLen && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
      curLen = 0;
    }
    current.push(line);
    curLen += lineLen;
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

module.exports = {
  data: createCommandBuilder({
    name: 'schedule',
    description: 'Generate a randomized match schedule (maps + modes). Miramar only Duo/Squad.',
    configure: builder => builder
      .addIntegerOption(o => o.setName('total_matches').setDescription('Total matches to schedule (default 6)').setRequired(false))
      .addIntegerOption(o => o.setName('maps_to_select').setDescription('How many maps to pick from pool (default 3)').setRequired(false))
      .addStringOption(o => o.setName('maps').setDescription('Optional comma-separated map list').setRequired(false))
      .addStringOption(o => o.setName('modes').setDescription('Optional comma-separated modes list').setRequired(false)),
  }),
  cooldown: 3,
  async execute(interaction) {
    const DEFAULT_TOTAL = 6;
    const DEFAULT_MAPS_TO_SELECT = 3;
    const DEFAULT_MAPS = ['Erangel', 'Sanhok', 'Miramar', 'Vikendi', 'Rondo'];
    const DEFAULT_MODES = ['Solo', 'Duo', 'Squad'];

    const totalMatches = Math.max(1, Math.min(500, interaction.options.getInteger('total_matches') ?? DEFAULT_TOTAL));
    let mapsToSelect = Math.max(1, interaction.options.getInteger('maps_to_select') ?? DEFAULT_MAPS_TO_SELECT);

    const mapsOption = interaction.options.getString('maps');
    const modesOption = interaction.options.getString('modes');

    const mapsPool = mapsOption ? mapsOption.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MAPS;
    const modesPool = modesOption ? modesOption.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODES;

    if (mapsPool.length === 0) return interaction.reply({ content: 'Map list empty.', ephemeral: true });
    if (modesPool.length === 0) return interaction.reply({ content: 'Modes list empty.', ephemeral: true });

    if (mapsToSelect > mapsPool.length) mapsToSelect = mapsPool.length;
    const selectedMaps = shuffle(mapsPool).slice(0, mapsToSelect);

    const matches = [];
    for (let i = 0; i < totalMatches; i++) {
      const map = selectedMaps[i % mapsToSelect];
      let allowedModes = modesPool;
      if (String(map).toLowerCase() === 'miramar') {
        const filtered = modesPool.filter(m => m.toLowerCase() !== 'solo');
        allowedModes = filtered.length ? filtered : modesPool;
      }
      const mode = chooseRandom(allowedModes);
      matches.push({ match: i + 1, map, mode });
    }

    const matchLines = matches.map(m => `${m.match}. ${m.map} — ${m.mode}`);
    const blocks = chunkLines(matchLines, 1000);

    const embed = createEmbed({
      title: 'Match Schedule',
      color: EMBED_COLORS.info,
    }).addFields(
        { name: 'Selected maps', value: selectedMaps.join(', '), inline: false },
        { name: 'Modes pool', value: modesPool.join(', '), inline: false },
        { name: 'Total matches', value: String(totalMatches), inline: true },
        { name: 'Maps used', value: String(mapsToSelect), inline: true }
      );

    let startIdx = 1;
    for (const block of blocks) {
      const endIdx = startIdx + block.split('\n').length - 1;
      embed.addFields({ name: `Matches ${startIdx}–${endIdx}`, value: block, inline: false });
      startIdx = endIdx + 1;
    }

    await interaction.reply({ embeds: [embed] });
  }
};