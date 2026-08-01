const fs = require('fs');

const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };

function buildPresence({ status, acttype, acttext }) {
  return {
    status: status || 'online',
    activities: acttext ? [{ name: acttext, type: ACTIVITY_TYPES[acttype] ?? 2 }] : [],
  };
}

function applyPresence(clientInstance, settings) {
  clientInstance.user.setPresence(buildPresence(settings));
}

function watchPresenceUpdates({ client, filePath, logger, intervalMs = 15_000, maxAgeMs = 60_000 }) {
  return setInterval(() => {
    try {
      if (!fs.existsSync(filePath)) return;

      const { status, acttype, acttext, ts } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof ts !== 'number' || Date.now() - ts > maxAgeMs) return;

      applyPresence(client, { status, acttype, acttext });
      logger.info(`[presence] Updated: ${status} / ${acttype} ${acttext}`);
      fs.unlinkSync(filePath);
    } catch (e) {
      logger.warn(`[presence] Failed to apply update: ${e.message}`);
    }
  }, intervalMs);
}

module.exports = {
  applyPresence,
  buildPresence,
  watchPresenceUpdates,
};
