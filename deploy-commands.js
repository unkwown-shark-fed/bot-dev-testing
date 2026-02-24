const { REST, Routes } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIdsEnv = process.env.GUILD_IDS || '';
const guildIds = guildIdsEnv.split(',').map(s => s.trim()).filter(Boolean);

if (!token || !clientId || guildIds.length === 0) {
  console.error('❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_IDS in .env');
  process.exit(1);
}

// ── Auto-scan /commands folder ───────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

const commands = [];
const skipped = [];

for (const file of commandFiles) {
  try {
    // Clear require cache so re-deploys always pick up latest file version
    const filePath = path.join(commandsPath, file);
    delete require.cache[require.resolve(filePath)];

    const command = require(filePath);

    if (!command?.data?.toJSON) {
      skipped.push(`${file} — missing data.toJSON() (not a valid SlashCommandBuilder)`);
      continue;
    }

    commands.push(command.data.toJSON());
    console.log(`  ✅ Loaded: /${command.data.name}  (${file})`);
  } catch (err) {
    skipped.push(`${file} — ${err.message}`);
    console.warn(`  ⚠️  Skipped: ${file} — ${err.message}`);
  }
}

if (skipped.length) {
  console.log(`\n⚠️  Skipped ${skipped.length} file(s):`);
  skipped.forEach(s => console.log(`   • ${s}`));
}

console.log(`\n📋 Registering ${commands.length} command(s) to ${guildIds.length} guild(s)...\n`);

// ── Deploy ───────────────────────────────────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    for (const guildId of guildIds) {
      console.log(`⏳ Deploying to guild ${guildId}...`);

      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );

      console.log(`✅ Done — guild ${guildId}`);
    }

    // Update config.json with current guild list
    const cfgPath = path.join(__dirname, 'config.json');
    let cfg = {};
    try {
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (_) {}
    cfg.allowedGuilds = guildIds;
    if (process.env.COMMAND_ROLE_ID) cfg.commandRoleId = process.env.COMMAND_ROLE_ID;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    console.log(`\n🎉 All ${commands.length} commands registered successfully!`);
    console.log(`📝 Commands: ${commands.map(c => `/${c.name}`).join(', ')}`);

  } catch (err) {
    console.error('\n❌ Deploy failed:', err.message);
    if (err.code === 50001) console.error('⚠️  Missing Access — is the bot invited to this guild?');
    else if (err.code === 10004) console.error('⚠️  Unknown Guild — check GUILD_IDS in .env');
    else if (err.status === 401) console.error('⚠️  Invalid Token — check DISCORD_TOKEN in .env');
    process.exit(1);
  }
})();