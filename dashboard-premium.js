/**
 * dashboard-premium.js  —  Bot Studio v2.1 (MongoDB Edition)
 *
 * Commands are stored in MongoDB Atlas, not files.
 * Deploy = register directly to Discord API. No git push needed.
 *
 * NEW ENV VARS REQUIRED:
 *   MONGODB_URI=mongodb+srv://...
 *   CLIENT_ID=your-discord-app-client-id
 *   GUILD_IDS=guildId1,guildId2,...
 *   DISCORD_TOKEN=...
 *   DASHBOARD_PASSWORD=...
 */

'use strict';
require('dotenv').config();

const express      = require('express');
const { spawn }    = require('child_process');
const fs           = require('fs');
const path         = require('path');
const WebSocket    = require('ws');
const { REST, Routes } = require('discord.js');
const mongoose     = require('mongoose');
const db           = require('./db');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.WEB_DASHBOARD_PORT || '3000', 10);
const PASSWORD  = process.env.DASHBOARD_PASSWORD || 'admin123';
const ROOT      = __dirname;
const CMD_DIR   = path.join(ROOT, 'commands');
const LOG_DIR   = path.join(ROOT, 'logs');
const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_IDS = (process.env.GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ── Schedule Model ─────────────────────────────────────────────────────────────
function getScheduleModel() {
  if (mongoose.models.Schedule) return mongoose.models.Schedule;
  const scheduleSchema = new mongoose.Schema({
    label:     { type: String, default: 'Unnamed' },
    channel:   { type: String, required: true },
    message:   { type: String, default: '' },
    repeat:    { type: String, enum: ['once','hourly','daily','weekly'], default: 'once' },
    nextRun:   { type: Date, default: null },
    active:    { type: Boolean, default: true },
    embed:     { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  });
  return mongoose.model('Schedule', scheduleSchema);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'premium.html')));

function auth(req, res, next) {
  if ((req.headers.authorization || '') !== `Bearer ${PASSWORD}`)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Bot process ───────────────────────────────────────────────────────────────
let botProcess = null;
let botStatus  = 'stopped';
let botLogs    = [];
const MAX_LOGS = 500;

function addLog(type, message) {
  botLogs.push({ timestamp: new Date().toISOString(), type, message: message.trim() });
  if (botLogs.length > MAX_LOGS) botLogs = botLogs.slice(-MAX_LOGS);
}
function broadcast(type, data) {
  wss?.clients?.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type, data })));
}

function spawnBot() {
  botProcess = spawn('node', ['index.js'], { cwd: ROOT, env: { ...process.env } });
  botProcess.startTime = Date.now();
  botStatus = 'running';
  const fwd = (type) => (d) => {
    const l = d.toString();
    addLog(type, l);
    broadcast('log', { type, message: l, timestamp: new Date().toISOString() });
  };
  botProcess.stdout.on('data', fwd('info'));
  botProcess.stderr.on('data', fwd('error'));
  botProcess.on('close', code => {
    botStatus = 'stopped'; botProcess = null;
    addLog('info', `Bot exited with code ${code}`);
    broadcast('log', { type:'info', message: `Bot exited (code ${code})`, timestamp: new Date().toISOString() });
    broadcast('status', { status: 'stopped' });
  });
  broadcast('status', { status: 'running' });
}

// ── Auth & Status ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) =>
  res.json(req.body?.password === PASSWORD
    ? { success: true, token: PASSWORD }
    : { error: 'Invalid password' })
);

app.get('/api/status', auth, (req, res) => res.json({
  status: botStatus,
  uptime: botProcess ? Math.floor((Date.now() - botProcess.startTime) / 1000) : 0,
  pid:    botProcess?.pid ?? null,
}));

app.post('/api/start', auth, (_req, res) => {
  if (botStatus === 'running') return res.status(400).json({ error: 'Already running' });
  try { spawnBot(); res.json({ success: true, message: 'Bot started' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stop', auth, (_req, res) => {
  if (!botProcess) return res.status(400).json({ error: 'Not running' });
  botProcess.kill('SIGTERM');
  botStatus = 'stopping';
  res.json({ success: true, message: 'Stopping…' });
});

app.post('/api/restart', auth, async (_req, res) => {
  if (botProcess) { botProcess.kill('SIGTERM'); await new Promise(r => setTimeout(r, 1500)); }
  res.json({ success: true, message: 'Restarting…' });
  setTimeout(() => { if (botStatus !== 'running') spawnBot(); }, 600);
});

app.get('/api/logs', auth, (req, res) =>
  res.json({ logs: botLogs.slice(-(parseInt(req.query.limit) || 100)) })
);

app.get('/api/log-files', auth, (_req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) return res.json({ files: [] });
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => { const s = fs.statSync(path.join(LOG_DIR, f)); return { name: f, size: s.size, modified: s.mtime }; })
      .sort((a, b) => b.modified - a.modified);
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, async (_req, res) => {
  let stats = { version: '2.1.0', totalCommands: 0, fileCommands: 0, dbCommands: 0, guilds: GUILD_IDS.length, uptime: 0 };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    stats.version = pkg.version || '2.1.0';
  } catch (_) {}
  try {
    const all = await db.getAllCommands();
    stats.totalCommands = all.length;
    stats.fileCommands  = all.filter(c => c.source === 'file').length;
    stats.dbCommands    = all.filter(c => c.source === 'dashboard').length;
  } catch (_) {}
  if (botProcess) stats.uptime = Math.floor((Date.now() - botProcess.startTime) / 1000);
  res.json(stats);
});

// ── Settings (GET) ────────────────────────────────────────────────────────────
app.get('/api/settings', auth, (_req, res) => {
  try {
    const cfgPath = path.join(ROOT, 'config.json');
    let cfg = {};
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const settings = {
      nick:     cfg.botNick  || '',
      prefix:   cfg.prefix   || '!',
      status:   cfg.status   || 'idle',
      acttype:  cfg.acttype  || 'Listening',
      acttext:  cfg.acttext  || 'with commands',
      unknown:  cfg.unknown  || 'Unknown command.',
      error:    cfg.error    || 'Something went wrong.',
      cooldown: cfg.cooldown || 'Please wait before using this again.',
      logch:    cfg.logch    || process.env.LOG_CHANNEL   || '',
      errch:    cfg.errch    || process.env.ERROR_CHANNEL || '',
      devmode:  cfg.devmode  || false,
      dms:      cfg.dms !== undefined ? cfg.dms : true,
    };
    res.json({ success: true, settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings (POST) ───────────────────────────────────────────────────────────
app.post('/api/settings', auth, async (req, res) => {
  try {
    const { section, ...data } = req.body;
    const cfgPath = path.join(ROOT, 'config.json');
    let cfg = {};
    if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    Object.assign(cfg, data);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // If presence-related settings changed, apply to live bot via Discord Gateway
    if (section === 'presence' || data.status || data.acttype || data.acttext || data.nick) {
      await applyPresenceToDiscord(cfg).catch(e => console.warn('[presence] apply failed:', e.message));
    }

    res.json({ success: true, message: `${section || 'Settings'} saved` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Apply presence / nick to live Discord bot ─────────────────────────────────
async function applyPresenceToDiscord(cfg) {
  if (!TOKEN || !CLIENT_ID || !GUILD_IDS.length) return;
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  // Update bot nickname in all guilds
  if (cfg.nick !== undefined) {
    for (const gid of GUILD_IDS) {
      await rest.patch(Routes.guildMember(CLIENT_ID, gid), { body: { nick: cfg.nick || null } })
        .catch(() => {}); // may fail if missing perms — non-fatal
    }
  }

  // Presence (online/idle/dnd/invisible) + activity can only be set via Gateway (WebSocket),
  // not REST. We signal the running bot process via a temp file it watches.
  const presenceFile = path.join(ROOT, '.presence_update.json');
  fs.writeFileSync(presenceFile, JSON.stringify({
    status:   cfg.status  || 'online',
    acttype:  cfg.acttype || 'Listening',
    acttext:  cfg.acttext || '',
    ts: Date.now(),
  }));
  console.log('[settings] Presence file written — bot will pick it up on next cycle');
}

// ── Settings apply endpoint (manual trigger) ──────────────────────────────────
app.post('/api/settings/apply', auth, async (req, res) => {
  try {
    const cfgPath = path.join(ROOT, 'config.json');
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    await applyPresenceToDiscord(cfg);
    res.json({ success: true, message: 'Presence applied to Discord' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Danger Zone ───────────────────────────────────────────────────────────────
app.post('/api/danger/:op', auth, async (req, res) => {
  const { op } = req.params;
  try {
    if (op === 'clear-commands') {
      // Unregister all guild commands from Discord
      if (TOKEN && CLIENT_ID && GUILD_IDS.length) {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        for (const gid of GUILD_IDS) {
          await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: [] });
        }
      }
      // Wipe DB command records
      await db.connect();
      await db.Command.deleteMany({});
      res.json({ success: true, message: 'All commands cleared from Discord & DB' });

    } else if (op === 'reset-stats') {
      await db.connect();
      await db.Command.updateMany({}, { $set: { usageCount: 0, errorCount: 0, lastUsedAt: null } });
      res.json({ success: true, message: 'Usage stats reset' });

    } else if (op === 'flush-cache') {
      // Clear Node require cache for all command files
      if (fs.existsSync(CMD_DIR)) {
        for (const f of fs.readdirSync(CMD_DIR).filter(f => f.endsWith('.js'))) {
          try { delete require.cache[require.resolve(path.join(CMD_DIR, f))]; } catch (_) {}
        }
      }
      res.json({ success: true, message: 'Require cache flushed' });

    } else {
      res.status(400).json({ error: 'Unknown operation: ' + op });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Schedules ─────────────────────────────────────────────────────────────────
app.get('/api/schedules', auth, async (_req, res) => {
  try {
    await db.connect();
    const Schedule = getScheduleModel();
    const schedules = await Schedule.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, schedules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/schedules", auth, async (req, res) => {
  try {
    await db.connect();
    const Schedule = getScheduleModel();
    // Always set a valid nextRun — if not provided, default to NOW so
    // the runner picks it up on the very next tick (within 1 minute).
    let nextRun = req.body.nextRun ? new Date(req.body.nextRun) : new Date();
    if (isNaN(nextRun.getTime())) nextRun = new Date();
    const schedule = await Schedule.create({ ...req.body, nextRun, active: true, createdAt: new Date() });
    res.json({ success: true, schedule });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/schedules/:id", auth, async (req, res) => {
  try {
    await db.connect();
    const Schedule = getScheduleModel();
    const update = { ...req.body };
    if (update.nextRun) {
      const d = new Date(update.nextRun);
      update.nextRun = isNaN(d.getTime()) ? new Date() : d;
    }
    await Schedule.findByIdAndUpdate(req.params.id, update);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/schedules/:id', auth, async (req, res) => {
  try {
    await db.connect();
    const Schedule = getScheduleModel();
    await Schedule.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commands CRUD ─────────────────────────────────────────────────────────────
app.get('/api/commands', auth, async (_req, res) => {
  try { res.json({ commands: await db.getAllCommands() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commands/:name', auth, async (req, res) => {
  try {
    const cmd = await db.getCommand(req.params.name);
    if (!cmd) return res.status(404).json({ error: 'Not found' });
    res.json({ command: cmd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/commands/:name', auth, async (req, res) => {
  try {
    const cmd = await db.getCommand(req.params.name);
    if (!cmd) return res.status(404).json({ error: 'Not found' });

    const fp = path.join(CMD_DIR, `${req.params.name}.js`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);

    await db.deleteCommand(req.params.name);

    if (TOKEN && CLIENT_ID && GUILD_IDS.length) {
      try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        for (const gid of GUILD_IDS) {
          const existing = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, gid));
          const match = existing.find(c => c.name === req.params.name);
          if (match) await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, gid, match.id));
        }
      } catch (_) {}
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Flow: Generate code preview ───────────────────────────────────────────────
app.post('/api/flow/generate', auth, (req, res) => {
  try { res.json({ success: true, code: generateFlowCode(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Flow: Save to MongoDB + Register to Discord directly ──────────────────────
app.post('/api/flow/deploy', auth, async (req, res) => {
  const { flow, code } = req.body || {};
  if (!flow || !code) return res.status(400).json({ error: 'flow and code are required' });

  const name = sanitizeName(flow.commandName);
  if (!name) return res.status(400).json({ error: 'Invalid command name' });
  if (!TOKEN) return res.status(400).json({ error: 'DISCORD_TOKEN missing in .env' });
  if (!CLIENT_ID) return res.status(400).json({ error: 'CLIENT_ID missing in .env' });
  if (!GUILD_IDS.length) return res.status(400).json({ error: 'GUILD_IDS missing in .env' });

  let cmdModule;
  try { cmdModule = loadModuleFromString(code); }
  catch (e) { return res.status(400).json({ error: `Code syntax error: ${e.message}` }); }
  if (!cmdModule?.data?.toJSON)
    return res.status(400).json({ error: 'Generated code missing valid data property' });

  const cmdJson = cmdModule.data.toJSON();

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const results = [];
    for (const gid of GUILD_IDS) {
      const existing = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, gid));
      const match    = existing.find(c => c.name === name);
      const discordCmd = match
        ? await rest.patch(Routes.applicationGuildCommand(CLIENT_ID, gid, match.id), { body: cmdJson })
        : await rest.post(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: cmdJson });
      results.push({ guild: gid, id: discordCmd.id, action: match ? 'updated' : 'created' });
    }

    await db.upsertCommand(name, {
      name,
      description: flow.commandDesc || cmdJson.description || 'No description',
      source:      'dashboard',
      flow,
      code,
      registered:   true,
      registeredAt: new Date(),
    });

    if (!fs.existsSync(CMD_DIR)) fs.mkdirSync(CMD_DIR, { recursive: true });
    fs.writeFileSync(path.join(CMD_DIR, `${name}.js`), code, 'utf8');

    res.json({ success: true, message: `✅ /${name} saved to MongoDB & registered!`, guilds: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sync all /commands files into MongoDB ─────────────────────────────────────
app.post('/api/sync', auth, async (_req, res) => {
  const files  = fs.existsSync(CMD_DIR) ? fs.readdirSync(CMD_DIR).filter(f => f.endsWith('.js')) : [];
  const loaded = [];
  const failed = [];

  for (const file of files) {
    try {
      const fp = path.join(CMD_DIR, file);
      delete require.cache[require.resolve(fp)];
      const mod = require(fp);
      if (mod?.data?.name) loaded.push({ name: mod.data.name, description: mod.data.description || '' });
    } catch (e) { failed.push({ file, error: e.message }); }
  }

  await db.syncFileCommands(loaded);

  const results = { guilds: [], errors: [] };
  if (TOKEN && CLIENT_ID && GUILD_IDS.length) {
    try {
      const rest    = new REST({ version: '10' }).setToken(TOKEN);
      const allCmds = await db.getAllCommands();
      const jsonCmds = [];

      for (const cmd of allCmds) {
        try {
          const fp = path.join(CMD_DIR, `${cmd.name}.js`);
          if (!fs.existsSync(fp)) continue;
          delete require.cache[require.resolve(fp)];
          const mod = require(fp);
          if (mod?.data?.toJSON) jsonCmds.push(mod.data.toJSON());
        } catch (_) {}
      }

      for (const gid of GUILD_IDS) {
        const r = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: jsonCmds });
        results.guilds.push({ guild: gid, registered: r.length });
      }
    } catch (e) { results.errors.push(e.message); }
  }

  res.json({
    success: true,
    synced:  loaded.length,
    failed,
    guilds:  results.guilds,
    message: `Synced ${loaded.length} commands to MongoDB${results.guilds.length ? ' and re-registered all to Discord' : ''}`,
  });
});

// ── Helper: load module from code string ──────────────────────────────────────
function loadModuleFromString(code) {
  const Module = require('module');
  const m = new Module('');
  m.filename = path.join(CMD_DIR || ROOT, '_preview.js');
  m.paths = Module._nodeModulePaths(CMD_DIR || ROOT);
  m._compile(code, '_preview.js');
  return m.exports;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CODE GENERATOR
// ═════════════════════════════════════════════════════════════════════════════

function sanitizeName(n) {
  return String(n || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}
function j(v) { return JSON.stringify(String(v ?? '')); }
function needsEmbed(actions) { return actions.some(a => a.type?.includes('embed')); }

function embedBlock(a, ind) {
  const lines = [`${ind}const embed = new EmbedBuilder()`];
  if (a.embedTitle)       lines.push(`${ind}  .setTitle(${j(a.embedTitle)})`);
  if (a.embedDescription) lines.push(`${ind}  .setDescription(${j(a.embedDescription)})`);
  if (a.embedColor)       lines.push(`${ind}  .setColor(${j(a.embedColor)})`);
  if (a.embedFooter)      lines.push(`${ind}  .setFooter({ text: ${j(a.embedFooter)} })`);
  if (a.embedImage)       lines.push(`${ind}  .setImage(${j(a.embedImage)})`);
  if (a.embedThumbnail)   lines.push(`${ind}  .setThumbnail(${j(a.embedThumbnail)})`);
  lines[lines.length - 1] += ';';
  return lines.join('\n');
}

function buildConditions(conditions) {
  return conditions.map(c => {
    const fail = j(c.failMessage || '❌ You do not have permission to use this command.');
    switch (c.type) {
      case 'has_role':     return `    if (!interaction.member?.roles?.cache?.some(r => r.name === ${j(c.value)} || r.id === ${j(c.value)}))\n      return interaction.reply({ content: ${fail}, ephemeral: true });`;
      case 'missing_role': return `    if (interaction.member?.roles?.cache?.some(r => r.name === ${j(c.value)} || r.id === ${j(c.value)}))\n      return interaction.reply({ content: ${fail}, ephemeral: true });`;
      case 'in_channel':   return `    if (interaction.channel?.name !== ${j(c.value)} && interaction.channelId !== ${j(c.value)})\n      return interaction.reply({ content: ${fail}, ephemeral: true });`;
      case 'is_admin':     return `    if (!interaction.member?.permissions?.has('Administrator'))\n      return interaction.reply({ content: ${fail}, ephemeral: true });`;
      default: return '';
    }
  }).filter(Boolean).join('\n\n');
}

// ── Modal form code generator ─────────────────────────────────────────────────
function buildModalFormAction(a, ind = '    ') {
  const buttonLabel   = a.buttonLabel   || '📋 Open Form';
  const buttonStyle   = ['Primary','Secondary','Success','Danger'].includes(a.buttonStyle) ? a.buttonStyle : 'Primary';
  const modalTitle    = a.modalTitle    || 'Fill Out Form';
  const responseCh    = a.responseChannel || '';
  const useEmbed      = a.responseEmbed !== false;
  const fields        = (a.modalFields  || []).filter(f => f.label);
  const modalId       = `modal_form_submit`;
  const btnId         = `modal_form_open`;

  const fieldDefs = fields.map((f, i) => {
    const style = f.style === 'paragraph' ? 'TextInputStyle.Paragraph' : 'TextInputStyle.Short';
    return `    const field${i} = new TextInputBuilder()
      .setCustomId(${j(`field_${i}`)})
      .setLabel(${j(f.label)})
      .setPlaceholder(${j(f.placeholder || '')})
      .setStyle(${style})
      .setRequired(${!!f.required});`;
  }).join('\n');

  const fieldRows = fields.map((_, i) =>
    `    modal.addComponents(new ActionRowBuilder().addComponents(field${i}));`
  ).join('\n');

  let responseCode;
  if (useEmbed) {
    const fieldLines = fields.map((f, i) =>
      `        { name: ${j(f.label)}, value: i.fields.getTextInputValue(${j(`field_${i}`)}), inline: true }`
    ).join(',\n');
    responseCode = `      const resEmbed = new EmbedBuilder()
        .setTitle('📋 New Form Submission')
        .addFields(
${fieldLines},
          { name: 'Submitted By', value: \`\${i.user.tag} (<@\${i.user.id}>)\`, inline: false },
          { name: 'Submitted At', value: \`<t:\${Math.floor(Date.now()/1000)}:F>\`, inline: false }
        )
        .setColor('#2dd4a0')
        .setThumbnail(i.user.displayAvatarURL());
      await targetCh.send({ embeds: [resEmbed] });`;
  } else {
    const fieldLines = fields.map((f, idx) =>
      `**${f.label}:** \${i.fields.getTextInputValue(${j(`field_${idx}`)})}`
    ).join('\\n');
    responseCode = `      await targetCh.send(\`📋 **New Submission** from \${i.user.tag}\\n${fieldLines}\`);`;
  }

  const targetChCode = responseCh
    ? `i.guild?.channels?.cache?.find(c => c.name === ${j(responseCh)} || c.id === ${j(responseCh)})`
    : `i.channel`;

  return `
${ind}// ── Modal Form ──────────────────────────────────────────────────────────
${ind}// Step 1: Reply with the button
${ind}const formBtn = new ButtonBuilder()
${ind}  .setCustomId(${j(btnId)})
${ind}  .setLabel(${j(buttonLabel)})
${ind}  .setStyle(ButtonStyle.${buttonStyle});
${ind}await interaction.reply({
${ind}  content: 'Click the button below to open the form.',
${ind}  components: [new ActionRowBuilder().addComponents(formBtn)]
${ind}});

${ind}// Step 2: Listen for button click via client interactionCreate
${ind}// (showModal MUST be called as a direct response — collectors are too slow)
${ind}const _formHandler = async i => {
${ind}  if (!i.isButton() || i.customId !== ${j(btnId)}) return;

${ind}  // Build and show the modal immediately as the direct response
${ind}  const modal = new ModalBuilder()
${ind}    .setCustomId(${j(modalId)})
${ind}    .setTitle(${j(modalTitle)});
${fieldDefs}
${fieldRows}
${ind}  await i.showModal(modal);
${ind}};

${ind}const _submitHandler = async i => {
${ind}  if (!i.isModalSubmit() || i.customId !== ${j(modalId)}) return;
${ind}  try {
${ind}    await i.deferReply({ ephemeral: true });
${ind}    const targetCh = ${targetChCode};
${ind}    if (!targetCh) {
${ind}      await i.editReply({ content: '⚠️ Response channel not found. Contact an admin.' });
${ind}      return;
${ind}    }
${responseCode}
${ind}    await i.editReply({ content: '✅ Form submitted successfully!' });
${ind}  } catch (err) {
${ind}    _logger?.error?.('Modal submit error: ' + err.message);
${ind}    await i.editReply({ content: '⚠️ Something went wrong submitting the form.' }).catch(() => {});
${ind}  }
${ind}};

${ind}_client.on('interactionCreate', _formHandler);
${ind}_client.on('interactionCreate', _submitHandler);

${ind}// Clean up listeners after 10 minutes
${ind}setTimeout(() => {
${ind}  _client.off('interactionCreate', _formHandler);
${ind}  _client.off('interactionCreate', _submitHandler);
${ind}  interaction.editReply({
${ind}    content: '⏱️ This form has expired.',
${ind}    components: []
${ind}  }).catch(() => {});
${ind}}, 10 * 60 * 1000);`;
}

function buildActions(actions, ind = '    ') {
  return actions.map(a => {
    if (a.type === 'modal_form') return buildModalFormAction(a, ind);
    const eph = a.ephemeral ? ', ephemeral: true' : '';
    switch (a.type) {
      case 'reply_text':   return `${ind}await interaction.reply({ content: ${j(a.content || '')}${eph} });`;
      case 'reply_embed':  return embedBlock(a, ind) + `\n${ind}await interaction.reply({ embeds: [embed]${eph} });`;
      case 'followup_text': return `${ind}await interaction.followUp({ content: ${j(a.content || '')}${eph} });`;
      case 'followup_embed': return embedBlock(a, ind) + `\n${ind}await interaction.followUp({ embeds: [embed]${eph} });`;
      case 'send_to_channel':
        return `${ind}{\n${ind}  const _ch = interaction.guild?.channels?.cache?.find(c => c.name === ${j(a.channel||'')} || c.id === ${j(a.channel||'')});\n${ind}  if (_ch?.isTextBased?.()) await _ch.send({ content: ${j(a.content||'')} });\n${ind}}`;
      case 'send_embed_to_channel':
        return `${ind}{\n${embedBlock(a, ind+'  ')}\n${ind}  const _ch = interaction.guild?.channels?.cache?.find(c => c.name === ${j(a.channel||'')} || c.id === ${j(a.channel||'')});\n${ind}  if (_ch?.isTextBased?.()) await _ch.send({ embeds: [embed] });\n${ind}}`;
      default: return '';
    }
  }).filter(Boolean).join('\n\n');
}

function generateFlowCode(flow) {
  const { trigger, conditions = [], actions = [], commandName, commandDesc } = flow;
  if (!trigger) throw new Error('Trigger is required');
  const name = sanitizeName(commandName);
  if (!name)  throw new Error('Command name is empty or invalid');
  switch (trigger.type) {
    case 'slash':   return genSlash(name, commandDesc, trigger, conditions, actions);
    case 'button':  return genButton(name, commandDesc, trigger, conditions, actions);
    case 'keyword': return genKeyword(name, commandDesc, trigger, conditions, actions);
    default: throw new Error('Unknown trigger type: ' + trigger.type);
  }
}

function genSlash(name, desc, trigger, conditions, actions) {
  const hasModal   = actions.some(a => a.type === 'modal_form');
  const hasEmbed   = needsEmbed(actions);

  const imports = ['SlashCommandBuilder'];
  if (hasEmbed || hasModal) imports.push('EmbedBuilder');
  if (hasModal) imports.push('ActionRowBuilder', 'ButtonBuilder', 'ButtonStyle', 'ModalBuilder', 'TextInputBuilder', 'TextInputStyle');

  const opts   = (trigger.options || []).filter(o => sanitizeName(o.name));
  const optLines = opts.map(o => {
    const n = j(sanitizeName(o.name)), d = j(o.description || o.name);
    const req = `\n        .setRequired(${!!o.required})`;
    switch (o.type) {
      case 'string':  return `    .addStringOption(o => o.setName(${n}).setDescription(${d})${req})`;
      case 'integer': return `    .addIntegerOption(o => o.setName(${n}).setDescription(${d})${req})`;
      case 'user':    return `    .addUserOption(o => o.setName(${n}).setDescription(${d})${req})`;
      case 'boolean': return `    .addBooleanOption(o => o.setName(${n}).setDescription(${d})${req})`;
      case 'channel': return `    .addChannelOption(o => o.setName(${n}).setDescription(${d})${req})`;
      case 'role':    return `    .addRoleOption(o => o.setName(${n}).setDescription(${d})${req})`;
      default: return '';
    }
  }).filter(Boolean).join('\n');

  const cond = buildConditions(conditions);
  const act  = buildActions(actions);
  const cool = parseInt(trigger.cooldown, 10) || 3;

  return `const { ${imports.join(', ')} } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName(${j(name)})
    .setDescription(${j(desc || 'No description')})${optLines ? '\n' + optLines : ''},
  cooldown: ${cool},

  async execute(interaction, _client, _logger) {
    try {
${cond ? cond + '\n\n' : ''}${act}
    } catch (err) {
      _logger?.error?.(\`/${name} error: \${err.message}\`);
      const m = '⚠️ Something went wrong.';
      if (interaction.deferred) await interaction.editReply(m).catch(() => {});
      else if (!interaction.replied) await interaction.reply({ content: m, ephemeral: true }).catch(() => {});
    }
  },
};
`;
}

function genButton(name, desc, trigger, conditions, actions) {
  const allActs = [...actions, ...(trigger.buttons || []).flatMap(b => b.actions || [])];
  const imp  = (needsEmbed(allActs) ? 'EmbedBuilder, ' : '') + 'SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle';
  const cool = parseInt(trigger.cooldown, 10) || 3;
  const tms  = (parseInt(trigger.timeout, 10) || 60) * 1000;
  const cond = buildConditions(conditions);
  const btnDefs = (trigger.buttons || []).map(b => {
    const style = ['Primary','Secondary','Success','Danger'].includes(b.style) ? b.style : 'Primary';
    return `    new ButtonBuilder()\n      .setCustomId(${j(b.customId || `btn_${b.label}`)})\n      .setLabel(${j(b.label || 'Button')})\n      .setStyle(ButtonStyle.${style})`;
  }).join(',\n');
  const cases = (trigger.buttons || []).map(b => {
    const bActs = b.actions?.length ? b.actions : actions;
    return `      if (i.customId === ${j(b.customId || `btn_${b.label}`)}) {\n${buildActions(bActs, '        ')}\n      }`;
  }).join('\n');
  return `const { ${imp} } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName(${j(name)})
    .setDescription(${j(desc || 'No description')}),
  cooldown: ${cool},

  async execute(interaction, _client, _logger) {
    try {
${cond ? cond + '\n\n' : ''}      const row = new ActionRowBuilder().addComponents(
${btnDefs}
      );
      await interaction.reply({ content: ${j(trigger.promptMessage || 'Choose an option:')}, components: [row] });

      const filter = i => i.user.id === interaction.user.id;
      const col = interaction.channel.createMessageComponentCollector({ filter, time: ${tms} });
      col.on('collect', async i => {
        await i.deferUpdate();
${cases}
      });
      col.on('end', (_, reason) => {
        if (reason === 'time') interaction.editReply({ content: '⏱️ Timed out.', components: [] }).catch(() => {});
      });
    } catch (err) {
      _logger?.error?.(\`/${name} error: \${err.message}\`);
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true }).catch(() => {});
    }
  },
};
`;
}

function genKeyword(name, desc, trigger, conditions, actions) {
  const kws  = (trigger.keywords || []).map(k => j(k)).join(', ');
  const mt   = trigger.matchType || 'includes';
  const mexpr = mt === 'exact'       ? `[${kws}].some(k => content === k)` :
                mt === 'startsWith'  ? `[${kws}].some(k => content.startsWith(k))` :
                                       `[${kws}].some(k => content.includes(k))`;
  const botG = trigger.ignoreBots !== false ? `    if (message.author?.bot) return;\n` : '';
  const chG  = trigger.channel ? `    if (message.channel?.name !== ${j(trigger.channel)} && message.channelId !== ${j(trigger.channel)}) return;\n` : '';
  const imp  = needsEmbed(actions) ? `const { EmbedBuilder } = require('discord.js');\n\n` : '';
  const acts = actions.map(a => {
    switch (a.type) {
      case 'reply_text':   return `    await message.reply({ content: ${j(a.content||'')} });`;
      case 'reply_embed':  return embedBlock(a,'    ') + `\n    await message.reply({ embeds: [embed] });`;
      case 'send_to_channel': return `    {\n      const _ch = message.guild?.channels?.cache?.find(c => c.name === ${j(a.channel||'')} || c.id === ${j(a.channel||'')});\n      if (_ch?.isTextBased?.()) await _ch.send({ content: ${j(a.content||'')} });\n    }`;
      case 'send_embed_to_channel': return `    {\n${embedBlock(a,'      ')}\n      const _ch = message.guild?.channels?.cache?.find(c => c.name === ${j(a.channel||'')} || c.id === ${j(a.channel||'')});\n      if (_ch?.isTextBased?.()) await _ch.send({ embeds: [embed] });\n    }`;
      default: return '';
    }
  }).filter(Boolean).join('\n\n');
  return `${imp}module.exports = {
  name: ${j(name)},
  description: ${j(desc || 'No description')},
  type: 'messageCreate',
  keywords: [${kws}],
  matchType: ${j(mt)},
  channel: ${trigger.channel ? j(trigger.channel) : 'null'},

  async execute(message) {
${botG}${chG}    const content = message.content?.toLowerCase() || '';
    if (!${mexpr}) return;
${acts}
  },
};
`;
}

// ── Embed Send ────────────────────────────────────────────────────────────────
app.post('/api/embed/send', auth, async (req, res) => {
  try {
    const { channel: channelInput, embed, buttons = [], content = '' } = req.body;
    if (!channelInput) return res.status(400).json({ error: 'channel is required' });
    if (!TOKEN)        return res.status(500).json({ error: 'DISCORD_TOKEN not configured' });
    if (!GUILD_IDS.length) return res.status(500).json({ error: 'GUILD_IDS not configured' });

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    let channelId = null;
    for (const guildId of GUILD_IDS) {
      try {
        const channels = await rest.get(Routes.guildChannels(guildId));
        const match = channels.find(c =>
          c.id === channelInput || c.name === channelInput.replace('#', '')
        );
        if (match) { channelId = match.id; break; }
      } catch (_) {}
    }

    if (!channelId) return res.status(404).json({ error: `Channel "${channelInput}" not found in any configured guild` });

    const discordEmbed = {};
    if (embed.title)       discordEmbed.title       = embed.title;
    if (embed.description) discordEmbed.description = embed.description;
    if (embed.color)       discordEmbed.color        = parseInt(embed.color.replace('#', ''), 16);
    if (embed.author)      discordEmbed.author       = { name: embed.author, ...(embed.authorIcon ? { icon_url: embed.authorIcon } : {}) };
    if (embed.footer)      discordEmbed.footer       = { text: embed.footer };
    if (embed.timestamp === 'current') discordEmbed.timestamp = new Date().toISOString();
    if (embed.thumbnail)   discordEmbed.thumbnail    = { url: embed.thumbnail };
    if (embed.image)       discordEmbed.image        = { url: embed.image };
    if (embed.fields?.length) discordEmbed.fields   = embed.fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline }));

    const payload = { embeds: [discordEmbed] };
    if (content) payload.content = content;

    if (buttons.length) {
      payload.components = [{
        type: 1,
        components: buttons.slice(0, 5).map(b => ({
          type: 2,
          style: { Link: 5, Primary: 1, Secondary: 2, Success: 3, Danger: 4 }[b.style] || 5,
          label: b.label || 'Click me',
          ...(b.style === 'Link' || !b.style ? { url: b.url || 'https://discord.com' } : { custom_id: b.customId || `btn_${Date.now()}` })
        }))
      }];
    }

    await rest.post(Routes.channelMessages(channelId), { body: payload });
    res.json({ ok: true, channelId });
  } catch (err) {
    console.error('[embed/send]', err);
    res.status(500).json({ error: err.message || 'Failed to send embed' });
  }
});

// ── Server & WebSocket ────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`\n🚀 Bot Studio  →  http://localhost:${PORT}`);
  console.log(`🔐 Auth: DASHBOARD_PASSWORD env var`);
  console.log(`🗄  MongoDB: ${process.env.MONGODB_URI ? 'URI configured' : '⚠️  MONGODB_URI not set!'}`);
  console.log(`🤖 Discord: ${TOKEN ? 'token set' : '⚠️  DISCORD_TOKEN not set!'}`);
  console.log(`📡 Guilds: ${GUILD_IDS.length ? GUILD_IDS.join(', ') : '⚠️  GUILD_IDS not set!'}\n`);
  try { await db.connect(); console.log('[DB] Ready'); }
  catch (e) { console.error('[DB] Connection failed:', e.message); }
});

let wss;
server.on('listening', () => {
  wss = new WebSocket.Server({ server });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'status', data: { status: botStatus } }));
  });
});

setInterval(() => broadcast('status', { status: botStatus }), 6000);

process.on('SIGTERM', () => { if (botProcess) botProcess.kill('SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT',  () => { if (botProcess) botProcess.kill('SIGTERM'); server.close(); process.exit(0); });

// ── Scheduler Runner ──────────────────────────────────────────────────────────
async function runScheduler() {
  if (!TOKEN || !GUILD_IDS.length) return;
  try {
    await db.connect();
    const Schedule = getScheduleModel();
    const now = new Date();
    const due = await Schedule.find({ active: true, $or: [{ nextRun: { $lte: now } }, { nextRun: null }] });
    console.log(`[scheduler] Tick — ${due.length} schedule(s) due`);
    if (!due.length) return;

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    // Resolve channel IDs once across all guilds
    let allChannels = [];
    for (const gid of GUILD_IDS) {
      try {
        const chs = await rest.get(Routes.guildChannels(gid));
        allChannels.push(...chs);
      } catch (_) {}
    }

    for (const sched of due) {
      try {
        const ch = allChannels.find(c =>
          c.name === sched.channel || c.id === sched.channel
        );
        if (!ch) { console.warn(`[scheduler] Channel not found: ${sched.channel}`); continue; }

        const payload = {};
        if (sched.message) payload.content = sched.message;
        if (sched.embed) {
          const embed = { ...sched.embed };
          if (typeof embed.color === "string") {
            embed.color = parseInt(embed.color.replace("#", ""), 16);
          }
          payload.embeds = [embed];
        }
        if (!payload.content && !payload.embeds?.length) payload.content = '*(scheduled message)*';

        await rest.post(Routes.channelMessages(ch.id), { body: payload });
        console.log(`[scheduler] Sent "${sched.label}" to #${sched.channel}`);

        // Calculate next run or deactivate
        let nextRun = null;
        if (sched.repeat === 'hourly') nextRun = new Date(now.getTime() + 60 * 60 * 1000);
        if (sched.repeat === 'daily')  nextRun = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        if (sched.repeat === 'weekly') nextRun = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);

        if (nextRun) {
          await Schedule.findByIdAndUpdate(sched._id, { nextRun });
        } else {
          await Schedule.findByIdAndUpdate(sched._id, { active: false, nextRun: null });
        }
      } catch (e) {
        console.error(`[scheduler] Error for "${sched.label}":`, e.message);
      }
    }
  } catch (e) {
    console.error('[scheduler] Runner error:', e.message);
  }
}
setInterval(runScheduler, 60 * 1000); // check every minute
runScheduler();                        // also fire on startup

// ── Command Log to Channel ────────────────────────────────────────────────────
// Your index.js should POST to /api/log with: { command, user, guild, channel, args }
// The dashboard will forward this to the configured logch channel.
app.post('/api/log', async (req, res) => {
  try {
    const { command, user, guild, channel, args, error: cmdError } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });

    // Add to internal log stream too
    const logLine = `[CMD] /${command}${args ? ` ${args}` : ''} — by ${user || '?'} in #${channel || '?'} (${guild || '?'})${cmdError ? ` ❌ ${cmdError}` : ''}`;
    addLog(cmdError ? 'error' : 'info', logLine);
    broadcast('log', { type: cmdError ? 'error' : 'info', message: logLine, timestamp: new Date().toISOString() });

    // Send to configured log channel if set
    if (TOKEN && GUILD_IDS.length) {
      const cfgPath = path.join(ROOT, 'config.json');
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      const logChannel = cfg.logch || process.env.LOG_CHANNEL;
      const errChannel = cfg.errch || process.env.ERROR_CHANNEL;
      const targetCh   = cmdError ? (errChannel || logChannel) : logChannel;

      if (targetCh) {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        let channelId = null;

        for (const gid of GUILD_IDS) {
          try {
            const chs = await rest.get(Routes.guildChannels(gid));
            const match = chs.find(c => c.name === targetCh || c.id === targetCh);
            if (match) { channelId = match.id; break; }
          } catch (_) {}
        }

        if (channelId) {
          const color = cmdError ? 0xED4245 : 0x57F287;
          const embed = {
            color,
            title: cmdError ? `❌ Command Error: /${command}` : `✅ Command Used: /${command}`,
            fields: [
              { name: 'User',    value: user    || 'Unknown', inline: true },
              { name: 'Channel', value: channel ? `#${channel}` : 'Unknown', inline: true },
              { name: 'Server',  value: guild   || 'Unknown', inline: true },
              ...(args     ? [{ name: 'Arguments', value: `\`${args}\`` }]        : []),
              ...(cmdError ? [{ name: 'Error',     value: `\`\`\`${cmdError}\`\`\`` }] : []),
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Bot Command Log' },
          };
          await rest.post(Routes.channelMessages(channelId), { body: { embeds: [embed] } })
            .catch(e => console.warn('[log] Failed to send to channel:', e.message));
        }
      }
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});