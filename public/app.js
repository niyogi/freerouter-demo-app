'use strict';

// Minimal chat client: keeps history in memory, talks only to our own
// server (POST /api/chat). The provider key never appears here.

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const pill = document.getElementById('provider-pill');

const history = [];

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
      return md.render(src);
    } catch {
      // fall through to built-in
    }
  }
  return renderMarkdown(src);
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
