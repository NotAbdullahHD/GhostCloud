# GhostCloud

A cloud-game library + cloud gaming launcher (built on the stratus-api cloud gaming API).

- **Frontend** (static): catalog of 225 games, search, tag filters, detail modals, player UI. Runs anywhere static files are served.
- **API server** (Node.js): Raccoon account creation (auto + manual), session flow, WebRTC signaling relay.

## Structure

```
index.html, css/, js/, games.json   ← static site
server.js                           ← local dev static server + /api proxy
api/                                ← Node.js API server (deploy to Render)
api/api.js                          ← Express + ws server
api/sites.json                      ← API keys / rate limits
render.yaml                         ← Render blueprint (one-click API deploy)
cloudflare/worker.js                ← optional serverless API (Cloudflare Worker)
```

## Deploy (Render + Cloudflare Pages)

This is the simplest setup that works end-to-end (minus upstream streaming — see Note below).

### 1. Put it on GitHub

Push this whole folder to a repo (`.gitignore` already excludes `node_modules/`, logs, and zips).

### 2. Deploy the API to Render

- Go to **Render → New → Blueprint**, connect the repo.
- It reads `render.yaml` and creates the **ghostcloud-api** web service (Node 20, `npm install` + `npm start`, health check at `/healthz`).
- Copy the resulting URL, e.g. `https://ghostcloud-api.onrender.com`.

### 3. Deploy the site to Cloudflare Pages

- **Cloudflare Pages → Create project**, connect the same repo.
- Build command: *(leave empty)*, output directory: `/` (root).
- The static site (`index.html`, `css/`, `js/`, `games.json`) gets served automatically.

### 4. Point the site at the API

Open the deployed site → **Settings** (top-right) → set:

- **API Base URL:** `https://ghostcloud-api.onrender.com`
- **API Key:** `sk_live_local_dev_key_12345` (or change it in `api/sites.json`)

Then **Save**. Auto and manual account creation now work.

## Run locally

```sh
cd api && npm install && cd ..
node api/api.js      # API server on :3001
node server.js       # site on :4578 with /api proxied
```

Open http://localhost:4578.

## Cloudflare Worker (serverless API, optional)

The Node `api/` server can be replaced by a Worker + Durable Object:

```sh
cd cloudflare
npx wrangler deploy
```

Then set **Settings → API Base URL** to `https://<your-worker>.workers.dev`.

Notes:
- Each session is a Durable Object (`SESSION`), keeping the WebRTC signaling relay alive across requests.
- Auto account creation polls mail.gw up to ~60s in one request, which can exceed free-tier Worker CPU limits — prefer the **manual account** flow (Settings → Raccoon account) or a paid plan.

## Note on streaming

Raccoon's game servers currently reject streamed sessions with `515 "Illegal User"` for accounts created through this flow (a server-side entitlement check). Account creation, queueing, and signaling all work; the final WebRTC stream may be blocked upstream. This is independent of where the API is hosted (Render, Worker, or local).
