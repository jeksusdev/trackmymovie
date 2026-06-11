// ─── CONFIG ───────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://qpxaiztckfbcktfzsmmb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFweGFpenRja2ZiY2t0ZnpzbW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTg3NDUsImV4cCI6MjA5NjMzNDc0NX0.5kZ-owTKhGaGdawpDfWW0lIFUafsYMOqcNMSwtZk8Wo';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const IMG           = 'https://image.tmdb.org/t/p/';
const TMDB_KEY      = '56d22eebdc0c16e4f800875507458997';

let sb = null;

// ─── STATE ────────────────────────────────────────────────────────
let currentUser = null;
let currentTab  = 'discover';
let searchTimer = null;
let watchlist   = {};
let episodeChecks = {};
let genreMap    = {};
let airStatusCache = {};
let _popupShowId = null;
let _popupData   = null;

function isGuestBuildHost() {
  const host = window.location.hostname;
  return !host || host === 'localhost' || host === '127.0.0.1' || host.includes('staging');
}

function setDisplay(id, display) {
  document.getElementById(id)?.style.setProperty('display', display, 'important');
}

// ─── SUPABASE AUTH ────────────────────────────────────────────────
async function signInGoogle() {
  if (!sb) return;
  const redirectTo = window.location.origin;
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: 'email profile'
    }
  });
}

async function signOut() {
  if (sb && currentUser) await sb.auth.signOut();
  currentUser = null;
  watchlist = {};
  episodeChecks = {};
  document.getElementById('app')?.style.setProperty('display', 'none', 'important');
  document.getElementById('detail-view').style.display = 'none';
  setDisplay('auth-gate', 'flex');
}

// ─── STORAGE: SUPABASE (logged in) or localStorage (guest) ────────
async function loadWatchlist() {
  if (currentUser) {
    const { data } = await sb.from('watchlist').select('show_id,status,item');
    watchlist = {};
    (data||[]).forEach(r => { watchlist[r.show_id] = { status: r.status, item: r.item }; });
  } else {
    try { watchlist = JSON.parse(localStorage.getItem('tmv_wl') || '{}'); } catch(e) { watchlist = {}; }
  }
}

async function saveWL() {
  if (currentUser) {
    // nothing — individual saves happen on each toggle
  } else {
    try { localStorage.setItem('tmv_wl', JSON.stringify(watchlist)); } catch(e) {}
  }
}

async function toggleWatchlistDB(showId, status, item) {
  const cur = watchlist[showId]?.status;
  if (cur === status) {
    delete watchlist[showId];
    if (currentUser) await sb.from('watchlist').delete().eq('show_id', showId).eq('user_id', currentUser.id);
  } else {
    watchlist[showId] = { status, item };
    if (currentUser) {
      await sb.from('watchlist').upsert({
        user_id: currentUser.id,
        show_id: showId,
        status,
        item,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,show_id' });
    }
  }
  if (!currentUser) saveWL();
}

async function loadEpisodeChecks() {
  if (currentUser) {
    const { data } = await sb.from('episode_checks').select('key');
    episodeChecks = {};
    (data||[]).forEach(r => { episodeChecks[r.key] = true; });
  } else {
    try { episodeChecks = JSON.parse(localStorage.getItem('tmv_ep') || '{}'); } catch(e) { episodeChecks = {}; }
  }
}

async function saveEpCheck(key, checked) {
  if (currentUser) {
    if (checked) {
      await sb.from('episode_checks').upsert({ user_id: currentUser.id, key, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' });
    } else {
      await sb.from('episode_checks').delete().eq('key', key).eq('user_id', currentUser.id);
    }
  } else {
    if (checked) episodeChecks[key] = true;
    else delete episodeChecks[key];
    try { localStorage.setItem('tmv_ep', JSON.stringify(episodeChecks)); } catch(e) {}
  }
}

async function saveAllEpChecks(keys) {
  if (currentUser) {
    const rows = keys.map(key => ({ user_id: currentUser.id, key, updated_at: new Date().toISOString() }));
    await sb.from('episode_checks').upsert(rows, { onConflict: 'user_id,key' });
    keys.forEach(k => { episodeChecks[k] = true; });
  } else {
    keys.forEach(k => { episodeChecks[k] = true; });
    try { localStorage.setItem('tmv_ep', JSON.stringify(episodeChecks)); } catch(e) {}
  }
}

// ─── INIT ─────────────────────────────────────────────────────────
async function loadGenres() {
  try {
    const [mv, tv] = await Promise.all([
      fetch(`${TMDB_BASE}/genre/movie/list?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json()),
      fetch(`${TMDB_BASE}/genre/tv/list?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json())
    ]);
    [...(mv.genres||[]), ...(tv.genres||[])].forEach(g => { genreMap[g.id] = g.name; });
  } catch(e) {}
}

async function prefetchAirStatus() {
  const tvIds = Object.values(watchlist)
    .map(v => v.item)
    .filter(i => i && (i.media_type === 'tv' || i.name))
    .map(i => i.id);
  await Promise.allSettled(tvIds.map(async id => {
    try {
      const d = await fetch(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json());
      const s = getAirStatus(d, 'tv');
      if (s) airStatusCache[id] = s;
    } catch(e) {}
  }));
}

async function bootApp() {
  // Clean up OAuth hash from URL
  if (window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname);
  }

  await loadGenres();
  await loadWatchlist();
  await loadEpisodeChecks();
  await prefetchAirStatus();

  document.getElementById('auth-gate').style.setProperty('display', 'none', 'important');
  setDisplay('loading-screen', 'none');
  const app = document.getElementById('app');
  app.style.setProperty('display', 'flex', 'important');

  renderUserArea();
  setupSearch();
  updateCounts();
  loadDiscover();
}

// ─── SUPABASE INIT ────────────────────────────────────────────────
// On page load — init Supabase, check session
document.addEventListener('DOMContentLoaded', async () => {
  if (isGuestBuildHost()) {
    setDisplay('auth-gate', 'none');
    setDisplay('loading-screen', 'flex');
    await bootApp();
    return;
  }

  const getSB = () => new Promise(resolve => {
    if (typeof supabase !== 'undefined') return resolve(true);
    let waited = 0;
    const interval = setInterval(() => {
      waited += 50;
      if (typeof supabase !== 'undefined') { clearInterval(interval); resolve(true); }
      else if (waited >= 5000) { clearInterval(interval); resolve(false); }
    }, 50);
  });

  const loaded = await getSB();
  if (!loaded) {
    console.warn('Supabase not loaded');
    setDisplay('loading-screen', 'none');
    setDisplay('auth-gate', 'flex');
    return;
  }

  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        persistSession: true,
        storageKey: 'tmv-auth',
        storage: window.localStorage,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      }
    });

    // Show loading spinner while checking session — prevents flash of login screen
    setDisplay('auth-gate', 'none');
    setDisplay('loading-screen', 'flex');

    // Wait for Supabase to process session (from localStorage or URL hash)
    let session = null;
    for (let i = 0; i < 20; i++) {
      const { data } = await sb.auth.getSession();
      if (data?.session?.user) {
        session = data.session;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (session?.user) {
      currentUser = session.user;
      await bootApp();
    } else {
      setDisplay('loading-screen', 'none');
      setDisplay('auth-gate', 'flex');
    }

    // Listen for sign out
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        currentUser = null;
        watchlist = {};
        episodeChecks = {};
        document.getElementById('app').style.setProperty('display', 'none', 'important');
        document.getElementById('detail-view').style.display = 'none';
        document.getElementById('auth-gate').style.setProperty('display', 'flex', 'important');
      }
    });
  } catch(err) {
    console.error('Supabase init error:', err);
    setDisplay('loading-screen', 'none');
    setDisplay('auth-gate', 'flex');
  }
});
// ─── USER AREA IN HEADER ──────────────────────────────────────────
function renderUserArea() {
  const area = document.getElementById('user-area');
  if (!currentUser) {
    area.innerHTML = isGuestBuildHost()
      ? `<span class="user-guest-btn">Guest mode</span>`
      : `<button class="user-guest-btn" onclick="signOut()">⎋ Guest</button>`;
    return;
  }
  const avatar = currentUser.user_metadata?.avatar_url;
  const name   = currentUser.user_metadata?.full_name || currentUser.email;
  area.innerHTML = `
    <div class="user-pill" onclick="toggleUserMenu()">
      ${avatar ? `<img src="${avatar}" class="user-avatar" alt="${name}">` : `<div class="user-avatar-ph">◉</div>`}
      <span class="user-name">${name.split(' ')[0]}</span>
      ▾
    </div>
    <div class="user-menu" id="user-menu">
      <div class="user-menu-info">
        <div style="font-weight:600;font-size:13px">${name}</div>
        <div style="font-size:11px;color:var(--text3)">${currentUser.email}</div>
      </div>
      <div class="user-menu-divider"></div>
      <button class="user-menu-btn" onclick="signOut()">⎋ Sign out</button>
    </div>`;
}

function toggleUserMenu() {
  document.getElementById('user-menu')?.classList.toggle('open');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.user-pill')) document.getElementById('user-menu')?.classList.remove('open');
});

// ─── LANG DETECTION ───────────────────────────────────────────────
function detectLang(text) {
  if (!/[\u0400-\u04FF]/.test(text)) return null;
  if (/[іїєґ]/i.test(text)) return 'UK';
  return 'RU';
}
function tmdbLang(text) {
  const l = detectLang(text);
  if (l === 'UK') return 'uk-UA';
  if (l === 'RU') return 'ru-RU';
  return 'en-US';
}

// ─── SEARCH ───────────────────────────────────────────────────────
function setupSearch() {
  const inp = document.getElementById('search-input');
  const badge = document.getElementById('lang-badge');
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    badge.textContent = detectLang(q) || '';
    badge.classList.toggle('visible', !!detectLang(q));
    clearTimeout(searchTimer);
    if (q.length < 2) { if (!q) switchTab(currentTab, true); return; }
    searchTimer = setTimeout(() => doSearch(q), 380);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); const q = inp.value.trim(); if (q.length >= 2) doSearch(q); }
  });
}

async function doSearch(q) {
  const lang = tmdbLang(q);
  showLoading();
  try {
    const r = await fetch(`${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=${lang}&query=${encodeURIComponent(q)}&include_adult=false`);
    const d = await r.json();
    const results = (d.results||[]).filter(x => x.media_type==='movie'||x.media_type==='tv');
    renderGrid(results, `Results for "${q}"`);
  } catch(e) { renderError(); }
}

// ─── DISCOVER ─────────────────────────────────────────────────────
async function loadDiscover() {
  showLoading();
  try {
    const [tr, tv] = await Promise.all([
      fetch(`${TMDB_BASE}/trending/all/week?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json()),
      fetch(`${TMDB_BASE}/tv/top_rated?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json())
    ]);
    const c = document.getElementById('main-content');
    c.innerHTML = `
      <div class="section-label">Trending this week</div>
      <div class="grid" id="g-trending"></div>
      <div class="section-label" style="margin-top:2rem">Top rated series</div>
      <div class="grid" id="g-toptv"></div>`;
    renderCards(tr.results.slice(0,18), 'g-trending');
    renderCards(tv.results.slice(0,12).map(x=>({...x,media_type:'tv'})), 'g-toptv');
  } catch(e) { renderError(); }
}

// ─── RENDER GRID ──────────────────────────────────────────────────
function renderGrid(items, label) {
  const c = document.getElementById('main-content');
  if (!items.length) {
    c.innerHTML = `<div class="empty-state">😔<p>Nothing found.</p></div>`;
    return;
  }
  c.innerHTML = `<div class="section-label">${label} — ${items.length} results</div><div class="grid" id="g-results"></div>`;
  renderCards(items, 'g-results');
}

// ─── RENDER CARDS ─────────────────────────────────────────────────
function renderCards(items, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  items.forEach(item => {
    if (!item) return;
    const type   = item.media_type || 'movie';
    const title  = item.title || item.name || 'Unknown';
    const year   = (item.release_date || item.first_air_date || '').slice(0,4);
    const poster = item.poster_path ? `${IMG}w300${item.poster_path}` : null;
    const state  = watchlist[item.id]?.status || null;
    const genreNames = (item.genre_ids||[]).slice(0,2).map(id=>genreMap[id]).filter(Boolean);
    const genreText  = genreNames.join(' · ');
    const seasons    = type==='tv' && item.number_of_seasons ? item.number_of_seasons : null;
    const airSt      = type==='tv' ? airStatusCache[item.id] : null;
    const airLabels  = { onair:'● On Air', ended:'■ Finished', canceled:'✕ Canceled' };

    const div = document.createElement('div');
    div.className = 'card';
    div.dataset.id = item.id;
    div.innerHTML = `
      ${state ? `<div class="status-ribbon ribbon-${state}"></div>` : ''}
      ${poster ? `<img class="card-poster" src="${poster}" alt="${title}" loading="lazy">` : `<div class="card-poster-placeholder">🎬</div>`}
      <div class="card-overlay"></div>
      <div class="card-actions">
        <button class="wl-btn ${state==='watchlist'?'wl-active-watchlist':''}" title="Want to watch">⊟</button>
        <button class="wl-btn ${state==='watching'?'wl-active-watching':''}" title="Watching">▶</button>
        <button class="wl-btn ${state==='watched'?'wl-active-watched':''}" title="Watched">✓</button>
      </div>
      <div class="card-body">
        <div class="card-title">${title}</div>
        ${genreText ? `<div class="overlay-genre">${genreText}</div>` : ''}
        ${seasons   ? `<div class="overlay-seasons">▤ ${seasons} season${seasons!==1?'s':''}</div>` : ''}
        <div class="card-badges">
          <span class="badge badge-type">${type==='tv'?'Series':'Movie'}</span>
          ${year ? `<span class="badge badge-year">${year}</span>` : ''}
          ${airSt ? `<span class="badge badge-${airSt}">${airLabels[airSt]}</span>` : ''}
        </div>
      </div>`;

    const btns = div.querySelectorAll('.wl-btn');
    ['watchlist','watching','watched'].forEach((s,i) => {
      btns[i].addEventListener('click', async e => {
        e.stopPropagation();
        await toggleWatchlistDB(item.id, s, item);
        updateCounts();
        updateCardUI(item.id, div);
        if (currentTab !== 'discover') renderWatchlistTab(currentTab);
      });
    });
    div.addEventListener('click', () => openDetail(item.id, type));
    grid.appendChild(div);
  });
}

function updateCardUI(id, cardEl) {
  const state = watchlist[id]?.status || null;
  let ribbon = cardEl.querySelector('.status-ribbon');
  if (ribbon) ribbon.remove();
  if (state) {
    const r = document.createElement('div');
    r.className = `status-ribbon ribbon-${state}`;
    cardEl.prepend(r);
  }
  const btns = cardEl.querySelectorAll('.wl-btn');
  const cls  = ['wl-active-watchlist','wl-active-watching','wl-active-watched'];
  btns.forEach((b,i) => b.classList.toggle(cls[i], state===(['watchlist','watching','watched'][i])));
}

function updateCounts() {
  ['watchlist','watching','watched'].forEach(s => {
    const n = Object.values(watchlist).filter(v=>v.status===s).length;
    const el = document.getElementById(`count-${s}`);
    if (el) el.textContent = n;
  });
}

function switchTab(tab, silent) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
  if (!silent) {
    document.getElementById('search-input').value = '';
    document.getElementById('lang-badge').classList.remove('visible');
  }
  if (tab==='discover') loadDiscover();
  else renderWatchlistTab(tab);
}

function renderWatchlistTab(tab) {
  const items = Object.values(watchlist).filter(v=>v.status===tab).map(v=>v.item);
  const c = document.getElementById('main-content');
  const labels = { watchlist:'No titles in your watchlist yet.', watching:'Not watching anything yet.', watched:'No watched titles yet.' };
  const icons  = { watchlist:'ti-bookmark', watching:'ti-player-play', watched:'ti-circle-check' };
  if (!items.length) {
    c.innerHTML = `<div class="empty-state"><i class="ti ${icons[tab]}"></i><p>${labels[tab]}</p></div>`;
    return;
  }
  c.innerHTML = `<div class="section-label">${items.length} title${items.length!==1?'s':''}</div><div class="grid" id="g-wl"></div>`;
  renderCards(items.map(i=>({...i, media_type: i.media_type||(i.title?'movie':'tv')})), 'g-wl');
}

function showLoading() { document.getElementById('main-content').innerHTML = '<div class="spinner"></div>'; }
function renderError()  { document.getElementById('main-content').innerHTML = `<div class="empty-state">⚠<p>Something went wrong.</p></div>`; }

// ─── DETAIL ───────────────────────────────────────────────────────
async function openDetail(id, type) {
  document.getElementById('app').style.display = 'none';
  const dv = document.getElementById('detail-view');
  dv.style.display = 'flex';
  dv.style.flexDirection = 'column';
  dv.style.minHeight = '100vh';
  dv.innerHTML = '<div class="spinner" style="margin-top:5rem"></div>';
  try {
    const data = await fetch(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`).then(r=>r.json());
    renderDetail(data, type);
  } catch(e) {
    dv.innerHTML = `<div class="empty-state">⚠<p>Could not load details.</p></div>`;
  }
}

function getAirStatus(data, type) {
  if (type!=='tv') return null;
  const s = (data.status||'').toLowerCase();
  if (s==='returning series'||s==='in production') return 'onair';
  if (s==='ended') return 'ended';
  if (s==='canceled'||s==='cancelled') return 'canceled';
  return null;
}

function renderDetail(data, type) {
  const dv    = document.getElementById('detail-view');
  const id    = data.id;
  const title = data.title || data.name || 'Unknown';
  const year  = (data.release_date || data.first_air_date || '').slice(0,4);
  const backdrop = data.backdrop_path ? `${IMG}w1280${data.backdrop_path}` : null;
  const poster   = data.poster_path   ? `${IMG}w200${data.poster_path}`   : null;
  const genres   = (data.genres||[]).map(g=>g.name).join(', ')||'—';
  const cast     = (data.credits?.cast||[]).slice(0,5).map(a=>a.name).join(', ')||'—';
  const studio   = type==='movie'
    ? (data.production_companies||[]).map(p=>p.name).slice(0,2).join(', ')||'—'
    : (data.networks||[]).map(n=>n.name).slice(0,2).join(', ')||'—';
  const state = watchlist[id]?.status || null;
  const airStatus = getAirStatus(data, type);
  if (airStatus) airStatusCache[id] = airStatus;

  const airBadges  = { onair:'● On Air', ended:'■ Finished', canceled:'✕ Canceled' };
  const airBadgeHtml = airStatus ? `<span class="chip air-badge air-${airStatus}">${airBadges[airStatus]}</span>` : '';

  let facts = `
    <div class="fact-card"><div class="fact-label">Year</div><div class="fact-value">${year||'—'}</div></div>
    <div class="fact-card"><div class="fact-label">Genre</div><div class="fact-value">${genres}</div></div>
    <div class="fact-card"><div class="fact-label">${type==='tv'?'Network':'Studio'}</div><div class="fact-value">${studio}</div></div>
    <div class="fact-card"><div class="fact-label">Cast</div><div class="fact-value">${cast}</div></div>`;
  if (type==='tv') {
    facts += `<div class="fact-card"><div class="fact-label">Seasons</div><div class="fact-value">${data.number_of_seasons||'—'}</div></div>`;
    facts += `<div class="fact-card"><div class="fact-label">Episodes</div><div class="fact-value">${data.number_of_episodes||'—'}</div></div>`;
    if (airStatus) {
      const al = { onair:'On Air', ended:'Finished', canceled:'Canceled' };
      facts += `<div class="fact-card"><div class="fact-label">Status</div><div class="fact-value air-fact-${airStatus}">${al[airStatus]}</div></div>`;
    }
  } else {
    facts += `<div class="fact-card"><div class="fact-label">Runtime</div><div class="fact-value">${data.runtime?data.runtime+' min':'—'}</div></div>`;
    facts += `<div class="fact-card"><div class="fact-label">Rating</div><div class="fact-value">${data.vote_average?Math.round(data.vote_average*10)/10+'/10':'—'}</div></div>`;
  }

  dv.innerHTML = `
    <div class="detail-header">
      ${backdrop?`<img class="detail-backdrop" src="${backdrop}" alt="">`:'<div class="detail-backdrop-placeholder"></div>'}
      <div class="detail-gradient"></div>
      <div class="detail-content">
        ${poster?`<img class="detail-poster" src="${poster}" alt="${title}">`:`<div class="detail-poster-ph">🎬</div>`}
        <div class="detail-info">
          <div class="detail-title">${title}</div>
          ${data.tagline?`<div class="detail-tagline">${data.tagline}</div>`:''}
          <div class="detail-chips">
            ${year?`<span class="chip">${year}</span>`:''}
            <span class="chip">${type==='tv'?'Series':'Movie'}</span>
            ${data.vote_average?`<span class="chip">★ ${Math.round(data.vote_average*10)/10}</span>`:''}
            ${airBadgeHtml}
          </div>
        </div>
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-back" id="back-btn">← Back</div>
      <div class="detail-actions">
        <button class="action-btn act-watchlist ${state==='watchlist'?'active':''}" data-s="watchlist">⊟ Want to watch</button>
        <button class="action-btn act-watching  ${state==='watching'?'active':''}"  data-s="watching">▶ Watching</button>
        <button class="action-btn act-watched   ${state==='watched'?'active':''}"   data-s="watched">✓ Watched</button>
      </div>
      <div class="detail-desc">${data.overview||'No description available.'}</div>
      <div class="detail-facts">${facts}</div>
      ${type==='tv'?'<div id="seasons-section"><div class="spinner"></div></div>':''}
    </div>`;

  document.getElementById('back-btn').addEventListener('click', closeDetail);

  dv.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = btn.dataset.s;
      await toggleWatchlistDB(id, s, data);
      updateCounts();
      const newState = watchlist[id]?.status || null;
      dv.querySelectorAll('.action-btn').forEach(b => b.classList.remove('active'));
      if (newState) dv.querySelector(`.act-${newState}`)?.classList.add('active');
      if (newState==='watched' && type==='tv') tickAllRenderedEpisodes();
    });
  });

  if (type==='tv' && data.number_of_seasons) loadSeasons(id, data.number_of_seasons);
}

// ─── EPISODES ─────────────────────────────────────────────────────
function tickAllRenderedEpisodes() {
  const sec = document.getElementById('seasons-section');
  if (!sec) return;
  const keys = [];
  sec.querySelectorAll('.ep-released .ep-check').forEach(cb => {
    if (!cb.checked) {
      cb.checked = true;
      episodeChecks[cb.dataset.key] = true;
      cb.closest('.episode-row').classList.add('ep-done');
      keys.push(cb.dataset.key);
    }
  });
  if (keys.length) saveAllEpChecks(keys);
}

async function loadSeasons(showId, count) {
  const sec = document.getElementById('seasons-section');
  if (!sec) return;
  sec.innerHTML = '<div class="seasons-title">Seasons &amp; Episodes</div>';
  const isWatched = () => watchlist[showId]?.status === 'watched';

  for (let n = 1; n <= count; n++) {
    try {
      const s = await fetch(`${TMDB_BASE}/tv/${showId}/season/${n}?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json());
      const eps = s.episodes || [];
      const today = new Date(); today.setHours(0,0,0,0);

      if (isWatched()) {
        const keys = [];
        eps.forEach(ep => {
          if (!ep.air_date) return;
          const air = new Date(ep.air_date); air.setHours(0,0,0,0);
          if (air <= today) {
            const key = `${showId}_s${n}_e${ep.episode_number}`;
            if (!episodeChecks[key]) keys.push(key);
          }
        });
        if (keys.length) await saveAllEpChecks(keys);
      }

      const block = document.createElement('div');
      block.className = 'season-block';
      const rows = eps.map(ep => {
        const key = `${showId}_s${n}_e${ep.episode_number}`;
        const done = !!episodeChecks[key];
        let released = false, daysLeft = null;
        if (ep.air_date) {
          const air = new Date(ep.air_date); air.setHours(0,0,0,0);
          released = air <= today;
          if (!released) daysLeft = Math.round((air - today) / 86400000);
        }
        const rowClass = ['episode-row', done?'ep-done':'', released?'ep-released':'ep-unreleased'].filter(Boolean).join(' ');
        const countdown = (!released && daysLeft!==null)
          ? `<span class="ep-countdown${daysLeft<=7?' soon':''}">${daysLeft===0?'Today!':daysLeft===1?'Tomorrow':daysLeft+'d'}</span>`
          : '';
        return `<div class="${rowClass}">
          <input type="checkbox" class="ep-check" ${done?'checked':''} ${!released?'disabled':''} data-key="${key}">
          <span class="ep-num">E${ep.episode_number}</span>
          <span class="ep-title">${ep.name||'Episode '+ep.episode_number}</span>
          ${countdown}
          ${ep.air_date?`<span class="ep-date">${ep.air_date}</span>`:''}
        </div>`;
      }).join('');

      block.innerHTML = `
        <div class="season-header">
          <span class="season-name">Season ${n}${s.name&&s.name!==`Season ${n}`?' — '+s.name:''}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="season-ep-count">${eps.length} ep</span>
            ▾
          </div>
        </div>
        <div class="episodes-list">${rows}</div>`;

      block.querySelector('.season-header').addEventListener('click', function() {
        this.classList.toggle('open');
        this.nextElementSibling.classList.toggle('open');
      });

      block.querySelectorAll('.ep-check').forEach(cb => {
        cb.addEventListener('change', async function() {
          if (this.disabled) return;
          const key = this.dataset.key;
          this.closest('.episode-row').classList.toggle('ep-done', this.checked);
          await saveEpCheck(key, this.checked);
          if (this.checked) episodeChecks[key] = true;
          else delete episodeChecks[key];
          checkAllWatched(showId);
        });
      });

      sec.appendChild(block);
    } catch(e) {}
  }
}

function checkAllWatched(showId) {
  const sec = document.getElementById('seasons-section');
  if (!sec) return;
  const allReleased = sec.querySelectorAll('.ep-released .ep-check');
  if (!allReleased.length) return;
  if (Array.from(allReleased).every(cb=>cb.checked) && watchlist[showId]?.status!=='watched') {
    _popupShowId = showId;
    _popupData   = watchlist[showId]?.item || { id: showId };
    document.getElementById('watched-popup').style.display = 'flex';
  }
}

async function confirmWatched() {
  if (_popupShowId===null) return;
  const id   = _popupShowId;
  const item = _popupData || watchlist[id]?.item || { id };
  await toggleWatchlistDB(id, 'watched', item);
  // Make sure it's set to watched (toggle would remove if already watched)
  if (!watchlist[id] || watchlist[id].status !== 'watched') {
    watchlist[id] = { status: 'watched', item };
    if (currentUser) {
      await sb.from('watchlist').upsert({
        user_id: currentUser.id, show_id: id, status: 'watched', item,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,show_id' });
    }
  }
  updateCounts();
  document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.act-watched')?.classList.add('active');
  tickAllRenderedEpisodes();
  closeWatchedPopup();
}

function closeWatchedPopup() {
  document.getElementById('watched-popup').style.display = 'none';
  _popupShowId = null; _popupData = null;
}

function closeDetail() {
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('app').style.setProperty('display', 'flex', 'important');
}
