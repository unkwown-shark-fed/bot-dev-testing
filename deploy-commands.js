const { REST, Routes } = require('discord.js');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { loadCommandModules } = require('./utils/command-loader');
const db = require('./db');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIdsEnv = process.env.GUILD_IDS || '';
const guildIds = guildIdsEnv.split(',').map(s => s.trim()).filter(Boolean);
const dbOnlyMode = String(process.env.DB_ONLY_COMMANDS || '').toLowerCase() === 'true';

if (!token || !clientId || guildIds.length === 0) {
  console.error('❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_IDS in .env');
  process.exit(1);
}

async function buildCommandsForDeploy() {
  async function loadDbCommandJson() {
    console.log('🧠 Loading slash commands from MongoDB records');
    await db.connect();
    const records = await db.getAllCommands();
    const Module = require('module');
    const commands = [];

    for (const record of records) {
      if (!record?.code || record?.source !== 'dashboard') continue;
      try {
        const filename = path.join(__dirname, 'commands', `_deploy_${record.name}.js`);
        const m = new Module(filename);
        m.filename = filename;
        m.path = path.dirname(filename);
        m.paths = Module._nodeModulePaths(m.path);
        m._compile(record.code, filename);
        const cmd = m.exports;
        if (cmd?.data?.toJSON) {
          commands.push(cmd.data.toJSON());
          console.log(`  ✅ Loaded from DB: /${cmd.data.name}`);
        }
      } catch (error) {
        console.log(`  ⚠️  Skipped DB command ${record.name}: ${error.message}`);
      }
    }
    return commands;
  }

  if (!dbOnlyMode) {
    const commandsPath = path.join(__dirname, 'commands');
    const { loaded, skipped } = loadCommandModules({
      commandsPath,
      clearCache: true,
      requireExecute: false,
    });

    const commands = loaded.map(({ command, file }) => {
      console.log(`  ✅ Loaded: /${command.data.name}  (${file})`);
      return command.data.toJSON();
    });

    if (skipped.length) {
      console.log(`\n⚠️  Skipped ${skipped.length} file(s):`);
      skipped.forEach(entry => console.log(`   • ${entry.file} — ${entry.reason}`));
    }

    if (commands.length > 0) return commands;

    console.log('⚠️  No file-based commands found. Falling back to MongoDB commands...');
    return loadDbCommandJson();
  }

  return loadDbCommandJson();
}

// ── Deploy ───────────────────────────────────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    const commands = await buildCommandsForDeploy();
    console.log(`\n📋 Registering ${commands.length} command(s) to ${guildIds.length} guild(s)...\n`);
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
