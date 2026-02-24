// Complete Premium Dashboard JavaScript
let token = localStorage.getItem('dashboardToken');
let ws = null;

if (token) checkAuth();

// === LOGIN ===
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) {
      token = data.token;
      localStorage.setItem('dashboardToken', token);
      showDashboard();
    } else {
      document.getElementById('loginError').textContent = 'Invalid password';
      document.getElementById('loginError').classList.add('show');
    }
  } catch (err) {
    document.getElementById('loginError').textContent = 'Login failed';
    document.getElementById('loginError').classList.add('show');
  }
});

async function checkAuth() {
  try {
    const res = await fetch('/api/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) showDashboard();
    else logout();
  } catch {
    logout();
  }
}

function showDashboard() {
  document.getElementById('loginContainer').style.display = 'none';
  document.getElementById('dashboard').classList.add('active');
  connectWebSocket();
  updateStatus();
  updateStats();
  setInterval(updateStatus, 5000);
}

function logout() {
  localStorage.removeItem('dashboardToken');
  location.reload();
}

// === WEBSOCKET ===
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'log') addLogLine(msg.data);
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

// === STATUS ===
async function updateStatus() {
  try {
    const res = await fetch('/api/status', { headers: { 'Authorization': `Bearer ${token}` }});
    const data = await res.json();
    const badge = document.getElementById('botStatus');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const restartBtn = document.getElementById('restartBtn');
    
    if (data.status === 'running') {
      badge.textContent = '● Online';
      badge.className = 'status-badge online';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      restartBtn.disabled = false;
    } else {
      badge.textContent = '● Offline';
      badge.className = 'status-badge offline';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      restartBtn.disabled = true;
    }
    document.getElementById('statsUptime').textContent = formatUptime(data.uptime);
  } catch (err) {
    console.error(err);
  }
}

async function updateStats() {
  try {
    const res = await fetch('/api/stats', { headers: { 'Authorization': `Bearer ${token}` }});
    const data = await res.json();
    document.getElementById('statsCommands').textContent = data.commands;
    document.getElementById('statsGuilds').textContent = data.guilds;
    document.getElementById('statsVersion').textContent = data.version;
  } catch (err) {
    console.error(err);
  }
}

// === BOT CONTROL ===
async function startBot() {
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    alert(data.message || 'Bot started');
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function stopBot() {
  try {
    const res = await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    alert(data.message || 'Bot stopped');
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function restartBot() {
  await stopBot();
  setTimeout(startBot, 2000);
}

// === COMMAND MANAGER ===
async function loadCommands() {
  try {
    const res = await fetch('/api/commands', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    const container = document.getElementById('commandsList');
    container.innerHTML = '';
    
    if (data.commands.length === 0) {
      container.innerHTML = '<p>No commands found</p>';
      return;
    }
    
    data.commands.forEach(cmd => {
      const item = document.createElement('div');
      item.className = 'command-item';
      item.innerHTML = `
        <div class="command-info">
          <h4>/${cmd.name}</h4>
          <p>Modified: ${new Date(cmd.modified).toLocaleString()}</p>
        </div>
        <div class="command-actions">
          <button class="btn btn-primary btn-sm" onclick="editCommand('${cmd.name}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCommand('${cmd.name}')">Delete</button>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    alert('Failed to load commands: ' + err.message);
  }
}

async function editCommand(name) {
  try {
    const res = await fetch(`/api/commands/${name}/content`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    
    // Switch to builder page with content
    const navItem = document.querySelector('[data-page="builder"]');
    navItem.click();
    
    // Show code in output
    document.getElementById('generatedCode').textContent = data.content;
    document.getElementById('codeOutput').style.display = 'block';
    window.generatedCommandCode = data.content;
    window.generatedCommandName = name;
    
    alert('Command loaded! You can edit and save it.');
  } catch (err) {
    alert('Failed to load command: ' + err.message);
  }
}

async function deleteCommand(name) {
  if (!confirm(`Delete command "${name}"? This cannot be undone!`)) return;
  
  try {
    const res = await fetch(`/api/commands/${name}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    
    if (data.success) {
      alert('✅ Command deleted! Run "npm run deploy" to update Discord.');
      loadCommands();
    } else {
      alert('❌ ' + data.error);
    }
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// === COMMAND BUILDER ===
function generateCommand() {
  const name = document.getElementById('cmdName').value.toLowerCase().trim();
  const desc = document.getElementById('cmdDesc').value.trim();
  const type = document.getElementById('cmdType').value;
  const response = document.getElementById('cmdResponse').value.trim();

  if (!name || !desc || !response) {
    alert('Fill all fields');
    return;
  }

  if (!/^[a-z0-9_-]+$/.test(name)) {
    alert('Invalid command name');
    return;
  }

  let code;
  if (type === 'text') {
    code = `const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('${name}')
    .setDescription('${desc}'),
  async execute(interaction) {
    await interaction.reply('${response.replace(/'/g, "\\'")}');
  }
};`;
  } else {
    code = `const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('${name}')
    .setDescription('${desc}'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('${name.charAt(0).toUpperCase() + name.slice(1)}')
      .setDescription('${response.replace(/'/g, "\\'")}')
      .setColor(0x5865F2);
    await interaction.reply({ embeds: [embed] });
  }
};`;
  }

  document.getElementById('generatedCode').textContent = code;
  document.getElementById('codeOutput').style.display = 'block';
  window.generatedCommandCode = code;
  window.generatedCommandName = name;
}

function copyCode() {
  navigator.clipboard.writeText(document.getElementById('generatedCode').textContent);
  alert('Copied!');
}

async function saveCommand() {
  if (!window.generatedCommandCode) {
    alert('Generate command first');
    return;
  }
  try {
    const res = await fetch('/api/save-command', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: window.generatedCommandName,
        code: window.generatedCommandCode
      })
    });
    const data = await res.json();
    alert(data.success ? '✅ Saved! Run "npm run deploy"' : '❌ ' + data.error);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

// === BUTTON CREATOR ===
function updateButtonPreview() {
  const label = document.getElementById('btnLabel').value || 'Button';
  const style = document.getElementById('btnStyle').value;
  const preview = document.getElementById('buttonPreview');
  
  const urlGroup = document.getElementById('urlGroup');
  urlGroup.style.display = style === 'Link' ? 'block' : 'none';
  
  preview.innerHTML = `<button class="discord-btn-${style}">${label}</button>`;
}

function generateButtonCode() {
  const label = document.getElementById('btnLabel').value || 'Button';
  const style = document.getElementById('btnStyle').value;
  const customId = document.getElementById('btnId').value || 'button_id';
  const url = document.getElementById('btnUrl').value;
  
  let code;
  if (style === 'Link') {
    code = `new ButtonBuilder()
  .setLabel('${label}')
  .setStyle(ButtonStyle.Link)
  .setURL('${url || 'https://example.com'}')`;
  } else {
    code = `new ButtonBuilder()
  .setCustomId('${customId}')
  .setLabel('${label}')
  .setStyle(ButtonStyle.${style})`;
  }
  
  document.getElementById('buttonCode').textContent = code;
  document.getElementById('buttonCodeOutput').style.display = 'block';
}

function copyButtonCode() {
  navigator.clipboard.writeText(document.getElementById('buttonCode').textContent);
  alert('Button code copied!');
}

// === MODAL DESIGNER ===
function addModalField() {
  const container = document.getElementById('modalFields');
  const field = document.createElement('div');
  field.className = 'modal-field';
  field.innerHTML = `
    <input type="text" class="form-control mb-10" placeholder="Field Label" data-field="label">
    <select class="form-control" data-field="style">
      <option value="Short">Short Text</option>
      <option value="Paragraph">Paragraph</option>
    </select>
  `;
  container.appendChild(field);
}

function generateModalCode() {
  const title = document.getElementById('modalTitle').value || 'Modal';
  const modalId = document.getElementById('modalId').value || 'modal_id';
  const fields = Array.from(document.querySelectorAll('.modal-field'));
  
  let fieldsCode = '';
  fields.forEach((field, i) => {
    const label = field.querySelector('[data-field="label"]').value || `Field ${i+1}`;
    const style = field.querySelector('[data-field="style"]').value;
    fieldsCode += `    new TextInputBuilder()
      .setCustomId('field_${i}')
      .setLabel('${label}')
      .setStyle(TextInputStyle.${style})
      .setRequired(true),
`;
  });
  
  const code = `const modal = new ModalBuilder()
  .setCustomId('${modalId}')
  .setTitle('${title}')
  .addComponents(
${fieldsCode.trim()}
  );

await interaction.showModal(modal);`;
  
  document.getElementById('modalCode').textContent = code;
  document.getElementById('modalCodeOutput').style.display = 'block';
}

function copyModalCode() {
  navigator.clipboard.writeText(document.getElementById('modalCode').textContent);
  alert('Modal code copied!');
}

// === EMBED BUILDER ===
function updateEmbedPreview() {
  const title = document.getElementById('embedTitle').value;
  const desc = document.getElementById('embedDesc').value;
  const color = document.getElementById('embedColor').value;
  const footer = document.getElementById('embedFooter').value;
  
  document.getElementById('embedColorHex').value = color;
  
  const preview = document.getElementById('embedPreview');
  preview.style.borderLeftColor = color;
  preview.innerHTML = `
    ${title ? `<div class="discord-embed-title">${title}</div>` : ''}
    ${desc ? `<div class="discord-embed-desc">${desc}</div>` : ''}
    ${footer ? `<div class="discord-embed-footer">${footer}</div>` : ''}
  `;
}

function generateEmbedCode() {
  const title = document.getElementById('embedTitle').value;
  const desc = document.getElementById('embedDesc').value;
  const color = document.getElementById('embedColor').value;
  const footer = document.getElementById('embedFooter').value;
  
  const hexColor = color.replace('#', '0x');
  
  let code = `const embed = new EmbedBuilder()`;
  if (title) code += `\n  .setTitle('${title}')`;
  if (desc) code += `\n  .setDescription('${desc}')`;
  code += `\n  .setColor(${hexColor})`;
  if (footer) code += `\n  .setFooter({ text: '${footer}' })`;
  code += `;`;
  
  document.getElementById('embedCode').textContent = code;
  document.getElementById('embedCodeOutput').style.display = 'block';
}

function copyEmbedCode() {
  navigator.clipboard.writeText(document.getElementById('embedCode').textContent);
  alert('Embed code copied!');
}

// === TEMPLATES ===
const templates = {
  welcome: {
    name: 'welcome',
    desc: 'Welcome new members',
    type: 'embed',
    response: 'Welcome to the server! Please read the rules and have fun!'
  },
  rules: {
    name: 'rules',
    desc: 'Display server rules',
    type: 'embed',
    response: '1. Be respectful\n2. No spam\n3. Follow Discord ToS\n4. Have fun!'
  },
  help: {
    name: 'help',
    desc: 'Show available commands',
    type: 'embed',
    response: 'Available commands:\n/help - Show this message\n/info - Bot information'
  },
  info: {
    name: 'info',
    desc: 'Bot information',
    type: 'embed',
    response: 'This is a custom Discord bot with 17+ commands!'
  },
  poll: {
    name: 'poll',
    desc: 'Create a poll',
    type: 'text',
    response: 'React with 👍 or 👎 to vote!'
  },
  announcement: {
    name: 'announce',
    desc: 'Send announcement',
    type: 'embed',
    response: 'Important announcement here!'
  }
};

function useTemplate(templateName) {
  const template = templates[templateName];
  if (!template) return;
  
  // Switch to builder
  const navItem = document.querySelector('[data-page="builder"]');
  navItem.click();
  
  // Fill fields
  document.getElementById('cmdName').value = template.name;
  document.getElementById('cmdDesc').value = template.desc;
  document.getElementById('cmdType').value = template.type;
  document.getElementById('cmdResponse').value = template.response;
  
  alert(`Template loaded! Customize and generate your command.`);
}

// === LOGS ===
function addLogLine(log) {
  const container = document.getElementById('logsContainer');
  const line = document.createElement('div');
  line.className = 'log-line ' + log.type;
  const time = new Date(log.timestamp).toLocaleTimeString();
  line.textContent = `[${time}] ${log.message}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
  
  if (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }
}

function clearLogs() {
  document.getElementById('logsContainer').innerHTML = '<div class="log-line info">[INFO] Logs cleared</div>';
}

// === NAVIGATION ===
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('page-' + page).classList.add('active');
    
    const titles = {
      overview: 'Dashboard Overview',
      control: 'Bot Control',
      commands: 'Command Manager',
      builder: 'Command Builder',
      buttons: 'Button Creator',
      modals: 'Modal Designer',
      embeds: 'Embed Builder',
      templates: 'Templates',
      logs: 'Live Logs'
    };
    
    document.getElementById('pageTitle').textContent = titles[page];
    
    // Auto-load commands list when visiting commands page
    if (page === 'commands') {
      loadCommands();
    }
  });
});

// === HELPERS ===
function formatUptime(seconds) {
  if (!seconds) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || !parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}
