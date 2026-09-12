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
const { cleanMessages, clientIp, buildUpstreamBody, describeAdsResult, describeKeytermsResult, config } = app;

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

test('ads are off by default: no ad_request sent', () => {
  assert.equal(config.companionAds, false);
  assert.equal(config.adsPlacement, 'chat-compare-pc-web');
  const body = buildUpstreamBody([{ role: 'user', content: 'hi' }], { ua: 'smoke-ua' });
  assert.equal(body.model, 'openrouter/free');
  assert.ok(!('ad_request' in body), 'ad_request must be absent when COMPANION_ADS is off');
});

test('COMPANION_ADS=true attaches the playground placement request', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    const body = server.buildUpstreamBody([{ role: 'user', content: 'hi' }], { ua: 'smoke-ua' });
    console.log(JSON.stringify({ config: server.config, ad_request: body.ad_request || null }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, COMPANION_ADS: 'true' },
    encoding: 'utf8',
  });
  const { config: adsConfig, ad_request } = JSON.parse(out);
  assert.equal(adsConfig.companionAds, true);
  assert.ok(ad_request, 'ad_request must be present when COMPANION_ADS is on');
  assert.equal(ad_request.placement, 'chat-compare-pc-web');
  assert.match(ad_request.session_id, /^sess_[0-9a-f]+$/);
  assert.equal(ad_request.ua, 'smoke-ua');
});

test('describeAdsResult names each outcome', () => {
  assert.equal(describeAdsResult({ choices: [] }), 'ads=off');
  assert.equal(describeAdsResult({ ads: [{ title: 'x' }] }), 'ads=off');
});

test('describeAdsResult with ads on distinguishes toggle-off silence', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    console.log(JSON.stringify([
      server.describeAdsResult({ choices: [] }),
      server.describeAdsResult({ ads: [{ title: 'x' }] }),
      server.describeAdsResult({ ads: [] }),
      server.describeAdsResult({ ads_error: { code: 'no_ad_network' } }),
    ]));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, COMPANION_ADS: 'true' },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), [
    'ads=not-attached(key-toggle-off?)',
    'ads=fill(1)',
    'ads=empty',
    'ads=no_ad_network',
  ]);
});

test('keyterms are off by default: no link_request sent', () => {
  assert.equal(config.monetizableKeyterms, false);
  assert.equal(config.keytermsMax, 3);
  const body = buildUpstreamBody([{ role: 'user', content: 'hi' }], { ua: 'smoke-ua' });
  assert.ok(!('link_request' in body), 'link_request must be absent when MONETIZABLE_KEYTERMS is off');
});

test('MONETIZABLE_KEYTERMS=true attaches a top-3 link request', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    const body = server.buildUpstreamBody([{ role: 'user', content: 'hi' }], { ua: 'smoke-ua' });
    console.log(JSON.stringify({ config: server.config, link_request: body.link_request || null }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, MONETIZABLE_KEYTERMS: 'true' },
    encoding: 'utf8',
  });
  const { config: ktConfig, link_request } = JSON.parse(out);
  assert.equal(ktConfig.monetizableKeyterms, true);
  assert.deepEqual(link_request, { max_keyterms: 3 });
});

test('describeKeytermsResult names each outcome', () => {
  assert.equal(describeKeytermsResult({ choices: [] }), 'keyterms=off');
  assert.equal(describeKeytermsResult({ keyterms: [{ keyterm: 'x' }] }), 'keyterms=off');
});

test('describeKeytermsResult with keyterms on distinguishes toggle-off silence', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    console.log(JSON.stringify([
      server.describeKeytermsResult({ choices: [] }),
      server.describeKeytermsResult({ keyterms: [{ keyterm: 'a' }, { keyterm: 'b' }] }),
      server.describeKeytermsResult({ keyterms: [] }),
      server.describeKeytermsResult({ keyterms_error: { code: 'extractor_error' } }),
    ]));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, MONETIZABLE_KEYTERMS: 'true' },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), [
    'keyterms=not-attached(key-toggle-off?)',
    'keyterms=linked(2)',
    'keyterms=empty',
    'keyterms=extractor_error',
  ]);
});

test('clientIp prefers the browser IP, never loopback/LAN', () => {
  assert.equal(clientIp({ ip: '203.0.113.7' }), '203.0.113.7');
  assert.equal(clientIp({ ip: '::ffff:203.0.113.7' }), '203.0.113.7');
  assert.equal(clientIp({ ip: '127.0.0.1' }), '');
  assert.equal(clientIp({ ip: '::1' }), '');
  assert.equal(clientIp({ ip: '192.168.1.10' }), '');
  assert.equal(clientIp({ ip: '10.0.0.5' }), '');
  assert.equal(clientIp({}), '');
  assert.equal(clientIp(null), '');
});

test('COMPANION_ADS=true forwards the client IP into ad_request', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    const withClient = server.buildUpstreamBody([{ role: 'user', content: 'hi' }], { ip: '203.0.113.7', ua: 'smoke-ua' });
    const fallback = server.buildUpstreamBody([{ role: 'user', content: 'hi' }], { ip: '', ua: 'smoke-ua' });
    console.log(JSON.stringify({ withClient: withClient.ad_request, fallbackIp: fallback.ad_request.ip }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, COMPANION_ADS: 'true' },
    encoding: 'utf8',
  });
  const { withClient, fallbackIp } = JSON.parse(out);
  assert.equal(withClient.ip, '203.0.113.7', 'browser IP must reach Gravity, not the server IP');
  assert.equal(typeof fallbackIp, 'string', 'local browsers fall back to the resolved public IP');
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
