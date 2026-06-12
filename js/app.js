// ─── CONFIG ───────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://qpxaiztckfbcktfzsmmb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFweGFpenRja2ZiY2t0ZnpzbW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTg3NDUsImV4cCI6MjA5NjMzNDc0NX0.5kZ-owTKhGaGdawpDfWW0lIFUafsYMOqcNMSwtZk8Wo';
const TMDB_BASE     = '/api/tmdb';
const IMG           = 'https://image.tmdb.org/t/p/';

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
let _statusChange = null;

function isGuestBuildHost() {
  const host = window.location.hostname;
  return !host || host === 'localhost' || host === '127.0.0.1' || host.includes('staging');
}

function setDisplay(id, display) {
  document.getElementById(id)?.style.setProperty('display', display, 'important');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function safeImageUrl(value, allowedOrigins) {
  try {
    const url = new URL(value);
    return allowedOrigins.includes(url.origin) ? url.href : '';
  } catch {
    return '';
  }
}

async function tmdbFetch(path, params = {}) {
  const url = new URL(`${TMDB_BASE}/${path.replace(/^\/+/, '')}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`TMDB request failed: ${response.status}`);
  return response.json();
}

function statusIcon(status) {
  const paths = {
    watchlist: 'M7 4.5h10a1 1 0 0 1 1 1v15l-6-3.7-6 3.7v-15a1 1 0 0 1 1-1Z',
    watching: 'm8 5 11 7-11 7V5Z',
    watched: 'm5 12.5 4.2 4.2L19 7'
  };
  return `<svg class="status-icon status-icon-${status}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[status]}"></path></svg>`;
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
  if (!keys.length) return;
  if (currentUser) {
    const rows = keys.map(key => ({ user_id: currentUser.id, key, updated_at: new Date().toISOString() }));
    await sb.from('episode_checks').upsert(rows, { onConflict: 'user_id,key' });
    keys.forEach(k => { episodeChecks[k] = true; });
  } else {
    keys.forEach(k => { episodeChecks[k] = true; });
    try { localStorage.setItem('tmv_ep', JSON.stringify(episodeChecks)); } catch(e) {}
  }
}

async function removeAllEpChecks(keys) {
  if (!keys.length) return;
  if (currentUser) {
    await sb.from('episode_checks').delete().eq('user_id', currentUser.id).in('key', keys);
  } else {
    keys.forEach(key => { delete episodeChecks[key]; });
    try { localStorage.setItem('tmv_ep', JSON.stringify(episodeChecks)); } catch(e) {}
  }
  keys.forEach(key => { delete episodeChecks[key]; });
}

// ─── INIT ─────────────────────────────────────────────────────────
async function loadGenres() {
  try {
    const [mv, tv] = await Promise.all([
      tmdbFetch('genre/movie/list', { language: 'en-US' }),
      tmdbFetch('genre/tv/list', { language: 'en-US' })
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
      const d = await tmdbFetch(`tv/${Number(id)}`, { language: 'en-US' });
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
  document.getElementById('google-btn').addEventListener('click', signInGoogle);
  document.querySelectorAll('.tab-btn').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
  document.querySelector('#status-popup .modal-backdrop').addEventListener('click', closeStatusPopup);
  document.getElementById('status-popup-confirm').addEventListener('click', confirmStatusChange);
  document.querySelector('#status-popup .modal-cancel').addEventListener('click', closeStatusPopup);
  document.getElementById('watched-popup-backdrop').addEventListener('click', closeWatchedPopup);
  document.querySelector('#watched-popup .wpop-confirm').addEventListener('click', confirmWatched);
  document.querySelector('#watched-popup .wpop-cancel').addEventListener('click', closeWatchedPopup);

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
  area.replaceChildren();
  if (!currentUser) {
    const guest = document.createElement(isGuestBuildHost() ? 'span' : 'button');
    guest.className = 'user-guest-btn';
    guest.textContent = isGuestBuildHost() ? 'Guest mode' : '⎋ Guest';
    if (!isGuestBuildHost()) guest.addEventListener('click', signOut);
    area.appendChild(guest);
    return;
  }
  const avatar = safeImageUrl(currentUser.user_metadata?.avatar_url, ['https://lh3.googleusercontent.com']);
  const name = String(currentUser.user_metadata?.full_name || currentUser.email || 'User');
  const pill = document.createElement('button');
  pill.className = 'user-pill';
  pill.type = 'button';
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.className = 'user-avatar';
    img.alt = name;
    pill.appendChild(img);
  } else {
    const fallback = document.createElement('span');
    fallback.className = 'user-avatar-ph';
    fallback.textContent = '◉';
    pill.appendChild(fallback);
  }
  const shortName = document.createElement('span');
  shortName.className = 'user-name';
  shortName.textContent = name.split(' ')[0];
  pill.append(shortName, document.createTextNode(' ▾'));
  pill.addEventListener('click', toggleUserMenu);

  const menu = document.createElement('div');
  menu.className = 'user-menu';
  menu.id = 'user-menu';
  const info = document.createElement('div');
  info.className = 'user-menu-info';
  const fullName = document.createElement('div');
  fullName.className = 'user-menu-name';
  fullName.textContent = name;
  const email = document.createElement('div');
  email.className = 'user-menu-email';
  email.textContent = currentUser.email || '';
  info.append(fullName, email);
  const divider = document.createElement('div');
  divider.className = 'user-menu-divider';
  const signOutButton = document.createElement('button');
  signOutButton.className = 'user-menu-btn';
  signOutButton.textContent = '⎋ Sign out';
  signOutButton.addEventListener('click', signOut);
  menu.append(info, divider, signOutButton);
  area.append(pill, menu);
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
  const clear = document.getElementById('search-clear');
  const updateSearchUI = q => {
    const lang = detectLang(q);
    badge.textContent = lang || '';
    badge.classList.toggle('visible', !!lang);
    clear.classList.toggle('visible', !!q);
  };

  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    updateSearchUI(q);
    clearTimeout(searchTimer);
    if (q.length < 2) { if (!q) switchTab(currentTab, true); return; }
    searchTimer = setTimeout(() => doSearch(q), 380);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); const q = inp.value.trim(); if (q.length >= 2) doSearch(q); }
  });
  clear.addEventListener('click', () => {
    clearTimeout(searchTimer);
    inp.value = '';
    updateSearchUI('');
    switchTab(currentTab, true);
    inp.focus();
  });
}

async function doSearch(q) {
  const lang = tmdbLang(q);
  showLoading();
  try {
    const d = await tmdbFetch('search/multi', { language: lang, query: q, include_adult: 'false' });
    const results = (d.results||[]).filter(x => x.media_type==='movie'||x.media_type==='tv');
    renderGrid(results, `Results for "${q}"`);
  } catch(e) { renderError(); }
}

// ─── DISCOVER ─────────────────────────────────────────────────────
async function loadDiscover() {
  showLoading();
  try {
    const [tr, tv] = await Promise.all([
      tmdbFetch('trending/all/week', { language: 'en-US' }),
      tmdbFetch('tv/top_rated', { language: 'en-US' })
    ]);
    const c = document.getElementById('main-content');
    c.innerHTML = `
      <div class="section-label">Trending this week</div>
      <div class="grid" id="g-trending"></div>
      <div class="section-label section-label-spaced">Top rated series</div>
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
  c.innerHTML = `<div class="section-label">${escapeHtml(label)} — ${items.length} results</div><div class="grid" id="g-results"></div>`;
  renderCards(items, 'g-results');
}

// ─── RENDER CARDS ─────────────────────────────────────────────────
function renderCards(items, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  items.forEach(item => {
    if (!item) return;
    const type   = item.media_type || 'movie';
    const title  = escapeHtml(item.title || item.name || 'Unknown');
    const year   = escapeHtml((item.release_date || item.first_air_date || '').slice(0,4));
    const poster = /^\/[\w.-]+$/.test(item.poster_path || '') ? `${IMG}w300${item.poster_path}` : null;
    const state  = watchlist[item.id]?.status || null;
    const genreNames = (item.genre_ids||[]).slice(0,2).map(id=>genreMap[id]).filter(Boolean);
    const genreText  = escapeHtml(genreNames.join(' · '));
    const seasons    = type==='tv' && Number.isInteger(Number(item.number_of_seasons)) ? Number(item.number_of_seasons) : null;
    const airSt      = type==='tv' ? airStatusCache[item.id] : null;
    const airLabels  = { onair:'● On Air', ended:'■ Finished', canceled:'✕ Canceled' };

    const div = document.createElement('div');
    div.className = `card${state ? ` card-status-${state}` : ''}`;
    div.dataset.id = item.id;
    div.innerHTML = `
      ${poster ? `<img class="card-poster" src="${poster}" alt="${title}" loading="lazy">` : `<div class="card-poster-placeholder">🎬</div>`}
      <div class="card-overlay"></div>
      <div class="card-actions">
        <button class="wl-btn ${state==='watchlist'?'wl-active-watchlist':''}" title="Watchlist" aria-label="Watchlist">
          ${statusIcon('watchlist')}
        </button>
        <button class="wl-btn ${state==='watching'?'wl-active-watching':''}" title="Watching" aria-label="Watching">
          ${statusIcon('watching')}
        </button>
        <button class="wl-btn ${state==='watched'?'wl-active-watched':''}" title="Watched" aria-label="Watched">
          ${statusIcon('watched')}
        </button>
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
        if (currentTab === 'discover') {
          await applyCardStatusChange(item.id, s, item, div);
        } else {
          openStatusPopup(item.id, s, item, div);
        }
      });
    });
    div.addEventListener('click', () => openDetail(item.id, type));
    grid.appendChild(div);
  });
}

async function applyCardStatusChange(id, status, item, cardEl) {
  await toggleWatchlistDB(id, status, item);
  updateCounts();
  updateCardUI(id, cardEl);
  if (currentTab !== 'discover') renderWatchlistTab(currentTab);
}

function openStatusPopup(id, status, item, cardEl) {
  const labels = { watchlist:'Watchlist', watching:'Watching', watched:'Watched' };
  const currentStatus = watchlist[id]?.status || null;
  const title = item.title || item.name || 'This title';
  const removing = currentStatus === status;
  const desc = document.getElementById('status-popup-desc');
  const strong = text => {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
  };

  _statusChange = { id, status, item, cardEl };
  document.getElementById('status-popup-icon').textContent = removing ? '−' : '↗';
  document.getElementById('status-popup-title').textContent = removing ? 'Remove from list?' : 'Change status?';
  desc.replaceChildren();
  if (removing) {
    desc.append('Remove ', strong(title), ' from ', strong(labels[status]), '?');
  } else {
    desc.append('Move ', strong(title), ' from ', strong(labels[currentStatus] || 'its current list'), ' to ', strong(labels[status]), '?');
  }
  document.getElementById('status-popup-confirm').textContent = removing ? 'Remove' : `Move to ${labels[status]}`;
  document.getElementById('status-popup').style.display = 'flex';
}

async function confirmStatusChange() {
  if (!_statusChange) return;
  const { id, status, item, cardEl } = _statusChange;
  const confirmBtn = document.getElementById('status-popup-confirm');
  confirmBtn.disabled = true;
  await applyCardStatusChange(id, status, item, cardEl);
  confirmBtn.disabled = false;
  closeStatusPopup();
}

function closeStatusPopup() {
  document.getElementById('status-popup').style.display = 'none';
  _statusChange = null;
}

function updateCardUI(id, cardEl) {
  const state = watchlist[id]?.status || null;
  cardEl.classList.remove('card-status-watchlist', 'card-status-watching', 'card-status-watched');
  if (state) cardEl.classList.add(`card-status-${state}`);
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
    document.getElementById('search-clear').classList.remove('visible');
  }
  if (tab==='discover') loadDiscover();
  else renderWatchlistTab(tab);
}

function renderWatchlistTab(tab) {
  const items = Object.values(watchlist).filter(v=>v.status===tab).map(v=>v.item);
  const c = document.getElementById('main-content');
  const labels = { watchlist:'No titles in your watchlist yet.', watching:'Not watching anything yet.', watched:'No watched titles yet.' };
  if (!items.length) {
    c.innerHTML = `<div class="empty-state empty-state-status">${statusIcon(tab)}<p>${labels[tab]}</p></div>`;
    return;
  }
  c.innerHTML = `<div class="section-label">${items.length} title${items.length!==1?'s':''}</div><div class="grid" id="g-wl"></div>`;
  renderCards(items.map(i=>({...i, media_type: i.media_type||(i.title?'movie':'tv')})), 'g-wl');
}

function showLoading() { document.getElementById('main-content').innerHTML = '<div class="spinner"></div>'; }
function renderError()  { document.getElementById('main-content').innerHTML = `<div class="empty-state">⚠<p>Something went wrong.</p></div>`; }

// ─── DETAIL ───────────────────────────────────────────────────────
async function openDetail(id, type) {
  if (!['movie', 'tv'].includes(type) || !Number.isInteger(Number(id))) return;
  document.getElementById('app').style.display = 'none';
  const dv = document.getElementById('detail-view');
  dv.style.display = 'flex';
  dv.style.flexDirection = 'column';
  dv.style.minHeight = '100vh';
  dv.innerHTML = '<div class="spinner detail-spinner"></div>';
  try {
    const data = await tmdbFetch(`${type}/${Number(id)}`, {
      language: 'en-US',
      append_to_response: 'credits,videos,external_ids'
    });
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

function canSuggestWatched(data, type) {
  const airStatus = getAirStatus(data, type);
  return (airStatus === 'ended' || airStatus === 'canceled') && !data.next_episode_to_air;
}

function getTrailer(data) {
  const trailers = (data.videos?.results || []).filter(video =>
    video.site === 'YouTube' &&
    video.type === 'Trailer' &&
    /^[\w-]+$/.test(video.key)
  );
  return trailers.find(video => video.official) || trailers[0] || null;
}

function renderDetail(data, type) {
  const dv    = document.getElementById('detail-view');
  const id    = data.id;
  const title = escapeHtml(data.title || data.name || 'Unknown');
  const year  = escapeHtml((data.release_date || data.first_air_date || '').slice(0,4));
  const backdrop = /^\/[\w.-]+$/.test(data.backdrop_path || '') ? `${IMG}w1280${data.backdrop_path}` : null;
  const poster   = /^\/[\w.-]+$/.test(data.poster_path || '') ? `${IMG}w200${data.poster_path}` : null;
  const genres   = escapeHtml((data.genres||[]).map(g=>g.name).join(', ')||'—');
  const cast     = escapeHtml((data.credits?.cast||[]).slice(0,5).map(a=>a.name).join(', ')||'—');
  const studio   = type==='movie'
    ? escapeHtml((data.production_companies||[]).map(p=>p.name).slice(0,2).join(', ')||'—')
    : escapeHtml((data.networks||[]).map(n=>n.name).slice(0,2).join(', ')||'—');
  const state = watchlist[id]?.status || null;
  const airStatus = getAirStatus(data, type);
  const trailer = getTrailer(data);
  const imdbId = data.external_ids?.imdb_id;
  const imdbUrl = /^tt\d+$/.test(imdbId || '') ? `https://www.imdb.com/title/${imdbId}/` : null;
  if (airStatus) airStatusCache[id] = airStatus;

  const airBadges  = { onair:'● On Air', ended:'■ Finished', canceled:'✕ Canceled' };
  const airBadgeHtml = airStatus ? `<span class="chip air-badge air-${airStatus}">${airBadges[airStatus]}</span>` : '';

  let facts = `
    <div class="fact-card"><div class="fact-label">Year</div><div class="fact-value">${year||'—'}</div></div>
    <div class="fact-card"><div class="fact-label">Genre</div><div class="fact-value">${genres}</div></div>
    <div class="fact-card"><div class="fact-label">${type==='tv'?'Network':'Studio'}</div><div class="fact-value">${studio}</div></div>
    <div class="fact-card"><div class="fact-label">Cast</div><div class="fact-value">${cast}</div></div>`;
  if (type==='tv') {
    facts += `<div class="fact-card"><div class="fact-label">Seasons</div><div class="fact-value">${Number(data.number_of_seasons)||'—'}</div></div>`;
    facts += `<div class="fact-card"><div class="fact-label">Episodes</div><div class="fact-value">${Number(data.number_of_episodes)||'—'}</div></div>`;
    if (airStatus) {
      const al = { onair:'On Air', ended:'Finished', canceled:'Canceled' };
      facts += `<div class="fact-card"><div class="fact-label">Status</div><div class="fact-value air-fact-${airStatus}">${al[airStatus]}</div></div>`;
    }
  } else {
    facts += `<div class="fact-card"><div class="fact-label">Runtime</div><div class="fact-value">${Number(data.runtime)?Number(data.runtime)+' min':'—'}</div></div>`;
    facts += `<div class="fact-card"><div class="fact-label">TMDB Rating</div><div class="fact-value">${data.vote_average?Math.round(data.vote_average*10)/10+'/10':'—'}</div></div>`;
  }

  dv.innerHTML = `
    <div class="detail-header">
      ${backdrop?`<img class="detail-backdrop" src="${backdrop}" alt="">`:'<div class="detail-backdrop-placeholder"></div>'}
      <div class="detail-gradient"></div>
      <div class="detail-content">
        ${poster?`<img class="detail-poster" src="${poster}" alt="${title}">`:`<div class="detail-poster-ph">🎬</div>`}
        <div class="detail-info">
          <div class="detail-title">${title}</div>
          ${data.tagline?`<div class="detail-tagline">${escapeHtml(data.tagline)}</div>`:''}
          <div class="detail-chips">
            ${year?`<span class="chip">${year}</span>`:''}
            <span class="chip">${type==='tv'?'Series':'Movie'}</span>
            ${data.vote_average?`<span class="chip tmdb-rating"><strong>TMDB</strong> ★ ${Math.round(data.vote_average*10)/10}</span>`:''}
            ${imdbUrl?`<a class="chip imdb-link" href="${imdbUrl}" target="_blank" rel="noopener noreferrer">IMDb ↗</a>`:''}
            ${airBadgeHtml}
          </div>
        </div>
        ${trailer ? `
          <div class="detail-trailer">
            <div class="trailer-label">Trailer</div>
            <button class="trailer-preview" type="button" data-youtube-key="${trailer.key}" aria-label="Play trailer">
              <img src="https://i.ytimg.com/vi/${trailer.key}/hqdefault.jpg" alt="" loading="lazy">
              <span class="trailer-shade"></span>
              <span class="trailer-play">▶</span>
              <span class="trailer-cta">Watch trailer</span>
            </button>
          </div>` : ''}
      </div>
    </div>
    <div class="detail-body">
      <div class="detail-back" id="back-btn">← Back</div>
      <div class="detail-actions">
        <button class="action-btn act-watchlist ${state==='watchlist'?'active':''}" data-s="watchlist">
          ${statusIcon('watchlist')}
          Watchlist
        </button>
        <button class="action-btn act-watching  ${state==='watching'?'active':''}"  data-s="watching">${statusIcon('watching')} Watching</button>
        <button class="action-btn act-watched   ${state==='watched'?'active':''}"   data-s="watched">${statusIcon('watched')} Watched</button>
      </div>
      <div class="detail-desc">${escapeHtml(data.overview||'No description available.')}</div>
      <div class="detail-facts">${facts}</div>
      ${type==='tv'?'<div id="seasons-section"><div class="spinner"></div></div>':''}
      <div class="tmdb-attribution detail-attribution">
        <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer" aria-label="Visit The Movie Database">
          <img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_long_2-9665a76b1ae401a510ec1e0ca40ddcb3b0cfe45f1d51b77a308fea0845885648.svg" alt="The Movie Database">
        </a>
        <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
      </div>
    </div>`;

  document.getElementById('back-btn').addEventListener('click', closeDetail);

  dv.querySelector('.trailer-preview')?.addEventListener('click', function() {
    const key = this.dataset.youtubeKey;
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0`;
    iframe.title = 'Trailer';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.className = 'trailer-iframe';
    this.replaceWith(iframe);
  });

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

  if (type==='tv' && data.number_of_seasons) {
    loadSeasons(id, data.number_of_seasons, canSuggestWatched(data, type));
  }
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
  sec.querySelectorAll('.season-block').forEach(syncSeasonBulkButton);
}

function syncSeasonBulkButton(block) {
  const bulkBtn = block.querySelector('.season-bulk-btn');
  if (!bulkBtn) return;
  const releasedChecks = Array.from(block.querySelectorAll('.ep-released .ep-check'));
  const allDone = releasedChecks.length > 0 && releasedChecks.every(cb => cb.checked);
  bulkBtn.textContent = allDone ? 'Clear watched' : 'Mark released watched';
  bulkBtn.classList.toggle('all-done', allDone);
}

async function loadSeasons(showId, count, allowWatchedSuggestion) {
  const sec = document.getElementById('seasons-section');
  if (!sec) return;
  sec.dataset.seasonsLoaded = 'false';
  sec.innerHTML = '<div class="seasons-title">Seasons &amp; Episodes</div>';
  const isWatched = () => watchlist[showId]?.status === 'watched';

  for (let n = 1; n <= count; n++) {
    try {
      const s = await tmdbFetch(`tv/${Number(showId)}/season/${n}`, { language: 'en-US' });
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
        const episodeNumber = Number(ep.episode_number) || 0;
        const key = `${Number(showId) || 0}_s${n}_e${episodeNumber}`;
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
          <span class="ep-num">E${episodeNumber}</span>
          <span class="ep-title">${escapeHtml(ep.name||'Episode '+episodeNumber)}</span>
          ${countdown}
          ${ep.air_date?`<span class="ep-date">${escapeHtml(ep.air_date)}</span>`:''}
        </div>`;
      }).join('');

      block.innerHTML = `
        <div class="season-header">
          <span class="season-name">Season ${n}${s.name&&s.name!==`Season ${n}`?' — '+escapeHtml(s.name):''}</span>
          <div class="season-header-actions">
            <span class="season-ep-count">${eps.length} ep</span>
            <span class="season-chevron">▾</span>
          </div>
        </div>
        <div class="episodes-list">
          <div class="season-bulk-bar">
            <span class="season-bulk-label">Released episodes</span>
            <button class="season-bulk-btn" type="button"></button>
          </div>
          ${rows}
        </div>`;

      const bulkBtn = block.querySelector('.season-bulk-btn');
      const releasedChecks = Array.from(block.querySelectorAll('.ep-released .ep-check'));

      if (!releasedChecks.length) bulkBtn.remove();
      else syncSeasonBulkButton(block);

      block.querySelector('.season-header').addEventListener('click', function() {
        this.classList.toggle('open');
        this.nextElementSibling.classList.toggle('open');
      });

      bulkBtn?.addEventListener('click', async e => {
        e.stopPropagation();
        bulkBtn.disabled = true;
        const shouldClear = releasedChecks.every(cb => cb.checked);
        const changedChecks = releasedChecks.filter(cb => cb.checked === shouldClear);
        const keys = changedChecks.map(cb => cb.dataset.key);

        changedChecks.forEach(cb => {
          cb.checked = !shouldClear;
          cb.closest('.episode-row').classList.toggle('ep-done', !shouldClear);
        });

        if (shouldClear) await removeAllEpChecks(keys);
        else await saveAllEpChecks(keys);

        syncSeasonBulkButton(block);
        bulkBtn.disabled = false;
        if (!shouldClear) checkAllWatched(showId, allowWatchedSuggestion);
      });

      block.querySelectorAll('.ep-check').forEach(cb => {
        cb.addEventListener('change', async function() {
          if (this.disabled) return;
          const key = this.dataset.key;
          this.closest('.episode-row').classList.toggle('ep-done', this.checked);
          await saveEpCheck(key, this.checked);
          if (this.checked) episodeChecks[key] = true;
          else delete episodeChecks[key];
          syncSeasonBulkButton(block);
          checkAllWatched(showId, allowWatchedSuggestion);
        });
      });

      sec.appendChild(block);
    } catch(e) {}
  }
  sec.dataset.seasonsLoaded = 'true';
}

function checkAllWatched(showId, allowWatchedSuggestion) {
  if (!allowWatchedSuggestion) return;
  const sec = document.getElementById('seasons-section');
  if (!sec || sec.dataset.seasonsLoaded !== 'true') return;
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(error => {
      console.warn('Service worker registration failed:', error);
    });
  });
}
