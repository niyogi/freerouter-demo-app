# FreeRouter Chatbot Demo

A simple, clean chatbot powered by [FreeRouter](https://freerouter.com) — one API key that routes across multiple LLM gateways. **Zero lock-in:** this exact app also runs on [OpenRouter](https://openrouter.ai) by changing two config values. No code changes.

![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## What this is

A minimal full-stack chatbot that shows what integrating with FreeRouter looks like in practice:

- Type a message, get an AI reply. Conversation history is kept in memory.
- The provider API key lives **only on the server** — the browser never sees it.
- A top-of-page **API shape** switch: **Chat Completions** (`POST /v1/chat/completions`) or **Responses** (`POST /v1/responses`) — same key, same model, two dialects.
- A **Stream** toggle: buffered JSON replies or live SSE typewriter output, on either shape.
- Swap between FreeRouter and OpenRouter by changing the base URL + key (+ model) in one file and restarting.

If you can run this demo, you can integrate FreeRouter into any Node app.

## Setup

**Prerequisites:** [Node.js](https://nodejs.org) 20 or newer, plus a terminal.

### 1. Sign up at freerouter.com and grab your starter key

Create an account at [freerouter.com](https://freerouter.com). Every new account includes a **starter key** — copy it from your dashboard. (It looks like `fr_live_…`.)

### 2. Make sure the key's API shape is `openai`

In the FreeRouter dashboard, each key has an **API shape**. Think of the shape as *which provider's API dialect the key speaks*: a key set to `openai` answers the OpenAI-style endpoints (`POST /v1/chat/completions`), a key set to `anthropic` answers the Anthropic-style endpoint (`POST /v1/messages`), and so on. Same key system, different "language."

This demo speaks the **OpenAI dialect**, so set your key's shape to **`openai`** (the default for new keys — if you haven't changed it, you're already good).

### 3. Configure and run

```bash
cp .env.example .env
# Edit .env: paste your starter key as PROVIDER_API_KEY.
# MODEL defaults to openrouter/free, which costs nothing — leave it.

npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) and start chatting.

**Confirm it's working:** after sending a message, head to the **Logs tab** in your [FreeRouter dashboard](https://freerouter.com) — you should see your successful API request listed there, confirming your key is configured correctly and being used.

Try all four combinations: flip the **API shape** switch (Chat Completions ↔ Responses) and the **Stream** toggle, then send a message each way. Your choice persists across reloads.

| Variable | What it is | Default |
|---|---|---|
| `PROVIDER_BASE_URL` | Which gateway to talk to | `https://api.freerouter.com` |
| `PROVIDER_API_KEY` | Your key (**server-side only**, never committed) | — |
| `MODEL` | Model id sent to the provider | `openrouter/free` (free tier) |
| `COMPANION_ADS` | `true` shows a sponsored slot under each reply (FreeRouter only) | `false` |
| `MONETIZABLE_KEYTERMS` | `true` hyperlinks the top 3 extracted keyterms in each reply (FreeRouter only) | `false` |
| `PORT` | Local port | `3000` |

> `.env` is git-ignored. Never commit a real key — that's the whole reason this demo has a server. The demo also reads the repo-root `.env` (one level up) as fallback for anything its own `.env` doesn't set — handy for values you share across projects. Real environment variables beat both files.

## The swap: FreeRouter ↔ OpenRouter

This is the point of the demo. FreeRouter speaks the same OpenAI-compatible API as OpenRouter, so the entire integration is portable:

1. In `.env`, comment out the FreeRouter lines and uncomment the OpenRouter lines (or just edit in place):

   ```bash
   PROVIDER_BASE_URL=https://openrouter.ai/api
   PROVIDER_API_KEY=sk-or-paste_yours_here
   MODEL=openrouter/free   # or any OpenRouter model id
   ```

2. Restart (`Ctrl-C`, then `npm start`) and chat again.

Same UI, same code, different provider. The footer shows the active provider hostname + model so you can see the swap took effect. To go back, restore the FreeRouter values and restart.

> Responses + streaming when swapped: Chat Completions works on any OpenAI-compatible provider, so the swap is seamless there. The Responses shape posts to `{BASE_URL}/v1/responses` — if the swapped-to provider doesn't serve that endpoint you'll get its 404 as a chat error; just switch the shape back to Chat Completions.

## API shape + streaming

The controls at the top of the page send `{ messages, shape, stream }` to `POST /api/chat`:

| Shape | Upstream endpoint | Buffered reply | Streamed deltas |
|---|---|---|---|
| Chat Completions | `POST /v1/chat/completions` | `choices[0].message.content` | `data: { choices: [{ delta: { content } }] }` … `data: [DONE]` |
| Responses | `POST /v1/responses` | `output_text` (output items fallback) | `response.output_text.delta` … terminal `response.completed` (no `[DONE]`) |

- **Buffered** (`stream` off): the server parses the reply per shape and returns `{ reply }` (+ `ads`/`ads_error`, `keyterms` when those features are on).
- **Streaming** (`stream` on): the server forwards `stream: true` upstream and relays the SSE bytes straight through as `text/event-stream`. The browser accumulates deltas per shape and renders markdown live. Ads/keyterms ride the terminal SSE event on both shapes, exactly as they ride the buffered JSON — streamed replies render them the same way.
- The server logs the shape per request (`chat(chat)`, `chat(responses+stream)`, …) so you can see which endpoint each message used.

## How it works (architecture)

```
browser (public/app.js) ──POST /api/chat──▶  Node server (server.js)
  { messages, shape, stream }                         │  attaches key + MODEL
                                                      ▼
                              {BASE_URL}/v1/chat/completions  (shape: chat)
                              {BASE_URL}/v1/responses         (shape: responses)
                              (FreeRouter serves both; OpenRouter: chat only)
                              buffered JSON ─or─ SSE relay when stream: true
```

- **`server.js`** — Express server. Serves the static frontend, exposes three routes:
  - `GET /api/health` → `{ ok: true }` (smoke checks).
  - `GET /api/config` → `{ providerHost, model }` for the UI footer. **Never returns the key.**
  - `POST /api/chat` → validates `{ messages }`, reads `shape` (`chat` default) + `stream` (`false` default), forwards `{ model, messages }` or `{ model, input, stream }` to the matching upstream endpoint with `Authorization: Bearer <key>`. Buffered replies return `{ reply }`; streams relay upstream SSE. Upstream errors are relayed with their status and message.
- **`public/`** — dependency-free frontend. `index.html` (layout + shape/stream controls), `styles.css` (light/dark via `prefers-color-scheme`, mobile-responsive), `app.js` (keeps history, calls only same-origin `/api/chat`, parses SSE per shape when streaming).
- **Why a server at all?** FreeRouter keys are secrets, like passwords. A pure HTML/JS page would ship your key to every visitor's browser. The ~60-line server route keeps the key private while the frontend stays dumb — this is the pattern to copy into production apps.

### Verify it yourself

```bash
npm run smoke   # offline checks: health, config, chat passthrough, bad-body 400
```

## Deploying

Any Node host works (Render, Fly.io, Railway, a VPS). Set `PROVIDER_BASE_URL`, `PROVIDER_API_KEY`, and `MODEL` as **environment variables** on the host instead of using a `.env` file, then run `npm install && npm start`. The server respects `PORT` if the host assigns one.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/chat` says `PROVIDER_API_KEY is not set` | `.env` missing or key blank | `cp .env.example .env`, paste key, restart |
| `401` / `Unauthorized` | Wrong or revoked key | Re-copy the key from the dashboard |
| `404` on `/v1/chat/completions` | Key's API shape isn't `openai` | Set the key's shape to `openai` (see step 2) |
| `404` on `/v1/responses` | Key's API shape isn't `openai`, or the swapped-to provider has no Responses endpoint | Set the key's shape to `openai`; on non-FreeRouter providers use Chat Completions |
| Stream starts then stalls | Reverse proxy buffering SSE | Disable proxy buffering for `/api/chat` (e.g. `X-Accel-Buffering: no` on nginx) or turn Stream off |
| `404` / model-not-found mentioning the model id | That provider doesn't know `MODEL` | Set `MODEL` to a valid id for the active provider |
| `Could not reach …` / `502` | Wrong `PROVIDER_BASE_URL` or no network | Check the URL (include `https://`, no trailing path) |
| No ad card with `COMPANION_ADS=true` | Key toggle off, no ad network configured, or no fill | Turn Companion Ads on for the key, add a network under Settings → Ad Networks, and confirm fills in the dashboard playground first |
| No hyperlinks with `MONETIZABLE_KEYTERMS=true` | Key toggle off, extractor unconfigured, or nothing specific in the reply | Turn Monetizable Keyterms on for the key, confirm the operator configured the extractor + destination template, and ask about something product-specific |

## Companion Ads (optional)

FreeRouter keys can monetize with [Companion Ads](https://docs.freerouter.com/companion-ads.html): a sponsored slot that rides alongside each reply without ever failing inference. To try it in this demo:

1. In the FreeRouter dashboard, turn **Companion Ads on** for your key and configure an ad network under **Settings → Ad Networks** (you'll need a publisher key from the network — Gravity is supported today). Without both steps, no ad returns.
2. Set `COMPANION_ADS=true` in `.env` and restart.

The demo then attaches an `ad_request` using the same placement the FreeRouter playground previews with, and renders any fill as a labeled "Sponsored" card under the reply (clicks go through `clickUrl`, views fire `impUrl`). Empty fills and `ads_error` outcomes render nothing — the chat keeps working regardless. The request carries your browser's IP (Gravity needs a public client IP for geo/fraud — a server IP no-fills); on localhost it falls back to the server's public IP. Watch the `ip=client:…|fallback:…` tag on the demo console's `ad_request(...)` line — the address is last-octet-masked. If the demo runs behind a reverse proxy, set `TRUST_PROXY=true` so the client IP is read from `X-Forwarded-For` (only behind a proxy you control).

> Companion Ads is a FreeRouter-only feature. When you swap this demo to OpenRouter (or any non-FreeRouter endpoint), set `COMPANION_ADS=false` — other providers don't understand `ad_request`.

## Monetizable Keyterms (optional)

FreeRouter keys can return [Monetizable Keyterms](https://docs.freerouter.com/keyterms.html): scored entities (brands, products, model numbers) with a destination URL each, riding alongside the reply without ever failing inference. To try it in this demo:

1. In the FreeRouter dashboard, turn **Monetizable Keyterms on** for your key. (The operator must also have configured the extractor model and destination template — otherwise replies carry `keyterms_error`.)
2. Set `MONETIZABLE_KEYTERMS=true` in `.env` and restart.

The demo then attaches a `link_request` capped at the top 3, and hyperlinks each returned span in the rendered reply post-render (first occurrence per term, never inside code blocks or existing links). Empty lists and `keyterms_error` outcomes change nothing — the chat keeps working regardless.

> Like Companion Ads, this is a FreeRouter-only feature. When you swap this demo to OpenRouter (or any non-FreeRouter endpoint), set `MONETIZABLE_KEYTERMS=false` — other providers don't understand `link_request`.

## Links

- [FreeRouter](https://freerouter.com) · [Docs](https://docs.freerouter.com) · [API reference](https://docs.freerouter.com/api-reference.html)
- [OpenRouter](https://openrouter.ai) — the swap target in the demo above

MIT — do what you want with it.
