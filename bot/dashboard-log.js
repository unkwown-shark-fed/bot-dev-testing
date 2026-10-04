function createDashboardLogger({ dashboardUrl, dashboardPassword, logger }) {
  return async function logCommandUse({ command, user, guild, channel, args = '', error = null }) {
    if (!dashboardPassword) return;

    try {
      const response = await fetch(`${dashboardUrl}/api/log`, {
        method:  'POST',
        signal: AbortSignal.timeout(3000),
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${dashboardPassword}`,
        },
        body: JSON.stringify({ command, user, guild, channel, args, error }),
      });

      if (!response.ok) {
        logger.warn(`Dashboard log request failed with status ${response.status}`);
      }
    } catch (err) {
      logger.warn(`Dashboard log request failed: ${err.message}`);
    }
  };
}

module.exports = {
  createDashboardLogger,
};
