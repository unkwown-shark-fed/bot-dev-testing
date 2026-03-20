const test = require('node:test');
const assert = require('node:assert/strict');

const { createDashboardAuth } = require('../utils/dashboard-auth');

test('dashboard auth issues session token and authenticates it', () => {
  let currentTime = 1_700_000_000_000;
  const auth = createDashboardAuth({
    password: 'secret',
    sessionTtlMs: 1000,
    maxLoginAttempts: 3,
    loginWindowMs: 5000,
    now: () => currentTime,
  });

  const result = auth.login({ passwordAttempt: 'secret', ip: '1.2.3.4' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.token, 'string');

  assert.equal(auth.authenticateBearerToken(result.token), true);
  currentTime += 1500;
  assert.equal(auth.authenticateBearerToken(result.token), false);
});

test('dashboard auth enforces rate limits and supports logout', () => {
  let currentTime = 1_700_000_000_000;
  const auth = createDashboardAuth({
    password: 'secret',
    sessionTtlMs: 60_000,
    maxLoginAttempts: 2,
    loginWindowMs: 60_000,
    now: () => currentTime,
  });

  const ip = '5.6.7.8';
  assert.equal(auth.login({ passwordAttempt: 'wrong', ip }).status, 401);
  assert.equal(auth.login({ passwordAttempt: 'wrong2', ip }).status, 401);
  assert.equal(auth.login({ passwordAttempt: 'secret', ip }).status, 429);

  currentTime += 61_000;
  const success = auth.login({ passwordAttempt: 'secret', ip });
  assert.equal(success.ok, true);
  assert.equal(auth.authenticateBearerToken(success.token), true);
  auth.logout(success.token);
  assert.equal(auth.authenticateBearerToken(success.token), false);
});
