const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadCommandModules } = require('../utils/command-loader');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-loader-'));
}

test('loadCommandModules loads valid commands and skips invalid ones', () => {
  const dir = makeTempDir();

  fs.writeFileSync(path.join(dir, 'valid.js'), `
    module.exports = {
      data: { name: 'ok', toJSON: () => ({ name: 'ok', description: 'desc' }) },
      execute: async () => {}
    };
  `);

  fs.writeFileSync(path.join(dir, 'invalid.js'), `module.exports = { data: { name: 'bad' } };`);

  const { loaded, skipped } = loadCommandModules({ commandsPath: dir, requireExecute: true });

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].command.data.name, 'ok');
  assert.equal(skipped.length, 1);
});
