const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const LOG_LIMIT = 800;

let mainWindow;
let botProcess = null;
let dashboardProcess = null;
let logs = [];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: 'Discord Utility Bot Control Center',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function appendLog(source, type, message) {
  const entries = String(message)
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => ({ source, type, message: line, timestamp: new Date().toISOString() }));

  if (!entries.length) return;
  logs = logs.concat(entries).slice(-LOG_LIMIT);
  entries.forEach(entry => send('log:entry', entry));
}

function readEnvFile() {
  const filePath = fs.existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  return raw.split(/\r?\n/).reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return acc;
    const index = trimmed.indexOf('=');
    acc[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    return acc;
  }, {});
}

function serializeEnv(values) {
  const orderedKeys = [
    'DISCORD_TOKEN',
    'CLIENT_ID',
    'GUILD_IDS',
    'COMMAND_ROLE_ID',
    'BOT_OWNER_ID',
    'ROLE_ID',
    'OUTPUT_DIR',
    'DEFAULT_PER_CHANNEL_LIMIT',
    'REPOST_MAX_SEND',
    'LOG_FILE',
    'ERROR_LOG_FILE',
    'LOG_LEVEL',
    'NODE_ENV',
    'WEB_DASHBOARD_PORT',
    'DASHBOARD_PASSWORD',
    'MONGODB_URI',
    'DB_ONLY_COMMANDS',
    'WRITE_COMMAND_FILES',
  ];
  const current = readEnvFile();
  const merged = { ...current, ...values };
  return orderedKeys
    .filter(key => Object.prototype.hasOwnProperty.call(merged, key))
    .map(key => `${key}=${String(merged[key] ?? '').replace(/\n/g, '')}`)
    .join('\n') + '\n';
}

function getStatus() {
  return {
    bot: botProcess ? 'running' : 'stopped',
    dashboard: dashboardProcess ? 'running' : 'stopped',
    envExists: fs.existsSync(ENV_PATH),
    dashboardUrl: `http://localhost:${readEnvFile().WEB_DASHBOARD_PORT || '3000'}`,
  };
}

function notifyStatus() {
  send('status:update', getStatus());
}

function spawnManaged(name, command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...readEnvFile() },
    shell: process.platform === 'win32',
  });

  child.stdout.on('data', data => appendLog(name, 'info', data));
  child.stderr.on('data', data => appendLog(name, 'error', data));
  child.on('error', error => appendLog(name, 'error', error.message));
  return child;
}

ipcMain.handle('env:load', () => readEnvFile());
ipcMain.handle('env:save', (_event, values) => {
  fs.writeFileSync(ENV_PATH, serializeEnv(values));
  appendLog('app', 'info', '.env saved');
  notifyStatus();
  return readEnvFile();
});
ipcMain.handle('logs:list', () => logs);
ipcMain.handle('status:get', () => getStatus());

ipcMain.handle('deps:install', async () => new Promise(resolve => {
  appendLog('app', 'info', 'Starting npm install...');
  const child = spawnManaged('install', 'npm', ['install']);
  child.on('close', code => {
    appendLog('install', code === 0 ? 'info' : 'error', `npm install exited with code ${code}`);
    resolve({ code });
  });
}));

ipcMain.handle('commands:deploy', async () => new Promise(resolve => {
  appendLog('app', 'info', 'Deploying Discord slash commands...');
  const child = spawnManaged('deploy', 'npm', ['run', 'deploy']);
  child.on('close', code => {
    appendLog('deploy', code === 0 ? 'info' : 'error', `deploy exited with code ${code}`);
    resolve({ code });
  });
}));

ipcMain.handle('bot:start', () => {
  if (botProcess) return getStatus();
  botProcess = spawnManaged('bot', 'npm', ['start']);
  appendLog('app', 'info', 'Bot process started');
  botProcess.on('close', code => {
    appendLog('bot', code === 0 ? 'info' : 'error', `bot exited with code ${code}`);
    botProcess = null;
    notifyStatus();
  });
  notifyStatus();
  return getStatus();
});

ipcMain.handle('bot:stop', () => {
  if (botProcess) botProcess.kill('SIGTERM');
  return getStatus();
});

ipcMain.handle('dashboard:start', () => {
  if (dashboardProcess) return getStatus();
  dashboardProcess = spawnManaged('dashboard', 'npm', ['run', 'dashboard']);
  appendLog('app', 'info', 'Dashboard process started');
  dashboardProcess.on('close', code => {
    appendLog('dashboard', code === 0 ? 'info' : 'error', `dashboard exited with code ${code}`);
    dashboardProcess = null;
    notifyStatus();
  });
  notifyStatus();
  return getStatus();
});

ipcMain.handle('dashboard:stop', () => {
  if (dashboardProcess) dashboardProcess.kill('SIGTERM');
  return getStatus();
});

ipcMain.handle('dashboard:open', async () => {
  await shell.openExternal(getStatus().dashboardUrl);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (botProcess) botProcess.kill('SIGTERM');
  if (dashboardProcess) dashboardProcess.kill('SIGTERM');
});
