const express = require("express");
const { randomUUID, createDecipheriv, createHash } = require("crypto");
const { readFileSync } = require("fs");
const { WebSocketServer, WebSocket } = require("ws");
const { createServer } = require("http");
const dns = require("dns");
const path = require("path");
const cors = require("cors");
if (!globalThis.crypto) globalThis.crypto = require("crypto").webcrypto;
const PORT = parseInt(process.env.PORT, 10) || 3001;
let sites;
try {
  sites = JSON.parse(readFileSync(path.join(__dirname, "sites.json"), "utf-8"));
} catch (e) {
  console.error("Failed to load sites.json:", e);
  process.exit(1);
}
const RACCOON_HOST = "www.raccoongame.com";
const RACCOON_TIMEOUT_MS = 20000;
const MAIL_BASE = "https://api.mail.gw";
let raccoonIpCache = null;
async function resolveRaccoonIp() {
  if (raccoonIpCache && raccoonIpCache.expiresAt > Date.now()) return raccoonIpCache;
  for (const family of [4, 6]) {
    try {
      const addrs = family === 4
        ? await dns.promises.resolve4(RACCOON_HOST)
        : await dns.promises.resolve6(RACCOON_HOST);
      if (addrs?.length) {
        const ip = addrs[Math.floor(Math.random() * addrs.length)];
        raccoonIpCache = { ip, family, expiresAt: Date.now() + 5 * 60000 };
        return raccoonIpCache;
      }
    } catch {}
  }
  return null;
}
async function fetchWithTimeout(url, opts = {}, ms = RACCOON_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function raccoonFetch(pathAndQuery, opts = {}) {
  const entry = await resolveRaccoonIp();
  if (!entry) return fetchWithTimeout(`https://${RACCOON_HOST}${pathAndQuery}`, opts);
  const authority = entry.family === 6 ? `[${entry.ip}]` : entry.ip;
  try {
    return await fetchWithTimeout(`https://${authority}${pathAndQuery}`, {
      ...opts, headers: { ...opts.headers, Host: RACCOON_HOST },
    });
  } catch {
    raccoonIpCache = null;
    return fetchWithTimeout(`https://${RACCOON_HOST}${pathAndQuery}`, opts);
  }
}

// Guarded JSON helper for the mail service — surfaces HTTP status / empty bodies
// in logs so an IP block (403), rate limit (429), or service outage is easy to
// tell apart instead of a cryptic "Unexpected end of JSON input".
async function mailJson(path, opts = {}, what = path) {
  let res;
  try { res = await fetchWithTimeout(`${MAIL_BASE}${path}`, opts, 15000); }
  catch (e) { throw new Error(`mail: ${what} unreachable (${e.message})`); }
  if (!res.ok) throw new Error(`mail: ${what} HTTP ${res.status}`);
  const text = await res.text();
  if (!text) throw new Error(`mail: ${what} empty response`);
  try { return JSON.parse(text); }
  catch { throw new Error(`mail: ${what} bad JSON`); }
}
const sessions = new Map();
const siteUsage = new Map();
const ipLimits = new Map();
const embedIpLimits = new Map();
const accountCreating = new Map();
const MAX_SESSION_SECONDS = 19 * 60; // 19 min default session cap
const DEFAULT_SESSION_SECONDS = 19 * 60;
function decryptPayload(result) {
  const key = Buffer.from("fd39e724f7c1e4b3d34bc7c72b5349c3", "utf8");
  const iv = Buffer.from("dd39e4a3337fe25a", "utf8");
  const d = createDecipheriv("aes-256-cbc", key, iv);
  const raw = d.update(result, "base64", "utf8") + d.final("utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") throw new Error("decryptPayload: unexpected shape");
  return parsed;
}
function generateSN() { return randomUUID().replace(/-/g, "").toLowerCase(); }
function generatePassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  let p = ""; for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)]; return p;
}
async function getVerificationCode(mailJwt, maxRetries = 30) {
  const headers = { Authorization: `Bearer ${mailJwt}`, "Content-Type": "application/json" };
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetchWithTimeout(`${MAIL_BASE}/messages?page=1`, { headers });
      const data = await res.json();
      if (data["hydra:member"]?.length > 0) {
        const msgId = data["hydra:member"][0].id;
        const full = await (await fetchWithTimeout(`${MAIL_BASE}/messages/${msgId}`, { headers })).json();
        const match = (full.text || full.html || "").replace(/<[^>]*>/g, "").match(/\b\d{6}\b/);
        if (match) return match[0];
      }
    } catch {}
  }
  throw new Error("Timeout getting verification code");
}
// Warm pool size — tunable via GHOSTCLOUD_POOL_TARGET env (Render → Environment).
// Each concurrent player burns one temp account, so a bigger pool = more instant starts.
// Keep it modest: the mail provider rate-limits registrations per IP, and every
// account in the pool is one registration we've already been allowed.
const POOL_TARGET = Math.min(Math.max(parseInt(process.env.GHOSTCLOUD_POOL_TARGET || "15", 10) || 15, 5), 30);
const pool = [];
let poolFilling = false;

// ── Global account-creation queue ──────────────────────────
// The mail provider 429s bursts of parallel registrations from one IP (that's
// what the logs showed). EVERY registration — pool fill AND on-demand from
// sessions — goes through ONE queue, so at most one is ever in flight per
// instance. This matches the old serial cadence that worked for weeks.
let creationChain = Promise.resolve();
function serialCreateAccount() {
  const run = creationChain.then(() => createAccountRaw(), () => createAccountRaw());
  creationChain = run.catch(() => {});
  return run;
}
// Is any live session stuck waiting for an account right now? If so, pool fill
// yields so the waiting player gets the next registration slot instead of the pool.
function anySessionWaitingForAccount() {
  for (const s of sessions.values()) if (s.state === "creating" && !s.sn) return true;
  return false;
}
async function fillPool() {
  if (poolFilling) return;
  const needed = POOL_TARGET - pool.length;
  if (needed <= 0) return;
  poolFilling = true;
  try {
    // Serial fill (one at a time). A burst is what gets us throttled.
    let errors = 0;
    for (let i = 0; i < needed; i++) {
      if (anySessionWaitingForAccount()) break; // let a player take the next slot
      try {
        const acc = await serialCreateAccount();
        pool.push(acc);
        errors = 0;
        console.log(`pool: ready (${pool.length}/${POOL_TARGET})`);
      } catch (e) {
        console.log(`pool: fill error — ${e.message}`);
        if (++errors >= 5) break; // rest; the self-heal timer retries later
        // 429 = provider throttling this IP — stop poking it for a while
        const wait = /429/.test(e.message) ? 30000 : 3000;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  } finally { poolFilling = false; }
}
// Self-heal: if the pool ever falls short (throttle window / provider hiccup),
// keep refilling gently in the background so the server recovers without a restart.
setInterval(() => { if (pool.length < POOL_TARGET) fillPool().catch(() => {}); }, 60000);
async function createAccount() {
  if (pool.length > 0) { const acc = pool.shift(); console.log(`pool: served (${pool.length} left)`); fillPool().catch(() => {}); return acc; }
  // Pool empty — take the next slot on the global queue (serialized with pool fill)
  const acc = await serialCreateAccount();
  fillPool().catch(() => {});
  return acc;
}
async function createAccountRaw() {
  const domainData = await mailJson("/domains", {}, "domains");
  if (!domainData["hydra:member"]?.length) throw new Error("No Mail.tm domains available");
  const domain = domainData["hydra:member"][0].domain;
  const mailUser = `rcn_${Math.random().toString(36).substring(2, 11)}`;
  const email = `${mailUser}@${domain}`;
  const mailPassword = generatePassword();
  const raccoonPassword = generatePassword();
  const sn = generateSN();
  const h = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" };
  const base = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" };
  await mailJson("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) }, "create mailbox");
  const { token: mailJwt } = await mailJson("/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) }, "mail token");
  await raccoonFetch("/users/sendEmail", { method: "POST", headers: h, body: new URLSearchParams({ email, type: "register", ...base }) });
  const code = await getVerificationCode(mailJwt);
  await raccoonFetch("/users/emailRegister", { method: "POST", headers: h, body: new URLSearchParams({ email, code, password: raccoonPassword, phone: "1", country: "Brazil", ...base }) });
  const loginRes = await raccoonFetch("/users/emailLogin", { method: "POST", headers: h, body: new URLSearchParams({ email, password: raccoonPassword, ...base }) });
  const loginData = await loginRes.json();
  if (loginData.status !== 200) throw new Error("Login failed");
  let userToken = loginData.data?.user_token || "";
  const cookie = loginRes.headers.get("set-cookie");
  if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
  return { sn, token: userToken };
}
function gameHeaders(token) {
  return { accept: "*/*", "content-type": "application/x-www-form-urlencoded; charset=UTF-8", cookie: `as_user_token=${token}`, origin: "https://www.raccoongame.com", referer: "https://www.raccoongame.com/?t=1720436119", "user-agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36", "x-requested-with": "XMLHttpRequest" };
}
// Games Raccoon marks as membership-only (status 4623) can never be played by
// temp accounts — remember them so we fail fast instead of burning an account
// on them every time someone clicks Play. Cache expires after 6h (games can change).
const MEMBERSHIP_GAME_MSG = "This game requires a paid membership on the game service — temporary accounts can't play it. Try another game.";
const MEMBERSHIP_BLOCK_TTL = 6 * 3600 * 1000;
const membershipBlockedGames = new Map(); // game_key -> expiresAt
async function doInitGame(session) {
  const { sn, token, game_key } = session;
  const h = gameHeaders(token);
  const common = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", user_token: token };
  try {
    const costRes = await raccoonFetch("/userGame/checkCost", { method: "POST", headers: h, body: new URLSearchParams({ ...common, game_key }) });
    const costData = await costRes.json().catch(() => null);
    if (costData && costData.status !== 200) console.log(`checkCost ${game_key}: ${JSON.stringify(costData).slice(0, 200)}`);
  } catch {}
  const playData = await (await raccoonFetch("/jyapi/playGame", { method: "POST", headers: h, body: new URLSearchParams({ ...common, game_key, model_name: "Chrome/147.0.0.0" }) })).json();
  // Raccoon status 3004 = account has no diamonds/credits for this game
  if (playData.status === 3004 || String(playData.msg || "").toLowerCase().includes("diamond")) {
    const err = new Error("This game needs play credits the temporary account doesn't have — try again in a moment or pick another game.");
    err.isDiamondError = true;
    throw err;
  }
  // Raccoon status 4623 = this game needs a paid membership — no temp account can play it
  if (playData.status === 4623 || /membership/i.test(String(playData.msg || ""))) {
    const err = new Error(MEMBERSHIP_GAME_MSG);
    err.isMembershipError = true;
    throw err;
  }
  if (playData.status === 201 || (playData.status === 200 && playData.data?.play_queue_id)) {
    const qid = playData.data?.play_queue_id;
    if (!qid) throw new Error("Missing queue ID");
    return { queued: true, queue_id: qid, initial_pos: playData.data?.queue_pos };
  }
  if (playData.status === 200 && playData.data?.result) {
    const server_data = decryptPayload(playData.data.result);
    return { queued: false, server_data };
  }
  throw new Error(`Unexpected playGame response: ${JSON.stringify(playData)}`);
}
async function doPollQueue(session, queue_id) {
  const { sn, token } = session;
  const d = await (await raccoonFetch("/jyapi/playQueue", { method: "POST", headers: gameHeaders(token), body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", play_queue_id: queue_id, user_token: token }) })).json();
  if (d.status !== 200 && d.status !== 201) throw new Error(`Queue poll rejected: ${JSON.stringify(d)}`);
  return d.data?.queue_pos ?? 1;
}
async function doClaimGame(session, queue_id) {
  const { sn, token, game_key } = session;
  const d = await (await raccoonFetch("/jyapi/playGame", { method: "POST", headers: gameHeaders(token), body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", game_key, model_name: "Chrome/147.0.0.0", play_queue_id: queue_id, user_token: token }) })).json();
  if (d.status === 200 && d.data?.result) return decryptPayload(d.data.result);
  throw new Error(`Failed to claim game. API Status: ${d.status}`);
}
async function doStopGame(session) {
  clearInterval(session.raccoonPingInterval);
  session.raccoonWs?.close();
  if (!session.sc_id) return;
  try { await raccoonFetch("/jyapi/stopGame", { method: "POST", headers: gameHeaders(session.token), body: new URLSearchParams({ sn: session.sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", sc_id: String(session.sc_id), game_type: "1", user_token: session.token }) }); } catch {}
}
async function doCost(session) {
  if (!session.sc_id) return;
  try {
    const res = await raccoonFetch("/userGame/cost", { method: "POST", headers: gameHeaders(session.token), body: new URLSearchParams({ sn: session.sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", sc_id: String(session.sc_id), game_type: "1", user_token: session.token }) });
    const body = await res.json().catch(() => null);
    if (body?.status === 3013) killSession(session.uuid, "upstream_terminated");
  } catch {}
}
function getSiteName(apiKey) { return Object.keys(sites.sites).find((k) => sites.sites[k].api_key === apiKey) || null; }
function getSite(apiKey) { const name = getSiteName(apiKey); return name ? { name, ...sites.sites[name] } : null; }
function checkRateLimit(apiKey, site) {
  const now = Date.now();
  const calls = siteUsage.get(apiKey) || [];
  const perMin = calls.filter((t) => t > now - 60000).length;
  const perHour = calls.filter((t) => t > now - 3600000).length;
  const perDay = calls.filter((t) => t > now - 86400000).length;
  const perMonth = calls.filter((t) => t > now - 30 * 86400000).length;
  if (perMin >= site.limits.per_minute) return { allowed: false, reason: "per-minute" };
  if (perHour >= site.limits.per_hour) return { allowed: false, reason: "per-hour" };
  if (perDay >= site.limits.per_day) return { allowed: false, reason: "per-day" };
  if (perMonth >= site.limits.per_month) return { allowed: false, reason: "per-month" };
  return { allowed: true };
}
function recordUsage(apiKey) { const now = Date.now(); const calls = (siteUsage.get(apiKey) || []).filter((t) => t > now - 30 * 86400000); calls.push(now); siteUsage.set(apiKey, calls); }
function getUsageStats(apiKey) { const now = Date.now(); const calls = siteUsage.get(apiKey) || []; return { perMin: calls.filter((t) => t > now - 60000).length, perHour: calls.filter((t) => t > now - 3600000).length, perDay: calls.filter((t) => t > now - 86400000).length, perMonth: calls.filter((t) => t > now - 30 * 86400000).length }; }
function countActiveSessions(apiKey) { return [...sessions.values()].filter((s) => s.api_key === apiKey).length; }
function acquireAccountSlot(apiKey, site) { const cap = (site.max_concurrent_sessions ?? 5) * 2; const current = accountCreating.get(apiKey) ?? 0; if (current >= cap) return false; accountCreating.set(apiKey, current + 1); return true; }
function releaseAccountSlot(apiKey) { const current = accountCreating.get(apiKey) ?? 1; const next = current - 1; if (next <= 0) accountCreating.delete(apiKey); else accountCreating.set(apiKey, next); }
function applyServerData(session, sd) { session.sc_id = sd.sc_id || sd.play_id; session.bs_sc_id = sd.bs_sc_id || session.sc_id; session.bs_host = sd.bs_host; session.bs_token = sd.token; session.channel_id = sd.channel_id; session.gl_key = sd.gl_key; session.play_config = sd.play_config; session.turns = sd.turns || []; session.message_server = sd.message_server; }
function killSession(uuid, reason = "unknown") {
  const session = sessions.get(uuid);
  if (!session) return;
  clearTimeout(session.startgame_timeout); clearTimeout(session.queue_abandon_timeout); clearTimeout(session.ping_timeout); clearTimeout(session.session_timeout); clearInterval(session.costInterval);
  try { session.clientWs?.close(1000, reason); } catch {}
  doStopGame(session).catch(() => {});
  sessions.delete(uuid);
  console.log(`session ${uuid.slice(0, 8)} killed — ${reason}`);
}
function resetPingTimeout(uuid) { const session = sessions.get(uuid); if (!session) return; clearTimeout(session.ping_timeout); session.ping_timeout = setTimeout(() => killSession(uuid, "ping_timeout"), 30000); }
const REAPER_DEADLINES = { creating: 5 * 60000, finished_queue: 2 * 60000 };
const QUEUED_MAX_AGE = 30 * 60000;
const QUEUED_POLL_STALE_AFTER = 90000;
setInterval(() => { const now = Date.now(); for (const [uuid, session] of sessions) { if (session.state === "queued") { const lastSeen = session.last_queue_poll_at ?? session.created_at; if (now - lastSeen > QUEUED_POLL_STALE_AFTER || now - session.created_at > QUEUED_MAX_AGE) { killSession(uuid, "reaper:queued_stale"); } continue; } const deadline = REAPER_DEADLINES[session.state]; if (deadline !== undefined && now - session.created_at > deadline) { killSession(uuid, `reaper:${session.state}_deadline`); continue; } if (session.state === "active" && !session.session_timeout && session.max_session_seconds > 0) { killSession(uuid, "reaper:active_no_timeout"); } } }, 2 * 60000);
function connectRaccoonSignaling(session) {
  const { sn, gl_key, play_config, uuid } = session;
  const raccoonWs = new WebSocket(session.message_server.url);
  session.raccoonWs = raccoonWs;
  const rSend = (p) => { if (raccoonWs.readyState === WebSocket.OPEN) raccoonWs.send(JSON.stringify(p)); };
  const toClient = (data) => { const cws = session.clientWs; if (cws?.readyState === WebSocket.OPEN) cws.send(JSON.stringify(data)); };
  raccoonWs.on("open", () => {
    rSend({ id: "register", type: "webUA", uid: sn, token: decodeURIComponent(session.message_server.token) });
    session.raccoonPingInterval = setInterval(() => { rSend({ id: "ping", uid: sn, type: "webUA", status: "gaming", sc_id: session.bs_sc_id }); }, 30000);
  });
  raccoonWs.on("message", (raw) => {
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.id === "rtc_sdp" && data.body?.code) console.log(`RTC_SDP: code=${data.body.code} msg=${data.body.msg || ''}`);
    switch (data.id) {
      case "register_ack": if (data.code === 200) { rSend({ id: "start_game", from: sn, to: gl_key, game_args: "", gp_num: 0, play_config, simpleHandler: null, body: { force_soft_dec: 0, session_id: session.bs_sc_id, sn_user_id: sn, game_name: null, joystick_num: 2 } }); } break;
      case "start_game": if (data.from === gl_key && data.body?.code === 200) { toClient({ type: "game_ready" }); } break;
      case "rtc_sdp": { const b = data.body; if (!b) break; try { if (b.type === "answer") { toClient({ type: "rtc_answer", sdp: b }); } else if (b.type === "candidate" && b.sdp) { toClient({ type: "rtc_candidate", candidate: b.sdp }); } } catch {} break; }
    }
  });
  raccoonWs.on("close", () => { clearInterval(session.raccoonPingInterval); console.log(`raccoon ws closed for ${uuid.slice(0, 8)}`); });
  raccoonWs.on("error", () => console.log(`signal error on ${uuid.slice(0, 8)}`));
}
function getClientIp(req) { return req.headers["x-caddy-real-ip-is-here1357908642"] || req.socket.remoteAddress || "unknown"; }
function checkIpLimit(store, ip, windowMs, max) { const now = Date.now(); const hits = (store.get(ip) || []).filter((t) => t > now - windowMs); if (hits.length >= max) return false; hits.push(now); store.set(ip, hits); return true; }
// Match an origin against an allowlist pattern. Supports exact, a URL prefix
// (existing behaviour), and a `*` subdomain wildcard like "https://*.pages.dev".
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function originMatches(pattern, origin) {
  if (pattern === origin) return true;
  if (origin.startsWith(pattern.replace(/\/+$/, ""))) return true; // URL-prefix (legacy)
  if (!pattern.includes("*")) return false;
  // Wildcard with support for multiple stars, e.g. "http://*.s3-website-*.amazonaws.com"
  const re = new RegExp("^" + pattern.split("*").map(escRe).join("[^/]*") + "$");
  return re.test(origin);
}
// Common free hosting suffixes — lets you spin up a NEW mirror link (another
// Cloudflare Pages project, GitHub Pages, Netlify, Vercel, an S3 bucket, …) and
// have it work immediately with zero API edits. The API key is already public
// in the page source and the concurrency + rate limits still apply, so this
// doesn't meaningfully raise the key-theft risk (that was always possible via
// curl, which has no Origin header).
const FREE_HOST_SUFFIXES = [
  // Cloudflare / Netlify / Vercel / GitHub Pages
  "https://*.pages.dev",
  "https://*.workers.dev",
  "https://*.github.io",
  "https://*.netlify.app",
  "https://*.vercel.app",
  // Amazon S3
  "https://s3.amazonaws.com", // any public S3 bucket via the REST endpoint (https://s3.amazonaws.com/<bucket>/index.html)
  "http://*.s3-website-*.amazonaws.com", // S3 static website hosting (HTTP)
  "https://*.s3-website-*.amazonaws.com",
  // Google / Microsoft free hosting (domains schools often allow for other reasons)
  "https://*.web.app", // Firebase Hosting
  "https://*.firebaseapp.com", // Firebase legacy
  "https://storage.googleapis.com", // Google Cloud Storage REST (free tier)
  "https://*.azurestaticapps.net", // Azure Static Web Apps
  // Obscure free static hosts
  "https://*.gitlab.io", // GitLab Pages
  "https://*.codeberg.page", // Codeberg Pages
  "https://*.surge.sh", // Surge
  "https://*.neocities.org", // Neocities
  "https://*.tiiny.site", // Tiiny.host
  "https://*.js.org", // js.org free subdomain (served via GitHub Pages)
  "https://*.onrender.com", // Render static sites
];
// Reject requests coming from websites that aren't in the site's allowlist.
// This stops someone else from pointing their own site at your API even if
// they steal the API base URL or key from your page source.
function originAllowed(req, site) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, server-to-server) with a valid key
  const allowed = site.allowed_origins || [];
  if (allowed.includes("*") || allowed.includes(origin)) return true;
  const list = site.allow_free_hosts ? allowed.concat(FREE_HOST_SUFFIXES) : allowed;
  return list.some((a) => originMatches(a, origin));
}
function auth(req, res, next) {
  const apiKey = req.headers["x-api-key"] || req.body?.api_key || req.query?.api_key;
  if (!apiKey) return res.status(401).json({ error: "Missing API key." });
  const site = getSite(apiKey);
  if (!site) return res.status(401).json({ error: "Invalid API key." });
  if (!site.enabled) return res.status(403).json({ error: "API Key disabled." });
  if (!originAllowed(req, site)) return res.status(403).json({ error: "Origin not allowed." });
  req.site = site; req.apiKey = apiKey; next();
}
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  // Presence pings are tiny and many clients can share one NAT IP (schools), so skip the per-IP burst limit for them.
  if (!req.path.startsWith("/cloud/v1/heartbeat") && !req.path.startsWith("/cloud/v1/online")) {
    const ip = getClientIp(req);
    if (!checkIpLimit(ipLimits, ip, 60000, 100)) return res.status(429).json({ error: "Too many requests." });
  }
  req.setTimeout(30000, () => { res.status(408).json({ error: "Timeout." }); });
  next();
});
app.use(express.static(path.join(__dirname, "public")));
// Health check for hosting platforms (Render/Railway) that require a 200 on /
app.get("/healthz", (req, res) => res.json({ status: "ok", name: "ghostcloud-api" }));
app.get("/cloud/v1/embed", (req, res) => { if (!req.query.id) return res.status(400).type("text").send("Missing id"); res.sendFile(path.join(__dirname, "public", "e.html")); });
app.get("/cloud/v1/embed-data", (req, res) => {
  const ip = getClientIp(req);
  if (!checkIpLimit(embedIpLimits, ip, 60000, 30)) return res.status(429).json({ error: "Too many requests." });
  const { id } = req.query; if (!id) return res.status(400).json({ error: "Missing id." });
  const session = sessions.get(id); if (!session) return res.status(404).json({ error: "Not found." }); if (session.state !== "active") return res.status(400).json({ error: "Not active." });
  res.json({ ice_servers: session.embed_ice_servers, signaling_ws: session.embed_signaling_ws });
});
// ── Online presence (real live user count) ────────────────
// Every browser sends a heartbeat ~every 30s with a stable client id
// (stored in localStorage). Anyone not heard from in 70s is dropped.
const presence = new Map(); // clientId -> lastSeen (ms)
const PRESENCE_TTL_MS = 70 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, seen] of presence) if (now - seen > PRESENCE_TTL_MS) presence.delete(id);
}, 15 * 1000);
function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const seen of presence.values()) if (now - seen <= PRESENCE_TTL_MS) n++;
  return n;
}
app.post("/cloud/v1/heartbeat", auth, (req, res) => {
  const id = (req.body || {}).client_id;
  if (typeof id === "string" && id.length >= 8 && id.length <= 64) presence.set(id, Date.now());
  res.json({ online: onlineCount() });
});
app.get("/cloud/v1/online", auth, (req, res) => res.json({ online: onlineCount() }));

// ── Pro entitlements (server-validated) ────────────────────
// The Pro code never ships to the browser; the client sends it here once and the
// API validates it, then issues a signed entitlement token that grants Pro.
// Code + reset management (no code edits needed):
//   - GHOSTCLOUD_PRO_CODE : the current Pro code. Set it in Render → Environment
//     and restart. The plaintext NEVER ships in this file or the repo.
//   - GHOSTCLOUD_PRO_EPOCH : bump this number to instantly invalidate every
//     existing Pro token (e.g. the moment a giveaway winner redeems, so the
//     code they share with friends stops working).
// If GHOSTCLOUD_PRO_CODE is unset, Pro activation is disabled entirely.
const PRO_CODE = process.env.GHOSTCLOUD_PRO_CODE || "";
const PRO_EPOCH = process.env.GHOSTCLOUD_PRO_EPOCH || "1";
const PRO_DAILY_SECONDS = 8 * 3600; // 8h/day for Pro
if (!PRO_CODE) console.log("⚠️  GHOSTCLOUD_PRO_CODE is not set — Pro activation is DISABLED. Set it in Render → Environment → New Variable and restart.");
const proTokens = new Map(); // token -> { exp, epoch }
const proAttempts = new Map(); // ip -> timestamps (brute-force guard on code entry)
function proTokenNew() { return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); }
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of proTokens) if (now > v.exp) proTokens.delete(t);
  for (const [ip, arr] of proAttempts) proAttempts.set(ip, arr.filter((x) => x > now - 60000));
}, 60 * 1000);
app.post("/cloud/v1/activatePro", auth, (req, res) => {
  if (!PRO_CODE) return res.status(503).json({ error: "Pro is not configured yet — try again later." });
  const ip = getClientIp(req);
  const now = Date.now();
  const attempts = (proAttempts.get(ip) || []).filter((x) => x > now - 60000);
  if (attempts.length >= 5) return res.status(429).json({ error: "Too many attempts. Try again later." });
  proAttempts.set(ip, [...attempts, now]);
  const code = String((req.body || {}).code || "").trim();
  if (!code || code !== PRO_CODE) {
    return res.status(401).json({ error: "Invalid code." });
  }
  const token = proTokenNew();
  proTokens.set(token, { exp: Date.now() + 30 * 24 * 3600 * 1000, epoch: PRO_EPOCH }); // 30-day token (sliding)
  res.json({ ok: true, token, subDailySeconds: PRO_DAILY_SECONDS });
});
app.post("/cloud/v1/verifyPro", auth, (req, res) => {
  const token = String((req.body || {}).token || "");
  const v = proTokens.get(token);
  if (!token || !v || v.epoch !== PRO_EPOCH || Date.now() > v.exp) {
    if (token) proTokens.delete(token);
    return res.json({ active: false });
  }
  proTokens.set(token, { exp: Date.now() + 30 * 24 * 3600 * 1000, epoch: PRO_EPOCH }); // sliding renewal
  res.json({ active: true, subDailySeconds: PRO_DAILY_SECONDS });
});

const REGISTER_HEADERS = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" };
function registerBase(sn) { return { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" }; }

// Create a mail.gw mailbox — Raccoon actually delivers verification mail to these domains
// (unlike temp-mail.org, which Raccoon silently drops).
async function createMailbox() {
  const domainData = await mailJson("/domains", {}, "domains");
  if (!domainData["hydra:member"]?.length) throw new Error("No mail domains available");
  const domain = domainData["hydra:member"][0].domain;
  const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${domain}`;
  const mailPassword = generatePassword();
  await mailJson("/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) }, "create mailbox");
  const { token: mailJwt } = await mailJson("/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) }, "mail token");
  return { email, mailJwt };
}

app.post("/cloud/v1/createMailbox", auth, async (req, res) => {
  try { res.json(await createMailbox()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Single-poll read of the newest message's 6-digit code from a mailbox.
app.post("/cloud/v1/getCode", auth, async (req, res) => {
  const { mailJwt } = req.body;
  if (!mailJwt) return res.status(400).json({ error: "Missing mailJwt." });
  try {
    const headers = { Authorization: `Bearer ${mailJwt}`, "Content-Type": "application/json" };
    const r = await fetchWithTimeout(`${MAIL_BASE}/messages?page=1`, { headers });
    const data = await r.json();
    if (data["hydra:member"]?.length > 0) {
      const msgId = data["hydra:member"][0].id;
      const full = await (await fetchWithTimeout(`${MAIL_BASE}/messages/${msgId}`, { headers })).json();
      const match = (full.text || full.html || "").replace(/<[^>]*>/g, "").match(/\b\d{6}\b/);
      res.json({ code: match ? match[0] : null });
    } else {
      res.json({ code: null });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 1 of manual account creation: user provides their own mailbox,
// we ask Raccoon to send the verification code to it.
app.post("/cloud/v1/sendEmail", auth, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password." });
  const sn = generateSN();
  try {
    const r = await raccoonFetch("/users/sendEmail", { method: "POST", headers: REGISTER_HEADERS, body: new URLSearchParams({ email, type: "register", ...registerBase(sn) }) });
    const data = await r.json().catch(() => ({}));
    console.log(`sendEmail ${email} → HTTP ${r.status} ${JSON.stringify(data)}`);
    if (data.status && data.status !== 200) return res.status(400).json({ error: data.msg || `Raccoon rejected: ${JSON.stringify(data)}`, raccoon: data });
    res.json({ sn, raccoon: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Step 2: finish registration + login with the code the user read from their inbox.
app.post("/cloud/v1/manualRegister", auth, async (req, res) => {
  const { sn, email, password, code, phone, country } = req.body;
  if (!sn || !email || !password || !code) return res.status(400).json({ error: "Missing sn, email, password or code." });
  const base = registerBase(sn);
  try {
    await raccoonFetch("/users/emailRegister", { method: "POST", headers: REGISTER_HEADERS, body: new URLSearchParams({ email, code, password, phone: phone || "1", country: country || "Brazil", ...base }) });
    const loginRes = await raccoonFetch("/users/emailLogin", { method: "POST", headers: REGISTER_HEADERS, body: new URLSearchParams({ email, password, ...base }) });
    const loginData = await loginRes.json();
    if (loginData.status !== 200) throw new Error("Login failed");
    let userToken = loginData.data?.user_token || "";
    const cookie = loginRes.headers.get("set-cookie");
    if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
    if (!userToken) throw new Error("No user token returned");
    res.json({ sn, token: userToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/cloud/v1/createSession", auth, async (req, res) => {
  const { game_key, account } = req.body;
  if (!game_key || typeof game_key !== "string" || game_key.length > 256) return res.status(400).json({ error: "Invalid game_key." });
  const manualAccount = account && typeof account.sn === "string" && typeof account.token === "string" && account.sn && account.token ? account : null;
  const { site, apiKey } = req;
  // Known membership-only games fail fast (no account wasted). Manual accounts
  // (user's own, possibly with a membership) are still allowed through.
  if (!manualAccount && (membershipBlockedGames.get(game_key) || 0) > Date.now()) {
    return res.status(409).json({ error: MEMBERSHIP_GAME_MSG });
  }
  if (countActiveSessions(apiKey) >= site.max_concurrent_sessions) return res.status(429).json({ error: "Concurrent session limit reached." });
  const rl = checkRateLimit(apiKey, site); if (!rl.allowed) return res.status(429).json({ error: `Rate limit: ${rl.reason}` });
  if (!manualAccount && !acquireAccountSlot(apiKey, site)) return res.status(429).json({ error: "Too many sessions being created." });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const push = (obj) => res.write(JSON.stringify(obj) + "\n");
  const uuid = randomUUID();
  const rawLimit = site.max_session_seconds && site.max_session_seconds > 0 ? site.max_session_seconds : DEFAULT_SESSION_SECONDS;
  const sessionLimit = Math.min(rawLimit, MAX_SESSION_SECONDS);
  const session = { uuid, api_key: apiKey, state: "creating", game_key, sn: "", token: "", created_at: Date.now(), max_session_seconds: sessionLimit, last_queue_poll_at: null, last_ping_at: null, startgame_timeout: null, queue_abandon_timeout: null, ping_timeout: null, session_timeout: null, raccoonWs: null, raccoonPingInterval: null, clientWs: null, costInterval: null };
  sessions.set(uuid, session);
  console.log(`createSession ${game_key} → ${uuid.slice(0, 8)}`);
  // If the client disconnects while we're still creating/queuing (tab closed,
  // player cancelled), stop immediately instead of holding the account + slot
  // and keeping their Raccoon queue position warm.
  let streamEnded = false;
  res.on("close", () => {
    if (streamEnded) return;
    const s = sessions.get(uuid);
    if (s && s.state !== "active") killSession(uuid, "client_left_during_setup");
  });
  try {
    let acc;
    if (manualAccount) {
      acc = manualAccount;
      push({ status: "account_ready" });
    } else {
      push({ status: "creating_account" });
      // The mail provider throttles per IP (429) and during a throttle window
      // only allows a trickle of registrations. Instead of dying on the first
      // 429, wait through a few spaced retries so the session catches the next
      // allowed slot. (Serial queue means these can't stack into a burst.)
      let accTries = 0;
      while (true) {
        try {
          acc = await createAccount();
          break;
        } catch (e) {
          if (e && e.cancelled) throw e;
          if (++accTries > 3) throw e;
          console.log(`account throttled on ${uuid.slice(0, 8)} — retry ${accTries}/3`);
          await new Promise((r) => setTimeout(r, 15000));
          if (!sessions.has(uuid)) return res.end(); // player left during the wait
          push({ status: "creating_account" });
        }
      }
      releaseAccountSlot(apiKey);
      if (!sessions.has(uuid)) return res.end();
      push({ status: "account_ready" });
    }
    session.sn = acc.sn; session.token = acc.token; recordUsage(apiKey);
    push({ status: "requesting_game" });
    // Fresh temp accounts can be out of credits (Raccoon status 3004) — try up to
    // 2 more accounts before giving up, so one drained account doesn't fail the player.
    let init = null;
    let creditRetries = 0;
    while (!init) {
      try {
        init = await doInitGame(session);
      } catch (e) {
        if (e && e.isDiamondError && !manualAccount && creditRetries < 2) {
          creditRetries++;
          console.log(`no credits on ${uuid.slice(0, 8)} — trying another account (${creditRetries})`);
          push({ status: "creating_account" });
          acc = await createAccount();
          session.sn = acc.sn; session.token = acc.token;
          push({ status: "account_ready" });
          push({ status: "requesting_game" });
          continue;
        }
        throw e;
      }
    }
    if (!sessions.has(uuid)) return res.end();
    if (init.queued) {
      session.state = "queued"; session.queue_id = init.queue_id;
      session.queue_abandon_timeout = setTimeout(() => killSession(uuid, "queue_abandoned"), 60000);
      push({ status: "queue", uuid, queue_pos: init.initial_pos });
    } else {
      applyServerData(session, init.server_data);
      session.state = "finished_queue"; session.finished_queue_at = Date.now();
      session.startgame_timeout = setTimeout(() => killSession(uuid, "startgame_timeout"), 30000);
      push({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
    }
  } catch (e) {
    if (!manualAccount) releaseAccountSlot(apiKey);
    if (e && e.isMembershipError && !manualAccount) membershipBlockedGames.set(game_key, Date.now() + MEMBERSHIP_BLOCK_TTL);
    push({ status: "error", error: e.message }); killSession(uuid, "creation_error");
  }
  streamEnded = true;
  res.end();
});
app.get("/cloud/v1/getQueue", auth, async (req, res) => {
  const { uuid } = req.query; if (!uuid) return res.status(400).json({ error: "Missing uuid." });
  const session = sessions.get(uuid); if (!session) return res.status(404).json({ error: "Not found." });
  if (session.api_key !== req.apiKey) return res.status(403).json({ error: "Forbidden." });
  if (session.state !== "queued" && session.state !== "finished_queue") return res.status(400).json({ error: `Session is '${session.state}'` });
  const now = Date.now();
  if (session.last_queue_poll_at && now - session.last_queue_poll_at < 3000) return res.status(429).json({ error: "Poll every 3 seconds max." });
  session.last_queue_poll_at = now;
  clearTimeout(session.queue_abandon_timeout);
  session.queue_abandon_timeout = setTimeout(() => killSession(uuid, "queue_abandoned"), 60000);
  if (session.state === "finished_queue") return res.json({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
  try {
    const pos = await doPollQueue(session, session.queue_id);
    if (pos === 0) {
      const serverData = await doClaimGame(session, session.queue_id);
      applyServerData(session, serverData);
      session.state = "finished_queue"; session.finished_queue_at = Date.now();
      clearTimeout(session.queue_abandon_timeout);
      session.startgame_timeout = setTimeout(() => killSession(uuid, "startgame_timeout"), 30000);
      return res.json({ status: "finished_queue", uuid, fetch_this_within_30s_or_terminate: "/cloud/v1/startGame" });
    }
    return res.json({ status: "queue", queue_pos: pos });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
app.post("/cloud/v1/startGame", auth, (req, res) => {
  const { uuid } = req.body; if (!uuid) return res.status(400).json({ error: "Missing uuid." });
  const session = sessions.get(uuid); if (!session) return res.status(404).json({ error: "Not found." });
  if (session.api_key !== req.apiKey) return res.status(403).json({ error: "Forbidden." });
  if (session.state !== "finished_queue") return res.status(400).json({ error: `Session is '${session.state}'` });
  clearTimeout(session.startgame_timeout); clearTimeout(session.queue_abandon_timeout);
  session.state = "active"; session.game_started_at = Date.now();
  resetPingTimeout(uuid);
  session.session_timeout = setTimeout(() => killSession(uuid, "max_session_length"), session.max_session_seconds * 1000);
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, ...(session.turns || []).map((t) => ({ urls: t.turn_url, username: t.turn_user, credential: t.turn_password }))];
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const signalingWs = `${proto === "https" ? "wss" : "ws"}://${req.headers.host}/cloud/v1/signal/${uuid}`;
  session.embed_ice_servers = iceServers; session.embed_signaling_ws = signalingWs;
  session.costInterval = setInterval(() => doCost(session), 25000);
  res.json({ ice_servers: iceServers, signaling_ws: signalingWs, max_seconds: session.max_session_seconds });
  console.log(`startGame ${session.game_key} → ${uuid.slice(0, 8)}`);
  connectRaccoonSignaling(session);
});
app.post("/cloud/v1/pingSession", auth, (req, res) => {
  const { uuid } = req.body; if (!uuid) return res.status(400).json({ error: "Missing uuid." });
  const session = sessions.get(uuid); if (!session) return res.status(404).json({ error: "Not found." });
  if (session.api_key !== req.apiKey) return res.status(403).json({ error: "Forbidden." });
  if (session.state !== "active") return res.status(400).json({ error: "Not active." });
  const now = Date.now();
  if (session.last_ping_at && now - session.last_ping_at < 3000) return res.status(429).json({ error: "Ping every 3s max." });
  session.last_ping_at = now; resetPingTimeout(uuid);
  const usage = getUsageStats(req.apiKey);
  const timeUsed = Math.floor((now - session.game_started_at) / 1000);
  res.json({ session_time_used_seconds: timeUsed, session_time_limit_seconds: session.max_session_seconds, quota: { minute: { used: usage.perMin, limit: req.site.limits.per_minute }, hour: { used: usage.perHour, limit: req.site.limits.per_hour }, day: { used: usage.perDay, limit: req.site.limits.per_day }, month: { used: usage.perMonth, limit: req.site.limits.per_month } } });
});
app.post("/cloud/v1/quitSession", auth, (req, res) => {
  const { uuid } = req.body; if (!uuid) return res.status(400).json({ error: "Missing uuid." });
  const session = sessions.get(uuid); if (!session) return res.status(404).json({ error: "Not found." });
  if (session.api_key !== req.apiKey) return res.status(403).json({ error: "Forbidden." });
  killSession(uuid, "quit_requested"); res.json({ status: "ok" });
});
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  const match = req.url.match(/^\/cloud\/v1\/signal\/([0-9a-f-]{36})$/i);
  if (!match) { socket.destroy(); return; }
  const uuid = match[1]; const session = sessions.get(uuid);
  if (!session || session.state !== "active") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.clientWs = ws;
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const rws = session.raccoonWs;
      if (!rws || rws.readyState !== WebSocket.OPEN) return;
      if (msg.type === "rtc_offer" && msg.sdp) { rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { sdp: msg.sdp, type: "offer" } })); }
      else if (msg.type === "rtc_candidate" && msg.candidate) { rws.send(JSON.stringify({ id: "rtc_sdp", from: session.sn, to: session.gl_key, body: { type: "candidate", sdp: msg.candidate } })); }
    });
    ws.on("close", () => {
      session.clientWs = undefined;
      // The game can't continue without signaling — drop the session promptly
      // instead of waiting for the ping timeout.
      if (sessions.get(uuid)) killSession(uuid, "client_ws_closed");
    });
    ws.on("error", () => { console.log("client ws error"); });
  });
});
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [ip, timestamps] of ipLimits.entries()) { const recent = timestamps.filter((t) => t > cutoff); if (recent.length === 0) ipLimits.delete(ip); else ipLimits.set(ip, recent); }
  for (const [ip, timestamps] of embedIpLimits.entries()) { const recent = timestamps.filter((t) => t > cutoff); if (recent.length === 0) embedIpLimits.delete(ip); else embedIpLimits.set(ip, recent); }
}, 60000);
httpServer.listen(PORT, () => {
  console.log("");
  console.log(" 🔌 GhostCloud API server");
  console.log("");
  console.log(" port      " + PORT);
  console.log(" sites     " + Object.keys(sites.sites).join(", "));
  console.log(" pool      " + POOL_TARGET + " accounts");
  console.log("");
  fillPool().catch(() => {});
});