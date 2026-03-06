const fs = require('fs');
const path = require('path');

function scanCommandFiles(commandsPath) {
  if (!fs.existsSync(commandsPath)) return [];
  return fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
}

function loadCommandModules({ commandsPath, clearCache = false, requireExecute = true } = {}) {
  const basePath = path.resolve(commandsPath || '.');
  const files = scanCommandFiles(basePath);
  const loaded = [];
  const skipped = [];

  for (const file of files) {
    const filePath = path.join(basePath, file);

    try {
      if (clearCache) {
        delete require.cache[require.resolve(filePath)];
      }

      const command = require(filePath);
      const hasData = Boolean(command?.data?.name && typeof command?.data?.toJSON === 'function');
      const hasExecute = typeof command?.execute === 'function';

      if (!hasData) {
        skipped.push({ file, reason: 'missing command.data.toJSON()/name' });
        continue;
      }

      if (requireExecute && !hasExecute) {
        skipped.push({ file, reason: 'missing execute(interaction)' });
        continue;
      }

      loaded.push({ file, filePath, command });
    } catch (error) {
      skipped.push({ file, reason: error.message });
    }
  }

  return { loaded, skipped };
}

module.exports = {
  loadCommandModules,
};
