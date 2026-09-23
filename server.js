'use strict';

/**
 * FreeRouter chatbot demo — tiny Express server.
 *
 * The browser talks only to this server (same origin). The server attaches
 * the provider API key and forwards to {PROVIDER_BASE_URL}/v1/chat/completions
 * or {PROVIDER_BASE_URL}/v1/responses, depending on the `shape` the browser
 * sends (`chat` by default). Either shape can stream (`stream: true`), in
 * which case the upstream SSE bytes are relayed straight through.
 * The key never leaves the server, so it never appears in client-side JS.
 *
 * Swap providers with env vars only (see .env.example): set
 * PROVIDER_BASE_URL + PROVIDER_API_KEY (+ MODEL) and restart. No code change.
 * (Chat Completions works on any OpenAI-compatible provider; Responses needs
 * an endpoint that serves POST /v1/responses — FreeRouter does.)
 */

const path = require('path');
const crypto = require('crypto');
// Env precedence: real environment > demo-github-app/.env > repo-root
// .env (shared defaults). dotenv never overrides an already-set var, so
// the demo dir loads first and the root only fills gaps. Missing files
// are silently ignored. presetKeys is snapshotted first so the startup
// env report can say where each value came from.
const presetKeys = new Set(Object.keys(process.env));
const demoEnv = require('dotenv').config({ path: path.join(__dirname, '.env') });
const rootEnv = require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const demoEnvKeys = new Set(Object.keys((demoEnv && demoEnv.parsed) || {}));
const rootEnvKeys = new Set(Object.keys((rootEnv && rootEnv.parsed) || {}));
function envSource(name) {
  if (presetKeys.has(name)) return 'environment';
  if (demoEnvKeys.has(name)) return 'demo .env';
  if (rootEnvKeys.has(name)) return 'root .env';
  return 'default';
}
const express = require('express');
const requestIp = require('request-ip');

const PORT = Number(process.env.PORT || 3000);
const PROVIDER_BASE_URL = String(process.env.PROVIDER_BASE_URL || 'https://api.freerouter.com').replace(/\/+$/, '');
const PROVIDER_API_KEY = String(process.env.PROVIDER_API_KEY || '');
const MODEL = String(process.env.MODEL || 'openrouter/free');
const COMPANION_ADS = String(process.env.COMPANION_ADS || 'false').toLowerCase() === 'true';
// Monetizable Keyterms (FreeRouter only): when true, each reply may carry
// scored linkable entities, hyperlinked client-side post-render.
const MONETIZABLE_KEYTERMS = String(process.env.MONETIZABLE_KEYTERMS || 'false').toLowerCase() === 'true';
// How many top candidates to ask for (and to link). The proxy returns them
// sorted best-first, so the client links at most this many spans.
const KEYTERMS_MAX = 3;
// Behind a reverse proxy you control (Render, nginx, …), req.ip is the
// proxy — set TRUST_PROXY=true so Express reads the client from
// X-Forwarded-For instead. Leave false for direct use: trusting the header
// otherwise lets any client spoof its IP and poison ad geo/fraud checks.
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';

// Same registered slot the FreeRouter playground previews with, so a key
// with Companion Ads on returns fills here too.
const ADS_PLACEMENT = 'chat-compare-pc-web';

// End-user public IP for ad_request (Gravity requires it). Resolved once,
// best-effort: a failed lookup just means ads_error while chat keeps working.
let publicIp = '';
async function resolvePublicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data && typeof data.ip === 'string') publicIp = data.ip;
  } catch {
    publicIp = '';
  }
}
if (COMPANION_ADS) resolvePublicIp();

function buildAdRequest({ ip, ua }) {
  if (!COMPANION_ADS) return null;
  return {
    placement: ADS_PLACEMENT,
    session_id: `sess_${crypto.randomBytes(8).toString('hex')}`,
    ip: String(ip || publicIp || ''),
    ua: String(ua || ''),
  };
}

function buildLinkRequest() {
  if (!MONETIZABLE_KEYTERMS) return null;
  return { max_keyterms: KEYTERMS_MAX };
}

// Request shape the browser asked for. Anything that is not exactly
// `responses` falls back to `chat`, so old clients that send no shape keep
// working against /v1/chat/completions.
function cleanShape(input) {
  return String(input || '').toLowerCase() === 'responses' ? 'responses' : 'chat';
}

function upstreamPathFor(shape) {
  return shape === 'responses' ? '/v1/responses' : '/v1/chat/completions';
}

function buildUpstreamBody(messages, { ip, ua, shape, stream } = {}) {
  // Responses takes the same [{ role, content }] turns as its `input` — the
  // proxy converts them to chat messages exactly when translating.
  const body = cleanShape(shape) === 'responses'
    ? { model: MODEL, input: messages }
    : { model: MODEL, messages };
  if (stream === true) body.stream = true;
  const adRequest = buildAdRequest({ ip, ua });
  if (adRequest) body.ad_request = adRequest;
  const linkRequest = buildLinkRequest();
  if (linkRequest) body.link_request = linkRequest;
  return body;
}

// Buffered reply extraction per shape. Chat answers in
// choices[0].message.content; Responses answers in `output_text` (with the
// output items as fallback).
function extractChatReply(data) {
  return data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '')
    : '';
}

function extractResponsesReply(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  let text = '';
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!item || typeof item !== 'object' || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part && typeof part === 'object' && part.type === 'output_text') text += String(part.text || '');
    }
  }
  return text;
}

function extractReply(data, shape) {
  return cleanShape(shape) === 'responses' ? extractResponsesReply(data) : extractChatReply(data);
}

// End-user IP for ad_request (Gravity requires a public client IP for
// geo + fraud checks — a server/datacenter IP looks like a bot and
// no-fills). Express is left without `trust proxy` on purpose: this demo
// is opened directly, so req.ip is the real browser address and a client
// can't spoof it via X-Forwarded-For. Loopback and LAN addresses (local
// testing) fall back to the server's resolved public IP — same egress the
// browser uses — instead of sending 127.0.0.1, which Gravity drops.
// Last-octet-masked IP for console logs: enough to compare against the
// browser's public IP when debugging wrong-IP reports, not enough to PII.
function maskIp(ip) {
  const s = String(ip || '');
  if (!s) return 'none';
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}:…`;
  const parts = s.split('.');
  if (parts.length !== 4) return 'invalid';
  return `${parts.slice(0, 3).join('.')}.xxx`;
}

function clientIp(req) {
  // With TRUST_PROXY, request-ip reads the client from X-Forwarded-For /
  // CF-Connecting-IP / True-Client-IP (leftmost = original client);
  // without it, only the TCP source is used so a direct client can't
  // spoof its IP via headers.
  let raw = '';
  try {
    raw = TRUST_PROXY && req
      ? String(requestIp.getClientIp(req) || '')
      : String((req && (req.ip || (req.socket && req.socket.remoteAddress))) || '');
  } catch {
    raw = '';
  }
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (!ip) return '';
  if (ip === '127.0.0.1' || ip === '::1') return '';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc00:|fe80:)/i.test(ip)) return '';
  return ip;
}

// One-word ads outcome for the console. Note the last case: when we asked
// for ads but the proxy attached neither `ads` nor `ads_error`, the key's
// Companion Ads toggle is off — the proxy ignores ad_request entirely.
function describeAdsResult(data) {
  if (!COMPANION_ADS) return 'ads=off';
  if (data && Array.isArray(data.ads)) {
    return data.ads.length > 0 ? `ads=fill(${data.ads.length})` : 'ads=empty';
  }
  if (data && data.ads_error) return `ads=${data.ads_error.code || 'error'}`;
  return 'ads=not-attached(key-toggle-off?)';
}

// One-word keyterms outcome for the console. Same idea as ads: when we
// asked but the proxy attached neither field, the key toggle is off.
function describeKeytermsResult(data) {
  if (!MONETIZABLE_KEYTERMS) return 'keyterms=off';
  if (data && Array.isArray(data.keyterms)) {
    return data.keyterms.length > 0 ? `keyterms=linked(${data.keyterms.length})` : 'keyterms=empty';
  }
  if (data && data.keyterms_error) return `keyterms=${data.keyterms_error.code || 'error'}`;
  return 'keyterms=not-attached(key-toggle-off?)';
}

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Vendor the markdown-it browser bundle from our own dependency (no CDN)
// so the chat renderer works offline and stays version-pinned.
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'markdown-it', 'dist', 'browser')));

function providerHost() {
  try {
    return new URL(PROVIDER_BASE_URL).hostname;
  } catch {
    return PROVIDER_BASE_URL;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Safe for the browser: hostname + model + feature flags only. Never the key.
app.get('/api/config', (req, res) => {
  res.json({ providerHost: providerHost(), model: MODEL, companionAds: COMPANION_ADS, monetizableKeyterms: MONETIZABLE_KEYTERMS });
});

function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') return null;
    const role = String(m.role || '');
    const content = String(m.content || '');
    if ((role !== 'user' && role !== 'assistant' && role !== 'system') || !content) return null;
    out.push({ role, content: content.slice(0, 8000) });
  }
  if (out.length === 0 || out.length > 50) return null;
  return out;
}

app.post('/api/chat', async (req, res) => {
  if (!PROVIDER_API_KEY) {
    return res.status(500).json({
      error: 'PROVIDER_API_KEY is not set. Copy .env.example to .env and add your key, then restart.',
    });
  }
  const messages = cleanMessages(req.body && req.body.messages);
  if (!messages) {
    return res.status(400).json({ error: 'Body must be { messages: [{ role, content }] }.' });
  }
  const shape = cleanShape(req.body && req.body.shape);
  const stream = Boolean(req.body && req.body.stream);
  const upstreamPath = upstreamPathFor(shape);

  // End-user context for ads: the browser IP + UA. buildAdRequest falls
  // back to the server's resolved public IP when the browser is local.
  // The log shows the masked address actually sent, so a wrong-IP report
  // can be checked against the browser's public IP without logging PII.
  const adIp = clientIp(req);
  const upstreamBody = buildUpstreamBody(messages, {
    ip: adIp,
    ua: req.get('User-Agent') || '',
    shape,
    stream,
  });
  const startedAt = Date.now();
  console.log(`[demo] chat(${shape}${stream ? '+stream' : ''}) → ${providerHost()} model=${MODEL} messages=${messages.length}${upstreamBody.ad_request ? ` ad_request(placement=${upstreamBody.ad_request.placement} ip=${adIp ? `client:${maskIp(adIp)}` : `fallback:${maskIp(publicIp)}`})` : ''}`);

  let upstream;
  try {
    upstream = await fetch(`${PROVIDER_BASE_URL}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PROVIDER_API_KEY}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach ${providerHost()}: ${err.message}` });
  }

  // Streaming: relay the upstream SSE bytes straight through. The browser
  // parses deltas per shape (chat `choices[0].delta.content`, responses
  // `response.output_text.delta`); ads/keyterms ride the terminal event on
  // both shapes, exactly as the buffered JSON carries them as siblings.
  if (stream) {
    if (!upstream.ok || !upstream.body) {
      let data = null;
      try {
        data = await upstream.json();
      } catch {
        data = null;
      }
      const message =
        (data && data.error && (data.error.message || data.error.code)) ||
        `Upstream error (HTTP ${upstream.status}).`;
      console.log(`[demo] ← ${upstream.status} in ${Date.now() - startedAt}ms error`);
      return res.status(upstream.status).json({ error: String(message).slice(0, 500) });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-demo-shape': shape,
    });
    try {
      for await (const chunk of upstream.body) {
        if (!res.write(Buffer.from(chunk))) await new Promise((r) => res.once('drain', r));
      }
    } catch {
      // Client went away mid-stream — nothing left to do.
    }
    // The terminal SSE event carries the ads/keyterms outcome to the
    // browser, so there is nothing to name here — just the elapsed time.
    console.log(`[demo] ← stream(${shape}) done in ${Date.now() - startedAt}ms`);
    return res.end();
  }

  let data = null;
  try {
    data = await upstream.json();
  } catch {
    data = null;
  }
  if (!upstream.ok) {
    const message =
      (data && data.error && (data.error.message || data.error.code)) ||
      `Upstream error (HTTP ${upstream.status}).`;
    console.log(`[demo] ← ${upstream.status} in ${Date.now() - startedAt}ms error`);
    return res.status(upstream.status).json({ error: String(message).slice(0, 500) });
  }
  const reply = extractReply(data, shape);
  if (!reply) {
    return res.status(502).json({ error: 'Upstream returned no reply. Try again.' });
  }
  // Companion Ads rides alongside the reply: an `ads` fill, an `ads_error`
  // when something is misconfigured, or nothing at all. Inference never
  // fails because of ads. Same for keyterms: a `keyterms` list (at most
  // KEYTERMS_MAX, best first), a `keyterms_error`, or nothing.
  const out = { reply };
  if (Array.isArray(data.ads)) out.ads = data.ads;
  else if (data.ads_error) out.ads_error = data.ads_error;
  if (Array.isArray(data.keyterms)) out.keyterms = data.keyterms.slice(0, KEYTERMS_MAX);
  else if (data.keyterms_error) out.keyterms_error = data.keyterms_error;
  console.log(`[demo] ← ${upstream.status} in ${Date.now() - startedAt}ms ${describeAdsResult(data)} ${describeKeytermsResult(data)}`);
  res.json(out);
});

// Effective config with its source per var. Secrets render as set/unset
// with length only — never the value.
function describeEnv() {
  const vars = [
    { name: 'PORT', fallback: '3000' },
    { name: 'PROVIDER_BASE_URL', fallback: 'https://api.freerouter.com' },
    { name: 'PROVIDER_API_KEY', secret: true },
    { name: 'MODEL', fallback: 'openrouter/free' },
    { name: 'COMPANION_ADS', fallback: 'false' },
    { name: 'MONETIZABLE_KEYTERMS', fallback: 'false' },
    { name: 'TRUST_PROXY', fallback: 'false' },
  ];
  return vars.map(({ name, fallback, secret }) => {
    const v = process.env[name];
    const shown = v == null || v === ''
      ? `<unset → ${fallback != null ? fallback : '(required)'}>`
      : (secret ? `<set:${String(v).length} chars>` : v);
    return `  ${name}=${shown} (${envSource(name)})`;
  });
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[demo] listening on http://localhost:${PORT}`);
    console.log('[demo] env:');
    for (const line of describeEnv()) console.log(`[demo]${line}`);
    console.log(`[demo] provider=${providerHost()} model=${MODEL} companionAds=${COMPANION_ADS ? 'on' : 'off'} keyterms=${MONETIZABLE_KEYTERMS ? 'on' : 'off'} key=${PROVIDER_API_KEY ? 'set' : 'MISSING'}`);
    if (!PROVIDER_API_KEY) console.log('[demo] hint: copy .env.example to .env and add your key, then restart.');
  });
}

// Exported for smoke.js (unit-level checks that run without binding a port).
module.exports = app;
module.exports.cleanMessages = cleanMessages;
module.exports.cleanShape = cleanShape;
module.exports.upstreamPathFor = upstreamPathFor;
module.exports.extractReply = extractReply;
module.exports.extractChatReply = extractChatReply;
module.exports.extractResponsesReply = extractResponsesReply;
module.exports.clientIp = clientIp;
module.exports.maskIp = maskIp;
module.exports.envSource = envSource;
module.exports.describeEnv = describeEnv;
module.exports.buildUpstreamBody = buildUpstreamBody;
module.exports.buildLinkRequest = buildLinkRequest;
module.exports.describeAdsResult = describeAdsResult;
module.exports.describeKeytermsResult = describeKeytermsResult;
module.exports.config = {
  providerBaseUrl: PROVIDER_BASE_URL,
  providerHost: providerHost(),
  model: MODEL,
  companionAds: COMPANION_ADS,
  adsPlacement: ADS_PLACEMENT,
  monetizableKeyterms: MONETIZABLE_KEYTERMS,
  keytermsMax: KEYTERMS_MAX,
  trustProxy: TRUST_PROXY,
};
