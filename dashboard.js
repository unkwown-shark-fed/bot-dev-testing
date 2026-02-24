const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.WEB_DASHBOARD_PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

// Bot process management
let botProcess = null;
let botStatus = 'stopped';
let botLogs = [];
const MAX_LOG_LINES = 500;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    res.json({ success: true, token: PASSWORD });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Get bot status
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

    // Capture stdout
    botProcess.stdout.on('data', (data) => {
      const logLine = data.toString();
      addLog('info', logLine);
      broadcastLog('info', logLine);
    });

    // Capture stderr
    botProcess.stderr.on('data', (data) => {
      const logLine = data.toString();
      addLog('error', logLine);
      broadcastLog('error', logLine);
    });

    // Handle process exit
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

// Restart bot
app.post('/api/restart', authenticate, (req, res) => {
  if (botProcess && botStatus === 'running') {
    botProcess.kill('SIGTERM');
    setTimeout(() => {
      // Start will be triggered by the restart endpoint after stop
      res.json({ success: true, message: 'Bot restarting...' });
    }, 1000);
  } else {
    res.status(400).json({ error: 'Bot is not running' });
  }
});

// Get logs
app.get('/api/logs', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ logs: botLogs.slice(-limit) });
});

// Get log files
app.get('/api/log-files', authenticate, (req, res) => {
  const logsDir = path.join(__dirname, 'logs');
  
  if (!fs.existsSync(logsDir)) {
    return res.json({ files: [] });
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const stat = fs.statSync(path.join(logsDir, f));
      return {
        name: f,
        size: stat.size,
        modified: stat.mtime
      };
    })
    .sort((a, b) => b.modified - a.modified);

  res.json({ files });
});

// Download log file
app.get('/api/log-files/:filename', authenticate, (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, 'logs', filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Log file not found' });
  }

  res.download(filepath);
});

// Get bot stats
app.get('/api/stats', authenticate, (req, res) => {
  const configPath = path.join(__dirname, 'config.json');
  const packagePath = path.join(__dirname, 'package.json');

  let stats = {
    version: '2.0.0',
    commands: 16,
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

// Helper functions
function addLog(type, message) {
  const timestamp = new Date().toISOString();
  botLogs.push({ timestamp, type, message: message.trim() });
  
  // Keep only last MAX_LOG_LINES
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

// WebSocket for real-time logs
const server = app.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
  console.log(`Default password: ${PASSWORD}`);
  console.log(`Change it in .env with DASHBOARD_PASSWORD=your_password`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  // Send current status
  ws.send(JSON.stringify({
    type: 'status',
    data: { status: botStatus }
  }));

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Broadcast status changes
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

// Cleanup on exit
process.on('SIGTERM', () => {
  if (botProcess) {
    botProcess.kill('SIGTERM');
  }
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  if (botProcess) {
    botProcess.kill('SIGTERM');
  }
  server.close();
  process.exit(0);
});
