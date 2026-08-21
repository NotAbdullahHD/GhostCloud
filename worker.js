// GhostCloud API — Cloudflare Worker + Durable Object
// Static-only equivalent of the Node `api/api.js` for serverless hosting.

import { WebSocketPair } from "cloudflare:sockets";

const API_KEY = "sk_live_local_dev_key_12345";
const RACCOON = "https://www.raccoongame.com";
const MAIL_BASE = "https://api.mail.gw";
const MAX_SESSION_SECONDS = 19 * 60;

const REGISTER_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36",
};

// ── helpers ─────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function generateSN() {
  return crypto.randomUUID().replace(/-/g, "");
}

function generatePassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$";
  let p = "";
  for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

function registerBase(sn) {
  return {
    sn,
    model: "Chrome/147.0.0.0",
    version_code: "1",
    version_name: "1.0.0",
    device_name: "GhostCloud",
    os: "web",
  };
}

function gameHeaders(token) {
  return {
    accept: "*/*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    cookie: `as_user_token=${token}`,
    origin: "https://www.raccoongame.com",
    referer: "https://www.raccoongame.com/?t=1720436119",
    "user-agent": "Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
  };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Node's createDecipheriv("aes-256-cbc", key, iv) → Web Crypto.
async function decryptPayload(result) {
  const keyBytes = new TextEncoder().encode("fd39e724f7c1e4b3d34bc7c72b5349c3");
  const ivBytes = new TextEncoder().encode("dd39e4a3337fe25a");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    key,
    base64ToBytes(result),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function fetchTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── mail / account ──────────────────────────────────────────
async function createMailbox() {
  const domainData = await (await fetchTimeout(`${MAIL_BASE}/domains`)).json();
  const domain = domainData["hydra:member"]?.[0]?.domain;
  if (!domain) throw new Error("No mail domains available");
  const email = `rcn_${Math.random().toString(36).substring(2, 11)}@${domain}`;
  const mailPassword = generatePassword();
  await fetchTimeout(`${MAIL_BASE}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: email, password: mailPassword }),
  });
  const tokenRes = await fetchTimeout(`${MAIL_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: email, password: mailPassword }),
  });
  const { token: mailJwt } = await tokenRes.json();
  return { email, mailJwt };
}

// Single-poll read of the newest 6-digit code in a mailbox.
async function readCode(mailJwt) {
  const headers = { Authorization: `Bearer ${mailJwt}`, "Content-Type": "application/json" };
  const r = await fetchTimeout(`${MAIL_BASE}/messages?page=1`, { headers });
  const data = await r.json();
  if (data["hydra:member"]?.length > 0) {
    const msgId = data["hydra:member"][0].id;
    const full = await (await fetchTimeout(`${MAIL_BASE}/messages/${msgId}`, { headers })).json();
    const match = (full.text || full.html || "").replace(/<[^>]*>/g, "").match(/\b\d{6}\b/);
    return match ? match[0] : null;
  }
  return null;
}

async function pollCode(mailJwt, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const code = await readCode(mailJwt).catch(() => null);
    if (code) return code;
  }
  throw new Error("Timeout getting verification code");
}

// Fully automated account creation (used when no manual account is saved).
async function createAccountRaw() {
  const { email, mailJwt } = await createMailbox();
  const raccoonPassword = generatePassword();
  const sn = generateSN();
  const base = registerBase(sn);
  await fetchTimeout(`${RACCOON}/users/sendEmail`, {
    method: "POST",
    headers: REGISTER_HEADERS,
    body: new URLSearchParams({ email, type: "register", ...base }),
  });
  const code = await pollCode(mailJwt);
  await fetchTimeout(`${RACCOON}/users/emailRegister`, {
    method: "POST",
    headers: REGISTER_HEADERS,
    body: new URLSearchParams({ email, code, password: raccoonPassword, phone: "1", country: "Brazil", ...base }),
  });
  const loginRes = await fetchTimeout(`${RACCOON}/users/emailLogin`, {
    method: "POST",
    headers: REGISTER_HEADERS,
    body: new URLSearchParams({ email, password: raccoonPassword, ...base }),
  });
  const loginData = await loginRes.json();
  if (loginData.status !== 200) throw new Error("Login failed");
  let userToken = loginData.data?.user_token || "";
  const cookie = loginRes.headers.get("set-cookie");
  if (cookie) {
    const m = cookie.match(/as_user_token=([^;]+)/);
    if (m) userToken = m[1];
  }
  return { sn, token: userToken };
}

// ── game flow ───────────────────────────────────────────────
function applyServerData(session, sd) {
  session.sc_id = sd.sc_id || sd.play_id;
  session.bs_sc_id = sd.bs_sc_id || session.sc_id;
  session.bs_host = sd.bs_host;
  session.bs_token = sd.token;
  session.channel_id = sd.channel_id;
  session.gl_key = sd.gl_key;
  session.play_config = sd.play_config;
  session.turns = sd.turns || [];
  session.message_server = sd.message_server;
}

async function doInitGame(session) {
  const { sn, token, game_key } = session;
  const h = gameHeaders(token);
  const common = {
    sn,
    model: "Chrome/147.0.0.0",
    version_code: "1",
    version_name: "1.0.0",
    device_name: "GhostCloud",
    os: "web",
    "manufacturer;": "",
    user_token: token,
  };
  await fetchTimeout(`${RACCOON}/userGame/checkCost`, {
    method: "POST",
    headers: h,
    body: new URLSearchParams({ ...common, game_key }),
  });
  const playData = await (
    await fetchTimeout(`${RACCOON}/jyapi/playGame`, {
      method: "POST",
      headers: h,
      body: new URLSearchParams({ ...common, game_key, model_name: "Chrome/147.0.0.0" }),
    })
  ).json();
  if (playData.status === 201 || (playData.status === 200 && playData.data?.play_queue_id)) {
    const qid = playData.data?.play_queue_id;
    if (!qid) throw new Error("Missing queue ID");
    return { queued: true, queue_id: qid, initial_pos: playData.data?.queue_pos };
  }
  if (playData.status === 200 && playData.data?.result) {
    return { queued: false, server_data: await decryptPayload(playData.data.result) };
  }
  throw new Error(`Unexpected playGame response: ${JSON.stringify(playData)}`);
}

async function doPollQueue(session, queueId) {
  const { sn, token } = session;
  const d = await (
    await fetchTimeout(`${RACCOON}/jyapi/playQueue`, {
      method: "POST",
      headers: gameHeaders(token),
      body: new URLSearchParams({
        sn,
        model: "Chrome/147.0.0.0",
        version_code: "1",
        version_name: "1.0.0",
        device_name: "GhostCloud",
        os: "web",
        "manufacturer;": "",
        play_queue_id: queueId,
        user_token: token,
      }),
    })
  ).json();
  if (d.status !== 200 && d.status !== 201) throw new Error(`Queue poll rejected: ${JSON.stringify(d)}`);
  return d.data?.queue_pos ?? 1;
}

async function doClaimGame(session, queueId) {
  const { sn, token, game_key } = session;
  const d = await (
    await fetchTimeout(`${RACCOON}/jyapi/playGame`, {
      method: "POST",
      headers: gameHeaders(token),
      body: new URLSearchParams({
        sn,
        model: "Chrome/147.0.0.0",
        version_code: "1",
        version_name: "1.0.0",
        device_name: "GhostCloud",
        os: "web",
        "manufacturer;": "",
        game_key,
        model_name: "Chrome/147.0.0.0",
        play_queue_id: queueId,
        user_token: token,
      }),
    })
  ).json();
  if (d.status === 200 && d.data?.result) return decryptPayload(d.data.result);
  throw new Error(`Failed to claim game. API Status: ${d.status}`);
}

async function doStopGame(session) {
  if (!session.sc_id || !session.token) return;
  try {
    await fetchTimeout(`${RACCOON}/jyapi/stopGame`, {
      method: "POST",
      headers: gameHeaders(session.token),
      body: new URLSearchParams({
        sn: session.sn,
        model: "Chrome/147.0.0.0",
        version_code: "1",
        version_name: "1.0.0",
        device_name: "GhostCloud",
        os: "web",
        "manufacturer;": "",
        sc_id: String(session.sc_id),
        game_type: "1",
        user_token: session.token,
      }),
    });
  } catch {}
}

// ── stateless endpoints ─────────────────────────────────────
async function handleCreateMailbox() {
  try {
    return json(await createMailbox());
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleSendEmail(request) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return json({ error: "Missing email or password." }, 400);
  const sn = generateSN();
  try {
    const r = await fetchTimeout(`${RACCOON}/users/sendEmail`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: new URLSearchParams({ email, type: "register", ...registerBase(sn) }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.status && data.status !== 200) {
      return json({ error: data.msg || `Raccoon rejected: ${JSON.stringify(data)}` }, 400);
    }
    return json({ sn });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleManualRegister(request) {
  const { sn, email, password, code, phone, country } = await request.json().catch(() => ({}));
  if (!sn || !email || !password || !code) return json({ error: "Missing sn, email, password or code." }, 400);
  const base = registerBase(sn);
  try {
    await fetchTimeout(`${RACCOON}/users/emailRegister`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: new URLSearchParams({ email, code, password, phone: phone || "1", country: country || "Brazil", ...base }),
    });
    const loginRes = await fetchTimeout(`${RACCOON}/users/emailLogin`, {
      method: "POST",
      headers: REGISTER_HEADERS,
      body: new URLSearchParams({ email, password, ...base }),
    });
    const loginData = await loginRes.json();
    if (loginData.status !== 200) throw new Error("Login failed");
    let userToken = loginData.data?.user_token || "";
    const cookie = loginRes.headers.get("set-cookie");
    if (cookie) {
      const m = cookie.match(/as_user_token=([^;]+)/);
      if (m) userToken = m[1];
    }
    if (!userToken) throw new Error("No user token returned");
    return json({ sn, token: userToken });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleGetCode(request) {
  const { mailJwt } = await request.json().catch(() => ({}));
  if (!mailJwt) return json({ error: "Missing mailJwt." }, 400);
  try {
    return json({ code: await readCode(mailJwt) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── Session Durable Object ──────────────────────────────────
export class SessionDO {
  constructor(state) {
    this.state = state;
    this.session = null;
    this.raccoonWs = null;
    this.clientWs = null;
    this.pingInterval = null;
  }

  async load() {
    if (!this.session) this.session = (await this.state.storage.get("session")) || null;
    return this.session;
  }

  async save() {
    await this.state.storage.put("session", this.session);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/cloud/v1/createSession") return this.createSession(request);
    if (path === "/cloud/v1/getQueue") return this.getQueue();
    if (path === "/cloud/v1/startGame") return this.startGame(request);
    if (path === "/cloud/v1/pingSession") return this.ping();
    if (path === "/cloud/v1/quitSession") return this.quit();
    if (path.startsWith("/cloud/v1/signal/")) return this.signal(request);
    return json({ error: "Not found" }, 404);
  }

  async createSession(request) {
    const uuid = request.headers.get("x-session-uuid") || crypto.randomUUID();
    const { game_key, account } = await request.json().catch(() => ({}));
    if (!game_key) return json({ error: "Invalid game_key." }, 400);
    const manualAccount =
      account && typeof account.sn === "string" && typeof account.token === "string" && account.sn && account.token
        ? account
        : null;

    this.session = {
      uuid,
      game_key,
      state: "creating",
      sn: "",
      token: "",
      created_at: Date.now(),
      sc_id: null,
      bs_sc_id: null,
      gl_key: null,
      play_config: null,
      turns: [],
      message_server: null,
      game_started_at: null,
    };
    await this.save();

    try {
      let acc;
      if (manualAccount) {
        acc = manualAccount;
      } else {
        acc = await createAccountRaw();
      }
      this.session.sn = acc.sn;
      this.session.token = acc.token;
      await this.save();

      const init = await doInitGame(this.session);
      if (init.queued) {
        this.session.state = "queued";
        this.session.queue_id = init.queue_id;
        await this.save();
        return json({ status: "queue", uuid, queue_pos: init.initial_pos });
      }
      applyServerData(this.session, init.server_data);
      this.session.state = "finished_queue";
      await this.save();
      return json({ status: "finished_queue", uuid });
    } catch (e) {
      this.session.state = "error";
      await this.save();
      return json({ error: e.message }, 500);
    }
  }

  async getQueue() {
    await this.load();
    if (!this.session) return json({ error: "Not found." }, 404);
    if (this.session.state === "finished_queue") return json({ status: "finished_queue", uuid: this.session.uuid });
    if (this.session.state !== "queued") return json({ error: `Session is '${this.session.state}'` }, 400);
    try {
      const pos = await doPollQueue(this.session, this.session.queue_id);
      if (pos === 0) {
        const sd = await doClaimGame(this.session, this.session.queue_id);
        applyServerData(this.session, sd);
        this.session.state = "finished_queue";
        await this.save();
        return json({ status: "finished_queue", uuid: this.session.uuid });
      }
      return json({ status: "queue", queue_pos: pos });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  async startGame(request) {
    await this.load();
    if (!this.session) return json({ error: "Not found." }, 404);
    if (this.session.state !== "finished_queue") return json({ error: `Session is '${this.session.state}'` }, 400);
    this.session.state = "active";
    this.session.game_started_at = Date.now();
    await this.save();

    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      ...(this.session.turns || []).map((t) => ({ urls: t.turn_url, username: t.turn_user, credential: t.turn_password })),
    ];
    const host = new URL(request.url).host;
    return json({
      ice_servers: iceServers,
      signaling_ws: `wss://${host}/cloud/v1/signal/${this.session.uuid}`,
      max_seconds: MAX_SESSION_SECONDS,
    });
  }

  async ping() {
    await this.load();
    if (!this.session) return json({ error: "Not found." }, 404);
    const timeUsed = this.session.game_started_at ? Math.floor((Date.now() - this.session.game_started_at) / 1000) : 0;
    return json({
      session_time_used_seconds: timeUsed,
      session_time_limit_seconds: MAX_SESSION_SECONDS,
      quota: {},
    });
  }

  async quit() {
    await this.load();
    if (this.session) {
      await doStopGame(this.session).catch(() => {});
      this.cleanup();
    }
    this.session = null;
    await this.state.storage.delete("session");
    return json({ status: "ok" });
  }

  async signal(request) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    await this.load();
    if (!this.session || this.session.state !== "active") {
      return new Response("Session not active", { status: 400 });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();
    this.clientWs = serverSocket;
    this.connectRaccoon(serverSocket);

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  connectRaccoon(clientWs) {
    const s = this.session;
    const raccoonWs = new WebSocket(s.message_server.url);
    this.raccoonWs = raccoonWs;

    const rSend = (p) => {
      if (raccoonWs.readyState === 1) raccoonWs.send(JSON.stringify(p));
    };
    const toClient = (d) => {
      if (clientWs && clientWs.readyState === 1) clientWs.send(JSON.stringify(d));
    };

    raccoonWs.addEventListener("open", () => {
      rSend({
        id: "register",
        type: "webUA",
        uid: s.sn,
        token: decodeURIComponent(s.message_server.token),
      });
      this.pingInterval = setInterval(() => {
        rSend({ id: "ping", uid: s.sn, type: "webUA", status: "gaming", sc_id: s.bs_sc_id });
      }, 30000);
    });

    raccoonWs.addEventListener("message", (ev) => {
      let data;
      try {
        data = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return;
      }
      switch (data.id) {
        case "register_ack":
          if (data.code === 200) {
            rSend({
              id: "start_game",
              from: s.sn,
              to: s.gl_key,
              game_args: "",
              gp_num: 0,
              play_config: s.play_config,
              simpleHandler: null,
              body: {
                force_soft_dec: 0,
                session_id: s.bs_sc_id,
                sn_user_id: s.sn,
                game_name: null,
                joystick_num: 2,
              },
            });
          }
          break;
        case "start_game":
          if (data.from === s.gl_key && data.body?.code === 200) toClient({ type: "game_ready" });
          break;
        case "rtc_sdp": {
          const b = data.body;
          if (!b) break;
          if (b.type === "answer") toClient({ type: "rtc_answer", sdp: b });
          else if (b.type === "candidate" && b.sdp) toClient({ type: "rtc_candidate", candidate: b.sdp });
          break;
        }
      }
    });

    raccoonWs.addEventListener("close", () => {
      clearInterval(this.pingInterval);
      this.raccoonWs = null;
    });
    raccoonWs.addEventListener("error", () => {});

    clientWs.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return;
      }
      if (msg.type === "rtc_offer" && msg.sdp) {
        rSend({ id: "rtc_sdp", from: s.sn, to: s.gl_key, body: { sdp: msg.sdp, type: "offer" } });
      } else if (msg.type === "rtc_candidate" && msg.candidate) {
        rSend({ id: "rtc_sdp", from: s.sn, to: s.gl_key, body: { type: "candidate", sdp: msg.candidate } });
      }
    });

    clientWs.addEventListener("close", () => {
      clearInterval(this.pingInterval);
      try {
        raccoonWs.close();
      } catch {}
      doStopGame(s).catch(() => {});
    });
    clientWs.addEventListener("error", () => {});
  }

  cleanup() {
    clearInterval(this.pingInterval);
    try {
      this.raccoonWs?.close();
    } catch {}
    this.raccoonWs = null;
    this.clientWs = null;
  }
}

// ── main worker ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Signaling WebSocket: browsers cannot set custom headers on WS upgrades,
    // so the un-guessable uuid in the path acts as the capability token.
    const signalMatch = path.match(/^\/cloud\/v1\/signal\/([0-9a-f-]{36})$/i);
    if (signalMatch) {
      const stub = env.SESSION.get(env.SESSION.idFromName(signalMatch[1]));
      return stub.fetch(request);
    }

    // Auth for HTTP endpoints: the frontend sends x-api-key as a header.
    if (request.headers.get("x-api-key") !== API_KEY) {
      return json({ error: "Invalid API key." }, 401);
    }

    // Stateless endpoints
    if (path === "/cloud/v1/createMailbox") return handleCreateMailbox();
    if (path === "/cloud/v1/sendEmail") return handleSendEmail(request);
    if (path === "/cloud/v1/manualRegister") return handleManualRegister(request);
    if (path === "/cloud/v1/getCode") return handleGetCode(request);

    // New session → new Durable Object (uuid is also the DO name)
    if (path === "/cloud/v1/createSession") {
      const uuid = crypto.randomUUID();
      const forwarded = request.clone();
      forwarded.headers.set("x-session-uuid", uuid);
      const stub = env.SESSION.get(env.SESSION.idFromName(uuid));
      return stub.fetch(forwarded);
    }

    // Remaining session endpoints carry uuid in query or body
    let uuid = url.searchParams.get("uuid");
    if (!uuid) {
      try {
        const body = await request.clone().json();
        uuid = body.uuid;
      } catch {}
    }
    if (uuid && ["/cloud/v1/getQueue", "/cloud/v1/startGame", "/cloud/v1/pingSession", "/cloud/v1/quitSession"].includes(path)) {
      const stub = env.SESSION.get(env.SESSION.idFromName(uuid));
      return stub.fetch(request);
    }

    return json({ error: "Not found." }, 404);
  },
};
