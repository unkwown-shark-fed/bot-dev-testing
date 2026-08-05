const Module = require('module');
const path = require('path');

function loadModuleFromString(code, { commandDir, filename = '_preview.js' } = {}) {
  const modulePath = commandDir || process.cwd();
  const m = new Module('');
  m.filename = path.join(modulePath, filename);
  m.paths = Module._nodeModulePaths(modulePath);
  m._compile(code, m.filename);
  return m.exports;
}

function buildInvalidCommandUploadResponse(code, cmdModule) {
  const exportKeys = cmdModule && typeof cmdModule === 'object' ? Object.keys(cmdModule) : [];
  const hasModuleExports = /\bmodule\.exports\b|\bexports\./.test(code);
  const looksLikeBotEntrypoint = /\bnew\s+Client\s*\(|\bclient\.login\s*\(/.test(code);
  const example = [
    "module.exports = { data: new SlashCommandBuilder().setName('ping')",
    ".setDescription('...'), async execute(interaction) {",
    " await interaction.reply('pong'); } }",
  ].join('');

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
    example,
  };
}

module.exports = {
  buildInvalidCommandUploadResponse,
  loadModuleFromString,
};
