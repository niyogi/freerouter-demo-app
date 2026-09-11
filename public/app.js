'use strict';

// Minimal chat client: keeps history in memory, talks only to our own
// server (POST /api/chat). The provider key never appears here.

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const pill = document.getElementById('provider-pill');

const history = [];

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Companion Ads slot. Uses clickUrl for clicks and fires impUrl on view,
// per the FreeRouter ads contract. Renders nothing on empty/error fills.
function addAds(ads) {
  for (const ad of ads) {
    if (!ad || typeof ad !== 'object') continue;
    const card = document.createElement('div');
    card.className = 'msg ad';
    const label = document.createElement('div');
    label.className = 'ad-label';
    label.textContent = 'Sponsored';
    card.appendChild(label);
    if (ad.brandName || ad.title) {
      const head = document.createElement('div');
      head.className = 'ad-head';
      head.textContent = ad.title || ad.brandName;
      card.appendChild(head);
    }
    if (ad.adText) {
      const body = document.createElement('div');
      body.className = 'ad-text';
      body.textContent = ad.adText;
      card.appendChild(body);
    }
    if (ad.clickUrl) {
      const cta = document.createElement('a');
      cta.href = ad.clickUrl;
      cta.target = '_blank';
      cta.rel = 'noopener sponsored';
      cta.className = 'ad-cta';
      cta.textContent = ad.cta || 'Learn more';
      card.appendChild(cta);
    }
    if (ad.impUrl) {
      const imp = document.createElement('img');
      imp.src = ad.impUrl;
      imp.alt = '';
      imp.width = 1;
      imp.height = 1;
      card.appendChild(imp);
    }
    messagesEl.appendChild(card);
  }
  if (ads.length > 0) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addError(text) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    pill.textContent = `Provider: ${cfg.providerHost} · ${cfg.model}`;
    document.getElementById('hint-host').textContent = cfg.providerHost;
    document.getElementById('hint-model').textContent = cfg.model;
  } catch {
    pill.textContent = 'Provider: unknown';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  const typing = addMessage('bot', 'Thinking…');
  typing.classList.add('typing');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) {
      addError(data.error || 'Something went wrong.');
    } else {
      addMessage('bot', data.reply);
      history.push({ role: 'assistant', content: data.reply });
      if (Array.isArray(data.ads)) addAds(data.ads);
    }
  } catch (err) {
    typing.remove();
    addError(`Could not reach the server: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

loadConfig();
addMessage('bot', 'Hi! Ask me anything.');
input.focus();
