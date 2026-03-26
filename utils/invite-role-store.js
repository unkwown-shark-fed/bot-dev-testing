const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '.invite_role_links.json');

function readStoreFile() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoreFile(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function createInviteRoleStore() {
  const backing = readStoreFile();

  function persist() {
    writeStoreFile(backing);
  }

  return {
    get(code) {
      return backing[code] || null;
    },
    set(code, value) {
      backing[code] = value;
      persist();
    },
    delete(code) {
      if (backing[code]) {
        delete backing[code];
        persist();
      }
    },
    size() {
      return Object.keys(backing).length;
    },
  };
}

module.exports = {
  createInviteRoleStore,
};
