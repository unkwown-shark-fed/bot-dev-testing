const envKeys = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_IDS',
  'MONGODB_URI',
  'DASHBOARD_PASSWORD',
  'WEB_DASHBOARD_PORT',
  'COMMAND_ROLE_ID',
  'BOT_OWNER_ID',
];

const logs = document.getElementById('logs');

function valuesFromForm() {
  return envKeys.reduce((acc, key) => {
    acc[key] = document.getElementById(key).value.trim();
    return acc;
  }, {});
}

function fillForm(values) {
  envKeys.forEach(key => {
    document.getElementById(key).value = values[key] || '';
  });
}

function renderStatus(status) {
  document.getElementById('botStatus').textContent = status.bot;
  document.getElementById('dashboardStatus').textContent = status.dashboard;
}

function addLog(entry) {
  const line = document.createElement('div');
  line.className = `log-${entry.type}`;
  line.textContent = `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.source}: ${entry.message}`;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

async function refresh() {
  fillForm(await window.botGui.loadEnv());
  renderStatus(await window.botGui.getStatus());
  (await window.botGui.listLogs()).forEach(addLog);
}

window.botGui.onLog(addLog);
window.botGui.onStatus(renderStatus);

document.getElementById('save').addEventListener('click', async () => {
  fillForm(await window.botGui.saveEnv(valuesFromForm()));
});
document.getElementById('install').addEventListener('click', () => window.botGui.installDependencies());
document.getElementById('deploy').addEventListener('click', () => window.botGui.deployCommands());
document.getElementById('startBot').addEventListener('click', () => window.botGui.startBot());
document.getElementById('stopBot').addEventListener('click', () => window.botGui.stopBot());
document.getElementById('startDashboard').addEventListener('click', () => window.botGui.startDashboard());
document.getElementById('stopDashboard').addEventListener('click', () => window.botGui.stopDashboard());
document.getElementById('openDashboard').addEventListener('click', () => window.botGui.openDashboard());

refresh();
