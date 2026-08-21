/* ============================================================
   GhostCloud — Game Library + Cloud Gaming Launcher
   GhostCloud-API client: createSession → queue → startGame → WebRTC
   ============================================================ */

// ── Configuration ──────────────────────────────────────────
const CONFIG = {
  apiBase: localStorage.getItem('ghostcloud_api_base') || '/api',
  apiKey: localStorage.getItem('ghostcloud_api_key') || 'sk_live_local_dev_key_12345',
};

const MANUAL_ACCOUNT_KEY = 'ghostcloud_manual_account';

// ── State ──────────────────────────────────────────────────
let GAMES = [];
let currentTag = 'all';
let currentSearch = '';
let currentSession = null; // { uuid, gameKey, interval, pc, ws, isActive, startTime }
let detailGame = null;
let heroIndex = 0;
let heroInterval;
let manualSn = null;
let manualMailJwt = null;

// Fallback games if games.json fails to load (top titles)
const FALLBACK_GAMES = [
  { name:"Red Dead Redemption 2", game_key:"jy0333", description:"The legendary story of Arthur Morgan and the notorious Van der Linde gang.", image:"https://download-oss.raccoongame.com/uploads/image/20260407/20260407165500251.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20260407/20260407165503850.jpg", tags:["3A","Adventure","RPG","Shooting"] },
  { name:"Elden Ring", game_key:"dg0170", description:"Step into vast scenes and explore unknown underground labyrinths.", image:"https://download-oss.raccoongame.com/uploads/image/20260515/2026051516303039.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20260122/20260122010238981.png", tags:["3A","Adventure","Challenge","Action"] },
  { name:"Cyberpunk 2077", game_key:"jy0354", description:"An open world game set in Night City.", image:"https://download-oss.raccoongame.com/uploads/image/20260410/20260410170557349.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20260410/20260410170600406.jpg", tags:["3A","Adventure","Challenge","RPG"] },
  { name:"God of War", game_key:"dg0154", description:"Kratos lives as a mortal in lands stalked by Norse deities.", image:"https://download-oss.raccoongame.com/uploads/image/20250402/20250402141418448.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20250208/20250208161453296.png", tags:["3A","Challenge","Adventure","Action"] },
  { name:"Forza Horizon 5", game_key:"kj0214", description:"Use the Mexican map to expand the exciting carnival.", image:"https://download-oss.raccoongame.com/uploads/image/20260305/20260305115627492.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20260305/20260305115630282.jpg", tags:["Racing"] },
  { name:"GTA V", game_key:"jy0108", description:"Experience entertainment blockbusters Grand Theft Auto V.", image:"https://download-oss.raccoongame.com/uploads/image/20260304/20260304175808508.jpg", cover:"https://download-oss.raccoongame.com/uploads/image/20260304/20260304175815239.jpg", tags:["Challenge","3A","RPG","Action"] },
];

// ── DOM helpers ────────────────────────────────────────────
const $ = id => document.getElementById(id);
const on = (el, ev, fn) => el.addEventListener(ev, fn);

// ── Initialization ─────────────────────────────────────────
async function init() {
  await loadGames();
  if (!GAMES.length) return;
  setupUI();
  renderAll();
  cycleHero();
}

async function loadGames() {
  try {
    const res = await fetch('./games.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    GAMES = await res.json();
    console.log(`Loaded ${GAMES.length} games`);
  } catch (e) {
    console.warn('Failed to load games.json, using fallback:', e.message);
    GAMES = FALLBACK_GAMES;
    $('error-msg').textContent = e.message;
    $('error-state').classList.remove('hidden');
    $('loading-state').classList.add('hidden');
  }
}

function setupUI() {
  // Tag filter chips
  const tags = ['all', ...new Set(GAMES.flatMap(g => g.tags || []))].sort();
  const chipContainer = $('filter-chips');
  tags.forEach(tag => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (tag === 'all' ? ' active' : '');
    chip.dataset.tag = tag;
    chip.textContent = tag === 'all' ? 'All' : tag;
    on(chip, 'click', () => {
      currentTag = tag;
      document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.tag === tag));
      renderGrid();
    });
    chipContainer.appendChild(chip);
  });

  // Search
  on($('search-input'), 'input', () => {
    currentSearch = $('search-input').value.trim().toLowerCase();
    $('search-clear').classList.toggle('hidden', !currentSearch);
    renderGrid();
  });
  on($('search-clear'), 'click', () => {
    $('search-input').value = '';
    currentSearch = '';
    $('search-clear').classList.add('hidden');
    renderGrid();
  });

  // Settings
  on($('settings-btn'), 'click', openSettings);
  on($('settings-form'), 'submit', saveSettings);
  on($('settings-test'), 'click', testConnection);
  on($('manual-send'), 'click', sendEmailCode);
  on($('manual-register'), 'click', registerManualAccount);
  on($('manual-clear'), 'click', clearManualAccount);
  on($('manual-mailbox'), 'click', createTempMailbox);

  // Detail modal close
  on($('detail-modal'), 'click', e => { if (e.target === $('detail-modal')) closeDetail(); });
  on($('detail-modal').querySelector('.modal-close'), 'click', closeDetail);

  // Player close
  on($('player-close'), 'click', closePlayer);
  on($('player-cancel'), 'click', closePlayer);
  on($('player-fullscreen'), 'click', togglePlayerFullscreen);
  bindPlayerInput($('player-video'));

  // Settings modal close
  on($('settings-modal'), 'click', e => { if (e.target === $('settings-modal')) closeSettings(); });
  on($('settings-modal').querySelector('.modal-close'), 'click', closeSettings);

  // Hero play
  on($('hero-play'), 'click', () => GAMES[heroIndex] && openDetail(GAMES[heroIndex]));
  on($('detail-play'), 'click', () => detailGame && playGame(detailGame));

  // Keyboard
  on(document, 'keydown', e => {
    if (e.key === 'Escape') {
      if (!$('player-modal').classList.contains('hidden')) closePlayer();
      else if (!$('detail-modal').classList.contains('hidden')) closeDetail();
      else if (!$('settings-modal').classList.contains('hidden')) closeSettings();
    }
  });

  // API status click → test
  on($('api-status'), 'click', testConnection);

  // Populate settings form
  $('setting-api-base').value = CONFIG.apiBase;
  $('setting-api-key').value = CONFIG.apiKey;
}

// ── Rendering ──────────────────────────────────────────────
function renderAll() {
  $('loading-state').classList.add('hidden');
  $('hero').classList.remove('hidden');
  $('filters').classList.remove('hidden');
  $('game-grid').classList.remove('hidden');

  heroIndex = Math.floor(Math.random() * GAMES.length);
  renderHero(GAMES[heroIndex]);
  renderGrid();
}

function renderHero(game) {
  if (!game) return;
  $('hero-bg').style.backgroundImage = `url(${game.cover || game.image || ''})`;
  $('hero-title').textContent = game.name;
  $('hero-desc').textContent = game.description || '';
  $('hero-tags').innerHTML = (game.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
}

function cycleHero() {
  heroInterval = setInterval(() => {
    heroIndex = (heroIndex + 1) % GAMES.length;
    renderHero(GAMES[heroIndex]);
  }, 8000);
}

function renderGrid() {
  const filtered = GAMES.filter(g => {
    if (currentTag !== 'all' && !(g.tags || []).includes(currentTag)) return false;
    if (currentSearch) {
      const s = currentSearch;
      const match = g.name.toLowerCase().includes(s) || (g.description || '').toLowerCase().includes(s);
      if (!match) return false;
    }
    return true;
  });

  $('result-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'game' : 'games'}`;

  const grid = $('game-grid');
  grid.innerHTML = '<div class="game-grid-inner" id="grid-inner"></div>';
  const inner = grid.querySelector('#grid-inner');
  const emptyEl = document.createElement('div');
  emptyEl.className = 'grid-empty hidden';
  emptyEl.innerHTML = '<i class="fas fa-search"></i><p>No games match your search</p>';
  inner.appendChild(emptyEl);

  if (!filtered.length) {
    emptyEl.classList.remove('hidden');
    return;
  }

  filtered.forEach(game => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      <div class="card-cover-wrap">
        <img class="card-cover" src="${game.image || game.cover || ''}" alt="${game.name}" loading="lazy"
             onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='grid';">
        <div class="card-cover-fallback" style="display:none"><i class="fas fa-gamepad"></i></div>
      </div>
      <div class="card-body">
        <div class="card-name">${game.name}</div>
        <div class="card-tags">${(game.tags || []).slice(0, 3).map(t => `<span class="tag">${t}</span>`).join('')}</div>
      </div>`;
    on(card, 'click', () => openDetail(game));
    inner.appendChild(card);
  });
}

// ── Detail Modal ───────────────────────────────────────────
function openDetail(game) {
  detailGame = game;
  clearInterval(heroInterval);
  $('detail-cover').src = game.cover || game.image || '';
  $('detail-name').textContent = game.name;
  $('detail-desc').textContent = game.description || '';
  $('detail-tags').innerHTML = (game.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
  $('detail-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  $('detail-modal').classList.add('hidden');
  document.body.style.overflow = '';
  detailGame = null;
  if (!heroInterval) cycleHero();
}

// ── Settings ───────────────────────────────────────────────
function openSettings() {
  $('setting-api-base').value = CONFIG.apiBase;
  $('setting-api-key').value = CONFIG.apiKey;
  $('settings-test-result').textContent = '';
  const acc = getManualAccount();
  if (acc) {
    $('manual-email').value = acc.email || '';
    $('manual-status').textContent = '✓ Saved account will be used (' + (acc.sn || '').slice(0, 8) + '…) — Clear to reset';
  } else {
    $('manual-status').textContent = '';
  }
  $('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  $('settings-modal').classList.add('hidden');
}

function saveSettings(e) {
  e.preventDefault();
  CONFIG.apiBase = $('setting-api-base').value.trim().replace(/\/+$/, '');
  CONFIG.apiKey = $('setting-api-key').value.trim();
  localStorage.setItem('ghostcloud_api_base', CONFIG.apiBase);
  localStorage.setItem('ghostcloud_api_key', CONFIG.apiKey);
  closeSettings();
  toast('Settings saved', 'success');
}

async function testConnection() {
  $('status-dot').className = 'status-dot connecting';
  $('status-label').textContent = 'Testing…';
  $('settings-test-result').textContent = 'Testing…';
  try {
    // Test: create a session with a dummy key (will fail but shows reachable)
    const res = await fetch(`${CONFIG.apiBase}/cloud/v1/createSession`, {
      method: 'POST',
      headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_key: 'test' }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 401) {
      // Reachable (401 = valid endpoint, wrong key)
      $('status-dot').className = 'status-dot online';
      $('status-label').textContent = 'Online';
      $('settings-test-result').textContent = '✓ API reachable';
      toast('API online', 'success');
    } else {
      throw new Error(`Status ${res.status}`);
    }
  } catch (e) {
    $('status-dot').className = 'status-dot error';
    $('status-label').textContent = 'Offline';
    $('settings-test-result').textContent = `✗ ${e.message}`;
    toast('API unreachable', 'error');
  }
}

// ── Manual Raccoon account ────────────────────────────
function getManualAccount() {
  try { return JSON.parse(localStorage.getItem(MANUAL_ACCOUNT_KEY) || 'null'); }
  catch { return null; }
}

async function createTempMailbox() {
  $('manual-status').textContent = 'Creating temp mailbox…';
  $('manual-mailbox').disabled = true;
  try {
    const res = await fetch(`${CONFIG.apiBase}/cloud/v1/createMailbox`, {
      method: 'POST',
      headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.email) throw new Error(data.error || 'Failed to create mailbox');
    $('manual-email').value = data.email;
    manualMailJwt = data.mailJwt;
    $('manual-status').textContent = `✓ Mailbox ready (${data.email}) — enter a password, then Send code`;
    toast('Temp mailbox created', 'success');
  } catch (e) {
    $('manual-status').textContent = `✗ ${e.message}`;
    toast(e.message, 'error');
  } finally {
    $('manual-mailbox').disabled = false;
  }
}

async function sendEmailCode() {
  const email = $('manual-email').value.trim();
  const password = $('manual-password').value;
  if (!email || !password) { $('manual-status').textContent = '✗ Enter email and password first'; return; }
  $('manual-status').textContent = 'Sending verification code…';
  $('manual-send').disabled = true;
  try {
    const res = await fetch(`${CONFIG.apiBase}/cloud/v1/sendEmail`, {
      method: 'POST',
      headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Status ${res.status}`);
    manualSn = data.sn;
    if (manualMailJwt) {
      $('manual-status').textContent = 'Code sent — reading mailbox…';
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const cRes = await fetch(`${CONFIG.apiBase}/cloud/v1/getCode`, {
            method: 'POST',
            headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mailJwt: manualMailJwt }),
            signal: AbortSignal.timeout(10000),
          });
          const cData = await cRes.json().catch(() => ({}));
          if (cData.code) {
            $('manual-code').value = cData.code;
            $('manual-status').textContent = '✓ Code received and filled in — click Register & save';
            toast('Verification code received', 'success');
            return;
          }
        } catch {}
      }
      $('manual-status').textContent = '✓ Code sent but not found yet — click Send code again';
    } else {
      $('manual-status').textContent = '✓ Code sent — check your inbox';
    }
    toast('Verification code sent', 'success');
  } catch (e) {
    $('manual-status').textContent = `✗ ${e.message}`;
    toast(e.message, 'error');
  } finally {
    $('manual-send').disabled = false;
  }
}

async function registerManualAccount() {
  const email = $('manual-email').value.trim();
  const password = $('manual-password').value;
  const code = $('manual-code').value.trim();
  if (!manualSn || !code) { $('manual-status').textContent = '✗ Send a code, then paste it here'; return; }
  $('manual-status').textContent = 'Registering account…';
  $('manual-register').disabled = true;
  try {
    const res = await fetch(`${CONFIG.apiBase}/cloud/v1/manualRegister`, {
      method: 'POST',
      headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sn: manualSn,
        email,
        password,
        code,
        phone: $('manual-phone').value.trim() || '1',
        country: $('manual-country').value.trim() || 'Brazil',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Status ${res.status}`);
    if (!data.token) throw new Error('No token returned');
    localStorage.setItem(MANUAL_ACCOUNT_KEY, JSON.stringify({ sn: data.sn, token: data.token, email }));
    $('manual-status').textContent = '✓ Account saved — Play Now will use it';
    toast('Raccoon account saved', 'success');
  } catch (e) {
    $('manual-status').textContent = `✗ ${e.message}`;
    toast(e.message, 'error');
  } finally {
    $('manual-register').disabled = false;
  }
}

function clearManualAccount() {
  localStorage.removeItem(MANUAL_ACCOUNT_KEY);
  manualSn = null;
  ['manual-email', 'manual-password', 'manual-code', 'manual-phone', 'manual-country'].forEach(id => $(id).value = '');
  $('manual-status').textContent = 'Cleared — launcher will auto-create accounts again';
}

// ── Player / Session Flow ──────────────────────────────────
function setStep(stepName, state) {
  const el = document.querySelector(`.step[data-step="${stepName}"]`);
  if (el) {
    el.className = 'step ' + state;
  }
}

function resetSteps() {
  document.querySelectorAll('.step').forEach(s => s.className = 'step');
}

async function playGame(game) {
  closeDetail();
  $('player-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('player-title').textContent = game.name;
  $('player-video').classList.remove('show');
  $('player-video').srcObject = null;
  $('player-status').style.display = 'flex';
  resetSteps();
  $('player-spinner').style.display = 'block';
  $('player-status-title').textContent = 'Connecting';
  $('player-status-msg').textContent = 'Creating session…';
  $('player-cancel').classList.remove('hidden');

  setStep('session', 'active');

  try {
    // 1. Create session
    const sessionResp = await createSession(game.game_key);
    const uuid = sessionResp.uuid;

    // 2. Queue if needed → get finished_queue
    setStep('session', 'done');
    setStep('queue', 'active');
    $('player-status-msg').textContent = 'Waiting in queue…';

    const queueResult = await waitForQueue(uuid);
    if (!queueResult) throw new Error('Queue aborted or timed out');

    setStep('queue', 'done');
    setStep('start', 'active');
    $('player-status-msg').textContent = 'Starting game…';

    // 3. Start game → get ice_servers + signaling_ws
    const startResp = await startGameSession(uuid);
    if (!startResp) throw new Error('Failed to start game');

    setStep('start', 'done');
    setStep('connect', 'active');
    $('player-status-msg').textContent = 'Connecting to stream…';

    // 4. Connect WebRTC
    await connectWebRTC(startResp.ice_servers, startResp.signaling_ws, uuid);

    setStep('connect', 'done');
    $('player-status-title').textContent = 'Connected!';
    $('player-status-msg').textContent = 'Starting stream…';
    $('player-spinner').style.display = 'none';
    $('player-cancel').classList.add('hidden');

    // 5. Hide status after stream starts
    setTimeout(() => {
      $('player-status').style.display = 'none';
    }, 1500);

  } catch (e) {
    console.error('Session error:', e);
    $('player-status-title').textContent = 'Error';
    $('player-status-msg').textContent = e.message;
    $('player-spinner').style.display = 'none';
    $('player-cancel').textContent = 'Close';
    setStep('connect', 'error');
    toast(e.message, 'error');
  }
}

async function createSession(gameKey) {
  $('player-status-msg').textContent = 'Creating session…';
  const res = await fetch(`${CONFIG.apiBase}/cloud/v1/createSession`, {
    method: 'POST',
    headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_key: gameKey, account: getManualAccount() || undefined }),
    // Account creation (mail.tm email verification) can take 60-90s,
    // so give the session plenty of time to stream to finished_queue.
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new Error(`Session creation failed: ${errText}`);
  }

  const ct = res.headers.get('content-type') || '';

  // Handle NDJSON stream (real backend)
  if (ct.includes('application/x-ndjson') || ct.includes('text/plain')) {
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.status === 'error') throw new Error(event.error || 'Session error');
      if (event.status === 'finished_queue') return { uuid: event.uuid, finished: true };
      if (event.status === 'queue') {
        $('player-status-msg').textContent = `In queue, position ${event.queue_pos}…`;
        setStep('queue', 'active');
      }
    }
    // If we got here, stream ended without finished_queue — check if uuid was given
    const last = JSON.parse(lines[lines.length - 1]);
    if (last.uuid) return { uuid: last.uuid, finished: false };
    throw new Error('Session stream ended unexpectedly');
  }

  // Handle plain JSON (mock/simplified backend)
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  // Mock backend: returns { status:"creating", uuid } immediately
  if (data.uuid) return { uuid: data.uuid, finished: data.status === 'finished_queue' };
  // Some backends return uuid nested
  return { uuid: data.session?.uuid || data.uuid, finished: false };
}

async function waitForQueue(uuid, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(
        `${CONFIG.apiBase}/cloud/v1/getQueue?uuid=${encodeURIComponent(uuid)}`,
        { headers: { 'x-api-key': CONFIG.apiKey }, signal: AbortSignal.timeout(10000) }
      );

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Queue check failed: HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.status === 'finished_queue') {
        $('player-status-msg').textContent = 'Queue finished — starting game…';
        return true;
      }
      if (data.status === 'queue') {
        $('player-status-msg').textContent = `In queue, position ${data.queue_pos}…`;
      }
    } catch (e) {
      console.warn('Queue poll error:', e.message);
    }
    await sleep(3000);
  }
  throw new Error('Queue timeout — try again later');
}

async function startGameSession(uuid) {
  const res = await fetch(`${CONFIG.apiBase}/cloud/v1/startGame`, {
    method: 'POST',
    headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `Start failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.ice_servers && !data.signaling_ws) {
    throw new Error('No WebRTC credentials returned');
  }

  // Store for ping/quit
  currentSession = {
    uuid,
    gameKey: '',
    isActive: true,
    startTime: Date.now(),
    maxSeconds: data.max_seconds || 900,
    pc: null,
    ws: null,
    interval: null,
  };

  return {
    ice_servers: data.ice_servers || [{ urls: 'stun:stun.l.google.com:19302' }],
    signaling_ws: data.signaling_ws,
    max_seconds: data.max_seconds || 900,
  };
}

function connectWebRTC(iceServers, signalingWsUrl, uuid) {
  return new Promise((resolve, reject) => {
    // Build RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: iceServers.map(s => {
        if (typeof s === 'string') return { urls: s };
        return s;
      }),
    });

    currentSession.pc = pc;

    const video = $('player-video');
    let hasTrack = false;
    let settled = false;
    let dc = null;

    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    pc.ontrack = (event) => {
      hasTrack = true;
      // Accumulate tracks (audio + video) into one MediaStream
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(event.track);
    };

    pc.ondatachannel = (event) => {
      if (event.channel.label === 'JYSDK') {
        dc = event.channel;
        currentSession.dc = dc;
        setupInputHandling(dc, video);
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        onStreamLive(video);
        finish(resolve);
      } else if (s === 'failed') {
        finish(reject, new Error('ICE connection failed'));
      }
    };

    // Connect signaling WebSocket
    let ws;
    try {
      ws = new WebSocket(signalingWsUrl);
    } catch (e) {
      finish(reject, new Error('WebSocket connection failed: ' + e.message));
      return;
    }

    currentSession.ws = ws;

    ws.onopen = () => {
      console.log('Signaling connected');
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('WS ←', msg.type || 'data');

        if (msg.type === 'game_ready') {
          // Server is ready → create offer.
          // Raccoon requires the JYSDK data channel in the offer before it
          // will answer — without it the stream never arrives.
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
          const channel = pc.createDataChannel('JYSDK', { id: 1, ordered: false, maxRetransmits: 0 });
          channel.onopen = () => {
            dc = channel;
            currentSession.dc = dc;
            setupInputHandling(dc, video);
          };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'rtc_offer', sdp: offer.sdp }));
        }

        if (msg.type === 'rtc_answer') {
          // msg.sdp is the Raccoon answer body: { type: "answer", sdp: "..." }
          const sdp = msg.sdp?.sdp || msg.sdp;
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp })).catch(() => {});
        }

        if (msg.type === 'rtc_candidate' && msg.candidate) {
          try {
            const c = typeof msg.candidate === 'string' ? { candidate: msg.candidate } : msg.candidate;
            await pc.addIceCandidate(new RTCIceCandidate(c));
          } catch (e) { console.warn('ICE candidate error:', e.message); }
        }
      } catch (e) {
        console.warn('WS message parse error:', e.message);
      }
    };

    ws.onclose = () => {
      console.log('Signaling closed');
      if (!hasTrack) {
        finish(reject, new Error('Signaling disconnected before stream started'));
      }
    };

    ws.onerror = (e) => {
      console.error('Signaling error:', e);
      if (!hasTrack) finish(reject, new Error('Signaling WebSocket error'));
    };

    // Send ICE candidates as full objects (Raccoon needs sdpMid/sdpMLineIndex)
    pc.onicecandidate = (event) => {
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'rtc_candidate', candidate: event.candidate.toJSON() }));
      }
    };

    // Start ping loop
    currentSession.interval = setInterval(async () => {
      if (!currentSession.isActive) return;
      try {
        const res = await fetch(`${CONFIG.apiBase}/cloud/v1/pingSession`, {
          method: 'POST',
          headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid }),
        });
        const data = await res.json();
        const used = data.session_time_used_seconds || 0;
        const limit = data.session_time_limit_seconds || currentSession.maxSeconds;
        if (used >= limit) {
          toast('Session time limit reached', 'error');
          closePlayer();
        }
      } catch (e) { /* ping fails silently */ }
    }, 15000);

    // Safety timeout
    setTimeout(() => {
      if (!hasTrack) finish(reject, new Error('Connection timed out — no stream received within 30s'));
    }, 30000);
  });
}

function onStreamLive(video) {
  video.classList.add('show');
  video.play().catch(() => {});
  $('player-status').style.display = 'none';
}

// ── Game input over the JYSDK data channel ────────────────
// Ported from the reference embed client (e.html).
let inputDC = null;
let streamFocused = false;
let curX = 0, curY = 0;
let mouseButtons = 0;
const activeKeys = new Set();
let escHoldTimer = null;
let gamepadRafId = null;

function dcSend(buf) {
  if (inputDC && inputDC.readyState === 'open') inputDC.send(buf);
}

function sendKeyInput(keyCode, isDown) {
  if (!inputDC || inputDC.readyState !== 'open') return;
  if (isDown) activeKeys.add(keyCode); else activeKeys.delete(keyCode);
  const buf = new ArrayBuffer(24), v = new DataView(buf);
  v.setUint8(0, 1); v.setUint8(2, 1); v.setUint8(3, 1);
  v.setUint16(4, keyCode); v.setUint8(6, isDown ? 1 : 0);
  let offset = 7;
  for (const k of activeKeys) {
    if (k !== keyCode && k > 0 && k < 255 && offset < 21) {
      v.setUint16(offset, k); offset += 2;
      v.setUint8(offset, 1); offset++;
    }
  }
  v.setUint8(offset++, 255);
  v.setUint8(1, offset - 1);
  dcSend(buf.slice(0, offset));
}

function sendMouseInput(moveX = 0, moveY = 0, scroll = 0) {
  if (!inputDC || inputDC.readyState !== 'open') return;
  const video = $('player-video');
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth || r.width;
  const vh = video.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const rw = vw * scale, rh = vh * scale;
  const left = r.left + (r.width - rw) / 2, top = r.top + (r.height - rh) / 2;
  const absX = Math.floor(((curX - left) / rw) * 10000);
  const absY = Math.floor(((curY - top) / rh) * 10000);
  const buf = new ArrayBuffer(12), v = new DataView(buf);
  v.setUint8(0, 1); v.setUint8(1, 11); v.setUint8(2, 2); v.setUint8(3, 8);
  v.setUint16(4, Math.max(0, Math.min(10000, absX)));
  v.setUint16(6, Math.max(0, Math.min(10000, absY)));
  v.setInt8(8, Math.max(-127, Math.min(127, moveX)));
  v.setInt8(9, Math.max(-127, Math.min(127, moveY)));
  v.setUint8(10, mouseButtons); v.setInt8(11, scroll);
  dcSend(buf);
}

function sendGamepadInput() {
  if (!inputDC || inputDC.readyState !== 'open') return;
  const GAMEPAD_BTN_MASK = [4096, 8192, 16384, 32768, 256, 512, 0, 0, 32, 16, 64, 128, 1, 2, 4, 8, 0];
  const gamepads = navigator.getGamepads?.() || [];
  for (let i = 0; i < gamepads.length; i++) {
    const gp = gamepads[i]; if (!gp) continue;
    let mask = 0, lt = 0, rt = 0;
    for (let b = 0; b < Math.min(gp.buttons.length, 17); b++) {
      const btn = gp.buttons[b];
      const pressed = typeof btn === 'object' ? btn.pressed : btn > 0;
      const value = typeof btn === 'object' ? btn.value : btn;
      if (pressed) {
        if (b === 6) lt = Math.round(value * 255);
        else if (b === 7) rt = Math.round(value * 255);
        else mask |= GAMEPAD_BTN_MASK[b];
      }
    }
    const ax = gp.axes;
    const lx = ax[0] ? Math.round(32767 * ax[0]) : 0;
    const ly = ax[1] ? Math.round(-32767 * ax[1]) : 0;
    const rx = ax[2] ? Math.round(32767 * ax[2]) : 0;
    const ry = ax[3] ? Math.round(-32767 * ax[3]) : 0;
    const buf = new ArrayBuffer(17), v = new DataView(buf);
    v.setUint8(0, 1); v.setUint8(1, 16); v.setUint8(2, 3); v.setUint8(3, 2); v.setUint8(4, i);
    v.setUint16(5, mask); v.setUint8(7, lt); v.setUint8(8, rt);
    v.setInt16(9, lx); v.setInt16(11, ly); v.setInt16(13, rx); v.setInt16(15, ry);
    dcSend(buf);
  }
}

function setupInputHandling(dc, video) {
  inputDC = dc;

  // Remote cursor images
  const MIMEMAP = { 0: 'image/x-icon', 1: 'image/jpeg', 2: 'image/png', 3: 'image/gif' };
  let currentCursorUrl = null;
  dc.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const v = new DataView(e.data);
    if (v.byteLength > 4 && v.getUint8(0) === 163 && v.getUint8(1) === 6) {
      if (v.byteLength <= 32) {
        video.style.cursor = 'none';
        if (currentCursorUrl) { URL.revokeObjectURL(currentCursorUrl); currentCursorUrl = null; }
      } else {
        const mimeType = MIMEMAP[v.getUint8(2)] || 'image/png';
        const hotX = v.getUint8(3), hotY = v.getUint8(4);
        const blob = new Blob([e.data.slice(5)], { type: mimeType });
        if (currentCursorUrl) URL.revokeObjectURL(currentCursorUrl);
        currentCursorUrl = URL.createObjectURL(blob);
        video.style.cursor = `url(${currentCursorUrl}) ${hotX} ${hotY}, default`;
        if (document.pointerLockElement === video) document.exitPointerLock();
      }
    }
  };

  // Gamepad polling loop
  const inputLoop = () => {
    sendGamepadInput();
    gamepadRafId = requestAnimationFrame(inputLoop);
  };
  if (gamepadRafId) cancelAnimationFrame(gamepadRafId);
  inputLoop();
}

function bindPlayerInput(video) {
  video.addEventListener('click', () => {
    if (!inputDC) return;
    streamFocused = true;
    navigator.keyboard?.lock?.().catch(() => {});
  });

  document.addEventListener('click', (e) => {
    if (streamFocused && !video.contains(e.target)) {
      streamFocused = false;
      navigator.keyboard?.unlock?.();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== video) navigator.keyboard?.unlock?.();
  });

  document.addEventListener('mousemove', (e) => {
    if (streamFocused && inputDC) {
      curX = e.clientX;
      curY = e.clientY;
      sendMouseInput(e.movementX || 0, e.movementY || 0, 0);
    } else {
      curX = e.clientX;
      curY = e.clientY;
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!streamFocused || !inputDC) return;
    mouseButtons = e.buttons;
    sendMouseInput(0, 0, 0);
  });

  document.addEventListener('mouseup', (e) => {
    if (!streamFocused || !inputDC) return;
    mouseButtons = e.buttons;
    sendMouseInput(0, 0, 0);
  });

  document.addEventListener('contextmenu', (e) => { if (streamFocused) e.preventDefault(); });

  video.addEventListener('wheel', (e) => {
    if (!streamFocused || !inputDC) return;
    e.preventDefault();
    sendMouseInput(0, 0, e.deltaY > 0 ? -1 : 1);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (!streamFocused || !inputDC) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.keyCode === 27 && !escHoldTimer) {
      escHoldTimer = setTimeout(() => {
        if (document.pointerLockElement) document.exitPointerLock();
        streamFocused = false;
        escHoldTimer = null;
      }, 1200);
    }
    sendKeyInput(e.keyCode, true);
  }, { capture: true });

  document.addEventListener('keyup', (e) => {
    if (!streamFocused || !inputDC) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.keyCode === 27) { clearTimeout(escHoldTimer); escHoldTimer = null; }
    sendKeyInput(e.keyCode, false);
  }, { capture: true });
}

function closePlayer() {
  // Cleanup session
  if (currentSession) {
    if (currentSession.interval) clearInterval(currentSession.interval);
    if (currentSession.ws) currentSession.ws.close();
    if (currentSession.pc) currentSession.pc.close();

    // Attempt quitSession
    if (currentSession.uuid) {
      fetch(`${CONFIG.apiBase}/cloud/v1/quitSession`, {
        method: 'POST',
        headers: { 'x-api-key': CONFIG.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: currentSession.uuid }),
      }).catch(() => {});
    }

    currentSession = null;
  }

  // Reset input state
  inputDC = null;
  streamFocused = false;
  mouseButtons = 0;
  activeKeys.clear();
  if (gamepadRafId) { cancelAnimationFrame(gamepadRafId); gamepadRafId = null; }
  if (escHoldTimer) { clearTimeout(escHoldTimer); escHoldTimer = null; }

  // Reset UI
  $('player-video').classList.remove('show');
  $('player-video').srcObject = null;
  $('player-modal').classList.add('hidden');
  $('player-status').style.display = 'flex';
  $('player-spinner').style.display = 'block';
  $('player-cancel').classList.remove('hidden');
  $('player-cancel').textContent = 'Cancel';
  resetSteps();
  document.body.style.overflow = '';

  if (!heroInterval) cycleHero();
}

function togglePlayerFullscreen() {
  const container = $('player-modal').querySelector('.player-container');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    container.requestFullscreen().catch(() => {});
  }
}

// ── Toast ──────────────────────────────────────────────────
let toastTimeout;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.classList.add('out');
  }, 3000);
  // Reset after animation
  setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('out');
  }, 3300);
}

// ── Utilities ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Boot ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);