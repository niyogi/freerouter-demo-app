'use strict';

// Offline smoke test: unit-level checks that run without binding a port
// (no listen needed). Verifies message validation, route wiring, and env
// config. Run: npm run smoke (or: node --test smoke.js)
// NOTE: a live boot (`npm start` + opening the chat in a browser) is the
// real end-to-end check — do that on your own machine.

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PROVIDER_BASE_URL = 'https://upstream.example';
process.env.PROVIDER_API_KEY = 'smoke-test-key';
process.env.MODEL = 'openrouter/free';

const app = require('./server');
const { cleanMessages, config } = app;

test('config reflects env (base URL, model, safe hostname)', () => {
  assert.equal(config.providerBaseUrl, 'https://upstream.example');
  assert.equal(config.providerHost, 'upstream.example');
  assert.equal(config.model, 'openrouter/free');
  assert.ok(!('providerApiKey' in config), 'key must never be exported');
});

test('cleanMessages accepts valid history', () => {
  const out = cleanMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('cleanMessages rejects bad bodies', () => {
  assert.equal(cleanMessages('not-an-array'), null);
  assert.equal(cleanMessages([]), null);
  assert.equal(cleanMessages([{ role: 'user' }]), null);
  assert.equal(cleanMessages([{ role: 'robot', content: 'x' }]), null);
  assert.equal(cleanMessages([{ role: 'user', content: 'x', extra: 1 }]).length, 1);
  assert.equal(cleanMessages(new Array(51).fill({ role: 'user', content: 'x' })), null);
});

test('cleanMessages truncates oversized content', () => {
  const out = cleanMessages([{ role: 'user', content: 'a'.repeat(9000) }]);
  assert.equal(out.length, 1);
  assert.ok(out[0].content.length <= 8100);
});

test('expected routes are wired', () => {
  const routes = [];
  for (const layer of app._router.stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      routes.push(`${methods} ${layer.route.path}`);
    }
  }
  assert.ok(routes.includes('GET /api/health'), `missing /api/health in ${routes}`);
  assert.ok(routes.includes('GET /api/config'), `missing /api/config in ${routes}`);
  assert.ok(routes.includes('POST /api/chat'), `missing /api/chat in ${routes}`);
});
