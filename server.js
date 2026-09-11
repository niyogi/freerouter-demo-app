'use strict';

/**
 * FreeRouter chatbot demo — tiny Express server.
 *
 * The browser talks only to this server (same origin). The server attaches
 * the provider API key and forwards to {PROVIDER_BASE_URL}/v1/chat/completions.
 * The key never leaves the server, so it never appears in client-side JS.
 *
 * Swap providers with env vars only (see .env.example): set
 * PROVIDER_BASE_URL + PROVIDER_API_KEY (+ MODEL) and restart. No code change.
 */

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const PROVIDER_BASE_URL = String(process.env.PROVIDER_BASE_URL || 'https://api.freerouter.com').replace(/\/+$/, '');
const PROVIDER_API_KEY = String(process.env.PROVIDER_API_KEY || '');
const MODEL = String(process.env.MODEL || 'openrouter/free');
const COMPANION_ADS = String(process.env.COMPANION_ADS || 'false').toLowerCase() === 'true';

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

function buildUpstreamBody(messages, { ip, ua }) {
  const body = { model: MODEL, messages };
  const adRequest = buildAdRequest({ ip, ua });
  if (adRequest) body.ad_request = adRequest;
  return body;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Safe for the browser: hostname + model + ads flag only. Never the key.
app.get('/api/config', (req, res) => {
  res.json({ providerHost: providerHost(), model: MODEL, companionAds: COMPANION_ADS });
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

  // End-user context for ads: the browser UA plus the resolved public IP.
  const upstreamBody = buildUpstreamBody(messages, {
    ua: req.get('User-Agent') || '',
  });

  let upstream;
  try {
    upstream = await fetch(`${PROVIDER_BASE_URL}/v1/chat/completions`, {
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
    return res.status(upstream.status).json({ error: String(message).slice(0, 500) });
  }
  const reply =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '')
      : '';
  if (!reply) {
    return res.status(502).json({ error: 'Upstream returned no reply. Try again.' });
  }
  // Companion Ads rides alongside the reply: an `ads` fill, an `ads_error`
  // when something is misconfigured, or nothing at all. Inference never
  // fails because of ads.
  const out = { reply };
  if (Array.isArray(data.ads)) out.ads = data.ads;
  else if (data.ads_error) out.ads_error = data.ads_error;
  res.json(out);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Chatbot demo listening on http://localhost:${PORT}`);
    console.log(`Provider: ${providerHost()} | model: ${MODEL}`);
    if (!PROVIDER_API_KEY) console.log('Note: PROVIDER_API_KEY is not set — /api/chat will explain how to fix it.');
  });
}

// Exported for smoke.js (unit-level checks that run without binding a port).
module.exports = app;
module.exports.cleanMessages = cleanMessages;
module.exports.buildUpstreamBody = buildUpstreamBody;
module.exports.config = {
  providerBaseUrl: PROVIDER_BASE_URL,
  providerHost: providerHost(),
  model: MODEL,
  companionAds: COMPANION_ADS,
  adsPlacement: ADS_PLACEMENT,
};
