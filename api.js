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
// Parse a response body as JSON with a friendly failure message. When the mail
// or game provider is throttling (that's exactly what happens under load) they
// return EMPTY bodies, and the old `res.json()` produced the cryptic
// "Unexpected end of JSON input" that players were seeing. This surfaces a
// message both the player and the Render logs can actually read.
async function parseJson(res, what) {
  // A non-2xx is almost always the provider throttling THIS instance's IP
  // (429) or blocking it (403) — surface the status so Render logs tell us
  // exactly which case we're in instead of a vague message.
  if (!res.ok) {
    // 5xx = the provider itself is sick (gateway outage) — not this instance's IP.
    // 4xx = this instance's IP is throttled (429) or blocked (403) by the provider.
    if (res.status >= 500) throw new Error(`${what} is briefly unavailable right now (HTTP ${res.status}) — try again in a moment.`);
    throw new Error(`${what} is at capacity right now (HTTP ${res.status}) — please try again in a moment.`);
  }
  const text = await res.text();
  if (!text) throw new Error(`${what} is under heavy load right now and sent no response — try again in a moment.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${what} sent an invalid response — try again in a moment.`); }
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
// ── Mail lanes ──────────────────────────────────────────────────────────────
// Raccoon is actively blocking disposable-mail DOMAINS: it now answers
// {"status":400,"msg":"Temporary email addresses are not supported."} for the
// domains it knows, and silently drops mail for ones it half-knows. So the mail
// layer is a set of LANES, each one an independent way to get a mailbox we can
// read a code from, tried in order of proven reliability:
//   1. own-domain   (GHOSTCLOUD_MAIL_DOMAIN) — a real domain you own that a
//      Cloudflare Email Worker pushes straight into this API. Nothing to block
//      in advance and no polling, so this is the durable lane.
//   2. tempmail.lol — free, no API key, hands out ROTATING SUB-DOMAINS, which
//      makes blocklisting much harder. Verified delivering (full register+login).
//   3. mail.tm-shaped bases (mail.gw, duckmail, mirrors) — mostly blocked now,
//      kept as fallback and skipped automatically once their domains are known
//      dead.
//   GHOSTCLOUD_MAIL_PROVIDERS="https://api.duckmail.sbs,https://api.mail.gw"
const MAIL_PROVIDERS = (process.env.GHOSTCLOUD_MAIL_PROVIDERS || "https://api.duckmail.sbs,https://api.mail.gw")
  .split(",").map((s) => s.trim()).filter(Boolean);
// A domain Raccoon rejects is dead forever — remember it so we never burn 50s
// waiting for mail that will never arrive.
const blockedMailDomains = new Set();
function isTempBlockedMessage(msg) {
  return /temporary email|not supported|disposable/i.test(String(msg || ""));
}
function markDomainBlocked(email, why) {
  const dom = String(email || "").split("@")[1];
  if (!dom || !isTempBlockedMessage(why) || blockedMailDomains.has(dom)) return;
  blockedMailDomains.add(dom);
  console.log(`mail domain rejected by Raccoon (${why.trim()}) — ${dom} added to blocklist`);
}
// Raccoon replies HTTP 200 but puts a non-200 status in the body when it
// refuses an address. Returns the message when refused, else null.
function raccoonRejectedMail(data) {
  if (!data || typeof data !== "object") return null;
  if (data.status === 200 || data.status === 201) return null;
  return String(data.msg || JSON.stringify(data).slice(0, 140));
}
const providerHealth = new Map(); // lane id -> { fails, skipUntil }
const providerStats = new Map();  // lane id -> { ok, fail, lastErr, lastAt }
function noteProviderOk(base) {
  const wasSkipped = (providerHealth.get(base) || {}).skipUntil > Date.now();
  providerHealth.delete(base);
  if (wasSkipped) console.log(`mail provider ${base} healthy again — back in rotation`);
  const st = providerStats.get(base) || { ok: 0, fail: 0, lastErr: null, lastAt: null };
  st.ok += 1; st.lastErr = null; st.lastAt = Date.now();
  providerStats.set(base, st);
}
function noteProviderFail(base, err) {
  const h = providerHealth.get(base) || { fails: 0, skipUntil: 0 };
  h.fails += 1;
  if (h.fails >= 3) { h.skipUntil = Date.now() + 5 * 60000; h.fails = 0; console.log(`mail provider ${base} failing — skipping for 5 min`); }
  providerHealth.set(base, h);
  const st = providerStats.get(base) || { ok: 0, fail: 0, lastErr: null, lastAt: null };
  st.fail += 1; st.lastErr = err ? err.message : null; st.lastAt = Date.now();
  providerStats.set(base, st);
}
// One compact line so you can see which mail lane is carrying the site at a
// glance (and whether any lane is being skipped for 5 min).
// Codes pushed in by the own-domain lane's Email Worker (address -> {code, at}).
const inboundCodes = new Map();

// tempmail.lol — free tier needs no API key and every inbox gets its own random
// sub-domain (e.g. ryon94d165@rd.prominentghost.com), so one blocked sub-domain
// doesn't kill the lane. Verified end-to-end against Raccoon.
const TEMPMAILLOL_ENABLED = process.env.GHOSTCLOUD_TEMPMAILLOL !== "off";
const tempmailLolLane = {
  id: "tempmail.lol",
  async create() {
    const r = await fetchWithTimeout("https://api.tempmail.lol/v2/inbox/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 15000);
    if (r.status === 429) throw new Error("tempmail.lol is rate limiting (HTTP 429)");
    const d = await parseJson(r, "Account service");
    if (!d.address || !d.token) throw new Error("tempmail.lol returned no mailbox");
    return { email: d.address, handle: { lane: "tempmail.lol", mailToken: d.token } };
  },
  async read(handle) {
    const r = await fetchWithTimeout(`https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(handle.mailToken)}`, {}, 15000);
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    for (const m of d?.emails || []) {
      const match = String(m.body || m.html || "").replace(/<[^>]*>/g, " ").match(/\b\d{6}\b/);
      if (match) return match[0];
    }
    return null;
  },
};

// Own-domain lane: any address @GHOSTCLOUD_MAIL_DOMAIN is valid mail because the
// domain's MX points at Cloudflare Email Routing, which forwards each message to
// the Email Worker, which POSTs the code to /cloud/v1/inbound. Push, not poll —
// the code is usually here before we even ask for it.
const MAIL_DOMAIN = (process.env.GHOSTCLOUD_MAIL_DOMAIN || "").trim().toLowerCase();
const domainLane = MAIL_DOMAIN ? {
  id: `${MAIL_DOMAIN} (own domain)`,
  async create() {
    const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${MAIL_DOMAIN}`;
    return { email, handle: { lane: "domain", email } };
  },
  async read(handle) {
    const hit = inboundCodes.get(String(handle.email || "").toLowerCase());
    return hit ? hit.code : null;
  },
} : null;

// mail.tm-shaped provider (mail.gw, duckmail, mirrors). Skips itself once every
// domain it offers is known-blocked, so it stays cheap in the rotation.
function mailtmLane(base) {
  const id = base.replace(/^https?:\/\//, "");
  return {
    id, base,
    async create() {
      const domainData = await parseJson(await fetchWithTimeout(`${base}/domains`), "Account service");
      const domains = (domainData["hydra:member"] || []).map((d) => d.domain).filter((d) => d && !blockedMailDomains.has(d));
      if (!domains.length) throw new Error(blockedMailDomains.size ? "all of its domains are blocklisted by Raccoon" : "No mail domains available");
      const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${domains[0]}`;
      const mailPassword = generatePassword();
      await fetchWithTimeout(`${base}/accounts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) });
      const { token: mailJwt } = await parseJson(await fetchWithTimeout(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: email, password: mailPassword }) }), "Account service");
      return { email, handle: { lane: "mailtm", base, mailJwt } };
    },
    async read(handle) {
      const headers = { Authorization: `Bearer ${handle.mailJwt}`, "Content-Type": "application/json" };
      const data = await parseJson(await fetchWithTimeout(`${base}/messages?page=1`, { headers }), "Mail service");
      if (!data["hydra:member"]?.length) return null;
      const msgId = data["hydra:member"][0].id;
      const full = await parseJson(await fetchWithTimeout(`${base}/messages/${msgId}`, { headers }), "Mail service");
      const body = [full.text, ...(Array.isArray(full.html) ? full.html : [full.html])].filter(Boolean).join("\n");
      const match = body.replace(/<[^>]*>/g, "").match(/\b\d{6}\b/);
      return match ? match[0] : null;
    },
  };
}

// All lanes in priority order (durable/fastest first).
function allLanes() {
  const lanes = [];
  if (domainLane) lanes.push(domainLane);
  if (TEMPMAILLOL_ENABLED) lanes.push(tempmailLolLane);
  MAIL_PROVIDERS.forEach((b) => lanes.push(mailtmLane(b)));
  return lanes;
}
// Lanes that aren't currently skipped. If EVERY lane is marked down, fall back
// to trying them all (better than nothing).
function laneOrder() {
  const now = Date.now();
  const all = allLanes();
  const healthy = all.filter((l) => { const h = providerHealth.get(l.id); return !h || h.skipUntil <= now; });
  return healthy.length > 0 ? healthy : all;
}
function laneById(id) { return allLanes().find((l) => l.id === id) || null; }
function providerDashboard() {
  const parts = allLanes().map((l) => {
    const st = providerStats.get(l.id);
    const h = providerHealth.get(l.id);
    const skipped = h && h.skipUntil > Date.now() ? " (skipped)" : "";
    return `${l.id} ok=${st?.ok ?? 0} fail=${st?.fail ?? 0}${skipped}`;
  });
  const blocked = blockedMailDomains.size ? ` | raccoon-blocked domains: ${[...blockedMailDomains].join(",")}` : "";
  return `providers: ${parts.join(" | ")} | pool ${pool.length}/${POOL_TARGET}${blocked}`;
}
// Poll one lane for the code. The first read is immediate so a push-based lane
// (own domain) returns without waiting a single tick.
async function pollCode(lane, handle, maxRetries = 17) {
  for (let i = 0; i < maxRetries; i++) {
    try { const c = await lane.read(handle); if (c) return c; } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}
// Warm pool size. Tunable via GHOSTCLOUD_POOL_TARGET (default 10) — drop it to
// 4-5 while the mail provider is throttling this IP, raise it when things are
// healthy. Each account in the pool is one registration already banked.
const POOL_TARGET = Math.min(Math.max(parseInt(process.env.GHOSTCLOUD_POOL_TARGET || "10", 10) || 10, 3), 20);
const pool = [];
let poolFilling = false;
async function fillPool() {
  if (poolFilling) return;
  const needed = POOL_TARGET - pool.length;
  if (needed <= 0) return;
  poolFilling = true;
  try {
    let errors = 0;
    for (let i = 0; i < needed; i++) {
      try { const acc = await createAccountRaw(); pool.push(acc); errors = 0; console.log(`pool: ready (${pool.length}/${POOL_TARGET})`); }
      catch (e) { console.log(`pool: fill error — ${e.message}`); if (++errors >= 3) break; await new Promise((r) => setTimeout(r, 3000)); }
    }
  } finally { poolFilling = false; }
}
async function createAccount() {
  if (pool.length > 0) { const acc = pool.shift(); console.log(`pool: served (${pool.length} left)`); fillPool().catch(() => {}); return acc; }
  const acc = await createAccountRaw(); fillPool().catch(() => {}); return acc;
}
async function createAccountRaw() {
  // Try each lane in order. Two failure shapes worth short-circuiting:
  //  - Raccoon answers "Temporary email addresses are not supported." → that
  //    domain is blocklisted, so remember it and rotate INSTANTLY instead of
  //    polling ~50s for mail that will never arrive.
  //  - The code simply never arrives (silent drop). Raccoon's sendEmail is
  //    occasionally flaky, so we ask up to twice per mailbox before giving up;
  //    a lane that keeps failing is skipped for 5 min by the health tracker.
  // Whole-pass retries: a sick lane (5xx, e.g. a gateway outage) usually
  // recovers within a minute, so retry the full pass with backoff before
  // surfacing an error to the player.
  const passBackoffMs = [3000, 8000, 20000];
  let lastErr = null;
  for (let pass = 0; pass <= passBackoffMs.length; pass++) {
    for (const lane of laneOrder()) {
      try {
        const { email, handle } = await lane.create();
        if (blockedMailDomains.has(String(email).split("@")[1])) continue;
        const raccoonPassword = generatePassword();
        const sn = generateSN();
        const h = { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36" };
        const common = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web" };
        let code = null;
        let rejected = null;
        for (let attempt = 0; attempt < 2 && !code && !rejected; attempt++) {
          const seRes = await raccoonFetch("/users/sendEmail", { method: "POST", headers: h, body: new URLSearchParams({ email, type: "register", ...common }) });
          rejected = raccoonRejectedMail(await seRes.json().catch(() => null));
          if (rejected) break; // refused outright — don't wait for mail
          code = await pollCode(lane, handle, 17); // ~50s worst case per attempt
        }
        if (rejected) {
          markDomainBlocked(email, rejected);
          noteProviderFail(lane.id, new Error(rejected));
          lastErr = new Error(`Raccoon refused ${email.split("@")[1]}: ${rejected}`);
          continue;
        }
        if (!code) { lastErr = new Error(`no verification code from ${lane.id}`); noteProviderFail(lane.id, lastErr); continue; }
        const regRes = await raccoonFetch("/users/emailRegister", { method: "POST", headers: h, body: new URLSearchParams({ email, code, password: raccoonPassword, phone: "1", country: "Brazil", ...common }) });
        const regRejected = raccoonRejectedMail(await regRes.json().catch(() => null));
        if (regRejected) {
          // Registration refused — a blocklisted domain looks exactly like this,
          // so retire the domain and rotate rather than fail the player.
          markDomainBlocked(email, regRejected);
          throw new Error(`register refused: ${regRejected}`);
        }
        const loginRes = await raccoonFetch("/users/emailLogin", { method: "POST", headers: h, body: new URLSearchParams({ email, password: raccoonPassword, ...common }) });
        const loginData = await parseJson(loginRes, "Raccoon login");
        if (loginData.status !== 200 && loginData.status !== 201) { noteProviderFail(lane.id, new Error("Login failed")); throw new Error(`Login failed: ${loginData.msg || loginData.status}`); }
        let userToken = loginData.data?.user_token || "";
        const cookie = loginRes.headers.get("set-cookie");
        if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
        if (!userToken) { noteProviderFail(lane.id, new Error("No user token")); throw new Error("Login returned no user token"); }
        noteProviderOk(lane.id);
        return { sn, token: userToken };
      } catch (e) {
        lastErr = e;
        noteProviderFail(lane.id, e);
      }
    }
    if (pass < passBackoffMs.length) {
      console.log(`account creation failed (${lastErr ? lastErr.message : "every mail lane is blocklisted"}) — retrying in ${passBackoffMs[pass] / 1000}s`);
      await new Promise((r) => setTimeout(r, passBackoffMs[pass]));
    }
  }
  throw lastErr || new Error("Account creation failed on all providers");
}
function gameHeaders(token) {
  return { accept: "*/*", "content-type": "application/x-www-form-urlencoded; charset=UTF-8", cookie: `as_user_token=${token}`, origin: "https://www.raccoongame.com", referer: "https://www.raccoongame.com/?t=1720436119", "user-agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36", "x-requested-with": "XMLHttpRequest" };
}
async function doInitGame(session) {
  const { sn, token, game_key } = session;
  const h = gameHeaders(token);
  const common = { sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", user_token: token };
  try {
    const costRes = await raccoonFetch("/userGame/checkCost", { method: "POST", headers: h, body: new URLSearchParams({ ...common, game_key }) });
    const costData = await costRes.json().catch(() => null);
    if (costData && costData.status !== 200) console.log(`checkCost ${game_key}: ${JSON.stringify(costData).slice(0, 200)}`);
  } catch {}
  const playData = await parseJson(await raccoonFetch("/jyapi/playGame", { method: "POST", headers: h, body: new URLSearchParams({ ...common, game_key, model_name: "Chrome/147.0.0.0" }) }), "Game service");
  // Raccoon status 3004 = account has no diamonds/credits for this game
  if (playData.status === 3004 || String(playData.msg || "").toLowerCase().includes("diamond")) {
    const err = new Error("This game needs play credits the temporary account doesn't have — try again in a moment or pick another game.");
    err.isDiamondError = true;
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
  const d = await parseJson(await raccoonFetch("/jyapi/playQueue", { method: "POST", headers: gameHeaders(token), body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", play_queue_id: queue_id, user_token: token }) }), "Game queue");
  if (d.status !== 200 && d.status !== 201) throw new Error(`Queue poll rejected: ${JSON.stringify(d)}`);
  return d.data?.queue_pos ?? 1;
}
async function doClaimGame(session, queue_id) {
  const { sn, token, game_key } = session;
  const d = await parseJson(await raccoonFetch("/jyapi/playGame", { method: "POST", headers: gameHeaders(token), body: new URLSearchParams({ sn, model: "Chrome/147.0.0.0", version_code: "1", version_name: "1.0.0", device_name: "GhostCloud", os: "web", "manufacturer;": "", game_key, model_name: "Chrome/147.0.0.0", play_queue_id: queue_id, user_token: token }) }), "Game service");
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
  drainCapacityQueue(); // a slot freed — start the next player in line
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
  // Opt-in escape hatch for fresh/custom domains (best answer to site blockers):
  // when a site sets allow_all_origins: true, ANY browser origin is accepted.
  if (site.allow_all_origins === true) return true;
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
// Diagnostic: shows EXACTLY how the mail provider responds to THIS instance's
// IP (429 = throttled, 403 = blocked, 200 + empty body = throttled, timeout =
// unreachable). Open it in a browser:
//   https://<your-service>.onrender.com/cloud/v1/diagMail?api_key=sk_live_local_dev_key_12345
app.get("/cloud/v1/diagMail", auth, async (req, res) => {
  const out = { provider: MAIL_PROVIDERS[0], note: "", domains: null };
  try {
    const t0 = Date.now();
    const r = await fetchWithTimeout(`${MAIL_PROVIDERS[0]}/domains`, {}, 15000);
    const text = await r.text();
    out.domains = { status: r.status, ms: Date.now() - t0, body_len: text.length, body_head: text.slice(0, 120) };
    if (r.status === 429) out.note = "THROTTLED — the IP is rate-limited. May clear on its own in hours; redeploy to try a fresh IP.";
    else if (r.status === 403) out.note = "BLOCKED — mail.gw refuses this IP outright. Redeploys won't help if the whole range is blocked.";
    else if (r.ok && text.length === 0) out.note = "THROTTLED — 200 with empty body. Same as 429, just uglier.";
    else if (r.ok) out.note = "HEALTHY — this instance's IP can reach the mail provider.";
  } catch (e) { out.domains = { error: e.message }; out.note = "UNREACHABLE — connection-level failure to the mail provider."; }
  res.json(out);
});

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

// Create a mailbox for the manual-login path. The handle it returns is opaque:
// the client hands it straight back to /getCode, so whichever lane created the
// mailbox is also the lane that reads it.
async function createMailbox() {
  let lastErr = null;
  for (const lane of laneOrder()) {
    try { const { email, handle } = await lane.create(); return { email, ...handle }; }
    catch (e) { lastErr = e; noteProviderFail(lane.id, e); }
  }
  throw lastErr || new Error("No mail provider available");
}

app.post("/cloud/v1/createMailbox", auth, async (req, res) => {
  try { res.json(await createMailbox()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Single-poll read of the newest message's 6-digit code from a mailbox.
app.post("/cloud/v1/getCode", auth, async (req, res) => {
  const body = req.body || {};
  let lane = null;
  if (body.lane === "tempmail.lol" && body.mailToken) {
    lane = tempmailLolLane;
  } else if (body.lane === "domain" && body.email && domainLane) {
    lane = domainLane;
  } else if (body.lane === "mailtm" || (!body.lane && body.mailJwt)) {
    const base = typeof body.base === "string" && MAIL_PROVIDERS.includes(body.base) ? body.base : MAIL_PROVIDERS[0];
    lane = mailtmLane(base);
    body.base = base; // fall back to the primary if the client didn't say which
  }
  if (!lane) return res.status(400).json({ error: "Missing mailbox handle." });
  try { res.json({ code: await lane.read(body) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inbound mail webhook (own-domain lane) ──────────────────────────────────
// The Cloudflare Email Worker POSTs every message that lands on
// GHOSTCLOUD_MAIL_DOMAIN here, so account creation never has to poll. Guarded
// by GHOSTCLOUD_INBOUND_KEY — the Worker sends it in x-ghostcloud-key.
const INBOUND_KEY = process.env.GHOSTCLOUD_INBOUND_KEY || "";
app.post("/cloud/v1/inbound", (req, res) => {
  if (!INBOUND_KEY) return res.status(503).json({ error: "Inbound mail is not configured on this server." });
  const key = req.get("x-ghostcloud-key") || req.query.key;
  if (key !== INBOUND_KEY) return res.status(401).json({ error: "Bad inbound key." });
  const to = String(req.body?.to || "").trim().toLowerCase();
  const text = `${req.body?.subject || ""} ${req.body?.text || ""} ${req.body?.html || ""}`.replace(/<[^>]*>/g, " ");
  const match = text.match(/\b\d{6}\b/);
  if (to && match) {
    inboundCodes.set(to, { code: match[0], at: Date.now() });
    console.log(`inboundMail ${to} → code received`);
  } else {
    console.log(`inboundMail ${to || "(no recipient)"} → no code found`);
  }
  // Keep the map tiny — these are only read within a minute of arriving.
  if (inboundCodes.size > 500) {
    for (const [k, v] of inboundCodes) if (Date.now() - v.at > 30 * 60000) inboundCodes.delete(k);
  }
  res.json({ ok: true, stored: Boolean(to && match) });
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
    const loginData = await parseJson(loginRes, "Raccoon login");
    if (loginData.status !== 200) throw new Error("Login failed");
    let userToken = loginData.data?.user_token || "";
    const cookie = loginRes.headers.get("set-cookie");
    if (cookie) { const m = cookie.match(/as_user_token=([^;]+)/); if (m) userToken = m[1]; }
    if (!userToken) throw new Error("No user token returned");
    res.json({ sn, token: userToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ---- Server-capacity queue -------------------------------------------------
// When the concurrent-session cap is reached we DON'T reject the player with
// an error. They enter a FIFO line (live capacity_queue status + position) and
// their session starts automatically the moment a slot frees. killSession() is
// the single place sessions die, so it is the drain point.
const capacityWaiters = []; // FIFO of { req, res, apiKey, site, game_key, manualAccount, enqueuedAt, ended, push }
function enqueueCapacityWaiter(req, res, ctx) {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
  }
  const waiter = { ...ctx, enqueuedAt: Date.now(), ended: false };
  waiter.push = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
  res.on("close", () => {
    if (waiter.ended) return;
    waiter.ended = true; // player closed / cancelled while waiting in line - drop them
    const idx = capacityWaiters.indexOf(waiter);
    if (idx >= 0) capacityWaiters.splice(idx, 1);
  });
  capacityWaiters.push(waiter);
  broadcastCapacityQueue(); // immediate first position event so the client shows the line
  return waiter;
}
function broadcastCapacityQueue() {
  const now = Date.now();
  for (let i = 0; i < capacityWaiters.length; i++) {
    const w = capacityWaiters[i];
    if (w.ended) continue;
    w.push({ status: "capacity_queue", position: i + 1, waited_seconds: Math.floor((now - w.enqueuedAt) / 1000) });
  }
}
function drainCapacityQueue() {
  for (;;) {
    const w = capacityWaiters.find((x) => !x.ended);
    if (!w) break;
    if (countActiveSessions(w.apiKey) >= w.site.max_concurrent_sessions) break;
    capacityWaiters.splice(capacityWaiters.indexOf(w), 1);
    w.ended = true;
    w.push({ status: "slot_reserved" }); // stream continues straight into the normal create flow
    runCreateSessionFlow(w.req, w.res, w);
  }
}
// Keep line positions fresh every 4s while players wait.
setInterval(broadcastCapacityQueue, 4000);

app.post("/cloud/v1/createSession", auth, async (req, res) => {
  const { game_key, account } = req.body;
  if (!game_key || typeof game_key !== "string" || game_key.length > 256) return res.status(400).json({ error: "Invalid game_key." });
  const manualAccount = account && typeof account.sn === "string" && typeof account.token === "string" && account.sn && account.token ? account : null;
  const { site, apiKey } = req;
  // No free slot -> join the line instead of a "server busy" error. The game
  // starts automatically the moment a slot frees (drainCapacityQueue).
  if (countActiveSessions(apiKey) >= site.max_concurrent_sessions) {
    enqueueCapacityWaiter(req, res, { apiKey, site, game_key, manualAccount });
    return;
  }
  runCreateSessionFlow(req, res, { apiKey, site, game_key, manualAccount });
});

async function runCreateSessionFlow(req, res, ctx) {
  const { apiKey, site, game_key, manualAccount } = ctx;
  const rl = checkRateLimit(apiKey, site);
  if (!rl.allowed) {
    if (res.headersSent) { res.write(JSON.stringify({ status: "error", error: `Rate limit: ${rl.reason}` }) + "\n"); res.end(); return; }
    return res.status(429).json({ error: `Rate limit: ${rl.reason}` });
  }
  if (!manualAccount && !acquireAccountSlot(apiKey, site)) {
    if (res.headersSent) { res.write(JSON.stringify({ status: "error", error: "Too many sessions being created." }) + "\n"); res.end(); return; }
    return res.status(429).json({ error: "Too many sessions being created." });
  }
  if (!res.headersSent) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
  }
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
      acc = await createAccount(); releaseAccountSlot(apiKey);
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
  } catch (e) { if (!manualAccount) releaseAccountSlot(apiKey); push({ status: "error", error: e.message }); killSession(uuid, "creation_error"); }
  streamEnded = true;
  res.end();
}
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
// Background refill: if the pool runs dry (provider outage, burst), keep
// topping it up so it self-heals the moment the provider recovers — players
// don't have to eat the per-account creation wait after an outage.
setInterval(() => { fillPool().catch(() => {}); }, 20000);
// Provider dashboard: one line at boot, then every 5 min — which mail lane is
// carrying the site, per-lane ok/fail counts, and whether any lane is skipped.
console.log(providerDashboard());
setInterval(() => console.log(providerDashboard()), 5 * 60000);

httpServer.listen(PORT, () => {
  console.log("");
  console.log(" 🔌 GhostCloud API server");
  console.log("");
  console.log(" port      " + PORT);
  console.log(" sites     " + Object.keys(sites.sites).join(", "));
  console.log(" pool      " + POOL_TARGET + " accounts");
  console.log(" mail      " + allLanes().map((l) => l.id).join(", "));
  console.log("");
  fillPool().catch(() => {});
});