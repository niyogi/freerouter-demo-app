'use strict';

// Offline smoke test: unit-level checks that run without binding a port
// (no listen needed). Verifies message/shape validation, upstream body
// building per shape, reply extraction, client SSE accumulation, route
// wiring, and env config. Run: npm run smoke (or: node --test smoke.js)
// NOTE: a live boot (`npm start` + opening the chat in a browser) is the
// real end-to-end check — do that on your own machine.

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.PROVIDER_BASE_URL = 'https://upstream.example';
process.env.PROVIDER_API_KEY = 'smoke-test-key';
process.env.MODEL = 'openrouter/free';

const app = require('./server');
const { cleanMessages, clientIp, maskIp, envSource, describeEnv, buildUpstreamBody, describeAdsResult, describeKeytermsResult, config } = app;

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

test('spoofed forwarding headers are ignored without TRUST_PROXY', () => {
  const fakeReq = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } };
  assert.equal(clientIp(fakeReq), '', 'direct clients must not spoof via X-Forwarded-For');
});

test('TRUST_PROXY reads the client from X-Forwarded-For', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const server = require('./server.js');
    console.log(JSON.stringify({
      direct: server.clientIp({ ip: '127.0.0.1', headers: {} }),
      forwarded: server.clientIp({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }),
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, TRUST_PROXY: 'true' },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { direct: '', forwarded: '203.0.113.9' });
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

test('maskIp hides the last octet, never the shape', () => {
  assert.equal(maskIp('203.0.113.7'), '203.0.113.xxx');
  assert.equal(maskIp(''), 'none');
  assert.equal(maskIp(null), 'none');
  assert.equal(maskIp('not-an-ip'), 'invalid');
  assert.match(maskIp('2001:db8:abcd:0012::1'), /^2001:db8:abcd:/);
});

test('envSource names where each var came from', () => {
  assert.equal(envSource('PROVIDER_BASE_URL'), 'environment');
  assert.equal(envSource('DEFINITELY_NOT_SET_VAR_XYZ'), 'default');
});

test('describeEnv lists every var without leaking the key', () => {
  const lines = describeEnv();
  assert.equal(lines.length, 7);
  assert.ok(lines.every((l) => /^(  )[A-Z_]+=.* \((environment|demo \.env|root \.env|default)\)$/.test(l)));
  const keyLine = lines.find((l) => l.includes('PROVIDER_API_KEY'));
  assert.match(keyLine, /<set:\d+ chars>/);
  assert.ok(!lines.join('\n').includes('smoke-test-key'), 'secret value must never render');
});

test('trust proxy stays off unless TRUST_PROXY=true', () => {
  assert.equal(app.get('trust proxy'), false);
  const { execFileSync } = require('node:child_process');
  const script = `console.log(JSON.stringify(require('./server.js').get('trust proxy')));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, TRUST_PROXY: 'true' },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(out), 1);
});

// The markdown renderer is pure string code inside the browser bundle —
// load just those functions into a vm context (same trick as
// app/tests/keys-view.test.js) so render regressions pin here.
function loadMarkdownRenderer() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'public', 'app.js'), 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp(`function ${name}[\\s\\S]*?^}`, 'm'));
    assert.ok(m, `function ${name} must exist in public/app.js`);
    return m[0];
  };
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${pick('escapeHtml')}\n${pick('renderInline')}\n${pick('renderMarkdown')}`, ctx);
  return ctx;
}

test('markdown renderer closes headings exactly once', () => {
  const { renderMarkdown } = loadMarkdownRenderer();
  assert.equal(renderMarkdown('## Header here'), '<h4>Header here</h4>');
});

function loadAssistantRenderer(withMarkdownIt) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'public', 'app.js'), 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp(`function ${name}[\\s\\S]*?^}`, 'm'));
    assert.ok(m, `function ${name} must exist in public/app.js`);
    return m[0];
  };
  const sandbox = {};
  if (withMarkdownIt) sandbox.window = { markdownit: require('markdown-it') };
  vm.createContext(sandbox);
  vm.runInContext(
    `${pick('escapeHtml')}\n${pick('renderInline')}\n${pick('renderMarkdown')}\nlet mdIt = null;\n${pick('getMarkdown')}\n${pick('renderAssistant')}`,
    sandbox,
  );
  return sandbox;
}

test('assistant replies render through markdown-it when bundled', () => {
  const { renderAssistant } = loadAssistantRenderer(true);
  assert.match(renderAssistant('# Hello'), /<h1>Hello<\/h1>/);
  assert.match(renderAssistant('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/);
  const link = renderAssistant('[guide](https://example.com/x)');
  assert.ok(link.includes('target="_blank"') && link.includes('rel="noopener"'), 'outbound links open safely');
  const evil = renderAssistant('[x](javascript:alert(1))');
  assert.ok(!evil.includes('<a'), 'javascript: links must not become anchors');
  const raw = renderAssistant('<script>alert(1)</script>');
  assert.ok(!raw.includes('<script>') && raw.includes('&lt;script&gt;'), 'raw HTML must stay escaped');
});

test('assistant replies fall back to the built-in renderer without the bundle', () => {
  const { renderAssistant } = loadAssistantRenderer(false);
  assert.equal(renderAssistant('**x**'), '<p><strong>x</strong></p>');
});

test('markdown-it vendor bundle is pinned and served', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dist = path.join(__dirname, 'node_modules', 'markdown-it', 'dist', 'browser', 'markdown-it.umd.min.js');
  assert.ok(fs.existsSync(dist), 'npm install must provide the vendored browser bundle');
  const pinned = require('./package.json').dependencies['markdown-it'];
  const installed = require('markdown-it/package.json').version;
  assert.ok(pinned, 'markdown-it must be a declared dependency');
  assert.ok(installed.startsWith(pinned.replace(/^\^/, '').split('.')[0] + '.'), `installed ${installed} must match pinned ${pinned}`);
});

test('markdown renderer builds ordered lists', () => {
  const { renderMarkdown } = loadMarkdownRenderer();
  const html = renderMarkdown('1. **Wilson Clash 108** - control.\n2. Head Ti.S6 - light.');
  assert.match(html, /^<ol>.*<\/ol>$/);
  assert.ok(html.includes('<li><strong>Wilson Clash 108</strong> - control.</li>'));
  assert.ok(!html.includes('<br />'), 'list items must not collapse into a paragraph');
});

test('cleanShape defaults to chat, accepts responses', () => {
  const { cleanShape, upstreamPathFor } = app;
  assert.equal(cleanShape(undefined), 'chat');
  assert.equal(cleanShape(''), 'chat');
  assert.equal(cleanShape('chat'), 'chat');
  assert.equal(cleanShape('responses'), 'responses');
  assert.equal(cleanShape('RESPONSES'), 'responses');
  assert.equal(cleanShape('anthropic'), 'chat');
  assert.equal(upstreamPathFor('chat'), '/v1/chat/completions');
  assert.equal(upstreamPathFor('responses'), '/v1/responses');
});

test('buildUpstreamBody defaults to a chat body without stream', () => {
  const body = buildUpstreamBody([{ role: 'user', content: 'hi' }], { ua: 'smoke-ua' });
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(!('input' in body), 'responses input must be absent on chat');
  assert.ok(!('stream' in body), 'stream must be absent unless requested');
});

test('buildUpstreamBody builds a responses body with input + stream', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const chatStream = buildUpstreamBody(msgs, { ua: 'smoke-ua', shape: 'chat', stream: true });
  assert.deepEqual(chatStream.messages, msgs);
  assert.equal(chatStream.stream, true);
  const body = buildUpstreamBody(msgs, { ua: 'smoke-ua', shape: 'responses', stream: true });
  assert.deepEqual(body.input, msgs);
  assert.ok(!('messages' in body), 'chat messages must be absent on responses');
  assert.equal(body.stream, true);
});

test('extractReply reads both shapes', () => {
  const { extractReply, extractChatReply, extractResponsesReply } = app;
  assert.equal(extractChatReply({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  assert.equal(extractChatReply({}), '');
  assert.equal(extractResponsesReply({ output_text: 'yo' }), 'yo');
  assert.equal(
    extractResponsesReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] }),
    'ab',
  );
  assert.equal(extractResponsesReply({}), '');
  assert.equal(extractReply({ output_text: 'r' }, 'responses'), 'r');
  assert.equal(extractReply({ choices: [{ message: { content: 'c' } }] }, undefined), 'c');
});

// The streaming accumulator is pure client code inside the browser bundle —
// load it into a vm context (same trick as the markdown renderer) so SSE
// regressions pin here.
function loadStreamState() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'public', 'app.js'), 'utf8');
  const m = src.match(/function createStreamState[\s\S]*?^}/m);
  assert.ok(m, 'function createStreamState must exist in public/app.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[0], ctx);
  return ctx;
}

test('stream state accumulates chat SSE deltas and terminal extras', () => {
  const { createStreamState } = loadStreamState();
  const { state, handleRecord } = createStreamState('chat');
  handleRecord('data: {"choices":[{"delta":{"role":"assistant"}}]}');
  handleRecord('data: {"choices":[{"delta":{"content":"Hello"}}]}');
  handleRecord('data: {"choices":[{"delta":{"content":" there"}}]}');
  assert.equal(state.text, 'Hello there');
  assert.equal(state.done, false);
  handleRecord('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
  handleRecord('data: {"ads": [], "keyterms": []}');
  handleRecord('data: [DONE]');
  assert.equal(state.done, true);
  // Length checks, not deepEqual: arrays built inside the vm context live
  // in another realm, so strict deepEqual rejects them (same-structure,
  // not reference-equal).
  assert.equal(state.ads.length, 0);
  assert.equal(state.keyterms.length, 0);
});

test('stream state ignores keep-alives and garbage lines', () => {
  const { createStreamState } = loadStreamState();
  const { state, handleRecord } = createStreamState('chat');
  handleRecord(': keep-alive');
  handleRecord('data: not-json');
  handleRecord('event: ping\ndata: {"choices":[{"delta":{"content":"x"}}]}');
  assert.equal(state.text, 'x');
  assert.equal(state.done, false);
});

test('stream state accumulates responses SSE deltas and terminal extras', () => {
  const { createStreamState } = loadStreamState();
  const { state, handleRecord } = createStreamState('responses');
  handleRecord('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}');
  handleRecord('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}');
  assert.equal(state.text, 'Hello');
  assert.equal(state.done, false);
  handleRecord('event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"Hello","ads":[{"title":"a"}],"keyterms":[]}}');
  assert.equal(state.text, 'Hello');
  assert.equal(state.done, true);
  assert.equal(state.ads.length, 1);
  assert.equal(state.keyterms.length, 0);
});

test('stream state fills responses text from the terminal when no deltas arrived', () => {
  const { createStreamState } = loadStreamState();
  const { state, handleRecord } = createStreamState('responses');
  handleRecord('event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"full"}]}]}}');
  assert.equal(state.text, 'full');
  assert.equal(state.done, true);
});

test('controls offer a shape choice and a streaming toggle', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('name="shape"'), 'shape radios must exist');
  assert.ok(html.includes('value="responses"'), 'responses option must exist');
  assert.ok(html.includes('id="stream"'), 'stream toggle must exist');
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
