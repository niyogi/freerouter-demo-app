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
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const PROVIDER_BASE_URL = String(process.env.PROVIDER_BASE_URL || 'https://api.freerouter.com').replace(/\/+$/, '');
const PROVIDER_API_KEY = String(process.env.PROVIDER_API_KEY || '');
const MODEL = String(process.env.MODEL || 'openrouter/free');

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

// Safe for the browser: hostname + model only. Never the key.
app.get('/api/config', (req, res) => {
  res.json({ providerHost: providerHost(), model: MODEL });
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

  let upstream;
  try {
    upstream = await fetch(`${PROVIDER_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PROVIDER_API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, messages }),
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
  res.json({ reply });
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
module.exports.config = { providerBaseUrl: PROVIDER_BASE_URL, providerHost: providerHost(), model: MODEL };
