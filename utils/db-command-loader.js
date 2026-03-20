const path = require('path');
const Module = require('module');

function compileDashboardCommand({ name, code }, basePath) {
  if (!name || typeof name !== 'string') {
    throw new Error('Dashboard command record is missing a valid name');
  }
  if (!code || typeof code !== 'string') {
    throw new Error('Dashboard command record is missing valid code');
  }

  const moduleFilename = path.join(basePath, `${name}.js`);
  const mod = new Module(moduleFilename);
  mod.filename = moduleFilename;
  mod.path = path.dirname(moduleFilename);
  mod.paths = Module._nodeModulePaths(mod.path);
  mod._compile(code, moduleFilename);

  return mod.exports;
}

function loadDashboardCommands(records, {
  basePath,
  requireExecute = true,
  filter = (record) => record?.source === 'dashboard' && Boolean(record?.code),
} = {}) {
  const loaded = [];
  const skipped = [];

  for (const record of records || []) {
    if (!filter(record)) continue;

    try {
      const command = compileDashboardCommand(record, basePath);
      const hasData = Boolean(command?.data?.name && typeof command?.data?.toJSON === 'function');
      const hasExecute = typeof command?.execute === 'function';

      if (!hasData) {
        skipped.push({ name: record.name, reason: 'missing command.data.toJSON()/name' });
        continue;
      }

      if (requireExecute && !hasExecute) {
        skipped.push({ name: record.name, reason: 'missing execute(interaction)' });
        continue;
      }

      loaded.push({ name: record.name, command });
    } catch (error) {
      skipped.push({ name: record.name, reason: error.message });
    }
  }

  return { loaded, skipped };
}

module.exports = {
  compileDashboardCommand,
  loadDashboardCommands,
};
