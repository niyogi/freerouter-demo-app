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
