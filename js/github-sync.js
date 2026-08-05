// ══════════════════════════════════════════════════════════════════
// github-sync.js — pushes open positions to scripts/positions.json
// v1.0
//
// WHY: localStorage (a49_positions) only lives in this browser tab.
// GitHub Actions can't read it, so alert-runner.js has no idea what's
// open when the laptop is asleep — which is exactly when a stop or T1
// is most likely to get hit. This module pushes the same position
// store the GUI already maintains straight into the repo via the
// GitHub Contents API, so the server-side runner can watch it too.
//
// FLOW:
//   position-tracker.js savePositions() → scheduleGithubSync()
//     → debounce ~4s → syncPositionsToGitHub()
//        → GET current file sha (if any) → PUT updated content
//   + a periodic safety-net tick (every ~60s) re-pushes if the
//     configured interval has elapsed and content actually changed.
//
// This is one-directional: browser → GitHub. The server only reads
// positions.json to decide when to alert; it never writes it back,
// so the browser's localStorage stays the single source of truth.
// ══════════════════════════════════════════════════════════════════

const GH_SYNC_KEY = `${_REPO_NS}_gh_sync_cfg`;

// ── symbol-history.json push — browser side ──
// Best-effort, PAT/GH_PAT-gated, same as position sync. Only fires on
// stop/T2 close events (rare), so a direct GET+merge+PUT per event is fine —
// no need for a polling loop like positions.json has.
const HISTORY_RETENTION_DAYS = 45;  // keep in sync with LB_HISTORY_RETENTION_DAYS default in leaderboard-decider.js
const HISTORY_MAX_ROWS       = 1500; // hard cap regardless of days — mirrors LB_HISTORY_MAX_ROWS default
window._historyQueue = window._historyQueue || []; // rows waiting to be pushed
let _historyPushTimer    = null;
let _historyPushInFlight = false;

// Bump this version whenever defaults change — triggers a one-time migration
// that resets mode/enabled to new defaults while keeping PAT credentials intact.
const GH_SYNC_CFG_VERSION = 4; // v4: Option B default with pull from GitHub, repo field

const DEFAULT_GH_SYNC_CFG = {
  _version:     GH_SYNC_CFG_VERSION,
  enabled:      true,      // ON by default — sync starts immediately when repo is configured
  mode:         'secrets', // Option B by default — headless-first, no PAT needed
  token:        '',        // GitHub PAT — fine-grained, "Contents: Read and write" on this repo
  repo:         '',        // "yourname/your-repo"
  branch:       'main',
  path:         'scripts/positions.json',
  intervalMins: 3,         // periodic safety-net push interval (Option A only)
  workerUrl:    '',        // Option B ONLY, watchlists only — alpha-fetch-checker Worker URL
                            // (e.g. https://alpha-fetch-checker.<subdomain>.workers.dev).
                            // Option B has no working browser PAT (window.__GH_PAT is always
                            // blank — see syncWatchlistsToGitHub() below), so watchlist pushes
                            // go through this Worker's own persistent PAT instead. Positions
                            // sync is unaffected — Option B pulls positions.json, it never
                            // pushes it, so it never needed a PAT in the first place.
  workerToken:  '',        // matches the Worker's SYNC_TOKEN secret, sent as Bearer auth
};

function loadGhSyncCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(GH_SYNC_KEY) || '{}');
    const savedVersion = raw._version || 0;
    // Version migration — reset mode and enabled to new defaults, keep credentials
    if (savedVersion < GH_SYNC_CFG_VERSION) {
      console.log(`[github-sync] Config v${savedVersion} → v${GH_SYNC_CFG_VERSION}: resetting mode/enabled to defaults`);
      const migrated = {
        ...DEFAULT_GH_SYNC_CFG,
        // Preserve any PAT/repo/branch the user already entered
        // Reset mode to 'pat' — fixes users stuck on broken Option B default
        mode:         raw.token ? 'pat' : (raw.mode || 'secrets'),
        token:        raw.token        || '',
        repo:         raw.repo         || '',
        branch:       raw.branch       || 'main',
        path:         raw.path         || 'scripts/positions.json',
        intervalMins: raw.intervalMins || 3,
        workerUrl:    raw.workerUrl    || '',
        workerToken:  raw.workerToken  || '',
      };
      localStorage.setItem(GH_SYNC_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return { ...DEFAULT_GH_SYNC_CFG, ...raw };
  } catch { return { ...DEFAULT_GH_SYNC_CFG }; }
}

function saveGhSyncCfg(cfg) {
  localStorage.setItem(GH_SYNC_KEY, JSON.stringify(cfg));
}

// ── Runtime status (not persisted — resets each session) ──
window._ghSyncState = window._ghSyncState || {
  lastSyncAt:   0,
  lastError:    null,
  lastPushedJSON: null,
  syncing:      false,
};

let _ghSyncTimer   = null;
let _ghSyncInFlight = false;
let _ghSyncQueued   = false;

// ══════════════════════════════════════════════════════════════════
// DEBOUNCED TRIGGER — called from position-tracker.js after every
// savePositions(). Batches rapid-fire changes into one push.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// OPTION B — Pull positions.json FROM GitHub into localStorage
// Runs on page load when mode='secrets' so the GUI shows headless
// positions written by leaderboard-decider.js without any browser sync.
// ══════════════════════════════════════════════════════════════════
async function pullPositionsFromGitHub() {
  const cfg   = loadGhSyncCfg();
  if (cfg.mode !== 'secrets') return; // Option A manages its own state

  // Use GH_PAT secret from env.js OR fall back to GITHUB_TOKEN isn't
  // available client-side, so we need GH_PAT set as a repo secret exposed
  // via env.js, OR the user can leave Option B and just view headless data
  // by refreshing — the runner commits positions.json every run.
  //
  // Simplest working approach: fetch the raw file from the public repo URL.
  // This works for public repos without any auth.
  const repo   = cfg.repo || window.__GH_REPO || '';
  const branch = cfg.branch || 'main';
  const fpath  = cfg.path  || 'scripts/positions.json';

  if (!repo) return; // no repo configured

  try {
    // Try raw.githubusercontent.com first (public repos, no auth needed)
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${fpath}?t=${Date.now()}`;
    const r = await fetch(rawUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const remote = await r.json();

    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;

    const localPositions = (typeof loadPositions === 'function') ? loadPositions() : {};
    const localKeys  = Object.keys(localPositions);
    const remoteKeys = Object.keys(remote);

    if (remoteKeys.length === 0 && localKeys.length > 0) {
      // Remote is empty but local has data — don't overwrite local with empty
      return;
    }

    // Merge: remote wins for symbols it knows about, local wins for anything extra
    const merged = { ...localPositions, ...remote };

    if (typeof savePositions === 'function') savePositions(merged);
    logAlertItem('info', `☁ Option B — pulled ${remoteKeys.length} position(s) from GitHub`);

    // Refresh the position tracker display
    if (typeof renderAlertCfgPage === 'function') renderAlertCfgPage();

  } catch (e) {
    // Silently fail — this is a best-effort pull
    console.log(`[gh-sync pull] ${e.message}`);
  }
}

// Pull on page load (Option B) — deferred so the rest of the app inits first
setTimeout(() => {
  const cfg = loadGhSyncCfg();
  if (cfg.mode === 'secrets') pullPositionsFromGitHub();
}, 3000);

function scheduleGithubSync(delayMs = 4000) {
  const cfg = loadGhSyncCfg();
  if (!cfg.enabled) return;
  if (_ghSyncTimer) clearTimeout(_ghSyncTimer);
  _ghSyncTimer = setTimeout(() => {
    _ghSyncTimer = null;
    syncPositionsToGitHub();
  }, delayMs);
}

// ══════════════════════════════════════════════════════════════════
// WATCHLIST SYNC — separate debounce/in-flight state from positions
// sync above, so editing named watchlists and position changes don't
// block or cancel each other's pending pushes.
// ══════════════════════════════════════════════════════════════════
let _ghWatchlistSyncTimer   = null;
let _ghWatchlistSyncInFlight = false;
let _ghWatchlistSyncQueued   = false;

function scheduleWatchlistSync(delayMs = 4000) {
  const cfg = loadGhSyncCfg();
  if (!cfg.enabled) return;
  if (_ghWatchlistSyncTimer) clearTimeout(_ghWatchlistSyncTimer);
  _ghWatchlistSyncTimer = setTimeout(() => {
    _ghWatchlistSyncTimer = null;
    syncWatchlistsToGitHub();
  }, delayMs);
}

// ══════════════════════════════════════════════════════════════════
// FLUSH-ON-EXIT — a pending scheduleWatchlistSync() timer is a plain
// in-memory setTimeout. If the tab is closed, reloaded, or navigated
// away from before that timer fires, the edit sitting in
// STATE.namedWatchlists (already in localStorage) never actually
// reaches the Worker/GitHub — it just gets silently overwritten by
// the next init() re-fetch of the (stale) repo copy on reload. This
// fires the pending sync immediately, best-effort, the moment the tab
// starts going away, instead of waiting out the rest of the debounce.
// keepalive:true lets the fetch survive the page unload in most
// browsers (same mechanism sendBeacon relies on).
// ══════════════════════════════════════════════════════════════════
function _flushPendingWatchlistSync() {
  if (!_ghWatchlistSyncTimer) return; // nothing pending — normal case, no-op
  clearTimeout(_ghWatchlistSyncTimer);
  _ghWatchlistSyncTimer = null;

  const cfg = loadGhSyncCfg();
  if (!cfg.enabled || cfg.mode !== 'secrets' || !cfg.workerUrl) return;

  const namedLists = (typeof STATE !== 'undefined' && STATE.namedWatchlists) ? STATE.namedWatchlists : {};
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.workerToken) headers['Authorization'] = `Bearer ${cfg.workerToken}`;
    fetch(cfg.workerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ namedWatchlists: namedLists }),
      keepalive: true, // survives page unload — best-effort, no response is read
    });
  } catch { /* best-effort only — nothing more we can do during unload */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _flushPendingWatchlistSync();
});
window.addEventListener('pagehide', _flushPendingWatchlistSync);

// ══════════════════════════════════════════════════════════════════
// CORE SYNC — GET sha (if file exists) → PUT updated content.
// manual=true bypasses the "enabled" gate so the Sync Now button
// always works even mid-setup, and surfaces config errors in the log.
// ══════════════════════════════════════════════════════════════════
async function syncPositionsToGitHub(manual = false) {
  const cfg = loadGhSyncCfg();

  if (!cfg.enabled && !manual) return { ok: false, reason: 'disabled' };

  // Token resolution: Option A (browser localStorage PAT) or Option B (GH_PAT secret
  // injected as window.__GH_PAT via a <meta> tag written by the GitHub Actions workflow).
  const resolvedToken = cfg.token || window.__GH_PAT || '';
  const resolvedRepo  = cfg.repo  || window.__GH_REPO || '';

  if (!resolvedToken || !resolvedRepo) {
    if (manual) logAlertItem('info', '⚠ GitHub Sync — no token found. Set GH_PAT secret (Option B) or enter a PAT (Option A).');
    return { ok: false, reason: 'not configured' };
  }

  // Avoid overlapping requests — if one's in flight, queue exactly one follow-up.
  if (_ghSyncInFlight) { _ghSyncQueued = true; return { ok: false, reason: 'in-flight' }; }
  _ghSyncInFlight = true;
  window._ghSyncState.syncing = true;

  try {
    const positions = (typeof loadPositions === 'function') ? loadPositions() : {};
    const json = JSON.stringify(positions, null, 2);

    // Skip the push entirely if nothing has actually changed since the
    // last successful sync — keeps commit history clean and avoids
    // burning API calls on no-op pushes from the periodic safety-net tick.
    if (!manual && json === window._ghSyncState.lastPushedJSON) {
      return { ok: true, reason: 'unchanged' };
    }

    const branch  = cfg.branch || 'main';
    const apiBase = `https://api.github.com/repos/${resolvedRepo}/contents/${cfg.path}`;
    const headers = {
      'Authorization':        `Bearer ${resolvedToken}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // ── 1. Look up the current file sha (needed to update vs. create) ──
    let sha = null;
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha || null;
    } else if (getRes.status !== 404) {
      throw new Error(`GET ${getRes.status} — check token scope / repo name`);
    }

    // UTF-8-safe base64 encode
    const content = btoa(unescape(encodeURIComponent(json)));

    const putBody = {
      message: `chore: sync positions (${Object.keys(positions).length} open) [skip ci]`,
      content,
      branch,
    };
    if (sha) putBody.sha = sha;

    let putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });

    // Lost a race with another writer (e.g. Actions touched the same file) — refetch sha, retry once.
    if (!putRes.ok && putRes.status === 409) {
      const getRes2 = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (getRes2.ok) {
        const j2 = await getRes2.json();
        putBody.sha = j2.sha || undefined;
        putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });
      }
    }

    if (!putRes.ok) {
      const errJson = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${errJson.message || ''}`.trim());
    }

    window._ghSyncState.lastSyncAt     = Date.now();
    window._ghSyncState.lastError      = null;
    window._ghSyncState.lastPushedJSON = json;

    // Sync succeeded — log and refresh status
    const posCount = Object.keys(positions).length;
    const posNames = Object.keys(positions).join(', ') || 'none';
    logAlertItem('info', `☁ GitHub sync OK — ${posCount} position(s) → ${resolvedRepo}`);
    if (posCount === 0) {
      logAlertItem('info', `ℹ No positions in local cache yet. A leaderboard buy alert must fire first to populate positions.`);
    } else {
      logAlertItem('info', `  Synced: ${posNames}`);
    }
    // Write to audit log (best-effort — needs Option A PAT)
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_sync_ok', { count: posCount, symbols: posNames, repo: resolvedRepo });
    }

    _refreshGhSyncStatusDOM();
    return { ok: true };

  } catch (e) {
    window._ghSyncState.lastError = e.message;
    // Surface actionable error messages
    let hint = '';
    if (e.message.includes('401')) hint = ' — PAT invalid or expired';
    else if (e.message.includes('403')) hint = ' — PAT lacks Contents:Write permission';
    else if (e.message.includes('404')) hint = ' — repo not found, check owner/repo field';
    else if (e.message.includes('not configured')) hint = ' — enter owner/repo and PAT then Save';
    logAlertItem('info', `☁ GitHub sync FAILED — ${e.message}${hint}`);
    // Write failure to audit (best-effort)
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_sync_failed', { error: e.message + hint, repo: resolvedRepo || '?' });
    }
    _refreshGhSyncStatusDOM();
    return { ok: false, reason: e.message };

  } finally {
    _ghSyncInFlight = false;
    window._ghSyncState.syncing = false;
    if (_ghSyncQueued) { _ghSyncQueued = false; scheduleGithubSync(2000); }
  }
}

// ══════════════════════════════════════════════════════════════════
// WATCHLIST SYNC — pushes STATE.namedWatchlists (the { listName:
// { SYMBOL: tgOnBoolean } } structure managed by the watchlist manager UI)
// to watchlist-source.json in the repo. Mirrors syncPositionsToGitHub()'s
// exact mechanics (same token resolution, same GET-sha/PUT/409-retry
// pattern) so it behaves identically and reuses the same GitHub Sync
// config (Option A PAT / Option B secrets) already set up for positions —
// no separate credentials needed.
//
// File shape written: { "Crypto": {"BINANCE:BTCUSDT": true}, "Stocks":
// {"AAPL.US": false} } — every named list, every symbol, with its
// per-symbol Telegram on/off state. This is deliberately NOT the flat
// array the backend reads: watchlist-source.json is the browser's own
// read/write source of truth (full lists + TG state); the separate
// alpha-watchlist-sync Cloudflare Worker computes the flattened, TG-on-
// only watchlist.json from this on its own schedule — the backend
// (market-fetcher/leaderboard-decider/alert-runner) still only ever
// reads that flat watchlist.json, unchanged.
// ══════════════════════════════════════════════════════════════════
async function syncWatchlistsToGitHub(manual = false) {
  const cfg = loadGhSyncCfg();

  if (!cfg.enabled && !manual) return { ok: false, reason: 'disabled' };

  if (_ghWatchlistSyncInFlight) { _ghWatchlistSyncQueued = true; return { ok: false, reason: 'in-flight' }; }
  _ghWatchlistSyncInFlight = true;

  try {
    const namedLists = (typeof STATE !== 'undefined' && STATE.namedWatchlists) ? STATE.namedWatchlists : {};
    const json = JSON.stringify(namedLists, null, 2);

    if (!manual && json === window._ghWatchlistSyncState?.lastPushedJSON) {
      return { ok: true, reason: 'unchanged' };
    }
    window._ghWatchlistSyncState = window._ghWatchlistSyncState || {};

    // Option B (mode='secrets') has no working browser PAT — window.__GH_PAT
    // is always blank by the time GitHub Pages serves env.js (alerts.yml
    // wipes it to blanks before every commit; see the DEPLOY.md /
    // worker.js note on this). So Option B routes through the
    // alpha-fetch-checker Worker instead, which holds its own persistent
    // PAT via `wrangler secret` and writes both watchlist-source.json AND
    // watchlist.json on our behalf. Option A (a user-entered PAT) still
    // writes directly to GitHub, unchanged.
    return cfg.mode === 'pat'
      ? await _syncWatchlistsViaPat(cfg, namedLists, json)
      : await _syncWatchlistsViaWorker(cfg, namedLists, json);

  } finally {
    _ghWatchlistSyncInFlight = false;
    if (_ghWatchlistSyncQueued) { _ghWatchlistSyncQueued = false; scheduleWatchlistSync(2000); }
  }
}

// ── Option A — direct GitHub Contents API PUT, using the browser-held PAT ──
async function _syncWatchlistsViaPat(cfg, namedLists, json) {
  const resolvedToken = cfg.token || window.__GH_PAT || '';
  const resolvedRepo  = cfg.repo  || window.__GH_REPO || '';

  if (!resolvedToken || !resolvedRepo) {
    logAlertItem('info', '⚠ GitHub Sync — no token found. Enter a PAT under Option A, or switch to Option B.');
    return { ok: false, reason: 'not configured' };
  }

  try {
    const branch  = cfg.branch || 'main';
    // Separate repo-variable-style path from cfg.path (which is
    // positions.json) — watchlist-source.json is the browser's own
    // read/write file, distinct from the computed watchlist.json the
    // backend reads, so the two syncs never target the same file.
    const wlPath  = cfg.watchlistSourcePath || 'watchlist-source.json';
    const apiBase = `https://api.github.com/repos/${resolvedRepo}/contents/${wlPath}`;
    const headers = {
      'Authorization':        `Bearer ${resolvedToken}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    let sha = null;
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha || null;
    } else if (getRes.status !== 404) {
      throw new Error(`GET ${getRes.status} — check token scope / repo name`);
    }

    const content = btoa(unescape(encodeURIComponent(json)));
    const totalSymbols = Object.values(namedLists).reduce((n, obj) => n + Object.keys(obj || {}).length, 0);
    const listNames = Object.keys(namedLists).join(', ') || 'none';

    const putBody = {
      message: `chore: sync watchlists (${listNames}) [skip ci]`,
      content,
      branch,
    };
    if (sha) putBody.sha = sha;

    let putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });

    if (!putRes.ok && putRes.status === 409) {
      const getRes2 = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (getRes2.ok) {
        const j2 = await getRes2.json();
        putBody.sha = j2.sha || undefined;
        putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });
      }
    }

    if (!putRes.ok) {
      const errJson = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${errJson.message || ''}`.trim());
    }

    window._ghWatchlistSyncState.lastSyncAt     = Date.now();
    window._ghWatchlistSyncState.lastError      = null;
    window._ghWatchlistSyncState.lastPushedJSON = json;

    logAlertItem('info', `☁ Watchlist sync OK — ${listNames} (${totalSymbols} symbol${totalSymbols === 1 ? '' : 's'}) → ${resolvedRepo}`);
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_watchlist_sync_ok', { lists: listNames, count: totalSymbols, repo: resolvedRepo });
    }

    _refreshGhSyncStatusDOM();
    return { ok: true };

  } catch (e) {
    window._ghWatchlistSyncState.lastError = e.message;
    let hint = '';
    if (e.message.includes('401')) hint = ' — PAT invalid or expired';
    else if (e.message.includes('403')) hint = ' — PAT lacks Contents:Write permission';
    else if (e.message.includes('404')) hint = ' — repo not found, check owner/repo field';
    logAlertItem('info', `☁ Watchlist sync FAILED — ${e.message}${hint}`);
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_watchlist_sync_failed', { error: e.message + hint, repo: resolvedRepo || '?' });
    }
    _refreshGhSyncStatusDOM();
    return { ok: false, reason: e.message };
  }
}

// ── Option B — POST to the alpha-fetch-checker Worker, which holds its
// own persistent GH_PAT and writes watchlist-source.json + watchlist.json
// on our behalf. See the comment above syncWatchlistsToGitHub() for why
// Option B can't PUT to GitHub directly the way Option A does. ──
async function _syncWatchlistsViaWorker(cfg, namedLists, json) {
  const workerUrl = (cfg.workerUrl || '').trim();

  if (!workerUrl) {
    logAlertItem('info', '⚠ GitHub Sync (Option B) — no Worker URL set. Enter the alpha-fetch-checker Worker URL under GitHub Sync settings.');
    return { ok: false, reason: 'not configured' };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.workerToken) headers['Authorization'] = `Bearer ${cfg.workerToken}`;

    const res = await fetch(workerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ namedWatchlists: namedLists }),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Worker HTTP ${res.status} — ${text || 'no detail'}`);

    const totalSymbols = Object.values(namedLists).reduce((n, obj) => n + Object.keys(obj || {}).length, 0);
    const listNames = Object.keys(namedLists).join(', ') || 'none';

    window._ghWatchlistSyncState.lastSyncAt     = Date.now();
    window._ghWatchlistSyncState.lastError      = null;
    window._ghWatchlistSyncState.lastPushedJSON = json;

    logAlertItem('info', `☁ Watchlist sync OK (via Worker) — ${listNames} (${totalSymbols} symbol${totalSymbols === 1 ? '' : 's'})`);
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_watchlist_sync_ok', { lists: listNames, count: totalSymbols, via: 'worker' });
    }

    _refreshGhSyncStatusDOM();
    return { ok: true };

  } catch (e) {
    window._ghWatchlistSyncState.lastError = e.message;
    let hint = '';
    if (e.message.includes('401')) hint = ' — Worker SYNC_TOKEN mismatch, check workerToken matches the Worker secret';
    else if (e.message.includes('500')) hint = ' — Worker missing GH_PAT/GH_REPO secret';
    else if (e.message.includes('Failed to fetch')) hint = ' — check the Worker URL is correct and deployed';
    logAlertItem('info', `☁ Watchlist sync FAILED — ${e.message}${hint}`);
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_watchlist_sync_failed', { error: e.message + hint, via: 'worker' });
    }
    _refreshGhSyncStatusDOM();
    return { ok: false, reason: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════
// SYMBOL-HISTORY PUSH — browser side companion to leaderboard-decider.js's
// headless history recording. Called from position-tracker.js whenever a
// position closes (stopped/tp2_hit) locally, e.g. because the browser tab
// was open and caught a price-based exit before the next headless Job B
// cycle did. Feeds the same scripts/symbol-history.json file that powers
// the ⭐ recommendation ranking in the Telegram buy alert.
//
// Best-effort only: needs Option A (browser PAT) or Option B (GH_PAT
// secret) — same credential resolution as positions sync. If neither is
// configured, rows just accumulate in window._historyQueue and are
// silently dropped on page close (headless Job B remains the source of
// truth either way, since it also records the same outcome on its own
// next cycle).
// ══════════════════════════════════════════════════════════════════
function queueHistoryOutcome(pos, price, outcome) {
  const entry  = pos.entryPrice || 0;
  const pnlPct = entry > 0 ? parseFloat(((price - entry) / entry * 100).toFixed(2)) : 0;
  window._historyQueue.push({
    base:       pos.base,
    pair:       pos.base + (pos.assetType === 'crypto' ? 'USDT' : ''),
    outcome,    // 'stopped' | 'tp2_hit'
    score:      pos.score,
    spikeScore: pos.spikeScore,
    pnlPct,
    closedAt:   Date.now(),
  });
  if (_historyPushTimer) clearTimeout(_historyPushTimer);
  _historyPushTimer = setTimeout(() => { _historyPushTimer = null; pushHistoryToGitHub(); }, 4000);
}

async function pushHistoryToGitHub() {
  if (!window._historyQueue.length) return;
  if (_historyPushInFlight) return; // next close event (or the timer above) will retry

  const cfg            = loadGhSyncCfg();
  const resolvedToken   = cfg.token || window.__GH_PAT  || '';
  const resolvedRepo    = cfg.repo  || window.__GH_REPO || '';
  if (!resolvedToken || !resolvedRepo) return; // not configured — stay silent, headless job covers it

  _historyPushInFlight = true;
  const pending = window._historyQueue.slice(); // snapshot — cleared only on success

  try {
    const branch  = cfg.branch || 'main';
    const fpath   = (cfg.path || 'scripts/positions.json').replace(/positions\.json$/, 'symbol-history.json');
    const apiBase = `https://api.github.com/repos/${resolvedRepo}/contents/${fpath}`;
    const headers = {
      'Authorization':        `Bearer ${resolvedToken}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const attemptPush = async () => {
      let sha = null, remote = [];
      const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (getRes.ok) {
        const j = await getRes.json();
        sha = j.sha || null;
        try {
          const decoded = decodeURIComponent(escape(atob((j.content || '').replace(/\n/g, ''))));
          remote = JSON.parse(decoded);
          if (!Array.isArray(remote)) remote = [];
        } catch { remote = []; }
      } else if (getRes.status !== 404) {
        throw new Error(`GET ${getRes.status}`);
      }

      let merged = remote.concat(pending);
      const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86_400_000;
      merged = merged.filter(e => e.closedAt >= cutoff);
      if (merged.length > HISTORY_MAX_ROWS) merged = merged.slice(merged.length - HISTORY_MAX_ROWS);

      const json    = JSON.stringify(merged); // compact — this is log data, not something you hand-edit
      const content = btoa(unescape(encodeURIComponent(json)));
      const body    = { message: `chore: symbol-history +${pending.length} row(s) [skip ci]`, content, branch };
      if (sha) body.sha = sha;
      return fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(body) });
    };

    let putRes = await attemptPush();
    if (!putRes.ok && putRes.status === 409) putRes = await attemptPush(); // lost a race with Job B — refetch sha, retry once

    if (!putRes.ok) {
      const e = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${e.message || ''}`.trim());
    }

    // Only drop the rows we actually sent — anything queued mid-flight stays for next push
    window._historyQueue = window._historyQueue.slice(pending.length);
    logAlertItem('info', `☁ Symbol history synced — +${pending.length} row(s) → ${fpath}`);

  } catch (e) {
    console.log(`[gh-sync history] ${e.message}`); // silent-ish — rows stay queued, retried on next close event
  } finally {
    _historyPushInFlight = false;
  }
}

// ══════════════════════════════════════════════════════════════════
// PERIODIC SAFETY NET — in case a debounced call gets lost (tab
// backgrounded mid-timer, etc.), re-check every minute and push if
// the configured interval has elapsed. The "unchanged" short-circuit
// above means this is a no-op unless something actually drifted.
// ══════════════════════════════════════════════════════════════════
setInterval(() => {
  const cfg = loadGhSyncCfg();
  if (!cfg.enabled) return;
  const minGapMs = Math.max(1, cfg.intervalMins || 3) * 60000;
  if (Date.now() - (window._ghSyncState.lastSyncAt || 0) >= minGapMs) {
    syncPositionsToGitHub();
  }
}, 60_000);

// ══════════════════════════════════════════════════════════════════
// UI — config card rendered inside renderAlertCfgPage()
// ══════════════════════════════════════════════════════════════════
function _ghSyncStatusLine() {
  const s = window._ghSyncState;
  if (s.syncing) return `<span style="color:var(--accent);">⏳ syncing…</span>`;
  if (s.lastError) return `<span style="color:var(--bear);">⚠ ${s.lastError}</span>`;
  if (!s.lastSyncAt) return `<span style="color:var(--text-dim);">Never synced yet</span>`;
  const mins = Math.floor((Date.now() - s.lastSyncAt) / 60000);
  const txt  = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
  return `<span style="color:var(--bull);">✓ Last synced ${txt}</span>`;
}

function _refreshGhSyncStatusDOM() {
  const el = document.getElementById('gh-sync-status-line');
  if (el) el.innerHTML = _ghSyncStatusLine();
}

function renderGithubSyncCard() {
  const cfg  = loadGhSyncCfg();
  const mode = cfg.mode || 'secrets'; // 'pat' | 'secrets'

  const tabStyle = (m) => [
    'cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;padding:4px 14px;',
    'border-radius:3px;',
    `border:1px solid ${mode===m ? '#8957e5' : 'var(--border2)'};`,
    `background:${mode===m ? 'rgba(137,87,229,.18)' : 'transparent'};`,
    `color:${mode===m ? '#8957e5' : 'var(--text-dim)'};`,
  ].join('');

  const patPanel = `
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
      Browser pushes <code style="color:var(--accent);">${cfg.path}</code> via your PAT whenever a position changes.<br>
      ⚠ Token stored in <b>localStorage only</b>. Use a fine-grained PAT scoped to this repo,
      <b>Contents: Read and write</b> — never a token with broader access.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">OWNER/REPO</label>
        <input type="text" id="gh-sync-repo" value="${cfg.repo}" placeholder="yourname/alpha-terminal"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">BRANCH</label>
        <input type="text" id="gh-sync-branch" value="${cfg.branch}" placeholder="main"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>
    <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">PERSONAL ACCESS TOKEN</label>
    <input type="password" id="gh-sync-token" value="${cfg.token}" placeholder="github_pat_…"
      style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
             padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;margin-bottom:8px;box-sizing:border-box;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">FILE PATH</label>
        <input type="text" id="gh-sync-path" value="${cfg.path}"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">SAFETY-NET INTERVAL (min)</label>
        <input type="number" id="gh-sync-interval" value="${cfg.intervalMins}" min="1" max="30" step="1"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>`;

  const secretsPanel = `
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.9;">
      <b style="color:var(--text);">Fully headless — no PAT in browser.</b>
      GitHub Actions writes <code style="color:var(--accent);">positions.json</code> every 15 min.
      The browser pulls it on load so you see live positions without syncing.<br><br>
      <b style="color:#8957e5;">Required — Settings → Secrets → Actions:</b><br>
      &nbsp;&nbsp;<code style="color:var(--accent);">TELEGRAM_BOT_TOKEN</code> + <code style="color:var(--accent);">TELEGRAM_CHAT_ID</code><br><br>
      <b style="color:#8957e5;">Required — Settings → Variables → Actions:</b><br>
      &nbsp;&nbsp;<code style="color:var(--accent);">GH_REPO</code> = <code>ahsan520/alpha</code><br><br>
      <b style="color:var(--text);">Enter your repo below so the browser can pull positions:</b>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">OWNER/REPO</label>
        <input type="text" id="gh-sync-repo" value="${cfg.repo}" placeholder="ahsan520/alpha"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">BRANCH</label>
        <input type="text" id="gh-sync-branch" value="${cfg.branch}" placeholder="main"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>
    <button onclick="pullPositionsFromGitHub()"
      style="width:100%;background:none;border:1px solid #8957e5;color:#8957e5;padding:8px;
             border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;margin-bottom:10px;">
      🔄 PULL POSITIONS NOW
    </button>
    <div style="font-family:var(--mono);font-size:7.5px;color:var(--text-dim);line-height:1.7;padding:8px;background:rgba(137,87,229,.06);border-radius:4px;margin-bottom:14px;">
      ✓ Leaderboard buy alerts → GitHub Actions → <code>positions.json</code><br>
      ✓ Stop/T1/T2/exit alerts → GitHub Actions every 15 min<br>
      ✓ Browser pulls positions on load — close tab anytime
    </div>
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:10px;line-height:1.9;border-top:1px solid var(--border);padding-top:12px;">
      <b style="color:var(--text);">Watchlist edits — pushed via Worker, not this PAT-less mode.</b>
      Editing a watchlist in the WATCHLIST tab has no server-side writer under
      Option B, so it's pushed through the <code style="color:var(--accent);">alpha-fetch-checker</code>
      Cloudflare Worker instead, which holds its own persistent PAT (set via
      <code style="color:var(--accent);">wrangler secret put GH_PAT</code> — never wiped, unlike
      env.js). Paste the Worker's URL below.
    </div>
    <div style="margin-bottom:8px;">
      <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">WORKER URL (watchlist sync)</label>
      <input type="text" id="gh-sync-worker-url" value="${cfg.workerUrl}" placeholder="https://alpha-fetch-checker.<subdomain>.workers.dev"
        style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
               padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:14px;">
      <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">WORKER SYNC TOKEN (optional, recommended)</label>
      <input type="password" id="gh-sync-worker-token" value="${cfg.workerToken}" placeholder="matches Worker's SYNC_TOKEN secret"
        style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
               padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
    </div>
    <button onclick="syncWatchlistsToGitHub(true)"
      style="width:100%;background:none;border:1px solid #8957e5;color:#8957e5;padding:8px;
             border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;">
      🔄 SYNC WATCHLISTS NOW
    </button>`;

  return `
  <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #8957e5;
              border-radius:8px;padding:16px;" id="github-sync-card">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#8957e5;letter-spacing:2px;">
        ☁ GITHUB POSITION SYNC
      </div>
      <span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:4px;font-weight:700;
        background:${cfg.enabled ? 'rgba(137,87,229,.15)' : 'rgba(100,100,100,.12)'};
        color:${cfg.enabled ? '#8957e5' : '#555'};
        border:1px solid ${cfg.enabled ? 'rgba(137,87,229,.35)' : '#2a2a2a'};">
        ${cfg.enabled ? 'ACTIVE' : 'OFF'}
      </span>
    </div>

    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-family:var(--mono);font-size:9px;
                  color:var(--text);margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);">
      <input type="checkbox" id="gh-sync-enabled" ${cfg.enabled ? 'checked' : ''}
        style="width:auto;margin:0;accent-color:#8957e5;"> Enable GitHub Sync
    </label>

    <!-- Mode selector -->
    <div style="display:flex;gap:6px;margin-bottom:14px;">
      <button onclick="setGhSyncMode('pat')"     style="${tabStyle('pat')}">⬡ OPTION A — Browser PAT</button>
      <button onclick="setGhSyncMode('secrets')" style="${tabStyle('secrets')}">⬡ OPTION B — GitHub Secrets</button>
    </div>

    ${mode === 'pat' ? patPanel : secretsPanel}

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <button onclick="saveGithubSyncCfgFromUI()"
        style="background:#8957e5;border:none;color:#fff;padding:8px 20px;
               border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;">
        💾 SAVE
      </button>
      <button onclick="syncPositionsToGitHub(true)"
        style="background:none;border:1px solid #8957e5;color:#8957e5;padding:7px 16px;
               border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;">
        🔄 SYNC NOW
      </button>
      <span id="gh-sync-status-line" style="font-family:var(--mono);font-size:8px;">${_ghSyncStatusLine()}</span>
    </div>
  </div>`;
}

function setGhSyncMode(mode) {
  const cfg = loadGhSyncCfg();
  cfg.mode = mode;
  saveGhSyncCfg(cfg);
  renderAlertCfgPage();
}

function saveGithubSyncCfgFromUI() {
  const existing = loadGhSyncCfg();
  const mode = existing.mode || 'secrets';
  const cfg = {
    ...existing,
    mode,
    enabled: document.getElementById('gh-sync-enabled')?.checked ?? false,
  };
  if (mode === 'pat') {
    cfg.token        = document.getElementById('gh-sync-token')?.value.trim()    || '';
    cfg.repo         = document.getElementById('gh-sync-repo')?.value.trim()     || '';
    cfg.branch       = document.getElementById('gh-sync-branch')?.value.trim()   || 'main';
    cfg.path         = document.getElementById('gh-sync-path')?.value.trim()     || 'scripts/positions.json';
    cfg.intervalMins = parseInt(document.getElementById('gh-sync-interval')?.value) || 3;
  }
  // Option B: save repo/branch so pullPositionsFromGitHub knows where to fetch from,
  // plus the Worker URL/token watchlist sync routes through (Option B has no
  // working browser PAT — see syncWatchlistsToGitHub()'s comment in github-sync.js).
  if (mode === 'secrets') {
    cfg.repo        = document.getElementById('gh-sync-repo')?.value.trim()        || cfg.repo   || '';
    cfg.branch      = document.getElementById('gh-sync-branch')?.value.trim()      || cfg.branch || 'main';
    cfg.workerUrl   = document.getElementById('gh-sync-worker-url')?.value.trim()   || '';
    cfg.workerToken = document.getElementById('gh-sync-worker-token')?.value.trim() || '';
  }
  cfg._version = GH_SYNC_CFG_VERSION;
  saveGhSyncCfg(cfg);
  logAlertItem('info', `💾 GitHub Sync config saved (${mode === 'secrets' ? 'Option B — Secrets' : 'Option A — Browser PAT'}).`);
  renderAlertCfgPage();
  if (mode === 'pat' && cfg.enabled && cfg.token && cfg.repo) syncPositionsToGitHub(true);
}
