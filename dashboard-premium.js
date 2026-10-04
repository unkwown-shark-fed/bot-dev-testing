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
const db           = require('./db');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.WEB_DASHBOARD_PORT || '3000', 10);
const PASSWORD  = process.env.DASHBOARD_PASSWORD || '';
const ROOT      = __dirname;
const CMD_DIR   = path.join(ROOT, 'commands');
const LOG_DIR   = path.join(ROOT, 'logs');
const WRITE_COMMAND_FILES = String(process.env.WRITE_COMMAND_FILES || '').toLowerCase() === 'true';
const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_IDS = (process.env.GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!PASSWORD) {
  console.error('❌ DASHBOARD_PASSWORD is required in environment. Refusing to start dashboard.');
  process.exit(1);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  },
}));
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const htmlPath = path.join(ROOT, 'public', 'premium.html');
  const cssPath = path.join(ROOT, 'public', 'css', 'dashboard.css');
  const assetVersion = fs.existsSync(cssPath)
    ? Math.floor(fs.statSync(cssPath).mtimeMs).toString()
    : Date.now().toString();

  const html = fs
    .readFileSync(htmlPath, 'utf8')
    .replace(/__ASSET_VERSION__/g, assetVersion);

  res.type('html').send(html);
});

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
  const proc = botProcess;
  if (proc) {
    botStatus = 'stopping';
    proc.kill('SIGTERM');

    // Wait for confirmed process close (or timeout) to avoid restart races.
    await Promise.race([
      new Promise(resolve => proc.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }

  if (botProcess) {
    return res.status(500).json({ error: 'Bot did not stop cleanly; restart aborted' });
  }

  spawnBot();
  res.json({ success: true, message: 'Restarted' });
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
      // Prefer current key `nick`, but keep backward compatibility with older `botNick`.
      nick:     cfg.nick ?? cfg.botNick ?? '',
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

app.get('/api/commands/:name/content', auth, async (req, res) => {
  try {
    const cmd = await db.getCommand(req.params.name);
    if (!cmd) return res.status(404).json({ error: 'Not found' });
    res.json({ content: cmd.code || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/commands/upload', auth, async (req, res) => {
  const { name: rawName, code, description = '' } = req.body || {};
  const name = sanitizeName(rawName);
  if (!name) return res.status(400).json({ error: 'Invalid command name' });
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Command code is required' });
  if (!TOKEN) return res.status(400).json({ error: 'DISCORD_TOKEN missing in .env' });
  if (!CLIENT_ID) return res.status(400).json({ error: 'CLIENT_ID missing in .env' });
  if (!GUILD_IDS.length) return res.status(400).json({ error: 'GUILD_IDS missing in .env' });

  let cmdModule;
  try {
    cmdModule = loadModuleFromString(code);
  } catch (e) {
    return res.status(400).json({ error: `Code syntax error: ${e.message}` });
  }

  if (!cmdModule?.data?.toJSON || typeof cmdModule?.execute !== 'function') {
    return res.status(400).json(buildInvalidCommandUploadResponse(code, cmdModule));
  }

  const cmdJson = cmdModule.data.toJSON();
  if (!cmdJson?.name || cmdJson.name !== name) {
    return res.status(400).json({ error: 'Body command name must match exported slash command name' });
  }

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const results = [];

    for (const gid of GUILD_IDS) {
      const existing = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, gid));
      const match = existing.find(c => c.name === name);
      const discordCmd = match
        ? await rest.patch(Routes.applicationGuildCommand(CLIENT_ID, gid, match.id), { body: cmdJson })
        : await rest.post(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: cmdJson });
      results.push({ guild: gid, id: discordCmd.id, action: match ? 'updated' : 'created' });
    }

    await db.upsertCommand(name, {
      name,
      description: description || cmdJson.description || 'Uploaded via dashboard',
      source: 'dashboard',
      flow: null,
      code,
      registered: true,
      registeredAt: new Date(),
    });

    if (WRITE_COMMAND_FILES) {
      if (!fs.existsSync(CMD_DIR)) fs.mkdirSync(CMD_DIR, { recursive: true });
      fs.writeFileSync(path.join(CMD_DIR, `${name}.js`), code, 'utf8');
    }

    res.json({
      success: true,
      message: `✅ /${name} uploaded to MongoDB and registered in Discord`,
      guilds: results,
      wroteFile: WRITE_COMMAND_FILES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Command name helper ─────────────────────────────────────────────────────
function sanitizeName(n) {
  return String(n || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

// ── Sync all /commands files into MongoDB ─────────────────────────────────────
app.post('/api/sync', auth, async (_req, res) => {
  // Express 4 does NOT auto-catch rejected promises in async handlers — an
  // uncaught throw anywhere below (e.g. Mongo down/unreachable, bad
  // DISCORD_TOKEN) would otherwise leave this request hanging forever and
  // the dashboard's "Syncing…" button would never resolve. Wrap everything.
  try {
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

        // Keep file-based commands (if present)
        for (const cmd of allCmds) {
          try {
            const fp = path.join(CMD_DIR, `${cmd.name}.js`);
            if (!fs.existsSync(fp)) continue;
            delete require.cache[require.resolve(fp)];
            const mod = require(fp);
            if (mod?.data?.toJSON) jsonCmds.push(mod.data.toJSON());
          } catch (_) {}
        }

        // Also include dashboard commands stored only in MongoDB.
        // Without this, syncing with WRITE_COMMAND_FILES=false can overwrite
        // guild commands with an empty list (appears as "no commands load").
        // Skip any whose file already exists — that copy was already added
        // above, and Discord's bulk overwrite rejects duplicate command names.
        for (const cmd of allCmds) {
          if (cmd.source !== 'dashboard' || !cmd.code) continue;
          const fp = path.join(CMD_DIR, `${cmd.name}.js`);
          if (fs.existsSync(fp)) continue;
          try {
            const mod = loadModuleFromString(cmd.code);
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
  } catch (e) {
    res.status(500).json({ error: `Sync failed: ${e.message}` });
  }
});

// ── Helper: load module from code string ──────────────────────────────────────
function loadModuleFromString(code) {
  const Module = require('module');
  const m = new Module('');
  m.filename = path.join(CMD_DIR || ROOT, '_preview.js');
  m.paths = Module._nodeModulePaths(CMD_DIR || ROOT);
  m._compile(code, m.filename);
  return m.exports;
}


function buildInvalidCommandUploadResponse(code, cmdModule) {
  const exportKeys = cmdModule && typeof cmdModule === 'object' ? Object.keys(cmdModule) : [];
  const hasModuleExports = /\bmodule\.exports\b|\bexports\./.test(code);
  const looksLikeBotEntrypoint = /\bnew\s+Client\s*\(|\bclient\.login\s*\(/.test(code);

  const hints = [`Found export keys: ${exportKeys.length ? exportKeys.join(', ') : '(none)'}`];
  if (!hasModuleExports) {
    hints.push('This file does not appear to export anything (missing module.exports / exports.*).');
  }
  if (looksLikeBotEntrypoint) {
    hints.push('The uploaded code looks like a bot entry file (index.js), not a slash command module.');
  }

  return {
    error: 'Code must export { data: SlashCommandBuilder, execute() }',
    hint: hints.join(' '),
    example: "module.exports = { data: new SlashCommandBuilder().setName('ping').setDescription('...'), async execute(interaction) { await interaction.reply('pong'); } }",
  };
}

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

// ── Command Log to Channel ────────────────────────────────────────────────────
// Your index.js should POST to /api/log with: { command, user, guild, channel, args }
// The dashboard will forward this to the configured logch channel.
// NOTE: protected by the same `auth` middleware as every other API route —
// this was previously open to unauthenticated requests, letting anyone who
// could reach this port forge log entries and post embeds into your
// configured Discord log/error channel.
app.post('/api/log', auth, async (req, res) => {
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