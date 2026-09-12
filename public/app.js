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
  if (role === 'bot' && text !== 'Thinking…') div.innerHTML = renderMarkdown(text);
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
  let para = [];
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((i) => `<li>${renderInline(i)}</li>`).join('')}</ul>`);
    list = [];
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
      list.push(listMatch[1]);
      continue;
    }
    flushList();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      flushPara();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}></h${level}>`);
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
    // The whole card is the click target (opens clickUrl); the visible CTA
    // is a styled span, not a nested link, so there is exactly one target.
    if (ad.clickUrl) {
      card.classList.add('clickable');
      card.setAttribute('role', 'link');
      card.setAttribute('tabindex', '0');
      const open = () => window.open(ad.clickUrl, '_blank', 'noopener');
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
    // CTA is a styled span, not a nested link: the whole tile opens
    // clickUrl (nested anchors would double-open). Arrow matches the
    // reference tile.
    if (ad.clickUrl) {
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

async function sendMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || sendBtn.disabled) return;
  sendBtn.disabled = true;

  addMessage('user', trimmed);
  history.push({ role: 'user', content: trimmed });
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
      const botDiv = addMessage('bot', data.reply);
      history.push({ role: 'assistant', content: data.reply });
      if (Array.isArray(data.ads)) addAds(data.ads);
      if (Array.isArray(data.keyterms)) hyperlinkKeyterms(botDiv, data.keyterms);
    }
  } catch (err) {
    typing.remove();
    addError(`Could not reach the server: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  sendMessage(text);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => sendMessage(chip.textContent));
});

loadConfig();
addMessage('bot', 'Hi! Ask me anything.');
input.focus();
