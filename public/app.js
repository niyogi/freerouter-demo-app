'use strict';

// Minimal chat client: keeps history in memory, talks only to our own
// server (POST /api/chat). The provider key never appears here. The top
// controls pick the API shape (chat → /v1/chat/completions, responses →
// /v1/responses) and whether to stream the reply via SSE.

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const pill = document.getElementById('provider-pill');

const history = [];

// Request options (persisted across reloads). Both shapes support both
// modes; streaming relays upstream SSE for a typewriter effect.
const shapeInputs = Array.from(document.querySelectorAll('input[name="shape"]'));
const streamToggle = document.getElementById('stream');
let shape = 'chat';
let streamMode = true;
try {
  const saved = JSON.parse(localStorage.getItem('fr-demo-prefs') || '{}');
  if (saved && (saved.shape === 'chat' || saved.shape === 'responses')) shape = saved.shape;
  if (saved && typeof saved.stream === 'boolean') streamMode = saved.stream;
} catch {
  // Storage unavailable (private browsing, …) — defaults stand.
}
for (const r of shapeInputs) r.checked = r.value === shape;
if (streamToggle) streamToggle.checked = streamMode;
function savePrefs() {
  try {
    localStorage.setItem('fr-demo-prefs', JSON.stringify({ shape, stream: streamMode }));
  } catch {
    // Non-fatal.
  }
}
for (const r of shapeInputs) {
  r.addEventListener('change', () => {
    if (r.checked) {
      shape = r.value;
      savePrefs();
    }
  });
}
if (streamToggle) {
  streamToggle.addEventListener('change', () => {
    streamMode = streamToggle.checked;
    savePrefs();
  });
}
function lockControls(locked) {
  for (const r of shapeInputs) r.disabled = locked;
  if (streamToggle) streamToggle.disabled = locked;
}

// Assistant rendering via the markdown-it package (vendored at
// /vendor/markdown-it.umd.min.js). Same security posture as the old
// built-in renderer: raw HTML is escaped (html:false), links are limited
// to http(s)/mailto (validateLink), outbound links open in a new tab.
// Falls back to the built-in minimal renderer when the bundle is missing
// (e.g. `npm install` was skipped) so the chat never goes blank.
let mdIt = null;
function getMarkdown() {
  if (mdIt) return mdIt;
  try {
    if (typeof window === 'undefined' || !window.markdownit) return null;
    mdIt = window.markdownit({
      html: false,
      linkify: true,
      typographer: false,
      validateLink: (url) => /^https?:\/\//i.test(url) || /^mailto:/i.test(url),
    });
    const defaultLinkOpen = mdIt.renderer.rules.link_open;
    mdIt.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener');
      if (defaultLinkOpen) return defaultLinkOpen(tokens, idx, options, env, self);
      return self.renderToken(tokens, idx, options);
    };
  } catch {
    return null;
  }
  return mdIt;
}

function renderAssistant(text) {
  const src = String(text == null ? '' : text);
  const md = getMarkdown();
  if (md) {
    try {
      // Trim: markdown-it appends a trailing newline, which renders as a
      // visible gap below the text inside the bubble (pre-wrap whitespace).
      return md.render(src).trim();
    } catch {
      // fall through to built-in
    }
  }
  return renderMarkdown(src).trim();
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  if (role === 'bot' && text !== 'Thinking…') div.innerHTML = renderAssistant(text);
  else div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Minimal markdown for model replies (code, bold/italic, links, headings,
// lists, paragraphs). HTML is escaped first, so model output can never
// inject markup; link targets are restricted to http(s).
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

function renderMarkdown(src) {
  const blocks = [];
  const rest = String(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const html = [];
  let list = [];
  let olist = [];
  let para = [];
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((i) => `<li>${renderInline(i)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushOlist = () => {
    if (olist.length) html.push(`<ol>${olist.map((i) => `<li>${renderInline(i)}</li>`).join('')}</ol>`);
    olist = [];
  };
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(renderInline).join('<br />')}</p>`);
    para = [];
  };
  for (const line of rest.split('\n')) {
    const trimmed = line.trim();
    const listMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      flushPara();
      flushOlist();
      list.push(listMatch[1]);
      continue;
    }
    const olistMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (olistMatch) {
      flushPara();
      flushList();
      olist.push(olistMatch[1]);
      continue;
    }
    flushList();
    flushOlist();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      flushPara();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const codeRef = trimmed.match(/^\u0000\d+\u0000$/);
    if (codeRef) {
      flushPara();
      html.push(trimmed);
      continue;
    }
    para.push(trimmed);
  }
  flushList();
  flushOlist();
  flushPara();
  return html.join('').replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
}

// Companion Ads slot. Uses clickUrl for clicks and fires impUrl on view,
// per the FreeRouter ads contract. Renders nothing on empty/error fills.
function addAds(ads) {
  for (const ad of ads) {
    if (!ad || typeof ad !== 'object') continue;
    const card = document.createElement('div');
    card.className = 'msg ad';
    // Click destination prefers the tracked clickUrl; some fills only
    // carry the raw landing-page `url` (different campaigns fill per
    // IP/geo, so local and remote can legitimately disagree). Falling back
    // keeps the CTA visible — clicks just go untracked, which the console
    // warning says out loud.
    const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u);
    const dest = isHttpUrl(ad.clickUrl) ? ad.clickUrl : (isHttpUrl(ad.url) ? ad.url : '');
    if (dest && dest !== ad.clickUrl) {
      console.warn('[demo ads] fill has no clickUrl; linking direct url (clicks untracked).');
    }
    // The whole card is the click target; the visible CTA is a styled
    // span, not a nested link, so there is exactly one target.
    if (dest) {
      card.classList.add('clickable');
      card.setAttribute('role', 'link');
      card.setAttribute('tabindex', '0');
      const open = () => window.open(dest, '_blank', 'noopener');
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    const label = document.createElement('div');
    label.className = 'ad-label';
    label.textContent = 'Sponsored';
    card.appendChild(label);
    // Brand row (favicon + advertiser) mirrors the playground's
    // "title (brand)" attribution — without it, content-style ads read as
    // bot text with no source.
    if (ad.brandName) {
      const brandRow = document.createElement('div');
      brandRow.className = 'ad-brandrow';
      if (typeof ad.favicon === 'string' && /^https?:\/\//.test(ad.favicon)) {
        const icon = document.createElement('img');
        icon.className = 'ad-favicon';
        icon.alt = '';
        icon.width = 16;
        icon.height = 16;
        icon.referrerPolicy = 'no-referrer';
        icon.addEventListener('error', () => icon.remove());
        icon.src = ad.favicon;
        brandRow.appendChild(icon);
      }
      const brand = document.createElement('span');
      brand.className = 'ad-brand';
      brand.textContent = ad.brandName;
      brandRow.appendChild(brand);
      card.appendChild(brandRow);
    }
    // Title always renders when present (even if it matches the brand) —
    // same as the reference tile: head row is attribution, title is content.
    if (ad.title) {
      const head = document.createElement('div');
      head.className = 'ad-head';
      head.textContent = ad.title;
      card.appendChild(head);
    }
    if (ad.adText) {
      const body = document.createElement('div');
      body.className = 'ad-text';
      body.textContent = ad.adText;
      card.appendChild(body);
    }
    // CTA is a styled span, not a nested link: the whole tile opens the
    // destination (nested anchors would double-open). Arrow matches the
    // reference tile. Shows whenever there is somewhere to go — a missing
    // button means the fill had neither clickUrl nor url, not a render bug.
    if (dest) {
      const cta = document.createElement('span');
      cta.className = 'ad-cta';
      cta.textContent = `${ad.cta || 'Learn more'} `;
      const arrow = document.createElement('i');
      arrow.className = 'bi bi-arrow-up-right';
      arrow.setAttribute('aria-hidden', 'true');
      cta.appendChild(arrow);
      card.appendChild(cta);
    }
    if (ad.impUrl) {
      // Fire the view pixel as soon as the card renders.
      const imp = new Image(1, 1);
      imp.alt = '';
      imp.src = ad.impUrl;
      imp.className = 'ad-imp';
      card.appendChild(imp);
    }
    messagesEl.appendChild(card);
  }
  if (ads.length > 0) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Monetizable Keyterms: hyperlink the top candidates inside an already
// rendered bot message. Walks text nodes only (never existing links, code,
// or pre blocks), links the first occurrence of each of the top-3 spans,
// and builds anchors with DOM APIs so model text can never inject markup.
// URLs are restricted to http(s), same as rendered markdown links.
function hyperlinkKeyterms(botDiv, keyterms) {
  const terms = (Array.isArray(keyterms) ? keyterms : []).slice(0, 3);
  if (!botDiv || !terms.length) return 0;
  let linked = 0;
  for (const t of terms) {
    if (!t || typeof t.keyterm !== 'string' || !t.keyterm) continue;
    if (typeof t.url !== 'string' || !/^https?:\/\//.test(t.url)) continue;
    const needle = t.keyterm;
    const walker = document.createTreeWalker(botDiv, NodeFilter.SHOW_TEXT);
    let node = null;
    let found = null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (parent && parent.closest('a,code,pre')) continue;
      const idx = node.nodeValue.indexOf(needle);
      if (idx !== -1) {
        found = { node, idx };
        break;
      }
    }
    if (!found) continue;
    const { node: textNode, idx } = found;
    const before = textNode.nodeValue.slice(0, idx);
    const after = textNode.nodeValue.slice(idx + needle.length);
    const anchor = document.createElement('a');
    anchor.href = t.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.textContent = needle;
    const parent = textNode.parentNode;
    if (before) parent.insertBefore(document.createTextNode(before), textNode);
    parent.insertBefore(anchor, textNode);
    if (after) parent.insertBefore(document.createTextNode(after), textNode);
    parent.removeChild(textNode);
    linked += 1;
  }
  return linked;
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

// Pure SSE accumulation for streaming (no DOM): one record in, deltas out.
// Chat records are `data: { choices: [{ delta: { content } }] }` ending with
// `data: [DONE]`; Responses records are `data: { type, ... }` with text in
// `response.output_text.delta` and the full answer plus the ads/keyterms
// siblings on the terminal `response.completed`. Pinned in smoke.js via the
// same vm trick as the markdown renderer.
function createStreamState(activeShape) {
  const isResponses = activeShape === 'responses';
  const state = { text: '', ads: null, ads_error: null, keyterms: null, keyterms_error: null, done: false };
  function takeChatPayload(evt) {
    const choice = evt && evt.choices && evt.choices[0];
    const delta = choice && choice.delta;
    if (delta && typeof delta.content === 'string') state.text += delta.content;
    if (Array.isArray(evt.ads)) state.ads = evt.ads;
    else if (evt.ads_error) state.ads_error = evt.ads_error;
    if (Array.isArray(evt.keyterms)) state.keyterms = evt.keyterms;
    else if (evt.keyterms_error) state.keyterms_error = evt.keyterms_error;
  }
  function extractTerminalText(resp) {
    if (typeof resp.output_text === 'string' && resp.output_text) return resp.output_text;
    let out = '';
    const items = Array.isArray(resp.output) ? resp.output : [];
    for (const item of items) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && part.type === 'output_text') out += String(part.text || '');
      }
    }
    return out;
  }
  function takeResponsesEvent(evt) {
    if (evt.type === 'response.output_text.delta') {
      state.text += String(evt.delta || '');
    } else if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
      // Deltas already accumulated the text; only fill from the terminal
      // object when nothing arrived yet.
      if (!state.text) state.text = extractTerminalText(evt.response || {});
      const resp = evt.response || {};
      if (Array.isArray(resp.ads)) state.ads = resp.ads;
      else if (resp.ads_error) state.ads_error = resp.ads_error;
      if (Array.isArray(resp.keyterms)) state.keyterms = resp.keyterms;
      else if (resp.keyterms_error) state.keyterms_error = resp.keyterms_error;
      state.done = true;
    }
  }
  function handleRecord(record) {
    const payloads = [];
    const lines = String(record).split('\n');
    for (const line of lines) {
      if (line.indexOf('data:') === 0) payloads.push(line.slice(5).trim());
    }
    for (const raw of payloads) {
      if (raw === '[DONE]') {
        state.done = true;
        continue;
      }
      let evt = null;
      try {
        evt = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!evt || typeof evt !== 'object') continue;
      if (isResponses) takeResponsesEvent(evt);
      else takeChatPayload(evt);
    }
  }
  return { state, handleRecord };
}

// Shared finish for buffered and streamed replies: append to history,
// render ads, hyperlink keyterms.
function finishAssistant(fullText, extras) {
  const botDiv = addMessage('bot', fullText);
  history.push({ role: 'assistant', content: fullText });
  const data = extras || {};
  // Ads narration: addAds renders SPONSORED unconditionally per ad
  // object, so a missing label means no ad arrived (or the browser
  // hid it) — never a render-logic skip. Say so in the console.
  if (Array.isArray(data.ads)) {
    if (!data.ads.length) console.info('[demo ads] no fill (ads: []) — nothing to render.');
    addAds(data.ads);
  } else if (data.ads_error) {
    console.warn(`[demo ads] ${data.ads_error.code || 'error'} — ${data.ads_error.message || ''}`);
  }
  if (Array.isArray(data.keyterms)) hyperlinkKeyterms(botDiv, data.keyterms);
  return botDiv;
}

async function sendMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || sendBtn.disabled) return;
  sendBtn.disabled = true;
  lockControls(true);

  addMessage('user', trimmed);
  history.push({ role: 'user', content: trimmed });

  try {
    if (streamMode) await sendMessageStream();
    else await sendMessageBuffered();
  } finally {
    sendBtn.disabled = false;
    lockControls(false);
    input.focus();
  }
}

async function sendMessageBuffered() {
  const typing = addMessage('bot', 'Thinking…');
  typing.classList.add('typing');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, shape, stream: false }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) {
      addError(data.error || 'Something went wrong.');
    } else {
      finishAssistant(data.reply, data);
    }
  } catch (err) {
    typing.remove();
    addError(`Could not reach the server: ${err.message}`);
  }
}

async function sendMessageStream() {
  const botDiv = addMessage('bot', 'Thinking…');
  botDiv.classList.add('typing');

  let res = null;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, shape, stream: true }),
    });
  } catch (err) {
    botDiv.remove();
    addError(`Could not reach the server: ${err.message}`);
    return;
  }
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || contentType.indexOf('text/event-stream') === -1 || !res.body) {
    // The server answers JSON, not SSE, when the request itself failed
    // (bad key, unknown model, no /v1/responses on this provider, …).
    let message = 'Something went wrong.';
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch {
      // Non-JSON error body — keep the default.
    }
    botDiv.remove();
    addError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const stream = createStreamState(shape);
  let buffer = '';
  let painted = '';
  const paint = () => {
    if (stream.state.text === painted) return;
    painted = stream.state.text;
    botDiv.classList.remove('typing');
    botDiv.innerHTML = renderAssistant(painted);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let idx = -1;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        stream.handleRecord(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        paint();
      }
    }
    if (buffer.trim()) {
      stream.handleRecord(buffer);
      buffer = '';
      paint();
    }
  } catch (err) {
    // Mid-stream network cut: keep whatever arrived, if anything.
    console.warn(`[demo stream] ${err.message}`);
  }
  const fullText = stream.state.text;
  if (!fullText) {
    botDiv.remove();
    addError('Upstream returned no reply. Try again.');
    return;
  }
  // Swap the live div for the standard finish path so streamed and
  // buffered replies share history/ads/keyterms handling exactly.
  botDiv.remove();
  finishAssistant(fullText, {
    ads: stream.state.ads,
    ads_error: stream.state.ads_error,
    keyterms: stream.state.keyterms,
    keyterms_error: stream.state.keyterms_error,
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  sendMessage(text);
});

const newChatBtn = document.getElementById('new-chat');
function newChat() {
  history.length = 0;
  messagesEl.innerHTML = '';
  addMessage('bot', 'Hi! Ask me anything.');
  input.focus();
}
if (newChatBtn) newChatBtn.addEventListener('click', newChat);

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.textContent));
});

loadConfig();
addMessage('bot', 'Hi! Ask me anything.');
input.focus();
