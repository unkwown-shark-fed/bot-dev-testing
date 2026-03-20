const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadDashboardCommands } = require('../utils/db-command-loader');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'db-cmd-loader-'));
}

test('loadDashboardCommands compiles valid dashboard commands', () => {
  const records = [
    {
      name: 'hello',
      source: 'dashboard',
      code: `
        module.exports = {
          data: { name: 'hello', toJSON: () => ({ name: 'hello', description: 'desc' }) },
          execute: async () => {}
        };
      `,
    },
    {
      name: 'bad',
      source: 'dashboard',
      code: 'module.exports = {}',
    },
  ];

  const { loaded, skipped } = loadDashboardCommands(records, { basePath: makeTempDir(), requireExecute: true });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].command.data.name, 'hello');
  assert.equal(skipped.length, 1);
});
