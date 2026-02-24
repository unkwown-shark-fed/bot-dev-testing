const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.WEB_DASHBOARD_PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

let botProcess = null;
let botStatus = 'stopped';
let botLogs = [];
const MAX_LOG_LINES = 500;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Authentication
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Bot status
app.get('/api/status', authenticate, (req, res) => {
  res.json({
    status: botStatus,
    uptime: botProcess ? Math.floor((Date.now() - botProcess.startTime) / 1000) : 0,
    pid: botProcess ? botProcess.pid : null
  });
});

// Start bot
app.post('/api/start', authenticate, (req, res) => {
  if (botProcess && botStatus === 'running') {
    return res.status(400).json({ error: 'Bot is already running' });
  }

  try {
    botProcess = spawn('node', ['index.js'], {
      cwd: __dirname,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    botProcess.startTime = Date.now();
    botStatus = 'running';

    botProcess.stdout.on('data', (data) => {
      const logLine = data.toString();
      addLog('info', logLine);
      broadcastLog('info', logLine);
    });

    botProcess.stderr.on('data', (data) => {
      const logLine = data.toString();
      addLog('error', logLine);
      broadcastLog('error', logLine);
    });

    botProcess.on('close', (code) => {
      botStatus = 'stopped';
      const exitLog = `Bot process exited with code ${code}`;
      addLog('info', exitLog);
      broadcastLog('info', exitLog);
      botProcess = null;
    });

    res.json({ success: true, message: 'Bot started successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop bot
app.post('/api/stop', authenticate, (req, res) => {
  if (!botProcess || botStatus === 'stopped') {
    return res.status(400).json({ error: 'Bot is not running' });
  }

  try {
    botProcess.kill('SIGTERM');
    botStatus = 'stopping';
    res.json({ success: true, message: 'Bot stopping...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get logs
app.get('/api/logs', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ logs: botLogs.slice(-limit) });
});

// Get bot stats
app.get('/api/stats', authenticate, (req, res) => {
  const configPath = path.join(__dirname, 'config.json');
  const packagePath = path.join(__dirname, 'package.json');

  let stats = {
    version: '2.0.0',
    commands: 17,
    guilds: 0,
    uptime: 0
  };

  try {
    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      stats.version = pkg.version;
    }

    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      stats.guilds = config.allowedGuilds?.length || 0;
    }

    const commandsDir = path.join(__dirname, 'commands');
    if (fs.existsSync(commandsDir)) {
      stats.commands = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js')).length;
    }

    if (botProcess && botStatus === 'running') {
      stats.uptime = Math.floor((Date.now() - botProcess.startTime) / 1000);
    }
  } catch (err) {
    console.error('Error getting stats:', err);
  }

  res.json(stats);
});

// Save generated command
app.post('/api/save-command', authenticate, (req, res) => {
  try {
    const { name, code } = req.body;
    
    if (!name || !code) {
      return res.status(400).json({ error: 'Name and code required' });
    }

    // Validate name
    if (!/^[a-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid command name. Use lowercase letters, numbers, hyphens, and underscores only.' });
    }

    const commandPath = path.join(__dirname, 'commands', `${name}.js`);
    
    // Check if file exists
    if (fs.existsSync(commandPath)) {
      return res.status(400).json({ error: 'Command already exists. Choose a different name.' });
    }

    // Save file
    fs.writeFileSync(commandPath, code, 'utf8');

    res.json({ success: true, message: `Command saved as ${name}.js`, path: commandPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List commands
app.get('/api/commands', authenticate, (req, res) => {
  try {
    const commandsDir = path.join(__dirname, 'commands');
    const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
    
    const commands = files.map(file => {
      const filepath = path.join(commandsDir, file);
      const stat = fs.statSync(filepath);
      return {
        name: file.replace('.js', ''),
        filename: file,
        size: stat.size,
        modified: stat.mtime
      };
    });

    res.json({ commands });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete command
app.delete('/api/commands/:name', authenticate, (req, res) => {
  try {
    const { name } = req.params;
    const commandPath = path.join(__dirname, 'commands', `${name}.js`);
    
    if (!fs.existsSync(commandPath)) {
      return res.status(404).json({ error: 'Command not found' });
    }

    fs.unlinkSync(commandPath);
    res.json({ success: true, message: `Command ${name} deleted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get command content
app.get('/api/commands/:name/content', authenticate, (req, res) => {
  try {
    const { name } = req.params;
    const commandPath = path.join(__dirname, 'commands', `${name}.js`);
    
    if (!fs.existsSync(commandPath)) {
      return res.status(404).json({ error: 'Command not found' });
    }

    const content = fs.readFileSync(commandPath, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function addLog(type, message) {
  const timestamp = new Date().toISOString();
  botLogs.push({ timestamp, type, message: message.trim() });
  
  if (botLogs.length > MAX_LOG_LINES) {
    botLogs = botLogs.slice(-MAX_LOG_LINES);
  }
}

function broadcastLog(type, message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'log',
        data: { timestamp: new Date().toISOString(), type, message: message.trim() }
      }));
    }
  });
}

const server = app.listen(PORT, () => {
  console.log(`\n🎨 Premium Dashboard running on http://localhost:${PORT}`);
  console.log(`📱 Access from phone: http://YOUR-IP:${PORT}`);
  console.log(`🔐 Default password: ${PASSWORD}`);
  console.log(`⚙️  Change password in .env: DASHBOARD_PASSWORD=your_password\n`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  ws.send(JSON.stringify({
    type: 'status',
    data: { status: botStatus }
  }));

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'status',
        data: { status: botStatus }
      }));
    }
  });
}, 5000);

process.on('SIGTERM', () => {
  if (botProcess) botProcess.kill('SIGTERM');
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (botProcess) botProcess.kill('SIGTERM');
  server.close();
  process.exit(0);
});
