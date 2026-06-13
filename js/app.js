// ─── CONFIG ───────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://qpxaiztckfbcktfzsmmb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFweGFpenRja2ZiY2t0ZnpzbW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTg3NDUsImV4cCI6MjA5NjMzNDc0NX0.5kZ-owTKhGaGdawpDfWW0lIFUafsYMOqcNMSwtZk8Wo';
const TMDB_BASE     = '/api/tmdb';
const IMG           = 'https://image.tmdb.org/t/p/';
const NOTIFIER_BASE = 'https://trackmymovie-notifier.jeksusdev.workers.dev';

let sb = null;
const { escapeHtml, itemKey, itemType, normalizeStoredWatchlist } = window.TrackMyMovieCore;
const tmdbFetch = window.TrackMyMovieApi.createTmdbClient(TMDB_BASE, window.location.origin, window.fetch.bind(window));

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
let searchController = null;
let lastFocusedElement = null;
let telegramConnectionPoll = null;

function isGuestBuildHost() {
  const host = window.location.hostname;
  return !host || host === 'localhost' || host === '127.0.0.1' || host.includes('staging');
}

function setDisplay(id, display) {
  document.getElementById(id)?.style.setProperty('display', display, 'important');
}

function showToast(message, kind = 'error') {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function assertSupabase(result, message) {
  if (result?.error) {
    console.error(message, result.error);
    throw new Error(message);
  }
  return result?.data;
}

function openDialog(element, focusTarget) {
  lastFocusedElement = document.activeElement;
  element.setAttribute('aria-hidden', 'false');
  element.style.display = 'flex';
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeDialog(element) {
  element.style.display = 'none';
  element.setAttribute('aria-hidden', 'true');
  lastFocusedElement?.focus?.();
  lastFocusedElement = null;
}

function trapDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(event.currentTarget.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function safeImageUrl(value, allowedOrigins) {
  try {
    const url = new URL(value);
    return allowedOrigins.includes(url.origin) ? url.href : '';
  } catch {
    return '';
  }
}

function stopActiveTrailer(remove = false) {
  const iframe = document.querySelector('#detail-view .trailer-iframe');
  if (!iframe) return;
  try {
    iframe.contentWindow?.postMessage(JSON.stringify({
      event: 'command',
      func: 'stopVideo',
      args: []
    }), 'https://www.youtube-nocookie.com');
  } catch {}
  if (remove) iframe.remove();
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
  if (isGuestBuildHost()) {
    window.location.reload();
    return;
  }
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
    const data = assertSupabase(
      await sb.from('watchlist').select('show_id,status,item,media_type'),
      'Could not load your watchlist.'
    );
    watchlist = {};
    (data||[]).forEach(r => {
      const type = r.media_type || itemType(r.item);
      watchlist[itemKey(r.show_id, type)] = { status: r.status, item: { ...r.item, media_type: type } };
    });
  } else {
    try {
      watchlist = normalizeStoredWatchlist(JSON.parse(localStorage.getItem('tmv_wl') || '{}'));
      localStorage.setItem('tmv_wl', JSON.stringify(watchlist));
    } catch(e) { watchlist = {}; }
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
  const type = itemType(item);
  const key = itemKey(showId, type);
  const cur = watchlist[key]?.status;
  const previous = watchlist[key];
  if (cur === status) {
    delete watchlist[key];
  } else {
    watchlist[key] = { status, item: { ...item, media_type: type } };
  }
  try {
    if (currentUser) {
      if (cur === status) {
        assertSupabase(
          await sb.from('watchlist').delete().eq('show_id', showId).eq('media_type', type).eq('user_id', currentUser.id),
          'Could not remove this title.'
        );
      } else {
        assertSupabase(await sb.from('watchlist').upsert({
        user_id: currentUser.id,
        show_id: showId,
        media_type: type,
        status,
        item: { ...item, media_type: type },
        updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,show_id,media_type' }), 'Could not save this title.');
      }
    }
    if (!currentUser) saveWL();
  } catch (error) {
    if (previous) watchlist[key] = previous;
    else delete watchlist[key];
    showToast(error.message);
    throw error;
  }
}

async function loadEpisodeChecks() {
  if (currentUser) {
    const data = assertSupabase(await sb.from('episode_checks').select('key'), 'Could not load episode progress.');
    episodeChecks = {};
    (data||[]).forEach(r => { episodeChecks[r.key] = true; });
  } else {
    try { episodeChecks = JSON.parse(localStorage.getItem('tmv_ep') || '{}'); } catch(e) { episodeChecks = {}; }
  }
}

async function saveEpCheck(key, checked) {
  if (currentUser) {
    if (checked) {
      assertSupabase(await sb.from('episode_checks').upsert({ user_id: currentUser.id, key, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' }), 'Could not save episode progress.');
    } else {
      assertSupabase(await sb.from('episode_checks').delete().eq('key', key).eq('user_id', currentUser.id), 'Could not save episode progress.');
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
    assertSupabase(await sb.from('episode_checks').upsert(rows, { onConflict: 'user_id,key' }), 'Could not save episode progress.');
    keys.forEach(k => { episodeChecks[k] = true; });
  } else {
    keys.forEach(k => { episodeChecks[k] = true; });
    try { localStorage.setItem('tmv_ep', JSON.stringify(episodeChecks)); } catch(e) {}
  }
}

async function removeAllEpChecks(keys) {
  if (!keys.length) return;
  if (currentUser) {
    assertSupabase(await sb.from('episode_checks').delete().eq('user_id', currentUser.id).in('key', keys), 'Could not clear episode progress.');
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
  try {
    const cached = JSON.parse(localStorage.getItem('tmv_air_status') || '{}');
    if (Date.now() - Number(cached.savedAt) < 21600000) Object.assign(airStatusCache, cached.values || {});
  } catch {}
  const tvIds = Object.values(watchlist)
    .map(v => v.item)
    .filter(i => i && (i.media_type === 'tv' || i.name))
    .map(i => i.id);
  const missingIds = tvIds.filter(id => !airStatusCache[id]);
  await Promise.allSettled(missingIds.map(async id => {
    try {
      const d = await tmdbFetch(`tv/${Number(id)}`, { language: 'en-US' });
      const s = getAirStatus(d, 'tv');
      if (s) airStatusCache[id] = s;
    } catch(e) {}
  }));
  try { localStorage.setItem('tmv_air_status', JSON.stringify({ savedAt: Date.now(), values: airStatusCache })); } catch {}
}

async function bootApp() {
  // Clean up OAuth hash from URL
  if (window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname);
  }

  try {
    await Promise.all([loadGenres(), loadWatchlist(), loadEpisodeChecks()]);
  } catch (error) {
    showToast(error.message);
  }

  document.getElementById('auth-gate').style.setProperty('display', 'none', 'important');
  setDisplay('loading-screen', 'none');
  const app = document.getElementById('app');
  app.style.setProperty('display', 'flex', 'important');

  renderUserArea();
  setupSearch();
  updateCounts();
  const requestedTab = new URLSearchParams(window.location.search).get('tab');
  if (['discover', 'watchlist', 'watching', 'watched'].includes(requestedTab)) switchTab(requestedTab, true);
  else loadDiscover();
  prefetchAirStatus().then(() => {
    if (currentTab === 'discover') loadDiscover();
    else renderWatchlistTab(currentTab);
  });
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
  document.querySelector('#telegram-popup .modal-backdrop').addEventListener('click', closeTelegramPopup);
  document.querySelector('#telegram-popup .modal-cancel').addEventListener('click', closeTelegramPopup);
  document.getElementById('telegram-popup').addEventListener('keydown', trapDialogFocus);
  document.getElementById('watched-popup-backdrop').addEventListener('click', closeWatchedPopup);
  document.querySelector('#watched-popup .wpop-confirm').addEventListener('click', confirmWatched);
  document.querySelector('#watched-popup .wpop-cancel').addEventListener('click', closeWatchedPopup);
  document.getElementById('status-popup').addEventListener('keydown', trapDialogFocus);
  document.getElementById('watched-popup').addEventListener('keydown', trapDialogFocus);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('status-popup').style.display === 'flex') closeStatusPopup();
    else if (document.getElementById('watched-popup').style.display === 'flex') closeWatchedPopup();
    else if (document.getElementById('detail-view').style.display === 'flex') closeDetail();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopActiveTrailer();
  });
  window.addEventListener('pagehide', () => stopActiveTrailer(true));

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
    if (isGuestBuildHost()) {
      setDisplay('auth-gate', 'none');
      setDisplay('loading-screen', 'flex');
      await bootApp();
      return;
    }
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
    } else if (isGuestBuildHost()) {
      await bootApp();
    } else {
      setDisplay('loading-screen', 'none');
      setDisplay('auth-gate', 'flex');
    }

    // Listen for sign out
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        if (isGuestBuildHost()) {
          window.location.reload();
          return;
        }
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
    const guest = document.createElement('button');
    guest.className = 'user-guest-btn';
    guest.type = 'button';
    guest.textContent = isGuestBuildHost() ? 'Sign in' : '⎋ Guest';
    guest.addEventListener('click', isGuestBuildHost() ? signInGoogle : signOut);
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
  pill.setAttribute('aria-haspopup', 'menu');
  pill.setAttribute('aria-expanded', 'false');
  pill.addEventListener('click', toggleUserMenu);

  const menu = document.createElement('div');
  menu.className = 'user-menu';
  menu.id = 'user-menu';
  menu.setAttribute('role', 'menu');
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
  const telegramButton = document.createElement('button');
  telegramButton.className = 'user-menu-btn user-menu-telegram';
  telegramButton.setAttribute('role', 'menuitem');
  telegramButton.textContent = 'Telegram Notifications';
  telegramButton.addEventListener('click', openTelegramPopup);
  const signOutButton = document.createElement('button');
  signOutButton.className = 'user-menu-btn';
  signOutButton.setAttribute('role', 'menuitem');
  signOutButton.textContent = '⎋ Sign out';
  signOutButton.addEventListener('click', signOut);
  menu.append(info, divider, telegramButton, signOutButton);
  area.append(pill, menu);
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  const open = menu?.classList.toggle('open');
  document.querySelector('.user-pill')?.setAttribute('aria-expanded', String(!!open));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.user-pill')) document.getElementById('user-menu')?.classList.remove('open');
});

// ─── TELEGRAM NOTIFICATIONS ──────────────────────────────────────
async function notifierRequest(path, options = {}) {
  const { data, error } = await sb.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Please sign in again.');
  const response = await fetch(`${NOTIFIER_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Telegram notifications are unavailable.');
  return payload;
}

function closeTelegramPopup() {
  const popup = document.getElementById('telegram-popup');
  popup.style.display = 'none';
  popup.setAttribute('aria-hidden', 'true');
}

async function openTelegramPopup() {
  const popup = document.getElementById('telegram-popup');
  const state = document.getElementById('telegram-state');
  const actions = document.getElementById('telegram-actions');
  popup.style.display = 'flex';
  popup.setAttribute('aria-hidden', 'false');
  state.textContent = 'Checking connection…';
  actions.replaceChildren();

  try {
    renderTelegramState(await notifierRequest('/api/telegram/status'));
  } catch (error) {
    state.textContent = error.message;
  }
}

function telegramAction(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `modal-btn ${className}`;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });
  return button;
}

function renderTelegramState(connection) {
  const state = document.getElementById('telegram-state');
  const actions = document.getElementById('telegram-actions');
  actions.replaceChildren();
  if (connection.state === 'not_connected') {
    state.textContent = 'Not connected';
    actions.append(telegramAction('Connect', 'telegram-primary', connectTelegram));
    return;
  }

  const suffix = connection.username ? ` · @${connection.username}` : '';
  state.textContent = connection.state === 'connected'
    ? `Connected${suffix}`
    : `Notifications disabled${suffix}`;
  if (connection.state === 'connected') {
    actions.append(telegramAction('Disable', 'modal-cancel', async () => {
      await notifierRequest('/api/telegram/disable', { method: 'POST' });
      renderTelegramState(await notifierRequest('/api/telegram/status'));
      renderTelegramWatchingBanner();
    }));
  } else {
    actions.append(telegramAction('Enable', 'telegram-primary', async () => {
      await notifierRequest('/api/telegram/enable', { method: 'POST' });
      renderTelegramState(await notifierRequest('/api/telegram/status'));
      renderTelegramWatchingBanner();
    }));
  }
  actions.append(telegramAction('Reconnect', 'modal-cancel', connectTelegram));
  actions.append(telegramAction('Disconnect', 'telegram-danger', async () => {
    await notifierRequest('/api/telegram/disconnect', { method: 'DELETE' });
    renderTelegramState({ state: 'not_connected' });
    renderTelegramWatchingBanner();
  }));
}

async function connectTelegram() {
  const telegramWindow = window.open('about:blank', '_blank');
  if (telegramWindow) telegramWindow.opener = null;
  try {
    const result = await notifierRequest('/api/telegram/connect', { method: 'POST' });
    if (telegramWindow) telegramWindow.location.replace(result.deepLink);
    else window.open(result.deepLink, '_blank', 'noopener,noreferrer');
    watchTelegramConnection();
  } catch (error) {
    telegramWindow?.close();
    throw error;
  }
}

function watchTelegramConnection() {
  clearInterval(telegramConnectionPoll);
  let checks = 0;
  const refresh = async () => {
    checks += 1;
    try {
      const connection = await notifierRequest('/api/telegram/status');
      if (connection.state === 'connected') {
        clearInterval(telegramConnectionPoll);
        telegramConnectionPoll = null;
      }
      if (document.getElementById('telegram-popup').style.display === 'flex') renderTelegramState(connection);
      if (document.getElementById('telegram-watching-banner')) renderTelegramWatchingBanner();
    } catch {}
    if (checks >= 40) {
      clearInterval(telegramConnectionPoll);
      telegramConnectionPoll = null;
    }
  };
  refresh();
  telegramConnectionPoll = setInterval(refresh, 3000);
}

async function renderTelegramWatchingBanner() {
  const banner = document.getElementById('telegram-watching-banner');
  if (!banner || !currentUser) return;
  banner.className = 'telegram-watching-banner telegram-watching-loading';
  banner.textContent = 'Checking Telegram notifications…';
  try {
    const connection = await notifierRequest('/api/telegram/status');
    if (!document.getElementById('telegram-watching-banner')) return;
    const connected = connection.state === 'connected';
    banner.className = `telegram-watching-banner telegram-watching-${connection.state}`;
    banner.innerHTML = `
      <div class="telegram-watching-content">
        <div class="telegram-watching-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M20.6 4.1 3.8 10.6c-1.1.4-1.1 1.1-.2 1.4l4.3 1.3 1.7 5.1c.2.6.1.8.8.8.5 0 .8-.2 1-.4l2.1-2 4.4 3.2c.8.5 1.4.2 1.6-.8l2.9-13.7c.3-1.2-.5-1.8-1.8-1.4ZM9.2 13l8.4-5.3c.4-.2.8-.1.5.2l-6.9 6.2-.3 3.3L9.2 13Z"></path></svg>
        </div>
        <div class="telegram-watching-copy">
          <div class="telegram-watching-title">${connected ? 'Telegram notifications enabled' : 'Get notified about new episodes'}</div>
          <div class="telegram-watching-desc">${connected
            ? 'New episodes from your Watching list will be sent to Telegram.'
            : 'Connect Telegram and receive notifications when new episodes are released.'}</div>
        </div>
      </div>
      <button class="telegram-watching-action" type="button">${connected ? 'Manage' : connection.state === 'disabled' ? 'Enable' : 'Connect Telegram'}</button>`;
    banner.querySelector('.telegram-watching-action').addEventListener('click', async () => {
      if (connection.state === 'disabled') {
        await notifierRequest('/api/telegram/enable', { method: 'POST' });
        renderTelegramWatchingBanner();
      } else {
        openTelegramPopup();
      }
    });
  } catch {
    banner.remove();
  }
}

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
  searchController?.abort();
  searchController = new AbortController();
  showLoading();
  try {
    const d = await tmdbFetch('search/multi', { language: lang, query: q, include_adult: 'false', signal: searchController.signal });
    const results = (d.results||[]).filter(x => x.media_type==='movie'||x.media_type==='tv');
    renderGrid(results, `Results for "${q}"`);
  } catch(e) {
    if (e.name !== 'AbortError') renderError();
  }
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
    const key = itemKey(item.id, type);
    const state  = watchlist[key]?.status || null;
    const genreNames = (item.genre_ids||[]).slice(0,2).map(id=>genreMap[id]).filter(Boolean);
    const genreText  = escapeHtml(genreNames.join(' · '));
    const seasons    = type==='tv' && Number.isInteger(Number(item.number_of_seasons)) ? Number(item.number_of_seasons) : null;
    const airSt      = type==='tv' ? airStatusCache[item.id] : null;
    const airLabels  = { onair:'● On Air', ended:'■ Finished', canceled:'✕ Canceled' };

    const div = document.createElement('div');
    div.className = `card${state ? ` card-status-${state}` : ''}`;
    div.dataset.id = item.id;
    div.dataset.type = type;
    div.innerHTML = `
      ${poster ? `<img class="card-poster" src="${poster}" alt="${title}" loading="lazy" decoding="async">` : `<div class="card-poster-placeholder">🎬</div>`}
      <div class="card-overlay"></div>
      <button class="card-open-button" type="button" aria-label="Open details for ${title}"></button>
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
    div.querySelector('.card-open-button').addEventListener('click', () => openDetail(item.id, type));
    grid.appendChild(div);
  });
}

async function applyCardStatusChange(id, status, item, cardEl) {
  try {
    await toggleWatchlistDB(id, status, item);
    updateCounts();
    updateCardUI(id, cardEl);
    if (currentTab !== 'discover') renderWatchlistTab(currentTab);
  } catch {}
}

function openStatusPopup(id, status, item, cardEl) {
  const labels = { watchlist:'Watchlist', watching:'Watching', watched:'Watched' };
  const currentStatus = watchlist[itemKey(id, itemType(item))]?.status || null;
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
  openDialog(document.getElementById('status-popup'), document.getElementById('status-popup-confirm'));
}

async function confirmStatusChange() {
  if (!_statusChange) return;
  const { id, status, item, cardEl } = _statusChange;
  const confirmBtn = document.getElementById('status-popup-confirm');
  confirmBtn.disabled = true;
  try {
    await applyCardStatusChange(id, status, item, cardEl);
    closeStatusPopup();
  } finally {
    confirmBtn.disabled = false;
  }
}

function closeStatusPopup() {
  closeDialog(document.getElementById('status-popup'));
  _statusChange = null;
}

function updateCardUI(id, cardEl) {
  const type = cardEl?.dataset.type || 'movie';
  const state = watchlist[itemKey(id, type)]?.status || null;
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
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
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
  const telegramBanner = tab === 'watching' && currentUser ? '<div id="telegram-watching-banner"></div>' : '';
  if (!items.length) {
    c.innerHTML = `${telegramBanner}<div class="empty-state empty-state-status">${statusIcon(tab)}<p>${labels[tab]}</p></div>`;
    if (telegramBanner) renderTelegramWatchingBanner();
    return;
  }
  c.innerHTML = `${telegramBanner}<div class="section-label">${items.length} title${items.length!==1?'s':''}</div><div class="grid" id="g-wl"></div>`;
  renderCards(items.map(i=>({...i, media_type: i.media_type||(i.title?'movie':'tv')})), 'g-wl');
  if (telegramBanner) renderTelegramWatchingBanner();
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
  const state = watchlist[itemKey(id, type)]?.status || null;
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
      ${backdrop?`<img class="detail-backdrop" src="${backdrop}" alt="" width="1280" height="720" decoding="async">`:'<div class="detail-backdrop-placeholder"></div>'}
      <div class="detail-gradient"></div>
      <div class="detail-content">
        ${poster?`<img class="detail-poster" src="${poster}" alt="${title}" decoding="async">`:`<div class="detail-poster-ph">🎬</div>`}
        <div class="detail-info">
          <div class="detail-title">${title}</div>
          ${data.tagline?`<div class="detail-tagline">${escapeHtml(data.tagline)}</div>`:''}
          <div class="detail-chips">
            ${year?`<span class="chip">${year}</span>`:''}
            <span class="chip">${type==='tv'?'Series':'Movie'}</span>
            ${data.vote_average?`<span class="chip tmdb-rating"><strong>TMDB</strong> ★ ${Math.round(data.vote_average*10)/10}</span>`:''}
            ${imdbUrl?`<a class="chip imdb-link" href="${imdbUrl}" target="_blank" rel="noopener noreferrer">
              IMDb
              <svg class="external-link-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 16 16 8M10 8h6v6"></path>
              </svg>
            </a>`:''}
            ${airBadgeHtml}
          </div>
        </div>
        ${trailer ? `
          <div class="detail-trailer">
            <div class="trailer-label">Trailer</div>
            <button class="trailer-preview" type="button" data-youtube-key="${trailer.key}" aria-label="Play trailer">
              <img src="https://i.ytimg.com/vi/${trailer.key}/hqdefault.jpg" alt="" width="480" height="360" loading="lazy" decoding="async">
              <span class="trailer-shade"></span>
              <span class="trailer-play" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="m9 6 10 6-10 6V6Z"></path></svg>
              </span>
              <span class="trailer-cta">Watch trailer</span>
            </button>
          </div>` : ''}
      </div>
    </div>
    <div class="detail-body">
      <button class="detail-back" id="back-btn" type="button">← Back</button>
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
    iframe.src = `https://www.youtube-nocookie.com/embed/${key}?autoplay=1&rel=0&enablejsapi=1&playsinline=1`;
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
      const newState = watchlist[itemKey(id, type)]?.status || null;
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
  for (let n = 1; n <= count; n++) {
    const block = document.createElement('div');
    block.className = 'season-block';
    block.dataset.season = n;
    block.innerHTML = `
      <button class="season-header" type="button" aria-expanded="false">
        <span class="season-name">Season ${n}</span>
        <span class="season-header-actions">
          <span class="season-ep-count">Load episodes</span>
          <span class="season-chevron" aria-hidden="true">▾</span>
        </span>
      </button>
      <div class="episodes-list"><div class="season-loading">Open season to load episodes.</div></div>`;
    block.querySelector('.season-header').addEventListener('click', async function() {
      const list = this.nextElementSibling;
      const opening = !list.classList.contains('open');
      this.classList.toggle('open', opening);
      this.setAttribute('aria-expanded', String(opening));
      list.classList.toggle('open', opening);
      if (opening && block.dataset.loaded !== 'true') {
        await loadSeasonEpisodes(block, showId, n, allowWatchedSuggestion);
      }
    });
    sec.appendChild(block);
  }
}

async function loadSeasonEpisodes(block, showId, seasonNumber, allowWatchedSuggestion) {
  const list = block.querySelector('.episodes-list');
  list.innerHTML = '<div class="season-loading">Loading episodes...</div>';
  try {
    const s = await tmdbFetch(`tv/${Number(showId)}/season/${seasonNumber}`, { language: 'en-US' });
    const eps = s.episodes || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const showKey = itemKey(showId, 'tv');

    if (watchlist[showKey]?.status === 'watched') {
      const missingKeys = eps.filter(ep => {
        if (!ep.air_date) return false;
        const air = new Date(ep.air_date); air.setHours(0,0,0,0);
        return air <= today && !episodeChecks[`${showId}_s${seasonNumber}_e${ep.episode_number}`];
      }).map(ep => `${showId}_s${seasonNumber}_e${ep.episode_number}`);
      if (missingKeys.length) await saveAllEpChecks(missingKeys);
    }

    const rows = eps.map(ep => {
      const episodeNumber = Number(ep.episode_number) || 0;
      const key = `${Number(showId) || 0}_s${seasonNumber}_e${episodeNumber}`;
      const done = !!episodeChecks[key];
      let released = false, daysLeft = null;
      if (ep.air_date) {
        const air = new Date(ep.air_date); air.setHours(0,0,0,0);
        released = air <= today;
        if (!released) daysLeft = Math.round((air - today) / 86400000);
      }
      const rowClass = ['episode-row', done?'ep-done':'', released?'ep-released':'ep-unreleased'].filter(Boolean).join(' ');
      const countdown = (!released && daysLeft!==null)
        ? `<span class="ep-countdown${daysLeft<=7?' soon':''}">${daysLeft===0?'Today!':daysLeft===1?'Tomorrow':daysLeft+'d'}</span>` : '';
      return `<div class="${rowClass}">
        <input type="checkbox" class="ep-check" aria-label="Mark episode ${episodeNumber} watched" ${done?'checked':''} ${!released?'disabled':''} data-key="${key}">
        <span class="ep-num">E${episodeNumber}</span>
        <span class="ep-title">${escapeHtml(ep.name||'Episode '+episodeNumber)}</span>
        ${countdown}
        ${ep.air_date?`<span class="ep-date">${escapeHtml(ep.air_date)}</span>`:''}
      </div>`;
    }).join('');

    block.querySelector('.season-name').textContent = s.name || `Season ${seasonNumber}`;
    block.querySelector('.season-ep-count').textContent = `${eps.length} ep`;
    list.innerHTML = `<div class="season-bulk-bar"><span class="season-bulk-label">Released episodes</span><button class="season-bulk-btn" type="button"></button></div>${rows}`;
    block.dataset.loaded = 'true';

    const bulkBtn = block.querySelector('.season-bulk-btn');
    const releasedChecks = Array.from(block.querySelectorAll('.ep-released .ep-check'));
    if (!releasedChecks.length) bulkBtn.remove();
    else syncSeasonBulkButton(block);

    bulkBtn?.addEventListener('click', async event => {
      event.stopPropagation();
      bulkBtn.disabled = true;
      const shouldClear = releasedChecks.every(cb => cb.checked);
      const changedChecks = releasedChecks.filter(cb => cb.checked === shouldClear);
      const keys = changedChecks.map(cb => cb.dataset.key);
      changedChecks.forEach(cb => {
        cb.checked = !shouldClear;
        cb.closest('.episode-row').classList.toggle('ep-done', !shouldClear);
      });
      try {
        if (shouldClear) await removeAllEpChecks(keys);
        else await saveAllEpChecks(keys);
        syncSeasonBulkButton(block);
        if (!shouldClear) checkAllWatched(showId, allowWatchedSuggestion);
      } catch (error) {
        showToast(error.message);
      } finally {
        bulkBtn.disabled = false;
      }
    });

    block.querySelectorAll('.ep-check').forEach(cb => {
      cb.addEventListener('change', async function() {
        if (this.disabled) return;
        const previous = !this.checked;
        this.closest('.episode-row').classList.toggle('ep-done', this.checked);
        try {
          await saveEpCheck(this.dataset.key, this.checked);
          if (this.checked) episodeChecks[this.dataset.key] = true;
          else delete episodeChecks[this.dataset.key];
          syncSeasonBulkButton(block);
          checkAllWatched(showId, allowWatchedSuggestion);
        } catch (error) {
          this.checked = previous;
          this.closest('.episode-row').classList.toggle('ep-done', previous);
          showToast(error.message);
        }
      });
    });
    const allBlocks = Array.from(document.querySelectorAll('#seasons-section .season-block'));
    document.getElementById('seasons-section').dataset.seasonsLoaded = String(allBlocks.every(item => item.dataset.loaded === 'true'));
  } catch (error) {
    list.innerHTML = '<div class="season-error">Could not load this season. Close and reopen to retry.</div>';
    showToast('Could not load this season.');
  }
}

function checkAllWatched(showId, allowWatchedSuggestion) {
  if (!allowWatchedSuggestion) return;
  const sec = document.getElementById('seasons-section');
  if (!sec || sec.dataset.seasonsLoaded !== 'true') return;
  const allReleased = sec.querySelectorAll('.ep-released .ep-check');
  if (!allReleased.length) return;
  if (Array.from(allReleased).every(cb=>cb.checked) && watchlist[itemKey(showId, 'tv')]?.status!=='watched') {
    _popupShowId = showId;
    _popupData   = watchlist[itemKey(showId, 'tv')]?.item || { id: showId, media_type: 'tv' };
    openDialog(document.getElementById('watched-popup'), document.querySelector('#watched-popup .wpop-confirm'));
  }
}

async function confirmWatched() {
  if (_popupShowId===null) return;
  const id   = _popupShowId;
  const key = itemKey(id, 'tv');
  const item = _popupData || watchlist[key]?.item || { id, media_type: 'tv' };
  await toggleWatchlistDB(id, 'watched', item);
  // Make sure it's set to watched (toggle would remove if already watched)
  if (!watchlist[key] || watchlist[key].status !== 'watched') {
    watchlist[key] = { status: 'watched', item };
    if (currentUser) {
      assertSupabase(await sb.from('watchlist').upsert({
        user_id: currentUser.id, show_id: id, media_type: 'tv', status: 'watched', item,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,show_id,media_type' }), 'Could not move this series to Watched.');
    }
  }
  updateCounts();
  document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.act-watched')?.classList.add('active');
  tickAllRenderedEpisodes();
  closeWatchedPopup();
}

function closeWatchedPopup() {
  closeDialog(document.getElementById('watched-popup'));
  _popupShowId = null; _popupData = null;
}

function closeDetail() {
  stopActiveTrailer(true);
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
