const crypto = require('crypto');

function createDashboardAuth({
  password,
  sessionTtlMs = 12 * 60 * 60 * 1000,
  maxLoginAttempts = 10,
  loginWindowMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  if (!password) throw new Error('createDashboardAuth requires password');

  const sessions = new Map();
  const loginAttempts = new Map();

  function clearExpiredSessions() {
    const current = now();
    for (const [token, expiresAt] of sessions.entries()) {
      if (expiresAt <= current) sessions.delete(token);
    }
  }

  function getRecentAttempts(ip) {
    const current = now();
    const attempts = (loginAttempts.get(ip) || []).filter(ts => current - ts < loginWindowMs);
    loginAttempts.set(ip, attempts);
    return attempts;
  }

  function isRateLimited(ip) {
    return getRecentAttempts(ip).length >= maxLoginAttempts;
  }

  function recordFailedAttempt(ip) {
    const attempts = getRecentAttempts(ip);
    attempts.push(now());
    loginAttempts.set(ip, attempts);
  }

  function createSession() {
    clearExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now() + sessionTtlMs);
    return token;
  }

  function createSessionToken() {
    return {
      token: createSession(),
      expiresInSeconds: Math.floor(sessionTtlMs / 1000),
    };
  }

  function login({ passwordAttempt, ip }) {
    if (isRateLimited(ip)) {
      return { ok: false, status: 429, error: 'Too many login attempts. Try again later.' };
    }

    if (passwordAttempt !== password) {
      recordFailedAttempt(ip);
      return { ok: false, status: 401, error: 'Invalid password' };
    }

    loginAttempts.delete(ip);
    return { ok: true, ...createSessionToken() };
  }

  function authenticateBearerToken(token) {
    clearExpiredSessions();
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= now()) {
      sessions.delete(token);
      return false;
    }

    sessions.set(token, now() + sessionTtlMs);
    return true;
  }

  function logout(token) {
    sessions.delete(token);
  }

  return {
    clearExpiredSessions,
    login,
    createSessionToken,
    authenticateBearerToken,
    logout,
  };
}

module.exports = {
  createDashboardAuth,
};
