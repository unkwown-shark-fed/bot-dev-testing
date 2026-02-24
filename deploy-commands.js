const { REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();
const fs = require('fs');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIdsEnv = process.env.GUILD_IDS || '';
const guildIds = guildIdsEnv.split(',').map(s => s.trim()).filter(Boolean);

if (!token || !clientId || guildIds.length === 0) {
  console.error('❌ Please set DISCORD_TOKEN, CLIENT_ID and at least one GUILD_IDS in .env');
  process.exit(1);
}

console.log(`🤖 Client ID: ${clientId}`);
console.log(`🎯 Target guilds: ${guildIds.join(', ')}`);

// Build /generate command with 12 button option pairs
const generateCmd = new SlashCommandBuilder()
  .setName('generate')
  .setDescription('Generate the Community Custom Matches schedule embed with optional event buttons');
for (let i = 1; i <= 12; i++) {
  generateCmd
    .addStringOption(o => o.setName(`button${i}_label`).setDescription(`Button ${i} label`).setRequired(false))
    .addStringOption(o => o.setName(`button${i}_url`).setDescription(`Button ${i} URL`).setRequired(false));
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency and API ping'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands and their descriptions'),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Display detailed information about this server'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Display detailed information about a user')
    .addUserOption(o => o.setName('user').setDescription('User to get info about (defaults to you)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show detailed bot health, uptime, and statistics (admin only)'),

  new SlashCommandBuilder()
    .setName('exportmessages')
    .setDescription('Export multiple messages to CSV by providing links or IDs')
    .addStringOption(opt => opt.setName('messages').setDescription('Message links or IDs (space/newline separated)').setRequired(false))
    .addStringOption(opt => opt.setName('message').setDescription('(legacy) Single message link or ID').setRequired(false)),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export all messages in a channel or between two message IDs to CSV')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to export (defaults to current)').setRequired(false))
    .addStringOption(o => o.setName('start_id').setDescription('Start message ID (used with end_id)').setRequired(false))
    .addStringOption(o => o.setName('end_id').setDescription('End message ID (used with start_id)').setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('Max messages to fetch (0 = unlimited)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('exportinvites')
    .setDescription('Export unique users who posted a specific keyword to CSV')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to scan (defaults to current)').setRequired(false))
    .addStringOption(o => o.setName('keyword').setDescription('Keyword to search (default: !invites)').setRequired(false))
    .addStringOption(o => o.setName('after').setDescription('Start scanning AFTER this message link or ID').setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('Max messages to scan (0 = unlimited)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('repost')
    .setDescription('Fetch and repost messages from one channel to another')
    .addChannelOption(o => o.setName('source').setDescription('Source channel (defaults to current)').setRequired(false))
    .addStringOption(o => o.setName('start_id').setDescription('Start message ID (used with end_id)').setRequired(false))
    .addStringOption(o => o.setName('end_id').setDescription('End message ID (used with start_id)').setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('Max messages to fetch and repost').setRequired(false))
    .addChannelOption(o => o.setName('target').setDescription('Target channel (defaults to current)').setRequired(false))
    .addBooleanOption(o => o.setName('sanitize').setDescription('Sanitize mentions to avoid pings (default: true)').setRequired(false))
    .addBooleanOption(o => o.setName('include_link').setDescription('Include original message link').setRequired(false)),

  new SlashCommandBuilder()
    .setName('rolemanage')
    .setDescription('Bulk add or remove a role from multiple users')
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a role to users')
        .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true))
        .addStringOption(o => o.setName('users').setDescription('User IDs or mentions (space/newline separated)').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Process only first N users').setRequired(false)))
    .addSubcommand(sc =>
      sc.setName('remove')
        .setDescription('Remove a role from users')
        .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true))
        .addStringOption(o => o.setName('users').setDescription('User IDs or mentions (space/newline separated)').setRequired(true))
        .addIntegerOption(o => o.setName('limit').setDescription('Process only first N users').setRequired(false))),

  new SlashCommandBuilder()
    .setName('findids')
    .setDescription('Find Discord user IDs by searching usernames across servers')
    .addStringOption(o => o.setName('users').setDescription('Usernames to search (newline/comma separated)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Generate a randomized match schedule with maps and game modes')
    .addIntegerOption(o => o.setName('total_matches').setDescription('Total matches to schedule (default: 6)').setRequired(false))
    .addIntegerOption(o => o.setName('maps_to_select').setDescription('How many maps to pick from pool (default: 3)').setRequired(false))
    .addStringOption(o => o.setName('maps').setDescription('Comma-separated map list').setRequired(false))
    .addStringOption(o => o.setName('modes').setDescription('Comma-separated modes list').setRequired(false)),

  new SlashCommandBuilder()
    .setName('listusers')
    .setDescription('Display a paginated list of all members with a specific role')
    .addRoleOption(o => o.setName('role').setDescription('Role to list members of').setRequired(true)),

  new SlashCommandBuilder()
    .setName('fetchreactions')
    .setDescription('Fetch all messages with thumbsup/thumbsdown reaction counts from a channel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to fetch reactions from (defaults to current)').setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('Max messages to fetch (0 = unlimited, default: 1000)').setRequired(false).setMinValue(0).setMaxValue(10000)),

  new SlashCommandBuilder()
    .setName('cleanup')
    .setDescription('Bulk delete messages in a channel (admin only)')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false))
    .addBooleanOption(o => o.setName('bots_only').setDescription('Only delete bot messages').setRequired(false)),

  generateCmd

].map(cmd => cmd.toJSON());

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  
  console.log(`\n📋 Registering ${commands.length} slash commands...`);
  
  try {
    for (const gid of guildIds) {
      console.log(`\n⏳ Processing guild ${gid}...`);
      
      // PUT replaces ALL guild commands — this removes any old/stale commands automatically
      await rest.put(Routes.applicationGuildCommands(clientId, gid), { body: commands });
      
      console.log(`✅ Successfully registered ${commands.length} commands to guild ${gid}`);
    }

    // Update config.json with guild IDs and optional command role
    const cfgPath = './config.json';
    let cfg = {};
    try {
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      console.warn('⚠️  Could not read config.json, will create it.', err.message);
    }
    
    cfg.allowedGuilds = guildIds;
    if (process.env.COMMAND_ROLE_ID) cfg.commandRoleId = process.env.COMMAND_ROLE_ID;
    
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('\n✅ Updated config.json with guild IDs and settings');
    
    console.log('\n🎉 All commands registered successfully!');
    console.log(`📝 Command list: ${commands.map(c => `/${c.name}`).join(', ')}`);
    
  } catch (err) {
    console.error('\n❌ Failed to register commands:', err);
    if (err.code === 50001) {
      console.error('⚠️  Missing Access - Check that your bot is invited to the guild(s)');
    } else if (err.code === 10004) {
      console.error('⚠️  Unknown Guild - Check your GUILD_IDS in .env');
    } else if (err.status === 401) {
      console.error('⚠️  Invalid Token - Check your DISCORD_TOKEN in .env');
    }
    process.exit(1);
  }
})();
